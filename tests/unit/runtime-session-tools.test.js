'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { RuntimeSessionTools } = requireDist('utcp/tools/runtime-session-tools.js');
const { RuntimeTools } = requireDist('utcp/tools/runtime-tools.js');
const { ValidationTools } = requireDist('utcp/tools/validation-tools.js');
const { ToolError } = requireDist('utcp/tool-error.js');
const transport = requireDist('utcp/utils/game-view-transport.js');
const originalInspect = transport.inspectGameViewRuntime;
const originalDispatch = transport.dispatchGameViewLifecycle;
const originalSetTimeScale = transport.setGameViewTimeScale;

const tools = new RuntimeSessionTools();
afterEach(async () => {
  const { sessions } = await tools.runtimeSessionLifecycle({ operation: 'list' });
  for (const session of sessions) await tools.runtimeSessionLifecycle({ operation: 'reset', sessionId: session.sessionId });
  delete global.Editor;
  transport.inspectGameViewRuntime = originalInspect;
  transport.dispatchGameViewLifecycle = originalDispatch;
  transport.setGameViewTimeScale = originalSetTimeScale;
});

function installPreview(initial = 'stop') {
  const preview = { state: initial, sceneUuid: 'actual-scene', gamePaused: initial !== 'play', directorPaused: false };
  const runtime = { running: initial !== 'stop', paused: initial !== 'play', timeScale: 1, frameCount: 12, sceneUuid: preview.sceneUuid };
  const control = { preview, runtime, platform: 'gameView', commands: [], acknowledge: true, transition: true };
  transport.inspectGameViewRuntime = async () => {
    if (preview.state !== 'stop' && preview.gamePaused !== (preview.state === 'pause')) {
      throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'Inconsistent preview pause state' });
    }
    return { ...runtime, running: preview.state !== 'stop', sceneUuid: preview.state === 'stop' ? '' : preview.sceneUuid,
      paused: preview.state === 'stop' ? null : preview.gamePaused, platform: control.platform,
      timeScale: Number.isFinite(runtime.timeScale) ? runtime.timeScale : null,
      frameCount: Number.isSafeInteger(runtime.frameCount) ? runtime.frameCount : null,
      enabled: preview.state !== 'stop', ready: true, loaded: true, failed: false, webContentsId: preview.state === 'stop' ? null : 7 };
  };
  transport.setGameViewTimeScale = async (scale) => {
    if (preview.state === 'stop') throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'Preview stopped' });
    runtime.timeScale = scale;
    return transport.inspectGameViewRuntime();
  };
  transport.dispatchGameViewLifecycle = async (enabled) => {
    control.commands.push(['host-preview-set-play', enabled]);
    if (!control.acknowledge) throw Object.assign(new Error('rejected'), { code: 'RUNTIME_CONTROL_REJECTED' });
    if (control.transition) {
      preview.state = enabled ? 'play' : 'stop';
      preview.gamePaused = !enabled;
      runtime.running = enabled;
      runtime.paused = !enabled;
    }
  };
  global.Editor = { Profile: { getConfig: async () => control.platform }, Message: { request: async (service, message, ...args) => {
    if (message === 'execute-scene-script') throw new Error('Edit renderer scripts are not Game View authority');
    if (service === 'preview' && message === 'query-preview-url') return 'http://127.0.0.1:7456';
    control.commands.push([message, ...args]);
    if (!control.acknowledge) return false;
    if (control.transition) {
      if (message === 'editor-preview-set-play') preview.state = args[0] ? 'play' : 'stop';
      else if (args[0] === 'pause') preview.state = args[1] ? 'pause' : 'play';
      else if (args[0] === 'step') runtime.frameCount++;
      preview.gamePaused = preview.state !== 'play';
      runtime.running = preview.state !== 'stop';
      runtime.paused = preview.gamePaused;
    }
    return true;
  } } };
  return control;
}

async function start() {
  return tools.runtimeSessionLifecycle({ operation: 'start', targetKind: 'game-view', timeoutMs: 100 });
}

