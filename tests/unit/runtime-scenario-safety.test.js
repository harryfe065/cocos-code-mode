'use strict';

const { it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const vm = require('node:vm');
const { requireDist } = require('../helpers/require-dist');
const { RuntimeSessionTools } = requireDist('utcp/tools/runtime-session-tools.js');
const { P4ContractTools } = requireDist('utcp/tools/p4-contract-tools.js');
const { ToolError } = requireDist('utcp/tool-error.js');
const transport = requireDist('utcp/utils/game-view-transport.js');
const originalLifecycle = RuntimeSessionTools.prototype.runtimeSessionLifecycle;
const originalExecute = transport.executeGameViewOperation;
const originalLoad = Module._load;
const originalNow = Date.now;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const flush = () => new Promise(resolve => setImmediate(resolve));
const tools = new RuntimeSessionTools();

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function ready(sessionId) {
  return { success: true, ready: true, session: { sessionId, status: 'attached', targetId: 'scene', targetKind: 'game-view', createdAt: 1 } };
}

const controls = [
  { operation: 'graphSet', nodeReference: { id: 'node' }, componentId: 'component', graphUuid: 'graph', variableName: 'speed', variableType: 'float', variableValue: 2 },
  { operation: 'particleControl', nodeReference: { id: 'node' }, componentId: 'component', particleOperation: 'play' },
  { operation: 'animationControl', nodeReference: { id: 'node' }, componentId: 'component', clipName: 'walk', clipUuid: 'clip', animationOperation: 'play' },
  { operation: 'audioControl', nodeReference: { id: 'node' }, audioOperation: 'play' },
];

afterEach(() => {
  RuntimeSessionTools.prototype.runtimeSessionLifecycle = originalLifecycle;
  transport.executeGameViewOperation = originalExecute;
  Module._load = originalLoad;
  Date.now = originalNow;
});

for (const step of controls) {
  it(`${step.operation} does not dispatch when readiness settles after the step deadline`, async () => {
    const sessionId = `late-${step.operation}`, runId = 'late';
    const entered = deferred(), readiness = deferred();
    let dispatches = 0;
    RuntimeSessionTools.prototype.runtimeSessionLifecycle = async () => { entered.resolve(); return readiness.promise; };
    transport.executeGameViewOperation = async () => { dispatches++; throw Error('Late mutation must never reach transport'); };
    const pending = tools.runtimeScenarioRun({ sessionId, runId, totalTimeoutMs: 10000, steps: [{ ...step, timeoutMs: 3000 }] });
    // Observe rejection immediately without creating a second rejecting assertion promise
    // while a cold dynamic import is still entering the readiness gate.
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await entered.promise;
    const elapsed = originalNow() + 4000;
    Date.now = () => elapsed;
    readiness.resolve(ready(sessionId));
    const { error } = await outcome;
    Date.now = originalNow;
    assert.equal(error?.code, step.operation === 'audioControl' ? 'AUDIO_STATE_TIMEOUT' : 'RUNTIME_STATE_TIMEOUT');
    await flush();
    assert.equal(dispatches, 0);
    assert.equal((await tools.runtimeScenarioInspect({ sessionId, runId })).active, false);
  });

  it(`${step.operation} does not dispatch after cancellation during readiness`, async () => {
    const sessionId = `cancel-${step.operation}`, runId = 'cancel';
    const entered = deferred(), readiness = deferred();
    let dispatches = 0;
    RuntimeSessionTools.prototype.runtimeSessionLifecycle = async () => { entered.resolve(); return readiness.promise; };
    transport.executeGameViewOperation = async () => { dispatches++; throw Error('Cancelled mutation must never reach transport'); };
    const pending = tools.runtimeScenarioRun({ sessionId, runId, totalTimeoutMs: 10000, steps: [{ ...step, timeoutMs: 3000 }] });
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await entered.promise;
    await tools.runtimeScenarioCancel({ sessionId, runId });
    assert.equal((await outcome).error?.code, 'RUNTIME_SCENARIO_CANCELLED');
    assert.equal((await tools.runtimeScenarioInspect({ sessionId, runId })).active, true);
    readiness.resolve(ready(sessionId));
    await flush();
    assert.equal(dispatches, 0);
    assert.equal((await tools.runtimeScenarioInspect({ sessionId, runId })).active, false);
  });
}

it('keeps a timed-out native mutation busy through wrapper rejection and releases only after the native promise settles', async () => {
  const sessionId = 'native-pending', runId = 'pending';
  const native = deferred(), entered = deferred();
  let dispatches = 0;
  RuntimeSessionTools.prototype.runtimeSessionLifecycle = async () => ready(sessionId);
  const main = {
    isDestroyed: () => false,
    getURL: () => 'file:///Creator/node_modules/@editor/creator/static/windows/main.html',
    executeJavaScript: async () => [{ platform: 'gameView', enabled: true, ready: true, loaded: true, failed: false, webContentsId: 7 }],
  };
  const preview = {
    id: 7, isDestroyed: () => false, getType: () => 'webview',
    getURL: () => 'packages://scene?url=preload%5Cpreview%5Cpreload.js',
    executeJavaScript: source => {
      if (source.includes('function snapshot()')) return Promise.resolve({ gameView: true, phase: 'play', paused: false, sceneUuid: 'scene', timeScale: 1, frameCount: 1 });
      dispatches++; entered.resolve(); return native.promise;
    },
  };
  Module._load = function (name, parent, isMain) {
    if (name === 'electron') return { BrowserWindow: { getAllWindows: () => [{ webContents: main }] }, webContents: { fromId: () => preview } };
    return originalLoad.call(this, name, parent, isMain);
  };
  // Exercise a real transport timeout before the longer scenario deadline.
  transport.executeGameViewOperation = (target, source, _timeout, mutation, deadline, active) => originalExecute(target, source, 100, mutation, deadline, active);
  const pending = tools.runtimeScenarioRun({ sessionId, runId, totalTimeoutMs: 3000, steps: [{ ...controls[1], timeoutMs: 1000 }] });
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.code, 'RUNTIME_STATE_TIMEOUT');
    assert.equal(error.details.retrySafe, false);
    assert.equal(error.pendingRequest, native.promise, 'scenario wrapping must retain exact native pending identity');
    return true;
  });
  await entered.promise;
  await rejected;
  await flush();
  const inspect = await tools.runtimeScenarioInspect({ sessionId, runId });
  assert.equal(inspect.active, true);
  assert.equal(inspect.progress.requestPending, true);
  assert.equal(inspect.progress.callerFinished, true);
  await assert.rejects(tools.runtimeScenarioRun({ sessionId, runId: 'blocked', steps: [{ operation: 'delay', durationMs: 0 }] }), { code: 'RUNTIME_SCENARIO_BUSY' });
  assert.equal(dispatches, 1);
  native.resolve({});
  await flush();
  assert.equal((await tools.runtimeScenarioInspect({ sessionId, runId })).active, false);
  assert.equal((await tools.runtimeScenarioRun({ sessionId, runId: 'released', steps: [{ operation: 'delay', durationMs: 0 }] })).success, true);
});

