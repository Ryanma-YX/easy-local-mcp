import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleAgentSessionStorage,effectiveState,type AgentSessionRecord
} from '../worker/agent-session-store.js';
import {
  agentSessionTools,approvedAgentSession,decodeSessionToken,
  handleAgentSessionTool,hashSecret,withSessionArgument
} from '../worker/agent-sessions.js';

class FakeStorage {
  values=new Map<string,unknown>();
  async get<T>(key:string){return this.values.get(key) as T|undefined;}
  async put(key:string,value:unknown){this.values.set(key,structuredClone(value));}
  async delete(keys:string|string[]){
    const values=Array.isArray(keys)?keys:[keys];
    assert.ok(values.length<=128,'Cloudflare DO rejects deleting >128 keys at once');
    for(const key of values)this.values.delete(key);
  }
  async list<T>({prefix}:{prefix:string}){
    return new Map([...this.values].filter(([key])=>key.startsWith(prefix))) as Map<string,T>;
  }
  async transaction<T>(callback:(tx:FakeStorage)=>Promise<T>){return callback(this);}
}
function fixture(){
  const storage=new FakeStorage();
  const env:any={ADMIN:{idFromName:()=>({}),get:()=>({
    fetch:(request:Request)=>handleAgentSessionStorage(storage as any,request)
  })}};
  const call=(action:string,body:any)=>handleAgentSessionStorage(
    storage as any,new Request('https://admin.internal/agent-sessions/'+action,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
    })
  );
  const list=()=>handleAgentSessionStorage(
    storage as any,new Request('https://admin.internal/agent-sessions/list')
  );
  const zone={kind:'zone' as const,id:'aa111111-1111-4111-8111-111111111111',secret:'a'.repeat(64)};
  const deviceA='bb222222-2222-4222-8222-222222222222';
  const deviceB='cc333333-3333-4333-8333-333333333333';
  const request=async(args:Record<string,unknown>)=>{
    const reply=await handleAgentSessionTool(
      env,zone,'request_agent_session',args,123,[deviceA,deviceB]
    );
    assert.ok(reply);
    const rpc:any=await reply.json();
    assert.equal(rpc.result.isError,undefined,JSON.stringify(rpc));
    return JSON.parse(rpc.result.content[0].text) as {sessionId:string;agentSessionToken:string;state:string};
  };
  return {storage,env,call,list,zone,deviceA,deviceB,request};
}

test('request/approve/use/revoke isolates independent AI sessions within same Zone',async()=>{
  const f=fixture();
  const params={scope:'devices',
    devices:[f.deviceA],tools:['run_command','read_file'],note:'test workflow'};
  const one=await f.request(params);
  const two=await f.request(params);
  assert.notEqual(one.agentSessionToken,two.agentSessionToken);
  assert.equal(one.state,'pending');
  assert.equal(await approvedAgentSession(f.env,f.zone,one.agentSessionToken,f.deviceA,'run_command'),false);
  const pending:any=await (await f.list())!.json();
  assert.equal(pending.sessions.length,2);
  assert.ok(!JSON.stringify(pending).includes(one.agentSessionToken));
  assert.ok(!JSON.stringify(pending).includes('tokenHash'));
  assert.ok(!JSON.stringify(pending).includes('connectorHash'));
  const granted=await f.call('approve',{id:one.sessionId,approvedHours:48});
  assert.equal(granted!.status,200);
  assert.equal(await approvedAgentSession(f.env,f.zone,one.agentSessionToken,f.deviceA,'run_command'),true);
  assert.equal(await approvedAgentSession(f.env,f.zone,one.agentSessionToken,f.deviceA,'read_file'),true);
  assert.equal(await approvedAgentSession(f.env,f.zone,one.agentSessionToken,f.deviceA,'delete_path'),false);
  assert.equal(await approvedAgentSession(f.env,f.zone,one.agentSessionToken,f.deviceB,'run_command'),false);
  assert.equal(await approvedAgentSession(f.env,f.zone,two.agentSessionToken,f.deviceA,'run_command'),false);
  assert.equal(await approvedAgentSession(f.env,{...f.zone,id:f.deviceB},one.agentSessionToken,f.deviceA,'run_command'),false);
  assert.equal(await approvedAgentSession(f.env,{...f.zone,secret:'b'.repeat(64)},one.agentSessionToken,f.deviceA,'run_command'),false);
  const token=decodeSessionToken(one.agentSessionToken)!;
  const status:any=await (await f.call('status',{
    id:token.id,tokenHash:await hashSecret(token.secret),connectorHash:await hashSecret(f.zone.secret),
    connectorId:f.zone.id,connectorKind:'zone'
  }))!.json();
  assert.equal(status.session.state,'approved');
  assert.equal(await (await f.call('approve',{id:one.sessionId,approvedHours:48}))!.status,409);
  assert.equal(await (await f.call('revoke',{id:one.sessionId}))!.status,200);
  assert.equal(await approvedAgentSession(f.env,f.zone,one.agentSessionToken,f.deviceA,'run_command'),false);
});

