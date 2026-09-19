interface ZoneDevice {
  deviceId:string;
  name:string;
  platform?:string;
  arch?:string;
  version?:string;
  joinedAt:string;
}

interface JoinCodeRecord {
  hash:string;
  expiresAt:string;
}

interface ZoneState {
  name:string;
  createdAt:string;
  adminHash:string;
  mcpHash?:string;
  devices:Record<string,ZoneDevice>;
  joinCodes:Record<string,JoinCodeRecord>;
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

function randomHex(bytes=24){
  const data=new Uint8Array(bytes);
  crypto.getRandomValues(data);

  return Array.from(
    data,
    byte=>byte.toString(16).padStart(2,'0')
  ).join('');
}

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

function cleanName(value:unknown,fallback:string){
  if(typeof value!=='string')return fallback;
  const trimmed=value.trim();
  if(!trimmed)return fallback;
  if(trimmed.length>80)throw new Error('Name is too long');
  return trimmed;
}

function optionalText(value:unknown,max=80){
  if(value===undefined||value===null||value==='')return undefined;
  if(typeof value!=='string')throw new Error('Invalid metadata');
  const trimmed=value.trim();
  if(trimmed.length>max)throw new Error('Metadata is too long');
  return trimmed||undefined;
}

export class ZoneManager {
  constructor(private ctx:DurableObjectState){}

  private async state(){
    return await this.ctx.storage.get<ZoneState>('state');
  }

  private async requireAdmin(request:Request,state:ZoneState){
    return await authorized(bearer(request),state.adminHash);
  }

  private pruneJoinCodes(state:ZoneState){
    const now=Date.now();

    for(const [key,record] of Object.entries(state.joinCodes)){
      if(Date.parse(record.expiresAt)<=now){
        delete state.joinCodes[key];
      }
    }
  }

