import { realpath, stat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { McpServerConfig } from './mcp/loader.js';

const mcpEntrySchema=z.object({
  enabled:z.boolean().optional().default(true),
  command:z.string().min(1),
  args:z.array(z.string()).optional().default([]),
  env:z.record(z.string(),z.string()).optional()
}).strict();

const filePermissionsSchema=z.object({
  read:z.boolean().optional(),
  write:z.boolean().optional(),
  delete:z.boolean().optional()
}).strict();

const featureSchema=z.object({
  files:z.union([z.boolean(),filePermissionsSchema]).optional(),
  shell:z.boolean().optional(),
  processes:z.boolean().optional(),
  externalMcp:z.boolean().optional(),
}).strict();

const securitySchema=z.object({
  alwaysUnlocked:z.boolean().optional().default(false),
  renewOnPrivilegedUse:z.boolean().optional().default(true),
  idleMinutes:z.number().int().min(5).max(120).optional().default(30),
  maxSessionMinutes:z.number().int().min(30).max(480).optional().default(240),
}).strict();

export const localMcpConfigSchema=z.object({
  root:z.string().optional(),
  workspaces:z.record(z.string().min(1),z.string().min(1)).optional(),
  defaultWorkspace:z.string().min(1).optional(),
  features:featureSchema.optional().default({}),
  skills:z.object({
    dir:z.string().optional().default('skills'),
    enabled:z.array(z.string().min(1)).optional()
  }).strict().optional().default({dir:'skills'}),
  security:securitySchema.optional().default({
    alwaysUnlocked:false,
    renewOnPrivilegedUse:true,
    idleMinutes:30,
    maxSessionMinutes:240
  }),
  mcpServers:z.record(z.string(),mcpEntrySchema).optional().default({}),
}).strict();

type FileConfig=z.infer<typeof localMcpConfigSchema>;

export interface Config {
  root:string;
  workspaces:Record<string,string>;
  defaultWorkspace:string;
  files:boolean;
  fileRead:boolean;
  fileWrite:boolean;
  fileDelete:boolean;
  shell:boolean;
  processes:boolean;
  externalMcp:boolean;
  alwaysUnlocked:boolean;
  renewUnlockOnPrivilegedUse:boolean;
  unlockIdleMinutes:number;
  unlockMaxSessionMinutes:number;
  port:number;
  token?:string;
  skillsDir:string;
  enabledSkills?:string[];
  mcpServers:Record<string,McpServerConfig>;
  configFile?:string;
}

function parseConfig(raw:unknown,path:string):FileConfig{
  const result=localMcpConfigSchema.safeParse(raw);
  if(result.success)return result.data;
  const details=result.error.issues
    .map(issue=>`${issue.path.join('.')||'<root>'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid Easy Local MCP config ${path}: ${details}`);
}

async function readConfig():Promise<{value:FileConfig;base:string;path?:string}>{
  const explicit=process.env.LOCALMCP_CONFIG;
  const path=explicit?resolve(explicit):resolve(homedir(),'.localmcp','localmcp.json');

  try{
    return {
      value:parseConfig(JSON.parse(await readFile(path,'utf8')),path),
      base:dirname(path),
      path
    };
  }catch(error:any){
    if(error instanceof SyntaxError){
      throw new Error(`Invalid JSON in Easy Local MCP config ${path}: ${error.message}`);
    }
    if(error.code!=='ENOENT')throw error;
    return {
      value:localMcpConfigSchema.parse({}),
      base:homedir()
    };
  }
}

export function configFilePath(){
  return resolve(
    process.env.LOCALMCP_CONFIG
    || resolve(homedir(),'.localmcp','localmcp.json')
  );
}

export async function config(
  snapshot?:{content:string;path:string}
):Promise<Config>{
  const loaded=snapshot
    ? {
        value:parseConfig(JSON.parse(snapshot.content),snapshot.path),
        base:dirname(snapshot.path),
        path:snapshot.path
      }
    : await readConfig();

  const c=loaded.value;
  const configured=c.workspaces&&Object.keys(c.workspaces).length
    ? c.workspaces
    : {default:c.root||'.'};
  const rootOverride=process.env.LOCALMCP_ROOT;
  const expand=(path:string)=>
    path==='~'||path.startsWith('~/')
      ? resolve(homedir(),path.slice(2))
      : resolve(loaded.base,path);

  const workspaces:Record<string,string>={};
  for(const [name,path] of Object.entries(configured)){
    const selected=
      rootOverride&&name===(c.defaultWorkspace||Object.keys(configured)[0])
        ? rootOverride
        : path;
    const root=await realpath(expand(selected));
    if(!(await stat(root)).isDirectory()){
      throw new Error(`Workspace '${name}' must be a directory`);
    }
    workspaces[name]=root;
  }

  const defaultWorkspace=c.defaultWorkspace||Object.keys(workspaces)[0];
  if(!workspaces[defaultWorkspace]){
    throw new Error(`Unknown defaultWorkspace '${defaultWorkspace}'`);
  }

  const root=workspaces[defaultWorkspace];
  const port=Number(process.env.LOCALMCP_PORT||8787);
  if(!Number.isInteger(port)||port<1||port>65535){
    throw new Error('Invalid LOCALMCP_PORT');
  }

  const mcpServers:Record<string,McpServerConfig>={};
  for(const [name,m] of Object.entries(c.mcpServers)){
    if(m.enabled){
      mcpServers[name]={
        command:m.command,
        args:m.args,
        env:m.env
      };
    }
  }

  const files=c.features.files;
  const fileRead=typeof files==='boolean'?files:files?.read??false;
  const fileWrite=typeof files==='boolean'?files:files?.write??false;
  const fileDelete=typeof files==='boolean'?files:files?.delete??false;
  const shell=
    process.env.LOCALMCP_SHELL!==undefined
      ? process.env.LOCALMCP_SHELL==='1'
      : c.features.shell??false;
  const processes=(c.features.processes??false)&&shell;

  // Existing configs with configured MCP servers retain the capability unless
  // they explicitly disable it.
  const externalMcp=
    c.features.externalMcp??Object.keys(mcpServers).length>0;

  // Zone membership always disables persistent unlock, even if a user manually
  // edits the local config. The Agent injects LOCALMCP_ZONE_ID into its child.
  const zoneMember=Boolean(process.env.LOCALMCP_ZONE_ID);
  const alwaysUnlocked=!zoneMember&&c.security.alwaysUnlocked;

  return {
    root,
    workspaces,
    defaultWorkspace,
    files:fileRead||fileWrite||fileDelete,
    fileRead,
    fileWrite,
    fileDelete,
    shell,
    processes,
    externalMcp,
    alwaysUnlocked,
    renewUnlockOnPrivilegedUse:c.security.renewOnPrivilegedUse,
    unlockIdleMinutes:c.security.idleMinutes,
    unlockMaxSessionMinutes:c.security.maxSessionMinutes,
    port,
    token:process.env.LOCALMCP_TOKEN,
    skillsDir:resolve(loaded.base,c.skills.dir),
    enabledSkills:c.skills.enabled,
    mcpServers,
    configFile:loaded.path
  };
}
