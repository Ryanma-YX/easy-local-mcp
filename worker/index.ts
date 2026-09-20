import { adminLoginPage, adminPage, adminSetupRequiredPage } from './admin';
import {
  adminCookie,
  adminSession,
  clearAdminCookie,
  createAdminSession,
  deleteAdminSession,
  listRegisteredZones,
  registerZone
} from './admin-session';
import { handleZoneMcp } from './zone-mcp';
export { RelayAdmin } from './relay-admin';
export { ZoneManager } from './zone';
import {
  Assembly,
  frames,
  parseFrame,
  MAX_CONCURRENT_REQUESTS,
  MAX_CONTROL_REQUESTS,
  isConcurrentReadRequest
} from '../src/relay-protocol';
interface Env {
  RELAY:DurableObjectNamespace;
  ZONE:DurableObjectNamespace;
  ADMIN:DurableObjectNamespace;
  MCP_TOKEN_HASH?:string;
  AGENT_TOKEN_HASH?:string;
  REGISTRATION_TOKEN_HASH?:string;
  RELAY_ADMIN_TOKEN_HASH?:string;
}

const json=(data:unknown,status=200)=>Response.json(
  data,
  {
    status,
    headers:{
      'Cache-Control':'no-store'
    }
  }
);

const sha256=async(value:string)=>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(value)
      )
    ),
    byte=>byte.toString(16).padStart(2,'0')
  ).join('');

async function authorized(token:string,expected?:string){
  if(
    !expected
    || !/^[a-f0-9]{64}$/.test(expected)
    || token.length>256
  ){
    return false;
  }

  const hash=await sha256(token);
  let diff=0;

  for(let i=0;i<64;i++){
    diff|=hash.charCodeAt(i)^expected.charCodeAt(i);
  }

  return diff===0;
}

function bearer(request:Request){
  return request.headers.get('Authorization')?.replace(/^Bearer /,'')||'';
}

function randomHex(bytes=32){
  const data=new Uint8Array(bytes);
  crypto.getRandomValues(data);

  return Array.from(
    data,
    byte=>byte.toString(16).padStart(2,'0')
  ).join('');
}

async function bodyText(request:Request,limit:number){
  const reader=request.body?.getReader();
  if(!reader)return'';

  const chunks:Uint8Array[]=[];
  let size=0;

  try{
    while(true){
      const {value,done}=await reader.read();
      if(done)break;

      size+=value.length;

      if(size>limit){
        await reader.cancel();
        throw new Error('Request too large');
      }

      chunks.push(value);
    }
  }finally{
    reader.releaseLock();
  }

  const bytes=new Uint8Array(size);
  let offset=0;

  for(const chunk of chunks){
    bytes.set(chunk,offset);
    offset+=chunk.length;
  }

  return new TextDecoder().decode(bytes);
}

function relay(env:Env,deviceId:string){
  return env.RELAY.get(env.RELAY.idFromName(deviceId));
}

function zone(env:Env,zoneId:string){
  return env.ZONE.get(env.ZONE.idFromName(zoneId));
}

function validUuid(value:string){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sameOriginAllowed(request:Request,url:URL){
  const origin=request.headers.get('Origin');
  return !origin||origin===url.origin;
}

async function createRegistration(
  env:Env,
  origin:string,
  deviceId=crypto.randomUUID()
){
  const agentToken=randomHex();
  const mcpToken=randomHex();

  const response=await relay(env,deviceId).fetch(
    new Request(
      'https://relay.internal/register',
      {
        method:'POST',
        headers:{
          'x-agent-hash':await sha256(agentToken),
          'x-mcp-hash':await sha256(mcpToken)
        }
      }
    )
  );

  if(!response.ok){
    throw new Error('Registration failed');
  }

  return {
    deviceId,
    agentToken,
    mcpToken,
    workerUrl:origin,
    mcpUrl:`${origin}/mcp/${deviceId}/${mcpToken}`
  };
}

function adminHtml(content:string){
  return new Response(
    content,
    {
      headers:{
        'Content-Type':'text/html; charset=utf-8',
        'Cache-Control':'no-store',
        'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
      }
    }
  );
}

function relayAdminConfigured(env:Env){
  return !!env.RELAY_ADMIN_TOKEN_HASH
    && /^[a-f0-9]{64}$/.test(env.RELAY_ADMIN_TOKEN_HASH);
}

async function relayAdminAuthorized(request:Request,env:Env){
  if(!relayAdminConfigured(env))return false;
  return (await adminSession(request,env)).authenticated;
}

async function createZone(
  env:Env,
  origin:string,
  name:unknown
){
  const zoneId=crypto.randomUUID();
  const adminToken=randomHex();
  const mcpToken=randomHex();
  const response=await zone(env,zoneId).fetch(
    new Request(
      'https://zone.internal/create',
      {
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          'x-zone-admin-hash':await sha256(adminToken),
          'x-zone-mcp-hash':await sha256(mcpToken)
        },
        body:JSON.stringify({name})
      }
    )
  );

  if(!response.ok)return response;

  const created=await response.json() as {
    name:string;
    createdAt:string;
  };

  await registerZone(
    env,
    {
      zoneId,
      name:created.name,
      createdAt:created.createdAt
    }
  );

  return json(
    {
      zoneId,
      adminToken,
      mcpToken,
      mcpUrl:`${origin}/mcp/z/${zoneId}/${mcpToken}`,
      name:created.name,
      createdAt:created.createdAt,
      adminUrl:`${origin}/admin`
    },
    201
  );
}

