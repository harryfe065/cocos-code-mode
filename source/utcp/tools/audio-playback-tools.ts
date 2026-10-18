import { JsonSchema } from '@utcp/sdk';
import { AudioPlaybackOperation, AudioPlaybackSuccess, createAudioPlaybackExecutor } from '../../audio-playback';
import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { executeGameViewOperation } from '../utils/game-view-transport';
import { RuntimeSessionTools } from './runtime-session-tools';

export interface AudioPlaybackObserveArgs { sessionId: string; nodeReference: { id: string }; expectedComponentUuid?: string; expectedClipUuid?: string }
export interface AudioPlaybackControlArgs extends AudioPlaybackObserveArgs {
    operation: Exclude<AudioPlaybackOperation, 'observe'>;
    time?: number;
    timeoutMs?: number;
}
const targetProperties: Record<string, JsonSchema> = {
    sessionId: { type: 'string', minLength: 1, maxLength: 64 },
    nodeReference: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['id'] },
    expectedComponentUuid: { type: 'string', minLength: 1, maxLength: 256 },
    expectedClipUuid: { type: 'string', minLength: 1, maxLength: 256 },
};
const stateSchema: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        currentTime: { type: 'number', minimum: 0 }, duration: { type: 'number', minimum: 0 }, playing: { type: 'boolean' },
        playbackState: { type: 'string', enum: ['init', 'playing', 'paused', 'stopped', 'interrupted'] }, loaded: { type: 'boolean' },
        volume: { type: ['number', 'null'], minimum: 0, maximum: 1 }, loop: { type: ['boolean', 'null'] },
        userActivation: { type: 'string', enum: ['active', 'inactive', 'unknown'] }, activationRequirement: { type: 'string', enum: ['unknown'] },
    }, required: ['currentTime', 'duration', 'playing', 'playbackState', 'loaded', 'volume', 'loop', 'userActivation', 'activationRequirement'],
};
const outputSchema: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        success: { type: 'boolean', enum: [true] }, sessionId: { type: 'string' }, targetId: { type: 'string' }, nodeUuid: { type: 'string' },
        componentUuid: { type: ['string', 'null'] }, clipUuid: { type: ['string', 'null'] },
        operation: { type: 'string', enum: ['play', 'pause', 'stop', 'seek', 'observe'] }, state: stateSchema,
        started: { type: 'boolean' }, ended: { type: 'boolean' },
    }, required: ['success', 'sessionId', 'targetId', 'nodeUuid', 'componentUuid', 'clipUuid', 'operation', 'state', 'started', 'ended'],
};

function validate(args: AudioPlaybackObserveArgs, operation: AudioPlaybackOperation, time?: number, timeoutMs?: number): void {
    const invalid = (message: string): never => { throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message }); };
    if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim() || args.sessionId.length > 64) invalid('sessionId is required (1..64 characters).');
    if (!args.nodeReference || typeof args.nodeReference.id !== 'string' || !args.nodeReference.id.trim() || args.nodeReference.id.length > 256) invalid('nodeReference.id is required (1..256 characters).');
    for (const key of ['expectedComponentUuid', 'expectedClipUuid'] as const) if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key]!.trim() || args[key]!.length > 256)) invalid(`${key} must be a bounded native UUID.`);
    if (!['play', 'pause', 'stop', 'seek', 'observe'].includes(operation)) invalid('Unknown audio operation.');
    if (operation === 'seek' ? !Number.isFinite(time) || time! < 0 : time !== undefined) invalid('Only seek accepts time, a finite nonnegative number of seconds.');
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000)) invalid('timeoutMs must be an integer from 100 to 5000.');
}

