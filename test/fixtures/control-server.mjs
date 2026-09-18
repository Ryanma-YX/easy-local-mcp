import {mkdir} from 'node:fs/promises';
import {stateDir,logFile,serveControl} from '../../dist/lifecycle.js';

await mkdir(stateDir,{recursive:true});

let reloads=0;
let rotations=0;
let locked=true;
let unlockExpiresAt=null;
const fullUrl='https://example.test/mcp/device/'+'a'.repeat(64);

let close;
close=await serveControl(
  ()=>({
    status:'running',
    pid:process.pid,
    url:fullUrl,
    config:`reloads:${reloads};rotations:${rotations}`,
    log:logFile,
    ready:true,
    locked,
    unlockExpiresAt
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
    }
  }
);

process.send?.('ready');
