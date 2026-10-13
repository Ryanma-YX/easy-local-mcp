import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProcessManager} from '../src/process.js';
import {CommandRunner} from '../src/command.js';

const pause=(ms:number)=>new Promise(done=>setTimeout(done,ms));
async function alive(pid:number){
  const s=await readFile('/proc/'+pid+'/stat','utf8').catch(()=>'');
  if(!s)return false;
  const state=s.slice(s.lastIndexOf(')')+2,s.lastIndexOf(')')+3);
  return state!=='Z'&&state!=='X';
}
async function waitFor(action:()=>Promise<boolean>,timeout=2000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    if(await action())return;
    await pause(30);
  }
  throw new Error('Timed out waiting for process state');
}

test('ProcessManager closes process groups after launching shell has exited',{
  skip:process.platform!=='linux',timeout:10000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-shell-group-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const marker=join(home,'descendant.pid');
  const manager=new ProcessManager();
  const started=manager.start('sleep 45 & echo $! > '+marker,home);
  const pgid=started.pid;
  assert.ok(pgid);
  let descendant=0;
  t.after(()=>{
    try{process.kill(-pgid,'SIGKILL');}catch{}
  });
  await waitFor(async()=>{
    const s=await readFile(marker,'utf8').catch(()=>'');
    descendant=Number(s.trim());
    return descendant>0&&!manager.list()[0].running&&await alive(descendant);
  });
  assert.equal(manager.list()[0].running,false);
  await manager.close();
  await waitFor(async()=>!(await alive(descendant)));
});

test('CommandRunner aborts in-flight execution and blocks late starts',{
  skip:process.platform==='win32',timeout:10000
},async()=>{
  const commands=new CommandRunner();
  const operation=commands.run('sleep 45',process.cwd(),120000);
  await pause(150);
  await commands.close();
  const result=await operation;
  assert.equal(result.timedOut,false);
  assert.equal(result.signal,'SIGKILL');
  await assert.rejects(commands.run('echo too-late',process.cwd(),1000),
    /Command runner is shutting down/);
});

test('stop_process still terminates background group after its shell exited',{
  skip:process.platform!=='linux',timeout:10000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-stop-background-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const marker=join(home,'background.pid');
  const manager=new ProcessManager();
  const started=manager.start('sleep 45 & echo $! > '+marker,home);
  t.after(()=>{
    try{process.kill(-started.pid,'SIGKILL');}catch{}
  });
  let descendant=0;
  await waitFor(async()=>{
    const value=await readFile(marker,'utf8').catch(()=>'');
    descendant=Number(value.trim());
    return descendant>0&&!manager.list()[0].running&&await alive(descendant);
  });
  const stopped=manager.stop(started.processId);
  assert.equal(stopped.running,false);
  await waitFor(async()=>!(await alive(descendant)));
  await manager.close();
});
