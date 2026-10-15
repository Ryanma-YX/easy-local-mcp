import {spawn} from 'node:child_process';
import {appendFile} from 'node:fs/promises';
const marker=process.env.LOCALMCP_SMOKE_MARKER;
if(!marker)throw new Error('Missing disposable marker');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
await appendFile(marker,JSON.stringify({parent:process.pid,child:child.pid})+'\n');
if(process.env.LOCALMCP_SMOKE_EXIT==='1')process.exit(0);
setInterval(()=>{},1000);
