import { uiI18nClient } from '../src/ui-i18n';
import { OWNER_TOOL_GROUPS } from './agent-session-tool-groups';

const styles=`
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fb}
body{margin:0}
body[aria-busy="true"]{overflow:hidden}
main{max-width:1040px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:28px;margin:0 0 8px}
h2{font-size:18px;margin:0 0 16px}
h3{font-size:16px;margin:0}
p{color:#5d6678}
.card{background:#fff;border:1px solid #e1e6ef;border-radius:14px;padding:20px;margin:16px 0;box-shadow:0 2px 8px rgba(23,32,51,.04)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
label{display:block;font-size:12px;font-weight:700;color:#566176;margin-bottom:6px}
input{box-sizing:border-box;width:100%;border:1px solid #ccd4e1;border-radius:9px;padding:10px 12px;font:inherit;background:#fff}
button{border:0;border-radius:9px;padding:10px 14px;font:inherit;font-weight:700;cursor:pointer;background:#2458d3;color:#fff}
button.secondary{background:#eef2f8;color:#263248}
button.danger{background:#fff0f0;color:#a72727}
button.copy{padding:8px 11px;white-space:nowrap;background:#eef2f8;color:#263248}
button:disabled{cursor:not-allowed;opacity:.58}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.zone{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 0;border-top:1px solid #edf0f5}
.zone:first-child{border-top:0}
.zone-actions{display:flex;gap:8px;flex-wrap:wrap}
.session-row{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;border-top:1px solid #edf0f5;padding:13px 0;flex-wrap:wrap}
.session-row:first-child{border-top:0}
.session-info{flex:1;min-width:230px;overflow-wrap:anywhere}
.session-actions{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}
.session-actions label{margin:0}
.session-actions input{max-width:100px}
.grant-editor{flex-basis:100%;min-width:280px;border:1px solid #dce3f0;border-radius:9px;padding:9px}
.grant-editor summary{cursor:pointer;font-weight:700;color:#34445d;font-size:13px}
.grant-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.grant-actions button{font-size:12px;padding:6px 9px}
.grant-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:5px;max-height:240px;overflow:auto;margin-top:8px}
.grant-grid label{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:500;margin:0}
.grant-grid input{width:auto;max-width:none}
.grant-preview{font-size:12px;color:#42516a;overflow-wrap:anywhere;margin-top:8px}
.device{display:grid;grid-template-columns:minmax(180px,1fr) minmax(160px,1fr) auto;gap:12px;align-items:center;padding:14px 0;border-top:1px solid #edf0f5}
.device:first-child{border-top:0}
.name{font-weight:800}
.meta{font-size:13px;color:#687386}
.status{font-size:12px;font-weight:800}
.online{color:#18794e}.offline{color:#8a5d00}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;background:#f4f6fa;border-radius:9px;padding:12px;white-space:pre-wrap}
.copy-list{display:grid;gap:9px;margin-top:12px}
.copy-row{display:grid;grid-template-columns:150px minmax(0,1fr) auto;gap:9px;align-items:center}
.copy-label{font-size:12px;font-weight:800;color:#566176}
.copy-value{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#f4f6fa;border-radius:9px;padding:10px 12px;overflow-wrap:anywhere;min-width:0}
.hidden{display:none!important}
#message{position:fixed;right:20px;bottom:20px;max-width:460px;padding:11px 14px;background:#172b4d;color:#fff;border-radius:10px;white-space:pre-wrap;z-index:30;box-shadow:0 10px 30px rgba(16,24,40,.22)}
#message.error{background:#8a1c13;color:#fff}
#operationOverlay{position:fixed;inset:0;z-index:20;background:rgba(15,23,42,.28);backdrop-filter:blur(1.5px);display:flex;align-items:center;justify-content:center}
#operationOverlay[hidden]{display:none}
.operation-panel{min-width:230px;max-width:80vw;padding:18px 22px;background:#fff;border:1px solid #d8dee8;border-radius:14px;box-shadow:0 18px 50px rgba(15,23,42,.22);display:flex;align-items:center;gap:13px;font-weight:700;color:#27364b}
.operation-spinner{width:22px;height:22px;border:3px solid #dbe2ea;border-top-color:#172b4d;border-radius:50%;animation:operation-spin .8s linear infinite;flex:0 0 auto}
@keyframes operation-spin{to{transform:rotate(360deg)}}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px}
.page-language{position:fixed;top:18px;right:18px;z-index:10}.page-language select{width:auto;min-width:94px;border:1px solid #ccd4e1;border-radius:9px;padding:8px 10px;background:#fff;color:#172033;font:inherit}
.small{font-size:12px}
@media(max-width:680px){.device{grid-template-columns:1fr}.zone{align-items:flex-start;flex-direction:column}.device .actions{margin-top:0}.copy-row{grid-template-columns:1fr auto}.copy-label{grid-column:1/-1}}
`;

