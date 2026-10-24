import { ToolError } from '../tool-error';

export interface GameViewRuntime {
    running: boolean;
    paused: boolean | null;
    timeScale: number | null;
    frameCount: number | null;
    sceneUuid: string;
    webContentsId: number | null;
    platform: string;
    enabled: boolean;
    ready: boolean;
    loaded: boolean;
    failed: boolean;
}

interface HostContents {
    id: number;
    getURL(): string;
    getType(): string;
    isDestroyed(): boolean;
    executeJavaScript(source: string): Promise<unknown>;
}
interface ElectronHost {
    BrowserWindow: { getAllWindows(): Array<{ webContents: HostContents }> };
    webContents: { fromId(id: number): HostContents | undefined };
}
interface PreviewHost {
    platform: string;
    enabled: boolean;
    ready: boolean;
    loaded: boolean;
    failed: boolean;
    webContentsId: number | null;
}

const OPERATION_TIMEOUT_MS = 10_000;
const RENDERER_TIMEOUT_MS = 5_000;

// Creator 3.7.3 host adapter. Only validated data is inserted into fixed operations.
const HOST_INSPECTION = `(() => {
    const views = [];
    function visit(root) {
        for (const element of root.querySelectorAll('*')) {
            if (element.tagName === 'ENGINE-VIEW' && element.previewClient && element.getClientRects().length) {
                const client = element.previewClient;
                views.push({ platform: element._platform, enabled: typeof element.isPreviewEnabled === 'boolean' ? element.isPreviewEnabled : element._isPreviewEnabled,
                    ready: client.isPreviewReady, loaded: client._loaded, failed: client.isPreviewFailed,
                    webContentsId: client._loaded && client.webview ? client.webview.getWebContentsId() : null });
            }
            if (element.shadowRoot) visit(element.shadowRoot);
        }
    }
    visit(document);
    return views;
})()`;
const RUNTIME_SNAPSHOT = `function snapshot() {
    const cc = globalThis.cc;
    if (!cc || cc.GAME_VIEW !== true) return { gameView: false };
    const director = cc && cc.director;
    const game = cc && cc.game;
    const scene = director && typeof director.getScene === 'function' && director.getScene();
    const scheduler = director && typeof director.getScheduler === 'function' && director.getScheduler();
    const frameCount = director && (typeof director.totalFrames === 'number' ? director.totalFrames : typeof director.getTotalFrames === 'function' ? director.getTotalFrames() : null);
    return { gameView: !!cc && cc.GAME_VIEW === true, sceneUuid: scene && scene.uuid,
        phase: globalThis.cce && globalThis.cce.PreviewPlay && globalThis.cce.PreviewPlay._state,
        paused: game && typeof game.isPaused === 'function' ? game.isPaused() : null,
        timeScale: scheduler && typeof scheduler.getTimeScale === 'function' ? scheduler.getTimeScale() : null,
        frameCount: typeof frameCount === 'number' ? frameCount : null };
}`;
const RUNTIME_INSPECTION = `(() => { ${RUNTIME_SNAPSHOT} return snapshot(); })()`;
const LIFECYCLE_DISPATCH = (enabled: boolean, expiresAt: number): string => `(() => {
    const views = [];
    function visit(root) {
        for (const element of root.querySelectorAll('*')) {
            if (element.tagName === 'ENGINE-VIEW' && element.previewClient && element.getClientRects().length) views.push(element);
            if (element.shadowRoot) visit(element.shadowRoot);
        }
    }
    visit(document);
    if (views.length !== 1 || views[0]._platform !== 'gameView') return false;
    const view = views[0];
    const client = view.previewClient;
    if (Date.now() >= ${expiresAt}) return false;
    // Acceptance only: lifecycle completion is verified by the caller from the renderer.
    if (typeof view.previewSetPlay === 'function') void view.previewSetPlay(${enabled ? 'true' : 'false'});
    else if (client && typeof client.previewSetPlay === 'function') void client.previewSetPlay(${enabled ? 'true' : 'false'});
    else return false;
    return true;
})()`;
const SET_TIME_SCALE = (scale: number, sceneUuid: string, expiresAt: number): string => `(() => {
    ${RUNTIME_SNAPSHOT}
    const before = snapshot();
    if (!before.gameView || before.sceneUuid !== ${JSON.stringify(sceneUuid)}) return { code: 'RUNTIME_TARGET_CHANGED', mutated: false };
    if (!['play', 'pause'].includes(before.phase) || typeof before.paused !== 'boolean' || before.paused !== (before.phase === 'pause')) return { code: 'RUNTIME_NOT_READY', mutated: false };
    const director = globalThis.cc.director;
    const scene = director.getScene();
    const scheduler = typeof director.getScheduler === 'function' && director.getScheduler();
    if (!scheduler || typeof scheduler.setTimeScale !== 'function' || typeof scheduler.getTimeScale !== 'function') return { code: 'UNSUPPORTED_RUNTIME_TRANSPORT', mutated: false };
    if (Date.now() >= ${expiresAt}) return { code: 'RUNTIME_STATE_TIMEOUT', mutated: false };
    scheduler.setTimeScale(${scale});
    const after = snapshot();
    if (director !== globalThis.cc.director || scene !== director.getScene() || scheduler !== director.getScheduler() || !after.gameView || after.sceneUuid !== before.sceneUuid) return { code: 'RUNTIME_TARGET_CHANGED', mutated: true };
    if (after.timeScale !== ${scale}) return { code: 'RUNTIME_CONTROL_UNAVAILABLE', mutated: true };
    return { mutated: true, state: after };
})()`;

