'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '../..', relativePath), 'utf8');
}

function toolContract(source, toolName) {
  const start = source.indexOf(`'${toolName}'`);
  assert.notEqual(start, -1, `${toolName} decorator must exist`);
  const next = source.indexOf('@utcpTool(', start + toolName.length);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('asset contract audit regressions', () => {
  it('requires only AssetTreeItem fields actually returned', () => {
    const schemas = readSource('source/utcp/schemas.ts');
    const assetTreeSchema = schemas.slice(schemas.indexOf('export const AssetTreeItemSchema'), schemas.indexOf('export const SceneTreeItemSchema'));

    assert.match(assetTreeSchema, /required: \['reference', 'name', 'children'\]/);
    assert.doesNotMatch(assetTreeSchema, /required: \[[^\]]*'type'/);
  });

  it('declares reference-or-path locators for asset and prefab endpoints', () => {
    const assets = readSource('source/utcp/tools/asset-tools.ts');
    const prefabs = readSource('source/utcp/tools/prefab-json-tools.ts');

    for (const toolName of ['assetResolvePath', 'assetReadContent', 'assetSaveContent']) {
      const contract = toolContract(assets, toolName);
      assert.match(contract, /anyOf:/);
      assert.match(contract, /required: \['reference'\]/);
      assert.match(contract, /required: \['assetPath'\]/);
    }
    for (const toolName of ['readPrefabJson', 'editPrefabJson', 'duplicatePrefab']) {
      const contract = toolContract(prefabs, toolName);
      assert.match(contract, /anyOf:/);
      assert.match(contract, /required: \['reference'\]/);
      assert.match(contract, /required: \['assetPath'\]/);
    }
  });

  it('declares filters, discriminator requirements, and finite caps', () => {
    const assets = readSource('source/utcp/tools/asset-tools.ts');
    const files = readSource('source/utcp/tools/file-tools.ts');
    const materials = readSource('source/utcp/tools/material-tools.ts');
    const assetQuery = toolContract(assets, 'assetQuery');
    assert.match(assetQuery, /anyOf:/);
    assert.match(assetQuery, /maximum: 1000/);
    assert.match(assetQuery, /boundedPositive\(args\.limit, 200, 1000\)/);
    const assetTree = toolContract(assets, 'assetGetTree');
    assert.match(assetTree, /maximum: VERBOSE_TREE_DEPTH/);
    assert.match(assetTree, /maximum: VERBOSE_TREE_NODES/);
    assert.match(assetTree, /boundedPositive\(args\.maxNodes/);

    const assetContent = toolContract(assets, 'assetReadContent');
    assert.match(assetContent, /maximum: VERBOSE_FILE_BYTES/);
    assert.match(assetContent, /boundedPositive\(args\.maxBytes/);

    const assetOperate = toolContract(assets, 'assetOperate');
    assert.match(assetOperate, /anyOf:/);
    assert.match(assetOperate, /const: 'move'/);
    assert.match(assetOperate, /required: \['targetAssetPath'\]/);
    assert.match(assetOperate, /const: 'save_meta'/);
    assert.match(assetOperate, /required: \['meta'\]/);

    const assetReferences = toolContract(assets, 'assetFindReferences');
    assert.match(assetReferences, /limit: \{ type: 'integer', minimum: 1, maximum: 1000/);
    assert.match(assetReferences, /const limitedUuids = uuids\.slice\(0, limit\)/);
    assert.match(assetReferences, /for \(const uuid of limitedUuids\)/);
    assert.match(assetReferences, /truncated/);

    const directory = toolContract(files, 'projectListDirectory');
    assert.match(directory, /maximum: MAX_DIRECTORY_ENTRIES/);
    assert.match(directory, /total: \{ type: 'number' \}/);
    assert.match(directory, /truncated: \{ type: 'boolean' \}/);
    assert.match(directory, /boundedPositive\(args\.limit, DEFAULT_DIRECTORY_ENTRIES, MAX_DIRECTORY_ENTRIES\)/);

    const materialQuery = toolContract(materials, 'materialQuery');
    assert.match(materialQuery, /oneOf:/);
    assert.match(materialQuery, /required: \['effectName'\]/);
    assert.match(materialQuery, /maximum: MAX_EFFECT_RESULTS/);
    assert.match(materialQuery, /boundedPositive\(args\.limit, DEFAULT_EFFECT_RESULTS, MAX_EFFECT_RESULTS\)/);

    const assetDbQuery = toolContract(materials, 'assetDbQuery');
    assert.match(assetDbQuery, /oneOf:/);
    assert.match(assetDbQuery, /maximum: MAX_RAW_DATA_BYTES/);
    assert.match(assetDbQuery, /truncated: \{ type: 'boolean' \}/);
    assert.match(assetDbQuery, /boundedPositive\(args\.maxBytes, DEFAULT_RAW_DATA_BYTES, MAX_RAW_DATA_BYTES\)/);
  });
});
