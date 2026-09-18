import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {join} from 'node:path';

export interface DesktopLaunchResult {
  mode:'app'|'browser';
  command:string;
}

interface LaunchCandidate {
  command:string;
  args:string[];
  checkPath:boolean;
  waitForExit?:boolean;
}

type Env=NodeJS.ProcessEnv;

function windowsPaths(env:Env){
  const values:string[]=[];
  const add=(base:string|undefined,...parts:string[])=>{
    if(base)values.push(join(base,...parts));
  };

  add(env['ProgramFiles(x86)'],'Microsoft','Edge','Application','msedge.exe');
  add(env.ProgramFiles,'Microsoft','Edge','Application','msedge.exe');
  add(env.LOCALAPPDATA,'Microsoft','Edge','Application','msedge.exe');
  add(env['ProgramFiles(x86)'],'Google','Chrome','Application','chrome.exe');
  add(env.ProgramFiles,'Google','Chrome','Application','chrome.exe');
  add(env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe');

  return values;
}

export function desktopAppCandidates(
  url:string,
  platform:NodeJS.Platform=process.platform,
  env:Env=process.env
):LaunchCandidate[]{
  const appArgs=[`--app=${url}`,'--new-window'];

  if(env.LOCALMCP_DESKTOP_BROWSER){
    return [{
      command:env.LOCALMCP_DESKTOP_BROWSER,
      args:appArgs,
      checkPath:false
    }];
  }

  if(platform==='win32'){
    return [
      ...windowsPaths(env).map(command=>({command,args:appArgs,checkPath:true})),
      {command:'msedge.exe',args:appArgs,checkPath:false},
      {command:'chrome.exe',args:appArgs,checkPath:false}
    ];
  }

  if(platform==='darwin'){
    return [
      {
        command:'open',
        args:['-na','Microsoft Edge','--args',...appArgs],
        checkPath:false,
        waitForExit:true
      },
      {
        command:'open',
        args:['-na','Google Chrome','--args',...appArgs],
        checkPath:false,
        waitForExit:true
      }
    ];
  }

  return [
    {command:'microsoft-edge',args:appArgs,checkPath:false},
    {command:'google-chrome',args:appArgs,checkPath:false},
    {command:'chromium',args:appArgs,checkPath:false},
    {command:'chromium-browser',args:appArgs,checkPath:false}
  ];
}

export function defaultBrowserCandidate(
  url:string,
  platform:NodeJS.Platform=process.platform
){
  if(platform==='win32'){
    return {
      command:'rundll32.exe',
      args:['url.dll,FileProtocolHandler',url],
      waitForExit:false
    };
  }

  if(platform==='darwin'){
    return {
      command:'open',
      args:[url],
      waitForExit:true
    };
  }

  return {
    command:'xdg-open',
    args:[url],
    waitForExit:true
  };
}

async function exists(path:string){
  try{
    await access(path);
    return true;
  }catch{
    return false;
  }
}

async function launch(
  command:string,
  args:string[],
  waitForExit=false
){
  return await new Promise<boolean>(resolveLaunch=>{
    const child=spawn(command,args,{
      detached:!waitForExit,
      stdio:'ignore',
      windowsHide:true
    });

    let settled=false;
    const finish=(value:boolean)=>{
      if(settled)return;
      settled=true;
      resolveLaunch(value);
    };

    child.once('error',()=>finish(false));
    child.once('spawn',()=>{
      if(!waitForExit){
        child.unref();
        finish(true);
      }
    });

    if(waitForExit){
      child.once('exit',code=>finish(code===0));
    }
  });
}

export async function openDesktopControl(
  url:string,
  platform:NodeJS.Platform=process.platform,
  env:Env=process.env
):Promise<DesktopLaunchResult>{
  for(const candidate of desktopAppCandidates(url,platform,env)){
    if(candidate.checkPath&&!(await exists(candidate.command)))continue;

    if(await launch(
      candidate.command,
      candidate.args,
      candidate.waitForExit===true
    )){
      return {
        mode:'app',
        command:candidate.command
      };
    }
  }

  const fallback=defaultBrowserCandidate(url,platform);

  if(await launch(
    fallback.command,
    fallback.args,
    fallback.waitForExit
  )){
    return {
      mode:'browser',
      command:fallback.command
    };
  }

  throw new Error(
    'Unable to open the Easy Local MCP desktop control window. '
    +'Set LOCALMCP_DESKTOP_BROWSER to an Edge/Chrome executable or open the printed local UI URL manually.'
  );
}
