import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {lstat,mkdir,mkdtemp,readFile,rm,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {UNIT_NAME} from '../scripts/systemd-user-service.mjs';

const pause=(ms:number)=>new Promise(done=>setTimeout(done,ms));
async function waitFor(probe:()=>Promise<boolean>,label:string,timeout=7000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    if(await probe())return;
    await pause(50);
  }
  throw new Error('Timeout waiting for '+label);
}
function runNode(args:string[],env:NodeJS.ProcessEnv,timeout=11000){
  const child=spawn(process.execPath,args,{
    cwd:resolve('.'),env,stdio:['ignore','pipe','pipe']
  });
  let output='';
  child.stdout?.on('data',(chunk:Buffer)=>{
    output=(output+chunk.toString()).slice(-5000);
  });
  child.stderr?.on('data',(chunk:Buffer)=>{
    output=(output+chunk.toString()).slice(-5000);
  });
  const finished=new Promise<{code:number|null;output:string;timedOut:boolean}>(done=>{
    let settled=false;
    const timer=setTimeout(()=>{
      if(settled)return;
      settled=true;
      child.kill('SIGKILL');
      done({code:null,output,timedOut:true});
    },timeout);
    child.once('exit',code=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      done({code,output,timedOut:false});
    });
    child.once('error',error=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      done({code:null,output:output+' '+error.message,timedOut:false});
    });
  });
  return {child,finished};
}
function childMessage(child:ChildProcess,want:string,timeout=7500){
  return new Promise<void>((yes,no)=>{
    const timer=setTimeout(()=>done(new Error('Timeout waiting for '+want)),timeout);
    function onMessage(message:unknown){
      if(message===want)done();
    }
    function onExit(){done(new Error('Fixture exited before '+want));}
    function done(error?:Error){
      clearTimeout(timer);
      child.off('message',onMessage);
      child.off('exit',onExit);
      error?no(error):yes();
    }
    child.on('message',onMessage);
    child.once('exit',onExit);
  });
}
async function setup(t:import('node:test').TestContext,holdBound=false){
  const home=await mkdtemp(join(tmpdir(),'localmcp-v14-race-'));
  const bin=join(home,'bin');
  await mkdir(join(home,'.localmcp'),{recursive:true,mode:0o700});
  await mkdir(bin,{mode:0o700});
  await writeFile(join(bin,'systemctl'), [
    '#!/bin/sh',
    "printf '%s\\n' \"$*\" >> \"$HOME/systemctl.calls\"",
    'exit 0',
    ''
  ].join('\n'),{mode:0o700});
  await chmod(join(bin,'systemctl'),0o700);
  const env:NodeJS.ProcessEnv={
    ...process.env,HOME:home,USERPROFILE:home,
    PATH:bin+':'+(process.env.PATH??'/usr/bin:/bin'),
    TEST_HOLD_BOUND:holdBound?'1':'0'
  };
  for(const key of [
    'LOCALMCP_INTERNAL','LOCALMCP_SYSTEMD_MANAGED','NOTIFY_SOCKET',
    'WATCHDOG_USEC','LOCALMCP_CONFIG','LOCALMCP_ROOT'
  ])delete env[key];
  const unitPath=join(home,'.config','systemd','user',UNIT_NAME);
  const endpoint=join(home,'.localmcp','agent.sock');
  const agent=fork(resolve('test/fixtures/gated-managed-install-agent.mjs'),[],{
    cwd:resolve('.'),env,stdio:['ignore','ignore','pipe','ipc']
  });
  let stderr='';
  agent.stderr?.on('data',(chunk:Buffer)=>stderr+=chunk.toString());
  t.after(async()=>{
    if(agent.exitCode===null&&agent.signalCode===null){
      const exited=once(agent,'exit').catch(()=>{});
      agent.kill('SIGKILL');
      await Promise.race([exited,pause(900)]);
    }
    await rm(home,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  });
  return {home,env,unitPath,endpoint,agent,readErrors:()=>stderr};
}

test('installer wins after Agent early managed check: late Agent bind refuses',{
  skip:process.platform!=='linux',timeout:16000
},async t=>{
  const {env,unitPath,endpoint,agent,readErrors}=await setup(t);
  await childMessage(agent,'early-check-passed');

  // Agent passed its original top-level check, but has not entered the
  // control-socket ownership-critical section.
  const installed=await runNode(
    [resolve('scripts/systemd-user-service.mjs'),'install'],env
  ).finished;
  assert.equal(installed.timedOut,false);
  assert.equal(installed.code,0,installed.output);
  assert.match(await readFile(unitPath,'utf8'),/^# Managed by Easy Local MCP/m);

  const exited=once(agent,'exit');
  agent.send('continue');
  const [code]=await exited;
  assert.notEqual(code,0,'Agent must not remain unsupervised after install');
  assert.match(readErrors(),/installed as a systemd user service/);
  await assert.rejects(lstat(endpoint),{code:'ENOENT'});
});

test('Agent holds startup ownership: installer waits and refuses after Agent binds',{
  skip:process.platform!=='linux',timeout:16000
},async t=>{
  const {home,env,unitPath,agent,readErrors}=await setup(t,true);
  await childMessage(agent,'early-check-passed');
  const bound=childMessage(agent,'bound-under-startup-lock');
  const ready=childMessage(agent,'ready');
  agent.send('continue');
  await bound;

  // Endpoint bound and mutex held, but initial security not yet complete.
  const installing=runNode(
    [resolve('scripts/systemd-user-service.mjs'),'install'],env
  );
  try{
    await waitFor(async()=>{
      const calls=await readFile(join(home,'systemctl.calls'),'utf8').catch(()=>'');
      return calls.includes('--user show-environment');
    },'installer systemctl preflight');
    await pause(220);
    assert.equal(installing.child.exitCode,null,
      'Installer ran past a mutex owned by an initializing Agent');
    await assert.rejects(readFile(unitPath,'utf8'),{code:'ENOENT'});
  }finally{
    agent.send('release-bound');
  }
  await ready;
  const result=await installing.finished;
  assert.equal(result.timedOut,false);
  assert.equal(result.code,1,result.output);
  assert.match(result.output,/Stop it with the normal CLI/);
  assert.equal(agent.exitCode,null,readErrors());
  await assert.rejects(readFile(unitPath,'utf8'),{code:'ENOENT'});
});

test('installer cannot commit a unit while the Agent startup mutex is held',{
  skip:process.platform!=='linux',timeout:16000
},async t=>{
  const {home,env,unitPath,endpoint,agent}=await setup(t);
  // Fixture is parked before control-socket startup; test owns its mutex.
  await childMessage(agent,'early-check-passed');
  const {withStartupLock}=await import('../src/socket-recovery.js');
  let acquired!:()=>void;
  let release!:()=>void;
  const ready=new Promise<void>(resolve=>{acquired=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const holding=withStartupLock(endpoint,async()=>{
    acquired();
    await gate;
  });
  await ready;
  const installing=runNode(
    [resolve('scripts/systemd-user-service.mjs'),'install'],env
  );
  try{
    await waitFor(async()=>{
      const calls=await readFile(join(home,'systemctl.calls'),'utf8').catch(()=>'');
      return calls.includes('--user show-environment');
    },'installer entering startup mutex');
    await pause(250);
    assert.equal(installing.child.exitCode,null,
      'Installer should be blocked by the same Agent startup lock');
    await assert.rejects(readFile(unitPath,'utf8'),{code:'ENOENT'});
  }finally{
    release();
    await holding;
  }
  const installed=await installing.finished;
  assert.equal(installed.timedOut,false);
  assert.equal(installed.code,0,installed.output);
  assert.match(await readFile(unitPath,'utf8'),/^# Managed by Easy Local MCP/m);
});
