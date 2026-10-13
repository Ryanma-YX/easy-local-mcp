import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,readFile,rm,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {assertNoStandaloneAgent,renderUserService,serviceExecutablePath,UNIT_NAME} from '../scripts/systemd-user-service.mjs';
import {assertManagedOwner,USER_SERVICE_HEADER,USER_SERVICE_UNIT} from '../src/systemd-service.js';

function runNode(args:string[],env:NodeJS.ProcessEnv,timeout=8500){
  return new Promise<{exitCode:number|null;output:string;timedOut:boolean}>(done=>{
    const child=spawn(process.execPath,args,{cwd:resolve('.'),env,
      stdio:['ignore','pipe','pipe']});
    let output='',finished=false;
    child.stdout?.on('data',(data:Buffer)=>{output+=data.toString();});
    child.stderr?.on('data',(data:Buffer)=>{output+=data.toString();});
    const timer=setTimeout(()=>{
      if(finished)return;
      finished=true;
      child.kill('SIGKILL');
      done({exitCode:null,output,timedOut:true});
    },timeout);
    child.once('exit',exitCode=>{
      if(finished)return;
      finished=true;
      clearTimeout(timer);
      done({exitCode,output,timedOut:false});
    });
    child.once('error',error=>{
      if(finished)return;
      finished=true;
      clearTimeout(timer);
      done({exitCode:null,output:String(error),timedOut:false});
    });
  });
}

test('project unit name is permanent and identical for installer and lifecycle',()=>{
  assert.equal(UNIT_NAME,USER_SERVICE_UNIT);
  assert.match(UNIT_NAME,/^easy-local-mcp-[0-9a-f]{8}\.service$/);
});

test('an earlier untagged unit fails closed without deleting the old unit',{
  skip:process.platform!=='linux',timeout:16000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-v13-old-unit-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const dir=join(home,'.config','systemd','user');
  await mkdir(dir,{recursive:true,mode:0o700});
  const legacyPath=join(dir,'easy-local-mcp.service');
  const original=USER_SERVICE_HEADER+'\n# deliberately old version\n';
  await writeFile(legacyPath,original);
  const env={...process.env,HOME:home,USERPROFILE:home};
  delete env.LOCALMCP_SYSTEMD_MANAGED;
  delete env.NOTIFY_SOCKET;
  const install=await runNode([resolve('scripts/systemd-user-service.mjs'),'install'],env);
  assert.equal(install.timedOut,false);
  assert.notEqual(install.exitCode,0);
  assert.match(install.output,/earlier untagged Easy Local MCP user unit/);
  await assert.rejects(readFile(join(dir,UNIT_NAME),'utf8'),{code:'ENOENT'});
  const standalone=await runNode([resolve('dist/index.js'),'agent'],env);
  assert.equal(standalone.timedOut,false);
  assert.notEqual(standalone.exitCode,0);
  assert.match(standalone.output,/older Easy Local MCP systemd user unit/);
  assert.equal(await readFile(legacyPath,'utf8'),original);
});

test('first-time installer preflight detects an existing standalone control listener',{
  skip:process.platform!=='linux'
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-install-preflight-'));
  const stateDir=join(home,'.localmcp');
  await mkdir(stateDir);
  const address=join(stateDir,'agent.sock');
  const listener=createServer(socket=>socket.end());
  t.after(async()=>{
    if(listener.listening)await new Promise<void>(done=>listener.close(()=>done()));
    await rm(home,{recursive:true,force:true});
  });
  await new Promise<void>((done,reject)=>{
    listener.once('error',reject);
    listener.listen(address,()=>done());
  });
  await assert.rejects(assertNoStandaloneAgent(home),/Stop it with the normal CLI/);
  await new Promise<void>(done=>listener.close(()=>done()));
  // Closing a Unix listener removes its socket on Node.js, so fresh installs work.
  await assert.doesNotReject(assertNoStandaloneAgent(home));
});

test('systemd user unit captures the selected Node and explicit external MCP PATH',()=>{
  const executablePath=serviceExecutablePath('/opt/custom-node/bin/node',
    '/opt/custom-uv/bin:/usr/bin');
  assert.ok(executablePath.startsWith('/opt/custom-node/bin:'));
  assert.ok(executablePath.includes(':/opt/custom-uv/bin:'));
  const service=renderUserService({
    nodePath:'/opt/custom-node/bin/node',
    entryPath:'/tmp/localmcp/dist/index.js',
    executablePath
  });
  assert.ok(service.includes('Environment="PATH='+executablePath+'"'));
  assert.ok(service.startsWith(USER_SERVICE_HEADER+'\n'));
  assert.match(service,/KillMode=control-group/);
  assert.throws(
    ()=>serviceExecutablePath('/bin/node','relative/bin:/usr/bin'),
    /must be absolute/
  );
});

