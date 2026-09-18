import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { mkdir, open, readFile, rm, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlEndpoint } from './control-endpoint.js';
import { ensureControlSecret, getControlSecret } from './security.js';
import { ensureRelayConfigured } from './relay-config.js';

export const stateDir=resolve(homedir(),'.localmcp');
export const logFile=resolve(stateDir,'agent.log');

const endpoint=controlEndpoint(stateDir);
const lockFile=resolve(stateDir,'control.lock');

export interface Status {
  status:'running'|'stopped';
  pid:number|null;
  url:string|null;
  config:string;
  log:string;
  ready:boolean;
  locked:boolean;
  unlockExpiresAt:string|null;
  workerUrl:string|null;
  deviceId:string|null;
  workerManagedByEnv:boolean;
}

type ControlCommand='status'|'stop'|'reload'|'unlock'|'lock'|'rotate'|'reregister';

interface ControlRequest {
  command:ControlCommand;
  secret:string;
  minutes?:number;
  workerUrl?:string;
}

export interface ControlHandlers {
  stop:()=>void;
  reload:()=>Promise<void>;
  unlock:(minutes?:number)=>Promise<void>;
  lock:()=>Promise<void>;
  rotate:()=>Promise<void>;
  reregister:(workerUrl:string)=>Promise<void>;
}

const pause=(ms:number)=>new Promise(resolvePause=>setTimeout(resolvePause,ms));

function secureEqual(left:string,right:string){
  const a=Buffer.from(left);
  const b=Buffer.from(right);
  return a.length===b.length&&timingSafeEqual(a,b);
}

export function maskMcpUrl(url:string|null){
  if(!url)return '-';

  try{
    const parsed=new URL(url);
    const segments=parsed.pathname.split('/').filter(Boolean);

    if(segments.length){
      const last=segments.length-1;
      segments[last]='<redacted>';
      parsed.pathname='/'+segments.join('/');
    }

    parsed.search='';
    parsed.hash='';
    parsed.username='';
    parsed.password='';

    return parsed.href;
  }catch{
    return '<redacted>';
  }
}

export async function request(
  command:ControlCommand='status',
  options:{minutes?:number;workerUrl?:string}={}
):Promise<Status>{
  const secret=await getControlSecret();

  return new Promise((resolveStatus,reject)=>{
    const socket=createConnection(endpoint.address);
    let data='';

    const timer=setTimeout(
      ()=>socket.destroy(new Error('Easy Local MCP control request timed out')),
      20000
    );

    socket.on('connect',()=>{
      const payload:ControlRequest={
        command,
        secret,
        ...(options.minutes===undefined?{}:{minutes:options.minutes}),
        ...(options.workerUrl===undefined?{}:{workerUrl:options.workerUrl})
      };
      socket.write(JSON.stringify(payload)+'\n');
    });

    socket.on('data',chunk=>{
      data+=chunk;
      if(data.length>65536){
        socket.destroy(new Error('Invalid control response'));
      }
    });

    socket.on('error',reject);
    socket.on('close',()=>clearTimeout(timer));

    socket.on('end',()=>{
      try{
        if(!data){
          throw Object.assign(
            new Error('Easy Local MCP control connection closed'),
            {code:'ECONNRESET'}
          );
        }

        const response=JSON.parse(data);

        if(response.error)reject(new Error(response.error));
        else resolveStatus(response);
      }catch(error){
        reject(error);
      }
    });
  });
}

export async function status():Promise<Status>{
  try{
    return await request();
  }catch(error:any){
    if(!['ENOENT','ECONNREFUSED','ECONNRESET','EPIPE'].includes(error.code)){
      throw error;
    }

    return {
      status:'stopped',
      pid:null,
      url:null,
      config:resolve(process.env.LOCALMCP_CONFIG||resolve(stateDir,'localmcp.json')),
      log:logFile,
      ready:false,
      locked:true,
      unlockExpiresAt:null,
      workerUrl:null,
      deviceId:null,
      workerManagedByEnv:process.env.LOCALMCP_WORKER_URL!==undefined
    };
  }
}

export function printStatus(value:Status){
  console.log(
    `Status: ${value.status}\n`
    + `PID: ${value.pid??'-'}\n`
    + `Security: ${value.locked?'LOCKED':'UNLOCKED'}\n`
    + `Unlock expires: ${value.unlockExpiresAt??'-'}\n`
    + `MCP URL: ${maskMcpUrl(value.url)}\n`
    + `Config: ${value.config}\n`
    + `Log: ${value.log}`
  );
}

export function printUrl(value:Status){
  if(value.status!=='running'||!value.url){
    throw new Error('Easy Local MCP is not running or has no MCP URL');
  }

  console.log(value.url);
}