function shell(
  title:string,
  body:string,
  script='',
  scope:'admin-public'|'admin'='admin'
){
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${styles}</style>
</head>
<body>
<div class="page-language"><select data-ui-language aria-label="Language"><option value="en">English</option><option value="zh-CN">中文</option></select></div>
<main>
${body}
</main>
<div id="operationOverlay" hidden aria-live="polite" aria-busy="true">
  <div class="operation-panel">
    <span class="operation-spinner" aria-hidden="true"></span>
    <span id="operationText">Processing…</span>
  </div>
</div>
<script>${uiI18nClient(scope)}${script}</script>
</body>
</html>`;
}

export function adminSetupRequiredPage(){
  return shell(
    'Easy Local MCP Relay Admin',
    `
<div class="card">
<h1>Relay Admin is not configured</h1>
<p>This Relay intentionally fails closed until <code>RELAY_ADMIN_TOKEN_HASH</code> is configured as a Cloudflare secret or environment variable.</p>
<p>Zone MCP, Agent, Join Code, and direct device credentials remain separate from Relay administration.</p>
</div>
`,
    '',
    'admin-public'
  );
}

export function adminLoginPage(){
  return shell(
    'Easy Local MCP Relay Admin',
    `
<div class="card" style="max-width:520px;margin:64px auto">
<h1>Easy Local MCP Relay Admin</h1>
<p>Sign in with the Relay Admin Token. This is different from a Zone Admin Token or MCP connector token.</p>
<label>Relay Admin Token</label>
<input id="token" type="password" autocomplete="current-password" autofocus>
<div class="actions"><button id="login">Sign In</button></div>
</div>
<div id="message" class="hidden" role="status" aria-live="polite"></div>
`,
    `
const $=id=>document.getElementById(id);
const token=$('token');
const show=(text,error=false)=>{
  const node=$('message');
  node.textContent=window.uiT(text);

  node.className=error?'error':'';
  clearTimeout(show.timer);
  show.timer=setTimeout(()=>node.className='hidden',4500);
};
let operationActive=false;
const withOperation=async(label,task)=>{
  if(operationActive)return;
  operationActive=true;
  $('operationText').textContent=window.uiT(label||'Processing…');

  $('operationOverlay').hidden=false;
  document.body.setAttribute('aria-busy','true');
  try{
    return await task();
  }catch(error){
    show(error?.message||String(error),true);
    return undefined;
  }finally{
    $('operationOverlay').hidden=true;
    document.body.removeAttribute('aria-busy');
    operationActive=false;
  }
};
async function login(){
  await withOperation('Signing in…',async()=>{
    const response=await fetch('/api/admin/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:token.value})
    });
    const text=await response.text();
    let data={};
    try{data=text?JSON.parse(text):{}}catch{}
    if(!response.ok)throw new Error(data.error||'Sign in failed');
    show('Signed in. Loading Relay Admin…');
    location.reload();
  });
}
$('login').onclick=login;
token.addEventListener('keydown',event=>{
  if(event.key==='Enter')login();
});
`,
    'admin-public'
  );
}

export function adminPage(){
  return shell(
    'Easy Local MCP Relay Admin',
    `
<div class="topbar">
<div>
<h1>Easy Local MCP Relay Admin</h1>
<p>Relay-wide Control Plane. Zone credentials and MCP credentials remain scoped separately.</p>
</div>
<button id="logout" class="secondary">Sign Out</button>
</div>

<section class="card" id="agentSessionsPanel">
<div class="topbar">
<div>
<h2>Agent Session Approvals</h2>
<p>AI agents request access to tools and devices. You choose how long approval lasts. These are separate from global Remote Unlock.</p>
</div>
<button id="refreshAgentSessions" class="secondary">Refresh</button>
</div>
<div id="agentSessions"><p>Loading Agent Sessions...</p></div>
</section>

<section class="card">
<h2>Create Zone</h2>
<div class="grid">
<div><label>Zone name</label><input id="createName" value="My Devices" maxlength="80"></div>
</div>
<div class="actions"><button id="createZone">Create Zone</button></div>
<div id="created" class="hidden">
<p>Save these one-time credentials now. The Relay stores only their hashes.</p>
<div id="createdValues" class="copy-list"></div>
</div>
</section>

