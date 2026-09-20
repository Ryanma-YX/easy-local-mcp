import { appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

export type UnlockSource='local'|'remote'|'always';

export interface UnlockStatus {
  locked:boolean;
  expiresAt:string|null;
  hardExpiresAt:string|null;
  source:UnlockSource|null;
  lastActivityAt:string|null;
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

export async function secureWriteFileAtomic(path:string,data:string){
  const temporary=`${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;

  try{
    await secureWriteFile(temporary,data);
    await rename(temporary,path);
    await restrictPath(path);
  }finally{
    await rm(temporary,{force:true}).catch(()=>{});
  }
}

export async function getControlSecret():Promise<string>{
  const value=(await readFile(controlSecretFile,'utf8')).trim();
  if(!/^[a-f0-9]{64}$/.test(value))throw new Error('Invalid Easy Local MCP control secret');
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

interface UnlockLeaseFile {
  version?:number;
  source?:'local'|'remote';
  until?:number;
  hardUntil?:number;
  idleMinutes?:number;
  lastActivityAt?:number;
}

async function readUnlockLease():Promise<UnlockLeaseFile|null>{
  try{
    const parsed=JSON.parse(await readFile(unlockFile,'utf8')) as UnlockLeaseFile;
    const until=typeof parsed.until==='number'?parsed.until:0;
    const hardUntil=typeof parsed.hardUntil==='number'?parsed.hardUntil:until;
    const source=parsed.source==='remote'?'remote':'local';

    if(until>Date.now()&&hardUntil>Date.now()){
      return {
        version:2,
        source,
        until,
        hardUntil,
        idleMinutes:
          typeof parsed.idleMinutes==='number'
            ? parsed.idleMinutes
            : Math.max(1,Math.ceil((until-Date.now())/60_000)),
        lastActivityAt:
          typeof parsed.lastActivityAt==='number'
            ? parsed.lastActivityAt
            : undefined
      };
    }

    await rm(unlockFile,{force:true});
    if(until||hardUntil){
      await auditSecurity(
        source==='remote'?'remote_unlock_expired':'unlock_expired'
      );
    }
    return null;
  }catch(error:any){
    if(error?.code==='ENOENT')return null;
    await rm(unlockFile,{force:true}).catch(()=>{});
    return null;
  }
}

export async function getUnlockStatus(
  alwaysUnlocked=false
):Promise<UnlockStatus>{
  if(alwaysUnlocked){
    return {
      locked:false,
      expiresAt:null,
      hardExpiresAt:null,
      source:'always',
      lastActivityAt:null
    };
  }

  const lease=await readUnlockLease();
  if(!lease){
    return {
      locked:true,
      expiresAt:null,
      hardExpiresAt:null,
      source:null,
      lastActivityAt:null
    };
  }

  return {
    locked:false,
    expiresAt:new Date(lease.until!).toISOString(),
    hardExpiresAt:new Date(lease.hardUntil!).toISOString(),
    source:lease.source??'local',
    lastActivityAt:
      typeof lease.lastActivityAt==='number'
        ? new Date(lease.lastActivityAt).toISOString()
        : null
  };
}

export async function isUnlocked(alwaysUnlocked=false){
  return !(await getUnlockStatus(alwaysUnlocked)).locked;
}

export async function unlockLocal(
  minutes=30,
  options:{
    source?:'local'|'remote';
    maxSessionMinutes?:number;
  }={}
):Promise<UnlockStatus>{
  const source=options.source??'local';
  const maxAllowed=source==='remote'?60:480;

  if(!Number.isInteger(minutes)||minutes<1||minutes>maxAllowed){
    throw new Error(
      source==='remote'
        ? 'Remote unlock duration must be an integer from 1 to 60 minutes'
        : 'Unlock duration must be an integer from 1 to 480 minutes'
    );
  }

  const maxSessionMinutes=Math.max(
    minutes,
    Math.min(
      source==='remote'?60:480,
      Number.isInteger(options.maxSessionMinutes)
        ? options.maxSessionMinutes!
        : source==='remote'?60:240
    )
  );
  const now=Date.now();
  const until=now+minutes*60_000;
  const hardUntil=now+maxSessionMinutes*60_000;

  await secureWriteFile(
    unlockFile,
    JSON.stringify({
      version:2,
      source,
      until,
      hardUntil,
      idleMinutes:minutes,
      lastActivityAt:now
    })
  );

  await auditSecurity(
    source==='remote'?'remote_unlock':'unlock',
    {
      source,
      minutes,
      expiresAt:new Date(until).toISOString(),
      hardExpiresAt:new Date(hardUntil).toISOString()
    }
  );

  return getUnlockStatus(false);
}

export async function renewUnlockLease(
  config:Pick<
    Config,
    'alwaysUnlocked'
    |'renewUnlockOnPrivilegedUse'
    |'unlockIdleMinutes'
    |'unlockMaxSessionMinutes'
  >
):Promise<UnlockStatus>{
  if(config.alwaysUnlocked){
    return getUnlockStatus(true);
  }

  const lease=await readUnlockLease();
  if(!lease||!config.renewUnlockOnPrivilegedUse){
    return getUnlockStatus(false);
  }

  const now=Date.now();
  const idleMinutes=Math.max(
    1,
    Math.min(120,lease.idleMinutes??config.unlockIdleMinutes)
  );
  const hardUntil=lease.hardUntil??(
    now+config.unlockMaxSessionMinutes*60_000
  );
  const nextUntil=Math.min(now+idleMinutes*60_000,hardUntil);

  if(nextUntil<=now){
    await rm(unlockFile,{force:true});
    return getUnlockStatus(false);
  }

  await secureWriteFile(
    unlockFile,
    JSON.stringify({
      version:2,
      source:lease.source??'local',
      until:nextUntil,
      hardUntil,
      idleMinutes,
      lastActivityAt:now
    })
  );

  await auditSecurity('unlock_renewed',{
    source:lease.source??'local',
    expiresAt:new Date(nextUntil).toISOString(),
    hardExpiresAt:new Date(hardUntil).toISOString()
  });

  return getUnlockStatus(false);
}

export async function lockLocal(reason='manual'):Promise<UnlockStatus>{
  await rm(unlockFile,{force:true});
  await auditSecurity('lock',{reason});

  return {
    locked:true,
    expiresAt:null,
    hardExpiresAt:null,
    source:null,
    lastActivityAt:null
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
      reason:'Capability is not enabled in Easy Local MCP configuration'
    };
  }

  if(privileged&&!(await isUnlocked(config.alwaysUnlocked))){
    return {
      allowed:false,
      privileged:true,
      reason:'Easy Local MCP is locked. Unlock it before using privileged tools.'
    };
  }
  return {
    allowed:true,
    privileged
  };
}