it('retains busy ownership when the outer scenario deadline wins before the transport wrapper rejects', async () => {
  const sessionId = 'outer-timeout', runId = 'outer';
  const wrapper = deferred(), native = deferred();
  let dispatches = 0;
  RuntimeSessionTools.prototype.runtimeSessionLifecycle = async () => ready(sessionId);
  transport.executeGameViewOperation = () => { dispatches++; return wrapper.promise; };
  const pending = tools.runtimeScenarioRun({ sessionId, runId, steps: [{ ...controls[1], timeoutMs: 100 }] });
  await assert.rejects(pending, { code: 'RUNTIME_STATE_TIMEOUT' });
  const failure = new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Native mutation remains queued', details: { mutationDispatched: true, retrySafe: false } });
  Object.defineProperty(failure, 'pendingRequest', { value: native.promise });
  wrapper.reject(failure);
  await flush();
  assert.equal((await tools.runtimeScenarioInspect({ sessionId, runId })).progress.requestPending, true);
  await assert.rejects(tools.runtimeScenarioRun({ sessionId, steps: [{ operation: 'delay', durationMs: 0 }] }), { code: 'RUNTIME_SCENARIO_BUSY' });
  native.reject(Error('Native completion failed'));
  await flush();
  assert.equal((await tools.runtimeScenarioInspect({ sessionId, runId })).active, false);
  assert.equal(dispatches, 1);
});

it('standalone particle mutation keeps its native timeout separate from readiness', async () => {
  RuntimeSessionTools.prototype.runtimeSessionLifecycle = async () => { await sleep(120); return ready('standalone'); };
  let dispatches = 0;
  transport.executeGameViewOperation = async () => { dispatches++; return { nodeUuid: 'node', componentId: 'component', state: { playing: true, particleCount: 0 } }; };
  const result = await new P4ContractTools().particlePlayback({ sessionId: 'standalone', nodeReference: { id: 'node' }, componentId: 'component', operation: 'play', timeoutMs: 100 });
  assert.equal(result.success, true);
  assert.equal(dispatches, 1);
});

