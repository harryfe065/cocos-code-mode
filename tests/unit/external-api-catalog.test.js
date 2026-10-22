'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { requireDist } = require('../helpers/require-dist');
const { discoverEngineApi } = requireDist('engine-api-discovery.js');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function fixture(count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-full-catalog-'));
  fs.mkdirSync(path.join(root, '.ccp'));
  const catalog = path.join(root, 'catalog'); fs.mkdirSync(catalog);
  const lookupRoot = path.join(root, 'lookup'); fs.mkdirSync(lookupRoot);
  const records = Array.from({ length: count }, (_, index) => ({ id:`3.7.3:engine-runtime:PhysicsSystem:${index}`, version:'3.7.3', namespace:'engine-runtime', className:index === 0 ? 'PhysicsSystem' : 'OtherSystem', member:index === 0 ? null : `member${index}`, name:index === 0 ? 'PhysicsSystem' : `member${index}`, kind:index === 0 ? 'class' : 'method', domain:count > 1 ? `physics-framework-${index}` : 'physics-framework', signatures:[], permitted:true }));
  const shardRecords = count > 1 ? records.map(record => [record]) : [records];
  const shardBuffers = shardRecords.map(rows => Buffer.from(JSON.stringify({records:rows})));
  shardBuffers.forEach((shard, index) => fs.writeFileSync(path.join(catalog, count > 1 ? `physics-${index}.json` : 'physics.json'), shard));
  const catalogHash='a'.repeat(64);
  const domains = shardBuffers.map((shard, index) => ({name:`engine-runtime.${count > 1 ? `physics-framework-${index}` : 'physics-framework'}`,file:count > 1 ? `physics-${index}.json` : 'physics.json',count:shardRecords[index].length}));
  const index=Buffer.from(JSON.stringify({schemaVersion:1,version:'3.7.3',catalogHash,domains,recordCount:records.length}));
  fs.writeFileSync(path.join(catalog,'index.json'),index);
  const lookup=Buffer.from(JSON.stringify({schemaVersion:1,version:'3.7.3',catalogHash,sourceIndexSha256:hash(index),shards:domains.map((domain,index)=>({file:domain.file,sha256:hash(shardBuffers[index]),count:domain.count,domain:domain.name})),entries:records.map((record,index)=>({...record,shard:count > 1 ? index : 0,domain:domains[count > 1 ? index : 0].name}))}));
  fs.writeFileSync(path.join(lookupRoot,'lookup.json'),lookup);
  fs.writeFileSync(path.join(root,'.ccp','engine-api-catalogs.json'),JSON.stringify({schemaVersion:1,catalogs:[{version:'3.7.3',catalogRoot:catalog,lookupRoot,lookupSha256:hash(lookup),catalogHash}]}));
  return {root,catalog,lookupRoot};
}

test('external catalog reaches classes outside pilot and rejects altered shard even after cache fill', async () => {
  const f=fixture(), previous=global.Editor;
  global.Editor={Project:{path:f.root},Message:{request:async()=>{throw new Error('No scene IPC expected');}}};
  try {
    const result=await discoverEngineApi({category:'engine_api',namespace:'engine-runtime',filter:'PhysicsSystem'});
    assert.equal(result.records[0].className,'PhysicsSystem');
    assert.equal(result.records[0].permitted,false);
    assert.equal(result.coverage.fullCatalogLoaded,true);
    const domains=await discoverEngineApi({category:'engine_api',operation:'list_domains'});
    assert.equal(domains.records[0].recordCount,1);
    fs.appendFileSync(path.join(f.catalog,'physics.json'),' ');
    await assert.rejects(()=>discoverEngineApi({category:'engine_api',filter:'PhysicsSystem'}),error=>error.code==='CATALOG_HASH_MISMATCH');
  } finally {global.Editor=previous;fs.rmSync(f.root,{recursive:true,force:true});}
});

test('external index scans are bounded while exact IDs use the lookup map', async () => {
  const f=fixture(257), previous=global.Editor;
  global.Editor={Project:{path:f.root}};
  try {
    await assert.rejects(() => discoverEngineApi({category:'engine_api',operation:'list_classes',maxPages:1}), error=>error.code==='CATALOG_INDEX_LIMIT');
    const exact=await discoverEngineApi({category:'engine_api',operation:'records',recordId:'3.7.3:engine-runtime:PhysicsSystem:256',maxPages:1});
    assert.equal(exact.records[0].id,'3.7.3:engine-runtime:PhysicsSystem:256');
  } finally {global.Editor=previous;fs.rmSync(f.root,{recursive:true,force:true});}
});

test('exact class hydration reads only the matching external shard', async () => {
  const f=fixture(2), previous=global.Editor, originalOpenSync=fs.openSync, opened=[];
  fs.openSync=(file, ...args) => { opened.push(String(file)); return originalOpenSync.call(fs, file, ...args); };
  global.Editor={Project:{path:f.root}};
  try {
    const result=await discoverEngineApi({category:'engine_api',className:'PhysicsSystem',maxPages:1});
    assert.equal(result.records.length,1);
    assert.deepEqual(opened.filter(file => path.basename(file).startsWith('physics-')), [path.join(f.catalog,'physics-0.json')]);
  } finally {fs.openSync=originalOpenSync;global.Editor=previous;fs.rmSync(f.root,{recursive:true,force:true});}
});

test('configured tampered lookup fails closed instead of silently falling back to pilot', async () => {
  const f=fixture(),previous=global.Editor;
  global.Editor={Project:{path:f.root}};
  try {
    fs.appendFileSync(path.join(f.lookupRoot,'lookup.json'),' ');
    await assert.rejects(()=>discoverEngineApi({category:'engine_api',operation:'list_classes'}),error=>error.code==='CATALOG_HASH_MISMATCH');
  } finally {global.Editor=previous;fs.rmSync(f.root,{recursive:true,force:true});}
});