function creatorMainWindow(electron: ElectronHost): { webContents: HostContents } {
    const windows = electron.BrowserWindow.getAllWindows().filter(({ webContents }) => {
        if (webContents.isDestroyed()) return false;
        try {
            const url = new URL(webContents.getURL());
            return url.protocol === 'file:' && url.pathname.replace(/\\/g, '/').endsWith('/@editor/creator/static/windows/main.html');
        } catch { return false; }
    });
    if (windows.length !== 1) throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_TRANSPORT', status: 422, message: 'Expected exactly one Creator project main window.' });
    return windows[0];
}

async function executeBounded(target: HostContents, source: string, deadline: number, mutation = false, maxWaitMs = RENDERER_TIMEOUT_MS): Promise<unknown> {
    if (Date.now() >= deadline) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Game-view operation deadline expired before dispatch.', ...(mutation ? { details: { mutationDispatched: false, outcome: 'refused', retrySafe: true } } : {}) });
    let timer: NodeJS.Timeout | undefined;
    let request: Promise<unknown> | undefined;
    try {
        request = target.executeJavaScript(source);
        return await Promise.race([request, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Game-view renderer operation exceeded its deadline.' })), Math.min(maxWaitMs, deadline - Date.now()));
        })]);
    } catch (error) {
        const failure = new ToolError({ code: error instanceof ToolError ? error.code : 'RUNTIME_CONTROL_UNAVAILABLE', status: 409,
            message: mutation ? 'Game-view mutation was dispatched but its outcome is unknown.' : 'Game-view renderer inspection did not complete.',
            details: { cause: (error instanceof Error ? error.message : String(error)).slice(0, 512), ...(mutation ? { mutationDispatched: true, outcome: 'unknown', retrySafe: false } : {}) },
            recovery: mutation ? 'Inspect the Game View before retrying; a queued renderer operation may still complete.' : 'Wait for the Game View renderer to respond, then inspect it again.' });
        if (mutation && request) Object.defineProperty(failure, 'pendingRequest', { value: (error instanceof ToolError ? (error as ToolError & { pendingRequest?: Promise<unknown> }).pendingRequest : undefined) ?? request });
        throw failure;
    } finally { clearTimeout(timer); }
}

async function readHost(main: HostContents, deadline: number): Promise<PreviewHost> {
    const candidates = await executeBounded(main, HOST_INSPECTION, deadline);
    if (!Array.isArray(candidates) || candidates.length !== 1) throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_TRANSPORT', status: 422, message: 'Expected exactly one visible Creator game-view host.' });
    const host = candidates[0] as Partial<PreviewHost> | null;
    if (!host || (typeof host.platform !== 'string' && !(host.platform == null && host.enabled === false && host.loaded === false)) || typeof host.enabled !== 'boolean' || typeof host.ready !== 'boolean' || typeof host.loaded !== 'boolean' || typeof host.failed !== 'boolean') {
        throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_TRANSPORT', status: 422, message: 'Creator game-view host shape differs from the 3.7.3 adapter.' });
    }
    return { ...host, platform: host.platform ?? '' } as PreviewHost;
}

