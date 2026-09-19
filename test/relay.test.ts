import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Assembly,frames,parseFrame} from '../src/relay-protocol.js';
import {validatedWorkerOrigin} from '../src/relay.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';

test('Worker origins require HTTPS except explicit loopback development origins',()=>{
  assert.equal(validatedWorkerOrigin('https://worker.example').href,'https://worker.example/');
  assert.equal(validatedWorkerOrigin('http://localhost:8787').href,'http://localhost:8787/');
  assert.equal(validatedWorkerOrigin('http://127.0.0.1:8787').href,'http://127.0.0.1:8787/');
  assert.throws(()=>validatedWorkerOrigin('http://worker.example'),/HTTPS/);
  assert.throws(()=>validatedWorkerOrigin('https://worker.example/register'),/origin/);
  assert.throws(()=>validatedWorkerOrigin('https://user:pass@worker.example'),/origin/);
  assert.throws(()=>validatedWorkerOrigin('https://worker.example?token=nope'),/origin/);
});

test('relay framing preserves large Unicode/image payloads and rejects invalid sequences',()=>{
  const value={
    text:'中文😀'.repeat(30000),
    content:[
      {
        type:'image',
        mimeType:'image/png',
        data:'a'.repeat(300000)
      }
    ]
  };

  const assembly=new Assembly();
  let result:any;

  for(const raw of frames('request-1',value)){
    result=assembly.push(parseFrame(raw));
  }

  assert.deepEqual(result.value,value);
  assert.throws(
    ()=>parseFrame(
      '{"id":"x","index":0,"total":99999,"data":""}'
    )
  );

  assert.throws(
    ()=>new Assembly().push({
      id:'x',
      index:1,
      total:2,
      data:''
    })
  );
});

