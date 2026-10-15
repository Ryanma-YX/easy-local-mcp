import { OWNER_GRANT_TOOLS, validAgentSessionTools } from './agent-session-tool-groups';
// MCP-facing Agent Session Approvals. Connector URL auth is independent of the
// per-AI session grant. No OAuth, refresh token, or model-hidden credential.
export interface SessionConnector {
  kind:'device'|'zone';
  id:string;
  secret:string;
}
export interface SessionEnv { ADMIN:DurableObjectNamespace }
export const SESSION_REQUEST_TOOL='request_agent_session';
export const SESSION_STATUS_TOOL='get_agent_session_status';
export const SESSION_TOKEN_ARGUMENT='agentSessionToken';

const uuid=(v:unknown):v is string=>typeof v==='string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const randomSecret=()=>{
  const bytes=new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
};
export const hashSecret=async(secret:string)=>
  Array.from(new Uint8Array(await crypto.subtle.digest(
    'SHA-256',new TextEncoder().encode(secret)
  )),b=>b.toString(16).padStart(2,'0')).join('');
const jsonRpc=(id:unknown,result:unknown)=>Response.json({
  jsonrpc:'2.0',id:id??null,result
},{headers:{'Cache-Control':'no-store'}});
function toolError(id:unknown,message:string){
  return jsonRpc(id,{isError:true,content:[{type:'text',text:message}]});
}
const result=(id:unknown,value:unknown)=>jsonRpc(id,{
  content:[{type:'text',text:JSON.stringify(value)}]
});
const storage=(env:SessionEnv)=>env.ADMIN.get(env.ADMIN.idFromName('relay-admin'));
async function post(env:SessionEnv,action:string,body:Record<string,unknown>){
  return storage(env).fetch(new Request(`https://admin.internal/agent-sessions/${action}`,{
    method:'POST',headers:{'Content-Type':'application/json','x-localmcp-internal':'1'},
    body:JSON.stringify(body)
  }));
}
async function connectorIdentity(connector:SessionConnector){
  return {
    connectorKind:connector.kind,
    connectorId:connector.id,
    connectorHash:await hashSecret(connector.secret)
  };
}
export function decodeSessionToken(token:unknown){
  if(typeof token!=='string')return null;
  const dot=token.indexOf('.');
  const id=token.slice(0,dot);
  const secret=token.slice(dot+1);
  return uuid(id)&&/^[0-9a-f]{64}$/.test(secret)?{id,secret}:null;
}

