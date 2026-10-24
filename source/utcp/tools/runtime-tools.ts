import { createHash } from 'crypto';
import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { executeGameViewOperation, executeGameViewSceneTransition, setGameViewTimeScale } from '../utils/game-view-transport';
import { RuntimePreviewResult, RuntimeSessionTools } from './runtime-session-tools';
import { observeRuntimeNode } from '../../runtime-node-observe';
import { unitQuaternion, orientationMatches } from '../utils/node-orientation';

const sessions = new RuntimeSessionTools();
type PreviewArgs = Parameters<RuntimeSessionTools['previewControl']>[0];
type PlaybackArgs = Omit<PreviewArgs, 'operation' | 'targetKind'>;
const playbackProperties = {
    sessionId: { type: 'string', minLength: 1, maxLength: 64 },
    targetId: { type: 'string', minLength: 1, maxLength: 256, description: 'Optional expected Game View scene UUID.' },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 60000 },
} as const;

// Public controls share the session lifecycle's Game View authority and postconditions.
export class RuntimeTools {
    @utcpTool('runtimeNodeObserve', 'Read exact Game View node activation/local position/world position/local scale/local and world quaternions without edit-scene fallback or mutation. Bounded10000-node/256-depth traversal; Creator3.7.x only.', {
        type: 'object', additionalProperties: false, properties: { sessionId: { type: 'string', minLength: 1, maxLength: 64 }, nodeReference: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['id'] }, expectedHierarchyRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' }, childOffset: { type: 'integer', minimum: 0, maximum: 9999, default: 0 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 } }, required: ['sessionId', 'nodeReference'],
    }, { type: 'object', properties: { sessionId: { type: 'string' }, targetId: { type: 'string' }, nodeUuid: { type: 'string' }, siblingIndex: { type: ['integer', 'null'], minimum: 0 }, parentUuid: { type: ['string', 'null'] }, childUuids: { type: 'array', maxItems: 128, items: { type: 'string' } }, childCount: { type: 'integer', minimum: 0 }, hierarchyRevision: { type: 'string' }, childOffset: { type: 'integer' }, nextChildOffset: { type: ['integer', 'null'] }, childrenTruncated: { type: 'boolean' }, active: { type: 'boolean' }, activeInHierarchy: { type: 'boolean' }, position: { type: 'object' }, worldPosition: { type: 'object' }, scale: { type: 'object' }, rotation: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, w: { type: 'number' } }, required: ['x', 'y', 'z', 'w'] }, worldRotation: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, w: { type: 'number' } }, required: ['x', 'y', 'z', 'w'] }, writes: { type: 'boolean', const: false } }, required: ['sessionId', 'targetId', 'nodeUuid', 'parentUuid', 'siblingIndex', 'childUuids', 'childCount', 'hierarchyRevision', 'childOffset', 'nextChildOffset', 'childrenTruncated', 'active', 'activeInHierarchy', 'position', 'worldPosition', 'scale', 'rotation', 'worldRotation', 'writes'] }, 'GET', ['node', 'runtime', 'observe', 'read-only'])
    async runtimeNodeObserve(args: { sessionId: string; nodeReference: { id: string }; expectedHierarchyRevision?: string; childOffset?: number; timeoutMs?: number }, assertActive?: () => void) {
        const timeoutMs = args?.timeoutMs ?? 1000;
        if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim() || args.sessionId.length > 64 || typeof args.nodeReference?.id !== 'string' || !args.nodeReference.id.trim() || args.nodeReference.id.length > 256 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Exact bounded session/node and timeout100..3000 required.' });
        const childOffset = args.childOffset ?? 0;
        if (!Number.isSafeInteger(childOffset) || childOffset < 0 || childOffset > 9999) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'childOffset must be0..9999.' });
        if (args.expectedHierarchyRevision !== undefined && (typeof args.expectedHierarchyRevision !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedHierarchyRevision))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedHierarchyRevision must be lowercase SHA256.' });
        args = { ...args, nodeReference: { id: args.nodeReference.id } };
        const deadline = Date.now() + timeoutMs;
        const phase = async <T>(operation: () => Promise<T>): Promise<T> => {
            assertActive?.();
            const remaining = deadline - Date.now();
            if (remaining < 100) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Node observation has insufficient remaining time for a bounded phase.' });
            let timer: NodeJS.Timeout | undefined;
            try {
                const value = await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Node observation caller deadline elapsed; in-flight read may settle later.' })), remaining); })]);
                assertActive?.();
                if (Date.now() >= deadline) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Node observation phase settled after caller deadline.' });
                return value;
            } finally { clearTimeout(timer); }
        };
        const inspected = await phase(() => sessions.runtimeSessionLifecycle({ operation: 'inspect', sessionId: args.sessionId, timeoutMs: Math.max(100, deadline - Date.now()) }));
        const session = inspected.session;
        if (!inspected.ready || !session || !('status' in session) || session.status !== 'attached' || session.targetKind !== 'game-view' || session.sessionId !== args.sessionId) throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'Exact attached Game View session required.' });
        const source = `(${observeRuntimeNode.toString()})(${JSON.stringify(args.nodeReference.id)}, ${deadline}, ${childOffset})`;
        const result = await phase(() => executeGameViewOperation(session.targetId, source, Math.max(1, deadline - Date.now()), false)) as ReturnType<typeof observeRuntimeNode>;
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Runtime node observation unavailable.' });
        if ('code' in result) throw new ToolError({ code: result.code, status: result.code === 'NODE_NOT_FOUND' ? 404 : 409, message: result.message });
        if (result.nodeUuid !== args.nodeReference.id || typeof result.active !== 'boolean' || typeof result.activeInHierarchy !== 'boolean' || [result.position, result.worldPosition, result.scale].some(v => !v || [v.x, v.y, v.z].some(n => typeof n !== 'number' || !Number.isFinite(n)))) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Runtime node identity/metrics invalid.' });
        if ([result.rotation, result.worldRotation].some(q => !q || [q.x, q.y, q.z, q.w].some(n => typeof n !== 'number' || !Number.isFinite(n)))) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Finite native quaternion metrics unavailable.' });
        if (result.parentUuid !== null && (typeof result.parentUuid !== 'string' || !result.parentUuid || result.parentUuid.length > 256) || !Number.isSafeInteger(result.childCount) || result.childCount < 0 || result.childCount > 10000 || !Array.isArray(result.childUuids) || result.childUuids.length !== Math.min(result.childCount - childOffset, 128) || Array.from(result.childUuids).some(id => typeof id !== 'string' || !id || id.length > 256) || new Set(result.childUuids).size !== result.childUuids.length || result.childOffset !== childOffset || childOffset > result.childCount || result.nextChildOffset !== (childOffset + result.childUuids.length < result.childCount ? childOffset + result.childUuids.length : null) || result.childrenTruncated !== (childOffset > 0 || result.nextChildOffset !== null)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Runtime hierarchy identity/count invalid.' });
        if (result.parentUuid === null ? result.siblingIndex !== null : !Number.isSafeInteger(result.siblingIndex) || result.siblingIndex! < 0 || result.siblingIndex! > 9999) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Runtime sibling index unavailable or inconsistent with parent.' });
        const after = await phase(() => sessions.runtimeSessionLifecycle({ operation: 'inspect', sessionId: args.sessionId, timeoutMs: Math.max(100, deadline - Date.now()) }));
        if (!after.ready || !after.session || !('status' in after.session) || after.session.status !== 'attached' || after.session.sessionId !== session.sessionId || after.session.targetId !== session.targetId || after.session.createdAt !== session.createdAt) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Session changed during node observation.' });
        if (typeof result.hierarchyIdentity !== 'string' || Buffer.byteLength(result.hierarchyIdentity) > 3000000) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Bounded hierarchy identity unavailable.' });
        const hierarchyRevision = createHash('sha256').update(JSON.stringify([session.sessionId, session.createdAt, session.targetId, result.nodeUuid, result.hierarchyIdentity])).digest('hex');
        if (args.expectedHierarchyRevision !== undefined && args.expectedHierarchyRevision !== hierarchyRevision) throw new ToolError({ code: 'RUNTIME_HIERARCHY_CHANGED', status: 409, message: 'Parent or direct child identity/order changed; restart paging.' });
        const { hierarchyIdentity, ...observation } = result;
        if (Date.now() >= deadline) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Node observation processing exceeded caller deadline.' });
        return { sessionId: session.sessionId, targetId: session.targetId, ...observation, hierarchyRevision, writes: false as const };
    }

    @utcpTool('runtimeNodeWaitForState', 'Read-only exact Game View node activation/position wait. Requires activation and/or explicit local/world position with per-axis inclusive tolerance; one caller deadline, no activation writes or absence-as-inactive inference.', {
        type: 'object', additionalProperties: false, properties: { sessionId: { type: 'string', minLength: 1, maxLength: 64 }, nodeReference: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['id'] }, siblingIndex: { type: ['integer', 'null'], minimum: 0, maximum: 9999 }, minChildCount: { type: 'integer', minimum: 0, maximum: 9999 }, maxChildCount: { type: 'integer', minimum: 0, maximum: 9999 }, parentUuid: { type: ['string', 'null'], minLength: 1, maxLength: 256, description: 'Exact parent UUID, null only for observed root; omitted means no parent predicate.' }, active: { type: 'boolean' }, activeInHierarchy: { type: 'boolean' }, position: { type: 'object', additionalProperties: false, properties: { space: { type: 'string', enum: ['local', 'world'] }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, tolerance: { type: 'number', minimum: 0, maximum: 1000000 } }, required: ['space', 'x', 'y', 'z', 'tolerance'] }, rotation: { type: 'object', additionalProperties: false, properties: { space: { type: 'string', enum: ['local', 'world'] }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, w: { type: 'number' }, toleranceDegrees: { type: 'number', minimum: 0, maximum: 180 } }, required: ['space', 'x', 'y', 'z', 'w', 'toleranceDegrees'] }, scale: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, tolerance: { type: 'number', minimum: 0, maximum: 1000000 } }, required: ['x', 'y', 'z', 'tolerance'], description: 'Local scale, inclusive per-axis tolerance; negative/zero scales permitted.' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 10000 }, pollMs: { type: 'integer', minimum: 25, maximum: 1000 } }, required: ['sessionId', 'nodeReference'],
    }, { type: 'object', properties: { matched: { type: 'boolean', const: true }, observations: { type: 'integer' }, observation: { type: 'object' } }, required: ['matched', 'observations', 'observation'] }, 'GET', ['node', 'runtime', 'wait', 'read-only'])
    async runtimeNodeWaitForState(args: { sessionId: string; nodeReference: { id: string }; siblingIndex?: number | null; minChildCount?: number; maxChildCount?: number; parentUuid?: string | null; active?: boolean; activeInHierarchy?: boolean; position?: { space: 'local' | 'world'; x: number; y: number; z: number; tolerance: number }; rotation?: { space: 'local' | 'world'; x: number; y: number; z: number; w: number; toleranceDegrees: number }; scale?: { x: number; y: number; z: number; tolerance: number }; timeoutMs?: number; pollMs?: number }, assertActive?: () => void) {
        const timeoutMs = args?.timeoutMs ?? 3000, pollMs = args?.pollMs ?? 100;
        if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim() || args.sessionId.length > 64 || typeof args.nodeReference?.id !== 'string' || !args.nodeReference.id.trim() || args.nodeReference.id.length > 256
            || args.active === undefined && args.activeInHierarchy === undefined && args.position === undefined && args.rotation === undefined && args.scale === undefined && args.parentUuid === undefined && args.minChildCount === undefined && args.maxChildCount === undefined && args.siblingIndex === undefined || args.active !== undefined && typeof args.active !== 'boolean' || args.activeInHierarchy !== undefined && typeof args.activeInHierarchy !== 'boolean'
            || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000 || !Number.isInteger(pollMs) || pollMs < 25 || pollMs > 1000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide exact session/node, boolean activation condition and bounded deadline/poll interval.' });
        if (args.parentUuid !== undefined && args.parentUuid !== null && (typeof args.parentUuid !== 'string' || !args.parentUuid.trim() || args.parentUuid.length > 256 || args.parentUuid === args.nodeReference.id)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'parentUuid must be null or one bounded non-self UUID.' });
        if ([args.minChildCount, args.maxChildCount].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0 || n > 9999)) || args.minChildCount !== undefined && args.maxChildCount !== undefined && args.minChildCount > args.maxChildCount) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Child count interval must contain integers0..9999 with min<=max.' });
        if (args.siblingIndex !== undefined && args.siblingIndex !== null && (!Number.isSafeInteger(args.siblingIndex) || args.siblingIndex < 0 || args.siblingIndex > 9999)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'siblingIndex must be null(root) or integer0..9999.' });
        let position = args.position;
        if (position !== undefined && (!position || typeof position !== 'object' || Array.isArray(position) || Object.keys(position).some(key => !['space', 'x', 'y', 'z', 'tolerance'].includes(key)) || !['local', 'world'].includes(position.space) || [position.x, position.y, position.z, position.tolerance].some(value => typeof value !== 'number' || !Number.isFinite(value)) || position.tolerance < 0 || position.tolerance > 1000000)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Position requires explicit local/world space, finite xyz and tolerance0..1000000.' });
        let rotation = args.rotation;
        if (rotation !== undefined && (!rotation || typeof rotation !== 'object' || Array.isArray(rotation) || Object.keys(rotation).some(key => !['space', 'x', 'y', 'z', 'w', 'toleranceDegrees'].includes(key)) || !['local', 'world'].includes(rotation.space) || typeof rotation.toleranceDegrees !== 'number' || !Number.isFinite(rotation.toleranceDegrees) || rotation.toleranceDegrees < 0 || rotation.toleranceDegrees > 180)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Rotation requires local/world quaternion and toleranceDegrees0..180.' });
        const expectedRotation = rotation ? unitQuaternion(rotation, 'INVALID_ARGUMENT') : undefined;
        let scale = args.scale;
        if (scale !== undefined && (!scale || typeof scale !== 'object' || Array.isArray(scale) || Object.keys(scale).some(key => !['x', 'y', 'z', 'tolerance'].includes(key)) || [scale.x, scale.y, scale.z, scale.tolerance].some(value => typeof value !== 'number' || !Number.isFinite(value)) || scale.tolerance < 0 || scale.tolerance > 1000000)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Local scale requires finite xyz and tolerance0..1000000.' });
        position = position === undefined ? undefined : { ...position };
        rotation = rotation === undefined ? undefined : { ...rotation };
        scale = scale === undefined ? undefined : { ...scale };
        args = { ...args, nodeReference: { id: args.nodeReference.id }, position, rotation, scale };
        const deadline = Date.now() + timeoutMs; let observations = 0; let targetId: string | undefined;
        for (;;) {
            assertActive?.();
            const remaining = deadline - Date.now();
            if (remaining < 100) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Node wait has insufficient remaining time for a bounded read; no next observation dispatched.' });
            let timer: NodeJS.Timeout | undefined;
            let observation: Awaited<ReturnType<RuntimeTools['runtimeNodeObserve']>>;
            try {
                observation = await Promise.race([this.runtimeNodeObserve({ sessionId: args.sessionId, nodeReference: { id: args.nodeReference.id }, timeoutMs: Math.max(100, Math.min(remaining, 1000)) }, assertActive), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Node observation exceeded caller deadline; in-flight read may settle later.' })), remaining); })]);
            } finally { clearTimeout(timer); }
            assertActive?.();
            if (Date.now() >= deadline) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Node observation completed after deadline.' });
            if (observation.sessionId !== args.sessionId || observation.nodeUuid !== args.nodeReference.id || typeof observation.targetId !== 'string' || !observation.targetId || typeof observation.active !== 'boolean' || typeof observation.activeInHierarchy !== 'boolean') throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Node activation observation identity/state invalid.' });
            if (targetId !== undefined && observation.targetId !== targetId) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Scene identity changed during node activation wait.' });
            targetId = observation.targetId; observations++;
            if (args.parentUuid !== undefined && observation.parentUuid !== null && (typeof observation.parentUuid !== 'string' || !observation.parentUuid.trim() || observation.parentUuid.length > 256)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Observed parent identity unavailable.' });
            if ((args.minChildCount !== undefined || args.maxChildCount !== undefined) && (!Number.isSafeInteger(observation.childCount) || observation.childCount < 0 || observation.childCount > 9999)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Observed direct child count unavailable.' });
            if (args.siblingIndex !== undefined && (observation.siblingIndex === null ? observation.parentUuid !== null : !Number.isSafeInteger(observation.siblingIndex) || observation.siblingIndex < 0 || observation.siblingIndex > 9999 || typeof observation.parentUuid !== 'string' || !observation.parentUuid)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Observed sibling identity unavailable.' });
            const actual = position?.space === 'world' ? observation.worldPosition : observation.position;
            if (position && (!actual || [actual.x, actual.y, actual.z].some(value => typeof value !== 'number' || !Number.isFinite(value)))) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Finite node position unavailable.' });
            const positionMatched = !position || Math.abs(actual.x - position.x) <= position.tolerance && Math.abs(actual.y - position.y) <= position.tolerance && Math.abs(actual.z - position.z) <= position.tolerance;
            const rotationMatched = !rotation || !expectedRotation || orientationMatches(rotation.space === 'world' ? observation.worldRotation : observation.rotation, expectedRotation, rotation.toleranceDegrees);
            if (scale && (!observation.scale || [observation.scale.x, observation.scale.y, observation.scale.z].some(value => typeof value !== 'number' || !Number.isFinite(value)))) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Finite local scale unavailable.' });
            const scaleMatched = !scale || Math.abs(observation.scale.x - scale.x) <= scale.tolerance && Math.abs(observation.scale.y - scale.y) <= scale.tolerance && Math.abs(observation.scale.z - scale.z) <= scale.tolerance;
            if ((args.siblingIndex === undefined || observation.siblingIndex === args.siblingIndex) && (args.minChildCount === undefined || observation.childCount >= args.minChildCount) && (args.maxChildCount === undefined || observation.childCount <= args.maxChildCount) && (args.parentUuid === undefined || observation.parentUuid === args.parentUuid) && scaleMatched && rotationMatched && positionMatched && (args.active === undefined || observation.active === args.active) && (args.activeInHierarchy === undefined || observation.activeInHierarchy === args.activeInHierarchy)) return { matched: true as const, observations, observation };
            await new Promise<void>(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
        }
    }

    @utcpTool(
        'runtimePause',
        'Pause the actual Game View runtime and verify its paused state.',
        { type: 'object', additionalProperties: false, properties: playbackProperties },
        { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
        'POST',
        ['runtime', 'pause', 'game', 'debug', 'control']
    )
    async runtimePause(args: PlaybackArgs = {}): Promise<{ success: true }> {
        await sessions.previewControl({ ...args, operation: 'pause' });
        return { success: true };
    }

    @utcpTool(
        'runtimeResume',
        'Resume the actual Game View runtime and verify its running state.',
        { type: 'object', additionalProperties: false, properties: playbackProperties },
        { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
        'POST',
        ['runtime', 'resume', 'game', 'debug', 'control']
    )
    async runtimeResume(args: PlaybackArgs = {}): Promise<{ success: true }> {
        await sessions.previewControl({ ...args, operation: 'resume' });
        return { success: true };
    }

    @utcpTool(
        'runtimeSetTimeScale',
        'Set and verify the actual Game View scheduler time scale (0 = frozen, 1 = normal, >1 = fast-forward).',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                scale: { type: 'number', minimum: 0, maximum: 10, description: 'Time scale multiplier (0-10)' },
            },
            required: ['scale'],
        },
        { type: 'object', properties: { success: { type: 'boolean' }, scale: { type: 'number' } }, required: ['success', 'scale'] },
        'POST',
        ['runtime', 'time', 'scale', 'speed', 'slow', 'fast', 'game']
    )
    async runtimeSetTimeScale(args: { scale: number }): Promise<{ success: true, scale: number }> {
        if (!Number.isFinite(args.scale) || args.scale < 0 || args.scale > 10) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'scale must be a finite number from 0 to 10.' });
        }
        const state = await setGameViewTimeScale(args.scale);
        if (!state.running || state.timeScale !== args.scale) {
            throw new ToolError({ code: 'RUNTIME_CONTROL_UNAVAILABLE', status: 409, message: 'Game View did not confirm the requested scheduler time scale.', recovery: 'Inspect Game View before retrying.' });
        }
        return { success: true, scale: state.timeScale };
    }

    @utcpTool(
        'runtimeGetState',
        'Read actual Game View paused state and nullable scheduler/frame metrics. A stopped preview is not ready.',
        { type: 'object', properties: {} },
        {
            type: 'object',
            properties: {
                paused: { type: 'boolean' },
                timeScale: { type: ['number', 'null'] },
                frameCount: { type: ['integer', 'null'], minimum: 0 },
            },
            required: ['paused', 'timeScale', 'frameCount'],
        },
        'GET',
        ['runtime', 'state', 'game', 'status', 'debug']
    )
    async runtimeGetState(): Promise<{ paused: boolean, timeScale: number | null, frameCount: number | null }> {
        const result = await sessions.previewControl({ operation: 'state' });
        if (!result.state) throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'Creator Game View preview is stopped.', recovery: 'Start Game View before reading runtime metrics.' });
        const { paused, timeScale, frameCount } = result.state;
        return { paused, timeScale, frameCount };
    }

    @utcpTool(
        'runtimePreviewControl',
        'Control the actual Creator Game View lifecycle with verified state and optional session/scene identity. Browser and simulator transports are unsupported.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                operation: { type: 'string', enum: ['start', 'pause', 'resume', 'stop', 'step', 'state'] },
                ...playbackProperties,
            },
            required: ['operation'],
        },
        {
            type: 'object',
            properties: {
                success: { type: 'boolean' },
                operation: { type: 'string' },
                session: { type: 'object' },
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
                preview: { type: 'object' },
                ready: { type: 'boolean' },
            },
            required: ['success', 'operation', 'preview', 'ready'],
        },
        'POST',
        ['runtime', 'session', 'preview', 'start', 'stop', 'pause', 'resume', 'step', 'state']
    )
    async runtimeSessionManage(args: PreviewArgs): Promise<RuntimePreviewResult> {
        return sessions.previewControl(args);
    }

    @utcpTool(
        'runtimeScenePreload',
        'Preload one named scene in the attached Creator 3.7.3 Game View without changing the active scene. Returns bounded native progress samples and preserves the session identity.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                sessionId: { type: 'string', minLength: 1, maxLength: 64 },
                sceneName: { type: 'string', minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9_./-]+$' },
                timeoutMs: { type: 'integer', minimum: 500, maximum: 10000 },
                maxProgressSamples: { type: 'integer', minimum: 1, maximum: 64, default: 32 },
            },
            required: ['sessionId', 'sceneName'],
        },
        {
            type: 'object',
            properties: {
                success: { type: 'boolean', const: true },
                sessionId: { type: 'string' },
                targetId: { type: 'string' },
                sceneName: { type: 'string' },
                sceneUnchanged: { type: 'boolean', const: true },
                preloaded: { type: 'boolean', const: true },
                progress: { type: 'array', maxItems: 64 },
                progressTruncated: { type: 'boolean' },
                writes: { type: 'boolean', const: false },
            },
            required: ['success', 'sessionId', 'targetId', 'sceneName', 'sceneUnchanged', 'preloaded', 'progress', 'progressTruncated', 'writes'],
        },
        'POST',
        ['runtime', 'scene', 'preload', 'progress', 'read-only'],
    )
    async runtimeScenePreload(args: { sessionId: string; sceneName: string; timeoutMs?: number; maxProgressSamples?: number }): Promise<Record<string, unknown>> {
        const timeoutMs = args?.timeoutMs ?? 5000;
        const maxProgressSamples = args?.maxProgressSamples ?? 32;
        if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim() || args.sessionId.length > 64
            || typeof args.sceneName !== 'string' || !/^[A-Za-z0-9_./-]{1,256}$/.test(args.sceneName) || args.sceneName.split('/').some(part => part === '.' || part === '..')
            || !Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 10000
            || !Number.isInteger(maxProgressSamples) || maxProgressSamples < 1 || maxProgressSamples > 64) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'runtimeScenePreload requires a bounded session, scene name, timeout and progress cap.' });
        }
        const inspected = await sessions.runtimeSessionLifecycle({ operation: 'inspect', sessionId: args.sessionId, timeoutMs });
        const session = inspected.session;
        if (!inspected.ready || !session || !('status' in session) || session.status !== 'attached' || session.targetKind !== 'game-view' || session.sessionId !== args.sessionId || typeof session.targetId !== 'string') {
            throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'An attached Game View session is required for scene preload.' });
        }
        const request = `new Promise((resolve, reject) => { const samples = []; let settled = false; const push = (completed, total) => { if (samples.length >= ${maxProgressSamples}) return; if (Number.isFinite(completed) && Number.isFinite(total) && total >= 0 && completed >= 0 && completed <= total) samples.push({ completed, total, ratio: total === 0 ? 1 : completed / total }); }; const finish = (error) => { if (settled) return; settled = true; if (error) reject(error); else resolve({ samples }); }; const accepted = globalThis.cc.director.preloadScene(${JSON.stringify(args.sceneName)}, push, finish); if (accepted === false) finish(new Error('Creator rejected scene preload')); })`;
        const result = await executeGameViewOperation(session.targetId, request, timeoutMs, false);
        if (!result || typeof result !== 'object' || Array.isArray(result) || !('samples' in result) || !Array.isArray((result as { samples?: unknown }).samples)) {
            throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Scene preload returned no bounded progress result.' });
        }
        const samples = (result as { samples: unknown[] }).samples;
        if (samples.length > maxProgressSamples || samples.some(sample => !sample || typeof sample !== 'object' || Array.isArray(sample))) {
            throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Scene preload returned malformed progress samples.' });
        }
        const after = await sessions.runtimeSessionLifecycle({ operation: 'inspect', sessionId: args.sessionId, timeoutMs });
        if (!after.ready || !after.session || !('status' in after.session) || after.session.status !== 'attached' || after.session.sessionId !== session.sessionId || after.session.targetId !== session.targetId || after.session.createdAt !== session.createdAt) {
            throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Runtime session changed during scene preload.' });
        }
        return { success: true, sessionId: session.sessionId, targetId: session.targetId, sceneName: args.sceneName, sceneUnchanged: true, preloaded: true, progress: samples, progressTruncated: samples.length >= maxProgressSamples, writes: false };
    }

    @utcpTool(
        'runtimeSceneTransition',
        'Load one exact named scene in the attached Creator 3.7.3 Game View, verify the new runtime scene identity, and invalidate the old session handle. Attach a new session before further node/component operations.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                sessionId: { type: 'string', minLength: 1, maxLength: 64 },
                sceneName: { type: 'string', minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9_./-]+$' },
                expectedSceneUuid: { type: 'string', minLength: 1, maxLength: 256 },
                timeoutMs: { type: 'integer', minimum: 500, maximum: 10000 },
            },
            required: ['sessionId', 'sceneName'],
        },
        {
            type: 'object',
            properties: {
                success: { type: 'boolean', const: true },
                sessionId: { type: 'string' },
                targetId: { type: 'string' },
                previousSceneUuid: { type: 'string' },
                sceneUuid: { type: 'string' },
                sceneName: { type: 'string' },
                sessionInvalidated: { type: 'boolean', const: true },
                newSessionRequired: { type: 'boolean', const: true },
            },
            required: ['success', 'sessionId', 'targetId', 'previousSceneUuid', 'sceneUuid', 'sceneName', 'sessionInvalidated', 'newSessionRequired'],
        },
        'POST',
        ['runtime', 'scene', 'transition', 'load', 'game-view'],
    )
    async runtimeSceneTransition(args: { sessionId: string; sceneName: string; expectedSceneUuid?: string; timeoutMs?: number }): Promise<Record<string, unknown>> {
        if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim() || args.sessionId.length > 64
            || typeof args.sceneName !== 'string' || !/^[A-Za-z0-9_./-]{1,256}$/.test(args.sceneName) || args.sceneName.split('/').some(part => part === '.' || part === '..')
            || args.expectedSceneUuid !== undefined && (typeof args.expectedSceneUuid !== 'string' || !args.expectedSceneUuid.trim() || args.expectedSceneUuid.length > 256)
            || !Number.isInteger(args.timeoutMs ?? 5000) || (args.timeoutMs ?? 5000) < 500 || (args.timeoutMs ?? 5000) > 10000) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'runtimeSceneTransition requires a bounded session, scene name and timeout.' });
        }
        const timeoutMs = args.timeoutMs ?? 5000;
        const inspected = await sessions.runtimeSessionLifecycle({ operation: 'inspect', sessionId: args.sessionId, timeoutMs });
        const session = inspected.session;
        if (!inspected.ready || !session || !('status' in session) || session.status !== 'attached' || session.targetKind !== 'game-view' || session.sessionId !== args.sessionId || typeof session.targetId !== 'string') {
            throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'An attached Game View session is required for scene transition.' });
        }
        const request = `new Promise((resolve, reject) => { let settled = false; const finish = (error) => { if (settled) return; settled = true; if (error) reject(error); else resolve(true); }; const accepted = globalThis.cc.director.loadScene(${JSON.stringify(args.sceneName)}, finish); if (accepted === false) finish(new Error('Creator rejected scene load')); })`;
        const transition = await executeGameViewSceneTransition(session.targetId, request, timeoutMs);
        if (!transition || typeof transition !== 'object' || Array.isArray(transition)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Scene transition returned no bounded identity.' });
        const result = transition as Record<string, unknown>;
        if (typeof result.sceneUuid !== 'string' || !result.sceneUuid.trim() || result.sceneUuid.length > 256) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Scene transition returned an invalid new scene identity.' });
        await sessions.runtimeSessionLifecycle({ operation: 'reset', sessionId: args.sessionId });
        if (args.expectedSceneUuid !== undefined && result.sceneUuid !== args.expectedSceneUuid) {
            throw new ToolError({ code: 'SCENE_TRANSITION_TARGET_MISMATCH', status: 409, message: 'Loaded scene UUID did not match expectedSceneUuid.', details: { expectedSceneUuid: args.expectedSceneUuid, sceneUuid: result.sceneUuid } });
        }
        return { success: true, sessionId: args.sessionId, targetId: session.targetId, previousSceneUuid: session.targetId, sceneUuid: result.sceneUuid, sceneName: args.sceneName, sessionInvalidated: true, newSessionRequired: true };
    }
}
