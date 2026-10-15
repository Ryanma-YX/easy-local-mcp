import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

test('Remote Lock fences delayed cross-process lease renewals',async()=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-unlock-fence-'));
  try{
    const output=execFileSync(process.execPath,[
      resolve('test/fixtures/verify-unlock-fence.mjs')
    ],{
      cwd:process.cwd(),
      env:{...process.env,HOME:home,USERPROFILE:home},
      encoding:'utf8',timeout:15000
    });
    assert.match(output,/PASS delayed stale write and cross-process renewal rejected/);
  }finally{
    await rm(home,{recursive:true,force:true});
  }
});
