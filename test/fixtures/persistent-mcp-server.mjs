import {writeFile} from 'node:fs/promises';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';

const marker=process.argv[2];
const requestMarker=process.argv[3];
const server=new Server({name:'persistent-test-mcp',version:'1'},{
  capabilities:{tools:{}}
});
server.setRequestHandler(ListToolsRequestSchema,async()=>({
  tools:[{name:'stall',description:'Deliberately pending test request',
    inputSchema:{type:'object',properties:{}}}]
}));
server.setRequestHandler(CallToolRequestSchema,async()=>{
  if(requestMarker)await writeFile(requestMarker,'pending');
  await new Promise(()=>{});
  return {content:[]};
});
await server.connect(new StdioServerTransport());
await writeFile(marker,String(process.pid));
setInterval(()=>{},1000);
