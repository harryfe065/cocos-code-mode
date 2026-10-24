export type PersistentRootOperation = 'add' | 'remove';

export interface PersistentRootResult {
    nodeUuid: string;
    operation: PersistentRootOperation;
    sceneUuid: string;
    parentUuidBefore: string | null;
    parentUuidAfter: string | null;
    registered: boolean;
    removed: boolean;
}

type RuntimeNode = { uuid: string; parent: RuntimeNode | null; children: RuntimeNode[] };

type RuntimeCc = {
    GAME_VIEW?: boolean;
    ENGINE_VERSION?: string;
    VERSION?: string;
    director?: {
        getScene(): RuntimeNode | null;
        addPersistRootNode?(node: RuntimeNode): void;
        removePersistRootNode?(node: RuntimeNode): void;
    };
    isValid(value: unknown, strict?: boolean): boolean;
};

export function mutateRuntimePersistentRoot(nodeUuid: string, operation: PersistentRootOperation, expiresAt: number): PersistentRootResult | { code: string; message: string } {
    try {
        const fail = (code: string, message: string): never => { throw { code, message }; };
        if (typeof nodeUuid !== 'string' || !nodeUuid.trim() || nodeUuid.length > 256) fail('INVALID_ARGUMENT', 'A bounded node UUID is required.');
        if (operation !== 'add' && operation !== 'remove') fail('INVALID_ARGUMENT', 'Persistent-root operation must be add or remove.');
        if (Date.now() >= expiresAt) fail('RUNTIME_STATE_TIMEOUT', 'Persistent-root operation deadline elapsed.');
        const cc = globalThis as unknown as { cc?: RuntimeCc };
        const engine = cc.cc ?? fail('UNSUPPORTED_RUNTIME_TRANSPORT', 'Actual Game View required.');
        if (engine.GAME_VIEW !== true) fail('UNSUPPORTED_RUNTIME_TRANSPORT', 'Actual Game View required.');
        if (!/^3\.7\./.test(engine.ENGINE_VERSION ?? engine.VERSION ?? '')) fail('UNSUPPORTED_VERSION', 'Persistent-root operations require Creator3.7.x.');
        const director = engine.director ?? fail('RUNTIME_NOT_READY', 'Creator director is unavailable.');
        const scene = director.getScene() ?? fail('RUNTIME_NOT_READY', 'No running Game View scene.');
        if (typeof scene.uuid !== 'string' || !scene.uuid) fail('RUNTIME_NOT_READY', 'No running Game View scene.');
        const stack: RuntimeNode[] = [scene];
        const seen = new Set<RuntimeNode>();
        let target: RuntimeNode | undefined;
        while (stack.length) {
            if (Date.now() >= expiresAt) fail('RUNTIME_STATE_TIMEOUT', 'Persistent-root operation deadline elapsed.');
            const node = stack.pop()!;
            if (!node || typeof node.uuid !== 'string' || !Array.isArray(node.children) || seen.has(node)) fail('RUNTIME_TREE_INVALID', 'Malformed or repeated runtime node.');
            seen.add(node);
            if (node.uuid === nodeUuid) {
                if (target) fail('AMBIGUOUS_RUNTIME_TARGET', 'Duplicate runtime node identity.');
                target = node;
            }
            if (seen.size > 10000) fail('RUNTIME_TRAVERSAL_LIMIT', 'Runtime tree exceeds10000 nodes.');
            for (const child of node.children) {
                if (!child || child.parent !== node) fail('RUNTIME_TREE_INVALID', 'Runtime child parent mismatch.');
                stack.push(child);
            }
        }
        const targetNode = target ?? fail('NODE_NOT_FOUND', 'Exact runtime node absent.');
        const parent = targetNode.parent ?? fail('INVALID_PERSISTENT_ROOT_TARGET', 'Persistent-root operations require an exact scene-root child.');
        if (targetNode === scene || parent !== scene) fail('INVALID_PERSISTENT_ROOT_TARGET', 'Persistent-root operations require an exact scene-root child.');
        const parentUuidBefore = parent.uuid;
        const method = (operation === 'add' ? director.addPersistRootNode : director.removePersistRootNode) ?? fail('UNSUPPORTED_RUNTIME_API', `Creator does not expose director.${operation === 'add' ? 'addPersistRootNode' : 'removePersistRootNode'}.`);
        method.call(director, targetNode);
        const parentAfter = targetNode.parent ?? fail('RUNTIME_TARGET_CHANGED', 'Persistent-root target lost its scene parent.');
        if (Date.now() >= expiresAt || director.getScene() !== scene || parentAfter !== scene || !engine.isValid(targetNode, true)) fail('RUNTIME_TARGET_CHANGED', 'Persistent-root target changed during operation.');
        return { nodeUuid, operation, sceneUuid: scene.uuid, parentUuidBefore, parentUuidAfter: parentAfter.uuid, registered: operation === 'add', removed: operation === 'remove' };
    } catch (error) {
        const known = error as { code?: unknown; message?: unknown };
        return { code: typeof known?.code === 'string' ? known.code : 'RUNTIME_PERSISTENT_ROOT_FAILED', message: typeof known?.message === 'string' ? known.message.slice(0, 256) : 'Persistent-root operation failed.' };
    }
}
