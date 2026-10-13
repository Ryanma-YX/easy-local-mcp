import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {createConnection,createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ProcessManager} from '../src/process.js';

const pause=(ms:number)=>new Promise(done=>setTimeout(done,ms));

async function portAvailable():Promise<number>{
  const server=createServer();
  await new Promise<void>((ok,fail)=>{
    server.once('error',fail);
    server.listen(0,'127.0.0.1',ok);
  });
  const addr=server.address();
  assert.ok(addr&&typeof addr!=='string');
  await new Promise<void>((ok,fail)=>server.close(err=>err?fail(err):ok()));
  return addr.port;
}

async function portListening(port:number):Promise<boolean>{
  return await new Promise(resolveResult=>{
    const socket=createConnection({host:'127.0.0.1',port});
    let settled=false;
    function finish(value:boolean){
      if(settled)return;
      settled=true;
      socket.destroy();
      resolveResult(value);
    }
    socket.once('connect',()=>finish(true));
    socket.once('error',()=>finish(false));
    socket.setTimeout(150,()=>finish(false));
  });
}

async function waitFor(action:()=>Promise<boolean>,label:string,timeout=8500){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    if(await action())return;
    await pause(70);
  }
  throw new Error('Timed out waiting for '+label);
}

async function httpChildOf(parentPid:number):Promise<number|undefined>{
  let children='';
  try{
    children=await readFile('/proc/'+parentPid+'/task/'+parentPid+'/children','utf8');
  }catch{return undefined;}
  for(const pidText of children.trim().split(/\s+/)){
    const pid=Number(pidText);
    if(!Number.isSafeInteger(pid)||pid<=0)continue;
    const cmd=await readFile('/proc/'+pid+'/cmdline','utf8').catch(()=>'');
    if(cmd.includes('dist/index.js')&&cmd.includes('http'))return pid;
  }
  return undefined;
}

async function httpChildAlive(pid:number,root:string):Promise<boolean>{
  const cmd=await readFile('/proc/'+pid+'/cmdline','utf8').catch(()=>'');
  if(!cmd.includes(root+'/dist/index.js')||!cmd.includes('http'))return false;
  const stat=await readFile('/proc/'+pid+'/stat','utf8').catch(()=>'');
  const state=stat.slice(stat.lastIndexOf(')')+2,stat.lastIndexOf(')')+3);
  return state!=='Z'&&state!=='X';
}

