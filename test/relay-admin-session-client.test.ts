import test from 'node:test';
import assert from 'node:assert/strict';
import {adminPage} from '../worker/admin.js';

test('Relay Admin owner session UI has valid client-side JavaScript and three actions',()=>{
  const html=adminPage();
  const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length,1,'admin dashboard has one bundled inline script');
  assert.doesNotThrow(()=>new Function(scripts[0][1]),'rendered client script must parse');
  assert.match(html,/Edit permissions/);
  assert.match(html,/extend/);
  assert.match(html,/Revoke Session/);
  assert.doesNotMatch(html,/Pause Session|Resume Session/);
  assert.match(html,/Group approvals cover the tools in that group today/);
  assert.match(html,/initialWildcard&&!touched/,
    'unmodified legacy dynamic wildcard must not silently become current snapshot');
  assert.match(html,/Remote Unlock \(fixed deadline\)/);
});
