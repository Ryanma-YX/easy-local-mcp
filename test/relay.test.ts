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
import {Assembly,frames,parseFrame,isConcurrentReadRequest} from '../src/relay-protocol.js';
import {validatedWorkerOrigin} from '../src/relay.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
import {adminLoginPage,adminPage,adminSetupRequiredPage} from '../worker/admin.js';

const nodeCommand=(script:string)=>
  JSON.stringify(process.execPath)+' -e '+JSON.stringify(script);

test('Relay admin pages emit syntactically valid browser JavaScript',()=>{
  for(const html of [adminLoginPage(),adminPage()]){
    const start=html.indexOf('<script>');
    const end=html.indexOf('</script>');

    assert.ok(start>=0&&end>start);
    const script=html.slice(start+'<script>'.length,end);
    assert.doesNotThrow(()=>new Function(script));
  }

  assert.match(
    adminSetupRequiredPage(),
    /RELAY_ADMIN_TOKEN_HASH/
  );
  const dashboard=adminPage();
  assert.match(dashboard,/id="operationOverlay"/);
  assert.match(dashboard,/const withOperation=async/);
  assert.match(dashboard,/navigator\.clipboard/);
  assert.match(dashboard,/document\.execCommand\('copy'\)/);
  assert.match(dashboard,/Copy Token/);
  assert.match(dashboard,/Copy URL/);
  assert.match(dashboard,/Copy Code/);
  assert.match(dashboard,/Copy ID/);
});

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

  assert.equal(
    isConcurrentReadRequest({
      method:'tools/call',
      params:{name:'read_process'}
    }),
    true
  );
  assert.equal(
    isConcurrentReadRequest({
      method:'tools/call',
      params:{name:'list_processes'}
    }),
    true
  );
  assert.equal(
    isConcurrentReadRequest({
      method:'tools/call',
      params:{name:'write_process'}
    }),
    false
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
  const relayAdminToken='e'.repeat(64);

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
      `REGISTRATION_TOKEN_HASH:${hash(registrationToken)}`,
      '--var',
      `RELAY_ADMIN_TOKEN_HASH:${hash(relayAdminToken)}`
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
  assert.equal(health.relayAdminProtected,true);
  assert.equal(health.zones,true);

  const publicAdmin=await fetch(origin+'/admin');
  assert.equal(publicAdmin.status,200);
  const publicAdminHtml=await publicAdmin.text();
  assert.match(publicAdminHtml,/Sign in with the Relay Admin Token/);
  assert.doesNotMatch(publicAdminHtml,/Relay-wide Control Plane/);

  assert.equal(
    (
      await fetch(origin+'/api/admin/zones')
    ).status,
    401
  );

  assert.equal(
    (
      await fetch(
        origin+'/api/admin/login',
        {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({token:'wrong'})
        }
      )
    ).status,
    401
  );

  const adminLogin=await fetch(
    origin+'/api/admin/login',
    {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:relayAdminToken})
    }
  );

  assert.equal(adminLogin.status,200);
  const setCookie=adminLogin.headers.get('set-cookie')||'';
  assert.match(setCookie,/localmcp_relay_admin=/);
  assert.match(setCookie,/HttpOnly/i);
  assert.match(setCookie,/Secure/i);
  assert.match(setCookie,/SameSite=Strict/i);
  const adminCookieHeader=setCookie.split(';')[0];

  const authenticatedAdmin=await fetch(
    origin+'/admin',
    {
      headers:{
        Cookie:adminCookieHeader
      }
    }
  );

  assert.equal(authenticatedAdmin.status,200);
  assert.match(
    await authenticatedAdmin.text(),
    /Relay-wide Control Plane/
  );

  assert.equal(
    (
      await fetch(
        origin+'/api/zones',
        {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({name:'Public Zone'})
        }
      )
    ).status,
    404,
    'Zone creation must fail closed outside the Relay Admin control plane'
  );

  assert.equal(
    (
      await fetch(
        origin+'/api/zones',
        {
          method:'POST',
          headers:{
            'Content-Type':'application/json',
            Authorization:`Bearer ${registrationToken}`
          },
          body:JSON.stringify({name:'Registration Token Zone'})
        }
      )
    ).status,
    404,
    'Registration Token must not grant Zone creation authority'
  );

  const zoneCreate=await fetch(
    origin+'/api/admin/zones',
    {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        Cookie:adminCookieHeader
      },
      body:JSON.stringify({
        name:'Test Zone'
      })
    }
  );

  assert.equal(zoneCreate.status,201);
  const createdZone:any=await zoneCreate.json();
  assert.match(createdZone.zoneId,/^[0-9a-f-]{36}$/);
  assert.equal(createdZone.adminToken.length,64);
  assert.equal(createdZone.mcpToken.length,64);
  assert.equal(
    createdZone.mcpUrl,
    `${origin}/mcp/z/${createdZone.zoneId}/${createdZone.mcpToken}`
  );
  assert.equal(createdZone.name,'Test Zone');
  const zoneHeaders={
    'Content-Type':'application/json',
    Authorization:`Bearer ${createdZone.adminToken}`
  };


  const registeredZones:any=await (
    await fetch(
      origin+'/api/admin/zones',
      {
        headers:{
          Cookie:adminCookieHeader
        }
      }
    )
  ).json();

  assert.equal(registeredZones.zones.length,1);
  assert.equal(registeredZones.zones[0].zoneId,createdZone.zoneId);

  assert.equal(
    (
      await fetch(
        origin+'/api/admin/zones/import',
        {
          method:'POST',
          headers:{
            'Content-Type':'application/json',
            Cookie:adminCookieHeader
          },
          body:JSON.stringify({
            zoneId:createdZone.zoneId,
            zoneAdminToken:'wrong'
          })
        }
      )
    ).status,
    404
  );

  const importedZone=await fetch(
    origin+'/api/admin/zones/import',
    {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        Cookie:adminCookieHeader
      },
      body:JSON.stringify({
        zoneId:createdZone.zoneId,
        zoneAdminToken:createdZone.adminToken
      })
    }
  );
  assert.equal(importedZone.status,200);

  const relayAdminZoneInfo:any=await (
    await fetch(
      `${origin}/api/admin/zones/${createdZone.zoneId}`,
      {
        headers:{
          Cookie:adminCookieHeader
        }
      }
    )
  ).json();
  assert.equal(relayAdminZoneInfo.name,'Test Zone');
  const joinCodeResponse=await fetch(
    `${origin}/api/admin/zones/${createdZone.zoneId}/join-codes`,
    {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        Cookie:adminCookieHeader
      },
      body:JSON.stringify({
        ttlMinutes:10
      })
    }
  );


  assert.equal(joinCodeResponse.status,201);
  const joinCode:any=await joinCodeResponse.json();
  assert.match(
    joinCode.code,
    /^[0-9a-f-]{36}\.[a-f0-9]{48}$/
  );

  const zoneJoinBody={
    code:joinCode.code,
    name:'MacMini-M4',
    platform:'darwin',
    arch:'arm64',
    version:'0.3.11'
  };

  const zoneJoin=await fetch(
    origin+'/join',
    {
      method:'POST',
      headers:{
        'Content-Type':'application/json'
      },
      body:JSON.stringify(zoneJoinBody)
    }
  );

  assert.equal(zoneJoin.status,201);
  const joinedDevice:any=await zoneJoin.json();
  assert.equal(joinedDevice.zoneId,createdZone.zoneId);
  assert.match(joinedDevice.deviceId,/^[0-9a-f-]{36}$/);
  assert.equal(joinedDevice.mcpToken.length,64);

  assert.equal(
    (
      await fetch(
        origin+'/join',
        {
          method:'POST',
          headers:{
            'Content-Type':'application/json'
          },
          body:JSON.stringify(zoneJoinBody)
        }
      )
    ).status,
    404,
    'join codes must be one-time credentials'
  );

  const zoneInfoResponse=await fetch(
    `${origin}/api/zones/${createdZone.zoneId}`,
    {
      headers:{
        Authorization:`Bearer ${createdZone.adminToken}`
      }
    }
  );

  assert.equal(zoneInfoResponse.status,200);
  let zoneInfo:any=await zoneInfoResponse.json();
  assert.equal(zoneInfo.devices.length,1);
  assert.equal(zoneInfo.devices[0].name,'MacMini-M4');
  assert.equal(zoneInfo.devices[0].platform,'darwin');
  assert.equal(zoneInfo.devices[0].arch,'arm64');
  assert.equal(zoneInfo.devices[0].online,false);

  const renamed=await fetch(
    `${origin}/api/admin/zones/${createdZone.zoneId}/devices/${joinedDevice.deviceId}`,
    {
      method:'PATCH',
      headers:{
        'Content-Type':'application/json',
        Cookie:adminCookieHeader
      },
      body:JSON.stringify({
        name:'Mac Mini PlayCover'
      })
    }
  );

  assert.equal(renamed.status,200);

  zoneInfo=await (
    await fetch(
      `${origin}/api/zones/${createdZone.zoneId}`,
      {
        headers:{
          Authorization:`Bearer ${createdZone.adminToken}`
        }
      }
    )
  ).json();

  assert.equal(zoneInfo.devices[0].name,'Mac Mini PlayCover');
  assert.equal(zoneInfo.devices[0].name,'Mac Mini PlayCover');

  const logout=await fetch(
    origin+'/api/admin/logout',
    {
      method:'POST',
      headers:{
        Cookie:adminCookieHeader
      }
    }
  );
  assert.equal(logout.status,200);
  assert.match(logout.headers.get('set-cookie')||'',/Max-Age=0/);

  assert.equal(
    (
      await fetch(
        origin+'/api/admin/zones',
        {
          headers:{
            Cookie:adminCookieHeader
          }
        }
      )
    ).status,
    401,
    'logout must invalidate the Relay Admin session immediately'
  );

  const loggedOutAdmin=await fetch(
    origin+'/admin',
    {
      headers:{
        Cookie:adminCookieHeader
      }
    }
  );
  assert.match(
    await loggedOutAdmin.text(),
    /Sign in with the Relay Admin Token/
  );

  const revoked=await fetch(
    `${origin}/api/zones/${createdZone.zoneId}/devices/${joinedDevice.deviceId}`,
    {
      method:'DELETE',
      headers:{
        Authorization:`Bearer ${createdZone.adminToken}`
      }
    }
  );

  assert.equal(revoked.status,200);

  assert.equal(
    (
      await fetch(
        joinedDevice.mcpUrl,
        {
          method:'POST',
          headers:{
            'Content-Type':'application/json'
          },
          body:'{}'
        }
      )
    ).status,
    404,
    'revoking a Zone device must invalidate its MCP credential'
  );

  zoneInfo=await (
    await fetch(
      `${origin}/api/zones/${createdZone.zoneId}`,
      {
        headers:{
          Authorization:`Bearer ${createdZone.adminToken}`
        }
      }
    )
  ).json();

  assert.equal(zoneInfo.devices.length,0);

  const leaveJoinCodeResponse=await fetch(
    `${origin}/api/zones/${createdZone.zoneId}/join-codes`,
    {
      method:'POST',
      headers:{
        Authorization:`Bearer ${createdZone.adminToken}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({ttlMinutes:10})
    }
  );
  assert.equal(leaveJoinCodeResponse.status,201);
  const leaveJoinCode:any=await leaveJoinCodeResponse.json();

  const leaveJoinResponse=await fetch(
    origin+'/join',
    {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        code:leaveJoinCode.code,
        name:'Leave Test Device',
        platform:'darwin',
        arch:'arm64',
        version:'0.4.0'
      })
    }
  );
  assert.equal(leaveJoinResponse.status,201);
  const leaveJoined:any=await leaveJoinResponse.json();

  assert.equal(
    (
      await fetch(
        `${origin}/leave/${createdZone.zoneId}/${leaveJoined.deviceId}`,
        {
          method:'POST',
          headers:{Authorization:'Bearer wrong-token'}
        }
      )
    ).status,
    404,
    'Zone leave must require the current device Agent token'
  );

  const leaveResponse=await fetch(
    `${origin}/leave/${createdZone.zoneId}/${leaveJoined.deviceId}`,
    {
      method:'POST',
      headers:{Authorization:`Bearer ${leaveJoined.agentToken}`}
    }
  );
  assert.equal(leaveResponse.status,200);
  const standalone:any=await leaveResponse.json();
  assert.equal(standalone.deviceId,leaveJoined.deviceId);
  assert.equal(standalone.workerUrl,origin);
  assert.equal(standalone.agentToken.length,64);
  assert.equal(standalone.mcpToken.length,64);
  assert.equal(standalone.zoneId,undefined);

  zoneInfo=await (
    await fetch(
      `${origin}/api/zones/${createdZone.zoneId}`,
      {
        headers:{Authorization:`Bearer ${createdZone.adminToken}`}
      }
    )
  ).json();
  assert.equal(zoneInfo.devices.length,0,'leaving must remove the device from the Zone');

  assert.equal(
    (
      await fetch(
        leaveJoined.mcpUrl,
        {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:'{}'
        }
      )
    ).status,
    404,
    'leaving must invalidate the old Zone-era direct MCP credential'
  );

  assert.equal(
    (
      await fetch(
        standalone.mcpUrl,
        {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:'{}'
        }
      )
    ).status,
    503,
    'leaving must issue valid standalone MCP credentials'
  );

  const unregisterResponse=await fetch(
    `${origin}/unregister/${standalone.deviceId}`,
    {
      method:'POST',
      headers:{
        Authorization:`Bearer ${standalone.agentToken}`,
        'Content-Type':'application/json'
      },
      body:'{}'
    }
  );
  assert.equal(unregisterResponse.status,200);
  assert.equal(
    (
      await fetch(
        standalone.mcpUrl,
        {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:'{}'
        }
      )
    ).status,
    404,
    'unregister must retire standalone device credentials'
  );

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

  let registered:any=await registration.json();

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

  const routedJoinCodeResponse=await fetch(
    `${origin}/api/zones/${createdZone.zoneId}/join-codes`,
    {
      method:'POST',
      headers:zoneHeaders,
      body:JSON.stringify({ttlMinutes:10})
    }
  );

  assert.equal(routedJoinCodeResponse.status,201);
  const routedJoinCode:any=await routedJoinCodeResponse.json();

  const routedJoin=await fetch(
    origin+'/join',
    {
      method:'POST',
      headers:{
        'Content-Type':'application/json'
      },
      body:JSON.stringify({
        code:routedJoinCode.code,
        name:'Zone Worker',
        platform:process.platform,
        arch:process.arch,
        version:'0.3.11'
      })
    }
  );

  assert.equal(routedJoin.status,201);
  registered=await routedJoin.json();
  assert.equal(registered.zoneId,createdZone.zoneId);

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
      deviceId:registered.deviceId,
      zoneId:registered.zoneId
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
        shell:true,
        processes:true,
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

  assert.equal(tools.tools.length,26);

  assert.ok(
    tools.tools.some(
      tool=>tool.name==='write_file'
    )
  );

  assert.ok(
    tools.tools.some(
      tool=>tool.name==='call_mcp_tool'
    )
  );

  const zoneClient=new Client({
    name:'zone-worker-test',
    version:'1'
  });

  await zoneClient.connect(
    new StreamableHTTPClientTransport(
      new URL(createdZone.mcpUrl)
    )
  );

  const zoneTools=await zoneClient.listTools();
  assert.ok(zoneTools.tools.some(tool=>tool.name==='list_devices'));
  const zoneWorkspaceTool=zoneTools.tools.find(
    tool=>tool.name==='list_workspaces'
  );
  assert.ok(zoneWorkspaceTool);
  assert.ok(
    Array.isArray(zoneWorkspaceTool.inputSchema.required)
    && zoneWorkspaceTool.inputSchema.required.includes('device')
  );

  const listedDevices:any=await zoneClient.callTool({
    name:'list_devices',
    arguments:{}
  });
  const listedDevicePayload=JSON.parse(listedDevices.content[0].text);
  assert.equal(listedDevicePayload.zone,'Test Zone');
  assert.equal(listedDevicePayload.devices.length,1);
  assert.equal(listedDevicePayload.devices[0].name,'Zone Worker');
  assert.equal(listedDevicePayload.devices[0].online,true);

  const zoneWorkspaces:any=await zoneClient.callTool({
    name:'list_workspaces',
    arguments:{
      device:'Zone Worker'
    }
  });
  assert.equal(
    JSON.parse(zoneWorkspaces.content[0].text).defaultWorkspace,
    'test'
  );

  const zoneLockedWrite:any=await zoneClient.callTool({
    name:'write_file',
    arguments:{
      device:'Zone Worker',
      path:'zone-locked.txt',
      content:'blocked'
    }
  });
  assert.equal(
    zoneLockedWrite.isError,
    true,
    'Zone routing must preserve the target Agent local LOCK boundary'
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
  const remoteAdminLogin=await fetch(
    origin+'/api/admin/login',
    {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:relayAdminToken})
    }
  );
  assert.equal(remoteAdminLogin.status,200);
  const remoteAdminCookie=(remoteAdminLogin.headers.get('set-cookie')||'').split(';')[0];

  const remoteUnlockPath=
    `${origin}/api/admin/zones/${createdZone.zoneId}/devices/${registered.deviceId}/unlock`;

  assert.equal(
    (
      await fetch(
        remoteUnlockPath,
        {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({minutes:30})
        }
      )
    ).status,
    401,
    'Remote unlock must require the Relay Admin session'
  );

  const remoteUnlock=await fetch(
    remoteUnlockPath,
    {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        Cookie:remoteAdminCookie
      },
      body:JSON.stringify({minutes:30})
    }
  );
  assert.equal(remoteUnlock.status,200);
  const remoteUnlockResult:any=await remoteUnlock.json();
  assert.equal(remoteUnlockResult.ok,true);
  assert.equal(remoteUnlockResult.source,'remote');
  assert.match(
    await cli('status'),
    /Unlock source: remote/
  );

  const zoneRemoteWrite:any=await zoneClient.callTool({
    name:'write_file',
    arguments:{
      device:'Zone Worker',
      path:'zone-remote-unlocked.txt',
      content:'remote admin unlock'
    }
  });
  assert.equal(zoneRemoteWrite.isError,undefined);
  assert.equal(
    await readFile(join(root,'zone-remote-unlocked.txt'),'utf8'),
    'remote admin unlock'
  );

  assert.match(
    await cli('lock'),
    /Security: LOCKED/
  );

  assert.match(
    await cli('unlock','--minutes','5'),
    /Security: UNLOCKED/
  );

  const zoneUnlockedWrite:any=await zoneClient.callTool({
    name:'write_file',
    arguments:{
      device:'Zone Worker',
      path:'zone-routed.txt',
      content:'through zone router'
    }
  });
  assert.equal(zoneUnlockedWrite.isError,undefined);
  assert.equal(
    await readFile(join(root,'zone-routed.txt'),'utf8'),
    'through zone router'
  );

  await zoneClient.close();

  const connectorRotation=await fetch(
    `${origin}/api/zones/${createdZone.zoneId}/connector`,
    {
      method:'POST',
      headers:zoneHeaders,
      body:'{}'
    }
  );
  assert.equal(connectorRotation.status,200);
  const rotatedConnector:any=await connectorRotation.json();
  assert.notEqual(rotatedConnector.mcpUrl,createdZone.mcpUrl);

  assert.equal(
    (
      await fetch(
        createdZone.mcpUrl,
        {
          method:'POST',
          headers:{
            'Content-Type':'application/json'
          },
          body:JSON.stringify({
            jsonrpc:'2.0',
            id:'old-zone-token',
            method:'ping'
          })
        }
      )
    ).status,
    404,
    'rotating the Zone connector must invalidate the previous URL'
  );

  const rotatedZoneClient=new Client({
    name:'rotated-zone-worker-test',
    version:'1'
  });
  await rotatedZoneClient.connect(
    new StreamableHTTPClientTransport(
      new URL(rotatedConnector.mcpUrl)
    )
  );
  assert.ok(
    (await rotatedZoneClient.listTools()).tools.some(
      tool=>tool.name==='list_devices'
    )
  );
  await rotatedZoneClient.close();

  tools=await client.listTools();

  assert.equal(tools.tools.length,26);

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
    26
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

  const trackedProcess:any=await client.callTool({
    name:'start_process',
    arguments:{
      command:nodeCommand('setInterval(()=>{},1000)')
    }
  });
  const trackedProcessInfo=JSON.parse(
    trackedProcess.content[0].text
  );

  const saturatedExecutions=Array.from(
    {length:8},
    ()=>client.callTool({
      name:'call_mcp_tool',
      arguments:{
        server:'fixture',
        tool:'echo',
        arguments:{
          text:'saturate'
        }
      }
    })
  );

  await new Promise(
    resolveDelay=>setTimeout(resolveDelay,150)
  );

  const blockedExecution=await fetch(
    originalUrl,
    {
      method:'POST',
      headers:{
        'Content-Type':'application/json'
      },
      body:JSON.stringify({
        jsonrpc:'2.0',
        id:'capacity-probe',
        method:'tools/call',
        params:{
          name:'write_file',
          arguments:{
            path:'capacity-probe.txt',
            content:'must not execute'
          }
        }
      })
    }
  );

  assert.equal(
    blockedExecution.status,
    429,
    'the eight execution requests must actually saturate the execution lane'
  );

  const readWhileSaturated=client.callTool({
    name:'read_process',
    arguments:{
      processId:trackedProcessInfo.processId,
      stdoutCursor:0,
      stderrCursor:0
    }
  });
  const listWhileSaturated=client.callTool({
    name:'list_processes',
    arguments:{}
  });

  assert.equal(
    await Promise.race([
      Promise.all([readWhileSaturated,listWhileSaturated])
        .then(()=> 'control'),
      saturatedExecutions[0].then(()=> 'execution')
    ]),
    'control',
    'read-only process status must remain available when all execution slots are occupied'
  );

  const processStatus:any=await readWhileSaturated;
  const processList:any=await listWhileSaturated;
  assert.equal(
    JSON.parse(processStatus.content[0].text).running,
    true
  );
  assert.ok(
    JSON.parse(processList.content[0].text).some(
      (process:any)=>process.processId===trackedProcessInfo.processId
    )
  );

  await Promise.all(saturatedExecutions);
  await client.callTool({
    name:'stop_process',
    arguments:{
      processId:trackedProcessInfo.processId
    }
  });

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
    restartedTools.tools.some(
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