describe('bounded Creator game-view lifecycle', () => {
  it('recovers explicit safe transient state reads without dispatching playback', async () => {
    const control = installPreview();
    const inspect = transport.inspectGameViewRuntime;
    let reads = 0;
    transport.inspectGameViewRuntime = async () => {
      reads++;
      if (reads < 3) throw new ToolError({ code: 'ASSET_QUERY_FAILED', message: 'Transient observation failure', details: { retrySafe: true, mutationDispatched: false } });
      return inspect();
    };
    const observed = await tools.previewControl({ operation: 'state', timeoutMs: 1000 });
    assert.equal(observed.preview.state, 'stop');
    assert.equal(reads, 3);
    assert.deepEqual(control.commands, []);
  });
  it('rejects an unloaded browser platform without queuing a native start', async () => {
    const control = installPreview();
    control.platform = 'browser';
    await assert.rejects(start(), { code: 'RUNTIME_PLATFORM_REQUIRED', status: 409 });
    assert.deepEqual(control.commands, []);
    assert.deepEqual((await tools.runtimeSessionLifecycle({ operation: 'list' })).sessions, []);
    control.platform = 'gameView';
    assert.equal((await start()).ready, true);
  });

  it('bounds platform discovery without dispatching a native mutation', async () => {
    const control = installPreview();
    global.Editor.Profile.getConfig = () => new Promise(() => {});
    await assert.rejects(start(), { code: 'RUNTIME_STATE_TIMEOUT' });
    assert.deepEqual(control.commands, []);
    global.Editor.Profile.getConfig = async () => 'gameView';
    assert.equal((await start()).ready, true);
  });

  it('starts with native identity, observes, pauses, resumes and proves native stop', async () => {
    const control = installPreview();
    const attached = await start();
    const sessionId = attached.session.sessionId;
    assert.equal(attached.session.targetId, 'actual-scene');
    assert.equal(attached.ready, true);
    const runtime = new RuntimeTools();
    await runtime.runtimePause({ sessionId });
    assert.equal((await tools.runtimeStateObserve({ sessionId })).state.paused, true);
    assert.equal((await runtime.runtimeGetState()).paused, true);
    await runtime.runtimeSetTimeScale({ scale: 0.5 });
    assert.equal((await runtime.runtimeGetState()).timeScale, 0.5);
    await runtime.runtimeSessionManage({ operation: 'step', sessionId });
    assert.equal((await tools.runtimeStateObserve({ sessionId })).state.frameCount, 13);
    await runtime.runtimeResume({ sessionId });
    assert.equal((await runtime.runtimeGetState()).paused, false);
    assert.equal((await tools.runtimeScenarioAssert({ sessionId, paused: false })).passed, true);
    const stopped = await tools.runtimeSessionLifecycle({ operation: 'stop', sessionId });
    assert.equal(control.preview.state, 'stop');
    assert.equal(stopped.session.status, 'stopped');
    assert.equal(stopped.ready, false);
    assert.equal((await tools.previewSessionInspect({ sessionId })).stale, true);
    assert.equal((await runtime.runtimeSessionManage({ operation: 'state' })).ready, false);
    await assert.rejects(runtime.runtimeGetState(), { code: 'RUNTIME_NOT_READY', status: 409 });
    await assert.rejects(runtime.runtimeSetTimeScale({ scale: 1 }), { code: 'RUNTIME_NOT_READY', status: 409 });
  });

  it('reuses an already-running Game View without dispatching another start', async () => {
    const control = installPreview('play');
    const attached = await start();
    assert.equal(attached.ready, true);
    assert.equal(attached.session.targetId, 'actual-scene');
    assert.deepEqual(control.commands, []);
  });

  it('does not mistake scene metrics or a server URL for a running preview', async () => {
    const control = installPreview('play');
    await assert.rejects(tools.runtimeSessionLifecycle({ operation: 'attach', targetKind: 'game-view', targetId: 'caller-label' }), { code: 'RUNTIME_TARGET_CHANGED' });
    const attached = await tools.runtimeSessionLifecycle({ operation: 'attach', targetKind: 'game-view' });
    assert.equal(attached.session.targetId, 'actual-scene');
    control.preview.state = 'stop';
    await assert.rejects(tools.runtimeSessionLifecycle({ operation: 'attach', targetKind: 'game-view' }), { code: 'RUNTIME_NOT_READY' });
    const inspected = await tools.previewSessionInspect({ sessionId: attached.session.sessionId });
    assert.equal(inspected.ready, false);
    assert.equal(inspected.url, '');
  });

  it('does not treat native play phase as ready before the game resumes', async () => {
    const control = installPreview('play');
    control.preview.gamePaused = true;
    control.runtime.paused = true;
    await assert.rejects(tools.runtimeSessionLifecycle({ operation: 'attach', targetKind: 'game-view' }), { code: 'RUNTIME_NOT_READY' });
    assert.deepEqual((await tools.runtimeSessionLifecycle({ operation: 'list' })).sessions, []);
  });

  it('does not pretend a stopped host exposes the runtime scene identity', async () => {
    const control = installPreview('play');
    const { session } = await start();
    control.preview.state = 'stop';
    const result = await new RuntimeTools().runtimeSessionManage({ operation: 'state', sessionId: session.sessionId });
    assert.equal(result.ready, false);
    assert.equal(result.preview.sceneUuid, '');
  });

  it('preserves handles when stop is rejected or acknowledged without its postcondition', async () => {
    const control = installPreview('play');
    const { session } = await start();
    control.acknowledge = false;
    await assert.rejects(tools.runtimeSessionLifecycle({ operation: 'stop', sessionId: session.sessionId }), { code: 'RUNTIME_CONTROL_UNAVAILABLE' });
    assert.equal((await tools.runtimeSessionLifecycle({ operation: 'inspect', sessionId: session.sessionId })).ready, true);
    control.acknowledge = true;
    await assert.rejects(tools.runtimeSessionLifecycle({ operation: 'stop', sessionId: session.sessionId, timeoutMs: 100 }), { code: 'RUNTIME_CONTROL_BUSY' });
    control.preview.state = 'stop';
    assert.equal((await tools.previewControl({ operation: 'state' })).ready, false);
    assert.equal((await tools.runtimeSessionLifecycle({ operation: 'list' })).sessions[0].status, 'stopped');
  });

  it('does not retry an acknowledged stop without its renderer postcondition', async () => {
    const control = installPreview('play');
    const { session } = await start();
    control.transition = false;
    await assert.rejects(tools.runtimeSessionLifecycle({ operation: 'stop', sessionId: session.sessionId, timeoutMs: 100 }), { code: 'RUNTIME_STATE_TIMEOUT' });
    const dispatched = control.commands.length;
    await assert.rejects(tools.runtimeSessionLifecycle({ operation: 'stop', sessionId: session.sessionId }), { code: 'RUNTIME_CONTROL_BUSY' });
    assert.equal(control.commands.length, dispatched);
    assert.equal((await tools.runtimeSessionLifecycle({ operation: 'list' })).sessions[0].status, 'attached');
    control.preview.state = 'stop';
    await tools.previewControl({ operation: 'state' });
    assert.equal((await tools.runtimeSessionLifecycle({ operation: 'list' })).sessions[0].status, 'stopped');
  });

it('confirms stop when the host tears down before the next renderer read', async () => {
  const control = installPreview('play');
  const { session } = await start();
  transport.dispatchGameViewLifecycle = async (enabled) => {
    control.commands.push(['host-preview-set-play', enabled]);
    control.preview.state = 'stop';
    control.preview.gamePaused = true;
    control.runtime.running = false;
  };
  const stopped = await tools.runtimeSessionLifecycle({ operation: 'stop', sessionId: session.sessionId, timeoutMs: 100 });
  assert.equal(stopped.ready, false);
  assert.equal(stopped.session.status, 'stopped');
});

it('waits through a transient inconsistent renderer during stop without dispatching twice', async () => {
  const control = installPreview('play');
  const { session } = await start();
  const inspect = transport.inspectGameViewRuntime;
  let transitioning = false;
  let dispatches = 0;
  transport.dispatchGameViewLifecycle = async () => {
    dispatches++;
    transitioning = true;
  };
  transport.inspectGameViewRuntime = async () => {
    if (transitioning) {
      transitioning = false;
      control.preview.state = 'stop';
      throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'Native teardown is between phases' });
    }
    return inspect();
  };
  const result = await tools.runtimeSessionLifecycle({ operation: 'stop', sessionId: session.sessionId, timeoutMs: 500 });
  assert.equal(result.session.status, 'stopped');
  assert.equal(dispatches, 1);
});