test('entire-Zone scope includes future devices, but never future tools; expiry is enforced',async()=>{
  const f=fixture();
  const originalNow=Date.now;
  let now=Date.parse('2026-10-14T00:00:00Z');
  Date.now=()=>now;
  try{
    const one=await f.request({scope:'zone/all',tools:['all']});
    assert.equal((await f.call('approve',{id:one.sessionId,approvedHours:720,idleHours:48}))!.status,200);
    const addedLater='dd444444-4444-4444-8444-444444444444';
    assert.equal(await approvedAgentSession(f.env,f.zone,one.agentSessionToken,addedLater,'run_command'),true);
    assert.equal(await approvedAgentSession(f.env,f.zone,one.agentSessionToken,addedLater,'future_tool_name'),false,
      'New devices can be included by Zone scope, but later-added tools cannot expand the snapshot');
    now+=47*60*60_000;
    assert.equal(await approvedAgentSession(f.env,f.zone,one.agentSessionToken,f.deviceA,'read_file'),true);
    now+=49*60*60_000;
    assert.equal(await approvedAgentSession(f.env,f.zone,one.agentSessionToken,f.deviceA,'read_file'),false);
    const second=await f.request({scope:'zone/all',tools:['all']});
    assert.equal((await f.call('approve',{id:second.sessionId,approvedHours:720,idleHours:48}))!.status,200);
    for(let i=0;i<58;i++){
      now+=12*60*60_000;
      assert.equal(await approvedAgentSession(f.env,f.zone,second.agentSessionToken,f.deviceA,'run_command'),true);
    }
    now+=25*60*60_000;
    assert.equal(await approvedAgentSession(f.env,f.zone,second.agentSessionToken,f.deviceA,'run_command'),false);
  }finally{
    Date.now=originalNow;
  }
});

test('expired pending requests cannot be approved and duplicate/replayed grants are denied',async()=>{
  const f=fixture();
  const originalNow=Date.now;
  let now=Date.parse('2026-10-14T00:00:00Z');
  Date.now=()=>now;
  try{
    const request=await f.request({scope:'zone/all'});
    assert.equal(await approvedAgentSession(f.env,f.zone,'invalid',f.deviceA,'read_file'),false);
    assert.equal(await approvedAgentSession(f.env,f.zone,request.agentSessionToken,f.deviceA,'read_file'),false);
    now+=16*60_000;
    assert.equal((await f.call('approve',{id:request.sessionId,approvedHours:20}))!.status,409);
    const status:any=await (await f.list())!.json();
    assert.equal(status.sessions[0].state,'expired');
    assert.equal((await f.call('revoke',{id:request.sessionId}))!.status,200);
  }finally{Date.now=originalNow;}
});

