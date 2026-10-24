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
test('get_inheritance projects bounded direct engine inheritance without native dispatch', async t => {
  const record = {
    ...engineRecord(),
    semanticKey: '["engine-runtime","cc","Button","inspect","method",false]',
    static: false,
    inheritance: [{ relation: 'extends', type: 'Component' }, { relation: 'implements', type: 'EventTarget' }],
    inheritedFrom: 'Component',
  };
  const calls = catalog(t, record);
  const result = await discoverEngineApi({ operation: 'get_inheritance', recordId: record.id, maxEntries: 1 });
  assert.equal(result.operation, 'get_inheritance');
  assert.deepEqual(result.records, [{
    id: record.id, version: '3.7.3', namespace: 'engine-runtime', className: 'Button', member: 'inspect',
    kind: 'method', static: false, semanticKey: record.semanticKey, inheritance: record.inheritance, inheritedFrom: 'Component',
    permitted: false, mutationAuthorized: false, runtimeVerified: false, qualified: false,
  }]);
  assert.equal(result.total, 1);
  assert.equal(result.count, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.nextCursor, null);
  assert.equal(result.live.checked, false);
  assert.equal(result.live.mutationAuthorized, false);
  assert.equal(result.permitted, false);
  assert.equal(result.mutationAuthorized, false);
  assert.equal(result.runtimeVerified, false);
  assert.equal(result.qualified, false);
  assert.deepEqual(calls, { editor: 0, inspector: 0 });
});

test('get_inheritance accepts explicit empty inheritance and preserves null inheritedFrom', async t => {
  const record = { ...engineRecord(), inheritance: [], inheritedFrom: null };
  catalog(t, record);
  const result = await discoverEngineApi({ operation: 'get_inheritance', recordId: record.id });
  assert.deepEqual(result.records[0].inheritance, []);
  assert.equal(result.records[0].inheritedFrom, null);
});

test('get_inheritance fails closed for missing or malformed inheritance metadata', async t => {
  const cases = [
    [{ ...engineRecord() }, 'CATALOG_INDEX_UPGRADE_REQUIRED'],
    [{ ...engineRecord(), inheritance: null }, 'CATALOG_INVALID'],
    [{ ...engineRecord(), inheritance: [{}] }, 'CATALOG_INVALID'],
    [{ ...engineRecord(), inheritance: [{ relation: 'extends' }] }, 'CATALOG_INVALID'],
    [{ ...engineRecord(), inheritance: [{ relation: 'extends', type: 42 }] }, 'CATALOG_INVALID'],
    [{ ...engineRecord(), inheritance: Array.from({ length: 257 }, () => ({ relation: 'extends', type: 'Base' })) }, 'CATALOG_INVALID'],
    [{ ...engineRecord(), inheritance: [], inheritedFrom: 42 }, 'CATALOG_INVALID'],
  ];
  for (const [record, code] of cases) {
    await t.test(String(code), async child => {
      catalog(child, record);
      await assert.rejects(() => discoverEngineApi({ operation: 'get_inheritance', recordId: record.id }), error => error.code === code);
    });
  }
});

test('get_inheritance rejects non-engine records and selectors before native access', async t => {
  const record = { ...ipcRecord(), inheritance: [], inheritedFrom: null };
  const calls = catalog(t, record);
  await assert.rejects(() => discoverEngineApi({ operation: 'get_inheritance', recordId: record.id }), error => error.code === 'INVALID_ARGUMENT');
  for (const selector of [
    { reference: { id: 'node' } }, { className: 'Button' }, { namespace: 'engine-runtime' }, { domain: 'ui' },
    { member: 'inspect' }, { filter: 'Button' }, { compareVersion: '3.8.8' }, { compareRecordId: record.id },
  ]) {
    await assert.rejects(() => discoverEngineApi({ operation: 'get_inheritance', recordId: record.id, ...selector }), error => error.code === 'INVALID_ARGUMENT');
  }
  assert.deepEqual(calls, { editor: 0, inspector: 0 });
});
test('get_inheritance rejects unbounded exact identities before catalog access', async () => {
  await assert.rejects(
    () => discoverEngineApi({ operation: 'get_inheritance', recordId: 'r'.repeat(1025) }),
    error => error.code === 'INVALID_ARGUMENT',
  );
});


test('get_inheritance enforces maxBytes without partial success', async t => {
  const record = { ...engineRecord(), inheritance: [{ relation: 'extends', type: 'B'.repeat(10000) }], inheritedFrom: null };
  catalog(t, record);
  await assert.rejects(() => discoverEngineApi({ operation: 'get_inheritance', recordId: record.id, maxBytes: 256 }), error => error.code === 'RESULT_TOO_LARGE');
});