it('waits for a selected Game View renderer to reload before sending start', async () => {
  const control = installPreview();
  const inspect = transport.inspectGameViewRuntime;
  let reloadReads = 0;
  transport.inspectGameViewRuntime = async () => {
    const state = await inspect();
    if (reloadReads++ < 2) {
      assert.equal(control.commands.length, 0);
      return { ...state, ready: false, loaded: false };
    }
    return state;
  };
  const result = await tools.runtimeSessionLifecycle({ operation: 'start', targetKind: 'game-view', timeoutMs: 500 });
  assert.equal(result.ready, true);
  assert.deepEqual(control.commands, [['host-preview-set-play', true]]);
});

  it('rejects stale targets without controlling the replacement preview or discarding the session', async () => {
    const control = installPreview('play');
    const { session } = await start();
    control.commands.length = 0;
    control.preview.sceneUuid = 'replacement-scene';
    await assert.rejects(tools.runtimeSessionLifecycle({ operation: 'inspect', sessionId: session.sessionId }), { code: 'RUNTIME_TARGET_CHANGED' });
    await assert.rejects(tools.runtimeSessionLifecycle({ operation: 'stop', sessionId: session.sessionId }), { code: 'RUNTIME_TARGET_CHANGED' });
    assert.equal(control.commands.length, 0);
    assert.equal((await tools.runtimeSessionLifecycle({ operation: 'list' })).sessions[0].sessionId, session.sessionId);
    assert.equal((await tools.previewSessionInspect({ sessionId: session.sessionId })).stale, true);
  });

  it('returns absent metrics as null and rejects frame assertions without evidence', async () => {
    const control = installPreview('play');
    const { session } = await start();
    control.runtime.frameCount = NaN;
    assert.equal((await tools.runtimeStateObserve({ sessionId: session.sessionId })).state.frameCount, null);
    control.runtime.timeScale = NaN;
    assert.deepEqual(await new RuntimeTools().runtimeGetState(), { paused: false, timeScale: null, frameCount: null });
    await assert.rejects(tools.runtimeScenarioAssert({ sessionId: session.sessionId, minFrameCount: 1 }), { code: 'UNSUPPORTED_RUNTIME_METRIC' });
    await assert.rejects(tools.runtimeWaitForState({ sessionId: session.sessionId, minFrameCount: 1, timeoutMs: 500 }), { code: 'UNSUPPORTED_RUNTIME_METRIC' });
  });

  it('bounds each state wait including a nonresponsive first read', async () => {
    installPreview('play');
    const { session } = await start();
    await assert.rejects(tools.runtimeWaitForState({ sessionId: session.sessionId, paused: true, timeoutMs: 10001 }), { code: 'INVALID_ARGUMENT', status: 400 });
    transport.inspectGameViewRuntime = () => new Promise(() => {});
    await assert.rejects(tools.runtimeWaitForState({ sessionId: session.sessionId, paused: true, timeoutMs: 100 }), { code: 'RUNTIME_STATE_TIMEOUT' });
  });

  it('releases only the local handle on reset and rejects unsupported transports', async () => {
    const control = installPreview('play');
    const { session } = await start();
    const result = await tools.runtimeSessionLifecycle({ operation: 'reset', sessionId: session.sessionId });
    assert.equal(result.session.reset, true);
    assert.equal(control.preview.state, 'play');
    await assert.rejects(tools.runtimeStateObserve({ sessionId: session.sessionId }), { code: 'SESSION_NOT_FOUND' });
    await assert.rejects(tools.runtimeSessionLifecycle({ operation: 'start', targetKind: 'browser-preview' }), { code: 'UNSUPPORTED_RUNTIME_TRANSPORT' });
  });
});

