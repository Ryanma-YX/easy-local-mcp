import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {createServer,type Server} from 'node:net';
import {chmod,lstat,mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {assertNoStandaloneAgent,UNIT_NAME} from '../scripts/systemd-user-service.mjs';

const pause=(ms:number)=>new Promise(done=>setTimeout(done,ms));
async function waitFor(probe:()=>Promise<boolean>,label:string,timeout=9500){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    if(await probe())return;
    await pause(60);
  }
  throw new Error('Timeout waiting for '+label);
}
async function unusedPort():Promise<number>{
  const listener=createServer();
  await new Promise<void>((done,reject)=>{
    listener.once('error',reject);
    listener.listen(0,'127.0.0.1',done);
  });
  const address=listener.address();
  assert.ok(address&&typeof address!=='string');
  await new Promise<void>(done=>listener.close(()=>done()));
  return address.port;
}
function runNode(args:string[],env:NodeJS.ProcessEnv,timeout=12000){
  return new Promise<{code:number|null;output:string;timedOut:boolean}>(done=>{
    const child=spawn(process.execPath,args,{cwd:resolve('.'),env,
      stdio:['ignore','pipe','pipe']});
    let output='',settled=false;
    const timer=setTimeout(()=>finish(null,true),timeout);
    child.stdout?.on('data',(chunk:Buffer)=>{output=(output+chunk.toString()).slice(-10000);});
    child.stderr?.on('data',(chunk:Buffer)=>{output=(output+chunk.toString()).slice(-10000);});
    function finish(code:number|null,timedOut:boolean){
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      if(timedOut)child.kill('SIGKILL');
      done({code,output,timedOut});
    }
    child.once('exit',code=>finish(code,false));
    child.once('error',error=>{output+='\n'+error.message;finish(null,false);});
  });
}
async function closeServer(server:Server|undefined){
  if(server?.listening)await new Promise<void>(done=>server.close(()=>done()));
}