async function locked<T>(action:()=>Promise<T>):Promise<T>{
  await mkdir(stateDir,{recursive:true,mode:0o700});
  const deadline=Date.now()+90000;

  while(true){
    try{
      const file=await open(lockFile,'wx',0o600);

      try{
        await file.writeFile(String(process.pid));
      }finally{
        await file.close();
      }

      break;
    }catch(error:any){
      if(error.code!=='EEXIST')throw error;

      let pid=0;

      try{
        pid=Number(await readFile(lockFile,'utf8'));
      }catch(readError:any){
        if(readError.code!=='ENOENT')throw readError;
      }

      if(Number.isInteger(pid)&&pid>0){
        try{
          process.kill(pid,0);
        }catch(killError:any){
          if(killError.code==='ESRCH'){
            await rm(lockFile,{force:true});
            continue;
          }
        }
      }

      if(Date.now()>deadline){
        throw new Error(`Another Easy Local MCP command is still running (${lockFile})`);
      }

      await pause(100);
    }
  }

  try{
    return await action();
  }finally{
    await rm(lockFile,{force:true});
  }
}

export async function control(
  command:'start'|'stop'|'reload',
  initialize:()=>Promise<void>=async()=>{}
){
  return locked(async()=>{
    let current=await status();

    if(command==='reload'){
      if(current.status==='stopped'){
        throw new Error('Easy Local MCP is stopped; run easy-local-mcp to start it');
      }

      current=await request('reload');
      console.log('Easy Local MCP configuration reloaded.');
    }else if(command==='stop'){
      if(current.status==='running'){
        await request('stop');

        for(let i=0;i<100;i++){
          current=await status();
          if(current.status==='stopped')break;
          await pause(100);
        }

        if(current.status!=='stopped'){
          throw new Error(`Easy Local MCP did not stop; see ${logFile}`);
        }
      }
    }else{
      let child:ReturnType<typeof spawn>|undefined;

      if(current.status==='stopped'){
        await ensureRelayConfigured();
        await initialize();

        if(endpoint.socketFile){
          await rm(endpoint.socketFile,{force:true});
        }

        const log=await open(logFile,'a',0o600);

        try{
          child=spawn(
            process.execPath,
            [fileURLToPath(new URL('./agent.js',import.meta.url))],
            {
              detached:true,
              stdio:['ignore',log.fd,log.fd],
              env:process.env,
              windowsHide:process.platform==='win32'
            }
          );

          await new Promise<void>((ready,reject)=>{
            child!.once('spawn',ready);
            child!.once('error',reject);
          });

          child.unref();
        }finally{
          await log.close();
        }
      }

      const deadline=Date.now()+60000;

      while(!current.ready){
        if(child&&(child.exitCode!==null||child.signalCode!==null)){
          throw new Error(`Easy Local MCP startup failed; see ${logFile}`);
        }

        if(Date.now()>deadline){
          child?.kill('SIGTERM');
          throw new Error(`Easy Local MCP startup timed out; see ${logFile}`);
        }

        await pause(100);
        current=await status();
      }
    }

    printStatus(current);
  });
}

export async function serveControl(
  getStatus:()=>Status|Promise<Status>,
  handlers:ControlHandlers
){
  const controlSecret=await ensureControlSecret();

  const server=createServer({allowHalfOpen:true},socket=>{
    let data='';
    let handled=false;

    socket.setTimeout(20000,()=>socket.destroy());
    socket.on('error',()=>{});

    const handle=()=>{
      if(handled||socket.destroyed)return;
      handled=true;

      void (async()=>{
        let parsed:ControlRequest;

        try{
          parsed=JSON.parse(data.trim()) as ControlRequest;
        }catch{
          throw new Error('Invalid control request');
        }

        if(
          !parsed
          || typeof parsed.command!=='string'
          || typeof parsed.secret!=='string'
          || !secureEqual(parsed.secret,controlSecret)
        ){
          throw new Error('Unauthorized control request');
        }

        switch(parsed.command){
          case'status':
            break;
          case'reload':
            await handlers.reload();
            break;
          case'unlock':
            await handlers.unlock(parsed.minutes);
            break;
          case'lock':
            await handlers.lock();
            break;
          case'rotate':
            await handlers.rotate();
            break;
          case'reregister':
            if(typeof parsed.workerUrl!=='string'||!parsed.workerUrl){
              throw new Error('workerUrl is required');
            }
            await handlers.reregister(parsed.workerUrl);
            break;
          case'stop':
            socket.once('close',handlers.stop);
            break;
          default:
            throw new Error('Unknown control command');
        }

        socket.end(JSON.stringify(await getStatus()));
      })().catch(error=>{
        socket.end(JSON.stringify({
          error:error instanceof Error?error.message:String(error)
        }));
      });
    };

    socket.on('data',chunk=>{
      data+=chunk;

      if(data.length>4096){
        socket.destroy();
        return;
      }

      if(data.includes('\n')){
        handle();
      }
    });

    socket.on('end',handle);
  });

  await new Promise<void>((ready,reject)=>{
    server.once('error',reject);
    server.listen(endpoint.address,ready);
  });

  if(endpoint.socketFile){
    await chmod(endpoint.socketFile,0o600);
  }

  return async()=>{
    await new Promise<void>((done,reject)=>{
      server.close(error=>error?reject(error):done());
    });

    if(endpoint.socketFile){
      await rm(endpoint.socketFile,{force:true});
    }
  };
}
