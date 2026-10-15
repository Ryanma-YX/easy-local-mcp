import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {readFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const pause=(ms:number)=>new Promise(ok=>setTimeout(ok,ms));
async function waitFor(check:()=>Promise<boolean>,label:string,limit=24000){
  const until=Date.now()+limit;
  while(Date.now()<until){
    if(await check())return;
    await pause(100);
  }
  throw new Error('Timeout: '+label);
}
async function systemdAvailable(){
  try{
    const result=await exec('systemctl',['--user','is-system-running'],{timeout:4000});
    return /running|degraded/.test(result.stdout);
  }catch(e){
    return /degraded/.test(String((e as {stdout?:string}).stdout??''));
  }
}
async function unitProps(unit:string){
  const result=await exec('systemctl',['--user','show',unit,
    '-p','ActiveState','-p','SubState','-p','Result',
    '-p','MainPID','-p','ControlGroup','-p','NRestarts'],{timeout:6000});
  return Object.fromEntries(
    result.stdout.trim().split('\n').map(s=>{
      const split=s.indexOf('=');
      return [s.slice(0,split),s.slice(split+1)];
    })
  );
}
async function alive(pid:number){
  if(!pid)return false;
  const stat=await readFile('/proc/'+pid+'/stat','utf8').catch(()=>'');
  return Boolean(stat)&&!['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2,stat.lastIndexOf(')')+3));
}
async function childPid(pid:number){
  const s=await readFile('/proc/'+pid+'/task/'+pid+'/children','utf8').catch(()=>'');
  for(const child of s.trim().split(/\s+/).map(Number)){
    if(!child)continue;
    const cmd=await readFile('/proc/'+child+'/cmdline','utf8').catch(()=>'');
    if(cmd.includes('dist/index.js')&&cmd.includes('http'))return child;
  }
  return 0;
}
async function unusedPort(){
  const server=createServer();
  await new Promise<void>((ok,bad)=>{
    server.once('error',bad);
    server.listen(0,'127.0.0.1',ok);
  });
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  await new Promise<void>(ok=>server.close(()=>ok()));
  return address.port;
}
async function health(port:number){
  try{
    const response=await fetch('http://127.0.0.1:'+port+'/healthz',{
      signal:AbortSignal.timeout(700)
    });
    return response.status===200;
  }catch{return false;}
}
function unitName(label:string){
  return 'localmcp-v9-'+label+'-'+process.pid+'-'+Date.now()+'.service';
}
async function cleanupUnit(unit:string){
  await exec('systemctl',['--user','stop',unit],{timeout:12000}).catch(()=>{});
  await exec('systemctl',['--user','reset-failed',unit],{timeout:7000}).catch(()=>{});
}

test('rootless systemd restarts Agent after crash and either process hangs',{
  skip:process.platform!=='linux',timeout:105000
},async t=>{
  if(!(await systemdAvailable())){t.skip('systemd user manager unavailable');return;}
  const home=await mkdtemp(join(tmpdir(),'localmcp-v9-supervised-'));
  const unit=unitName('agent');
  const port=await unusedPort();
  const state=join(home,'.localmcp');
  await mkdir(state,{recursive:true,mode:0o700});
  await writeFile(join(state,'localmcp.json'),JSON.stringify({
    workspaces:{fixture:home},defaultWorkspace:'fixture',
    features:{shell:true,processes:true,externalMcp:false},
    security:{alwaysUnlocked:true}
  }));
  await writeFile(join(state,'worker.json'),JSON.stringify({
    workerUrl:'http://127.0.0.1:9/',
    agentToken:'a'.repeat(64),mcpToken:'b'.repeat(64),
    deviceId:'v9-disposable-device'
  }),{mode:0o600});
  t.after(async()=>{
    await cleanupUnit(unit);
    await rm(home,{recursive:true,force:true,maxRetries:4,retryDelay:80});
  });
  await exec('systemd-run',[
    '--user','--no-block','--unit='+unit,
    '--property=Type=notify',
    '--property=NotifyAccess=all',
    '--property=KillMode=control-group',
    '--property=Restart=on-failure',
    '--property=RestartSec=1s',
    '--property=StartLimitIntervalSec=90s',
    '--property=StartLimitBurst=6',
    '--property=WatchdogSec=8s',
    '--property=WatchdogSignal=SIGKILL',
    '--property=TimeoutStopSec=4s',
    '--property=TimeoutStartSec=20s',
    '--property=NoNewPrivileges=yes',
    '--property=UMask=0077',
    '--working-directory='+resolve('.'),
    '--setenv=HOME='+home,
    '--setenv=USERPROFILE='+home,
    '--setenv=LOCALMCP_WORKER_URL=http://127.0.0.1:9/',
    '--setenv=LOCALMCP_SYSTEMD_MANAGED=1',
    '--setenv=LOCALMCP_AGENT_PORT='+port,
    process.execPath,resolve('dist/index.js'),'agent'
  ],{timeout:10000});

  let main=0,http=0,group='';
  await waitFor(async()=>{
    const state=await unitProps(unit);
    main=Number(state.MainPID);
    group=state.ControlGroup??'';
    http=await childPid(main);
    return state.ActiveState==='active'&&main>0&&http>0&&await health(port);
  },'supervised Agent READY and local HTTP healthy',24000);
  assert.ok(group.includes(unit.slice(0,-8)));
  const childCgroup=(await readFile('/proc/'+http+'/cgroup','utf8')).trim();
  assert.ok(childCgroup.endsWith(group),'HTTP child is outside service cgroup');

  // A competing standalone Agent must refuse the already-owned control
  // endpoint without replacing or disrupting the systemd service.
  const duplicate=spawn(process.execPath,[resolve('dist/index.js'),'agent'],{
    env:{...process.env,HOME:home,USERPROFILE:home,
      LOCALMCP_WORKER_URL:'http://127.0.0.1:9/',
      LOCALMCP_AGENT_PORT:String(port)},
    stdio:'ignore'
  });
  const duplicateCode=await new Promise<number|null>((done,reject)=>{
    const timeout=setTimeout(()=>{
      duplicate.kill('SIGKILL');
      reject(new Error('Competing standalone Agent never exited'));
    },8000);
    duplicate.once('exit',code=>{clearTimeout(timeout);done(code);});
    duplicate.once('error',reject);
  });
  assert.notEqual(duplicateCode,0,'Competing Agent stole live service ownership');
  assert.equal(Number((await unitProps(unit)).MainPID),main);
  assert.equal(await health(port),true);

  process.kill(main,'SIGKILL');
  await waitFor(async()=>{
    const next=await unitProps(unit);
    return Number(next.MainPID)>0&&Number(next.MainPID)!==main
      &&next.ActiveState==='active'&&await health(port);
  },'systemd restart after main Agent SIGKILL',24000);
  assert.equal(await alive(http),false,'Old HTTP child survived cgroup cleanup');

  // A hung HTTP child cannot keep the Agent alive indefinitely: the Agent
  // probes local HTTP and exits with failure. systemd restarts the unit.
  const second=await unitProps(unit);
  const secondMain=Number(second.MainPID);
  const secondHttp=await childPid(secondMain);
  assert.ok(secondHttp>0);
  process.kill(secondHttp,'SIGSTOP');
  await waitFor(async()=>{
    const next=await unitProps(unit);
    return Number(next.MainPID)>0&&Number(next.MainPID)!==secondMain
      &&next.ActiveState==='active'&&await health(port);
  },'automatic restart after frozen HTTP child',27000);

  // A hung Agent cannot send watchdog notifications. The OS watchdog
  // terminates the service cgroup, even though the JS event loop is stopped.
  const thirdMain=Number((await unitProps(unit)).MainPID);
  process.kill(thirdMain,'SIGSTOP');
  await waitFor(async()=>{
    const next=await unitProps(unit);
    return Number(next.MainPID)>0&&Number(next.MainPID)!==thirdMain
      &&next.ActiveState==='active'&&await health(port);
  },'systemd watchdog recovery after frozen Agent',27000);
});

test('systemd removes descendants in a different session before restart',{
  skip:process.platform!=='linux',timeout:27000
},async t=>{
  if(!(await systemdAvailable())){t.skip('systemd user manager unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'localmcp-v9-group-'));
  const unit=unitName('cgroup');
  const marker=join(dir,'children.jsonl');
  let oldChild=0;
  t.after(async()=>{
    await cleanupUnit(unit);
    if(oldChild&&await alive(oldChild)){
      try{process.kill(oldChild,'SIGKILL');}catch{}
    }
    await rm(dir,{recursive:true,force:true});
  });
  await exec('systemd-run',[
    '--user','--no-block','--unit='+unit,
    '--property=Type=exec',
    '--property=KillMode=control-group',
    '--property=Restart=on-failure',
    '--property=RestartSec=1s',
    '--property=StartLimitIntervalSec=20s',
    '--property=StartLimitBurst=3',
    '--setenv=LOCALMCP_SMOKE_MARKER='+marker,
    process.execPath,resolve('test/fixtures/systemd-process-tree.mjs')
  ],{timeout:10000});
  let firstMain=0,firstGroup='';
  await waitFor(async()=>{
    const lines=(await readFile(marker,'utf8').catch(()=>'')).trim().split('\n');
    if(!lines[0])return false;
    const value=JSON.parse(lines[0]) as {parent:number;child:number};
    firstMain=value.parent;
    oldChild=value.child;
    const state=await unitProps(unit);
    firstGroup=state.ControlGroup??'';
    return state.ActiveState==='active'&&await alive(firstMain)
      &&await alive(oldChild);
  },'first process tree');
  const oldCgroup=(await readFile('/proc/'+oldChild+'/cgroup','utf8')).trim();
  assert.ok(oldCgroup.endsWith(firstGroup),
    'New process session must remain in systemd service cgroup');
  const childStat=(await readFile('/proc/'+oldChild+'/stat','utf8'))
    .split(') ')[1].trim().split(/\s+/);
  assert.equal(Number(childStat[2]),oldChild,'Fixture should lead a separate process group');
  process.kill(firstMain,'SIGKILL');
  await waitFor(async()=>{
    const next=await unitProps(unit);
    const lines=(await readFile(marker,'utf8').catch(()=>'')).trim().split('\n');
    return Number(next.MainPID)>0&&Number(next.MainPID)!==firstMain
      &&next.ActiveState==='active'&&lines.length>=2;
  },'replacement after old process tree is removed');
  await waitFor(async()=>!(await alive(oldChild)),
    'cleanup of escaped process-group descendant',5000);
  assert.equal(await alive(oldChild),false);
});

test('systemd limits repeated failed starts instead of restarting forever',{
  skip:process.platform!=='linux',timeout:16000
},async t=>{
  if(!(await systemdAvailable())){t.skip('systemd user manager unavailable');return;}
  const unit=unitName('loop');
  t.after(()=>cleanupUnit(unit));
  await exec('systemd-run',[
    '--user','--no-block','--unit='+unit,
    '--property=Type=exec',
    '--property=Restart=on-failure',
    '--property=RestartSec=100ms',
    '--property=StartLimitIntervalSec=10s',
    '--property=StartLimitBurst=3',
    '--property=KillMode=control-group',
    process.execPath,'-e','process.exit(1)'
  ],{timeout:10000});
  await waitFor(async()=>{
    const state=await unitProps(unit);
    return state.ActiveState==='failed'&&Number(state.NRestarts)>=1;
  },'service stops after bounded failed restarts',9000);
  const state=await unitProps(unit);
  const restarts=Number(state.NRestarts);
  assert.ok(restarts>=1&&restarts<=3,
    'Restart attempts exceed the configured burst limit: '+restarts);
  await pause(550);
  const later=await unitProps(unit);
  assert.equal(later.ActiveState,'failed');
  assert.equal(Number(later.NRestarts),restarts,'Failed unit restarted again');
});
