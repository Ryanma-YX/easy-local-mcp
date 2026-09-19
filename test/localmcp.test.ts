import test from 'node:test';
import assert from 'node:assert/strict';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Workspace} from '../src/workspace.js';
import {runCommand} from '../src/command.js';

const exec=promisify(execFile);

async function temp(t:any){
  const root=await mkdtemp(join(tmpdir(),'localmcp-test-'));

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

  return root;
}

const nodeCommand=(script:string)=>
  `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

test('file boundary, symlinks, hardlinks and overwrite protection',async t=>{
  const root=await temp(t);
  const outside=await temp(t);
  const ws=new Workspace(root);

  await ws.write('a/b.txt','hello',false);

  assert.equal(await ws.read('a/b.txt'),'hello');
  await assert.rejects(ws.write('a/b.txt','bad',false));
  await assert.rejects(ws.read('../outside'));

  await symlink(
    outside,
    join(root,'escape'),
    process.platform==='win32'?'junction':'dir'
  );

  await assert.rejects(ws.write('escape/no.txt','bad',false));

  await writeFile(join(outside,'keep'),'keep');
  await link(join(outside,'keep'),join(root,'hard'));

  await assert.rejects(ws.write('hard','bad',true));
  assert.equal(await readFile(join(outside,'keep'),'utf8'),'keep');
});

test('command results, nonzero exit, bounded output and timeout are cross-platform',async t=>{
  const root=await temp(t);

  assert.equal(
    (
      await runCommand(
        nodeCommand("process.stdout.write('hello')"),
        root,
        1000
      )
    ).output,
    'hello'
  );

  assert.equal(
    (
      await runCommand(
        nodeCommand('process.exit(7)'),
        root,
        1000
      )
    ).exitCode,
    7
  );

  assert.equal(
    (
      await runCommand(
        nodeCommand('setTimeout(()=>{},5000)'),
        root,
        100
      )
    ).timedOut,
    true
  );

  const big=await runCommand(
    nodeCommand("process.stdout.write('x'.repeat(300000))"),
    root,
    3000
  );

  assert.equal(big.truncated,true);
  assert.ok(big.output.length<=262144);
});

test('fresh init uses a dedicated safe workspace instead of exposing the home directory',async t=>{
  const home=await temp(t);

  await exec(
    process.execPath,
    [resolve('dist/index.js'),'init'],
    {
      cwd:home,
      env:{
        ...process.env,
        HOME:home,
        USERPROFILE:home
      },
      timeout:10000
    }
  );

  const cfg=JSON.parse(
    await readFile(
      join(home,'.localmcp','localmcp.json'),
      'utf8'
    )
  );

  assert.equal(
    await realpath(resolve(cfg.workspaces.project)),
    await realpath(resolve(home,'.localmcp','workspace'))
  );

  assert.notEqual(
    await realpath(resolve(cfg.workspaces.project)),
    await realpath(resolve(home))
  );

  assert.deepEqual(
    cfg.features,
    {
      files:{
        read:true,
        write:false,
        delete:false
      },
      shell:false,
      processes:false,
      externalMcp:false
    }
  );
});

test('real SDK stdio honors explicit legacy capabilities but requires local unlock for dangerous tools',async t=>{
  const root=await temp(t);
  const stateDir=join(root,'.localmcp');
  const cfgPath=join(root,'localmcp.json');

  await mkdir(stateDir,{recursive:true});

  await writeFile(
    cfgPath,
    JSON.stringify({
      root:'.',
      features:{
        files:true,
        shell:true,
        processes:true,
        externalMcp:true
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
    name:'test',
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
      LOCALMCP_CONFIG:cfgPath
    } as Record<string,string>,
    stderr:'pipe'
  });

  await client.connect(transport);

  t.after(()=>client.close());

  let tools=await client.listTools();

  assert.equal(tools.tools.length,26);
  assert.ok(tools.tools.some(tool=>tool.name==='run_command'));
  assert.ok(tools.tools.some(tool=>tool.name==='write_file'));

  const call=(name:string,args:any)=>
    client.callTool({
      name,
      arguments:args
    });

  assert.equal(
    (
      await call(
        'write_file',
        {
          path:'hello.txt',
          content:'hello world'
        }
      )
    ).isError,
    undefined
  );

  assert.equal(
    (
      await call(
        'edit_file',
        {
          path:'hello.txt',
          oldText:'world',
          newText:'MCP'
        }
      )
    ).isError,
    undefined
  );

  assert.equal(
    await readFile(join(root,'hello.txt'),'utf8'),
    'hello MCP'
  );

  const commandResult:any=await call(
    'run_command',
    {
      command:nodeCommand(
        "process.stdout.write('shell-enabled')"
      )
    }
  );

  assert.equal(commandResult.isError,undefined);
  assert.equal(
    JSON.parse(commandResult.content[0].text).output,
    'shell-enabled'
  );

  await rm(join(stateDir,'unlock.json'),{force:true});

  tools=await client.listTools();

  assert.equal(tools.tools.length,26);
  assert.ok(tools.tools.some(tool=>tool.name==='run_command'));
  assert.ok(tools.tools.some(tool=>tool.name==='write_file'));
  assert.ok(tools.tools.some(tool=>tool.name==='call_mcp_tool'));

  assert.equal(
    (
      await call(
        'run_command',
        {
          command:nodeCommand(
            "process.stdout.write('must-not-run')"
          )
        }
      )
    ).isError,
    true
  );

  assert.equal(
    (
      await call(
        'write_file',
        {
          path:'locked.txt',
          content:'must not write'
        }
      )
    ).isError,
    true
  );
});

test('HTTP URL credential and origin protection work with secure read-only tools',async t=>{
  const root=await temp(t);
  const token='a'.repeat(64);
  const port=18000+Math.floor(Math.random()*20000);
  const cfgPath=join(root,'localmcp.json');

  await writeFile(
    join(root,'http.txt'),
    'read-only data'
  );

  await writeFile(
    cfgPath,
    JSON.stringify({
      root:'.',
      features:{
        files:{
          read:true,
          write:false,
          delete:false
        },
        shell:false,
        processes:false,
        externalMcp:false
      }
    })
  );

  const child=spawn(
    process.execPath,
    [
      resolve('dist/index.js'),
      'http'
    ],
    {
      env:{
        ...process.env,
        HOME:root,
        USERPROFILE:root,
        LOCALMCP_CONFIG:cfgPath,
        LOCALMCP_PORT:String(port),
        LOCALMCP_TOKEN:token
      },
      stdio:'ignore'
    }
  );

  t.after(()=>{
    child.kill('SIGTERM');
  });

  const base=`http://127.0.0.1:${port}`;

  let ready=false;

  for(let i=0;i<100;i++){
    try{
      if((await fetch(base+'/healthz')).ok){
        ready=true;
        break;
      }
    }catch{}

    await new Promise(
      resolveDelay=>setTimeout(resolveDelay,50)
    );
  }

  assert.ok(ready);
  assert.equal((await fetch(base+'/mcp')).status,404);
  assert.equal((await fetch(base+'/mcp/wrong')).status,404);
  assert.equal(
    (
      await fetch(
        base+'/api/status',
        {
          method:'POST',
          headers:{Authorization:`Bearer ${token}`}
        }
      )
    ).status,
    404
  );

  assert.equal(
    (
      await fetch(
        `${base}/mcp/${token}`,
        {
          headers:{
            Origin:'https://evil.example'
          }
        }
      )
    ).status,
    403
  );

  const client=new Client({
    name:'test',
    version:'1'
  });

  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`${base}/mcp/${token}`)
    )
  );

  t.after(()=>client.close());

  const tools=await client.listTools();

  assert.ok(tools.tools.some(tool=>tool.name==='read_file'));
  assert.ok(!tools.tools.some(tool=>tool.name==='write_file'));
  assert.ok(!tools.tools.some(tool=>tool.name==='run_command'));

  assert.equal(
    (
      await client.callTool({
        name:'write_file',
        arguments:{
          path:'http-write.txt',
          content:'must not write'
        }
      })
    ).isError,
    true
  );

  const result:any=await client.callTool({
    name:'read_file',
    arguments:{
      path:'http.txt'
    }
  });

  assert.equal(
    JSON.parse(result.content[0].text).content,
    'read-only data'
  );
});