<section class="card">
<h2>Import Existing Zone</h2>
<p>Use this once for a Zone created before the Relay Admin registry existed.</p>
<div class="grid">
<div><label>Zone ID</label><input id="importZoneId" autocomplete="off"></div>
<div><label>Existing Zone Admin Token</label><input id="importZoneToken" type="password" autocomplete="off"></div>
</div>
<div class="actions"><button id="importZone" class="secondary">Import Zone</button></div>
</section>

<section class="card">
<div class="topbar">
<h2>Zones</h2>
<button id="refreshZones" class="secondary">Refresh</button>
</div>
<div id="zones"><p>Loading...</p></div>
</section>

<section id="zonePanel" class="card hidden">
<div class="topbar">
<div>
<h2 id="zoneName">Zone</h2>
<p id="zoneMeta"></p>
</div>
<button id="closeZone" class="secondary">Close</button>
</div>
<div id="zoneIdentity" class="copy-list"></div>
<div class="actions">
<button id="makeJoin">Create Join Code</button>
<button id="rotateConnector" class="secondary">Rotate Connector</button>
</div>
<div id="joinResult" class="hidden">
<p>Join codes are one-time credentials and expire after 10 minutes.</p>
<div id="joinValues" class="copy-list"></div>
</div>
<div id="connectorResult" class="hidden">
<p>The old Zone MCP URL becomes invalid immediately after rotation.</p>
<div id="connectorValues" class="copy-list"></div>
</div>
<div id="devices"></div>
</section>

<div id="message" class="hidden" role="status" aria-live="polite"></div>
`,
    `
const $=id=>document.getElementById(id);
let activeZoneId='';
const show=(text,error=false)=>{
  const node=$('message');
  node.textContent=window.uiT(text);

  node.className=error?'error':'';
  clearTimeout(show.timer);
  show.timer=setTimeout(()=>node.className='hidden',4500);
};
const hide=()=>{$('message').className='hidden'};
let operationActive=false;
const withOperation=async(label,task)=>{
  if(operationActive)return;
  operationActive=true;
  $('operationText').textContent=window.uiT(label||'Processing…');

  $('operationOverlay').hidden=false;
  document.body.setAttribute('aria-busy','true');
  try{
    return await task();
  }catch(error){
    show(error?.message||String(error),true);
    return undefined;
  }finally{
    $('operationOverlay').hidden=true;
    document.body.removeAttribute('aria-busy');
    operationActive=false;
  }
};
async function api(path,options={}){
  const response=await fetch(path,options);
  const text=await response.text();
  let body={};
  try{body=text?JSON.parse(text):{}}catch{}
  if(response.status===401){
    setTimeout(()=>location.reload(),900);
    throw new Error(window.uiT('Admin session expired. Sign in again.'));
  }
  if(!response.ok)throw new Error(body.error||window.uiT('requestFailed',{status:response.status}));
  return body;
}
const jsonHeaders={'Content-Type':'application/json'};
const ownerToolGroups=${JSON.stringify(OWNER_TOOL_GROUPS)};

async function writeClipboard(value){
  if(navigator.clipboard&&window.isSecureContext){
    await navigator.clipboard.writeText(value);
    return;
  }
  const input=document.createElement('textarea');
  input.value=value;
  input.setAttribute('readonly','');
  input.style.position='fixed';
  input.style.opacity='0';
  document.body.appendChild(input);
  input.select();
  if(!document.execCommand('copy')){
    input.remove();
    throw new Error(window.uiT('Copy failed. Please copy the value manually.'));
  }
  input.remove();
}
async function copyText(value,label){
  try{
    await writeClipboard(value);
    show(window.uiT('copied',{label:window.uiT(label||'Value')}));
  }catch(error){
    show(error?.message||String(error),true);
  }
}
function renderCopyRow(host,label,value,copyLabel='Copy'){
  const row=document.createElement('div');
  row.className='copy-row';
  const title=document.createElement('div');
  title.className='copy-label';
  title.textContent=label;
  const shown=document.createElement('div');
  shown.className='copy-value';
  shown.textContent=value;
  const copy=document.createElement('button');
  copy.className='copy';
  copy.textContent=copyLabel;
  copy.type='button';
  copy.onclick=()=>copyText(value,label);
  row.append(title,shown,copy);
  host.appendChild(row);
}
function renderCredentials(data){
  const host=$('createdValues');
  host.textContent='';
  renderCopyRow(host,'Zone ID',data.zoneId,'Copy ID');
  renderCopyRow(host,'Zone Admin Token',data.adminToken,'Copy Token');
  renderCopyRow(host,'Zone MCP URL',data.mcpUrl,'Copy URL');
}
function renderJoin(data){
  const host=$('joinValues');
  host.textContent='';
  renderCopyRow(host,'Join Code',data.code,'Copy Code');
  const expiry=document.createElement('div');
  expiry.className='meta';
  expiry.textContent=window.uiT('expires',{time:new Date(data.expiresAt).toLocaleString()});
  host.appendChild(expiry);
}
function renderConnector(data){
  const host=$('connectorValues');
  host.textContent='';
  renderCopyRow(host,'Zone MCP URL',data.mcpUrl,'Copy URL');
}

