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

const pause=(ms:number)=>new Promise(ok=>setTimeout(ok,ms));
async function until(action:()=>Promise<boolean>,label:string,timeout=8000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    if(await action())return;
    await pause(65);
  }
  throw new Error('Timeout waiting for '+label);
}
async function getPort(){
  const server=createServer();
  await new Promise<void>((ok,no)=>{
    server.once('error',no);server.listen(0,'127.0.0.1',ok);
  });
  const addr=server.address();
  assert.ok(addr&&typeof addr!=='string');
  await new Promise<void>(ok=>server.close(()=>ok()));
  return addr.port;
}
async function isOpen(port:number){
  return await new Promise<boolean>(ok=>{
    const socket=createConnection(port,'127.0.0.1');
    socket.once('connect',()=>{socket.destroy();ok(true);});
    socket.once('error',()=>{socket.destroy();ok(false);});
    socket.setTimeout(250,()=>{socket.destroy();ok(false);});
  });
}
async function alive(pid:number){
  const value=await readFile('/proc/'+pid+'/stat','utf8').catch(()=>'');
  if(!value)return false;
  const state=value.slice(value.lastIndexOf(')')+2,value.lastIndexOf(')')+3);
  return state!=='Z'&&state!=='X';
}
async function pidFromMarker(marker:string){
  const value=await readFile(marker,'utf8').catch(()=>'');
  const pid=Number(value.trim());
  return Number.isSafeInteger(pid)&&pid>0?pid:undefined;
}
async function httpChildPid(pid:number){
  const data=await readFile('/proc/'+pid+'/task/'+pid+'/children','utf8').catch(()=>'');
  for(const value of data.trim().split(/\s+/)){
    const child=Number(value);
    if(!child)continue;
    const cmd=await readFile('/proc/'+child+'/cmdline','utf8').catch(()=>'');
    if(cmd.includes('dist/index.js')&&cmd.includes('http'))return child;
  }
  return undefined;
}
async function subprocess(command:string[],env:NodeJS.ProcessEnv,timeout=11000){
  const child=spawn(process.execPath,command,{
    env,stdio:['ignore','pipe','pipe']
  });
  let output='';
  child.stdout?.on('data',chunk=>{output+=chunk.toString();});
  child.stderr?.on('data',chunk=>{output+=chunk.toString();});
  return await new Promise<{code:number|null;output:string}>(ok=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');ok({code:null,output:'Timeout '+output});},timeout);
    child.once('exit',code=>{clearTimeout(timer);ok({code,output});});
    child.once('error',err=>{clearTimeout(timer);ok({code:-1,output:String(err)});});
  });
}
interface Harness{
  home:string;
  port:number;
  env:NodeJS.ProcessEnv;
  marker:string;
  externalMarker:string;
  externalPending:string;
  wrapperMarker:string;
  agent:ChildProcess;
  launch:()=>ChildProcess;
  client:()=>Promise<Client>;
  cli:(mode:'stop'|'reload')=>Promise<void>;
  track:(pid:number)=>Promise<void>;
  trackExternal:(pid:number)=>void;
}
async function fixture(t:import('node:test').TestContext,external:boolean|'wrapped'=false):Promise<Harness>{
  const root=resolve('.');
  const home=await mkdtemp(join(tmpdir(),'localmcp-lifetime-v7-'));
  const state=join(home,'.localmcp');
  const marker=join(home,'command-child.pid');
  const externalMarker=join(home,'external.pid');
  const externalPending=join(home,'external-pending');
  const wrapperMarker=join(home,'wrapper.pid');
  const port=await getPort();
  await mkdir(state,{recursive:true,mode:0o700});
  await writeFile(join(state,'localmcp.json'),JSON.stringify({
    workspaces:{fixture:home},defaultWorkspace:'fixture',
    features:{shell:true,processes:true,externalMcp:Boolean(external)},
    security:{alwaysUnlocked:true},
    mcpServers:external?{fixture:{
      command:process.execPath,
      args:external==='wrapped'
        ? [resolve('test/fixtures/wrapped-mcp-server.mjs'),externalMarker,externalPending,wrapperMarker]
        : [resolve('test/fixtures/persistent-mcp-server.mjs'),externalMarker,externalPending]
    }}:{}
  }));
  await writeFile(join(state,'worker.json'),JSON.stringify({
    workerUrl:'http://127.0.0.1:9/',
    agentToken:'a'.repeat(64),mcpToken:'b'.repeat(64),
    deviceId:'test-ownership'
  }),{mode:0o600});
  const env:NodeJS.ProcessEnv={
    ...process.env,HOME:home,USERPROFILE:home,
    LOCALMCP_WORKER_URL:'http://127.0.0.1:9/',
    LOCALMCP_AGENT_PORT:String(port)
  };
  for(const key of ['LOCALMCP_ROOT','LOCALMCP_CONFIG','LOCALMCP_INTERNAL',
    'LOCALMCP_ZONE_ID','LOCALMCP_TOKEN','LOCALMCP_PORT']){
    delete env[key];
  }
  const agents:ChildProcess[]=[];
  const ownedGroups=new Set<number>();
  const externalPids=new Set<number>();
  const clients:Client[]=[];
  let logs='';
  function launch(){
    const child=spawn(process.execPath,[resolve('dist/index.js'),'agent'],{
      cwd:root,env,stdio:['ignore','pipe','pipe']
    });
    agents.push(child);
    child.stderr?.on('data',(data:Buffer)=>{logs=(logs+data.toString()).slice(-4000);});
    child.stdout?.on('data',(data:Buffer)=>{logs=(logs+data.toString()).slice(-4000);});
    return child;
  }
  t.after(async()=>{
    for(const client of clients){await client.close().catch(()=>{});}
    for(const agent of agents){
      if(agent.exitCode===null&&agent.signalCode===null)agent.kill('SIGKILL');
    }
    // Cleanup only process groups that this disposable test created.
    for(const group of ownedGroups){
      try{process.kill(-group,'SIGKILL');}catch{}
    }
    for(const pid of externalPids){
      if(await alive(pid)){
        try{process.kill(pid,'SIGKILL');}catch{}
      }
    }
    await pause(140);
    await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const agent=launch();
  await until(async()=>{
    if(agent.exitCode!==null||agent.signalCode!==null)throw new Error('Agent exited '+logs);
    return Boolean(await httpChildPid(agent.pid!))&&await isOpen(port);
  },'real Agent HTTP endpoint');
  async function client(){
    const child=await httpChildPid(agents[agents.length-1].pid!);
    assert.ok(child);
    const envData=await readFile('/proc/'+child+'/environ','utf8');
    const bearer=envData.split('\0').find(s=>s.startsWith('LOCALMCP_TOKEN='))?.slice(15);
    assert.match(bearer??'',/^[0-9a-f]{64}$/);
    const result=new Client({name:'lifecycle-v7-test',version:'1'});
    await result.connect(new StreamableHTTPClientTransport(
      new URL('http://127.0.0.1:'+port+'/mcp/'+bearer)
    ));
    clients.push(result);
    return result;
  }
  async function cli(mode:'stop'|'reload'){
    const result=await subprocess([resolve('dist/index.js'),mode],env);
    assert.equal(result.code,0,mode+': '+result.output+'\n'+logs);
  }
  async function track(pid:number){
    const stat=await readFile('/proc/'+pid+'/stat','utf8');
    const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
    const group=Number(fields[2]);
    assert.ok(group>0);
    // Never kill unrelated process groups in cleanup; commands launched with
    // run_command create their own detached Unix group.
    const ownStat=await readFile('/proc/self/stat','utf8');
    const ownFields=ownStat.slice(ownStat.lastIndexOf(')')+2).trim().split(/\s+/);
    assert.notEqual(group,Number(ownFields[2]),
      'Test-owned command unexpectedly shares the test runner process group');
    ownedGroups.add(group);
  }
  return {home,port,env,marker,externalMarker,externalPending,wrapperMarker,
    agent,launch,client,cli,track,
    trackExternal:pid=>externalPids.add(pid)};
}

for(const mode of ['SIGKILL','stop','reload'] as const){
  test('run_command terminates in-flight shell during Agent '+mode,{
    skip:process.platform!=='linux',timeout:25000
  },async t=>{
    const f=await fixture(t);
    const client=await f.client();
    // Sleep is a background child of a waiting shell, with its PID recorded
    // before the Agent is terminated. A client request remains in flight.
    const call=client.callTool({
      name:'run_command',
      arguments:{
        command:'sleep 45 & echo $! > '+f.marker+'; wait',
        timeoutMs:120000
      }
    });
    void call.catch(()=>{});
    let child=0;
    await until(async()=>{
      child=(await pidFromMarker(f.marker))??0;
      return child>0&&await alive(child);
    },'in-flight run_command subprocess');
    await f.track(child);
    if(mode==='SIGKILL'){
      const exited=once(f.agent,'exit');
      f.agent.kill('SIGKILL');
      await exited;
    }else{
      await f.cli(mode);
    }
    await until(async()=>!(await alive(child)),
      'in-flight run_command process termination after '+mode,6000);
    if(mode==='reload'){
      await until(async()=>await isOpen(f.port),
        'same Agent HTTP port after reload');
    }else{
      await until(async()=>!(await isOpen(f.port)),
        'HTTP port released after '+mode);
    }
  });
}

for(const mode of ['SIGKILL','stop','reload'] as const){
  test('persistent external MCP server exits on Agent '+mode,{
    skip:process.platform!=='linux',timeout:30000
  },async t=>{
    const f=await fixture(t,true);
    const client=await f.client();
    const started=await client.callTool({
      name:'list_mcp_tools',arguments:{server:'fixture'}
    });
    assert.equal(started.isError,undefined,JSON.stringify(started));
    let serverPid=0;
    await until(async()=>{
      serverPid=(await pidFromMarker(f.externalMarker))??0;
      return serverPid>0&&await alive(serverPid);
    },'external MCP process');
    f.trackExternal(serverPid);
    // A pending external call must not hold the old HTTP process open.
    const pending=client.callTool({
      name:'call_mcp_tool',arguments:{server:'fixture',tool:'stall',arguments:{}}
    });
    void pending.catch(()=>{});
    await until(async()=>{
      return Boolean(await readFile(f.externalPending,'utf8').catch(()=>''));
    },'pending external MCP call');
    if(mode==='SIGKILL'){
      const exited=once(f.agent,'exit');
      f.agent.kill('SIGKILL');
      await exited;
    }else{
      await f.cli(mode);
    }
    await until(async()=>!(await alive(serverPid)),
      'external MCP child terminated after '+mode,6000);
    if(mode==='reload'){
      await until(()=>isOpen(f.port),'HTTP port rebound after MCP reload');
    }else{
      await until(async()=>!(await isOpen(f.port)),'HTTP port released');
    }
  });
}

// Independent review V7: the SDK owns only the direct wrapper PID; its
// stdio-serving descendant survives when the wrapper alone is SIGKILLed.
for(const mode of ['SIGKILL','stop','reload'] as const){
  test('wrapped MCP child terminates with Agent on '+mode,{
    skip:process.platform!=='linux',timeout:26000
  },async t=>{
    const f=await fixture(t,'wrapped');
    const client=await f.client();
    const discovered=await client.callTool({
      name:'list_mcp_tools',arguments:{server:'fixture'}
    });
    assert.equal(discovered.isError,undefined,JSON.stringify(discovered));
    let actual=0,wrapper=0;
    await until(async()=>{
      actual=(await pidFromMarker(f.externalMarker))??0;
      wrapper=(await pidFromMarker(f.wrapperMarker))??0;
      return actual>0&&wrapper>0&&await alive(actual)&&await alive(wrapper);
    },'wrapped external MCP server and launcher');
    f.trackExternal(actual);
    f.trackExternal(wrapper);
    // The owned launcher must really lead its own private Linux session.
    const stat=(await readFile('/proc/'+wrapper+'/stat','utf8'))
      .split(') ')[1].trim().split(/\s+/);
    assert.equal(Number(stat[2]),wrapper,'Wrapper not the group leader');
    assert.equal(Number(stat[3]),wrapper,'Wrapper not the session leader');
    if(mode==='SIGKILL'){
      const exited=once(f.agent,'exit');
      f.agent.kill('SIGKILL');
      await exited;
    }else await f.cli(mode);
    await until(async()=>!(await alive(wrapper)),
      'wrapper termination after '+mode,5500);
    await until(async()=>!(await alive(actual)),
      'real external MCP descendant termination after '+mode,5500);
    if(mode==='reload'){
      await until(()=>isOpen(f.port),'HTTP port rebound after MCP reload');
    }else{
      await until(async()=>!(await isOpen(f.port)),'releasing HTTP port');
    }
  });
}
