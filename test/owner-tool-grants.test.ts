import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAgentSessionStorage,type AgentSessionRecord} from '../worker/agent-session-store.js';
import {handleAgentSessionTool,approvedAgentSession} from '../worker/agent-sessions.js';
import {OWNER_TOOL_GROUPS,OWNER_GRANT_TOOLS,validAgentSessionTools} from '../worker/agent-session-tool-groups.js';
import {adminPage} from '../worker/admin.js';

class FakeStore {
  items=new Map<string,unknown>();
  async get<T>(key:string){return this.items.get(key) as T|undefined;}
  async put(key:string,value:unknown){this.items.set(key,structuredClone(value));}
  async delete(keys:string|string[]){for(const key of Array.isArray(keys)?keys:[keys])this.items.delete(key);}
  async list<T>({prefix}:{prefix:string}){
    return new Map([...this.items].filter(([key])=>key.startsWith(prefix))) as Map<string,T>;
  }
  async transaction<T>(cb:(tx:FakeStore)=>Promise<T>){return cb(this);}
}
function fixture(){
  const store=new FakeStore();
  const env:any={ADMIN:{idFromName:()=>({}),get:()=>({fetch:(request:Request)=>
    handleAgentSessionStorage(store as any,request)})}};
  const connector={kind:'zone' as const,id:'aa111111-1111-4111-8111-111111111111',secret:'a'.repeat(64)};
  const device='bb222222-2222-4222-8222-222222222222';
  const request=async(tools:string[])=>{
    const response=await handleAgentSessionTool(env,connector,'request_agent_session',
      {scope:'devices',devices:[device],tools},11,[device]);
    const body:any=await response!.json();
    assert.equal(body.result.isError,undefined);
    return JSON.parse(body.result.content[0].text) as {sessionId:string;agentSessionToken:string};
  };
  const action=async(id:string,approvedTools:unknown,approvedHours=2)=>
    handleAgentSessionStorage(store as any,new Request('https://admin.internal/agent-sessions/approve',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id,approvedHours,approvedTools})
    }));
  const check=(token:string,tool:string)=>approvedAgentSession(env,connector,token,device,tool);
  const record=(id:string)=>store.items.get('agent-session:'+id) as AgentSessionRecord;
  return {request,action,check,record};
}

test('owner may broaden requested read to read + edit + execute without broadening device scope',async()=>{
  const f=fixture();
  const session=await f.request(['read_file']);
  assert.equal(await f.check(session.agentSessionToken,'read_file'),false);
  assert.equal((await f.action(session.sessionId,['read_file','edit_file','run_command']))!.status,200);
  const grant=f.record(session.sessionId);
  assert.deepEqual(grant.requestedTools,['read_file']);
  assert.deepEqual(grant.tools,['read_file','edit_file','run_command']);
  for(const tool of ['read_file','edit_file','run_command']){
    assert.equal(await f.check(session.agentSessionToken,tool),true);
  }
  assert.equal(await f.check(session.agentSessionToken,'delete_path'),false);
  assert.deepEqual(grant.devices,['bb222222-2222-4222-8222-222222222222']);
  assert.equal(grant.scope,'devices');
});

test('owner can narrow broad requests; explicit backend wildcard remains a dynamic grant',async()=>{
  const f=fixture();
  const session=await f.request(['*']);
  assert.equal((await f.action(session.sessionId,['read_file']))!.status,200);
  assert.deepEqual(f.record(session.sessionId).requestedTools,['*']);
  assert.deepEqual(f.record(session.sessionId).tools,['read_file']);
  assert.equal(await f.check(session.agentSessionToken,'read_file'),true);
  assert.equal(await f.check(session.agentSessionToken,'run_command'),false);
  const broader=await f.request(['read_file']);
  assert.equal((await f.action(broader.sessionId,['*']))!.status,200);
  assert.deepEqual(f.record(broader.sessionId).tools,['*'],
    'An explicit backend wildcard must remain an open-ended grant');
  assert.equal(await f.check(broader.agentSessionToken,'run_command'),true);
  assert.equal(await f.check(broader.agentSessionToken,'future_tool_name'),true,
    'A backend wildcard must allow future enabled tools');
  assert.deepEqual(f.record(broader.sessionId).requestedTools,['read_file']);
});