async function loadZones(){
  const data=await api('/api/admin/zones');
  const host=$('zones');
  host.textContent='';
  if(!data.zones.length){
    const p=document.createElement('p');
    p.textContent='No Zones are registered with this Relay Admin yet.';
    host.appendChild(p);
    return;
  }
  for(const zone of data.zones){
    const row=document.createElement('div');
    row.className='zone';
    const info=document.createElement('div');
    const name=document.createElement('div');
    name.className='name';
    name.textContent=zone.name;
    const meta=document.createElement('div');
    meta.className='meta';
    meta.textContent=zone.zoneId+' · '+window.uiT('createdMeta',{time:new Date(zone.createdAt).toLocaleString()});
    info.append(name,meta);

    const actions=document.createElement('div');
    actions.className='zone-actions';
    const copy=document.createElement('button');
    copy.className='copy';
    copy.textContent='Copy ID';
    copy.onclick=()=>copyText(zone.zoneId,'Zone ID');
    const open=document.createElement('button');
    open.className='secondary';
    open.textContent='Manage';
    open.onclick=()=>withOperation(window.uiT('Loading Zone…'),()=>openZone(zone.zoneId));
    actions.append(copy,open);

    row.append(info,actions);
    host.appendChild(row);
  }
}

async function openZone(zoneId){
  hide();
  const data=await api('/api/admin/zones/'+encodeURIComponent(zoneId));
  activeZoneId=zoneId;
  $('zonePanel').className='card';
  $('zoneName').textContent=data.name;
  $('zoneMeta').textContent=window.uiT('zoneMeta',{devices:data.devices.length,codes:data.activeJoinCodes,connector:window.uiT(data.connectorConfigured?'ready':'not configured')});
  const identity=$('zoneIdentity');
  identity.textContent='';
  renderCopyRow(identity,'Zone ID',data.zoneId,'Copy ID');
  $('joinResult').className='hidden';
  $('connectorResult').className='hidden';

  const host=$('devices');
  host.textContent='';
  if(!data.devices.length){
    const p=document.createElement('p');
    p.textContent='No devices have joined this Zone yet.';
    host.appendChild(p);
    return;
  }

  for(const device of data.devices){
    const row=document.createElement('div');
    row.className='device';

    const info=document.createElement('div');
    const name=document.createElement('div');
    name.className='name';
    name.textContent=device.name;
    const meta=document.createElement('div');
    meta.className='meta';
    meta.textContent=[device.platform,device.arch,device.version].filter(Boolean).join(' · ')||'LocalMCP device';
    const deviceId=document.createElement('div');
    deviceId.className='meta';
    deviceId.textContent=device.deviceId;
    info.append(name,meta,deviceId);

    const state=document.createElement('div');
    const status=document.createElement('div');
    status.className='status '+(device.online?'online':'offline');
    status.textContent=window.uiT(device.online?'Online':'Offline');
    const joined=document.createElement('div');
    joined.className='meta';
    joined.textContent=window.uiT('joinedAt',{time:new Date(device.joinedAt).toLocaleString()});
    state.append(status,joined);

    const actions=document.createElement('div');
    actions.className='actions';

    const unlockMinutes=document.createElement('select');
    unlockMinutes.setAttribute('aria-label',window.uiT('Remote unlock duration'));
    for(const minutes of [5,15,30,60]){
      const option=document.createElement('option');
      option.value=String(minutes);
      option.textContent=minutes+'m';
      if(minutes===30)option.selected=true;
      unlockMinutes.appendChild(option);
    }
    unlockMinutes.disabled=!device.online;

    const remoteUnlock=document.createElement('button');
    remoteUnlock.className='secondary';
    remoteUnlock.textContent='Remote Unlock';
    remoteUnlock.disabled=!device.online;
    remoteUnlock.onclick=()=>withOperation(
      window.uiT('remoteUnlocking',{name:device.name}),
      async()=>{
        const minutes=Number(unlockMinutes.value);
        const result=await api(
          '/api/admin/zones/'+encodeURIComponent(activeZoneId)
            +'/devices/'+encodeURIComponent(device.deviceId)
            +'/unlock',
          {
            method:'POST',
            headers:jsonHeaders,
            body:JSON.stringify({minutes})
          }
        );
        show(
          window.uiT('remotelyUnlocked',{name:device.name,minutes})
            +(result.expiresAt
              ? window.uiT('remotelyUnlockedExpiry',{time:new Date(result.expiresAt).toLocaleString()})
              : '')
        );
      }
    );

    const copy=document.createElement('button');
    copy.className='copy';
    copy.textContent='Copy ID';
    copy.onclick=()=>copyText(device.deviceId,'Device ID');

    const rename=document.createElement('button');
    rename.className='secondary';
    rename.textContent='Rename';
    rename.onclick=()=>{
      const next=prompt(window.uiT('Device name'),device.name);
      if(!next||next===device.name)return;
      withOperation('Renaming device…',async()=>{
        await api('/api/admin/zones/'+encodeURIComponent(activeZoneId)+'/devices/'+encodeURIComponent(device.deviceId),{
          method:'PATCH',
          headers:jsonHeaders,
          body:JSON.stringify({name:next})
        });
        await openZone(activeZoneId);
        show('Device renamed.');
      });
    };

    const revoke=document.createElement('button');
    revoke.className='danger';
    revoke.textContent='Revoke';
    revoke.onclick=()=>{
      if(!confirm(window.uiT('revokeConfirm',{name:device.name})))return;
      withOperation('Revoking device…',async()=>{
        await api('/api/admin/zones/'+encodeURIComponent(activeZoneId)+'/devices/'+encodeURIComponent(device.deviceId),{
          method:'DELETE'
        });
        await openZone(activeZoneId);
        show('Device revoked.');
      });
    };

    actions.append(unlockMinutes,remoteUnlock,copy,rename,revoke);
    row.append(info,state,actions);
    host.appendChild(row);
  }
}

