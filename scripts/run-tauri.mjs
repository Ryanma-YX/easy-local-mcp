import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {delimiter, dirname, join} from 'node:path';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const tauriCli=require.resolve('@tauri-apps/cli/tauri.js');
const cargoName=process.platform==='win32'?'cargo.exe':'cargo';
const explicit=process.env.CARGO;
const userCargo=join(homedir(),'.cargo','bin',cargoName);
const cargo=explicit&&existsSync(explicit)?explicit:(existsSync(userCargo)?userCargo:undefined);
const env={...process.env};

if(cargo){
  const cargoDir=dirname(cargo);
  env.CARGO=cargo;
  env.PATH=`${cargoDir}${delimiter}${env.PATH??''}`;
}

const result=spawnSync(process.execPath,[tauriCli,...process.argv.slice(2)],{
  stdio:'inherit',
  env,
  shell:false,
  windowsHide:process.platform==='win32'
});

if(result.error){
  console.error('Unable to run Tauri CLI.');
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status??1);
