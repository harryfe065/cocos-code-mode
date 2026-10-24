'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { discoverEngineApi } = requireDist('engine-api-discovery.js');

test('catalog browsing groups shard domains and reports pilot coverage without dispatch', async () => {
  const before = global.Editor;
  global.Editor = { Message: { request: async () => { throw new Error('Navigation must not dispatch editor IPC'); } } };
  try {
    const domains = await discoverEngineApi({ category: 'engine_api', operation: 'list_domains' });
    assert.equal(new Set(domains.records.map(r => r.name)).size, domains.total);
    assert.equal(domains.coverage.scope, 'reviewed-seven-class-read-only-pilot');
    assert.equal(domains.coverage.fullCatalogLoaded, false);
    const classes = await discoverEngineApi({ category: 'engine_api', operation: 'list_classes', maxEntries:2 });
    assert.equal(classes.total, 7);
    assert.equal(classes.count, 2);
    assert.equal(classes.truncated, true);
    const next = await discoverEngineApi({ category: 'engine_api', operation: 'list_classes', maxEntries:2, cursor:classes.nextCursor });
    assert.notEqual(classes.records[0].id, next.records[0].id);
    await assert.rejects(() => discoverEngineApi({ category:'engine_api', operation:'records', cursor:classes.nextCursor }), error => error.code==='STALE_CURSOR');
    const bounded = await discoverEngineApi({ category:'engine_api', operation:'list_classes', maxEntries:200,maxBytes:1024 });
    assert.ok(Buffer.byteLength(JSON.stringify(bounded))<=1024);
    assert.equal(bounded.truncated,true);
  } finally { global.Editor=before; }
});
test('get_inheritance reads one installed engine record without dispatch', async () => {
  const before = global.Editor;
  global.Editor = { Message: { request: async () => { throw new Error('Inheritance discovery must not dispatch editor IPC'); } } };
  try {
    const result = await discoverEngineApi({
      category: 'engine_api',
      operation: 'get_inheritance',
      recordId: '3.7.3:engine-runtime:cc:Button::class:instance',
      maxEntries: 1,
    });
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].namespace, 'engine-runtime');
    assert.ok(Array.isArray(result.records[0].inheritance));
    assert.equal(result.live.checked, false);
  } finally { global.Editor = before; }
});


test('navigation refuses mixed instance targets before querying the editor', async () => {
  await assert.rejects(() => discoverEngineApi({category:'engine_api',operation:'list_classes',reference:{id:'node'}}), error=>error.code==='INVALID_ARGUMENT');
});
