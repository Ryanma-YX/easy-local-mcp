#!/usr/bin/env node
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { stateDir, logFile, maskMcpUrl, serveControl } from './lifecycle.js';
import { config } from './config.js';
import WebSocket from 'ws';
import {
  Assembly,
  frames,
  parseFrame,
  MAX_BYTES
} from './relay-protocol.js';
import { DEFAULT_PUBLIC_WORKER_URL, validatedWorkerOrigin } from './relay.js';
import {
  clearPendingRegistrationToken,
  clearPendingZoneJoinCode,
  configuredRelayUrl,
  registrationToken,
  saveRelayPreference,
  zoneJoinCode
} from './relay-config.js';
import {
  auditSecurity,
  getUnlockStatus,
  lockLocal,
  resetUnlockOnAgentStart,
  secureWriteFile,
  unlockLocal
} from './security.js';
interface Settings {
  workerUrl:string;
  agentToken:string;
  mcpToken:string;
  deviceId?:string;
  zoneId?:string;
}

await mkdir(stateDir,{recursive:true,mode:0o700});
await resetUnlockOnAgentStart();
await auditSecurity('agent_start',{pid:process.pid});

const pidFile=resolve(stateDir,'agent.pid');
const workerFile=resolve(stateDir,'worker.json');
const connectionFile=resolve(stateDir,'connection.json');

let closing=false;
let ready=false;
let mcpUrl:string|null=null;
let local:ChildProcess|undefined;
let socket:WebSocket|undefined;
let reconnect:ReturnType<typeof setTimeout>|undefined;
let reloading:Promise<void>|undefined;
let settings:Settings|undefined;
let origin:URL|undefined;

async function registerDevice(workerUrl:string):Promise<Settings>{
  const target=validatedWorkerOrigin(workerUrl);
  const headers:Record<string,string>={
    'Content-Type':'application/json'
  };
  const joinCode=await zoneJoinCode();
  const token=joinCode?undefined:await registrationToken();

  if(token){
    headers.Authorization=`Bearer ${token}`;
  }

  if(target.href===validatedWorkerOrigin(DEFAULT_PUBLIC_WORKER_URL).href){
    console.error(
      'Security warning: the default public relay is trusted infrastructure and can observe relayed MCP request/response plaintext. Use a self-hosted Worker for sensitive environments.'
    );
  }

  const endpoint=joinCode?'/join':'/register';
  const response=await fetch(new URL(endpoint,target),{
    method:'POST',
    headers,
    body:joinCode
      ? JSON.stringify({
          code:joinCode,
          name:process.env.LOCALMCP_DEVICE_NAME?.trim()||hostname(),
          platform:process.platform,
          arch:process.arch,
          version:'0.4.0'
        })
      : '{}',
    signal:AbortSignal.timeout(15000)
  });

  if(!response.ok){
    throw new Error(
      joinCode
        ? `Zone join failed (${response.status}). The join code may be invalid, expired, or already used.`
        : `Worker registration failed (${response.status}). Check the Relay URL and registration token in the Control Center, or the LOCALMCP_WORKER_URL / LOCALMCP_REGISTRATION_TOKEN environment overrides.`
    );
  }

  const registered=await response.json() as Settings;

  if(
    !registered.workerUrl
    || !registered.agentToken
    || !registered.mcpToken
  ){
    throw new Error('Worker returned an invalid registration response');
  }

  return {
    workerUrl:registered.workerUrl,
    agentToken:registered.agentToken,
    mcpToken:registered.mcpToken,
    deviceId:registered.deviceId,
    zoneId:registered.zoneId
  };
}
async function loadSettings(){
  const desiredWorkerUrl=await configuredRelayUrl();
  const desiredOrigin=validatedWorkerOrigin(desiredWorkerUrl);

  try{
    settings=JSON.parse(await readFile(workerFile,'utf8')) as Settings;
  }catch(error:any){
    if(error.code!=='ENOENT')throw error;
  }

  const registeredOrigin=settings?.workerUrl
    ? validatedWorkerOrigin(settings.workerUrl)
    : undefined;

  if(!settings||registeredOrigin?.href!==desiredOrigin.href){
    settings=await registerDevice(desiredOrigin.href);
    await secureWriteFile(workerFile,JSON.stringify(settings,null,2));
    await clearPendingRegistrationToken();
    await clearPendingZoneJoinCode();

    await auditSecurity('worker_registration',{
      deviceId:settings.deviceId,
      zoneId:settings.zoneId,
      publicRelay:desiredOrigin.href===validatedWorkerOrigin(DEFAULT_PUBLIC_WORKER_URL).href
    });

    console.error(
      settings.zoneId
        ? `Joined Easy Local MCP Zone ${settings.zoneId} as device ${settings.deviceId??'unknown'}.`
        : `Registered Easy Local MCP device ${settings.deviceId??'legacy'}.`
    );
  }

  origin=desiredOrigin;
}


