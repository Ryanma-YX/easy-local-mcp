import test from 'node:test';
import assert from 'node:assert/strict';
import {McpLoader} from '../src/mcp/loader.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('failed external MCP connects do not retain dead client or transport objects',{
  timeout:20000
},async()=>{
  const loader=new McpLoader({
    missing:{command:process.execPath,args:['-e','process.exit(2)']}
  });
  try{
    for(let i=0;i<15;i++){
      await assert.rejects(loader.listTools('missing'));
      const state=loader as unknown as {
        clients:Set<unknown>;
        transports:Set<unknown>;
        starting:Map<string,unknown>;
      };
      assert.equal(state.clients.size,0,'Retained failed MCP client #'+i);
      assert.equal(state.transports.size,0,'Retained failed MCP transport #'+i);
      assert.equal(state.starting.size,0,'Retained failed MCP startup #'+i);
    }
  }finally{
    await loader.close({force:true});
  }
});


test('graceful MCP loader close owns descendants of the stdio wrapper',{
  skip:process.platform!=='linux',timeout:16000
},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'localmcp-graceful-mcp-group-'));
  const serverMarker=join(dir,'server.pid');
  const wrapperMarker=join(dir,'wrapper.pid');
  const loader=new McpLoader({wrapped:{
    command:process.execPath,
    args:[resolve('test/fixtures/wrapped-mcp-server.mjs'),
      serverMarker,join(dir,'pending'),wrapperMarker]
  }});
  let actual=0,wrapper=0;
  async function alive(pid:number){
    if(!pid)return false;
    const stat=await readFile('/proc/'+pid+'/stat','utf8').catch(()=>'');
    if(!stat)return false;
    return !['X','Z'].includes(stat.slice(stat.lastIndexOf(')')+2,stat.lastIndexOf(')')+3));
  }
  t.after(async()=>{
    await loader.close({force:true});
    // Only these test-owned PIDs can be signalled here; the wrapper leads
    // a separate group as verified by the transport itself.
    for(const pid of [actual,wrapper]){
      if(await alive(pid)){
        try{process.kill(pid,'SIGKILL');}catch{}
      }
    }
    await rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  });
  const tools=await loader.listTools('wrapped');
  assert.ok(tools.some(tool=>tool.name==='stall'));
  actual=Number((await readFile(serverMarker,'utf8')).trim());
  wrapper=Number((await readFile(wrapperMarker,'utf8')).trim());
  assert.equal(await alive(actual),true);
  assert.equal(await alive(wrapper),true);
  await loader.close();
  const deadline=Date.now()+2000;
  while(Date.now()<deadline&&await alive(actual)){
    await new Promise(done=>setTimeout(done,30));
  }
  assert.equal(await alive(actual),false,
    'Graceful loader close left a wrapped MCP subprocess orphaned');
});