$('createZone').onclick=()=>withOperation('Creating Zone…',async()=>{
  hide();
  const data=await api('/api/admin/zones',{
    method:'POST',
    headers:jsonHeaders,
    body:JSON.stringify({name:$('createName').value.trim()})
  });
  $('created').className='';
  renderCredentials(data);
  await loadZones();
  await openZone(data.zoneId);
  show('Zone created. Save the one-time credentials.');
});

$('importZone').onclick=()=>withOperation('Importing Zone…',async()=>{
  hide();
  const zoneId=$('importZoneId').value.trim();
  const zoneAdminToken=$('importZoneToken').value.trim();
  await api('/api/admin/zones/import',{
    method:'POST',
    headers:jsonHeaders,
    body:JSON.stringify({zoneId,zoneAdminToken})
  });
  $('importZoneToken').value='';
  await loadZones();
  await openZone(zoneId);
  show('Existing Zone imported into the Relay Admin registry.');
});

$('makeJoin').onclick=()=>withOperation('Creating Join Code…',async()=>{
  const data=await api('/api/admin/zones/'+encodeURIComponent(activeZoneId)+'/join-codes',{
    method:'POST',
    headers:jsonHeaders,
    body:JSON.stringify({ttlMinutes:10})
  });
  await openZone(activeZoneId);
  $('joinResult').className='';
  renderJoin(data);
  show('One-time Join Code created.');
});

$('rotateConnector').onclick=()=>{
  if(!confirm(window.uiT('Rotate this Zone connector? The previous Zone MCP URL stops working immediately.')))return;
  withOperation('Rotating connector…',async()=>{
    const data=await api('/api/admin/zones/'+encodeURIComponent(activeZoneId)+'/connector',{
      method:'POST'
    });
    $('connectorResult').className='';
    renderConnector(data);
    show('Zone connector rotated. Copy the new URL into ChatGPT.');
  });
};

