import { validAgentSessionTools } from './agent-session-tool-groups';
// Persistent, per-AI owner-approved session grants. The RelayAdmin DO is the
// only authority; model-visible secrets are never persisted in plaintext.
export interface AgentSessionRecord {
  id:string;
  tokenHash:string;
  connectorKind:'device'|'zone';
  connectorId:string;
  connectorHash:string;
  scope:'device'|'devices'|'zone/all';
  devices:string[];
  tools:string[];
  requestedTools?:string[]; // Original AI request, immutable after owner approves.
  requestedHours?:number; // Legacy records only; never caps owner approval.
  idleHours:24|48;
  note:string;
  createdAt:string;
  pendingUntil:string;
  state:'pending'|'approved'|'rejected'|'revoked';
  approvedAt?:string;
  approvedHours?:number;
  hardUntil?:string;
  idleUntil?:string;
  lastUsedAt?:string;
  endedAt?:string;
}

const json=(body:unknown,status=200)=>Response.json(body,{
  status,headers:{'Cache-Control':'no-store'}
});
const uuid=(value:unknown)=>typeof value==='string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const hash=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const key=(id:string)=>`agent-session:${id}`;
// A Zone MCP connector has one shared quota for all clients holding its URL;
// a direct device connector has its own quota. Model conversation identity
// cannot be authenticated from a shared bearer, so do not claim per-AI quotas.
const MAX_PENDING_PER_CONNECTOR=10;
const MAX_APPROVED_PER_CONNECTOR=64;
const MAX_RETAINED_HISTORY=200; // Soft cap; never blocks active sessions.
const REQUESTS_PER_HOUR=10;
const HOUR_MS=60*60_000;
const AUDIT_RETENTION_MS=7*24*HOUR_MS;
const elapsed=(date?:string)=>!!date&&Date.parse(date)<=Date.now();
export function effectiveState(record:AgentSessionRecord){
  if(record.state==='pending'&&elapsed(record.pendingUntil))return 'expired';
  if(record.state==='approved'&&(elapsed(record.hardUntil)||elapsed(record.idleUntil)))return 'expired';
  return record.state;
}
function publicRecord(record:AgentSessionRecord){
  const {tokenHash,connectorHash,...rest}=record;
  // Preserve exact owner-approved permission representation, including a
  // deliberately granted '*' wildcard. The UI All shortcut sends explicit
  // names, but a wildcard is still a supported backend authorization value.
  return {...rest,state:effectiveState(record)};
}
function sameConnector(record:AgentSessionRecord,body:Record<string,unknown>){
  return record.connectorKind===body.connectorKind
    && record.connectorId===body.connectorId
    && record.connectorHash===body.connectorHash;
}
async function readBody(request:Request){
  try{
    const body=await request.json();
    return body&&typeof body==='object'&&!Array.isArray(body)
      ?body as Record<string,unknown>:null;
  }catch{return null;}
}

