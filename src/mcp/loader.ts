import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { OwnedStdioClientTransport } from './owned-stdio-transport.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// Forced shutdown must not wait indefinitely for SDK connection promises
// whose launcher has already exited but whose stdio descendants were alive.
function settledWithin(operations:Promise<unknown>[],timeoutMs:number):Promise<void>{
  if(operations.length===0)return Promise.resolve();
  return new Promise(resolve=>{
    const timer=setTimeout(resolve,timeoutMs);
    void Promise.allSettled(operations).then(()=>{
      clearTimeout(timer);
      resolve();
    });
  });
}

export interface McpServerConfig { command:string; args?:string[]; env?:Record<string,string>; }
interface Loaded { name:string; client:Client; tools:Tool[]; }
export class McpLoader {
  private loaded:Loaded[]=[];
  private starting=new Map<string,Promise<Loaded>>();
  private pending=new Set<Promise<unknown>>();
  private clients=new Set<Client>();
  private transports=new Set<OwnedStdioClientTransport>();
  private closing=false;
  private cleanup?:Promise<void>;
  private track<T>(operation:Promise<T>):Promise<T>{this.pending.add(operation);return operation.finally(()=>this.pending.delete(operation));}
  constructor(private servers:Record<string,McpServerConfig>){}

  private getLoaded(name:string){return this.loaded.find(server=>server.name===name);}

  private async ensure(name:string):Promise<Loaded>{
    if(this.closing)throw new Error('MCP loader is shutting down');
    const existing=this.getLoaded(name);if(existing)return existing;
    const inFlight=this.starting.get(name);if(inFlight)return inFlight;
    const cfg=this.servers[name];if(!cfg)throw new Error(`Unknown MCP server '${name}'`);
    const operation=(async()=>{
      const client=new Client({name:`easy-local-mcp-${name}`,version:'0.4.0'});
      const transport=new OwnedStdioClientTransport({command:cfg.command,args:cfg.args||[],env:cfg.env,stderr:'inherit'});
      this.clients.add(client);
      this.transports.add(transport);
      const server={name,client,tools:[] as Tool[]};
      try{
        await client.connect(transport);
        if(this.closing)throw new Error('MCP loader is shutting down');
        await this.refresh(server);
        if(this.closing)throw new Error('MCP loader is shutting down');
        this.loaded.push(server);
        return server;
      }catch(error){
        // Failed handshakes may already have spawned a wrapper and child.
        // Stop that owned group before closing a possibly stalled transport.
        transport.terminateOwned();
        try{await client.close().catch(()=>{});}
        finally{
          this.clients.delete(client);
          this.transports.delete(transport);
        }
        throw error;
      }finally{
        this.starting.delete(name);
      }
    })();
    this.starting.set(name,operation);
    return operation;
  }

  async start(){
    try{for(const name of Object.keys(this.servers))await this.ensure(name);}
    catch(error){await this.close();throw error;}
  }

  private async refresh(server:Loaded):Promise<Tool[]> {
    const tools:Tool[]=[];let cursor:string|undefined;
    do{const page=await server.client.listTools({cursor});tools.push(...page.tools);cursor=page.nextCursor;}while(cursor);
    server.tools=tools;
    return tools;
  }

  listServers(){return Object.keys(this.servers).map(name=>({name,running:!!this.getLoaded(name)}));}

  async listTools(server:string):Promise<Tool[]> {
    return this.track((async()=>this.refresh(await this.ensure(server)))());
  }

  async call(serverName:string,toolName:string,args:Record<string,unknown>){
    const server=await this.ensure(serverName);
    const tool=server.tools.find(tool=>tool.name===toolName);
    if(!tool)throw new Error(`Unknown MCP tool '${toolName}' on server '${serverName}'; use list_mcp_tools first`);
    const validation=new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args);
    if(!validation.valid)throw new Error(`Invalid arguments for MCP tool '${toolName}': ${validation.errorMessage}`);
    return this.track(server.client.callTool({name:toolName,arguments:args},undefined,{timeout:60000}));
  }

  /**
   * Normal close drains calls (including config hot-reload).
   * Forced close is for process shutdown: stop children immediately, then
   * settle the client transports without waiting for slow MCP calls.
   */
  close(options:{force?:boolean}={}):Promise<void>{
    if(options.force){
      for(const transport of this.transports)transport.terminateOwned();
    }
    if(this.cleanup){
      return options.force?settledWithin([this.cleanup],1500):this.cleanup;
    }
    this.closing=true;
    this.cleanup=(async()=>{
      if(!options.force){
        await Promise.allSettled([...this.pending,...this.starting.values()]);
      }
      const clients=[...this.clients].map(client=>client.close());
      if(options.force){
        await settledWithin(clients,1000);
      }else{
        await Promise.allSettled(clients);
      }
      // SDK close may only terminate a launcher, not its stdio-serving child.
      // After graceful transport closure, finish cleanup of owned groups.
      for(const transport of this.transports)transport.terminateOwned();
      const operations=[...this.pending,...this.starting.values()];
      if(options.force){
        // No need to await a handshake that can no longer complete: process
        // groups have already been killed, and late ensure() paths reject
        // because closing is true. Observe promises to consume rejections.
        void Promise.allSettled(operations);
      }else{
        await Promise.allSettled(operations);
      }
      this.loaded=[];
      this.starting.clear();
      this.clients.clear();
      this.transports.clear();
    })();
    return this.cleanup;
  }
}