test('old owner API without approvedTools retains requested wildcard behavior',async()=>{
  const f=fixture();
  const session=await f.request(['*']);
  assert.equal((await f.action(session.sessionId,undefined))!.status,200);
  assert.deepEqual(f.record(session.sessionId).requestedTools,['*']);
  assert.deepEqual(f.record(session.sessionId).tools,['*']);
  assert.equal(await f.check(session.agentSessionToken,'run_command'),true);
  assert.equal(await f.check(session.agentSessionToken,'future_tool_name'),true);
});

test('previously approved wildcard grants keep true wildcard semantics',async()=>{
  const f=fixture();
  const session=await f.request(['read_file']);
  // Simulate an already-approved pre-upgrade record that persisted wildcard.
  const record=f.record(session.sessionId);
  const now=Date.now();
  const legacy:AgentSessionRecord={...record,
    tools:['*'],requestedTools:undefined,state:'approved',
    approvedAt:new Date(now).toISOString(),approvedHours:24,
    hardUntil:new Date(now+24*60*60_000).toISOString(),
    idleUntil:new Date(now+24*60*60_000).toISOString()
  };
  Object.assign(record,legacy);
  assert.equal(await f.check(session.agentSessionToken,'not_yet_shipped_tool'),true);
  assert.equal(await f.check(session.agentSessionToken,'run_command'),true);
  assert.deepEqual(f.record(session.sessionId).tools,['*'],
    'A previous wildcard grant must not silently be downgraded or rewritten');
  assert.equal(f.record(session.sessionId).requestedTools,undefined,
    'Do not invent an original AI request for legacy sessions');
});

test('default owner approval honors request and rejects unrecognized or unsafe tool sets',async()=>{
  const f=fixture();
  const session=await f.request(['read_file']);
  for(const invalid of [[],['nonexistent'],['read_file','read_file'],['*','read_file'],42]){
    assert.equal((await f.action(session.sessionId,invalid))!.status,400);
    assert.equal(f.record(session.sessionId).state,'pending');
  }
  assert.equal((await f.action(session.sessionId,undefined))!.status,200);
  assert.deepEqual(f.record(session.sessionId).tools,['read_file']);
  assert.equal(await f.check(session.agentSessionToken,'edit_file'),false);
});

test('owner grants are from the same allowlist as MCP requests and grouped by capability',()=>{
  assert.deepEqual(Object.keys(OWNER_TOOL_GROUPS),['Read','Write','Delete','Execute','External MCP']);
  assert.equal(new Set(OWNER_GRANT_TOOLS).size,OWNER_GRANT_TOOLS.length);
  for(const group of Object.values(OWNER_TOOL_GROUPS)){
    assert.equal(validAgentSessionTools([...group]),true);
  }
  assert.equal(validAgentSessionTools(['*']),true);
  assert.equal(validAgentSessionTools(['*','read_file']),false);
  const html=adminPage();
  assert.match(html,/Choose permitted tools/);
  assert.match(html,/Requested only/);
  assert.match(html,/Add '\+group/);
  assert.match(html,/All current tools/);
  assert.match(html,/future tools NOT included/);
  assert.match(html,/selectedTools=new Set\(toolNames\)/,
    'The UI All shortcut resolves the current visible tool names');
  assert.doesNotMatch(html,/selectedTools=new Set\(\['\*'\]\)/,
    'The UI must never submit a dynamic wildcard as its All shortcut');
  assert.match(html,/approvedTools/);
  assert.match(html,/MORE tools than the AI requested/);
});