test('owned MCP group survives its launcher exiting after connection',{
  skip:process.platform!=='linux',timeout:15000
},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'localmcp-exited-mcp-wrapper-'));
  const serverMarker=join(dir,'server.pid');
  const wrapperMarker=join(dir,'wrapper.pid');
  const loader=new McpLoader({wrapped:{
    command:process.execPath,
    args:[resolve('test/fixtures/wrapped-mcp-server.mjs'),
      serverMarker,join(dir,'pending'),wrapperMarker,'exit-early']
  }});
  let actual=0,wrapper=0,owned=false;
  async function living(pid:number){
    const stat=await readFile('/proc/'+pid+'/stat','utf8').catch(()=>'');
    if(!stat)return false;
    return !['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2,stat.lastIndexOf(')')+3));
  }
  t.after(async()=>{
    await loader.close({force:true});
    if(actual&&await living(actual)){
      try{process.kill(actual,'SIGKILL');}catch{}
    }
    if(owned){
      // Group identity is checked from the test-owned server while it is alive.
      try{process.kill(-wrapper,'SIGKILL');}catch{}
    }
    await rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  });
  const tools=await loader.listTools('wrapped');
  assert.ok(tools.some(tool=>tool.name==='stall'));
  actual=Number((await readFile(serverMarker,'utf8')).trim());
  wrapper=Number((await readFile(wrapperMarker,'utf8')).trim());
  const info=(await readFile('/proc/'+actual+'/stat','utf8'))
    .split(') ')[1].trim().split(/\s+/);
  owned=Number(info[2])===wrapper&&Number(info[3])===wrapper;
  assert.equal(owned,true,'MCP descendant escaped its wrapper-owned group');
  const deadline=Date.now()+4000;
  while(Date.now()<deadline&&await living(wrapper)){
    await new Promise(done=>setTimeout(done,40));
  }
  assert.equal(await living(wrapper),false,'Wrapper failed to exit on its own');
  assert.equal(await living(actual),true,'MCP descendant did not persist');
  await loader.close({force:true});
  const stopDeadline=Date.now()+2000;
  while(Date.now()<stopDeadline&&await living(actual)){
    await new Promise(done=>setTimeout(done,40));
  }
  assert.equal(await living(actual),false,
    'MCP group was lost when its original launcher exited');
});

test('Linux refuses unsafe external MCP fallback if setsid is unavailable',{
  skip:process.platform!=='linux',timeout:5000
},async()=>{
  const loader=new McpLoader({fixture:{
    command:process.execPath,
    args:['-e','setInterval(()=>{},1000)'],
    env:{PATH:'/nonexistent-localmcp-test-bin'}
  }});
  try{
    await assert.rejects(loader.listTools('fixture'),/requires setsid/);
  }finally{
    await loader.close({force:true});
  }
});

test('forced close cancels an MCP startup whose wrapper exited immediately',{
  skip:process.platform!=='linux',timeout:14000
},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'localmcp-inflight-mcp-wrapper-'));
  const serverMarker=join(dir,'server.pid');
  const wrapperMarker=join(dir,'wrapper.pid');
  const loader=new McpLoader({wrapped:{
    command:process.execPath,
    args:[resolve('test/fixtures/wrapped-mcp-server.mjs'),
      serverMarker,join(dir,'pending'),wrapperMarker,'exit-immediate']
  }});
  let actual=0,wrapper=0;
  async function live(pid:number){
    if(!pid)return false;
    const stat=await readFile('/proc/'+pid+'/stat','utf8').catch(()=>'');
    if(!stat)return false;
    return !['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2,stat.lastIndexOf(')')+3));
  }
  t.after(async()=>{
    // No await on a potentially blocked SDK initialization during fixture
    // cleanup; the test-owned process/group are terminated independently.
    void loader.close({force:true}).catch(()=>{});
    if(actual&&await live(actual)){
      const stat=await readFile('/proc/'+actual+'/stat','utf8').catch(()=>'');
      if(stat){
        const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
        if(Number(fields[2])===wrapper&&Number(fields[3])===wrapper){
          try{process.kill(-wrapper,'SIGKILL');}catch{}
        }
      }
      try{process.kill(actual,'SIGKILL');}catch{}
    }
    await rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  });
  const connecting=loader.listTools('wrapped');
  void connecting.catch(()=>{});
  const until=Date.now()+3000;
  while(Date.now()<until){
    const actualText=await readFile(serverMarker,'utf8').catch(()=>'');
    const wrapperText=await readFile(wrapperMarker,'utf8').catch(()=>'');
    actual=Number(actualText.trim());
    wrapper=Number(wrapperText.trim());
    if(actual>0&&wrapper>0&&await live(actual))break;
    await new Promise(done=>setTimeout(done,25));
  }
  assert.ok(actual>0&&wrapper>0,'Fixture failed before launching MCP child');
  await loader.close({force:true});
  assert.equal(await live(actual),false,
    'Forced shutdown left behind an in-flight MCP startup descendant');
});
