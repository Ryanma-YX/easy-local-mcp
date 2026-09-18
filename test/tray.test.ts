import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trayBinaryCandidates,
  validateTrayControlUrl
} from '../src/tray.js';

test('tray accepts only loopback Control Center URLs',()=>{
  assert.equal(
    validateTrayControlUrl('http://127.0.0.1:4567/'),
    'http://127.0.0.1:4567/'
  );

  for(const value of [
    'https://127.0.0.1:4567/',
    'http://localhost:4567/',
    'http://127.0.0.1/',
    'http://127.0.0.1:4567/path',
    'http://127.0.0.1:4567/?token=secret',
    'http://user:pass@127.0.0.1:4567/',
    'http://example.com:4567/'
  ]){
    assert.throws(()=>validateTrayControlUrl(value));
  }
});

test('tray binary candidates prefer an explicit local override',()=>{
  const env={
    LOCALMCP_TRAY_BINARY:'D:\\trusted\\easy-local-mcp-tray.exe'
  } as NodeJS.ProcessEnv;

  assert.deepEqual(
    trayBinaryCandidates('win32',env,'D:\\repo'),
    ['D:\\trusted\\easy-local-mcp-tray.exe']
  );
});

test('tray binary candidates use release before debug',()=>{
  const candidates=trayBinaryCandidates(
    'win32',
    {},
    'D:\\repo'
  );

  assert.equal(
    candidates[0],
    'D:\\repo\\src-tauri\\target\\release\\easy-local-mcp-tray.exe'
  );
  assert.equal(
    candidates[1],
    'D:\\repo\\src-tauri\\target\\debug\\easy-local-mcp-tray.exe'
  );
});