function renderer(electron: ElectronHost, host: PreviewHost): HostContents {
    if (host.platform !== 'gameView' || !host.enabled || !host.ready || !host.loaded || host.failed || !Number.isSafeInteger(host.webContentsId)) throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'Game-view transport is not running and ready.' });
    const target = electron.webContents.fromId(host.webContentsId!);
    const previewUrl = target ? decodeURIComponent(target.getURL()).replace(/\\/g, '/') : '';
    if (!target || target.id !== host.webContentsId || target.isDestroyed() || target.getType() !== 'webview' || !/(?:^|[=/])preload\/(?:preview\/preload|web\/preview)\.js(?:$|[?#])/.test(previewUrl)) {
        throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_TRANSPORT', status: 422, message: 'Creator preview host does not identify its game-view renderer.' });
    }
    return target;
}

function assertHostUnchanged(electron: ElectronHost, host: PreviewHost, target: HostContents, url: string): void {
    if (host.platform !== 'gameView' || !host.enabled || !host.ready || !host.loaded || host.failed || host.webContentsId !== target.id || target.isDestroyed() || electron.webContents.fromId(target.id) !== target || target.getURL() !== url) {
        throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Game-view renderer changed during the operation.' });
    }
}

function runningState(host: PreviewHost, target: HostContents, value: unknown): GameViewRuntime {
    const state = value as Record<string, unknown> | null;
    if (!state || state.gameView !== true || !['play', 'pause'].includes(String(state.phase)) || typeof state.sceneUuid !== 'string' || !state.sceneUuid || typeof state.paused !== 'boolean' || state.paused !== (state.phase === 'pause')) {
        throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'Actual game-view phase and cc.game.isPaused do not identify a consistent running scene.' });
    }
    return { ...host, running: true, paused: state.paused, sceneUuid: state.sceneUuid, webContentsId: target.id,
        timeScale: typeof state.timeScale === 'number' && Number.isFinite(state.timeScale) ? state.timeScale : null,
        frameCount: typeof state.frameCount === 'number' && Number.isSafeInteger(state.frameCount) && state.frameCount >= 0 ? state.frameCount : null };
}