test('installer preflight rejects non-socket entries while accepting genuine stale sockets',{
  skip:process.platform!=='linux',timeout:15000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-v12-inodes-'));
  const stateDir=join(home,'.localmcp');
  const socketFile=join(stateDir,'agent.sock');
  let staleOwner:ChildProcess|undefined;
  await mkdir(stateDir,{mode:0o700});
  t.after(async()=>{
    if(staleOwner&&staleOwner.exitCode===null&&staleOwner.signalCode===null){
      staleOwner.kill('SIGKILL');
    }
    await rm(home,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  });

  await assert.doesNotReject(assertNoStandaloneAgent(home));
  await writeFile(socketFile,'not a socket');
  await assert.rejects(assertNoStandaloneAgent(home),/not a Unix socket/);
  await rm(socketFile);

  const target=join(stateDir,'regular-target');
  await writeFile(target,'not a socket');
  await symlink(target,socketFile);
  await assert.rejects(assertNoStandaloneAgent(home),/not a Unix socket/);
  await rm(socketFile);

  await mkdir(socketFile);
  await assert.rejects(assertNoStandaloneAgent(home),/not a Unix socket/);
  await rm(socketFile,{recursive:true});

  // SIGKILL leaves a genuine Unix socket inode: Agent startup can reclaim it.
  staleOwner=spawn(process.execPath,['-e',
    "require('node:net').createServer().listen(process.argv[1],()=>console.log('ready'))",
    socketFile
  ],{stdio:['ignore','pipe','pipe']});
  await waitFor(async()=>{
    if(staleOwner!.exitCode!==null||staleOwner!.signalCode!==null){
      throw new Error('Stale-socket fixture exited early');
    }
    try{return (await lstat(socketFile)).isSocket();}
    catch{return false;}
  },'live Unix socket inode');
  const exited=once(staleOwner,'exit');
  staleOwner.kill('SIGKILL');
  await exited;
  assert.equal((await lstat(socketFile)).isSocket(),true);
  await assert.doesNotReject(assertNoStandaloneAgent(home));

  if(process.getuid?.()!==0){
    await chmod(stateDir,0o000);
    try{
      await assert.rejects(assertNoStandaloneAgent(home),/Cannot safely inspect/);
    }finally{
      await chmod(stateDir,0o700);
    }
  }
});

test('real standalone Agent blocks installer, then stop permits install and managed update',{
  skip:process.platform!=='linux',timeout:36000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-v12-installer-'));
  const stateDir=join(home,'.localmcp');
  const bin=join(home,'bin');
  const socketFile=join(stateDir,'agent.sock');
  const unitPath=join(home,'.config','systemd','user',UNIT_NAME);
  const port=await unusedPort();
  let agent:ChildProcess|undefined;
  let fakeManagedListener:Server|undefined;
  await mkdir(stateDir,{recursive:true,mode:0o700});
  await mkdir(bin,{mode:0o700});
  await writeFile(join(stateDir,'worker.json'),JSON.stringify({
    workerUrl:'http://127.0.0.1:9/',
    agentToken:'a'.repeat(64),
    mcpToken:'b'.repeat(64),
    deviceId:'disposable-v12-test-agent'
  }),{mode:0o600});
  await writeFile(join(bin,'systemctl'), [
    '#!/bin/sh',
    "printf '%s\\n' \"$*\" >> \"$HOME/isolated-systemctl.calls\"",
    'exit 0',
    ''
  ].join('\n'),{mode:0o700});
  await chmod(join(bin,'systemctl'),0o700);
  const env:NodeJS.ProcessEnv={
    ...process.env,
    HOME:home,USERPROFILE:home,
    PATH:bin+':'+(process.env.PATH??'/usr/bin:/bin'),
    LOCALMCP_WORKER_URL:'http://127.0.0.1:9/',
    LOCALMCP_AGENT_PORT:String(port)
  };
  for(const key of ['LOCALMCP_INTERNAL','LOCALMCP_SYSTEMD_MANAGED',
    'LOCALMCP_CONFIG','LOCALMCP_ROOT','LOCALMCP_TOKEN',
    'NOTIFY_SOCKET','WATCHDOG_USEC']){
    delete env[key];
  }
  t.after(async()=>{
    await closeServer(fakeManagedListener);
    if(agent&&agent.exitCode===null&&agent.signalCode===null){
      agent.kill('SIGTERM');
      await Promise.race([once(agent,'exit').catch(()=>{}),pause(1200)]);
      if(agent.exitCode===null&&agent.signalCode===null)agent.kill('SIGKILL');
    }
    await pause(100);
    await rm(home,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  });

  agent=spawn(process.execPath,[resolve('dist/index.js'),'agent'],{
    cwd:resolve('.'),env,stdio:['ignore','pipe','pipe']
  });
  let agentLogs='';
  agent.stdout?.on('data',(chunk:Buffer)=>{
    agentLogs=(agentLogs+chunk.toString()).slice(-3000);
  });
  agent.stderr?.on('data',(chunk:Buffer)=>{
    agentLogs=(agentLogs+chunk.toString()).slice(-3000);
  });
  await waitFor(async()=>{
    if(agent!.exitCode!==null||agent!.signalCode!==null){
      throw new Error('Standalone test Agent exited: '+agentLogs);
    }
    try{
      await assertNoStandaloneAgent(home);
      return false;
    }catch(error){
      if(/A standalone Easy Local MCP Agent is already running/.test(String(error))){
        return true;
      }
      throw error;
    }
  },'real standalone Agent to listen',11000);

  const firstInstall=await runNode(
    [resolve('scripts/systemd-user-service.mjs'),'install'],env
  );
  assert.equal(firstInstall.timedOut,false);
  assert.equal(firstInstall.code,1,firstInstall.output);
  assert.match(firstInstall.output,/Stop it with the normal CLI/);
  await assert.rejects(readFile(unitPath,'utf8'),{code:'ENOENT'});
  assert.equal(agent.exitCode,null,'Installer terminated standalone Agent');
  assert.equal(agent.signalCode,null,'Installer signaled standalone Agent');

  const stopped=await runNode([resolve('dist/index.js'),'stop'],env);
  assert.equal(stopped.timedOut,false);
  assert.equal(stopped.code,0,stopped.output);
  await waitFor(async()=>agent!.exitCode!==null||agent!.signalCode!==null,
    'standalone Agent to exit after CLI stop');
  await waitFor(async()=>{
    try{await lstat(socketFile);return false;}
    catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT';}
  },'normal shutdown to release socket');

  const secondInstall=await runNode(
    [resolve('scripts/systemd-user-service.mjs'),'install'],env
  );
  assert.equal(secondInstall.timedOut,false);
  assert.equal(secondInstall.code,0,secondInstall.output);
  assert.match(await readFile(unitPath,'utf8'),/^# Managed by Easy Local MCP/m);

  // An existing installer-owned unit can be refreshed while its Agent listens.
  fakeManagedListener=createServer(socket=>socket.end());
  await new Promise<void>((done,reject)=>{
    fakeManagedListener!.once('error',reject);
    fakeManagedListener!.listen(socketFile,done);
  });
  const update=await runNode(
    [resolve('scripts/systemd-user-service.mjs'),'install'],env
  );
  assert.equal(update.timedOut,false);
  assert.equal(update.code,0,update.output);
  const calls=await readFile(join(home,'isolated-systemctl.calls'),'utf8');
  assert.match(calls,/--user show-environment/);
  assert.match(calls,/--user daemon-reload/);
  assert.doesNotMatch(calls,/--user (stop|start|restart|enable)/);
});
