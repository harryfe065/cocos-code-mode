'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { MaterialTools } = requireDist('utcp/tools/material-tools.js');

describe('materialEdit contract', () => {
  it('rejects missing references before editor mutation', async () => {
    await assert.rejects(
      () => new MaterialTools().materialEdit({ path: 'passes.0.properties.roughness', value: 0.5 }),
      error => error.code === 'INVALID_ARGUMENT' && error.status === 400,
    );
  });

  it('rejects unsafe property paths before editor mutation', async () => {
    await assert.rejects(
      () => new MaterialTools().materialEdit({ reference: { id: 'mat' }, path: 'passes[0].roughness', value: 0.5 }),
      error => error.code === 'INVALID_ARGUMENT' && error.status === 400,
    );
  });

  it('refuses native readback that ignores the requested technique and verifies restoration', async () => {
    const previous = global.Editor;
    let onChanged;
    global.Editor = { App: { version: '3.8.8' }, Message: {
      request: async (service, message) => {
        if (service === 'asset-db' && message === 'query-asset-info') return { uuid: 'mat', importer: 'material', type: 'cc.Material' };
        if (service === 'scene' && message === 'query-material') return { effect: 'test-effect', technique: 0, data: [{ passes: [] }, { passes: [] }] };
        if (service === 'scene' && message === 'query-all-effects') return [];
        if (service === 'scene' && message === 'preview-material') return;
        if (service === 'scene' && message === 'apply-material') {
          onChanged('mat', { uuid: 'mat', importer: 'material', imported: true, invalid: false });
          return;
        }
        throw new Error(`unexpected ${service}:${message}`);
      }, broadcast: () => undefined,
      addBroadcastListener: (_topic, listener) => { onChanged = listener; },
      removeBroadcastListener: () => { onChanged = undefined; },
    } };
    const { registerAllImporters } = requireDist('utcp/utils/asset-importers/index.js');
    registerAllImporters();
    try {
      await assert.rejects(() => new MaterialTools().materialEdit({ reference: { id: 'mat', type: 'cc.Material' }, path: 'technique', value: 1 }), error => error.code === 'READBACK_MISMATCH' && error.details.rollback === 'verified-restored');
    } finally {
      if (previous === undefined) delete global.Editor;
      else global.Editor = previous;
    }
  });

  it('waits for the target import and delayed renderer cache without writing a rollback', async () => {
    const previous = global.Editor;
    const white = { r: 255, g: 255, b: 255, a: 255 };
    const requested = { r: 120, g: 160, b: 200, a: 255 };
    const original = { effect: 'builtin-standard', technique: 0, data: [{ passes: [
      { props: [{ name: 'mainColor', type: 'cc.Color', value: white, default: white }], defines: [] },
      { props: [{ name: 'roughness', type: 'Number', value: 0.7, default: 0.5 }], defines: [] },
    ] }] };
    const desired = JSON.parse(JSON.stringify(original));
    desired.data[0].passes[0].props[0].value = requested;
    let current = original;
    let onChanged;
    let writes = 0;
    let importFinished = false;
    let staleReadsAfterImport = 0;
    const timers = [];
    global.Editor = { Message: {
      request: async (service, message, id, dump) => {
        if (service === 'asset-db' && message === 'query-asset-info') return { uuid: 'mat', importer: 'material', type: 'cc.Material' };
        if (message === 'query-material') {
          if (importFinished && current === original) staleReadsAfterImport++;
          return JSON.parse(JSON.stringify(current));
        }
        if (message === 'preview-material') return;
        if (message === 'apply-material') {
          writes++;
          // A different asset import cannot complete this material's native save.
          onChanged('other', { uuid: 'other', importer: 'material', imported: true, invalid: false });
          timers.push(setTimeout(() => {
            importFinished = true;
            onChanged(id, { uuid: id, importer: 'material', imported: true, invalid: false });
          }, 10));
          // The save response and import broadcast both precede the scene cache reload.
          timers.push(setTimeout(() => { current = JSON.parse(JSON.stringify(dump)); }, 30));
          return;
        }
        throw new Error(`unexpected ${service}:${message}`);
      },
      addBroadcastListener: (_topic, listener) => { onChanged = listener; },
      removeBroadcastListener: () => { onChanged = undefined; },
      broadcast: () => undefined,
    } };
    const { registerAllImporters } = requireDist('utcp/utils/asset-importers/index.js');
    registerAllImporters();
    try {
      const result = await new MaterialTools().materialEdit({ reference: { id: 'mat', type: 'cc.Material' }, path: 'passes.0.properties.mainColor', value: requested });
      assert.deepEqual(result.readBackValue, requested);
      assert.deepEqual(result.after, desired);
      assert.equal(staleReadsAfterImport > 0, true);
      assert.equal(writes, 1);
      assert.equal(onChanged, undefined);
    } finally {
      timers.forEach(clearTimeout);
      if (previous === undefined) delete global.Editor;
      else global.Editor = previous;
    }
  });

  it('does not race restoration against a lost material save response', async () => {
    const previous = global.Editor;
    let writes = 0;
    let listener;
    global.Editor = { Message: {
      request: async (_service, message) => {
        if (message === 'query-asset-info') return { uuid: 'mat', importer: 'material', type: 'cc.Material' };
        if (message === 'query-material') return { effect: 'test-effect', technique: 0, data: [{ passes: [] }, { passes: [] }] };
        if (message === 'preview-material') return;
        if (message === 'apply-material') { writes++; throw new Error('lost native save reply'); }
        throw new Error(`unexpected ${message}`);
      },
      addBroadcastListener: (_topic, callback) => { listener = callback; },
      removeBroadcastListener: () => { listener = undefined; },
      broadcast: () => undefined,
    } };
    const { registerAllImporters } = requireDist('utcp/utils/asset-importers/index.js');
    registerAllImporters();
    try {
      await assert.rejects(() => new MaterialTools().materialEdit({ reference: { id: 'mat' }, path: 'technique', value: 1 }), error => error.code === 'MATERIAL_MUTATION_OUTCOME_UNKNOWN' && error.details.retrySafe === false && error.details.restored === null);
      assert.equal(writes, 1);
      assert.equal(listener, undefined);
    } finally {
      if (previous === undefined) delete global.Editor;
      else global.Editor = previous;
    }
  });

  it('does not dispatch a late save after preview times out and releases its listener', async () => {
    const previous = global.Editor;
    const previousSetTimeout = global.setTimeout;
    let releasePreview;
    let expire;
    let writes = 0;
    let listener;
    const pendingPreview = new Promise(resolve => { releasePreview = resolve; });
    global.setTimeout = (callback, delay, ...args) => {
      if (delay === 5000) { expire = () => callback(...args); return undefined; }
      return previousSetTimeout(callback, delay, ...args);
    };
    global.Editor = { Message: {
      request: async (_service, message) => {
        if (message === 'preview-material') return pendingPreview;
        if (message === 'apply-material') { writes++; return; }
        throw new Error(`unexpected ${message}`);
      },
      addBroadcastListener: (_topic, callback) => { listener = callback; },
      removeBroadcastListener: () => { listener = undefined; },
      broadcast: () => undefined,
    } };
    const { MaterialImporter } = requireDist('utcp/utils/asset-importers/material-importer.js');
    try {
      const pending = new MaterialImporter().applyDump('mat', {});
      expire();
      await assert.rejects(pending, error => error.code === 'MATERIAL_MUTATION_OUTCOME_UNKNOWN' && error.details.retrySafe === false);
      releasePreview();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(writes, 0);
      assert.equal(listener, undefined);
    } finally {
      global.setTimeout = previousSetTimeout;
      if (previous === undefined) delete global.Editor;
      else global.Editor = previous;
    }
  });

  it('applies render configuration with scene read-back and snapshot', async () => {
    const previous = global.Editor;
    const node = { uuid: 'render-node', camera: { value: { fov: 45 } } };
    const calls = [];
    global.Editor = { Message: { request: async (service, message, payload) => {
      calls.push({ service, message, payload });
      if (message === 'query-node') return node;
      if (message === 'set-property') { node.camera.value.fov = payload.dump.value; return true; }
      if (message === 'snapshot') return true;
      throw new Error(`unexpected ${service}:${message}`);
    } } };
    try {
      const result = await new MaterialTools().renderConfigurationApply({ updates: [{ reference: { id: 'render-node', type: 'cc.Node' }, path: 'camera.fov', value: 60 }] });
      assert.deepEqual(result, {
        changed: ['camera.fov'],
        readBack: [{ reference: { id: 'render-node', type: 'cc.Node' }, path: 'camera.fov', value: 60 }],
        verified: true,
      });
    } finally {
      if (previous === undefined) delete global.Editor;
      else global.Editor = previous;
    }
  });

  it('rolls back applied render configuration after stale read-back and verifies restoration', async () => {
    const previous = global.Editor;
    const node = { uuid: 'render-node', camera: { value: { fov: 44 } } };
    let queryCount = 0;
    global.Editor = { Message: { request: async (_service, message, payload) => {
      if (message === 'query-node') {
        queryCount += 1;
        if (queryCount === 2) return { uuid: 'render-node', camera: { value: { fov: 44 } } };
        return node;
      }
      if (message === 'set-property') { node.camera.value.fov = payload.dump.value; return true; }
      if (message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    try {
      await assert.rejects(
        () => new MaterialTools().renderConfigurationApply({ updates: [{ reference: { id: 'render-node', type: 'cc.Node' }, path: 'camera.fov', value: 60 }] }),
        error => error.code === 'MUTATION_FAILED' && error.status === 502,
      );
      assert.equal(node.camera.value.fov, 44);
    } finally {
      if (previous === undefined) delete global.Editor;
      else global.Editor = previous;
    }
  });
  it('does not race restoration against a lost native mutation response', async () => {
    const previous = global.Editor;
    let value = 45;
    let writes = 0;
    global.Editor = { Message: { request: async (_service, message, payload) => {
      if (message === 'query-node') return { camera: { value: { fov: value } } };
      if (message === 'set-property') { writes++; value = payload.dump.value; throw new Error('lost response'); }
      throw new Error(`unexpected ${message}`);
    } } };
    try {
      await assert.rejects(new MaterialTools().renderConfigurationApply({ updates: [{ reference: { id: 'node' }, path: 'camera.fov', value: 60 }] }), error => error.code === 'RENDER_MUTATION_OUTCOME_UNKNOWN' && error.details.retrySafe === false && error.details.restored === null);
      assert.equal(value, 60);
      assert.equal(writes, 1);
    } finally { if (previous === undefined) delete global.Editor; else global.Editor = previous; }
  });
  it('preserves an external edit instead of overwriting it during restoration', async () => {
    const previous = global.Editor;
    let value = 45;
    let writes = 0;
    global.Editor = { Message: { request: async (_service, message, payload) => {
      if (message === 'query-node') return { camera: { value: { fov: value } } };
      if (message === 'set-property') { writes++; value = payload.dump.value; return true; }
      if (message === 'snapshot') { value = 90; throw new Error('external edit'); }
      throw new Error(`unexpected ${message}`);
    } } };
    try {
      await assert.rejects(new MaterialTools().renderConfigurationApply({ updates: [{ reference: { id: 'node' }, path: 'camera.fov', value: 60 }] }), error => error.code === 'ROLLBACK_FAILED');
      assert.equal(value, 90);
      assert.equal(writes, 1);
    } finally { if (previous === undefined) delete global.Editor; else global.Editor = previous; }
  });
});