  async fetch(request:Request):Promise<Response>{
    const url=new URL(request.url);

    if(url.pathname==='/create'&&request.method==='POST'){
      if(await this.state()){
        return json({error:'Zone already exists'},409);
      }

      const adminHash=request.headers.get('x-zone-admin-hash')||'';
      const mcpHash=request.headers.get('x-zone-mcp-hash')||'';

      if(!/^[a-f0-9]{64}$/.test(adminHash)){
        return json({error:'Invalid admin credential'},400);
      }

      if(mcpHash&&!/^[a-f0-9]{64}$/.test(mcpHash)){
        return json({error:'Invalid MCP credential'},400);
      }

      let body:Record<string,unknown>={};
      try{
        body=await request.json() as Record<string,unknown>;
      }catch{}

      const state:ZoneState={
        name:cleanName(body.name,'LocalMCP Zone'),
        createdAt:new Date().toISOString(),
        adminHash,
        ...(mcpHash?{mcpHash}:{}),
        devices:{},
        joinCodes:{}
      };

      await this.ctx.storage.put('state',state);

      return json(
        {
          ok:true,
          name:state.name,
          createdAt:state.createdAt,
          connectorConfigured:!!state.mcpHash
        },
        201
      );
    }

    const state=await this.state();
    if(!state){
      return json({error:'Zone not found'},404);
    }

    if(url.pathname==='/info'&&request.method==='GET'){
      if(!await this.requireAdmin(request,state)){
        return new Response(null,{status:404});
      }

      this.pruneJoinCodes(state);
      await this.ctx.storage.put('state',state);

      return json({
        name:state.name,
        createdAt:state.createdAt,
        devices:Object.values(state.devices),
        activeJoinCodes:Object.keys(state.joinCodes).length,
        connectorConfigured:!!state.mcpHash
      });
    }

    if(url.pathname==='/mcp-context'&&request.method==='GET'){
      if(!await authorized(
        request.headers.get('x-zone-mcp-token')||'',
        state.mcpHash
      )){
        return new Response(null,{status:404});
      }

      return json({
        name:state.name,
        createdAt:state.createdAt,
        devices:Object.values(state.devices)
      });
    }

    if(url.pathname==='/mcp-token'&&request.method==='POST'){
      if(!await this.requireAdmin(request,state)){
        return new Response(null,{status:404});
      }

      const mcpHash=request.headers.get('x-zone-mcp-hash')||'';
      if(!/^[a-f0-9]{64}$/.test(mcpHash)){
        return json({error:'Invalid MCP credential'},400);
      }

      state.mcpHash=mcpHash;
      await this.ctx.storage.put('state',state);
      return json({ok:true});
    }

    if(url.pathname==='/join-code'&&request.method==='POST'){
      if(!await this.requireAdmin(request,state)){
        return new Response(null,{status:404});
      }

      let body:Record<string,unknown>={};
      try{
        body=await request.json() as Record<string,unknown>;
      }catch{}

      const ttlMinutes=body.ttlMinutes===undefined?10:Number(body.ttlMinutes);
      if(
        !Number.isInteger(ttlMinutes)
        || ttlMinutes<1
        || ttlMinutes>60
      ){
        return json({error:'ttlMinutes must be an integer from 1 to 60'},400);
      }

      this.pruneJoinCodes(state);

      const secret=randomHex();
      const key=await sha256(secret);
      const expiresAt=new Date(Date.now()+ttlMinutes*60_000).toISOString();

      state.joinCodes[key]={
        hash:key,
        expiresAt
      };

      await this.ctx.storage.put('state',state);

      return json({
        secret,
        expiresAt
      },201);
    }

    if(url.pathname==='/join/consume'&&request.method==='POST'){
      let body:Record<string,unknown>;

      try{
        body=await request.json() as Record<string,unknown>;
      }catch{
        return json({error:'Invalid JSON'},400);
      }

      const secret=typeof body.secret==='string'?body.secret.trim():'';
      const deviceId=typeof body.deviceId==='string'?body.deviceId.trim():'';

      if(!/^[a-f0-9]{48}$/.test(secret)||!/^[0-9a-f-]{36}$/.test(deviceId)){
        return json({error:'Invalid join request'},400);
      }

      this.pruneJoinCodes(state);

      const key=await sha256(secret);
      const record=state.joinCodes[key];

      if(!record||Date.parse(record.expiresAt)<=Date.now()){
        delete state.joinCodes[key];
        await this.ctx.storage.put('state',state);
        return new Response(null,{status:404});
      }

      if(
        !state.devices[deviceId]
        && Object.keys(state.devices).length>=32
      ){
        return json({error:'Zone device limit reached'},409);
      }

      delete state.joinCodes[key];

      try{
        state.devices[deviceId]={
          deviceId,
          name:cleanName(body.name,'LocalMCP Device'),
          platform:optionalText(body.platform),
          arch:optionalText(body.arch),
          version:optionalText(body.version),
          joinedAt:new Date().toISOString()
        };
      }catch(error){
        return json(
          {
            error:error instanceof Error?error.message:'Invalid device metadata'
          },
          400
        );
      }

      await this.ctx.storage.put('state',state);

      return json({
        ok:true,
        device:state.devices[deviceId]
      },201);
    }

    const deviceMatch=/^\/devices\/([0-9a-f-]{36})$/.exec(url.pathname);

    if(deviceMatch&&request.method==='PATCH'){
      if(!await this.requireAdmin(request,state)){
        return new Response(null,{status:404});
      }

      const device=state.devices[deviceMatch[1]];
      if(!device){
        return json({error:'Device not found'},404);
      }

      let body:Record<string,unknown>;
      try{
        body=await request.json() as Record<string,unknown>;
      }catch{
        return json({error:'Invalid JSON'},400);
      }

      try{
        device.name=cleanName(body.name,device.name);
      }catch(error){
        return json(
          {
            error:error instanceof Error?error.message:'Invalid device name'
          },
          400
        );
      }

      await this.ctx.storage.put('state',state);
      return json({ok:true,device});
    }

    if(deviceMatch&&request.method==='DELETE'){
      if(!await this.requireAdmin(request,state)){
        return new Response(null,{status:404});
      }

      const device=state.devices[deviceMatch[1]];
      if(!device){
        return json({error:'Device not found'},404);
      }

      delete state.devices[deviceMatch[1]];
      await this.ctx.storage.put('state',state);
      return json({ok:true,device});
    }

    if(
      deviceMatch
      && request.method==='POST'
      && request.headers.get('x-localmcp-internal')==='remove'
    ){
      delete state.devices[deviceMatch[1]];
      await this.ctx.storage.put('state',state);
      return json({ok:true});
    }

    return json({error:'Not found'},404);
  }
}
