import {mkdir} from 'node:fs/promises';
import {stateDir,logFile,serveControl} from '../../dist/lifecycle.js';
import {getUnlockStatus,resetUnlockOnAgentStart} from '../../dist/security.js';

await mkdir(stateDir,{recursive:true,mode:0o700});
let close;
close=await serveControl(
  async()=>{
    const unlock=await getUnlockStatus(false);
    return {
      status:'running',pid:process.pid,url:null,config:'',log:logFile,
      ready:true,locked:unlock.locked,unlockExpiresAt:unlock.expiresAt,
      unlockHardExpiresAt:unlock.hardExpiresAt,
      unlockSource:unlock.source,unlockLastActivityAt:unlock.lastActivityAt,
      alwaysUnlocked:false,workerUrl:null,deviceId:null,zoneId:null,
      workerManagedByEnv:false
    };
  },
  {
    stop:()=>{void close().then(()=>process.exit(0));},
    reload:async()=>{},unlock:async()=>{},lock:async()=>{},
    rotate:async()=>{},reregister:async()=>{}
  },
  async()=>{
    process.send?.('bound-before-init');
    if(process.env.TEST_GATE_STARTUP==='1'){
      await new Promise(resolve=>{
        process.on('message',message=>{
          if(message==='continue')resolve();
        });
      });
    }
    if(process.env.TEST_FAIL_STARTUP==='1'){
      throw new Error('Injected startup initialization failure');
    }
    await resetUnlockOnAgentStart();
  }
);
process.send?.('ready');
