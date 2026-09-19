export function adminPage(){
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Easy Local MCP Zones</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fb}
body{margin:0}
main{max-width:960px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:28px;margin:0 0 8px}
h2{font-size:18px;margin:0 0 16px}
p{color:#5d6678}
.card{background:white;border:1px solid #e1e6ef;border-radius:14px;padding:20px;margin:16px 0;box-shadow:0 2px 8px rgba(23,32,51,.04)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
label{display:block;font-size:12px;font-weight:700;color:#566176;margin-bottom:6px}
input{box-sizing:border-box;width:100%;border:1px solid #ccd4e1;border-radius:9px;padding:10px 12px;font:inherit;background:white}
button{border:0;border-radius:9px;padding:10px 14px;font:inherit;font-weight:700;cursor:pointer;background:#2458d3;color:white}
button.secondary{background:#eef2f8;color:#263248}
button.danger{background:#fff0f0;color:#a72727}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.device{display:grid;grid-template-columns:minmax(180px,1fr) minmax(160px,1fr) auto;gap:12px;align-items:center;padding:14px 0;border-top:1px solid #edf0f5}
.device:first-child{border-top:0}
.name{font-weight:800}
.meta{font-size:13px;color:#687386}
.status{font-size:12px;font-weight:800}
.online{color:#18794e}.offline{color:#8a5d00}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;background:#f4f6fa;border-radius:9px;padding:12px;margin-top:12px}
.hidden{display:none}
.message{margin-top:12px;padding:10px 12px;border-radius:9px;background:#eef5ff;color:#24416d}
.error{background:#fff0f0;color:#982929}
@media(max-width:680px){.device{grid-template-columns:1fr}.device .actions{margin-top:0}}
</style>
</head>
<body>
<main>
<h1>Easy Local MCP Zones</h1>
<p>Manage groups of LocalMCP devices. Zone administration is separate from device MCP credentials.</p>

<section class="card">
<h2>Create Zone</h2>
<div class="grid">
<div><label>Zone name</label><input id="createName" value="My Devices" maxlength="80"></div>
<div><label>Relay registration token (only if required)</label><input id="registrationToken" type="password"></div>
</div>
<div class="actions"><button id="createZone">Create Zone</button></div>
<div id="created" class="hidden">
<p>Save the administrator token now. It is not recoverable from the Relay.</p>
<div id="createdValues" class="code"></div>
</div>
</section>

<section class="card">
<h2>Open Zone</h2>
<div class="grid">
<div><label>Zone ID</label><input id="zoneId" autocomplete="off"></div>
<div><label>Admin token</label><input id="adminToken" type="password" autocomplete="off"></div>
</div>
<div class="actions"><button id="loadZone">Load Zone</button><button id="makeJoin" class="secondary">Create Join Code</button></div>
<div id="joinResult" class="hidden">
<p>Join codes are one-time credentials and expire after 10 minutes.</p>
<div id="joinCode" class="code"></div>
</div>
</section>

<section id="zonePanel" class="card hidden">
<h2 id="zoneName">Zone</h2>
<p id="zoneMeta"></p>
<div id="devices"></div>
</section>

<div id="message" class="message hidden"></div>
</main>
<script>
const $=id=>document.getElementById(id);
const message=(text,error=false)=>{
  const el=$('message');
  el.textContent=text;
  el.className='message'+(error?' error':'');
};
const hideMessage=()=>{$('message').className='message hidden'};
const authHeaders=()=>({
  'Content-Type':'application/json',
  'Authorization':'Bearer '+$('adminToken').value.trim()
});
const zonePath=()=>'/api/zones/'+encodeURIComponent($('zoneId').value.trim());

async function api(path,options={}){
  const response=await fetch(path,options);
  const text=await response.text();
  let body={};
  try{body=text?JSON.parse(text):{}}catch{}
  if(!response.ok)throw new Error(body.error||('Request failed: '+response.status));
  return body;
}

async function load(){
  hideMessage();
  const zoneId=$('zoneId').value.trim();
  const token=$('adminToken').value.trim();
  if(!zoneId||!token)throw new Error('Zone ID and admin token are required.');
  const data=await api(zonePath(),{headers:authHeaders()});
  $('zonePanel').className='card';
  $('zoneName').textContent=data.name;
  $('zoneMeta').textContent='Zone '+data.zoneId+' · '+data.devices.length+' device(s) · '+data.activeJoinCodes+' active join code(s)';
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
        await api(zonePath()+'/devices/'+encodeURIComponent(device.deviceId),{
          method:'PATCH',
          headers:authHeaders(),
          body:JSON.stringify({name:next})
        });
        await load();
        message('Device renamed.');
      }catch(error){message(error.message,true)}
    };
    const revoke=document.createElement('button');
    revoke.className='danger';
    revoke.textContent='Revoke';
    revoke.onclick=async()=>{
      if(!confirm('Revoke '+device.name+' from this Zone and invalidate its Relay credentials?'))return;
      try{
        await api(zonePath()+'/devices/'+encodeURIComponent(device.deviceId),{
          method:'DELETE',
          headers:authHeaders()
        });
        await load();
        message('Device revoked.');
      }catch(error){message(error.message,true)}
    };
    actions.append(rename,revoke);
    row.append(info,state,actions);
    host.appendChild(row);
  }
}

$('createZone').onclick=async()=>{
  try{
    hideMessage();
    const headers={'Content-Type':'application/json'};
    const registrationToken=$('registrationToken').value.trim();
    if(registrationToken)headers.Authorization='Bearer '+registrationToken;
    const data=await api('/api/zones',{
      method:'POST',
      headers,
      body:JSON.stringify({name:$('createName').value.trim()})
    });
    $('zoneId').value=data.zoneId;
    $('adminToken').value=data.adminToken;
    $('created').className='';
    $('createdValues').textContent='Zone ID: '+data.zoneId+'\nAdmin token: '+data.adminToken;
    await load();
    message('Zone created. Save the administrator token.');
  }catch(error){message(error.message,true)}
};

$('loadZone').onclick=()=>load().catch(error=>message(error.message,true));

$('makeJoin').onclick=async()=>{
  try{
    hideMessage();
    const data=await api(zonePath()+'/join-codes',{
      method:'POST',
      headers:authHeaders(),
      body:JSON.stringify({ttlMinutes:10})
    });
    $('joinResult').className='';
    $('joinCode').textContent=data.code+'\nExpires: '+new Date(data.expiresAt).toLocaleString();
    await load();
    message('One-time join code created.');
  }catch(error){message(error.message,true)}
};
</script>
</body>
</html>`;
}
