import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// This wrapper stays alive while its child owns the MCP stdio channel.
// Killing only the wrapper cannot be treated as killing the MCP server.
const [serverMarker,pendingMarker,wrapperMarker,exitMode]=process.argv.slice(2);
const child=spawn(process.execPath,[
  resolve('test/fixtures/persistent-mcp-server.mjs'),
  serverMarker,pendingMarker
],{stdio:'inherit'});
child.once('error',error=>{
  console.error('MCP fixture child failed:',error);
  process.exitCode=1;
});
await writeFile(wrapperMarker,String(process.pid));
if(exitMode==='exit-immediate')process.exit(0);
if(exitMode==='exit-early'){
  // The stdio-serving descendant keeps the inherited IPC pipes after this
  // wrapper exits; the transport must retain ownership of the group.
  setTimeout(()=>process.exit(0),900);
}
setInterval(()=>{},1000);