test('workspace tree, search, ranged reads, atomic edits and file operations',async t=>{
  const root=await temp(t);
  const ws=new Workspace(root);

  await ws.write(
    'src/a.ts',
    'one\ntwo needle\nthree\nfour',
    false
  );

  await ws.write(
    'src/b.ts',
    'another needle',
    false
  );

  const tree=await ws.tree('.',3,100);

  assert.ok(
    tree.entries.some(entry=>entry.path==='src/a.ts')
  );

  const found=await ws.findFiles('.','*.ts',10);

  assert.deepEqual(
    found.matches.sort(),
    ['src/a.ts','src/b.ts']
  );

  const searched=await ws.search(
    '.',
    'needle',
    false,
    false,
    10,
    1
  );

  assert.equal(searched.matches.length,2);
  assert.equal(searched.matches[0].line,2);

  const range=await ws.readLines(
    'src/a.ts',
    2,
    3
  );

  assert.equal(
    range.content,
    'two needle\nthree'
  );

  assert.equal(range.hasMore,true);

  const hash=(
    await import('node:crypto')
  ).createHash('sha256')
    .update(await ws.read('src/a.ts'))
    .digest('hex');

  await ws.applyEdits(
    'src/a.ts',
    [
      {
        startLine:2,
        endLine:2,
        replacement:'TWO'
      }
    ],
    hash
  );

  assert.equal(
    await ws.read('src/a.ts'),
    'one\nTWO\nthree\nfour'
  );

  await assert.rejects(
    ws.applyEdits(
      'src/a.ts',
      [
        {
          startLine:1,
          endLine:1,
          replacement:'bad'
        }
      ],
      hash
    )
  );

  await ws.createDirectory('empty');
  await ws.move('src/b.ts','empty/b.ts',false);

  assert.equal(
    await ws.read('empty/b.ts'),
    'another needle'
  );

  await ws.delete('empty/b.ts',false);

  await assert.rejects(
    ws.read('empty/b.ts')
  );
});