const currentToolNames=[...new Set(Object.values(ownerToolGroups).flat())];
function compactTools(tools){
  if(tools.includes('*'))return 'Legacy wildcard (*) — future enabled tools included';
  const remaining=new Set(tools);
  if(currentToolNames.length&&currentToolNames.every(t=>remaining.has(t))){
    return 'All current ('+currentToolNames.length+' tools)';
  }
  const parts=[];
  for(const [name,members] of Object.entries(ownerToolGroups)){
    if(members.every(t=>remaining.has(t))){
      parts.push(name);
      for(const tool of members)remaining.delete(tool);
    }
  }
  parts.push(...remaining);
  return parts.join(', ');
}
function toolDetails(tools){
  const details=document.createElement('details');
  const summary=document.createElement('summary');
  summary.textContent=compactTools(tools);
  const list=document.createElement('div');
  list.className='meta';
  list.textContent=tools.join(', ');
  details.append(summary,list);
  return details;
}
function toolGrantEditor(initial){
  const details=document.createElement('details');
  details.className='grant-editor';
  const summary=document.createElement('summary');
  summary.textContent='Choose permitted tools';
  details.appendChild(summary);
  const initialWildcard=initial.includes('*');
  let touched=false;
  let selected=new Set(initialWildcard?currentToolNames:initial);
  const buttons=document.createElement('div');buttons.className='grant-actions';
  const grid=document.createElement('div');grid.className='grant-grid';
  const preview=document.createElement('div');preview.className='grant-preview';
  const inputs=[];
  const refresh=()=>{
    for(const input of inputs)input.checked=selected.has(input.value);
    preview.textContent=initialWildcard&&!touched
      ?'Existing dynamic wildcard (*) unchanged. Editing the selection creates an explicit current-tool grant.'
      :compactTools([...selected])||'Select at least one tool';
  };
  const add=(label,fn)=>{
    const button=document.createElement('button');button.type='button';
    button.className='secondary';button.textContent=label;
    button.onclick=()=>{touched=true;fn();refresh();};buttons.appendChild(button);
  };
  add('Requested/granted only',()=>selected=new Set(initial.includes('*')?currentToolNames:initial));
  for(const [name,members] of Object.entries(ownerToolGroups))add('Add '+name,()=>members.forEach(t=>selected.add(t)));
  add('All current tools',()=>selected=new Set(currentToolNames));
  add('Clear',()=>selected.clear());
  for(const name of currentToolNames){
    const input=document.createElement('input');input.type='checkbox';input.value=name;
    const label=document.createElement('label');label.append(input,document.createTextNode(name));
    input.onchange=()=>{touched=true;if(input.checked)selected.add(name);else selected.delete(name);refresh();};
    grid.append(label);inputs.push(input);
  }
  details.append(buttons,grid,preview);refresh();
  return {details,get:()=>initialWildcard&&!touched?['*']:[...selected]};
}
async function loadAgentSessions(){
  const data=await api('/api/admin/agent-sessions');
  const host=$('agentSessions');
  host.textContent='';
  if(!data.sessions.length){
    const message=document.createElement('p');
    message.textContent='No Agent Session requests yet.';
    host.appendChild(message);
    return;
  }
  const notice=document.createElement('p');
  notice.className='meta';
  notice.textContent='Group approvals cover the tools in that group today; new tools added later are not granted automatically.';
  host.appendChild(notice);
  for(const session of data.sessions){
    const row=document.createElement('div');
    row.className='session-row';
    const info=document.createElement('div');
    info.className='session-info';
    const title=document.createElement('div');
    title.className='name';
    title.textContent=(session.connectorKind==='zone'?'Zone ':'Device ')
      +session.connectorId+' · '+session.state.toUpperCase();
    info.appendChild(title);
    const scope=document.createElement('div');
    scope.className='meta';
    scope.textContent='Scope: '+(session.scope==='zone/all'?'ENTIRE ZONE (including devices enrolled in the future)':session.scope)
      +(session.scope==='devices'?' ('+session.devices.join(', ')+')':'')
      +' · Requested tools: '+compactTools(session.requestedTools||session.tools)
      +(session.state==='approved'?' · Granted tools: '+compactTools(session.tools):'');
    info.appendChild(scope);
    const requestedDetails=toolDetails(session.requestedTools||session.tools);
    info.appendChild(requestedDetails);
    // The owner, not the AI, determines the approval lifetime.
    // A 24h idle limit has no effect on a shorter absolute approval.
    const idleRelevant=Number.isInteger(session.approvedHours)
      &&session.approvedHours>session.idleHours;
    const identity=document.createElement('div');
    identity.className='meta';
    identity.textContent='Session ID: '+session.id
      +(session.approvedHours?' · Granted '+session.approvedHours+'h':' · Duration chosen by owner')
      +(idleRelevant?' · Idle '+session.idleHours+'h':'')
      +' · '+new Date(session.createdAt).toLocaleString();
    info.appendChild(identity);
    if(idleRelevant){
      const idleNote=document.createElement('div');
      idleNote.className='meta';
      idleNote.textContent='Activity extends the '+session.idleHours+'h idle timeout without new approval. No use for '+session.idleHours+'h ends this session, even if the overall approval has not expired.';
      info.appendChild(idleNote);
    }
    if(session.note){
      const note=document.createElement('div');
      note.className='meta';
      note.textContent='Purpose: '+session.note;
      info.appendChild(note);
    }
    if(session.state==='approved'){
      const expires=document.createElement('div');
      expires.className='meta';
      expires.textContent='Expires: '+new Date(session.hardUntil).toLocaleString()
        +(idleRelevant?' · Idle expiry: '+new Date(session.idleUntil).toLocaleString():'')
        +' · Last use: '+(session.lastUsedAt?new Date(session.lastUsedAt).toLocaleString():'Never');
      info.appendChild(expires);
    }
    row.appendChild(info);
    const actions=document.createElement('div');
    actions.className='session-actions';
    if(session.state==='pending'){
      const label=document.createElement('label');
      label.textContent='Grant duration (hours, 1–720; maximum 30 days)';
      const hours=document.createElement('input');
      hours.type='number';
      hours.min='1';hours.max='720';hours.step='1';
      hours.value='1';
      label.appendChild(hours);
      actions.appendChild(label);

      const idleLabel=document.createElement('label');
      idleLabel.textContent='Inactivity timeout';
      const idleSelect=document.createElement('select');
      for(const value of [24,48]){
        const option=document.createElement('option');
        option.value=String(value);
        option.textContent=value+' hours';
        idleSelect.appendChild(option);
      }
      idleSelect.value='24';
      idleLabel.appendChild(idleSelect);
      const updateIdleVisibility=()=>{
        idleLabel.className=Number(hours.value)>24?'':'hidden';
      };
      hours.addEventListener('input',updateIdleVisibility);
      updateIdleVisibility();
      actions.appendChild(idleLabel);

      // Requested scopes/devices are fixed; only an independently signed-in
      // owner may explicitly widen or narrow the allowed tool operations.
      // Defaults remain exactly the AI request (least privilege).
      const originallyRequested=session.requestedTools||session.tools;
      const toolNames=[...new Set(Object.values(ownerToolGroups).flat())];
      // Previously pending wildcard requests may still exist. The owner UI
      // converts them to an explicit snapshot, never a new wildcard grant.
      const requestedSelection=()=>new Set(
        originallyRequested.includes('*')?toolNames:originallyRequested
      );
      let selectedTools=requestedSelection();
      const editor=document.createElement('details');
      editor.className='grant-editor';
      const summary=document.createElement('summary');
      summary.textContent='Choose permitted tools (defaults to requested)';
      editor.appendChild(summary);
      const presets=document.createElement('div');
      presets.className='grant-actions';
      const checklist=document.createElement('div');
      checklist.className='grant-grid';
      const preview=document.createElement('div');
      preview.className='grant-preview';
      const checkboxes=[];
      const refreshSelection=()=>{
        const all=toolNames.every(name=>selectedTools.has(name));
        for(const checkbox of checkboxes){
          checkbox.checked=selectedTools.has(checkbox.value);
        }
        preview.textContent='Owner will grant: '
          +(all?'ALL '+toolNames.length+' currently known tools (future tools NOT included)'
            :([...selectedTools].join(', ')||'NONE — choose at least one'));
        if(originallyRequested[0]!=='*'
          && [...selectedTools].some(name=>!originallyRequested.includes(name))){
          preview.textContent+=' · This grants MORE tools than the AI requested.';
        }
      };
      const presetButton=(label,run)=>{
        const button=document.createElement('button');
        button.type='button';
        button.className='secondary';
        button.textContent=label;
        button.onclick=()=>{run();refreshSelection();};
        presets.appendChild(button);
      };
      presetButton('Requested only',()=>{selectedTools=requestedSelection();});
      for(const [group,names] of Object.entries(ownerToolGroups)){
        presetButton('Add '+group,()=>{
          for(const name of names)selectedTools.add(name);
        });
      }
      presetButton('All current tools',()=>{selectedTools=new Set(toolNames);});
      presetButton('Clear',()=>{selectedTools.clear();});
      for(const name of toolNames){
        const checkbox=document.createElement('input');
        checkbox.type='checkbox';
        checkbox.value=name;
        const label=document.createElement('label');
        label.append(checkbox,document.createTextNode(name));
        checkbox.onchange=()=>{
          if(checkbox.checked)selectedTools.add(name);
          else selectedTools.delete(name);
          refreshSelection();
        };
        checklist.appendChild(label);
        checkboxes.push(checkbox);
      }
      editor.append(presets,checklist,preview);
      refreshSelection();
      actions.appendChild(editor);

      const approve=document.createElement('button');
      approve.textContent='Approve';
      approve.onclick=()=>{
        const duration=Number(hours.value);
        if(!Number.isInteger(duration)||duration<1||duration>720){
          show('Grant duration must be between 1 and 720 hours',true);return;
        }
        const idleHours=duration>24?Number(idleSelect.value):24;
        if(idleHours!==24&&idleHours!==48){
          show('Invalid inactivity timeout',true);return;
        }
        const approvedTools=[...selectedTools];
        if(!approvedTools.length){
          show('Select at least one permitted tool',true);return;
        }
        withOperation('Approving Agent Session…',async()=>{
          await api('/api/admin/agent-sessions/'+session.id+'/approve',{
            method:'POST',headers:jsonHeaders,body:JSON.stringify({
              approvedHours:duration,idleHours,approvedTools
            })
          });
          await loadAgentSessions();
          show('Agent Session approved for '+duration+' hours.');
        });
      };
      const reject=document.createElement('button');
      reject.className='secondary';reject.textContent='Reject';
      reject.onclick=()=>{
        if(!window.confirm('Reject this Agent Session?'))return;
        withOperation('Rejecting Agent Session…',async()=>{
          await api('/api/admin/agent-sessions/'+session.id+'/reject',{method:'POST'});
          await loadAgentSessions();show('Agent Session rejected.');
        });
      };
      actions.append(approve,reject);
    }else if(session.state==='approved'){
      const permissionEditor=toolGrantEditor(session.tools);
      actions.appendChild(permissionEditor.details);
      const edit=document.createElement('button');edit.className='secondary';
      edit.textContent='Edit permissions';
      edit.onclick=()=>{
        const approvedTools=permissionEditor.get();
        if(approvedTools.includes('*')){
          show('Existing wildcard remains active. Change the tool selection to save an explicit current-tool grant.',true);
          return;
        }
        if(!approvedTools.length){show('Choose at least one tool',true);return;}
        withOperation('Editing Agent Session…',async()=>{
          await api('/api/admin/agent-sessions/'+session.id+'/edit',{
            method:'POST',headers:jsonHeaders,body:JSON.stringify({approvedTools})
          });
          await loadAgentSessions();show('Permissions updated for future calls.');
        });
      };
      const extension=document.createElement('label');
      extension.textContent='New expiry from now (1–720 hours)';
      const hours=document.createElement('input');hours.type='number';
      hours.min='1';hours.max='720';hours.step='1';hours.value='1';
      extension.appendChild(hours);
      const extend=document.createElement('button');extend.className='secondary';
      extend.textContent='Extend';
      extend.onclick=()=>{
        const approvedHours=Number(hours.value);
        if(!Number.isInteger(approvedHours)||approvedHours<1||approvedHours>720){
          show('Extension must be between 1 and 720 hours',true);return;
        }
        withOperation('Extending Agent Session…',async()=>{
          await api('/api/admin/agent-sessions/'+session.id+'/extend',{
            method:'POST',headers:jsonHeaders,body:JSON.stringify({approvedHours})
          });
          await loadAgentSessions();show('Session expiry updated from now.');
        });
      };
      actions.append(edit,extension,extend);
      const revoke=document.createElement('button');
      revoke.className='danger';revoke.textContent='Revoke Session';
      revoke.onclick=()=>{
        if(!window.confirm('Revoke this Agent Session immediately?'))return;
        withOperation('Revoking Agent Session…',async()=>{
          const result=await api('/api/admin/agent-sessions/'+session.id+'/revoke',{method:'POST'});
          await loadAgentSessions();
          show('Agent Session revoked. Best-effort cancellation requested for '
            +(result.cancellation?.requestsSignalled??0)+' in-flight request(s).');
        });
      };
      actions.appendChild(revoke);
    }
    row.appendChild(actions);
    host.appendChild(row);
  }
}
$('refreshAgentSessions').onclick=()=>withOperation('Refreshing Agent Sessions…',loadAgentSessions);

$('refreshZones').onclick=()=>withOperation('Refreshing Zones…',async()=>{
  await loadZones();
  show('Zone list refreshed.');
});
$('closeZone').onclick=()=>{
  activeZoneId='';
  $('zonePanel').className='card hidden';
};
$('logout').onclick=()=>withOperation('Signing out…',async()=>{
  await api('/api/admin/logout',{method:'POST'});
  location.reload();
});

withOperation('Loading Relay Admin…',async()=>{await loadZones();await loadAgentSessions();});
`
  );
}
