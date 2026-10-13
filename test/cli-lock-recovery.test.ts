import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

async function stopCli(home:string,timeout=2000){
  const cmd=spawn(process.execPath,[resolve('dist/index.js'),'stop'],{
    env:{...process.env,HOME:home,USERPROFILE:home},
    stdio:['ignore','pipe','pipe']
  });
  let output='';
  cmd.stderr?.on('data',chunk=>{output+=chunk.toString();});
  cmd.stdout?.on('data',chunk=>{output+=chunk.toString();});
  return await new Promise<{code:number|null;timeout:boolean;output:string}>(resolveResult=>{
    let done=false;
    const timer=setTimeout(()=>{
      if(done)return;
      done=true;
      cmd.kill('SIGKILL');
      resolveResult({code:null,timeout:true,output});
    },timeout);
    cmd.once('exit',code=>{
      if(done)return;
      done=true;
      clearTimeout(timer);
      resolveResult({code,timeout:false,output});
    });
    cmd.once('error',error=>{
      if(done)return;
      done=true;
      clearTimeout(timer);
      resolveResult({code:-1,timeout:false,output:String(error)});
    });
  });
}

test('Linux CLI lifecycle ignores incomplete and PID-reused stale control.lock',{
  skip:process.platform!=='linux',timeout:9000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-cli-lock-recovery-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const state=join(home,'.localmcp');
  await mkdir(state,{recursive:true});
  const lock=join(state,'control.lock');

  // A power loss could leave an empty lock; PID reuse can make a stale lock
  // appear live even when the process is unrelated.
  for(const stale of ['',String(process.pid)]){
    await writeFile(lock,stale);
    const outcome=await stopCli(home);
    assert.equal(outcome.timeout,false,
      'CLI blocked by stale control.lock containing '+JSON.stringify(stale));
    assert.equal(outcome.code,0,outcome.output);
  }
});


test('Linux concurrent CLI commands wait for a live kernel-owned lock',{
  skip:process.platform!=='linux',timeout:9000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-cli-live-lock-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const holder=fork(resolve('test/fixtures/hold-cli-lock.mjs'),[],{
    env:{...process.env,HOME:home,USERPROFILE:home},
    stdio:['ignore','ignore','pipe','ipc']
  });
  t.after(()=>{if(holder.exitCode===null)holder.kill('SIGKILL');});
  await new Promise<void>((ok,no)=>{
    const timer=setTimeout(()=>no(new Error('Live lock fixture did not start')),3000);
    holder.on('message',message=>{
      if(message==='held'){clearTimeout(timer);ok();}
    });
    holder.once('error',no);
  });
  let completed=false;
  const command=stopCli(home,5000).then(outcome=>{
    completed=true;
    return outcome;
  });
  await new Promise(ok=>setTimeout(ok,350));
  assert.equal(completed,false,'Second lifecycle command bypassed the held lock');
  holder.send('release');
  const outcome=await command;
  assert.equal(outcome.timeout,false);
  assert.equal(outcome.code,0,outcome.output);
});
