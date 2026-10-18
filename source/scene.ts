import { buildUiAccessibilityAudit, UiAccessibilityAuditRequest } from './ui-accessibility-audit';
import { buildUiLayoutReport, LayoutReportRequest } from './ui-layout-report';
import { buildUiSafeAreaInspect, UiSafeAreaInspectRequest } from './ui-safe-area-inspect';
import { buildUiLayoutValidate, UiLayoutValidateRequest } from './ui-layout-validate';
import { buildUiLayoutInspectGeometry, UiLayoutGeometryRequest, UiLayoutGeometryResult } from './ui-layout-inspect';
import { executeAudioPlayback, AudioPlaybackRequest, AudioPlaybackResult, AudioRuntimeEngine } from './audio-playback';
import { inspectEngineClass } from './engine-api-availability';
import type { EngineClassRequest } from './engine-api-availability';
import { inspectRemovedPrefabIdentity } from './prefab-removed-inspect';
import { executeUiReflow } from './ui-reflow';
import type { UiReflowRequest, UiReflowEngine, UiReflowFacade } from './ui-reflow';
import { loadLocalizationRuntime } from './localization-runtime';
import { executeTerrainEdit } from './terrain-edit';
import type { TerrainEditRequest, TerrainEditResult, TerrainEngine, TerrainPersistence } from './terrain-edit';
import path from 'path';


export function load() { }
export function unload() {
    if (_loggingOwner && console.error === _loggingWrapper && _originalConsoleError) console.error = _originalConsoleError;
    _loggingOwner = null;
    _loggingWrapper = null;
    _originalConsoleError = null;
    _caughtLogs = [];
    void methods.stopCatchAll();
}
let _originalConsoleError: ((...data: unknown[]) => void) | null = null;
let _caughtLogs: string[] = [];
let _loggingOwner: string | null = null;
let _loggingWrapper: ((...data: unknown[]) => void) | null = null;

// Scene-console capture is opt-in and writes bounded JSONL in the current editor scope.
let _catchAllActive = false;
let _origLog: typeof console.log | null = null;
let _origWarn: typeof console.warn | null = null;
let _origErr: typeof console.error | null = null;
let _catchAllLog: typeof console.log | null = null;
let _catchAllWarn: typeof console.warn | null = null;
let _catchAllError: typeof console.error | null = null;
let _sceneLogFile: string | null = null;
const _sceneLogMaxBytes = 4 * 1024 * 1024;
const _sceneLogRetention = 4;

function _rotateSceneLog(fs: any): void {
    if (!_sceneLogFile) return;
    const base = _sceneLogFile.replace(/\.jsonl$/i, '');
    for (let index = _sceneLogRetention - 1; index >= 1; index -= 1) {
        const source = `${base}-${index}.jsonl`;
        const target = `${base}-${index + 1}.jsonl`;
        try { if (fs.existsSync(source)) { if (fs.existsSync(target)) fs.unlinkSync(target); fs.renameSync(source, target); } } catch {}
    }
    try { if (fs.existsSync(`${base}-1.jsonl`)) fs.unlinkSync(`${base}-1.jsonl`); fs.renameSync(_sceneLogFile, `${base}-1.jsonl`); } catch {}
}

