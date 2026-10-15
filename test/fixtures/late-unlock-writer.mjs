// Simulate a different OS process that read an old lease before owner Lock.
// The parent deliberately lets its atomic write finish AFTER Lock returns.
import {readFile} from 'node:fs/promises';
import {unlockFile,secureWriteFileAtomic} from '../../dist/security.js';
const old=await readFile(unlockFile,'utf8');
process.stdout.write('READY\n');
process.stdin.once('data',async()=>{
  try{
    await secureWriteFileAtomic(unlockFile,old);
    process.exitCode=0;
  }catch(e){
    process.stderr.write(String(e));
    process.exitCode=1;
  }
  process.stdin.pause();
});