test('persistent process manager supports stdout, stderr, stdin and stop',async t=>{
  const {ProcessManager}=await import('../src/process.js');
  const root=await temp(t);
  const pm=new ProcessManager();

  const started=pm.start(
    nodeCommand(
      "process.stdin.on('data',d=>{console.log('out:'+d.toString().trim());console.error('err');})"
    ),
    root
  );

  pm.write(
    started.processId,
    'hello\n'
  );

  await new Promise(
    resolveDelay=>setTimeout(resolveDelay,250)
  );

  const result=pm.read(started.processId);

  assert.match(result.stdout,/out:hello/);
  assert.match(result.stderr,/err/);

  pm.stop(started.processId);
  await pm.close();

  await new Promise(
    resolveDelay=>setTimeout(resolveDelay,100)
  );

  assert.ok(
    pm.list().some(
      process=>process.processId===started.processId
    )
  );
});

test('skill loader discovers SKILL.md',async t=>{
  const root=await temp(t);

  await mkdir(join(root,'demo'));

  await writeFile(
    join(root,'demo','SKILL.md'),
    '# Demo\n\nUse demo tools carefully.'
  );

  const {loadSkills}=await import('../src/skills/loader.js');
  const skills=await loadSkills(root);

  assert.equal(skills.length,1);
  assert.equal(skills[0].name,'demo');
  assert.match(skills[0].instructions,/Demo/);
});