const findNodeSource = `(async function findRuntimeNode(id) {
    const scene = globalThis.cc?.director?.getScene?.();
    if (!scene || typeof id !== 'string') return null;
    const pending = [{ node: scene, depth: 0 }];
    const visited = new Set();
    let scheduled = 1, found = null;
    const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 409 }); };
    while (pending.length) {
        const { node, depth } = pending.pop();
        if (!node || typeof node !== 'object' || visited.has(node) || typeof node.uuid !== 'string' || !node.uuid || node.uuid.length > 256 || !Array.isArray(node.children)) fail('RUNTIME_TREE_INVALID', 'Audio lookup encountered malformed/repeated runtime nodes.');
        if (depth > 256) fail('RUNTIME_TRAVERSAL_LIMIT', 'Audio runtime tree exceeds256 levels.');
        visited.add(node);
        if (node.uuid === id) {
            if (found) fail('AMBIGUOUS_RUNTIME_TARGET', 'Multiple audio nodes expose the requested UUID.');
            found = node;
        }
        scheduled += node.children.length;
        if (scheduled > 10000) fail('RUNTIME_TRAVERSAL_LIMIT', 'Audio lookup exceeds10000 scheduled nodes.');
        for (const child of node.children) {
            if (!child || child.parent !== node) fail('RUNTIME_TREE_INVALID', 'Audio runtime child parent mismatch.');
            pending.push({ node: child, depth: depth + 1 });
        }
    }
    return found;
})`;
const executorSource = createAudioPlaybackExecutor.toString();

function operationSource(request: { sessionId: string; targetId: string; nodeUuid: string; operation: AudioPlaybackOperation; time?: number; timeoutMs?: number; expiresAt?: number; expectedComponentUuid?: string; expectedClipUuid?: string }): string {
    const requestLiteral = JSON.stringify(request);
    return `(() => {
        const key = Symbol.for('ccp3x.audioPlaybackExecutor');
        let execute = globalThis[key];
        if (typeof execute !== 'function') {
            execute = Object.assign((${executorSource})(), { identityContract: 2, snapshotContract: 3, deadlineContract: 1 });
            globalThis[key] = execute;
        }
        if ((${requestLiteral}.expectedComponentUuid !== undefined || ${requestLiteral}.expectedClipUuid !== undefined) && execute.identityContract !== 2) return { success: false, error: { code: 'AUDIO_EXECUTOR_STALE', status: 409, message: 'Existing audio executor cannot enforce identity guards. Restart the owned preview explicitly; cached mutation ownership was not reset.' } };
        if (execute.snapshotContract !== 3) return { success: false, error: { code: 'AUDIO_EXECUTOR_STALE', status: 409, message: 'Existing audio executor lacks current sound snapshot fields. Explicit owned preview restart required; mutation ownership was preserved.' } };
        if (${requestLiteral}.expiresAt !== undefined && execute.deadlineContract !== 1) return { success: false, error: { code: 'AUDIO_EXECUTOR_STALE', status: 409, message: 'Existing audio executor cannot enforce the caller deadline. Explicit owned preview restart required; mutation ownership was preserved.' } };
        return execute(${requestLiteral}, globalThis.cc, ${findNodeSource});
    })()`;
}

function throwRuntimeResult(result: unknown): asserts result is AudioPlaybackSuccess {
    if (result && typeof result === 'object' && (result as { success?: unknown }).success === true) return;
    const failure = result && typeof result === 'object' ? (result as { error?: Record<string, unknown> }).error : undefined;
    const code = typeof failure?.code === 'string' ? failure.code : 'AUDIO_OPERATION_FAILED';
    const status = typeof failure?.status === 'number' ? failure.status : 502;
    const message = typeof failure?.message === 'string' ? failure.message : 'Game View audio operation failed.';
    const details = failure ? { ...(typeof failure.state === 'object' && failure.state !== null ? { state: failure.state } : {}), ...(failure.pendingMayComplete === true ? { pendingMayComplete: true, mutationDispatched: true, retrySafe: false } : {}) } : undefined;
    throw new ToolError({ code, status, message, details, recovery: failure?.pendingMayComplete === true ? 'Observe the bound audio source before retrying; the prior operation may still complete.' : undefined });
}

