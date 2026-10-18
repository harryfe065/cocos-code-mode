#!/usr/bin/env node
'use strict';
const { fs, path, compare, stable, hash, parseArgs } = require('./catalog-utils');
const { TextDecoder } = require('node:util');
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_LOOKUP_BYTES = 32 * 1024 * 1024;
const MAX_SHARD_BYTES = 8 * 1024 * 1024;
const MAX_SHARDS = 1000;
const MAX_SHARD_RECORDS = 10000;
const MAX_RECORDS = 100000;
const HELP = `Usage: node scripts/cocos-api/index-catalog.js --catalog-root <full-dir> --output <fresh-index-dir>
Generates lookup.json and manifest.json; record shards remain in the original catalog root.
Limits: 1MiB source index, 1000 shards, 10000 records/8MiB per shard, 100000 total records, 32MiB lookup.
Output parent must exist; output must not exist.
No source execution. No overwrites. lookup.json is published last; publication failure may leave an incomplete output.
`;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.length > 0;
const nullableText = value => value === null || isText(value);
const fingerprint = stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].map(key => String(stat[key])).join(':');
const identity = stat => ['dev', 'ino', 'birthtimeNs'].map(key => String(stat[key])).join(':');
const serialize = value => Buffer.from(`${JSON.stringify(stable(value))}\n`, 'utf8');

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function guardFile(file) {
  if (!isText(file) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/.test(file)
      || path.basename(file) !== file || path.win32.basename(file) !== file) throw new Error(`Invalid catalog basename: ${file}`);
}
function snapshot(root, file, limit) {
  guardFile(file);
  const filename = path.join(root, file);
  const realpath = fs.realpathSync(filename);
  const before = fs.lstatSync(filename, { bigint: true });
  if (!inside(root, realpath) || !before.isFile() || before.isSymbolicLink()
      || before.size <= 0n || before.size > BigInt(limit)) throw new Error(`Unsafe or oversized catalog file: ${file}`);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (fingerprint(fs.fstatSync(fd, { bigint: true })) !== fingerprint(before)) throw new Error(`Input changed while opening: ${file}`);
    const bytes = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error(`Input truncated while reading: ${file}`);
      offset += count;
    }
    if (fingerprint(fs.fstatSync(fd, { bigint: true })) !== fingerprint(before)
        || fingerprint(fs.lstatSync(filename, { bigint: true })) !== fingerprint(before)
        || fs.realpathSync(filename) !== realpath) throw new Error(`Input changed while reading: ${file}`);
    return { file, limit, realpath, stat: fingerprint(before), sha256: hash(bytes), bytes };
  } finally { fs.closeSync(fd); }
}
function parseJson(source) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source.bytes)); }
  catch (error) { throw new Error(`Invalid UTF-8 JSON in ${source.file}: ${error.message}`); }
}
function validateIndex(index) {
  if (!isObject(index) || index.schemaVersion !== 1
      || typeof index.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(index.version)
      || typeof index.catalogHash !== 'string' || !/^[a-f0-9]{64}$/.test(index.catalogHash)
      || !Array.isArray(index.domains) || !index.domains.length || index.domains.length > MAX_SHARDS) throw new Error('Invalid catalog index schema, stable version, hash or domains (maximum 1000 shards).');
  const files = new Set(['index.json', 'lookup.json', 'manifest.json']);
  let total = 0;
  for (const domain of index.domains) {
    if (!isObject(domain) || !isText(domain.name) || !Number.isSafeInteger(domain.count)
        || domain.count < 1 || domain.count > MAX_SHARD_RECORDS) throw new Error('Invalid catalog domain or record count (maximum 10000 per shard).');
    guardFile(domain.file);
    const key = domain.file.toLowerCase();
    if (files.has(key)) throw new Error(`Duplicate or reserved catalog shard: ${domain.file}`);
    files.add(key);
    total += domain.count;
    if (total > MAX_RECORDS) throw new Error(`Catalog exceeds ${MAX_RECORDS} records.`);
  }
  if (index.recordCount !== undefined && index.recordCount !== total) throw new Error('Catalog index recordCount does not match domain counts.');
  return total;
}
function projectRecord(record, index, domain, shard, ids) {
  if (!isObject(record) || record.version !== index.version || !isText(record.id)
      || !isText(record.namespace) || !record.id.startsWith(`${index.version}:${record.namespace}:`)
      || !nullableText(record.className) || !isText(record.name) || !nullableText(record.member)
      || !isText(record.kind) || !isText(record.module)
      || (record.domain !== undefined && record.domain !== null && typeof record.domain !== 'string')) throw new Error(`Invalid record identity, version or metadata in ${domain.file}.`);
  if (record.visibility != null && !['public', 'protected', 'private', 'internal'].includes(record.visibility)) throw new Error(`Invalid visibility metadata in ${domain.file}.`);
  if (record.static != null && typeof record.static !== 'boolean') throw new Error(`Invalid static metadata in ${domain.file}.`);
  const contexts = record.contextConstraints?.execution ?? null;
  if (contexts !== null && (!Array.isArray(contexts) || contexts.length > 32 || contexts.some(value => !isText(value) || value.length > 128))) throw new Error(`Invalid execution context metadata in ${domain.file}.`);
  if (record.evidenceStatus != null && (!isText(record.evidenceStatus) || record.evidenceStatus.length > 128)) throw new Error(`Invalid evidence metadata in ${domain.file}.`);
  const recordDomain = `${record.namespace}.${record.domain || record.module.replace(/[^\w-]/g, '-')}`;
  if (recordDomain !== domain.name) throw new Error(`Record ${record.id} disagrees with domain ${domain.name}.`);
  if (ids.has(record.id)) throw new Error(`Duplicate catalog record ID: ${record.id}`);
  ids.add(record.id);
  return { id: record.id, shard, namespace: record.namespace, className: record.className,
    name: record.name, member: record.member, kind: record.kind, static: record.static ?? null, module: record.module, visibility: record.visibility ?? null, contexts, evidenceState: record.evidenceStatus ?? null, domain: domain.name };
}
function requireAbsent(file) {
  try { fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Output already exists: ${file}`);
}
function indexCatalog(catalogRoot, output) {
  const sourcePath = path.resolve(catalogRoot);
  const root = fs.realpathSync(sourcePath);
  if (!fs.statSync(root).isDirectory()) throw new Error('Catalog root must be a directory.');
  const requestedOutput = path.resolve(output);
  const parent = fs.realpathSync(path.dirname(requestedOutput));
  const destination = path.join(parent, path.basename(requestedOutput));
  if (destination === root || inside(root, destination)) throw new Error('Output must be outside the source catalog root.');
  requireAbsent(destination);
  const sourceIndex = snapshot(root, 'index.json', MAX_INDEX_BYTES);
  const index = parseJson(sourceIndex);
  const recordCount = validateIndex(index);
  const sources = [{ ...sourceIndex, bytes: undefined }];
  const entries = [];
  const shards = [];
  const ids = new Set();
  const domains = [...index.domains].sort((a, b) => compare(a.file, b.file));
  for (const domain of domains) {
    const source = snapshot(root, domain.file, MAX_SHARD_BYTES);
    const document = parseJson(source);
    if (!isObject(document) || !Array.isArray(document.records) || document.records.length !== domain.count
        || (document.schemaVersion !== undefined && document.schemaVersion !== 1)
        || (document.version !== undefined && document.version !== index.version)
        || (document.catalogHash !== undefined && document.catalogHash !== index.catalogHash)
        || (document.recordCount !== undefined && document.recordCount !== domain.count)) throw new Error(`Invalid shard metadata or record count: ${domain.file}`);
    const shard = shards.length;
    for (const record of document.records) entries.push(projectRecord(record, index, domain, shard, ids));
    shards.push({ file: domain.file, sha256: source.sha256, count: domain.count, domain: domain.name });
    sources.push({ ...source, bytes: undefined });
  }
  if (entries.length !== recordCount) throw new Error('Catalog total record count mismatch.');
  entries.sort((a, b) => compare(a.id, b.id));
  const lookup = serialize({ schemaVersion: 1, version: index.version, catalogHash: index.catalogHash,
    sourceIndexSha256: sourceIndex.sha256, shards, entries });
  if (lookup.length > MAX_LOOKUP_BYTES) throw new Error('Generated lookup exceeds 32MiB; no records are truncated.');
  const manifest = { lookupSha256: hash(lookup), version: index.version, catalogHash: index.catalogHash,
    sourceIndexSha256: sourceIndex.sha256, recordCount, shardCount: shards.length };
  const staging = fs.mkdtempSync(path.join(parent, '.catalog-index-'));
  const stagingIdentity = identity(fs.lstatSync(staging, { bigint: true }));
  try {
    fs.writeFileSync(path.join(staging, 'manifest.json'), serialize(manifest), { flag: 'wx' });
    fs.writeFileSync(path.join(staging, 'lookup.json'), lookup, { flag: 'wx' });
    for (const previous of sources) {
      const current = snapshot(root, previous.file, previous.limit);
      if (current.realpath !== previous.realpath || current.stat !== previous.stat || current.sha256 !== previous.sha256) throw new Error(`Input changed before publication: ${previous.file}`);
    }
    for (const source of sources) {
      if (fingerprint(fs.lstatSync(path.join(root, source.file), { bigint: true })) !== source.stat
          || fs.realpathSync(path.join(root, source.file)) !== source.realpath) throw new Error(`Input changed during final verification: ${source.file}`);
    }
    if (fs.realpathSync(sourcePath) !== root || fs.realpathSync(path.dirname(requestedOutput)) !== parent) throw new Error('Input root or output parent changed before publication.');
    // Exclusive directory creation reserves the destination; hard links never replace another file.
    fs.mkdirSync(destination);
    const destinationIdentity = identity(fs.lstatSync(destination, { bigint: true }));
    for (const file of ['manifest.json', 'lookup.json']) {
      const current = fs.lstatSync(destination, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || identity(current) !== destinationIdentity) throw new Error('Output directory changed during publication.');
      fs.linkSync(path.join(staging, file), path.join(destination, file));
    }
    return { output: destination, ...manifest };
  } finally {
    const current = fs.lstatSync(staging, { bigint: true });
    if (current.isDirectory() && !current.isSymbolicLink() && identity(current) === stagingIdentity) fs.rmSync(staging, { recursive: true });
  }
}
function main(args = process.argv.slice(2)) {
  const options = parseArgs(args, ['--catalog-root', '--output']);
  if (options.help) { console.log(HELP); return; }
  if (!options['catalog-root'] || !options.output) throw new Error('--catalog-root and --output are required.');
  const result = indexCatalog(options['catalog-root'], options.output);
  console.log(JSON.stringify(result));
  return result;
}
if (require.main === module) { try { main(); } catch (error) { console.error(`catalog-index: ${error.message}`); process.exitCode = 1; } }
module.exports = { indexCatalog, main };
