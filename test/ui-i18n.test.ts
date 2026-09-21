import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UI_DICTIONARIES,
  uiI18nClient,
  type UiScope
} from '../src/ui-i18n.js';

test('UI i18n dictionaries keep English and Chinese keys aligned',()=>{
  const scopes=Object.keys(UI_DICTIONARIES) as UiScope[];

  assert.deepEqual(
    scopes.sort(),
    ['admin','admin-public','control','home'].sort()
  );

  for(const scope of scopes){
    const dictionary=UI_DICTIONARIES[scope];

    assert.deepEqual(
      Object.keys(dictionary.en).sort(),
      Object.keys(dictionary['zh-CN']).sort(),
      scope+' translations must have matching keys'
    );

    assert.ok(
      Object.values(dictionary['zh-CN']).some(
        value=>/[\u3400-\u9fff]/.test(value)
      ),
      scope+' should contain Chinese translations'
    );
  }
});

test('UI i18n browser bootstrap is syntactically valid for every scope',()=>{
  for(const scope of Object.keys(UI_DICTIONARIES) as UiScope[]){
    const script=uiI18nClient(scope);

    assert.doesNotThrow(
      ()=>new Function(script)
    );
    assert.match(script,/easy-local-mcp\.ui-language/);
    assert.match(script,/zh-CN/);
  }
});

test('public Relay Admin translations do not embed authenticated dashboard copy',()=>{
  const publicJson=JSON.stringify(UI_DICTIONARIES['admin-public']);

  assert.doesNotMatch(publicJson,/Relay-wide Control Plane/);
  assert.match(publicJson,/Relay Admin Token/);
});
