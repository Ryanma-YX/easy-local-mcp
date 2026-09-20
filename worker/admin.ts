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
.small{font-size:12px}
@media(max-width:680px){.device{grid-template-columns:1fr}.zone{align-items:flex-start;flex-direction:column}.device .actions{margin-top:0}.copy-row{grid-template-columns:1fr auto}.copy-label{grid-column:1/-1}}
`;

function shell(title:string,body:string,script=''){
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${styles}</style>
</head>
<body>
<main>
${body}
</main>
<div id="operationOverlay" hidden aria-live="polite" aria-busy="true">
  <div class="operation-panel">
    <span class="operation-spinner" aria-hidden="true"></span>
    <span id="operationText">Processing…</span>
  </div>
</div>
${script?`<script>${script}</script>`:''}
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
`
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
  node.textContent=text;
  node.className=error?'error':'';
  clearTimeout(show.timer);
  show.timer=setTimeout(()=>node.className='hidden',4500);
};
let operationActive=false;
const withOperation=async(label,task)=>{
  if(operationActive)return;
  operationActive=true;
  $('operationText').textContent=label||'Processing…';
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
`
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
  node.textContent=text;
  node.className=error?'error':'';
  clearTimeout(show.timer);
  show.timer=setTimeout(()=>node.className='hidden',4500);
};
const hide=()=>{$('message').className='hidden'};
let operationActive=false;
const withOperation=async(label,task)=>{
  if(operationActive)return;
  operationActive=true;
  $('operationText').textContent=label||'Processing…';
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
    throw new Error('Admin session expired. Sign in again.');
  }
  if(!response.ok)throw new Error(body.error||('Request failed: '+response.status));
  return body;
}
const jsonHeaders={'Content-Type':'application/json'};

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
    throw new Error('Copy failed. Please copy the value manually.');
  }
  input.remove();
}
async function copyText(value,label){
  try{
    await writeClipboard(value);
    show((label||'Value')+' copied.');
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
  expiry.textContent='Expires: '+new Date(data.expiresAt).toLocaleString();
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
    meta.textContent=zone.zoneId+' · created '+new Date(zone.createdAt).toLocaleString();
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
    open.onclick=()=>withOperation('Loading Zone…',()=>openZone(zone.zoneId));
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
  $('zoneMeta').textContent=data.devices.length+' device(s) · '+data.activeJoinCodes+' active join code(s) · Connector '+(data.connectorConfigured?'ready':'not configured');
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
    status.textContent=device.online?'Online':'Offline';
    const joined=document.createElement('div');
    joined.className='meta';
    joined.textContent='Joined '+new Date(device.joinedAt).toLocaleString();
    state.append(status,joined);

    const actions=document.createElement('div');
    actions.className='actions';

    const unlockMinutes=document.createElement('select');
    unlockMinutes.setAttribute('aria-label','Remote unlock duration');
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
      'Remotely unlocking '+device.name+'…',
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
          device.name+' remotely unlocked for '+minutes+' minutes'
            +(result.expiresAt
              ? ' · expires '+new Date(result.expiresAt).toLocaleString()
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
      const next=prompt('Device name',device.name);
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
      if(!confirm('Revoke '+device.name+' and invalidate its Relay credentials?'))return;
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
  if(!confirm('Rotate this Zone connector? The previous Zone MCP URL stops working immediately.'))return;
  withOperation('Rotating connector…',async()=>{
    const data=await api('/api/admin/zones/'+encodeURIComponent(activeZoneId)+'/connector',{
      method:'POST'
    });
    $('connectorResult').className='';
    renderConnector(data);
    show('Zone connector rotated. Copy the new URL into ChatGPT.');
  });
};

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

withOperation('Loading Zones…',loadZones);
`
  );
}