async function zoneInfo(
  env:Env,
  zoneId:string,
  headers:HeadersInit
){
  const response=await zone(env,zoneId).fetch(
    new Request(
      'https://zone.internal/info',
      {headers}
    )
  );

  if(!response.ok)return response;

  const info=await response.json() as {
    name:string;
    createdAt:string;
    activeJoinCodes:number;
    connectorConfigured:boolean;
    devices:Array<{
      deviceId:string;
      name:string;
      platform?:string;
      arch?:string;
      version?:string;
      joinedAt:string;
    }>;
  };

  const devices=await Promise.all(
    info.devices.map(async device=>{
      const status=await relay(env,device.deviceId).fetch(
        new Request(
          'https://relay.internal/status',
          {
            headers:{
              'x-localmcp-internal':'1'
            }
          }
        )
      );

      let online=false;
      if(status.ok){
        const data=await status.json() as {online?:boolean};
        online=data.online===true;
      }

      return {
        ...device,
        online
      };
    })
  );

  return json({
    zoneId,
    name:info.name,
    createdAt:info.createdAt,
    activeJoinCodes:info.activeJoinCodes,
    connectorConfigured:info.connectorConfigured,
    devices
  });
}

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url);

    if(url.pathname==='/healthz'&&request.method==='GET'){
      return json({
        ok:true,
        service:'easy-local-mcp-relay',
        registration:true,
        registrationProtected:!!env.REGISTRATION_TOKEN_HASH,
        relayAdminProtected:relayAdminConfigured(env),
        zones:true
      });
    }

    if(url.pathname==='/admin'&&request.method==='GET'){
      if(!relayAdminConfigured(env)){
        return adminHtml(adminSetupRequiredPage());
      }

      if(await relayAdminAuthorized(request,env)){
        return adminHtml(adminPage());
      }

      return adminHtml(adminLoginPage());
    }

    if(url.pathname==='/api/admin/login'&&request.method==='POST'){
      if(!sameOriginAllowed(request,url)){
        return json({error:'Origin not allowed'},403);
      }

      if(!relayAdminConfigured(env)){
        return json({error:'Relay admin authentication is not configured'},503);
      }

      let body:Record<string,unknown>;
      try{
        body=JSON.parse(await bodyText(request,16*1024)) as Record<string,unknown>;
      }catch{
        return json({error:'Invalid JSON'},400);
      }

      const token=typeof body.token==='string'?body.token:'';
      if(!await authorized(token,env.RELAY_ADMIN_TOKEN_HASH)){
        return json({error:'Invalid admin credential'},401);
      }

      const session=await createAdminSession(env);
      return new Response(
        JSON.stringify({ok:true,expiresAt:session.expiresAt}),
        {
          status:200,
          headers:{
            'Content-Type':'application/json',
            'Cache-Control':'no-store',
            'Set-Cookie':adminCookie(session.token)
          }
        }
      );
    }

    if(url.pathname==='/api/admin/logout'&&request.method==='POST'){
      if(!sameOriginAllowed(request,url)){
        return json({error:'Origin not allowed'},403);
      }

      await deleteAdminSession(request,env);
      return new Response(
        JSON.stringify({ok:true}),
        {
          headers:{
            'Content-Type':'application/json',
            'Cache-Control':'no-store',
            'Set-Cookie':clearAdminCookie()
          }
        }
      );
    }

    if(url.pathname==='/api/admin/session'&&request.method==='GET'){
      if(!relayAdminConfigured(env)){
        return json({authenticated:false,configured:false});
      }

      const session=await adminSession(request,env);
      return json(
        session.authenticated
          ? {authenticated:true,configured:true,expiresAt:session.expiresAt}
          : {authenticated:false,configured:true}
      );
    }

    if(url.pathname==='/api/admin/zones'){
      if(!sameOriginAllowed(request,url)){
        return json({error:'Origin not allowed'},403);
      }

      if(!await relayAdminAuthorized(request,env)){
        return json({error:'Authentication required'},401);
      }

      if(request.method==='GET'){
        return json(await listRegisteredZones(env));
      }

      if(request.method==='POST'){
        let body:Record<string,unknown>={};
        try{
          body=JSON.parse(await bodyText(request,16*1024)) as Record<string,unknown>;
        }catch{
          return json({error:'Invalid JSON'},400);
        }

        return createZone(env,url.origin,body.name);
      }

      return new Response(null,{status:405,headers:{Allow:'GET, POST'}});
    }

    if(url.pathname==='/api/admin/zones/import'&&request.method==='POST'){
      if(!sameOriginAllowed(request,url)){
        return json({error:'Origin not allowed'},403);
      }

      if(!await relayAdminAuthorized(request,env)){
        return json({error:'Authentication required'},401);
      }

      let body:Record<string,unknown>;
      try{
        body=JSON.parse(await bodyText(request,16*1024)) as Record<string,unknown>;
      }catch{
        return json({error:'Invalid JSON'},400);
      }

      const zoneId=typeof body.zoneId==='string'?body.zoneId.trim():'';
      const zoneAdminToken=
        typeof body.zoneAdminToken==='string'
          ? body.zoneAdminToken.trim()
          : '';

      if(!validUuid(zoneId)||!zoneAdminToken){
        return json({error:'Zone ID and Zone Admin Token are required'},400);
      }

      const response=await zone(env,zoneId).fetch(
        new Request(
          'https://zone.internal/info',
          {
            headers:{
              Authorization:`Bearer ${zoneAdminToken}`
            }
          }
        )
      );

      if(!response.ok){
        return json({error:'Zone not found or Zone Admin Token is invalid'},404);
      }

      const info=await response.json() as {
        name:string;
        createdAt:string;
      };

      await registerZone(
        env,
        {
          zoneId,
          name:info.name,
          createdAt:info.createdAt
        }
      );

      return json({
        ok:true,
        zone:{
          zoneId,
          name:info.name,
          createdAt:info.createdAt
        }
      });
    }

    const adminZoneMatch=/^\/api\/admin\/zones\/([0-9a-f-]{36})$/.exec(url.pathname);
    if(adminZoneMatch&&request.method==='GET'){
      if(!sameOriginAllowed(request,url)){
        return json({error:'Origin not allowed'},403);
      }

      if(!await relayAdminAuthorized(request,env)){
        return json({error:'Authentication required'},401);
      }

      const zoneId=adminZoneMatch[1];
      if(!validUuid(zoneId))return json({error:'Zone not found'},404);

      return zoneInfo(
        env,
        zoneId,
        {
          'x-localmcp-relay-admin':'1'
        }
      );
    }

    const adminJoinCodeMatch=/^\/api\/admin\/zones\/([0-9a-f-]{36})\/join-codes$/.exec(url.pathname);
    if(adminJoinCodeMatch&&request.method==='POST'){
      if(!sameOriginAllowed(request,url)){
        return json({error:'Origin not allowed'},403);
      }

      if(!await relayAdminAuthorized(request,env)){
        return json({error:'Authentication required'},401);
      }

      const zoneId=adminJoinCodeMatch[1];
      if(!validUuid(zoneId))return json({error:'Zone not found'},404);

      let body='{}';
      try{
        body=await bodyText(request,16*1024)||'{}';
        JSON.parse(body);
      }catch{
        return json({error:'Invalid JSON'},400);
      }

      const response=await zone(env,zoneId).fetch(
        new Request(
          'https://zone.internal/join-code',
          {
            method:'POST',
            headers:{
              'Content-Type':'application/json',
              'x-localmcp-relay-admin':'1'
            },
            body
          }
        )
      );

      if(!response.ok)return response;

      const data=await response.json() as {
        secret:string;
        expiresAt:string;
      };

      return json(
        {
          code:`${zoneId}.${data.secret}`,
          expiresAt:data.expiresAt
        },
        201
      );
    }

    const adminConnectorMatch=/^\/api\/admin\/zones\/([0-9a-f-]{36})\/connector$/.exec(url.pathname);
    if(adminConnectorMatch&&request.method==='POST'){
      if(!sameOriginAllowed(request,url)){
        return json({error:'Origin not allowed'},403);
      }

      if(!await relayAdminAuthorized(request,env)){
        return json({error:'Authentication required'},401);
      }

      const zoneId=adminConnectorMatch[1];
      if(!validUuid(zoneId))return json({error:'Zone not found'},404);

      const mcpToken=randomHex();
      const response=await zone(env,zoneId).fetch(
        new Request(
          'https://zone.internal/mcp-token',
          {
            method:'POST',
            headers:{
              'x-localmcp-relay-admin':'1',
              'x-zone-mcp-hash':await sha256(mcpToken)
            }
          }
        )
      );

      if(!response.ok)return response;

      return json({
        mcpToken,
        mcpUrl:`${url.origin}/mcp/z/${zoneId}/${mcpToken}`
      });
    }

    const adminDeviceUnlockMatch=/^\/api\/admin\/zones\/([0-9a-f-]{36})\/devices\/([0-9a-f-]{36})\/unlock$/.exec(url.pathname);
    if(adminDeviceUnlockMatch&&request.method==='POST'){
      if(!sameOriginAllowed(request,url)){
        return json({error:'Origin not allowed'},403);
      }

      if(!await relayAdminAuthorized(request,env)){
        return json({error:'Authentication required'},401);
      }

      const zoneId=adminDeviceUnlockMatch[1];
      const deviceId=adminDeviceUnlockMatch[2];
      if(!validUuid(zoneId)||!validUuid(deviceId)){
        return json({error:'Device not found'},404);
      }

      let body:Record<string,unknown>;
      try{
        body=JSON.parse(await bodyText(request,8*1024)) as Record<string,unknown>;
      }catch{
        return json({error:'Invalid JSON'},400);
      }

      const minutes=Number(body.minutes);
      if(![5,15,30,60].includes(minutes)){
        return json({
          error:'Remote unlock duration must be 5, 15, 30, or 60 minutes'
        },400);
      }

      const zoneResponse=await zone(env,zoneId).fetch(
        new Request(
          'https://zone.internal/info',
          {
            headers:{
              'x-localmcp-relay-admin':'1'
            }
          }
        )
      );
      if(!zoneResponse.ok)return zoneResponse;

      const zoneData=await zoneResponse.json() as {
        devices:Array<{deviceId:string}>;
      };
      if(!zoneData.devices.some(device=>device.deviceId===deviceId)){
        return json({error:'Device not found'},404);
      }

      return relay(env,deviceId).fetch(
        new Request(
          'https://relay.internal/remote-unlock',
          {
            method:'POST',
            headers:{
              'Content-Type':'application/json',
              'x-localmcp-internal':'1'
            },
            body:JSON.stringify({
              zoneId,
              minutes
            })
          }
        )
      );
    }

    const adminDeviceMatch=/^\/api\/admin\/zones\/([0-9a-f-]{36})\/devices\/([0-9a-f-]{36})$/.exec(url.pathname);
    if(adminDeviceMatch&&(request.method==='PATCH'||request.method==='DELETE')){
      if(!sameOriginAllowed(request,url)){
        return json({error:'Origin not allowed'},403);
      }

      if(!await relayAdminAuthorized(request,env)){
        return json({error:'Authentication required'},401);
      }

      const zoneId=adminDeviceMatch[1];
      const deviceId=adminDeviceMatch[2];

      if(!validUuid(zoneId)||!validUuid(deviceId)){
        return json({error:'Device not found'},404);
      }

      if(request.method==='PATCH'){
        let body:string;
        try{
          body=await bodyText(request,16*1024);
          JSON.parse(body);
        }catch{
          return json({error:'Invalid JSON'},400);
        }

        return zone(env,zoneId).fetch(
          new Request(
            `https://zone.internal/devices/${deviceId}`,
            {
              method:'PATCH',
              headers:{
                'Content-Type':'application/json',
                'x-localmcp-relay-admin':'1'
              },
              body
            }
          )
        );
      }

      const infoResponse=await zone(env,zoneId).fetch(
        new Request(
          'https://zone.internal/info',
          {
            headers:{
              'x-localmcp-relay-admin':'1'
            }
          }
        )
      );

      if(!infoResponse.ok)return infoResponse;

      const info=await infoResponse.json() as {
        devices:Array<{deviceId:string}>;
      };

      if(!info.devices.some(device=>device.deviceId===deviceId)){
        return json({error:'Device not found'},404);
      }
      const revoked=await relay(env,deviceId).fetch(
        new Request(
          'https://relay.internal/revoke',
          {
            method:'POST',
            headers:{
              'x-localmcp-internal':'1'
            }
          }
        )
      );

      if(!revoked.ok){
        return json({error:'Unable to revoke device credentials'},500);
      }
      return zone(env,zoneId).fetch(
        new Request(
          `https://zone.internal/devices/${deviceId}`,
          {
            method:'DELETE',
            headers:{
              'x-localmcp-relay-admin':'1'
            }
          }
        )
      );
    }

    if(url.pathname==='/api/zones'&&request.method==='POST'){
      return new Response(null,{status:404});
    }
    const zoneInfoMatch=/^\/api\/zones\/([0-9a-f-]{36})$/.exec(url.pathname);
    if(zoneInfoMatch&&request.method==='GET'){
      if(!sameOriginAllowed(request,url)){
        return json({error:'Origin not allowed'},403);
      }

      const zoneId=zoneInfoMatch[1];
      if(!validUuid(zoneId))return json({error:'Zone not found'},404);

      const response=await zone(env,zoneId).fetch(
        new Request(
          'https://zone.internal/info',
          {
            headers:{
              Authorization:`Bearer ${bearer(request)}`
            }
          }
        )
      );

      if(!response.ok)return response;

      const info=await response.json() as {
        name:string;
        createdAt:string;
        activeJoinCodes:number;
        connectorConfigured:boolean;
        devices:Array<{
          deviceId:string;
          name:string;
          platform?:string;
          arch?:string;
          version?:string;
          joinedAt:string;
        }>;
      };

      const devices=await Promise.all(
        info.devices.map(async device=>{
          const status=await relay(env,device.deviceId).fetch(
            new Request(
              'https://relay.internal/status',
              {
                headers:{
                  'x-localmcp-internal':'1'
                }
              }
            )
          );

          let online=false;
          if(status.ok){
            const data=await status.json() as {online?:boolean};
            online=data.online===true;
          }

          return {
            ...device,
            online
          };
        })
      );
      return json({
        zoneId,
        name:info.name,
        createdAt:info.createdAt,
        activeJoinCodes:info.activeJoinCodes,
        connectorConfigured:info.connectorConfigured,
        devices
      });
    }

    const connectorMatch=/^\/api\/zones\/([0-9a-f-]{36})\/connector$/.exec(url.pathname);
    if(connectorMatch&&request.method==='POST'){
      if(!sameOriginAllowed(request,url)){
        return json({error:'Origin not allowed'},403);
      }

      const zoneId=connectorMatch[1];
      if(!validUuid(zoneId))return json({error:'Zone not found'},404);

      const mcpToken=randomHex();
      const response=await zone(env,zoneId).fetch(
        new Request(
          'https://zone.internal/mcp-token',
          {
            method:'POST',
            headers:{
              Authorization:`Bearer ${bearer(request)}`,
              'x-zone-mcp-hash':await sha256(mcpToken)
            }
          }
        )
      );

      if(!response.ok)return response;

      return json({
        mcpToken,
        mcpUrl:`${url.origin}/mcp/z/${zoneId}/${mcpToken}`
      });

    }

    const joinCodeMatch=/^\/api\/zones\/([0-9a-f-]{36})\/join-codes$/.exec(url.pathname);
    if(joinCodeMatch&&request.method==='POST'){
      if(!sameOriginAllowed(request,url)){
        return json({error:'Origin not allowed'},403);
      }

      const zoneId=joinCodeMatch[1];
      if(!validUuid(zoneId))return json({error:'Zone not found'},404);

      let body='{}';
      try{
        body=await bodyText(request,16*1024)||'{}';
        JSON.parse(body);
      }catch{
        return json({error:'Invalid JSON'},400);
      }

      const response=await zone(env,zoneId).fetch(
        new Request(
          'https://zone.internal/join-code',
          {
            method:'POST',
            headers:{
              'Content-Type':'application/json',
              Authorization:`Bearer ${bearer(request)}`
            },
            body
          }
        )
      );

      if(!response.ok)return response;

      const data=await response.json() as {
        secret:string;
        expiresAt:string;
      };

      return json(
        {
          code:`${zoneId}.${data.secret}`,
          expiresAt:data.expiresAt
        },
        201
      );
    }

    const zoneDeviceMatch=/^\/api\/zones\/([0-9a-f-]{36})\/devices\/([0-9a-f-]{36})$/.exec(url.pathname);
    if(zoneDeviceMatch&&(request.method==='PATCH'||request.method==='DELETE')){
      if(!sameOriginAllowed(request,url)){
        return json({error:'Origin not allowed'},403);
      }

      const zoneId=zoneDeviceMatch[1];
      const deviceId=zoneDeviceMatch[2];
      if(!validUuid(zoneId)||!validUuid(deviceId)){
        return json({error:'Device not found'},404);
      }

      if(request.method==='PATCH'){
        let body:string;
        try{
          body=await bodyText(request,16*1024);
          JSON.parse(body);
        }catch{
          return json({error:'Invalid JSON'},400);
        }

        return zone(env,zoneId).fetch(
          new Request(
            `https://zone.internal/devices/${deviceId}`,
            {
              method:'PATCH',
              headers:{
                'Content-Type':'application/json',
                Authorization:`Bearer ${bearer(request)}`
              },
              body
            }
          )
        );
      }

      const infoResponse=await zone(env,zoneId).fetch(
        new Request(
          'https://zone.internal/info',
          {
            headers:{
              Authorization:`Bearer ${bearer(request)}`
            }
          }
        )
      );

      if(!infoResponse.ok)return infoResponse;

      const info=await infoResponse.json() as {
        devices:Array<{deviceId:string}>;
      };

      if(!info.devices.some(device=>device.deviceId===deviceId)){
        return json({error:'Device not found'},404);
      }

      const revoked=await relay(env,deviceId).fetch(
        new Request(
          'https://relay.internal/revoke',
          {
            method:'POST',
            headers:{
              'x-localmcp-internal':'1'
            }
          }
        )
      );

      if(!revoked.ok){
        return json({error:'Unable to revoke device credentials'},500);
      }

      return zone(env,zoneId).fetch(
        new Request(
          `https://zone.internal/devices/${deviceId}`,
          {
            method:'DELETE',
            headers:{
              Authorization:`Bearer ${bearer(request)}`
            }
          }
        )
      );
    }

    if(url.pathname==='/join'&&request.method==='POST'){
      if(request.headers.has('Origin')){
        return json({error:'Origin not allowed'},403);
      }

      let body:Record<string,unknown>;
      try{
        body=JSON.parse(await bodyText(request,32*1024)) as Record<string,unknown>;
      }catch{
        return json({error:'Invalid JSON'},400);
      }

      const code=typeof body.code==='string'?body.code.trim():'';
      const separator=code.indexOf('.');
      if(separator<0){
        return new Response(null,{status:404});
      }

      const zoneId=code.slice(0,separator);
      const secret=code.slice(separator+1);
      if(!validUuid(zoneId)||!/^[a-f0-9]{48}$/.test(secret)){
        return new Response(null,{status:404});
      }

      const deviceId=crypto.randomUUID();
      const consumed=await zone(env,zoneId).fetch(
        new Request(
          'https://zone.internal/join/consume',
          {
            method:'POST',
            headers:{
              'Content-Type':'application/json'
            },
            body:JSON.stringify({
              secret,
              deviceId,
              name:body.name,
              platform:body.platform,
              arch:body.arch,
              version:body.version
            })
          }
        )
      );

      if(!consumed.ok)return consumed;
      try{
        const registered=await createRegistration(env,url.origin,deviceId);
        return json(
          {
            ...registered,
            zoneId
          },
          201
        );
      }catch{
        await zone(env,zoneId).fetch(
          new Request(
            `https://zone.internal/devices/${deviceId}`,
            {
              method:'POST',
              headers:{
                'x-localmcp-internal':'remove'
              }
            }
          )
        );
        return json({error:'Registration failed'},500);
      }
    }

    if(request.headers.has('Origin')){
      return json({error:'Origin not allowed'},403);
    }

    const zoneMcpMatch=/^\/mcp\/z\/([0-9a-f-]{36})\/([a-f0-9]{64})$/.exec(url.pathname);

    if(zoneMcpMatch){
      if(request.method!=='POST'){
        return new Response(
          null,
          {
            status:405,
            headers:{
              Allow:'POST'
            }
          }
        );
      }

      if(!request.headers.get('Content-Type')?.toLowerCase().includes('application/json')){
        return json({error:'JSON required'},415);
      }

      let body:string;
      try{
        body=await bodyText(request,2*1024*1024);
      }catch{
        return json({error:'Invalid JSON or body exceeds 2 MiB'},400);
      }

      return handleZoneMcp(
        request,
        env,
        zoneMcpMatch[1],
        zoneMcpMatch[2],
        body
      );
    }

    if(url.pathname==='/register'&&request.method==='POST'){
      if(
        env.REGISTRATION_TOKEN_HASH
        && !await authorized(bearer(request),env.REGISTRATION_TOKEN_HASH)
      ){
        return new Response(null,{status:404});
      }

      try{
        return json(await createRegistration(env,url.origin),201);
      }catch{
        return json({error:'Registration failed'},500);
      }
    }

    const rotateMatch=/^\/rotate\/([0-9a-f-]{36})$/.exec(url.pathname);

    if(rotateMatch&&request.method==='POST'){
      const deviceId=rotateMatch[1];
      const agentToken=randomHex();
      const mcpToken=randomHex();

      const response=await relay(env,deviceId).fetch(
        new Request(
          'https://relay.internal/rotate',
          {
            method:'POST',
            headers:{
              'x-current-agent-token':bearer(request),
              'x-agent-hash':await sha256(agentToken),
              'x-mcp-hash':await sha256(mcpToken)
            }
          }
        )
      );

      if(!response.ok){
        return new Response(null,{status:response.status});
      }

      return json({
        deviceId,
        agentToken,
        mcpToken,
        workerUrl:url.origin,
        mcpUrl:`${url.origin}/mcp/${deviceId}/${mcpToken}`
      });
    }
    const unregisterMatch=/^\/unregister\/([0-9a-f-]{36})$/.exec(url.pathname);

    if(unregisterMatch&&request.method==='POST'){
      const deviceId=unregisterMatch[1];
      const currentToken=bearer(request);
      let body:Record<string,unknown>={};

      try{
        body=JSON.parse(await bodyText(request,8*1024)) as Record<string,unknown>;
      }catch{
        return json({error:'Invalid JSON'},400);
      }

      const zoneId=typeof body.zoneId==='string'?body.zoneId.trim():'';
      if(zoneId&&!validUuid(zoneId)){
        return json({error:'Invalid Zone ID'},400);
      }

      const authorizedDevice=await relay(env,deviceId).fetch(
        new Request(
          'https://relay.internal/authorize-agent',
          {
            method:'POST',
            headers:{
              'x-localmcp-internal':'1',
              'x-current-agent-token':currentToken
            }
          }
        )
      );

      if(!authorizedDevice.ok){
        return new Response(null,{status:authorizedDevice.status});
      }

      if(zoneId){
        const removed=await zone(env,zoneId).fetch(
          new Request(
            `https://zone.internal/devices/${deviceId}`,
            {
              method:'POST',
              headers:{
                'x-localmcp-internal':'remove'
              }
            }
          )
        );
        if(!removed.ok){
          return json({error:'Unable to leave Zone'},500);
        }
      }

      const revoked=await relay(env,deviceId).fetch(
        new Request(
          'https://relay.internal/revoke',
          {
            method:'POST',
            headers:{
              'x-localmcp-internal':'1'
            }
          }
        )
      );

      if(!revoked.ok){
        return json({error:'Unable to revoke device credentials'},500);
      }

      return json({ok:true});
    }

    const leaveMatch=/^\/leave\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/.exec(url.pathname);

    if(leaveMatch&&request.method==='POST'){
      const zoneId=leaveMatch[1];
      const deviceId=leaveMatch[2];
      const currentToken=bearer(request);

      const authorizedDevice=await relay(env,deviceId).fetch(
        new Request(
          'https://relay.internal/authorize-agent',
          {
            method:'POST',
            headers:{
              'x-localmcp-internal':'1',
              'x-current-agent-token':currentToken
            }
          }
        )
      );

      if(!authorizedDevice.ok){
        return new Response(null,{status:authorizedDevice.status});
      }

      const removed=await zone(env,zoneId).fetch(
        new Request(
          `https://zone.internal/devices/${deviceId}`,
          {
            method:'POST',
            headers:{
              'x-localmcp-internal':'remove'
            }
          }
        )
      );

      if(!removed.ok){
        return json({error:'Unable to leave Zone'},500);
      }

      const revoked=await relay(env,deviceId).fetch(
        new Request(
          'https://relay.internal/revoke',
          {
            method:'POST',
            headers:{
              'x-localmcp-internal':'1'
            }
          }
        )
      );

      if(!revoked.ok){
        return json({error:'Unable to revoke device credentials'},500);
      }

      try{
        return json(await createRegistration(env,url.origin,deviceId),200);
      }catch{
        return json({error:'Unable to create standalone device credentials'},500);
      }
    }

    const agentMatch=/^\/agent\/([0-9a-f-]{36})$/.exec(url.pathname);

    if(agentMatch){
      if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket'){
        return json({error:'WebSocket required'},426);
      }

      return relay(env,agentMatch[1]).fetch(
        new Request(
          'https://relay.internal/agent',
          {
            headers:{
              Upgrade:'websocket',
              'x-localmcp-agent-token':bearer(request)
            }
          }
        )
      );
    }

    const mcpMatch=/^\/mcp\/([0-9a-f-]{36})\/([a-f0-9]{64})$/.exec(url.pathname);

    if(mcpMatch){
      if(request.method!=='POST'){
        return new Response(
          null,
          {
            status:405,
            headers:{
              Allow:'POST'
            }
          }
        );
      }

      if(!request.headers.get('Content-Type')?.toLowerCase().includes('application/json')){
        return json({error:'JSON required'},415);
      }

      let body:string;

      try{
        body=await bodyText(request,2*1024*1024);
        JSON.parse(body);
      }catch{
        return json(
          {
            error:'Invalid JSON or body exceeds 2 MiB'
          },
          400
        );
      }

      const headers=new Headers({
        'Content-Type':'application/json',
        'Accept':'application/json, text/event-stream',
        'x-localmcp-mcp-token':mcpMatch[2]
      });

      const version=request.headers.get('MCP-Protocol-Version');

      if(version){
        headers.set('MCP-Protocol-Version',version);
      }

      return relay(env,mcpMatch[1]).fetch(
        new Request(
          'https://relay.internal/mcp',
          {
            method:'POST',
            headers,
            body
          }
        )
      );
    }

    // Legacy single-user self-hosted routes.
    const legacyBearer=bearer(request);

    if(url.pathname==='/agent'){
      if(!await authorized(legacyBearer,env.AGENT_TOKEN_HASH)){
        return new Response(null,{status:404});
      }

      if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket'){
        return json({error:'WebSocket required'},426);
      }

      return relay(env,'local').fetch(
        new Request(
          'https://relay.internal/agent',
          {
            headers:{
              Upgrade:'websocket',
              'x-localmcp-legacy':'1'
            }
          }
        )
      );
    }

    const legacy=/^\/mcp(?:\/([a-f0-9]{64}))?$/.exec(url.pathname);

    if(
      !legacy
      || !await authorized(
        legacy[1]||legacyBearer,
        env.MCP_TOKEN_HASH
      )
    ){
      return new Response(null,{status:404});
    }

    if(request.method!=='POST'){
      return new Response(
        null,
        {
          status:405,
          headers:{
            Allow:'POST'
          }
        }
      );
    }

    let body:string;

    try{
      body=await bodyText(request,2*1024*1024);
      JSON.parse(body);
    }catch{
      return json(
        {
          error:'Invalid JSON or body exceeds 2 MiB'
        },
        400
      );
    }

    const headers=new Headers({
      'Content-Type':'application/json',
      'Accept':'application/json, text/event-stream',
      'x-localmcp-legacy':'1'
    });

    const version=request.headers.get('MCP-Protocol-Version');

    if(version){
      headers.set('MCP-Protocol-Version',version);
    }

    return relay(env,'local').fetch(
      new Request(
        'https://relay.internal/mcp',
        {
          method:'POST',
          headers,
          body
        }
      )
    );
  }
};

