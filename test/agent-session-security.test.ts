import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';

test('Agent remote gate requires approved session or global unlock; local callers retain legacy policy',async t=>{
  const root=await mkdtemp(join(tmpdir(),'agent-session-gate-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const code=String.raw`
    import assert from 'node:assert/strict';
    import {mkdir,writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    import {homedir} from 'node:os';
    import {authorizeTool} from './src/security.ts';
    const config={fileRead:true,fileWrite:true,fileDelete:true,shell:true,
      processes:true,externalMcp:true,alwaysUnlocked:false};
    const check=(name,remote,allowed)=>authorizeTool(config,name,remote).then(x=>assert.equal(x.allowed,allowed,name));
    await check('read_file',{approved:false},false);
    await check('run_command',{approved:false},false);
    await check('write_file',{approved:false},false);
    await check('workspace_info',{approved:false},true);
    await check('list_workspaces',{approved:false},true);
    await check('run_command',{approved:true},true);
    await check('write_file',{approved:true},true);
    await check('read_file',{approved:true},true);
    await check('read_file',undefined,true);
    await check('run_command',undefined,false);
    const state=join(homedir(),'.localmcp');
    await mkdir(state,{recursive:true});
    await writeFile(join(state,'unlock.json'),JSON.stringify({
      version:2,source:'remote',until:Date.now()+60_000,hardUntil:Date.now()+60_000,
      idleMinutes:1,lastActivityAt:Date.now()
    }));
    await check('run_command',{approved:false},true);
    await check('write_file',{approved:false},true);
    console.log('Agent gate isolated checks passed');
  `;
  const proc=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{
    cwd:resolve('.'),env:{...process.env,HOME:root,USERPROFILE:root},stdio:['ignore','pipe','pipe']
  });
  let output='';
  proc.stdout.on('data',x=>{output+=x.toString();});
  proc.stderr.on('data',x=>{output+=x.toString();});
  const codeResult=await new Promise<number|null>((done,reject)=>{
    proc.on('error',reject);proc.on('close',done);
  });
  assert.equal(codeResult,0,output);
  assert.match(output,/Agent gate isolated checks passed/);
});
