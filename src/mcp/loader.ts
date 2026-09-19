import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface McpServerConfig { command:string; args?:string[]; env?:Record<string,string>; }
interface Loaded { name:string; client:Client; tools:Tool[]; }
export class McpLoader {
  private loaded:Loaded[]=[];
  private starting=new Map<string,Promise<Loaded>>();
  private pending=new Set<Promise<unknown>>();
  private track<T>(operation:Promise<T>):Promise<T>{this.pending.add(operation);return operation.finally(()=>this.pending.delete(operation));}
  constructor(private servers:Record<string,McpServerConfig>){}

  private getLoaded(name:string){return this.loaded.find(server=>server.name===name);}

  private async ensure(name:string):Promise<Loaded>{
    const existing=this.getLoaded(name);if(existing)return existing;
    const inFlight=this.starting.get(name);if(inFlight)return inFlight;
    const cfg=this.servers[name];if(!cfg)throw new Error(`Unknown MCP server '${name}'`);
    const operation=(async()=>{
      const client=new Client({name:`easy-local-mcp-${name}`,version:'0.4.0'});
      const transport=new StdioClientTransport({command:cfg.command,args:cfg.args||[],env:cfg.env,stderr:'inherit'});
      const server={name,client,tools:[] as Tool[]};
      try{
        await client.connect(transport);
        await this.refresh(server);
        this.loaded.push(server);
        return server;
      }catch(error){
        await client.close().catch(()=>{});
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

  async close(){
    await Promise.allSettled([...this.pending,...this.starting.values()]);
    await Promise.allSettled(this.loaded.map(server=>server.client.close()));
    this.loaded=[];
    this.starting.clear();
  }
}