test('get_inheritance rejects stale cursors using exact catalog selector identity', async t => {
  const first = { ...engineRecord(), inheritance: [], inheritedFrom: null };
  const second = { ...engineRecord(), id: '3.7.3:engine-runtime:cc:Button:run:method:instance', member: 'run', name: 'run', inheritance: [], inheritedFrom: null };
  catalog(t, [first, second]);
  const page = await discoverEngineApi({ operation: 'records', maxEntries: 1 });
  await assert.rejects(() => discoverEngineApi({ operation: 'get_inheritance', recordId: first.id, cursor: page.nextCursor }), error => error.code === 'STALE_CURSOR');
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
test('unresolved discovery aggregates diagnostic kinds and deduplicates per source record', async t => {
  const first = { ...engineRecord(), unresolved: [{ kind: 'any' }, { kind: 'any' }, { kind: 'unknown' }] };
  const second = { ...engineRecord(), id: '3.7.3:engine-runtime:cc:Button:run:method:instance', member: 'run', name: 'run', unresolved: [{ kind: 'any' }] };
  const third = { ...engineRecord(), id: '3.7.3:engine-runtime:cc:Button:paint:method:instance', member: 'paint', name: 'paint', unresolved: [] };
  const calls = catalog(t, [first, second, third]);
  const result = await discoverEngineApi({ operation: 'list_unresolved', namespace: 'engine-runtime' });
  assert.deepEqual(result.records.map(row => [row.name, row.unresolvedKind, row.recordCount, row.occurrenceCount, row.kind, row.permitted]), [
    ['any', 'any', 2, 3, 'unresolved-summary', false],
    ['unknown', 'unknown', 1, 1, 'unresolved-summary', false],
  ]);
  assert.equal(result.live.checked, false);
  assert.equal(result.runtimeVerified, false);
  assert.equal(result.qualified, false);
  assert.equal(result.permitted, false);
  assert.equal(result.mutationAuthorized, false);
  assert.deepEqual(calls, { editor: 0, inspector: 0 });
});

test('unresolved discovery accepts explicit empty metadata and fails closed for missing or malformed metadata', async t => {
  const valid = { ...engineRecord(), unresolved: [] };
  catalog(t, valid);
  const empty = await discoverEngineApi({ operation: 'list_unresolved' });
  assert.deepEqual(empty.records, []);
  for (const unresolved of [undefined, null, [{}], [{ kind: '' }], [{ kind: 42 }], [null], ['any']]) {
    await t.test(unresolved === undefined ? 'missing' : JSON.stringify(unresolved), async child => {
      const record = { ...engineRecord() };
      if (unresolved !== undefined) record.unresolved = unresolved;
      catalog(child, record);
      await assert.rejects(() => discoverEngineApi({ operation: 'list_unresolved' }), error => error.code === (unresolved === undefined ? 'CATALOG_INDEX_UPGRADE_REQUIRED' : 'CATALOG_INVALID'));
    });
  }
});

test('unresolved discovery preserves pagination bounds and rejects stale cursors without native dispatch', async t => {
  const records = [
    { ...engineRecord(), unresolved: [{ kind: 'any' }] },
    { ...engineRecord(), id: '3.7.3:engine-runtime:cc:Button:run:method:instance', member: 'run', name: 'run', unresolved: [{ kind: 'unknown' }] },
  ];
  const calls = catalog(t, records);
  const page = await discoverEngineApi({ operation: 'list_unresolved', maxEntries: 1 });
  assert.equal(page.count, 1);
  assert.equal(page.truncated, true);
  assert.ok(page.nextCursor);
  const next = await discoverEngineApi({ operation: 'list_unresolved', maxEntries: 1, cursor: page.nextCursor });
  assert.equal(next.count, 1);
  assert.equal(next.truncated, false);
  await assert.rejects(() => discoverEngineApi({ operation: 'list_unresolved', namespace: 'editor-ipc', cursor: page.nextCursor }), error => error.code === 'STALE_CURSOR');
  await assert.rejects(() => discoverEngineApi({ operation: 'list_unresolved', maxBytes: 256 }), error => error.code === 'RESULT_TOO_LARGE');
  assert.deepEqual(calls, { editor: 0, inspector: 0 });
});



test('navigation refuses instance references instead of mapping them through Inspector', async t => {
  const record = engineRecord(), calls = catalog(t, record);
  const targets = [
    { operation: 'list_domains' }, { operation: 'list_classes' }, { operation: 'list_namespaces' }, { operation: 'list_modules' }, { operation: 'list_kinds' }, { operation: 'list_visibility' }, { operation: 'list_contexts' }, { operation: 'list_evidence' }, { operation: 'list_static' }, { operation: 'list_unresolved' },
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