test('SIGKILL of the agent terminates its HTTP child and allows fixed-port restart',{
  skip:process.platform!=='linux',timeout:25000
},async t=>{
  const root=resolve('.');
  const home=await mkdtemp(join(tmpdir(),'localmcp-child-recovery-'));
  const port=await portAvailable();
  const stateDir=join(home,'.localmcp');
  await mkdir(stateDir,{recursive:true,mode:0o700});
  await writeFile(join(stateDir,'worker.json'),JSON.stringify({
    workerUrl:'http://127.0.0.1:9/',
    agentToken:'a'.repeat(64),mcpToken:'b'.repeat(64),
    deviceId:'disposable-test-device'
  }),{mode:0o600});
  const env:NodeJS.ProcessEnv={
    ...process.env,
    HOME:home,USERPROFILE:home,
    LOCALMCP_WORKER_URL:'http://127.0.0.1:9/',
    LOCALMCP_AGENT_PORT:String(port)
  };
  delete env.LOCALMCP_CONFIG;
  delete env.LOCALMCP_ROOT;
  delete env.LOCALMCP_INTERNAL;
  delete env.LOCALMCP_TOKEN;
  delete env.LOCALMCP_PORT;
  const agents:ChildProcess[]=[];
  const childPids=new Set<number>();
  let logs='';
  function launchAgent(){
    const child=spawn(process.execPath,[resolve('dist/index.js'),'agent'],{
      cwd:root,env,stdio:['ignore','pipe','pipe']
    });
    agents.push(child);
    child.stdout?.on('data',(data:Buffer)=>{logs=(logs+data.toString()).slice(-4000);});
    child.stderr?.on('data',(data:Buffer)=>{logs=(logs+data.toString()).slice(-4000);});
    return child;
  }
  t.after(async()=>{
    for(const agent of agents){
      if(agent.exitCode===null&&agent.signalCode===null)agent.kill('SIGKILL');
    }
    await pause(150);
    for(const pid of childPids){
      if(await httpChildAlive(pid,root)){
        try{process.kill(pid,'SIGKILL');}catch(error){
          if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;
        }
      }
    }
    await rm(home,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  });

  const first=launchAgent();
  let firstHttp:number|undefined;
  await waitFor(async()=>{
    if(first.exitCode!==null||first.signalCode!==null){
      throw new Error('Initial agent exited: '+logs.slice(-400));
    }
    firstHttp=await httpChildOf(first.pid!);
    return firstHttp!==undefined&&await portListening(port);
  },'first HTTP child to listen');
  assert.ok(firstHttp);
  childPids.add(firstHttp);
  const firstExit=once(first,'exit');
  first.kill('SIGKILL');
  await firstExit;

  await waitFor(async()=>{
    return !(await httpChildAlive(firstHttp!,root))
      &&!(await portListening(port));
  },'HTTP child to exit and release its port after agent SIGKILL',4500);

  const restarted=launchAgent();
  let restartedHttp:number|undefined;
  await waitFor(async()=>{
    if(restarted.exitCode!==null||restarted.signalCode!==null){
      throw new Error('Replacement agent exited: '+logs.slice(-450));
    }
    restartedHttp=await httpChildOf(restarted.pid!);
    return restartedHttp!==undefined&&await portListening(port);
  },'replacement HTTP child to bind original fixed port');
  assert.ok(restartedHttp);
  childPids.add(restartedHttp);
  assert.notEqual(restartedHttp,firstHttp);
});

async function managedProcessAlive(pid:number){
  const stat=await readFile('/proc/'+pid+'/stat','utf8').catch(()=>'');
  if(!stat)return false;
  const state=stat.slice(stat.lastIndexOf(')')+2,stat.lastIndexOf(')')+3);
  return state!=='Z'&&state!=='X';
}

test('Agent SIGKILL stops MCP-managed processes before fixed-port restart',{
  skip:process.platform!=='linux',timeout:25000
},async t=>{
  const root=resolve('.');
  const home=await mkdtemp(join(tmpdir(),'localmcp-owned-command-'));
  const port=await portAvailable();
  const stateDir=join(home,'.localmcp');
  await mkdir(stateDir,{recursive:true,mode:0o700});
  await writeFile(join(stateDir,'localmcp.json'),JSON.stringify({
    workspaces:{fixture:home},defaultWorkspace:'fixture',
    features:{files:{read:true,write:false,delete:false},shell:true,
      processes:true,externalMcp:false}
  }));
  await writeFile(join(stateDir,'worker.json'),JSON.stringify({
    workerUrl:'http://127.0.0.1:9/',
    agentToken:'a'.repeat(64),mcpToken:'b'.repeat(64),
    deviceId:'disposable-test-device'
  }),{mode:0o600});
  const env:NodeJS.ProcessEnv={
    ...process.env,HOME:home,USERPROFILE:home,
    LOCALMCP_WORKER_URL:'http://127.0.0.1:9/',
    LOCALMCP_AGENT_PORT:String(port)
  };
  for(const key of ['LOCALMCP_CONFIG','LOCALMCP_ROOT','LOCALMCP_INTERNAL',
    'LOCALMCP_TOKEN','LOCALMCP_PORT']){
    delete env[key];
  }
  let logs='';
  let managedPid:number|undefined;
  const children:ChildProcess[]=[];
  function launch(){
    const child=spawn(process.execPath,[resolve('dist/index.js'),'agent'],{
      cwd:root,env,stdio:['ignore','pipe','pipe']
    });
    children.push(child);
    child.stdout?.on('data',(chunk:Buffer)=>{logs=(logs+chunk).slice(-4000);});
    child.stderr?.on('data',(chunk:Buffer)=>{logs=(logs+chunk).slice(-4000);});
    return child;
  }
  t.after(async()=>{
    for(const child of children){
      if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    }
    if(managedPid!==undefined&&await managedProcessAlive(managedPid)){
      // This process group was started by this disposable test only.
      try{process.kill(-managedPid,'SIGKILL');}catch(error){
        if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;
      }
    }
    await pause(170);
    await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const first=launch();
  let httpPid:number|undefined;
  await waitFor(async()=>{
    if(first.exitCode!==null||first.signalCode!==null){
      throw new Error('Test Agent unexpectedly exited: '+logs.slice(-400));
    }
    httpPid=await httpChildOf(first.pid!);
    return httpPid!==undefined&&await portListening(port);
  },'Agent HTTP listener');
  assert.ok(httpPid);
  const childEnv=(await readFile('/proc/'+httpPid+'/environ','utf8')).split('\0');
  const token=childEnv.find(e=>e.startsWith('LOCALMCP_TOKEN='))?.slice(15);
  assert.match(token??'',/^[a-f0-9]{64}$/,'Missing test-owned HTTP bearer token');
  const now=Date.now();
  await writeFile(join(stateDir,'unlock.json'),JSON.stringify({
    version:2,source:'local',until:now+600000,hardUntil:now+1200000,
    idleMinutes:10,lastActivityAt:now
  }),{mode:0o600});

  const client=new Client({name:'crash-cleanup-test',version:'1'});
  try{
    await client.connect(new StreamableHTTPClientTransport(
      new URL('http://127.0.0.1:'+port+'/mcp/'+token)
    ));
    const response=await client.callTool({
      name:'start_process',arguments:{command:'sleep 45'}
    });
    assert.equal(response.isError,undefined,JSON.stringify(response));
    const started=JSON.parse(String(response.content[0].text));
    managedPid=started.pid;
    assert.ok(Number.isSafeInteger(managedPid)&&managedPid>0);
    assert.equal(await managedProcessAlive(managedPid),true);
  }finally{
    await client.close().catch(()=>{});
  }

  const exited=once(first,'exit');
  first.kill('SIGKILL');
  await exited;
  await waitFor(async()=>!(await httpChildAlive(httpPid!,root))
    && !(await portListening(port)),'HTTP child shutdown',5500);
  await waitFor(async()=>!(await managedProcessAlive(managedPid!)),
    'MCP-managed command termination after agent crash',4500);

  const second=launch();
  await waitFor(async()=>{
    if(second.exitCode!==null||second.signalCode!==null){
      throw new Error('Restarted Agent unexpectedly exited: '+logs.slice(-400));
    }
    const secondHttp=await httpChildOf(second.pid!);
    return secondHttp!==undefined&&await portListening(port);
  },'replacement Agent binding original fixed port');
});


test('ProcessManager shutdown is idempotent and blocks late process starts',async()=>{
  const manager=new ProcessManager();
  await Promise.all([manager.close(),manager.close()]);
  assert.throws(
    ()=>manager.start('sleep 30',process.cwd()),
    /Process manager is shutting down/
  );
});