function currentMcpUrl(){
  if(!settings||!origin)return null;

  const path=settings.deviceId
    ? `/mcp/${settings.deviceId}/${settings.mcpToken}`
    : `/mcp/${settings.mcpToken}`;

  return new URL(path,origin).href;
}
async function writeConnectionFile(){
  mcpUrl=currentMcpUrl();

  if(!mcpUrl||!settings){
    throw new Error('Easy Local MCP connection settings are not ready');
  }

  await secureWriteFile(
    connectionFile,
    JSON.stringify({
      url:mcpUrl,
      authentication:'none',
      transport:'worker-websocket',
      deviceId:settings.deviceId,
      zoneId:settings.zoneId,
      root:process.env.LOCALMCP_ROOT||process.cwd()
    },null,2)
  );
}

async function reregisterDevice(workerUrl:string){
  if(process.env.LOCALMCP_WORKER_URL){
    throw new Error('Worker origin is controlled by LOCALMCP_WORKER_URL; remove the environment override before changing it in the UI.');
  }

  const requested=validatedWorkerOrigin(workerUrl);
  const next=await registerDevice(requested.href);
  const nextOrigin=validatedWorkerOrigin(next.workerUrl);

  settings=next;
  origin=nextOrigin;
  await saveRelayPreference(nextOrigin.href);
  await secureWriteFile(workerFile,JSON.stringify(settings,null,2));
  await writeConnectionFile();
  await clearPendingRegistrationToken();
  await clearPendingZoneJoinCode();
  await auditSecurity('worker_registration',{
    deviceId:settings.deviceId,
    zoneId:settings.zoneId,
    publicRelay:origin.href===validatedWorkerOrigin(DEFAULT_PUBLIC_WORKER_URL).href
  });

  ready=false;
  socket?.terminate();
}


async function rotateCredentials(){
  if(!settings||!origin){
    throw new Error('Easy Local MCP Worker settings are not ready');
  }

  if(!settings.deviceId){
    throw new Error(
      'Credential rotation is not available for the legacy single-user Worker model. Rotate Worker secrets and re-register manually.'
    );
  }

  const response=await fetch(
    new URL(`/rotate/${settings.deviceId}`,origin),
    {
      method:'POST',
      headers:{
        Authorization:`Bearer ${settings.agentToken}`
      },
      body:'{}',
      signal:AbortSignal.timeout(15000)
    }
  );

  if(!response.ok){
    throw new Error(`Worker credential rotation failed (${response.status})`);
  }

  const rotated=await response.json() as Settings;

  if(
    rotated.deviceId!==settings.deviceId
    || !rotated.agentToken
    || !rotated.mcpToken
    || !rotated.workerUrl
  ){
    throw new Error('Worker returned an invalid rotation response');
  }

  settings={
    workerUrl:rotated.workerUrl,
    agentToken:rotated.agentToken,
    mcpToken:rotated.mcpToken,
    deviceId:rotated.deviceId,
    zoneId:settings.zoneId
  };

  await secureWriteFile(workerFile,JSON.stringify(settings,null,2));
  await writeConnectionFile();
  await auditSecurity('credential_rotation',{
    deviceId:settings.deviceId,
    zoneId:settings.zoneId
  });

  socket?.terminate();
}

const closeControl=await serveControl(
  async()=>{
    const unlock=await getUnlockStatus();

    return {
      status:'running',
      pid:process.pid,
      url:mcpUrl,
      config:resolve(
        process.env.LOCALMCP_CONFIG||resolve(stateDir,'localmcp.json')
      ),
      log:logFile,
      ready,
      locked:unlock.locked,
      unlockExpiresAt:unlock.expiresAt,
      workerUrl:origin?.href??null,
      deviceId:settings?.deviceId??null,
      workerManagedByEnv:process.env.LOCALMCP_WORKER_URL!==undefined
    };
  },
  {
    stop:()=>stop(),
    reload:async()=>{
      reloading??=reloadLocal().finally(()=>{
        reloading=undefined;
      });
      await reloading;
    },
    unlock:async minutes=>{
      await unlockLocal(minutes??30);
    },
    lock:async()=>{
      await lockLocal('manual');
    },
    rotate:rotateCredentials,
    reregister:reregisterDevice
  }
);

