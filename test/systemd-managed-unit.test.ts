import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess,execFile} from 'node:child_process';
import {createServer} from 'node:net';
import {readFile,mkdir,mkdtemp,rm,writeFile,chmod,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {renderUserService,UNIT_NAME} from '../scripts/systemd-user-service.mjs';

const exec=promisify(execFile);
async function unusedPort(){
  const server=createServer();
  await new Promise<void>((done,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',done);
  });
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  await new Promise<void>(done=>server.close(()=>done()));
  return address.port;
}

function cli(args:string[],env:NodeJS.ProcessEnv,timeout=16000){
  return new Promise<{code:number|null;out:string}>(done=>{
    const proc=spawn(process.execPath,args,{cwd:resolve('.'),env,
      stdio:['ignore','pipe','pipe']});
    let out='',finished=false;
    proc.stdout?.on('data',(b:Buffer)=>out+=b.toString());
    proc.stderr?.on('data',(b:Buffer)=>out+=b.toString());
    const timer=setTimeout(()=>{
      if(finished)return;finished=true;
      proc.kill('SIGKILL');done({code:null,out:'TIMEOUT '+out});
    },timeout);
    proc.once('exit',code=>{
      if(finished)return;finished=true;clearTimeout(timer);done({code,out});
    });
    proc.once('error',err=>{
      if(finished)return;finished=true;clearTimeout(timer);
      done({code:null,out:String(err)});
    });
  });
}
async function unitState(unit:string){
  const {stdout}=await exec('systemctl',['--user','show',unit,
    '-p','MainPID','-p','ActiveState','-p','LoadState'],{timeout:6000});
  return Object.fromEntries(stdout.trim().split('\n').map(line=>{
    const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];
  }));
}
async function launchUi(env:NodeJS.ProcessEnv){
  const proc=spawn(process.execPath,[resolve('dist/index.js'),'ui','--no-open'],{
    cwd:resolve('.'),env,stdio:['ignore','pipe','pipe']
  });
  const url=await new Promise<string>((done,fail)=>{
    let out='';
    const timer=setTimeout(()=>{
      proc.kill('SIGKILL');fail(new Error('UI startup timed out: '+out));
    },8500);
    proc.stdout?.on('data',(b:Buffer)=>{
      out+=b.toString();
      const match=/Easy Local MCP control UI: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if(match){clearTimeout(timer);done(match[1]);}
    });
    proc.stderr?.on('data',(b:Buffer)=>out+=b.toString());
    proc.once('exit',code=>{
      clearTimeout(timer);fail(new Error('UI exited '+code+': '+out));
    });
    proc.once('error',fail);
  });
  return {proc,url};
}