test('request validates access scope and tools; owner chooses session duration',async()=>{
  const f=fixture();
  async function invalid(input:Record<string,unknown>){
    const response=await handleAgentSessionTool(
      f.env,f.zone,'request_agent_session',input,111,[f.deviceA]
    );
    const payload:any=await response!.json();
    assert.equal(payload.result.isError,true);
  }
  await invalid({scope:'invalid'});
  await invalid({scope:'devices',devices:[f.deviceB]});
  await invalid({scope:'devices',devices:[]});
  await invalid({scope:'zone/all',tools:['not_a_real_tool']});
  await invalid({scope:'zone/all',tools:['*','run_command']});
  await invalid({scope:'zone/all',note:123});
  const schemas=agentSessionTools('zone');
  assert.equal(schemas.length,2);
  const schema:any=schemas[0].inputSchema;
  assert.deepEqual(schema.required,['scope']);
  assert.equal(schema.properties.tools.items.enum.includes('all'),true);
  assert.equal(schema.properties.tools.items.enum.includes('read'),true);
  assert.equal(schema.properties.tools.items.enum.includes('*'),false);
  assert.match(schema.properties.tools.description,/fixed snapshots/);
  assert.match(schemas[0].description,/least-privilege/);
  assert.equal('durationHours' in schema.properties,false);
  assert.equal('idleHours' in schema.properties,false);
  const directSchema:any=agentSessionTools('device')[0].inputSchema;
  assert.deepEqual(directSchema.required,[]);
  // A stale ChatGPT tool snapshot may still pass the old requested limits.
  // Neither value may influence an owner-selected approval.
  const oldClient=await f.request({durationHours:1,idleHours:48,scope:'zone/all',tools:['read_file']});
  const pending:any=await (await f.list())!.json();
  assert.equal(pending.sessions[0].requestedHours,undefined);
  assert.equal(pending.sessions[0].idleHours,24);
  for(const hours of [0,-1,721,2.5]){
    assert.equal((await f.call('approve',{id:oldClient.sessionId,approvedHours:hours}))!.status,400);
  }
  assert.equal((await f.call('approve',{id:oldClient.sessionId,approvedHours:72,idleHours:12}))!.status,400);
  assert.equal((await f.call('approve',{id:oldClient.sessionId,approvedHours:72,idleHours:48}))!.status,200);
  const ownerGrant:any=await (await f.list())!.json();
  assert.equal(ownerGrant.sessions[0].approvedHours,72);
  assert.equal(ownerGrant.sessions[0].idleHours,48);
  assert.equal(await approvedAgentSession(f.env,f.zone,oldClient.agentSessionToken,f.deviceA,'read_file'),true);
  // Maximum 30 days is available entirely at the owner's discretion.
  const max=await f.request({scope:'zone/all',tools:['read_file']});
  assert.equal((await f.call('approve',{id:max.sessionId,approvedHours:720}))!.status,200);
  const routed=withSessionArgument({name:'run_command',inputSchema:{type:'object',properties:{command:{type:'string'}},required:['command']}});
  assert.ok((routed.inputSchema as any).properties.agentSessionToken);
  assert.deepEqual((routed.inputSchema as any).required,['command']);
});

test('out-of-scope denial never revokes a still-valid read-only token',async()=>{
  const f=fixture();
  const one=await f.request({scope:'devices',devices:[f.deviceA],tools:['read_file']});
  assert.equal((await f.call('approve',{id:one.sessionId,approvedHours:1}))!.status,200);
  const recordKey='agent-session:'+one.sessionId;
  assert.equal((f.storage.values.get(recordKey) as AgentSessionRecord).lastUsedAt,undefined);
  assert.equal(await approvedAgentSession(f.env,f.zone,one.agentSessionToken,f.deviceA,'edit_file'),false);
  assert.equal((f.storage.values.get(recordKey) as AgentSessionRecord).lastUsedAt,undefined);
  const token=decodeSessionToken(one.agentSessionToken)!;
  const identity={id:token.id,tokenHash:await hashSecret(token.secret),
    connectorKind:'zone',connectorId:f.zone.id,connectorHash:await hashSecret(f.zone.secret)};
  const checked:any=await (await f.call('status',identity))!.json();
  assert.equal(checked.session.state,'approved');
  assert.equal(await approvedAgentSession(f.env,f.zone,one.agentSessionToken,f.deviceA,'read_file'),true);
  const used=(f.storage.values.get(recordKey) as AgentSessionRecord).lastUsedAt;
  assert.ok(used);
  assert.equal(await approvedAgentSession(f.env,f.zone,one.agentSessionToken,f.deviceA,'edit_file'),false);
  assert.equal((f.storage.values.get(recordKey) as AgentSessionRecord).lastUsedAt,used,
    'Denied tool use must not extend idle expiry or clear valid permissions');
  assert.equal(await approvedAgentSession(f.env,f.zone,one.agentSessionToken,f.deviceA,'read_file'),true);
  assert.equal((await f.call('revoke',{id:one.sessionId}))!.status,200);
  assert.equal(await approvedAgentSession(f.env,f.zone,one.agentSessionToken,f.deviceA,'read_file'),false);
});