describe('Game View authority and deadline boundaries', () => {
  it('bounds a stalled host dispatch and blocks blind retries until settled state proves stop', async () => {
    const control = installPreview('play');
    const { session } = await start();
    let finish;
    transport.dispatchGameViewLifecycle = () => new Promise(resolve => { finish = resolve; });
    await assert.rejects(tools.previewControl({ operation: 'stop', sessionId: session.sessionId, timeoutMs: 100 }), { code: 'RUNTIME_STATE_TIMEOUT' });
    control.preview.state = 'stop';
    await tools.previewControl({ operation: 'state' });
    await assert.rejects(tools.previewControl({ operation: 'start' }), { code: 'RUNTIME_CONTROL_BUSY' });
    finish();
    await tools.previewControl({ operation: 'state' });
    assert.equal((await tools.runtimeSessionLifecycle({ operation: 'list' })).sessions[0].status, 'stopped');
  });

  it('does not control a replacement scene using a stale start handle', async () => {
    const control = installPreview('play');
    const { session } = await start();
    control.preview.sceneUuid = 'replacement-scene';
    await assert.rejects(new RuntimeTools().runtimeSessionManage({ operation: 'start', sessionId: session.sessionId }), { code: 'RUNTIME_TARGET_CHANGED' });
    assert.deepEqual(control.commands, []);
  });

  it('reports a start on another scene and permits explicit cleanup after read-only reconciliation', async () => {
    const control = installPreview();
    await assert.rejects(tools.previewControl({ operation: 'start', targetId: 'expected-scene', timeoutMs: 500 }), error => {
      assert.equal(error.code, 'RUNTIME_TARGET_CHANGED');
      assert.equal(error.details.actualSceneUuid, 'actual-scene');
      assert.equal(error.details.retrySafe, false);
      return true;
    });
    assert.deepEqual(control.commands, [['host-preview-set-play', true]]);
    await assert.rejects(tools.previewControl({ operation: 'start' }), { code: 'RUNTIME_CONTROL_BUSY' });
    const observed = await tools.previewControl({ operation: 'state' });
    assert.equal(observed.state.sceneUuid, 'actual-scene');
    const attached = await tools.runtimeSessionLifecycle({ operation: 'attach', targetKind: 'game-view', targetId: observed.state.sceneUuid });
    await tools.runtimeSessionLifecycle({ operation: 'stop', sessionId: attached.session.sessionId, timeoutMs: 500 });
    assert.deepEqual(control.commands, [['host-preview-set-play', true], ['host-preview-set-play', false]]);
  });

  it('validates a stopped runtime as not ready instead of fabricating healthy metrics', async () => {
    installPreview();
    global.Editor.Message.request = async (_service, message) => {
      if (message === 'query-node-tree') return { uuid: 'scene', name: 'Scene', children: [] };
      throw new Error(`Unexpected editor request ${message}`);
    };
    const validation = await new ValidationTools().validateScene({ includeScriptDiagnostics: false, includeLogErrors: false });
    assert.equal(validation.ok, false);
    assert.equal(validation.runtime.code, 'RUNTIME_NOT_READY');
    assert.equal(validation.runtime.paused, undefined);
    assert.equal(validation.runtime.timeScale, undefined);
  });
  it('rejects malformed or traversal scene transitions before touching the runtime session', async () => {
    const runtime = new RuntimeTools();
    await assert.rejects(runtime.runtimeSceneTransition({ sessionId: '', sceneName: 'main' }), { code: 'INVALID_ARGUMENT', status: 400 });
    await assert.rejects(runtime.runtimeSceneTransition({ sessionId: 'session-1', sceneName: '../outside' }), { code: 'INVALID_ARGUMENT', status: 400 });
    await assert.rejects(runtime.runtimeSceneTransition({ sessionId: 'session-1', sceneName: 'main', timeoutMs: 499 }), { code: 'INVALID_ARGUMENT', status: 400 });
  });
});
