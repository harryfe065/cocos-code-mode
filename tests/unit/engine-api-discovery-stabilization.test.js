'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { requireDist } = require('../helpers/require-dist');
const { discoverEngineApi } = requireDist('engine-api-discovery.js');
const { ToolsUtils } = requireDist('utcp/utils/tools-utils.js');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const dto = { name: 'ArgsDto', resolution: 'resolved', kind: 'interface', enumValues: null };
const ipcRecord = () => ({ id: '3.7.3:editor-ipc:scene:inspect:message:instance', version: '3.7.3', namespace: 'editor-ipc', className: null, member: 'inspect', name: 'inspect', kind: 'message', domain: 'scene', signatures: [], permitted: true });
const engineRecord = () => ({ id: '3.7.3:engine-runtime:cc:Button:inspect:method:instance', version: '3.7.3', namespace: 'engine-runtime', className: 'Button', member: 'inspect', name: 'inspect', kind: 'method', domain: 'ui', signatures: [], permitted: true });

function catalog(t, record) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-discovery-stabilization-'));
  const previousEditor = global.Editor, previousInspect = ToolsUtils.inspectInstance;
  t.after(() => {
    global.Editor = previousEditor;
    ToolsUtils.inspectInstance = previousInspect;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const catalogRoot = path.join(root, 'catalog'), lookupRoot = path.join(root, 'lookup');
  fs.mkdirSync(path.join(root, '.ccp'));
  fs.mkdirSync(catalogRoot);
  fs.mkdirSync(lookupRoot);
  const domain = `${record.namespace}.${record.domain}`, catalogHash = 'a'.repeat(64);
  const shard = Buffer.from(JSON.stringify({ records: [record] }));
  const index = Buffer.from(JSON.stringify({ schemaVersion: 1, version: record.version, catalogHash, domains: [{ name: domain, file: 'records.json', count: 1 }] }));
  const lookup = Buffer.from(JSON.stringify({ schemaVersion: 1, version: record.version, catalogHash, sourceIndexSha256: hash(index), shards: [{ file: 'records.json', sha256: hash(shard), count: 1, domain }], entries: [{ ...record, domain, shard: 0 }] }));
  fs.writeFileSync(path.join(catalogRoot, 'records.json'), shard);
  fs.writeFileSync(path.join(catalogRoot, 'index.json'), index);
  fs.writeFileSync(path.join(lookupRoot, 'lookup.json'), lookup);
  fs.writeFileSync(path.join(root, '.ccp', 'engine-api-catalogs.json'), JSON.stringify({ schemaVersion: 1, catalogs: [{ version: record.version, catalogRoot, lookupRoot, lookupSha256: hash(lookup), catalogHash }] }));
  const calls = { editor: 0, inspector: 0 };
  global.Editor = { Project: { path: root }, Message: { request: async () => { calls.editor++; throw new Error('Unexpected editor dispatch'); } } };
  ToolsUtils.inspectInstance = async () => { calls.inspector++; throw new Error('Unexpected Inspector dispatch'); };
  return calls;
}

test('IPC related types retain source and declaration DTO dependencies with signature roles and indices', async t => {
  const record = ipcRecord();
  record.signatures = [{ kind: 'ipc' }, { kind: 'ipc', params: '[ArgsDto]', parameterReferences: [dto] }];
  record.declarationEvidence = { signatures: [{ kind: 'ipc' }, { kind: 'ipc' }, { kind: 'ipc', parameterReferences: [dto] }] };
  const calls = catalog(t, record);
  const result = await discoverEngineApi({ operation: 'get_related_types', recordId: record.id });
  assert.deepEqual(result.records.map(row => ({ relation: row.relation, metadata: row.metadata, permitted: row.permitted })), [
    { relation: 'declaration.signature.parameterReferences', metadata: { ...dto, relation: 'declaration.signature.parameterReferences', signatureIndex: 2 }, permitted: false },
    { relation: 'signature.parameterReferences', metadata: { ...dto, relation: 'signature.parameterReferences', signatureIndex: 1 }, permitted: false }
  ]);
  assert.equal(result.live.checked, false);
  assert.equal(result.live.mutationAuthorized, false);
  assert.deepEqual(calls, { editor: 0, inspector: 0 });
});

test('IPC parameter dependency containers and entries fail closed when malformed', async t => {
  for (const evidence of ['source', 'declaration']) {
    for (const parameterReferences of [{ name: 'ArgsDto' }, [42]]) {
      await t.test(`${evidence} ${Array.isArray(parameterReferences) ? 'entry' : 'container'}`, async child => {
        const record = ipcRecord(), signature = { kind: 'ipc', parameterReferences };
        if (evidence === 'source') record.signatures = [signature];
        else record.declarationEvidence = { signatures: [signature] };
        catalog(child, record);
        await assert.rejects(() => discoverEngineApi({ operation: 'get_related_types', recordId: record.id }), error => error.code === 'CATALOG_INVALID');
      });
    }
  }
});

test('source and declaration IPC dependencies share related-entry and serialized-byte budgets', async t => {
  await t.test('combined entry budget', async child => {
    const record = ipcRecord();
    record.declarationEvidence = { signatures: [{ parameterReferences: Array(5000).fill(dto) }] };
    record.signatures = [{ parameterReferences: Array(5001).fill(dto) }];
    catalog(child, record);
    await assert.rejects(() => discoverEngineApi({ operation: 'get_related_types', recordId: record.id }), error => error.code === 'CATALOG_RELATED_LIMIT' && /10000 entries/.test(error.message));
  });
  await t.test('combined byte budget', async child => {
    const record = ipcRecord(), large = { ...dto, name: 'A'.repeat(530000) };
    record.declarationEvidence = { signatures: [{ parameterReferences: [large] }] };
    record.signatures = [{ parameterReferences: [large] }];
    catalog(child, record);
    await assert.rejects(() => discoverEngineApi({ operation: 'get_related_types', recordId: record.id }), error => error.code === 'CATALOG_RELATED_LIMIT' && /1MiB/.test(error.message));
  });
});

test('class member and related-type navigation never dispatch availability or Inspector reads', async t => {
  const record = engineRecord(), calls = catalog(t, record);
  const members = await discoverEngineApi({ operation: 'list_members', className: 'Button' });
  assert.deepEqual(members.records.map(row => [row.className, row.member, row.permitted]), [['Button', 'inspect', false]]);
  assert.equal(members.live.checked, false);
  const related = await discoverEngineApi({ operation: 'get_related_types', recordId: record.id, className: 'Button' });
  assert.equal(related.live.checked, false);
  assert.deepEqual(calls, { editor: 0, inspector: 0 });
});

test('navigation refuses instance references instead of mapping them through Inspector', async t => {
  const record = engineRecord(), calls = catalog(t, record);
  const targets = [
    { operation: 'list_domains' }, { operation: 'list_classes' }, { operation: 'list_namespaces' },
    { operation: 'list_members', className: 'Button' },
    { operation: 'get_related_types', recordId: record.id }
  ];
  for (const target of targets) {
    await assert.rejects(() => discoverEngineApi({ ...target, reference: { id: 'button', type: 'cc.Button' } }), error => error.code === 'INVALID_ARGUMENT');
  }
  assert.deepEqual(calls, { editor: 0, inspector: 0 });
});

test('records and exact signatures retain intentional observations without granting permission', async t => {
  const record = engineRecord();
  catalog(t, record);
  let availabilityCalls = 0, inspectorCalls = 0;
  global.Editor.Message.request = async () => {
    availabilityCalls++;
    return { available: true, className: 'Button', engineVersion: '3.7.3', context: 'edit-scene' };
  };
  ToolsUtils.inspectInstance = async () => {
    inspectorCalls++;
    return { type: 'cc.Button', props: { enabled: { readonly: false }, name: { readonly: true } } };
  };
  for (const operation of ['records', 'get_signature']) {
    const target = { operation, className: 'Button', recordId: record.id };
    const available = await discoverEngineApi(target);
    assert.equal(available.live.checked, true);
    assert.equal(available.live.available, true);
    assert.equal(available.live.mutationAuthorized, false);
    assert.equal(available.records[0].permitted, false);
    const inspected = await discoverEngineApi({ ...target, reference: { id: 'button', type: 'cc.Button' } });
    assert.deepEqual(inspected.live.writablePaths, ['enabled']);
    assert.equal(inspected.live.mutationAuthorized, false);
    assert.equal(inspected.records[0].permitted, false);
    ToolsUtils.inspectInstance = async () => ({ type: 'cc.Label', props: {} });
    await assert.rejects(() => discoverEngineApi({ ...target, reference: { id: 'button', type: 'cc.Button' } }), error => error.code === 'TYPE_MISMATCH');
    ToolsUtils.inspectInstance = async () => {
      inspectorCalls++;
      return { type: 'cc.Button', props: { enabled: { readonly: false }, name: { readonly: true } } };
    };
  }
  assert.equal(availabilityCalls, 2);
  assert.equal(inspectorCalls, 2);
});
