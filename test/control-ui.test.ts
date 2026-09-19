import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile, fork, spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';

const exec=promisify(execFile);

async function waitForFixture(
  child:ReturnType<typeof fork>,
  getErrors:()=>string
){
  await new Promise<void>((done,reject)=>{
    const timer=setTimeout(
      ()=>reject(new Error('Control fixture startup timed out: '+getErrors())),
      10000
    );

    child.once('message',()=>{
      clearTimeout(timer);
      done();
    });
    child.once('error',error=>{
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit',code=>{
      clearTimeout(timer);
      reject(new Error(`Control fixture exited (${code}): ${getErrors()}`));
    });
  });
}

async function waitForUi(
  child:ReturnType<typeof spawn>,
  getErrors:()=>string
){
  return await new Promise<string>((done,reject)=>{
    let output='';
    const timer=setTimeout(
      ()=>reject(new Error('Control UI startup timed out: '+getErrors())),
      10000
    );

    child.stdout?.on('data',data=>{
      output+=data.toString();
      const match=/Easy Local MCP control UI: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
      if(match){
        clearTimeout(timer);
        done(match[1]);
      }
    });
    child.once('error',error=>{
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit',code=>{
      clearTimeout(timer);
      reject(new Error(`Control UI exited before ready (${code}): ${getErrors()}`));
    });
  });
}

