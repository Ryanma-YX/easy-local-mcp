import {readFileSync} from 'node:fs';
import {
  StdioClientTransport,
  type StdioServerParameters
} from '@modelcontextprotocol/sdk/client/stdio.js';

interface ProcessIdentity{
  pgid:number;
  sid:number;
  startTicks:string;
}

function linuxProcess(pid:number):ProcessIdentity|null{
  try{
    const stat=readFileSync('/proc/'+pid+'/stat','utf8');
    const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
    return {
      pgid:Number(fields[2]),
      sid:Number(fields[3]),
      startTicks:fields[19]
    };
  }catch{return null;}
}

/**
 * On Linux, start the external MCP launcher in a verified private process
 * group. The SDK normally owns only its direct child; a launcher may leave
 * active descendants behind after it exits.
 *
 * util-linux's setsid execs the requested command in the SDK-spawned process.
 * The SDK child cannot initially lead its inherited group, so setsid does
 * not need to fork. No shell is involved and all configured arguments remain
 * distinct.
 */
export class OwnedStdioClientTransport extends StdioClientTransport{
  private ownedGroup:{pid:number;startTicks:string}|undefined;

  constructor(params:StdioServerParameters){
    super(process.platform==='linux'
      ? {...params,command:'setsid',args:['--',params.command,...(params.args??[])]}
      : params);
  }

  override async start(){
    try{
      await super.start();
    }catch(error){
      if(process.platform==='linux'
        &&(error as NodeJS.ErrnoException).code==='ENOENT'){
        throw new Error(
          'Linux external MCP process ownership requires setsid (util-linux)',
          {cause:error}
        );
      }
      throw error;
    }
    if(process.platform!=='linux')return;
    const pid=this.pid;
    if(!pid)return;

    // Node's 'spawn' event can precede setsid() in the new process.
    // Verify the kernel process-group/session identity before trusting -pid.
    const deadline=Date.now()+400;
    while(Date.now()<deadline){
      const identity=linuxProcess(pid);
      if(!identity)return; // The launch failed/exited; SDK connect will reject.
      if(identity.pgid===pid&&identity.sid===pid){
        this.ownedGroup={pid,startTicks:identity.startTicks};
        return;
      }
      await new Promise(done=>setTimeout(done,5));
    }
    throw new Error('External MCP launcher did not establish its Linux process group');
  }

  /**
   * Force-clean only a group positively established by this transport.
   * If the leader has exited, Linux retains its group ID while descendants
   * exist. If its PID has been reused, the start-tick check fails closed.
   */
  terminateOwned(){
    if(process.platform!=='linux'){
      const pid=this.pid;
      if(pid){try{process.kill(pid,'SIGKILL');}catch{}}
      return;
    }
    const group=this.ownedGroup;
    if(!group){
      // A shutdown during the few milliseconds before setsid verification
      // must at least retain V7's direct-child termination behavior.
      const pid=this.pid;
      if(pid){try{process.kill(pid,'SIGKILL');}catch{}}
      return;
    }
    const current=linuxProcess(group.pid);
    if(current&&(
      current.startTicks!==group.startTicks
      ||current.pgid!==group.pid
      ||current.sid!==group.pid
    ))return;
    try{process.kill(-group.pid,'SIGKILL');}catch{}
  }
}
