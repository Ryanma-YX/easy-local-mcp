import { spawn } from 'node:child_process';

type CommandResult={
  exitCode:number|null;
  signal:string|null;
  output:string;
  timedOut:boolean;
  truncated:boolean;
};

/** Execute one command, including cancellation of its Unix process group. */
export function runCommand(
  command:string,cwd:string,timeoutMs:number,signal?:AbortSignal
):Promise<CommandResult>{
  if(signal?.aborted)return Promise.reject(new Error('Command cancelled'));

  return new Promise((resolve,reject)=>{
    // Deliberately do not pass the server's credentials to commands.
    const env:NodeJS.ProcessEnv={};
    for(const key of ['PATH','HOME','USER','TMPDIR','LANG','SHELL','SystemRoot']){
      if(process.env[key])env[key]=process.env[key];
    }
    const child=spawn(command,{
      cwd,shell:true,detached:process.platform!=='win32',env,
      stdio:['ignore','pipe','pipe'],windowsHide:process.platform==='win32'
    });
    let output=Buffer.alloc(0),timedOut=false,truncated=false;
    const stop=()=>{
      try{
        if(process.platform!=='win32'&&child.pid){
          process.kill(-child.pid,'SIGKILL');
        }else child.kill('SIGKILL');
      }catch{}
    };
    const onAbort=()=>stop();
    const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
    signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted)stop();
    const collect=(chunk:Buffer)=>{
      const remaining=256*1024-output.length;
      if(chunk.length>remaining)truncated=true;
      output=Buffer.concat([output,chunk.subarray(0,Math.max(0,remaining))]);
    };
    child.stdout.on('data',collect);
    child.stderr.on('data',collect);
    const clean=()=>{
      clearTimeout(timer);
      signal?.removeEventListener('abort',onAbort);
    };
    child.on('error',error=>{clean();reject(error);});
    child.on('close',(exitCode,exitSignal)=>{
      clean();
      stop();
      resolve({
        exitCode,signal:exitSignal,output:output.toString('utf8'),
        timedOut,truncated
      });
    });
  });
}

/**
 * Owns in-flight run_command executions for an HTTP/stdio server.
 * Closing cancels first, then waits; starting new work after close is denied.
 */
export class CommandRunner{
  private closing=false;
  private active=new Map<Promise<CommandResult>,AbortController>();
  private cleanup?:Promise<void>;

  run(command:string,cwd:string,timeoutMs:number):Promise<CommandResult>{
    if(this.closing)return Promise.reject(new Error('Command runner is shutting down'));
    const controller=new AbortController();
    const result=runCommand(command,cwd,timeoutMs,controller.signal);
    this.active.set(result,controller);
    void result.then(
      ()=>this.active.delete(result),
      ()=>this.active.delete(result)
    );
    return result;
  }

  close():Promise<void>{
    if(this.cleanup)return this.cleanup;
    this.closing=true;
    const active=[...this.active];
    for(const [,controller] of active)controller.abort();
    this.cleanup=Promise.allSettled(active.map(([result])=>result)).then(()=>{});
    return this.cleanup;
  }
}
