import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {resolve} from 'node:path';
// Invoked with HOME pointing at an isolated temporary directory.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {
  unlockFile,unlockFenceFile,unlockLocal,lockLocal,getUnlockStatus,
  renewUnlockLease,resetUnlockOnAgentStart
} from '../../dist/security.js';

const config={alwaysUnlocked:false,renewUnlockOnPrivilegedUse:true,
  unlockIdleMinutes:5,unlockMaxSessionMinutes:30};

await unlockLocal(5,{source:'remote'});
assert.equal((await getUnlockStatus()).locked,false,'precondition: globally unlocked');
const oldLease=await readFile(unlockFile,'utf8');
assert.match(JSON.parse(oldLease).fence,/^[a-f0-9]{64}$/,'Remote Unlock must rotate its generation');
await lockLocal('remote_lock_test');
const generation=(await readFile(unlockFenceFile,'utf8')).trim();
assert.match(generation,/^[a-f0-9]{64}$/);
await writeFile(unlockFile,oldLease);
assert.equal((await getUnlockStatus()).locked,true,'late writer must not resurrect an old lease');

const explicit=await unlockLocal(5,{source:'remote'});
assert.equal(explicit.locked,false,'new explicit Remote Unlock can issue a current lease');
const renewed=await renewUnlockLease(config);
assert.equal(renewed.locked,false,'fixed Remote Unlock remains active before expiry');
const lease=JSON.parse(await readFile(unlockFile,'utf8'));
assert.notEqual(lease.fence,generation,'Remote Unlock rotates the older Lock generation');
await lockLocal('remote_lock_after_renewal');
await writeFile(unlockFile,JSON.stringify(lease));
assert.equal((await getUnlockStatus()).locked,true,'stale renewed lease denied after second lock');

await unlockLocal(5,{source:'remote'});
const child=spawn(process.execPath,[resolve('test/fixtures/late-unlock-writer.mjs')],{
  cwd:process.cwd(),env:process.env,stdio:['pipe','pipe','pipe']
});
const [ready]=await once(child.stdout,'data');
assert.match(String(ready),/READY/);
const exit=once(child,'exit');
await lockLocal('cross_process_lock');
child.stdin.write('GO\n');
const [code]=await exit;
assert.equal(code,0,'delayed writer must complete after owner lock');
assert.equal((await getUnlockStatus()).locked,true,
  'another OS process must not revive an old unlock lease after Lock completed');

await unlockLocal(5,{source:'local'});
const beforeRestart=await readFile(unlockFile,'utf8');
await resetUnlockOnAgentStart();
await writeFile(unlockFile,beforeRestart);
assert.equal((await getUnlockStatus()).locked,true,'agent restart fences orphaned renewals');

for(let i=0;i<30;i++){
  await unlockLocal(5,{source:'remote'});
  const competing=Array.from({length:12},()=>renewUnlockLease(config));
  await lockLocal('competing_renewals');
  await Promise.all(competing);
  assert.equal((await getUnlockStatus()).locked,true,`lock must win concurrent renewals in iteration ${i}`);
}
console.log('PASS delayed stale write and cross-process renewal rejected; new unlock/renewal works; restart fences; 30x12 competing renewals cannot resurrect Lock');