test('ten pending slots per connector, independent of approved grants and other Zones',async()=>{
  const f=fixture();
  const originalNow=Date.now;
  let now=Date.parse('2026-10-14T00:00:00Z');
  Date.now=()=>now;
  try{
    const pending=[];
    for(let i=0;i<10;i++){
      pending.push(await f.request({scope:'zone/all',tools:['read_file']}));
    }
    const eleventh=await handleAgentSessionTool(f.env,f.zone,'request_agent_session',
      {scope:'zone/all'},9,[f.deviceA]);
    const denied:any=await eleventh!.json();
    assert.equal(denied.result.isError,true);
    assert.match(denied.result.content[0].text,/maximum 10/);
    const otherZone={...f.zone,id:'de555555-5555-4555-8555-555555555555',secret:'d'.repeat(64)};
    const other=await handleAgentSessionTool(f.env,otherZone,'request_agent_session',
      {scope:'zone/all',tools:['read_file']},10,[f.deviceB]);
    const otherData:any=await other!.json();
    assert.equal(otherData.result.isError,undefined,'Zone A pending queue must not block Zone B');
    assert.equal((await f.call('approve',{id:pending[0].sessionId,approvedHours:720}))!.status,200);
    assert.equal(await approvedAgentSession(f.env,f.zone,pending[0].agentSessionToken,f.deviceA,'read_file'),true);
    assert.equal((await f.call('reject',{id:pending[1].sessionId}))!.status,200);
    const rateDenied=await handleAgentSessionTool(f.env,f.zone,'request_agent_session',
      {scope:'zone/all'},11,[f.deviceA]);
    const rateBody:any=await rateDenied!.json();
    assert.equal(rateBody.result.isError,true);
    assert.match(rateBody.result.content[0].text,/Too many session requests/,
      'Freeing pending slots does not bypass the ten/hour anti-spam limit');
    now+=61*60_000;
    const next=await f.request({scope:'zone/all'});
    assert.equal(next.state,'pending','expired pending requests do not occupy approval slots');
    assert.equal(await approvedAgentSession(f.env,f.zone,pending[0].agentSessionToken,f.deviceA,'read_file'),true,
      'Approved grant persists independently of pending queue expiry');
  }finally{Date.now=originalNow;}
});

test('ten requests per rolling hour still apply when pending requests are rejected',async()=>{
  const f=fixture();
  const originalNow=Date.now;
  let now=Date.parse('2026-10-14T00:00:00Z');
  Date.now=()=>now;
  try{
    for(let i=0;i<10;i++){
      const created=await f.request({scope:'zone/all'});
      assert.equal((await f.call('reject',{id:created.sessionId}))!.status,200);
    }
    const denied=await handleAgentSessionTool(f.env,f.zone,'request_agent_session',
      {scope:'zone/all'},19,[f.deviceA]);
    const data:any=await denied!.json();
    assert.equal(data.result.isError,true);
    assert.match(data.result.content[0].text,/Too many session requests/);
    now+=61*60_000;
    const next=await f.request({scope:'zone/all'});
    assert.equal(next.state,'pending');
  }finally{Date.now=originalNow;}
});

