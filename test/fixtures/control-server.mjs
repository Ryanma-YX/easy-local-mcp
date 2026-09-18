import {mkdir} from 'node:fs/promises';
import {stateDir,logFile,serveControl} from '../../dist/lifecycle.js';

await mkdir(stateDir,{recursive:true});

let reloads=0;
let rotations=0;
let reregistrations=0;
let locked=true;
let unlockExpiresAt=null;
let workerUrl='https://example.test/';
let fullUrl='https://example.test/mcp/device/'+'a'.repeat(64);

let close;
close=await serveControl(
  ()=>({
    status:'running',
    pid:process.pid,
    url:fullUrl,
    config:`reloads:${reloads};rotations:${rotations};reregistrations:${reregistrations}`,
    log:logFile,
    ready:true,
    locked,
    unlockExpiresAt,
    workerUrl,
    deviceId:'fixture-device',
    workerManagedByEnv:false
  }),
  {
    stop:()=>{
      void close().then(()=>process.exit(0));
    },
    reload:async()=>{
      reloads++;
    },
    unlock:async minutes=>{
      locked=false;
      unlockExpiresAt=new Date(Date.now()+(minutes??30)*60_000).toISOString();
    },
    lock:async()=>{
      locked=true;
      unlockExpiresAt=null;
    },
    rotate:async()=>{
      rotations++;
    },
    reregister:async value=>{
      const origin=new URL(value);
      workerUrl=origin.origin+'/';
      fullUrl=new URL('/mcp/device/'+'a'.repeat(64),workerUrl).href;
      reregistrations++;
    }
  }
);

process.send?.('ready');
