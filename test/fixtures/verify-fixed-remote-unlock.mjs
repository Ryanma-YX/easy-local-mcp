import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {unlockLocal,renewUnlockLease,getUnlockStatus,unlockFile,lockLocal} from '../../dist/security.js';
const config={alwaysUnlocked:false,renewUnlockOnPrivilegedUse:true,unlockIdleMinutes:5,unlockMaxSessionMinutes:60};
const realNow=Date.now;
let now=Date.parse('2026-10-15T00:00:00Z');
Date.now=()=>now;
try{
  for(const minutes of [5,15,30,60]){
    await lockLocal('isolated_test');
    const result=await unlockLocal(minutes,{source:'remote',maxSessionMinutes:60});
    const expected=now+minutes*60_000;
    assert.equal(Date.parse(result.expiresAt),expected);
    assert.equal(Date.parse(result.hardExpiresAt),expected);
    const before=await readFile(unlockFile,'utf8');
    now+=minutes*60_000-1;
    await renewUnlockLease(config);
    assert.equal(await readFile(unlockFile,'utf8'),before,'activity cannot renew Remote Unlock');
    assert.equal((await getUnlockStatus()).locked,false);
    now+=1;
    assert.equal((await getUnlockStatus()).locked,true,'deadline must be exact');
    now+=10_000;
  }
  // A delayed older local renewal must not silently revive its former
  // sliding interval after the owner selected a fixed Remote Unlock.
  await unlockLocal(15,{source:'local',maxSessionMinutes:60});
  const oldLease=await readFile(unlockFile,'utf8');
  await unlockLocal(5,{source:'remote',maxSessionMinutes:60});
  const newLease=await readFile(unlockFile,'utf8');
  assert.notEqual(JSON.parse(oldLease).fence,JSON.parse(newLease).fence);
  await writeFile(unlockFile,oldLease);
  assert.equal((await getUnlockStatus()).locked,true,
    'old delayed lease write must fail closed, not extend new Remote Unlock');
  await unlockLocal(5,{source:'local',maxSessionMinutes:60});
  const before=(await getUnlockStatus()).expiresAt;
  now+=4*60_000;
  assert.notEqual((await renewUnlockLease(config)).expiresAt,before,'local CLI still renews');
  console.log('PASS fixed Remote Unlock deadlines, nonrenewal and local CLI behavior');
}finally{Date.now=realNow;}
