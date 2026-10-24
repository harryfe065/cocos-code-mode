'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requireDist } = require('../helpers/require-dist');
const { resolveBundleArtifact } = requireDist('utcp/utils/asset-bundle-artifact.js');

const projects = [];

afterEach(() => {
  for (const project of projects.splice(0)) fs.rmSync(project, { recursive: true, force: true });
});

describe('asset bundle artifact validation', () => {
  it('accepts Creator 3.7 data-only System.register output', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-bundle-artifact-'));
    projects.push(project);
    const name = 'native_bundle';
    const root = path.join(project, 'build', 'web-mobile', 'assets', name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      name,
      deps: [],
      uuids: ['native-text-uuid'],
      paths: { 0: ['payload', 0] },
      types: ['cc.TextAsset'],
      redirect: [],
      importBase: 'import',
      nativeBase: 'native',
    }));
    fs.writeFileSync(path.join(root, 'index.js'), `System.register("chunks:///_virtual/${name}",[],(function(){return{execute:function(){}}}));\n\n(function(r) {\n  r('virtual:///prerequisite-imports/${name}', 'chunks:///_virtual/${name}'); \n})(function(mid, cid) { System.register(mid, [cid], function (_export, _context) { return { setters: [function(_m) { var _exportObj = {}; for (var _key in _m) { if (_key !== "default" && _key !== "__esModule") _exportObj[_key] = _m[_key]; } _export(_exportObj); }], execute: function () { } }; }); });`);

    const artifact = resolveBundleArtifact(project, `build/web-mobile/assets/${name}`, name);
    assert.equal(artifact.name, name);
    assert.equal(artifact.indexFile, 'index.js');
  });
});
