import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
test('Remote Unlock has selected fixed deadline, never renews, and leaves CLI sliding',async()=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-fixed-remote-'));
  try{
    const output=execFileSync(process.execPath,[resolve('test/fixtures/verify-fixed-remote-unlock.mjs')],{
      cwd:process.cwd(),env:{...process.env,HOME:home,USERPROFILE:home},encoding:'utf8',timeout:15000
    });
    assert.match(output,/PASS fixed Remote Unlock deadlines/);
  }finally{await rm(home,{recursive:true,force:true});}
});
