import { appendFile, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from './config.js';

const execFileAsync=promisify(execFile);

export const securityStateDir=resolve(homedir(),'.localmcp');
export const unlockFile=resolve(securityStateDir,'unlock.json');
export const auditFile=resolve(securityStateDir,'audit.log');
export const controlSecretFile=resolve(securityStateDir,'control.secret');

export interface UnlockStatus {
  locked:boolean;
  expiresAt:string|null;
}

async function restrictPath(path:string){
  try{await chmod(path,0o600);}catch{}
  if(process.platform!=='win32')return;

  const username=process.env.USERNAME;
  if(!username)return;

  const identity=process.env.USERDOMAIN
    ? `${process.env.USERDOMAIN}\\${username}`
    : username;

  try{
    await execFileAsync('icacls',[
      path,
      '/inheritance:r',
      '/grant:r',
      `${identity}:(F)`,
      '*S-1-5-18:(F)'
    ]);
  }catch(error){
    console.error(
      `Warning: unable to apply restrictive Windows ACL to ${path}: ${error instanceof Error?error.message:String(error)}`
    );
  }
}

export async function secureWriteFile(path:string,data:string){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  await writeFile(path,data,{mode:0o600});
  await restrictPath(path);
}

export async function getControlSecret():Promise<string>{
  const value=(await readFile(controlSecretFile,'utf8')).trim();
  if(!/^[a-f0-9]{64}$/.test(value))throw new Error('Invalid LocalMCP control secret');
  return value;
}

export async function ensureControlSecret():Promise<string>{
  try{
    return await getControlSecret();
  }catch(error:any){
    if(error?.code!=='ENOENT')throw error;
    const value=randomBytes(32).toString('hex');
    await secureWriteFile(controlSecretFile,value);
    return value;
  }
}

function safeAuditFields(fields:Record<string,unknown>){
  const safe:Record<string,unknown>={};

  for(const [key,value] of Object.entries(fields)){
    if(/token|secret|credential|url|content|stdout|stderr|command/i.test(key))continue;
    if(value===undefined)continue;
    safe[key]=value;
  }

  return safe;
}

export async function auditSecurity(event:string,fields:Record<string,unknown>={}){
  try{
    await mkdir(securityStateDir,{recursive:true,mode:0o700});

    const record={
      timestamp:new Date().toISOString(),
      event,
      ...safeAuditFields(fields)
    };

    await appendFile(auditFile,JSON.stringify(record)+'\n',{mode:0o600});
    await restrictPath(auditFile);
  }catch(error){
    console.error(
      `Warning: security audit write failed: ${error instanceof Error?error.message:String(error)}`
    );
  }
}

async function readUnlockUntil():Promise<number>{
  try{
    const parsed=JSON.parse(await readFile(unlockFile,'utf8')) as {until?:unknown};
    const until=typeof parsed.until==='number'?parsed.until:0;

    if(until>Date.now())return until;

    await rm(unlockFile,{force:true});
    if(until)await auditSecurity('unlock_expired');
    return 0;
  }catch(error:any){
    if(error?.code==='ENOENT')return 0;
    await rm(unlockFile,{force:true}).catch(()=>{});
    return 0;
  }
}

export async function getUnlockStatus():Promise<UnlockStatus>{
  const until=await readUnlockUntil();

  return {
    locked:until<=Date.now(),
    expiresAt:until>Date.now()?new Date(until).toISOString():null
  };
}

export async function isUnlocked(){
  return !(await getUnlockStatus()).locked;
}

export async function unlockLocal(minutes=30):Promise<UnlockStatus>{
  if(!Number.isInteger(minutes)||minutes<1||minutes>480){
    throw new Error('Unlock duration must be an integer from 1 to 480 minutes');
  }

  const until=Date.now()+minutes*60_000;

  await secureWriteFile(unlockFile,JSON.stringify({until}));
  await auditSecurity('unlock',{
    minutes,
    expiresAt:new Date(until).toISOString()
  });

  return {
    locked:false,
    expiresAt:new Date(until).toISOString()
  };
}

export async function lockLocal(reason='manual'):Promise<UnlockStatus>{
  await rm(unlockFile,{force:true});
  await auditSecurity('lock',{reason});

  return {
    locked:true,
    expiresAt:null
  };
}

export async function resetUnlockOnAgentStart(){
  await rm(unlockFile,{force:true});
}

const fileReadTools=new Set([
  'list_directory',
  'workspace_tree',
  'stat_path',
  'find_files',
  'search_files',
  'read_file',
  'read_file_lines'
]);

const fileWriteTools=new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'create_directory'
]);

const fileDeleteTools=new Set([
  'delete_path',
  'move_path'
]);

const shellTools=new Set([
  'run_command'
]);

const processTools=new Set([
  'start_process',
  'read_process',
  'write_process',
  'stop_process',
  'list_processes'
]);

const externalMcpReadTools=new Set([
  'list_mcp_servers'
]);

const externalMcpPrivilegedTools=new Set([
  'list_mcp_tools',
  'call_mcp_tool'
]);

const alwaysTools=new Set([
  'workspace_info',
  'list_workspaces',
  'list_skills',
  'read_skill'
]);

export function isPrivilegedTool(name:string){
  return fileWriteTools.has(name)
    || fileDeleteTools.has(name)
    || shellTools.has(name)
    || processTools.has(name)
    || externalMcpPrivilegedTools.has(name);
}

export function configuredForTool(config:Config,name:string){
  if(alwaysTools.has(name))return true;
  if(fileReadTools.has(name))return config.fileRead;
  if(fileWriteTools.has(name))return config.fileWrite;
  if(fileDeleteTools.has(name))return config.fileDelete;
  if(shellTools.has(name))return config.shell;
  if(processTools.has(name))return config.processes;
  if(externalMcpReadTools.has(name)||externalMcpPrivilegedTools.has(name))return config.externalMcp;
  return false;
}

export async function authorizeTool(
  config:Config,
  name:string
):Promise<{allowed:boolean;privileged:boolean;reason?:string}>{
  const privileged=isPrivilegedTool(name);

  if(!configuredForTool(config,name)){
    return {
      allowed:false,
      privileged,
      reason:'Capability is not enabled in LocalMCP configuration'
    };
  }

  if(privileged&&!(await isUnlocked())){
    return {
      allowed:false,
      privileged:true,
      reason:'LocalMCP is locked. Unlock locally before using privileged tools.'
    };
  }

  return {
    allowed:true,
    privileged
  };
}
