import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config, configFilePath } from './config.js';
import { auditFile, auditSecurity, secureWriteFileAtomic } from './security.js';
import { control, maskMcpUrl, request, status } from './lifecycle.js';
import { DEFAULT_PUBLIC_WORKER_URL, validatedWorkerOrigin } from './relay.js';

const UI_HOST='127.0.0.1';
const SESSION_COOKIE='localmcp_ui_session';
const SESSION_TTL_MS=30*60_000;
const MAX_BODY_BYTES=32*1024;
const MAX_AUDIT_BYTES=256*1024;
const SAFE_AUDIT_FIELDS=new Set([
  'timestamp','event','tool','workspace','result','durationMs','reason','error',
  'deviceId','publicRelay','pid','code','minutes','expiresAt','externalServer',
  'externalTool','changed'
]);

type FeatureState={
  fileRead:boolean;
  fileWrite:boolean;
  fileDelete:boolean;
  shell:boolean;
  processes:boolean;
  externalMcp:boolean;
};

type JsonObject=Record<string,unknown>;

export interface ControlUiHandle {
  host:string;
  port:number;
  url:string;
  close:()=>Promise<void>;
  closed:Promise<void>;
}

export interface ControlUiOptions {
  port?:number;
  openBrowser?:boolean;
}

function securityHeaders(res:ServerResponse){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',[
    "default-src 'self'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
}

function json(res:ServerResponse,statusCode:number,value:unknown){
  securityHeaders(res);
  res.statusCode=statusCode;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

function text(res:ServerResponse,statusCode:number,value:string,contentType='text/plain; charset=utf-8'){
  securityHeaders(res);
  res.statusCode=statusCode;
  res.setHeader('Content-Type',contentType);
  res.end(value);
}

function isLoopback(address:string|undefined){
  return address==='127.0.0.1'
    || address==='::1'
    || address==='::ffff:127.0.0.1';
}

function parseCookies(value:string|undefined){
  const result:Record<string,string>={};
  for(const item of (value||'').split(';')){
    const index=item.indexOf('=');
    if(index<=0)continue;
    const key=item.slice(0,index).trim();
    const cookieValue=item.slice(index+1).trim();
    if(key)result[key]=cookieValue;
  }
  return result;
}

async function readJsonBody(req:IncomingMessage):Promise<JsonObject>{
  let bytes=0;
  const chunks:Buffer[]=[];

  for await (const chunk of req){
    const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    bytes+=value.length;
    if(bytes>MAX_BODY_BYTES)throw new Error('Request body is too large');
    chunks.push(value);
  }

  if(!chunks.length)return {};

  const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)){
    throw new Error('JSON body must be an object');
  }

  return parsed as JsonObject;
}

async function readRawConfig(){
  const path=configFilePath();
  const content=await readFile(path,'utf8');
  const raw=JSON.parse(content) as unknown;

  if(!raw||typeof raw!=='object'||Array.isArray(raw)){
    throw new Error('LocalMCP configuration must be a JSON object');
  }

  return {path,raw:raw as JsonObject};
}

function configuredFeatures(raw:JsonObject,normalized:Awaited<ReturnType<typeof config>>):FeatureState{
  const features=raw.features&&typeof raw.features==='object'&&!Array.isArray(raw.features)
    ? raw.features as JsonObject
    : {};
  const files=features.files;

  const fileRead=typeof files==='boolean'
    ? files
    : files&&typeof files==='object'&&!Array.isArray(files)
      ? (files as JsonObject).read===true
      : normalized.fileRead;
  const fileWrite=typeof files==='boolean'
    ? files
    : files&&typeof files==='object'&&!Array.isArray(files)
      ? (files as JsonObject).write===true
      : normalized.fileWrite;
  const fileDelete=typeof files==='boolean'
    ? files
    : files&&typeof files==='object'&&!Array.isArray(files)
      ? (files as JsonObject).delete===true
      : normalized.fileDelete;

  return {
    fileRead,
    fileWrite,
    fileDelete,
    shell:typeof features.shell==='boolean'?features.shell:normalized.shell,
    processes:typeof features.processes==='boolean'?features.processes:normalized.processes,
    externalMcp:typeof features.externalMcp==='boolean'
      ? features.externalMcp
      : normalized.externalMcp
  };
}

async function configView(){
  const {path,raw}=await readRawConfig();
  const normalized=await config({
    content:JSON.stringify(raw),
    path
  });
  const configured=configuredFeatures(raw,normalized);

  return {
    path,
    defaultWorkspace:normalized.defaultWorkspace,
    workspaces:Object.entries(normalized.workspaces).map(([name,root])=>({
      name,
      root,
      default:name===normalized.defaultWorkspace
    })),
    features:configured,
    effectiveFeatures:{
      fileRead:normalized.fileRead,
      fileWrite:normalized.fileWrite,
      fileDelete:normalized.fileDelete,
      shell:normalized.shell,
      processes:normalized.processes,
      externalMcp:normalized.externalMcp
    }
  };
}

function workerOrigin(url:string|null){
  if(!url)return null;
  try{return new URL(url).origin;}catch{return null;}
}

function capabilityAvailability(enabled:boolean,privileged:boolean,current:Awaited<ReturnType<typeof status>>){
  if(!enabled)return 'disabled';
  if(current.status!=='running')return 'agent-stopped';
  if(!current.ready)return 'connecting';
  if(privileged&&current.locked)return 'locked';
  return 'available';
}

