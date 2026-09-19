import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fork,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createConnection} from 'node:net';
import {controlEndpoint} from '../src/control-endpoint.js';
import {desktopAgentLauncher} from '../src/lifecycle.js';

const exec=promisify(execFile);

test('control endpoints use normalized, directory-specific Windows pipes and Unix socket files',()=>{
  const endpoint=controlEndpoint('C:\\Users\\chy\\.localmcp','win32');

  assert.match(endpoint.address,/^\\\\\.\\pipe\\localmcp-[a-f0-9]{32}$/);
  assert.equal(endpoint.socketFile,undefined);
  assert.deepEqual(endpoint,controlEndpoint('c:/users/CHY/.localmcp/','win32'));
  assert.notEqual(
    endpoint.address,
    controlEndpoint('C:\\Users\\other\\.localmcp','win32').address
  );

  for(const platform of ['darwin','linux'] as const){
    const dir=resolve('test-state');

    assert.deepEqual(
      controlEndpoint(dir,platform),
      {
        address:join(dir,'agent.sock'),
        socketFile:join(dir,'agent.sock')
      }
    );
  }
});

test('authenticated native IPC supports masked status, url reveal, unlock, lock, rotate, reload and stop',{timeout:30000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-ipc-'));
  const env={
    ...process.env,
    HOME:home,
    USERPROFILE:home
  };

  const children:ReturnType<typeof fork>[]=[];

  t.after(async()=>{
    for(const child of children){
      if(child.exitCode===null)child.kill();
    }

    await new Promise(resolveDelay=>setTimeout(resolveDelay,200));
    await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });

  const cli=async(...args:string[])=>(
    await exec(
      process.execPath,
      [resolve('dist/index.js'),...args],
      {
        env,
        timeout:10000
      }
    )
  ).stdout;

  assert.match(await cli('status'),/Status: stopped/);

  const fullToken='a'.repeat(64);
  const fullUrl='https://example.test/mcp/device/'+fullToken;

  for(let iteration=0;iteration<2;iteration++){
    const child=fork(
      resolve('test/fixtures/control-server.mjs'),
      [],
      {
        env,
        stdio:['ignore','ignore','pipe','ipc']
      }
    );

    children.push(child);

    let errors='';
    child.stderr?.on('data',data=>{
      errors+=data;
    });

    await new Promise<void>((done,reject)=>{
      child.once('message',()=>done());
      child.once('error',reject);
      child.once('exit',code=>{
        reject(new Error(`IPC server exited (${code}): ${errors}`));
      });
    });

    const secret=(
      await readFile(join(home,'.localmcp','control.secret'),'utf8')
    ).trim();

    const rawRequest=async(payload:unknown)=>new Promise<string>((done,reject)=>{
      const socket=createConnection(
        controlEndpoint(join(home,'.localmcp')).address
      );

      let data='';

      socket.setTimeout(
        5000,
        ()=>socket.destroy(new Error('IPC framing timeout'))
      );

      socket.on('connect',()=>{
        socket.write(JSON.stringify(payload)+'\n');
      });

      socket.on('data',chunk=>{
        data+=chunk;
      });

      socket.on('end',()=>{
        socket.destroy();
        done(data);
      });

      socket.on('error',reject);
    });

    const denied=JSON.parse(
      await rawRequest({
        command:'status',
        secret:'0'.repeat(64)
      })
    );

    assert.match(denied.error,/Unauthorized/);

    const direct=JSON.parse(
      await rawRequest({
        command:'status',
        secret
      })
    );

    assert.equal(direct.pid,child.pid);
    assert.equal(direct.url,fullUrl);

    const statusOutput=await cli('status');

    assert.match(statusOutput,new RegExp(`PID: ${child.pid}`));
    assert.match(statusOutput,/Security: LOCKED/);
    assert.ok(!statusOutput.includes(fullToken));
    assert.match(statusOutput,/MCP URL: .*redacted/i);

    assert.equal((await cli('url')).trim(),fullUrl);

    assert.match(await cli('start'),new RegExp(`PID: ${child.pid}`));

    const unlocked=await cli('unlock','--minutes','5');
    assert.match(unlocked,/Security: UNLOCKED/);
    assert.match(unlocked,/Unlock expires:/);

    assert.match(await cli('lock'),/Security: LOCKED/);

    assert.match(
      await cli('rotate'),
      /rotations:1/
    );

    assert.match(
      await cli('reload'),
      /Config: reloads:1;rotations:1/
    );

    assert.match(await cli('stop'),/Status: stopped/);
    assert.match(await cli('stop'),/Status: stopped/);
  }
});

test('desktop Agent launcher is only selected for Windows bundled desktop',()=>{
  assert.equal(
    desktopAgentLauncher(
      {LOCALMCP_DESKTOP_LAUNCHER:' C:\\Easy Local MCP\\easy-local-mcp-tray.exe '} as NodeJS.ProcessEnv,
      'win32'
    ),
    'C:\\Easy Local MCP\\easy-local-mcp-tray.exe'
  );
  assert.equal(
    desktopAgentLauncher(
      {LOCALMCP_DESKTOP_LAUNCHER:'C:\\Easy Local MCP\\easy-local-mcp-tray.exe'} as NodeJS.ProcessEnv,
      'linux'
    ),
    null
  );
  assert.equal(desktopAgentLauncher({} as NodeJS.ProcessEnv,'win32'),null);
});