await secureWriteFile(pidFile,String(process.pid));

process.once('SIGINT',()=>stop());
process.once('SIGTERM',()=>stop());

process.on('SIGHUP',()=>{
  if(!reloading){
    reloading=reloadLocal()
      .catch(error=>console.error(error.message))
      .finally(()=>{
        reloading=undefined;
      });
  }
});

process.on('uncaughtException',error=>{
  console.error(error);
  stop(1);
});

process.on('unhandledRejection',error=>{
  console.error(error);
  stop(1);
});

await loadSettings();

const localToken=randomBytes(32).toString('hex');

async function findFreePort(){
  if(process.env.LOCALMCP_AGENT_PORT){
    return Number(process.env.LOCALMCP_AGENT_PORT);
  }

  return await new Promise<number>((resolvePort,reject)=>{
    const server=createNetServer();

    server.once('error',reject);

    server.listen(0,'127.0.0.1',()=>{
      const address=server.address();

      if(!address||typeof address==='string'){
        server.close();
        reject(new Error('Unable to allocate local port'));
        return;
      }

      const selected=address.port;
      server.close(error=>error?reject(error):resolvePort(selected));
    });
  });
}

const port=await findFreePort();

function spawnLocal(){
  return spawn(
    process.execPath,
    [fileURLToPath(new URL('./index.js',import.meta.url)),'http'],
    {
      env:{
        ...process.env,
        LOCALMCP_PORT:String(port),
        LOCALMCP_TOKEN:localToken,
        LOCALMCP_INTERNAL:'1'
      },
      stdio:['ignore','ignore','inherit'],
      windowsHide:process.platform==='win32'
    }
  );
}

function watchLocal(child:ChildProcess){
  child.on('error',error=>{
    console.error(error.message);
    stop(1);
  });

  child.on('exit',code=>{
    if(!closing&&!reloading&&child===local){
      console.error(`Local server exited (${code})`);
      stop(1);
    }
  });
}

local=spawnLocal();
watchLocal(local);

function stop(code=0){
  if(closing)return;

  closing=true;
  ready=false;

  clearTimeout(reconnect);
  socket?.terminate();
  local?.kill('SIGTERM');

  setTimeout(async()=>{
    local?.kill('SIGKILL');

    await lockLocal('agent_stop').catch(()=>{});
    await auditSecurity('agent_stop',{pid:process.pid,code});
    await unlink(pidFile).catch(()=>{});
    await closeControl();

    process.exit(code);
  },1500);
}

async function reloadLocal(){
  if(closing||!local){
    throw new Error('Easy Local MCP is not ready');
  }

  await config();

  const previous=local;

  await new Promise<void>(done=>{
    const timer=setTimeout(()=>previous.kill('SIGKILL'),5000);

    previous.once('exit',()=>{
      clearTimeout(timer);
      done();
    });

    previous.kill('SIGTERM');
  });

  if(closing){
    throw new Error('Easy Local MCP is stopping');
  }

  local=spawnLocal();
  watchLocal(local);

  const deadline=Date.now()+10000;

  while(Date.now()<deadline&&!closing){
    if(local.exitCode!==null||local.signalCode!==null){
      break;
    }

    try{
      const response=await fetch(
        `http://127.0.0.1:${port}/mcp`,
        {
          headers:{
            Authorization:`Bearer ${localToken}`
          },
          signal:AbortSignal.timeout(500)
        }
      );

      if(response.status===405){
        await auditSecurity('config_reload');
        console.error('Easy Local MCP configuration reloaded.');
        return;
      }
    }catch{}

    await new Promise(resolvePause=>setTimeout(resolvePause,100));
  }

  stop(1);
  throw new Error('Reload failed; see '+logFile);
}

let localReady=false;

for(let i=0;i<100&&!closing;i++){
  try{
    const response=await fetch(
      `http://127.0.0.1:${port}/mcp`,
      {
        headers:{
          Authorization:`Bearer ${localToken}`
        },
        signal:AbortSignal.timeout(500)
      }
    );

    if(response.status===405){
      localReady=true;
      break;
    }
  }catch{}

  await new Promise(resolvePause=>setTimeout(resolvePause,100));
}