async function statusView(){
  const current=await status();
  const configuration=await configView();
  const effective=configuration.effectiveFeatures;
  const capabilityMeta:{key:keyof FeatureState;privileged:boolean}[]=[
    {key:'fileRead',privileged:false},
    {key:'fileWrite',privileged:true},
    {key:'fileDelete',privileged:true},
    {key:'shell',privileged:true},
    {key:'processes',privileged:true},
    {key:'externalMcp',privileged:true}
  ];

  return {
    agent:{
      status:current.status,
      pid:current.pid,
      ready:current.ready,
      locked:current.locked,
      unlockExpiresAt:current.unlockExpiresAt,
      log:current.log
    },
    connection:{
      state:current.status==='running'?(current.ready?'connected':'connecting'):'stopped',
      workerUrl:current.workerUrl??workerOrigin(current.url),
      deviceId:current.deviceId,
      workerManagedByEnv:current.workerManagedByEnv,
      publicRelay:(current.workerUrl??workerOrigin(current.url))===validatedWorkerOrigin(DEFAULT_PUBLIC_WORKER_URL).href,
      mcpUrlMasked:maskMcpUrl(current.url)
    },
    capabilities:capabilityMeta.map(({key,privileged})=>({
      key,
      configured:configuration.features[key],
      effective:effective[key],
      privileged,
      availability:capabilityAvailability(effective[key],privileged,current)
    })),
    configuration
  };
}

function parseFeatureUpdate(body:JsonObject):FeatureState{
  const source=body.features;
  if(!source||typeof source!=='object'||Array.isArray(source)){
    throw new Error('features is required');
  }

  const features=source as JsonObject;
  const keys=[
    'fileRead','fileWrite','fileDelete','shell','processes','externalMcp'
  ] as const;

  for(const key of keys){
    if(typeof features[key]!=='boolean'){
      throw new Error(`features.${key} must be boolean`);
    }
  }

  if(features.processes===true&&features.shell!==true){
    throw new Error('processes requires shell to be enabled');
  }

  return {
    fileRead:features.fileRead as boolean,
    fileWrite:features.fileWrite as boolean,
    fileDelete:features.fileDelete as boolean,
    shell:features.shell as boolean,
    processes:features.processes as boolean,
    externalMcp:features.externalMcp as boolean
  };
}

async function updateConfiguration(body:JsonObject){
  const nextFeatures=parseFeatureUpdate(body);
  const {path,raw}=await readRawConfig();
  const normalizedBefore=await config({
    content:JSON.stringify(raw),
    path
  });
  const previous=configuredFeatures(raw,normalizedBefore);

  const dangerousKeys:(keyof FeatureState)[]=[
    'fileWrite','fileDelete','shell','processes','externalMcp'
  ];
  const enabling=dangerousKeys.filter(
    key=>!previous[key]&&nextFeatures[key]
  );

  if(enabling.length&&body.confirmDangerous!==true){
    throw new Error(
      'Explicit confirmation is required before enabling privileged capabilities'
    );
  }

  const previousFeatures=
    raw.features&&typeof raw.features==='object'&&!Array.isArray(raw.features)
      ? raw.features as JsonObject
      : {};
  const previousFiles=
    previousFeatures.files
    && typeof previousFeatures.files==='object'
    && !Array.isArray(previousFeatures.files)
      ? previousFeatures.files as JsonObject
      : {};

  const nextRaw:JsonObject={
    ...raw,
    features:{
      ...previousFeatures,
      files:{
        ...previousFiles,
        read:nextFeatures.fileRead,
        write:nextFeatures.fileWrite,
        delete:nextFeatures.fileDelete
      },
      shell:nextFeatures.shell,
      processes:nextFeatures.processes,
      externalMcp:nextFeatures.externalMcp
    }
  };

  const content=JSON.stringify(nextRaw,null,2)+'\n';

  await config({content,path});

  const changed=(Object.keys(nextFeatures) as (keyof FeatureState)[])
    .filter(key=>previous[key]!==nextFeatures[key]);

  await secureWriteFileAtomic(path,content);
  await auditSecurity('config_update',{changed:changed.join(',')});

  const current=await status();
  let reloaded=false;

  if(current.status==='running'){
    await request('reload');
    reloaded=true;
  }

  return {
    saved:true,
    reloaded,
    changed,
    configuration:await configView()
  };
}

async function updateWorkspaces(body:JsonObject){
  if(body.confirm!==true){
    throw new Error('Workspace changes require explicit confirmation');
  }

  const source=body.workspaces;
  if(!Array.isArray(source)||source.length<1||source.length>32){
    throw new Error('workspaces must contain 1 to 32 entries');
  }

  const workspaces:Record<string,string>={};
  for(const entry of source){
    if(!entry||typeof entry!=='object'||Array.isArray(entry)){
      throw new Error('Each workspace must be an object');
    }
    const item=entry as JsonObject;
    const name=typeof item.name==='string'?item.name.trim():'';
    const root=typeof item.root==='string'?item.root.trim():'';
    if(!/^[A-Za-z0-9._-]{1,64}$/.test(name)){
      throw new Error('Workspace names may contain only letters, numbers, dot, underscore, and hyphen');
    }
    if(!root||root.length>4096)throw new Error(`Workspace '${name}' requires a valid path`);
    if(workspaces[name]!==undefined)throw new Error(`Duplicate workspace '${name}'`);
    workspaces[name]=root;
  }

  const defaultWorkspace=typeof body.defaultWorkspace==='string'
    ? body.defaultWorkspace.trim()
    : '';
  if(!workspaces[defaultWorkspace]){
    throw new Error('defaultWorkspace must reference one of the configured workspaces');
  }

  const {path,raw}=await readRawConfig();
  const nextRaw:JsonObject={...raw,workspaces,defaultWorkspace};
  delete nextRaw.root;
  const content=JSON.stringify(nextRaw,null,2)+'\n';

  await config({content,path});
  await secureWriteFileAtomic(path,content);
  await auditSecurity('config_update',{changed:'workspaces'});

  const current=await status();
  let reloaded=false;
  if(current.status==='running'){
    await request('reload');
    reloaded=true;
  }

  return {saved:true,reloaded,configuration:await configView()};
}

