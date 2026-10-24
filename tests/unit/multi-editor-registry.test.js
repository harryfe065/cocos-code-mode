'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const net = require('node:net');
const { requireDist } = require('../helpers/require-dist');
const { UtcpConfigManager } = requireDist('utcp/config-manager.js');
const { UtcpClientConfigSerializer } = require('@utcp/sdk');
require('@utcp/http');

it('concurrent processes preserve all editor endpoints and ownership; late cleanup cannot remove a replacement', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-registry-'));
  const configPath = path.join(dir, 'config.json');
  const modulePath = path.resolve(__dirname, '../../dist/utcp/config-manager.js');
  const other = { name: 'other', call_template_type: 'http', url: 'http://localhost:3000/utcp', http_method: 'GET' };
  fs.writeFileSync(configPath, JSON.stringify({ variables: { USER_VALUE: 'keep' }, manual_call_templates: [other,
    { ...other, name: 'ccp3x', url: 'http://localhost:42000/utcp' },
  ] }));
  const invalidReads = [];
  const reader = setInterval(() => {
    try { JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (error) { invalidReads.push(error.message); }
  }, 2);
  const barrier = path.join(dir, 'start');
  const worker = `global.Editor={Project:{path:process.argv[5]},Profile:{setConfig:async()=>{}}};const fs=require('node:fs');const net=require('node:net');const {UtcpConfigManager}=require(process.argv[1]);(async()=>{const port=Number(process.argv[3]);const server=net.createServer();await new Promise((r,j)=>{server.once('error',j);server.listen(port,'127.0.0.1',r)});while(!fs.existsSync(process.argv[6]))await new Promise(r=>setTimeout(r,5));const m=UtcpConfigManager.getInstance();await m.setConfigPath(process.argv[2]);await m.ensureCocosEditorTemplate(port,process.argv[4],process.argv[5]);fs.writeFileSync(process.argv[6]+'.done-'+port,'done');while(Array.from({length:8},(_,i)=>42001+i).some(p=>!fs.existsSync(process.argv[6]+'.done-'+p)))await new Promise(r=>setTimeout(r,5));await new Promise(r=>server.close(r));})().catch(e=>{console.error(e);process.exitCode=1});`;
  const legacyServer = net.createServer();
  await new Promise((resolve, reject) => { legacyServer.once('error', reject); legacyServer.listen(42000, '127.0.0.1', resolve); });
  try {
    const workers = Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
      execFile(process.execPath, ['-e', worker, modulePath, configPath, String(42001 + i), String(i + 1).padStart(32, '0'), path.join(dir, `project-${i}`), barrier],
        (error, stdout, stderr) => error ? reject(new Error(stdout + stderr)) : resolve());
    }));
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(barrier, 'go');
    await Promise.all(workers);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(config.manual_call_templates.map(t => t.name).sort(), ['other', ...Array.from({ length: 9 }, (_, i) => `ccp3x_${42000 + i}`)].sort());
    assert.equal(config.variables.USER_VALUE, 'keep');
    new UtcpClientConfigSerializer().validateDict(config);
    assert.deepEqual(invalidReads, [], 'readers must never see a partial registry');
    const original = global.Editor;
    global.Editor = { Profile: { setConfig: async () => {} } };
    try {
      const manager = UtcpConfigManager.getInstance();
      await manager.setConfigPath(configPath);
      const oldId = '1'.padStart(32, '0');
      const newId = 'a'.repeat(32);
      await manager.ensureCocosEditorTemplate(42001, newId);
      await manager.setConfigPath(path.join(dir, 'other-config.json'));
      assert.equal(await manager.removeCocosEditorTemplate(42001, oldId, configPath), false);
      await manager.setConfigPath(configPath);
      assert.equal(await manager.removeCocosEditorTemplate(42001, oldId), false);
      assert.ok(manager.readConfig().manual_call_templates.some(t => t.name === 'ccp3x_42001'));
      await manager.removeCocosEditorTemplate(42001, newId);
      assert.equal(manager.readConfig().manual_call_templates.some(t => t.name === 'ccp3x_42001'), false);
      assert.equal(manager.readConfig().manual_call_templates.some(t => t.name === 'ccp3x_42002'), false, 'a later publication prunes definitively closed endpoints');
      assert.equal(manager.readConfig().manual_call_templates.some(t => t.name === 'ccp3x'), false);
    } finally { global.Editor = original; }
  } finally {
    await new Promise(resolve => legacyServer.close(resolve));
    clearInterval(reader);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('invalid registry is preserved rather than overwritten by publication', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-broken-registry-'));
  const configPath = path.join(dir, 'config.json');
  const original = global.Editor;
  global.Editor = { Profile: { setConfig: async () => {} } };
  try {
    fs.writeFileSync(configPath, '{broken');
    const manager = UtcpConfigManager.getInstance();
    await manager.setConfigPath(configPath);
    await assert.rejects(manager.ensureCocosEditorTemplate(42100, 'b'.repeat(32)));
    assert.equal(fs.readFileSync(configPath, 'utf8'), '{broken');
    assert.equal(fs.existsSync(configPath + '.ccp-lock'), false);
  } finally { global.Editor = original; fs.rmSync(dir, { recursive: true, force: true }); }
});

