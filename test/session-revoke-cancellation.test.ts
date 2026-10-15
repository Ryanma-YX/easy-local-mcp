import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {CommandRunner} from '../src/command.js';

test('revoking one in-flight run_command kills its command without cancelling other commands',async()=>{
  const runner=new CommandRunner();
  const revoked=new AbortController();
  const unaffected=new AbortController();
  const sleep='node -e "setTimeout(()=>process.stdout.write(\'completed\'),650)"';
  const first=runner.run(sleep,tmpdir(),10_000,revoked.signal);
  const second=runner.run(sleep,tmpdir(),10_000,unaffected.signal);
  await new Promise(resolve=>setTimeout(resolve,150));
  revoked.abort();
  const [cancelled,completed]=await Promise.all([first,second]);
  assert.notEqual(cancelled.output,'completed');
  assert.ok(cancelled.signal!==null||cancelled.exitCode!==0,
    'cancelled command cannot report a successful normal exit');
  assert.equal(completed.exitCode,0);
  assert.equal(completed.output,'completed');
  await runner.close();
});

test('already cancelled requests never spawn shell commands',async()=>{
  const runner=new CommandRunner();
  const controller=new AbortController();
  controller.abort();
  await assert.rejects(runner.run('exit 0',tmpdir(),500,controller.signal),/cancelled/);
  await runner.close();
});

test('relay Revoke cancels only matching session, retains other sessions and rejects unauthenticated control',async()=>{
  // Cloudflare DO interfaces are emulated with a deliberately small in-memory stub.
  const old=(globalThis as any).WebSocketRequestResponsePair;
  (globalThis as any).WebSocketRequestResponsePair=class{};
  try{
    const {McpRelay}=await import('../worker/index.js');
    const stored=new Map<string,unknown>();
    const storage={
      get:async <T>(key:string)=>stored.get(key) as T|undefined,
      put:async(key:string,value:unknown)=>{stored.set(key,value);},
      delete:async(keys:string|string[])=>{for(const key of Array.isArray(keys)?keys:[keys])stored.delete(key);},
      list:async({prefix}:{prefix:string})=>new Map([...stored].filter(([key])=>key.startsWith(prefix)))
    };
    const relay=new McpRelay({storage,setWebSocketAutoResponse:()=>{},getWebSockets:()=>[]} as any);
    const sent:string[]=[];
    const socket={send:(s:string)=>sent.push(s)};
    const sessionA='aa111111-1111-4111-8111-111111111111';
    const sessionB='bb222222-2222-4222-8222-222222222222';
    const resolved:string[]=[];
    const pending=(sessionId:string)=>({sessionId,socket,assembly:{},resolve:(r:Response)=>resolved.push(String(r.status)),timer:setTimeout(()=>{},5000),lane:'execution'});
    (relay as any).pending.set('callA',pending(sessionA));
    (relay as any).pending.set('callB',pending(sessionB));
    const request=(authenticated:boolean)=>new Request('https://relay.internal/cancel-session',{
      method:'POST',headers:authenticated?{'x-localmcp-internal':'1'}:{},
      body:JSON.stringify({sessionId:sessionA})
    });
    assert.notEqual((await relay.fetch(request(false))).status,200);
    const result=await relay.fetch(request(true));
    assert.equal(result.status,200);
    assert.equal((await result.json() as {cancellations:number}).cancellations,1);
    assert.deepEqual(sent.map(x=>JSON.parse(x)),[{type:'cancel',requestId:'callA'}]);
    assert.equal((relay as any).pending.has('callA'),false);
    assert.equal((relay as any).pending.has('callB'),true);
    assert.deepEqual(resolved,['409']);
    assert.ok(Number(stored.get('revoked-session:'+sessionA))>Date.now());
    clearTimeout((relay as any).pending.get('callB').timer);
  }finally{(globalThis as any).WebSocketRequestResponsePair=old;}
});