export async function dispatchGameViewLifecycle(enabled: boolean, deadline = Date.now() + OPERATION_TIMEOUT_MS): Promise<void> {
    if (typeof enabled !== 'boolean' || !Number.isFinite(deadline)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Lifecycle dispatch requires a boolean enabled value and finite deadline.' });
    deadline = Math.min(deadline, Date.now() + OPERATION_TIMEOUT_MS);
    const electron = require('electron') as ElectronHost;
    const expiresAt = Math.min(deadline, Date.now() + RENDERER_TIMEOUT_MS);
    const dispatched = await executeBounded(creatorMainWindow(electron).webContents, LIFECYCLE_DISPATCH(enabled, expiresAt), expiresAt, true);
    if (dispatched !== true) throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_TRANSPORT', status: 422, message: 'Creator game-view host did not accept the bounded lifecycle dispatch.', details: { mutationDispatched: false, outcome: 'refused', retrySafe: true } });
}

export async function inspectGameViewRuntime(): Promise<GameViewRuntime> {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    const electron = require('electron') as ElectronHost;
    const main = creatorMainWindow(electron).webContents;
    const host = await readHost(main, deadline);
    if (!host.enabled) return { ...host, running: false, paused: null, timeScale: null, frameCount: null, sceneUuid: '', webContentsId: null };
    const target = renderer(electron, host);
    const url = target.getURL();
    const state = runningState(host, target, await executeBounded(target, RUNTIME_INSPECTION, deadline));
    assertHostUnchanged(electron, await readHost(main, deadline), target, url);
    return state;
}

export async function setGameViewTimeScale(scale: number): Promise<GameViewRuntime> {
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0 || scale > 10) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Game-view time scale must be a finite number from 0 to 10.' });
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    const electron = require('electron') as ElectronHost;
    const main = creatorMainWindow(electron).webContents;
    const host = await readHost(main, deadline);
    const target = renderer(electron, host);
    const url = target.getURL();
    const before = runningState(host, target, await executeBounded(target, RUNTIME_INSPECTION, deadline));
    assertHostUnchanged(electron, await readHost(main, deadline), target, url);
    const expiresAt = Math.min(deadline, Date.now() + RENDERER_TIMEOUT_MS);
    const result = await executeBounded(target, SET_TIME_SCALE(scale, before.sceneUuid, expiresAt), expiresAt, true) as { code?: string; mutated?: boolean; state?: unknown } | null;
    if (!result || result.code || result.mutated !== true) throw new ToolError({ code: result?.code ?? 'RUNTIME_CONTROL_UNAVAILABLE', status: result?.code === 'UNSUPPORTED_RUNTIME_TRANSPORT' ? 422 : 409,
        message: result?.code === 'UNSUPPORTED_RUNTIME_TRANSPORT' ? 'Game-view scheduler does not expose both setTimeScale and getTimeScale.' : 'Game-view time scale operation could not verify its target and postcondition.',
        details: { mutationDispatched: result?.mutated !== false, outcome: result?.mutated === false ? 'refused' : 'unknown', retrySafe: result?.mutated === false }, recovery: 'Inspect the Game View before retrying.' });
    try {
        const mutationState = runningState(host, target, result.state);
        if (mutationState.sceneUuid !== before.sceneUuid || mutationState.timeScale !== scale) throw new ToolError({ code: 'RUNTIME_CONTROL_UNAVAILABLE', status: 409, message: 'Game-view mutation returned an inconsistent target or time scale.' });
        const afterHost = await readHost(main, deadline);
        assertHostUnchanged(electron, afterHost, target, url);
        const after = runningState(afterHost, target, await executeBounded(target, RUNTIME_INSPECTION, deadline));
        if (after.sceneUuid !== before.sceneUuid) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Game-view scene changed during time scale read-back.' });
        if (after.timeScale !== scale) throw new ToolError({ code: 'RUNTIME_CONTROL_UNAVAILABLE', status: 409, message: 'Game-view time scale did not match the requested value during read-back.' });
        assertHostUnchanged(electron, await readHost(main, deadline), target, url);
        return after;
    } catch (error) {
        throw new ToolError({ code: error instanceof ToolError ? error.code : 'RUNTIME_CONTROL_UNAVAILABLE', status: error instanceof ToolError ? error.status : 409,
            message: 'Game-view time scale was dispatched but complete read-back could not be verified.',
            details: { cause: (error instanceof Error ? error.message : String(error)).slice(0, 512), mutationDispatched: true, outcome: 'unknown', retrySafe: false }, recovery: 'Inspect the Game View and reconcile its time scale before retrying.' });
    }
}

/** Internal trusted scripts only. Public tools supply validated data, never caller code. */
export async function executeGameViewOperation(targetId: string, operationSource: string, timeoutMs = 5000, mutation = false, callerDeadline?: number, assertActive?: () => void): Promise<unknown> {
    if (typeof targetId !== 'string' || !targetId || targetId.length > 256 || typeof operationSource !== 'string' || Buffer.byteLength(operationSource, 'utf8') > 128 * 1024
        || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000 || callerDeadline !== undefined && !Number.isFinite(callerDeadline)) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Invalid bounded Game View operation.' });
    }
    const deadline = Math.min(Date.now() + timeoutMs, callerDeadline ?? Infinity);
    assertActive?.();
    const electron = require('electron') as ElectronHost;
    const main = creatorMainWindow(electron).webContents;
    const host = await readHost(main, deadline);
    const target = renderer(electron, host);
    const url = target.getURL();
    const before = runningState(host, target, await executeBounded(target, RUNTIME_INSPECTION, deadline));
    if (before.sceneUuid !== targetId) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Game View scene differs from the bound session.' });
    assertHostUnchanged(electron, await readHost(main, deadline), target, url);
    assertActive?.();
    const source = `(async () => { const scene = globalThis.cc?.director?.getScene(); if (globalThis.cc?.GAME_VIEW !== true || !scene || scene.uuid !== ${JSON.stringify(targetId)} || Date.now() >= ${deadline}) throw new Error('Game View target/deadline changed before operation'); const result = await (${operationSource}); if (scene !== globalThis.cc?.director?.getScene()) throw new Error('Game View target changed during operation'); return result; })()`;
    const result = await executeBounded(target, source, deadline, mutation, timeoutMs);
    try {
        const encoded = JSON.stringify(result);
        if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 256 * 1024) throw new ToolError({ code: 'RUNTIME_RESPONSE_LIMIT', status: 502, message: 'Game View result is not bounded JSON.' });
        const afterHost = await readHost(main, deadline);
        assertHostUnchanged(electron, afterHost, target, url);
        const after = runningState(afterHost, target, await executeBounded(target, RUNTIME_INSPECTION, deadline));
        if (after.sceneUuid !== targetId) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Game View scene changed during read-back.' });
        return result;
    } catch (error) {
        if (!mutation) throw error;
        throw new ToolError({ code: error instanceof ToolError ? error.code : 'RUNTIME_CONTROL_UNAVAILABLE', status: 409, message: 'Game View mutation complete read-back is unconfirmed.', details: { mutationDispatched: true, retrySafe: false, outcome: 'unknown' }, recovery: 'Inspect the bound target before further control.' });
    }
}