function animationContext() {
  class Animation {}
  const scene = { uuid: 'scene', children: [] };
  const clip = { uuid: 'clip', name: 'walk' };
  const state = { clip, isPlaying: false, isPaused: false, time: 0, duration: 1, speed: 1 };
  const listeners = new Map();
  let playback = 0, registrations = 0;
  const node = { uuid: 'node', children: [], parent: scene, getComponents: () => [component] };
  const component = { uuid: 'component', node, clips: [clip], getState: () => state,
    play() { playback++; }, stop() { playback++; }, pause() { playback++; }, resume() { playback++; },
    on(type, callback) { registrations++; listeners.set(type, callback); }, off(type) { listeners.delete(type); },
  };
  scene.children.push(node);
  const cc = { GAME_VIEW: true, ENGINE_VERSION: '3.7.3', Animation, director: { getScene: () => scene }, isValid: () => true };
  return { context: vm.createContext({ cc, performance, setTimeout, clearTimeout, setInterval, clearInterval }), listeners, playback: () => playback, registrations: () => registrations };
}

it('completes an explicit full-window animation capture plus session verification before the bounded step completes', async () => {
  const sessionId = 'events-complete', fixture = animationContext();
  let inspections = 0;
  RuntimeSessionTools.prototype.runtimeSessionLifecycle = async () => { inspections++; await sleep(30); return ready(sessionId); };
  transport.executeGameViewOperation = async (_target, source) => vm.runInContext(source, fixture.context);
  const result = await tools.runtimeScenarioRun({ sessionId, totalTimeoutMs: 3000, steps: [{ operation: 'animationEvents', nodeReference: { id: 'node' }, componentId: 'component', clipName: 'walk', clipUuid: 'clip', timeoutMs: 100 }] });
  const capture = result.outcomes[0].result;
  assert.equal(capture.reason, 'deadline');
  assert.ok(capture.elapsedMs >= 90, `full native window was truncated: ${capture.elapsedMs}`);
  assert.equal(inspections, 2, 'successful capture must also verify session continuity');
  assert.equal(fixture.registrations(), 6);
  assert.equal(fixture.listeners.size, 0);
  assert.equal(fixture.playback(), 0);
});

it('refuses a capture that cannot fit its full window and completion reserve before registering listeners', async () => {
  const sessionId = 'events-short', fixture = animationContext();
  let captures = 0;
  RuntimeSessionTools.prototype.runtimeSessionLifecycle = async () => ready(sessionId);
  transport.executeGameViewOperation = async (_target, source) => { captures++; return vm.runInContext(source, fixture.context); };
  await assert.rejects(tools.runtimeScenarioRun({ sessionId, totalTimeoutMs: 300, steps: [{ operation: 'animationEvents', nodeReference: { id: 'node' }, componentId: 'component', clipName: 'walk', clipUuid: 'clip', timeoutMs: 100 }] }), { code: 'RUNTIME_STATE_TIMEOUT' });
  assert.equal(captures, 0);
  assert.equal(fixture.registrations(), 0);
  assert.equal(fixture.playback(), 0);
});

it('native audio lookup cannot dispatch after the absolute caller deadline or poison a safely refused source', async () => {
  const { createAudioPlaybackExecutor } = requireDist('audio-playback.js');
  class AudioSource {
    static AudioState = { INIT: 0, PLAYING: 1, PAUSED: 2, STOPPED: 3, INTERRUPTED: 4 };
    static EventType = { STARTED: 'started', ENDED: 'ended' };
  }
  const scene = { uuid: 'scene' };
  const source = Object.assign(new AudioSource(), { clip: { uuid: 'clip' }, _isLoaded: true, _player: {}, duration: 2, currentTime: 0, state: 1, playing: true });
  let commands = 0;
  source._lastSetClip = source.clip;
  source.pause = () => { commands++; source.state = 2; source.playing = false; };
  const node = { uuid: 'node', parent: scene, getComponents: () => [source] };
  const cc = { GAME_VIEW: true, AudioSource, director: { getScene: () => scene } };
  const execute = createAudioPlaybackExecutor();
  const request = { sessionId: 'audio-native', targetId: 'scene', nodeUuid: 'node', operation: 'pause', timeoutMs: 100 };
  const refused = await execute({ ...request, expiresAt: Date.now() + 100 }, cc, async () => { await sleep(120); return node; });
  assert.equal(refused.error.code, 'AUDIO_STATE_TIMEOUT');
  assert.equal(refused.error.pendingMayComplete, undefined);
  assert.equal(commands, 0);
  const completed = await execute(request, cc, async () => node);
  assert.equal(completed.success, true);
  assert.equal(completed.state.playbackState, 'paused');
  assert.equal(commands, 1);
});
