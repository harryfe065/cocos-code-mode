import { JsonSchema } from '@utcp/sdk';
import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import {
    executeComponentOperation,
    requireComponentText,
    validateComponentTarget,
    ComponentOperation,
} from '../utils/game-view-components';
import { GraphVariableWaitCondition, waitForGraphVariable } from '../graph-variable-wait';
import { createHash } from 'crypto';

const targetProperties: Record<string, JsonSchema> = {
    sessionId: { type: 'string', minLength: 1, maxLength: 64 },
    nodeReference: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['id'] },
    componentId: { type: 'string', minLength: 1, maxLength: 256 },
};
const animationStateSchema: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: { playing: { type: 'boolean' }, paused: { type: 'boolean' }, time: { type: ['number', 'null'] }, duration: { type: ['number', 'null'] }, speed: { type: ['number', 'null'] } },
    required: ['playing', 'paused', 'time', 'duration', 'speed'],
};
const componentOutputSchema: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        success: { type: 'boolean', enum: [true] }, sessionId: { type: 'string' }, targetId: { type: 'string' }, operation: { type: 'string' },
        nodeReference: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, nodeUuid: { type: 'string' }, componentId: { type: 'string' },
        componentType: { type: 'string' }, clipName: { type: 'string' }, clipUuid: { type: 'string' }, state: animationStateSchema, events: { type: 'array', maxItems: 100 }, reason: { type: 'string' },
        graphUuid: { type: ['string', 'null'] }, variables: { type: 'array', maxItems: 64 }, layers: { type: 'array', maxItems: 16 },
    }, required: ['success', 'sessionId', 'targetId', 'operation', 'nodeReference', 'nodeUuid', 'componentId'],
};

type BaseArgs = { sessionId?: string; nodeReference?: { id?: string }; componentId?: string; timeoutMs?: number };
type SkeletalArgs = BaseArgs & { operation?: string; clipName?: string; clipUuid?: string };
type EventArgs = BaseArgs & { clipName?: string; clipUuid?: string; maxEvents?: number; timeoutMs?: number };
type GraphVariable = { name?: string; type?: string; value?: number | boolean; expectedValue?: number | boolean };
type GraphArgs = BaseArgs & { operation?: string; variable?: GraphVariable; expectedGraphUuid?: string; timeoutMs?: number };