const sessionTokenProperty={
  type:'string',
  description:'Your independently approved Agent Session Token. Omit only if the target Agent is globally Remote Unlocked.'
};
export function withSessionArgument(tool:Record<string,unknown>){
  const schema=tool.inputSchema as Record<string,unknown>||{};
  return {...tool,inputSchema:{
    ...schema,
    properties:{...(schema.properties as Record<string,unknown>||{}),
      [SESSION_TOKEN_ARGUMENT]:sessionTokenProperty}
  }};
}
export function agentSessionTools(kind:'zone'|'device'){
  const requestProps:Record<string,unknown>={
    tools:{type:'array',items:{type:'string'},minItems:1,maxItems:OWNER_GRANT_TOOLS.length,
      description:'MCP tool names to request, or ["*"] to request all enabled tools. The owner UI chooses explicit currently visible tools at approval time; backend wildcard grants remain supported separately.'},
    note:{type:'string',maxLength:160,description:'Brief purpose shown to the owner.'}
  };
  if(kind==='zone'){
    requestProps.scope={type:'string',enum:['zone/all','devices'],description:'Whole Zone including future members, or explicit device IDs.'};
    requestProps.devices={type:'array',items:{type:'string'},description:'Required when scope is devices; use IDs returned by list_devices.'};
  }
  return [{
    name:SESSION_REQUEST_TOOL,
    description:'Request owner approval for selected tools and devices. The owner alone chooses the access duration (up to 30 days) and inactivity limit in Relay Admin. The returned token is NOT authorized until then.',
    inputSchema:{type:'object',properties:requestProps,required:kind==='zone'?['scope']:[],additionalProperties:false}
  },{
    name:SESSION_STATUS_TOOL,
    description:'Check the approval, idle deadline and absolute expiration for your own Agent Session Token. Checking status does not extend inactivity.',
    inputSchema:{type:'object',properties:{agentSessionToken:sessionTokenProperty},required:['agentSessionToken'],additionalProperties:false}
  }];
}
export async function handleAgentSessionTool(
  env:SessionEnv,
  connector:SessionConnector,
  name:string,
  args:Record<string,unknown>,
  rpcId:unknown,
  currentDevices:string[]
):Promise<Response|null>{
  if(name!==SESSION_REQUEST_TOOL&&name!==SESSION_STATUS_TOOL)return null;
  const identity=await connectorIdentity(connector);
  if(name===SESSION_STATUS_TOOL){
    const decoded=decodeSessionToken(args.agentSessionToken);
    if(!decoded)return toolError(rpcId,'Invalid Agent Session Token');
    const response=await post(env,'status',{
      ...identity,id:decoded.id,tokenHash:await hashSecret(decoded.secret)
    });
    if(!response.ok)return toolError(rpcId,'Unknown or inaccessible Agent Session');
    return result(rpcId,await response.json());
  }

  const scope=connector.kind==='device'?'device':args.scope;
  const deviceIds=scope==='devices'?args.devices:[];
  const tools=args.tools??['*'];
  const note=args.note??'';
  // Old clients may send legacy duration fields until they refresh tools.
  // They are deliberately ignored: only the independently authenticated
  // owner can choose the approval and idle lifetimes.
  if(!['device','devices','zone/all'].includes(String(scope))
    || (connector.kind==='zone'&&scope==='device')
    || (connector.kind==='device'&&scope!=='device')
    || !Array.isArray(deviceIds)||deviceIds.length>32
    || (scope==='devices'&&deviceIds.length===0)
    || (scope!=='devices'&&deviceIds.length!==0)
    || deviceIds.some(id=>!uuid(id)||!currentDevices.includes(id))
    || new Set(deviceIds).size!==deviceIds.length
    || !validAgentSessionTools(tools)
    || typeof note!=='string'||note.length>160){
    return toolError(rpcId,'Invalid access scope, tools or purpose');
  }

  const id=crypto.randomUUID();
  const secret=randomSecret();
  const response=await post(env,'request',{
    ...identity,id,tokenHash:await hashSecret(secret),
    scope,devices:deviceIds,tools,note
  });
  if(!response.ok){
    const error=await response.json() as {error?:string};
    return toolError(rpcId,error.error||'Unable to request Agent Session');
  }
  const created=await response.json() as {pendingUntil:string};
  return result(rpcId,{
    sessionId:id,
    agentSessionToken:`${id}.${secret}`,
    state:'pending',pendingUntil:created.pendingUntil,
    dashboard:'/admin',
    message:'Save this token privately. The owner chooses how long access lasts in Relay Admin. The token grants no protected access until approved.'
  });
}

export async function authorizedAgentSessionId(
  env:SessionEnv,
  connector:SessionConnector,
  token:unknown,
  targetDeviceId:string,
  tool:string
):Promise<string|null>{
  const decoded=decodeSessionToken(token);
  if(!decoded)return null;
  const identity=await connectorIdentity(connector);
  const response=await post(env,'authorize',{
    ...identity,id:decoded.id,tokenHash:await hashSecret(decoded.secret),
    deviceId:targetDeviceId,tool
  });
  if(!response.ok)return null;
  const data=await response.json() as {authorized?:boolean;id?:string};
  return data.authorized===true&&data.id===decoded.id?decoded.id:null;
}

export async function approvedAgentSession(
  env:SessionEnv,connector:SessionConnector,token:unknown,targetDeviceId:string,tool:string
):Promise<boolean>{
  return (await authorizedAgentSessionId(env,connector,token,targetDeviceId,tool))!==null;
}