function _serializeSceneValue(value: unknown): string {
    if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`;
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, (key, nested) => {
            const normalized = key.replace(/[^a-z0-9]/gi, '');
            if (/^(?:.*(?:password|passwd|passphrase|secret|token|credential|authorization|cookie|privatekey|apikey)|pwd|auth|sessionid)$/i.test(normalized)) return '[REDACTED]';
            return typeof nested === 'bigint' ? String(nested) : nested;
        }) ?? String(value);
    } catch { return '[unserializable value]'; }
}

function _writeSceneLog(level: 'log' | 'warn' | 'error', data: unknown[]): void {
    if (!_sceneLogFile) return;
    const msg = data.map(_serializeSceneValue).join(' ').slice(0, 32768);
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg }) + '\n';
    try {
        const fs = require('fs');
        if (fs.existsSync(_sceneLogFile) && fs.statSync(_sceneLogFile).size + Buffer.byteLength(line, 'utf8') > _sceneLogMaxBytes) _rotateSceneLog(fs);
        fs.appendFileSync(_sceneLogFile, line, 'utf8');
    } catch {}
}

function getSceneExecuteGlobals(): Record<string, any> {
    // Inject scene-renderer globals explicitly — new Function has no closure access.
    // `cc`/`cce`/`document` are reliably present in the editor scene; `require` is
    // guarded because fs may be unavailable in some scene sub-contexts.
    return {
        cc: (globalThis as any)['cc'],
        cce: (globalThis as any)['cce'],
        document,
        require: typeof require === 'function' ? require : undefined,
    };
}

export const methods = {
    async terrainHeightEdit(request: TerrainEditRequest): Promise<TerrainEditResult> {
        const globals = globalThis as unknown as { cc: TerrainEngine; cce: { Ipc: { send(message: string, ...args: unknown[]): Promise<unknown> }; SceneFacadeManager: { queryMode(): string } } };
        let manager: TerrainPersistence['manager'];
        try {
            // Creator's installed manager is the same serializer/source writer used by its terrain editor.
            const module = require(path.join(Editor.App.path, 'builtin', 'scene', 'dist', 'script', '3d', 'manager', 'terrain', 'index.ccc')) as { default: TerrainPersistence['manager'] };
            manager = module.default;
        } catch (error: unknown) {
            return { success: false, changed: false, verified: false, mutationStarted: false, nodeUuid: request?.nodeUuid, componentUuid: request?.componentUuid, assetUuid: request?.assetUuid, restoration: 'not-needed', error: { code: 'UNSUPPORTED_EDITOR_API', message: error instanceof Error ? error.message : String(error) } };
        }
        return executeTerrainEdit(request, globals.cc, methods.findRuntimeNodeUuid, {
            manager,
            queryMode: () => globals.cce.SceneFacadeManager.queryMode(),
            saveSource: (assetUuid, bytes) => globals.cce.Ipc.send('save-asset', assetUuid, bytes),
        });
    },

    async audioPlayback(request: AudioPlaybackRequest): Promise<AudioPlaybackResult> {
        // The scene renderer supplies the native engine; the adapter validates its runtime capabilities.
        const globals = globalThis as unknown as { cc: AudioRuntimeEngine };
        return executeAudioPlayback(request, globals.cc, methods.findRuntimeNodeUuid);
    },

    async startCatchLogging(owner: string, expiresAt: number): Promise<{ owner: string; active: true; expiresAt: number }> {
        if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(owner)) throw new Error('Logging capture requires a bounded owner token.');
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 10000) throw new Error('Logging setup deadline expired or is invalid.');
        if (_loggingOwner) throw new Error('Logging capture is already owned.');
        const original = console.error;
        const logs: string[] = [];
        const wrapper = (...data: unknown[]): void => {
            if (logs.length < 128) {
                try {
                    let message = '';
                    for (let index = 0; index < Math.min(data.length, 32) && message.length < 2048; index++) {
                        const argument = data[index];
                        const text = typeof argument === 'string' ? argument : argument instanceof Error ? '[Error]' : argument === null ? 'null' : typeof argument === 'number' || typeof argument === 'boolean' || typeof argument === 'undefined' ? String(argument) : '[non-scalar]';
                        if (index) message += ' ';
                        message += text.slice(0, 2048 - message.length);
                    }
                    logs.push(message);
                }
                catch { logs.push('[unprintable error]'); }
            }
            original(...data);
        };
        _caughtLogs = logs;
        _originalConsoleError = original;
        _loggingWrapper = wrapper;
        _loggingOwner = owner;
        console.error = wrapper;
        return { owner, active: true, expiresAt };
    },

    async inspectCatchLogging(owner: string): Promise<{ active: boolean; owned: boolean; handlerCurrent: boolean }> {
        if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(owner)) throw new Error('Logging inspection requires a bounded owner token.');
        return { active: _loggingOwner !== null, owned: _loggingOwner === owner, handlerCurrent: _loggingOwner !== null && console.error === _loggingWrapper };
    },

    async stopCatchLogging(owner: string): Promise<string[]> {
        if (!_loggingOwner) return [];
        if (_loggingOwner !== owner) throw new Error('Logging capture owner mismatch; collector was not changed.');
        if (console.error !== _loggingWrapper) throw new Error('Console error handler changed outside capture; restoration refused.');
        console.error = _originalConsoleError!;
        const logs = _caughtLogs;
        _caughtLogs = [];
        _originalConsoleError = null;
        _loggingWrapper = null;
        _loggingOwner = null;
        return logs;
    },

    async startCatchAll(instanceId?: unknown): Promise<boolean> {
        if (_loggingOwner) throw new Error('Cannot change console capture while an operation owns logging.');
        if (_catchAllActive) return true;
        let fs: any;
        try { fs = require('fs'); } catch {
            return false;
        }
        const path = require('path');
        const os = require('os');
        const safe = String(instanceId ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96) || 'unscoped';
        const dir = path.join(os.homedir(), '.utcp-debug', `instance-${safe}`);
        try { fs.mkdirSync(dir, { recursive: true }); } catch { return false; }
        _sceneLogFile = path.join(dir, `scene-console-${Date.now()}-${process.pid}.jsonl`);
        _catchAllActive = true;
        _origLog = console.log;
        _origWarn = console.warn;
        _origErr = console.error;
        const originalLog = console.log, originalWarn = console.warn, originalError = console.error;
        _catchAllLog = (...args: unknown[]) => { _writeSceneLog('log', args); originalLog(...args); };
        _catchAllWarn = (...args: unknown[]) => { _writeSceneLog('warn', args); originalWarn(...args); };
        _catchAllError = (...args: unknown[]) => { _writeSceneLog('error', args); originalError(...args); };
        console.log = _catchAllLog;
        console.warn = _catchAllWarn;
        console.error = _catchAllError;
        return true;
    },

    async stopCatchAll(): Promise<void> {
        if (_loggingOwner) throw new Error('Cannot stop console capture while an operation owns logging.');
        if (!_catchAllActive) return;
        if (_origLog && console.log === _catchAllLog) console.log = _origLog;
        if (_origWarn && console.warn === _catchAllWarn) console.warn = _origWarn;
        if (_origErr && console.error === _catchAllError) console.error = _origErr;
        _origLog = _origWarn = _origErr = null;
        _catchAllLog = _catchAllWarn = _catchAllError = null;
        _catchAllActive = false;
        _sceneLogFile = null;
    },

    async createPrefabFromNode(nodeUuid: string, path: string): Promise<string> {
        const cce = (globalThis as any)['cce'];
        
        if (!cce || !cce.Prefab || !cce.Prefab.createPrefabAssetFromNode) {
            throw new Error('CCE API not found');
        }

        return await cce.Prefab.createPrefabAssetFromNode(nodeUuid, path);
    },

    async applyPrefabByNode(nodeUuid: string): Promise<string | null> {
        try {
            const globals = globalThis as unknown as { cce?: { Prefab?: { applyPrefab?: (id: string) => Promise<unknown> } } };
            const apply = globals.cce?.Prefab?.applyPrefab;
            if (typeof apply !== 'function') throw new Error('CCE prefab apply API not found');
            const before = await methods.findRuntimeNodeUuid(nodeUuid);
            const assetId: unknown = before?._prefab?.asset?._uuid;
            if (typeof assetId !== 'string' || !before?._prefab?.instance) throw new Error('Target is not a linked prefab instance');
            // Creator 3.7.3 returns false even after successful apply and reload.
            // Its return value cannot distinguish success: verify the resulting instance instead.
            await apply.call(globals.cce!.Prefab, nodeUuid);
            const after = await methods.findRuntimeNodeUuid(nodeUuid);
            if (after?._prefab?.asset?._uuid !== assetId) throw new Error('Prefab identity changed during apply');
            const instance = after?._prefab?.instance;
            if (!instance) throw new Error('Prefab instance disappeared during apply');
            // Creator keeps these instance-root overrides on the instance after a successful
            // apply, so their presence is not evidence of a failed flush. `_lscale` behaves
            // exactly like the other transform fields (verified live on 3.7.3: `_lscale`
            // survives apply while a non-transform override such as `_active` is flushed).
            const reservedRootPaths: Record<string, true> = { _name: true, _lpos: true, _lrot: true, _euler: true, _lscale: true };
            for (const key of ['propertyOverrides', 'mountedChildren', 'mountedComponents', 'removedComponents']) {
                const remaining: unknown = instance[key];
                if (!Array.isArray(remaining)) throw new Error(`Prefab apply returned invalid ${key}`);
                const pending = key === 'propertyOverrides' ? remaining.filter((entry: unknown) => {
                    if (!entry || typeof entry !== 'object' || !('targetInfo' in entry) || !('propertyPath' in entry)) return true;
                    const target = entry.targetInfo;
                    const propertyPath = entry.propertyPath;
                    return !(target && typeof target === 'object' && 'localID' in target && Array.isArray(target.localID)
                        && target.localID.length === 1 && target.localID[0] === after._prefab.fileId
                        && Array.isArray(propertyPath) && propertyPath.length === 1 && Object.prototype.hasOwnProperty.call(reservedRootPaths, propertyPath[0]));
                }) : remaining;
                if (pending.length > 0) throw new Error(`Prefab apply left pending ${key}`);
            }
            return null;
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    },

    async unlinkPrefabByNode(nodeUuid: string, recursive: boolean): Promise<string | null> {
        try {
            const cce = (globalThis as any)['cce'];
            if (!cce || !cce.Prefab || !cce.Prefab.unWrapPrefabInstance) {
                throw new Error('CCE API not found');
            }

            const success: boolean = await cce.Prefab.unWrapPrefabInstance(nodeUuid, recursive);
            if (!success) {
                throw new Error('Failed to unlink prefab');
            } else {
                return null;
            }
        } catch (error) {
             return error instanceof Error ? error.message : String(error);
        }
    },

    async createOffscreenCanvas(width: number, height: number): Promise<HTMLCanvasElement> {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    },

    async captureScreenshot(
        imageSize: { width: number, height: number } = { width: 512, height: 512 },
        jpegQuality: number = 80,
        cameraPosition?: { x: number, y: number, z: number },
        targetPosition?: { x: number, y: number, z: number },
        orthographic: boolean = false,
        orthographicSize: number = 10
    ): Promise<string> {
        // A bare number (or any non-{width,height} shape) used to reach root.resize()
        // as undefined, producing a 0x0 canvas whose toDataURL() is the string
        // "data:," — which then shipped as a valid-looking but empty JPEG. Fail
        // loudly instead, and accept the square-size shorthand while we're here.
        if (typeof imageSize === 'number') {
            imageSize = { width: imageSize, height: imageSize };
        }
        const width = Math.floor(imageSize?.width ?? 0);
        const height = Math.floor(imageSize?.height ?? 0);
        if (!(width > 0) || !(height > 0)) {
            throw new Error(`captureScreenshot: imageSize must be {width,height} with positive values, got ${JSON.stringify(imageSize)}`);
        }
        imageSize = { width, height };

        return new Promise((resolve, reject) => {
            const cce = (globalThis as any)['cce'];
            const cc = (globalThis as any)['cc'];

            let prevWidth: number;
            let prevHeight: number;

            // Optional: Save camera state
            let prevCamPos: any;
            let prevCamRot: any;
            let prevProjection: number;
            let prevOrthoSize: number;
            
            // Apply Camera Changes
            try {
                if (cce && cce.Camera && cce.Camera.camera) {
                    const camNode = cce.Camera.camera.node;

                    if (camNode) {
                        prevCamPos = camNode.position.clone();
                        prevCamRot = camNode.rotation.clone();
                        prevProjection = cce.Camera.camera.projection;
                        prevOrthoSize = cce.Camera.camera.orthoSize;

                        cce.Camera.camera.projection = orthographic ? 
                            cc.Camera.ProjectionType.ORTHO : cc.Camera.ProjectionType.PERSPECTIVE;

                        if (orthographic) {
                            cce.Camera.camera.orthoSize = orthographicSize;
                        }

                        if (cameraPosition) {
                            camNode.setPosition(new cc.Vec3(cameraPosition.x ?? 0, cameraPosition.y ?? 0, cameraPosition.z ?? 0));
                        }
                        if (targetPosition) {
                            camNode.lookAt(new cc.Vec3(targetPosition.x ?? 0, targetPosition.y ?? 0, targetPosition.z ?? 0));
                        }
                        
                        if (cce.Camera.refresh) cce.Camera.refresh();
                    }
                }
            } catch (e) {
                console.warn("[captureScreenshot] Failed to modify camera:", e);
            }

            if (cc.director && cc.director.root) {
                prevWidth = cc.director.root.mainWindow?.width || 0;
                prevHeight = cc.director.root.mainWindow?.height || 0;
                cc.director.root.resize(imageSize.width, imageSize.height);
            } else {
                return reject(new Error("cc.game.canvas not found or is not an HTMLCanvasElement"));
            }
            
            try {
                if (cce && cce.Engine) {
                    cce.Engine.repaintInEditMode();
                }
            } catch (e) { console.warn("Failed to repaintInEditMode:", e); }

            cc.director.once(cc.Director.EVENT_AFTER_RENDER, () => {
                try {
                    if (cc.game && cc.game.canvas && (cc.game.canvas instanceof HTMLCanvasElement)) {
                        const dataURL = cc.game.canvas.toDataURL('image/jpeg', jpegQuality / 100);
                        const base64 = dataURL.replace(/^data:image\/\w+;base64,/, '');
                        resolve(base64);
                    } else {
                        reject(new Error("cc.game.canvas not found or is not an HTMLCanvasElement"));
                    }
                } catch (error: any) {
                     reject(new Error(error.message || String(error)));
                } finally {
                    // Restore previous size
                    if (cc.director && cc.director.root) {
                        cc.director.root.resize(prevWidth, prevHeight);
                    }
                    // Restore camera
                    setTimeout(() => {
                        if (cce && cce.Camera && cce.Camera.camera && cce.Camera.camera.node) {
                            if (prevCamPos) cce.Camera.camera.node.setPosition(prevCamPos);
                            if (prevCamRot) cce.Camera.camera.node.setRotation(prevCamRot);
                            if (prevProjection !== undefined) cce.Camera.camera.projection = prevProjection;
                            if (prevOrthoSize !== undefined) cce.Camera.camera.orthoSize = prevOrthoSize;
                            if (cce.Camera.refresh) cce.Camera.refresh();
                        }
                    }, 50);
                }
            });
        });
    },

    async runCode(code: string, args?: any): Promise<any> {
        // Generic JS execution escape hatch in the scene renderer. Globals are injected
        // explicitly and kept in getSceneExecuteGlobals so future globals are a one-line
        // add. Uses an async wrapper so the agent can `await` and `return <expr>`.
        const globals = getSceneExecuteGlobals();
        const names = Object.keys(globals);
        const values = Object.values(globals);
        const fn = new Function('args', ...names, `return (async () => { ${code} })();`) as (...v: any[]) => Promise<any>;
        const result = await fn(args ?? {}, ...values);
        if (result === undefined || result === null) return null;
        // Coerce to JSON-safe BEFORE crossing IPC: the Editor.Message transport
        // JSON-serializes this return value in the scene process, so a circular
        // object or live cc.Node would throw "Converting circular structure to JSON"
        // where the editor-side serializeGuard cannot intercept it. Mirror that guard
        // here so scene-context returns are as safe as editor-context returns.
        try {
            JSON.stringify(result);
            return result; // already serializable — skip the extra round-trip
        } catch {
            const seen = new WeakSet();
            try {
                return JSON.parse(JSON.stringify(result, (_key, val) => {
                    if (typeof val === 'function' || typeof val === 'bigint' || typeof val === 'symbol') return undefined;
                    if (val && typeof val === 'object') {
                        if (seen.has(val)) return undefined; // circular
                        seen.add(val);
                    }
                    return val;
                }));
            } catch {
                return null; // pathologically non-serializable — fail soft, not crash
            }
        }
    },


    // Finds a live runtime node by uuid in the editor scene graph. The scene panel
    // runs the full engine, so cc.director.getScene() holds real cc.Node instances
    // (distinct from the editor-side dump returned by query-node).
    async findRuntimeNodeUuid(nodeUuid: string): Promise<any | null> {
        const cc = (globalThis as any)['cc'];
        const scene = cc?.director?.getScene?.();
        if (!scene) return null;
        const stack: any[] = [scene];
        const visitedNodes = new Set<any>();
        while (stack.length) {
            const node = stack.pop();
            if (!node || visitedNodes.has(node)) continue;
            visitedNodes.add(node);
            if (node.uuid === nodeUuid) return node;
            for (const child of node.children || []) {
                if (child && !visitedNodes.has(child)) stack.push(child);
            }
        }
        return null;
    },

    async animationUsageAnalyze(request: { nodeUuid?: string, maxNodes?: number } = {}): Promise<Record<string, unknown>> {
        const cc = (globalThis as any)['cc'];
        const root = request.nodeUuid ? await methods.findRuntimeNodeUuid(request.nodeUuid) : cc?.director?.getScene?.();
        if (!root) throw new Error('Animation usage analysis target scene or node was not found');
        const maxNodes = Number.isInteger(request.maxNodes) ? Math.max(1, Math.min(request.maxNodes!, 200)) : 100;
        const findings: Array<Record<string, unknown>> = [];
        const stack: any[] = [root];
        let visited = 0;
        while (stack.length && visited < maxNodes) {
            const node = stack.pop();
            visited++;
            const components = Array.isArray(node?.components) ? node.components : [];
            for (const component of components) {
                const className = String(component?.constructor?.name ?? component?._$erialized?.type ?? '');
                const isAnimation = className === 'Animation' || className === 'cc.Animation' || className === 'SkeletalAnimation' || className === 'cc.SkeletalAnimation';
                const isSpine = className === 'Skeleton' || className === 'sp.Skeleton';
                const isDragonBones = className === 'ArmatureDisplay' || className === 'dragonBones.ArmatureDisplay';
                if (!isAnimation && !isSpine && !isDragonBones) continue;
                const clips = Array.isArray(component.clips) ? component.clips.filter(Boolean).slice(0, 50).map((clip: any) => ({
                    uuid: clip?.uuid ?? null, name: clip?.name ?? null, duration: typeof clip?.duration === 'number' ? clip.duration : null,
                    sample: typeof clip?.sample === 'number' ? clip.sample : null,
                })) : [];
                const skeletonData = component?.skeletonData;
                const runtimeData = typeof skeletonData?.getRuntimeData === 'function' ? skeletonData.getRuntimeData() : skeletonData?.runtimeData;
                const spineAnimations = isSpine && runtimeData?.animations && typeof runtimeData.animations === 'object'
                    ? Object.values(runtimeData.animations).slice(0, 50).map((animation: any) => ({
                        name: animation?.name ?? null,
                        duration: typeof animation?.duration === 'number' ? animation.duration : null,
                    }))
                    : [];
                const catalog = clips.length > 0 ? clips : spineAnimations;
                const states = component._nameToState && typeof component._nameToState === 'object'
                    ? Object.keys(component._nameToState).slice(0, 50).map((name) => {
                        const state = component._nameToState[name];
                        return {
                            name,
                            playing: !!state?.isPlaying,
                            paused: !!state?.isPaused,
                            time: typeof state?.time === 'number' ? state.time : null,
                            speed: typeof state?.speed === 'number' ? state.speed : null,
                            weight: typeof state?.weight === 'number' ? state.weight : null,
                            delay: typeof state?.delay === 'number' ? state.delay : null,
                            playbackRange: state?.playbackRange && typeof state.playbackRange.min === 'number' && typeof state.playbackRange.max === 'number'
                                ? { min: state.playbackRange.min, max: state.playbackRange.max }
                                : null
                        };
                    })
                    : [];
                const cacheMode = component.cacheMode ?? component.defaultCacheMode ?? component._cacheMode ?? null;
                findings.push({
                    nodeUuid: node?.uuid ?? null,
                    nodeName: node?.name ?? null,
                    component: className,
                    clipCount: catalog.length,
                    clips: catalog,
                    defaultClip: component.defaultClip?.uuid ?? component.defaultClip?.name ?? component.defaultAnimation ?? null,
                    playOnLoad: typeof component.playOnLoad === 'boolean' ? component.playOnLoad : null,
                    stateCount: states.length,
                    states,
                    cacheMode,
                    cached: typeof component.isAnimationCached === 'function' ? !!component.isAnimationCached() : null,
                    recommendations: [
                        catalog.length > 0 && !component.defaultClip && !component.defaultAnimation ? 'Set a default clip or explicitly call play(name).' : null,
                        (isSpine || isDragonBones) && typeof component.isAnimationCached === 'function' && !component.isAnimationCached() ? 'Consider SHARED_CACHE or PRIVATE_CACHE for repeated deterministic playback; verify memory and dynamic-track tradeoffs.' : null,
                    ].filter(Boolean),
                });
            }
            for (const child of node?.children || []) stack.push(child);
        }
        return { nodeUuid: request.nodeUuid ?? root?.uuid ?? null, visitedNodes: visited, truncated: stack.length > 0, componentCount: findings.length, findings };
    },

    async spineSceneInspect(request: { nodeUuid?: string, maxItems?: number } = {}): Promise<Record<string, unknown>> {
        const root = request.nodeUuid ? await methods.findRuntimeNodeUuid(request.nodeUuid) : (globalThis as any).cc?.director?.getScene?.();
        if (!root) throw new Error('Spine scene inspection target was not found');
        const maxItems = Number.isInteger(request.maxItems) ? Math.max(1, Math.min(request.maxItems!, 1000)) : 200;
        const stack: any[] = [root];
        const visitedNodes = new Set<any>();
        const maxVisitedNodes = Math.min(100000, Math.max(maxItems, maxItems * 100));
        const findings: Record<string, unknown>[] = [];
        let truncated = false;
        const detailRemaining: Record<string, number> = { animations: maxItems, bones: maxItems, slots: maxItems, tracks: maxItems, sockets: maxItems };
        const takeDetails = <T>(category: string, values: unknown, map: (value: any, index: number) => T): T[] => {
            if (!Array.isArray(values)) return [];
            const count = Math.min(values.length, detailRemaining[category]);
            if (values.length > count) truncated = true;
            detailRemaining[category] -= count;
            return values.slice(0, count).map(map);
        };
        while (stack.length && findings.length < maxItems && visitedNodes.size < maxVisitedNodes) {
            const node = stack.pop();
            if (!node || visitedNodes.has(node)) continue;
            visitedNodes.add(node);
            const components = Array.isArray(node?.components) ? node.components : [];
            for (const component of components) {
                const className = String(component?.constructor?.name ?? '');
                if (className !== 'Skeleton' && className !== 'sp.Skeleton') continue;
                if (findings.length >= maxItems) {
                    truncated = true;
                    break;
                }
                const skeleton = component?._skeleton ?? component?.skeleton;
                const runtimeData = typeof component?.skeletonData?.getRuntimeData === 'function' ? component.skeletonData.getRuntimeData() : component?.skeletonData?.runtimeData;
                const animations = takeDetails('animations', runtimeData?.animations, (animation) => ({ name: animation?.name ?? null, duration: typeof animation?.duration === 'number' && Number.isFinite(animation.duration) ? animation.duration : null }));
                const bones = takeDetails('bones', skeleton?.bones, (bone) => ({ name: bone?.data?.name ?? bone?.name ?? null, parent: bone?.parent?.data?.name ?? bone?.parent?.name ?? null, x: typeof bone?.worldX === 'number' && Number.isFinite(bone.worldX) ? bone.worldX : null, y: typeof bone?.worldY === 'number' && Number.isFinite(bone.worldY) ? bone.worldY : null }));
                const slots = takeDetails('slots', skeleton?.slots, (slot) => ({ name: slot?.data?.name ?? slot?.name ?? null, bone: slot?.bone?.data?.name ?? slot?.bone?.name ?? null, attachment: slot?.attachment?.name ?? null, attachmentType: slot?.attachment?.constructor?.name ?? null }));
                const animationState = typeof component?.getState === 'function'
                    ? component.getState()
                    : typeof component?.getAnimationState === 'function'
                        ? component.getAnimationState()
                        : component?.animationState;
                const tracks = takeDetails('tracks', animationState?.tracks, (track, trackIndex) => ({
                    index: trackIndex,
                    animation: track?.animation?.name ?? null,
                    loop: typeof track?.loop === 'boolean' ? track.loop : null,
                    trackTime: typeof track?.trackTime === 'number' && Number.isFinite(track.trackTime) ? track.trackTime : null,
                    delay: typeof track?.delay === 'number' && Number.isFinite(track.delay) ? track.delay : null,
                    alpha: typeof track?.alpha === 'number' && Number.isFinite(track.alpha) ? track.alpha : null,
                }));
                const sockets = takeDetails('sockets', component?.sockets, (socket) => ({
                    name: socket?.name ?? socket?.path ?? null,
                    path: socket?.path ?? null,
                    bone: socket?.target?.data?.name ?? socket?.target?.name ?? null,
                }));
                findings.push({
                    node: { id: node?.uuid ?? null, name: node?.name ?? null },
                    component: className,
                    defaultAnimation: component?.defaultAnimation ?? null,
                    animation: component?.animation ?? null,
                    timeScale: typeof component?.timeScale === 'number' && Number.isFinite(component.timeScale) ? component.timeScale : null,
                    animations,
                    loop: typeof component?.loop === 'boolean' ? component.loop : null,
                    tracks,
                    bones,
                    slots,
                    sockets,
                    hasSkeletonData: !!component?.skeletonData,
                });
            }
            for (const child of node?.children || []) {
                if (child && !visitedNodes.has(child)) stack.push(child);
            }
        }
        if (visitedNodes.size >= maxVisitedNodes) truncated = true;
        return { nodeUuid: request.nodeUuid ?? root?.uuid ?? null, findings, total: findings.length, truncated: truncated || (findings.length >= maxItems && stack.length > 0) };
    },

    async animationRuntimeControl(request: {
        nodeUuid: string,
        operation: 'inspect' | 'play' | 'cross_fade' | 'pause' | 'resume' | 'stop' | 'set_default' | 'set_play_on_load' | 'set_state' | 'set_cache_mode' | 'invalidate_cache',
        clipName?: string,
        duration?: number,
        playOnLoad?: boolean,
        loop?: boolean,
        speed?: number,
        time?: number,
        repeatCount?: number,
        wrapMode?: number,
        weight?: number,
        delay?: number,
        playbackRange?: { min: number, max: number },
        cacheMode?: 'REALTIME' | 'SHARED_CACHE' | 'PRIVATE_CACHE',
    }): Promise<Record<string, unknown>> {
        const node = await methods.findRuntimeNodeUuid(request.nodeUuid);
        if (!node) throw new Error(`Runtime animation node ${request.nodeUuid} not found`);
        const components = Array.isArray(node.components) ? node.components : [];
        const animation = components.find((component: any) => ['Animation', 'cc.Animation', 'SkeletalAnimation', 'cc.SkeletalAnimation'].includes(String(component?.constructor?.name ?? '')));
        const animationClass = String(animation?.constructor?.name ?? '');
        const isSkeletalAnimation = animationClass === 'SkeletalAnimation' || animationClass === 'cc.SkeletalAnimation';
        const spine = components.find((component: any) => ['Skeleton', 'sp.Skeleton'].includes(String(component?.constructor?.name ?? '')));
        const dragonBones = components.find((component: any) => ['ArmatureDisplay', 'dragonBones.ArmatureDisplay'].includes(String(component?.constructor?.name ?? '')));
        const describe = (component: any): Record<string, unknown> => {
            const clips = Array.isArray(component?.clips) ? component.clips.filter(Boolean).slice(0, 50) : [];
            const states = typeof component?.getState === 'function'
                ? clips.map((clip: any) => {
                    const state = component.getState(clip?.name ?? clip?.uuid);
                    return state ? {
                        name: state.name ?? clip?.name ?? clip?.uuid ?? null,
                        isPlaying: typeof state.isPlaying === 'boolean' ? state.isPlaying : null,
                        isPaused: typeof state.isPaused === 'boolean' ? state.isPaused : null,
                        speed: typeof state.speed === 'number' ? state.speed : null,
                        time: typeof state.time === 'number' ? state.time : null,
                        repeatCount: typeof state.repeatCount === 'number' ? state.repeatCount : null,
                        wrapMode: typeof state.wrapMode === 'number' ? state.wrapMode : null,
                        weight: typeof state.weight === 'number' ? state.weight : null,
                        delay: typeof state.delay === 'number' ? state.delay : null,
                        playbackRange: state.playbackRange && typeof state.playbackRange.min === 'number' && typeof state.playbackRange.max === 'number'
                            ? { min: state.playbackRange.min, max: state.playbackRange.max }
                            : null,
                    } : null;
                }).filter(Boolean)
                : [];
            return {
                component: component?.constructor?.name ?? null,
                clips: clips.map((clip: any) => ({ uuid: clip?.uuid ?? null, name: clip?.name ?? null, duration: clip?.duration ?? null })),
                states,
                defaultClip: component?.defaultClip?.uuid ?? component?.defaultClip?.name ?? null,
                playOnLoad: typeof component?.playOnLoad === 'boolean' ? component.playOnLoad : null,
                cacheMode: component?.cacheMode ?? component?.defaultCacheMode ?? component?._cacheMode ?? null,
                cached: typeof component?.isAnimationCached === 'function' ? !!component.isAnimationCached() : null,
            };
        };
        if (request.operation === 'inspect') return { nodeUuid: request.nodeUuid, animation: animation ? describe(animation) : null, spine: spine ? describe(spine) : null, dragonBones: dragonBones ? describe(dragonBones) : null };
        if (animation) {
            const name = request.clipName;
            if (request.operation === 'set_state' && isSkeletalAnimation) {
                throw new Error('AnimationState field control is unavailable on SkeletalAnimation; use play, pause, resume, or stop.');
            }
            if (request.operation === 'play') {
                if (typeof animation.play !== 'function') throw new Error('Skeletal playback API is unavailable');
                animation.play(name);
            } else if (request.operation === 'cross_fade') {
                if (!name) throw new Error('cross_fade requires clipName');
                if (typeof animation.crossFade !== 'function') throw new Error('Animation cross-fade API is unavailable');
                animation.crossFade(name, request.duration ?? 0.3);
            } else if (request.operation === 'pause') {
                if (typeof animation.pause !== 'function') throw new Error('Animation pause API is unavailable');
                animation.pause();
            } else if (request.operation === 'resume') {
                if (typeof animation.resume !== 'function') throw new Error('Animation resume API is unavailable');
                animation.resume();
            } else if (request.operation === 'stop') {
                if (typeof animation.stop !== 'function') throw new Error('Animation stop API is unavailable');
                animation.stop();
            } else if (request.operation === 'set_default') {
                if (!name) throw new Error('set_default requires clipName');
                const clip = (animation.clips || []).find((candidate: any) => candidate?.name === name || candidate?.uuid === name);
                if (!clip) throw new Error(`Animation clip '${name}' was not found`);
                animation.defaultClip = clip;
            } else if (request.operation === 'set_play_on_load') {
                if (typeof request.playOnLoad !== 'boolean') throw new Error('set_play_on_load requires playOnLoad');
                animation.playOnLoad = request.playOnLoad;
            } else if (request.operation === 'set_state') {
                if (!name) throw new Error('set_state requires clipName');
                const state = animation.getState(name);
                if (!state) throw new Error(`Animation state '${name}' was not found`);
                if (request.speed !== undefined) state.speed = request.speed;
                if (request.time !== undefined) state.time = request.time;
                if (request.repeatCount !== undefined) state.repeatCount = request.repeatCount;
                if (request.wrapMode !== undefined) state.wrapMode = request.wrapMode;
                if (request.weight !== undefined) state.weight = request.weight;
                if (request.delay !== undefined) state.delay = request.delay;
                if (request.playbackRange !== undefined) state.playbackRange = request.playbackRange;
                const same = (actual: unknown, expected: number): boolean => typeof actual === 'number' && Math.abs(actual - expected) <= 1e-6;
                if (request.speed !== undefined && !same(state.speed, request.speed)) throw new Error(`Animation state '${name}' speed read-back mismatch`);
                if (request.time !== undefined && !same(state.time, request.time)) throw new Error(`Animation state '${name}' time read-back mismatch`);
                if (request.repeatCount !== undefined && !same(state.repeatCount, request.repeatCount)) throw new Error(`Animation state '${name}' repeatCount read-back mismatch`);
                if (request.wrapMode !== undefined && state.wrapMode !== request.wrapMode) throw new Error(`Animation state '${name}' wrapMode read-back mismatch`);
                if (request.weight !== undefined && !same(state.weight, request.weight)) throw new Error(`Animation state '${name}' weight read-back mismatch`);
                if (request.delay !== undefined && !same(state.delay, request.delay)) throw new Error(`Animation state '${name}' delay read-back mismatch`);
                if (request.playbackRange !== undefined && (!state.playbackRange || !same(state.playbackRange.min, request.playbackRange.min) || !same(state.playbackRange.max, request.playbackRange.max))) throw new Error(`Animation state '${name}' playbackRange read-back mismatch`);
            } else if (request.operation !== 'set_cache_mode' && request.operation !== 'invalidate_cache') {
                throw new Error(`Unsupported animation operation '${request.operation}'`);
            }
        }
        if (!animation && request.operation !== 'set_cache_mode' && request.operation !== 'invalidate_cache') {
            const name = request.clipName;
            const skeletalTarget = spine || dragonBones;
            if (!skeletalTarget) throw new Error('No Animation, SkeletalAnimation, Spine, or DragonBones component found');
            if (request.operation === 'play') {
                if (!name) throw new Error('play requires clipName for Spine or DragonBones');
                if (spine && typeof spine.setAnimation === 'function') spine.setAnimation(0, name, request.loop ?? false);
                else if (dragonBones && typeof dragonBones.playAnimation === 'function') dragonBones.playAnimation(name, request.loop ? 0 : 1);
                else throw new Error('Skeletal playback API is unavailable');
            } else if (request.operation === 'pause') {
                if (spine) spine.paused = true;
                else dragonBones.timeScale = 0;
            } else if (request.operation === 'resume') {
                if (spine) spine.paused = false;
                else dragonBones.timeScale = 1;
            } else if (request.operation === 'stop') {
                if (spine && typeof spine.clearTracks === 'function') spine.clearTracks();
                else {
                    const armature = dragonBones?.armature?.();
                    if (typeof armature?.animation?.stop === 'function') armature.animation.stop();
                    else throw new Error('Skeletal stop API is unavailable');
                }
            } else {
                throw new Error(`Operation '${request.operation}' requires an Animation or SkeletalAnimation component`);
            }
        }
        const cacheTarget = spine || dragonBones;
        if (request.operation === 'set_cache_mode' || request.operation === 'invalidate_cache') {
            if (!cacheTarget) throw new Error('No Spine or DragonBones animation component found for cache operation');
            if (request.operation === 'set_cache_mode') {
                if (!request.cacheMode) throw new Error('set_cache_mode requires cacheMode');
                const enumObject = cacheTarget.constructor?.AnimationCacheMode
                    ?? (globalThis as any).sp?.Skeleton?.AnimationCacheMode
                    ?? (globalThis as any).dragonBones?.ArmatureDisplay?.AnimationCacheMode;
                const fallbackModes = { REALTIME: 0, SHARED_CACHE: 1, PRIVATE_CACHE: 2 } as const;
                const enumValue = enumObject?.[request.cacheMode];
                const mode = typeof enumValue === 'number' ? enumValue : fallbackModes[request.cacheMode];
                if (typeof cacheTarget.setAnimationCacheMode !== 'function') throw new Error('Animation cache mode is unavailable on this component');
                cacheTarget.setAnimationCacheMode(mode);
                const readBack = cacheTarget.cacheMode ?? cacheTarget.defaultCacheMode ?? cacheTarget._cacheMode;
                if (readBack !== mode) throw new Error(`Animation cache mode read-back mismatch: expected ${mode}, got ${String(readBack)}`);
            } else {
                if (typeof cacheTarget.invalidAnimationCache !== 'function') throw new Error('Animation cache invalidation is unavailable on this component');
                cacheTarget.invalidAnimationCache();
            }
        }
        return { nodeUuid: request.nodeUuid, operation: request.operation, animation: animation ? describe(animation) : null, spine: spine ? describe(spine) : null, dragonBones: dragonBones ? describe(dragonBones) : null };
    },

    async spineRuntimeControl(request: {
        nodeUuid: string,
        operation: 'inspect' | 'set_skin' | 'set_attachment' | 'queue_animation' | 'clear_track' | 'clear_tracks' | 'set_time_scale' | 'set_mix',
        skinName?: string,
        slotName?: string,
        attachmentName?: string | null,
        clipName?: string,
        trackIndex?: number,
        loop?: boolean,
        delay?: number,
        timeScale?: number,
        fromAnimation?: string,
        toAnimation?: string,
        duration?: number,
    }): Promise<Record<string, unknown>> {
        const node = await methods.findRuntimeNodeUuid(request.nodeUuid);
        if (!node) throw new Error(`Runtime Spine node ${request.nodeUuid} not found`);
        const components = Array.isArray(node.components) ? node.components : [];
        const spine: any = components.find((component: any) => ['Skeleton', 'sp.Skeleton'].includes(String(component?.constructor?.name ?? '')));
        if (!spine) throw new Error('No Spine Skeleton component found');
        const state = typeof spine.getState === 'function' ? spine.getState() : spine.animationState;
        const describe = () => ({
            component: spine.constructor?.name ?? null,
            skin: spine._skeleton?.skin?.data?.name ?? spine._skeleton?.skin?.name ?? null,
            animation: spine.animation ?? null,
            timeScale: typeof spine.timeScale === 'number' ? spine.timeScale : null,
            tracks: Array.isArray(state?.tracks) ? state.tracks.slice(0, 100).map((track: any, index: number) => ({
                index,
                animation: track?.animation?.name ?? null,
                loop: typeof track?.loop === 'boolean' ? track.loop : null,
                trackTime: typeof track?.trackTime === 'number' ? track.trackTime : null,
                delay: typeof track?.delay === 'number' ? track.delay : null,
                alpha: typeof track?.alpha === 'number' ? track.alpha : null,
            })) : [],
        });
        if (request.operation === 'inspect') return { nodeUuid: request.nodeUuid, spine: describe() };
        const trackIndex = request.trackIndex ?? 0;
        if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex > 31) throw new Error('trackIndex must be an integer from 0 to 31');
        if (request.operation === 'set_skin') {
            if (!request.skinName) throw new Error('set_skin requires skinName');
            if (typeof spine.setSkin !== 'function') throw new Error('Spine setSkin API is unavailable');
            spine.setSkin(request.skinName);
            if (typeof spine._skeleton?.setSlotsToSetupPose === 'function') spine._skeleton.setSlotsToSetupPose();
        } else if (request.operation === 'set_attachment') {
            if (!request.slotName) throw new Error('set_attachment requires slotName');
            if (typeof spine.setAttachment !== 'function') throw new Error('Spine setAttachment API is unavailable');
            spine.setAttachment(request.slotName, request.attachmentName ?? null);
        } else if (request.operation === 'queue_animation') {
            if (!request.clipName) throw new Error('queue_animation requires clipName');
            if (typeof state?.addAnimation !== 'function') throw new Error('Spine addAnimation API is unavailable');
            state.addAnimation(trackIndex, request.clipName, request.loop ?? false, request.delay ?? 0);
        } else if (request.operation === 'clear_track') {
            if (typeof state?.clearTrack !== 'function') throw new Error('Spine clearTrack API is unavailable');
            state.clearTrack(trackIndex);
        } else if (request.operation === 'clear_tracks') {
            if (typeof state?.clearTracks !== 'function') throw new Error('Spine clearTracks API is unavailable');
            state.clearTracks();
        } else if (request.operation === 'set_time_scale') {
            if (typeof request.timeScale !== 'number' || !Number.isFinite(request.timeScale) || request.timeScale < 0 || request.timeScale > 100) throw new Error('timeScale must be a finite number from 0 to 100');
            spine.timeScale = request.timeScale;
        } else if (request.operation === 'set_mix') {
            if (!request.fromAnimation || !request.toAnimation || typeof request.duration !== 'number' || !Number.isFinite(request.duration) || request.duration < 0 || request.duration > 60) throw new Error('set_mix requires fromAnimation, toAnimation, and duration from 0 to 60');
            if (typeof spine.setMix !== 'function') throw new Error('Spine setMix API is unavailable');
            spine.setMix(request.fromAnimation, request.toAnimation, request.duration);
        } else {
            throw new Error(`Unsupported Spine runtime operation '${request.operation}'`);
        }
        return { nodeUuid: request.nodeUuid, operation: request.operation, spine: describe() };
    },
    async spineSocketConfigure(request: {
        nodeUuid: string,
        sockets: Array<{ path: string, targetUuid: string }>,
    }): Promise<Record<string, unknown>> {
        const node = await methods.findRuntimeNodeUuid(request.nodeUuid);
        if (!node) throw new Error(`Runtime Spine node ${request.nodeUuid} not found`);
        const components = Array.isArray(node.components) ? node.components : [];
        const spine: any = components.find((component: any) => ['Skeleton', 'sp.Skeleton'].includes(String(component?.constructor?.name ?? '')));
        if (!spine) throw new Error('No Spine Skeleton component found');
        const sockets: any[] = [];
        for (const entry of request.sockets) {
            if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) throw new Error('Each Spine socket requires a non-empty path');
            const target = await methods.findRuntimeNodeUuid(entry.targetUuid);
            if (!target) throw new Error(`Spine socket target node ${entry.targetUuid} not found`);
            sockets.push({ path: entry.path, target });
        }

        // Use Creator's serialized component-property path rather than assigning the
        // runtime accessor directly. This preserves scene serialization and history.
        const nodeDump = await (globalThis as any).Editor.Message.request('scene', 'query-node', request.nodeUuid);
        const componentIndex = nodeDump?.__comps__?.findIndex((component: any) =>
            component?.value?.uuid?.value === spine.uuid);
        if (!Number.isInteger(componentIndex) || componentIndex < 0) throw new Error('Spine component is missing from the serialized scene node');
        const componentDump = await (globalThis as any).Editor.Message.request('scene', 'query-component', spine.uuid);
        const socketProperty = componentDump?.value?.sockets;
        const elementTemplate = socketProperty?.elementTypeData;
        if (!socketProperty || !elementTemplate) throw new Error('Creator returned no serialized Spine socket schema');
        const serializedSockets = sockets.map((socket) => {
            const element = JSON.parse(JSON.stringify(elementTemplate));
            element.value.path.value = socket.path;
            element.value.target.value = { uuid: socket.target.uuid };
            return element;
        });

        await (globalThis as any).Editor.Message.request('scene', 'snapshot');
        const applied = await (globalThis as any).Editor.Message.request('scene', 'set-property', {
            uuid: request.nodeUuid,
            path: `__comps__.${componentIndex}.sockets`,
            dump: { value: serializedSockets, type: socketProperty.type },
        });
        if (applied === false) throw new Error('Creator refused serialized Spine socket assignment');
        return {
            nodeUuid: request.nodeUuid,
            socketCount: sockets.length,
            sockets: sockets.map((socket: any) => ({
                path: socket?.path ?? null,
                targetUuid: socket?.target?.uuid ?? null,
            })),
        };
    },


    async animationCatalogInspect(request: { nodeUuid?: string, maxItems?: number } = {}): Promise<Record<string, unknown>> {
        const root = request.nodeUuid ? await methods.findRuntimeNodeUuid(request.nodeUuid) : (globalThis as any).cc?.director?.getScene?.();
        if (!root) throw new Error('Animation catalog target was not found');
        const maxItems = Number.isInteger(request.maxItems) ? Math.max(1, Math.min(request.maxItems!, 1000)) : 200;
        const findings: Record<string, unknown>[] = [];
        const stack: any[] = [root];
        const visitedNodes = new Set<any>();
        const maxVisitedNodes = Math.min(100000, Math.max(maxItems, maxItems * 100));
        while (stack.length && findings.length < maxItems && visitedNodes.size < maxVisitedNodes) {
            const node = stack.pop();
            if (!node || visitedNodes.has(node)) continue;
            visitedNodes.add(node);
            for (const component of Array.isArray(node?.components) ? node.components : []) {
                const className = String(component?.constructor?.name ?? '');
                const isAnimation = ['Animation', 'cc.Animation', 'SkeletalAnimation', 'cc.SkeletalAnimation'].includes(className);
                const isSpine = ['Skeleton', 'sp.Skeleton'].includes(className);
                const isDragonBones = ['ArmatureDisplay', 'dragonBones.ArmatureDisplay'].includes(className);
                if (!isAnimation && !isSpine && !isDragonBones) continue;
                const animations: Record<string, unknown>[] = [];
                let totalAnimations = 0;
                for (const clip of Array.isArray(component?.clips) ? component.clips : []) {
                    if (!clip) continue;
                    totalAnimations++;
                    if (animations.length >= maxItems) continue;
                    animations.push({
                        name: clip.name ?? null, uuid: clip.uuid ?? null,
                        duration: typeof clip.duration === 'number' && Number.isFinite(clip.duration) ? clip.duration : null,
                        source: 'clip',
                    });
                }
                if (isSpine && totalAnimations === 0) {
                    const runtimeData = typeof component?.skeletonData?.getRuntimeData === 'function'
                        ? component.skeletonData.getRuntimeData() : component?.skeletonData?.runtimeData;
                    const entries = runtimeData?.animations;
                    if (entries && typeof entries === 'object') {
                        for (const key in entries) {
                            if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
                            totalAnimations++;
                            if (animations.length >= maxItems) continue;
                            const animation = entries[key];
                            animations.push({
                                name: animation?.name ?? null, uuid: null,
                                duration: typeof animation?.duration === 'number' && Number.isFinite(animation.duration) ? animation.duration : null,
                                source: 'spine-runtime',
                            });
                        }
                    }
                }
                findings.push({
                    node: { id: node?.uuid ?? null, name: node?.name ?? null },
                    component: className,
                    animations,
                    totalAnimations,
                    truncated: totalAnimations > animations.length,
                });
                if (findings.length >= maxItems) break;
            }
            for (const child of node?.children || []) {
                if (child && !visitedNodes.has(child)) stack.push(child);
            }
        }
        return { nodeUuid: request.nodeUuid ?? root?.uuid ?? null, findings, total: findings.length, truncated: stack.length > 0 || findings.length >= maxItems };
    },
    async animationClipAssign(request: { nodeUuid: string, clipUuid: string, clipName?: string }): Promise<Record<string, unknown>> {
        if (typeof request?.nodeUuid !== 'string' || !request.nodeUuid) throw new Error('nodeUuid is required');
        if (typeof request?.clipUuid !== 'string' || !request.clipUuid) throw new Error('clipUuid is required');
        const node = await methods.findRuntimeNodeUuid(request.nodeUuid);
        if (!node) throw new Error(`Animation node ${request.nodeUuid} not found`);
        const animation: any = (Array.isArray(node.components) ? node.components : []).find((component: any) =>
            ['Animation', 'cc.Animation'].includes(String(component?.constructor?.name ?? '')));
        if (!animation) throw new Error('No cc.Animation component found');
        const animationUuid = animation.uuid;
        const requireCurrentTarget = async () => {
            const currentNode = await methods.findRuntimeNodeUuid(request.nodeUuid);
            if (currentNode !== node || !Array.isArray(currentNode?.components) || !currentNode.components.includes(animation) || animation.uuid !== animationUuid) {
                throw new Error('Animation assignment target changed; inspect the node before retrying');
            }
        };
        let clip: any = (Array.isArray(animation.clips) ? animation.clips : []).find((candidate: any) => candidate?.uuid === request.clipUuid);
        if (!clip) {
            const assets = (globalThis as any).cc?.assetManager?.assets;
            clip = typeof assets?.get === 'function' ? assets.get(request.clipUuid) : null;
        }
        if (!clip && typeof (globalThis as any).cc?.assetManager?.loadAny === 'function') {
            clip = await new Promise((resolve, reject) => {
                (globalThis as any).cc.assetManager.loadAny({ uuid: request.clipUuid }, (error: unknown, asset: unknown) => error ? reject(error) : resolve(asset));
            });
        }
        if (!clip || typeof clip !== 'object') throw new Error(`AnimationClip ${request.clipUuid} could not be loaded`);
        if (clip.uuid !== request.clipUuid) throw new Error('Loaded AnimationClip identity does not match the requested UUID');
        const AnimationClip = (globalThis as any).cc?.AnimationClip;
        if (typeof AnimationClip !== 'function' || !(clip instanceof AnimationClip)) throw new Error('Loaded asset cannot be verified as a native AnimationClip');
        const nodeDump = await (globalThis as any).Editor.Message.request('scene', 'query-node', request.nodeUuid);
        const componentIndex = nodeDump?.__comps__?.findIndex((component: any) =>
            component?.value?.uuid?.value === animation.uuid);
        if (!animation.uuid || !Number.isInteger(componentIndex) || componentIndex < 0) throw new Error('Animation component is missing from the serialized scene node');
        const previousClips = Array.isArray(animation.clips) ? animation.clips.slice() : [];
        const previousClipUuids = previousClips.map((candidate: any) => candidate?.uuid ?? null);
        const nextClips = previousClips.slice();
        if (!nextClips.some((candidate: any) => candidate?.uuid === request.clipUuid)) nextClips.push(clip);
        const expectedClipUuids = nextClips.map((candidate: any) => candidate?.uuid ?? null);
        const clipName = typeof request.clipName === 'string' && request.clipName ? request.clipName : (clip.name ?? request.clipUuid);
        const serialized = await (globalThis as any).Editor.Message.request('scene', 'query-component', animation.uuid);
        const clipsProperty = serialized?.value?.clips;
        if (!clipsProperty?.elementTypeData) throw new Error('Animation clip serialization metadata is unavailable');
        const entries = nextClips.map((candidate: any) => {
            const entry = JSON.parse(JSON.stringify(clipsProperty.elementTypeData));
            if (entry?.value && typeof entry.value === 'object' && 'uuid' in entry.value) entry.value.uuid.value = candidate?.uuid ?? null;
            else if (entry?.value && typeof entry.value === 'object') entry.value = { uuid: candidate?.uuid ?? null };
            return entry;
        });
        await (globalThis as any).Editor.Message.request('scene', 'snapshot');
        const currentNodeDump = await (globalThis as any).Editor.Message.request('scene', 'query-node', request.nodeUuid);
        if (currentNodeDump?.__comps__?.[componentIndex]?.value?.uuid?.value !== animationUuid) {
            throw new Error('Serialized Animation component index changed; inspect the node before retrying');
        }
        await requireCurrentTarget();
        const currentClips = Array.isArray(animation.clips) ? animation.clips : [];
        if (currentClips.length !== previousClips.length || previousClips.some((candidate: any, index: number) => currentClips[index] !== candidate || (currentClips[index]?.uuid ?? null) !== previousClipUuids[index])) {
            throw new Error('Animation clip inventory changed; inspect the component before retrying');
        }
        const applied = await (globalThis as any).Editor.Message.request('scene', 'set-property', { uuid: request.nodeUuid, path: `__comps__.${componentIndex}.clips`, dump: { value: entries, type: clipsProperty.type } });
        if (applied === false) throw new Error('Creator refused Animation clip assignment');
        await requireCurrentTarget();
        const readBackClips = Array.isArray(animation.clips) ? animation.clips : [];
        if (readBackClips.length !== expectedClipUuids.length || expectedClipUuids.some((uuid: string | null, index: number) => (readBackClips[index]?.uuid ?? null) !== uuid)) {
            throw new Error('Animation clip inventory read-back failed; inspect the component before retrying');
        }
        return { nodeUuid: request.nodeUuid, clipUuid: request.clipUuid, clipName, clips: animation.clips.map((candidate: any) => ({ uuid: candidate?.uuid ?? null, name: candidate?.name ?? null })), success: true };
    },

    async animationComponentsList(request: { nodeUuid?: string, recursive?: boolean } = {}): Promise<Record<string, unknown>> {
        const root = request.nodeUuid ? await methods.findRuntimeNodeUuid(request.nodeUuid) : (globalThis as any).cc?.director?.getScene?.();
        if (!root) throw new Error('Animation list target was not found');
        const recursive = request.recursive !== false;
        const animations: Record<string, unknown>[] = [];
        const stack: any[] = [root];
        const visited = new Set<any>();
        while (stack.length) {
            const node = stack.pop();
            if (!node || visited.has(node)) continue;
            visited.add(node);
            for (const component of Array.isArray(node.components) ? node.components : []) {
                const className = String(component?.constructor?.name ?? '');
                if (!['Animation', 'cc.Animation'].includes(className)) continue;
                const clips = Array.isArray(component.clips) ? component.clips.filter(Boolean).map((clip: any) => clip?.name ?? clip?.uuid ?? null).filter((name: unknown): name is string => typeof name === 'string') : [];
                animations.push({ nodeUuid: node?.uuid ?? null, defaultClip: component?.defaultClip?.name ?? component?.defaultClip?.uuid ?? null, clips });
            }
            if (recursive) for (const child of node.children || []) stack.push(child);
        }
        return { animations };
    },

    async animationCompatibilityAudit(request: { nodeUuid: string }): Promise<Record<string, unknown>> {
        const node = await methods.findRuntimeNodeUuid(request.nodeUuid);
        if (!node) throw new Error(`Runtime animation node ${request.nodeUuid} not found`);
        const components = Array.isArray(node.components) ? node.components : [];
        const animation = components.find((component: any) => ['Animation', 'cc.Animation', 'SkeletalAnimation', 'cc.SkeletalAnimation'].includes(String(component?.constructor?.name ?? '')));
        const spine = components.find((component: any) => ['Skeleton', 'sp.Skeleton'].includes(String(component?.constructor?.name ?? '')));
        const dragonBones = components.find((component: any) => ['ArmatureDisplay', 'dragonBones.ArmatureDisplay'].includes(String(component?.constructor?.name ?? '')));
        const target: any = animation || spine || dragonBones;
        if (!target) throw new Error('No Animation, SkeletalAnimation, Spine, or DragonBones component found');
        const isSpine = !!spine && target === spine;
        const supports = {
            inspect: true,
            playback: typeof target.play === 'function' || typeof target.setAnimation === 'function' || typeof target.playAnimation === 'function',
            crossFade: typeof target.crossFade === 'function',
            tracks: isSpine && (typeof target.getState === 'function' || typeof target.getAnimationState === 'function' || (target.animationState !== null && typeof target.animationState === 'object' && Array.isArray(target.animationState.tracks))),
            seek: typeof target.getState === 'function',
            cacheMode: typeof target.setAnimationCacheMode === 'function',
            cacheInvalidation: typeof target.invalidAnimationCache === 'function',
        };
        const unsupportedOperations = Object.entries(supports).filter(([, supported]) => !supported).map(([name]) => name);
        return {
            nodeUuid: request.nodeUuid,
            component: target.constructor?.name ?? null,
            supports,
            supportedCacheModes: supports.cacheMode ? ['REALTIME', 'SHARED_CACHE', 'PRIVATE_CACHE'] : [],
            unsupportedOperations,
            recommendations: unsupportedOperations.length > 0 ? ['Use animationRuntimeControl inspect before issuing unsupported operations.'] : [],
        };
    },

    async engineApiClassAvailability(request: EngineClassRequest) {
        return inspectEngineClass(request, Reflect.get(globalThis, 'cc'));
    },

    async inspectRemovedPrefabComponent(request: { nodeUuid: string; fileID: string }) {
        const engine: unknown = Reflect.get(globalThis, 'cc');
        if (!engine || typeof engine !== 'object' || !('js' in engine)) throw new Error('Engine class registry is unavailable.');
        const registry = engine.js;
        if (!registry || typeof registry !== 'object' || !('getClassName' in registry) || typeof registry.getClassName !== 'function') throw new Error('Engine class name resolver is unavailable.');
        const resolveClassName = registry.getClassName;
        return inspectRemovedPrefabIdentity(await methods.findRuntimeNodeUuid(request.nodeUuid), request, component => String(resolveClassName(component)));
    },

    async uiLayoutReflow(request: UiReflowRequest) {
        // Scene globals are actual internal engine/facade objects; helper validates capabilities before mutation.
        const globals = globalThis as unknown as { cc: UiReflowEngine; cce: { SceneFacadeManager: UiReflowFacade } };
        return executeUiReflow(request, globals.cc, methods.findRuntimeNodeUuid, globals.cce.SceneFacadeManager);
    },



    async uiLayoutInspectGeometry(request: UiLayoutGeometryRequest): Promise<UiLayoutGeometryResult> {
        const cc = (globalThis as { cc?: { director?: { getScene?: () => unknown } } }).cc;
        const scene = cc?.director?.getScene?.();
        if (!scene || typeof scene !== 'object') {
            return { error: { code: 'UI_LAYOUT_SCENE_UNAVAILABLE', message: 'Live scene graph is unavailable.' } };
        }
        return buildUiLayoutInspectGeometry(scene, request);
    },

    async uiLayoutReport(request: LayoutReportRequest): Promise<unknown> {
        const cc = (globalThis as { cc?: { director?: { getScene?: () => unknown } } }).cc;
        const scene = cc?.director?.getScene?.();
        if (!scene || typeof scene !== 'object') {
            return { error: { code: 'UI_LAYOUT_SCENE_UNAVAILABLE', message: 'Live scene graph is unavailable', evidence: {} } };
        }
        return buildUiLayoutReport(scene as Parameters<typeof buildUiLayoutReport>[0], request);
    },

    async uiAccessibilityAudit(request: UiAccessibilityAuditRequest): Promise<unknown> {
        const cc = (globalThis as { cc?: { director?: { getScene?: () => unknown } } }).cc;
        const scene = cc?.director?.getScene?.();
        if (!scene || typeof scene !== 'object') {
            return { error: { code: 'UI_ACCESSIBILITY_SCENE_UNAVAILABLE', message: 'Live scene graph is unavailable', evidence: {} } };
        }
        return buildUiAccessibilityAudit(scene as Parameters<typeof buildUiAccessibilityAudit>[0], request);
    },

    async uiSafeAreaInspect(request: UiSafeAreaInspectRequest): Promise<unknown> {
        const cc = (globalThis as { cc?: { director?: { getScene?: () => unknown } } }).cc;
        const scene = cc?.director?.getScene?.();
        if (!scene || typeof scene !== 'object') {
            return { error: { code: 'UI_SAFE_AREA_SCENE_UNAVAILABLE', message: 'Live scene graph is unavailable', evidence: {} } };
        }
        return buildUiSafeAreaInspect(scene as Parameters<typeof buildUiSafeAreaInspect>[0], request);
    },
    async uiLayoutValidate(request: UiLayoutValidateRequest): Promise<unknown> {
        const cc = (globalThis as { cc?: { director?: { getScene?: () => unknown } } }).cc;
        const scene = cc?.director?.getScene?.();
        if (!scene || typeof scene !== 'object') {
            return { error: { code: 'UI_LAYOUT_VALIDATE_SCENE_UNAVAILABLE', message: 'Live scene graph is unavailable', evidence: {} } };
        }
        return buildUiLayoutValidate(scene as Parameters<typeof buildUiLayoutValidate>[0], request);
    },

    async simulateButtonClick(nodeUuid: string): Promise<{ handlersFired: number, method: string }> {
        const cc = (globalThis as any)['cc'];
        const node = await methods.findRuntimeNodeUuid(nodeUuid);
        if (!node) {
            throw new Error(`Runtime node ${nodeUuid} not found in the live scene`);
        }
        const button = node.getComponent?.(cc.Button);
        if (!button) {
            throw new Error(`Node ${nodeUuid} has no cc.Button component`);
        }

        // Fire every editor-bound click handler (the same ones the UI would run).
        let handlersFired = 0;
        for (const ev of button.clickEvents || []) {
            try {
                ev.emit([button]);
                handlersFired++;
            } catch (e: any) {
                console.warn(`[simulateButtonClick] handler failed: ${e?.message || e}`);
            }
        }
        return { handlersFired, method: 'clickEvents' };
    },

    async bindButtonClickEvent(nodeUuid: string, componentType: string, handlerName: string, customEventData?: string): Promise<{ handlerCount: number }> {
        const cc = (globalThis as any)['cc'];
        const node = await methods.findRuntimeNodeUuid(nodeUuid);
        if (!node) {
            throw new Error(`Runtime node ${nodeUuid} not found in the live scene`);
        }
        const button = node.getComponent?.(cc.Button);
        if (!button) {
            throw new Error(`Node ${nodeUuid} has no cc.Button component`);
        }

        // Resolve the target component on the same node (or its children) by type name.
        const candidates = [
            node.getComponent?.(componentType),
            ...(node.getComponentsInChildren?.(componentType) || []),
        ].filter(Boolean);
        const target = candidates[0];
        if (!target) {
            throw new Error(`No component of type '${componentType}' found on node ${nodeUuid} or its children`);
        }
        if (typeof target[handlerName] !== 'function') {
            throw new Error(`Component '${componentType}' has no method '${handlerName}'`);
        }

        const handler = new cc.Component.EventHandler();
        handler.target = node;
        handler.component = componentType.replace(/^cc\./, '');
        handler.handler = handlerName;
        handler.customEventData = customEventData || '';
        button.clickEvents = button.clickEvents || [];
        button.clickEvents.push(handler);
        return { handlerCount: button.clickEvents.length };
    },

    async listButtonClickEvents(nodeUuid: string): Promise<Array<{ targetUuid: string | null, componentName: string | null, handler: string | null, customEventData: string }>> {
        const node = await methods.findRuntimeNodeUuid(nodeUuid);
        if (!node) throw new Error(`Runtime node ${nodeUuid} not found in the live scene`);
        const cc = (globalThis as { cc?: { Button?: unknown } }).cc;
        const button = typeof node.getComponent === 'function' ? node.getComponent(cc?.Button) as { clickEvents?: unknown[] } | null : null;
        if (!button) throw new Error(`Node ${nodeUuid} has no cc.Button component`);
        return (Array.isArray(button.clickEvents) ? button.clickEvents : []).map((event: unknown) => {
            if (!event || typeof event !== 'object') return { targetUuid: null, componentName: null, handler: null, customEventData: '' };
            const row = event as Record<string, unknown>;
            const target = row.target && typeof row.target === 'object' ? row.target as Record<string, unknown> : undefined;
            return { targetUuid: target && typeof target.uuid === 'string' ? target.uuid : null, componentName: typeof row.component === 'string' ? row.component : null, handler: typeof row.handler === 'string' ? row.handler : null, customEventData: typeof row.customEventData === 'string' ? row.customEventData : '' };
        });
    },


    async particlePlaybackControl(nodeUuid: string, operation: 'play' | 'stop' | 'clear'): Promise<{ playing: boolean, operation: string, nodeUuid: string }> {
        const cc = (globalThis as any)['cc'];
        const node = await methods.findRuntimeNodeUuid(nodeUuid);
        if (!node) throw new Error(`Particle node not found: ${nodeUuid}`);
        const ParticleSystem = cc?.ParticleSystem ?? cc?.js?.getClassByName?.('cc.ParticleSystem');
        const ParticleSystem2D = cc?.ParticleSystem2D ?? cc?.js?.getClassByName?.('cc.ParticleSystem2D');
        const component = (ParticleSystem ? node.getComponent?.(ParticleSystem) : null)
            ?? (ParticleSystem2D ? node.getComponent?.(ParticleSystem2D) : null);
        if (!component) throw new Error(`Particle component not found on node: ${nodeUuid}`);
        if (operation === 'play') component.play?.();
        else if (operation === 'stop') component.stop?.();
        else if (operation === 'clear') component.clear?.();
        else throw new Error(`Unsupported particle operation: ${String(operation)}`);
        const playingValue = component.isPlaying;
        const playing = typeof playingValue === 'boolean'
            ? playingValue
            : typeof playingValue === 'function' ? Boolean(playingValue.call(component)) : operation === 'play';
        return { playing, operation, nodeUuid };
    },

    async inspectLocalization(): Promise<{ supported: boolean, currentLanguage: string | null, languages: string[], directions: Record<string, string>, error?: string }> {
        try {
            const l10n = await loadLocalizationRuntime();
            const currentLanguage = l10n.currentLanguage;
            const languages = Array.isArray(l10n.languages) ? l10n.languages.filter((language): language is string => typeof language === 'string').slice(0,32) : [];
            const directions: Record<string, string> = {};
            const unavailableDirections: string[] = [];
            for (const language of languages) {
                try { const direction = l10n.direction(language); if (direction !== 'ltr' && direction !== 'rtl') throw new Error('Invalid text direction'); directions[language] = direction; }
                catch { unavailableDirections.push(language); }
            }
            if (l10n.currentLanguage !== currentLanguage) throw new Error('Localization language changed during inspection.');
            return { supported: true, currentLanguage: typeof currentLanguage === 'string' && currentLanguage ? currentLanguage : null, languages, directions, ...(unavailableDirections.length ? { error: `Text direction unavailable for: ${unavailableDirections.join(', ')}`.slice(0,512) } : {}) };
        } catch (error: unknown) {
            return { supported: false, currentLanguage: null, languages: [], directions: {}, error: String(error instanceof Error ? error.message : error).slice(0,512) };
        }
    },
    async validateLocalization(keys: string[]): Promise<{ supported: boolean, language: string | null, checkedKeys: number, missingKeys: string[], error?: string }> {
        try {
            const l10n = await loadLocalizationRuntime();
            const boundedKeys = Array.from(new Set((keys ?? []).filter((key): key is string => typeof key === 'string' && key.length > 0))).slice(0, 256);
            const language = l10n.currentLanguage;
            const missingKeys: string[] = [];
            for (const key of boundedKeys) {
                const exists = l10n.exists(key);
                if (typeof exists !== 'boolean') throw new Error('Localization exists returned a non-boolean result.');
                if (l10n.currentLanguage !== language) throw new Error('Localization language changed during key validation.');
                if (!exists) missingKeys.push(key);
            }
            if (l10n.currentLanguage !== language) throw new Error('Localization language changed during key validation.');
            return { supported: true, language: typeof language === 'string' && language ? language : null, checkedKeys: boundedKeys.length, missingKeys };
        } catch (error: unknown) {
            return { supported: false, language: null, checkedKeys: 0, missingKeys: [], error: String(error instanceof Error ? error.message : error).slice(0,512) };
        }
    },
};