test('64 active owner-approved grants per connector do not constrain other Zones',async()=>{
  const f=fixture();
  const pending=await f.request({scope:'zone/all',tools:['read_file']});
  const base=f.storage.values.get('agent-session:'+pending.sessionId) as AgentSessionRecord;
  const now=Date.now();
  let firstId='';
  for(let i=0;i<64;i++){
    const id=crypto.randomUUID();
    if(i===0)firstId=id;
    f.storage.values.set('agent-session:'+id,{
      ...structuredClone(base),id,state:'approved',approvedHours:72,
      approvedAt:new Date(now-60_000).toISOString(),
      hardUntil:new Date(now+72*60*60_000).toISOString(),
      idleUntil:new Date(now+24*60*60_000).toISOString()
    });
  }
  assert.equal((await f.call('approve',{id:pending.sessionId,approvedHours:48}))!.status,429,
    'Owner cannot overfill effective approved pool even when requests were already pending');
  const blocked=await handleAgentSessionTool(f.env,f.zone,'request_agent_session',
    {scope:'zone/all'},9,[f.deviceA]);
  const blockedBody:any=await blocked!.json();
  assert.equal(blockedBody.result.isError,true);
  assert.match(blockedBody.result.content[0].text,/Active approval limit/);
  const otherZone={...f.zone,id:'de555555-5555-4555-8555-555555555555',secret:'d'.repeat(64)};
  const other=await handleAgentSessionTool(f.env,otherZone,'request_agent_session',
    {scope:'zone/all',tools:['read_file']},10,[f.deviceB]);
  const otherBody:any=await other!.json();
  assert.equal(otherBody.result.isError,undefined,'Approved Zone A grants must not block Zone B');
  assert.equal((await f.call('revoke',{id:firstId}))!.status,200);
  assert.equal((await f.call('approve',{id:pending.sessionId,approvedHours:48}))!.status,200,
    'Owner can reuse a slot after revocation');
});

test('300 expired requests from one connector cannot exhaust another Zones capacity',async()=>{
  const f=fixture();
  const originalNow=Date.now;
  let now=Date.parse('2026-10-14T00:00:00Z');
  Date.now=()=>now;
  try{
    for(let i=0;i<300;i++){
      now+=16*60_000;
      await f.request({scope:'zone/all',tools:['read_file']});
    }
    const otherZone={...f.zone,id:'de555555-5555-4555-8555-555555555555',secret:'d'.repeat(64)};
    const other=await handleAgentSessionTool(f.env,otherZone,'request_agent_session',
      {scope:'zone/all',tools:['read_file']},12,[f.deviceB]);
    const body:any=await other!.json();
    assert.equal(body.result.isError,undefined,
      'Expired pending history from Zone A must never block Zone B');
    assert.ok(f.storage.values.size<300,'Expired pending history is pruned automatically');
    assert.equal((await f.list())!.status,200);
  }finally{Date.now=originalNow;}
});

test('evict stale audit rows under pressure without touching active approvals',async()=>{
  const f=fixture();
  const originalNow=Date.now;
  let now=Date.parse('2026-10-14T00:00:00Z');
  Date.now=()=>now;
  try{
    const keep=await f.request({scope:'zone/all',tools:['read_file']});
    assert.equal((await f.call('approve',{id:keep.sessionId,approvedHours:720}))!.status,200);
    // Imported old history resembling the previously exploited shared store.
    // Every entry is terminal and older than hourly rate-limit bookkeeping.
    for(let i=0;i<300;i++){
      const id=`historical-${i}`;
      const old=(f.storage.values.get('agent-session:'+keep.sessionId) as AgentSessionRecord);
      f.storage.values.set('agent-session:'+id,{
        ...structuredClone(old),id,tokenHash:String(i).padStart(64,'0'),
        state:'rejected',createdAt:new Date(now-60*24*60*60_000-i*1000).toISOString(),
        endedAt:new Date(now-50*24*60*60_000).toISOString()
      });
    }
    const otherZone={...f.zone,id:'de555555-5555-4555-8555-555555555555',secret:'d'.repeat(64)};
    const other=await handleAgentSessionTool(f.env,otherZone,'request_agent_session',
      {scope:'zone/all'},12,[f.deviceB]);
    const body:any=await other!.json();
    assert.equal(body.result.isError,undefined);
    assert.equal(await approvedAgentSession(f.env,f.zone,keep.agentSessionToken,f.deviceA,'read_file'),true,
      'Never evict an active owner-approved session');
    assert.ok(f.storage.values.size<300);
  }finally{Date.now=originalNow;}
});