if(!localReady||closing){
  stop(1);
}else{
  let attempt=0;

  await writeConnectionFile();

  function connect(){
    if(closing||!settings||!origin)return;

    const wsUrl=new URL(
      settings.deviceId?`/agent/${settings.deviceId}`:'/agent',
      origin
    );

    wsUrl.protocol=origin.protocol==='https:'?'wss:':'ws:';

    const ws=new WebSocket(
      wsUrl,
      {
        headers:{
          Authorization:`Bearer ${settings.agentToken}`
        },
        handshakeTimeout:15000,
        maxPayload:160000
      }
    );

    socket=ws;

    const assemblies=new Map<string,Assembly>();
    const activeRequests=new Set<string>();
    let pong=Date.now();

    const heartbeat=setInterval(()=>{
      if(ws.readyState!==WebSocket.OPEN)return;

      if(Date.now()-pong>65000){
        ws.terminate();
        return;
      }

      ws.send('ping');
    },25000);

    ws.on('open',()=>{
      ready=true;
      attempt=0;

      console.log(
        `Easy Local MCP is running\n\nMCP URL: ${maskMcpUrl(mcpUrl)}\nUse "easy-local-mcp url" to reveal the full credential-bearing URL.\nConfig: ~/.localmcp/localmcp.json\nSecurity: LOCKED until locally unlocked.\n`
      );
    });

    const respond=(id:string,value:unknown)=>{
      if(ws.readyState===WebSocket.OPEN){
        for(const frame of frames(id,value)){
          ws.send(frame);
        }
      }
    };

    ws.on('message',async raw=>{
      const message=raw.toString();

      if(message==='pong'){
        pong=Date.now();
        return;
      }

      try{
        const frame=parseFrame(message);

        if(activeRequests.has(frame.id)){
          throw new Error('Duplicate active request');
        }

        let assembly=assemblies.get(frame.id);

        if(!assembly){
          if(frame.index!==0){
            throw new Error('Missing initial relay frame');
          }

          assembly=new Assembly();
          assemblies.set(frame.id,assembly);
        }

        const complete=assembly.push(frame);
        if(!complete)return;

        assemblies.delete(frame.id);

        const data=complete.value as {
          body:string;
          protocolVersion?:string;
        };

        if(
          !data
          || typeof data.body!=='string'
          || Buffer.byteLength(data.body)>2*1024*1024
        ){
          throw new Error('Invalid request body');
        }

        JSON.parse(data.body);
        activeRequests.add(frame.id);

        try{
          const headers:Record<string,string>={
            'Content-Type':'application/json',
            'Accept':'application/json, text/event-stream',
            Authorization:`Bearer ${localToken}`
          };

          if(data.protocolVersion){
            headers['MCP-Protocol-Version']=data.protocolVersion;
          }

          const response=await fetch(
            `http://127.0.0.1:${port}/mcp`,
            {
              method:'POST',
              headers,
              body:data.body,
              signal:AbortSignal.timeout(125000)
            }
          );

          const reader=response.body?.getReader();
          let body='';
          let bytes=0;
          const decoder=new TextDecoder();

          if(reader){
            try{
              while(true){
                const part=await reader.read();
                if(part.done)break;

                bytes+=part.value.length;

                if(bytes>MAX_BYTES-1024){
                  await reader.cancel();
                  throw new Error('Tool response exceeds relay limit');
                }

                body+=decoder.decode(part.value,{stream:true});
              }

              body+=decoder.decode();
            }finally{
              reader.releaseLock();
            }
          }

          respond(frame.id,{
            status:response.status,
            body
          });
        }catch{
          respond(frame.id,{
            status:502,
            body:JSON.stringify({
              error:'Local call failed or timed out. Outcome may be unknown; do not automatically retry.'
            })
          });
        }finally{
          activeRequests.delete(frame.id);
        }
      }catch{
        ws.close(1008,'Invalid relay request');
      }
    });

    ws.on('error',error=>{
      console.error(`Worker connection error: ${error.message}`);
    });

    ws.on('close',()=>{
      ready=false;
      clearInterval(heartbeat);

      if(!closing){
        const delay=
          Math.min(30000,1000*2**Math.min(attempt++,5))
          + Math.random()*1000;

        console.error(
          `Worker disconnected; reconnecting in ${Math.ceil(delay/1000)}s. Requests are not replayed.`
        );

        reconnect=setTimeout(connect,delay);
      }
    });
  }

  connect();
}
