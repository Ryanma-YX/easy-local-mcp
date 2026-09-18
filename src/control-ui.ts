import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config, configFilePath } from './config.js';
import { auditFile, auditSecurity, secureWriteFileAtomic } from './security.js';
import { maskMcpUrl, request, status } from './lifecycle.js';

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

async function statusView(){
  const current=await status();
  const configuration=await configView();

  return {
    agent:{
      status:current.status,
      pid:current.pid,
      ready:current.ready,
      locked:current.locked,
      unlockExpiresAt:current.unlockExpiresAt
    },
    connection:{
      workerUrl:workerOrigin(current.url),
      mcpUrlMasked:maskMcpUrl(current.url)
    },
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
<title>LocalMCP Control</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fb}
*{box-sizing:border-box}body{margin:0}.wrap{max-width:1120px;margin:0 auto;padding:28px 20px 48px}
header{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:22px}h1{margin:0;font-size:28px}p{margin:.45rem 0;color:#5a6578}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:16px}.card{background:#fff;border:1px solid #dfe5ef;border-radius:14px;padding:18px;box-shadow:0 4px 16px rgba(24,39,75,.05)}
h2{font-size:17px;margin:0 0 14px}.row{display:flex;justify-content:space-between;gap:16px;padding:7px 0;border-bottom:1px solid #edf0f5}.row:last-child{border-bottom:0}.label{color:#6a7487}.value{font-weight:600;text-align:right;word-break:break-all}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}button{border:1px solid #cad2df;background:#fff;border-radius:9px;padding:8px 12px;font-weight:650;cursor:pointer}button.primary{background:#172033;color:#fff;border-color:#172033}button.danger{border-color:#d33;color:#b42318}button:disabled{opacity:.45;cursor:not-allowed}
.badge{display:inline-flex;padding:4px 8px;border-radius:999px;font-size:12px;font-weight:700;background:#edf1f7}.warning{display:none;margin-top:12px;padding:12px;border-radius:10px;background:#fff1d6;color:#784800;font-weight:600}.warning.show{display:block}
fieldset{border:0;padding:0;margin:0}.toggle{display:flex;align-items:center;justify-content:space-between;padding:8px 0}.toggle input{width:18px;height:18px}.path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all;color:#4d596c}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px;border-bottom:1px solid #edf0f5;vertical-align:top}th{color:#6a7487}.wide{grid-column:1/-1}
#revealed{width:100%;padding:9px;border:1px solid #cad2df;border-radius:8px;margin-top:8px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
#message{position:fixed;right:20px;bottom:20px;max-width:420px;padding:11px 14px;background:#172033;color:white;border-radius:10px;display:none;white-space:pre-wrap}.muted{color:#7b8596;font-size:12px}
@media(max-width:640px){header{display:block}.wrap{padding:18px 12px}.card{padding:15px}}
</style>
</head>
<body>
<div class="wrap">
<header><div><h1>LocalMCP Control</h1><p>Local-only control plane. This page does not expose the control secret.</p></div><span id="securityBadge" class="badge">Connecting…</span></header>
<div class="grid">
<section class="card">
<h2>Agent status</h2>
<div class="row"><span class="label">Status</span><span id="agentStatus" class="value">-</span></div>
<div class="row"><span class="label">PID</span><span id="pid" class="value">-</span></div>
<div class="row"><span class="label">Unlock expires</span><span id="expiry" class="value">-</span></div>
<div class="actions"><button data-minutes="5">Unlock 5m</button><button data-minutes="30">Unlock 30m</button><button data-minutes="60">Unlock 60m</button><button id="lock" class="danger">Lock now</button></div>
</section>
<section class="card">
<h2>Connection</h2>
<div class="row"><span class="label">Worker</span><span id="worker" class="value">-</span></div>
<div class="row"><span class="label">MCP URL</span><span id="maskedUrl" class="value">-</span></div>
<div class="actions"><button id="reveal">Reveal / Copy MCP URL</button><button id="reload">Reload configuration</button><button id="rotate" class="danger">Rotate credentials</button></div>
<input id="revealed" type="text" readonly hidden aria-label="Revealed MCP URL">
</section>
<section class="card">
<h2>Configuration</h2>
<div id="configPath" class="path"></div>
<fieldset id="features">
<label class="toggle"><span>files.read</span><input type="checkbox" data-key="fileRead"></label>
<label class="toggle"><span>files.write</span><input type="checkbox" data-key="fileWrite"></label>
<label class="toggle"><span>files.delete</span><input type="checkbox" data-key="fileDelete"></label>
<label class="toggle"><span>shell</span><input type="checkbox" data-key="shell"></label>
<label class="toggle"><span>processes</span><input type="checkbox" data-key="processes"></label>
<label class="toggle"><span>externalMcp</span><input type="checkbox" data-key="externalMcp"></label>
</fieldset>
<div id="shellWarning" class="warning">Shell grants OS-level command execution under the LocalMCP process user's authority. The configured workspace is NOT a shell sandbox.</div>
<div class="actions"><button id="saveConfig" class="primary">Save configuration</button></div>
</section>
<section class="card">
<h2>Workspaces</h2>
<div id="workspaces"></div>
</section>
<section class="card wide">
<h2>Recent audit events</h2>
<div class="actions"><button id="refreshAudit">Refresh audit</button></div>
<div style="overflow:auto;margin-top:8px"><table><thead><tr><th>Time</th><th>Event</th><th>Tool / workspace</th><th>Result / reason</th></tr></thead><tbody id="auditRows"></tbody></table></div>
<p class="muted">Only a safe allowlist of audit fields is displayed. Tokens, URLs, command output and arbitrary payloads are omitted.</p>
</section>
</div>
</div>
<div id="message"></div>
<script>
(() => {
  let currentFeatures=null;
  const $=id=>document.getElementById(id);
  const message=(value,error=false)=>{
    const node=$('message');
    node.textContent=value;
    node.style.background=error?'#8a1c13':'#172033';
    node.style.display='block';
    clearTimeout(message.timer);
    message.timer=setTimeout(()=>node.style.display='none',4500);
  };
  const api=async(path,body={})=>{
    const response=await fetch(path,{
      method:'POST',
      credentials:'same-origin',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)
    });
    const data=await response.json().catch(()=>({error:'Invalid server response'}));
    if(!response.ok)throw new Error(data.error||('HTTP '+response.status));
    return data;
  };
  const setFeatures=features=>{
    currentFeatures={...features};
    document.querySelectorAll('#features input[data-key]').forEach(input=>{
      input.checked=!!features[input.dataset.key];
    });
    $('shellWarning').classList.toggle('show',!!features.shell);
  };
  const load=async()=>{
    const data=await api('/api/status');
    $('agentStatus').textContent=data.agent.status+(data.agent.ready?' / ready':'');
    $('pid').textContent=data.agent.pid??'-';
    $('expiry').textContent=data.agent.unlockExpiresAt??'-';
    $('securityBadge').textContent=data.agent.locked?'LOCKED':'UNLOCKED';
    $('worker').textContent=data.connection.workerUrl??'-';
    $('maskedUrl').textContent=data.connection.mcpUrlMasked??'-';
    $('configPath').textContent=data.configuration.path;
    setFeatures(data.configuration.features);
    const root=$('workspaces');
    root.replaceChildren();
    for(const workspace of data.configuration.workspaces){
      const row=document.createElement('div');
      row.className='row';
      const left=document.createElement('span');
      left.className='label';
      left.textContent=workspace.name+(workspace.default?' (default)':'');
      const right=document.createElement('span');
      right.className='path';
      right.textContent=workspace.root;
      row.append(left,right);
      root.append(row);
    }
  };
  const loadAudit=async()=>{
    const data=await api('/api/audit');
    const body=$('auditRows');
    body.replaceChildren();
    for(const event of data.events){
      const tr=document.createElement('tr');
      const values=[
        event.timestamp||'-',
        event.event||'-',
        [event.tool,event.workspace].filter(Boolean).join(' / ')||'-',
        event.reason||event.result||event.error||event.durationMs||'-'
      ];
      for(const value of values){
        const td=document.createElement('td');
        td.textContent=String(value);
        tr.append(td);
      }
      body.append(tr);
    }
  };
  const boot=async()=>{
    await api('/api/session');
    await load();
    await loadAudit();
  };
  document.querySelectorAll('button[data-minutes]').forEach(button=>{
    button.addEventListener('click',async()=>{
      try{
        await api('/api/unlock',{minutes:Number(button.dataset.minutes)});
        await load();
        message('LocalMCP unlocked.');
      }catch(error){message(error.message,true);}
    });
  });
  $('lock').addEventListener('click',async()=>{
    try{await api('/api/lock');await load();message('LocalMCP locked.');}
    catch(error){message(error.message,true);}
  });
  $('reload').addEventListener('click',async()=>{
    try{await api('/api/reload');await load();message('Configuration reloaded.');}
    catch(error){message(error.message,true);}
  });
  $('rotate').addEventListener('click',async()=>{
    if(!confirm('Rotate LocalMCP credentials? Existing connections may be interrupted.'))return;
    try{await api('/api/rotate',{confirm:true});await load();message('Credentials rotated.');}
    catch(error){message(error.message,true);}
  });
  $('reveal').addEventListener('click',async()=>{
    if(!confirm('The full MCP URL is a credential. Reveal and copy it locally?'))return;
    try{
      const data=await api('/api/reveal-url',{confirm:true});
      const input=$('revealed');
      input.hidden=false;
      input.value=data.url;
      try{await navigator.clipboard.writeText(data.url);message('MCP URL revealed and copied.');}
      catch{message('MCP URL revealed. Clipboard access was unavailable.');}
    }catch(error){message(error.message,true);}
  });
  document.querySelector('input[data-key="processes"]').addEventListener('change',event=>{
    if(event.target.checked)document.querySelector('input[data-key="shell"]').checked=true;
  });
  document.querySelector('input[data-key="shell"]').addEventListener('change',event=>{
    if(!event.target.checked)document.querySelector('input[data-key="processes"]').checked=false;
    $('shellWarning').classList.toggle('show',event.target.checked);
  });
  $('saveConfig').addEventListener('click',async()=>{
    try{
      const features={};
      document.querySelectorAll('#features input[data-key]').forEach(input=>{
        features[input.dataset.key]=input.checked;
      });
      const dangerous=['fileWrite','fileDelete','shell','processes','externalMcp'];
      const enabling=dangerous.filter(key=>!currentFeatures?.[key]&&features[key]);
      let confirmDangerous=false;
      if(enabling.length){
        confirmDangerous=confirm('Enable privileged capabilities: '+enabling.join(', ')+'?\n\nThese capabilities may grant remote MCP calls additional authority while LocalMCP is unlocked.');
        if(!confirmDangerous)return;
      }
      await api('/api/config/update',{features,confirmDangerous});
      await load();
      message('Configuration saved.');
    }catch(error){message(error.message,true);}
  });
  $('refreshAudit').addEventListener('click',()=>loadAudit().catch(error=>message(error.message,true)));
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
        json(res,200,{events:await readAuditEvents()});
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
