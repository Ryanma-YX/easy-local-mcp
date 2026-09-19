interface ZoneMcpEnv {
  RELAY:DurableObjectNamespace;
  ZONE:DurableObjectNamespace;
}

interface ZoneDevice {
  deviceId:string;
  name:string;
  platform?:string;
  arch?:string;
  version?:string;
  joinedAt:string;
}

interface ZoneContext {
  name:string;
  createdAt:string;
  devices:ZoneDevice[];
}

interface RpcRequest {
  jsonrpc?:unknown;
  id?:string|number|null;
  method?:unknown;
  params?:unknown;
}

interface McpTool {
  name:string;
  description?:string;
  inputSchema:Record<string,unknown>;
  [key:string]:unknown;
}

function relay(env:ZoneMcpEnv,deviceId:string){
  return env.RELAY.get(env.RELAY.idFromName(deviceId));
}

function zone(env:ZoneMcpEnv,zoneId:string){
  return env.ZONE.get(env.ZONE.idFromName(zoneId));
}

function jsonResponse(value:unknown,status=200){
  return Response.json(
    value,
    {
      status,
      headers:{
        'Cache-Control':'no-store',
        'Content-Type':'application/json'
      }
    }
  );
}

function rpcResult(id:RpcRequest['id'],result:unknown){
  return jsonResponse({
    jsonrpc:'2.0',
    id:id??null,
    result
  });
}

function rpcError(
  id:RpcRequest['id'],
  code:number,
  message:string,
  data?:unknown
){
  return jsonResponse({
    jsonrpc:'2.0',
    id:id??null,
    error:{
      code,
      message,
      ...(data===undefined?{}:{data})
    }
  });
}

async function context(
  env:ZoneMcpEnv,
  zoneId:string,
  token:string
):Promise<ZoneContext|null>{
  const response=await zone(env,zoneId).fetch(
    new Request(
      'https://zone.internal/mcp-context',
      {
        headers:{
          'x-zone-mcp-token':token
        }
      }
    )
  );

  if(!response.ok){
    return null;
  }

  return await response.json() as ZoneContext;
}

async function deviceOnline(env:ZoneMcpEnv,deviceId:string){
  const response=await relay(env,deviceId).fetch(
    new Request(
      'https://relay.internal/status',
      {
        headers:{
          'x-localmcp-internal':'1'
        }
      }
    )
  );

  if(!response.ok)return false;

  const value=await response.json() as {online?:boolean};
  return value.online===true;
}