type PendingLane='execution'|'control';

interface Pending {
  socket:WebSocket;
  assembly:Assembly;
  resolve:(response:Response)=>void;
  timer:ReturnType<typeof setTimeout>;
  lane:PendingLane;
}

interface ControlPending {
  socket:WebSocket;
  resolve:(response:Response)=>void;
  timer:ReturnType<typeof setTimeout>;
}

export class McpRelay {
  private pending=new Map<string,Pending>();
  private controlPending=new Map<string,ControlPending>();

  constructor(private ctx:DurableObjectState){
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping','pong')
    );
  }
  private pendingInLane(lane:PendingLane){
    let count=0;
    for(const pending of this.pending.values()){
      if(pending.lane===lane)count++;
    }
    return count;
  }

  async fetch(request:Request):Promise<Response>{
    const url=new URL(request.url);

    if(
      url.pathname==='/status'
      && request.headers.get('x-localmcp-internal')==='1'
    ){
      return json({
        online:this.ctx.getWebSockets('agent').length>0
      });
    }

    if(
      url.pathname==='/authorize-agent'
      && request.method==='POST'
      && request.headers.get('x-localmcp-internal')==='1'
    ){
      const expected=await this.ctx.storage.get<string>('agentHash');
      const current=request.headers.get('x-current-agent-token')||'';
      if(!await authorized(current,expected)){
        return new Response(null,{status:404});
      }
      return json({ok:true});
    }

    if(
      url.pathname==='/remote-unlock'
      && request.method==='POST'
      && request.headers.get('x-localmcp-internal')==='1'
    ){
      const socket=this.ctx.getWebSockets('agent')[0];
      if(!socket){
        return json({error:'Local agent offline. Start localmcp.'},503);
      }

      let body:Record<string,unknown>;
      try{
        body=JSON.parse(await request.text()) as Record<string,unknown>;
      }catch{
        return json({error:'Invalid JSON'},400);
      }

      const minutes=Number(body.minutes);
      const zoneId=typeof body.zoneId==='string'?body.zoneId:'';
      if(!validUuid(zoneId)||![5,15,30,60].includes(minutes)){
        return json({error:'Invalid remote unlock request'},400);
      }

      const requestId=crypto.randomUUID();
      return new Promise<Response>(resolveResponse=>{
        const timer=setTimeout(()=>{
          this.controlPending.delete(requestId);
          resolveResponse(json({
            error:'Remote unlock timed out; device may be offline or busy.'
          },504));
        },15000);

        this.controlPending.set(requestId,{
          socket,
          resolve:resolveResponse,
          timer
        });

        try{
          socket.send(JSON.stringify({
            type:'control',
            requestId,
            command:'remote_unlock',
            minutes,
            zoneId
          }));
        }catch{
          clearTimeout(timer);
          this.controlPending.delete(requestId);
          resolveResponse(json({
            error:'Unable to send remote unlock request to Agent.'
          },502));
        }
      });
    }

    if(
      url.pathname==='/revoke'
      && request.method==='POST'
      && request.headers.get('x-localmcp-internal')==='1'
    ){
      await this.ctx.storage.delete(['agentHash','mcpHash']);

      for(const socket of this.ctx.getWebSockets('agent')){
        this.failSocket(socket);
        try{
          socket.close(1008,'Device revoked');
        }catch{}
      }

      return json({ok:true});
    }

    if(url.pathname==='/register'){
      const agentHash=request.headers.get('x-agent-hash');
      const mcpHash=request.headers.get('x-mcp-hash');

      if(
        !agentHash
        || !mcpHash
        || !/^[a-f0-9]{64}$/.test(agentHash)
        || !/^[a-f0-9]{64}$/.test(mcpHash)
      ){
        return json({error:'Invalid registration'},400);
      }

      await this.ctx.storage.put({
        agentHash,
        mcpHash
      });

      return json({ok:true});
    }

    if(url.pathname==='/rotate'){
      const expected=await this.ctx.storage.get<string>('agentHash');
      const current=request.headers.get('x-current-agent-token')||'';
      const agentHash=request.headers.get('x-agent-hash');
      const mcpHash=request.headers.get('x-mcp-hash');

      if(!await authorized(current,expected)){
        return new Response(null,{status:404});
      }

      if(
        !agentHash
        || !mcpHash
        || !/^[a-f0-9]{64}$/.test(agentHash)
        || !/^[a-f0-9]{64}$/.test(mcpHash)
      ){
        return json({error:'Invalid rotation'},400);
      }

      await this.ctx.storage.put({
        agentHash,
        mcpHash
      });

      for(const socket of this.ctx.getWebSockets('agent')){
        this.failSocket(socket);

        try{
          socket.close(1012,'Credentials rotated');
        }catch{}
      }

      return json({ok:true});
    }

    const legacy=request.headers.get('x-localmcp-legacy')==='1';
    const internal=request.headers.get('x-localmcp-internal')==='1';

    if(url.pathname==='/agent'){
      if(!legacy){
        const expected=await this.ctx.storage.get<string>('agentHash');

        if(
          !await authorized(
            request.headers.get('x-localmcp-agent-token')||'',
            expected
          )
        ){
          return new Response(null,{status:404});
        }
      }

      if(this.ctx.getWebSockets('agent').length){
        return json(
          {
            error:'An agent is already connected'
          },
          409
        );
      }

      const pair=new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1],['agent']);

      return new Response(
        null,
        {
          status:101,
          webSocket:pair[0]
        }
      );
    }

    if(!legacy&&!internal){
      const expected=await this.ctx.storage.get<string>('mcpHash');

      if(
        !await authorized(
          request.headers.get('x-localmcp-mcp-token')||'',
          expected
        )
      ){
        return new Response(null,{status:404});
      }
    }
    const socket=this.ctx.getWebSockets('agent')[0];

    if(!socket){
      return json(
        {
          error:'Local agent offline. Start localmcp.'
        },
        503
      );
    }

    const body=await request.text();
    let parsedBody:unknown;
    try{
      parsedBody=JSON.parse(body);
    }catch{
      parsedBody=undefined;
    }

    const lane:PendingLane=isConcurrentReadRequest(parsedBody)
      ? 'control'
      : 'execution';
    const limit=lane==='control'
      ? MAX_CONTROL_REQUESTS
      : MAX_CONCURRENT_REQUESTS;

    if(this.pendingInLane(lane)>=limit){
      return json(
        {
          error:lane==='control'
            ? `Local agent has reached the ${MAX_CONTROL_REQUESTS}-request control-query safety limit.`
            : `Local agent has reached the ${MAX_CONCURRENT_REQUESTS}-request execution concurrency limit. Read-only status queries remain available; do not automatically retry write operations.`
        },
        429
      );
    }

    const id=crypto.randomUUID();

    return new Promise<Response>(resolveResponse=>{
      const timer=setTimeout(
        ()=>this.finish(
          id,
          json(
            {
              error:'Local execution timed out; outcome may be unknown.'
            },
            504
          )
        ),
        130000
      );

      this.pending.set(
        id,
        {
          socket,
          assembly:new Assembly(),
          resolve:resolveResponse,
          timer,
          lane
        }
      );

      try{
        for(
          const frame of frames(
            id,
            {
              body,
              protocolVersion:request.headers.get('MCP-Protocol-Version')
            }
          )
        ){
          socket.send(frame);
        }
      }catch{
        this.finish(
          id,
          json(
            {
              error:'Agent connection lost; outcome may be unknown.'
            },
            502
          )
        );
      }
    });
  }

  private finish(id:string,response:Response){
    const pending=this.pending.get(id);
    if(!pending)return;

    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(response);
  }

  webSocketMessage(
    socket:WebSocket,
    message:string|ArrayBuffer
  ){
    try{
      if(typeof message!=='string'){
        throw new Error('Text frames required');
      }


      let control:
        |{
            type?:unknown;
            requestId?:unknown;
            ok?:unknown;
            error?:unknown;
            expiresAt?:unknown;
            hardExpiresAt?:unknown;
            source?:unknown;
          }
        |undefined;
      try{
        control=JSON.parse(message);
      }catch{}

      if(control?.type==='control_result'){
        const requestId=
          typeof control.requestId==='string'
            ? control.requestId
            : '';
        const pending=this.controlPending.get(requestId);
        if(!pending||pending.socket!==socket)return;

        clearTimeout(pending.timer);
        this.controlPending.delete(requestId);

        if(control.ok===true){
          pending.resolve(json({
            ok:true,
            expiresAt:
              typeof control.expiresAt==='string'
                ? control.expiresAt
                : null,
            hardExpiresAt:
              typeof control.hardExpiresAt==='string'
                ? control.hardExpiresAt
                : null,
            source:
              typeof control.source==='string'
                ? control.source
                : 'remote'
          }));
        }else{
          pending.resolve(json({
            error:
              typeof control.error==='string'
                ? control.error
                : 'Remote unlock was rejected by the Agent.'
          },409));
        }
        return;
      }

      const frame=parseFrame(message);
      const pending=this.pending.get(frame.id);
      if(!pending||pending.socket!==socket){
        return;
      }

      const complete=pending.assembly.push(frame);

      if(!complete){
        return;
      }

      const data=complete.value as {
        status:number;
        body:string;
      };

      if(
        !data
        || !Number.isInteger(data.status)
        || typeof data.body!=='string'
      ){
        throw new Error('Invalid agent response');
      }

      if(![202,204,205,304].includes(data.status)){
        JSON.parse(data.body);
      }

      this.finish(
        frame.id,
        new Response(
          [204,205,304].includes(data.status)
            ? null
            : data.body,
          {
            status:data.status,
            headers:{
              'Content-Type':'application/json',
              'Cache-Control':'no-store'
            }
          }
        )
      );
    }catch{
      socket.close(1008,'Invalid relay response');
      this.failSocket(socket);
    }
  }

  private failSocket(socket:WebSocket){
    for(const [id,pending] of this.pending){
      if(pending.socket===socket){
        this.finish(
          id,
          json(
            {
              error:'Local agent disconnected; execution outcome may be unknown.'
            },
            502
          )
        );
      }
    }

    for(const [requestId,pending] of this.controlPending){
      if(pending.socket!==socket)continue;
      clearTimeout(pending.timer);
      this.controlPending.delete(requestId);
      pending.resolve(json({
        error:'Local agent disconnected before the control operation completed.'
      },502));
    }
  }

  webSocketClose(socket:WebSocket){
    this.failSocket(socket);

    try{
      socket.close(1000,'Closed');
    }catch{}
  }

  webSocketError(socket:WebSocket){
    this.failSocket(socket);

    try{
      socket.close(1011,'Connection failed');
    }catch{}
  }
}