export class AudioPlaybackTools {
    @utcpTool('audioPlaybackControl', 'Control one validated AudioSource in the attached Creator 3.7.3 Game View and confirm actual playback state.', {
        type: 'object', additionalProperties: false,
        properties: { ...targetProperties, operation: { type: 'string', enum: ['play', 'pause', 'stop', 'seek'] },
            time: { type: 'number', minimum: 0 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 5000 } },
        required: ['sessionId', 'nodeReference', 'operation'],
    }, outputSchema, 'POST', ['audio', 'playback', 'runtime', 'control'])
    async audioPlaybackControl(args: AudioPlaybackControlArgs, assertActive?: () => void, deadline?: number): Promise<AudioPlaybackSuccess> {
        if (!args || !['play', 'pause', 'stop', 'seek'].includes(args.operation)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Control requires play, pause, stop, or seek.' });
        return this.execute(args, args.operation, args.time, args.timeoutMs, deadline, assertActive);
    }

    @utcpTool('audioPlaybackObserve', 'Observe one validated AudioSource in the attached Creator 3.7.3 Game View with truthful readback.', {
        type: 'object', additionalProperties: false, properties: targetProperties, required: ['sessionId', 'nodeReference'],
    }, outputSchema, 'POST', ['audio', 'playback', 'runtime', 'observe'])
    async audioPlaybackObserve(args: AudioPlaybackObserveArgs, deadline?: number, assertActive?: () => void): Promise<AudioPlaybackSuccess> {
        return this.execute(args, 'observe', undefined, undefined, deadline, assertActive);
    }

    @utcpTool('audioPlaybackWaitForState', 'Wait for observed AudioSource playing/loaded/time conditions in one attached Game View target. Read-only polling; stopped is not proof of natural completion. No playback dispatch or event listeners.', {
        type: 'object', additionalProperties: false,
        properties: { ...targetProperties, userActivation: { type: 'string', enum: ['active', 'inactive', 'unknown'] }, minDuration: { type: 'number', minimum: 0, maximum: 86400 }, maxDuration: { type: 'number', minimum: 0, maximum: 86400 }, playing: { type: 'boolean' }, minVolume: { type: 'number', minimum: 0, maximum: 1 }, maxVolume: { type: 'number', minimum: 0, maximum: 1 }, loop: { type: 'boolean' }, loaded: { type: 'boolean' }, playbackState: { type: 'string', enum: ['init', 'playing', 'paused', 'stopped', 'interrupted'] }, maxTime: { type: 'number', minimum: 0, maximum: 3600 }, minTime: { type: 'number', minimum: 0, maximum: 3600 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 10000 }, pollMs: { type: 'integer', minimum: 25, maximum: 1000 } },
        required: ['sessionId', 'nodeReference'],
    }, { type: 'object', additionalProperties: false, properties: { matched: { type: 'boolean', const: true }, observations: { type: 'integer' }, observation: outputSchema }, required: ['matched', 'observations', 'observation'] }, 'POST', ['audio', 'playback', 'wait', 'read-only'])
    async audioPlaybackWaitForState(args: AudioPlaybackObserveArgs & { userActivation?: 'active' | 'inactive' | 'unknown'; minDuration?: number; maxDuration?: number; playing?: boolean; minVolume?: number; maxVolume?: number; loop?: boolean; loaded?: boolean; playbackState?: AudioPlaybackSuccess['state']['playbackState']; maxTime?: number; minTime?: number; timeoutMs?: number; pollMs?: number }, assertActive?: () => void) {
        validate(args, 'observe');
        const timeoutMs = args.timeoutMs ?? 3000;
        const pollMs = args.pollMs ?? 100;
        if (args.playing === undefined && args.loaded === undefined && args.loop === undefined && args.minVolume === undefined && args.maxVolume === undefined && args.maxTime === undefined && args.minTime === undefined && args.playbackState === undefined && args.userActivation === undefined && args.minDuration === undefined && args.maxDuration === undefined
            || args.playing !== undefined && typeof args.playing !== 'boolean'
            || args.loaded !== undefined && typeof args.loaded !== 'boolean'
            || args.loop !== undefined && typeof args.loop !== 'boolean'
            || args.playbackState !== undefined && !['init', 'playing', 'paused', 'stopped', 'interrupted'].includes(args.playbackState)
            || args.userActivation !== undefined && !['active', 'inactive', 'unknown'].includes(args.userActivation)
            || args.minTime !== undefined && (typeof args.minTime !== 'number' || !Number.isFinite(args.minTime) || args.minTime < 0 || args.minTime > 3600)
            || args.maxTime !== undefined && (typeof args.maxTime !== 'number' || !Number.isFinite(args.maxTime) || args.maxTime < 0 || args.maxTime > 3600)
            || args.minTime !== undefined && args.maxTime !== undefined && args.minTime > args.maxTime
            || [args.minVolume, args.maxVolume].some(n => n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) || args.minVolume !== undefined && args.maxVolume !== undefined && args.minVolume > args.maxVolume
            || [args.minDuration, args.maxDuration].some(value => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86400)) || args.minDuration !== undefined && args.maxDuration !== undefined && args.minDuration > args.maxDuration
            || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000
            || !Number.isInteger(pollMs) || pollMs < 25 || pollMs > 1000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide a bounded audio state condition, deadline and poll interval.' });
        args = { ...args, nodeReference: { id: args.nodeReference.id } };
        const deadline = Date.now() + timeoutMs;
        let targetId: string | undefined;
        let sourceIdentity: string | undefined;
        let observations = 0;
        for (;;) {
            assertActive?.();
            const remaining = deadline - Date.now();
            if (remaining < 100) throw new ToolError({ code: 'AUDIO_STATE_TIMEOUT', status: 409, message: 'Audio wait has insufficient remaining time for a bounded read.' });
            let timer: NodeJS.Timeout | undefined;
            let observation: AudioPlaybackSuccess;
            try {
                observation = await Promise.race([this.audioPlaybackObserve({ sessionId: args.sessionId, nodeReference: { id: args.nodeReference.id }, expectedComponentUuid: args.expectedComponentUuid, expectedClipUuid: args.expectedClipUuid }, deadline, assertActive), new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new ToolError({ code: 'AUDIO_STATE_TIMEOUT', status: 409, message: 'Audio read exceeded the caller deadline; in-flight observation may still settle.' })), remaining);
                })]);
            } finally { clearTimeout(timer); }
            assertActive?.();
            if (Date.now() >= deadline) throw new ToolError({ code: 'AUDIO_STATE_TIMEOUT', status: 409, message: 'Audio observation completed after the caller deadline.' });
            if (observation.success !== true || observation.operation !== 'observe' || observation.sessionId !== args.sessionId || observation.nodeUuid !== args.nodeReference.id
                || typeof observation.targetId !== 'string' || !observation.targetId) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Audio observation identity is invalid.' });
            if (targetId !== undefined && observation.targetId !== targetId) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Audio target changed during state wait.' });
            targetId = observation.targetId;
            if (typeof observation.componentUuid !== 'string' || !observation.componentUuid.trim() || observation.componentUuid.length > 256 || typeof observation.clipUuid !== 'string' || !observation.clipUuid.trim() || observation.clipUuid.length > 256) throw new ToolError({ code: 'AUDIO_IDENTITY_UNAVAILABLE', status: 422, message: 'Audio wait requires native source and clip UUIDs; unavailable identity cannot prove a stable target.' });
            const identity = JSON.stringify([observation.componentUuid, observation.clipUuid]);
            if (sourceIdentity !== undefined && sourceIdentity !== identity) throw new ToolError({ code: 'AUDIO_TARGET_CHANGED', status: 409, message: 'AudioSource or assigned clip identity changed during wait.' });
            sourceIdentity = identity;
            const state = observation.state;
            if (!state || typeof state.playing !== 'boolean' || typeof state.loaded !== 'boolean'
                || !['init', 'playing', 'paused', 'stopped', 'interrupted'].includes(state.playbackState)
                || typeof state.currentTime !== 'number' || !Number.isFinite(state.currentTime) || state.currentTime < 0
                || typeof state.duration !== 'number' || !Number.isFinite(state.duration) || state.duration < 0
                || !['active', 'inactive', 'unknown'].includes(state.userActivation)
                || state.activationRequirement !== 'unknown') throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Audio wait received invalid state metrics.' });
            if (args.loop !== undefined && typeof state.loop !== 'boolean') throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_METRIC', status: 422, message: 'Native looping state unavailable.' });
            if ((args.minVolume !== undefined || args.maxVolume !== undefined) && (typeof state.volume !== 'number' || !Number.isFinite(state.volume) || state.volume < 0 || state.volume > 1)) throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_METRIC', status: 422, message: 'Native source volume unavailable.' });
            observations++;
            if ((args.minVolume === undefined || state.volume! >= args.minVolume) && (args.maxVolume === undefined || state.volume! <= args.maxVolume) && (args.loop === undefined || state.loop === args.loop) && (args.playing === undefined || state.playing === args.playing) && (args.loaded === undefined || state.loaded === args.loaded)
                && (args.playbackState === undefined || state.playbackState === args.playbackState) && (args.userActivation === undefined || state.userActivation === args.userActivation) && (args.minDuration === undefined || state.duration >= args.minDuration) && (args.maxDuration === undefined || state.duration <= args.maxDuration)
                && (args.maxTime === undefined || state.currentTime <= args.maxTime) && (args.minTime === undefined || state.currentTime >= args.minTime)) return { matched: true as const, observations, observation };
            await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
        }
    }

    private async execute(args: AudioPlaybackObserveArgs, operation: AudioPlaybackOperation, time?: number, timeoutMs?: number, deadline?: number, assertActive?: () => void): Promise<AudioPlaybackSuccess> {
        validate(args, operation, time, timeoutMs);
        args = { ...args, nodeReference: { id: args.nodeReference.id } };
        try {
            const runtime = new RuntimeSessionTools();
            assertActive?.();
            const readinessRemaining = deadline === undefined ? undefined : deadline - Date.now();
            if (readinessRemaining !== undefined && readinessRemaining < 100) throw new ToolError({ code: 'AUDIO_STATE_TIMEOUT', status: 409, message: 'Audio wait has insufficient time for readiness; no inspection dispatched.' });
            const inspected = await runtime.runtimeSessionLifecycle({ operation: 'inspect', sessionId: args.sessionId, ...(readinessRemaining === undefined ? {} : { timeoutMs: Math.min(10000, readinessRemaining) }) });
            const session = inspected.session;
            if (session && 'status' in session && session.status === 'stopped') throw new ToolError({ code: 'RUNTIME_SESSION_STOPPED', status: 409, message: 'The runtime session is stopped.' });
            if (!inspected.success || !inspected.ready || !session || !('targetId' in session) || session.sessionId !== args.sessionId) throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'The attached runtime session is not ready.' });
            if (session.targetKind !== 'game-view') throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_TRANSPORT', status: 422, message: 'Audio supports the Creator Game View transport only.' });
            assertActive?.();
            const request = { sessionId: args.sessionId, targetId: session.targetId, nodeUuid: args.nodeReference.id, expectedComponentUuid: args.expectedComponentUuid, expectedClipUuid: args.expectedClipUuid, operation, ...(time === undefined ? {} : { time }), ...(deadline === undefined ? {} : { expiresAt: deadline }), ...(timeoutMs === undefined ? {} : { timeoutMs: deadline === undefined ? timeoutMs : Math.min(timeoutMs, deadline - Date.now()) }) };
            const remaining = deadline === undefined ? undefined : deadline - Date.now();
            if (remaining !== undefined && remaining < 100) throw new ToolError({ code: 'AUDIO_STATE_TIMEOUT', status: 409, message: 'Audio wait deadline exhausted during session inspection; no read dispatched.' });
            const transportTimeout = remaining === undefined ? Math.min(10000, (timeoutMs ?? 1000) + 2000) : Math.min(10000, remaining);
            const result = await executeGameViewOperation(session.targetId, operationSource(request), transportTimeout, operation !== 'observe', deadline, assertActive);
            throwRuntimeResult(result);
            if (result.sessionId !== args.sessionId || result.targetId !== session.targetId || result.nodeUuid !== args.nodeReference.id || result.operation !== operation
                || args.expectedComponentUuid !== undefined && result.componentUuid !== args.expectedComponentUuid || args.expectedClipUuid !== undefined && result.clipUuid !== args.expectedClipUuid) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Audio response does not identify the dispatched session/node/operation and expected source/clip.', details: { mutationDispatched: operation !== 'observe', retrySafe: false, pendingMayComplete: operation !== 'observe' }, recovery: 'Inspect the exact audio target before any further control; do not replay this request blindly.' });
            const state = result.state;
            const nullableUuid = (value: unknown) => value === null || typeof value === 'string' && !!value.trim() && value.length <= 256;
            if (!nullableUuid(result.componentUuid) || !nullableUuid(result.clipUuid) || typeof result.started !== 'boolean' || typeof result.ended !== 'boolean'
                || !state || typeof state !== 'object' || Array.isArray(state) || typeof state.playing !== 'boolean' || typeof state.loaded !== 'boolean'
                || !['init', 'playing', 'paused', 'stopped', 'interrupted'].includes(state.playbackState) || state.playing !== (state.playbackState === 'playing')
                || typeof state.currentTime !== 'number' || !Number.isFinite(state.currentTime) || state.currentTime < 0 || typeof state.duration !== 'number' || !Number.isFinite(state.duration) || state.duration < 0
                || state.volume !== null && (typeof state.volume !== 'number' || !Number.isFinite(state.volume) || state.volume < 0 || state.volume > 1) || state.loop !== null && typeof state.loop !== 'boolean'
                || !['active', 'inactive', 'unknown'].includes(state.userActivation) || state.activationRequirement !== 'unknown') throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Audio success contains unavailable or inconsistent state metrics.', details: { mutationDispatched: operation !== 'observe', pendingMayComplete: operation !== 'observe', retrySafe: false }, recovery: 'Inspect the exact audio target before further control; no automatic replay.' });
            const uncertainty = { mutationDispatched: operation !== 'observe', pendingMayComplete: operation !== 'observe', retrySafe: false };
            const confirmed = operation === 'observe'
                || state.loaded && state.duration > 0 && (operation === 'play' ? result.started && (state.playing || result.ended)
                    : operation === 'pause' ? state.playbackState === 'paused' && !state.playing
                        : operation === 'stop' ? state.playbackState === 'stopped' && !state.playing && state.currentTime <= 0.001
                            : time !== undefined && time <= state.duration && Math.abs(state.currentTime - time) <= 0.05);
            if (!confirmed) throw new ToolError({ code: 'AUDIO_READBACK_MISMATCH', status: 502, message: 'Audio success does not satisfy the requested playback postcondition.', details: { ...uncertainty, state }, recovery: 'Observe the exact source before further control; no automatic playback replay.' });
            if (operation === 'observe') assertActive?.();
            const verificationRemaining = deadline === undefined ? undefined : deadline - Date.now();
            if (verificationRemaining !== undefined && verificationRemaining < 100) throw new ToolError({ code: 'AUDIO_STATE_TIMEOUT', status: 409, message: 'Audio wait has insufficient time for verification; no recheck dispatched.' });
            let after: Awaited<ReturnType<RuntimeSessionTools['runtimeSessionLifecycle']>>;
            try { after = await runtime.runtimeSessionLifecycle({ operation: 'inspect', sessionId: args.sessionId, ...(verificationRemaining === undefined ? {} : { timeoutMs: Math.min(10000, verificationRemaining) }) }); }
            catch (error) { throw new ToolError({ code: 'AUDIO_SESSION_RECHECK_FAILED', status: 502, message: 'Audio operation settled but session continuity could not be confirmed.', details: { ...uncertainty, cause: error instanceof ToolError ? error.code : 'SESSION_INSPECTION_FAILED' }, recovery: 'Reconcile the exact session and audio target before further control; no replay.' }); }
            if (operation === 'observe') assertActive?.();
            const current = after.session;
            if (!after.success || !after.ready || !current || !('status' in current) || current.status !== 'attached' || current.sessionId !== session.sessionId || current.targetId !== session.targetId || current.targetKind !== session.targetKind || current.createdAt !== session.createdAt) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Audio session identity/lifecycle changed during execution.', details: uncertainty, recovery: 'Inspect the current session; do not replay the prior audio action.' });
            if (deadline !== undefined && Date.now() >= deadline) throw new ToolError({ code: 'AUDIO_STATE_TIMEOUT', status: 409, message: 'Audio observation verification settled after wait deadline.' });
            return result;
        } catch (error) {
            if (error instanceof ToolError) throw error;
            throw new ToolError({ code: 'AUDIO_TRANSPORT_UNAVAILABLE', status: 502,
                message: 'Audio Game View transport failed.', details: { cause: error instanceof Error ? error.message : String(error) } });
        }
    }
}
