import {mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {withStartupLock} from '../../dist/socket-recovery.js';
const dir=resolve(homedir(),'.localmcp');
await mkdir(dir,{recursive:true,mode:0o700});
await withStartupLock(resolve(dir,'control.lock'),async()=>{
  process.send?.('held');
  await new Promise(resolveDone=>{
    process.on('message',message=>{
      if(message==='release')resolveDone();
    });
  });
},10000);
process.send?.('released');
