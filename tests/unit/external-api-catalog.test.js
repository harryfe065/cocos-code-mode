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

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-full-catalog-'));
  fs.mkdirSync(path.join(root, '.ccp'));
  const catalog = path.join(root, 'catalog'); fs.mkdirSync(catalog);
  const lookupRoot = path.join(root, 'lookup'); fs.mkdirSync(lookupRoot);
  const record = { id:'3.7.3:engine-runtime:PhysicsSystem', version:'3.7.3', namespace:'engine-runtime', className:'PhysicsSystem', member:null, name:'PhysicsSystem', kind:'class', domain:'physics-framework', signatures:[], permitted:true };
  const shard = Buffer.from(JSON.stringify({records:[record]}));
  fs.writeFileSync(path.join(catalog,'physics.json'),shard);
  const catalogHash='a'.repeat(64);
  const index=Buffer.from(JSON.stringify({schemaVersion:1,version:'3.7.3',catalogHash,domains:[{name:'engine-runtime.physics-framework',file:'physics.json',count:1}]}));
  fs.writeFileSync(path.join(catalog,'index.json'),index);
  const lookup=Buffer.from(JSON.stringify({schemaVersion:1,version:'3.7.3',catalogHash,sourceIndexSha256:hash(index),shards:[{file:'physics.json',sha256:hash(shard),count:1,domain:'engine-runtime.physics-framework'}],entries:[{...record,shard:0,domain:'engine-runtime.physics-framework'}]}));
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

test('configured tampered lookup fails closed instead of silently falling back to pilot', async () => {
  const f=fixture(),previous=global.Editor;
  global.Editor={Project:{path:f.root}};
  try {
    fs.appendFileSync(path.join(f.lookupRoot,'lookup.json'),' ');
    await assert.rejects(()=>discoverEngineApi({category:'engine_api',operation:'list_classes'}),error=>error.code==='CATALOG_HASH_MISMATCH');
  } finally {global.Editor=previous;fs.rmSync(f.root,{recursive:true,force:true});}
});
