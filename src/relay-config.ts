import {access,readFile,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {DEFAULT_PUBLIC_WORKER_URL,validatedWorkerOrigin} from './relay.js';
import {secureWriteFileAtomic} from './security.js';

const relayStateDir=resolve(homedir(),'.localmcp');
export const relayConfigFile=resolve(relayStateDir,'relay.json');
export const registeredWorkerFile=resolve(relayStateDir,'worker.json');
export const pendingRegistrationTokenFile=resolve(relayStateDir,'registration-token.pending');
export const pendingZoneJoinCodeFile=resolve(relayStateDir,'zone-join-code.pending');
export interface RegisteredDeviceRecord {
  workerUrl:string;
  agentToken:string;
  mcpToken:string;
  deviceId?:string;
  zoneId?:string;
}

export interface RelaySetupState {
  configured:boolean;
  workerUrl:string|null;
  suggestedWorkerUrl:string;
  source:'env'|'saved'|'registered'|'unconfigured';
  managedByEnv:boolean;
  registrationTokenManagedByEnv:boolean;
}

async function readJson(path:string){
  try{
    return JSON.parse(await readFile(path,'utf8')) as unknown;
  }catch(error:any){
    if(error.code==='ENOENT')return undefined;
    throw error;
  }
}

function workerUrlFrom(value:unknown,path:string){
  if(!value||typeof value!=='object'||Array.isArray(value)){
    throw new Error(`Invalid Relay configuration in ${path}`);
  }

  const workerUrl=(value as Record<string,unknown>).workerUrl;
  if(typeof workerUrl!=='string'||!workerUrl.trim()){
    throw new Error(`Invalid workerUrl in ${path}`);
  }

  return validatedWorkerOrigin(workerUrl).href;
}

export async function registeredDeviceRecord():Promise<RegisteredDeviceRecord|null>{
  const value=await readJson(registeredWorkerFile);
  if(value===undefined)return null;
  if(!value||typeof value!=='object'||Array.isArray(value)){
    throw new Error(`Invalid Relay registration in ${registeredWorkerFile}`);
  }

  const source=value as Record<string,unknown>;
  const workerUrl=workerUrlFrom(source,registeredWorkerFile);
  const agentToken=typeof source.agentToken==='string'?source.agentToken:'';
  const mcpToken=typeof source.mcpToken==='string'?source.mcpToken:'';
  const deviceId=typeof source.deviceId==='string'?source.deviceId:undefined;
  const zoneId=typeof source.zoneId==='string'?source.zoneId:undefined;

  if(!agentToken||!mcpToken){
    throw new Error(`Invalid Relay credentials in ${registeredWorkerFile}`);
  }

  return {workerUrl,agentToken,mcpToken,deviceId,zoneId};
}

export async function saveRegisteredDevice(record:RegisteredDeviceRecord){
  await secureWriteFileAtomic(
    registeredWorkerFile,
    JSON.stringify(record,null,2)+'\n'
  );
}
export async function clearRegisteredDevice(){
  await rm(registeredWorkerFile,{force:true});
}

export async function relaySetupState():Promise<RelaySetupState>{
  const envWorker=process.env.LOCALMCP_WORKER_URL?.trim();

  if(envWorker){
    return {
      configured:true,
      workerUrl:validatedWorkerOrigin(envWorker).href,
      suggestedWorkerUrl:validatedWorkerOrigin(envWorker).href,
      source:'env',
      managedByEnv:true,
      registrationTokenManagedByEnv:process.env.LOCALMCP_REGISTRATION_TOKEN!==undefined
    };
  }

  const saved=await readJson(relayConfigFile);
  if(saved!==undefined){
    const workerUrl=workerUrlFrom(saved,relayConfigFile);
    return {
      configured:true,
      workerUrl,
      suggestedWorkerUrl:workerUrl,
      source:'saved',
      managedByEnv:false,
      registrationTokenManagedByEnv:process.env.LOCALMCP_REGISTRATION_TOKEN!==undefined
    };
  }

  const registered=await readJson(registeredWorkerFile);
  if(registered!==undefined){
    const workerUrl=workerUrlFrom(registered,registeredWorkerFile);
    return {
      configured:true,
      workerUrl,
      suggestedWorkerUrl:workerUrl,
      source:'registered',
      managedByEnv:false,
      registrationTokenManagedByEnv:process.env.LOCALMCP_REGISTRATION_TOKEN!==undefined
    };
  }

  return {
    configured:false,
    workerUrl:null,
    suggestedWorkerUrl:validatedWorkerOrigin(DEFAULT_PUBLIC_WORKER_URL).href,
    source:'unconfigured',
    managedByEnv:false,
    registrationTokenManagedByEnv:process.env.LOCALMCP_REGISTRATION_TOKEN!==undefined
  };
}

export async function ensureRelayConfigured(){
  const envWorker=process.env.LOCALMCP_WORKER_URL?.trim();
  if(envWorker){
    validatedWorkerOrigin(envWorker);
    return;
  }

  const saved=await readJson(relayConfigFile);
  if(saved!==undefined){
    workerUrlFrom(saved,relayConfigFile);
    return;
  }

  try{
    await access(registeredWorkerFile);
    return;
  }catch(error:any){
    if(error.code!=='ENOENT')throw error;
  }

  throw new Error(
    'Relay is not configured. Open the Easy Local MCP Control Center and choose a Relay before starting the Agent.'
  );
}

export async function configuredRelayUrl(){
  const state=await relaySetupState();
  if(!state.configured||!state.workerUrl){
    throw new Error(
      'Relay is not configured. Open the Easy Local MCP Control Center and choose a Relay before starting the Agent.'
    );
  }
  return state.workerUrl;
}

export async function saveRelayPreference(workerUrl:string){
  if(process.env.LOCALMCP_WORKER_URL){
    throw new Error(
      'Relay is controlled by LOCALMCP_WORKER_URL; remove the environment override before changing it in the UI.'
    );
  }

  const normalized=validatedWorkerOrigin(workerUrl).href;
  await secureWriteFileAtomic(
    relayConfigFile,
    JSON.stringify({workerUrl:normalized},null,2)+'\n'
  );
  return normalized;
}

export async function savePendingRegistrationToken(value:string|undefined){
  if(process.env.LOCALMCP_REGISTRATION_TOKEN!==undefined){
    if(value?.trim()){
      throw new Error(
        'Registration token is controlled by LOCALMCP_REGISTRATION_TOKEN; remove the environment override before changing it in the UI.'
      );
    }
    return;
  }

  const token=value?.trim()??'';
  if(!token){
    await rm(pendingRegistrationTokenFile,{force:true});
    return;
  }

  if(token.length>8192){
    throw new Error('Registration token is too long');
  }

  await secureWriteFileAtomic(pendingRegistrationTokenFile,token+'\n');
}

export async function registrationToken(){
  if(process.env.LOCALMCP_REGISTRATION_TOKEN!==undefined){
    return process.env.LOCALMCP_REGISTRATION_TOKEN;
  }

  try{
    return (await readFile(pendingRegistrationTokenFile,'utf8')).trim()||undefined;
  }catch(error:any){
    if(error.code==='ENOENT')return undefined;
    throw error;
  }
}

export async function clearPendingRegistrationToken(){
  if(process.env.LOCALMCP_REGISTRATION_TOKEN===undefined){
    await rm(pendingRegistrationTokenFile,{force:true});
  }
}

export async function savePendingZoneJoinCode(value:string|undefined){
  if(process.env.LOCALMCP_ZONE_JOIN_CODE!==undefined){
    if(value?.trim()){
      throw new Error(
        'Zone join code is controlled by LOCALMCP_ZONE_JOIN_CODE; remove the environment override before changing it locally.'
      );
    }
    return;
  }

  const code=value?.trim()??'';
  if(!code){
    await rm(pendingZoneJoinCodeFile,{force:true});
    return;
  }

  if(
    !/^[0-9a-f-]{36}\.[a-f0-9]{48}$/i.test(code)
    || code.length>128
  ){
    throw new Error('Invalid Zone join code');
  }

  await secureWriteFileAtomic(pendingZoneJoinCodeFile,code+'\n');
}

export async function zoneJoinCode(){
  if(process.env.LOCALMCP_ZONE_JOIN_CODE!==undefined){
    return process.env.LOCALMCP_ZONE_JOIN_CODE.trim()||undefined;
  }

  try{
    return (await readFile(pendingZoneJoinCodeFile,'utf8')).trim()||undefined;
  }catch(error:any){
    if(error.code==='ENOENT')return undefined;
    throw error;
  }
}

export async function clearPendingZoneJoinCode(){
  if(process.env.LOCALMCP_ZONE_JOIN_CODE===undefined){
    await rm(pendingZoneJoinCodeFile,{force:true});
  }
}
