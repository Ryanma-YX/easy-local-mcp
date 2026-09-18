import { realpath, stat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { McpServerConfig } from './mcp/loader.js';

const mcpEntrySchema=z.object({enabled:z.boolean().optional().default(true),command:z.string().min(1),args:z.array(z.string()).optional().default([]),env:z.record(z.string(),z.string()).optional()}).strict();
const filePermissionsSchema=z.object({read:z.boolean().optional(),write:z.boolean().optional(),delete:z.boolean().optional()}).strict();
const featureSchema=z.object({
  files:z.union([z.boolean(),filePermissionsSchema]).optional(),
  shell:z.boolean().optional(),
  processes:z.boolean().optional(),
  externalMcp:z.boolean().optional(),
}).strict();
export const localMcpConfigSchema=z.object({
  root:z.string().optional(),
  workspaces:z.record(z.string().min(1),z.string().min(1)).optional(),
  defaultWorkspace:z.string().min(1).optional(),
  features:featureSchema.optional().default({}),
  skills:z.object({dir:z.string().optional().default('skills'),enabled:z.array(z.string().min(1)).optional()}).strict().optional().default({dir:'skills'}),
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
  port:number;
  token?:string;
  skillsDir:string;
  enabledSkills?:string[];
  mcpServers:Record<string,McpServerConfig>;
  configFile?:string;
}

function parseConfig(raw:unknown,path:string):FileConfig{
 const result=localMcpConfigSchema.safeParse(raw);if(result.success)return result.data;
 const details=result.error.issues.map(i=>`${i.path.join('.')||'<root>'}: ${i.message}`).join('; ');
 throw new Error(`Invalid Easy Local MCP config ${path}: ${details}`);
}
async function readConfig():Promise<{value:FileConfig;base:string;path?:string}>{
 const explicit=process.env.LOCALMCP_CONFIG,path=explicit?resolve(explicit):resolve(homedir(),'.localmcp','localmcp.json');
 try{return {value:parseConfig(JSON.parse(await readFile(path,'utf8')),path),base:dirname(path),path};}
 catch(e:any){if(e instanceof SyntaxError)throw new Error(`Invalid JSON in Easy Local MCP config ${path}: ${e.message}`);if(e.code!=='ENOENT')throw e;return {value:localMcpConfigSchema.parse({}),base:homedir()};}
}
export function configFilePath(){return resolve(process.env.LOCALMCP_CONFIG||resolve(homedir(),'.localmcp','localmcp.json'));}
export async function config(snapshot?:{content:string;path:string}):Promise<Config>{
 const loaded=snapshot?{value:parseConfig(JSON.parse(snapshot.content),snapshot.path),base:dirname(snapshot.path),path:snapshot.path}:await readConfig(),c=loaded.value;
 const configured=c.workspaces&&Object.keys(c.workspaces).length?c.workspaces:{default:c.root||'.'};
 const rootOverride=process.env.LOCALMCP_ROOT;
 const expand=(path:string)=>path==='~'||path.startsWith('~/')?resolve(homedir(),path.slice(2)):resolve(loaded.base,path);
 const workspaces:Record<string,string>={};for(const [name,path] of Object.entries(configured)){const selected=rootOverride&&name===(c.defaultWorkspace||Object.keys(configured)[0])?rootOverride:path;const root=await realpath(expand(selected));if(!(await stat(root)).isDirectory())throw new Error(`Workspace '${name}' must be a directory`);workspaces[name]=root;}
 const defaultWorkspace=c.defaultWorkspace||Object.keys(workspaces)[0];if(!workspaces[defaultWorkspace])throw new Error(`Unknown defaultWorkspace '${defaultWorkspace}'`);
 const root=workspaces[defaultWorkspace];
 const port=Number(process.env.LOCALMCP_PORT||8787);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid LOCALMCP_PORT');
 const mcpServers:Record<string,McpServerConfig>={};for(const [name,m] of Object.entries(c.mcpServers))if(m.enabled)mcpServers[name]={command:m.command,args:m.args,env:m.env};

 const files=c.features.files;
 const fileRead=typeof files==='boolean'?files:files?.read??false;
 const fileWrite=typeof files==='boolean'?files:files?.write??false;
 const fileDelete=typeof files==='boolean'?files:files?.delete??false;
 const shell=process.env.LOCALMCP_SHELL!==undefined?process.env.LOCALMCP_SHELL==='1':c.features.shell??false;
 const processes=(c.features.processes??false)&&shell;
 // Existing configs with configured MCP servers retain the capability unless they explicitly disable it.
 const externalMcp=c.features.externalMcp??Object.keys(mcpServers).length>0;

 return {
  root,workspaces,defaultWorkspace,
  files:fileRead||fileWrite||fileDelete,
  fileRead,fileWrite,fileDelete,
  shell,processes,externalMcp,
  port,token:process.env.LOCALMCP_TOKEN,
  skillsDir:resolve(loaded.base,c.skills.dir),enabledSkills:c.skills.enabled,
  mcpServers,configFile:loaded.path
 };
}
