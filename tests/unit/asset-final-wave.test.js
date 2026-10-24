'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requireDist } = require('../helpers/require-dist');

const { FileTools } = requireDist('utcp/tools/file-tools.js');
const { PreferenceTools } = requireDist('utcp/tools/preference-tools.js');

function restoreEditor(previous) {
  if (previous === undefined) delete global.Editor;
  else global.Editor = previous;
}

describe('final asset/import authoring wave', () => {
  it('returns a bounded project-file snippet and rejects paths outside the project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-snippet-'));
    const previous = global.Editor;
    global.Editor = { Project: { path: root } };
    fs.writeFileSync(path.join(root, 'script.ts'), 'one\ntwo\nthree\nfour\nfive\n');
    try {
      const result = await new FileTools().projectFileSnippet({ filePath: 'script.ts', line: 3, radius: 1 });
      assert.equal(result.snippet, 'two\nthree\nfour');
      assert.equal(result.startLine, 2);
      assert.equal(result.endLine, 4);
      await new FileTools().projectReplaceInFile({ filePath: 'script.ts', search: 'three', replace: 'changed', expectedSha256: result.sha256 });
      await assert.rejects(new FileTools().projectReplaceInFile({ filePath: 'script.ts', search: 'changed', replace: 'stale', expectedSha256: result.sha256 }), (error) => error.code === 'FILE_CONTENT_CHANGED');
      await assert.rejects(() => new FileTools().projectFileSnippet({ filePath: '../outside.ts', line: 1 }), (error) => error.code === 'INVALID_ARGUMENT');
    } finally {
      restoreEditor(previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('atomically writes and replaces bounded project files with read-back', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-file-write-'));
    const previous = global.Editor;
    global.Editor = { Project: { path: root }, Message: { request: async () => true } };
    try {
      const tools = new FileTools();
      const written = await tools.projectWriteFile({ filePath: 'src/a.ts', content: 'alpha\nbeta\n' });
      assert.equal(written.success, true);
      assert.equal(written.bytesWritten, 11);
      const replaced = await tools.projectReplaceInFile({ filePath: 'src/a.ts', search: 'beta', replace: 'gamma', expectedSha256: written.sha256 });
      assert.equal(replaced.replacements, 1);
      const read = await tools.projectReadFile({ filePath: 'src/a.ts' });
      assert.equal(read.content, 'alpha\ngamma\n');
      assert.equal(read.bytes, 12);
      await tools.projectReplaceInFile({ filePath: 'src/a.ts', search: 'gamma', replace: 'delta', expectedSha256: replaced.sha256 });
      await assert.rejects(tools.projectReplaceInFile({ filePath: 'src/a.ts', search: 'delta', replace: 'stale', expectedSha256: read.sha256 }), (error) => error.code === 'FILE_CONTENT_CHANGED');
      assert.deepEqual(await tools.projectSearchFiles({ pattern: '*.ts', directory: 'src' }), { files: ['src/a.ts'], total: 1, truncated: false });
      await assert.rejects(() => tools.projectWriteFile({ filePath: '../outside.ts', content: 'blocked' }), (error) => error.code === 'INVALID_ARGUMENT');
    } finally {
      restoreEditor(previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps CCP preferences scoped and reads/writes arbitrary package preferences through preferences IPC', async () => {
    const previous = global.Editor;
    const values = new Map();
    global.Editor = {
      Profile: {
        async getConfig(pkg, key) { return values.get(`${pkg}:${key}`); },
        async setConfig(pkg, key, value) { values.set(`${pkg}:${key}`, value); },
      },
      Message: { request: async (service, method, pkg, key, value) => {
        assert.equal(service, 'preferences');
        assert.ok(['queryConfig', 'setConfig'].includes(method));
        const id = `${pkg}:${key}`;
        if (method === 'setConfig') { values.set(id, value); return true; }
        return values.get(id);
      } },
    };
    try {
      const tools = new PreferenceTools();
      assert.deepEqual(await tools.getEditorPreference({ key: 'toolProfile' }), { key: 'toolProfile', value: null });
      assert.deepEqual(await tools.setEditorPreference({ key: 'toolProfile', value: 'full' }), { success: true, key: 'toolProfile', value: 'full' });
      assert.deepEqual(await tools.setEditorPreference({ key: 'fixedServerPort', value: 43123 }), { success: true, key: 'fixedServerPort', value: 43123 });
      await assert.rejects(() => tools.setEditorPreference({ key: 'fixedServerPort', value: '43123' }), /integer from 0 to 65535/);
      await assert.rejects(() => tools.setEditorPreference({ key: 'fixedServerPort', value: 65536 }), /integer from 0 to 65535/);
      assert.deepEqual(await tools.queryPreferencesConfig({ packageName: 'pkg.third-party', key: 'enabled/path' }), { value: null });
      assert.deepEqual(await tools.setPreferencesConfig({ packageName: 'pkg.third-party', key: 'enabled/path', value: true }), { updated: true, value: true });
      await assert.rejects(() => tools.queryPreferencesConfig({ packageName: '../outside', key: 'x' }), /bounded preference identifiers/);
      assert.ok('all' in await tools.getEditorPreference({}));
    } finally {
      restoreEditor(previous);
    }
  });
});
