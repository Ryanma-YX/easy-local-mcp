import test from 'node:test';
import assert from 'node:assert/strict';
import {renderUserService,UNIT_NAME} from '../scripts/systemd-user-service.mjs';
import {startSystemdSupervision} from '../src/systemd-supervision.js';

const pause=(ms:number)=>new Promise(ok=>setTimeout(ok,ms));

test('rootless systemd unit uses cgroup cleanup, health notification, and restart limits',()=>{
  const unit=renderUserService({
    nodePath:'/tmp/custom node/bin/node',
    entryPath:'/tmp/project/dist/index.js',
    workingDirectory:'/tmp/project with spaces'
  });
  for(const setting of [
    'KillMode=control-group','Type=notify','NotifyAccess=all',
    'Restart=on-failure','StartLimitBurst=4','WatchdogSec=25s',
    'NoNewPrivileges=yes','Environment=LOCALMCP_SYSTEMD_MANAGED=1'
  ])assert.ok(unit.includes(setting),setting);
  assert.match(unit,/ExecStart="\/tmp\/custom node\/bin\/node"/);
  assert.match(unit,/WorkingDirectory=\/tmp\/project with spaces/);
});

test('a healthy HTTP probe is required for systemd watchdog credits',{
  timeout:6000
},async()=>{
  const calls:string[][]=[];
  let healthy=true,reason='';
  const stop=await startSystemdSupervision({
    port:1234,env:{NOTIFY_SOCKET:'/dummy',WATCHDOG_USEC:'900000',LOCALMCP_SYSTEMD_MANAGED:'1'},
    checkHealth:async()=>healthy,
    notify:async(...args)=>{calls.push(args);},
    onUnhealthy:why=>{reason=why;}
  });
  try{
    assert.ok(calls[0].includes('--ready'));
    for(let i=0;i<15&&!calls.some(a=>a.includes('WATCHDOG=1'));i++){
      await pause(80);
    }
    assert.ok(calls.some(a=>a.includes('WATCHDOG=1')));
    healthy=false;
    const count=calls.filter(a=>a.includes('WATCHDOG=1')).length;
    for(let i=0;i<25&&!reason;i++)await pause(80);
    assert.equal(reason,'local_http_unresponsive');
    assert.equal(calls.filter(a=>a.includes('WATCHDOG=1')).length,count);
  }finally{stop();}
});

test('without systemd, the Agent never requires a notification helper',async()=>{
  let called=false;
  const stop=await startSystemdSupervision({
    port:0,env:{},checkHealth:async()=>false,
    notify:async()=>{called=true;},
    onUnhealthy:()=>assert.fail('Unexpected supervision')
  });
  stop();
  assert.equal(called,false);
});

test('generated service unit passes the real systemd unit-file validator',{
  skip:process.platform!=='linux',timeout:7000
},async t=>{
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {execFile}=await import('node:child_process');
  const {promisify}=await import('node:util');
  const run=promisify(execFile);
  const temp=await mkdtemp(join(tmpdir(),'localmcp-v9-unitverify-'));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const unitFile=join(temp,UNIT_NAME);
  await writeFile(unitFile,renderUserService());
  try{
    await run('systemd-analyze',['--user','verify',unitFile],{timeout:6000});
  }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT'){
      t.skip('systemd-analyze unavailable');
      return;
    }
    throw error;
  }
});

test('arbitrary NOTIFY_SOCKET does not activate unmanaged Agent supervision',async()=>{
  let called=false;
  const stop=await startSystemdSupervision({
    port:1,
    env:{NOTIFY_SOCKET:'/not-our-systemd-service',WATCHDOG_USEC:'900000'},
    checkHealth:async()=>false,
    notify:async()=>{called=true;},
    onUnhealthy:()=>assert.fail('An unmanaged Agent must never report ready')
  });
  stop();
  assert.equal(called,false);
});