/** Internal trusted scene-transition executor. Unlike ordinary mutations, the expected scene identity is allowed to change exactly once. */
export async function executeGameViewSceneTransition(targetId: string, operationSource: string, timeoutMs = 10000, callerDeadline?: number, assertActive?: () => void): Promise<unknown> {
    if (typeof targetId !== 'string' || !targetId || targetId.length > 256 || typeof operationSource !== 'string' || Buffer.byteLength(operationSource, 'utf8') > 128 * 1024
        || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000 || callerDeadline !== undefined && !Number.isFinite(callerDeadline)) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Invalid bounded Game View scene transition.' });
    }
    const deadline = Math.min(Date.now() + timeoutMs, callerDeadline ?? Infinity);
    assertActive?.();
    const electron = require('electron') as ElectronHost;
    const main = creatorMainWindow(electron).webContents;
    const host = await readHost(main, deadline);
    const target = renderer(electron, host);
    const url = target.getURL();
    const before = runningState(host, target, await executeBounded(target, RUNTIME_INSPECTION, deadline));
    if (before.sceneUuid !== targetId) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Game View scene differs from the bound session.' });
    assertHostUnchanged(electron, await readHost(main, deadline), target, url);
    assertActive?.();
    const source = `(async () => { const before = globalThis.cc?.director?.getScene(); if (globalThis.cc?.GAME_VIEW !== true || !before || before.uuid !== ${JSON.stringify(targetId)} || Date.now() >= ${deadline}) throw new Error('Game View target/deadline changed before scene transition'); const result = await (${operationSource}); const after = globalThis.cc?.director?.getScene(); if (!after || after === before || typeof after.uuid !== 'string' || !after.uuid) throw new Error('Scene transition did not produce a new runtime scene'); return { result, sceneUuid: after.uuid }; })()`;
    try {
        const result = await executeBounded(target, source, deadline, true, timeoutMs);
        const encoded = JSON.stringify(result);
        if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 256 * 1024) throw new ToolError({ code: 'RUNTIME_RESPONSE_LIMIT', status: 502, message: 'Game View scene transition result is not bounded JSON.' });
        const afterHost = await readHost(main, deadline);
        assertHostUnchanged(electron, afterHost, target, url);
        const after = runningState(afterHost, target, await executeBounded(target, RUNTIME_INSPECTION, deadline));
        if (after.sceneUuid === targetId) throw new ToolError({ code: 'SCENE_TRANSITION_UNCONFIRMED', status: 409, message: 'Game View remained on the original scene after transition.' });
        return { ...(result as Record<string, unknown>), targetId, previousSceneUuid: targetId, sceneUuid: after.sceneUuid, sessionInvalidated: true };
    } catch (error) {
        throw new ToolError({ code: error instanceof ToolError ? error.code : 'SCENE_TRANSITION_UNCONFIRMED', status: error instanceof ToolError ? error.status : 409, message: error instanceof ToolError ? error.message : 'Game View scene transition was dispatched but its new scene identity was not confirmed.', details: { mutationDispatched: true, retrySafe: false, outcome: 'unknown' }, recovery: 'Inspect the running Game View and attach a new runtime session before retrying.' });
    }
}
