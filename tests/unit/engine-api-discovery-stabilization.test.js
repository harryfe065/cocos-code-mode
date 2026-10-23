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
const engineRecord = () => ({ id: '3.7.3:engine-runtime:cc:Button:inspect:method:instance', version: '3.7.3', namespace: 'engine-runtime', module: 'cc/ui', className: 'Button', member: 'inspect', name: 'inspect', kind: 'method', visibility: 'public', contextConstraints: { execution: ['game-runtime'] }, domain: 'ui', signatures: [], permitted: true });

function catalog(t, record) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-discovery-stabilization-'));
  const records = Array.isArray(record) ? record : [record];
  const first = records[0];
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
  const domain = `${first.namespace}.${first.domain}`, catalogHash = 'a'.repeat(64);
  const shard = Buffer.from(JSON.stringify({ records }));
  const index = Buffer.from(JSON.stringify({ schemaVersion: 1, version: first.version, catalogHash, domains: [{ name: domain, file: 'records.json', count: records.length }] }));
  const lookupEntries = records.map(item => {
    const indexedContexts = item.contextConstraints?.execution;
    return { ...item, domain, shard: 0, ...(indexedContexts !== undefined ? { contexts: indexedContexts } : {}), ...(Object.prototype.hasOwnProperty.call(item, 'evidenceStatus') ? { evidenceState: item.evidenceStatus } : {}) };
  });
  const lookup = Buffer.from(JSON.stringify({ schemaVersion: 1, version: first.version, catalogHash, sourceIndexSha256: hash(index), shards: [{ file: 'records.json', sha256: hash(shard), count: records.length, domain }], entries: lookupEntries }));
  fs.writeFileSync(path.join(catalogRoot, 'records.json'), shard);
  fs.writeFileSync(path.join(catalogRoot, 'index.json'), index);
  fs.writeFileSync(path.join(lookupRoot, 'lookup.json'), lookup);
  fs.writeFileSync(path.join(root, '.ccp', 'engine-api-catalogs.json'), JSON.stringify({ schemaVersion: 1, catalogs: [{ version: first.version, catalogRoot, lookupRoot, lookupSha256: hash(lookup), catalogHash }] }));
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
  const modules = await discoverEngineApi({ operation: 'list_modules', namespace: 'engine-runtime' });
  assert.deepEqual(modules.records.map(row => [row.module, row.recordCount, row.permitted]), [['cc/ui', 1, false]]);
  assert.equal(modules.live.checked, false);
  const kinds = await discoverEngineApi({ operation: 'list_kinds', namespace: 'engine-runtime' });
  assert.deepEqual(kinds.records.map(row => [row.name, row.recordKind, row.recordCount, row.permitted]), [['method', 'method', 1, false]]);
  assert.equal(kinds.live.checked, false);
  const visibility = await discoverEngineApi({ operation: 'list_visibility', namespace: 'engine-runtime' });
  assert.deepEqual(visibility.records.map(row => [row.name, row.visibility, row.recordCount, row.permitted]), [['public', 'public', 1, false]]);
  assert.equal(visibility.live.checked, false);
  const contexts = await discoverEngineApi({ operation: 'list_contexts', namespace: 'engine-runtime' });
  assert.deepEqual(contexts.records.map(row => [row.name, row.context, row.recordCount, row.permitted]), [['game-runtime', 'game-runtime', 1, false]]);
  assert.equal(contexts.live.checked, false);
  const related = await discoverEngineApi({ operation: 'get_related_types', recordId: record.id, className: 'Button' });
  assert.equal(related.live.checked, false);
  assert.deepEqual(calls, { editor: 0, inspector: 0 });
});

test('evidence discovery groups indexed states without dispatch and omits null evidence', async t => {
  const record = engineRecord();
  record.evidenceStatus = 'signatureResolved';
  const calls = catalog(t, record);
  const result = await discoverEngineApi({ operation: 'list_evidence', namespace: 'engine-runtime' });
  assert.deepEqual(result.records.map(row => [row.name, row.evidenceState, row.recordCount, row.permitted]), [['signatureResolved', 'signatureResolved', 1, false]]);
  assert.equal(result.live.checked, false);
  assert.deepEqual(calls, { editor: 0, inspector: 0 });
  for (const evidenceStatus of [null, 'unknown']) {
    const nullCalls = catalog(t, { ...engineRecord(), evidenceStatus });
    const omitted = await discoverEngineApi({ operation: 'list_evidence', namespace: 'engine-runtime' });
    assert.deepEqual(omitted.records, []);
    assert.equal(omitted.live.checked, false);
    assert.deepEqual(nullCalls, { editor: 0, inspector: 0 });
  }
});
test('static discovery groups explicit metadata, omits unknown values, and never dispatches', async t => {
  const records = [
    { ...engineRecord(), id: '3.7.3:engine-runtime:cc:Button:inspect:method:static', static: true },
    { ...engineRecord(), id: '3.7.3:engine-runtime:cc:Button:run:method:instance', member: 'run', name: 'run', static: false },
    { ...engineRecord(), id: '3.7.3:engine-runtime:cc:Button:unknown:method:instance', member: 'unknown', name: 'unknown', static: null },
  ];
  const calls = catalog(t, records);
  const result = await discoverEngineApi({ operation: 'list_static', namespace: 'engine-runtime' });
  assert.deepEqual(result.records.map(row => [row.namespace, row.static, row.recordCount, row.kind, row.permitted]), [
    ['engine-runtime', false, 1, 'static-summary', false],
    ['engine-runtime', true, 1, 'static-summary', false],
  ]);
  assert.equal(result.live.checked, false);
  assert.deepEqual(calls, { editor: 0, inspector: 0 });
});


