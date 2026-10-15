import {execFile} from 'node:child_process';
import {lstat,readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {promisify} from 'node:util';

/** Only installer-owned units opt the CLI and Control Center into systemd. */
// Keep this name identical to scripts/systemd-user-service.mjs (tested).
export const USER_SERVICE_UNIT='easy-local-mcp-1591e5a7.service';
export const USER_SERVICE_HEADER='# Managed by Easy Local MCP rootless systemd installer';
const LEGACY_USER_SERVICE_UNIT='easy-local-mcp.service';
const exec=promisify(execFile);

export interface UserServiceState{
  mode:'systemd-user';
  unit:string;
  active:boolean;
  mainPid:number|null;
  state:string;
}

export async function hasManagedUserService():Promise<boolean>{
  if(process.platform!=='linux')return false;
  // Never allow a previous untagged supervised installation to be silently
  // overlooked while this build starts an unmanaged replacement.
  const legacy=resolve(homedir(),'.config/systemd/user',LEGACY_USER_SERVICE_UNIT);
  try{
    await lstat(legacy);
    throw new Error(
      'An older Easy Local MCP systemd user unit exists at '+legacy
      +'. Stop/uninstall the previous unit before using the tagged version.'
    );
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
  const path=resolve(homedir(),'.config/systemd/user',USER_SERVICE_UNIT);
  let content:string;
  try{
    content=await readFile(path,'utf8');
  }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return false;
    throw error;
  }
  if(!content.startsWith(USER_SERVICE_HEADER+'\n')){
    throw new Error(
      'A systemd unit already exists at '+path
      +', but it was not installed by Easy Local MCP. '
      +'Refusing to spawn a competing standalone Agent. Review the unit manually.'
    );
  }
  return true;
}

/** Enforce the standalone/managed boundary at BOTH Agent entry and
 * final control-socket initialization under the startup ownership mutex.
 * Installer and Agent must make their final decision under that same mutex.
 */
export async function assertAgentStartupAllowed(
  env:NodeJS.ProcessEnv=process.env
):Promise<void>{
  if(await hasManagedUserService()&&(
    env.LOCALMCP_SYSTEMD_MANAGED!=='1'||!env.NOTIFY_SOCKET
  )){
    throw new Error(
      'Easy Local MCP is installed as a systemd user service. '
      +'Use systemctl --user start '+USER_SERVICE_UNIT
      +' (or the normal CLI/Control Center), not a direct Agent launch.'
    );
  }
}

async function systemctl(args:string[],timeout=45000):Promise<string>{
  try{
    const {stdout}=await exec('systemctl',['--user',...args],{
      timeout,maxBuffer:128*1024
    });
    return stdout;
  }catch(error){
    const e=error as Error&{stderr?:string};
    throw new Error(
      'Managed Easy Local MCP systemd operation failed: '
      +(e.stderr?.trim()||e.message)
      +'. Check systemctl --user status '+USER_SERVICE_UNIT
    );
  }
}

export async function managedUserServiceState():Promise<UserServiceState|null>{
  if(!(await hasManagedUserService()))return null;
  const output=await systemctl([
    'show',USER_SERVICE_UNIT,
    '--property=LoadState,ActiveState,SubState,MainPID'
  ],7000);
  const data=Object.fromEntries(output.trim().split('\n').map(line=>{
    const at=line.indexOf('=');
    return [line.slice(0,at),line.slice(at+1)];
  }));
  if(data.LoadState!=='loaded'){
    throw new Error('Easy Local MCP user service is installed but not loaded ('
      +(data.LoadState||'unknown')+'). Run systemctl --user daemon-reload.');
  }
  const mainPid=Number(data.MainPID);
  return {
    mode:'systemd-user',unit:USER_SERVICE_UNIT,
    active:data.ActiveState==='active'||data.ActiveState==='activating'
      ||data.ActiveState==='reloading'||data.ActiveState==='deactivating',
    mainPid:Number.isSafeInteger(mainPid)&&mainPid>0?mainPid:null,
    state:data.ActiveState??'unknown'
  };
}

export function assertManagedOwner(
  service:UserServiceState,
  agent:{status:'running'|'stopped';pid:number|null}
){
  if(agent.status!=='running')return;
  if(!service.active||service.mainPid!==agent.pid){
    throw new Error(
      'A standalone or unexpected Agent is running while Easy Local MCP '
      +'is configured for systemd. Refusing an unsafe lifecycle change. '
      +'Stop the unexpected Agent using its original launcher, or uninstall '
      +'the managed unit before using standalone CLI stop. '
      +'Then re-enable the systemd user service.'
    );
  }
}

export async function commandUserService(
  command:'start'|'stop'|'restart'
):Promise<void>{
  await systemctl([command,USER_SERVICE_UNIT]);
}
