import {spawn} from 'node:child_process';

type Notification=(...fields:string[])=>Promise<void>;
type HealthCheck=()=>Promise<boolean>;

export interface SystemdSupervisionOptions{
  port:number;
  onUnhealthy:(reason:string)=>void;
  env?:NodeJS.ProcessEnv;
  notify?:Notification;
  checkHealth?:HealthCheck;
  log?:(message:string)=>void;
}

const STARTUP_HEALTH_TIMEOUT_MS=1500;

/** Send a datagram via the systemd-supplied helper; no native addon needed. */
export function notifySystemd(...fields:string[]):Promise<void>{
  return new Promise((resolve,reject)=>{
    const child=spawn('systemd-notify',fields,{stdio:'ignore',windowsHide:true});
    child.once('error',reject);
    child.once('exit',(code,signal)=>{
      if(code===0)resolve();
      else reject(new Error(
        'systemd-notify failed ('+(signal??'exit '+code)+')'
      ));
    });
  });
}

/** Public agent readiness means local HTTP is responsive, not Relay connected. */
export async function probeLocalHttpHealth(port:number):Promise<boolean>{
  try{
    const response=await fetch('http://127.0.0.1:'+port+'/healthz',{
      signal:AbortSignal.timeout(STARTUP_HEALTH_TIMEOUT_MS)
    });
    return response.status===200;
  }catch{return false;}
}

/**
 * A systemd watchdog is useful only if the Agent makes demonstrable progress:
 * notify after an actual HTTP probe, never from an unconditional timer.
 * If the JS event loop freezes, no notification is sent and systemd restarts
 * the entire service cgroup. No systemd involvement during direct execution.
 */
export async function startSystemdSupervision({
  port,onUnhealthy,env=process.env,notify=notifySystemd,
  checkHealth=()=>probeLocalHttpHealth(port),log=()=>{}
}:SystemdSupervisionOptions):Promise<()=>void>{
  if(process.platform!=='linux'||env.LOCALMCP_SYSTEMD_MANAGED!=='1'||!env.NOTIFY_SOCKET)return ()=>{};

  if(!(await checkHealth())){
    throw new Error('Cannot mark systemd service ready: HTTP child is unhealthy');
  }

  // Type=notify is started only after the local MCP listener is responsive.
  await notify('--ready','--status=Local MCP listener healthy');
  const watchdogUs=Number(env.WATCHDOG_USEC);
  if(!Number.isFinite(watchdogUs)||watchdogUs<=0)return ()=>{};

  const watchdogMs=watchdogUs/1000;
  const intervalMs=Math.max(250,Math.min(10_000,Math.floor(watchdogMs/3)));
  let closing=false;
  let busy=false;
  let misses=0;
  let failed=false;

  // Watchdog signal is sent only after a successful local HTTP round trip.
  const timer=setInterval(()=>{
    if(closing||busy||failed)return;
    busy=true;
    void (async()=>{
      // Convert probe exceptions to failed health observations. A one-off
      // network or probe error must not become an unhandled rejection.
      let healthy=false;
      try{healthy=await checkHealth();}catch{}
      if(closing)return;
      if(!healthy){
        misses++;
        log('Local MCP health probe failed '+misses+' consecutive time(s)');
        if(misses>=2){
          failed=true;
          onUnhealthy('local_http_unresponsive');
        }
        return;
      }
      misses=0;
      try{
        await notify('WATCHDOG=1','--status=Local MCP listener healthy');
      }catch(error){
        if(closing)return;
        failed=true;
        log('systemd watchdog notification failed: '+String(error));
        onUnhealthy('systemd_watchdog_notification_failed');
      }
    })().finally(()=>{busy=false;});
  },intervalMs);
  timer.unref();
  return ()=>{
    closing=true;
    clearInterval(timer);
  };
}
