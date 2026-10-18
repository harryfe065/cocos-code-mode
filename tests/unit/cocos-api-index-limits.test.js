'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { indexCatalog } = require('../../scripts/cocos-api/index-catalog');

const MiB = 1024 * 1024;
const version = '3.7.3';
const catalogHash = 'a'.repeat(64);

function fixture(t, counts, name = 'n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-index-limits-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const catalog = path.join(root, 'catalog');
  fs.mkdirSync(catalog);
  const domains = counts.map((count, shard) => ({ name: `e.d${shard}`, file: `shard-${shard}.json`, count }));
  const index = { schemaVersion: 1, version, catalogHash, recordCount: counts.reduce((a, b) => a + b, 0), domains };
  const writeIndex = () => fs.writeFileSync(path.join(catalog, 'index.json'), JSON.stringify(index));
  const writeShard = (shard, count, recordName = name) => {
    const records = Array.from({ length: count }, (_, record) => ({
      id: `${version}:e:${shard}:${record}`, version, namespace: 'e', className: null,
      name: recordName, member: null, kind: 'class', module: 'm', domain: `d${shard}`
    }));
    fs.writeFileSync(path.join(catalog, domains[shard].file), JSON.stringify({ records }));
  };
  domains.forEach((domain, shard) => writeShard(shard, domain.count));
  writeIndex();
  return { root, catalog, index, writeIndex, writeShard, output: path.join(root, 'lookup') };
}

function padJson(file, maximum) {
  const remaining = maximum - fs.statSync(file).size;
  assert.ok(remaining >= 0, 'fixture JSON must fit within its boundary');
  fs.appendFileSync(file, ' '.repeat(remaining));
}

function rejectUnpublished(f, pattern, output = f.output) {
  const before = fs.readdirSync(f.root).sort();
  assert.throws(() => indexCatalog(f.catalog, output), pattern);
  assert.equal(fs.existsSync(output), false, 'rejected catalog must not reserve or publish output');
  assert.deepEqual(fs.readdirSync(f.root).sort(), before, 'rejection must not leave staging files');
}

function readPublished(f, result) {
  const bytes = fs.readFileSync(path.join(f.output, 'lookup.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(f.output, 'manifest.json'), 'utf8'));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), result.lookupSha256);
  assert.equal(manifest.lookupSha256, result.lookupSha256);
  return JSON.parse(bytes.toString('utf8'));
}

test('1001 shards cannot publish; the 1000-shard boundary publishes the complete catalog', t => {
  const f = fixture(t, Array(1001).fill(1));
  rejectUnpublished(f, /1000 shards/);
  const removed = f.index.domains.pop();
  fs.unlinkSync(path.join(f.catalog, removed.file));
  f.index.recordCount--;
  f.writeIndex();
  const result = indexCatalog(f.catalog, f.output);
  const lookup = readPublished(f, result);
  assert.equal(result.shardCount, 1000);
  assert.deepEqual(new Set(lookup.entries.map(entry => entry.id)), new Set(Array.from({ length: 1000 }, (_, shard) => `${version}:e:${shard}:0`)));
});

test('10001 records in a shard cannot publish; 10000 records and exact source byte bounds can', t => {
  const f = fixture(t, [10001]);
  rejectUnpublished(f, /10000 per shard/);
  f.index.domains[0].count = f.index.recordCount = 10000;
  f.writeShard(0, 10000);
  f.writeIndex();
  padJson(path.join(f.catalog, 'index.json'), MiB);
  padJson(path.join(f.catalog, 'shard-0.json'), 8 * MiB);
  const result = indexCatalog(f.catalog, f.output);
  const lookup = readPublished(f, result);
  assert.equal(result.recordCount, 10000);
  assert.deepEqual(new Set(lookup.entries.map(entry => entry.id)), new Set(Array.from({ length: 10000 }, (_, record) => `${version}:e:0:${record}`)));
  assert.ok(fs.statSync(path.join(f.output, 'lookup.json')).size > MiB, 'lookup retains its separate 32MiB bound');
});

test('source index above 1MiB is rejected before publication', t => {
  const f = fixture(t, [1]);
  padJson(path.join(f.catalog, 'index.json'), MiB + 1);
  rejectUnpublished(f, /oversized catalog file: index\.json/);
});

test('raw shard above 8MiB is rejected before publication', t => {
  const f = fixture(t, [1]);
  padJson(path.join(f.catalog, 'shard-0.json'), 8 * MiB + 1);
  rejectUnpublished(f, /oversized catalog file: shard-0\.json/);
});

test('100000 records can publish without truncation, but 100001 cannot', t => {
  const f = fixture(t, Array(10).fill(10000));
  const result = indexCatalog(f.catalog, f.output);
  const lookup = readPublished(f, result);
  assert.equal(result.recordCount, 100000);
  const publishedIds = new Set(lookup.entries.map(entry => entry.id));
  assert.equal(publishedIds.size, 100000);
  for (let shard = 0; shard < 10; shard++) {
    assert.ok(publishedIds.has(`${version}:e:${shard}:0`));
    assert.ok(publishedIds.has(`${version}:e:${shard}:9999`));
  }
  f.index.domains.push({ name: 'e.d10', file: 'shard-10.json', count: 1 });
  f.index.recordCount++;
  f.writeShard(10, 1);
  f.writeIndex();
  rejectUnpublished(f, /100000 records/, path.join(f.root, 'overflow'));
});

test('projected lookup above 32MiB cannot publish even when every source shard fits', t => {
  const f = fixture(t, Array(10).fill(2000), '\u96ea'.repeat(600));
  for (const domain of f.index.domains) assert.ok(fs.statSync(path.join(f.catalog, domain.file)).size <= 8 * MiB);
  rejectUnpublished(f, /lookup exceeds 32MiB/);
});

test('lookup accepts exactly 32MiB and rejects one more byte without publishing', t => {
  const f = fixture(t, Array(5).fill(1));
  indexCatalog(f.catalog, f.output);
  const baseline = fs.statSync(path.join(f.output, 'lookup.json')).size;
  const extra = 32 * MiB - baseline;
  const names = Array.from({ length: 5 }, (_, shard) => 'n'.repeat(1 + Math.floor(extra / 5) + (shard < extra % 5 ? 1 : 0)));
  names.forEach((name, shard) => f.writeShard(shard, 1, name));
  f.output = path.join(f.root, 'boundary');
  const result = indexCatalog(f.catalog, f.output);
  assert.equal(fs.statSync(path.join(f.output, 'lookup.json')).size, 32 * MiB);
  const lookup = readPublished(f, result);
  assert.deepEqual(new Map(lookup.entries.map(entry => [entry.id, entry.name])), new Map(names.map((name, shard) => [`${version}:e:${shard}:0`, name])));
  f.writeShard(0, 1, `${names[0]}n`);
  rejectUnpublished(f, /lookup exceeds 32MiB/, path.join(f.root, 'oversized'));
});
