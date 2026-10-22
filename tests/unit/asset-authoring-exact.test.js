'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { AssetTools } = requireDist('utcp/tools/asset-tools.js');
const { ToolRegistry } = requireDist('utcp/decorators.js');
const { assetQueryMemo } = requireDist('utcp/utils/memo-cache.js');

function install(request) {
  const previous = global.Editor;
  global.Editor = { Message: { request } };
  return () => {
    assetQueryMemo.invalidate();
    if (previous === undefined) delete global.Editor;
    else global.Editor = previous;
  };
}

describe('exact asset authoring adapters', () => {
  it('finds assets by exact name with authoritative bounded records', async () => {
    const rows = [
      { uuid: 'a', name: 'Hero', url: 'db://assets/Hero.prefab', type: 'cc.Prefab', importer: 'prefab', isDirectory: false },
      { uuid: 'b', name: 'Hero', url: 'db://assets/Hero.scene', type: 'cc.SceneAsset', importer: 'scene', isDirectory: false },
      { uuid: 'c', name: 'Other', url: 'db://assets/Other.prefab', type: 'cc.Prefab', importer: 'prefab', isDirectory: false },
    ];
    const restore = install(async (service, message, options) => {
      assert.equal(service, 'asset-db');
      assert.equal(message, 'query-assets');
      assert.deepEqual(options, { name: 'Hero' });
      return rows;
    });
    try {
      const result = await new AssetTools().assetQuery({ name: 'Hero', limit: 1 });
      assert.equal(result.total, 2);
      assert.equal(result.truncated, true);
      assert.deepEqual(result.assets, [{ uuid: 'a', name: 'Hero', url: 'db://assets/Hero.prefab', type: 'cc.Prefab', importer: 'prefab', isDirectory: false }]);
    } finally { restore(); }
  });
  it('does not echo unknown reference ids as asset identities', async () => {
    const calls = [];
    const restore = install(async (service, message, id) => {
      calls.push([service, message, id]);
      if (service === 'asset-db' && message === 'query-asset-info') return null;
      throw new Error(`Unexpected ${service}.${message}:${id}`);
    });
    try {
      const result = await new AssetTools().assetResolvePath({ reference: { id: 'scene-node-id' } });
      assert.deepEqual(result, { filesystemPath: '', exists: false });
      assert.deepEqual(calls, [['asset-db', 'query-asset-info', 'scene-node-id']]);
    } finally { restore(); }
  });

  it('returns asset identity, metadata, and bounded serialized data', async () => {
    const info = { uuid: 'asset-id', url: 'db://assets/config.json', type: 'cc.JsonAsset', file: 'C:/project/assets/config.json', importer: 'json', isDirectory: false };
    const meta = { imported: true, userData: { schema: 'v1' } };
    const rawData = { enabled: true, label: 'hello' };
    const calls = [];
    const restore = install(async (service, message, id) => {
      calls.push([service, message, id]);
      if (message === 'query-asset-info') return info;
      if (message === 'query-asset-meta') return meta;
      if (message === 'query-asset-data') return rawData;
      throw new Error(`Unexpected ${service}.${message}`);
    });
    try {
      const result = await new AssetTools().assetInspect({ reference: { id: 'asset-id' }, maxDataBytes: 1024 });
      assert.deepEqual(result, {
        uuid: 'asset-id', url: info.url, type: info.type, file: info.file, isDirectory: false,
        importer: 'json', meta, data: rawData, dataBytes: JSON.stringify(rawData).length, dataTruncated: false,
      });
      assert.deepEqual(calls, [
        ['asset-db', 'query-asset-info', 'asset-id'],
        ['asset-db', 'query-asset-meta', 'asset-id'],
        ['asset-db', 'query-asset-data', 'asset-id'],
      ]);
    } finally { restore(); }
  });

  it('opens an asset by authoritative UUID and returns read-back identity', async () => {
    const calls = [];
    const restore = install(async (service, message, value) => {
      calls.push([service, message, value]);
      if (message === 'query-url') return 'db://assets/Hero.prefab';
      if (message === 'open-asset') return true;
      if (message === 'query-asset-info') return { uuid: 'asset-id', url: 'db://assets/Hero.prefab', type: 'cc.Prefab' };
      throw new Error(`Unexpected ${service}.${message}`);
    });
    try {
      const result = await new AssetTools().assetOpen({ reference: { id: 'asset-id', type: 'cc.Prefab' } });
      assert.deepEqual(result.reference, { id: 'asset-id', type: 'cc.Prefab' });
      assert.ok(calls.some(([, message, value]) => message === 'open-asset' && value === 'asset-id'));
    } finally { restore(); }
  });
  it('inspects a SpriteFrame subasset and reads its source image metadata', async () => {
    const restore = install(async (_service, message, id) => {
      if (message === 'query-asset-info' && id === 'image@frame') return { uuid: id, url: 'db://assets/image.png@frame', type: 'cc.SpriteFrame', importer: 'sprite-frame', isSubAsset: true };
      if (message === 'query-asset-info' && id === 'image') return { uuid: id, url: 'db://assets/image.png', type: 'cc.ImageAsset', importer: 'image' };
      if (message === 'query-asset-meta') return { subMetas: { frame: { userData: { borderTop: 1 } } } };
      throw new Error(`Unexpected ${message}:${id}`);
    });
    try {
      const result = await new AssetTools().spriteFrameInspect({ reference: { id: 'image@frame', type: 'cc.SpriteFrame' } });
      assert.deepEqual(result.reference, { id: 'image@frame', type: 'cc.SpriteFrame' });
      assert.deepEqual(result.sourceReference, { id: 'image', type: 'cc.ImageAsset' });
      assert.deepEqual(result.metadata, { frame: { userData: { borderTop: 1 } } });
    } finally { restore(); }
  });
  it('normalizes SpriteFrame geometry metadata', async () => {
    const restore = install(async (_service, message, id) => {
      if (message === 'query-asset-info' && id === 'image@frame') return { uuid: id, url: 'db://assets/image.png@frame', type: 'cc.SpriteFrame', importer: 'sprite-frame' };
      if (message === 'query-asset-info' && id === 'image') return { uuid: id, url: 'db://assets/image.png', type: 'cc.ImageAsset', importer: 'image' };
      if (message === 'query-asset-meta') return { subMetas: { frame: { userData: { width: 32, height: 16, borderTop: 2, trimmed: true } } } };
      throw new Error(`Unexpected ${message}:${id}`);
    });
    try {
      const result = await new AssetTools().spriteFrameGeometryInspect({ reference: { id: 'image@frame' } });
      assert.deepEqual(result.geometry.rect, { x: null, y: null, width: 32, height: 16 });
      assert.deepEqual(result.geometry.borders, { left: null, right: null, top: 2, bottom: null });
      assert.equal(result.geometry.trimmed, true);
      assert.equal(result.metadataAvailable, true);
    } finally { restore(); }
  });
  it('registers SpriteFrame geometry inspection', () => {
    const names = ToolRegistry.getTools().map(({ tool }) => tool.name);
    assert.ok(names.includes('spriteFrameGeometryInspect'));
  });
  it('inspects an imported script with class identity and bounded dependencies', async () => {
    const restore = install(async (service, message, id) => {
      if (service === 'asset-db' && message === 'query-asset-info') return { uuid: 'script-id', url: 'db://assets/scripts/Hero.ts', type: 'cc.Script', importer: 'typescript' };
      if (service === 'scene' && message === 'query-script-name') return 'Hero';
      if (service === 'scene' && message === 'query-script-cid') return 'HeroCID';
      if (service === 'asset-db' && message === 'query-asset-dependencies') return ['dep-a', 'dep-b'];
      throw new Error(`Unexpected ${service}.${message}:${id}`);
    });
    try {
      const result = await new AssetTools().scriptAssetInspect({ reference: { id: 'script-id' }, maxDependencies: 1 });
      assert.equal(result.className, 'Hero');
      assert.equal(result.classId, 'HeroCID');
      assert.deepEqual(result.dependencies, ['dep-a']);
      assert.equal(result.totalDependencies, 2);
      assert.equal(result.truncated, true);
    } finally { restore(); }
  });
  it('validates script and SpriteFrame assets through their bounded inspectors', async () => {
    const restore = install(async (service, message, id) => {
      if (service === 'asset-db' && message === 'query-asset-info' && id === 'script-id') return { uuid: 'script-id', url: 'db://assets/Hero.ts', type: 'cc.Script', importer: 'typescript' };
      if (service === 'scene' && message === 'query-script-name') return 'Hero';
      if (service === 'scene' && message === 'query-script-cid') return 'HeroCID';
      if (service === 'asset-db' && message === 'query-asset-dependencies') return [];
      if (service === 'asset-db' && message === 'query-asset-info' && id === 'image@frame') return { uuid: id, url: 'db://assets/image.png@frame', type: 'cc.SpriteFrame', importer: 'sprite-frame' };
      if (service === 'asset-db' && message === 'query-asset-info' && id === 'image') return { uuid: id, url: 'db://assets/image.png', type: 'cc.ImageAsset', importer: 'image' };
      if (service === 'asset-db' && message === 'query-asset-meta') return { subMetas: { frame: {} } };
      throw new Error(`Unexpected ${service}.${message}:${id}`);
    });
    try {
      assert.equal((await new AssetTools().scriptAssetValidate({ reference: { id: 'script-id' } })).valid, true);
      assert.equal((await new AssetTools().spriteFrameValidate({ reference: { id: 'image@frame' } })).valid, true);
    } finally { restore(); }
  });
  it('registers bounded script and SpriteFrame validation routes', () => {
    const names = ToolRegistry.getTools().map(({ tool }) => tool.name);
    assert.ok(names.includes('scriptAssetValidate'));
    assert.ok(names.includes('spriteFrameValidate'));
  });

  it('registers script dependency impact inspection', () => {
    const names = ToolRegistry.getTools().map(({ tool }) => tool.name);
    assert.ok(names.includes('scriptDependencyImpactInspect'));
  });
  it('rejects invalid reference limits before querying the Asset DB', async () => {
    let requests = 0;
    const restore = install(async () => {
      requests++;
      throw new Error('Asset DB must not be queried for invalid input');
    });
    try {
      await assert.rejects(
        () => new AssetTools().assetFindReferences({ reference: { id: 'asset-id' }, limit: 0 }),
        (error) => error.code === 'INVALID_ARGUMENT' && error.status === 400,
      );
      assert.equal(requests, 0);
    } finally { restore(); }
  });

  it('returns bounded dependency identities and resolves only the bounded page', async () => {
    const calls = [];
    const restore = install(async (service, message, id) => {
      calls.push([service, message, id]);
      if (message === 'query-asset-dependencies') return ['dep-a', { uuid: 'dep-b' }, { id: 'dep-c' }];
      if (message === 'query-asset-info') return { uuid: id, url: `db://assets/${id}.json`, type: 'cc.JsonAsset' };
      throw new Error(`Unexpected ${service}.${message}:${id}`);
    });
    try {
      const result = await new AssetTools().assetFindReferences({ direction: 'depends_on', reference: { id: 'asset-id' }, resolveUrls: true, limit: 2 });
      assert.deepEqual(result.references, [{ id: 'dep-a' }, { id: 'dep-b' }]);
      assert.deepEqual(result.assets, [
        { uuid: 'dep-a', url: 'db://assets/dep-a.json', type: 'cc.JsonAsset' },
        { uuid: 'dep-b', url: 'db://assets/dep-b.json', type: 'cc.JsonAsset' },
      ]);
      assert.equal(result.total, 3);
      assert.equal(result.truncated, true);
      assert.deepEqual(calls, [
        ['asset-db', 'query-asset-dependencies', 'asset-id'],
        ['asset-db', 'query-asset-info', 'dep-a'],
        ['asset-db', 'query-asset-info', 'dep-b'],
      ]);
    } finally { restore(); }
  });


  it('registers imported image inspection', () => {
    const names = ToolRegistry.getTools().map(({ tool }) => tool.name);
    assert.ok(names.includes('imageAssetInspect'));
  });
  it('registers source image metadata inspection', () => {
    const names = ToolRegistry.getTools().map(({ tool }) => tool.name);
    assert.ok(names.includes('imageSourceMetadataInspect'));
  });
  it('registers image source metadata batch inspection', () => {
    const names = ToolRegistry.getTools().map(({ tool }) => tool.name);
    assert.ok(names.includes('imageSourceMetadataBatchInspect'));
  });
  it('validates bounded source image metadata against caller constraints', async () => {
    const tools = new AssetTools();
    tools.imageSourceMetadataInspect = async () => ({ reference: { id: 'image', type: 'cc.ImageAsset' }, source: { url: 'db://assets/image.png', bytes: 128 }, width: 64, height: 32, format: 'png', space: 'srgb', channels: 4, hasAlpha: true, orientation: 1, density: 72, pages: 1 });
    const valid = await tools.imageSourceMetadataValidate({ reference: { id: 'image' }, width: 64, height: 32, formats: ['png'], hasAlpha: true, minDensity: 70, maxDensity: 100, pages: 1 });
    assert.equal(valid.valid, true);
    assert.deepEqual(valid.issues, []);
    const invalid = await tools.imageSourceMetadataValidate({ reference: { id: 'image' }, width: 128, formats: ['jpg'], hasAlpha: false });
    assert.equal(invalid.valid, false);
    assert.deepEqual(invalid.issues.map(({ code }) => code), ['IMAGE_WIDTH_MISMATCH', 'IMAGE_FORMAT_MISMATCH', 'IMAGE_ALPHA_MISMATCH']);
  });
  it('rejects contradictory image density bounds before inspection', async () => {
    const tools = new AssetTools();
    await assert.rejects(() => tools.imageSourceMetadataValidate({ reference: { id: 'image' }, minDensity: 100, maxDensity: 50 }), /minDensity must not exceed maxDensity/);
  });
  it('isolates image metadata validation failures and counts invalid results', async () => {
    const tools = new AssetTools();
    tools.imageSourceMetadataValidate = async (item) => {
      if (item.reference.id === 'broken') throw new Error('metadata unavailable');
      return { valid: item.reference.id === 'valid', reference: item.reference, metadata: {}, issues: item.reference.id === 'valid' ? [] : [{ code: 'IMAGE_WIDTH_MISMATCH' }] };
    };
    const result = await tools.imageSourceMetadataBatchValidate({ items: [{ reference: { id: 'valid' } }, { reference: { id: 'invalid' } }, { reference: { id: 'broken' } }] });
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.invalid, 1);
    assert.equal(result.partial, true);
    assert.equal(result.outcomes[2].error.message, 'metadata unavailable');
  });
  it('registers image and script impact validation routes', () => {
    const names = ToolRegistry.getTools().map(({ tool }) => tool.name);
    assert.ok(names.includes('imageAssetValidate'));
    assert.ok(names.includes('scriptDependencyImpactValidate'));
  });
  it('inspects a bounded SpriteFrame batch with per-item outcomes', async () => {
    const restore = install(async (_service, message, id) => {
      if (message === 'query-asset-info' && id === 'image@frame') return { uuid: id, url: 'db://assets/image.png@frame', type: 'cc.SpriteFrame', importer: 'sprite-frame' };
      if (message === 'query-asset-info' && id === 'image') return { uuid: id, url: 'db://assets/image.png', type: 'cc.ImageAsset', importer: 'image' };
      if (message === 'query-asset-meta') return { subMetas: { frame: {} } };
      throw new Error(`Unexpected ${message}:${id}`);
    });
    try {
      const result = await new AssetTools().spriteFrameBatchInspect({ references: [{ id: 'image@frame' }, { id: 'missing@frame' }] });
      assert.equal(result.succeeded, 1);
      assert.equal(result.failed, 1);
      assert.equal(result.items.length, 2);
    } finally { restore(); }
  });
  it('registers SpriteFrame batch inspection route', () => {
    const names = ToolRegistry.getTools().map(({ tool }) => tool.name);
    assert.ok(names.includes('spriteFrameBatchInspect'));
  });
  it('registers image and script batch inspection routes', () => {
    const names = ToolRegistry.getTools().map(({ tool }) => tool.name);
    assert.ok(names.includes('imageAssetBatchInspect'));
    assert.ok(names.includes('scriptAssetBatchInspect'));
  });
  it('registers live Sprite batch inspection', () => {
    const source = require('fs').readFileSync(require('path').resolve(__dirname, '../../source/utcp/tools/ui-tools.ts'), 'utf8');
    assert.match(source, /'spriteBatchInspect'/);
    assert.match(source, /nodeReferences/);
  });
  it('registers SpriteFrame mutation batch route', () => {
    const source = require('fs').readFileSync(require('path').resolve(__dirname, '../../source/utcp/tools/ui-tools.ts'), 'utf8');
    assert.match(source, /'spriteFrameBatchAssign'/);
    assert.match(source, /partial/);
  });
  it('registers image batch validation', () => {
    const names = ToolRegistry.getTools().map(({ tool }) => tool.name);
    assert.ok(names.includes('imageAssetBatchValidate'));
  });
  it('registers SpriteFrame and script batch validation', () => {
    const names = ToolRegistry.getTools().map(({ tool }) => tool.name);
    assert.ok(names.includes('spriteFrameBatchValidate'));
    assert.ok(names.includes('scriptAssetBatchValidate'));
  });
  it('registers Sprite configuration route', () => {
    const source = require('fs').readFileSync(require('path').resolve(__dirname, '../../source/utcp/tools/ui-tools.ts'), 'utf8');
    assert.match(source, /'spriteConfigure'/);
    assert.match(source, /SPRITE_CONFIGURE_FAILED/);
  });
  it('registers image dependency impact inspection', () => {
    const names = ToolRegistry.getTools().map(({ tool }) => tool.name);
    assert.ok(names.includes('imageDependencyImpactInspect'));
  });
  it('registers script impact batch inspection', () => {
    const names = ToolRegistry.getTools().map(({ tool }) => tool.name);
    assert.ok(names.includes('scriptDependencyImpactBatchInspect'));
  });
  it('extends Sprite configuration with bounded color channels', () => {
    const source = require('fs').readFileSync(require('path').resolve(__dirname, '../../source/utcp/tools/ui-tools.ts'), 'utf8');
    assert.match(source, /color channels must be integers from 0 to 255/);
    assert.match(source, /type: 'cc.Color'/);
  });
  it('keeps Sprite configuration color bounded', () => {
    const source = require('fs').readFileSync(require('path').resolve(__dirname, '../../source/utcp/tools/ui-tools.ts'), 'utf8');
    assert.match(source, /color channels must be integers from 0 to 255/);
  });
  it('registers Sprite batch configuration', () => {
    const source = require('fs').readFileSync(require('path').resolve(__dirname, '../../source/utcp/tools/ui-tools.ts'), 'utf8');
    assert.match(source, /'spriteBatchConfigure'/);
    assert.match(source, /Sprite configurations/);
  });

  it('registers the exact query, inspection, and open contracts', () => {
    const names = ToolRegistry.getTools().map(({ tool }) => tool.name);
    assert.ok(names.includes('assetQuery'));
    assert.ok(names.includes('assetInspect'));
    assert.ok(names.includes('assetOpen'));
  });
});