test('real user unit keeps CLI start/stop/restart and Control Center supervised',{
  skip:process.platform!=='linux',timeout:75000
},async t=>{
  try{
    await exec('systemctl',['--user','show-environment'],{timeout:5000});
  }catch{t.skip('No user systemd manager');return;}
  const home=await mkdtemp(join(tmpdir(),'localmcp-v10-service-'));
  const unit='localmcp-v10-unit-'+process.pid+'-'+Date.now()+'.service';
  const runtimeLink=join('/run/user',String(process.getuid?.()??0),
    'systemd','user',unit);
  const bin=join(home,'bin');
  const ownServiceDir=join(home,'.config','systemd','user');
  const state=join(home,'.localmcp');
  const managedFile=join(home,unit);
  const uiChildren:ChildProcess[]=[];
  await mkdir(bin,{recursive:true,mode:0o700});
  await mkdir(ownServiceDir,{recursive:true,mode:0o700});
  await mkdir(state,{recursive:true,mode:0o700});
  t.after(async()=>{
    for(const proc of uiChildren){
      if(proc.exitCode===null&&proc.signalCode===null)proc.kill('SIGKILL');
    }
    await exec('systemctl',['--user','stop',unit],{timeout:12000}).catch(()=>{});
    await unlink(runtimeLink).catch(()=>{});
    await exec('systemctl',['--user','daemon-reload'],{timeout:6000}).catch(()=>{});
    await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });

  const port=await unusedPort();
  await writeFile(join(state,'localmcp.json'),JSON.stringify({
    workspaces:{fixture:home},defaultWorkspace:'fixture',
    features:{shell:false,processes:false,externalMcp:false}
  }));
  await writeFile(join(state,'worker.json'),JSON.stringify({
    workerUrl:'http://127.0.0.1:9/',
    agentToken:'a'.repeat(64),mcpToken:'b'.repeat(64),
    deviceId:'v10-systemd-managed'
  }),{mode:0o600});

  const rawUnit=renderUserService({
    nodePath:process.execPath,
    entryPath:resolve('dist/index.js'),
    workingDirectory:resolve('.')
  });
  const text=rawUnit.replace('Environment=LOCALMCP_SYSTEMD_MANAGED=1',
    ['Environment=LOCALMCP_SYSTEMD_MANAGED=1',
    'Environment=HOME='+home,
    'Environment=USERPROFILE='+home,
    'Environment=LOCALMCP_WORKER_URL=http://127.0.0.1:9/',
    'Environment=LOCALMCP_AGENT_PORT='+port].join('\n'));
  await writeFile(managedFile,text);
  await exec('systemctl',['--user','link','--runtime',managedFile],{timeout:7000});
  await exec('systemctl',['--user','daemon-reload'],{timeout:7000});
  await writeFile(join(ownServiceDir,UNIT_NAME),rawUnit);
  const shim=join(bin,'systemctl');
  await writeFile(shim,`#!/bin/sh
[ "$1" = "--user" ] || exit 97
shift
verb="$1"
shift
case "$verb" in
  show)
    [ "$1" = "${UNIT_NAME}" ] || exit 96
    shift
    exec /usr/bin/systemctl --user show "$LOCALMCP_TEST_UNIT" "$@"
    ;;
  start|stop|restart)
    [ "$1" = "${UNIT_NAME}" ] || exit 95
    exec /usr/bin/systemctl --user "$verb" "$LOCALMCP_TEST_UNIT"
    ;;
esac
exit 94
`);
  await chmod(shim,0o700);
  const env:NodeJS.ProcessEnv={
    ...process.env,HOME:home,USERPROFILE:home,
    LOCALMCP_WORKER_URL:'http://127.0.0.1:9/',
    LOCALMCP_AGENT_PORT:String(port),
    LOCALMCP_TEST_UNIT:unit,
    PATH:bin+':'+(process.env.PATH??'/usr/bin:/bin')
  };
  for(const name of ['NOTIFY_SOCKET','LOCALMCP_SYSTEMD_MANAGED','WATCHDOG_USEC']){
    delete env[name];
  }

  assert.equal((await unitState(unit)).ActiveState,'inactive');
  const started=await cli([resolve('dist/index.js'),'start'],env);
  assert.equal(started.code,0,started.out);
  assert.match(started.out,/Supervision: systemd user service/);
  const first=await unitState(unit);
  assert.equal(first.ActiveState,'active');
  const firstPid=Number(first.MainPID);
  assert.ok(firstPid>0);
  const inGroup=(await readFile('/proc/'+firstPid+'/cgroup','utf8')).trim();
  assert.ok(inGroup.includes(unit.slice(0,-8)));

  const stopped=await cli([resolve('dist/index.js'),'stop'],env);
  assert.equal(stopped.code,0,stopped.out);
  assert.equal((await unitState(unit)).ActiveState,'inactive');
  const again=await cli([resolve('dist/index.js'),'start'],env);
  assert.equal(again.code,0,again.out);
  const second=await unitState(unit);
  assert.equal(second.ActiveState,'active');
  assert.notEqual(Number(second.MainPID),firstPid);

  const {proc,url}=await launchUi(env);
  uiChildren.push(proc);
  const origin=new URL(url).origin;
  const session=await fetch(url+'api/session',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:'{}'
  });
  assert.equal(session.status,200);
  const cookie=session.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  async function api(action:string,body:Record<string,unknown>={}){
    const result=await fetch(url+'api/'+action,{
      method:'POST',headers:{
        Origin:origin,Cookie:cookie,'Content-Type':'application/json'
      },body:JSON.stringify(body)
    });
    const value=await result.json();
    assert.equal(result.status,200,JSON.stringify(value));
    return value as {
      agent:{pid:number|null;supervision?:{
        mode:string;verifiedOwner?:boolean;active?:boolean
      }}
    };
  }

  const snapshot=await api('status');
  assert.equal(snapshot.agent.supervision?.mode,'systemd-user');
  assert.equal(snapshot.agent.supervision?.verifiedOwner,true);
  const newStatus=await api('agent/restart',{confirm:true});
  assert.equal(newStatus.agent.supervision?.verifiedOwner,true);
  const third=await unitState(unit);
  assert.equal(third.ActiveState,'active');
  assert.notEqual(third.MainPID,second.MainPID);

  await api('agent/stop',{confirm:true});
  assert.equal((await unitState(unit)).ActiveState,'inactive');
  const uiStart=await api('agent/start');
  assert.equal(uiStart.agent.supervision?.verifiedOwner,true);
  assert.equal((await unitState(unit)).ActiveState,'active');
});