test('installed systemd mode never falls back to standalone CLI or direct Agent',{
  skip:process.platform!=='linux',timeout:18000
},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-v10-routing-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const systemdDir=join(home,'.config','systemd','user');
  const bin=join(home,'bin');
  await mkdir(systemdDir,{recursive:true,mode:0o700});
  await mkdir(bin,{recursive:true,mode:0o700});
  await writeFile(join(systemdDir,UNIT_NAME),renderUserService());
  await mkdir(join(home,'.localmcp'),{recursive:true});
  // Fake a loaded-but-inactive systemd service. Its calls are recorded to
  // prove no CLI command silently launches its own background Node agent.
  const shim=join(bin,'systemctl');
  await writeFile(shim,`#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/service.calls"
case " $* " in
  *' show '*)
    printf 'LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\n'
    ;;
esac
exit 0
`);
  await chmod(shim,0o700);
  const env={...process.env,HOME:home,USERPROFILE:home,
    PATH:bin+':'+(process.env.PATH??'/usr/bin:/bin')};
  for(const key of ['LOCALMCP_INTERNAL','LOCALMCP_SYSTEMD_MANAGED',
    'NOTIFY_SOCKET','WATCHDOG_USEC','LOCALMCP_WORKER_URL']){
    delete env[key];
  }

  const stopped=await runNode([resolve('dist/index.js'),'stop'],env);
  assert.equal(stopped.timedOut,false);
  assert.equal(stopped.exitCode,0,stopped.output);
  assert.match(stopped.output,/systemd user service/);

  const start=await runNode([resolve('dist/index.js'),'start'],env);
  assert.equal(start.timedOut,false);
  assert.match(start.output,/systemd|relay/i);
  // With no configured Relay, initialization must not fall back to detached
  // startup; the service itself has not been started by this test stub.
  const direct=await runNode([resolve('dist/index.js'),'agent'],env);
  assert.equal(direct.timedOut,false);
  assert.notEqual(direct.exitCode,0,'Direct Agent bypassed installed service');
  assert.match(direct.output,/systemd user service/);

  const calls=await readFile(join(home,'service.calls'),'utf8');
  assert.ok(calls.includes('--user show '+UNIT_NAME));
  assert.ok(calls.includes('--user stop '+UNIT_NAME));
  assert.ok(!calls.includes('--user start '+UNIT_NAME),
    'Missing Relay must not accidentally launch a background process');
});


test('managed owner identity rejects an unexpected or stale standalone Agent',()=>{
  const unit={mode:'systemd-user' as const,unit:UNIT_NAME,
    active:true,mainPid:1234,state:'active'};
  assert.doesNotThrow(()=>assertManagedOwner(unit,{status:'running',pid:1234}));
  assert.throws(()=>assertManagedOwner(unit,{status:'running',pid:4321}),
    /Refusing an unsafe lifecycle change/);
  assert.throws(()=>assertManagedOwner({...unit,active:false},{
    status:'running',pid:1234
  }),/Refusing an unsafe lifecycle change/);
});

test('an actual systemd user service can launch node and npx through configured PATH',{
  skip:process.platform!=='linux',timeout:25000
},async t=>{
  const {execFile}=await import('node:child_process');
  const {promisify}=await import('node:util');
  const exec=promisify(execFile);
  try{
    await exec('systemctl',['--user','show-environment'],{timeout:5000});
  }catch{t.skip('No systemd user manager');return;}
  const home=await mkdtemp(join(tmpdir(),'localmcp-v10-external-path-'));
  const unit='localmcp-v10-path-'+process.pid+'-'+Date.now();
  t.after(async()=>{
    await exec('systemctl',['--user','stop',unit],{timeout:5000}).catch(()=>{});
    await rm(home,{recursive:true,force:true});
  });
  const marker=join(home,'verified.json');
  const servicePath=serviceExecutablePath(process.execPath,'/usr/bin:/bin');
  const script=[
    "const {spawnSync}=require('node:child_process');",
    "const fs=require('node:fs');",
    "const node=spawnSync('node',['--version'],{encoding:'utf8',timeout:5000});",
    "const npx=spawnSync('npx',['--version'],{encoding:'utf8',timeout:8000});",
    "fs.writeFileSync(process.env.LOCALMCP_MARKER,JSON.stringify({",
    "node:node.status,npx:npx.status,nodeOutput:node.stdout,npxOutput:npx.stdout",
    "}));",
    "if(node.status!==0||npx.status!==0)process.exit(9);"
  ].join('');
  await exec('systemd-run',[
    '--user','--wait','--collect','--unit='+unit,
    '--property=Type=exec',
    '--setenv=PATH='+servicePath,
    '--setenv=LOCALMCP_MARKER='+marker,
    process.execPath,'-e',script
  ],{timeout:18000});
  const result=JSON.parse(await readFile(marker,'utf8')) as {
    node:number;npx:number;nodeOutput:string;npxOutput:string
  };
  assert.equal(result.node,0);
  assert.equal(result.npx,0);
  assert.match(result.nodeOutput,/^v22/);
  assert.match(result.npxOutput,/\d/);
});
