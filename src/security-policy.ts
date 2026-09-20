import { readFile } from 'node:fs/promises';
import { configFilePath, localMcpConfigSchema } from './config.js';
import { auditSecurity, secureWriteFileAtomic } from './security.js';

export interface SecurityPolicyPreference {
  alwaysUnlocked:boolean;
  renewOnPrivilegedUse:boolean;
  idleMinutes:number;
  maxSessionMinutes:number;
}

const defaults:SecurityPolicyPreference={
  alwaysUnlocked:false,
  renewOnPrivilegedUse:true,
  idleMinutes:30,
  maxSessionMinutes:240
};

async function readRaw(){
  const path=configFilePath();
  try{
    const raw=JSON.parse(await readFile(path,'utf8')) as Record<string,unknown>;
    return {path,raw};
  }catch(error:any){
    if(error?.code==='ENOENT'){
      return {path,raw:{} as Record<string,unknown>};
    }
    if(error instanceof SyntaxError){
      throw new Error(`Invalid JSON in Easy Local MCP config ${path}: ${error.message}`);
    }
    throw error;
  }
}

export async function securityPolicyPreference():Promise<SecurityPolicyPreference>{
  const {raw}=await readRaw();
  const parsed=localMcpConfigSchema.parse(raw);
  return {
    alwaysUnlocked:parsed.security.alwaysUnlocked,
    renewOnPrivilegedUse:parsed.security.renewOnPrivilegedUse,
    idleMinutes:parsed.security.idleMinutes,
    maxSessionMinutes:parsed.security.maxSessionMinutes
  };
}

export async function updateSecurityPolicy(
  next:Partial<SecurityPolicyPreference>,
  reason='local'
):Promise<SecurityPolicyPreference>{
  const {path,raw}=await readRaw();
  const current=localMcpConfigSchema.parse(raw);
  const security={
    ...defaults,
    ...current.security,
    ...next
  };

  const nextRaw={
    ...raw,
    security
  };

  localMcpConfigSchema.parse(nextRaw);
  await secureWriteFileAtomic(path,JSON.stringify(nextRaw,null,2)+'\n');

  await auditSecurity('security_policy_update',{
    reason,
    alwaysUnlocked:security.alwaysUnlocked,
    renewOnPrivilegedUse:security.renewOnPrivilegedUse,
    idleMinutes:security.idleMinutes,
    maxSessionMinutes:security.maxSessionMinutes
  });

  return security;
}

export async function disableAlwaysUnlocked(reason:string){
  const current=await securityPolicyPreference();
  if(!current.alwaysUnlocked)return false;
  await updateSecurityPolicy({alwaysUnlocked:false},reason);
  await auditSecurity('always_unlock_disabled',{reason});
  return true;
}
