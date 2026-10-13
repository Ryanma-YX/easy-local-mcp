import {createHash} from 'node:crypto';
import {lstat, realpath, unlink} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {createConnection, createServer, type Server} from 'node:net';

const pause=(ms:number)=>new Promise(done=>setTimeout(done,ms));

function isMissing(error:unknown){
  return (error as NodeJS.ErrnoException).code==='ENOENT';
}

/** Kernel-owned startup mutex: no stale filesystem lock or PID reuse. */
async function withStartupLock<T>(socketFile:string,action:()=>Promise<T>):Promise<T>{
  // Different path aliases can refer to the same Unix socket. Resolve only
  // its parent: the socket itself might not exist yet (or might be orphaned).
  const canonicalPath=join(await realpath(dirname(socketFile)),basename(socketFile));
  const hash=createHash('sha256').update(canonicalPath).digest('hex');
  // Linux abstract socket names are removed automatically on process death.
  // macOS uses a deterministic loopback port and fails closed on collision.
  const abstractAddress='\0localmcp-startup-'+hash;
  const port=30000+(Number.parseInt(hash.slice(0,8),16)%30000);
  const deadline=Date.now()+10000;
  // The mutex accepts no client protocol. Immediately close any unexpected
  // connection so lock.close() cannot be held indefinitely by a local client.
  const lock=createServer(socket=>socket.destroy());
  while(true){
    try{
      await new Promise<void>((resolve,reject)=>{
        const error=(err:Error)=>{lock.off('listening',ready);reject(err);};
        const ready=()=>{lock.off('error',error);resolve();};
        lock.once('error',error);
        lock.once('listening',ready);
        if(process.platform==='linux')lock.listen(abstractAddress);
        else lock.listen(port,'127.0.0.1');
      });
      break;
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='EADDRINUSE')throw error;
      if(Date.now()>deadline){
        const detail=process.platform==='linux'
          ? 'another startup process holds the Unix mutex'
          : 'loopback TCP port '+port+' is occupied (possibly by another application)';
        throw new Error('Agent control socket startup is locked: '+socketFile+'; '+detail);
      }
      await pause(50);
    }
  }
  try{return await action();}
  finally{await new Promise<void>((resolve,reject)=>{
    lock.close(error=>error?reject(error):resolve());
  });}
}
async function hasListener(socketFile:string):Promise<boolean>{
  return await new Promise<boolean>((resolve,reject)=>{
    const socket=createConnection(socketFile);
    let settled=false;
    const timer=setTimeout(()=>{
      if(settled)return;
      settled=true;
      socket.destroy();
      reject(new Error('Timed out probing control socket; refusing to remove it'));
    },3000);

    const finish=(error?:Error,alive?:boolean)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      socket.destroy();
      if(error)reject(error);
      else resolve(Boolean(alive));
    };

    socket.once('connect',()=>finish(undefined,true));
    socket.once('error',(error:NodeJS.ErrnoException)=>{
      if(error.code==='ECONNREFUSED'||error.code==='ENOENT'){
        finish(undefined,false);
      }else{
        finish(error);
      }
    });
  });
}

async function listen(server:Server,address:string,onBound?:()=>Promise<void>){
  await new Promise<void>((resolve,reject)=>{
    const onError=(error:Error)=>{
      server.off('listening',onListening);
      reject(error);
    };
    const onListening=()=>{
      server.off('error',onError);
      resolve();
    };
    server.once('error',onError);
    server.once('listening',onListening);
    server.listen(address);
  });
  // Keep the mutex held while the newly bound owner completes initialization.
  // On failure, release our socket before another contender can acquire it.
  try{
    await onBound?.();
  }catch(error){
    await new Promise<void>((resolve,reject)=>{
      server.close(closeError=>closeError?reject(closeError):resolve());
    });
    throw error;
  }
}

/**
 * Remove an orphaned Unix control socket, but never unlink an endpoint with a
 * reachable listener. Windows named pipes require no filesystem recovery.
 */
export async function listenWithSocketRecovery(
  server:Server,address:string,socketFile?:string,
  onBound?:()=>Promise<void>
):Promise<void>{
  if(!socketFile){
    await listen(server,address,onBound);
    return;
  }

  await withStartupLock(socketFile,async()=>{
    let entry:Awaited<ReturnType<typeof lstat>>|undefined;
    try{
      entry=await lstat(socketFile);
    }catch(error){
      if(!isMissing(error))throw error;
    }

    if(entry){
      if(!entry.isSocket()){
        throw new Error(`Control socket path is not a socket: ${socketFile}`);
      }

      if(await hasListener(socketFile)){
        throw new Error(`Another agent is already listening on ${socketFile}`);
      }

      await unlink(socketFile);
    }

    await listen(server,address,onBound);
  });
}
