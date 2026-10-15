import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const pause=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
async function exists(path:string){
  try{await readFile(path);return true;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
async function until(predicate:()=>Promise<boolean>,label:string){
  for(let i=0;i<140;i++){
    if(await predicate())return;
    await pause(40);
  }
  throw new Error('Timeout waiting for '+label);
}
async function freePort(){
  const server=createServer();
  await new Promise<void>((resolveReady,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolveReady);
  });
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  await new Promise<void>(done=>server.close(()=>done()));
  return address.port;
}
function nodeCommand(js:string){
  // Test is POSIX-only; the command interpreter receives one isolated -e arg.
  assert.ok(!js.includes("'"));
  return JSON.stringify(process.execPath)+" -e '"+js+"'";
}

/** Actual HTTP connection cancellation while an earlier tool holds the mutation gate. */
test('aborted queued HTTP run_command never starts and later mutations still run',{
  skip:process.platform==='win32',timeout:30000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-revoke-queued-'));
  const state=join(home,'.localmcp');
  await mkdir(state,{recursive:true,mode:0o700});
  const configFile=join(state,'localmcp.json');
  const firstStarted=join(home,'first-started');
  const releaseFirst=join(home,'release-first');
  const cancelledMarker=join(home,'cancelled-queued-command-executed');
  const subsequentMarker=join(home,'subsequent-command-executed');
  const token='f'.repeat(64);
  const port=await freePort();
  await writeFile(configFile,JSON.stringify({
    workspaces:{fixture:home},defaultWorkspace:'fixture',
    features:{shell:true},security:{alwaysUnlocked:true}
  }));
  const env={...process.env,HOME:home,USERPROFILE:home,
    LOCALMCP_CONFIG:configFile,LOCALMCP_PORT:String(port),LOCALMCP_TOKEN:token};
  for(const name of ['LOCALMCP_INTERNAL','LOCALMCP_ZONE_ID','LOCALMCP_ROOT',
    'LOCALMCP_RELAY_GATE_KEY','LOCALMCP_SHELL'])delete env[name];
  const child=spawn(process.execPath,[resolve('dist/index.js'),'http'],{
    cwd:resolve('.'),env,stdio:['ignore','pipe','pipe']
  });
  let logs='';
  child.stdout?.on('data',buf=>{logs=(logs+buf.toString()).slice(-3000);});
  child.stderr?.on('data',buf=>{logs=(logs+buf.toString()).slice(-3000);});
  t.after(async()=>{
    await writeFile(releaseFirst,'released').catch(()=>{});
    if(child.exitCode===null&&child.signalCode===null){
      child.kill('SIGTERM');
      const closed=once(child,'exit').then(()=>true,()=>false);
      await Promise.race([closed,pause(1500)]);
      if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    }
    await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const origin=`http://127.0.0.1:${port}`;
  await until(async()=>{
    if(child.exitCode!==null)throw new Error('HTTP test child exited: '+logs);
    try{return (await fetch(origin+'/healthz')).ok;}catch{return false;}
  },'disposable HTTP child');
  const body=(id:number,command:string)=>JSON.stringify({
    jsonrpc:'2.0',id,method:'tools/call',params:{
      name:'run_command',arguments:{workspace:'fixture',command,timeoutMs:12000}
    }
  });
  const headers={Authorization:`Bearer ${token}`,
    'Content-Type':'application/json',Accept:'application/json, text/event-stream',
    'MCP-Protocol-Version':'2025-03-26'};
  const call=async(id:number,command:string)=>{
    const response=await fetch(origin+'/mcp',{method:'POST',headers,body:body(id,command),
      signal:AbortSignal.timeout(17000)});
    const text=await response.text();
    assert.equal(response.status,200,`tool ${id}: ${text} ${logs}`);
    const reply=JSON.parse(text);
    assert.notEqual(reply.result?.isError,true,`tool ${id} should succeed: ${text}`);
    return reply;
  };
  const firstScript=`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(firstStarted)},"ready");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFirst)})){clearInterval(timer);process.stdout.write("released");}},20);`;
  const first=call(1,nodeCommand(firstScript));
  // Avoid an unhandled rejection if a later assertion fails before awaiting A.
  void first.catch(()=>{});
  await until(()=>exists(firstStarted),'first command occupying mutation gate');

  const queuedScript=`require("node:fs").writeFileSync(${JSON.stringify(cancelledMarker)},"unexpected")`;
  const queued=httpRequest(origin+'/mcp',{method:'POST',headers});
  let queuedResponded=false;
  queued.on('response',res=>{queuedResponded=true;res.resume();});
  queued.on('error',()=>{}); // ECONNRESET is expected on explicit abort.
  const written=new Promise<void>((done,reject)=>{
    queued.once('finish',()=>done());
    queued.once('error',reject);
  });
  queued.end(body(2,nodeCommand(queuedScript)));
  await written;
  // B is fully sent and pending while A owns the gate. Give the server a
  // separate event-loop turn to place it behind A before the socket closes.
  await pause(180);
  assert.equal(queuedResponded,false,'queued operation replied before A released the gate');
  assert.equal(await exists(cancelledMarker),false);
  const closed=new Promise<void>(done=>queued.once('close',()=>done()));
  queued.destroy(new Error('owner revoked queued session request'));
  await closed;
  // Flush loopback close handling before letting the first operation finish.
  assert.equal((await fetch(origin+'/healthz')).status,200);
  await pause(80);
  assert.equal(await exists(cancelledMarker),false,'queued command ran before release');

  await writeFile(releaseFirst,'released');
  await first;
  const subsequentScript=`require("node:fs").writeFileSync(${JSON.stringify(subsequentMarker)},"ok")`;
  await call(3,nodeCommand(subsequentScript));
  assert.equal(await exists(subsequentMarker),true,'queue deadlocked after cancellation');
  assert.equal(await exists(cancelledMarker),false,
    'revoked command was executed after its HTTP socket had already closed');
});
