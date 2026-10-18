import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { ProjectTools } from './project-tools';
import { executeComponentOperation } from '../utils/game-view-components';

const projectTools = new ProjectTools();

function requireText(value: unknown, name: string, max = 256): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${name} must be a non-empty string of at most ${max} characters.` });
    }
    return value;
}

const PHYSICS_PATHS = new Set(['physics.gravity', 'physics.allowSleep', 'physics.sleepThreshold', 'physics.autoSimulation', 'physics.fixedTimeStep', 'physics.maxSubSteps', 'physics.defaultMaterial', 'physics.collisionGroups', 'physics.collisionMatrix']);
function validatePhysicsSetting(path: string, value: unknown): void {
    if (!PHYSICS_PATHS.has(path) && !/^physics\.(collisionGroups|collisionMatrix)\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/.test(path)) throw new ToolError({ code: 'UNSUPPORTED_SETTING', status: 422, message: `Physics setting '${path}' is outside the bounded Creator project settings contract.` });
    if (path === 'physics.gravity') {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !['x', 'y', 'z'].every(key => typeof (value as Record<string, unknown>)[key] === 'number' && Number.isFinite((value as Record<string, unknown>)[key]))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'physics.gravity requires finite numeric x, y and z.' });
    } else if (['physics.allowSleep', 'physics.autoSimulation'].includes(path) && typeof value !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${path} requires a boolean.` });
    else if (['physics.sleepThreshold', 'physics.fixedTimeStep'].includes(path) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 60)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${path} requires a finite number from 0 to 60.` });
    else if (path === 'physics.maxSubSteps' && (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 64)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'physics.maxSubSteps requires an integer from 1 to 64.' });
}

export class P4ContractTools {
    @utcpTool('physics2dConfigure', 'Configure bounded 2D physics project settings only when Creator exposes a verified project settings writer, then query and verify the persisted value.', {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string', minLength: 1, maxLength: 256 }, value: {} },
        required: ['path', 'value'],
    }, { type: 'object', properties: { success: { type: 'boolean' }, path: { type: 'string' }, readBack: {} }, required: ['success', 'path', 'readBack'] }, 'POST', ['physics', '2d', 'configure'])
    async physics2dConfigure(args: { path?: string, value?: unknown }): Promise<{ success: boolean, path: string, readBack: unknown }> {
        const path = requireText(args?.path, 'path'); validatePhysicsSetting(path, args?.value);
        return projectTools.projectSetConfig({ path, value: args?.value });
    }

    @utcpTool('physics3dConfigure', 'Configure bounded 3D physics project settings only when Creator exposes a verified project settings writer, then query and verify the persisted value.', {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string', minLength: 1, maxLength: 256 }, value: {} },
        required: ['path', 'value'],
    }, { type: 'object', properties: { success: { type: 'boolean' }, path: { type: 'string' }, readBack: {} }, required: ['success', 'path', 'readBack'] }, 'POST', ['physics', '3d', 'configure'])
    async physics3dConfigure(args: { path?: string, value?: unknown }): Promise<{ success: boolean, path: string, readBack: unknown }> {
        const path = requireText(args?.path, 'path'); validatePhysicsSetting(path, args?.value);
        return projectTools.projectSetConfig({ path, value: args?.value });
    }

    @utcpTool('particlePlayback', 'Control or inspect one exact cc.ParticleSystem in the active Game View with actual state read-back. inspect never invokes playback.', {
        type: 'object', additionalProperties: false,
        properties: {
            sessionId: { type: 'string', minLength: 1, maxLength: 64 },
            operation: { type: 'string', enum: ['play', 'stop', 'clear', 'inspect'] },
            nodeReference: {
                type: 'object', additionalProperties: false,
                properties: { id: { type: 'string', minLength: 1, maxLength: 256 } },
                required: ['id'],
            },
            componentId: { type: 'string', minLength: 1, maxLength: 256 },
            timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 },
        },
        required: ['sessionId', 'operation', 'nodeReference'],
    }, { type: 'object', properties: { success: { type: 'boolean' }, sessionId: { type: 'string' }, targetId: { type: 'string' }, operation: { type: 'string' }, nodeReference: {}, nodeUuid: { type: 'string' }, componentId: { type: 'string' }, state: {} }, required: ['success', 'sessionId', 'targetId', 'operation', 'nodeReference', 'nodeUuid', 'componentId', 'state'] }, 'POST', ['particle', 'playback', 'runtime'])
    async particlePlayback(args: { sessionId?: string, operation?: string, nodeReference?: { id?: string }, componentId?: string, timeoutMs?: number }, assertActive?: () => void, deadline?: number): Promise<Record<string, unknown>> {
        const sessionId = requireText(args?.sessionId, 'sessionId', 64);
        const nodeId = requireText(args?.nodeReference?.id, 'nodeReference.id');
        if (!['play', 'stop', 'clear', 'inspect'].includes(String(args.operation))) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation must be play, stop, clear, or inspect.' });
        }
        if (args.componentId !== undefined) requireText(args.componentId, 'componentId');
        if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 100 || args.timeoutMs > 3000)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'timeoutMs must be an integer from 100 to 3000.' });
        return executeComponentOperation({ kind: 'particle', operation: String(args.operation), sessionId, nodeReference: { id: nodeId }, componentId: args.componentId, timeoutMs: args.timeoutMs ?? 1000 }, assertActive, deadline);
    }

    @utcpTool('particleWaitForState', 'Observe one exact Game View ParticleSystem until playing/count conditions match or the deadline expires. Read-only: never calls play/stop/clear. Exact componentId required; invalidated sessions fail closed.', {
        type: 'object', additionalProperties: false,
        properties: { sessionId: { type: 'string', minLength: 1, maxLength: 64 }, nodeReference: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['id'] }, componentId: { type: 'string', minLength: 1, maxLength: 256 }, playing: { type: 'boolean' }, minParticleCount: { type: 'integer', minimum: 0, maximum: 1000000 }, maxParticleCount: { type: 'integer', minimum: 0, maximum: 1000000 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 10000, default: 3000 }, pollMs: { type: 'integer', minimum: 25, maximum: 1000, default: 100 } }, required: ['sessionId', 'nodeReference', 'componentId'],
    }, { type: 'object', properties: { matched: { type: 'boolean' }, timedOut: { type: 'boolean' }, observations: { type: 'integer' }, state: { type: 'object' } }, required: ['matched', 'timedOut', 'observations', 'state'] }, 'POST', ['particle', 'runtime', 'wait', 'read-only'])
    async particleWaitForState(args: { sessionId: string; nodeReference: { id: string }; componentId: string; playing?: boolean; minParticleCount?: number; maxParticleCount?: number; timeoutMs?: number; pollMs?: number }, assertActive?: () => void) {
        requireText(args?.sessionId, 'sessionId', 64); requireText(args?.nodeReference?.id, 'nodeReference.id'); requireText(args?.componentId, 'componentId');
        const timeoutMs = args.timeoutMs ?? 3000; const pollMs = args.pollMs ?? 100;
        if (args.playing === undefined && args.minParticleCount === undefined && args.maxParticleCount === undefined || args.playing !== undefined && typeof args.playing !== 'boolean'
            || args.minParticleCount !== undefined && (!Number.isInteger(args.minParticleCount) || args.minParticleCount < 0 || args.minParticleCount > 1000000)
            || args.minParticleCount !== undefined && args.maxParticleCount !== undefined && args.minParticleCount > args.maxParticleCount
            || args.maxParticleCount !== undefined && (!Number.isInteger(args.maxParticleCount) || args.maxParticleCount < 0 || args.maxParticleCount > 1000000)
            || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000 || !Number.isInteger(pollMs) || pollMs < 25 || pollMs > 1000) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide playing/count condition and bounded timeout/poll interval.' });
        }
        args = { ...args, nodeReference: { id: args.nodeReference.id } };
        const deadline = Date.now() + timeoutMs; let observations = 0;
        let targetId: string | undefined;
        for (;;) {
            assertActive?.();
            const remaining = deadline - Date.now();
            if (remaining < 100) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Particle observation has insufficient remaining time for a bounded read; no next read dispatched.' });
            let timer: NodeJS.Timeout | undefined;
            let result: Record<string, unknown>;
            try {
                result = await Promise.race([executeComponentOperation({ kind: 'particle', operation: 'inspect', sessionId: args.sessionId, nodeReference: args.nodeReference, componentId: args.componentId, timeoutMs: Math.min(remaining, 1000) }, assertActive), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Particle state read exceeded caller deadline; no playback mutation dispatched.' })), remaining); })]);
            } finally { clearTimeout(timer); }
            assertActive?.();
            if (Date.now() >= deadline) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Particle state read completed after caller deadline; no playback mutation dispatched.' });
            if (typeof result.targetId !== 'string' || !result.targetId) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Particle observation target identity is unavailable.' });
            if (targetId !== undefined && result.targetId !== targetId) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Particle target changed during state wait.' });
            targetId = result.targetId;
            observations++;
            const state = result.state as { playing?: unknown; particleCount?: unknown } | undefined;
            if (!state || typeof state.playing !== 'boolean') throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Particle inspect returned no valid state.' });
            if (typeof state.particleCount !== 'number' || !Number.isSafeInteger(state.particleCount) || state.particleCount < 0) throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_METRIC', status: 422, message: 'Particle count must be a non-negative safe integer.' });
            const matched = (args.playing === undefined || state.playing === args.playing) && (args.minParticleCount === undefined || state.particleCount >= args.minParticleCount) && (args.maxParticleCount === undefined || (state.particleCount as number) <= args.maxParticleCount);
            if (matched || Date.now() >= deadline) return { matched, timedOut: !matched, observations, state };
            await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
        }
    }
}