export async function handleAgentSessionStorage(
  storage:DurableObjectStorage,
  request:Request
):Promise<Response|null>{
  const url=new URL(request.url);
  if(!url.pathname.startsWith('/agent-sessions/'))return null;
  const action=url.pathname.slice('/agent-sessions/'.length);
  if(action==='list'&&request.method==='GET'){
    const entries=await storage.list<AgentSessionRecord>({prefix:'agent-session:'});
    const priority=(state:string)=>state==='pending'?0:state==='approved'?1:2;
    const sessions=Array.from(entries.values()).map(publicRecord)
      .sort((a,b)=>priority(a.state)-priority(b.state)
        || b.createdAt.localeCompare(a.createdAt)).slice(0,200);
    return json({sessions});
  }
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  const body=await readBody(request);
  if(!body)return json({error:'Invalid session request'},400);

  if(action==='request'){
    const {id,tokenHash,connectorKind,connectorId,connectorHash,
      scope,devices,tools,note}=body;
    if(!uuid(id)||!hash(tokenHash)||!hash(connectorHash)
      || !['device','zone'].includes(String(connectorKind))
      || !uuid(connectorId)&&!(connectorKind==='device'&&connectorId==='local')
      || !['device','devices','zone/all'].includes(String(scope))
      || (connectorKind==='device'&&scope!=='device')
      || (connectorKind==='zone'&&scope==='device')
      || !Array.isArray(devices)||devices.length>32
      || devices.some(d=>!uuid(d))
      || new Set(devices).size!==devices.length
      || (scope==='devices'&&devices.length===0)
      || (scope!=='devices'&&devices.length!==0)
      || !validAgentSessionTools(tools)
      || typeof note!=='string'||note.length>160){
      return json({error:'Invalid session access scope or request'},400);
    }
    const now=Date.now();
    const record:AgentSessionRecord={
      id:id as string,tokenHash:tokenHash as string,
      connectorKind:connectorKind as 'device'|'zone',
      connectorId:connectorId as string,connectorHash:connectorHash as string,
      scope:scope as AgentSessionRecord['scope'],devices:devices as string[],
      tools:tools as string[],requestedTools:tools as string[],
      idleHours:24,note:note as string,
      createdAt:new Date(now).toISOString(),
      pendingUntil:new Date(now+15*60_000).toISOString(),state:'pending'
    };
    // Random id collision is unlikely; never overwrite an existing grant.
    return storage.transaction(async tx=>{
      if(await tx.get(key(record.id)))return json({error:'Duplicate request'},409);
      const entries=await tx.list<AgentSessionRecord>({prefix:'agent-session:'});
      const matching=(entry:AgentSessionRecord)=>
        entry.connectorKind===record.connectorKind
        && entry.connectorId===record.connectorId
        && entry.connectorHash===record.connectorHash;
      // The pending queue and approved grants are separate logical pools.
      // Expired pending requests consume neither pool; one Zone or device
      // connector cannot monopolize the other connectors' active slots.
      const activePending=Array.from(entries.values()).filter(entry=>
        matching(entry)&&effectiveState(entry)==='pending'
      );
      if(activePending.length>=MAX_PENDING_PER_CONNECTOR){
        return json({error:'Too many pending approvals for this connector (maximum 10)'},429);
      }
      const activeApproved=Array.from(entries.values()).filter(entry=>
        matching(entry)&&effectiveState(entry)==='approved'
      );
      if(activeApproved.length>=MAX_APPROVED_PER_CONNECTOR){
        return json({error:'Active approval limit for this connector reached'},429);
      }
      // Preserve the existing hourly anti-spam control, including requests
      // that expired 15 minutes after creation. Do not prune their audit row
      // until the one-hour rate-limit window has elapsed.
      const recent=Array.from(entries.values()).filter(entry=>
        matching(entry)&&Date.parse(entry.createdAt)>now-HOUR_MS
      );
      if(recent.length>=REQUESTS_PER_HOUR){
        return json({error:'Too many session requests; retry later'},429);
      }
      const inactive=Array.from(entries.entries()).filter(([,entry])=>
        !['pending','approved'].includes(effectiveState(entry))
      ).sort((a,b)=>a[1].createdAt.localeCompare(b[1].createdAt));
      const drop=new Set(inactive.filter(([,entry])=>
        Date.parse(entry.createdAt)<=now-HOUR_MS
        && ((entry.state==='pending'&&effectiveState(entry)==='expired'
            && Date.parse(entry.pendingUntil)<=now-HOUR_MS)
          || ((entry.state==='revoked'||entry.state==='rejected')
            && Date.parse(entry.endedAt||entry.createdAt)<now-AUDIT_RETENTION_MS)
          || (entry.state==='approved'&&effectiveState(entry)==='expired'
            && Date.parse(entry.hardUntil||entry.createdAt)<now-AUDIT_RETENTION_MS))
      ).map(([entryKey])=>entryKey));
      // Completed/expired records are a best-effort history pool with a
      // bounded size. Never count an approved grant or another Zone's pending
      // request against this connector's pending admission. No shared global
      // 300-record admission limit remains.
      let retainedHistory=inactive.length;
      for(const [entryKey,entry] of inactive){
        if(drop.has(entryKey)){
          retainedHistory--;
          continue;
        }
        if(retainedHistory>MAX_RETAINED_HISTORY
          && Date.parse(entry.createdAt)<=now-HOUR_MS){
          drop.add(entryKey);
          retainedHistory--;
        }
      }
      if(drop.size){
        const expiredKeys=[...drop];
        // Cloudflare Durable Object storage delete(array) accepts at most
        // 128 keys per call, even inside a transaction. Old staging stores
        // can contain hundreds of stale requests from the former policy.
        for(let offset=0;offset<expiredKeys.length;offset+=128){
          await tx.delete(expiredKeys.slice(offset,offset+128));
        }
      }
      await tx.put(key(record.id),record);
      return json({id:record.id,pendingUntil:record.pendingUntil,state:'pending'},201);
    });
  }
  if(!['status','authorize','approve','reject','revoke','edit','extend'].includes(action)){
    return json({error:'Unknown session operation'},404);
  }
  if(!uuid(body.id))return json({error:'Invalid session ID'},400);
  return storage.transaction(async tx=>{
    const id=body.id as string;
    const record=await tx.get<AgentSessionRecord>(key(id));
    if(!record)return json({error:'Session not found'},404);

    if(action==='status'||action==='authorize'){
      if(!hash(body.tokenHash)||record.tokenHash!==body.tokenHash
        || !hash(body.connectorHash)||!sameConnector(record,body)){
        return json({error:'Session not found'},404);
      }
      const state=effectiveState(record);
      if(action==='status'){
        return json({session:publicRecord(record)});
      }
      if(state!=='approved')return json({authorized:false,state},403);
      const tool=body.tool;
      const deviceId=body.deviceId;
      if(typeof tool!=='string'||!uuid(deviceId)
        || (!record.tools.includes('*')&&!record.tools.includes(tool))
        || (record.scope==='device'&&deviceId!==record.connectorId)
        || (record.scope==='devices'&&!record.devices.includes(deviceId as string))){
        return json({authorized:false,state:'out_of_scope'},403);
      }
      // The edge verifies current Zone membership on every Zone request.
      const now=Date.now();
      record.lastUsedAt=new Date(now).toISOString();
      record.idleUntil=new Date(Math.min(
        now+record.idleHours*60*60_000,
        Date.parse(record.hardUntil!)
      )).toISOString();
      await tx.put(key(id),record);
      return json({authorized:true,id:record.id,hardUntil:record.hardUntil});
    }

    if(action==='edit'||action==='extend'){
      // Never revive an expired or revoked token, even if its stored state
      // still says 'approved'. Each operation is atomic in the owner DO.
      if(effectiveState(record)!=='approved'){
        return json({error:'Only active approved sessions may be changed'},409);
      }
      if(action==='edit'){
        if(!validAgentSessionTools(body.approvedTools)){
          return json({error:'Invalid owner-selected tool grant'},400);
        }
        record.tools=[...body.approvedTools];
      }else{
        const hours=body.approvedHours;
        if(!Number.isInteger(hours)||Number(hours)<1||Number(hours)>720){
          return json({error:'Extension must be 1 to 720 hours from now'},400);
        }
        const now=Date.now();
        record.approvedHours=hours as number;
        record.hardUntil=new Date(now+(hours as number)*60*60_000).toISOString();
        // Extension resets inactivity to a fresh owner-selected window,
        // capped by the newly selected hard deadline. No token rotation.
        record.idleUntil=new Date(Math.min(
          now+record.idleHours*60*60_000,Date.parse(record.hardUntil)
        )).toISOString();
      }
      await tx.put(key(id),record);
      return json({session:publicRecord(record)});
    }

    if(action==='approve'){
      if(effectiveState(record)!=='pending'){
        return json({error:'Session is not pending'},409);
      }
      // Requests may be pending while the owner approves other sessions.
      // Recheck the approved pool transactionally so rapid approvals cannot
      // exceed this connector's effective owner-authorized quota.
      const existing=await tx.list<AgentSessionRecord>({prefix:'agent-session:'});
      const currentlyApproved=Array.from(existing.values()).filter(other=>
        other.connectorKind===record.connectorKind
        && other.connectorId===record.connectorId
        && other.connectorHash===record.connectorHash
        && effectiveState(other)==='approved'
      );
      if(currentlyApproved.length>=MAX_APPROVED_PER_CONNECTOR){
        return json({error:'Active approval limit for this connector reached'},429);
      }
      const hours=body.approvedHours;
      const idleHours=body.idleHours??record.idleHours;
      if(!Number.isInteger(hours)||Number(hours)<1||Number(hours)>720){
        return json({error:'Owner must choose a duration from 1 to 720 hours'},400);
      }
      if(idleHours!==24&&idleHours!==48){
        return json({error:'Inactivity limit must be 24 or 48 hours'},400);
      }
      // Owner may intentionally broaden or narrow tool access. This path is
      // available ONLY behind Relay Admin authentication, never over MCP.
      // Scope and device coverage do not change. Old clients/approvals remain
      // compatible when approvedTools is omitted.
      const approvedTools=body.approvedTools===undefined?record.tools:body.approvedTools;
      if(!validAgentSessionTools(approvedTools)){
        return json({error:'Invalid owner-selected tool grant'},400);
      }
      const now=Date.now();
      record.state='approved';
      record.approvedHours=hours as number;
      record.idleHours=idleHours;
      record.requestedTools??=[...record.tools];
      record.tools=[...approvedTools];
      record.approvedAt=new Date(now).toISOString();
      record.hardUntil=new Date(now+(hours as number)*60*60_000).toISOString();
      record.idleUntil=new Date(now+Math.min(hours as number,record.idleHours)*60*60_000).toISOString();
    }else if(action==='reject'){
      if(effectiveState(record)!=='pending'){
        return json({error:'Only pending sessions may be rejected'},409);
      }
      record.state='rejected';
      record.endedAt=new Date().toISOString();
    }else{
      if(record.state==='revoked')return json({session:publicRecord(record)});
      record.state='revoked';
      record.endedAt=new Date().toISOString();
    }
    await tx.put(key(id),record);
    return json({session:publicRecord(record)});
  });
}
