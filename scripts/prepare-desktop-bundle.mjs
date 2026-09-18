import {copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const resources=join(root,'src-tauri','resources');
const appDir=join(resources,'app');
const runtimeDir=join(resources,'runtime');

mkdirSync(resources,{recursive:true});
rmSync(appDir,{recursive:true,force:true});
rmSync(runtimeDir,{recursive:true,force:true});
rmSync(join(resources,'BUNDLE-MANIFEST.json'),{force:true});
mkdirSync(appDir,{recursive:true});
mkdirSync(runtimeDir,{recursive:true});

for(const required of ['dist','skills','package.json','package-lock.json']){
  if(!existsSync(join(root,required))){
    throw new Error(`Missing ${required}; run npm install/build before preparing the desktop bundle.`);
  }
}

cpSync(join(root,'dist'),join(appDir,'dist'),{recursive:true});
cpSync(join(root,'skills'),join(appDir,'skills'),{recursive:true});
copyFileSync(join(root,'package.json'),join(appDir,'package.json'));
copyFileSync(join(root,'package-lock.json'),join(appDir,'package-lock.json'));

const runtimeName=process.platform==='win32'?'node.exe':'node';
copyFileSync(process.execPath,join(runtimeDir,runtimeName));
writeFileSync(join(runtimeDir,'NODE-VERSION.txt'),`${process.version}\n`);

let nodeLicense;
for(const candidate of [
  join(dirname(process.execPath),'LICENSE'),
  join(dirname(process.execPath),'LICENSE.txt')
]){
  if(existsSync(candidate)){
    nodeLicense=readFileSync(candidate,'utf8');
    break;
  }
}

if(!nodeLicense){
  const url=`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
  const response=await fetch(url);
  if(!response.ok){
    throw new Error(`Unable to retrieve Node.js license for ${process.version}: ${response.status}`);
  }
  nodeLicense=await response.text();
}

writeFileSync(join(runtimeDir,'NODE-LICENSE.txt'),nodeLicense);

const npmExec=process.env.npm_execpath;
let install;
if(npmExec){
  install=spawnSync(process.execPath,[npmExec,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{
    cwd:appDir,
    stdio:'inherit'
  });
}else{
  install=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{
    cwd:appDir,
    stdio:'inherit',
    shell:false
  });
}

if(install.error)throw install.error;
if(install.status!==0)throw new Error(`npm ci --omit=dev failed with exit code ${install.status}`);

const rootPackage=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
writeFileSync(join(resources,'BUNDLE-MANIFEST.json'),JSON.stringify({
  localmcpVersion:rootPackage.version,
  nodeVersion:process.version,
  platform:process.platform,
  arch:process.arch
},null,2)+'\n');

console.log(`Prepared desktop resources at ${resources}`);
