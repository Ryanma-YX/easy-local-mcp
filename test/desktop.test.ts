import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultBrowserCandidate,
  desktopAppCandidates
} from '../src/desktop.js';

const url='http://127.0.0.1:4567/';

test('desktop launcher builds safe Windows app-mode candidates',()=>{
  const env={
    'ProgramFiles(x86)':'C:\\Program Files (x86)',
    ProgramFiles:'C:\\Program Files',
    LOCALAPPDATA:'C:\\Users\\Test\\AppData\\Local'
  } as NodeJS.ProcessEnv;

  const candidates=desktopAppCandidates(url,'win32',env);

  assert.ok(candidates.some(item=>item.command.endsWith('Microsoft\\Edge\\Application\\msedge.exe')));
  assert.ok(candidates.some(item=>item.command==='msedge.exe'));
  assert.ok(candidates.some(item=>item.command==='chrome.exe'));

  for(const candidate of candidates){
    assert.ok(candidate.args.includes('--app='+url));
    assert.ok(candidate.args.includes('--new-window'));
    assert.ok(!candidate.args.some(arg=>/mcp\//i.test(arg)));
  }

  const fallback=defaultBrowserCandidate(url,'win32');
  assert.equal(fallback.command,'rundll32.exe');
  assert.deepEqual(fallback.args,['url.dll,FileProtocolHandler',url]);
});

test('desktop launcher honors an explicit browser without shell interpolation',()=>{
  const env={
    LOCALMCP_DESKTOP_BROWSER:'custom-browser'
  } as NodeJS.ProcessEnv;

  const candidates=desktopAppCandidates(url,'linux',env);

  assert.deepEqual(candidates,[{
    command:'custom-browser',
    args:['--app='+url,'--new-window'],
    checkPath:false
  }]);
});

test('desktop launcher uses platform app-mode conventions',()=>{
  const mac=desktopAppCandidates(url,'darwin',{});
  assert.equal(mac[0].command,'open');
  assert.deepEqual(
    mac[0].args,
    ['-na','Microsoft Edge','--args','--app='+url,'--new-window']
  );
  assert.equal(mac[0].waitForExit,true);

  const linux=desktopAppCandidates(url,'linux',{});
  assert.equal(linux[0].command,'microsoft-edge');
  assert.deepEqual(linux[0].args,['--app='+url,'--new-window']);

  assert.equal(defaultBrowserCandidate(url,'darwin').command,'open');
  assert.equal(defaultBrowserCandidate(url,'linux').command,'xdg-open');
});
