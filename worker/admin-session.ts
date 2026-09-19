export const ADMIN_COOKIE_NAME='localmcp_relay_admin';
export const ADMIN_SESSION_SECONDS=8*60*60;

interface AdminEnv {
  ADMIN:DurableObjectNamespace;
}

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

function randomHex(bytes=32){
  const data=new Uint8Array(bytes);
  crypto.getRandomValues(data);

  return Array.from(
    data,
    byte=>byte.toString(16).padStart(2,'0')
  ).join('');
}

function store(env:AdminEnv){
  return env.ADMIN.get(env.ADMIN.idFromName('relay-admin'));
}

function cookieValue(request:Request,name:string){
  const cookie=request.headers.get('Cookie')||'';

  for(const part of cookie.split(';')){
    const [rawName,...rawValue]=part.trim().split('=');
    if(rawName===name){
      return rawValue.join('=');
    }
  }

  return undefined;
}

async function internal(
  env:AdminEnv,
  path:string,
  init:RequestInit={}
){
  const headers=new Headers(init.headers);
  headers.set('x-localmcp-internal','1');

  return store(env).fetch(
    new Request(
      `https://admin.internal${path}`,
      {
        ...init,
        headers
      }
    )
  );
}

export async function createAdminSession(env:AdminEnv){
  const token=randomHex();
  const hash=await sha256(token);
  const expiresAt=new Date(
    Date.now()+ADMIN_SESSION_SECONDS*1000
  ).toISOString();

  const response=await internal(
    env,
    '/session/create',
    {
      method:'POST',
      headers:{
        'x-session-hash':hash,
        'x-session-expires-at':expiresAt
      }
    }
  );

  if(!response.ok){
    throw new Error('Unable to create admin session');
  }

  return {
    token,
    expiresAt
  };
}

export async function adminSession(
  request:Request,
  env:AdminEnv
){
  const token=cookieValue(request,ADMIN_COOKIE_NAME);

  if(!token||!/^[a-f0-9]{64}$/.test(token)){
    return {
      authenticated:false as const
    };
  }

  const hash=await sha256(token);
  const response=await internal(
    env,
    '/session/check',
    {
      headers:{
        'x-session-hash':hash
      }
    }
  );

  if(!response.ok){
    return {
      authenticated:false as const
    };
  }

  const data=await response.json() as {
    expiresAt:string;
  };

  return {
    authenticated:true as const,
    token,
    hash,
    expiresAt:data.expiresAt
  };
}

export async function deleteAdminSession(
  request:Request,
  env:AdminEnv
){
  const token=cookieValue(request,ADMIN_COOKIE_NAME);
  if(!token||!/^[a-f0-9]{64}$/.test(token))return;

  await internal(
    env,
    '/session/delete',
    {
      method:'POST',
      headers:{
        'x-session-hash':await sha256(token)
      }
    }
  );
}

export function adminCookie(token:string){
  return [
    `${ADMIN_COOKIE_NAME}=${token}`,
    'Path=/',
    `Max-Age=${ADMIN_SESSION_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict'
  ].join('; ');
}

export function clearAdminCookie(){
  return [
    `${ADMIN_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=Strict'
  ].join('; ');
}

export async function listRegisteredZones(env:AdminEnv){
  const response=await internal(env,'/zones');

  if(!response.ok){
    throw new Error('Unable to read Zone registry');
  }

  return await response.json() as {
    zones:Array<{
      zoneId:string;
      name:string;
      createdAt:string;
      registeredAt:string;
    }>;
  };
}

export async function registerZone(
  env:AdminEnv,
  zone:{
    zoneId:string;
    name:string;
    createdAt:string;
  }
){
  const response=await internal(
    env,
    `/zones/${zone.zoneId}`,
    {
      method:'PUT',
      headers:{
        'Content-Type':'application/json'
      },
      body:JSON.stringify({
        name:zone.name,
        createdAt:zone.createdAt
      })
    }
  );

  if(!response.ok){
    throw new Error('Unable to register Zone in Relay admin registry');
  }
}
