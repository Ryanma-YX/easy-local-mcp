#!/usr/bin/env node
/**
 * Rootless Linux systemd user-service installer.
 * No deployment or service activation is performed by "preview".
 */
import {existsSync} from 'node:fs';
import {lstat,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {homedir} from 'node:os';
import {createConnection} from 'node:net';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const run=promisify(execFile);
// Stable project identity, generated once with Python secrets.token_hex(4).
// Never regenerate on each installation: systemd unit identity must persist.
export const UNIT_NAME='easy-local-mcp-1591e5a7.service';
export const OWNED_HEADER='# Managed by Easy Local MCP rootless systemd installer';
// Detect earlier experimental installs, but never modify them implicitly.
const LEGACY_UNIT_NAME='easy-local-mcp.service';
const HEADER=OWNED_HEADER;
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

function systemdWord(value){
  if(!value.startsWith('/')||/[\r\n\x00-\x1f]/.test(value)){
    throw new Error('Systemd service paths must be absolute and single-line');
  }
  return '"'+value
    .replaceAll('\\','\\\\')
    .replaceAll('"','\\"')
    .replaceAll('%','%%')+'"';
}

function workingDirectoryPath(path){
  if(!path.startsWith('/')||/[\r\n\x00-\x1f]/.test(path)){
    throw new Error('Systemd service paths must be absolute and single-line');
  }
  // WorkingDirectory= takes one absolute path, not the ExecStart word syntax.
  return path.replaceAll('\\','\\\\').replaceAll('%','%%');
}

/**
 * Explicit executable search path for the *service*, independent of the
 * interactive shell or systemd manager environment. Add the selected Node
 * installation, the caller's chosen absolute search directories, then safe
 * system defaults. LOCALMCP_SYSTEMD_PATH can override at installation time.
 */
export function serviceExecutablePath(nodePath=process.execPath,
  selected=process.env.LOCALMCP_SYSTEMD_PATH??process.env.PATH??''){
  const paths=[dirname(nodePath),...selected.split(':'),
    '/usr/local/bin','/usr/bin','/bin'];
  const result=[];
  for(const raw of paths){
    if(!raw)continue;
    if(!raw.startsWith('/')||/[\r\n\x00-\x1f]/.test(raw)){
      throw new Error('Systemd PATH entries must be absolute directories: '+JSON.stringify(raw));
    }
    if(!result.includes(raw))result.push(raw);
  }
  return result.join(':');
}

/** Prevent first-time installation from trapping an already-running standalone
 * Agent behind the newly installed managed-mode ownership checks.
 * A connectable local control socket is sufficient: never stop or unlink it.
 * Ambiguous probe failures fail closed, without changing the user's service.
 */
export async function assertNoStandaloneAgent(home=homedir()){
  const address=resolve(home,'.localmcp','agent.sock');
  // Match the Agent's socket-recovery policy: non-socket entries (including
  // symlinks) cannot be used for startup. Never remove or alter them here.
  let entry;
  try{
    entry=await lstat(address);
  }catch(error){
    if(error.code!=='ENOENT'){
      throw new Error('Cannot safely inspect Agent control endpoint: '+error.message);
    }
  }
  if(entry&&!entry.isSocket()){
    throw new Error(
      'Agent control path is not a Unix socket: '+address
      +'. Resolve this unexpected entry before installing the systemd service.'
    );
  }
  await new Promise((done,reject)=>{
    const socket=createConnection(address);
    let settled=false;
    function finish(error){
      if(settled)return;
      settled=true;
      socket.destroy();
      if(error)reject(error);
      else done();
    }
    socket.setTimeout(2000,()=>finish(new Error(
      'Unable to verify whether a standalone Agent is running (control probe timed out). Installation refused.'
    )));
    socket.once('connect',()=>finish(new Error(
      'A standalone Easy Local MCP Agent is already running. Stop it with the normal CLI before installing the systemd user service.'
    )));
    socket.once('error',error=>{
      if(error.code==='ENOENT'||error.code==='ECONNREFUSED')finish();
      else finish(new Error('Cannot safely probe existing Agent control endpoint: '+error.message));
    });
  });
}

/** Fail closed when a pre-tag service requires explicit migration. */
async function assertNoLegacyUnit(home=homedir()){
  const legacyPath=resolve(home,'.config/systemd/user',LEGACY_UNIT_NAME);
  try{
    await lstat(legacyPath);
  }catch(error){
    if(error.code==='ENOENT')return;
    throw error;
  }
  throw new Error(
    'An earlier untagged Easy Local MCP user unit exists at '+legacyPath
    +'. Stop and uninstall that previous unit before installing the '
    +UNIT_NAME+' service. No automatic migration was performed.'
  );
}

/** Generate service content without altering the computer. */
export function renderUserService({
  nodePath=process.execPath,
  entryPath=resolve(root,'dist/index.js'),
  workingDirectory=root,
  executablePath=serviceExecutablePath(nodePath)
}={}){
  return [
    HEADER,
    '[Unit]',
    'Description=Easy Local MCP Agent (rootless)',
    'StartLimitIntervalSec=90s',
    'StartLimitBurst=4',
    '',
    '[Service]',
    'Type=notify',
    'NotifyAccess=all',
    'Environment=LOCALMCP_SYSTEMD_MANAGED=1',
    // ExecStart's Node path is absolute; PATH remains needed by MCP commands
    // such as npx, node, uvx and their subprocesses.
    'Environment="PATH='+systemdWord(executablePath).slice(1,-1)+'"',
    'ExecStart='+systemdWord(nodePath)+' '+systemdWord(entryPath)+' agent',
    'WorkingDirectory='+workingDirectoryPath(workingDirectory),
    'Restart=on-failure',
    'RestartSec=3s',
    'KillMode=control-group',
    'TimeoutStartSec=30s',
    'TimeoutStopSec=8s',
    'WatchdogSec=25s',
    'UMask=0077',
    'NoNewPrivileges=yes',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
}

export async function runCli(command){
  if(process.platform!=='linux'){
    throw new Error('User systemd supervision is supported only on Linux');
  }
  if(process.getuid?.()===0){
    throw new Error('Run the rootless user service installer as an unprivileged user, not root');
  }
  const unitPath=resolve(homedir(),'.config/systemd/user',UNIT_NAME);

  if(command==='preview'){
    console.log(renderUserService());
    console.log('# To install: node scripts/systemd-user-service.mjs install');
    return;
  }
  if(command==='status'){
    await run('systemctl',['--user','status',UNIT_NAME,'--no-pager'],{timeout:12000});
    return;
  }
  if(!['install','uninstall'].includes(command)){
    throw new Error('Usage: node scripts/systemd-user-service.mjs preview|install|uninstall|status');
  }

  const existing=await readFile(unitPath,'utf8').catch(error=>{
    if(error.code==='ENOENT')return null;
    throw error;
  });
  if(existing&&!existing.startsWith(HEADER)){
    throw new Error('Refusing to replace an unrecognized user service: '+unitPath);
  }

  if(command==='install'){
    await assertNoLegacyUnit();
    // Fail before writing any file if the user manager is unavailable.
    await run('systemctl',['--user','show-environment'],{timeout:6000});
    const entry=resolve(root,'dist/index.js');
    if(!existsSync(entry)){
      throw new Error('Build first with npm run build: '+entry);
    }
    // The compiled module is packaged with the built CLI. Sharing the exact
    // Agent startup mutex avoids introducing a second, ineffective lock.
    const {withStartupLock}=await import('../dist/socket-recovery.js');
    const home=homedir();
    const agentDir=resolve(home,'.localmcp');
    await mkdir(agentDir,{recursive:true,mode:0o700});
    await mkdir(dirname(unitPath),{recursive:true,mode:0o700});
    await withStartupLock(resolve(agentDir,'agent.sock'),async()=>{
      // Do NOT rely on the preliminary inspection outside this mutex.
      // A standalone Agent can pass its early check and be starting now.
      await assertNoLegacyUnit(home);
      const current=await readFile(unitPath,'utf8').catch(error=>{
        if(error.code==='ENOENT')return null;
        throw error;
      });
      if(current&&!current.startsWith(HEADER)){
        throw new Error('Refusing to replace an unrecognized user service: '+unitPath);
      }
      // Updates of a recognized managed unit are allowed while its Agent runs.
      if(!current)await assertNoStandaloneAgent(home);
      // The lock stays owned until this write commits the managed-mode file.
      await writeFile(unitPath,renderUserService(),{mode:0o644});
    });
    await run('systemctl',['--user','daemon-reload'],{timeout:12000});
    console.log('Installed '+unitPath+' (not started or enabled).');
    console.log('External MCP service PATH: '+serviceExecutablePath());
    console.log('Start and enable explicitly with: systemctl --user enable --now '+UNIT_NAME);
    console.log('For boot-before-login support, review: loginctl enable-linger '+process.env.USER);
    return;
  }

  if(!existing){
    console.log('No managed user service installed.');
    return;
  }
  await run('systemctl',['--user','disable','--now',UNIT_NAME],{timeout:12000});
  await rm(unitPath);
  await run('systemctl',['--user','daemon-reload'],{timeout:12000});
  console.log('Removed '+UNIT_NAME);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runCli(process.argv[2]??'preview').catch(error=>{
    console.error(error instanceof Error?error.message:String(error));
    process.exitCode=1;
  });
}
