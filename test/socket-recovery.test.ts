import test from 'node:test';
import assert from 'node:assert/strict';
import {fork, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {listenWithSocketRecovery} from '../dist/socket-recovery.js';
import {lstat, mkdir, mkdtemp, realpath, rm, symlink} from 'node:fs/promises';
import {createConnection, createServer, type Server} from 'node:net';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';

const pause=(ms:number)=>new Promise(done=>setTimeout(done,ms));

function launch(home:string){
  const child=fork(resolve('test/fixtures/control-server.mjs'),[],{
    env:{...process.env,HOME:home,USERPROFILE:home},
    stdio:['ignore','ignore','pipe','ipc'],
    windowsHide:true
  });
  let stderr='';
  child.stderr?.on('data',(data:Buffer)=>{
    stderr+=data.toString();
  });
  const outcome=new Promise<boolean>((done,reject)=>{
    child.once('message',()=>done(true));
    child.once('exit',()=>done(false));
    child.once('error',reject);
  });
  return {child,outcome,stderr:()=>stderr};
}

async function assertListening(path:string){
  await new Promise<void>((done,reject)=>{
    const client=createConnection(path);
    client.once('connect',()=>{
      client.destroy();
      done();
    });
    client.once('error',reject);
  });
}

test('Unix control socket recovers after SIGKILL but never steals a live endpoint',{
  skip:process.platform==='win32',
  timeout:30000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-socket-recovery-'));
  const socketFile=join(home,'.localmcp','agent.sock');
  const children:ChildProcess[]=[];

  const start=()=>{
    const instance=launch(home);
    children.push(instance.child);
    return instance;
  };

  t.after(async()=>{
    for(const child of children){
      if(child.exitCode===null&&child.signalCode===null){
        child.kill('SIGKILL');
      }
    }
    await pause(200);
    await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });

  const crashed=start();
  assert.equal(await crashed.outcome,true,crashed.stderr());
  const exited=once(crashed.child,'exit');
  crashed.child.kill('SIGKILL');
  await exited;
  assert.equal((await lstat(socketFile)).isSocket(),true);

  // An orphaned socket is reclaimed when starting directly, without CLI start.
  const recovered=start();
  assert.equal(await recovered.outcome,true,recovered.stderr());
  await assertListening(socketFile);

  // A second agent must neither remove nor take over a live control socket.
  const duplicate=start();
  assert.equal(await duplicate.outcome,false,'Duplicate agent unexpectedly started');
  assert.match(duplicate.stderr(),/Another agent is already listening/);
  await assertListening(socketFile);

  const stopped=once(recovered.child,'exit');
  recovered.child.kill('SIGKILL');
  await stopped;

  // Two contenders racing to reclaim a stale endpoint yield just one listener.
  const contenders=[start(),start()];
  const outcomes=await Promise.all(contenders.map(candidate=>candidate.outcome));
  assert.deepEqual(outcomes.slice().sort(),[false,true]);
  await assertListening(socketFile);
});

test('obsolete malformed startup lock does not block Unix socket recovery',{
  skip:process.platform==='win32',timeout:30000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-legacy-lock-'));
  const dir=join(home,'.localmcp');
  const file=join(dir,'agent.sock');
  await mkdir(dir,{recursive:true});
  await symlink('invalid',file+'.startup-lock');
  const instance=launch(home);
  t.after(async()=>{
    if(instance.child.exitCode===null&&instance.child.signalCode===null)instance.child.kill('SIGKILL');
    await pause(200);
    await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  assert.equal(await instance.outcome,true,instance.stderr());
  await assertListening(file);
});

test('eight racing Unix socket startup contenders leave exactly one listener',{
  skip:process.platform==='win32',timeout:30000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-startup-race-'));
  const children=Array.from({length:8},()=>launch(home));
  t.after(async()=>{
    for(const entry of children){
      if(entry.child.exitCode===null&&entry.child.signalCode===null)entry.child.kill('SIGKILL');
    }
    await pause(200);
    await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const results=await Promise.all(children.map(entry=>entry.outcome));
  assert.equal(results.filter(Boolean).length,1,JSON.stringify(results));
  await assertListening(join(home,'.localmcp','agent.sock'));
});


/** Delay the control listener after the startup mutex has been acquired. */
function gateControlListen(server:Server){
  const original=server.listen;
  let signalEntered!:()=>void;
  let allowListen!:()=>void;
  const entered=new Promise<void>(resolve=>{signalEntered=resolve;});
  const allowed=new Promise<void>(resolve=>{allowListen=resolve;});
  server.listen=((...args:unknown[])=>{
    signalEntered();
    void allowed.then(()=>Reflect.apply(original,server,args));
    return server;
  }) as typeof server.listen;
  return {entered,allowListen};
}

test('unexpected mutex client cannot indefinitely block startup completion',{
  skip:process.platform!=='linux',timeout:15000
},async()=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-held-mutex-'));
  const path=join(home,'agent.sock');
  const server=createServer(socket=>socket.destroy());
  const gate=gateControlListen(server);
  let client:ReturnType<typeof createConnection>|undefined;
  const startup=listenWithSocketRecovery(server,path,path);
  try{
    await gate.entered; // The kernel-owned mutex is listening now.
    const identity=join(await realpath(dirname(path)),basename(path));
    const mutexAddress='\0localmcp-startup-'+createHash('sha256').update(identity).digest('hex');
    client=createConnection(mutexAddress);
    await once(client,'connect');
    gate.allowListen();
    const outcome=await Promise.race([
      startup.then(()=>'complete'),
      pause(1000).then(()=>'blocked')
    ]);
    assert.equal(outcome,'complete','An unexpected mutex client held the startup lock open');
  }finally{
    gate.allowListen();
    client?.destroy();
    await startup.catch(()=>{});
    if(server.listening){
      await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
    await rm(home,{recursive:true,force:true});
  }
});

test('symlink-alias control paths share the same startup mutex',{
  skip:process.platform==='win32',timeout:15000
},async()=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-alias-mutex-'));
  const realDir=join(home,'actual');
  const aliasDir=join(home,'alias');
  await mkdir(realDir,{recursive:true});
  await symlink(realDir,aliasDir,'dir');
  const actual=join(realDir,'agent.sock');
  const alias=join(aliasDir,'agent.sock');
  const first=createServer(socket=>socket.destroy());
  const second=createServer(socket=>socket.destroy());
  const gate=gateControlListen(first);
  const firstAttempt=listenWithSocketRecovery(first,actual,actual);
  let secondReachedControlListen=false;
  const originalSecondListen=second.listen;
  second.listen=((...args:unknown[])=>{
    secondReachedControlListen=true;
    return Reflect.apply(originalSecondListen,second,args);
  }) as typeof second.listen;
  let secondAttempt:Promise<string>|undefined;
  try{
    await gate.entered; // First agent holds the mutex without binding its endpoint.
    secondAttempt=listenWithSocketRecovery(second,alias,alias).then(
      ()=> 'bound',
      (error:Error)=>error.message
    );
    await pause(300);
    assert.equal(secondReachedControlListen,false,
      'The symlink alias bypassed the active startup mutex');
    gate.allowListen();
    await firstAttempt;
    const secondResult=await secondAttempt;
    assert.match(secondResult,/Another agent is already listening/);
    await assertListening(alias);
  }finally{
    gate.allowListen();
    await firstAttempt.catch(()=>{});
    await secondAttempt?.catch(()=>{});
    for(const server of [first,second]){
      if(server.listening){
        await new Promise<void>(resolve=>server.close(()=>resolve()));
      }
    }
    await rm(home,{recursive:true,force:true});
  }
});