async function runAgentAction(action:'start'|'stop'|'restart'){
  if(action==='restart'){
    const current=await status();
    if(current.status==='running')await control('stop');
    await control('start');
  }else{
    await control(action);
  }
  return statusView();
}

function parseWorkerOrigin(body:JsonObject){
  const value=typeof body.workerUrl==='string'?body.workerUrl.trim():'';
  if(!value)throw new Error('workerUrl is required');
  if(value.length>2048)throw new Error('workerUrl is too long');
  return validatedWorkerOrigin(value).href;
}

function safeAuditValue(value:unknown){
  if(value===null||typeof value==='number'||typeof value==='boolean')return value;
  if(typeof value!=='string')return undefined;
  if(value.length>500)return value.slice(0,500)+'…';
  if(/(?:bearer\s+)?[a-f0-9]{48,}/i.test(value))return '<redacted>';
  if(/\/mcp\/[^\s]+/i.test(value))return '<redacted>';
  return value;
}

async function readAuditEvents(limit=100){
  let handle:Awaited<ReturnType<typeof open>>|undefined;

  try{
    handle=await open(auditFile,'r');
    const stat=await handle.stat();
    const size=Math.min(stat.size,MAX_AUDIT_BYTES);
    const buffer=Buffer.alloc(size);
    await handle.read(buffer,0,size,Math.max(0,stat.size-size));
    let content=buffer.toString('utf8');

    if(stat.size>size){
      const firstNewline=content.indexOf('\n');
      content=firstNewline>=0?content.slice(firstNewline+1):'';
    }

    const records:JsonObject[]=[];

    for(const line of content.split(/\r?\n/)){
      if(!line.trim())continue;

      try{
        const source=JSON.parse(line) as unknown;
        if(!source||typeof source!=='object'||Array.isArray(source))continue;

        const safe:JsonObject={};
        for(const [key,value] of Object.entries(source as JsonObject)){
          if(!SAFE_AUDIT_FIELDS.has(key))continue;
          const sanitized=safeAuditValue(value);
          if(sanitized!==undefined)safe[key]=sanitized;
        }

        records.push(safe);
      }catch{}
    }

    return records.slice(-Math.max(1,Math.min(limit,200))).reverse();
  }catch(error:any){
    if(error?.code==='ENOENT')return [];
    throw error;
  }finally{
    await handle?.close().catch(()=>{});
  }
}

function openDefaultBrowser(url:string){
  let child:ReturnType<typeof spawn>;

  if(process.platform==='win32'){
    child=spawn(
      'rundll32.exe',
      ['url.dll,FileProtocolHandler',url],
      {detached:true,stdio:'ignore',windowsHide:true}
    );
  }else if(process.platform==='darwin'){
    child=spawn('open',[url],{detached:true,stdio:'ignore'});
  }else{
    child=spawn('xdg-open',[url],{detached:true,stdio:'ignore'});
  }

  child.on('error',()=>{});
  child.unref();
}

