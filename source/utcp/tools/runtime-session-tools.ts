import { randomUUID } from 'crypto';
import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { dispatchGameViewLifecycle, inspectGameViewRuntime } from '../utils/game-view-transport';
import { retryTransient } from '../utils/retry-policy';
import { unitQuaternion, orientationMatches } from '../utils/node-orientation';
import { validateGraphVariableInventory } from '../graph-variable-wait';
import {
    RuntimeSession,
    RuntimeSessionError,
    RuntimeSessionStore,
    RuntimeTargetKind,
} from '../utils/runtime-session-store';

type RuntimeState = { running: boolean, paused: boolean, timeScale: number | null, frameCount: number | null, sceneUuid: string };
type PreviewState = { state: 'play' | 'pause' | 'stop', sceneUuid: string, gamePaused: boolean | null, enabled: boolean, ready: boolean, platform: string, webContentsId: number | null };
type PreviewOperation = 'start' | 'stop' | 'pause' | 'resume' | 'step' | 'state';
export interface RuntimePreviewResult {
    success: true;
    operation: string;
    session?: RuntimeSession;
    state?: RuntimeState;
    preview: PreviewState;
    ready: boolean;
}

type LifecycleArgs = {
    operation: 'start' | 'attach' | 'inspect' | 'stop' | 'reset' | 'list';
    targetKind?: RuntimeTargetKind;
    targetId?: string;
    sessionId?: string;
    timeoutMs?: number;
};

const store = new RuntimeSessionStore();
const RUNTIME_STATE_TIMEOUT_MS = 60_000;
let previewMutationPending = false;
let unconfirmedPreviewMutation: { expected: PreviewState['state'], targetId?: string, minFrameCount?: number, requestSettled: boolean } | undefined;
const activeScenarios = new Map<string, { cancelled: boolean; cancel: () => void; runId: string; stepIndex: number | null; operation: string | null; completedSteps: number; requestPending: boolean; callerFinished: boolean }>();

