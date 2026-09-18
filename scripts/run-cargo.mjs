import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const executable=process.platform==='win32'?'cargo.exe':'cargo';
const candidates=[
  process.env.CARGO,
  join(homedir(),'.cargo','bin',executable),
  'cargo'
].filter(Boolean);

let command=candidates[candidates.length-1];

for(const candidate of candidates.slice(0,-1)){
  if(existsSync(candidate)){
    command=candidate;
    break;
  }
}

const result=spawnSync(command,process.argv.slice(2),{
  stdio:'inherit',
  shell:false
});

if(result.error){
  console.error(
    'Unable to run Cargo. Install Rust with rustup or set CARGO to the Cargo executable.'
  );
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status??1);