it('ignores legacy serverPort while fixedServerPort remains explicit', async () => {
  const original = global.Editor;
  const values = { serverPort: 49999 };
  global.Editor = { Profile: { getConfig: async (_, key) => values[key], setConfig: async (_, key, value) => { values[key] = value; } } };
  try {
    const manager = UtcpConfigManager.getInstance();
    assert.equal(await manager.getCurrentPort(), 0);
    await manager.setConfiguredPort(42500);
    assert.equal(await manager.getCurrentPort(), 42500);
    await manager.setConfiguredPort(0);
    assert.equal(await manager.getCurrentPort(), 0);
    await assert.rejects(manager.setConfiguredPort(-1));
  } finally { global.Editor = original; }
});
it('normalizes numeric fixedServerPort values and recovers malformed preferences', async () => {
  const original = global.Editor;
  const writes = [];
  const values = { fixedServerPort: '42500' };
  global.Editor = {
    Profile: {
      getConfig: async (_package, key) => values[key],
      setConfig: async (_package, key, value) => { values[key] = value; writes.push([key, value]); },
    },
  };
  try {
    const manager = UtcpConfigManager.getInstance();
    assert.equal(await manager.getCurrentPort(), 42500);
    values.fixedServerPort = 'not-a-port';
    assert.equal(await manager.getCurrentPort(), 0);
    assert.deepEqual(writes, [['fixedServerPort', 42500], ['fixedServerPort', 0]]);
  } finally { global.Editor = original; }
});

it('internal publication preserves offline authenticated relay registrations and refuses their port', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-protected-registry-'));
  const configPath = path.join(dir, 'config.json');
  const original = global.Editor;
  global.Editor = { Profile: { setConfig: async () => {} } };
  const protectedTemplate = { name: 'ccp3x_42111', call_template_type: 'http',
    url: 'http://localhost:42111/utcp', http_method: 'GET', headers: { 'x-ccp-project-id': '${CCP_LOCAL_PROJECT_ID}' } };
  const loader = { variable_loader_type: 'dotenv', env_file_path: path.join(dir, 'private.env') };
  try {
    fs.writeFileSync(configPath, JSON.stringify({ manual_call_templates: [protectedTemplate], load_variables_from: [loader] }));
    const manager = UtcpConfigManager.getInstance();
    await manager.setConfigPath(configPath);
    await manager.ensureCocosEditorTemplate(42112, 'b'.repeat(32));
    assert.deepEqual(manager.readConfig().manual_call_templates.find(t => t.name === protectedTemplate.name), protectedTemplate);
    assert.deepEqual(manager.readConfig().load_variables_from, [loader]);
    await assert.rejects(manager.ensureCocosEditorTemplate(42111, 'c'.repeat(32)), /authenticated project relay/);
    assert.deepEqual(manager.readConfig().manual_call_templates.find(t => t.name === protectedTemplate.name), protectedTemplate);
  } finally { global.Editor = original; fs.rmSync(dir, { recursive: true, force: true }); }
});