test('Worker + Durable Object + local agent enforce registration protection, lock state and credential rotation',{timeout:120000},async t=>{
  const root=await mkdtemp(
    join(tmpdir(),'localmcp-relay-')
  );

  const children:ChildProcess[]=[];

  t.after(async()=>{
    await cli('stop').catch(()=>{});

    for(const child of children){
      child.kill('SIGTERM');
    }

    await new Promise(
      resolveDelay=>setTimeout(resolveDelay,2000)
    );

    for(const child of children){
      if(child.exitCode===null){
        child.kill('SIGKILL');
      }
    }

    await rm(
      root,
      {
        recursive:true,
        force:true,
        maxRetries:5,
        retryDelay:100
      }
    );
  });

  const port=20000+Math.floor(Math.random()*15000);
  const origin=`http://127.0.0.1:${port}`;
  const agentToken='b'.repeat(64);
  const mcpToken='c'.repeat(64);
  const registrationToken='d'.repeat(64);

  const hash=(value:string)=>
    createHash('sha256')
      .update(value)
      .digest('hex');

  const worker=spawn(
    process.execPath,
    [
      resolve('node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--config',
      resolve('wrangler.jsonc'),
      '--local',
      '--port',
      String(port),
      '--inspector-port',
      '0',
      '--persist-to',
      join(root,'state'),
      '--var',
      `AGENT_TOKEN_HASH:${hash(agentToken)}`,
      '--var',
      `MCP_TOKEN_HASH:${hash(mcpToken)}`,
      '--var',
      `REGISTRATION_TOKEN_HASH:${hash(registrationToken)}`
    ],
    {
      stdio:[
        'ignore',
        'pipe',
        'pipe'
      ]
    }
  );

  children.push(worker);

  let logs='';

  worker.stdout?.on('data',chunk=>{
    logs+=chunk;
  });

  worker.stderr?.on('data',chunk=>{
    logs+=chunk;
  });

  let ready=false;

  for(let i=0;i<200;i++){
    try{
      if((await fetch(origin+'/healthz')).ok){
        ready=true;
        break;
      }
    }catch{}

    await new Promise(
      resolveDelay=>setTimeout(resolveDelay,100)
    );
  }

  assert.ok(ready,logs);

  const health:any=await (
    await fetch(origin+'/healthz')
  ).json();

  assert.equal(health.registrationProtected,true);

  const legacyUrl=`${origin}/mcp/${mcpToken}`;

  assert.equal(
    (
      await fetch(
        legacyUrl,
        {
          method:'POST',
          headers:{
            'Content-Type':'application/json'
          },
          body:'{}'
        }
      )
    ).status,
    503
  );

  assert.equal(
    (
      await fetch(
        origin+'/mcp/bad',
        {
          method:'POST'
        }
      )
    ).status,
    404
  );

  assert.equal(
    (
      await fetch(
        legacyUrl,
        {
          headers:{
            Origin:'https://evil.example'
          }
        }
      )
    ).status,
    403
  );

  assert.equal(
    (
      await fetch(
        origin+'/agent',
        {
          headers:{
            Authorization:`Bearer ${mcpToken}`
          }
        }
      )
    ).status,
    404
  );

  assert.equal(
    (
      await fetch(
        origin+'/register',
        {
          method:'POST',
          headers:{
            'Content-Type':'application/json'
          },
          body:'{}'
        }
      )
    ).status,
    404
  );

  assert.equal(
    (
      await fetch(
        origin+'/register',
        {
          method:'POST',
          headers:{
            'Content-Type':'application/json',
            Authorization:'Bearer wrong'
          },
          body:'{}'
        }
      )
    ).status,
    404
  );

  const registration=await fetch(
    origin+'/register',
    {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        Authorization:`Bearer ${registrationToken}`
      },
      body:'{}'
    }
  );

  assert.equal(registration.status,201);

  const registered:any=await registration.json();

  assert.match(
    registered.deviceId,
    /^[0-9a-f-]{36}$/
  );

  assert.equal(
    registered.agentToken.length,
    64
  );

  assert.equal(
    registered.mcpToken.length,
    64
  );

  const originalUrl=registered.mcpUrl;

  const postOriginal=()=>fetch(
    originalUrl,
    {
      method:'POST',
      headers:{
        'Content-Type':'application/json'
      },
      body:'{}'
    }
  );

  assert.equal(
    (await postOriginal()).status,
    503
  );

  assert.equal(
    (
      await fetch(
        `${origin}/mcp/${registered.deviceId}/${mcpToken}`,
        {
          method:'POST',
          headers:{
            'Content-Type':'application/json'
          },
          body:'{}'
        }
      )
    ).status,
    404
  );

  await mkdir(
    join(root,'.localmcp'),
    {
      recursive:true
    }
  );

  await writeFile(
    join(root,'.localmcp','worker.json'),
    JSON.stringify({
      workerUrl:origin,
      agentToken:registered.agentToken,
      mcpToken:registered.mcpToken,
      deviceId:registered.deviceId
    })
  );

  await writeFile(
    join(root,'.localmcp','localmcp.json'),
    JSON.stringify({
      workspaces:{
        test:root
      },
      defaultWorkspace:'test',
      features:{
        files:{
          read:true,
          write:true,
          delete:true
        },
        shell:false,
        processes:false,
        externalMcp:true
      },
      mcpServers:{}
    })
  );

  async function cli(...args:string[]){
    return new Promise<string>((done,reject)=>{
      const child=spawn(
        process.execPath,
        [
          resolve('dist/index.js'),
          ...args
        ],
        {
          cwd:root,
          env:{
            ...process.env,
            HOME:root,
            USERPROFILE:root,
            LOCALMCP_ROOT:root,
            LOCALMCP_AGENT_PORT:String(port+1),
            LOCALMCP_REGISTRATION_TOKEN:registrationToken
          },
          stdio:[
            'ignore',
            'pipe',
            'pipe'
          ]
        }
      );

      let output='';

      child.stdout.on('data',chunk=>{
        output+=chunk;
      });

      child.stderr.on('data',chunk=>{
        output+=chunk;
      });

      const timer=setTimeout(
        ()=>{
          child.kill('SIGKILL');
          reject(
            new Error(
              'CLI did not return: '+output
            )
          );
        },
        25000
      );

      child.on('error',reject);

      child.on('close',code=>{
        clearTimeout(timer);

        if(code===0){
          done(output);
        }else{
          reject(new Error(output));
        }
      });
    });
  }

  assert.match(
    await cli('status'),
    /Status: stopped/
  );

  await writeFile(
    join(root,'.localmcp','agent.pid'),
    String(process.pid)
  );

  assert.match(
    await cli('stop'),
    /Status: stopped/
  );

  await assert.rejects(
    cli('reload'),
    /Easy Local MCP is stopped/
  );

  const firstStart=await cli();
  const pid=firstStart.match(/PID: (\d+)/)?.[1];

  assert.ok(pid);
  assert.match(firstStart,/Status: running/);
  assert.match(firstStart,/Security: LOCKED/);
  assert.ok(!firstStart.includes(registered.mcpToken));

  const secondStart=await cli('start');

  assert.equal(
    secondStart.match(/PID: (\d+)/)?.[1],
    pid
  );

  assert.equal(
    (await cli('url')).trim(),
    originalUrl
  );

  const client=new Client({
    name:'worker-test',
    version:'1'
  });

  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(originalUrl)
    )
  );

  let tools=await client.listTools();

  assert.ok(
    tools.tools.some(
      tool=>tool.name==='read_file'
    )
  );

  assert.ok(
    !tools.tools.some(
      tool=>tool.name==='write_file'
    )
  );

  assert.ok(
    !tools.tools.some(
      tool=>tool.name==='call_mcp_tool'
    )
  );

  assert.equal(
    (
      await client.callTool({
        name:'write_file',
        arguments:{
          path:'locked.txt',
          content:'blocked'
        }
      })
    ).isError,
    true
  );

  assert.match(
    await cli('unlock','--minutes','5'),
    /Security: UNLOCKED/
  );

  tools=await client.listTools();

  assert.equal(tools.tools.length,20);

  const content='中文😀'.repeat(25000);

  assert.equal(
    (
      await client.callTool({
        name:'write_file',
        arguments:{
          path:'relay.txt',
          content
        }
      })
    ).isError,
    undefined
  );

  const result:any=await client.callTool({
    name:'read_file',
    arguments:{
      path:'relay.txt'
    }
  });

  assert.equal(
    JSON.parse(result.content[0].text).content,
    content
  );

  const duplicate=new WebSocket(
    origin.replace('http:','ws:')
      +`/agent/${registered.deviceId}`,
    {
      headers:{
        Authorization:`Bearer ${registered.agentToken}`
      }
    }
  );

  const duplicateStatus=await new Promise<number>((resolveStatus,reject)=>{
    duplicate.on(
      'unexpected-response',
      (_request,response)=>{
        response.resume();
        duplicate.terminate();
        resolveStatus(response.statusCode!);
      }
    );

    duplicate.on('error',()=>{});

    duplicate.on('open',()=>{
      duplicate.close();
      reject(
        new Error('Duplicate accepted')
      );
    });
  });

  assert.equal(duplicateStatus,409);

  const configPath=join(
    root,
    '.localmcp',
    'localmcp.json'
  );

  const originalConfig=await readFile(
    configPath,
    'utf8'
  );

  await writeFile(
    configPath,
    '{invalid'
  );

  await assert.rejects(
    cli('reload'),
    /Invalid JSON/
  );

  assert.equal(
    (await client.listTools()).tools.length,
    20
  );

  const changedConfig=JSON.parse(originalConfig);

  changedConfig.workspaces={
    reloaded:root
  };

  changedConfig.defaultWorkspace='reloaded';

  changedConfig.mcpServers={
    fixture:{
      command:process.execPath,
      args:[
        resolve('test/fixtures/mcp-server.mjs')
      ]
    }
  };

  await writeFile(
    configPath,
    JSON.stringify(changedConfig)
  );

  let hot=false;

  for(let i=0;i<100;i++){
    const info:any=await client.callTool({
      name:'list_workspaces',
      arguments:{}
    });

    if(
      JSON.parse(
        info.content[0].text
      ).defaultWorkspace==='reloaded'
    ){
      hot=true;
      break;
    }

    await new Promise(
      resolveDelay=>setTimeout(resolveDelay,100)
    );
  }

  assert.ok(
    hot,
    'configuration should update without a reload command'
  );

  const reloaded=await cli('status');

  assert.ok(
    !reloaded.includes(registered.mcpToken)
  );

  assert.match(
    reloaded,
    new RegExp('PID: '+pid)
  );

  assert.equal(
    (await cli('url')).trim(),
    originalUrl
  );

  const workspaces:any=await client.callTool({
    name:'list_workspaces',
    arguments:{}
  });

  assert.ok(
    workspaces.content[0].text.includes('reloaded')
  );

  const external:any=await client.callTool({
    name:'list_mcp_tools',
    arguments:{
      server:'fixture'
    }
  });

  assert.equal(
    JSON.parse(
      external.content[0].text
    ).tools[0].name,
    'echo'
  );

  const slowExternal=client.callTool({
    name:'call_mcp_tool',
    arguments:{
      server:'fixture',
      tool:'echo',
      arguments:{
        text:'slow'
      }
    }
  });

  await new Promise(
    resolveDelay=>setTimeout(resolveDelay,100)
  );

  const duringSlow=client.callTool({
    name:'list_workspaces',
    arguments:{}
  });

  assert.equal(
    await Promise.race([
      duringSlow.then(()=> 'quick'),
      slowExternal.then(()=> 'slow')
    ]),
    'quick',
    'a long-running tool must not block an unrelated MCP request'
  );

  const duringSlowResult:any=await duringSlow;
  assert.ok(
    duringSlowResult.content[0].text.includes('reloaded')
  );
  assert.equal((await slowExternal).isError,false);

  const exclusiveSlow=client.callTool({
    name:'call_mcp_tool',
    arguments:{
      server:'fixture',
      tool:'echo',
      arguments:{
        text:'slow'
      }
    }
  });

  await new Promise(
    resolveDelay=>setTimeout(resolveDelay,100)
  );

  const queuedWrite=client.callTool({
    name:'write_file',
    arguments:{
      path:'serialized.txt',
      content:'after slow mutation',
      overwrite:true
    }
  });

  assert.equal(
    await Promise.race([
      exclusiveSlow.then(()=> 'slow'),
      queuedWrite.then(()=> 'write')
    ]),
    'slow',
    'mutating MCP requests must remain serialized'
  );

  assert.equal((await exclusiveSlow).isError,false);
  assert.equal((await queuedWrite).isError,undefined);

  const echoed:any=await client.callTool({
    name:'call_mcp_tool',
    arguments:{
      server:'fixture',
      tool:'echo',
      arguments:{
        text:'through relay'
      }
    }
  });

  assert.equal(echoed.isError,false);
  assert.equal(echoed.content[1].type,'image');

  await client.close();

  const rotationStatus=await cli('rotate');

  assert.ok(
    !rotationStatus.includes(registered.mcpToken)
  );

  const rotatedUrl=(await cli('url')).trim();

  assert.notEqual(
    rotatedUrl,
    originalUrl
  );

  assert.equal(
    (await postOriginal()).status,
    404
  );

  const oldAgent=new WebSocket(
    origin.replace('http:','ws:')
      +`/agent/${registered.deviceId}`,
    {
      headers:{
        Authorization:`Bearer ${registered.agentToken}`
      }
    }
  );

  const oldAgentStatus=await new Promise<number>((resolveStatus,reject)=>{
    oldAgent.on(
      'unexpected-response',
      (_request,response)=>{
        response.resume();
        oldAgent.terminate();
        resolveStatus(response.statusCode!);
      }
    );

    oldAgent.on('error',()=>{});

    oldAgent.on('open',()=>{
      oldAgent.close();
      reject(
        new Error('Rotated agent token was still accepted')
      );
    });
  });

  assert.equal(oldAgentStatus,404);

  let rotatedReady=false;

  for(let i=0;i<100;i++){
    try{
      const response=await fetch(
        rotatedUrl,
        {
          method:'POST',
          headers:{
            'Content-Type':'application/json'
          },
          body:'{}'
        }
      );

      if(response.status!==503){
        rotatedReady=true;
        break;
      }
    }catch{}

    await new Promise(
      resolveDelay=>setTimeout(resolveDelay,100)
    );
  }

  assert.ok(
    rotatedReady,
    'agent should reconnect with rotated credentials'
  );

  assert.match(
    await cli('stop'),
    /Status: stopped/
  );

  assert.equal(
    (
      await fetch(
        rotatedUrl,
        {
          method:'POST',
          headers:{
            'Content-Type':'application/json'
          },
          body:'{}'
        }
      )
    ).status,
    503
  );

  const restarted=await cli();

  assert.match(restarted,/Security: LOCKED/);

  const second=new Client({
    name:'reconnect-test',
    version:'1'
  });

  await second.connect(
    new StreamableHTTPClientTransport(
      new URL(rotatedUrl)
    )
  );

  const restartedTools=await second.listTools();

  assert.ok(
    !restartedTools.tools.some(
      tool=>tool.name==='write_file'
    )
  );

  assert.ok(
    restartedTools.tools.some(
      tool=>tool.name==='read_file'
    )
  );

  await second.close();
  await cli('stop');

  await writeFile(
    join(root,'.localmcp','worker.json'),
    '{invalid'
  );

  await assert.rejects(
    cli(),
    /startup failed/
  );

  assert.match(
    await cli('status'),
    /Status: stopped/
  );
});