async function withRuntimeStateTimeout<T>(promise: Promise<T>, deadline = Date.now() + RUNTIME_STATE_TIMEOUT_MS): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Preview operation exceeded its deadline; any in-flight Creator request may still complete.', recovery: 'Use runtimePreviewControl operation=state to reconcile Game View before retrying a mutation.' })), Math.max(0, deadline - Date.now()));
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export class RuntimeSessionTools {
    @utcpTool(
        'runtimeSessionLifecycle',
        'Start, attach, inspect, stop and release local handles for bounded Creator 3.7.3 Game View sessions. Browser and simulator transports are unsupported.',
        {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['start', 'attach', 'inspect', 'stop', 'reset', 'list'] },
                targetKind: { type: 'string', enum: ['game-view', 'browser-preview', 'simulator'] },
                targetId: { type: 'string', minLength: 1, maxLength: 256, description: 'Optional expected scene UUID; arbitrary target labels are not accepted.' },
                sessionId: { type: 'string', minLength: 1, maxLength: 64 },
                timeoutMs: { type: 'integer', minimum: 100, maximum: 60000 },
            },
            required: ['operation'],
        },
        {
            type: 'object',
            properties: {
                success: { type: 'boolean' },
                operation: { type: 'string' },
                session: { type: 'object' },
                sessions: { type: 'array' },
                state: { type: 'object' },
                preview: { type: 'object' },
                ready: { type: 'boolean' },
            },
            required: ['success', 'operation'],
        },
        'POST',
        ['runtime', 'session', 'lifecycle', 'start', 'attach', 'inspect', 'stop', 'reset', 'list'],
    )
    async runtimeSessionLifecycle(args: LifecycleArgs): Promise<{
        success: boolean;
        operation: string;
        session?: RuntimeSession | { sessionId: string; reset: true };
        sessions?: RuntimeSession[];
        state?: RuntimeState;
        preview?: PreviewState;
        ready?: boolean;
    }> {
        try {
            const timeoutMs = args.timeoutMs ?? 30_000;
            if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > RUNTIME_STATE_TIMEOUT_MS) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'timeoutMs must be an integer from 100 to 60000.' });
            switch (args.operation) {
                case 'start':
                    return await this.previewControl({ ...args, operation: 'start' });
                case 'attach':
                    return await this.attach(args);
                case 'inspect':
                    return await this.inspect(args);
                case 'stop':
                    return await this.stop(args);
                case 'reset':
                    return this.reset(args);
                case 'list':
                    return { success: true, operation: args.operation, sessions: store.list() };
                default:
                    throw new RuntimeSessionError('INVALID_ARGUMENT', `Unknown lifecycle operation: ${String(args.operation)}`);
            }
        } catch (error) {
            if (error instanceof RuntimeSessionError) {
                throw new ToolError({ code: error.code, status: error.code === 'SESSION_NOT_FOUND' ? 404 : 400, message: error.message });
            }
            throw error;
        }
    }

    private async attach(args: LifecycleArgs): Promise<{
        success: boolean;
        operation: string;
        session: RuntimeSession;
        state: RuntimeState;
        ready: boolean;
    }> {
        if (!args.targetKind) {
            throw new RuntimeSessionError('INVALID_ARGUMENT', 'attach requires targetKind');
        }
        if (args.targetKind !== 'game-view') {
            throw new ToolError({
                code: 'UNSUPPORTED_RUNTIME_TRANSPORT',
                status: 422,
                message: `Runtime target ${args.targetKind} has no verified transport on Creator 3.7.3.`,
                recovery: 'Use targetKind=game-view or qualify the target transport before attaching.',
            });
        }
        if (previewMutationPending) throw new ToolError({ code: 'RUNTIME_CONTROL_BUSY', status: 409, message: 'Wait for the pending preview lifecycle transition before attaching.' });
        let state: RuntimeState;
        try {
            state = await this.readState(args.targetId, Date.now() + (args.timeoutMs ?? 30_000));
        } catch (error) {
            if (error instanceof ToolError) throw error;
            throw new ToolError({
                code: 'RUNTIME_NOT_READY',
                status: 409,
                message: 'Creator game-view preview readiness is not verified on this runtime.',
                recovery: 'Start a verified game-view preview transport before attaching a runtime session.',
                details: { cause: error instanceof Error ? error.message : String(error) },
            });
        }
        const session = store.attach(args.targetKind, state.sceneUuid);
        return { success: true, operation: 'attach', session, state, ready: true };
    }

    private async inspect(args: LifecycleArgs): Promise<{
        success: boolean;
        operation: string;
        session: RuntimeSession;
        state?: RuntimeState;
        ready: boolean;
    }> {
        const session = store.inspect(args.sessionId ?? '');
        if (session.status === 'stopped') return { success: true, operation: 'inspect', session, ready: false };
        if (session.targetKind !== 'game-view') throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_TRANSPORT', status: 422, message: `Runtime target ${session.targetKind} has no verified transport.` });
        try {
            const deadline = Date.now() + (args.timeoutMs ?? 30_000);
            const state = await this.readState(session.targetId, deadline);
            if (Date.now() >= deadline) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Session readiness inspection completed after its caller deadline.' });
            let current: RuntimeSession;
            try { current = store.inspect(session.sessionId); }
            catch (error) {
                if (error instanceof RuntimeSessionError && error.code === 'SESSION_NOT_FOUND') throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Session was reset during readiness inspection; stale readiness refused.' });
                throw error;
            }
            if (current.status !== 'attached' || current.targetId !== session.targetId || current.targetKind !== session.targetKind || current.createdAt !== session.createdAt) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Session lifecycle changed during readiness inspection.' });
            return { success: true, operation: 'inspect', session: current, state, ready: true };
        } catch (error) {
            if (error instanceof ToolError) throw error;
            throw new ToolError({
                code: 'RUNTIME_NOT_READY',
                status: 409,
                message: 'Creator preview did not expose a valid runtime state during inspect.',
                recovery: 'Start the game-view preview and retry inspect.',
                details: { cause: error instanceof Error ? error.message : String(error) },
            });
        }
    }

    private async stop(args: LifecycleArgs): Promise<{ success: true, operation: string, session: RuntimeSession, ready: false }> {
        const session = store.inspect(args.sessionId ?? '');
        const result = await this.previewControl({ operation: 'stop', sessionId: session.sessionId, timeoutMs: args.timeoutMs });
        return { success: true, operation: 'stop', session: result.session!, ready: false };
    }

    private reset(args: LifecycleArgs): { success: true, operation: string, session: { sessionId: string, reset: true } } {
        return { success: true, operation: 'reset', session: store.reset(args.sessionId ?? '') };
    }

    private async readPreviewState(deadline: number): Promise<PreviewState> {
        const result = await retryTransient(() => withRuntimeStateTimeout(inspectGameViewRuntime(), deadline), { attempts: 3, delayMs: 50, deadline });
        return { state: result.running ? result.paused ? 'pause' : 'play' : 'stop', sceneUuid: result.sceneUuid,
            gamePaused: result.running ? result.paused : null, enabled: result.enabled, ready: result.ready,
            platform: result.platform, webContentsId: result.webContentsId };
    }

    private async readState(targetId?: string, deadline = Date.now() + RUNTIME_STATE_TIMEOUT_MS): Promise<RuntimeState> {
        const result = await withRuntimeStateTimeout(inspectGameViewRuntime(), deadline);
        if (!result.running || typeof result.paused !== 'boolean') throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'Creator game-view preview is stopped.' });
        if (targetId && result.sceneUuid !== targetId) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'The actual game-view scene no longer matches this session.', details: { targetId, sceneUuid: result.sceneUuid } });
        return { running: result.running, paused: result.paused, timeScale: result.timeScale, frameCount: result.frameCount, sceneUuid: result.sceneUuid };
    }

    async previewControl(args: { operation: PreviewOperation, sessionId?: string, targetId?: string, targetKind?: RuntimeTargetKind, timeoutMs?: number }): Promise<RuntimePreviewResult> {
        const timeoutMs = args.timeoutMs ?? 30_000;
        if (!['start', 'stop', 'pause', 'resume', 'step', 'state'].includes(args.operation)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Unknown preview operation.' });
        if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > RUNTIME_STATE_TIMEOUT_MS) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'timeoutMs must be an integer from 100 to 60000.' });
        if (args.targetKind && args.targetKind !== 'game-view') throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_TRANSPORT', status: 422, message: 'Only Creator 3.7.3 game-view lifecycle is supported.' });
        if (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || args.sessionId.length < 1 || args.sessionId.length > 64)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'sessionId must be 1-64 characters.' });
        if (args.targetId !== undefined && (typeof args.targetId !== 'string' || args.targetId.length < 1 || args.targetId.length > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'targetId must be 1-256 characters.' });
        const deadline = Date.now() + timeoutMs;
        let session: RuntimeSession | undefined;
        try {
            session = args.sessionId ? store.inspect(args.sessionId) : undefined;
        } catch (error) {
            if (error instanceof RuntimeSessionError) throw new ToolError({ code: error.code, status: error.code === 'SESSION_NOT_FOUND' ? 404 : 400, message: error.message });
            throw error;
        }
        if (session && args.targetId && args.targetId !== session.targetId) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'The requested target does not match this session.' });
        if (session?.status === 'stopped') throw new ToolError({ code: 'RUNTIME_SESSION_STOPPED', status: 409, message: 'This session already stopped; it cannot control a replacement preview.' });
        if (args.operation === 'state') {
            const preview = await this.readPreviewState(deadline);
            const targetId = session?.targetId ?? args.targetId;
            if (preview.enabled && targetId && preview.sceneUuid !== targetId) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'The current scene no longer matches the requested target.' });
            const state = preview.state === 'stop' ? undefined : await this.readState(targetId, deadline);
            if (state && (state.sceneUuid !== preview.sceneUuid || state.paused !== (preview.state === 'pause'))) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Game View changed while reading preview state.' });
            if (unconfirmedPreviewMutation?.requestSettled && preview.state === unconfirmedPreviewMutation.expected
                && (preview.state === 'stop' ? !preview.enabled : !!state && (!unconfirmedPreviewMutation.targetId || state.sceneUuid === unconfirmedPreviewMutation.targetId)
                    && (unconfirmedPreviewMutation.minFrameCount === undefined || (state.frameCount !== null && state.frameCount >= unconfirmedPreviewMutation.minFrameCount)))) {
                if (preview.state === 'stop') {
                    for (const attached of store.list()) {
                        if (attached.status === 'attached' && attached.targetKind === 'game-view'
                            && (!unconfirmedPreviewMutation.targetId || attached.targetId === unconfirmedPreviewMutation.targetId)) store.stop(attached.sessionId);
                    }
                }
                unconfirmedPreviewMutation = undefined;
                previewMutationPending = false;
            }
            return { success: true, operation: 'state', preview, state, ready: !!state };
        }
        let unsettledRequest: Promise<unknown> | undefined;
        let dispatchedMutation = false;
        let pendingPostcondition: Omit<NonNullable<typeof unconfirmedPreviewMutation>, 'requestSettled'> | undefined;
        if (previewMutationPending) throw new ToolError({ code: 'RUNTIME_CONTROL_BUSY', status: 409, message: 'A preview lifecycle operation is pending or its outcome is unconfirmed.', recovery: 'Use runtimePreviewControl operation=state; mutations unlock only after the request settles and its intended Game View state is verified.' });
        previewMutationPending = true;
        try {
            if (args.operation === 'start') {
                const platform: unknown = await withRuntimeStateTimeout(Editor.Profile.getConfig('preview', 'preview.current.platform', 'local'), deadline);
                if (platform !== 'gameView') throw new ToolError({
                    code: 'RUNTIME_PLATFORM_REQUIRED', status: 409,
                    message: 'Select Game View in the Creator preview toolbar before starting a game-view session.',
                    details: { platform: typeof platform === 'string' ? platform : null },
                    recovery: 'Select Game View manually, wait for its preview transport to load, then retry. This tool does not change the selected platform.',
                });
            }
            let preview = await this.readPreviewState(deadline);
            if (args.operation === 'start') {
                while (preview.platform === 'gameView' && !preview.ready) {
                    await withRuntimeStateTimeout(new Promise<void>((resolve) => setTimeout(resolve, 50)), deadline);
                    preview = await this.readPreviewState(deadline);
                }
                if (preview.platform !== 'gameView') throw new ToolError({ code: 'RUNTIME_PLATFORM_REQUIRED', status: 409, message: 'The preview platform changed before Game View became ready.' });
            }
            const targetId = session?.targetId ?? args.targetId ?? preview.sceneUuid;
            if (preview.enabled && targetId && targetId !== preview.sceneUuid) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'The requested scene does not match the current preview.', details: { targetId, sceneUuid: preview.sceneUuid } });
            if (args.operation === 'start' && preview.state !== 'stop' && preview.enabled) {
                const state = await this.readState(targetId || undefined, deadline);
                const attached = store.attach('game-view', state.sceneUuid);
                return { success: true, operation: 'start', session: attached, state, preview, ready: true };
            }
            if (args.operation === 'start') store.assertCapacity('game-view', preview.sceneUuid || undefined);
            if (!['start', 'stop'].includes(args.operation) && preview.state === 'stop') throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'Start game-view preview before controlling playback.' });
            if (args.operation === 'step' && preview.state !== 'pause') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Pause game-view before stepping it.' });
            const before = args.operation === 'step' ? await this.readState(preview.sceneUuid, deadline) : undefined;
            if (before && before.frameCount === null) throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_METRIC', status: 422, message: 'Game-view does not expose a frame counter for verified stepping.' });
            const expected = args.operation === 'stop' ? 'stop' : args.operation === 'pause' || args.operation === 'step' || (args.operation === 'start' && preview.state === 'pause') ? 'pause' : 'play';
            pendingPostcondition = { expected, targetId: targetId || undefined, minFrameCount: before?.frameCount === undefined || before.frameCount === null ? undefined : before.frameCount + 1 };
            if (Date.now() >= deadline) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Preview deadline elapsed before dispatch; no playback mutation was sent.' });
            let requestFailure: unknown;
            if (args.operation === 'start' || args.operation === 'stop') {
                const request = dispatchGameViewLifecycle(args.operation === 'start', deadline);
                unsettledRequest = request;
                dispatchedMutation = true;
                await withRuntimeStateTimeout(request, deadline);
                unsettledRequest = undefined;
            } else {
                const request = args.operation === 'step'
                    ? Editor.Message.request('scene', 'editor-preview-call-method', 'step')
                    : Editor.Message.request('scene', 'editor-preview-call-method', 'pause', args.operation === 'pause');
                unsettledRequest = request;
                dispatchedMutation = true;
                void request.then(undefined, error => { requestFailure = error; });
                void request.then(() => { unsettledRequest = undefined; }, () => { unsettledRequest = undefined; });
            }
            for (;;) {
                if (requestFailure !== undefined) throw requestFailure;
                try {
                    preview = await this.readPreviewState(deadline);
                } catch (error) {
                    // Native transitions can briefly expose an enabled host with a
                    // stopped/inconsistent renderer. Observe again; never redispatch.
                    if (!(error instanceof ToolError) || error.code !== 'RUNTIME_NOT_READY') throw error;
                    await withRuntimeStateTimeout(new Promise<void>((resolve) => setTimeout(resolve, 50)), deadline);
                    continue;
                }
                if (args.operation === 'stop' && preview.state === 'stop' && !preview.enabled) {
                    unconfirmedPreviewMutation = undefined;
                    const stopped = session ? store.stop(session.sessionId) : undefined;
                    for (const attached of store.list()) {
                        if (attached.status === 'attached' && attached.targetKind === 'game-view' && (!targetId || attached.targetId === targetId)) store.stop(attached.sessionId);
                    }
                    return { success: true, operation: 'stop', session: stopped, preview, ready: false };
                }
                if (args.operation !== 'stop' && targetId && preview.enabled && preview.sceneUuid !== targetId) {
                    // The native start completed on another scene; do not disguise
                    // known identity drift as a readiness timeout or rebind a handle.
                    if (pendingPostcondition) pendingPostcondition.targetId = preview.sceneUuid;
                    throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Game View started or switched to a different scene than requested.', details: { expectedTargetId: targetId, actualSceneUuid: preview.sceneUuid }, recovery: 'Read runtimePreviewControl state, then attach explicitly to the observed runtime or stop it. Do not repeat start.' });
                }
                if (preview.state === expected && (expected === 'stop' ? !preview.enabled : preview.gamePaused === (expected === 'pause'))) {
                    // Actual Game View renderer state is the authoritative postcondition.
                    // Creator 3.7.3 can leave the official message promise unsettled after
                    // the renderer is already running/stopped; do not retain a false busy lock.
                    // Release only after the full postcondition, including a verified step frame.
                    const state = await this.readState(targetId || undefined, deadline);
                    if (state.sceneUuid !== preview.sceneUuid || state.paused !== (expected === 'pause')) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Game View changed during playback verification.' });
                    if (!before || (state.frameCount !== null && before.frameCount !== null && state.frameCount > before.frameCount)) {
                        unconfirmedPreviewMutation = undefined;
                        unsettledRequest = undefined;
                        const attached = args.operation === 'start' ? store.attach('game-view', state.sceneUuid) : session;
                        return { success: true, operation: args.operation, session: attached, state, preview, ready: true };
                    }
                }
                await withRuntimeStateTimeout(new Promise<void>((resolve) => setTimeout(resolve, 50)), deadline);
            }
        } catch (error) {
            const retrySafe = error instanceof ToolError && error.details?.retrySafe === true;
            if (dispatchedMutation && pendingPostcondition && !retrySafe) {
                const rawRequest = (error instanceof ToolError ? (error as ToolError & { pendingRequest?: Promise<unknown> }).pendingRequest : undefined) ?? unsettledRequest;
                const pending = { ...pendingPostcondition, requestSettled: !rawRequest };
                unconfirmedPreviewMutation = pending;
                if (rawRequest) void rawRequest.then(() => { pending.requestSettled = true; }, failure => {
                    const rawCompletion = failure instanceof ToolError ? (failure as ToolError & { pendingRequest?: Promise<unknown> }).pendingRequest : undefined;
                    if (rawCompletion) void rawCompletion.then(() => { pending.requestSettled = true; }, () => { pending.requestSettled = true; });
                    else pending.requestSettled = true;
                });
            }
            if (error instanceof RuntimeSessionError) throw new ToolError({ code: error.code, status: error.code === 'SESSION_NOT_FOUND' ? 404 : 400, message: error.message });
            if (error instanceof ToolError) {
                if (dispatchedMutation && !retrySafe) throw new ToolError({ code: error.code, status: error.status, message: error.message,
                    details: { ...error.details, mutationDispatched: true, outcome: 'unknown', retrySafe: false },
                    recovery: 'Use runtimePreviewControl operation=state to reconcile Game View before retrying.' });
                throw error;
            }
            throw new ToolError({ code: 'RUNTIME_CONTROL_UNAVAILABLE', status: 409, message: 'Creator preview control failed; target state is unconfirmed.', details: { cause: error instanceof Error ? error.message : String(error), mutationDispatched: dispatchedMutation, retrySafe: !dispatchedMutation }, recovery: 'Inspect the target before retrying.' });
        } finally {
            // A settled IPC promise does not prove that its delayed lifecycle mutation
            // completed. Keep unknown outcomes locked until read-only state confirms them.
            previewMutationPending = unconfirmedPreviewMutation !== undefined;
        }
    }
    @utcpTool(
        'runtimeStateObserve',
        'Observe verified state for an attached game-view runtime session.',
        {
            type: 'object',
            properties: { sessionId: { type: 'string', minLength: 1, maxLength: 64 } },
            required: ['sessionId'],
        },
        {
            type: 'object',
            properties: {
                success: { type: 'boolean' },
                sessionId: { type: 'string' },
                state: {
                    type: 'object',
                    properties: {
                        running: { type: 'boolean' },
                        paused: { type: 'boolean' },
                        timeScale: { type: ['number', 'null'] },
                        frameCount: { type: ['integer', 'null'], minimum: 0 },
                        sceneUuid: { type: 'string' },
                    },
                    required: ['running', 'paused', 'timeScale', 'frameCount', 'sceneUuid'],
                },
            },
            required: ['success', 'sessionId', 'state'],
        },
        'POST',
        ['runtime', 'state', 'observe', 'session'],
    )
    async runtimeStateObserve(args: { sessionId: string }): Promise<{ success: true, sessionId: string, state: RuntimeState }> {
        let session: RuntimeSession;
        try {
            session = store.inspect(args.sessionId);
        } catch (error) {
            if (error instanceof RuntimeSessionError) throw new ToolError({ code: error.code, status: error.code === 'SESSION_NOT_FOUND' ? 404 : 400, message: error.message });
            throw error;
        }
        if (session.status === 'stopped') {
            throw new ToolError({
                code: 'RUNTIME_SESSION_STOPPED',
                status: 409,
                message: `Runtime session is stopped: ${session.sessionId}`,
                recovery: 'Attach a new game-view session before observing state.',
            });
        }
        if (session.targetKind !== 'game-view') {
            throw new ToolError({
                code: 'UNSUPPORTED_RUNTIME_TRANSPORT',
                status: 422,
                message: `Runtime target ${session.targetKind} has no verified transport.`,
            });
        }
        try {
            const observed = await this.inspect({ operation: 'inspect', sessionId: session.sessionId });
            if (!observed.state) throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'Runtime state unavailable.' });
            return { success: true, sessionId: session.sessionId, state: observed.state };
        } catch (error) {
            if (error instanceof ToolError) throw error;
            throw new ToolError({
                code: 'RUNTIME_NOT_READY',
                status: 409,
                message: 'Creator preview did not expose a valid runtime state.',
                recovery: 'Start the game-view preview and retry observation.',
                details: { cause: error instanceof Error ? error.message : String(error) },
            });
        }
    }

    @utcpTool(
        'runtimeWaitForState',
        'Wait boundedly for an attached game-view runtime state to match declared conditions.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                sessionId: { type: 'string', minLength: 1, maxLength: 64 },
                paused: { type: 'boolean' },
                minFrameCount: { type: 'integer', minimum: 0, maximum: 1000000000 },
                maxFrameCount: { type: 'integer', minimum: 0, maximum: 1000000000 },
                timeoutMs: { type: 'integer', minimum: 100, maximum: 10000 },
            },
            required: ['sessionId'],
        },
        {
            type: 'object',
            properties: { success: { type: 'boolean' }, sessionId: { type: 'string' }, state: { type: 'object' }, elapsedMs: { type: 'integer', minimum: 0 } },
            required: ['success', 'sessionId', 'state', 'elapsedMs'],
        },
        'POST',
        ['runtime', 'state', 'wait', 'condition'],
    )
    async runtimeWaitForState(args: { sessionId: string, paused?: boolean, maxFrameCount?: number; minFrameCount?: number, timeoutMs?: number }, assertActive?: () => void): Promise<{ success: true, sessionId: string, state: RuntimeState, elapsedMs: number }> {
        if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim() || args.sessionId.length > 64 || args.paused === undefined && args.minFrameCount === undefined && args.maxFrameCount === undefined
            || args.maxFrameCount !== undefined && (!Number.isSafeInteger(args.maxFrameCount) || args.maxFrameCount < 0 || args.maxFrameCount > 1000000000 || args.minFrameCount !== undefined && args.minFrameCount > args.maxFrameCount)
            || args.paused !== undefined && typeof args.paused !== 'boolean' || args.minFrameCount !== undefined && (!Number.isSafeInteger(args.minFrameCount) || args.minFrameCount < 0 || args.minFrameCount > 1000000000)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide exact session and typed paused/minFrameCount wait predicates.' });
        let session: RuntimeSession;
        try {
            session = store.inspect(args.sessionId);
        } catch (error) {
            if (error instanceof RuntimeSessionError) throw new ToolError({ code: error.code, status: error.code === 'SESSION_NOT_FOUND' ? 404 : 400, message: error.message });
            throw error;
        }
        if (session.status === 'stopped') throw new ToolError({ code: 'RUNTIME_SESSION_STOPPED', status: 409, message: `Runtime session is stopped: ${session.sessionId}`, recovery: 'Attach a new game-view session before waiting for state.' });
        if (session.targetKind !== 'game-view') throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_TRANSPORT', status: 422, message: `Runtime target ${session.targetKind} has no verified transport.` });
        const timeoutMs = args.timeoutMs ?? 10000;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'timeoutMs must be an integer from 100 to 10000.' });
        args = { ...args };
        const started = Date.now();
        const deadline = started + timeoutMs;
        const observe = async (): Promise<RuntimeState> => {
            assertActive?.();
            const remaining = deadline - Date.now();
            if (remaining < 100) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Runtime wait has insufficient remaining time for a bounded observation; no next inspection dispatched.' });
            const observed = await withRuntimeStateTimeout(this.inspect({ operation: 'inspect', sessionId: session.sessionId, timeoutMs: remaining }), deadline);
            assertActive?.();
            if (Date.now() >= deadline) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Runtime state observation settled after wait deadline.' });
            if (!observed.state || !observed.ready || observed.session.createdAt !== session.createdAt || observed.session.targetId !== session.targetId || observed.session.targetKind !== session.targetKind) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Runtime wait session identity changed.' });
            return observed.state;
        };
        let state = await observe();
        while ((args.paused !== undefined && state.paused !== args.paused) || (args.minFrameCount !== undefined && (state.frameCount === null || state.frameCount < args.minFrameCount)) || (args.maxFrameCount !== undefined && (state.frameCount === null || state.frameCount > args.maxFrameCount))) {
            if ((args.minFrameCount !== undefined || args.maxFrameCount !== undefined) && state.frameCount === null) throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_METRIC', status: 422, message: 'Game-view frame count is unavailable.' });
            if (Date.now() - started >= timeoutMs) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Runtime state did not match the requested condition before timeout.', recovery: 'Start a verified game-view preview or increase timeoutMs within the bound.', details: { state, elapsedMs: Date.now() - started } });
            await withRuntimeStateTimeout(new Promise<void>((resolve) => setTimeout(resolve, 50)), deadline);
            state = await observe();
        }
        return { success: true, sessionId: session.sessionId, state, elapsedMs: Date.now() - started };
    }
    @utcpTool(
        'previewSessionInspect',
        'Inspect a session against native game-view state and scene identity; URL is ancillary server metadata, never readiness proof.',
        {
            type: 'object',
            additionalProperties: false,
            properties: { sessionId: { type: 'string', minLength: 1, maxLength: 64 } },
            required: ['sessionId'],
        },
        {
            type: 'object',
            properties: { success: { type: 'boolean' }, sessionId: { type: 'string' }, targetKind: { type: 'string' }, url: { type: 'string' }, ready: { type: 'boolean' }, stale: { type: 'boolean' } },
            required: ['success', 'sessionId', 'targetKind', 'url', 'ready', 'stale'],
        },
        'POST',
        ['preview', 'session', 'inspect', 'runtime'],
    )
    async previewSessionInspect(args: { sessionId: string }): Promise<{ success: true, sessionId: string, targetKind: string, url: string, ready: boolean, stale: boolean }> {
        let session: RuntimeSession;
        try {
            session = store.inspect(args.sessionId);
        } catch (error) {
            if (error instanceof RuntimeSessionError) throw new ToolError({ code: error.code, status: error.code === 'SESSION_NOT_FOUND' ? 404 : 400, message: error.message });
            throw error;
        }
        if (session.status === 'stopped') return { success: true, sessionId: session.sessionId, targetKind: session.targetKind, url: '', ready: false, stale: true };
        const deadline = Date.now() + RUNTIME_STATE_TIMEOUT_MS;
        const preview = await this.readPreviewState(deadline);
        const stale = preview.sceneUuid !== session.targetId;
        if (stale || preview.state === 'stop') return { success: true, sessionId: session.sessionId, targetKind: session.targetKind, url: '', ready: false, stale };
        await this.readState(session.targetId, deadline);
        let url: unknown;
        try {
            url = await withRuntimeStateTimeout(Editor.Message.request('preview', 'query-preview-url'), deadline);
        } catch (error) {
            throw new ToolError({ code: 'UNSUPPORTED_EDITOR_API', status: 422, message: 'Creator does not expose preview/query-preview-url.', details: { cause: error instanceof Error ? error.message : String(error) }, recovery: 'Use a Creator version with preview URL query support.' });
        }
        if (typeof url !== 'string') url = '';
        return { success: true, sessionId: session.sessionId, targetKind: session.targetKind, url: url as string, ready: true, stale: false };
    }
    @utcpTool(
        'runtimeScenarioRun',
        'Run finite typed runtime, audio and exact-clip animation checkpoints with deadlines and cooperative cancellation. No automatic action replay.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                sessionId: { type: 'string', minLength: 1, maxLength: 64 },
                runId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Caller-generated fresh per-run cancellation identity. Omit for a generated identity.' },
                totalTimeoutMs: { type: 'integer', minimum: 100, maximum: 60000, default: 30000 },
                steps: {
                    type: 'array', minItems: 1, maxItems: 16,
                    items: {
                        type: 'object', additionalProperties: false,
                        properties: {
                            operation: { type: 'string', enum: ['nodeObserve', 'nodeAssert', 'nodeWait', 'graphObserve', 'graphAssert', 'graphSet', 'graphWait', 'delay', 'wait', 'assert', 'observe', 'particleControl', 'particleObserve', 'particleAssert', 'particleWait', 'animationEvents', 'animationControl', 'animationObserve', 'animationAssert', 'animationWait', 'audioObserve', 'audioAssert', 'audioControl', 'audioWait', 'pause', 'resume', 'step'] },
                            paused: { type: 'boolean' },
                            active: { type: 'boolean' }, activeInHierarchy: { type: 'boolean' },
                            parentUuid: { type: ['string', 'null'], minLength: 1, maxLength: 256, description: 'nodeAssert/nodeWait exact parent; null means root, omitted means no predicate.' },
                            minChildCount: { type: 'integer', minimum: 0, maximum: 9999 }, maxChildCount: { type: 'integer', minimum: 0, maximum: 9999 },
                            siblingIndex: { type: ['integer', 'null'], minimum: 0, maximum: 9999, description: 'nodeAssert/nodeWait hierarchy order only; null root.' },
                            position: { type: 'object', additionalProperties: false, properties: { space: { type: 'string', enum: ['local', 'world'] }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, tolerance: { type: 'number', minimum: 0, maximum: 1000000 } }, required: ['space', 'x', 'y', 'z', 'tolerance'], description: 'nodeAssert/nodeWait only, inclusive per-axis tolerance; not movement or completion proof.' },
                            rotation: { type: 'object', additionalProperties: false, properties: { space: { type: 'string', enum: ['local', 'world'] }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, w: { type: 'number' }, toleranceDegrees: { type: 'number', minimum: 0, maximum: 180 } }, required: ['space', 'x', 'y', 'z', 'w', 'toleranceDegrees'], description: 'nodeAssert/nodeWait only; finite nonzero quaternion, sign-invariant angular comparison.' },
                            scale: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, tolerance: { type: 'number', minimum: 0, maximum: 1000000 } }, required: ['x', 'y', 'z', 'tolerance'], description: 'nodeAssert/nodeWait local scale only; inclusive per-axis tolerance.' },
                            minFrameCount: { type: 'integer', minimum: 0, maximum: 1000000000 },
                maxFrameCount: { type: 'integer', minimum: 0, maximum: 1000000000 },
                            timeoutMs: { type: 'integer', minimum: 100, maximum: 10000 },
                            durationMs: { type: 'integer', minimum: 0, maximum: 5000, description: 'Wall-clock cue spacing only; independent of game pause/time-scale, never completion evidence.' },
                            nodeReference: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['id'] },
                            componentId: { type: 'string', minLength: 1, maxLength: 256 },
                            graphUuid: { type: 'string', minLength: 1, maxLength: 256 }, variableName: { type: 'string', minLength: 1, maxLength: 256 },
                            variableType: { type: 'string', enum: ['float', 'integer', 'boolean'] }, variableValue: { type: ['number', 'boolean'] },
                            variableRange: { type: 'object', additionalProperties: false, properties: { min: { type: 'number' }, max: { type: 'number' } }, required: ['min', 'max'], description: 'graphAssert/graphWait inclusive numeric range, exclusive with variableValue; never graphSet.' },
                            expectedValue: { type: ['number', 'boolean'], description: 'Optional graphSet current-value conflict guard; not an atomic transaction.' },
                            clipName: { type: 'string', minLength: 1, maxLength: 256 },
                            clipUuid: { type: 'string', minLength: 1, maxLength: 256 },
                            maxEvents: { type: 'integer', minimum: 1, maximum: 100, description: 'animationEvents only; capture window begins at listener registration, no prior history or playback dispatch.' },
                            expectedEvent: { type: 'string', enum: ['play', 'pause', 'resume', 'stop', 'lastframe', 'finished'], description: 'animationEvents only; require this lifecycle event inside captured window. Not prior history, event ordering or guaranteed natural completion.' },
                            minEventCount: { type: 'integer', minimum: 1, maximum: 100, description: 'animationEvents with expectedEvent only; default1. Must not exceed maxEvents (default20). Counts selected event occurrences in captured window, not loop count or prior history.' },
                            expectedEventSequence: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', enum: ['play', 'pause', 'resume', 'stop', 'lastframe', 'finished'] }, description: 'animationEvents only: ordered subsequence within capture, other events may intervene. Exclusive with expectedEvent/minEventCount; length must fit maxEvents(default20). No prior-history inference.' },
                            animationOperation: { type: 'string', enum: ['play', 'pause', 'resume', 'stop'] },
                            particleOperation: { type: 'string', enum: ['play', 'stop', 'clear'] },
                            minParticleCount: { type: 'integer', minimum: 0, maximum: 1000000 },
                            userActivation: { type: 'string', enum: ['active', 'inactive', 'unknown'], description: 'audioAssert/audioWait observed browser activation only, not autoplay permission or playback guarantee.' },
                            maxParticleCount: { type: 'integer', minimum: 0, maximum: 1000000 },
                            playing: { type: 'boolean' },
                            loaded: { type: 'boolean' },
                            loop: { type: 'boolean', description: 'audioAssert/audioWait only; no loop writes.' },
                            minVolume: { type: 'number', minimum: 0, maximum: 1 }, maxVolume: { type: 'number', minimum: 0, maximum: 1 },
                            minDuration: { type: 'number', minimum: 0, maximum: 86400 }, maxDuration: { type: 'number', minimum: 0, maximum: 86400 },
                            minTime: { type: 'number', minimum: 0, maximum: 3600 },
                            minSpeed: { type: 'number', minimum: -1000000, maximum: 1000000 }, maxSpeed: { type: 'number', minimum: -1000000, maximum: 1000000 },
                            maxTime: { type: 'number', minimum: 0, maximum: 3600, description: 'animationAssert/animationWait/audioAssert/audioWait inclusive upper playback-time bound only.' },
                            playbackState: { type: 'string', enum: ['init', 'playing', 'paused', 'stopped', 'interrupted'] },
                            audioOperation: { type: 'string', enum: ['play', 'pause', 'stop', 'seek'] },
                            expectedComponentUuid: { type: 'string', minLength: 1, maxLength: 256 }, expectedClipUuid: { type: 'string', minLength: 1, maxLength: 256 },
                            time: { type: 'number', minimum: 0 },
                        },
                        required: ['operation'],
                    },
                },
            },
            required: ['sessionId', 'steps'],
        },
        {
            type: 'object',
            properties: { success: { type: 'boolean' }, sessionId: { type: 'string' }, runId: { type: 'string' }, outcomes: { type: 'array' } },
            required: ['success', 'sessionId', 'runId', 'outcomes'],
        },
        'POST',
        ['runtime', 'scenario', 'run', 'steps'],
    )
    async runtimeScenarioRun(args: { sessionId: string, runId?: string, steps: Array<{ operation: 'nodeObserve' | 'nodeAssert' | 'nodeWait' | 'graphObserve' | 'graphAssert' | 'graphSet' | 'graphWait' | 'delay' | 'wait' | 'assert' | 'observe' | 'particleControl' | 'particleObserve' | 'particleAssert' | 'particleWait' | 'animationEvents' | 'animationControl' | 'animationObserve' | 'animationAssert' | 'animationWait' | 'audioObserve' | 'audioAssert' | 'audioControl' | 'audioWait' | 'pause' | 'resume' | 'step', minDuration?: number; maxDuration?: number; userActivation?: 'active' | 'inactive' | 'unknown'; expectedComponentUuid?: string; expectedClipUuid?: string; siblingIndex?: number | null; minChildCount?: number; maxChildCount?: number; parentUuid?: string | null; scale?: { x: number; y: number; z: number; tolerance: number }; rotation?: { space: 'local' | 'world'; x: number; y: number; z: number; w: number; toleranceDegrees: number }; position?: { space: 'local' | 'world', x: number; y: number; z: number; tolerance: number }; active?: boolean, activeInHierarchy?: boolean, graphUuid?: string, variableName?: string, variableType?: 'float' | 'integer' | 'boolean', expectedValue?: number | boolean, variableRange?: { min: number; max: number }; variableValue?: number | boolean, durationMs?: number, nodeReference?: { id: string }, animationOperation?: 'play' | 'pause' | 'resume' | 'stop', particleOperation?: 'play' | 'stop' | 'clear', minParticleCount?: number, maxParticleCount?: number, componentId?: string, expectedEventSequence?: Array<'play' | 'pause' | 'resume' | 'stop' | 'lastframe' | 'finished'>; minEventCount?: number; expectedEvent?: 'play' | 'pause' | 'resume' | 'stop' | 'lastframe' | 'finished'; maxEvents?: number; clipName?: string, clipUuid?: string, playbackState?: 'init' | 'playing' | 'paused' | 'stopped' | 'interrupted', maxTime?: number; minSpeed?: number; maxSpeed?: number; minTime?: number, audioOperation?: 'play' | 'pause' | 'stop' | 'seek', time?: number, playing?: boolean, minVolume?: number; maxVolume?: number; loop?: boolean; loaded?: boolean, paused?: boolean, maxFrameCount?: number; minFrameCount?: number, timeoutMs?: number }>, totalTimeoutMs?: number }): Promise<{ success: true, sessionId: string, runId: string, outcomes: Array<Record<string, unknown>> }> {
        if (!Array.isArray(args.steps) || args.steps.length === 0 || args.steps.length > 16) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'runtimeScenarioRun requires 1-16 typed steps.' });
        if (typeof args.sessionId !== 'string' || !args.sessionId.trim() || args.sessionId.length > 64) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'A bounded runtime sessionId is required.' });
        if (args.runId !== undefined && (typeof args.runId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(args.runId))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'runId must be a fresh bounded alphanumeric/hyphen/underscore identity.' });
        const totalTimeoutMs = args.totalTimeoutMs ?? 30000;
        if (!Number.isInteger(totalTimeoutMs) || totalTimeoutMs < 100 || totalTimeoutMs > 60000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'totalTimeoutMs must be an integer from 100 to 60000.' });
        const scenarioDeadline = Date.now() + totalTimeoutMs;
        const steps = Array.from(args.steps, (step, index) => {
            if (step?.operation === 'nodeObserve' || step?.operation === 'nodeAssert' || step?.operation === 'nodeWait') {
                if (Object.keys(step).some(key => !['operation', 'nodeReference', 'siblingIndex', 'minChildCount', 'maxChildCount', 'parentUuid', 'scale', 'rotation', 'position', 'active', 'activeInHierarchy', 'timeoutMs'].includes(key)) || !step.nodeReference || typeof step.nodeReference !== 'object' || Array.isArray(step.nodeReference) || Object.keys(step.nodeReference).some(key => key !== 'id')
                    || typeof step.nodeReference.id !== 'string' || !step.nodeReference.id.trim() || step.nodeReference.id.length > 256
                    || step.active !== undefined && typeof step.active !== 'boolean' || step.activeInHierarchy !== undefined && typeof step.activeInHierarchy !== 'boolean'
                    || step.position !== undefined && (step.operation === 'nodeObserve' || !step.position || typeof step.position !== 'object' || Array.isArray(step.position) || Object.keys(step.position).some(key => !['space', 'x', 'y', 'z', 'tolerance'].includes(key)) || !['local', 'world'].includes(step.position.space) || [step.position.x, step.position.y, step.position.z, step.position.tolerance].some(value => typeof value !== 'number' || !Number.isFinite(value)) || step.position.tolerance < 0 || step.position.tolerance > 1000000)
                    || step.rotation !== undefined && (step.operation === 'nodeObserve' || !step.rotation || typeof step.rotation !== 'object' || Array.isArray(step.rotation) || Object.keys(step.rotation).some(key => !['space', 'x', 'y', 'z', 'w', 'toleranceDegrees'].includes(key)) || !['local', 'world'].includes(step.rotation.space) || [step.rotation.x, step.rotation.y, step.rotation.z, step.rotation.w, step.rotation.toleranceDegrees].some(value => typeof value !== 'number' || !Number.isFinite(value)) || Math.max(Math.abs(step.rotation.x), Math.abs(step.rotation.y), Math.abs(step.rotation.z), Math.abs(step.rotation.w)) === 0 || step.rotation.toleranceDegrees < 0 || step.rotation.toleranceDegrees > 180)
                    || step.scale !== undefined && (step.operation === 'nodeObserve' || !step.scale || typeof step.scale !== 'object' || Array.isArray(step.scale) || Object.keys(step.scale).some(key => !['x', 'y', 'z', 'tolerance'].includes(key)) || [step.scale.x, step.scale.y, step.scale.z, step.scale.tolerance].some(value => typeof value !== 'number' || !Number.isFinite(value)) || step.scale.tolerance < 0 || step.scale.tolerance > 1000000)
                    || step.parentUuid !== undefined && (step.operation === 'nodeObserve' || step.parentUuid !== null && (typeof step.parentUuid !== 'string' || !step.parentUuid.trim() || step.parentUuid.length > 256 || step.parentUuid === step.nodeReference.id))
                    || [step.minChildCount, step.maxChildCount].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0 || n > 9999)) || step.minChildCount !== undefined && step.maxChildCount !== undefined && step.minChildCount > step.maxChildCount
                    || step.siblingIndex !== undefined && step.siblingIndex !== null && (!Number.isSafeInteger(step.siblingIndex) || step.siblingIndex < 0 || step.siblingIndex > 9999)
                    || (step.operation === 'nodeObserve' ? step.active !== undefined || step.activeInHierarchy !== undefined || step.position !== undefined || step.rotation !== undefined || step.scale !== undefined || step.parentUuid !== undefined || step.minChildCount !== undefined || step.maxChildCount !== undefined || step.siblingIndex !== undefined : step.active === undefined && step.activeInHierarchy === undefined && step.position === undefined && step.rotation === undefined && step.scale === undefined && step.parentUuid === undefined && step.minChildCount === undefined && step.maxChildCount === undefined && step.siblingIndex === undefined)
                    || step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > (step.operation === 'nodeWait' ? 10000 : 3000))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Invalid node checkpoint step ${index}.` });
                return { ...step, ...(step.position ? { position: { ...step.position } } : {}), ...(step.rotation ? { rotation: { ...step.rotation } } : {}), ...(step.scale ? { scale: { ...step.scale } } : {}), nodeReference: { id: step.nodeReference.id } };
            }
            if (step?.operation === 'graphObserve') {
                if (Object.keys(step).some(key => !['operation', 'nodeReference', 'componentId', 'graphUuid', 'timeoutMs'].includes(key)) || !step.nodeReference || typeof step.nodeReference !== 'object' || Array.isArray(step.nodeReference) || Object.keys(step.nodeReference).some(key => key !== 'id')
                    || [step.nodeReference?.id, step.componentId, step.graphUuid].some(value => typeof value !== 'string' || !value.trim() || value.length > 256)
                    || step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > 3000)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Invalid graph observation step ${index}.` });
                return { ...step, nodeReference: { id: step.nodeReference!.id } };
            }
            if (step?.operation === 'graphAssert' || step?.operation === 'graphWait' || step?.operation === 'graphSet') {
                if (Object.keys(step).some(key => !['operation', 'nodeReference', 'componentId', 'graphUuid', 'variableName', 'variableType', 'variableRange', 'variableValue', 'expectedValue', 'timeoutMs'].includes(key))
                    || !step.nodeReference || typeof step.nodeReference !== 'object' || Array.isArray(step.nodeReference) || Object.keys(step.nodeReference).some(key => key !== 'id')
                    || [step.nodeReference?.id, step.componentId, step.graphUuid, step.variableName].some(value => typeof value !== 'string' || !value.trim() || value.length > 256)
                    || !['float', 'integer', 'boolean'].includes(step.variableType ?? '')
                    || (step.variableRange === undefined ? (step.variableType === 'boolean' ? typeof step.variableValue !== 'boolean' : typeof step.variableValue !== 'number' || !Number.isFinite(step.variableValue) || step.variableType === 'integer' && !Number.isInteger(step.variableValue)) : step.operation === 'graphSet' || step.variableValue !== undefined || step.variableType === 'boolean' || !step.variableRange || typeof step.variableRange !== 'object' || Array.isArray(step.variableRange) || Object.keys(step.variableRange).some(key => key !== 'min' && key !== 'max') || [step.variableRange.min, step.variableRange.max].some(value => typeof value !== 'number' || !Number.isFinite(value) || step.variableType === 'integer' && !Number.isInteger(value)) || step.variableRange.min > step.variableRange.max)
                    || step.expectedValue !== undefined && (step.operation !== 'graphSet' || (step.variableType === 'boolean' ? typeof step.expectedValue !== 'boolean' : typeof step.expectedValue !== 'number' || !Number.isFinite(step.expectedValue) || step.variableType === 'integer' && !Number.isInteger(step.expectedValue)))
                    || step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > (step.operation === 'graphWait' ? 10000 : 3000))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Invalid graph variable wait step ${index}.` });
                return { ...step, ...(step.variableRange ? { variableRange: { ...step.variableRange } } : {}), nodeReference: { id: step.nodeReference!.id } };
            }
            if (step?.operation === 'delay') {
                if (Object.keys(step).some(key => !['operation', 'durationMs'].includes(key)) || !Number.isInteger(step.durationMs) || step.durationMs! < 0 || step.durationMs! > 5000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Delay step ${index} requires durationMs0..5000 and no target or predicates.` });
                return { ...step };
            }
            if (step && ['particleControl', 'particleObserve', 'particleAssert', 'particleWait'].includes(step.operation)) {
                const predicates = step.operation === 'particleAssert' || step.operation === 'particleWait';
                if (Object.keys(step).some(key => !['operation', 'nodeReference', 'componentId', 'particleOperation', 'playing', 'minParticleCount', 'maxParticleCount', 'timeoutMs'].includes(key))
                    || !step.nodeReference || typeof step.nodeReference !== 'object' || Array.isArray(step.nodeReference) || Object.keys(step.nodeReference).some(key => key !== 'id')
                    || [step.nodeReference?.id, step.componentId].some(value => typeof value !== 'string' || !value.trim() || value.length > 256)
                    || (step.operation === 'particleControl' ? !['play', 'stop', 'clear'].includes(step.particleOperation ?? '') : step.particleOperation !== undefined)
                    || (predicates ? step.playing === undefined && step.minParticleCount === undefined && step.maxParticleCount === undefined : step.playing !== undefined || step.minParticleCount !== undefined || step.maxParticleCount !== undefined)
                    || step.playing !== undefined && typeof step.playing !== 'boolean'
                    || step.minParticleCount !== undefined && (!Number.isInteger(step.minParticleCount) || step.minParticleCount < 0 || step.minParticleCount > 1000000)
                    || step.minParticleCount !== undefined && step.maxParticleCount !== undefined && step.minParticleCount > step.maxParticleCount
                    || step.maxParticleCount !== undefined && (!Number.isInteger(step.maxParticleCount) || step.maxParticleCount < 0 || step.maxParticleCount > 1000000)
                    || step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > (step.operation === 'particleWait' ? 10000 : 3000))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Invalid particle scenario step ${index}.` });
                return { ...step, nodeReference: { id: step.nodeReference!.id } };
            }
            if (step && ['animationEvents', 'animationControl', 'animationObserve', 'animationAssert', 'animationWait'].includes(step.operation)) {
                const invalid = Object.keys(step).some(key => !['operation', 'nodeReference', 'expectedEventSequence', 'minEventCount', 'expectedEvent', 'maxEvents', 'animationOperation', 'componentId', 'clipName', 'clipUuid', 'minDuration', 'maxDuration', 'minSpeed', 'maxSpeed', 'playing', 'paused', 'maxTime', 'minTime', 'timeoutMs'].includes(key))
                    || !step.nodeReference || typeof step.nodeReference !== 'object' || Array.isArray(step.nodeReference) || Object.keys(step.nodeReference).some(key => key !== 'id')
                    || [step.nodeReference?.id, step.componentId, step.clipName, step.clipUuid].some(value => typeof value !== 'string' || !value.trim() || value.length > 256)
                    || step.playing !== undefined && typeof step.playing !== 'boolean' || step.paused !== undefined && typeof step.paused !== 'boolean'
                    || step.minTime !== undefined && (typeof step.minTime !== 'number' || !Number.isFinite(step.minTime) || step.minTime < 0 || step.minTime > 3600)
                    || step.maxTime !== undefined && (typeof step.maxTime !== 'number' || !Number.isFinite(step.maxTime) || step.maxTime < 0 || step.maxTime > 3600 || step.minTime !== undefined && step.minTime > step.maxTime)
                    || [step.minSpeed, step.maxSpeed].some(value => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1000000)) || step.minSpeed !== undefined && step.maxSpeed !== undefined && step.minSpeed > step.maxSpeed
                    || [step.minDuration, step.maxDuration].some(value => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86400)) || step.minDuration !== undefined && step.maxDuration !== undefined && step.minDuration > step.maxDuration
                    || step.maxEvents !== undefined && (step.operation !== 'animationEvents' || !Number.isInteger(step.maxEvents) || step.maxEvents < 1 || step.maxEvents > 100)
                    || step.expectedEvent !== undefined && (step.operation !== 'animationEvents' || !['play', 'pause', 'resume', 'stop', 'lastframe', 'finished'].includes(step.expectedEvent))
                    || step.minEventCount !== undefined && (step.operation !== 'animationEvents' || step.expectedEvent === undefined || !Number.isInteger(step.minEventCount) || step.minEventCount < 1 || step.minEventCount > (step.maxEvents ?? 20))
                    || step.expectedEventSequence !== undefined && (step.operation !== 'animationEvents' || step.expectedEvent !== undefined || step.minEventCount !== undefined || !Array.isArray(step.expectedEventSequence) || step.expectedEventSequence.length < 1 || step.expectedEventSequence.length > (step.maxEvents ?? 20) || step.expectedEventSequence.findIndex(event => !['play', 'pause', 'resume', 'stop', 'lastframe', 'finished'].includes(event)) >= 0)
                    || step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > (step.operation === 'animationWait' ? 10000 : 3000))
                    || (step.operation === 'animationControl' ? !['play', 'pause', 'resume', 'stop'].includes(step.animationOperation ?? '') : step.animationOperation !== undefined)
                    || ((step.operation === 'animationEvents' || step.operation === 'animationObserve' || step.operation === 'animationControl') ? step.playing !== undefined || step.paused !== undefined || step.minTime !== undefined || step.maxTime !== undefined || step.minSpeed !== undefined || step.maxSpeed !== undefined || step.minDuration !== undefined || step.maxDuration !== undefined : step.playing === undefined && step.paused === undefined && step.minTime === undefined && step.maxTime === undefined && step.minSpeed === undefined && step.maxSpeed === undefined && step.minDuration === undefined && step.maxDuration === undefined);
                if (invalid) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Invalid animation scenario step ${index}.` });
                return { ...step, ...(step.expectedEventSequence ? { expectedEventSequence: [...step.expectedEventSequence] } : {}), nodeReference: { id: step.nodeReference!.id } };
            }
            if (!step || typeof step !== 'object' || Array.isArray(step)
                || Object.keys(step).some(key => !['operation', 'nodeReference', 'expectedComponentUuid', 'expectedClipUuid', 'audioOperation', 'time', 'playing', 'minDuration', 'maxDuration', 'minVolume', 'maxVolume', 'loop', 'userActivation', 'loaded', 'playbackState', 'maxTime', 'minTime', 'paused', 'maxFrameCount', 'minFrameCount', 'timeoutMs'].includes(key))
                || !['wait', 'assert', 'observe', 'audioObserve', 'audioAssert', 'audioControl', 'audioWait', 'pause', 'resume', 'step'].includes(step.operation)
                || ['wait', 'assert'].includes(step.operation) && step.paused === undefined && step.minFrameCount === undefined && step.maxFrameCount === undefined
                || ['observe', 'audioObserve', 'audioAssert', 'audioControl', 'audioWait', 'pause', 'resume', 'step'].includes(step.operation) && (step.paused !== undefined || step.minFrameCount !== undefined || step.maxFrameCount !== undefined)
                || (step.operation === 'audioControl'
                    ? !step.audioOperation || !['play', 'pause', 'stop', 'seek'].includes(step.audioOperation) || (step.audioOperation === 'seek' ? !Number.isFinite(step.time) || step.time! < 0 : step.time !== undefined) || step.timeoutMs !== undefined && step.timeoutMs > 5000
                    : step.audioOperation !== undefined || step.time !== undefined)
                || (['audioAssert', 'audioWait'].includes(step.operation)
                    ? step.playing === undefined && step.loaded === undefined && step.loop === undefined && step.minVolume === undefined && step.maxVolume === undefined && step.playbackState === undefined && step.minTime === undefined && step.maxTime === undefined && step.userActivation === undefined && step.minDuration === undefined && step.maxDuration === undefined || step.playing !== undefined && typeof step.playing !== 'boolean' || step.loaded !== undefined && typeof step.loaded !== 'boolean' || step.loop !== undefined && typeof step.loop !== 'boolean'
                    : step.playing !== undefined || step.loaded !== undefined || step.loop !== undefined || step.minVolume !== undefined || step.maxVolume !== undefined || step.playbackState !== undefined || step.minTime !== undefined || step.maxTime !== undefined || step.userActivation !== undefined || step.minDuration !== undefined || step.maxDuration !== undefined)
                || step.playbackState !== undefined && !['init', 'playing', 'paused', 'stopped', 'interrupted'].includes(step.playbackState)
                || step.userActivation !== undefined && !['active', 'inactive', 'unknown'].includes(step.userActivation)
                || step.minTime !== undefined && (typeof step.minTime !== 'number' || !Number.isFinite(step.minTime) || step.minTime < 0 || step.minTime > 3600)
                || step.maxTime !== undefined && (typeof step.maxTime !== 'number' || !Number.isFinite(step.maxTime) || step.maxTime < 0 || step.maxTime > 3600 || step.minTime !== undefined && step.minTime > step.maxTime)
                || [step.minVolume, step.maxVolume].some(n => n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) || step.minVolume !== undefined && step.maxVolume !== undefined && step.minVolume > step.maxVolume
                || [step.minDuration, step.maxDuration].some(value => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86400)) || step.minDuration !== undefined && step.maxDuration !== undefined && step.minDuration > step.maxDuration
                || (['audioObserve', 'audioAssert', 'audioControl', 'audioWait'].includes(step.operation)
                    ? !step.nodeReference || typeof step.nodeReference !== 'object' || Array.isArray(step.nodeReference) || Object.keys(step.nodeReference).some(key => key !== 'id') || typeof step.nodeReference.id !== 'string' || !step.nodeReference.id.trim() || step.nodeReference.id.length > 256
                    : step.nodeReference !== undefined)
                || [step.expectedComponentUuid, step.expectedClipUuid].some(value => value !== undefined && (!['audioObserve', 'audioAssert', 'audioControl', 'audioWait'].includes(step.operation) || typeof value !== 'string' || !value.trim() || value.length > 256))
                || step.paused !== undefined && typeof step.paused !== 'boolean'
                || step.minFrameCount !== undefined && (!Number.isInteger(step.minFrameCount) || step.minFrameCount < 0 || step.minFrameCount > 1000000000)
                || step.maxFrameCount !== undefined && (!Number.isSafeInteger(step.maxFrameCount) || step.maxFrameCount < 0 || step.maxFrameCount > 1000000000 || step.minFrameCount !== undefined && step.minFrameCount > step.maxFrameCount)
                || step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > 10000)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Invalid runtime scenario step ${index}.` });
            return { ...step, ...(step.nodeReference ? { nodeReference: { id: step.nodeReference.id } } : {}) };
        });
        args = { ...args, steps };
        if (activeScenarios.has(args.sessionId)) throw new ToolError({ code: 'RUNTIME_SCENARIO_BUSY', status: 409, message: 'A scenario or its timed-out request still owns this session; no steps dispatched.' });
        let cancel!: () => void;
        const cancellation = new Promise<void>(resolve => { cancel = resolve; });
        const scenario = { cancelled: false, cancel, runId: args.runId ?? randomUUID(), stepIndex: null as number | null, operation: null as string | null, completedSteps: 0, requestPending: false, callerFinished: false };
        activeScenarios.set(args.sessionId, scenario);
        const assertActive = () => { if (scenario.cancelled) throw new ToolError({ code: 'RUNTIME_SCENARIO_CANCELLED', status: 409, message: 'Scenario cancelled; no further operation dispatched.' }); };
        let inFlight: Promise<unknown> | undefined;
        const waitForSettlement = async (request: Promise<unknown>): Promise<void> => {
            try { await request; }
            catch (error) {
                const native = error instanceof ToolError ? (error as ToolError & { pendingRequest?: Promise<unknown> }).pendingRequest : undefined;
                // A rejected timeout wrapper is not completion of its queued renderer work.
                if (native && native !== request) await waitForSettlement(native);
            }
        };
        try {
        const outcomes: Array<Record<string, unknown>> = [];
        for (let index = 0; index < steps.length; index++) {
            const step = steps[index];
            if (scenario.cancelled) throw new ToolError({ code: 'RUNTIME_SCENARIO_CANCELLED', status: 409, message: 'Scenario cancelled; no next step dispatched.', details: { sessionId: args.sessionId, runId: scenario.runId, failedStep: index, outcomes } });
            if (Date.now() >= scenarioDeadline) throw new ToolError({ code: 'RUNTIME_SCENARIO_TIMEOUT', status: 409, message: `Runtime scenario deadline elapsed before step ${index}.`, details: { sessionId: args.sessionId, runId: scenario.runId, failedStep: index, outcomes } });
            const remaining = Math.min(10000, scenarioDeadline - Date.now());
            if (!['assert', 'observe', 'audioObserve', 'audioAssert'].includes(step.operation) && remaining < 100) throw new ToolError({ code: 'RUNTIME_SCENARIO_TIMEOUT', status: 409, message: 'Scenario has insufficient remaining time for a bounded primitive; no next step dispatched.', details: { sessionId: args.sessionId, runId: scenario.runId, failedStep: index, outcomes } });
            try {
                const stepDeadline = Math.min(scenarioDeadline, Date.now() + (step.operation === 'animationEvents' ? (step.timeoutMs ?? 3000) + 2000 : step.timeoutMs ?? 10000));
                scenario.stepIndex = index; scenario.operation = step.operation;
                const delay = async (): Promise<Record<string, unknown>> => {
                    const start = Date.now(), end = start + step.durationMs!;
                    if (end >= stepDeadline) throw new ToolError({ code: 'RUNTIME_SCENARIO_TIMEOUT', status: 409, message: 'Cue delay cannot fit the remaining scenario deadline.' });
                    while (Date.now() < end) {
                        if (scenario.cancelled) throw new ToolError({ code: 'RUNTIME_SCENARIO_CANCELLED', status: 409, message: 'Scenario cancelled during cue delay.' });
                        await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, end - Date.now())));
                        if (Date.now() >= stepDeadline) throw new ToolError({ code: 'RUNTIME_SCENARIO_TIMEOUT', status: 409, message: 'Cue delay exceeded its deadline.' });
                    }
                    return { durationMs: step.durationMs, elapsedMs: Date.now() - start, timingScope: 'wall-clock', runtimeVerified: false };
                };
                const pending = step.operation === 'delay' ? delay() : step.operation === 'wait'
                    ? this.runtimeWaitForState({ sessionId: args.sessionId, paused: step.paused, maxFrameCount: step.maxFrameCount, minFrameCount: step.minFrameCount, timeoutMs: Math.min(step.timeoutMs ?? 10000, remaining) }, assertActive)
                    : step.operation === 'assert'
                        ? this.runtimeScenarioAssert({ sessionId: args.sessionId, paused: step.paused, maxFrameCount: step.maxFrameCount, minFrameCount: step.minFrameCount })
                        : step.operation === 'observe'
                            ? this.runtimeStateObserve({ sessionId: args.sessionId })
                            : step.operation === 'nodeObserve' || step.operation === 'nodeAssert' || step.operation === 'nodeWait'
                                ? import('./runtime-tools').then(async ({ RuntimeTools }) => {
                                    if (scenario.cancelled) throw new ToolError({ code: 'RUNTIME_SCENARIO_CANCELLED', status: 409, message: 'Scenario cancelled before node checkpoint.' });
                                    const timeoutMs = Math.min(step.timeoutMs ?? (step.operation === 'nodeWait' ? 10000 : 3000), stepDeadline - Date.now());
                                    if (timeoutMs < 100) throw new ToolError({ code: 'RUNTIME_SCENARIO_TIMEOUT', status: 409, message: 'Node checkpoint deadline elapsed before dispatch.' });
                                    const nodes = new RuntimeTools();
                                    const target = { sessionId: args.sessionId, nodeReference: step.nodeReference!, timeoutMs };
                                    if (step.operation === 'nodeWait') return nodes.runtimeNodeWaitForState({ ...target, siblingIndex: step.siblingIndex, minChildCount: step.minChildCount, maxChildCount: step.maxChildCount, parentUuid: step.parentUuid, scale: step.scale, rotation: step.rotation, position: step.position, active: step.active, activeInHierarchy: step.activeInHierarchy }, assertActive);
                                    const observation = await nodes.runtimeNodeObserve(target);
                                    if (step.operation === 'nodeObserve') return observation;
                                    if (typeof observation.active !== 'boolean' || typeof observation.activeInHierarchy !== 'boolean') throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Node activation metrics unavailable.' });
                                    if (step.parentUuid !== undefined && observation.parentUuid !== null && (typeof observation.parentUuid !== 'string' || !observation.parentUuid.trim() || observation.parentUuid.length > 256)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Observed parent identity unavailable.' });
                                    if ((step.minChildCount !== undefined || step.maxChildCount !== undefined) && (!Number.isSafeInteger(observation.childCount) || observation.childCount < 0 || observation.childCount > 9999)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Observed direct child count unavailable.' });
                                    if (step.siblingIndex !== undefined && (observation.siblingIndex === null ? observation.parentUuid !== null : !Number.isSafeInteger(observation.siblingIndex) || observation.siblingIndex < 0 || observation.siblingIndex > 9999 || typeof observation.parentUuid !== 'string' || !observation.parentUuid)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Observed sibling identity unavailable.' });
                                    const position = step.position;
                                    const actual = position?.space === 'world' ? observation.worldPosition : observation.position;
                                    if (position && (!actual || [actual.x, actual.y, actual.z].some(value => typeof value !== 'number' || !Number.isFinite(value)))) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Node position metrics unavailable.' });
                                    const positionMatched = !position || Math.abs(actual.x - position.x) <= position.tolerance && Math.abs(actual.y - position.y) <= position.tolerance && Math.abs(actual.z - position.z) <= position.tolerance;
                                    const rotation = step.rotation;
                                    const rotationMatched = !rotation || orientationMatches(rotation.space === 'world' ? observation.worldRotation : observation.rotation, unitQuaternion(rotation, 'INVALID_ARGUMENT'), rotation.toleranceDegrees);
                                    const scale = step.scale;
                                    if (scale && (!observation.scale || [observation.scale.x, observation.scale.y, observation.scale.z].some(value => typeof value !== 'number' || !Number.isFinite(value)))) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Local scale metrics unavailable.' });
                                    const scaleMatched = !scale || Math.abs(observation.scale.x - scale.x) <= scale.tolerance && Math.abs(observation.scale.y - scale.y) <= scale.tolerance && Math.abs(observation.scale.z - scale.z) <= scale.tolerance;
                                    return { ...observation, passed: (step.siblingIndex === undefined || observation.siblingIndex === step.siblingIndex) && (step.minChildCount === undefined || observation.childCount >= step.minChildCount) && (step.maxChildCount === undefined || observation.childCount <= step.maxChildCount) && (step.parentUuid === undefined || observation.parentUuid === step.parentUuid) && scaleMatched && rotationMatched && positionMatched && (step.active === undefined || observation.active === step.active) && (step.activeInHierarchy === undefined || observation.activeInHierarchy === step.activeInHierarchy) };
                                })
                            : step.operation === 'graphObserve' || step.operation === 'graphAssert' || step.operation === 'graphWait' || step.operation === 'graphSet'
                                ? import('./component-runtime-tools').then(async ({ ComponentRuntimeTools }) => {
                                    if (scenario.cancelled) throw new ToolError({ code: 'RUNTIME_SCENARIO_CANCELLED', status: 409, message: 'Scenario cancelled before graph wait dispatch.' });
                                    const timeoutMs = Math.min(step.timeoutMs ?? (step.operation === 'graphWait' ? 10000 : 3000), stepDeadline - Date.now());
                                    if (timeoutMs < 100) throw new ToolError({ code: 'RUNTIME_SCENARIO_TIMEOUT', status: 409, message: 'Graph wait deadline elapsed before dispatch.' });
                                    if (step.operation === 'graphSet') return new ComponentRuntimeTools().animationGraphPreview({ sessionId: args.sessionId, nodeReference: step.nodeReference!, componentId: step.componentId!, operation: 'setVariable', expectedGraphUuid: step.graphUuid!, variable: { name: step.variableName!, type: step.variableType!, value: step.variableValue!, expectedValue: step.expectedValue }, timeoutMs }, assertActive, stepDeadline);
                                    if (step.operation === 'graphObserve' || step.operation === 'graphAssert') {
                                        const result = await new ComponentRuntimeTools().animationGraphPreview({ sessionId: args.sessionId, nodeReference: step.nodeReference!, componentId: step.componentId!, operation: 'inspect', expectedGraphUuid: step.graphUuid!, timeoutMs });
                                        if (result.graphUuid !== step.graphUuid) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Graph checkpoint identity changed.' });
                                        if (step.operation === 'graphObserve') return result;
                                        validateGraphVariableInventory(result.variables);
                                        const matches = result.variables.filter(variable => variable.name === step.variableName);
                                        if (matches.length !== 1) throw new ToolError({ code: 'GRAPH_VARIABLE_NOT_FOUND', status: 404, message: 'Expected one exact graph variable.' });
                                        const variable = matches[0];
                                        const nativeType = step.variableType === 'boolean' ? 1 : step.variableType === 'integer' ? 3 : 0;
                                        if (variable.type !== nativeType || (step.variableType === 'boolean' ? typeof variable.value !== 'boolean' : typeof variable.value !== 'number' || !Number.isFinite(variable.value) || step.variableType === 'integer' && !Number.isInteger(variable.value))) throw new ToolError({ code: 'UNSUPPORTED_GRAPH_VARIABLE', status: 422, message: 'Observed graph variable type/metric differs from checkpoint.' });
                                        return { ...result, passed: step.variableRange === undefined ? variable.value === step.variableValue : (variable.value as number) >= step.variableRange.min && (variable.value as number) <= step.variableRange.max };
                                    }
                                    return new ComponentRuntimeTools().animationGraphWaitForVariable({ sessionId: args.sessionId, nodeReference: step.nodeReference!, componentId: step.componentId!, graphUuid: step.graphUuid!, name: step.variableName!, type: step.variableType!, value: step.variableValue, range: step.variableRange, timeoutMs }, assertActive);
                                })
                            : step.operation === 'particleControl' || step.operation === 'particleObserve' || step.operation === 'particleAssert' || step.operation === 'particleWait'
                                ? import('./p4-contract-tools').then(async ({ P4ContractTools }) => {
                                    if (scenario.cancelled) throw new ToolError({ code: 'RUNTIME_SCENARIO_CANCELLED', status: 409, message: 'Scenario cancelled before particle dispatch.' });
                                    const timeoutMs = Math.min(step.timeoutMs ?? (step.operation === 'particleWait' ? 10000 : 3000), stepDeadline - Date.now());
                                    if (timeoutMs < 100) throw new ToolError({ code: 'RUNTIME_SCENARIO_TIMEOUT', status: 409, message: 'Particle deadline elapsed before dispatch.' });
                                    const particles = new P4ContractTools();
                                    const target = { sessionId: args.sessionId, nodeReference: step.nodeReference!, componentId: step.componentId!, timeoutMs };
                                    if (step.operation === 'particleWait') {
                                        const result = await particles.particleWaitForState({ ...target, playing: step.playing, minParticleCount: step.minParticleCount, maxParticleCount: step.maxParticleCount }, assertActive);
                                        return { ...result, passed: result.matched === true };
                                    }
                                    const result = await particles.particlePlayback({ ...target, operation: step.operation === 'particleControl' ? step.particleOperation! : 'inspect' }, assertActive, step.operation === 'particleControl' ? stepDeadline : undefined);
                                    if (step.operation !== 'particleAssert') return result;
                                    const state = result.state as { playing?: unknown; particleCount?: unknown } | undefined;
                                    if (!state || typeof state.playing !== 'boolean' || typeof state.particleCount !== 'number' || !Number.isSafeInteger(state.particleCount) || state.particleCount < 0) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Particle assertion requires typed state/count metrics.' });
                                    return { ...result, passed: (step.playing === undefined || state.playing === step.playing) && (step.minParticleCount === undefined || state.particleCount >= step.minParticleCount) && (step.maxParticleCount === undefined || state.particleCount <= step.maxParticleCount) };
                                })
                            : step.operation === 'animationEvents' || step.operation === 'animationControl' || step.operation === 'animationObserve' || step.operation === 'animationAssert' || step.operation === 'animationWait'
                                ? import('./component-runtime-tools').then(async ({ ComponentRuntimeTools }) => {
                                    if (scenario.cancelled) throw new ToolError({ code: 'RUNTIME_SCENARIO_CANCELLED', status: 409, message: 'Scenario cancelled before animation dispatch.' });
                                    const timeoutMs = Math.min(step.timeoutMs ?? (step.operation === 'animationWait' ? 10000 : 3000), stepDeadline - Date.now());
                                    if (timeoutMs < 100) throw new ToolError({ code: 'RUNTIME_SCENARIO_TIMEOUT', status: 409, message: 'Animation deadline elapsed before dispatch.' });
                                    const animation = new ComponentRuntimeTools();
                                    const target = { sessionId: args.sessionId, nodeReference: step.nodeReference!, componentId: step.componentId!, clipName: step.clipName!, clipUuid: step.clipUuid!, timeoutMs };
                                    if (step.operation === 'animationEvents') {
                                        const capture = await animation.animationPlaybackEvents({ ...target, timeoutMs: step.timeoutMs ?? 3000, maxEvents: step.maxEvents }, assertActive, stepDeadline);
                                        if (step.expectedEvent === undefined && step.expectedEventSequence === undefined) return capture;
                                        if (!Array.isArray(capture.events) || capture.events.length > (step.maxEvents ?? 20) || capture.events.findIndex((event, index) => !event || typeof event !== 'object' || Array.isArray(event) || !['play', 'pause', 'resume', 'stop', 'lastframe', 'finished'].includes(event.type) || event.clipUuid !== step.clipUuid || event.clipName !== step.clipName || event.sequence !== index + 1) >= 0) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Animation event checkpoint requires bounded sequential events for the exact requested clip.' });
                                        let previousElapsedMs = 0;
                                        for (const event of capture.events) {
                                            if (typeof event.elapsedMs !== 'number' || !Number.isFinite(event.elapsedMs) || event.elapsedMs < previousElapsedMs) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Animation event checkpoint requires finite nonnegative nondecreasing capture times.' });
                                            previousElapsedMs = event.elapsedMs;
                                        }
                                        if (step.expectedEventSequence !== undefined) {
                                            let matchedSequenceLength = 0;
                                            for (const event of capture.events) if (matchedSequenceLength < step.expectedEventSequence.length && event.type === step.expectedEventSequence[matchedSequenceLength]) matchedSequenceLength++;
                                            return { ...capture, expectedEventSequence: step.expectedEventSequence, matchedSequenceLength, passed: matchedSequenceLength === step.expectedEventSequence.length };
                                        }
                                        let matchedEventCount = 0;
                                        for (const event of capture.events) if (event.type === step.expectedEvent) matchedEventCount++;
                                        return { ...capture, expectedEvent: step.expectedEvent, minEventCount: step.minEventCount ?? 1, matchedEventCount, passed: matchedEventCount >= (step.minEventCount ?? 1) };
                                    }
                                    if (step.operation === 'animationControl') return animation.animationPlaybackControl({ ...target, operation: step.animationOperation! }, assertActive, stepDeadline);
                                    if (step.operation === 'animationWait') {
                                        const result = await animation.animationPlaybackWaitForState({ ...target, minDuration: step.minDuration, maxDuration: step.maxDuration, minSpeed: step.minSpeed, maxSpeed: step.maxSpeed, playing: step.playing, paused: step.paused, maxTime: step.maxTime, minTime: step.minTime }, assertActive);
                                        return { ...result, passed: result.matched === true };
                                    }
                                    const observation = await animation.animationPlaybackObserve(target);
                                    if (step.operation === 'animationObserve') return observation;
                                    const state = observation.state as { playing?: unknown; paused?: unknown; speed?: unknown; duration?: unknown; time?: unknown } | undefined;
                                    if (!state || typeof state.playing !== 'boolean' || typeof state.paused !== 'boolean' || (step.minTime !== undefined || step.maxTime !== undefined) && (typeof state.time !== 'number' || !Number.isFinite(state.time))) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Animation assertion requires available typed state metrics.' });
                                    if ((step.minSpeed !== undefined || step.maxSpeed !== undefined) && (typeof state.speed !== 'number' || !Number.isFinite(state.speed))) throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_METRIC', status: 422, message: 'Animation assertion speed is unavailable.' });
                                    if ((step.minDuration !== undefined || step.maxDuration !== undefined) && (typeof state.duration !== 'number' || !Number.isFinite(state.duration) || state.duration < 0)) throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_METRIC', status: 422, message: 'Animation assertion duration is unavailable.' });
                                    return { ...observation, passed: (step.minDuration === undefined || (state.duration as number) >= step.minDuration) && (step.maxDuration === undefined || (state.duration as number) <= step.maxDuration) && (step.minSpeed === undefined || (state.speed as number) >= step.minSpeed) && (step.maxSpeed === undefined || (state.speed as number) <= step.maxSpeed) && (step.playing === undefined || state.playing === step.playing) && (step.paused === undefined || state.paused === step.paused) && (step.minTime === undefined || (state.time as number) >= step.minTime) && (step.maxTime === undefined || (state.time as number) <= step.maxTime) };
                                })
                            : step.operation === 'audioObserve' || step.operation === 'audioAssert' || step.operation === 'audioControl' || step.operation === 'audioWait'
                                ? import('./audio-playback-tools').then(async ({ AudioPlaybackTools }) => {
                                    if (scenario.cancelled) throw new ToolError({ code: 'RUNTIME_SCENARIO_CANCELLED', status: 409, message: 'Scenario cancelled before audio dispatch.' });
                                    const audio = new AudioPlaybackTools();
                                    const target = { sessionId: args.sessionId, nodeReference: step.nodeReference!, expectedComponentUuid: step.expectedComponentUuid, expectedClipUuid: step.expectedClipUuid };
                                    const timeoutMs = Math.min(step.timeoutMs ?? (step.operation === 'audioControl' ? 5000 : 10000), stepDeadline - Date.now());
                                    if (Date.now() >= stepDeadline || (step.operation === 'audioControl' || step.operation === 'audioWait') && timeoutMs < 100) throw new ToolError({ code: 'RUNTIME_SCENARIO_TIMEOUT', status: 409, message: 'Audio step deadline elapsed before dispatch; no audio operation sent.' });
                                    if (step.operation === 'audioControl') return audio.audioPlaybackControl({ ...target, operation: step.audioOperation!, time: step.time, timeoutMs }, assertActive, stepDeadline);
                                    if (step.operation === 'audioWait') return audio.audioPlaybackWaitForState({ ...target, minDuration: step.minDuration, maxDuration: step.maxDuration, userActivation: step.userActivation, playing: step.playing, minVolume: step.minVolume, maxVolume: step.maxVolume, loop: step.loop, loaded: step.loaded, playbackState: step.playbackState, maxTime: step.maxTime, minTime: step.minTime, timeoutMs }, assertActive);
                                    const observation = await audio.audioPlaybackObserve(target);
                                    if (step.operation !== 'audioAssert') return observation;
                                    if (step.playbackState !== undefined && !['init', 'playing', 'paused', 'stopped', 'interrupted'].includes(observation.state.playbackState) || (step.minTime !== undefined || step.maxTime !== undefined) && (typeof observation.state.currentTime !== 'number' || !Number.isFinite(observation.state.currentTime) || observation.state.currentTime < 0)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Audio assertion requires available typed playback/time metrics.' });
                                    if (step.loop !== undefined && typeof observation.state.loop !== 'boolean') throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_METRIC', status: 422, message: 'Native looping state unavailable.' });
                                    if ((step.minVolume !== undefined || step.maxVolume !== undefined) && (typeof observation.state.volume !== 'number' || !Number.isFinite(observation.state.volume) || observation.state.volume < 0 || observation.state.volume > 1)) throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_METRIC', status: 422, message: 'Native source volume unavailable.' });
                                    if (step.userActivation !== undefined && !['active', 'inactive', 'unknown'].includes(observation.state.userActivation)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Audio activation metric is unavailable.' });
                                    if ((step.minDuration !== undefined || step.maxDuration !== undefined) && (typeof observation.state.duration !== 'number' || !Number.isFinite(observation.state.duration) || observation.state.duration < 0)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Audio duration metric is unavailable.' });
                                    return { ...observation, passed: (step.minDuration === undefined || observation.state.duration >= step.minDuration) && (step.maxDuration === undefined || observation.state.duration <= step.maxDuration) && (step.userActivation === undefined || observation.state.userActivation === step.userActivation) && (step.minVolume === undefined || observation.state.volume! >= step.minVolume) && (step.maxVolume === undefined || observation.state.volume! <= step.maxVolume) && (step.loop === undefined || observation.state.loop === step.loop) && (step.playing === undefined || observation.state.playing === step.playing) && (step.loaded === undefined || observation.state.loaded === step.loaded) && (step.playbackState === undefined || observation.state.playbackState === step.playbackState) && (step.minTime === undefined || observation.state.currentTime >= step.minTime) && (step.maxTime === undefined || observation.state.currentTime <= step.maxTime) };
                                })
                                : this.previewControl({ sessionId: args.sessionId, operation: step.operation, timeoutMs: Math.min(step.timeoutMs ?? 10000, remaining) });
                scenario.requestPending = true;
                const ownership: Promise<void> = waitForSettlement(pending).then(() => { if (inFlight === ownership) scenario.requestPending = false; });
                inFlight = ownership;
                const result: Record<string, unknown> = await withRuntimeStateTimeout<Record<string, unknown>>(Promise.race([pending as Promise<Record<string, unknown>>, cancellation.then(() => { throw new ToolError({ code: 'RUNTIME_SCENARIO_CANCELLED', status: 409, message: 'Scenario caller cancelled; pending primitive retains session ownership until settlement.', details: { nativeWorkCancelled: false, retrySafe: false, pendingMayComplete: scenario.requestPending } }); })]), stepDeadline);
                inFlight = undefined;
                scenario.requestPending = false;
                if (Date.now() >= stepDeadline) throw new ToolError({ code: 'RUNTIME_SCENARIO_TIMEOUT', status: 409, message: 'Scenario step completed after its deadline; inspect before retrying any action.' });
                outcomes.push({ index, operation: step.operation, result });
                scenario.completedSteps = outcomes.length;
                if (scenario.cancelled) throw new ToolError({ code: 'RUNTIME_SCENARIO_CANCELLED', status: 409, message: 'Scenario cancelled after the dispatched step settled; no subsequent step dispatched.' });
                if ('passed' in result && result.passed !== true) throw new ToolError({ code: 'RUNTIME_SCENARIO_ASSERTION_FAILED', status: 409, message: `Runtime scenario assertion failed at step ${index}.` });
            } catch (error) {
                const failure = new ToolError({ code: error instanceof ToolError ? error.code : 'RUNTIME_SCENARIO_FAILED', status: error instanceof ToolError ? error.status : 502,
                    message: error instanceof ToolError ? error.message : `Runtime scenario failed at step ${index}.`,
                    details: { sessionId: args.sessionId, runId: scenario.runId, failedStep: index, outcomes, ...(['graphSet', 'particleControl', 'animationControl', 'audioControl', 'pause', 'resume', 'step'].includes(step.operation) && (!(error instanceof ToolError) || error.details?.retrySafe !== true) ? { retrySafe: false, pendingMayComplete: scenario.requestPending } : {}), ...(error instanceof ToolError && error.details ? { cause: error.details, ...(error.details.retrySafe === false ? { retrySafe: false } : {}) } : {}) },
                    recovery: error instanceof ToolError ? error.recovery : undefined });
                const native = error instanceof ToolError ? (error as ToolError & { pendingRequest?: Promise<unknown> }).pendingRequest : undefined;
                if (native) Object.defineProperty(failure, 'pendingRequest', { value: native });
                throw failure;
            }
        }
        return { success: true, sessionId: args.sessionId, runId: scenario.runId, outcomes };
        } finally {
            scenario.callerFinished = true;
            if (inFlight) {
                // Timeout ends the caller wait, not ownership of the outstanding request.
                void inFlight.then(() => activeScenarios.delete(args.sessionId), () => activeScenarios.delete(args.sessionId));
            } else {
                activeScenarios.delete(args.sessionId);
            }
        }
    }

    @utcpTool('runtimeScenarioInspect', 'Read current in-memory scenario ownership/progress without native calls. Inactive does not prove success or native completion; no historical results retained.', {
        type: 'object', additionalProperties: false, properties: { sessionId: { type: 'string', minLength: 1, maxLength: 64 }, runId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } }, required: ['sessionId', 'runId'],
    }, { type: 'object', properties: { sessionId: { type: 'string' }, runId: { type: 'string' }, active: { type: 'boolean' }, progress: { type: ['object', 'null'], properties: { stepIndex: { type: ['integer', 'null'] }, operation: { type: ['string', 'null'] }, completedSteps: { type: 'integer' }, requestPending: { type: 'boolean' }, callerFinished: { type: 'boolean' }, cancellationRequested: { type: 'boolean' } }, required: ['stepIndex', 'operation', 'completedSteps', 'requestPending', 'callerFinished', 'cancellationRequested'] } }, required: ['sessionId', 'runId', 'active', 'progress'] }, 'GET', ['runtime', 'scenario', 'inspect', 'read-only'])
    async runtimeScenarioInspect(args: { sessionId: string; runId: string }) {
        if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim() || args.sessionId.length > 64 || typeof args.runId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(args.runId)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Exact bounded sessionId and runId required.' });
        const scenario = activeScenarios.get(args.sessionId);
        if (scenario && scenario.runId !== args.runId) throw new ToolError({ code: 'RUNTIME_SCENARIO_IDENTITY_MISMATCH', status: 409, message: 'Inspection does not match the active run.' });
        return { sessionId: args.sessionId, runId: args.runId, active: !!scenario, progress: scenario ? { stepIndex: scenario.stepIndex, operation: scenario.operation, completedSteps: scenario.completedSteps, requestPending: scenario.requestPending, callerFinished: scenario.callerFinished, cancellationRequested: scenario.cancelled } : null };
    }

    @utcpTool(
        'runtimeScenarioCancel',
        'Request cooperative cancellation of the active scenario for an exact session. Does not cancel native work, release pending ownership, restore or replay actions.',
        { type: 'object', additionalProperties: false, properties: { sessionId: { type: 'string', minLength: 1, maxLength: 64 }, runId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } }, required: ['sessionId', 'runId'] },
        { type: 'object', additionalProperties: false, properties: { sessionId: { type: 'string' }, active: { type: 'boolean' }, cancellationRequested: { type: 'boolean' }, nativeWorkCancelled: { type: 'boolean', const: false } }, required: ['sessionId', 'active', 'cancellationRequested', 'nativeWorkCancelled'] },
        'POST', ['runtime', 'scenario', 'cancel']
    )
    async runtimeScenarioCancel(args: { sessionId: string, runId: string }): Promise<{ sessionId: string, active: boolean, cancellationRequested: boolean, nativeWorkCancelled: false }> {
        if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim() || args.sessionId.length > 64) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'A bounded runtime sessionId is required.' });
        if (typeof args.runId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(args.runId)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'An exact bounded runId is required.' });
        const scenario = activeScenarios.get(args.sessionId);
        if (scenario && scenario.runId !== args.runId) throw new ToolError({ code: 'RUNTIME_SCENARIO_IDENTITY_MISMATCH', status: 409, message: 'Cancellation does not match the active run; no cancellation requested.' });
        if (scenario) { scenario.cancelled = true; scenario.cancel(); }
        return { sessionId: args.sessionId, active: !!scenario, cancellationRequested: !!scenario, nativeWorkCancelled: false };
    }
    @utcpTool(
        'runtimeScenarioAssert',
        'Assert bounded runtime state for an attached game-view session.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                sessionId: { type: 'string', minLength: 1, maxLength: 64 },
                paused: { type: 'boolean' },
                minFrameCount: { type: 'integer', minimum: 0, maximum: 1000000000 },
                maxFrameCount: { type: 'integer', minimum: 0, maximum: 1000000000 },
            },
            required: ['sessionId'],
        },
        {
            type: 'object',
            properties: { success: { type: 'boolean' }, sessionId: { type: 'string' }, passed: { type: 'boolean' }, state: { type: 'object' }, issues: { type: 'array' } },
            required: ['success', 'sessionId', 'passed', 'state', 'issues'],
        },
        'POST',
        ['runtime', 'scenario', 'assert', 'state'],
    )
    async runtimeScenarioAssert(args: { sessionId: string, paused?: boolean, maxFrameCount?: number; minFrameCount?: number }): Promise<{ success: true, sessionId: string, passed: boolean, state: RuntimeState, issues: string[] }> {
        if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim() || args.sessionId.length > 64 || args.paused === undefined && args.minFrameCount === undefined && args.maxFrameCount === undefined
            || args.maxFrameCount !== undefined && (!Number.isSafeInteger(args.maxFrameCount) || args.maxFrameCount < 0 || args.maxFrameCount > 1000000000 || args.minFrameCount !== undefined && args.minFrameCount > args.maxFrameCount)
            || args.paused !== undefined && typeof args.paused !== 'boolean' || args.minFrameCount !== undefined && (!Number.isSafeInteger(args.minFrameCount) || args.minFrameCount < 0 || args.minFrameCount > 1000000000)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide exact session and typed paused/minFrameCount assertion predicates.' });
        let session: RuntimeSession;
        try {
            session = store.inspect(args.sessionId);
        } catch (error) {
            if (error instanceof RuntimeSessionError) throw new ToolError({ code: error.code, status: error.code === 'SESSION_NOT_FOUND' ? 404 : 400, message: error.message });
            throw error;
        }
        if (session.status === 'stopped') throw new ToolError({ code: 'RUNTIME_SESSION_STOPPED', status: 409, message: `Runtime session is stopped: ${session.sessionId}`, recovery: 'Attach a new game-view session before asserting runtime state.' });
        if (session.targetKind !== 'game-view') throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_TRANSPORT', status: 422, message: `Runtime target ${session.targetKind} has no verified transport.` });
        args = { ...args };
        const observed = await this.inspect({ operation: 'inspect', sessionId: session.sessionId });
        if (!observed.state || !observed.ready) throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'Runtime assertion state unavailable.' });
        const state = observed.state;
        const issues: string[] = [];
        if (args.paused !== undefined && state.paused !== args.paused) issues.push(`paused expected ${args.paused} but was ${state.paused}`);
        if ((args.minFrameCount !== undefined || args.maxFrameCount !== undefined) && state.frameCount === null) throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_METRIC', status: 422, message: 'Game-view frame count is unavailable.' });
        if (args.minFrameCount !== undefined && state.frameCount !== null && state.frameCount < args.minFrameCount) issues.push(`frameCount expected at least ${args.minFrameCount} but was ${state.frameCount}`);
        if (args.maxFrameCount !== undefined && state.frameCount !== null && state.frameCount > args.maxFrameCount) issues.push(`frameCount expected at most ${args.maxFrameCount} but was ${state.frameCount}`);
        return { success: true, sessionId: session.sessionId, passed: issues.length === 0, state, issues };
    }
}
