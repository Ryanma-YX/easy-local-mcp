import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawn,type ChildProcess} from 'node:child_process';
import {readFile,mkdtemp,mkdir,rm,writeFile,lstat} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const pause=(ms:number)=>new Promise(done=>setTimeout(done,ms));
function message(child:ChildProcess,want:string,timeout=5000){
  return new Promise<void>((yes,no)=>{
    const timer=setTimeout(()=>done(new Error('Timeout waiting for '+want)),timeout);
    const onMessage=(s:unknown)=>{if(s===want)done();};
    const onExit=()=>done(new Error('Child exited before '+want));
    function done(err?:Error){
      clearTimeout(timer);child.off('message',onMessage);child.off('exit',onExit);
      err?no(err):yes();
    }
    child.on('message',onMessage);child.once('exit',onExit);
  });
}
function exited(child:ChildProcess,timeout=8000){
  return new Promise<number|null>((yes,no)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');no(new Error('Child exit timeout'));},timeout);
    child.once('exit',code=>{clearTimeout(timer);yes(code);});
  });
}
async function lease(home:string){
  const dir=join(home,'.localmcp');
  await mkdir(dir,{recursive:true,mode:0o700});
  const file=join(dir,'unlock.json');
  const now=Date.now();
  const value=JSON.stringify({
    version:2,source:'local',until:now+600000,hardUntil:now+1200000,
    idleMinutes:10,lastActivityAt:now
  });
  await writeFile(file,value,{mode:0o600});
  return {file,value,dir};
}
async function status(home:string){
  const dir=join(home,'.localmcp');
  const secret=(await readFile(join(dir,'control.secret'),'utf8')).trim();
  return new Promise<string>(yes=>{
    const socket=createConnection(join(dir,'agent.sock'));
    let text='',done=false;
    const timer=setTimeout(finish,1400);
    function finish(){
      if(done)return;done=true;clearTimeout(timer);socket.destroy();yes(text);
    }
    socket.on('connect',()=>socket.write(JSON.stringify({command:'status',secret})+'\n'));
    socket.on('data',chunk=>{text+=chunk.toString();});
    socket.on('error',finish);socket.on('end',finish);socket.on('close',finish);
  });
}
function forkGate(home:string,extra:Record<string,string>={}){
  return fork(resolve('test/fixtures/control-startup-gate.mjs'),[],{
    env:{...process.env,HOME:home,USERPROFILE:home,...extra},
    stdio:['ignore','ignore','pipe','ipc']
  });
}
function spawnAgent(home:string){
  return spawn(process.execPath,[resolve('dist/agent.js')],{
    env:{...process.env,HOME:home,USERPROFILE:home,LOCALMCP_WORKER_URL:'http://127.0.0.1:9'},
    stdio:['ignore','ignore','pipe']
  });
}
async function cleanup(home:string,children:ChildProcess[]){
  for(const child of children){
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  }
  await pause(180);
  await rm(home,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}

test('rejected duplicate agent preserves running agent unlock lease',{
  skip:process.platform==='win32',timeout:16000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-owner-duplicate-'));
  const children:ChildProcess[]=[];
  t.after(()=>cleanup(home,children));
  const first=fork(resolve('test/fixtures/control-server.mjs'),[],{
    env:{...process.env,HOME:home,USERPROFILE:home},
    stdio:['ignore','ignore','pipe','ipc']
  });
  children.push(first);
  await message(first,'ready');
  const current=await lease(home);
  const duplicate=spawnAgent(home);
  children.push(duplicate);
  let stderr='';
  duplicate.stderr?.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
  assert.equal(await exited(duplicate),1,stderr);
  assert.match(stderr,/Another agent is already listening/);
  assert.equal(await readFile(current.file,'utf8'),current.value,
    'Duplicate startup erased active unlock');
  const reply=JSON.parse(await status(home));
  assert.equal(reply.status,'running');
  assert.equal(reply.pid,first.pid);
});

test('owner resets stale unlock before it serves any control requests',{
  skip:process.platform==='win32',timeout:16000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-owner-gated-'));
  const children:ChildProcess[]=[];
  t.after(()=>cleanup(home,children));
  const current=await lease(home);
  const agent=forkGate(home,{TEST_GATE_STARTUP:'1'});
  children.push(agent);
  await message(agent,'bound-before-init');
  assert.equal(await readFile(current.file,'utf8'),current.value);
  const early=await status(home);
  assert.equal(early,'','Request was accepted before startup security reset');
  const ready=message(agent,'ready');
  agent.send('continue');
  await ready;
  await assert.rejects(readFile(current.file,'utf8'),{code:'ENOENT'});
  const reply=JSON.parse(await status(home));
  assert.equal(reply.status,'running');
  assert.equal(reply.locked,true);
});

test('initialization failure closes endpoint without erasing unlock state',{
  skip:process.platform==='win32',timeout:16000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-owner-failure-'));
  const children:ChildProcess[]=[];
  t.after(()=>cleanup(home,children));
  const current=await lease(home);
  const child=forkGate(home,{TEST_GATE_STARTUP:'1',TEST_FAIL_STARTUP:'1'});
  children.push(child);
  await message(child,'bound-before-init');
  const result=exited(child);
  child.send('continue');
  assert.equal(await result,1);
  assert.equal(await readFile(current.file,'utf8'),current.value);
  await assert.rejects(lstat(join(current.dir,'agent.sock')),{code:'ENOENT'});
});

test('fresh real agent resets stale unlock after claiming endpoint',{
  skip:process.platform==='win32',timeout:16000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-owner-fresh-'));
  const children:ChildProcess[]=[];
  t.after(()=>cleanup(home,children));
  const current=await lease(home);
  const child=spawnAgent(home);
  children.push(child);
  await exited(child);
  await assert.rejects(readFile(current.file,'utf8'),{code:'ENOENT'});
  assert.match(await readFile(join(current.dir,'audit.log'),'utf8'),
    /"event":"agent_start"/);
});