test('navigation refuses instance references instead of mapping them through Inspector', async t => {
  const record = engineRecord(), calls = catalog(t, record);
  const targets = [
    { operation: 'list_domains' }, { operation: 'list_classes' }, { operation: 'list_namespaces' }, { operation: 'list_modules' }, { operation: 'list_kinds' }, { operation: 'list_visibility' }, { operation: 'list_contexts' }, { operation: 'list_evidence' }, { operation: 'list_static' },
    { operation: 'list_members', className: 'Button' },
    { operation: 'get_related_types', recordId: record.id }
  ];
  for (const target of targets) {
    await assert.rejects(() => discoverEngineApi({ ...target, reference: { id: 'button', type: 'cc.Button' } }), error => error.code === 'INVALID_ARGUMENT');
  }
  assert.deepEqual(calls, { editor: 0, inspector: 0 });
});
test('context discovery refuses external lookups without indexed context metadata', async t => {
  const calls = catalog(t, ipcRecord());
  await assert.rejects(() => discoverEngineApi({ operation: 'list_contexts', namespace: 'editor-ipc' }), error => error.code === 'CATALOG_INDEX_UPGRADE_REQUIRED');
  assert.deepEqual(calls, { editor: 0, inspector: 0 });
});
test('evidence discovery refuses external lookups without indexed evidence metadata', async t => {
  const calls = catalog(t, ipcRecord());
  await assert.rejects(() => discoverEngineApi({ operation: 'list_evidence', namespace: 'editor-ipc' }), error => error.code === 'CATALOG_INDEX_UPGRADE_REQUIRED');
  assert.deepEqual(calls, { editor: 0, inspector: 0 });
});
test('static discovery refuses external lookups without indexed static metadata', async t => {
  const calls = catalog(t, ipcRecord());
  await assert.rejects(() => discoverEngineApi({ operation: 'list_static', namespace: 'editor-ipc' }), error => error.code === 'CATALOG_INDEX_UPGRADE_REQUIRED');
  assert.deepEqual(calls, { editor: 0, inspector: 0 });
});


test('get_signature exposes stable overload/accessor identities without collapsing type evidence', async t => {
  const record = engineRecord();
  record.id = '3.7.3:engine-runtime:cc:Widget:target:accessor:instance';
  record.className = 'Widget';
  record.member = record.name = 'target';
  record.kind = 'accessor';
  record.semanticKey = '["engine-runtime","cc","Widget","target","accessor",false]';
  const anyEvidence = { kind: 'any', reference: 'error' };
  record.signatures = [
    { kind: 'get', overload: 0, signatureId: 'target-get', parameters: [], returnType: 'Node | null', returnReferences: [dto], unresolved: [] },
    { kind: 'set', overload: 1, signatureId: 'target-set', parameters: [{ name: 'value', type: 'any', optional: false, rest: false, references: [], unresolved: [anyEvidence] }], returnType: 'void', unresolved: [] }
  ];
  record.declarationEvidence = { signatures: [{ kind: 'get', overload: 0, signatureId: 'decl-target-get', parameters: [], returnType: 'Node | null', unresolved: [{ kind: 'unknown', reference: 'cycle' }] }] };
  const calls = catalog(t, record);
  const result = await discoverEngineApi({ operation: 'get_signature', recordId: record.id });
  const projected = result.records[0];
  assert.deepEqual(projected.signatureIdentities.catalog, [
    {
      evidence: 'catalog-signature', recordId: record.id, semanticKey: record.semanticKey, className: 'Widget', member: 'target',
      recordKind: 'accessor', static: null, overload: 0, signatureId: 'target-get', signatureKind: 'get', accessor: 'get'
    },
    {
      evidence: 'catalog-signature', recordId: record.id, semanticKey: record.semanticKey, className: 'Widget', member: 'target',
      recordKind: 'accessor', static: null, overload: 1, signatureId: 'target-set', signatureKind: 'set', accessor: 'set'
    }
  ]);
  assert.deepEqual(projected.signatureIdentities.declaration.map(identity => [identity.evidence, identity.overload, identity.accessor]), [['declaration-signature', 0, 'get']]);
  assert.equal(projected.signatures[0].returnType, 'Node | null');
  assert.deepEqual(projected.signatures[0].returnReferences, [dto]);
  assert.deepEqual(projected.signatures[1].parameters[0].unresolved, [anyEvidence]);
  assert.deepEqual(projected.declarationEvidence.signatures[0].unresolved, [{ kind: 'unknown', reference: 'cycle' }]);
  assert.equal(result.live.mutationAuthorized, false);
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
