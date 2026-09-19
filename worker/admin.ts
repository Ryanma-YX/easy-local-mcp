const styles=`
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fb}
body{margin:0}
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
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.zone{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 0;border-top:1px solid #edf0f5}
.zone:first-child{border-top:0}
.device{display:grid;grid-template-columns:minmax(180px,1fr) minmax(160px,1fr) auto;gap:12px;align-items:center;padding:14px 0;border-top:1px solid #edf0f5}
.device:first-child{border-top:0}
.name{font-weight:800}
.meta{font-size:13px;color:#687386}
.status{font-size:12px;font-weight:800}
.online{color:#18794e}.offline{color:#8a5d00}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;background:#f4f6fa;border-radius:9px;padding:12px;margin-top:12px;white-space:pre-wrap}
.hidden{display:none}
.message{margin-top:12px;padding:10px 12px;border-radius:9px;background:#eef5ff;color:#24416d}
.error{background:#fff0f0;color:#982929}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px}
.small{font-size:12px}
@media(max-width:680px){.device{grid-template-columns:1fr}.zone{align-items:flex-start;flex-direction:column}.device .actions{margin-top:0}}
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
<div id="message" class="message hidden"></div>
</div>
`,
    `
const token=document.getElementById('token');
const message=document.getElementById('message');
const show=(text,error=false)=>{
  message.textContent=text;
  message.className='message'+(error?' error':'');
};
async function login(){
  try{
    const response=await fetch('/api/admin/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:token.value})
    });
    const text=await response.text();
    let data={};
    try{data=text?JSON.parse(text):{}}catch{}
    if(!response.ok)throw new Error(data.error||'Sign in failed');
    location.reload();
  }catch(error){
    show(error.message,true);
  }
}
document.getElementById('login').onclick=login;
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
<div id="createdValues" class="code"></div>
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
<div class="actions">
<button id="makeJoin">Create Join Code</button>
<button id="rotateConnector" class="secondary">Rotate Connector</button>
</div>
<div id="joinResult" class="hidden">
<p>Join codes are one-time credentials and expire after 10 minutes.</p>
<div id="joinCode" class="code"></div>
</div>
<div id="connectorResult" class="hidden">
<p>The old Zone MCP URL becomes invalid immediately after rotation.</p>
<div id="connectorUrl" class="code"></div>
</div>
<div id="devices"></div>
</section>

<div id="message" class="message hidden"></div>
`,
    `
const $=id=>document.getElementById(id);
let activeZoneId='';
const show=(text,error=false)=>{
  const el=$('message');
  el.textContent=text;
  el.className='message'+(error?' error':'');
};
const hide=()=>{$('message').className='message hidden'};
async function api(path,options={}){
  const response=await fetch(path,options);
  const text=await response.text();
  let body={};
  try{body=text?JSON.parse(text):{}}catch{}
  if(!response.ok)throw new Error(body.error||('Request failed: '+response.status));
  return body;
}
const jsonHeaders={'Content-Type':'application/json'};

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
    const open=document.createElement('button');
    open.className='secondary';
    open.textContent='Manage';
    open.onclick=()=>openZone(zone.zoneId).catch(error=>show(error.message,true));
    row.append(info,open);
    host.appendChild(row);
  }
}

async function openZone(zoneId){
  hide();
  const data=await api('/api/admin/zones/'+encodeURIComponent(zoneId));
  activeZoneId=zoneId;
  $('zonePanel').className='card';
  $('zoneName').textContent=data.name;
  $('zoneMeta').textContent='Zone '+data.zoneId+' · '+data.devices.length+' device(s) · '+data.activeJoinCodes+' active join code(s) · Connector '+(data.connectorConfigured?'ready':'not configured');
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
    meta.textContent=[device.platform,device.arch,device.version].filter(Boolean).join(' · ')||device.deviceId;
    info.append(name,meta);

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

    const rename=document.createElement('button');
    rename.className='secondary';
    rename.textContent='Rename';
    rename.onclick=async()=>{
      const next=prompt('Device name',device.name);
      if(!next||next===device.name)return;
      try{
        await api('/api/admin/zones/'+encodeURIComponent(activeZoneId)+'/devices/'+encodeURIComponent(device.deviceId),{
          method:'PATCH',
          headers:jsonHeaders,
          body:JSON.stringify({name:next})
        });
        await openZone(activeZoneId);
        show('Device renamed.');
      }catch(error){show(error.message,true)}
    };

    const revoke=document.createElement('button');
    revoke.className='danger';
    revoke.textContent='Revoke';
    revoke.onclick=async()=>{
      if(!confirm('Revoke '+device.name+' and invalidate its Relay credentials?'))return;
      try{
        await api('/api/admin/zones/'+encodeURIComponent(activeZoneId)+'/devices/'+encodeURIComponent(device.deviceId),{
          method:'DELETE'
        });
        await openZone(activeZoneId);
        show('Device revoked.');
      }catch(error){show(error.message,true)}
    };

    actions.append(rename,revoke);
    row.append(info,state,actions);
    host.appendChild(row);
  }
}

$('createZone').onclick=async()=>{
  try{
    hide();
    const data=await api('/api/admin/zones',{
      method:'POST',
      headers:jsonHeaders,
      body:JSON.stringify({name:$('createName').value.trim()})
    });
    $('created').className='';
    $('createdValues').textContent=
      'Zone ID: '+data.zoneId+'\\n'
      +'Zone Admin Token: '+data.adminToken+'\\n'
      +'Zone MCP URL: '+data.mcpUrl;
    await loadZones();
    await openZone(data.zoneId);
    show('Zone created. Save the one-time credentials.');
  }catch(error){show(error.message,true)}
};

$('importZone').onclick=async()=>{
  try{
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
  }catch(error){show(error.message,true)}
};

$('makeJoin').onclick=async()=>{
  try{
    const data=await api('/api/admin/zones/'+encodeURIComponent(activeZoneId)+'/join-codes',{
      method:'POST',
      headers:jsonHeaders,
      body:JSON.stringify({ttlMinutes:10})
    });
    $('joinResult').className='';
    $('joinCode').textContent=data.code+'\\nExpires: '+new Date(data.expiresAt).toLocaleString();
    await openZone(activeZoneId);
    $('joinResult').className='';
    $('joinCode').textContent=data.code+'\\nExpires: '+new Date(data.expiresAt).toLocaleString();
    show('One-time Join Code created.');
  }catch(error){show(error.message,true)}
};

$('rotateConnector').onclick=async()=>{
  try{
    if(!confirm('Rotate this Zone connector? The previous Zone MCP URL stops working immediately.'))return;
    const data=await api('/api/admin/zones/'+encodeURIComponent(activeZoneId)+'/connector',{
      method:'POST'
    });
    $('connectorResult').className='';
    $('connectorUrl').textContent=data.mcpUrl;
    show('Zone connector rotated. Update ChatGPT to the new URL.');
  }catch(error){show(error.message,true)}
};

$('refreshZones').onclick=()=>loadZones().catch(error=>show(error.message,true));
$('closeZone').onclick=()=>{
  activeZoneId='';
  $('zonePanel').className='card hidden';
};
$('logout').onclick=async()=>{
  try{
    await api('/api/admin/logout',{method:'POST'});
  }finally{
    location.reload();
  }
};

loadZones().catch(error=>show(error.message,true));
`
  );
}
