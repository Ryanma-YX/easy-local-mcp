import {mkdir} from 'node:fs/promises';
import {stateDir,serveControl} from '../../dist/lifecycle.js';
import {assertAgentStartupAllowed} from '../../dist/systemd-service.js';

// Models the two actual Agent entry/ownership gates while exposing an IPC
// pause after its early check; no production debug switches are necessary.
await assertAgentStartupAllowed();
await mkdir(stateDir,{recursive:true,mode:0o700});
process.send?.('early-check-passed');

await new Promise(resolve=>{
  process.on('message',message=>{
    if(message==='continue')resolve();
  });
});

let closeControl;
closeControl=await serveControl(
  ()=>({
    status:'running',pid:process.pid,url:null,config:'',log:'',
    ready:true,locked:true,unlockExpiresAt:null,unlockHardExpiresAt:null,
    unlockSource:null,unlockLastActivityAt:null,alwaysUnlocked:false,
    workerUrl:null,deviceId:null,zoneId:null,workerManagedByEnv:false
  }),
  {
    stop:()=>{
      void closeControl().then(()=>process.exit(0));
    },
    reload:async()=>{},
    unlock:async()=>{},
    lock:async()=>{},
    rotate:async()=>{},
    reregister:async()=>{}
  },
  async()=>{
    // Identical guard invoked by src/agent.ts inside serveControl's onBound,
    // while listenWithSocketRecovery holds the Agent startup mutex.
    await assertAgentStartupAllowed();
    if(process.env.TEST_HOLD_BOUND==='1'){
      process.send?.('bound-under-startup-lock');
      await new Promise(resolve=>{
        process.on('message',message=>{
          if(message==='release-bound')resolve();
        });
      });
    }
  }
);

process.send?.('ready');
