import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAgentSessionStorage,type AgentSessionRecord} from '../worker/agent-session-store.js';
class Store{
  items=new Map<string,unknown>();
  async get<T>(k:string){return this.items.get(k) as T|undefined;}
  async put(k:string,v:unknown){this.items.set(k,structuredClone(v));}
  async delete(k:string){this.items.delete(k);}
  async list<T>({prefix}:{prefix:string}){return new Map([...this.items].filter(([k])=>k.startsWith(prefix))) as Map<string,T>;}
  async transaction<T>(fn:(store:Store)=>Promise<T>){return fn(this);}
}
const id='aa111111-1111-4111-8111-111111111111';
const device='bb222222-2222-4222-8222-222222222222';
const connector='cc333333-3333-4333-8333-333333333333';
const hour=60*60_000;
function fixture(){
  const store=new Store();
  const now=Date.now();
  const record:AgentSessionRecord={id,tokenHash:'a'.repeat(64),connectorHash:'b'.repeat(64),connectorKind:'zone',connectorId:connector,scope:'devices',devices:[device],tools:['read_file'],requestedTools:['read_file'],idleHours:24,note:'fixture',createdAt:new Date(now).toISOString(),pendingUntil:new Date(now+15*60_000).toISOString(),state:'approved',approvedAt:new Date(now).toISOString(),approvedHours:48,hardUntil:new Date(now+48*hour).toISOString(),idleUntil:new Date(now+24*hour).toISOString()};
  store.items.set('agent-session:'+id,record);
  const call=async(action:string,body:Record<string,unknown>={})=>handleAgentSessionStorage(store as any,new Request('https://admin.internal/agent-sessions/'+action,{method:'POST',body:JSON.stringify({id,...body})}));
  return {call,record:()=>store.items.get('agent-session:'+id) as AgentSessionRecord};
}
test('Edit changes only owner tools, not token, original request or device scope',async()=>{
  const f=fixture();const original=f.record();
  assert.equal((await f.call('edit',{approvedTools:['read_file','edit_file']}))!.status,200);
  assert.deepEqual(f.record().tools,['read_file','edit_file']);
  for(const field of ['tokenHash','connectorHash','connectorKind','connectorId','scope','devices','requestedTools','hardUntil','idleUntil'] as const){
    assert.deepEqual(f.record()[field],original[field],field);
  }
  for(const invalid of [[],['read_file','read_file'],['*','read_file'],['unknown']]){
    assert.equal((await f.call('edit',{approvedTools:invalid}))!.status,400);
  }
  assert.equal((await f.call('edit',{approvedTools:['*']}))!.status,400);
  assert.deepEqual(f.record().tools,['read_file','edit_file'],
    'Attempting a new wildcard edit must leave the existing grant intact');
});
test('Extend replaces deadline relative to now, can repeat, resets idle, does not revive revoked/expired',async()=>{
  const f=fixture();
  assert.equal((await f.call('extend',{approvedHours:1}))!.status,200);
  const first=f.record().hardUntil;
  assert.ok(Date.parse(first!)<Date.now()+hour+5_000);
  assert.equal(f.record().idleUntil,first,'idle is capped by a shorter hard expiry');
  assert.equal((await f.call('extend',{approvedHours:720}))!.status,200);
  assert.ok(Date.parse(f.record().hardUntil!)>Date.parse(first!));
  assert.ok(Date.parse(f.record().idleUntil!)<=Date.now()+24*hour+5_000);
  assert.equal((await f.call('extend',{approvedHours:2}))!.status,200);
  assert.ok(Date.parse(f.record().hardUntil!)<Date.now()+2*hour+5_000);
  for(const invalid of [0,721,2.5,-1])assert.equal((await f.call('extend',{approvedHours:invalid}))!.status,400);
  assert.equal((await f.call('revoke'))!.status,200);
  assert.equal((await f.call('extend',{approvedHours:1}))!.status,409);
  assert.equal((await f.call('edit',{approvedTools:['read_file']}))!.status,409);
  const expired=fixture();expired.record().hardUntil=new Date(Date.now()-1).toISOString();
  assert.equal((await expired.call('extend',{approvedHours:48}))!.status,409);
});