async function forward(
  env:ZoneMcpEnv,
  deviceId:string,
  body:string,
  protocolVersion:string|null
){
  const headers=new Headers({
    'Content-Type':'application/json',
    'Accept':'application/json, text/event-stream',
    'x-localmcp-internal':'1'
  });

  if(protocolVersion){
    headers.set('MCP-Protocol-Version',protocolVersion);
  }

  return relay(env,deviceId).fetch(
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

async function deviceTools(
  env:ZoneMcpEnv,
  device:ZoneDevice,
  protocolVersion:string|null
){
  const request={
    jsonrpc:'2.0',
    id:`zone-tools-${device.deviceId}`,
    method:'tools/list',
    params:{}
  };

  const response=await forward(
    env,
    device.deviceId,
    JSON.stringify(request),
    protocolVersion
  );

  if(!response.ok){
    return [] as McpTool[];
  }

  try{
    const payload=await response.json() as {
      result?:{
        tools?:McpTool[];
      };
    };

    return Array.isArray(payload.result?.tools)
      ? payload.result!.tools!
      : [];
  }catch{
    return [];
  }
}

function routedTool(tool:McpTool,deviceNames:string[]):McpTool{
  const schema=
    tool.inputSchema
    && typeof tool.inputSchema==='object'
    && !Array.isArray(tool.inputSchema)
      ? tool.inputSchema
      : {};

  const properties=
    schema.properties
    && typeof schema.properties==='object'
    && !Array.isArray(schema.properties)
      ? schema.properties as Record<string,unknown>
      : {};

  const required=Array.isArray(schema.required)
    ? schema.required.filter(value=>typeof value==='string') as string[]
    : [];

  const available=deviceNames.length
    ? ` Available on: ${deviceNames.join(', ')}.`
    : '';

  return {
    ...tool,
    description:
      `${tool.description||tool.name}. Target a Zone device with the device argument.${available}`,
    inputSchema:{
      ...schema,
      type:'object',
      properties:{
        device:{
          type:'string',
          description:'Target device name or device ID from list_devices.'
        },
        ...properties
      },
      required:Array.from(new Set(['device',...required]))
    }
  };
}

async function mergedTools(
  env:ZoneMcpEnv,
  devices:ZoneDevice[],
  protocolVersion:string|null
){
  const discovered=await Promise.all(
    devices.map(async device=>({
      device,
      tools:await deviceTools(env,device,protocolVersion)
    }))
  );

  const merged=new Map<
    string,
    {
      tool:McpTool;
      devices:string[];
    }
  >();

  for(const item of discovered){
    for(const tool of item.tools){
      const current=merged.get(tool.name);

      if(current){
        if(!current.devices.includes(item.device.name)){
          current.devices.push(item.device.name);
        }
      }else{
        merged.set(
          tool.name,
          {
            tool,
            devices:[item.device.name]
          }
        );
      }
    }
  }

  return Array.from(merged.values())
    .sort((left,right)=>left.tool.name.localeCompare(right.tool.name))
    .map(item=>routedTool(item.tool,item.devices));
}

function selectDevice(devices:ZoneDevice[],value:string){
  const byId=devices.find(device=>device.deviceId===value);
  if(byId)return {device:byId};

  const normalized=value.trim().toLowerCase();
  const matches=devices.filter(
    device=>device.name.trim().toLowerCase()===normalized
  );

  if(matches.length===1){
    return {device:matches[0]};
  }

  if(matches.length>1){
    return {
      error:'Device name is ambiguous. Use the device ID from list_devices.'
    };
  }

  return {
    error:`Unknown Zone device '${value}'. Use list_devices to see available devices.`
  };
}

async function listDeviceResult(
  env:ZoneMcpEnv,
  zoneContext:ZoneContext
){
  const devices=await Promise.all(
    zoneContext.devices.map(async device=>({
      ...device,
      online:await deviceOnline(env,device.deviceId)
    }))
  );

  return {
    content:[
      {
        type:'text',
        text:JSON.stringify(
          {
            zone:zoneContext.name,
            devices
          }
        )
      }
    ]
  };
}

export async function handleZoneMcp(
  request:Request,
  env:ZoneMcpEnv,
  zoneId:string,
  token:string,
  body:string
):Promise<Response>{
  const zoneContext=await context(env,zoneId,token);
  if(!zoneContext){
    return new Response(null,{status:404});
  }

  let rpc:RpcRequest;
  try{
    rpc=JSON.parse(body) as RpcRequest;
  }catch{
    return rpcError(null,-32700,'Parse error');
  }

  const method=typeof rpc.method==='string'?rpc.method:'';
  const protocolVersion=request.headers.get('MCP-Protocol-Version');

  if(method==='initialize'){
    const params=
      rpc.params
      && typeof rpc.params==='object'
      && !Array.isArray(rpc.params)
        ? rpc.params as Record<string,unknown>
        : {};

    const requestedVersion=
      typeof params.protocolVersion==='string'
        ? params.protocolVersion
        : '2025-06-18';

    return rpcResult(
      rpc.id,
      {
        protocolVersion:requestedVersion,
        capabilities:{
          tools:{}
        },
        serverInfo:{
          name:'easy-local-mcp-zone',
          version:'0.4.0'
        },
        instructions:
          'Use list_devices first when device names or online state are unknown. Other tools require a device argument.'
      }
    );
  }

  if(method==='notifications/initialized'){
    return new Response(
      null,
      {
        status:202,
        headers:{
          'Cache-Control':'no-store'
        }
      }
    );
  }

  if(method==='ping'){
    return rpcResult(rpc.id,{});
  }

  if(method==='tools/list'){
    const routed=await mergedTools(
      env,
      zoneContext.devices,
      protocolVersion
    );

    return rpcResult(
      rpc.id,
      {
        tools:[
          {
            name:'list_devices',
            description:'List devices in this LocalMCP Zone, including online state and platform metadata.',
            inputSchema:{
              type:'object',
              properties:{},
              additionalProperties:false
            }
          },
          ...routed
        ]
      }
    );
  }

  if(method==='tools/call'){
    const params=
      rpc.params
      && typeof rpc.params==='object'
      && !Array.isArray(rpc.params)
        ? rpc.params as Record<string,unknown>
        : {};

    const name=typeof params.name==='string'?params.name:'';
    const args=
      params.arguments
      && typeof params.arguments==='object'
      && !Array.isArray(params.arguments)
        ? params.arguments as Record<string,unknown>
        : {};

    if(name==='list_devices'){
      return rpcResult(
        rpc.id,
        await listDeviceResult(env,zoneContext)
      );
    }

    const deviceValue=typeof args.device==='string'?args.device.trim():'';
    if(!deviceValue){
      return rpcResult(
        rpc.id,
        {
          isError:true,
          content:[
            {
              type:'text',
              text:'A device argument is required. Call list_devices to select a target device.'
            }
          ]
        }
      );
    }

    const selected=selectDevice(zoneContext.devices,deviceValue);
    if(!selected.device){
      return rpcResult(
        rpc.id,
        {
          isError:true,
          content:[
            {
              type:'text',
              text:selected.error||'Device not found.'
            }
          ]
        }
      );
    }

    const forwardedArgs={...args};
    delete forwardedArgs.device;

    const forwardedBody=JSON.stringify({
      jsonrpc:'2.0',
      id:rpc.id??null,
      method:'tools/call',
      params:{
        name,
        arguments:forwardedArgs
      }
    });

    const response=await forward(
      env,
      selected.device.deviceId,
      forwardedBody,
      protocolVersion
    );

    const responseText=await response.text();

    if(!response.ok){
      let message=
        response.status===503
          ? `Device '${selected.device.name}' is offline.`
          : `Device '${selected.device.name}' returned HTTP ${response.status}.`;

      try{
        const failure=JSON.parse(responseText) as {error?:unknown};
        if(typeof failure.error==='string'){
          message=failure.error;
        }
      }catch{}

      return rpcResult(
        rpc.id,
        {
          isError:true,
          content:[
            {
              type:'text',
              text:message
            }
          ]
        }
      );
    }

    try{
      JSON.parse(responseText);
    }catch{
      return rpcError(
        rpc.id,
        -32603,
        `Device '${selected.device.name}' returned an invalid MCP response.`
      );
    }

    return new Response(
      responseText,
      {
        status:200,
        headers:{
          'Content-Type':'application/json',
          'Cache-Control':'no-store'
        }
      }
    );
  }

  if(rpc.id===undefined){
    return new Response(
      null,
      {
        status:202,
        headers:{
          'Cache-Control':'no-store'
        }
      }
    );
  }

  return rpcError(rpc.id,-32601,'Method not found');
}
