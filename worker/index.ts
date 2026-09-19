import {
  Assembly,
  frames,
  parseFrame,
  MAX_CONCURRENT_REQUESTS
} from '../src/relay-protocol';

interface Env {
  RELAY:DurableObjectNamespace;
  MCP_TOKEN_HASH?:string;
  AGENT_TOKEN_HASH?:string;
  REGISTRATION_TOKEN_HASH?:string;
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
    return {
      response:json({error:'Registration failed'},500)
    };
  }

  return {
    response:json(
      {
        deviceId,
        agentToken,
        mcpToken,
        workerUrl:origin,
        mcpUrl:`${origin}/mcp/${deviceId}/${mcpToken}`
      },
      201
    )
  };
}

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url);

    if(url.pathname==='/healthz'&&request.method==='GET'){
      return json({
        ok:true,
        service:'easy-local-mcp-relay',
        registration:true,
        registrationProtected:!!env.REGISTRATION_TOKEN_HASH
      });
    }

    if(request.headers.has('Origin')){
      return json({error:'Origin not allowed'},403);
    }

    if(url.pathname==='/register'&&request.method==='POST'){
      if(
        env.REGISTRATION_TOKEN_HASH
        && !await authorized(bearer(request),env.REGISTRATION_TOKEN_HASH)
      ){
        return new Response(null,{status:404});
      }

      return (await createRegistration(env,url.origin)).response;
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

interface Pending {
  socket:WebSocket;
  assembly:Assembly;
  resolve:(response:Response)=>void;
  timer:ReturnType<typeof setTimeout>;
}

export class McpRelay {
  private pending=new Map<string,Pending>();

  constructor(private ctx:DurableObjectState){
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping','pong')
    );
  }

  async fetch(request:Request):Promise<Response>{
    const url=new URL(request.url);

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

    if(!legacy){
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

    if(this.pending.size>=MAX_CONCURRENT_REQUESTS){
      return json(
        {
          error:`Local agent has reached the ${MAX_CONCURRENT_REQUESTS}-request concurrency limit. Do not automatically retry write operations.`
        },
        429
      );
    }

    const id=crypto.randomUUID();
    const body=await request.text();

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
          timer
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