function validateTimeout(value: unknown, name = 'timeoutMs'): number {
    if (value === undefined) return 1000;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 3000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${name} must be an integer from 100 to 3000.` });
    return value;
}
function validateSkeletal(args: SkeletalArgs, operation: string): ComponentOperation {
    validateComponentTarget({ sessionId: args?.sessionId ?? '', nodeReference: { id: args?.nodeReference?.id ?? '' }, componentId: args?.componentId }, true);
    requireComponentText(args.clipName, 'clipName');
    requireComponentText(args.clipUuid, 'clipUuid');
    if (!['play', 'pause', 'resume', 'stop', 'observe'].includes(operation)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation must be play, pause, resume, stop, or observe.' });
    return { kind: 'skeletal', operation, sessionId: args.sessionId!, nodeReference: { id: args.nodeReference!.id! }, componentId: args.componentId!, clipName: args.clipName!, clipUuid: args.clipUuid!, timeoutMs: validateTimeout(args.timeoutMs) };
}

export class ComponentRuntimeTools {
    @utcpTool('animationClipInventory', 'Page runtime clip slots with full ordered identity revision. Supply expectedRevision on later pages to refuse changed collection/target. No state/playback calls; revision excludes asset content and playback state.', { type: 'object', additionalProperties: false, properties: { ...targetProperties, maxClips: { type: 'integer', minimum: 1, maximum: 128, default: 32 }, clipOffset: { type: 'integer', minimum: 0, maximum: 256, default: 0 }, expectedRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 } }, required: ['sessionId', 'nodeReference', 'componentId'] }, { type: 'object', properties: { success: { type: 'boolean' }, sessionId: { type: 'string' }, targetId: { type: 'string' }, nodeUuid: { type: 'string' }, componentId: { type: 'string' }, clips: { type: 'array', maxItems: 128 }, totalClips: { type: 'integer' }, clipOffset: { type: 'integer' }, nextOffset: { type: ['integer', 'null'] }, truncated: { type: 'boolean' }, revision: { type: 'string' } }, required: ['success', 'sessionId', 'targetId', 'nodeUuid', 'componentId', 'clips', 'totalClips', 'clipOffset', 'nextOffset', 'truncated', 'revision'] }, 'POST', ['animation', 'clips', 'inventory', 'read-only'])
    async animationClipInventory(args: BaseArgs & { maxClips?: number; clipOffset?: number; expectedRevision?: string }) {
        validateComponentTarget({ sessionId: args?.sessionId ?? '', nodeReference: { id: args?.nodeReference?.id ?? '' }, componentId: args?.componentId }, true);
        const maxClips = args.maxClips ?? 32;
        if (!Number.isInteger(maxClips) || maxClips < 1 || maxClips > 128) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxClips must be1..128.' });
        const clipOffset = args.clipOffset ?? 0;
        if (!Number.isInteger(clipOffset) || clipOffset < 0 || clipOffset > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'clipOffset must be0..256.' });
        if (args.expectedRevision !== undefined && (typeof args.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedRevision))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedRevision must be a lowercase SHA-256 revision.' });
        args = { ...args, nodeReference: { id: args.nodeReference!.id } };
        const result = await executeComponentOperation({ kind: 'animation', operation: 'inspect', sessionId: args.sessionId!, nodeReference: { id: args.nodeReference!.id! }, componentId: args.componentId!, maxClips, clipOffset, timeoutMs: validateTimeout(args.timeoutMs) });
        if (typeof result.inventorySnapshot !== 'string' || result.inventorySnapshot.length > 800000) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Bounded clip identity snapshot unavailable.' });
        if (typeof result.totalClips !== 'number' || !Number.isSafeInteger(result.totalClips) || result.totalClips < 0 || result.totalClips > 256 || clipOffset > result.totalClips || result.clipOffset !== clipOffset || !Array.isArray(result.clips) || result.clips.length !== Math.min(maxClips, result.totalClips - clipOffset)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Clip inventory page count/offset is inconsistent.' });
        const end = clipOffset + result.clips.length;
        if (result.nextOffset !== (end < result.totalClips ? end : null) || result.truncated !== (end < result.totalClips)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Clip inventory continuation is inconsistent.' });
        let snapshot: unknown;
        try { snapshot = JSON.parse(result.inventorySnapshot); }
        catch { throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Clip identity snapshot is not valid JSON.' }); }
        if (!Array.isArray(snapshot) || snapshot.length !== result.totalClips) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Clip identity snapshot count is inconsistent.' });
        const names = new Map<string, number>();
        for (const identity of snapshot) {
            if (identity === null) continue;
            if (!Array.isArray(identity) || identity.length !== 2 || identity.some(value => typeof value !== 'string' || !value || value.length > 256)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Clip identity snapshot contains invalid slots.' });
            names.set(identity[0], (names.get(identity[0]) ?? 0) + 1);
        }
        for (let index = 0; index < result.clips.length; index++) {
            const slot = result.clips[index];
            if (!Object.prototype.hasOwnProperty.call(result.clips, index) || !slot || typeof slot !== 'object' || Array.isArray(slot) || typeof slot.uniqueName !== 'boolean' || typeof slot.empty !== 'boolean'
                || (slot.empty ? slot.clipName !== null || slot.clipUuid !== null || slot.uniqueName !== false : typeof slot.clipName !== 'string' || !slot.clipName || slot.clipName.length > 256 || typeof slot.clipUuid !== 'string' || !slot.clipUuid || slot.clipUuid.length > 256)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Clip inventory slot metadata is invalid.' });
            const identity = snapshot[clipOffset + index];
            if (identity === null ? !slot.empty : slot.empty || slot.clipName !== identity[0] || slot.clipUuid !== identity[1] || slot.uniqueName !== (names.get(identity[0]) === 1)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Clip inventory page differs from its identity snapshot.' });
        }
        const revision = createHash('sha256').update(JSON.stringify([args.sessionId, result.targetId, result.nodeUuid, result.componentId, result.inventorySnapshot])).digest('hex');
        if (args.expectedRevision !== undefined && args.expectedRevision !== revision) throw new ToolError({ code: 'RUNTIME_INVENTORY_CHANGED', status: 409, message: 'Clip slot identity/order changed since the requested revision; restart paging.' });
        const { inventorySnapshot, ...inventory } = result;
        return { ...inventory, revision };
    }

    @utcpTool('animationPlaybackObserve', 'Read one exact Animation/SkeletalAnimation clip state in attached Creator3.7 Game View. No playback calls, event listeners or edit-scene substitution. Spine/DragonBones unsupported.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, clipName: { type: 'string', minLength: 1, maxLength: 256 }, clipUuid: { type: 'string', minLength: 1, maxLength: 256 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 } }, required: ['sessionId', 'nodeReference', 'componentId', 'clipName', 'clipUuid'],
    }, componentOutputSchema, 'POST', ['animation', 'observe', 'runtime', 'read-only'])
    async animationPlaybackObserve(args: SkeletalArgs): Promise<Record<string, unknown>> {
        validateComponentTarget({ sessionId: args?.sessionId ?? '', nodeReference: { id: args?.nodeReference?.id ?? '' }, componentId: args?.componentId }, true);
        requireComponentText(args.clipName, 'clipName'); requireComponentText(args.clipUuid, 'clipUuid');
        return executeComponentOperation({ kind: 'animation', operation: 'observe', sessionId: args.sessionId!, nodeReference: { id: args.nodeReference!.id! }, componentId: args.componentId!, clipName: args.clipName!, clipUuid: args.clipUuid!, timeoutMs: validateTimeout(args.timeoutMs) });
    }

    @utcpTool('animationPlaybackControl', 'Control one exact Animation/SkeletalAnimation component and clip in attached Creator3.7 Game View through finite play/pause/resume/stop with actual state read-back. Component pause/resume/stop affect its active states, not an isolated clip. No edit-scene substitution or automatic replay.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, operation: { type: 'string', enum: ['play', 'pause', 'resume', 'stop'] }, clipName: { type: 'string', minLength: 1, maxLength: 256 }, clipUuid: { type: 'string', minLength: 1, maxLength: 256 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 } }, required: ['sessionId', 'nodeReference', 'componentId', 'operation', 'clipName', 'clipUuid'],
    }, componentOutputSchema, 'POST', ['animation', 'playback', 'control', 'runtime'])
    async animationPlaybackControl(args: SkeletalArgs, assertActive?: () => void, deadline?: number): Promise<Record<string, unknown>> {
        validateComponentTarget({ sessionId: args?.sessionId ?? '', nodeReference: { id: args?.nodeReference?.id ?? '' }, componentId: args?.componentId }, true);
        requireComponentText(args.clipName, 'clipName'); requireComponentText(args.clipUuid, 'clipUuid');
        if (!['play', 'pause', 'resume', 'stop'].includes(args.operation ?? '')) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation must be play, pause, resume or stop.' });
        return executeComponentOperation({ kind: 'animation', operation: args.operation!, sessionId: args.sessionId!, nodeReference: { id: args.nodeReference!.id! }, componentId: args.componentId!, clipName: args.clipName!, clipUuid: args.clipUuid!, timeoutMs: validateTimeout(args.timeoutMs) }, assertActive, deadline);
    }

    @utcpTool('skeletalAnimationPlay', 'Play, pause, resume, stop or observe one exact cc.SkeletalAnimation clip in Game View. observe is read-only; Spine and DragonBones are unsupported.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, operation: { type: 'string', enum: ['play', 'pause', 'resume', 'stop', 'observe'] }, clipName: { type: 'string', minLength: 1, maxLength: 256 }, clipUuid: { type: 'string', minLength: 1, maxLength: 256 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 } },
        required: ['sessionId', 'nodeReference', 'componentId', 'operation', 'clipName', 'clipUuid'],
    }, componentOutputSchema, 'POST', ['skeletal', 'animation', 'playback', 'runtime'])
    async skeletalAnimationPlay(args: SkeletalArgs): Promise<Record<string, unknown>> {
        const operation = args?.operation;
        if (typeof operation !== 'string') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation is required.' });
        return executeComponentOperation(validateSkeletal(args, operation));
    }

    @utcpTool('skeletalAnimationWaitForState', 'Poll one exact SkeletalAnimation clip state without changing playback. Missing metrics/invalidated targets fail closed; caller deadline bounds each observation.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, clipName: { type: 'string', minLength: 1, maxLength: 256 }, clipUuid: { type: 'string', minLength: 1, maxLength: 256 }, minDuration: { type: 'number', minimum: 0, maximum: 86400 }, maxDuration: { type: 'number', minimum: 0, maximum: 86400 }, minSpeed: { type: 'number', minimum: -1000000, maximum: 1000000 }, maxSpeed: { type: 'number', minimum: -1000000, maximum: 1000000 }, playing: { type: 'boolean' }, paused: { type: 'boolean' }, maxTime: { type: 'number', minimum: 0, maximum: 3600 }, minTime: { type: 'number', minimum: 0, maximum: 3600 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 10000, default: 3000 }, pollMs: { type: 'integer', minimum: 25, maximum: 1000, default: 100 } }, required: ['sessionId', 'nodeReference', 'componentId', 'clipName', 'clipUuid'],
    }, { type: 'object', properties: { matched: { type: 'boolean' }, timedOut: { type: 'boolean' }, observations: { type: 'integer' }, state: animationStateSchema }, required: ['matched', 'timedOut', 'observations', 'state'] }, 'POST', ['skeletal', 'animation', 'wait', 'read-only'])
    async skeletalAnimationWaitForState(args: SkeletalArgs & { minDuration?: number; maxDuration?: number; minSpeed?: number; maxSpeed?: number; playing?: boolean; paused?: boolean; maxTime?: number; minTime?: number; pollMs?: number }) {
        return this.waitForAnimationState(args, 'skeletal');
    }

    @utcpTool('animationPlaybackWaitForState', 'Wait for one exact Animation/SkeletalAnimation clip state in attached Game View. Read-only polling with a caller deadline; no playback dispatch, listeners or edit-scene fallback.', {
        type: 'object', additionalProperties: false,
        properties: { ...targetProperties, clipName: { type: 'string', minLength: 1, maxLength: 256 }, clipUuid: { type: 'string', minLength: 1, maxLength: 256 }, minDuration: { type: 'number', minimum: 0, maximum: 86400 }, maxDuration: { type: 'number', minimum: 0, maximum: 86400 }, minSpeed: { type: 'number', minimum: -1000000, maximum: 1000000 }, maxSpeed: { type: 'number', minimum: -1000000, maximum: 1000000 }, playing: { type: 'boolean' }, paused: { type: 'boolean' }, maxTime: { type: 'number', minimum: 0, maximum: 3600 }, minTime: { type: 'number', minimum: 0, maximum: 3600 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 10000, default: 3000 }, pollMs: { type: 'integer', minimum: 25, maximum: 1000, default: 100 } },
        required: ['sessionId', 'nodeReference', 'componentId', 'clipName', 'clipUuid'],
    }, { type: 'object', properties: { matched: { type: 'boolean' }, timedOut: { type: 'boolean' }, observations: { type: 'integer' }, state: animationStateSchema }, required: ['matched', 'timedOut', 'observations', 'state'] }, 'POST', ['animation', 'playback', 'wait', 'read-only'])
    async animationPlaybackWaitForState(args: SkeletalArgs & { minDuration?: number; maxDuration?: number; minSpeed?: number; maxSpeed?: number; playing?: boolean; paused?: boolean; maxTime?: number; minTime?: number; pollMs?: number }, assertActive?: () => void) {
        return this.waitForAnimationState(args, 'animation', assertActive);
    }

    private async waitForAnimationState(args: SkeletalArgs & { minDuration?: number; maxDuration?: number; minSpeed?: number; maxSpeed?: number; playing?: boolean; paused?: boolean; maxTime?: number; minTime?: number; pollMs?: number }, kind: 'animation' | 'skeletal', assertActive?: () => void) {
        const timeoutMs = args?.timeoutMs ?? 3000; const pollMs = args?.pollMs ?? 100;
        if (!args || args.playing === undefined && args.paused === undefined && args.minTime === undefined && args.maxTime === undefined && args.minSpeed === undefined && args.maxSpeed === undefined && args.minDuration === undefined && args.maxDuration === undefined
            || args.playing !== undefined && typeof args.playing !== 'boolean' || args.paused !== undefined && typeof args.paused !== 'boolean'
            || args.minTime !== undefined && (typeof args.minTime !== 'number' || !Number.isFinite(args.minTime) || args.minTime < 0 || args.minTime > 3600)
            || args.maxTime !== undefined && (typeof args.maxTime !== 'number' || !Number.isFinite(args.maxTime) || args.maxTime < 0 || args.maxTime > 3600 || args.minTime !== undefined && args.minTime > args.maxTime)
            || [args.minSpeed, args.maxSpeed].some(value => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1000000)) || args.minSpeed !== undefined && args.maxSpeed !== undefined && args.minSpeed > args.maxSpeed
            || [args.minDuration, args.maxDuration].some(value => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86400)) || args.minDuration !== undefined && args.maxDuration !== undefined && args.minDuration > args.maxDuration
            || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000 || !Number.isInteger(pollMs) || pollMs < 25 || pollMs > 1000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide bounded state conditions, timeout and poll interval.' });
        validateSkeletal({ ...args, timeoutMs: 1000 }, 'observe');
        args = { ...args, nodeReference: { id: args.nodeReference!.id } };
        const deadline = Date.now() + timeoutMs; let observations = 0;
        let targetId: string | undefined;
        for (;;) {
            assertActive?.();
            const remaining = deadline - Date.now();
            if (remaining < 100) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Animation wait has insufficient remaining time for a bounded read; no next observation dispatched.' });
            const operation: ComponentOperation = { ...validateSkeletal({ ...args, timeoutMs: Math.max(100, Math.min(remaining, 1000)) }, 'observe'), kind };
            let timer: NodeJS.Timeout | undefined; let result: Record<string, unknown>;
            try { result = await Promise.race([executeComponentOperation(operation, assertActive), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Skeletal state read exceeded caller deadline; no playback mutation dispatched.' })), remaining); })]); }
            finally { clearTimeout(timer); }
            assertActive?.();
            if (Date.now() >= deadline) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Skeletal state read completed after caller deadline; no playback mutation dispatched.' });
            if (typeof result.targetId !== 'string' || !result.targetId) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Animation observation target identity is unavailable.' });
            if (targetId !== undefined && result.targetId !== targetId) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Animation target changed during state wait.' });
            targetId = result.targetId;
            const state = result.state as { playing?: unknown; paused?: unknown; speed?: unknown; duration?: unknown; time?: unknown } | undefined;
            if (!state || typeof state.playing !== 'boolean' || typeof state.paused !== 'boolean') throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Invalid skeletal state observation.' });
            if ((args.minTime !== undefined || args.maxTime !== undefined) && (typeof state.time !== 'number' || !Number.isFinite(state.time))) throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_METRIC', status: 422, message: 'Skeletal clip time is unavailable.' });
            if ((args.minSpeed !== undefined || args.maxSpeed !== undefined) && (typeof state.speed !== 'number' || !Number.isFinite(state.speed))) throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_METRIC', status: 422, message: 'Animation clip speed is unavailable.' });
            if ((args.minDuration !== undefined || args.maxDuration !== undefined) && (typeof state.duration !== 'number' || !Number.isFinite(state.duration) || state.duration < 0)) throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_METRIC', status: 422, message: 'Animation clip duration is unavailable.' });
            observations++;
            const matched = (args.playing === undefined || args.playing === state.playing) && (args.paused === undefined || args.paused === state.paused) && (args.minTime === undefined || (state.time as number) >= args.minTime) && (args.maxTime === undefined || (state.time as number) <= args.maxTime) && (args.minSpeed === undefined || (state.speed as number) >= args.minSpeed) && (args.maxSpeed === undefined || (state.speed as number) <= args.maxSpeed) && (args.minDuration === undefined || (state.duration as number) >= args.minDuration) && (args.maxDuration === undefined || (state.duration as number) <= args.maxDuration);
            if (matched || Date.now() >= deadline) return { matched, timedOut: !matched, observations, state };
            await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
        }
    }

    @utcpTool('skeletalAnimationEvents', 'Observe bounded cc.SkeletalAnimation lifecycle events for one exact clip, with deadline and listener cleanup. Spine and DragonBones are unsupported.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, clipName: { type: 'string', minLength: 1, maxLength: 256 }, clipUuid: { type: 'string', minLength: 1, maxLength: 256 }, maxEvents: { type: 'integer', minimum: 1, maximum: 100 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 } },
        required: ['sessionId', 'nodeReference', 'componentId', 'clipName', 'clipUuid'],
    }, componentOutputSchema, 'POST', ['skeletal', 'animation', 'events', 'runtime'])
    async skeletalAnimationEvents(args: EventArgs): Promise<Record<string, unknown>> {
        validateComponentTarget({ sessionId: args?.sessionId ?? '', nodeReference: { id: args?.nodeReference?.id ?? '' }, componentId: args?.componentId }, true);
        requireComponentText(args.clipName, 'clipName');
        requireComponentText(args.clipUuid, 'clipUuid');
        if (args.maxEvents !== undefined && (!Number.isInteger(args.maxEvents) || args.maxEvents < 1 || args.maxEvents > 100)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxEvents must be an integer from 1 to 100.' });
        const op: ComponentOperation = { kind: 'events', skeletalEvents: true, operation: 'observe', sessionId: args.sessionId!, nodeReference: { id: args.nodeReference!.id! }, componentId: args.componentId!, clipName: args.clipName!, clipUuid: args.clipUuid!, maxEvents: args.maxEvents ?? 20, timeoutMs: validateTimeout(args.timeoutMs) };
        return executeComponentOperation(op);
    }

    @utcpTool('animationPlaybackEvents', 'Observe bounded Animation/SkeletalAnimation lifecycle events for one exact Game View clip. Read-only playback observation with listener cleanup; no event history before registration or automatic playback dispatch.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, clipName: { type: 'string', minLength: 1, maxLength: 256 }, clipUuid: { type: 'string', minLength: 1, maxLength: 256 }, maxEvents: { type: 'integer', minimum: 1, maximum: 100 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 } }, required: ['sessionId', 'nodeReference', 'componentId', 'clipName', 'clipUuid'],
    }, componentOutputSchema, 'POST', ['animation', 'events', 'runtime', 'read-only'])
    async animationPlaybackEvents(args: EventArgs, assertActive?: () => void, deadline?: number): Promise<Record<string, unknown>> {
        const operation = validateSkeletal(args, 'observe');
        if (args.maxEvents !== undefined && (!Number.isInteger(args.maxEvents) || args.maxEvents < 1 || args.maxEvents > 100)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxEvents must be an integer from1 to100.' });
        return executeComponentOperation({ ...operation, kind: 'events', maxEvents: args.maxEvents ?? 20 }, assertActive, deadline);
    }

    @utcpTool('animationGraphPreview', 'Inspect one exact cc.animation.AnimationController runtime graph, or set one typed FLOAT/INTEGER/BOOLEAN variable with read-back. No dynamic methods or invented graph component are used.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, operation: { type: 'string', enum: ['inspect', 'setVariable'] }, expectedGraphUuid: { type: 'string', minLength: 1, maxLength: 256 }, variable: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 256 }, type: { type: 'string', enum: ['float', 'integer', 'boolean'] }, value: {}, expectedValue: { type: ['number', 'boolean'] } }, required: ['name', 'type', 'value'] }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 } },
        required: ['sessionId', 'nodeReference', 'componentId', 'operation'],
    }, componentOutputSchema, 'POST', ['animation', 'graph', 'preview', 'runtime'])
    async animationGraphPreview(args: GraphArgs, assertActive?: () => void, deadline?: number): Promise<Record<string, unknown>> {
        validateComponentTarget({ sessionId: args?.sessionId ?? '', nodeReference: { id: args?.nodeReference?.id ?? '' }, componentId: args?.componentId }, true);
        if (args.operation !== 'inspect' && args.operation !== 'setVariable') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation must be inspect or setVariable.' });
        if (args.expectedGraphUuid !== undefined) requireComponentText(args.expectedGraphUuid, 'expectedGraphUuid');
        let variable: ComponentOperation['variable'];
        if (args.operation === 'setVariable') {
            const candidate = args.variable;
            if (!candidate || typeof candidate !== 'object') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'variable is required.' });
            requireComponentText(candidate.name, 'variable.name');
            if (candidate.type !== 'float' && candidate.type !== 'integer' && candidate.type !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'variable.type must be float, integer, or boolean.' });
            if (candidate.type === 'boolean' ? typeof candidate.value !== 'boolean' : typeof candidate.value !== 'number' || !Number.isFinite(candidate.value) || candidate.type === 'integer' && !Number.isInteger(candidate.value)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'variable.value must match its declared finite type.' });
            if (candidate.expectedValue !== undefined && (candidate.type === 'boolean' ? typeof candidate.expectedValue !== 'boolean' : typeof candidate.expectedValue !== 'number' || !Number.isFinite(candidate.expectedValue) || candidate.type === 'integer' && !Number.isInteger(candidate.expectedValue))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'variable.expectedValue must match its declared finite type.' });
            const variableType: 'float' | 'integer' | 'boolean' = candidate.type;
            const variableValue: number | boolean = candidate.value as number | boolean;
            variable = { name: candidate.name, type: variableType, value: variableValue, expectedValue: candidate.expectedValue };
        }
        return executeComponentOperation({ kind: 'graph', operation: args.operation, sessionId: args.sessionId!, nodeReference: { id: args.nodeReference!.id! }, componentId: args.componentId!, variable, expectedGraphUuid: args.expectedGraphUuid, timeoutMs: validateTimeout(args.timeoutMs) }, assertActive, deadline);
    }

    @utcpTool('animationGraphWaitForVariable', 'Observe one exact runtime graph variable until a typed value matches. Exact graph UUID required; inspect-only, no setValue or runtime restart. Target drift/missing/type/deadline errors fail closed.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, graphUuid: { type: 'string', minLength: 1, maxLength: 256 }, name: { type: 'string', minLength: 1, maxLength: 256 }, type: { type: 'string', enum: ['float', 'integer', 'boolean'] }, value: { type: ['number', 'boolean'] }, range: { type: 'object', additionalProperties: false, properties: { min: { type: 'number' }, max: { type: 'number' } }, required: ['min', 'max'], description: 'Inclusive finite numeric variable interval, exclusive with value. Boolean ranges refused; integer ranges require integer bounds. Not transition/playability proof.' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 10000 }, pollMs: { type: 'integer', minimum: 25, maximum: 1000 } }, required: ['sessionId', 'nodeReference', 'componentId', 'graphUuid', 'name', 'type'], oneOf: [{ required: ['value'], not: { required: ['range'] } }, { required: ['range'], not: { required: ['value'] } }],
    }, { type: 'object', properties: { matched: { type: 'boolean', const: true }, observations: { type: 'integer' }, graphUuid: { type: 'string' }, variable: { type: 'object' }, writes: { type: 'boolean', const: false } }, required: ['matched', 'observations', 'graphUuid', 'variable', 'writes'] }, 'POST', ['animation', 'graph', 'wait', 'read-only'])
    async animationGraphWaitForVariable(args: BaseArgs & GraphVariableWaitCondition, assertActive?: () => void) {
        validateComponentTarget({ sessionId: args?.sessionId ?? '', nodeReference: { id: args?.nodeReference?.id ?? '' }, componentId: args?.componentId }, true);
        const { sessionId, componentId, graphUuid } = args;
        const nodeId = args.nodeReference!.id!;
        let targetId: string | undefined;
        return waitForGraphVariable(args, async timeoutMs => {
            assertActive?.();
            const result = await executeComponentOperation({ kind: 'graph', operation: 'inspect', sessionId: sessionId!, nodeReference: { id: nodeId }, componentId: componentId!, expectedGraphUuid: graphUuid, timeoutMs }, assertActive);
            assertActive?.();
            if (typeof result.targetId !== 'string' || !result.targetId) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Graph observation target identity is unavailable.' });
            if (targetId !== undefined && result.targetId !== targetId) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Graph target changed during variable wait.' });
            targetId = result.targetId;
            return result;
        });
    }
}
