import {spawn, type ChildProcess} from 'node:child_process';
import {access} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export interface NativeTraySession {
  command:string;
  child:ChildProcess;
  closed:Promise<number|null>;
}

function packageRoot(){
  return resolve(dirname(fileURLToPath(import.meta.url)),'..');
}

async function exists(path:string){
  try{
    await access(path);
    return true;
  }catch{
    return false;
  }
}

export function validateTrayControlUrl(value:string){
  const url=new URL(value);

  if(
    url.protocol!=='http:'
    ||url.hostname!=='127.0.0.1'
    ||!url.port
    ||url.username
    ||url.password
    ||url.search
    ||url.hash
    ||url.pathname!=='/'
  ){
    throw new Error(
      'Tray Control Center URL must be http://127.0.0.1:<port>/ with no credentials, query or fragment'
    );
  }

  return url.toString();
}

export function trayBinaryCandidates(
  platform:NodeJS.Platform=process.platform,
  env:NodeJS.ProcessEnv=process.env,
  root=packageRoot()
){
  if(env.LOCALMCP_TRAY_BINARY){
    return [env.LOCALMCP_TRAY_BINARY];
  }

  const name=platform==='win32'
    ? 'localmcp-tray.exe'
    : 'localmcp-tray';

  return [
    resolve(root,'src-tauri','target','release',name),
    resolve(root,'src-tauri','target','debug',name)
  ];
}

export async function startNativeTray(
  controlUrl:string,
  platform:NodeJS.Platform=process.platform,
  env:NodeJS.ProcessEnv=process.env
):Promise<NativeTraySession>{
  const url=validateTrayControlUrl(controlUrl);
  const candidates=trayBinaryCandidates(platform,env);
  let command:string|undefined;

  for(const candidate of candidates){
    if(await exists(candidate)){
      command=candidate;
      break;
    }
  }

  if(!command){
    throw new Error(
      'LocalMCP native tray binary was not found. Run npm run tray:build first, '
      +'or set LOCALMCP_TRAY_BINARY to a trusted local binary.'
    );
  }

  const child=spawn(command,[],{
    env:{
      ...env,
      LOCALMCP_CONTROL_URL:url
    },
    stdio:'inherit',
    windowsHide:false
  });

  const closed=new Promise<number|null>((resolveClosed,rejectClosed)=>{
    child.once('error',rejectClosed);
    child.once('exit',code=>resolveClosed(code));
  });

  return {
    command,
    child,
    closed
  };
}