test('localmcp.json controls secure granular features, skills and MCP enablement',async t=>{
  const root=await temp(t);

  await mkdir(
    join(root,'skills','one'),
    {
      recursive:true
    }
  );

  await writeFile(
    join(root,'skills','one','SKILL.md'),
    '# One\n\nOne skill.'
  );

  const cfgPath=join(root,'localmcp.json');

  await writeFile(
    cfgPath,
    JSON.stringify({
      root:'.',
      features:{
        files:{
          read:true,
          write:false,
          delete:false
        },
        shell:false,
        processes:false,
        externalMcp:false
      },
      skills:{
        dir:'skills',
        enabled:['one']
      },
      mcpServers:{
        off:{
          enabled:false,
          command:'never-run'
        }
      }
    })
  );

  const old=process.env.LOCALMCP_CONFIG;
  process.env.LOCALMCP_CONFIG=cfgPath;

  try{
    const {config}=await import('../src/config.js');
    const cfg=await config();

    assert.equal(
      await (await import('node:fs/promises')).realpath(cfg.root),
      await (await import('node:fs/promises')).realpath(root)
    );

    assert.equal(cfg.files,true);
    assert.equal(cfg.fileRead,true);
    assert.equal(cfg.fileWrite,false);
    assert.equal(cfg.fileDelete,false);
    assert.equal(cfg.shell,false);
    assert.equal(cfg.processes,false);
    assert.equal(cfg.externalMcp,false);
    assert.deepEqual(cfg.enabledSkills,['one']);
    assert.deepEqual(cfg.mcpServers,{});
  }finally{
    if(old===undefined)delete process.env.LOCALMCP_CONFIG;
    else process.env.LOCALMCP_CONFIG=old;
  }
});

test('legacy files:true migrates to read/write/delete capabilities predictably',async t=>{
  const root=await temp(t);
  const cfgPath=join(root,'legacy.json');

  await writeFile(
    cfgPath,
    JSON.stringify({
      root:'.',
      features:{
        files:true,
        shell:true,
        processes:true
      },
      mcpServers:{
        fixture:{
          command:process.execPath,
          args:[
            resolve('test/fixtures/mcp-server.mjs')
          ]
        }
      }
    })
  );

  const old=process.env.LOCALMCP_CONFIG;
  process.env.LOCALMCP_CONFIG=cfgPath;

  try{
    const {config}=await import('../src/config.js');
    const cfg=await config();

    assert.equal(cfg.fileRead,true);
    assert.equal(cfg.fileWrite,true);
    assert.equal(cfg.fileDelete,true);
    assert.equal(cfg.shell,true);
    assert.equal(cfg.processes,true);
    assert.equal(cfg.externalMcp,true);
  }finally{
    if(old===undefined)delete process.env.LOCALMCP_CONFIG;
    else process.env.LOCALMCP_CONFIG=old;
  }
});

test('localmcp.json schema rejects invalid and unknown config',async t=>{
  const root=await temp(t);
  const cfgPath=join(root,'bad.json');
  const {config}=await import('../src/config.js');
  const old=process.env.LOCALMCP_CONFIG;

  try{
    await writeFile(
      cfgPath,
      JSON.stringify({
        mcpServers:{
          bad:{
            enabled:true
          }
        }
      })
    );

    process.env.LOCALMCP_CONFIG=cfgPath;

    await assert.rejects(
      config(),
      /command/
    );

    await writeFile(
      cfgPath,
      JSON.stringify({
        unknown:true
      })
    );

    await assert.rejects(
      config(),
      /Unrecognized key|unknown/i
    );
  }finally{
    if(old===undefined)delete process.env.LOCALMCP_CONFIG;
    else process.env.LOCALMCP_CONFIG=old;
  }
});

test('multiple workspaces select files independently and preserve legacy file semantics',async t=>{
  const one=await temp(t);
  const two=await temp(t);
  const cfgPath=join(one,'multi.json');

  await writeFile(join(one,'a.txt'),'one');
  await writeFile(join(two,'a.txt'),'two');

  await writeFile(
    cfgPath,
    JSON.stringify({
      workspaces:{
        one:'.',
        two
      },
      defaultWorkspace:'one',
      features:{
        files:true,
        shell:false
      }
    })
  );

  const old=process.env.LOCALMCP_CONFIG;
  process.env.LOCALMCP_CONFIG=cfgPath;

  try{
    const {config}=await import('../src/config.js');
    const cfg=await config();

    assert.equal(cfg.defaultWorkspace,'one');
    assert.equal(Object.keys(cfg.workspaces).length,2);
    assert.equal(cfg.fileRead,true);
    assert.equal(cfg.fileWrite,true);
    assert.equal(cfg.fileDelete,true);

    assert.equal(
      await readFile(
        join(cfg.workspaces.two,'a.txt'),
        'utf8'
      ),
      'two'
    );
  }finally{
    if(old===undefined)delete process.env.LOCALMCP_CONFIG;
    else process.env.LOCALMCP_CONFIG=old;
  }
});