const PAGE=String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LocalMCP Control Center</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#182230;background:#f4f6f9}
*{box-sizing:border-box}body{margin:0;background:#f4f6f9}.shell{max-width:1240px;margin:0 auto;padding:26px 20px 52px}
header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:20px}h1{font-size:28px;margin:0}h2{font-size:17px;margin:0 0 14px}p{margin:.45rem 0;color:#667085}
.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}.metric,.card{background:#fff;border:1px solid #e1e6ee;border-radius:14px;box-shadow:0 4px 14px rgba(16,24,40,.04)}
.metric{padding:14px 16px}.metric-label{font-size:12px;color:#667085}.metric-value{margin-top:5px;font-size:17px;font-weight:750;word-break:break-word}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.card{padding:18px}.wide{grid-column:1/-1}
.row{display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid #edf0f4}.row:last-child{border-bottom:0}.label{color:#667085}.value{font-weight:650;text-align:right;word-break:break-all}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.header-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}#securityBadge{align-items:center;justify-content:center;align-self:center;line-height:1}button{border:1px solid #cfd6e2;background:#fff;border-radius:9px;padding:8px 12px;font-weight:650;cursor:pointer;color:#27364b}button.primary{background:#172b4d;border-color:#172b4d;color:#fff}button.danger{border-color:#f0a3a3;color:#b42318}button:disabled{opacity:.45;cursor:not-allowed}
.badge{display:inline-flex;padding:4px 8px;border-radius:999px;background:#eef2f6;font-size:12px;font-weight:750}.badge.ok{background:#e9f8ef;color:#067647}.badge.warn{background:#fff4e5;color:#b54708}.badge.bad{background:#feecec;color:#b42318}
.muted{font-size:12px;color:#7b8697}.path{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:#475467;word-break:break-all}
.warning{margin-top:12px;padding:11px 12px;border-radius:10px;background:#fff4e5;color:#7a4b00;font-size:13px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #edf0f4;vertical-align:middle}th{font-size:12px;color:#667085}
input[type="text"],select{width:100%;border:1px solid #cfd6e2;border-radius:8px;padding:8px 9px;background:#fff;color:#182230}input[type="checkbox"],input[type="radio"]{width:17px;height:17px}
.cap-name{font-weight:700}.cap-note{display:block;font-size:11px;color:#7b8697;margin-top:2px}.workspace-actions{display:flex;gap:6px;align-items:center}.connection-editor{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:12px}
.audit-tools{display:grid;grid-template-columns:180px 1fr auto auto;gap:8px;align-items:center;margin-bottom:10px}.pager{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:10px;flex-wrap:wrap}.pager-controls{display:flex;gap:8px;align-items:center}
#revealed{margin-top:9px;font:12px ui-monospace,SFMono-Regular,Consolas,monospace}#message{position:fixed;right:20px;bottom:20px;max-width:460px;padding:11px 14px;background:#172b4d;color:#fff;border-radius:10px;display:none;white-space:pre-wrap;z-index:10}
@media(max-width:900px){.summary{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.wide{grid-column:auto}}
@media(max-width:600px){.shell{padding:18px 10px 40px}.summary{grid-template-columns:1fr 1fr}header{display:block}.audit-tools{grid-template-columns:1fr}.connection-editor{grid-template-columns:1fr}.card{padding:14px}}
</style>
</head>
<body>
<div class="shell">
<header>
  <div><h1>LocalMCP Control Center</h1><p>Local-only administration over the existing authenticated control plane.</p></div>
  <div class="header-actions"><button id="refreshStatus">Refresh</button><span id="securityBadge" class="badge">Connecting…</span></div>
</header>

<div class="summary">
  <div class="metric"><div class="metric-label">Agent</div><div id="summaryAgent" class="metric-value">-</div></div>
  <div class="metric"><div class="metric-label">Relay</div><div id="summaryRelay" class="metric-value">-</div></div>
  <div class="metric"><div class="metric-label">Security</div><div id="summarySecurity" class="metric-value">-</div></div>
  <div class="metric"><div class="metric-label">Default workspace</div><div id="summaryWorkspace" class="metric-value">-</div></div>
</div>

<div class="grid">
<section class="card">
<h2>Agent lifecycle</h2>
<div class="row"><span class="label">Status</span><span id="agentStatus" class="value">-</span></div>
<div class="row"><span class="label">PID</span><span id="pid" class="value">-</span></div>
<div class="row"><span class="label">Unlock expires</span><span id="expiry" class="value">-</span></div>
<div class="row"><span class="label">Log</span><span id="logPath" class="path">-</span></div>
<div class="actions">
  <button id="agentStart" class="primary">Start</button>
  <button id="agentRestart">Restart</button>
  <button id="agentStop" class="danger">Stop</button>
  <button id="reload">Reload config</button>
</div>
<div class="actions">
  <button data-minutes="5">Unlock 5m</button><button data-minutes="30">Unlock 30m</button><button data-minutes="60">Unlock 60m</button><button id="lock" class="danger">Lock now</button>
</div>
</section>

<section class="card">
<h2>Relay & connection</h2>
<div class="row"><span class="label">State</span><span id="relayState" class="value">-</span></div>
<div class="row"><span class="label">Worker origin</span><span id="worker" class="value">-</span></div>
<div class="row"><span class="label">Device</span><span id="deviceId" class="value">-</span></div>
<div class="row"><span class="label">MCP URL</span><span id="maskedUrl" class="value">-</span></div>
<div class="connection-editor"><input id="workerInput" type="text" aria-label="Worker origin" placeholder="https://worker.example.com"><button id="useDefaultWorker">Use public relay</button></div>
<p id="workerHint" class="muted">Changing Worker re-registers this device. Registration credentials remain inside the Agent.</p>
<div class="actions"><button id="reregisterWorker">Re-register Worker</button><button id="reveal">Reveal / Copy MCP URL</button><button id="rotate" class="danger">Rotate credentials</button></div>
<input id="revealed" type="text" readonly hidden aria-label="Revealed MCP URL">
</section>

<section class="card wide">
<h2>Permissions</h2>
<p class="muted">Configured controls what LocalMCP may expose. Current availability also reflects Agent and LOCK / UNLOCK state.</p>
<div style="overflow:auto"><table>
<thead><tr><th>Capability</th><th>Configured</th><th>Effective config</th><th>Current availability</th></tr></thead>
<tbody id="capabilityRows">
<tr data-cap="fileRead"><td><span class="cap-name">files.read</span><span class="cap-note">Read workspace files</span></td><td><input type="checkbox" data-key="fileRead"></td><td class="effective">-</td><td class="availability">-</td></tr>
<tr data-cap="fileWrite"><td><span class="cap-name">files.write</span><span class="cap-note">Privileged</span></td><td><input type="checkbox" data-key="fileWrite"></td><td class="effective">-</td><td class="availability">-</td></tr>
<tr data-cap="fileDelete"><td><span class="cap-name">files.delete</span><span class="cap-note">Privileged</span></td><td><input type="checkbox" data-key="fileDelete"></td><td class="effective">-</td><td class="availability">-</td></tr>
<tr data-cap="shell"><td><span class="cap-name">shell</span><span class="cap-note">OS-level command execution</span></td><td><input type="checkbox" data-key="shell"></td><td class="effective">-</td><td class="availability">-</td></tr>
<tr data-cap="processes"><td><span class="cap-name">processes</span><span class="cap-note">Requires shell</span></td><td><input type="checkbox" data-key="processes"></td><td class="effective">-</td><td class="availability">-</td></tr>
<tr data-cap="externalMcp"><td><span class="cap-name">externalMcp</span><span class="cap-note">External MCP execution is privileged</span></td><td><input type="checkbox" data-key="externalMcp"></td><td class="effective">-</td><td class="availability">-</td></tr>
</tbody></table></div>
<div class="warning">Shell runs with the LocalMCP OS user's authority. Workspace restrictions protect LocalMCP file tools; they do not sandbox shell commands.</div>
<div class="actions"><button id="saveConfig" class="primary">Save permission profile</button><span id="configPath" class="path"></span></div>
</section>

<section class="card wide">
<h2>Workspaces</h2>
<p class="muted">Workspace changes alter the file-access boundary and require explicit confirmation. Paths must already exist and be directories.</p>
<div style="overflow:auto"><table><thead><tr><th>Default</th><th>Name</th><th>Path</th><th></th></tr></thead><tbody id="workspaceRows"></tbody></table></div>
<div class="actions"><button id="addWorkspace">Add workspace</button><button id="saveWorkspaces" class="primary">Save workspaces</button></div>
</section>

<section class="card wide">
<h2>Audit history</h2>
<div class="audit-tools">
<select id="auditCategory"><option value="all">All events</option><option value="denied">Denied / errors</option><option value="security">Security & credentials</option><option value="config">Configuration</option><option value="tools">Tool activity</option></select>
<input id="auditSearch" type="text" placeholder="Filter event, tool, workspace, result…">
<select id="auditPageSize" aria-label="Audit rows per page"><option value="10">10 / page</option><option value="25" selected>25 / page</option><option value="50">50 / page</option></select>
<button id="refreshAudit">Refresh</button>
</div>
<div style="overflow:auto"><table><thead><tr><th>Time</th><th>Event</th><th>Tool / workspace</th><th>Result / reason</th></tr></thead><tbody id="auditRows"></tbody></table></div>
<div class="pager"><span id="auditPageInfo" class="muted">-</span><div class="pager-controls"><button id="auditPrev">Previous</button><button id="auditNext">Next</button></div></div>
<p class="muted">Only a safe allowlist of audit fields is displayed. Tokens, URLs, command output and arbitrary payloads are omitted.</p>
</section>
</div>
</div>
<div id="message"></div>
<script>
(() => {
  let currentFeatures=null;
  let currentWorkspaces=[];
  let currentDefaultWorkspace='';
  let auditEvents=[];
  let auditPage=1;
  let workerManagedByEnv=false;
  const DEFAULT_WORKER='https://localmcp-relay.daodao973597.workers.dev';
  const $=id=>document.getElementById(id);
  const message=(value,error=false)=>{
    const node=$('message');
    node.textContent=value;
    node.style.background=error?'#8a1c13':'#172b4d';
    node.style.display='block';
    clearTimeout(message.timer);
    message.timer=setTimeout(()=>node.style.display='none',4500);
  };
  const api=async(path,body={})=>{
    const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json().catch(()=>({error:'Invalid server response'}));
    if(!response.ok)throw new Error(data.error||('HTTP '+response.status));
    return data;
  };
  const badge=(text,state)=>{
    const span=document.createElement('span');
    span.className='badge '+(state||'');
    span.textContent=text;
    return span;
  };
  const setFeatures=(features,capabilities)=>{
    currentFeatures={...features};
    document.querySelectorAll('#capabilityRows input[data-key]').forEach(input=>{input.checked=!!features[input.dataset.key];});
    for(const capability of capabilities||[]){
      const row=document.querySelector('tr[data-cap="'+capability.key+'"]');
      if(!row)continue;
      row.querySelector('.effective').replaceChildren(badge(capability.effective?'Enabled':'Disabled',capability.effective?'ok':''));
      const state=capability.availability==='available'?'ok':capability.availability==='locked'?'warn':capability.availability==='disabled'?'':'bad';
      row.querySelector('.availability').replaceChildren(badge(capability.availability,state));
    }
  };
  const renderWorkspaces=()=>{
    const body=$('workspaceRows');
    body.replaceChildren();
    currentWorkspaces.forEach((workspace,index)=>{
      const tr=document.createElement('tr');
      const tdDefault=document.createElement('td');
      const radio=document.createElement('input');
      radio.type='radio'; radio.name='defaultWorkspace'; radio.checked=workspace.name===currentDefaultWorkspace;
      radio.addEventListener('change',()=>{if(radio.checked)currentDefaultWorkspace=workspace.name;});
      tdDefault.append(radio);
      const tdName=document.createElement('td');
      const name=document.createElement('input'); name.type='text'; name.value=workspace.name; name.maxLength=64;
      name.addEventListener('input',()=>{const old=workspace.name;workspace.name=name.value;if(currentDefaultWorkspace===old)currentDefaultWorkspace=workspace.name;});
      tdName.append(name);
      const tdRoot=document.createElement('td');
      const root=document.createElement('input'); root.type='text'; root.value=workspace.root;
      root.addEventListener('input',()=>{workspace.root=root.value;});
      tdRoot.append(root);
      const tdAction=document.createElement('td');
      const remove=document.createElement('button'); remove.textContent='Remove'; remove.className='danger'; remove.disabled=currentWorkspaces.length===1;
      remove.addEventListener('click',()=>{const removed=currentWorkspaces.splice(index,1)[0];if(removed.name===currentDefaultWorkspace)currentDefaultWorkspace=currentWorkspaces[0].name;renderWorkspaces();});
      tdAction.append(remove);
      tr.append(tdDefault,tdName,tdRoot,tdAction); body.append(tr);
    });
  };
  const load=async()=>{
    const data=await api('/api/status');
    const running=data.agent.status==='running';
    $('agentStatus').textContent=data.agent.status+(data.agent.ready?' / ready':running?' / connecting':'');
    $('pid').textContent=data.agent.pid??'-';
    $('expiry').textContent=data.agent.unlockExpiresAt??'-';
    $('logPath').textContent=data.agent.log??'-';
    $('securityBadge').textContent=data.agent.locked?'LOCKED':'UNLOCKED';
    $('securityBadge').className='badge '+(data.agent.locked?'warn':'ok');
    $('summaryAgent').textContent=data.agent.ready?'Running / ready':running?'Running / connecting':'Stopped';
    $('summaryRelay').textContent=data.connection.state;
    $('summarySecurity').textContent=data.agent.locked?'LOCKED':'UNLOCKED';
    $('summaryWorkspace').textContent=data.configuration.defaultWorkspace;
    $('relayState').textContent=data.connection.state;
    $('worker').textContent=data.connection.workerUrl??'-';
    $('deviceId').textContent=data.connection.deviceId??'legacy / unavailable';
    $('maskedUrl').textContent=data.connection.mcpUrlMasked??'-';
    $('configPath').textContent=data.configuration.path;
    workerManagedByEnv=!!data.connection.workerManagedByEnv;
    $('workerInput').value=data.connection.workerUrl??'';
    $('workerInput').disabled=workerManagedByEnv;
    $('reregisterWorker').disabled=workerManagedByEnv||!running;
    $('useDefaultWorker').disabled=workerManagedByEnv;
    $('workerHint').textContent=workerManagedByEnv
      ? 'Worker origin is controlled by LOCALMCP_WORKER_URL. Remove the environment override before changing it here.'
      : (data.connection.publicRelay?'Using the default public relay. It is trusted infrastructure, not end-to-end encrypted.':'Custom Worker origin. Re-registering replaces device credentials for this Agent.');
    $('agentStart').disabled=running;
    $('agentStop').disabled=!running;
    $('agentRestart').disabled=!running;
    $('lock').disabled=!running;
    document.querySelectorAll('button[data-minutes]').forEach(button=>button.disabled=!running);
    setFeatures(data.configuration.features,data.capabilities);
    currentWorkspaces=data.configuration.workspaces.map(item=>({name:item.name,root:item.root}));
    currentDefaultWorkspace=data.configuration.defaultWorkspace;
    renderWorkspaces();
  };
  const eventCategory=event=>{
    const name=String(event.event||'').toLowerCase();
    const result=String(event.result||'').toLowerCase();
    if(event.reason||event.error||result==='denied'||result==='error')return 'denied';
    if(name.includes('lock')||name.includes('unlock')||name.includes('credential')||name.includes('worker')||name.includes('reveal'))return 'security';
    if(name.includes('config'))return 'config';
    if(event.tool)return 'tools';
    return 'other';
  };
  const renderAudit=()=>{
    const body=$('auditRows'); body.replaceChildren();
    const category=$('auditCategory').value;
    const query=$('auditSearch').value.trim().toLowerCase();
    const pageSize=Number($('auditPageSize').value)||25;
    const filtered=auditEvents.filter(event=>{
      if(category!=='all'&&eventCategory(event)!==category)return false;
      const searchable=Object.values(event).map(String).join(' ').toLowerCase();
      return !query||searchable.includes(query);
    });
    const totalPages=Math.max(1,Math.ceil(filtered.length/pageSize));
    auditPage=Math.min(Math.max(1,auditPage),totalPages);
    const start=(auditPage-1)*pageSize;
    const pageItems=filtered.slice(start,start+pageSize);
    for(const event of pageItems){
      const tr=document.createElement('tr');
      const values=[event.timestamp||'-',event.event||'-',[event.tool,event.workspace].filter(Boolean).join(' / ')||'-',event.reason||event.result||event.error||event.durationMs||'-'];
      for(const value of values){const td=document.createElement('td');td.textContent=String(value);tr.append(td);} body.append(tr);
    }
    if(!pageItems.length){
      const tr=document.createElement('tr');
      const td=document.createElement('td');td.colSpan=4;td.className='muted';td.textContent='No matching audit events.';tr.append(td);body.append(tr);
    }
    const shownFrom=filtered.length?start+1:0;
    const shownTo=Math.min(start+pageItems.length,filtered.length);
    $('auditPageInfo').textContent='Showing '+shownFrom+'–'+shownTo+' of '+filtered.length+' · Page '+auditPage+' / '+totalPages;
    $('auditPrev').disabled=auditPage<=1;
    $('auditNext').disabled=auditPage>=totalPages;
  };
  const loadAudit=async()=>{const data=await api('/api/audit');auditEvents=data.events||[];auditPage=1;renderAudit();};
  const boot=async()=>{await api('/api/session');await load();await loadAudit();};
  const agentAction=async(action)=>{
    if((action==='stop'||action==='restart')&&!confirm((action==='stop'?'Stop':'Restart')+' the LocalMCP Agent? Active MCP connections will be interrupted.'))return;
    try{await api('/api/agent/'+action,{confirm:action==='start'||action==='stop'||action==='restart'});await load();message('Agent '+action+' completed.');}
    catch(error){message(error.message,true);}
  };
  $('agentStart').addEventListener('click',()=>agentAction('start'));
  $('agentStop').addEventListener('click',()=>agentAction('stop'));
  $('agentRestart').addEventListener('click',()=>agentAction('restart'));
  document.querySelectorAll('button[data-minutes]').forEach(button=>button.addEventListener('click',async()=>{
    try{await api('/api/unlock',{minutes:Number(button.dataset.minutes)});await load();message('LocalMCP unlocked.');}catch(error){message(error.message,true);}
  }));
  $('lock').addEventListener('click',async()=>{try{await api('/api/lock');await load();message('LocalMCP locked.');}catch(error){message(error.message,true);}});
  $('reload').addEventListener('click',async()=>{try{await api('/api/reload');await load();message('Configuration reloaded.');}catch(error){message(error.message,true);}});
  $('rotate').addEventListener('click',async()=>{
    if(!confirm('Rotate LocalMCP credentials? Existing connections may be interrupted.'))return;
    try{await api('/api/rotate',{confirm:true});await load();message('Credentials rotated.');}catch(error){message(error.message,true);}
  });
  $('reveal').addEventListener('click',async()=>{
    if(!confirm('The full MCP URL is a credential. Reveal and copy it locally?'))return;
    try{const data=await api('/api/reveal-url',{confirm:true});const input=$('revealed');input.hidden=false;input.value=data.url;try{await navigator.clipboard.writeText(data.url);message('MCP URL revealed and copied.');}catch{message('MCP URL revealed. Clipboard access was unavailable.');}}catch(error){message(error.message,true);}
  });
  $('useDefaultWorker').addEventListener('click',()=>{$('workerInput').value=DEFAULT_WORKER;});
  $('reregisterWorker').addEventListener('click',async()=>{
    if(workerManagedByEnv)return;
    const workerUrl=$('workerInput').value.trim();
    if(!confirm('Re-register this LocalMCP device with '+workerUrl+'? Local credentials will switch to the new Worker. The previous Worker registration may remain valid until it is revoked or rotated there.'))return;
    try{await api('/api/worker/reregister',{workerUrl,confirm:true});await load();message('Worker re-registration completed.');}catch(error){message(error.message,true);}
  });
  document.querySelector('input[data-key="processes"]').addEventListener('change',event=>{if(event.target.checked)document.querySelector('input[data-key="shell"]').checked=true;});
  document.querySelector('input[data-key="shell"]').addEventListener('change',event=>{if(!event.target.checked)document.querySelector('input[data-key="processes"]').checked=false;});
  $('saveConfig').addEventListener('click',async()=>{
    try{
      const features={};document.querySelectorAll('#capabilityRows input[data-key]').forEach(input=>{features[input.dataset.key]=input.checked;});
      const dangerous=['fileWrite','fileDelete','shell','processes','externalMcp'];
      const enabling=dangerous.filter(key=>!currentFeatures?.[key]&&features[key]);
      let confirmDangerous=false;
      if(enabling.length){confirmDangerous=confirm('Enable privileged capabilities: '+enabling.join(', ')+'?\n\nThese capabilities grant additional authority while LocalMCP is unlocked.');if(!confirmDangerous)return;}
      await api('/api/config/update',{features,confirmDangerous});await load();message('Permission profile saved.');
    }catch(error){message(error.message,true);}
  });
  $('addWorkspace').addEventListener('click',()=>{let i=1;let name='workspace'+i;const names=new Set(currentWorkspaces.map(item=>item.name));while(names.has(name))name='workspace'+(++i);currentWorkspaces.push({name,root:''});renderWorkspaces();});
  $('saveWorkspaces').addEventListener('click',async()=>{
    if(!confirm('Save workspace changes? This changes the LocalMCP file-access boundary.'))return;
    try{await api('/api/workspaces/update',{workspaces:currentWorkspaces,defaultWorkspace:currentDefaultWorkspace,confirm:true});await load();message('Workspaces saved.');}catch(error){message(error.message,true);}
  });
  $('refreshStatus').addEventListener('click',()=>load().catch(error=>message(error.message,true)));
  $('refreshAudit').addEventListener('click',()=>loadAudit().catch(error=>message(error.message,true)));
  $('auditCategory').addEventListener('change',()=>{auditPage=1;renderAudit();});
  $('auditSearch').addEventListener('input',()=>{auditPage=1;renderAudit();});
  $('auditPageSize').addEventListener('change',()=>{auditPage=1;renderAudit();});
  $('auditPrev').addEventListener('click',()=>{if(auditPage>1){auditPage--;renderAudit();}});
  $('auditNext').addEventListener('click',()=>{auditPage++;renderAudit();});
  boot().catch(error=>message(error.message,true));
})();
</script>
</body>
</html>`;

export async function startControlUi(options:ControlUiOptions={}):Promise<ControlUiHandle>{
  const sessions=new Map<string,number>();
  let expectedOrigin='';
  let expectedHost='';
  let closedResolve!:()=>void;
  let closing:Promise<void>|undefined;
  const closed=new Promise<void>(resolveClosed=>{closedResolve=resolveClosed;});

  const server=createServer(async(req,res)=>{
    try{
      if(!isLoopback(req.socket.remoteAddress)){
        json(res,403,{error:'Loopback access only'});
        return;
      }

      const host=req.headers.host||'';
      if(!expectedHost||host!==expectedHost){
        json(res,403,{error:'Invalid local host'});
        return;
      }

      const target=new URL(req.url||'/',expectedOrigin);
      if(target.search){
        json(res,400,{error:'Query strings are not accepted'});
        return;
      }

      if(req.method==='GET'&&target.pathname==='/'){
        text(res,200,PAGE,'text/html; charset=utf-8');
        return;
      }

      if(req.method!=='POST'||!target.pathname.startsWith('/api/')){
        json(res,404,{error:'Not found'});
        return;
      }

      if(req.headers.origin!==expectedOrigin){
        json(res,403,{error:'Invalid origin'});
        return;
      }

      const now=Date.now();
      for(const [token,expiresAt] of sessions){
        if(expiresAt<=now)sessions.delete(token);
      }

      if(target.pathname==='/api/session'){
        const token=randomBytes(32).toString('hex');
        sessions.set(token,now+SESSION_TTL_MS);
        res.setHeader(
          'Set-Cookie',
          `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS/1000}`
        );
        json(res,200,{ok:true});
        return;
      }

      const cookies=parseCookies(req.headers.cookie);
      const session=cookies[SESSION_COOKIE];
      const expiresAt=session?sessions.get(session):undefined;

      if(!session||!expiresAt||expiresAt<=now){
        if(session)sessions.delete(session);
        json(res,401,{error:'Local UI session required'});
        return;
      }

      sessions.set(session,now+SESSION_TTL_MS);

      if(target.pathname==='/api/status'){
        await readJsonBody(req);
        json(res,200,await statusView());
        return;
      }

      if(target.pathname==='/api/config'){
        await readJsonBody(req);
        json(res,200,{configuration:await configView()});
        return;
      }

      if(target.pathname==='/api/config/update'){
        json(res,200,await updateConfiguration(await readJsonBody(req)));
        return;
      }

      if(target.pathname==='/api/workspaces/update'){
        json(res,200,await updateWorkspaces(await readJsonBody(req)));
        return;
      }

      if(
        target.pathname==='/api/agent/start'
        || target.pathname==='/api/agent/stop'
        || target.pathname==='/api/agent/restart'
      ){
        const body=await readJsonBody(req);
        const action=target.pathname.slice('/api/agent/'.length) as 'start'|'stop'|'restart';
        if((action==='stop'||action==='restart')&&body.confirm!==true){
          throw new Error(`Agent ${action} requires explicit confirmation`);
        }
        json(res,200,await runAgentAction(action));
        return;
      }

      if(target.pathname==='/api/worker/reregister'){
        const body=await readJsonBody(req);
        if(body.confirm!==true)throw new Error('Worker re-registration requires explicit confirmation');
        const workerUrl=parseWorkerOrigin(body);
        await request('reregister',{workerUrl});
        json(res,200,await statusView());
        return;
      }

      if(target.pathname==='/api/unlock'){
        const body=await readJsonBody(req);
        const minutes=Number(body.minutes);
        if(![5,30,60].includes(minutes)){
          throw new Error('UI unlock duration must be 5, 30, or 60 minutes');
        }
        await request('unlock',{minutes});
        json(res,200,await statusView());
        return;
      }

      if(target.pathname==='/api/lock'){
        await readJsonBody(req);
        await request('lock');
        json(res,200,await statusView());
        return;
      }

      if(target.pathname==='/api/reload'){
        await readJsonBody(req);
        await request('reload');
        json(res,200,await statusView());
        return;
      }

      if(target.pathname==='/api/rotate'){
        const body=await readJsonBody(req);
        if(body.confirm!==true)throw new Error('Credential rotation requires explicit confirmation');
        await request('rotate');
        json(res,200,await statusView());
        return;
      }

      if(target.pathname==='/api/reveal-url'){
        const body=await readJsonBody(req);
        if(body.confirm!==true)throw new Error('MCP URL reveal requires explicit confirmation');
        const current=await request('status');
        if(current.status!=='running'||!current.url){
          throw new Error('LocalMCP is not running or has no MCP URL');
        }
        await auditSecurity('mcp_url_reveal');
        json(res,200,{url:current.url});
        return;
      }

      if(target.pathname==='/api/audit'){
        await readJsonBody(req);
        json(res,200,{events:await readAuditEvents(200)});
        return;
      }

      json(res,404,{error:'Not found'});
    }catch(error){
      json(
        res,
        400,
        {error:error instanceof Error?error.message:String(error)}
      );
    }
  });

  server.on('clientError',(_error,socket)=>{
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  await new Promise<void>((ready,reject)=>{
    server.once('error',reject);
    server.listen(options.port??0,UI_HOST,ready);
  });

  const address=server.address();
  if(!address||typeof address==='string'){
    server.close();
    throw new Error('Unable to determine LocalMCP UI address');
  }

  const port=address.port;
  expectedHost=`${UI_HOST}:${port}`;
  expectedOrigin=`http://${expectedHost}`;
  const url=expectedOrigin+'/';

  const close=()=>{
    closing??=new Promise<void>((done,reject)=>{
      sessions.clear();
      server.close(error=>{
        if(error)reject(error);
        else{
          closedResolve();
          done();
        }
      });
      server.closeAllConnections();
    });
    return closing;
  };

  if(options.openBrowser!==false){
    openDefaultBrowser(url);
  }

  return {
    host:UI_HOST,
    port,
    url,
    close,
    closed
  };
}