test('local control UI is loopback-only, authenticated, redacted and uses isolated state',{timeout:40000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-ui-'));
  const stateDir=join(home,'.localmcp');
  const workspace=join(home,'workspace');
  const workspace2=join(home,'workspace-2');
  const configPath=join(stateDir,'localmcp.json');

  await mkdir(stateDir,{recursive:true});
  await mkdir(join(stateDir,'skills'),{recursive:true});
  await mkdir(workspace,{recursive:true});
  await mkdir(workspace2,{recursive:true});

  const originalConfig={
    workspaces:{project:workspace},
    defaultWorkspace:'project',
    features:{
      files:{read:true,write:false,delete:false},
      shell:false,
      processes:false,
      externalMcp:false
    },
    skills:{dir:'skills',enabled:[]},
    mcpServers:{
      futureCompatibleFixture:{
        enabled:false,
        command:'never-run',
        args:['--kept'],
        env:{PRESERVE_ME:'yes'}
      }
    }
  };

  await writeFile(configPath,JSON.stringify(originalConfig,null,2)+'\n');

  const leakedAuditSecret='audit-secret-must-not-display';
  await writeFile(
    join(stateDir,'audit.log'),
    JSON.stringify({
      timestamp:'2026-09-18T00:00:00.000Z',
      event:'privileged_tool_failure',
      tool:'run_command',
      workspace:'project',
      reason:'denied',
      secret:leakedAuditSecret,
      command:'echo private-value',
      stdout:'private-output'
    })+'\n'
  );

  const env:{[key:string]:string|undefined}={
    ...process.env,
    HOME:home,
    USERPROFILE:home,
    LOCALMCP_UI_PORT:'0'
  };

  delete env.LOCALMCP_CONFIG;
  delete env.LOCALMCP_ROOT;
  delete env.LOCALMCP_SHELL;
  delete env.LOCALMCP_REGISTRATION_TOKEN;
  delete env.LOCALMCP_WORKER_URL;

  let fixtureErrors='';
  const fixture=fork(
    resolve('test/fixtures/control-server.mjs'),
    [],
    {
      env,
      stdio:['ignore','ignore','pipe','ipc']
    }
  );
  fixture.stderr?.on('data',data=>{fixtureErrors+=data.toString();});

  let uiErrors='';
  let uiOutput='';
  let ui:ReturnType<typeof spawn>|undefined;

  t.after(async()=>{
    if(ui&&ui.exitCode===null)ui.kill('SIGTERM');
    if(fixture.exitCode===null)fixture.kill('SIGTERM');
    await new Promise(resolveDelay=>setTimeout(resolveDelay,250));
    await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });

  await waitForFixture(fixture,()=>fixtureErrors);

  const controlSecret=(
    await readFile(join(stateDir,'control.secret'),'utf8')
  ).trim();
  assert.match(controlSecret,/^[a-f0-9]{64}$/);

  ui=spawn(
    process.execPath,
    [resolve('dist/index.js'),'ui','--no-open'],
    {
      env,
      stdio:['ignore','pipe','pipe']
    }
  );
  ui.stdout?.on('data',data=>{uiOutput+=data.toString();});
  ui.stderr?.on('data',data=>{uiErrors+=data.toString();});

  const uiUrl=await waitForUi(ui,()=>uiErrors);
  const origin=new URL(uiUrl).origin;

  assert.equal(new URL(uiUrl).hostname,'127.0.0.1');
  assert.equal(new URL(uiUrl).search,'');
  assert.equal(new URL(uiUrl).hash,'');
  assert.ok(!uiUrl.includes(controlSecret));

  const page=await fetch(uiUrl);
  assert.equal(page.status,200);
  const html=await page.text();

  assert.match(html,/Easy Local MCP Control Center/);
  assert.match(html,/do not sandbox shell commands/);
  assert.match(html,/Agent lifecycle/);
  assert.match(html,/Re-register Worker/);
  assert.match(html,/auditPageSize/);
  assert.match(html,/auditPrev/);
  assert.match(html,/auditNext/);
  assert.match(html,/id="operationOverlay"/);
  assert.match(html,/operation-spinner/);
  const inlineScript=/<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(()=>new Function(inlineScript));
  assert.match(inlineScript,/withOperation/);
  assert.match(inlineScript,/operationActive/);
  assert.match(inlineScript,/response\.status===401/);
  assert.match(inlineScript,/post\('\/api\/session'/);
  assert.ok(!html.includes(controlSecret));
  assert.ok(!html.includes('a'.repeat(64)));

  const unauthenticated=await fetch(new URL('/api/status',uiUrl),{
    method:'POST',
    headers:{
      Origin:origin,
      'Content-Type':'application/json'
    },
    body:'{}'
  });
  assert.equal(unauthenticated.status,401);

  const crossOrigin=await fetch(new URL('/api/session',uiUrl),{
    method:'POST',
    headers:{
      Origin:'https://evil.example',
      'Content-Type':'application/json'
    },
    body:'{}'
  });
  assert.equal(crossOrigin.status,403);

  const queryRejected=await fetch(new URL('/api/status?secret=nope',uiUrl),{
    method:'POST',
    headers:{
      Origin:origin,
      'Content-Type':'application/json'
    },
    body:'{}'
  });
  assert.equal(queryRejected.status,400);

  const sessionResponse=await fetch(new URL('/api/session',uiUrl),{
    method:'POST',
    headers:{
      Origin:origin,
      'Content-Type':'application/json'
    },
    body:'{}'
  });

  assert.equal(sessionResponse.status,200);
  const setCookie=sessionResponse.headers.get('set-cookie');
  assert.ok(setCookie);
  assert.match(setCookie,/HttpOnly/i);
  assert.match(setCookie,/SameSite=Strict/i);
  const cookie=setCookie!.split(';')[0];
  assert.ok(!cookie.includes(controlSecret));

  const api=async(path:string,body:Record<string,unknown>={})=>{
    const response=await fetch(new URL(path,uiUrl),{
      method:'POST',
      headers:{
        Origin:origin,
        Cookie:cookie,
        'Content-Type':'application/json'
      },
      body:JSON.stringify(body)
    });
    const value=await response.json() as any;
    return {response,value};
  };

  const initial=await api('/api/status');
  assert.equal(initial.response.status,200);
  const refreshedCookie=initial.response.headers.get('set-cookie');
  assert.ok(refreshedCookie);
  assert.match(refreshedCookie,/Max-Age=1800/i);
  assert.equal(refreshedCookie!.split(';')[0],cookie);
  assert.equal(initial.value.agent.status,'running');
  assert.equal(initial.value.agent.locked,true);
  assert.equal(initial.value.connection.workerUrl,'https://example.test/');
  assert.equal(initial.value.connection.state,'connected');
  assert.equal(initial.value.connection.deviceId,'fixture-device');
  assert.equal(initial.value.connection.workerManagedByEnv,false);
  assert.match(initial.value.connection.mcpUrlMasked,/redacted/i);
  assert.ok(!JSON.stringify(initial.value).includes('a'.repeat(64)));
  assert.equal(initial.value.configuration.defaultWorkspace,'project');
  assert.equal(initial.value.configuration.features.fileRead,true);
  assert.equal(initial.value.configuration.features.fileWrite,false);
  assert.equal(initial.value.capabilities.find((item:any)=>item.key==='fileRead').availability,'available');
  assert.equal(initial.value.capabilities.find((item:any)=>item.key==='fileWrite').availability,'disabled');

  const startWhileRunning=await api('/api/agent/start');
  assert.equal(startWhileRunning.response.status,200);
  assert.equal(startWhileRunning.value.agent.status,'running');
  const stopNeedsConfirmation=await api('/api/agent/stop',{confirm:false});
  assert.equal(stopNeedsConfirmation.response.status,400);
  const restartNeedsConfirmation=await api('/api/agent/restart',{confirm:false});
  assert.equal(restartNeedsConfirmation.response.status,400);

  const configRead=await api('/api/config');
  assert.equal(configRead.response.status,200);
  assert.equal(configRead.value.configuration.path,configPath);
  assert.equal(
    await realpath(configRead.value.configuration.workspaces[0].root),
    await realpath(workspace)
  );

  for(const minutes of [5,30,60]){
    const unlocked=await api('/api/unlock',{minutes});
    assert.equal(unlocked.response.status,200);
    assert.equal(unlocked.value.agent.locked,false);
    assert.ok(!JSON.stringify(unlocked.value).includes('a'.repeat(64)));

    const expiry=Date.parse(unlocked.value.agent.unlockExpiresAt);
    const remaining=expiry-Date.now();
    assert.ok(remaining>(minutes*60_000)-10000);
    assert.ok(remaining<=(minutes*60_000)+10000);
  }

  const locked=await api('/api/lock');
  assert.equal(locked.response.status,200);
  assert.equal(locked.value.agent.locked,true);
  assert.ok(!JSON.stringify(locked.value).includes('a'.repeat(64)));

  const dangerousWithoutConfirmation=await api('/api/config/update',{
    features:{
      fileRead:true,
      fileWrite:true,
      fileDelete:false,
      shell:true,
      processes:true,
      externalMcp:true
    },
    confirmDangerous:false
  });
  assert.equal(dangerousWithoutConfirmation.response.status,400);
  assert.match(dangerousWithoutConfirmation.value.error,/confirmation/i);

  const updated=await api('/api/config/update',{
    features:{
      fileRead:true,
      fileWrite:true,
      fileDelete:false,
      shell:true,
      processes:true,
      externalMcp:true
    },
    confirmDangerous:true
  });

  assert.equal(updated.response.status,200);
  assert.equal(updated.value.saved,true);
  assert.equal(updated.value.reloaded,true);

  const saved=JSON.parse(await readFile(configPath,'utf8'));
  assert.deepEqual(saved.workspaces,originalConfig.workspaces);
  assert.deepEqual(saved.skills,originalConfig.skills);
  assert.deepEqual(saved.mcpServers,originalConfig.mcpServers);
  assert.deepEqual(saved.features,{
    files:{read:true,write:true,delete:false},
    shell:true,
    processes:true,
    externalMcp:true
  });

  const afterPermissions=await api('/api/status');
  assert.equal(
    afterPermissions.value.capabilities.find((item:any)=>item.key==='fileWrite').availability,
    'locked'
  );

  const workspaceNeedsConfirmation=await api('/api/workspaces/update',{
    workspaces:[{name:'project',root:workspace}],
    defaultWorkspace:'project',
    confirm:false
  });
  assert.equal(workspaceNeedsConfirmation.response.status,400);

  const invalidWorkspace=await api('/api/workspaces/update',{
    workspaces:[{name:'missing',root:join(home,'does-not-exist')}],
    defaultWorkspace:'missing',
    confirm:true
  });
  assert.equal(invalidWorkspace.response.status,400);

  const workspaceUpdated=await api('/api/workspaces/update',{
    workspaces:[
      {name:'project',root:workspace},
      {name:'archive',root:workspace2}
    ],
    defaultWorkspace:'archive',
    confirm:true
  });
  assert.equal(workspaceUpdated.response.status,200);
  assert.equal(workspaceUpdated.value.saved,true);
  assert.equal(workspaceUpdated.value.reloaded,true);
  assert.equal(workspaceUpdated.value.configuration.defaultWorkspace,'archive');
  assert.equal(workspaceUpdated.value.configuration.workspaces.length,2);

  const savedWorkspaces=JSON.parse(await readFile(configPath,'utf8'));
  assert.deepEqual(savedWorkspaces.workspaces,{project:workspace,archive:workspace2});
  assert.equal(savedWorkspaces.defaultWorkspace,'archive');
  assert.deepEqual(savedWorkspaces.skills,originalConfig.skills);
  assert.deepEqual(savedWorkspaces.mcpServers,originalConfig.mcpServers);

  const reloadResult=await api('/api/reload');
  assert.equal(reloadResult.response.status,200);
  assert.ok(!JSON.stringify(reloadResult.value).includes('a'.repeat(64)));

  const rotateNeedsConfirmation=await api('/api/rotate',{confirm:false});
  assert.equal(rotateNeedsConfirmation.response.status,400);

  const rotated=await api('/api/rotate',{confirm:true});
  assert.equal(rotated.response.status,200);
  assert.ok(!JSON.stringify(rotated.value).includes('a'.repeat(64)));

  const cliStatus=(
    await exec(
      process.execPath,
      [resolve('dist/index.js'),'status'],
      {env,timeout:10000}
    )
  ).stdout;

  assert.match(cliStatus,/reloads:3/);
  assert.match(cliStatus,/rotations:1/);
  assert.ok(!cliStatus.includes('a'.repeat(64)));

  const revealNeedsConfirmation=await api('/api/reveal-url',{confirm:false});
  assert.equal(revealNeedsConfirmation.response.status,400);

  const revealed=await api('/api/reveal-url',{confirm:true});
  assert.equal(revealed.response.status,200);
  assert.equal(
    revealed.value.url,
    'https://example.test/mcp/device/'+'a'.repeat(64)
  );

  const reregisterNeedsConfirmation=await api('/api/worker/reregister',{
    workerUrl:'https://worker.example',
    confirm:false
  });
  assert.equal(reregisterNeedsConfirmation.response.status,400);

  const reregistered=await api('/api/worker/reregister',{
    workerUrl:'https://worker.example',
    confirm:true
  });
  assert.equal(reregistered.response.status,200);
  assert.equal(reregistered.value.connection.workerUrl,'https://worker.example/');
  assert.equal(reregistered.value.connection.deviceId,'fixture-device');
  assert.ok(!JSON.stringify(reregistered.value).includes('a'.repeat(64)));

  const cliAfterReregister=(
    await exec(
      process.execPath,
      [resolve('dist/index.js'),'status'],
      {env,timeout:10000}
    )
  ).stdout;
  assert.match(cliAfterReregister,/reregistrations:1/);
  assert.ok(!cliAfterReregister.includes('a'.repeat(64)));

  const audit=await api('/api/audit');
  assert.equal(audit.response.status,200);
  const auditText=JSON.stringify(audit.value);
  assert.match(auditText,/mcp_url_reveal/);
  assert.match(auditText,/privileged_tool_failure/);
  assert.ok(!auditText.includes(leakedAuditSecret));
  assert.ok(!auditText.includes('echo private-value'));
  assert.ok(!auditText.includes('private-output'));
  assert.ok(!auditText.includes(controlSecret));

  assert.ok(!uiOutput.includes(controlSecret));
  assert.ok(!uiErrors.includes(controlSecret));

  const stateFiles=await import('node:fs/promises').then(fs=>fs.readdir(stateDir));
  assert.ok(stateFiles.includes('control.secret'));
  assert.ok(stateFiles.includes('localmcp.json'));
});

test('fresh Control Center requires explicit Relay setup before Agent start',{timeout:30000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-first-run-'));
  const stateDir=join(home,'.localmcp');
  const env:{[key:string]:string|undefined}={
    ...process.env,
    HOME:home,
    USERPROFILE:home,
    LOCALMCP_UI_PORT:'0'
  };
  delete env.LOCALMCP_CONFIG;
  delete env.LOCALMCP_ROOT;
  delete env.LOCALMCP_REGISTRATION_TOKEN;
  delete env.LOCALMCP_WORKER_URL;

  let uiErrors='';
  let ui:ReturnType<typeof spawn>|undefined;
  t.after(async()=>{
    if(ui&&ui.exitCode===null)ui.kill('SIGTERM');
    await new Promise(resolveDelay=>setTimeout(resolveDelay,200));
    await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });

  ui=spawn(
    process.execPath,
    [resolve('dist/index.js'),'ui','--no-open'],
    {env,stdio:['ignore','pipe','pipe']}
  );
  ui.stderr?.on('data',data=>{uiErrors+=data.toString();});

  const uiUrl=await waitForUi(ui,()=>uiErrors);
  const origin=new URL(uiUrl).origin;
  const page=await fetch(uiUrl);
  const html=await page.text();
  assert.match(html,/Choose a Relay before starting Easy Local MCP/);
  assert.match(html,/Save & Start Agent/);
  const inlineScript=/<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(()=>new Function(inlineScript));

  const sessionResponse=await fetch(new URL('/api/session',uiUrl),{
    method:'POST',
    headers:{Origin:origin,'Content-Type':'application/json'},
    body:'{}'
  });
  const setCookie=sessionResponse.headers.get('set-cookie');
  assert.ok(setCookie);
  const cookie=setCookie!.split(';')[0];
  const api=async(path:string,body:Record<string,unknown>={})=>{
    const response=await fetch(new URL(path,uiUrl),{
      method:'POST',
      headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},
      body:JSON.stringify(body)
    });
    const value=await response.json() as any;
    return {response,value};
  };

  const initial=await api('/api/status');
  assert.equal(initial.response.status,200);
  assert.equal(initial.value.agent.status,'stopped');
  assert.equal(initial.value.connection.configured,false);
  assert.equal(initial.value.connection.needsSetup,true);
  assert.equal(initial.value.connection.workerUrl,null);
  assert.equal(
    initial.value.connection.suggestedWorkerUrl,
    'https://localmcp-relay.daodao973597.workers.dev/'
  );

  const blockedStart=await api('/api/agent/start',{confirm:true});
  assert.equal(blockedStart.response.status,400);
  assert.match(blockedStart.value.error,/Relay is not configured/);

  const registrationToken='first-run-registration-token-secret';
  const configured=await api('/api/relay/configure',{
    workerUrl:'https://relay.example.test',
    registrationToken,
    start:false,
    confirm:true
  });
  assert.equal(configured.response.status,200);
  assert.equal(configured.value.agent.status,'stopped');
  assert.equal(configured.value.connection.configured,true);
  assert.equal(configured.value.connection.needsSetup,false);
  assert.equal(configured.value.connection.workerUrl,'https://relay.example.test/');

  const relayFile=JSON.parse(await readFile(join(stateDir,'relay.json'),'utf8'));
  assert.equal(relayFile.workerUrl,'https://relay.example.test/');
  assert.equal(
    (await readFile(join(stateDir,'registration-token.pending'),'utf8')).trim(),
    registrationToken
  );

  const auditText=await readFile(join(stateDir,'audit.log'),'utf8');
  assert.match(auditText,/relay_config_update/);
  assert.ok(!auditText.includes(registrationToken));
});
