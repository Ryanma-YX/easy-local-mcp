import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('stable MCP gateways stay lazy, require unlock, validate and forward external tools',async t=>{
  const root=await mkdtemp(join(tmpdir(),'localmcp-gateway-'));

  t.after(
    ()=>rm(
      root,
      {
        recursive:true,
        force:true,
        maxRetries:5,
        retryDelay:100
      }
    )
  );

  const names=join(root,'tools.json');
  const configPath=join(root,'config.json');
  const stateDir=join(root,'.localmcp');

  await mkdir(stateDir,{recursive:true});
  await writeFile(names,JSON.stringify(['echo','second']));

  await writeFile(
    configPath,
    JSON.stringify({
      root,
      features:{
        files:true,
        shell:false,
        processes:false,
        externalMcp:true
      },
      mcpServers:{
        external:{
          command:process.execPath,
          args:[
            resolve('test/fixtures/mcp-server.mjs'),
            names
          ]
        }
      }
    })
  );

  await writeFile(
    join(stateDir,'unlock.json'),
    JSON.stringify({
      until:Date.now()+60_000
    })
  );

  const client=new Client({
    name:'gateway-test',
    version:'1'
  });

  const transport=new StdioClientTransport({
    command:process.execPath,
    args:[
      resolve('dist/index.js'),
      'stdio'
    ],
    env:{
      ...process.env,
      HOME:root,
      USERPROFILE:root,
      LOCALMCP_CONFIG:configPath
    } as Record<string,string>,
    stderr:'pipe'
  });

  t.after(()=>client.close());

  await client.connect(transport);

  const call=(name:string,args:Record<string,unknown>={})=>
    client.callTool({
      name,
      arguments:args
    }) as Promise<any>;

  const top=await client.listTools();

  assert.equal(top.tools.length,20);
  assert.ok(!top.tools.some(tool=>tool.name.startsWith('external_')));

  const gateway=top.tools.find(
    tool=>tool.name==='call_mcp_tool'
  )!;

  assert.equal(gateway.annotations,undefined);

  assert.deepEqual(
    JSON.parse(
      (await call('list_mcp_servers')).content[0].text
    ),
    {
      servers:[
        {
          name:'external',
          running:false
        }
      ]
    }
  );

  const discovered=JSON.parse(
    (
      await call(
        'list_mcp_tools',
        {
          server:'external'
        }
      )
    ).content[0].text
  );

  assert.deepEqual(
    discovered.tools.map(
      (tool:any)=>tool.name
    ),
    ['echo','second']
  );

  assert.deepEqual(
    discovered.tools[0].inputSchema.required,
    ['text']
  );

  assert.equal(
    discovered.tools[0].annotations.readOnlyHint,
    true
  );

  assert.deepEqual(
    JSON.parse(
      (await call('list_mcp_servers')).content[0].text
    ),
    {
      servers:[
        {
          name:'external',
          running:true
        }
      ]
    }
  );

  const result=await call(
    'call_mcp_tool',
    {
      server:'external',
      tool:'echo',
      arguments:{
        text:'hello'
      }
    }
  );

  assert.equal(result.isError,false);

  assert.deepEqual(
    result.content,
    [
      {
        type:'text',
        text:'{"text":"hello"}'
      },
      {
        type:'image',
        mimeType:'image/png',
        data:'aGVsbG8='
      }
    ]
  );

  assert.deepEqual(
    result.structuredContent,
    {
      tool:'echo'
    }
  );

  assert.equal(
    (
      await call(
        'call_mcp_tool',
        {
          server:'external',
          tool:'echo',
          arguments:{
            text:'fail'
          }
        }
      )
    ).isError,
    true
  );

  for(const args of [
    {},
    {text:1},
    {
      text:'ok',
      extra:true
    }
  ]){
    const invalid=await call(
      'call_mcp_tool',
      {
        server:'external',
        tool:'echo',
        arguments:args
      }
    );

    assert.equal(invalid.isError,true);
    assert.match(
      invalid.content[0].text,
      /Invalid arguments/
    );
  }

  assert.equal(
    (
      await call(
        'call_mcp_tool',
        {
          server:'missing',
          tool:'echo'
        }
      )
    ).isError,
    true
  );

  assert.equal(
    (
      await call(
        'call_mcp_tool',
        {
          server:'external',
          tool:'missing'
        }
      )
    ).isError,
    true
  );

  assert.equal(
    (
      await call(
        'external_echo',
        {
          text:'hello'
        }
      )
    ).isError,
    true
  );

  await writeFile(
    names,
    JSON.stringify(['new_tool'])
  );

  const changed=JSON.parse(
    (
      await call(
        'list_mcp_tools',
        {
          server:'external'
        }
      )
    ).content[0].text
  );

  assert.deepEqual(
    changed.tools.map(
      (tool:any)=>tool.name
    ),
    ['new_tool']
  );

  assert.equal(
    (
      await call(
        'call_mcp_tool',
        {
          server:'external',
          tool:'new_tool',
          arguments:{
            text:'ok'
          }
        }
      )
    ).isError,
    false
  );

  assert.equal(
    (
      await call(
        'call_mcp_tool',
        {
          server:'external',
          tool:'echo',
          arguments:{
            text:'ok'
          }
        }
      )
    ).isError,
    true
  );

  await rm(
    join(stateDir,'unlock.json'),
    {
      force:true
    }
  );

  const locked=await client.listTools();

  assert.ok(
    !locked.tools.some(
      tool=>tool.name==='list_mcp_tools'
    )
  );

  assert.ok(
    !locked.tools.some(
      tool=>tool.name==='call_mcp_tool'
    )
  );

  assert.equal(
    (
      await call(
        'call_mcp_tool',
        {
          server:'external',
          tool:'new_tool',
          arguments:{
            text:'blocked'
          }
        }
      )
    ).isError,
    true
  );
});
