import packageJSON from '../../../package.json';
import { createHash } from 'crypto';
import { utcpTool } from '../decorators';
import { ISceneTreeItem, SceneTreeItemSchema, Base64ImageSchema, IBase64Image, InstanceReferenceSchema, IInstanceReference, ISuccessIndicator, SuccessIndicatorSchema } from '../schemas';
import type { IPropertyValueType } from '@cocos/creator-types/editor/packages/scene/@types/public';
import { ToolError } from '../tool-error';
import { DEFAULT_TREE_MAX_DEPTH, DEFAULT_TREE_MAX_NODES, restorePrefabNode } from '../utils/tools-utils';
import { VERBOSE_TREE_DEPTH, VERBOSE_TREE_NODES } from '../utils/verbose';

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 2000;
const MAX_TREE_CHILD_OFFSET = 1_000_000;

const ALLOWED_COMPONENT_METHODS: Record<string, true> = {
    onLoad: true, start: true, onEnable: true, onDisable: true, onDestroy: true,
    resetInEditor: true, onFocusInEditor: true, onLostFocusInEditor: true,
    unscheduleAllCallbacks: true,
};
const MAX_COMPONENT_METHOD_ARGS = 32;
const MAX_COMPONENT_METHOD_RESULT_BYTES = 64 * 1024;
const MAX_COMPONENT_METHOD_BYTES = 32 * 1024;

function boundedListLimit(limit: number | undefined): number {
    return Math.min(Math.max(limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
}

function componentUuid(component: any): string | undefined {
    const nested = component?.value?.uuid?.value ?? component?.value?.uuid ?? component?.uuid;
    if (typeof nested === 'string' && nested) return nested;
    // Creator 3.7 query-node-tree serializes some native components as
    // { type, value: '<component-uuid>', extends } instead of a nested
    // value.uuid wrapper. Preserve the authoritative scalar UUID.
    return typeof component?.value === 'string' && component.value ? component.value : undefined;
}

function componentClassId(component: any): string | undefined {
    const value = component?.value;
    return value?.__type__?.value ?? value?.__type__ ?? component?.cid ?? value?.cid ?? component?.type;
}

function componentCandidates(componentType: any): string[] {
    return [componentType?.name, componentType?.type, componentType?.cid, componentType?.classId]
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function scriptHealthRegisteredClasses(value: unknown): Set<string> {
    if (!Array.isArray(value)) throw new ToolError({ code: 'SCRIPT_HEALTH_QUERY_FAILED', status: 502, message: 'Creator did not return a component registry array.' });
    const registered = new Set<string>();
    for (const candidate of value) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new ToolError({ code: 'SCRIPT_HEALTH_QUERY_FAILED', status: 502, message: 'Creator returned an invalid component registry entry.' });
        const identities = componentCandidates(candidate);
        if (!identities.length) throw new ToolError({ code: 'SCRIPT_HEALTH_QUERY_FAILED', status: 502, message: 'Component registry entry has no supported identity.' });
        for (const identity of identities) registered.add(identity);
    }
    return registered;
}

function findComponentType(componentTypes: any[], requested: string): any | undefined {
    return componentTypes.find((candidate) => componentCandidates(candidate).includes(requested));
}

function unwrapSceneValue(value: unknown): unknown {
    if (value && typeof value === 'object' && 'value' in value) return value.value;
    return value;
}

function cameraComponentField(component: unknown, key: string): unknown {
    if (!component || typeof component !== 'object') return undefined;
    const row = component as Record<string, unknown>;
    const value = row.value && typeof row.value === 'object' ? row.value as Record<string, unknown> : undefined;
    return unwrapSceneValue(row[key] ?? value?.[key]);
}

function cameraComponentsFromNode(node: unknown): unknown[] {
    if (!node || typeof node !== 'object') return [];
    const row = node as Record<string, unknown>;
    return Array.isArray(row.__comps__) ? row.__comps__ : Array.isArray(row.components) ? row.components : [];
}

function isCameraComponent(component: unknown): boolean {
    const type = componentClassId(component);
    return type === 'cc.Camera' || type === 'Camera';
}

function cameraReference(component: unknown): IInstanceReference {
    const id = componentUuid(component);
    if (!id) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator returned a camera component without an authoritative UUID.' });
    return { id, type: 'cc.Camera' };
}

function* cameraSceneNodes(root: unknown): Generator<Record<string, unknown>> {
    const stack: unknown[] = [root];
    const seen = new Set<object>();
    const nodeIds = new Set<string>();
    let scheduled = 1;
    let componentCount = 0;
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object' || Array.isArray(node)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Camera hierarchy contains an invalid node.' });
        if (seen.has(node)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Camera hierarchy contains a repeated node object.' });
        seen.add(node);
        const row = node as Record<string, unknown>;
        if (typeof row.uuid !== 'string' || !row.uuid) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Camera hierarchy node has no authoritative UUID.' });
        if (nodeIds.has(row.uuid)) throw new ToolError({ code: 'CAMERA_TARGET_AMBIGUOUS', status: 409, message: 'Camera hierarchy repeats a node UUID.' });
        nodeIds.add(row.uuid);
        if (row.children !== undefined && !Array.isArray(row.children)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Camera hierarchy children must be an array when present.' });
        componentCount += cameraComponentsFromNode(row).length;
        if (componentCount > VERBOSE_TREE_NODES) throw new ToolError({ code: 'LIMIT_EXCEEDED', status: 413, message: 'Camera hierarchy exceeds the component traversal budget.' });
        if (Array.isArray(row.children)) {
            scheduled += row.children.length;
            if (scheduled > VERBOSE_TREE_NODES) throw new ToolError({ code: 'LIMIT_EXCEEDED', status: 413, message: 'Camera hierarchy exceeds the scene traversal budget.' });
            for (const child of row.children) stack.push(child);
        }
        yield row;
    }
}

interface SceneTreeNode {
    uuid?: string;
    name?: string | { value?: string };
    children?: SceneTreeNode[];
}

function sceneTreeNodeName(node: SceneTreeNode): string {
    if (typeof node.name === 'string') return node.name;
    return node.name?.value ?? node.uuid ?? '';
}

function findSceneTreeNode(root: SceneTreeNode, uuid: string): SceneTreeNode | null {
    const stack: SceneTreeNode[] = [root];
    while (stack.length) {
        const node = stack.pop()!;
        if (node.uuid === uuid) return node;
        for (const child of node.children ?? []) stack.push(child);
    }
    return null;
}

function nodeUuidFromSceneUsage(value: unknown, message: string): string {
    const uuid = typeof value === 'string' ? value :
        value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>).uuid ?? (value as Record<string, unknown>).id : undefined;
    if (typeof uuid !== 'string' || !uuid.trim()) {
        throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: `Creator returned an invalid node identity from ${message}.` });
    }
    return uuid;
}

async function assetInfoForSceneUsage(id: string): Promise<Record<string, unknown>> {
    let info: unknown;
    try {
        info = await Editor.Message.request('asset-db', 'query-asset-info', id);
    } catch (error) {
        throw new ToolError({ code: 'ASSET_QUERY_FAILED', status: 502, message: `Creator could not verify asset ${id}.`, details: { cause: error instanceof Error ? error.message : String(error) } });
    }
    if (info == null) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Asset ${id} was not found.` });
    if (typeof info !== 'object' || Array.isArray(info) || (info as Record<string, unknown>).uuid !== id) {
        throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: `Creator returned a mismatched asset identity for ${id}.` });
    }
    return info as Record<string, unknown>;
}

async function queryNodesForAsset(assetId: string, limit: number): Promise<{ references: IInstanceReference[], total: number, truncated: boolean }> {
    const nodeUuids: unknown = await Editor.Message.request('scene', 'query-nodes-by-asset-uuid', assetId);
    if (!Array.isArray(nodeUuids) || nodeUuids.some((uuid) => typeof uuid !== 'string' || !uuid.trim())) {
        throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: `Creator returned an invalid node UUID list for asset ${assetId}.` });
    }
    const references: IInstanceReference[] = nodeUuids.slice(0, limit).map((id: string) => ({ id, type: 'cc.Node' }));
    return { references, total: nodeUuids.length, truncated: nodeUuids.length > limit };
}

export class SceneTools {

    async sceneOpen(args: { reference: IInstanceReference }): Promise<ISuccessIndicator> {
        if (!args.reference || !args.reference.id) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'sceneOpen requires reference.id (scene uuid)' });
        }
        await Editor.Message.request('scene', 'open-scene', args.reference.id);
        const current = await Editor.Message.request('scene', 'query-current-scene');
        const currentId = typeof current === 'string' ? current : current?.uuid ?? current?.id;
        if (currentId !== args.reference.id) {
            throw new ToolError({
                code: 'SCENE_OPEN_UNCONFIRMED',
                status: 502,
                message: `Creator did not confirm scene ${args.reference.id} as the active scene.`,
                details: { requestedId: args.reference.id, currentId: currentId ?? null },
                recovery: 'Query sceneGetInfo and retry with an available scene asset.',
            });
        }
        return { success: true };
    }

    @utcpTool(
        'sceneGetInfo',
        'Get scene bounds, dirty state, current scene asset, and bounded hierarchy node count.',
        { type: 'object', properties: {} },
        {
            type: 'object',
            properties: {
                bounds: {
                    type: 'object',
                    properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
                    required: ['x', 'y', 'width', 'height']
                },
                name: { type: 'string' }, uuid: { type: 'string' },
                dirty: { type: 'boolean' }, isDirty: { type: 'boolean' }, nodeCount: { type: 'integer', minimum: 0 },
                currentScene: { type: 'object', properties: { uuid: { type: 'string' }, url: { type: 'string' }, name: { type: 'string' } } }
            },
            required: ['bounds', 'dirty', 'isDirty', 'nodeCount']
        }, "GET", ['scene', 'info', 'bounds', 'size', 'dirty', 'unsaved', 'current', 'nodes', 'count']
    )
    async sceneGetInfo(): Promise<{ bounds: { x: number, y: number, width: number, height: number }, name?: string, uuid?: string, dirty: boolean, isDirty: boolean, nodeCount: number, currentScene?: { uuid?: string, url?: string, name?: string } }> {
        const [bounds, dirty, currentRaw, tree] = await Promise.all([
            Editor.Message.request('scene', 'query-scene-bounds'),
            Editor.Message.request('scene', 'query-dirty'),
            Editor.Message.request('scene', 'query-current-scene').catch(() => undefined),
            Editor.Message.request('scene', 'query-node-tree').catch(() => undefined),
        ]);
        if (!bounds) throw new Error('Failed to query scene bounds');
        let currentScene: { uuid?: string, url?: string, name?: string } | undefined;
        if (typeof currentRaw === 'string' && currentRaw) currentScene = { uuid: currentRaw };
        else if (currentRaw && typeof currentRaw === 'object') currentScene = currentRaw as { uuid?: string, url?: string, name?: string };
        const countNodes = (node: unknown): number => {
            if (!node || typeof node !== 'object') return 0;
            const children = 'children' in node && Array.isArray(node.children) ? node.children : [];
            return 1 + children.reduce((total: number, child: unknown) => total + countNodes(child), 0);
        };
        const nodeCount = countNodes(tree);
        return {
            bounds,
            ...(currentScene?.name ? { name: currentScene.name } : {}),
            ...(currentScene?.uuid ? { uuid: currentScene.uuid } : {}),
            dirty: !!dirty,
            isDirty: !!dirty,
            nodeCount,
            currentScene,
        };
    }

    @utcpTool(
        'nodeSetTransform',
        'Set bounded node position, rotation, scale, and active state through exact scene property paths with read-back.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] },
                rotation: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] },
                scale: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] },
                active: { type: 'boolean' },
            },
            required: ['reference'],
        },
        { type: 'object', properties: { updated: { type: 'boolean', const: true }, reference: InstanceReferenceSchema }, required: ['updated', 'reference'] },
        'POST', ['scene', 'node', 'transform', 'position', 'rotation', 'scale', 'active', 'set']
    )
    async nodeSetTransform(args: { reference: IInstanceReference, position?: { x: number, y: number, z: number }, rotation?: { x: number, y: number, z: number }, scale?: { x: number, y: number, z: number }, active?: boolean }): Promise<{ updated: true, reference: IInstanceReference }> {
        if (!args?.reference?.id) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nodeSetTransform requires reference.id.' });
        const changes: Array<{ path: string, value: any, type: string }> = [];
        if (args.position) changes.push({ path: 'position', value: args.position, type: 'cc.Vec3' });
        if (args.rotation) changes.push({ path: 'eulerAngles', value: args.rotation, type: 'cc.Vec3' });
        if (args.scale) changes.push({ path: 'scale', value: args.scale, type: 'cc.Vec3' });
        if (args.active !== undefined) changes.push({ path: 'active', value: args.active, type: 'Boolean' });
        if (changes.length === 0) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nodeSetTransform requires at least one transform field.' });
        const before = await Editor.Message.request('scene', 'query-node', args.reference.id);
        if (!before) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Node ${args.reference.id} not found.` });
        for (const change of changes) {
            const accepted = await Editor.Message.request('scene', 'set-property', { uuid: args.reference.id, path: change.path, dump: { value: change.value, type: change.type } });
            if (accepted === false) throw new ToolError({ code: 'NODE_TRANSFORM_UPDATE_FAILED', status: 502, message: `Creator rejected node property ${change.path}.` });
        }
        await Editor.Message.request('scene', 'snapshot');
        const after = await Editor.Message.request('scene', 'query-node', args.reference.id);
        if (!after || typeof after !== 'object') throw new ToolError({ code: 'NODE_TRANSFORM_UPDATE_UNCONFIRMED', status: 502, message: `Creator did not return node ${args.reference.id} after transform update.` });
        const row = after as unknown as Record<string, unknown>;
        const unwrap = (value: unknown): unknown => value && typeof value === 'object' && 'value' in value ? value.value : value;
        for (const change of changes) {
            if (JSON.stringify(unwrap(row[change.path])) !== JSON.stringify(change.value)) throw new ToolError({ code: 'NODE_TRANSFORM_UPDATE_UNCONFIRMED', status: 502, message: `Node property ${change.path} did not match read-back.` });
        }
        return { updated: true, reference: { id: args.reference.id, type: 'cc.Node' } };
    }

    @utcpTool('sceneCreate', 'Create a scene asset from the built-in Creator template and confirm asset identity.', { type: 'object', properties: { assetPath: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['assetPath'] }, { type: 'object', properties: { success: { type: 'boolean' }, reference: InstanceReferenceSchema }, required: ['success', 'reference'] }, 'POST', ['scene', 'create', 'asset'])
    async sceneCreate(args: { assetPath: string }): Promise<{ success: true, reference: IInstanceReference }> {
        if (typeof args?.assetPath !== 'string' || !/^db:\/\/assets\/.+\.scene$/.test(args.assetPath) || args.assetPath.includes('..')) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetPath must be a db://assets scene path without traversal.' });
        }
        const legacy = Editor.App?.version === '3.7.3';
        const template = legacy ? 'db://internal/default_file_content/scene' : 'db://internal/default_file_content/scene/default.scene';
        const templateInfo = await Editor.Message.request('asset-db', 'query-asset-info', template) as { type?: string; isDirectory?: boolean; url?: string } | null;
        if (templateInfo?.type !== (legacy ? 'cc.Asset' : 'cc.SceneAsset') || templateInfo.isDirectory !== false || templateInfo.url !== template) throw new ToolError({ code: 'UNSUPPORTED_EDITOR_API', status: 422, message: 'Creator default scene template identity is unavailable.' });
        const created = await Editor.Message.request('asset-db', 'copy-asset', template, args.assetPath, { overwrite: false, rename: false }) as unknown;
        if (!created || typeof created !== 'object' || !('uuid' in created) || typeof created.uuid !== 'string') {
            throw new ToolError({ code: 'SCENE_CREATE_FAILED', status: 502, message: `Creator did not create scene ${args.assetPath}.` });
        }
        const info = await Editor.Message.request('asset-db', 'query-asset-info', created.uuid) as unknown;
        if (!info || typeof info !== 'object' || !('uuid' in info) || info.uuid !== created.uuid || !('type' in info) || info.type !== 'cc.SceneAsset' || !('isDirectory' in info) || info.isDirectory !== false) {
            throw new ToolError({ code: 'SCENE_CREATE_UNCONFIRMED', status: 502, message: `Creator did not confirm scene ${created.uuid}.` });
        }
        return { success: true, reference: { id: created.uuid, type: 'cc.SceneAsset' } };
    }

    @utcpTool('nodeGetInfo', 'Read one open-scene node with authoritative editor dump.', { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object' }, 'GET', ['scene', 'node', 'info', 'inspect'])
    async nodeGetInfo(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        return this.sceneInspectNode(args);
    }

    @utcpTool('queryComponents', 'List globally registered component classes with bounded filtering.', { type: 'object', properties: { includeInternal: { type: 'boolean' }, filter: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT } } }, { type: 'object', properties: { componentTypes: { type: 'array', items: { type: 'string' } }, total: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['componentTypes', 'total', 'truncated'] }, 'GET', ['scene', 'component', 'query', 'types', 'inspect'])
    async queryComponents(args: { includeInternal?: boolean, filter?: string, limit?: number } = {}): Promise<{ componentTypes: string[], total: number, truncated: boolean }> {
        const raw = await Editor.Message.request('scene', 'query-components');
        if (!Array.isArray(raw)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator returned no component type list.' });
        const filter = typeof args.filter === 'string' && args.filter ? args.filter.toLowerCase() : undefined;
        const limit = boundedListLimit(args.limit);
        const names = raw.flatMap((candidate: unknown) => componentCandidates(candidate)).filter((name, index, all) => all.indexOf(name) === index && (!filter || name.toLowerCase().includes(filter)));
        return { componentTypes: names.slice(0, limit), total: names.length, truncated: names.length > limit };
    }
    @utcpTool('sceneInspectNode', 'Inspect one open-scene node with authoritative editor dump.', { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object' }, 'GET', ['scene', 'inspect', 'node', 'info'])
    async sceneInspectNode(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        if (!args.reference?.id) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'reference.id is required.' });
        const node = await Editor.Message.request('scene', 'query-node', args.reference.id) as unknown;
        if (!node || typeof node !== 'object') throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Node ${args.reference.id} was not found.` });
        return node as Record<string, unknown>;
    }

    @utcpTool('sceneNodeType', 'Read the authoritative class type of one open-scene node.', { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', properties: { reference: InstanceReferenceSchema, type: { type: 'string' } }, required: ['reference', 'type'] }, 'GET', ['scene', 'node', 'type', 'inspect'])
    async sceneNodeType(args: { reference: IInstanceReference }): Promise<{ reference: IInstanceReference, type: string }> {
        const node = await this.sceneInspectNode(args);
        const typeValue = node.__type__;
        const type = typeValue && typeof typeValue === 'object' && 'value' in typeValue ? typeValue.value : typeValue;
        if (typeof type !== 'string' || !type) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator returned no authoritative node type.' });
        return { reference: { id: args.reference.id, type: 'cc.Node' }, type };
    }

    @utcpTool('sceneComponentInfo', 'Read one component dump by authoritative UUID.', { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object' }, 'GET', ['scene', 'component', 'inspect', 'info'])
    async sceneComponentInfo(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        if (!args.reference?.id) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'reference.id is required.' });
        const component = await Editor.Message.request('scene', 'query-component', args.reference.id) as unknown;
        if (!component || typeof component !== 'object') throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Component ${args.reference.id} was not found.` });
        return component as Record<string, unknown>;
    }

    @utcpTool(
        'cameraCreate',
        'Create a scene node with a cc.Camera component and verify both identities by read-back.',
        {
            type: 'object',
            properties: {
                name: { type: 'string', minLength: 1 },
                is2D: { type: 'boolean' },
                parentReference: InstanceReferenceSchema,
            },
        },
        {
            type: 'object',
            properties: { nodeReference: InstanceReferenceSchema, cameraReference: InstanceReferenceSchema },
            required: ['nodeReference', 'cameraReference'],
        },
        'POST', ['scene', 'camera', 'create', 'node']
    )
    async cameraCreate(args: { name?: string, is2D?: boolean, parentReference?: IInstanceReference }): Promise<{ nodeReference: IInstanceReference, cameraReference: IInstanceReference }> {
        if (!args || args.is2D !== undefined && typeof args.is2D !== 'boolean' || args.name !== undefined && (typeof args.name !== 'string' || !args.name.length)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Camera creation requires optional nonempty name and boolean is2D.' });
        const requestedIs2D = args.is2D;
        const nodeReference = await this.sceneCreateNode({ name: args.name ?? 'Camera', parentReference: args.parentReference });
        let pendingMutation: 'create-component' | 'projection' | 'snapshot' | null = null;
        let createdCameraId: string | null = null;
        try {
            pendingMutation = 'create-component';
            await Editor.Message.request('scene', 'create-component', { uuid: nodeReference.reference.id, component: 'cc.Camera' });
            pendingMutation = null;
            const node = await Editor.Message.request('scene', 'query-node', nodeReference.reference.id);
            if (!node || typeof node !== 'object' || unwrapSceneValue((node as Record<string, unknown>).uuid) !== nodeReference.reference.id) throw new ToolError({ code: 'CAMERA_CREATE_UNCONFIRMED', status: 502, message: 'Creator did not confirm the created node identity.' });
            const initialCameras = cameraComponentsFromNode(node).filter((component) => isCameraComponent(component));
            if (initialCameras.length !== 1) throw new ToolError({ code: 'CAMERA_CREATE_UNCONFIRMED', status: 502, message: 'Creator did not confirm exactly one cc.Camera after creation.' });
            const cameraReferenceValue = cameraReference(initialCameras[0]);
            createdCameraId = cameraReferenceValue.id;
            if (requestedIs2D !== undefined) {
                const cameraIndex = cameraComponentsFromNode(node).findIndex((component) => componentUuid(component) === cameraReferenceValue.id);
                if (cameraIndex < 0) throw new ToolError({ code: 'CAMERA_CREATE_UNCONFIRMED', status: 502, message: 'Created camera index was not confirmed.' });
                pendingMutation = 'projection';
                const changed = await Editor.Message.request('scene', 'set-property', { uuid: nodeReference.reference.id, path: `__comps__.${cameraIndex}.projection`, dump: { value: requestedIs2D ? 1 : 0, type: 'Enum' } });
                pendingMutation = null;
                if (changed === false) throw new ToolError({ code: 'CAMERA_CREATE_UNCONFIRMED', status: 502, message: 'Creator rejected the requested camera projection.' });
            }
            pendingMutation = 'snapshot';
            const snapshot: unknown = await Editor.Message.request('scene', 'snapshot');
            pendingMutation = null;
            if (snapshot === false) throw new ToolError({ code: 'CAMERA_CREATE_UNCONFIRMED', status: 502, message: 'Creator refused the camera creation undo snapshot.' });
            const verifiedNode = await Editor.Message.request('scene', 'query-node', nodeReference.reference.id);
            if (!verifiedNode || typeof verifiedNode !== 'object' || unwrapSceneValue((verifiedNode as Record<string, unknown>).uuid) !== nodeReference.reference.id) throw new ToolError({ code: 'CAMERA_CREATE_UNCONFIRMED', status: 502, message: 'Creator did not confirm created node read-back.' });
            const verifiedCameras = cameraComponentsFromNode(verifiedNode).filter((component) => isCameraComponent(component));
            if (verifiedCameras.length !== 1 || cameraReference(verifiedCameras[0]).id !== cameraReferenceValue.id) throw new ToolError({ code: 'CAMERA_CREATE_UNCONFIRMED', status: 502, message: 'Creator did not preserve camera identity.' });
            if (requestedIs2D !== undefined && cameraComponentField(verifiedCameras[0], 'projection') !== (requestedIs2D ? 1 : 0)) throw new ToolError({ code: 'CAMERA_CREATE_UNCONFIRMED', status: 502, message: 'Creator did not retain the requested camera projection.' });
            return { nodeReference: nodeReference.reference, cameraReference: cameraReferenceValue };
        } catch (error) {
            if (pendingMutation) throw new ToolError({ code: 'CAMERA_CREATE_OUTCOME_UNKNOWN', status: 502, message: 'Camera creation/configuration was dispatched but its outcome is unknown; node cleanup was not dispatched.', details: { nodeReference: nodeReference.reference, componentId: createdCameraId, pendingMutation, retrySafe: false, restored: null, cleanupAttempted: false, cause: error instanceof Error ? error.message : String(error) }, recovery: 'Inspect the retained node and reconcile the pending native request before creation or cleanup.' });
            let cleanupPhase: 'remove' | 'absence-readback' | 'snapshot' = 'remove';
            let cleanupPending = false;
            let removed = false;
            try {
                cleanupPending = true;
                const removeResult = await Editor.Message.request('scene', 'remove-node', { uuid: nodeReference.reference.id });
                cleanupPending = false;
                if (removeResult === false) throw new Error('Creator refused camera node removal.');
                cleanupPhase = 'absence-readback';
                const remaining = await Editor.Message.request('scene', 'query-node', nodeReference.reference.id);
                if (remaining !== null && remaining !== undefined) throw new Error('Created camera node remains or cleanup response is invalid.');
                removed = true;
                cleanupPhase = 'snapshot';
                cleanupPending = true;
                const cleanupSnapshot: unknown = await Editor.Message.request('scene', 'snapshot');
                cleanupPending = false;
                if (cleanupSnapshot === false) throw new Error('Creator refused the camera cleanup undo snapshot.');
            } catch (cleanupError) {
                throw new ToolError({ code: cleanupPending ? 'CAMERA_CLEANUP_OUTCOME_UNKNOWN' : 'ROLLBACK_FAILED', status: cleanupPending ? 502 : 500, message: removed ? 'Camera node absence was confirmed, but cleanup snapshot was not confirmed.' : 'Camera creation failed and owned-node cleanup was not confirmed.', details: { nodeUuid: nodeReference.reference.id, componentId: createdCameraId, cleanupPhase, removed, snapshotConfirmed: false, pendingMayComplete: cleanupPending, cause: error instanceof Error ? error.message : String(error), cleanupCause: cleanupError instanceof Error ? cleanupError.message : String(cleanupError), retrySafe: false, restored: removed ? true : null }, recovery: removed ? 'Reconcile undo state; do not repeat node removal.' : 'Inspect the exact node and any pending cleanup request before another mutation.' });
            }
            throw error;
        }
    }

    @utcpTool(
        'cameraList',
        'List cc.Camera components in the open scene with bounded node traversal and authoritative component read-back.',
        { type: 'object', properties: { maxResults: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } } },
        { type: 'object', properties: { cameras: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['cameras', 'total', 'truncated'] },
        'GET', ['scene', 'camera', 'list', 'query']
    )
    async cameraList(args: { maxResults?: number } = {}): Promise<{ cameras: Array<Record<string, unknown>>, total: number, truncated: boolean }> {
        if (args.maxResults !== undefined && (!Number.isInteger(args.maxResults) || args.maxResults < 1 || args.maxResults > MAX_LIST_LIMIT)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `maxResults must be an integer from 1 to ${MAX_LIST_LIMIT}.` });
        }
        const tree = await Editor.Message.request('scene', 'query-node-tree');
        if (!tree) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'No open scene hierarchy.' });
        const limit = boundedListLimit(args.maxResults);
        const cameras: Array<Record<string, unknown>> = [];
        let total = 0;
        let inspectedComponents = 0;
        const cameraIds = new Set<string>();
        for (const row of cameraSceneNodes(tree)) {
            const nodeId = typeof row.uuid === 'string' ? row.uuid : undefined;
            if (nodeId) {
                const dump: unknown = await Editor.Message.request('scene', 'query-node', nodeId);
                if (!dump || typeof dump !== 'object' || Array.isArray(dump)
                    || !Array.isArray((dump as Record<string, unknown>).__comps__) && !Array.isArray((dump as Record<string, unknown>).components)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Camera inventory requires a complete serialized component array.' });
                if (unwrapSceneValue((dump as Record<string, unknown>).uuid) !== nodeId) throw new ToolError({ code: 'CAMERA_TARGET_CHANGED', status: 409, message: 'Camera inventory node response does not match the requested UUID.' });
                const components = cameraComponentsFromNode(dump);
                inspectedComponents += components.length;
                if (inspectedComponents > VERBOSE_TREE_NODES) throw new ToolError({ code: 'LIMIT_EXCEEDED', status: 413, message: 'Camera inventory exceeds the component inspection budget.' });
                for (const component of components) {
                    if (!isCameraComponent(component)) continue;
                    const reference = cameraReference(component);
                    if (cameraIds.has(reference.id)) throw new ToolError({ code: 'CAMERA_TARGET_AMBIGUOUS', status: 409, message: 'Camera inventory contains a repeated component UUID.' });
                    cameraIds.add(reference.id);
                    total += 1;
                    if (cameras.length >= limit) continue;
                    cameras.push({
                        nodeReference: { id: nodeId, type: 'cc.Node' },
                        name: typeof row.name === 'string' ? row.name : unwrapSceneValue(row.name),
                        cameraReference: reference,
                        priority: cameraComponentField(component, 'priority'),
                        visibility: cameraComponentField(component, 'visibility'),
                        projection: cameraComponentField(component, 'projection'),
                    });
                }
            }
        }
        return { cameras, total, truncated: total > limit };
    }

    @utcpTool(
        'cameraSetProperties',
        'Set bounded cc.Camera properties through scene IPC and verify each requested value by fresh component read-back.',
        {
            type: 'object',
            properties: { reference: InstanceReferenceSchema, properties: { type: 'object', minProperties: 1, maxProperties: 32, propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_]{0,127}$' } } },
            required: ['reference', 'properties'],
        },
        { type: 'object', properties: { updated: { type: 'boolean', const: true }, reference: InstanceReferenceSchema }, required: ['updated', 'reference'] },
        'POST', ['scene', 'camera', 'set', 'properties']
    )
    async cameraSetProperties(args: { reference: IInstanceReference, properties: Record<string, unknown> }): Promise<{ updated: true, reference: IInstanceReference }> {
        if (!args?.reference || typeof args.reference.id !== 'string' || !args.reference.id.trim() || args.reference.id.length > 256 || !args.properties || typeof args.properties !== 'object' || Array.isArray(args.properties) || Object.keys(args.properties).length === 0) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'cameraSetProperties requires a camera reference and non-empty properties.' });
        }
        const propertyNames = Object.keys(args.properties);
        if (propertyNames.length > 32 || propertyNames.some((property) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(property))) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Camera properties require 1 to 32 bounded identifier names, not nested paths.' });
        }
        const nodeReferenceId = args.reference.id;
        let requestedProperties: Record<string, unknown>;
        try { requestedProperties = JSON.parse(JSON.stringify(args.properties)) as Record<string, unknown>; }
        catch { throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Camera properties must be JSON-serializable.' }); }
        if (!requestedProperties || typeof requestedProperties !== 'object' || Array.isArray(requestedProperties)
            || Object.keys(requestedProperties).length !== propertyNames.length
            || propertyNames.some(property => !Object.prototype.hasOwnProperty.call(requestedProperties, property))) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Every requested camera property must survive JSON serialization before mutation.' });
        }
        args = { reference: { id: nodeReferenceId, ...(args.reference.type === undefined ? {} : { type: args.reference.type }) }, properties: requestedProperties };
        const nodeTree = await Editor.Message.request('scene', 'query-node-tree');
        if (!nodeTree) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'No open scene hierarchy.' });
        let foundNode: Record<string, unknown> | undefined;
        let foundComponent: unknown;
        let componentIndex = -1;
        for (const row of cameraSceneNodes(nodeTree)) {
            const components = cameraComponentsFromNode(row);
            for (let index = 0; index < components.length; index++) {
                if (componentUuid(components[index]) !== args.reference.id) continue;
                if (foundNode || !isCameraComponent(components[index])) throw new ToolError({ code: 'CAMERA_TARGET_AMBIGUOUS', status: 409, message: 'Camera UUID is ambiguous in the scene hierarchy.' });
                foundNode = row;
                foundComponent = components[index];
                componentIndex = index;
            }
        }
        const nodeId = foundNode && typeof foundNode.uuid === 'string' ? foundNode.uuid : undefined;
        if (!nodeId || !foundComponent || componentIndex < 0) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Camera ${args.reference.id} was not found in the open scene.` });
        const checkedNodeComponents = (node: unknown): unknown[] => {
            if (!node || typeof node !== 'object' || Array.isArray(node)
                || unwrapSceneValue((node as Record<string, unknown>).uuid) !== nodeId) throw new ToolError({ code: 'CAMERA_TARGET_CHANGED', status: 409, message: 'Camera node read-back does not match the requested UUID.' });
            const record = node as Record<string, unknown>;
            if (!Array.isArray(record.__comps__) && !Array.isArray(record.components)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Camera node read-back requires a component array.' });
            return cameraComponentsFromNode(node);
        };
        const serializedNode = await Editor.Message.request('scene', 'query-node', nodeId);
        const serializedComponents = checkedNodeComponents(serializedNode);
        const requireUniqueCamera = (components: unknown[]) => {
            if (components.length > VERBOSE_TREE_NODES) throw new ToolError({ code: 'LIMIT_EXCEEDED', status: 413, message: 'Camera node exceeds the component inspection budget.' });
            let index = -1;
            for (let candidate = 0; candidate < components.length; candidate++) {
                if (componentUuid(components[candidate]) !== args.reference.id) continue;
                if (index >= 0 || !isCameraComponent(components[candidate])) throw new ToolError({ code: 'CAMERA_TARGET_AMBIGUOUS', status: 409, message: 'Camera UUID does not identify exactly one camera component.' });
                index = candidate;
            }
            return index;
        };
        componentIndex = requireUniqueCamera(serializedComponents);
        if (componentIndex < 0) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Camera is absent from the serialized node.' });
        const previous = new Map<string, unknown>();
        for (const property of propertyNames) {
            const original = cameraComponentField(serializedComponents[componentIndex], property);
            if (original === undefined) throw new ToolError({ code: 'CAMERA_PROPERTY_UNAVAILABLE', status: 422, message: `Camera property ${property} has no restorable serialized value.` });
            try { previous.set(property, JSON.parse(JSON.stringify(original))); }
            catch { throw new ToolError({ code: 'CAMERA_PROPERTY_UNAVAILABLE', status: 422, message: `Camera property ${property} cannot be snapshotted for restoration.` }); }
        }
        const applied: string[] = [];
        let mutationPending = false;
        let pendingPhase: 'property' | 'snapshot' | null = null;
        let pendingProperty: string | null = null;
        const restoreApplied = async (): Promise<string | null> => {
            const failures: string[] = [];
            for (let index = applied.length - 1; index >= 0; index--) {
                const property = applied[index];
                let restorationPending = false;
                try {
                    const currentNode = await Editor.Message.request('scene', 'query-node', nodeId);
                    const components = checkedNodeComponents(currentNode);
                    if (requireUniqueCamera(components) !== componentIndex) throw new Error('Camera identity/index changed before restoration.');
                    const observed = cameraComponentField(components[componentIndex], property);
                    if (JSON.stringify(observed) === JSON.stringify(previous.get(property))) continue;
                    if (JSON.stringify(observed) !== JSON.stringify(requestedProperties[property])) throw new ToolError({ code: 'CAMERA_RESTORATION_CONFLICT', status: 409, message: 'Camera value changed outside this update; restoration refused.', details: { nodeId, componentId: nodeReferenceId, property, retrySafe: false, restored: null } });
                    restorationPending = true;
                    const restoredResult = await Editor.Message.request('scene', 'set-property', { uuid: nodeId, path: `__comps__.${componentIndex}.${property}`, dump: { value: previous.get(property) as IPropertyValueType, type: typeof previous.get(property) === 'number' ? 'Number' : typeof previous.get(property) === 'boolean' ? 'Boolean' : 'String' } });
                    restorationPending = false;
                    if (restoredResult === false) throw new Error(`Creator refused rollback ${property}`);
                    const restoredNode = await Editor.Message.request('scene', 'query-node', nodeId);
                    const restoredComponents = checkedNodeComponents(restoredNode);
                    if (requireUniqueCamera(restoredComponents) !== componentIndex || JSON.stringify(cameraComponentField(restoredComponents[componentIndex], property)) !== JSON.stringify(previous.get(property))) throw new Error(`rollback read-back mismatch for ${property}`);
                } catch (error) {
                    if (restorationPending) throw new ToolError({ code: 'CAMERA_RESTORATION_OUTCOME_UNKNOWN', status: 502, message: 'Camera restoration was dispatched but did not return a settled outcome; further restoration was stopped.', details: { nodeId, componentId: nodeReferenceId, property, retrySafe: false, restored: null, cause: error instanceof Error ? error.message : String(error) }, recovery: 'Reconcile the exact camera field and pending restoration before any further mutation.' });
                    if (error instanceof ToolError && error.code === 'CAMERA_RESTORATION_CONFLICT') throw error;
                    failures.push(property);
                }
            }
            try {
                const finalNode = await Editor.Message.request('scene', 'query-node', nodeId);
                const finalComponents = checkedNodeComponents(finalNode);
                if (requireUniqueCamera(finalComponents) !== componentIndex) throw new Error('Camera identity/index changed during final restoration read-back.');
                for (const property of applied) {
                    if (JSON.stringify(cameraComponentField(finalComponents[componentIndex], property)) !== JSON.stringify(previous.get(property)) && !failures.includes(property)) failures.push(property);
                }
            } catch {
                for (const property of applied) if (!failures.includes(property)) failures.push(property);
            }
            return failures.length ? failures.join(',') : null;
        };
        try {
            for (const [property, value] of Object.entries(requestedProperties)) {
                const currentNode = await Editor.Message.request('scene', 'query-node', nodeId);
                const currentComponents = checkedNodeComponents(currentNode);
                if (requireUniqueCamera(currentComponents) !== componentIndex) throw new ToolError({ code: 'CAMERA_TARGET_CHANGED', status: 409, message: 'Camera serialized component index changed before property dispatch.' });
                if (JSON.stringify(cameraComponentField(currentComponents[componentIndex], property)) !== JSON.stringify(previous.get(property))) throw new ToolError({ code: 'CAMERA_TARGET_CHANGED', status: 409, message: `Camera property ${property} changed after preflight; its write was refused.` });
                applied.push(property);
                pendingPhase = 'property';
                pendingProperty = property;
                mutationPending = true;
                const changed = await Editor.Message.request('scene', 'set-property', { uuid: nodeId, path: `__comps__.${componentIndex}.${property}`, dump: { value: value as IPropertyValueType, type: typeof value === 'number' ? 'Number' : typeof value === 'boolean' ? 'Boolean' : 'String' } });
                mutationPending = false;
                pendingPhase = null;
                pendingProperty = null;
                if (changed === false) throw new ToolError({ code: 'CAMERA_PROPERTY_UPDATE_FAILED', status: 502, message: `Creator rejected camera property ${property}.` });
            }
            pendingPhase = 'snapshot';
            mutationPending = true;
            const snapshot: unknown = await Editor.Message.request('scene', 'snapshot');
            mutationPending = false;
            pendingPhase = null;
            if (snapshot === false) throw new ToolError({ code: 'CAMERA_PROPERTY_UPDATE_UNCONFIRMED', status: 502, message: 'Creator refused the camera update undo snapshot.' });
            const verifiedNode = await Editor.Message.request('scene', 'query-node', nodeId);
            const verifiedComponents = checkedNodeComponents(verifiedNode);
            const verified = verifiedComponents[requireUniqueCamera(verifiedComponents)];
            if (!verified || Object.entries(requestedProperties).some(([property, value]) => JSON.stringify(cameraComponentField(verified, property)) !== JSON.stringify(value))) throw new ToolError({ code: 'CAMERA_PROPERTY_UPDATE_UNCONFIRMED', status: 502, message: 'Camera property mutation was not confirmed by read-back.' });
            return { updated: true, reference: cameraReference(verified) };
        } catch (error) {
            if (mutationPending) throw new ToolError({ code: 'CAMERA_MUTATION_OUTCOME_UNKNOWN', status: 502, message: 'Camera native dispatch did not return a settled outcome; automatic restoration was not attempted.', details: { nodeId, componentId: nodeReferenceId, pendingPhase, pendingProperty, applied, retrySafe: false, restored: null }, recovery: 'Inspect the exact camera and reconcile the pending phase before another mutation.' });
            if (applied.length === 0) throw error;
            const rollbackFailure = await restoreApplied();
            throw new ToolError({ code: rollbackFailure ? 'ROLLBACK_FAILED' : 'CAMERA_PROPERTY_UPDATE_FAILED', status: 502, message: rollbackFailure ? `Camera property update failed; rollback could not verify ${rollbackFailure}.` : 'Camera property update failed; owned camera values were restored.', details: { nodeId, componentId: nodeReferenceId, applied, rollbackFailure, cause: error instanceof Error ? error.message : String(error) }, recovery: rollbackFailure ? 'Inspect the camera before retrying; do not replay an ambiguous mutation.' : 'Retry only after fresh camera identity/read-back.' });
        }
    }

    @utcpTool(
        'findNodesByAsset',
        'Find nodes referencing a given asset uuid. Reverse-reference / impact analysis.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                limit: { type: 'number', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT, description: 'Maximum references to return.' }
            },
            required: ['reference']
        },
        { type: 'object', properties: { references: { type: 'array', items: InstanceReferenceSchema }, total: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['references', 'total', 'truncated'] }, "GET", ['scene', 'node', 'find', 'asset', 'reference', 'usage', 'impact']
    )
    async findNodesByAsset(args: { reference: IInstanceReference, limit?: number }): Promise<{ references: IInstanceReference[], total: number, truncated: boolean }> {
        const assetId = args.reference?.id;
        if (typeof assetId !== 'string' || !assetId.trim()) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'findNodesByAsset requires reference.id (asset uuid).' });
        }
        await assetInfoForSceneUsage(assetId);
        return queryNodesForAsset(assetId, boundedListLimit(args.limit));
    }

    @utcpTool('spriteFrameUsageInspect', 'Inspect bounded scene nodes referencing one SpriteFrame asset.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, nodes: { type: 'array' }, total: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['reference', 'nodes', 'total', 'truncated'] }, 'GET', ['scene', 'sprite', 'frame', 'usage', 'inspect'])
    async spriteFrameUsageInspect(args: { reference: IInstanceReference, limit?: number }): Promise<Record<string, unknown>> {
        const id = args.reference?.id;
        if (typeof id !== 'string' || !id.trim()) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'spriteFrameUsageInspect requires reference.id.' });
        const info = await assetInfoForSceneUsage(id);
        if (info.type !== 'cc.SpriteFrame' && info.importer !== 'sprite-frame') {
            throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Asset ${id} is not a SpriteFrame.` });
        }
        const result = await queryNodesForAsset(id, boundedListLimit(args.limit));
        return { reference: { id, type: 'cc.SpriteFrame' }, nodes: result.references, total: result.total, truncated: result.truncated };
    }
    @utcpTool('spriteFrameUsageBatchInspect', 'Inspect scene usage for a bounded batch of SpriteFrame assets with per-item errors.', { type: 'object', additionalProperties: false, properties: { references: { type: 'array', minItems: 1, maxItems: 64, items: InstanceReferenceSchema }, limitPerFrame: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: ['references'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated'] }, 'GET', ['scene', 'sprite', 'frame', 'usage', 'batch'])
    async spriteFrameUsageBatchInspect(args: { references: IInstanceReference[], limitPerFrame?: number }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.references) || args.references.length < 1 || args.references.length > 64) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references must contain 1 to 64 items.' });
        const limit = boundedListLimit(args.limitPerFrame);
        const items: Array<Record<string, unknown>> = [];
        for (const [index, reference] of args.references.entries()) {
            try {
                items.push({ index, ok: true, result: await this.spriteFrameUsageInspect({ reference, limit }) });
            } catch (error) {
                items.push({ index, ok: false, reference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        const truncated = items.some((item) => item.ok === true && (item.result as Record<string, unknown>)?.truncated === true);
        return { items, succeeded, failed: items.length - succeeded, truncated };
    }


    @utcpTool('imageSceneUsageInspect', 'Inspect scene usage for an imported image and its bounded SpriteFrame sub-assets.', { type: 'object', additionalProperties: false, properties: { imageReference: InstanceReferenceSchema, maxFrames: { type: 'integer', minimum: 1, maximum: 256, default: 128 }, limitPerAsset: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: ['imageReference'] }, { type: 'object', additionalProperties: false, properties: { imageReference: InstanceReferenceSchema, direct: { type: 'object' }, spriteFrames: { type: 'array' }, totalSpriteFrames: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['imageReference', 'direct', 'spriteFrames', 'totalSpriteFrames', 'truncated'] }, 'GET', ['scene', 'image', 'sprite', 'usage', 'inspect'])
    async imageSceneUsageInspect(args: { imageReference: IInstanceReference, maxFrames?: number, limitPerAsset?: number }): Promise<Record<string, unknown>> {
        const imageId = args.imageReference?.id;
        if (!imageId) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'imageReference.id is required.' });
        const maxFrames = args.maxFrames ?? 128;
        if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxFrames must be an integer from 1 to 256.' });
        const limit = boundedListLimit(args.limitPerAsset);
        const info = await assetInfoForSceneUsage(imageId);
        if (!['image', 'texture'].includes(String(info.importer ?? '')) && !['cc.ImageAsset', 'cc.Texture2D'].includes(String(info.type ?? ''))) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Asset ${imageId} is not an imported image.` });
        const frames = info.subAssets && typeof info.subAssets === 'object' && !Array.isArray(info.subAssets) ? Object.values(info.subAssets) : [];
        const spriteFrames = frames.filter((frame): frame is Record<string, unknown> => !!frame && typeof frame === 'object' && ((frame as Record<string, unknown>).importer === 'sprite-frame' || (frame as Record<string, unknown>).type === 'cc.SpriteFrame'));
        const frameReferences = spriteFrames.slice(0, maxFrames).map((frame) => {
            if (typeof frame.uuid !== 'string' || !frame.uuid.trim()) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: `Creator returned a SpriteFrame without an asset identity for ${imageId}.` });
            return { id: frame.uuid, type: 'cc.SpriteFrame' };
        });
        const direct = await queryNodesForAsset(imageId, limit);
        const frameUsages = [];
        for (const reference of frameReferences) frameUsages.push(await this.spriteFrameUsageInspect({ reference, limit }));
        return { imageReference: { id: imageId, type: typeof info.type === 'string' ? info.type : 'cc.ImageAsset' }, direct: { nodes: direct.references, total: direct.total, truncated: direct.truncated }, spriteFrames: frameUsages, totalSpriteFrames: spriteFrames.length, truncated: direct.truncated || spriteFrames.length > maxFrames || frameUsages.some((entry) => entry.truncated === true) };
    }
    @utcpTool('imageSceneUsageBatchInspect', 'Inspect scene usage for a bounded batch of imported image assets with per-item errors.', { type: 'object', additionalProperties: false, properties: { imageReferences: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema }, maxFrames: { type: 'integer', minimum: 1, maximum: 256, default: 128 }, limitPerAsset: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: ['imageReferences'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated'] }, 'GET', ['scene', 'image', 'sprite', 'usage', 'batch'])
    async imageSceneUsageBatchInspect(args: { imageReferences: IInstanceReference[], maxFrames?: number, limitPerAsset?: number }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.imageReferences) || args.imageReferences.length < 1 || args.imageReferences.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'imageReferences must contain 1 to 32 items.' });
        const items: Array<Record<string, unknown>> = [];
        for (const [index, imageReference] of args.imageReferences.entries()) {
            try { items.push({ index, ok: true, result: await this.imageSceneUsageInspect({ imageReference, maxFrames: args.maxFrames, limitPerAsset: args.limitPerAsset }) }); }
            catch (error) { items.push({ index, ok: false, imageReference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } }); }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        return { items, succeeded, failed: items.length - succeeded, truncated: items.some((item) => item.ok === true && (item.result as Record<string, unknown>)?.truncated === true) };
    }

    @utcpTool(
        'findNodesWithMissingAssets',
        'Find nodes with missing/broken asset references. QA/health check for scene integrity.',
        {
            type: 'object',
            properties: {
                limit: { type: 'number', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT, description: 'Maximum references to return.' }
            }
        },
        { type: 'object', properties: { references: { type: 'array', items: InstanceReferenceSchema }, total: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['references', 'total', 'truncated'] }, "GET", ['scene', 'node', 'missing', 'broken', 'asset', 'qa', 'health', 'integrity']
    )
    async findNodesWithMissingAssets(args: { limit?: number } = {}): Promise<{ references: IInstanceReference[], total: number, truncated: boolean }> {
        const result: unknown = await Editor.Message.request('scene', 'query-nodes-miss-assets');
        if (!Array.isArray(result)) {
            throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator returned no missing-assets node list.' });
        }
        const limit = boundedListLimit(args.limit);
        const references: IInstanceReference[] = [];
        for (const [index, value] of result.entries()) {
            const id = nodeUuidFromSceneUsage(value, 'query-nodes-miss-assets');
            if (index < limit) references.push({ id, type: 'cc.Node' });
        }
        return { references, total: result.length, truncated: result.length > limit };
    }

    @utcpTool(
        'findNodes',
        'Find nodes with AND-combined name/component/path filters, optionally inside an exact subtree UUID. Read-only bounded hierarchy traversal; paths remain relative to the open scene/prefab root.',
        {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Substring match on node name (case-insensitive).' },
                names: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 }, description: 'OR of exact names; mutually exclusive with name/nameMatch.' },
                excludeNames: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 }, description: 'Exclude exact node names, not their descendants; uses nameCaseSensitive.' },
                componentType: { type: 'string', description: 'Exact component class, e.g. cc.Sprite, cc.Label.' },
                componentTypes: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 } },
                excludeComponentTypes: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 }, description: 'Require absence of every listed class, AND-combined with presence predicates.' },
                componentMatch: { type: 'string', enum: ['all', 'any', 'none', 'only', 'subset'], default: 'all', description: 'only requires every requested class and no outside components; subset allows missing requested classes and empty inventories.' },
                nameMatch: { type: 'string', enum: ['contains', 'exact', 'prefix', 'suffix'], default: 'contains' },
                nameCaseSensitive: { type: 'boolean', default: false, description: 'Match node names with exact case; requires name. Path filtering is unchanged.' },
                pathContains: { type: 'string', minLength: 1, maxLength: 512 },
                pathMatch: { type: 'string', enum: ['contains', 'exact', 'prefix', 'suffix'], default: 'contains', description: 'Literal path matching using pathCaseSensitive; requires pathContains. Paths are not unique identities.' },
                pathCaseSensitive: { type: 'boolean', default: false, description: 'Literal case-sensitive path matching; requires pathContains and is independent of nameCaseSensitive.' },
                active: { type: 'boolean', description: 'Exact local active flag only; not visibility or activeInHierarchy.' },
                hierarchyActive: { type: 'boolean', description: 'Tri-state AND of local active flags from the observed hierarchy root; not runtime activeInHierarchy or visibility.' },
                minComponents: { type: 'integer', minimum: 0, maximum: 10000 },
                maxComponents: { type: 'integer', minimum: 0, maximum: 10000 },
                siblingIndex: { type: 'integer', minimum: 0, maximum: 10000 },
                minSiblingIndex: { type: 'integer', minimum: 0, maximum: 10000 },
                maxSiblingIndex: { type: 'integer', minimum: 0, maximum: 10000 },
                minSiblingCount: { type: 'integer', minimum: 1, maximum: 10000 },
                maxSiblingCount: { type: 'integer', minimum: 1, maximum: 10000 },
                siblingPosition: { type: 'string', enum: ['first', 'last', 'only'], description: 'Position in the full observed parent group, not filtered results; parentless root never matches.' },
                minDepth: { type: 'integer', minimum: 0, maximum: 99 },
                parentReference: InstanceReferenceSchema,
                parentReferences: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema, description: 'OR selection of exact direct-parent UUIDs; mutually exclusive with parentReference.' },
                minChildren: { type: 'integer', minimum: 0, maximum: 10000 },
                maxChildren: { type: 'integer', minimum: 0, maximum: 10000 },
                maxDepth: { type: 'integer', minimum: 0, maximum: 99 },
                rootReference: InstanceReferenceSchema,
                includeRoot: { type: 'boolean', default: true, description: 'Include the selected scope root in matches; false omits only that node, not traversal or ancestor state.' },
                excludeReferences: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema },
                references: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema, description: 'OR of exact node UUIDs; missing UUIDs refuse, other selectors still AND-combine.' },
                requireAllReferences: { type: 'boolean', default: false, description: 'Require every distinct references UUID to match all filters; requires references. Independent of result caps.' },
                requireSingle: { type: 'boolean', default: false, description: 'Require exactly one match over the complete bounded scope, independently of maxResults.' },
                requireMatch: { type: 'boolean', default: false, description: 'Require at least one filtered match over the complete bounded scope; multiple matches are valid.' },
                summaryOnly: { type: 'boolean', default: false, description: 'Count complete filtered matches without allocating result rows; nodes is empty and detailsOmitted is true.' },
                maxResults: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT, description: 'Cap results.' }
            },
            anyOf: [
                { required: ['names'] },
                { required: ['excludeNames'] },
                { required: ['name'] },
                { required: ['componentType'] },
                { required: ['pathContains'] },
                { required: ['rootReference'] },
                { required: ['componentTypes'] },
                { required: ['active'] },
                { required: ['minComponents'] },
                { required: ['maxComponents'] },
                { required: ['parentReference'] },
                { required: ['parentReferences'] },
                { required: ['minChildren'] },
                { required: ['maxChildren'] },
                { required: ['siblingIndex'] },
                { required: ['minSiblingIndex'] },
                { required: ['maxSiblingIndex'] },
                { required: ['minSiblingCount'] },
                { required: ['maxSiblingCount'] },
                { required: ['siblingPosition'] },
                { required: ['excludeComponentTypes'] },
                { required: ['minDepth'] },
                { required: ['maxDepth'] },
                { required: ['excludeReferences'] },
                { required: ['references'] },
                { required: ['hierarchyActive'] }
            ],
        },
        { type: 'object', properties: { nodes: { type: 'array', items: { type: 'object', properties: { reference: InstanceReferenceSchema, parentReference: { type: ['object', 'null'] }, name: { type: 'string' }, path: { type: 'string' }, depth: { type: 'integer' }, componentCount: { type: 'integer' }, childCount: { type: 'integer' }, siblingIndex: { type: ['integer', 'null'] }, siblingCount: { type: ['integer', 'null'] }, active: { type: ['boolean', 'null'] }, hierarchyActive: { type: ['boolean', 'null'] } } } }, detailsOmitted: { type: 'boolean' }, total: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['nodes', 'total'] }, "GET", ['scene', 'node', 'find', 'search', 'name', 'component', 'filter']
    )
    async findNodes(args: { references?: IInstanceReference[], requireAllReferences?: boolean, name?: string, names?: string[], excludeNames?: string[], nameMatch?: 'contains' | 'exact' | 'prefix' | 'suffix', nameCaseSensitive?: boolean, componentType?: string, componentTypes?: string[], excludeComponentTypes?: string[], componentMatch?: 'all' | 'any' | 'none' | 'only' | 'subset', pathContains?: string, pathCaseSensitive?: boolean, pathMatch?: 'contains' | 'exact' | 'prefix' | 'suffix', active?: boolean, hierarchyActive?: boolean, minComponents?: number, maxComponents?: number, parentReference?: IInstanceReference, parentReferences?: IInstanceReference[], minChildren?: number, maxChildren?: number, siblingIndex?: number, minSiblingIndex?: number, maxSiblingIndex?: number, minSiblingCount?: number, maxSiblingCount?: number, siblingPosition?: 'first' | 'last' | 'only', rootReference?: IInstanceReference, includeRoot?: boolean, excludeReferences?: IInstanceReference[], minDepth?: number, maxDepth?: number, maxResults?: number, summaryOnly?: boolean, requireSingle?: boolean, requireMatch?: boolean }): Promise<{ nodes: Array<{ reference: IInstanceReference, parentReference: IInstanceReference | null, name: string, path: string, depth: number, componentCount: number, childCount: number, siblingIndex: number | null, siblingCount: number | null, active: boolean | null, hierarchyActive: boolean | null }>, total: number, truncated: boolean, detailsOmitted?: true }> {
        if (args.requireSingle !== undefined && typeof args.requireSingle !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireSingle must be boolean.' });
        if (args.requireMatch !== undefined && typeof args.requireMatch !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireMatch must be boolean.' });
        if (args.includeRoot !== undefined && typeof args.includeRoot !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'includeRoot must be boolean.' });
        if (args.summaryOnly !== undefined && typeof args.summaryOnly !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'summaryOnly must be boolean.' });
        for (const [key, maximum] of [['name', 256], ['componentType', 256], ['pathContains', 512]] as const) {
            const value = args[key];
            if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > maximum)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${key} must be a bounded nonempty string.` });
        }
        if (args.pathMatch !== undefined && (!args.pathContains || !['contains', 'exact', 'prefix', 'suffix'].includes(args.pathMatch))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'pathMatch requires pathContains and contains/exact/prefix/suffix.' });
        if (args.pathCaseSensitive !== undefined && (typeof args.pathCaseSensitive !== 'boolean' || args.pathContains === undefined)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'pathCaseSensitive requires pathContains and a boolean value.' });
        const pathNeedle = args.pathCaseSensitive ? args.pathContains : args.pathContains?.toLowerCase();
        if (args.names !== undefined && (args.name !== undefined || args.nameMatch !== undefined)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Choose names or name/nameMatch, not both.' });
        if (args.names !== undefined && (!Array.isArray(args.names) || args.names.length < 1 || args.names.length > 32 || args.names.some(name => typeof name !== 'string' || !name.trim() || name.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'names requires1..32 bounded nonempty names.' });
        if (args.excludeNames !== undefined && (!Array.isArray(args.excludeNames) || args.excludeNames.length < 1 || args.excludeNames.length > 32 || args.excludeNames.some(name => typeof name !== 'string' || !name.trim() || name.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'excludeNames requires1..32 bounded nonempty names.' });
        if (args.nameMatch !== undefined && (!args.name || !['contains', 'exact', 'prefix', 'suffix'].includes(args.nameMatch))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nameMatch requires name and contains/exact/prefix/suffix.' });
        if (args.nameCaseSensitive !== undefined && (typeof args.nameCaseSensitive !== 'boolean' || args.name === undefined && args.names === undefined && args.excludeNames === undefined)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nameCaseSensitive requires a name selector and a boolean value.' });
        const nameNeedle = args.nameCaseSensitive ? args.name : args.name?.toLowerCase();
        const exactNames = args.names ? new Set(args.names.map(name => args.nameCaseSensitive ? name : name.toLowerCase())) : undefined;
        const excludedNames = new Set(args.excludeNames?.map(name => args.nameCaseSensitive ? name : name.toLowerCase()));
        if (args.componentType !== undefined && args.componentTypes !== undefined) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Choose componentType or componentTypes, not both.' });
        if (args.componentTypes !== undefined && (!Array.isArray(args.componentTypes) || args.componentTypes.length < 1 || args.componentTypes.length > 32 || args.componentTypes.some(type => typeof type !== 'string' || !type.trim() || type.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'componentTypes requires1..32 bounded class names.' });
        if (args.componentMatch !== undefined && (!args.componentTypes || !['all', 'any', 'none', 'only', 'subset'].includes(args.componentMatch))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'componentMatch requires componentTypes and all/any/none/only/subset.' });
        if (args.componentTypes !== undefined) for (const type of args.componentTypes) if (typeof type !== 'string' || !type.trim() || type.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'componentTypes requires bounded class names without missing entries.' });
        const types = [...new Set((args.componentTypes ?? (args.componentType ? [args.componentType] : [])).map(type => type.replace(/^cc\./, '')))];
        if (args.excludeComponentTypes !== undefined && (!Array.isArray(args.excludeComponentTypes) || args.excludeComponentTypes.length < 1 || args.excludeComponentTypes.length > 32 || args.excludeComponentTypes.some(type => typeof type !== 'string' || !type.trim() || type.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'excludeComponentTypes requires1..32 bounded class names.' });
        if (args.excludeComponentTypes !== undefined) for (const type of args.excludeComponentTypes) if (typeof type !== 'string' || !type.trim() || type.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'excludeComponentTypes requires bounded class names without missing entries.' });
        const absentTypes = [...new Set(args.excludeComponentTypes?.map(type => type.replace(/^cc\./, '')))];
        if (args.rootReference !== undefined && (typeof args.rootReference?.id !== 'string' || !args.rootReference.id.trim() || args.rootReference.id.length > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'rootReference requires a bounded node UUID.' });
        if (args.parentReference !== undefined && (typeof args.parentReference?.id !== 'string' || !args.parentReference.id.trim() || args.parentReference.id.length > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'parentReference requires a bounded node UUID.' });
        if (args.parentReference !== undefined && args.parentReferences !== undefined) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Choose parentReference or parentReferences, not both.' });
        if (args.parentReferences !== undefined) {
            if (!Array.isArray(args.parentReferences) || args.parentReferences.length < 1 || args.parentReferences.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'parentReferences requires1..32 bounded exact node UUIDs.' });
            for (const reference of args.parentReferences) if (typeof reference?.id !== 'string' || !reference.id.trim() || reference.id.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'parentReferences requires bounded exact UUIDs without missing entries.' });
        }
        if (args.minChildren !== undefined && (!Number.isInteger(args.minChildren) || args.minChildren < 0 || args.minChildren > 10000) || args.maxChildren !== undefined && (!Number.isInteger(args.maxChildren) || args.maxChildren < 0 || args.maxChildren > 10000) || args.minChildren !== undefined && args.maxChildren !== undefined && args.minChildren > args.maxChildren) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Child count filters must be integers0..10000 with minChildren<=maxChildren.' });
        if (args.siblingIndex !== undefined && (!Number.isInteger(args.siblingIndex) || args.siblingIndex < 0 || args.siblingIndex > 10000) || args.minSiblingIndex !== undefined && (!Number.isInteger(args.minSiblingIndex) || args.minSiblingIndex < 0 || args.minSiblingIndex > 10000) || args.maxSiblingIndex !== undefined && (!Number.isInteger(args.maxSiblingIndex) || args.maxSiblingIndex < 0 || args.maxSiblingIndex > 10000) || args.siblingIndex !== undefined && (args.minSiblingIndex !== undefined || args.maxSiblingIndex !== undefined) || args.minSiblingIndex !== undefined && args.maxSiblingIndex !== undefined && args.minSiblingIndex > args.maxSiblingIndex) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Sibling filters require one exact index or a valid range.' });
        if (args.minSiblingCount !== undefined && (!Number.isInteger(args.minSiblingCount) || args.minSiblingCount < 1 || args.minSiblingCount > 10000) || args.maxSiblingCount !== undefined && (!Number.isInteger(args.maxSiblingCount) || args.maxSiblingCount < 1 || args.maxSiblingCount > 10000) || args.minSiblingCount !== undefined && args.maxSiblingCount !== undefined && args.minSiblingCount > args.maxSiblingCount) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Sibling count filters require integers1..10000 with minSiblingCount<=maxSiblingCount.' });
        if (args.siblingPosition !== undefined && !['first', 'last', 'only'].includes(args.siblingPosition)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'siblingPosition requires first/last/only.' });
        if (args.excludeReferences !== undefined) {
            if (!Array.isArray(args.excludeReferences) || args.excludeReferences.length < 1 || args.excludeReferences.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'excludeReferences requires1..32 bounded node UUIDs.' });
            for (const reference of args.excludeReferences) if (typeof reference?.id !== 'string' || !reference.id.trim() || reference.id.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'excludeReferences requires bounded UUIDs without missing entries.' });
        }
        if (args.references !== undefined) {
            if (!Array.isArray(args.references) || args.references.length < 1 || args.references.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references requires1..32 bounded exact node UUIDs.' });
            for (const reference of args.references) if (typeof reference?.id !== 'string' || !reference.id.trim() || reference.id.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references requires bounded exact node UUIDs without missing entries.' });
        }
        if (args.requireAllReferences !== undefined && (typeof args.requireAllReferences !== 'boolean' || args.references === undefined)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireAllReferences requires references and a boolean value.' });
        const selectedIds = args.references === undefined ? undefined : new Set(args.references.map(reference => reference.id));
        const unseenReferences = new Set(selectedIds);
        const unmatchedReferences = args.requireAllReferences ? new Set(selectedIds) : undefined;
        const excludedIds = new Set(args.excludeReferences?.map(reference => reference.id));
        const parentIds = new Set(args.parentReferences?.map(reference => reference.id) ?? (args.parentReference ? [args.parentReference.id] : []));
        const unseenParent = new Set(parentIds);
        const unseenExclusions = new Set(excludedIds);
        if (args.minDepth !== undefined && (!Number.isInteger(args.minDepth) || args.minDepth < 0 || args.minDepth > 99) || args.maxDepth !== undefined && (!Number.isInteger(args.maxDepth) || args.maxDepth < 0 || args.maxDepth > 99) || args.minDepth !== undefined && args.maxDepth !== undefined && args.minDepth > args.maxDepth) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Depth filters must be integers0..99 with minDepth<=maxDepth.' });
        if (args.active !== undefined && typeof args.active !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'active must be a boolean local-state selector.' });
        if (args.hierarchyActive !== undefined && typeof args.hierarchyActive !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'hierarchyActive must be boolean.' });
        if (args.minComponents !== undefined && (!Number.isInteger(args.minComponents) || args.minComponents < 0 || args.minComponents > 10000) || args.maxComponents !== undefined && (!Number.isInteger(args.maxComponents) || args.maxComponents < 0 || args.maxComponents > 10000) || args.minComponents !== undefined && args.maxComponents !== undefined && args.minComponents > args.maxComponents) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Component count filters must be integers0..10000 with minComponents<=maxComponents.' });
        if (!args.references && !args.name && !args.names && !args.excludeNames && !types.length && !absentTypes.length && !args.pathContains && !args.rootReference && !args.parentReference && !args.parentReferences && !args.excludeReferences && args.active === undefined && args.hierarchyActive === undefined && args.minDepth === undefined && args.maxDepth === undefined && args.minComponents === undefined && args.maxComponents === undefined && args.minChildren === undefined && args.maxChildren === undefined && args.siblingIndex === undefined && args.minSiblingIndex === undefined && args.maxSiblingIndex === undefined && args.minSiblingCount === undefined && args.maxSiblingCount === undefined && args.siblingPosition === undefined) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'At least one node selector is required.' });
        if (args.maxResults !== undefined && (!Number.isInteger(args.maxResults) || args.maxResults < 1 || args.maxResults > MAX_LIST_LIMIT)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `maxResults must be an integer from 1 to ${MAX_LIST_LIMIT}.`, details: { field: 'maxResults' } });
        const limit = boundedListLimit(args.maxResults);
        const queried = await Editor.Message.request('scene', 'query-node-tree');
        if (!queried) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'No open hierarchy.' });
        const root = (await this.findPrefabEditRoot(queried)) ?? queried;
        const hits: Array<{ reference: IInstanceReference, parentReference: IInstanceReference | null, name: string, path: string, depth: number, componentCount: number, childCount: number, siblingIndex: number | null, siblingCount: number | null, active: boolean | null, hierarchyActive: boolean | null }> = [];
        const stack = [{ node: root, path: sceneTreeNodeName(root), depth: 0, parentReference: null as IInstanceReference | null, siblingIndex: 0, siblingCount: null as number | null, ancestorActive: true as boolean | null, inScope: !args.rootReference, excluded: false }];
        const visited = new Set<object>();
        const visitedIds = new Map<string, string>();
        let scheduled = 1, total = 0, rootFound = !args.rootReference;
        while (stack.length) {
            const { node, path: nodePath, depth, parentReference, siblingIndex, siblingCount, ancestorActive, inScope, excluded } = stack.pop()!;
            if (!node || typeof node !== 'object' || visited.has(node)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Malformed or cyclic scene hierarchy.' });
            visited.add(node);
            const id = nodeUuidFromSceneUsage(node, 'node search');
            if (visitedIds.has(id)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Duplicate node UUID in search hierarchy.', details: { nodeId: id, firstPath: visitedIds.get(id)!, path: nodePath } });
            visitedIds.set(id, nodePath);
            unseenParent.delete(id);
            unseenExclusions.delete(id);
            unseenReferences.delete(id);
            const branchExcluded = excluded || excludedIds.has(id);
            const scoped = inScope || id === args.rootReference?.id;
            const rootAllowed = (!selectedIds || selectedIds.has(id)) && (args.includeRoot !== false || (args.rootReference ? id !== args.rootReference.id : node !== root));
            if (id === args.rootReference?.id) rootFound = true;
            const relativeDepth = id === args.rootReference?.id ? 0 : depth;
            const name = sceneTreeNodeName(node);
            const comparableName = args.nameCaseSensitive ? name : name.toLowerCase();
            const nameOk = exactNames ? exactNames.has(comparableName) : nameNeedle === undefined || (args.nameMatch === 'exact' ? comparableName === nameNeedle : args.nameMatch === 'prefix' ? comparableName.startsWith(nameNeedle) : args.nameMatch === 'suffix' ? comparableName.endsWith(nameNeedle) : comparableName.includes(nameNeedle));
            const nameAllowed = !excludedNames.has(comparableName);
            const comparablePath = pathNeedle === undefined ? '' : args.pathCaseSensitive ? nodePath : nodePath.toLowerCase();
            const pathOk = pathNeedle === undefined || (args.pathMatch === 'exact' ? comparablePath === pathNeedle : args.pathMatch === 'prefix' ? comparablePath.startsWith(pathNeedle) : args.pathMatch === 'suffix' ? comparablePath.endsWith(pathNeedle) : comparablePath.includes(pathNeedle));
            const components = node.components ?? [];
            if (!Array.isArray(components)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Malformed component inventory.' });
            const attachedTypes = new Set<string>();
            let allComponentsAllowed = true;
            if (types.length || absentTypes.length) for (const component of components) {
                const candidates = [...componentCandidates(component), component?.__type__, componentClassId(component)].filter((type): type is string => typeof type === 'string' && !!type.trim());
                if (!candidates.length) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Component class identity is unavailable; presence/absence cannot be determined.' });
                if ((args.componentMatch === 'only' || args.componentMatch === 'subset') && !candidates.some(type => types.includes(type.replace(/^cc\./, '')))) allComponentsAllowed = false;
                for (const type of candidates) attachedTypes.add(type.replace(/^cc\./, ''));
            }
            const matched = types.filter(type => attachedTypes.has(type)).length;
            const compOk = (!types.length || (args.componentMatch === 'subset' ? allComponentsAllowed : args.componentMatch === 'any' ? matched > 0 : args.componentMatch === 'none' ? matched === 0 : matched === types.length)) && (args.componentMatch !== 'only' || allComponentsAllowed) && !absentTypes.some(type => attachedTypes.has(type));
            const componentCountOk = (args.minComponents === undefined || components.length >= args.minComponents) && (args.maxComponents === undefined || components.length <= args.maxComponents);
            const depthOk = (args.minDepth === undefined || relativeDepth >= args.minDepth) && (args.maxDepth === undefined || relativeDepth <= args.maxDepth);
            const rawActive = node.active;
            const active = typeof rawActive === 'boolean' ? rawActive : rawActive?.value;
            const hierarchyActive: boolean | null = ancestorActive === false || active === false ? false : ancestorActive === true && active === true ? true : null;
            const children = node.children ?? [];
            if (!Array.isArray(children)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Malformed hierarchy children.' });
            const childCountOk = (args.minChildren === undefined || children.length >= args.minChildren) && (args.maxChildren === undefined || children.length <= args.maxChildren);
            const parentOk = parentIds.size === 0 || parentReference !== null && parentIds.has(parentReference.id);
            const siblingOk = (args.siblingIndex === undefined || siblingIndex === args.siblingIndex) && (args.minSiblingIndex === undefined || siblingIndex >= args.minSiblingIndex) && (args.maxSiblingIndex === undefined || siblingIndex <= args.maxSiblingIndex) && (args.minSiblingCount === undefined && args.maxSiblingCount === undefined || siblingCount !== null && (args.minSiblingCount === undefined || siblingCount >= args.minSiblingCount) && (args.maxSiblingCount === undefined || siblingCount <= args.maxSiblingCount)) && (args.siblingPosition === undefined || siblingCount !== null && (args.siblingPosition === 'first' ? siblingIndex === 0 : args.siblingPosition === 'last' ? siblingIndex === siblingCount - 1 : siblingCount === 1));
            if (args.active !== undefined && scoped && rootAllowed && !branchExcluded && depthOk && nameOk && nameAllowed && compOk && componentCountOk && childCountOk && parentOk && siblingOk && pathOk && typeof active !== 'boolean') throw new ToolError({ code: 'NODE_STATE_UNAVAILABLE', status: 422, message: 'Local active metadata is unavailable; no complete activity-filtered result returned.', details: { nodeId: id, path: nodePath, stateScope: 'local' } });
            if (args.hierarchyActive !== undefined && scoped && rootAllowed && !branchExcluded && depthOk && nameOk && nameAllowed && compOk && componentCountOk && childCountOk && parentOk && siblingOk && (args.active === undefined || active === args.active) && pathOk && hierarchyActive === null) throw new ToolError({ code: 'NODE_STATE_UNAVAILABLE', status: 422, message: 'Ancestor activity is unknown; no complete filtered result returned.', details: { nodeId: id, path: nodePath, stateScope: 'hierarchy' } });
            if (scoped && rootAllowed && !branchExcluded && depthOk && nameOk && nameAllowed && compOk && componentCountOk && childCountOk && parentOk && siblingOk && (args.active === undefined || active === args.active) && (args.hierarchyActive === undefined || hierarchyActive === args.hierarchyActive) && pathOk) {
                total++;
                unmatchedReferences?.delete(id);
                if (!args.summaryOnly && hits.length < limit) hits.push({ reference: { id, type: 'cc.Node' }, parentReference, name, path: nodePath, depth: relativeDepth, componentCount: components.length, childCount: children.length, siblingIndex: parentReference ? siblingIndex : null, siblingCount, active: typeof active === 'boolean' ? active : null, hierarchyActive });
            }
            scheduled += children.length;
            if (scheduled > 10000) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 413, message: 'Node search exceeds 10000 hierarchy nodes; no complete result returned.', details: { scheduledNodes: scheduled, maximum: 10000 } });
            for (let index = children.length - 1; index >= 0; index--) {
                const child = children[index];
                if (!child || typeof child !== 'object' || Array.isArray(child)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Malformed hierarchy child.' });
                stack.push({ node: child, path: `${nodePath}/${sceneTreeNodeName(child)}`, depth: relativeDepth + 1, parentReference: { id, type: 'cc.Node' }, siblingIndex: index, siblingCount: children.length, ancestorActive: hierarchyActive, inScope: scoped, excluded: branchExcluded });
            }
        }
        if (!rootFound) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Search subtree UUID is absent from the open hierarchy.', details: { rootReference: args.rootReference } });
        if (unseenParent.size) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'The parent selector UUID is absent from the open hierarchy.', details: { missingParentIds: [...unseenParent] } });
        if (unseenExclusions.size) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'An excluded subtree UUID is absent from the open hierarchy.', details: { missingExcludedIds: [...unseenExclusions] } });
        if (unseenReferences.size) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Selected node UUIDs are absent from the open hierarchy.', details: { missingReferenceIds: [...unseenReferences] } });
        if (unmatchedReferences?.size) throw new ToolError({ code: 'NODE_SELECTION_INCOMPLETE', status: 409, message: 'Not every selected node matches the requested scope and filters.', details: { unmatchedReferenceIds: [...unmatchedReferences], selectedCount: selectedIds!.size, matchCount: total } });
        if (args.requireSingle && total !== 1) throw new ToolError({ code: total ? 'NODE_MATCH_AMBIGUOUS' : 'NODE_MATCH_NOT_FOUND', status: total ? 409 : 404, message: 'Single-node lookup requires exactly one filtered match.', details: { matchCount: total } });
        if (args.requireMatch && total === 0) throw new ToolError({ code: 'NODE_MATCH_NOT_FOUND', status: 404, message: 'Node presence check requires at least one filtered match.', details: { matchCount: 0 } });
        return { nodes: hits, total, truncated: total > hits.length, ...(args.summaryOnly ? { detailsOmitted: true as const } : {}) };
    }

    @utcpTool(
        'nodeGetPath',
        'Resolve a node UUID to its stable hierarchy path in the open scene or prefab. Use this reverse lookup before generating getChildByPath/find calls.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                reference: InstanceReferenceSchema,
                relativeTo: InstanceReferenceSchema,
                includeRoot: { type: 'boolean', default: true },
                requireUnique: { type: 'boolean', default: false, description: 'Refuse ambiguous slash-joined paths rather than returning collision metadata.' },
                expectedPath: { type: 'string', maxLength: 4096, description: 'Exact formatted path from a prior observation using the same relativeTo/includeRoot options.' },
                expectedAncestors: { type: 'array', maxItems: 9999, items: InstanceReferenceSchema, description: 'Exact ordered ancestor UUID chain from a prior lookup with the same relativeTo scope; target excluded.' },
                expectedSiblingIndex: { type: ['integer', 'null'], minimum: 0, maximum: 9999, description: 'Exact observed sibling index, or null for selected scope root. Does not identify parent.' },
                expectedSiblingCount: { type: ['integer', 'null'], minimum: 1, maximum: 9999, description: 'Expected full direct-parent child count; null requires scope root. Not sibling identity or order.' },
                expectedNextSibling: { type: ['object', 'null'], properties: { id: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['id'], description: 'Exact next sibling UUID, or null for no next sibling in scope.' },
                expectedPreviousSibling: { type: ['object', 'null'], properties: { id: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['id'], description: 'Exact previous sibling UUID, or null for no previous sibling in scope.' },
                expectedChildCount: { type: 'integer', minimum: 0, maximum: 9999, description: 'Expected immediate child count of the target, including0 for a leaf; not descendant identity.' },
                expectedDescendantCount: { type: 'integer', minimum: 0, maximum: 9999, description: 'Expected count of all nodes strictly below the target; not descendant identity or order.' },
                expectedChildren: { type: 'array', maxItems: 9999, items: InstanceReferenceSchema, description: 'Exact ordered immediate child UUID list; empty requires a leaf. Not recursive descendant identity.' },
            },
            required: ['reference'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                reference: InstanceReferenceSchema,
                path: { type: 'string' },
                segments: { type: 'array', items: { type: 'string' } },
                depth: { type: 'integer', minimum: 0 },
                childCount: { type: 'integer', minimum: 0 },
                descendantCount: { type: 'integer', minimum: 0 },
                subtreeHeight: { type: 'integer', minimum: 0 },
                subtreeLeafCount: { type: 'integer', minimum: 1 },
                relativeTo: InstanceReferenceSchema,
                pathUnique: { type: 'boolean' },
                matchingNodeCount: { type: 'integer', minimum: 1 },
                ancestors: { type: 'array', items: InstanceReferenceSchema },
                parentReference: { type: ['object', 'null'], properties: { id: { type: 'string' }, type: { type: 'string' } } },
                siblingIndex: { type: ['integer', 'null'], minimum: 0 },
                siblingCount: { type: ['integer', 'null'], minimum: 1 },
                previousSibling: { type: ['object', 'null'], properties: { id: { type: 'string' }, type: { type: 'string' } } },
                nextSibling: { type: ['object', 'null'], properties: { id: { type: 'string' }, type: { type: 'string' } } },
                firstChild: { type: ['object', 'null'], properties: { id: { type: 'string' }, type: { type: 'string' } } },
                lastChild: { type: ['object', 'null'], properties: { id: { type: 'string' }, type: { type: 'string' } } },
            },
            required: ['reference', 'path', 'segments', 'depth', 'childCount', 'descendantCount', 'subtreeHeight', 'subtreeLeafCount', 'pathUnique', 'matchingNodeCount', 'ancestors', 'parentReference', 'siblingIndex', 'siblingCount', 'previousSibling', 'nextSibling', 'firstChild', 'lastChild'],
        },
        'GET',
        ['scene', 'node', 'path', 'hierarchy', 'reverse', 'lookup']
    )
    async nodeGetPath(args: { reference: IInstanceReference, relativeTo?: IInstanceReference, includeRoot?: boolean, requireUnique?: boolean, expectedPath?: string, expectedAncestors?: IInstanceReference[], expectedSiblingIndex?: number | null, expectedSiblingCount?: number | null, expectedNextSibling?: IInstanceReference | null, expectedPreviousSibling?: IInstanceReference | null, expectedChildCount?: number, expectedDescendantCount?: number, expectedChildren?: IInstanceReference[] }): Promise<{ reference: IInstanceReference, path: string, segments: string[], depth: number, childCount: number, descendantCount: number, subtreeHeight: number, subtreeLeafCount: number, relativeTo?: IInstanceReference, pathUnique: boolean, matchingNodeCount: number, ancestors: IInstanceReference[], parentReference: IInstanceReference | null, siblingIndex: number | null, siblingCount: number | null, previousSibling: IInstanceReference | null, nextSibling: IInstanceReference | null, firstChild: IInstanceReference | null, lastChild: IInstanceReference | null }> {
        for (const reference of [args.reference, ...(args.relativeTo !== undefined ? [args.relativeTo] : [])]) {
            if (typeof reference?.id !== 'string' || !reference.id.trim() || reference.id.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Path lookup requires bounded exact node UUIDs.' });
        }
        if (args.includeRoot !== undefined && typeof args.includeRoot !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'includeRoot must be boolean.' });
        if (args.requireUnique !== undefined && typeof args.requireUnique !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireUnique must be boolean.' });
        if (args.expectedPath !== undefined && (typeof args.expectedPath !== 'string' || args.expectedPath.length > 4096)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedPath must be a string of at most4096 characters.' });
        if (args.expectedAncestors !== undefined) {
            if (!Array.isArray(args.expectedAncestors) || args.expectedAncestors.length > 9999) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedAncestors requires an ordered bounded UUID chain, at most9999 entries.' });
            for (const reference of args.expectedAncestors) if (typeof reference?.id !== 'string' || !reference.id.trim() || reference.id.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedAncestors requires bounded UUID references without missing entries.' });
        }
        if (args.expectedSiblingIndex !== undefined && args.expectedSiblingIndex !== null && (!Number.isInteger(args.expectedSiblingIndex) || args.expectedSiblingIndex < 0 || args.expectedSiblingIndex > 9999)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedSiblingIndex must be null or an integer0..9999.' });
        if (args.expectedSiblingCount !== undefined && args.expectedSiblingCount !== null && (!Number.isInteger(args.expectedSiblingCount) || args.expectedSiblingCount < 1 || args.expectedSiblingCount > 9999)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedSiblingCount must be null or an integer1..9999.' });
        if (args.expectedNextSibling !== undefined && args.expectedNextSibling !== null && (typeof args.expectedNextSibling.id !== 'string' || !args.expectedNextSibling.id.trim() || args.expectedNextSibling.id.length > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedNextSibling requires null or a bounded exact UUID reference.' });
        if (args.expectedPreviousSibling !== undefined && args.expectedPreviousSibling !== null && (typeof args.expectedPreviousSibling.id !== 'string' || !args.expectedPreviousSibling.id.trim() || args.expectedPreviousSibling.id.length > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedPreviousSibling requires null or a bounded exact UUID reference.' });
        if (args.expectedChildCount !== undefined && (!Number.isInteger(args.expectedChildCount) || args.expectedChildCount < 0 || args.expectedChildCount > 9999)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedChildCount requires an integer0..9999.' });
        if (args.expectedDescendantCount !== undefined && (!Number.isInteger(args.expectedDescendantCount) || args.expectedDescendantCount < 0 || args.expectedDescendantCount > 9999)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedDescendantCount requires an integer0..9999.' });
        if (args.expectedChildren !== undefined) {
            if (!Array.isArray(args.expectedChildren) || args.expectedChildren.length > 9999) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedChildren requires at most9999 distinct bounded UUID references in observed order.' });
            const childIds = new Set<string>();
            for (const reference of args.expectedChildren) {
                if (typeof reference?.id !== 'string' || !reference.id.trim() || reference.id.length > 256 || childIds.has(reference.id)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedChildren requires distinct bounded UUID references without missing entries.' });
                childIds.add(reference.id);
            }
        }
        const expectedAncestorIds = args.expectedAncestors?.map(reference => reference.id);
        const tree = await Editor.Message.request('scene', 'query-node-tree') as unknown as SceneTreeNode | null;
        if (!tree) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: 'No open scene or prefab hierarchy.' });
        const defaultRoot = args.relativeTo ? tree : ((await this.findPrefabEditRoot(tree)) as SceneTreeNode | null) ?? tree;
        return this.prepareObservedNodePaths(tree, defaultRoot, args.relativeTo, args.includeRoot)(args, expectedAncestorIds);
    }

    private prepareObservedNodePaths(tree: SceneTreeNode, defaultRoot: SceneTreeNode, relativeTo?: IInstanceReference, includeRoot?: boolean) {
        const nodes = new Map<string, SceneTreeNode>();
        const pending = [tree];
        let scheduled = 1;
        while (pending.length) {
            const node = pending.pop();
            if (!node || typeof node !== 'object' || Array.isArray(node)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Malformed hierarchy node.' });
            const id = nodeUuidFromSceneUsage(node, 'path lookup');
            if (nodes.has(id)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Duplicate UUID or cycle in hierarchy.' });
            nodes.set(id, node);
            const children = node.children ?? [];
            if (!Array.isArray(children)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Malformed hierarchy children.' });
            scheduled += children.length;
            if (scheduled > 10000) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 413, message: 'Path lookup exceeds10000 hierarchy nodes.' });
            for (const child of children) pending.push(child);
        }
        const descendantCounts = new Map<string, number>();
        const subtreeHeights = new Map<string, number>();
        const subtreeLeafCounts = new Map<string, number>();
        for (const node of [...nodes.values()].reverse()) {
            let count = 0, height = 0;
            let leaves = (node.children?.length ?? 0) === 0 ? 1 : 0;
            for (const child of node.children ?? []) {
                count += 1 + descendantCounts.get(child.uuid!)!;
                height = Math.max(height, 1 + subtreeHeights.get(child.uuid!)!);
                leaves += subtreeLeafCounts.get(child.uuid!)!;
            }
            descendantCounts.set(node.uuid!, count);
            subtreeHeights.set(node.uuid!, height);
            subtreeLeafCounts.set(node.uuid!, leaves);
        }
        const root = relativeTo ? nodes.get(relativeTo.id) : defaultRoot;
        if (!root) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: 'Relative root not found.' });
        const paths = new Map<string, number>();
        const parents = new Map<string, string>();
        const siblingIndices = new Map<string, number>();
        const stack: Array<{ node: SceneTreeNode, segments: string[] }> = [{ node: root, segments: [sceneTreeNodeName(root)] }];
        const segmentsById = new Map<string, string[]>();
        while (stack.length) {
            const { node, segments } = stack.pop()!;
            const outputSegments = includeRoot === false ? segments.slice(1) : segments;
            const path = outputSegments.join('/');
            paths.set(path, (paths.get(path) ?? 0) + 1);
            segmentsById.set(node.uuid!, outputSegments);
            const children = node.children ?? [];
            for (const [index, child] of children.entries()) {
                parents.set(child.uuid!, node.uuid!);
                siblingIndices.set(child.uuid!, index);
                stack.push({ node: child, segments: [...segments, sceneTreeNodeName(child)] });
            }
        }
        return (args: { reference: IInstanceReference, requireUnique?: boolean, expectedPath?: string, expectedSiblingIndex?: number | null, expectedSiblingCount?: number | null, expectedNextSibling?: IInstanceReference | null, expectedPreviousSibling?: IInstanceReference | null, expectedChildCount?: number, expectedDescendantCount?: number, expectedChildren?: IInstanceReference[] }, expectedAncestorIds?: string[]) => {
        const selected = segmentsById.get(args.reference.id);
        if (!selected) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: 'Node is not inside the requested hierarchy.' });
        const path = selected.join('/');
        if (args.expectedPath !== undefined && args.expectedPath !== path) throw new ToolError({ code: 'NODE_PATH_CHANGED', status: 409, message: 'The target hierarchy path differs from the expected observation.', details: { nodeId: args.reference.id, expectedPath: args.expectedPath, path }, recovery: 'Inspect the target by UUID before any mutation; do not resolve a different object using the old path.' });
        const matchingNodeCount = paths.get(path)!;
        if (args.requireUnique && matchingNodeCount !== 1) throw new ToolError({ code: 'NODE_PATH_AMBIGUOUS', status: 409, message: 'Multiple nodes share the requested hierarchy path; use UUID identity or a narrower root.', details: { path, matchingNodeCount, nodeId: args.reference.id } });
        const ancestors: IInstanceReference[] = [];
        for (let parent = parents.get(args.reference.id); parent !== undefined; parent = parents.get(parent)) ancestors.push({ id: parent, type: 'cc.Node' });
        ancestors.reverse();
        if (expectedAncestorIds !== undefined && (expectedAncestorIds.length !== ancestors.length || expectedAncestorIds.some((id, index) => id !== ancestors[index].id))) throw new ToolError({ code: 'NODE_ANCESTRY_CHANGED', status: 409, message: 'Observed ancestor identity differs from the expected chain.', details: { nodeId: args.reference.id, expectedAncestorIds, ancestorIds: ancestors.map(ancestor => ancestor.id) }, recovery: 'Inspect the exact target UUID and ancestor chain before any mutation.' });
        const parentId = parents.get(args.reference.id);
        const siblingIndex = siblingIndices.get(args.reference.id) ?? null;
        if (args.expectedSiblingIndex !== undefined && args.expectedSiblingIndex !== siblingIndex) throw new ToolError({ code: 'NODE_SIBLING_INDEX_CHANGED', status: 409, message: 'Observed sibling position differs from the expected index.', details: { nodeId: args.reference.id, expectedSiblingIndex: args.expectedSiblingIndex, siblingIndex } });
        const siblings = parentId === undefined ? undefined : nodes.get(parentId)!.children!;
        const siblingCount = siblings ? siblings.length : null;
        if (args.expectedSiblingCount !== undefined && args.expectedSiblingCount !== siblingCount) throw new ToolError({ code: 'NODE_SIBLING_COUNT_CHANGED', status: 409, message: 'Observed parent child count differs from the expected count.', details: { nodeId: args.reference.id, expectedSiblingCount: args.expectedSiblingCount, siblingCount } });
        const previous = siblings && siblingIndex !== null ? siblings[siblingIndex - 1] : undefined;
        const next = siblings && siblingIndex !== null ? siblings[siblingIndex + 1] : undefined;
        if (args.expectedNextSibling !== undefined && (args.expectedNextSibling?.id ?? null) !== (next?.uuid ?? null)) throw new ToolError({ code: 'NODE_NEXT_SIBLING_CHANGED', status: 409, message: 'Observed next sibling identity differs from the expected reference.', details: { nodeId: args.reference.id, expectedNextSiblingId: args.expectedNextSibling?.id ?? null, nextSiblingId: next?.uuid ?? null } });
        if (args.expectedPreviousSibling !== undefined && (args.expectedPreviousSibling?.id ?? null) !== (previous?.uuid ?? null)) throw new ToolError({ code: 'NODE_PREVIOUS_SIBLING_CHANGED', status: 409, message: 'Observed previous sibling identity differs from the expected reference.', details: { nodeId: args.reference.id, expectedPreviousSiblingId: args.expectedPreviousSibling?.id ?? null, previousSiblingId: previous?.uuid ?? null } });
        const children = nodes.get(args.reference.id)!.children ?? [];
        if (args.expectedChildCount !== undefined && args.expectedChildCount !== children.length) throw new ToolError({ code: 'NODE_CHILD_COUNT_CHANGED', status: 409, message: 'Observed immediate child count differs from the expected count.', details: { nodeId: args.reference.id, expectedChildCount: args.expectedChildCount, childCount: children.length } });
        const descendantCount = descendantCounts.get(args.reference.id)!;
        if (args.expectedDescendantCount !== undefined && args.expectedDescendantCount !== descendantCount) throw new ToolError({ code: 'NODE_DESCENDANT_COUNT_CHANGED', status: 409, message: 'Observed descendant count differs from the expected count.', details: { nodeId: args.reference.id, expectedDescendantCount: args.expectedDescendantCount, descendantCount } });
        if (args.expectedChildren !== undefined) {
            let mismatchIndex = 0;
            while (mismatchIndex < args.expectedChildren.length && mismatchIndex < children.length && args.expectedChildren[mismatchIndex].id === children[mismatchIndex].uuid) mismatchIndex++;
            if (mismatchIndex < args.expectedChildren.length || mismatchIndex < children.length) throw new ToolError({ code: 'NODE_CHILDREN_CHANGED', status: 409, message: 'Observed ordered child identities differ from the expected list.', details: { nodeId: args.reference.id, mismatchIndex, expectedChildId: args.expectedChildren[mismatchIndex]?.id ?? null, childId: children[mismatchIndex]?.uuid ?? null, expectedChildIds: args.expectedChildren.map(reference => reference.id), childIds: children.map(child => child.uuid!) } });
        }
        const firstChild = children[0], lastChild = children[children.length - 1];
        return { reference: { id: args.reference.id, type: 'cc.Node' }, path, segments: selected, depth: ancestors.length, childCount: children.length, descendantCount: descendantCounts.get(args.reference.id)!, subtreeHeight: subtreeHeights.get(args.reference.id)!, subtreeLeafCount: subtreeLeafCounts.get(args.reference.id)!, pathUnique: matchingNodeCount === 1, matchingNodeCount, ancestors, parentReference: parentId === undefined ? null : { id: parentId, type: 'cc.Node' }, siblingIndex, siblingCount: siblings ? siblings.length : null, previousSibling: previous ? { id: previous.uuid!, type: 'cc.Node' } : null, nextSibling: next ? { id: next.uuid!, type: 'cc.Node' } : null, firstChild: firstChild ? { id: firstChild.uuid!, type: 'cc.Node' } : null, lastChild: lastChild ? { id: lastChild.uuid!, type: 'cc.Node' } : null, ...(relativeTo ? { relativeTo } : {}) };
        };
    }

    @utcpTool(
        'nodeGetPaths',
        'Resolve1..32 exact node UUIDs from one captured bounded hierarchy with per-target errors. No atomic editor snapshot or mutation.',
        { type: 'object', additionalProperties: false, properties: {
            references: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema },
            expectedPaths: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, path: { type: 'string', maxLength: 4096 } }, required: ['reference', 'path'] }, description: 'Optional exact paths keyed by requested target UUID; omitted targets are unguarded.' },
            expectedAncestors: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, ancestors: { type: 'array', maxItems: 9999, items: InstanceReferenceSchema } }, required: ['reference', 'ancestors'] }, description: 'Optional ordered ancestor UUID chains keyed by requested target; same relativeTo scope required.' },
            expectedSiblingIndices: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, siblingIndex: { type: ['integer', 'null'], minimum: 0, maximum: 9999 } }, required: ['reference', 'siblingIndex'] }, description: 'Optional scoped sibling positions keyed by requested UUID; null requires scope root.' },
            expectedSiblingCounts: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, siblingCount: { type: ['integer', 'null'], minimum: 1, maximum: 9999 } }, required: ['reference', 'siblingCount'] }, description: 'Optional full parent child-count baselines keyed by target UUID; null requires scope root.' },
            expectedChildCounts: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, childCount: { type: 'integer', minimum: 0, maximum: 9999 } }, required: ['reference', 'childCount'] }, description: 'Immediate child-count baselines keyed by exact requested target UUID.' },
            expectedDescendantCounts: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, descendantCount: { type: 'integer', minimum: 0, maximum: 9999 } }, required: ['reference', 'descendantCount'] }, description: 'Full descendant-count baselines keyed by requested target UUID.' },
            expectedNeighbors: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, previousSibling: { type: ['object', 'null'], properties: { id: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['id'] }, nextSibling: { type: ['object', 'null'], properties: { id: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['id'] } }, required: ['reference', 'previousSibling', 'nextSibling'] }, description: 'Both neighbor UUID/null baselines keyed by exact requested target.' },
            relativeTo: InstanceReferenceSchema, includeRoot: { type: 'boolean', default: true }, requireUnique: { type: 'boolean', default: false },
            requireAll: { type: 'boolean', default: false, description: 'Refuse partial target resolution after collecting every item result; no mutation or rollback.' },
            requireDisjoint: { type: 'boolean', default: false, description: 'Reject duplicate requested UUIDs and ancestor/descendant overlaps among successfully resolved targets. Does not imply requireAll.' },
            requireDistinct: { type: 'boolean', default: false, description: 'Reject repeated requested UUIDs before IPC, while permitting ancestor/descendant selections. Does not imply requireAll.' },
            requireSameParent: { type: 'boolean', default: false, description: 'Require a nonempty resolved group with the same direct parent UUID inside the selected scope. Does not imply requireAll or distinct targets.' },
            requireSameDepth: { type: 'boolean', default: false, description: 'Require every target to resolve at the same scoped depth; different direct parents are allowed.' },
            requireContiguous: { type: 'boolean', default: false, description: 'Require all requested UUIDs distinct and resolved as consecutive siblings under one observed parent; input order is irrelevant.' },
            requireCompleteSiblings: { type: 'boolean', default: false, description: 'Require complete target resolution and every represented parent group to include all observed children; scope roots refuse.' },
            requireCompleteSubtrees: { type: 'boolean', default: false, description: 'Require every target to resolve and every descendant of selected nodes to be explicitly selected; no expansion.' },
            requireInputOrder: { type: 'boolean', default: false, description: 'Require complete distinct siblings in ascending observed index order matching input; gaps allowed unless requireContiguous.' },
            requireSiblingIndices: { type: 'boolean', default: false, description: 'Require an expectedSiblingIndices guard for every distinct requested UUID before IPC; does not imply requireAll.' },
            requireSiblingCounts: { type: 'boolean', default: false, description: 'Require expectedSiblingCounts for every distinct requested UUID before IPC; does not imply requireAll.' },
            requireNeighbors: { type: 'boolean', default: false, description: 'Require an expectedNeighbors pair for every distinct requested UUID before IPC; does not imply requireAll.' },
            requireChildCounts: { type: 'boolean', default: false, description: 'Require expectedChildCounts for every distinct target before IPC; does not imply requireAll.' },
            requireDescendantCounts: { type: 'boolean', default: false, description: 'Require expectedDescendantCounts for every distinct target before IPC; does not imply requireAll.' },
            requireAncestors: { type: 'boolean', default: false, description: 'Require expectedAncestors for every distinct requested UUID before IPC; does not imply requireAll.' },
            requirePaths: { type: 'boolean', default: false, description: 'Require expectedPaths for every distinct requested UUID before IPC; does not imply requireAll.' },
        }, required: ['references'] },
        { type: 'object', properties: { subtreeSelectionCoverage: { type: ['object', 'null'], properties: { selectedCount: { type: 'integer', minimum: 1 }, subtreeNodeCount: { type: 'integer', minimum: 1 }, unselectedCount: { type: 'integer', minimum: 0 }, complete: { type: 'boolean' } }, required: ['selectedCount', 'subtreeNodeCount', 'unselectedCount', 'complete'] }, selectionParentCounts: { type: ['array', 'null'], items: { type: 'object', properties: { parentReference: { type: ['object', 'null'], properties: { id: { type: 'string' }, type: { type: 'string' } } }, references: { type: 'array', maxItems: 32, items: InstanceReferenceSchema }, count: { type: 'integer', minimum: 1 }, siblingCount: { type: ['integer', 'null'], minimum: 1 }, complete: { type: ['boolean', 'null'] } }, required: ['parentReference', 'references', 'count', 'siblingCount', 'complete'] } }, selectionDepthCounts: { type: ['object', 'null'], additionalProperties: { type: 'integer', minimum: 1 } }, selectionDepthRange: { type: ['object', 'null'], properties: { min: { type: 'integer', minimum: 0 }, max: { type: 'integer', minimum: 0 } }, required: ['min', 'max'] }, selectedSubtreeNodeCount: { type: ['integer', 'null'], minimum: 1 }, items: { type: 'array' }, errorCounts: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 } }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, siblingBlocks: { type: ['array', 'null'], items: { type: 'object', properties: { firstIndex: { type: 'integer', minimum: 0 }, lastIndex: { type: 'integer', minimum: 0 }, references: { type: 'array', items: InstanceReferenceSchema } }, required: ['firstIndex', 'lastIndex', 'references'] } }, siblingSpan: { type: ['object', 'null'], properties: { firstIndex: { type: 'integer', minimum: 0 }, lastIndex: { type: 'integer', minimum: 0 }, gapCount: { type: 'integer', minimum: 0 } }, required: ['firstIndex', 'lastIndex', 'gapCount'] }, siblingOrder: { type: ['array', 'null'], items: InstanceReferenceSchema }, sharedParent: { type: ['object', 'null'], properties: { id: { type: 'string' }, type: { type: 'string' } } }, selectionRoots: { type: 'array', items: InstanceReferenceSchema }, selectionCoverage: { type: 'array', items: { type: 'object', properties: { reference: InstanceReferenceSchema, selectionRoot: InstanceReferenceSchema, distanceFromSelectionRoot: { type: 'integer', minimum: 0 } }, required: ['reference', 'selectionRoot', 'distanceFromSelectionRoot'] } }, commonAncestor: { type: ['object', 'null'], properties: { id: { type: 'string' }, type: { type: 'string' } } } }, required: ['subtreeSelectionCoverage', 'selectionParentCounts', 'selectionDepthCounts', 'selectionDepthRange', 'errorCounts', 'selectedSubtreeNodeCount', 'items', 'succeeded', 'failed', 'commonAncestor', 'sharedParent', 'siblingOrder', 'siblingSpan', 'siblingBlocks', 'selectionRoots', 'selectionCoverage'] },
        'GET', ['scene', 'node', 'path', 'batch', 'ancestors']
    )
    async nodeGetPaths(args: { references: IInstanceReference[], expectedPaths?: Array<{ reference: IInstanceReference, path: string }>, expectedAncestors?: Array<{ reference: IInstanceReference, ancestors: IInstanceReference[] }>, expectedSiblingIndices?: Array<{ reference: IInstanceReference, siblingIndex: number | null }>, expectedSiblingCounts?: Array<{ reference: IInstanceReference, siblingCount: number | null }>, expectedNeighbors?: Array<{ reference: IInstanceReference, previousSibling: IInstanceReference | null, nextSibling: IInstanceReference | null }>, expectedChildCounts?: Array<{ reference: IInstanceReference, childCount: number }>, expectedDescendantCounts?: Array<{ reference: IInstanceReference, descendantCount: number }>, relativeTo?: IInstanceReference, includeRoot?: boolean, requireUnique?: boolean, requireAll?: boolean, requireDisjoint?: boolean, requireDistinct?: boolean, requireSameParent?: boolean, requireSameDepth?: boolean, requireContiguous?: boolean, requireCompleteSiblings?: boolean, requireCompleteSubtrees?: boolean, requireInputOrder?: boolean, requireSiblingIndices?: boolean, requireSiblingCounts?: boolean, requireNeighbors?: boolean, requireChildCounts?: boolean, requireDescendantCounts?: boolean, requireAncestors?: boolean, requirePaths?: boolean }): Promise<{ items: Array<Record<string, unknown>>, errorCounts: Record<string, number>, subtreeSelectionCoverage: { selectedCount: number, subtreeNodeCount: number, unselectedCount: number, complete: boolean } | null, selectionParentCounts: Array<{ parentReference: IInstanceReference | null, references: IInstanceReference[], count: number, siblingCount: number | null, complete: boolean | null }> | null, selectionDepthCounts: Record<string, number> | null, selectionDepthRange: { min: number, max: number } | null, succeeded: number, failed: number, selectedSubtreeNodeCount: number | null, commonAncestor: IInstanceReference | null, sharedParent: IInstanceReference | null, siblingOrder: IInstanceReference[] | null, siblingBlocks: Array<{ firstIndex: number, lastIndex: number, references: IInstanceReference[] }> | null, siblingSpan: { firstIndex: number, lastIndex: number, gapCount: number } | null, selectionRoots: IInstanceReference[], selectionCoverage: Array<{ reference: IInstanceReference, selectionRoot: IInstanceReference, distanceFromSelectionRoot: number }> }> {
        if (!Array.isArray(args?.references) || args.references.length < 1 || args.references.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references requires1..32 bounded node UUIDs.' });
        for (const reference of args.references) if (typeof reference?.id !== 'string' || !reference.id.trim() || reference.id.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references requires bounded node UUIDs without missing entries.' });
        if (args.relativeTo !== undefined && (typeof args.relativeTo?.id !== 'string' || !args.relativeTo.id.trim() || args.relativeTo.id.length > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'relativeTo requires a bounded node UUID.' });
        if (args.includeRoot !== undefined && typeof args.includeRoot !== 'boolean' || args.requireUnique !== undefined && typeof args.requireUnique !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Path projection flags must be boolean.' });
        if (args.requireAll !== undefined && typeof args.requireAll !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireAll must be boolean.' });
        if (args.requireDisjoint !== undefined && typeof args.requireDisjoint !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireDisjoint must be boolean.' });
        if (args.requireDistinct !== undefined && typeof args.requireDistinct !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireDistinct must be boolean.' });
        if (args.requireSameParent !== undefined && typeof args.requireSameParent !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireSameParent must be boolean.' });
        if (args.requireSameDepth !== undefined && typeof args.requireSameDepth !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireSameDepth must be boolean.' });
        if (args.requireContiguous !== undefined && typeof args.requireContiguous !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireContiguous must be boolean.' });
        if (args.requireCompleteSiblings !== undefined && typeof args.requireCompleteSiblings !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireCompleteSiblings must be boolean.' });
        if (args.requireCompleteSubtrees !== undefined && typeof args.requireCompleteSubtrees !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireCompleteSubtrees must be boolean.' });
        if (args.requireInputOrder !== undefined && typeof args.requireInputOrder !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireInputOrder must be boolean.' });
        if (args.requireSiblingIndices !== undefined && typeof args.requireSiblingIndices !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireSiblingIndices must be boolean.' });
        if (args.requireSiblingCounts !== undefined && typeof args.requireSiblingCounts !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireSiblingCounts must be boolean.' });
        if (args.requireNeighbors !== undefined && typeof args.requireNeighbors !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireNeighbors must be boolean.' });
        if (args.requireChildCounts !== undefined && typeof args.requireChildCounts !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireChildCounts must be boolean.' });
        if (args.requireDescendantCounts !== undefined && typeof args.requireDescendantCounts !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireDescendantCounts must be boolean.' });
        if (args.requireAncestors !== undefined && typeof args.requireAncestors !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireAncestors must be boolean.' });
        if (args.requirePaths !== undefined && typeof args.requirePaths !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requirePaths must be boolean.' });
        const references = args.references.map(reference => ({ id: reference.id }));
        const expectedPaths = new Map<string, string>();
        const requestedIds = new Set(references.map(reference => reference.id));
        if ((args.requireDisjoint || args.requireContiguous || args.requireInputOrder || args.requireDistinct) && requestedIds.size !== references.length) {
            const positions = new Map<string, number[]>();
            for (const [index, reference] of references.entries()) {
                const indices = positions.get(reference.id);
                if (indices) indices.push(index);
                else positions.set(reference.id, [index]);
            }
            const duplicates = [...positions].filter(([, indices]) => indices.length > 1).map(([id, indices]) => ({ reference: { id }, indices }));
            const mode = args.requireDisjoint ? 'Disjoint' : args.requireContiguous ? 'Contiguous' : args.requireInputOrder ? 'Ordered' : 'Distinct';
            throw new ToolError({ code: 'NODE_SELECTION_OVERLAP', status: 409, message: `${mode} selection cannot contain duplicate node UUIDs.`, details: { duplicates } });
        }
        if (args.expectedPaths !== undefined) {
            if (!Array.isArray(args.expectedPaths) || args.expectedPaths.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedPaths accepts at most32 target-bound paths.' });
            for (const entry of args.expectedPaths) {
                const id = entry?.reference?.id;
                if (typeof id !== 'string' || !requestedIds.has(id) || expectedPaths.has(id) || typeof entry.path !== 'string' || entry.path.length > 4096) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Expected paths must be unique valid entries bound to requested UUIDs.' });
                expectedPaths.set(id, entry.path);
            }
        }
        if (args.requirePaths && expectedPaths.size !== requestedIds.size) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requirePaths requires an expected path for every requested UUID.', details: { missingPathGuardIds: [...requestedIds].filter(id => !expectedPaths.has(id)) } });
        const expectedAncestors = new Map<string, string[]>();
        if (args.expectedAncestors !== undefined) {
            if (!Array.isArray(args.expectedAncestors) || args.expectedAncestors.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedAncestors accepts at most32 target-bound chains.' });
            for (const entry of args.expectedAncestors) {
                const id = entry?.reference?.id;
                if (typeof id !== 'string' || !requestedIds.has(id) || expectedAncestors.has(id) || !Array.isArray(entry.ancestors) || entry.ancestors.length > 9999) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Ancestor guards require unique requested targets and bounded ordered UUID chains.' });
                for (const reference of entry.ancestors) if (typeof reference?.id !== 'string' || !reference.id.trim() || reference.id.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Ancestor guards require bounded UUID references without missing entries.' });
                expectedAncestors.set(id, entry.ancestors.map(reference => reference.id));
            }
        }
        if (args.requireAncestors && expectedAncestors.size !== requestedIds.size) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireAncestors requires an ancestor guard for every requested UUID.', details: { missingAncestorGuardIds: [...requestedIds].filter(id => !expectedAncestors.has(id)) } });
        const expectedSiblingIndices = new Map<string, number | null>();
        if (args.expectedSiblingIndices !== undefined) {
            if (!Array.isArray(args.expectedSiblingIndices) || args.expectedSiblingIndices.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedSiblingIndices accepts at most32 target-bound positions.' });
            for (const entry of args.expectedSiblingIndices) {
                const id = entry?.reference?.id;
                if (typeof id !== 'string' || !requestedIds.has(id) || expectedSiblingIndices.has(id) || entry.siblingIndex !== null && (!Number.isInteger(entry.siblingIndex) || entry.siblingIndex < 0 || entry.siblingIndex > 9999)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Sibling guards require unique requested UUIDs and null or integer0..9999 positions.' });
                expectedSiblingIndices.set(id, entry.siblingIndex);
            }
        }
        if (args.requireSiblingIndices && expectedSiblingIndices.size !== requestedIds.size) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireSiblingIndices requires a position guard for every requested UUID.', details: { missingSiblingIndexGuardIds: [...requestedIds].filter(id => !expectedSiblingIndices.has(id)) } });
        const expectedSiblingCounts = new Map<string, number | null>();
        if (args.expectedSiblingCounts !== undefined) {
            if (!Array.isArray(args.expectedSiblingCounts) || args.expectedSiblingCounts.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedSiblingCounts accepts at most32 target-bound counts.' });
            for (const entry of args.expectedSiblingCounts) {
                const id = entry?.reference?.id;
                if (typeof id !== 'string' || !requestedIds.has(id) || expectedSiblingCounts.has(id) || entry.siblingCount !== null && (!Number.isInteger(entry.siblingCount) || entry.siblingCount < 1 || entry.siblingCount > 9999)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Sibling count guards require unique requested UUIDs and null or integer1..9999 counts.' });
                expectedSiblingCounts.set(id, entry.siblingCount);
            }
        }
        if (args.requireSiblingCounts && expectedSiblingCounts.size !== requestedIds.size) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireSiblingCounts requires a count guard for every requested UUID.', details: { missingSiblingCountGuardIds: [...requestedIds].filter(id => !expectedSiblingCounts.has(id)) } });
        const expectedNeighbors = new Map<string, { expectedPreviousSibling: IInstanceReference | null, expectedNextSibling: IInstanceReference | null }>();
        if (args.expectedNeighbors !== undefined) {
            if (!Array.isArray(args.expectedNeighbors) || args.expectedNeighbors.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedNeighbors accepts at most32 target-bound pairs.' });
            for (const entry of args.expectedNeighbors) {
                const id = entry?.reference?.id;
                if (typeof id !== 'string' || !requestedIds.has(id) || expectedNeighbors.has(id) || [entry.previousSibling, entry.nextSibling].some(neighbor => neighbor !== null && (typeof neighbor?.id !== 'string' || !neighbor.id.trim() || neighbor.id.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Neighbor guards require unique requested UUIDs and two explicit UUID/null baselines.' });
                expectedNeighbors.set(id, { expectedPreviousSibling: entry.previousSibling === null ? null : { id: entry.previousSibling.id }, expectedNextSibling: entry.nextSibling === null ? null : { id: entry.nextSibling.id } });
            }
        }
        if (args.requireNeighbors && expectedNeighbors.size !== requestedIds.size) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireNeighbors requires a neighbor pair for every requested UUID.', details: { missingNeighborGuardIds: [...requestedIds].filter(id => !expectedNeighbors.has(id)) } });
        const expectedChildCounts = new Map<string, number>();
        if (args.expectedChildCounts !== undefined) {
            if (!Array.isArray(args.expectedChildCounts) || args.expectedChildCounts.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedChildCounts accepts at most32 target-bound counts.' });
            for (const entry of args.expectedChildCounts) {
                const id = entry?.reference?.id;
                if (typeof id !== 'string' || !requestedIds.has(id) || expectedChildCounts.has(id) || !Number.isInteger(entry.childCount) || entry.childCount < 0 || entry.childCount > 9999) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Child count guards require unique requested UUIDs and integer0..9999 counts.' });
                expectedChildCounts.set(id, entry.childCount);
            }
        }
        if (args.requireChildCounts && expectedChildCounts.size !== requestedIds.size) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireChildCounts requires a child count guard for every requested UUID.', details: { missingChildCountGuardIds: [...requestedIds].filter(id => !expectedChildCounts.has(id)) } });
        const expectedDescendantCounts = new Map<string, number>();
        if (args.expectedDescendantCounts !== undefined) {
            if (!Array.isArray(args.expectedDescendantCounts) || args.expectedDescendantCounts.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedDescendantCounts accepts at most32 target-bound counts.' });
            for (const entry of args.expectedDescendantCounts) {
                const id = entry?.reference?.id;
                if (typeof id !== 'string' || !requestedIds.has(id) || expectedDescendantCounts.has(id) || !Number.isInteger(entry.descendantCount) || entry.descendantCount < 0 || entry.descendantCount > 9999) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Descendant count guards require unique requested UUIDs and integer0..9999 counts.' });
                expectedDescendantCounts.set(id, entry.descendantCount);
            }
        }
        if (args.requireDescendantCounts && expectedDescendantCounts.size !== requestedIds.size) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireDescendantCounts requires a descendant count guard for every requested UUID.', details: { missingDescendantCountGuardIds: [...requestedIds].filter(id => !expectedDescendantCounts.has(id)) } });
        const relativeTo = args.relativeTo ? { id: args.relativeTo.id } : undefined;
        const includeRoot = args.includeRoot, requireUnique = args.requireUnique;
        const items: Array<Record<string, unknown>> = [];
        const errorCounts: Record<string, number> = Object.create(null);
        let succeeded = 0;
        let minDepth = Infinity, maxDepth = 0;
        let commonChain: IInstanceReference[] | undefined;
        const resolved = new Map<string, { reference: IInstanceReference, ancestors: IInstanceReference[], siblingIndex: number | null, siblingCount: number | null, descendantCount: number }>();
        const tree = await Editor.Message.request('scene', 'query-node-tree') as unknown as SceneTreeNode | null;
        if (!tree) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: 'No open scene or prefab hierarchy.' });
        const defaultRoot = relativeTo ? tree : ((await this.findPrefabEditRoot(tree)) as SceneTreeNode | null) ?? tree;
        const resolvePath = this.prepareObservedNodePaths(tree, defaultRoot, relativeTo, includeRoot);
        for (const [index, reference] of references.entries()) {
            try {
                const result = resolvePath({ ...expectedNeighbors.get(reference.id), reference, requireUnique, expectedDescendantCount: expectedDescendantCounts.get(reference.id), expectedChildCount: expectedChildCounts.get(reference.id), expectedPath: expectedPaths.get(reference.id), expectedSiblingCount: expectedSiblingCounts.get(reference.id), expectedSiblingIndex: expectedSiblingIndices.get(reference.id) }, expectedAncestors.get(reference.id));
                items.push({ index, ok: true, reference, result });
                succeeded++;
                minDepth = Math.min(minDepth, result.ancestors.length);
                maxDepth = Math.max(maxDepth, result.ancestors.length);
                resolved.set(result.reference.id, result);
                const chain = [...result.ancestors, result.reference];
                if (commonChain === undefined) commonChain = chain;
                else {
                    let shared = 0;
                    while (shared < commonChain.length && shared < chain.length && commonChain[shared].id === chain[shared].id) shared++;
                    commonChain.length = shared;
                }
            } catch (error) {
                const code = error instanceof ToolError ? error.code : 'NODE_PATH_QUERY_FAILED';
                errorCounts[code] = (errorCounts[code] ?? 0) + 1;
                items.push({ index, ok: false, reference, error: { status: error instanceof ToolError ? error.status : 500, code, message: (error instanceof Error ? error.message : String(error)).slice(0, 512), ...(error instanceof ToolError && error.details ? { details: error.details } : {}), ...(error instanceof ToolError && error.recovery ? { recovery: error.recovery } : {}) } });
            }
        }
        const selectionRoots: IInstanceReference[] = [];
        const selectionCoverage: Array<{ reference: IInstanceReference, selectionRoot: IInstanceReference, distanceFromSelectionRoot: number }> = [];
        for (const target of resolved.values()) {
            const selectedAncestor = target.ancestors.find(ancestor => resolved.has(ancestor.id));
            const selectionRoot = selectedAncestor ? resolved.get(selectedAncestor.id)!.reference : target.reference;
            if (!selectedAncestor) selectionRoots.push(target.reference);
            selectionCoverage.push({ reference: target.reference, selectionRoot, distanceFromSelectionRoot: selectedAncestor ? target.ancestors.length - resolved.get(selectedAncestor.id)!.ancestors.length : 0 });
        }
        let parentId: string | undefined;
        let sameParent = resolved.size > 0;
        for (const target of resolved.values()) {
            const parent = target.ancestors[target.ancestors.length - 1]?.id;
            if (parent === undefined || parentId !== undefined && parent !== parentId) sameParent = false;
            parentId = parent;
        }
        const sharedParent: IInstanceReference | null = sameParent && parentId !== undefined ? { id: parentId, type: 'cc.Node' } : null;
        const siblingOrder: IInstanceReference[] | null = succeeded === references.length && resolved.size === references.length && sharedParent !== null
            ? [...resolved.values()].sort((a, b) => a.siblingIndex! - b.siblingIndex!).map(target => target.reference) : null;
        const siblingSpan = siblingOrder ? {
            firstIndex: resolved.get(siblingOrder[0].id)!.siblingIndex!,
            lastIndex: resolved.get(siblingOrder[siblingOrder.length - 1].id)!.siblingIndex!,
            gapCount: resolved.get(siblingOrder[siblingOrder.length - 1].id)!.siblingIndex! - resolved.get(siblingOrder[0].id)!.siblingIndex! + 1 - siblingOrder.length,
        } : null;
        const siblingBlocks: Array<{ firstIndex: number, lastIndex: number, references: IInstanceReference[] }> | null = siblingOrder ? [] : null;
        if (siblingOrder && siblingBlocks) for (const reference of siblingOrder) {
            const index = resolved.get(reference.id)!.siblingIndex!;
            const previous = siblingBlocks[siblingBlocks.length - 1];
            if (previous && index === previous.lastIndex + 1) {
                previous.lastIndex = index;
                previous.references.push(reference);
            } else siblingBlocks.push({ firstIndex: index, lastIndex: index, references: [reference] });
        }
        const selectionDepthCounts: Record<string, number> | null = succeeded === references.length ? Object.create(null) : null;
        if (selectionDepthCounts) for (const target of resolved.values()) {
            const depth = target.ancestors.length;
            selectionDepthCounts[depth] = (selectionDepthCounts[depth] ?? 0) + 1;
        }
        let selectionParentCounts: Array<{ parentReference: IInstanceReference | null, references: IInstanceReference[], count: number, siblingCount: number | null, complete: boolean | null }> | null = null;
        if (succeeded === references.length) {
            const groups = new Map<string | null, { parentReference: IInstanceReference | null, references: IInstanceReference[], count: number, siblingCount: number | null, complete: boolean | null }>();
            for (const target of resolved.values()) {
                const parent = target.ancestors[target.ancestors.length - 1] ?? null;
                const id = parent?.id ?? null;
                const group = groups.get(id);
                if (group) { group.references.push(target.reference); group.count++; group.complete = group.siblingCount === null ? null : group.count === group.siblingCount; }
                else groups.set(id, { parentReference: parent, references: [target.reference], count: 1, siblingCount: target.siblingCount, complete: target.siblingCount === null ? null : target.siblingCount === 1 });
            }
            selectionParentCounts = [...groups.values()];
        }
        const selectedSubtreeNodeCount = succeeded === references.length ? selectionRoots.reduce((sum, root) => sum + 1 + resolved.get(root.id)!.descendantCount, 0) : null;
        const subtreeSelectionCoverage = selectedSubtreeNodeCount === null ? null : { selectedCount: resolved.size, subtreeNodeCount: selectedSubtreeNodeCount, unselectedCount: selectedSubtreeNodeCount - resolved.size, complete: selectedSubtreeNodeCount === resolved.size };
        const result = { subtreeSelectionCoverage, selectionParentCounts, selectionDepthCounts, selectionDepthRange: succeeded === references.length ? { min: minDepth, max: maxDepth } : null, selectedSubtreeNodeCount, items, errorCounts, succeeded, failed: references.length - succeeded, commonAncestor: commonChain?.length ? commonChain[commonChain.length - 1] : null, sharedParent, siblingOrder, siblingSpan, siblingBlocks, selectionRoots, selectionCoverage };
        if ((args.requireAll || args.requireCompleteSubtrees || args.requireCompleteSiblings || args.requireSameDepth || args.requireContiguous || args.requireInputOrder) && result.failed) throw new ToolError({ code: 'NODE_GROUP_INCOMPLETE', status: 409, message: 'Not every requested node resolved; partial results must not be used as a complete group.', details: result });
        if (args.requireDisjoint && selectionRoots.length !== resolved.size) throw new ToolError({ code: 'NODE_SELECTION_OVERLAP', status: 409, message: 'Resolved selection contains ancestor/descendant overlaps.', details: result });
        if ((args.requireSameParent || args.requireContiguous || args.requireInputOrder) && sharedParent === null) throw new ToolError({ code: 'NODE_PARENT_GROUP_MISMATCH', status: 409, message: 'Resolved targets do not share one observed direct parent in the selected scope.', details: result });
        if (args.requireSameDepth && minDepth !== maxDepth) throw new ToolError({ code: 'NODE_DEPTH_GROUP_MISMATCH', status: 409, message: 'Requested targets do not share one observed scoped depth.', details: result });
        if (args.requireContiguous) {
            const indices = [...resolved.values()].map(target => target.siblingIndex).sort((a, b) => (a ?? -1) - (b ?? -1));
            if (indices.some((value, index) => value === null || index > 0 && value !== indices[index - 1]! + 1)) throw new ToolError({ code: 'NODE_SELECTION_NOT_CONTIGUOUS', status: 409, message: 'Requested siblings do not form one consecutive observed block.', details: result });
        }
        if (args.requireInputOrder && siblingOrder?.some((reference, index) => reference.id !== references[index].id)) throw new ToolError({ code: 'NODE_SELECTION_ORDER_CHANGED', status: 409, message: 'Observed sibling order differs from request order.', details: result });
        if (args.requireCompleteSiblings && selectionParentCounts!.some(group => group.complete !== true)) throw new ToolError({ code: 'NODE_SIBLING_COVERAGE_INCOMPLETE', status: 409, message: 'Not every represented parent has all observed children selected, or parent evidence is unavailable.', details: result });
        if (args.requireCompleteSubtrees && result.selectedSubtreeNodeCount !== resolved.size) throw new ToolError({ code: 'NODE_SUBTREE_COVERAGE_INCOMPLETE', status: 409, message: 'Selection omits descendants of its selected subtree roots.', details: result });
        return result;
    }

    @utcpTool(
        'sceneHierarchyAnalyze',
        'Summarize a bounded scene or subtree hierarchy: depth, active state, component counts, duplicate names and unknown component identities. Read-only; no serialized mutation or runtime inference.',
        {
            type: 'object', additionalProperties: false,
            properties: { rootReference: InstanceReferenceSchema, limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: MAX_LIST_LIMIT } },
        },
        { type: 'object', additionalProperties: false, properties: {
            rootReference: InstanceReferenceSchema, checkedNodes: { type: 'integer' }, maxDepth: { type: 'integer' }, truncated: { type: 'boolean' },
            depthCounts: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 } },
            childCountDistribution: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 } },
            componentCountDistribution: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 } },
            componentNodeCounts: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 } },
            missingNodeUuidCount: { type: 'integer', minimum: 0 },
            duplicateNodeUuids: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { uuid: { type: 'string' }, count: { type: 'integer', minimum: 2 } }, required: ['uuid', 'count'] } },
            leafNodes: { type: 'integer' }, containerNodes: { type: 'integer' }, unknownChildrenNodes: { type: 'integer' },
            nodesWithComponents: { type: 'integer' }, nodesWithoutComponents: { type: 'integer' }, unknownComponentsNodes: { type: 'integer' },
            siblingNameCollisions: { type: 'array', items: { type: 'object', properties: { parentReference: InstanceReferenceSchema, name: { type: 'string' }, references: { type: 'array', items: InstanceReferenceSchema } }, required: ['parentReference', 'name', 'references'] } },
            activeNodes: { type: 'integer' }, inactiveNodes: { type: 'integer' }, unknownActiveNodes: { type: 'integer' }, componentCounts: { type: 'object' }, duplicateNames: { type: 'array' }, unknownComponentCount: { type: 'integer' }, issues: { type: 'array' },
        }, required: ['checkedNodes', 'maxDepth', 'depthCounts', 'childCountDistribution', 'componentCountDistribution', 'componentNodeCounts', 'missingNodeUuidCount', 'duplicateNodeUuids', 'leafNodes', 'containerNodes', 'unknownChildrenNodes', 'nodesWithComponents', 'nodesWithoutComponents', 'unknownComponentsNodes', 'truncated', 'activeNodes', 'inactiveNodes', 'unknownActiveNodes', 'componentCounts', 'duplicateNames', 'siblingNameCollisions', 'unknownComponentCount', 'issues'] },
        'GET', ['scene', 'hierarchy', 'analyze', 'component', 'summary', 'qa']
    )
    async sceneHierarchyAnalyze(args: { rootReference?: IInstanceReference, limit?: number } = {}): Promise<Record<string, unknown>> {
        // Counts describe local active flags in the observed hierarchy, not runtime activation.
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIST_LIMIT)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Invalid analysis limit.' });
        if (args.rootReference !== undefined && (typeof args.rootReference?.id !== 'string' || !args.rootReference.id.trim() || args.rootReference.id.length > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'A bounded root UUID is required.' });
        const tree = await Editor.Message.request('scene', 'query-node-tree') as any;
        if (!tree) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'No open scene or hierarchy.' });
        let root = tree;
        if (args.rootReference?.id) {
            const pending = [tree];
            const visited = new Set<object>();
            let scheduled = 1;
            root = undefined;
            while (pending.length) {
                const node = pending.pop();
                if (!node || typeof node !== 'object' || visited.has(node)) continue;
                visited.add(node);
                if (node.uuid === args.rootReference.id) { root = node; break; }
                const children = node.children ?? [];
                if (!Array.isArray(children)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Malformed hierarchy children.' });
                scheduled += children.length;
                if (scheduled > 10000) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 413, message: 'Subtree lookup exceeds10000 nodes.' });
                for (const child of children) pending.push(child);
            }
            if (!root) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Hierarchy root ${args.rootReference.id} not found.` });
        }
        const limit = boundedListLimit(args.limit);
        const componentCounts: Record<string, number> = Object.create(null);
        const componentNodeCounts: Record<string, number> = Object.create(null);
        const depthCounts: Record<string, number> = Object.create(null);
        const childCountDistribution: Record<string, number> = Object.create(null);
        const componentCountDistribution: Record<string, number> = Object.create(null);
        const nameCounts = new Map<string, number>();
        const uuidCounts = new Map<string, number>();
        let missingNodeUuidCount = 0;
        const issues: string[] = [];
        const visited = new Set<object>();
        const siblingGroups = new Map<object, { parentReference: IInstanceReference, names: Map<string, IInstanceReference[]> }>();
        const stack: Array<{ node: any, depth: number, parent: any | null }> = [{ node: root, depth: 0, parent: null }];
        let checkedNodes = 0, maxDepth = 0, activeNodes = 0, inactiveNodes = 0, unknownComponentCount = 0, truncated = false;
        let unknownActiveNodes = 0, scheduled = 1, componentTotal = 0;
        let leafNodes = 0, containerNodes = 0, unknownChildrenNodes = 0;
        let nodesWithComponents = 0, nodesWithoutComponents = 0, unknownComponentsNodes = 0;
        while (stack.length) {
            if (checkedNodes >= limit) { truncated = true; break; }
            const { node, depth, parent } = stack.pop()!;
            if (!node || typeof node !== 'object' || Array.isArray(node)) { issues.push('invalid node encountered'); continue; }
            if (visited.has(node)) { issues.push(`cycle or repeated node at depth ${depth}`); continue; }
            visited.add(node); checkedNodes++; maxDepth = Math.max(maxDepth, depth);
            depthCounts[depth] = (depthCounts[depth] ?? 0) + 1;
            const name = sceneTreeNodeName(node); nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
            if (typeof node.uuid === 'string' && node.uuid.trim()) uuidCounts.set(node.uuid, (uuidCounts.get(node.uuid) ?? 0) + 1);
            else { missingNodeUuidCount++; issues.push(`node UUID unavailable on ${name}`); }
            if (parent !== null) {
                const parentId = parent.uuid, id = node.uuid;
                const explicitName = typeof node.name === 'string' ? node.name : node.name?.value;
                if (typeof parentId === 'string' && parentId.trim() && typeof id === 'string' && id.trim() && typeof explicitName === 'string') {
                    let group = siblingGroups.get(parent);
                    if (!group) { group = { parentReference: { id: parentId, type: 'cc.Node' }, names: new Map() }; siblingGroups.set(parent, group); }
                    const references = group.names.get(explicitName);
                    const reference = { id, type: 'cc.Node' };
                    if (references) references.push(reference); else group.names.set(explicitName, [reference]);
                } else issues.push('sibling collision identity or name unavailable');
            }
            const rawActive = node.active;
            const active = typeof rawActive === 'boolean' ? rawActive : rawActive?.value;
            if (active === false) inactiveNodes++; else if (active === true) activeNodes++; else unknownActiveNodes++;
            const children = node.children ?? [];
            if (!Array.isArray(children)) unknownChildrenNodes++;
            else if (children.length === 0) leafNodes++;
            else containerNodes++;
            if (Array.isArray(children)) childCountDistribution[children.length] = (childCountDistribution[children.length] ?? 0) + 1;
            const components = node.components ?? [];
            if (!Array.isArray(components)) {
                unknownComponentsNodes++;
                issues.push(`malformed components on ${name}`);
            } else {
                if (components.length) nodesWithComponents++; else nodesWithoutComponents++;
                componentTotal += components.length;
                if (componentTotal > 10000) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 413, message: 'Analysis component budget exceeded.' });
                componentCountDistribution[components.length] = (componentCountDistribution[components.length] ?? 0) + 1;
                const nodeTypes = new Set<string>();
                for (const component of components) {
                    const type = componentClassId(component) ?? componentCandidates(component)[0];
                    if (typeof type !== 'string' || !type.trim()) { unknownComponentCount++; continue; }
                    const normalized = type.replace(/^cc\./, ''); componentCounts[normalized] = (componentCounts[normalized] ?? 0) + 1;
                    if (!nodeTypes.has(normalized)) {
                        nodeTypes.add(normalized);
                        componentNodeCounts[normalized] = (componentNodeCounts[normalized] ?? 0) + 1;
                    }
                }
            }
            if (!Array.isArray(children)) { issues.push(`malformed children on ${name}`); continue; }
            scheduled += children.length;
            if (scheduled > 10000) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 413, message: 'Analysis scheduled-node budget exceeded.' });
            for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index], depth: depth + 1, parent: node });
        }
        const siblingNameCollisions: Array<{ parentReference: IInstanceReference, name: string, references: IInstanceReference[] }> = [];
        for (const group of siblingGroups.values()) for (const [name, references] of group.names) if (references.length > 1) siblingNameCollisions.push({ parentReference: group.parentReference, name, references });
        const duplicateNodeUuids = [...uuidCounts].filter(([, count]) => count > 1).map(([uuid, count]) => ({ uuid, count }));
        for (const { uuid } of duplicateNodeUuids) issues.push(`duplicate node UUID ${uuid}`);
        return { ...(args.rootReference ? { rootReference: args.rootReference } : {}), checkedNodes, maxDepth, depthCounts, childCountDistribution, componentCountDistribution, leafNodes, containerNodes, unknownChildrenNodes, nodesWithComponents, nodesWithoutComponents, unknownComponentsNodes, truncated, activeNodes, inactiveNodes, unknownActiveNodes,
            componentCounts, componentNodeCounts, duplicateNames: [...nameCounts].filter(([, count]) => count > 1).map(([name, count]) => ({ name, count })), siblingNameCollisions, missingNodeUuidCount, duplicateNodeUuids, unknownComponentCount, issues };
    }

    @utcpTool(
        'sceneHierarchyValidate',
        'Validate scene hierarchy identity, unique paths, and parent-child topology within bounded traversal.',
        {
            type: 'object',
            properties: {
                rootReference: InstanceReferenceSchema,
                limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: MAX_LIST_LIMIT }
            }
        },
        {
            type: 'object',
            properties: {
                valid: { type: 'boolean' },
                checkedNodes: { type: 'integer' },
                issues: { type: 'array', items: { type: 'string' } },
                truncated: { type: 'boolean' }
            },
            required: ['valid', 'checkedNodes', 'issues', 'truncated']
        },
        'GET',
        ['scene', 'hierarchy', 'validate', 'parent', 'path', 'integrity']
    )
    async sceneHierarchyValidate(args: { rootReference?: IInstanceReference, limit?: number } = {}): Promise<{ valid: boolean, checkedNodes: number, issues: string[], truncated: boolean }> {
        const tree = await Editor.Message.request('scene', 'query-node-tree') as any;
        if (!tree) throw new Error('sceneHierarchyValidate: no open scene or failed to query scene tree');
        let root = tree;
        if (args.rootReference?.id) {
            const candidates = [tree];
            root = undefined;
            while (candidates.length) {
                const candidate = candidates.pop();
                if (candidate?.uuid === args.rootReference.id) {
                    root = candidate;
                    break;
                }
                if (Array.isArray(candidate?.children)) candidates.push(...candidate.children);
            }
            if (!root) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Hierarchy root ${args.rootReference.id} not found`, recovery: 'Query the current scene tree and retry with an existing node id.' });
        }
        const limit = boundedListLimit(args.limit);
        const issues: string[] = [];
        const seenObjects = new Set<object>();
        const seenUuids = new Map<string, string>();
        const parentByUuid = new Map<string, string>();
        const stack: Array<{ node: any, path: string, parentPath: string }> = [{ node: root, path: root.name || '', parentPath: '' }];
        let checkedNodes = 0;
        let truncated = false;
        while (stack.length) {
            if (checkedNodes >= limit) {
                truncated = true;
                break;
            }
            const current = stack.pop()!;
            const node = current.node;
            if (!node || typeof node !== 'object') {
                issues.push(`invalid node at ${current.path || '(root)'}`);
                continue;
            }
            if (seenObjects.has(node)) {
                issues.push(`cycle or repeated node object at ${current.path || '(root)'}`);
                continue;
            }
            seenObjects.add(node);
            checkedNodes++;
            const path = current.path || '(root)';
            const uuid = typeof node.uuid === 'string' ? node.uuid : '';
            if (!uuid) {
                issues.push(`missing uuid at ${path}`);
            } else {
                const firstPath = seenUuids.get(uuid);
                if (firstPath) {
                    issues.push(`duplicate uuid ${uuid} at ${path}; first seen at ${firstPath}`);
                    const firstParent = parentByUuid.get(uuid);
                    if (firstParent !== undefined && firstParent !== current.parentPath) {
                        issues.push(`invalid parenting for ${uuid}: ${firstParent} and ${current.parentPath || '(root)'}`);
                    }
                } else {
                    seenUuids.set(uuid, path);
                    parentByUuid.set(uuid, current.parentPath);
                }
            }
            const childPaths = new Set<string>();
            const children = Array.isArray(node.children) ? node.children : [];
            for (let index = children.length - 1; index >= 0; index--) {
                const child = children[index];
                const childName = typeof child?.name === 'string' ? child.name : '';
                const childPath = path === '(root)' ? childName || `(child-${index})` : `${path}/${childName || `(child-${index})`}`;
                if (childPaths.has(childPath)) issues.push(`duplicate path ${childPath}`);
                childPaths.add(childPath);
                stack.push({ node: child, path: childPath, parentPath: path });
            }
        }
        return {
            valid: issues.length === 0 && !truncated,
            checkedNodes,
            issues: issues.slice(0, MAX_LIST_LIMIT),
            truncated
        };
    }

    @utcpTool(
        'sceneScriptHealthScan',
        'Scan the open scene or prefab for script components whose class is no longer registered. Read-only; returns node paths and repair candidates.',
        {
            type: 'object',
            properties: {
                limit: { type: 'number', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT }
            }
        },
        {
            type: 'object',
            properties: {
                findings: { type: 'array', items: { type: 'object' } },
                total: { type: 'number' },
                truncated: { type: 'boolean' }
            },
            required: ['findings', 'total', 'truncated']
        },
        'GET',
        ['scene', 'script', 'missing', 'invalid', 'scan', 'health', 'repair']
    )
    async sceneScriptHealthScan(args: { limit?: number } = {}): Promise<{ findings: Array<Record<string, unknown>>, total: number, truncated: boolean }> {
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIST_LIMIT)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `limit must be an integer from 1 to ${MAX_LIST_LIMIT}.` });
        const limit = boundedListLimit(args.limit);
        const tree = await Editor.Message.request('scene', 'query-node-tree');
        if (!tree) throw new Error('sceneScriptHealthScan: no open scene or prefab');
        const componentTypes = await Editor.Message.request('scene', 'query-components');
        const registered = scriptHealthRegisteredClasses(componentTypes);
        const findings: Array<Record<string, unknown>> = [];
        const rootName = typeof tree.name === 'string'
            ? tree.name
            : (tree.name && typeof tree.name.value === 'string' ? tree.name.value : '');
        const stack: Array<{ node: any, path: string }> = [{ node: (await this.findPrefabEditRoot(tree)) ?? tree, path: rootName }];
        const visited = new Set<object>();
        let scheduled = 1;
        let total = 0;
        while (stack.length) {
            const { node, path: nodePath } = stack.pop()!;
            if (!node || typeof node !== 'object' || visited.has(node)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script health hierarchy contains an invalid or repeated node.' });
            visited.add(node);
            const components = node.components ?? node.__comps__ ?? [];
            if (!Array.isArray(components)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script health components must be an array.' });
            for (const component of components) {
                if (!component || typeof component !== 'object' || Array.isArray(component)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script health contains an invalid component entry.' });
                const classId = componentClassId(component);
                const uuid = componentUuid(component);
                if (classId !== undefined && typeof classId !== 'string') throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script health class identity must be a string.' });
                if (!classId || registered.has(classId) || classId.startsWith('cc.')) continue;
                const nodeId = nodeUuidFromSceneUsage(node, 'script health hierarchy');
                total++;
                if (findings.length < limit) findings.push({
                    nodeReference: { id: nodeId, type: 'cc.Node' },
                    nodeName: node.name || '',
                    nodePath,
                    componentReference: uuid ? { id: uuid, type: 'cc.Component' } : undefined,
                    classId,
                    repair: 'Provide scriptReference or replacementClassId to sceneScriptRepair'
                });
            }
            const children = node.children ?? [];
            if (!Array.isArray(children)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script health children must be an array.' });
            scheduled += children.length;
            if (scheduled > VERBOSE_TREE_NODES) throw new ToolError({ code: 'LIMIT_EXCEEDED', status: 413, message: 'Script health hierarchy exceeds the 10000-node traversal budget.' });
            for (let index = children.length - 1; index >= 0; index--) {
                const child = children[index];
                stack.push({ node: child, path: nodePath ? `${nodePath}/${child?.name || ''}` : child?.name || '' });
            }
        }
        return { findings, total, truncated: total > findings.length };
    }

    @utcpTool('sceneScriptHealthBatchScan', 'Scan bounded scene roots for missing custom script classes with per-root outcomes.', { type: 'object', additionalProperties: false, properties: { nodeReferences: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema }, limitPerRoot: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: ['nodeReferences'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated'] }, 'GET', ['scene', 'script', 'health', 'batch', 'scan'])
    async sceneScriptHealthBatchScan(args: { nodeReferences: IInstanceReference[], limitPerRoot?: number }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.nodeReferences) || args.nodeReferences.length < 1 || args.nodeReferences.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nodeReferences must contain 1 to 32 items.' });
        if (args.limitPerRoot !== undefined && (!Number.isInteger(args.limitPerRoot) || args.limitPerRoot < 1 || args.limitPerRoot > MAX_LIST_LIMIT)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `limitPerRoot must be an integer from 1 to ${MAX_LIST_LIMIT}.` });
        const limit = boundedListLimit(args.limitPerRoot);
        const componentTypes = await Editor.Message.request('scene', 'query-components');
        const registered = scriptHealthRegisteredClasses(componentTypes);
        const items: Array<Record<string, unknown>> = [];
        for (const [index, nodeReference] of args.nodeReferences.entries()) {
            try {
                const tree = await Editor.Message.request('scene', 'query-node-tree', nodeReference.id) as any;
                if (!tree) throw new Error(`Node ${nodeReference.id} was not found.`);
                if (nodeUuidFromSceneUsage(tree, 'script health root') !== nodeReference.id) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator returned a different script health root.' });
                const findings: Array<Record<string, unknown>> = [];
                const stack: Array<{ node: any, path: string }> = [{ node: tree, path: typeof tree.name === 'string' ? tree.name : '' }];
                const visited = new Set<object>();
                let scheduled = 1;
                let total = 0;
                while (stack.length) {
                    const { node, path: nodePath } = stack.pop()!;
                    if (!node || typeof node !== 'object' || visited.has(node)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script health hierarchy contains an invalid or repeated node.' });
                    visited.add(node);
                    const components = node.components ?? node.__comps__ ?? [];
                    if (!Array.isArray(components)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script health component inventory must be an array.' });
                    for (const component of components) {
                        if (!component || typeof component !== 'object' || Array.isArray(component)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script health contains an invalid component entry.' });
                        const classId = componentClassId(component);
                        if (classId !== undefined && typeof classId !== 'string') throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script health class identity must be a string.' });
                        if (!classId || classId.startsWith('cc.') || registered.has(classId)) continue;
                        const nodeId = nodeUuidFromSceneUsage(node, 'script health hierarchy');
                        total++;
                        if (findings.length < limit) findings.push({ nodeReference: { id: nodeId, type: 'cc.Node' }, nodePath, componentReference: componentUuid(component) ? { id: componentUuid(component)!, type: 'cc.Component' } : null, classId });
                    }
                    const children = node.children ?? [];
                    if (!Array.isArray(children)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script health children must be an array.' });
                    scheduled += children.length;
                    if (scheduled > VERBOSE_TREE_NODES) throw new ToolError({ code: 'LIMIT_EXCEEDED', status: 413, message: 'Script health hierarchy exceeds the 10000-node traversal budget.' });
                    for (let childIndex = children.length - 1; childIndex >= 0; childIndex--) {
                        const child = children[childIndex];
                        stack.push({ node: child, path: nodePath ? `${nodePath}/${child?.name || ''}` : child?.name || '' });
                    }
                }
                items.push({ index, ok: true, nodeReference, findings, total, truncated: total > findings.length });
            } catch (error) {
                items.push({ index, ok: false, nodeReference, error: { code: error instanceof ToolError ? error.code : 'SCRIPT_HEALTH_QUERY_FAILED', message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        return { items, succeeded, failed: items.length - succeeded, truncated: items.some((item) => item.truncated === true) };
    }

    @utcpTool('sceneScriptUsageInspect', 'Inspect bounded script component usage across the open scene with optional class filtering.', { type: 'object', additionalProperties: false, properties: { classId: { type: 'string', maxLength: 256 }, limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: [] }, { type: 'object', additionalProperties: false, properties: { usages: { type: 'array' }, total: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['usages', 'total', 'truncated'] }, 'GET', ['scene', 'script', 'usage', 'inspect'])
    async sceneScriptUsageInspect(args: { classId?: string, limit?: number } = {}): Promise<Record<string, unknown>> {
        return this.collectScriptUsage(args);
    }

    private async collectScriptUsage(args: { classId?: string, limit?: number }, visit?: (row: Record<string, unknown>) => void): Promise<{ usages: Array<Record<string, unknown>>, total: number, truncated: boolean }> {
        if (args.classId !== undefined && (typeof args.classId !== 'string' || !args.classId || args.classId.length > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'classId must be a bounded non-empty string.' });
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIST_LIMIT)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `limit must be an integer from 1 to ${MAX_LIST_LIMIT}.` });
        const limit = boundedListLimit(args.limit);
        const tree = await Editor.Message.request('scene', 'query-node-tree');
        if (!tree) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: 'No open scene or prefab hierarchy.' });
        const usages: Array<Record<string, unknown>> = [];
        const stack: Array<{ node: any, path: string }> = [{ node: tree, path: typeof tree.name === 'string' ? tree.name : '' }];
        const visited = new Set<object>();
        let scheduled = 1;
        let total = 0;
        while (stack.length) {
            const { node, path: nodePath } = stack.pop()!;
            if (!node || typeof node !== 'object' || visited.has(node)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script usage hierarchy contains an invalid or repeated node.' });
            visited.add(node);
            const components = node.components ?? node.__comps__ ?? [];
            if (!Array.isArray(components)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script usage components must be an array.' });
            for (const component of components) {
                if (!component || typeof component !== 'object' || Array.isArray(component)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script usage contains an invalid component entry.' });
                const classId = componentClassId(component);
                const componentId = componentUuid(component);
                if (classId !== undefined && typeof classId !== 'string') throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script usage component class identity must be a string.' });
                if (!classId || classId.startsWith('cc.') || (args.classId && classId !== args.classId)) continue;
                const nodeId = nodeUuidFromSceneUsage(node, 'script usage hierarchy');
                total++;
                const row = { nodeReference: { id: nodeId, type: 'cc.Node' }, nodePath, componentReference: componentId ? { id: componentId, type: classId } : null, classId };
                if (visit) visit(row);
                else if (usages.length < limit) usages.push(row);
            }
            const children = node.children ?? [];
            if (!Array.isArray(children)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script usage hierarchy children must be an array.' });
            scheduled += children.length;
            if (scheduled > VERBOSE_TREE_NODES) throw new ToolError({ code: 'LIMIT_EXCEEDED', status: 413, message: 'Script usage hierarchy exceeds the 10000-node traversal budget.' });
            for (let index = children.length - 1; index >= 0; index--) {
                const child = children[index];
                stack.push({ node: child, path: nodePath ? `${nodePath}/${child?.name || ''}` : child?.name || '' });
            }
        }
        return { usages, total, truncated: total > usages.length };
    }

    @utcpTool('scriptAssetSceneUsageInspect', 'Resolve an imported script class and inspect its bounded usage across the open scene.', { type: 'object', additionalProperties: false, properties: { scriptReference: InstanceReferenceSchema, limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: ['scriptReference'] }, { type: 'object', additionalProperties: false, properties: { scriptReference: InstanceReferenceSchema, classId: { type: 'string' }, usages: { type: 'array' }, total: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['scriptReference', 'classId', 'usages', 'total', 'truncated'] }, 'GET', ['scene', 'script', 'asset', 'usage', 'inspect'])
    async scriptAssetSceneUsageInspect(args: { scriptReference: IInstanceReference, limit?: number }): Promise<Record<string, unknown>> {
        const scriptId = args.scriptReference?.id;
        if (typeof scriptId !== 'string' || !scriptId.trim() || scriptId.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'scriptReference.id must be a bounded non-empty string.' });
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIST_LIMIT)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `limit must be an integer from 1 to ${MAX_LIST_LIMIT}.` });
        const asset = await assetInfoForSceneUsage(scriptId);
        if (asset.isDirectory === true || !['typescript', 'javascript'].includes(String(asset.importer ?? ''))) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'Script usage lookup requires an imported TypeScript or JavaScript asset.' });
        let classId: unknown;
        try { classId = await Editor.Message.request('scene', 'query-script-cid', scriptId); }
        catch { throw new ToolError({ code: 'SCRIPT_METADATA_QUERY_FAILED', status: 502, message: 'Creator could not query the script class identity.' }); }
        if (typeof classId !== 'string' || !classId) throw new ToolError({ code: 'SCRIPT_METADATA_UNAVAILABLE', status: 422, message: `Creator did not expose a class ID for script ${scriptId}.` });
        const usage = await this.sceneScriptUsageInspect({ classId, limit: args.limit });
        const current = await assetInfoForSceneUsage(scriptId);
        let currentClassId: unknown;
        try { currentClassId = await Editor.Message.request('scene', 'query-script-cid', scriptId); }
        catch { throw new ToolError({ code: 'SCRIPT_METADATA_QUERY_FAILED', status: 502, message: 'Creator could not recheck the script class identity.' }); }
        if (currentClassId !== classId || current.url !== asset.url || current.file !== asset.file || current.importer !== asset.importer || current.type !== asset.type || current.isDirectory !== asset.isDirectory) throw new ToolError({ code: 'SCRIPT_ASSET_CHANGED', status: 409, message: 'Script asset identity or class binding changed during usage inspection; no mixed result returned.' });
        return { scriptReference: { id: scriptId, type: typeof asset.type === 'string' && asset.type ? asset.type : 'cc.Script' }, classId, usages: usage.usages, total: usage.total, truncated: usage.truncated };
    }
    @utcpTool('scriptAssetSceneUsageBatchInspect', 'Inspect bounded scene usage for multiple imported script assets with per-script errors.', { type: 'object', additionalProperties: false, properties: { scriptReferences: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema }, limitPerScript: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: ['scriptReferences'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' }, partial: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated', 'partial'] }, 'GET', ['scene', 'script', 'asset', 'usage', 'batch', 'inspect'])
    async scriptAssetSceneUsageBatchInspect(args: { scriptReferences: IInstanceReference[], limitPerScript?: number }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.scriptReferences) || args.scriptReferences.length < 1 || args.scriptReferences.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'scriptReferences must contain 1 to 32 items.' });
        if (args.limitPerScript !== undefined && (!Number.isInteger(args.limitPerScript) || args.limitPerScript < 1 || args.limitPerScript > MAX_LIST_LIMIT)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `limitPerScript must be an integer from 1 to ${MAX_LIST_LIMIT}.` });
        const limit = boundedListLimit(args.limitPerScript);
        const items: Array<Record<string, unknown>> = [];
        for (const [index, scriptReference] of args.scriptReferences.entries()) {
            try {
                items.push({ index, ok: true, scriptReference, result: await this.scriptAssetSceneUsageInspect({ scriptReference, limit }) });
            } catch (error) {
                items.push({ index, ok: false, scriptReference, error: { code: error instanceof ToolError ? error.code : 'SCRIPT_USAGE_INSPECTION_FAILED', message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512), recovery: error instanceof ToolError ? error.recovery?.slice(0, 512) : undefined } });
            }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        const truncated = items.some((item) => item.ok === true && (item.result as Record<string, unknown>)?.truncated === true);
        return { items, succeeded, failed: items.length - succeeded, truncated, partial: succeeded > 0 && succeeded < items.length };
    }


    @utcpTool('sceneScriptUsageSummary', 'Count custom script classes across the complete bounded hierarchy, independently of returned node-detail limits. Refuses traversal/class budget overflow; counts describe observed hierarchy, not an atomic scene snapshot.', { type: 'object', additionalProperties: false, properties: { maxClasses: { type: 'integer', minimum: 1, maximum: 256, default: 64 }, maxNodesPerClass: { type: 'integer', minimum: 1, maximum: 256, default: 32 } }, required: [] }, { type: 'object', additionalProperties: false, properties: { classes: { type: 'array' }, totalClasses: { type: 'integer' }, totalUsages: { type: 'integer' }, countsComplete: { type: 'boolean', const: true }, truncated: { type: 'boolean' } }, required: ['classes', 'totalClasses', 'totalUsages', 'countsComplete', 'truncated'] }, 'GET', ['scene', 'script', 'usage', 'summary'])
    async sceneScriptUsageSummary(args: { maxClasses?: number, maxNodesPerClass?: number } = {}): Promise<Record<string, unknown>> {
        const maxClasses = args.maxClasses ?? 64;
        const maxNodesPerClass = args.maxNodesPerClass ?? 32;
        if (!Number.isInteger(maxClasses) || maxClasses < 1 || maxClasses > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxClasses must be an integer from 1 to 256.' });
        if (!Number.isInteger(maxNodesPerClass) || maxNodesPerClass < 1 || maxNodesPerClass > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxNodesPerClass must be an integer from 1 to 256.' });
        const groups = new Map<string, { count: number; nodes: Array<Record<string, unknown>> }>();
        const usage = await this.collectScriptUsage({}, row => {
            const classId = row.classId as string;
            let group = groups.get(classId);
            if (!group) {
                if (groups.size >= 4096) throw new ToolError({ code: 'LIMIT_EXCEEDED', status: 413, message: 'Script summary exceeds the 4096-class aggregation budget.' });
                group = { count: 0, nodes: [] };
                groups.set(classId, group);
            }
            group.count++;
            if (group.nodes.length < maxNodesPerClass) group.nodes.push({ nodeReference: row.nodeReference, nodePath: row.nodePath, componentReference: row.componentReference });
        });
        const all = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
        const classes = all.slice(0, maxClasses).map(([classId, group]) => ({ classId, count: group.count, nodes: group.nodes, truncated: group.count > group.nodes.length }));
        return { classes, totalClasses: all.length, totalUsages: usage.total, countsComplete: true, truncated: all.length > classes.length || classes.some(entry => entry.truncated) };
    }

    @utcpTool('sceneScriptComponentInspect', 'Inspect one custom scene script component with class identity and authoritative serialized dump.', { type: 'object', additionalProperties: false, properties: { componentReference: InstanceReferenceSchema }, required: ['componentReference'] }, { type: 'object', additionalProperties: false, properties: { componentReference: InstanceReferenceSchema, classId: { type: 'string' }, dump: { type: 'object' } }, required: ['componentReference', 'classId', 'dump'] }, 'GET', ['scene', 'script', 'component', 'inspect'])
    async sceneScriptComponentInspect(args: { componentReference: IInstanceReference }): Promise<Record<string, unknown>> {
        const componentId = args.componentReference?.id;
        if (!componentId) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'sceneScriptComponentInspect requires componentReference.id.' });
        const dump = await Editor.Message.request('scene', 'query-component', componentId) as any;
        if (!dump || typeof dump !== 'object') throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Script component ${componentId} was not found.` });
        if (Array.isArray(dump) || componentUuid(dump) !== componentId) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator returned mismatched or missing script component identity.' });
        const classId = componentClassId(dump);
        if (!classId || classId.startsWith('cc.')) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Component ${componentId} is not a custom script component.` });
        return { componentReference: { id: componentId, type: classId }, classId, dump };
    }

    @utcpTool('sceneScriptComponentBatchInspect', 'Inspect a bounded batch of custom scene script components with per-item errors.', { type: 'object', additionalProperties: false, properties: { componentReferences: { type: 'array', minItems: 1, maxItems: 64, items: InstanceReferenceSchema } }, required: ['componentReferences'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated'] }, 'GET', ['scene', 'script', 'component', 'batch', 'inspect'])
    async sceneScriptComponentBatchInspect(args: { componentReferences: IInstanceReference[] }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.componentReferences) || args.componentReferences.length < 1 || args.componentReferences.length > 64) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'componentReferences must contain 1 to 64 items.' });
        const items: Array<Record<string, unknown>> = [];
        for (const [index, componentReference] of args.componentReferences.entries()) {
            try {
                items.push({ index, ok: true, result: await this.sceneScriptComponentInspect({ componentReference }) });
            } catch (error) {
                items.push({ index, ok: false, componentReference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        return { items, succeeded, failed: items.length - succeeded, truncated: false };
    }

    @utcpTool(
        'sceneScriptRepair',
        'Replace one missing or invalid script component after verifying the target and replacement class. Uses editor undo snapshot and verifies the new component.',
        {
            type: 'object',
            properties: {
                nodeReference: InstanceReferenceSchema,
                componentReference: InstanceReferenceSchema,
                expectedClassId: { type: 'string' },
                replacementClassId: { type: 'string' },
                scriptReference: InstanceReferenceSchema
            },
            required: ['nodeReference'],
            anyOf: [
                { required: ['componentReference'] },
                { required: ['expectedClassId'] }
            ],
            oneOf: [
                { required: ['replacementClassId'] },
                { required: ['scriptReference'] }
            ]
        },
        {
            type: 'object',
            properties: { success: { type: 'boolean' }, removedComponent: { type: 'string' }, createdComponent: InstanceReferenceSchema },
            required: ['success', 'createdComponent']
        },
        'POST',
        ['scene', 'script', 'missing', 'invalid', 'repair', 'replace', 'component']
    )
    async sceneScriptRepair(args: { nodeReference: IInstanceReference, componentReference?: IInstanceReference, expectedClassId?: string, replacementClassId?: string, scriptReference?: IInstanceReference }): Promise<{ success: boolean, removedComponent?: string, createdComponent: IInstanceReference }> {
        const nodeUuid = args.nodeReference?.id;
        if (!nodeUuid) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'sceneScriptRepair requires nodeReference.id' });
        const node = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
        if (!node) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Scene node ${nodeUuid} was not found.` });
        if (!Array.isArray(node.__comps__)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator did not return a complete component inventory for repair preflight.' });
        const components = node.__comps__;
        const targets = components.filter((component: unknown) => args.componentReference?.id ? componentUuid(component) === args.componentReference.id : args.expectedClassId && componentClassId(component) === args.expectedClassId);
        if (targets.length > 1) throw new ToolError({ code: 'SCRIPT_TARGET_AMBIGUOUS', status: 409, message: 'Repair selector matches multiple components; provide an exact component UUID.' });
        const target = targets[0];
        const oldUuid = componentUuid(target);
        if (!target || !oldUuid) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'sceneScriptRepair target component was not found.' });
        const originalClass = componentClassId(target);
        if (args.expectedClassId !== undefined && originalClass !== args.expectedClassId) throw new ToolError({ code: 'SCRIPT_TARGET_CHANGED', status: 409, message: 'Repair component no longer matches expectedClassId.' });
        const replacement = args.scriptReference?.id ? await Editor.Message.request('scene', 'query-script-cid', args.scriptReference.id) : args.replacementClassId;
        if (typeof replacement !== 'string' || !replacement) throw new ToolError({ code: 'SCRIPT_METADATA_UNAVAILABLE', status: 422, message: 'Replacement script class is missing or invalid.' });
        const available = await Editor.Message.request('scene', 'query-components');
        if (!Array.isArray(available) || !findComponentType(available, replacement)) throw new ToolError({ code: 'SCRIPT_NOT_REGISTERED', status: 422, message: `Replacement class '${replacement}' is not registered in Creator.` });
        const fresh = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
        const freshTargets = Array.isArray(fresh?.__comps__) ? fresh.__comps__.filter((component: unknown) => componentUuid(component) === oldUuid) : [];
        if (freshTargets.length !== 1 || componentClassId(freshTargets[0]) !== originalClass) throw new ToolError({ code: 'SCRIPT_TARGET_CHANGED', status: 409, message: 'Repair target identity changed during preflight; no removal was dispatched.' });
        let createdUuid: string | undefined;
        let phase: 'remove-dispatch' | 'remove-readback' | 'create-dispatch' | 'create-readback' | 'snapshot' = 'remove-dispatch';
        let removalConfirmed = false;
        try {
            await Editor.Message.request('scene', 'remove-component', { uuid: oldUuid });
            phase = 'remove-readback';
            const removed = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
            if (!removed || !Array.isArray(removed.__comps__) || removed.__comps__.some((component: unknown) => componentUuid(component) === oldUuid)) throw new ToolError({ code: 'SCRIPT_REPAIR_UNCONFIRMED', status: 502, message: 'Original component removal was not confirmed; replacement was not dispatched.' });
            const priorIds = new Set(removed.__comps__.map((component: unknown) => componentUuid(component)));
            removalConfirmed = true;
            phase = 'create-dispatch';
            await Editor.Message.request('scene', 'create-component', { uuid: nodeUuid, component: replacement });
            phase = 'create-readback';
            const after = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
            if (!after || !Array.isArray(after.__comps__) || after.__comps__.some((component: unknown) => componentUuid(component) === oldUuid)) throw new ToolError({ code: 'SCRIPT_REPAIR_UNCONFIRMED', status: 502, message: 'Repair component inventory is incomplete or original component is present.' });
            const candidates = after.__comps__.filter((component: unknown) => componentClassId(component) === replacement && componentUuid(component) && !priorIds.has(componentUuid(component)));
            if (candidates.length !== 1) throw new ToolError({ code: 'SCRIPT_REPAIR_UNCONFIRMED', status: 502, message: 'Creator did not expose exactly one new replacement component.' });
            createdUuid = componentUuid(candidates[0]);
            if (!createdUuid) throw new ToolError({ code: 'SCRIPT_REPAIR_UNCONFIRMED', status: 502, message: 'Replacement component identity is unavailable.' });
            phase = 'snapshot';
            await Editor.Message.request('scene', 'snapshot');
            return { success: true, removedComponent: oldUuid, createdComponent: { id: createdUuid, type: replacement } };
        } catch (error) {
            throw new ToolError({ code: phase === 'remove-dispatch' || phase === 'create-dispatch' ? 'SCRIPT_REPAIR_OUTCOME_UNKNOWN' : 'SCRIPT_REPAIR_PARTIAL', status: 502, message: 'Script repair did not complete; inspect the node before retrying.', details: { nodeUuid, targetComponent: oldUuid, removedComponent: removalConfirmed ? oldUuid : null, removalConfirmed, phase, replacement, createdComponent: createdUuid ?? null, retrySafe: false, cause: error instanceof Error ? error.message : String(error) }, recovery: 'Inspect current components; do not blindly repeat remove/create after an ambiguous mutation.' });
        }
    }
    @utcpTool('sceneScriptRepairBatch', 'Repair bounded missing script components with per-item replacement verification.', { type: 'object', additionalProperties: false, properties: { items: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, componentReference: InstanceReferenceSchema, expectedClassId: { type: 'string', maxLength: 256 }, replacementClassId: { type: 'string', maxLength: 256 }, scriptReference: InstanceReferenceSchema }, required: ['nodeReference'] } } }, required: ['items'] }, { type: 'object', additionalProperties: false, properties: { outcomes: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, partial: { type: 'boolean' } }, required: ['outcomes', 'succeeded', 'failed', 'partial'] }, 'POST', ['scene', 'script', 'batch', 'repair'])
    async sceneScriptRepairBatch(args: { items: Array<{ nodeReference: IInstanceReference, componentReference?: IInstanceReference, expectedClassId?: string, replacementClassId?: string, scriptReference?: IInstanceReference }> }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.items) || args.items.length < 1 || args.items.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'items must contain 1 to 32 repair requests.' });
        const outcomes: Array<Record<string, unknown>> = [];
        for (const [index, item] of args.items.entries()) {
            try { outcomes.push({ index, ok: true, result: await this.sceneScriptRepair(item) }); }
            catch (error) { outcomes.push({ index, ok: false, nodeReference: item?.nodeReference, error: { code: error instanceof ToolError ? error.code : 'SCRIPT_REPAIR_FAILED', message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512), recovery: error instanceof ToolError ? error.recovery?.slice(0, 512) : undefined, retrySafe: false } }); }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, partial: succeeded > 0 && succeeded < outcomes.length };
    }
    @utcpTool(
        'sceneScriptAttach',
        'Attach one registered project script to a scene node with typed preflight and authoritative read-back.',
        { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, scriptReference: InstanceReferenceSchema }, required: ['nodeReference', 'scriptReference'] },
        { type: 'object', additionalProperties: false, properties: { success: { type: 'boolean', const: true }, nodeReference: InstanceReferenceSchema, scriptReference: InstanceReferenceSchema, componentReference: InstanceReferenceSchema }, required: ['success', 'nodeReference', 'scriptReference', 'componentReference'] },
        'POST', ['scene', 'script', 'attach', 'component']
    )
    async sceneScriptAttach(args: { nodeReference: IInstanceReference, scriptReference: IInstanceReference }): Promise<{ success: true, nodeReference: IInstanceReference, scriptReference: IInstanceReference, componentReference: IInstanceReference }> {
        const nodeUuid = args.nodeReference?.id;
        const scriptUuid = args.scriptReference?.id;
        if (!nodeUuid || !scriptUuid) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'sceneScriptAttach requires nodeReference.id and scriptReference.id.' });
        const node = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
        if (!node) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Scene node ${nodeUuid} was not found.` });
        const classId = await Editor.Message.request('scene', 'query-script-cid', scriptUuid);
        if (typeof classId !== 'string' || !classId) throw new ToolError({ code: 'SCRIPT_METADATA_UNAVAILABLE', status: 422, message: `Creator did not expose a class ID for script ${scriptUuid}.` });
        const available = await Editor.Message.request('scene', 'query-components');
        if (!Array.isArray(available) || !findComponentType(available, classId)) throw new ToolError({ code: 'SCRIPT_NOT_REGISTERED', status: 422, message: `Script class '${classId}' is not registered in Creator.` });
        if ((node.__comps__ || []).some((component: unknown) => componentClassId(component) === classId)) throw new ToolError({ code: 'SCRIPT_ALREADY_ATTACHED', status: 409, message: `Script class '${classId}' is already attached to node ${nodeUuid}.` });
        const existingIds = new Set((node.__comps__ || []).map((component: unknown) => componentUuid(component)));
        let createdUuid: string | undefined;
        try {
            await Editor.Message.request('scene', 'create-component', { uuid: nodeUuid, component: classId });
            const after = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
            const candidates = (after?.__comps__ || []).filter((component: unknown) => componentClassId(component) === classId);
            const created = candidates.length === 1 ? candidates[0] : undefined;
            createdUuid = componentUuid(created);
            if (createdUuid && existingIds.has(createdUuid)) createdUuid = undefined;
            if (!created || !createdUuid) throw new ToolError({ code: 'SCRIPT_ATTACH_UNCONFIRMED', status: 502, message: `Creator did not return the attached script component for node ${nodeUuid}.` });
            await Editor.Message.request('scene', 'snapshot');
            return { success: true, nodeReference: { id: nodeUuid, type: args.nodeReference.type ?? 'cc.Node' }, scriptReference: { id: scriptUuid, type: args.scriptReference.type ?? 'cc.Script' }, componentReference: { id: createdUuid, type: classId } };
        } catch (error) {
            if (!createdUuid) throw new ToolError({ code: 'SCRIPT_ATTACH_OUTCOME_UNKNOWN', status: 502, message: 'Script attachment was dispatched but its component identity was not confirmed; no cleanup was attempted.', details: { nodeUuid, scriptUuid, classId, retrySafe: false, restored: null }, recovery: 'Inspect current node components before another attachment; never replay the create blindly.' });
            let rollbackFailure: string | undefined;
            if (createdUuid) {
                try {
                    const current = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
                    if (!current || !Array.isArray(current.__comps__) || current.__comps__.filter((component: unknown) => componentUuid(component) === createdUuid && componentClassId(component) === classId).length !== 1) throw new Error('Owned component identity changed before cleanup.');
                    await Editor.Message.request('scene', 'remove-component', { uuid: createdUuid });
                    const rollbackNode = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
                    if (!rollbackNode || !Array.isArray(rollbackNode.__comps__) || rollbackNode.__comps__.some((component: unknown) => componentUuid(component) === createdUuid)) rollbackFailure = `Created component ${createdUuid} absence was not confirmed.`;
                } catch (rollbackError) { rollbackFailure = rollbackError instanceof Error ? rollbackError.message : String(rollbackError); }
            }
            throw new ToolError({ code: rollbackFailure ? 'ROLLBACK_FAILED' : (error instanceof ToolError ? error.code : 'SCRIPT_ATTACH_FAILED'), status: 502, message: rollbackFailure ? `Script attachment failed and cleanup could not be verified.` : `Script attachment failed; owned component cleanup was verified.`, details: { nodeUuid, scriptUuid, classId, createdUuid: createdUuid ?? null, rollbackFailure, cause: error instanceof Error ? error.message : String(error) }, recovery: rollbackFailure ? 'Inspect the node and remove the owned component manually before retrying.' : 'Rescan the node before retrying; no ambiguous component remains.' });
        }
    }
    @utcpTool('sceneScriptBatchAttach', 'Attach one registered script to a bounded set of scene nodes with per-item read-back outcomes.', { type: 'object', additionalProperties: false, properties: { nodeReferences: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema }, scriptReference: InstanceReferenceSchema }, required: ['nodeReferences', 'scriptReference'] }, { type: 'object', additionalProperties: false, properties: { outcomes: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, partial: { type: 'boolean' } }, required: ['outcomes', 'succeeded', 'failed', 'partial'] }, 'POST', ['scene', 'script', 'batch', 'attach'])
    async sceneScriptBatchAttach(args: { nodeReferences: IInstanceReference[], scriptReference: IInstanceReference }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.nodeReferences) || args.nodeReferences.length < 1 || args.nodeReferences.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nodeReferences must contain 1 to 32 items.' });
        if (!args.scriptReference?.id) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'scriptReference.id is required.' });
        const outcomes: Array<Record<string, unknown>> = [];
        for (const [index, nodeReference] of args.nodeReferences.entries()) {
            try {
                outcomes.push({ index, ok: true, result: await this.sceneScriptAttach({ nodeReference, scriptReference: args.scriptReference }) });
            } catch (error) {
                outcomes.push({ index, ok: false, nodeReference, error: { code: error instanceof ToolError ? error.code : 'SCRIPT_ATTACH_FAILED', message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512), recovery: error instanceof ToolError ? error.recovery?.slice(0, 512) : undefined, retrySafe: false } });
            }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, partial: succeeded > 0 && succeeded < outcomes.length };
    }

    @utcpTool('sceneScriptDetach', 'Detach one script component from a scene node with preflight, absence read-back, and undo snapshot.', { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, componentReference: InstanceReferenceSchema, scriptClassId: { type: 'string' } }, required: ['nodeReference'], anyOf: [{ required: ['componentReference'] }, { required: ['scriptClassId'] }] }, { type: 'object', additionalProperties: false, properties: { success: { type: 'boolean', const: true }, nodeReference: InstanceReferenceSchema, removedComponent: InstanceReferenceSchema }, required: ['success', 'nodeReference', 'removedComponent'] }, 'POST', ['scene', 'script', 'detach', 'component'])
    async sceneScriptDetach(args: { nodeReference: IInstanceReference, componentReference?: IInstanceReference, scriptClassId?: string }): Promise<{ success: true, nodeReference: IInstanceReference, removedComponent: IInstanceReference }> {
        const nodeId = args.nodeReference?.id;
        if (!nodeId) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'sceneScriptDetach requires nodeReference.id.' });
        const node = await Editor.Message.request('scene', 'query-node', nodeId) as any;
        if (!node) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Scene node ${nodeId} was not found.` });
        if (!Array.isArray(node.__comps__)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator did not return a complete component inventory for detach preflight.' });
        const targets = node.__comps__.filter((component: unknown) => {
            const uuid = componentUuid(component);
            const classId = componentClassId(component);
            return (args.componentReference?.id && uuid === args.componentReference.id) || (!args.componentReference?.id && args.scriptClassId && classId === args.scriptClassId);
        });
        if (targets.length > 1) throw new ToolError({ code: 'SCRIPT_TARGET_AMBIGUOUS', status: 409, message: 'Detach selector matches multiple components; provide an exact component UUID.' });
        const target = targets[0];
        const componentId = componentUuid(target);
        const classId = componentClassId(target);
        if (!target || !componentId || !classId) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Script component was not found on node ${nodeId}.` });
        if (args.scriptClassId !== undefined && args.scriptClassId !== classId) throw new ToolError({ code: 'SCRIPT_TARGET_CHANGED', status: 409, message: 'Detach target no longer matches scriptClassId.' });
        const fresh = await Editor.Message.request('scene', 'query-node', nodeId) as any;
        const freshTargets = Array.isArray(fresh?.__comps__) ? fresh.__comps__.filter((component: unknown) => componentUuid(component) === componentId) : [];
        if (freshTargets.length !== 1 || componentClassId(freshTargets[0]) !== classId) throw new ToolError({ code: 'SCRIPT_TARGET_CHANGED', status: 409, message: 'Detach target identity changed during preflight; no removal was dispatched.' });
        await Editor.Message.request('scene', 'remove-component', { uuid: componentId });
        const after = await Editor.Message.request('scene', 'query-node', nodeId) as any;
        if (!after || !Array.isArray(after.__comps__) || after.__comps__.some((component: unknown) => componentUuid(component) === componentId)) throw new ToolError({ code: 'SCRIPT_DETACH_UNCONFIRMED', status: 502, message: `Creator did not confirm removal of script component ${componentId}.`, details: { nodeId, componentId, retrySafe: false }, recovery: 'Inspect the node before another removal; missing or malformed node data is not component absence proof.' });
        await Editor.Message.request('scene', 'snapshot');
        return { success: true, nodeReference: { id: nodeId, type: args.nodeReference.type ?? 'cc.Node' }, removedComponent: { id: componentId, type: classId } };
    }
    @utcpTool('sceneScriptBatchDetach', 'Detach bounded script components from scene nodes with per-item absence read-back outcomes.', { type: 'object', additionalProperties: false, properties: { items: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, componentReference: InstanceReferenceSchema, scriptClassId: { type: 'string', maxLength: 256 } }, required: ['nodeReference'], anyOf: [{ required: ['componentReference'] }, { required: ['scriptClassId'] }] } } }, required: ['items'] }, { type: 'object', additionalProperties: false, properties: { outcomes: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, partial: { type: 'boolean' } }, required: ['outcomes', 'succeeded', 'failed', 'partial'] }, 'POST', ['scene', 'script', 'batch', 'detach'])
    async sceneScriptBatchDetach(args: { items: Array<{ nodeReference: IInstanceReference, componentReference?: IInstanceReference, scriptClassId?: string }> }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.items) || args.items.length < 1 || args.items.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'items must contain 1 to 32 detach requests.' });
        const outcomes: Array<Record<string, unknown>> = [];
        for (const [index, item] of args.items.entries()) {
            try {
                outcomes.push({ index, ok: true, result: await this.sceneScriptDetach(item) });
            } catch (error) {
                outcomes.push({ index, ok: false, nodeReference: item?.nodeReference, error: { code: error instanceof ToolError ? error.code : 'SCRIPT_DETACH_FAILED', message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512), recovery: error instanceof ToolError ? error.recovery?.slice(0, 512) : undefined, retrySafe: false } });
            }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, partial: succeeded > 0 && succeeded < outcomes.length };
    }



    @utcpTool(
        'nodeReset',
        'Reset node or component properties to defaults. Operations: "node" (all), "component" (one component), "property" (one field by path).',
        {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['node', 'component', 'property'] },
                references: { type: 'array', items: InstanceReferenceSchema, description: 'For node/component: node/component uuids. For property: exactly one node-or-component uuid.' },
                propertyPath: { type: 'string', description: 'For property only: inspector path (e.g. "position", "__comps__.0.type").' }
            },
            required: ['operation', 'references']
        },
        SuccessIndicatorSchema, "POST", ['scene', 'node', 'component', 'reset', 'default', 'revert', 'property']
    )
    async nodeReset(args: { operation: string, references: IInstanceReference[], propertyPath?: string }): Promise<ISuccessIndicator> {
        const uuids = (args.references || []).map((r: IInstanceReference) => r.id).filter((id: string) => !!id);
        if (uuids.length === 0) {
            throw new Error('nodeReset requires non-empty references');
        }

        if (args.operation === 'property') {
            if (uuids.length !== 1) {
                throw new Error('nodeReset operation "property" requires exactly one uuid');
            }
            if (!args.propertyPath || !args.propertyPath.trim()) {
                throw new Error('nodeReset operation "property" requires propertyPath');
            }
            // Typed facade reuses SetPropertyOptions (which marks `dump` required), but
            // reset-property ignores dump: only uuid + path matter. Cast to satisfy tsc.
            const ok = await Editor.Message.request('scene', 'reset-property', { uuid: uuids[0], path: args.propertyPath } as any);
            if (!ok) {
                throw new Error(`Failed to reset property ${args.propertyPath} on ${uuids[0]}`);
            }
        } else if (args.operation === 'node') {
            const ok = await Editor.Message.request('scene', 'reset-node', { uuid: uuids.length === 1 ? uuids[0] : uuids });
            if (!ok) {
                throw new Error(`Failed to reset nodes ${uuids.join(', ')}`);
            }
        } else if (args.operation === 'component') {
            if (uuids.length !== 1) {
                throw new Error('nodeReset operation "component" requires exactly one component uuid');
            }
            await Editor.Message.request('scene', 'reset-component', { uuid: uuids[0] });
        } else {
            throw new Error(`Unknown reset operation: ${args.operation}`);
        }

        await Editor.Message.request('scene', 'snapshot');
        return { success: true };
    }

    @utcpTool(
        'callComponentMethod',
        'Call a method on a component by uuid. Args and return must be JSON-serializable. Get uuid via nodeComponentsGet.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                methodName: { type: 'string', description: 'Name of the method to call' },
                methodArgs: { type: 'array', items: {}, description: 'Arguments to pass to the method (JSON-serializable)' }
            },
            required: ['reference', 'methodName']
        },
        { type: 'object', properties: { result: {} } }, "POST", ['scene', 'component', 'call', 'execute', 'method', 'invoke', 'script']
    )
    async callComponentMethod(args: { reference: IInstanceReference, methodName: string, methodArgs?: any[] }): Promise<{ result: any }> {
        if (!args.reference || !args.reference.id) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'callComponentMethod requires reference.id (component uuid)' });
        }
        if (typeof args.methodName !== 'string' || !ALLOWED_COMPONENT_METHODS[args.methodName]) {
            throw new ToolError({ code: 'METHOD_NOT_ALLOWED', status: 422, message: `Component method '${String(args.methodName)}' is not in the bounded allowlist.` });
        }
        const methodArgs = args.methodArgs ?? [];
        if (!Array.isArray(methodArgs) || methodArgs.length > MAX_COMPONENT_METHOD_ARGS) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `methodArgs must contain at most ${MAX_COMPONENT_METHOD_ARGS} JSON values.` });
        }
        let encodedArgs: string;
        try { encodedArgs = JSON.stringify(methodArgs); } catch (error) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'methodArgs must be JSON-serializable.', details: { cause: error instanceof Error ? error.message : String(error) } });
        }
        if (Buffer.byteLength(encodedArgs, 'utf8') > MAX_COMPONENT_METHOD_BYTES) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `methodArgs must be at most ${MAX_COMPONENT_METHOD_BYTES} UTF-8 bytes.` });
        }
        const component = await Editor.Message.request('scene', 'query-component', args.reference.id);
        if (!component || typeof component !== 'object') throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Component ${args.reference.id} was not found.` });
        const result = await Editor.Message.request('scene', 'execute-component-method', { uuid: args.reference.id, name: args.methodName, args: methodArgs });
        await Editor.Message.request('scene', 'snapshot');
        let normalizedResult: unknown = result === undefined ? null : result;
        try {
            const encodedResult = JSON.stringify(normalizedResult);
            if (Buffer.byteLength(encodedResult, 'utf8') > MAX_COMPONENT_METHOD_RESULT_BYTES) {
                throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 502, message: `Component method result exceeds ${MAX_COMPONENT_METHOD_RESULT_BYTES} UTF-8 bytes.` });
            }
            normalizedResult = JSON.parse(encodedResult);
        } catch (error) {
            if (error instanceof ToolError) throw error;
            throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Component method result was not JSON-serializable.', details: { cause: error instanceof Error ? error.message : String(error) } });
        }
        return { result: normalizedResult };
    }

    @utcpTool(
        'listComponentMethods',
        'List discovered method names per component, separately reporting the finite callComponentMethod allowlist. Discovery does not authorize arbitrary or lifecycle execution.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema
            },
            required: ['reference']
        },
        {
            type: 'object',
            properties: {
                components: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            reference: InstanceReferenceSchema,
                            methods: { type: 'array', items: { type: 'string' } },
                            permittedMethods: { type: 'array', items: { type: 'string' } },
                            deniedMethods: { type: 'array', items: { type: 'string' } },
                            permissionReason: { type: 'string' }
                        }
                    }
                }
            },
            required: ['components']
        }, "GET", ['scene', 'node', 'component', 'method', 'function', 'list', 'discover', 'callable', 'invoke', 'script']
    )
    async listComponentMethods(args: { reference: IInstanceReference }): Promise<{ components: Array<{ reference: IInstanceReference, methods: string[], permittedMethods: string[], deniedMethods: string[], permissionReason: string }> }> {
        if (!args.reference || !args.reference.id) {
            throw new Error('listComponentMethods requires reference.id (node uuid)');
        }
        const queriedNode = await Editor.Message.request('scene', 'query-node', args.reference.id);
        if (queriedNode == null) {
            throw new ToolError({
                code: 'TARGET_NOT_FOUND',
                status: 404,
                message: `Node not found: ${args.reference.id}`,
                details: { requestedId: args.reference.id },
                recovery: 'Call nodeGetTree or sceneGetInfo to inspect the active scene and use a current node reference.',
            });
        }
        const raw = await Editor.Message.request('scene', 'query-component-function-of-node', args.reference.id);
        if (raw === null || raw === undefined) {
            throw new Error(`listComponentMethods: query-component-function-of-node returned no payload for ${args.reference.id}`);
        }

        const objectField = (value: unknown, key: string): unknown => value && typeof value === 'object' && !Array.isArray(value) ? Reflect.get(value, key) : undefined;
        const toMethods = (value: unknown): string[] => {
            const source = Array.isArray(value) ? value : objectField(value, 'functions') ?? objectField(value, 'methods');
            if (!Array.isArray(source)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator returned an invalid component method collection.' });
            return source.map(item => typeof item === 'string' ? item : objectField(item, 'name') ?? objectField(item, 'functionName')).filter((name): name is string => typeof name === 'string' && name.length > 0);
        };
        const dumps: unknown = objectField(queriedNode, '__comps__');
        if (!Array.isArray(dumps)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Node dump omitted authoritative component identities.' });
        const identities = dumps.map(dump => ({ id: componentUuid(dump), type: typeof objectField(dump, 'type') === 'string' ? String(objectField(dump, 'type')) : componentClassId(dump), classId: componentClassId(dump) }));
        if (identities.some(identity => !identity.id || !identity.type)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Component identity/type is incomplete.' });
        const entries: Array<{ selector: string; value: unknown }> = Array.isArray(raw)
            ? raw.map(entry => ({ selector: String(objectField(entry, 'uuid') ?? objectField(entry, 'id') ?? objectField(entry, 'type') ?? ''), value: entry }))
            : raw && typeof raw === 'object' ? Object.entries(raw).map(([selector, value]) => ({ selector, value })) : [];
        const components: Array<{ reference: IInstanceReference; methods: string[] }> = [];
        for (const entry of entries) {
            const matched = identities.filter(identity => identity.id === entry.selector || identity.type === entry.selector || identity.classId === entry.selector);
            if (!matched.length) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Discovered method class does not map to an attached component.' });
            const methods = toMethods(entry.value);
            for (const identity of matched) components.push({ reference: { id: identity.id!, type: identity.type! }, methods });
        }

        return { components: components.map(component => ({ ...component, permittedMethods: component.methods.filter(name => Object.prototype.hasOwnProperty.call(ALLOWED_COMPONENT_METHODS, name)), deniedMethods: component.methods.filter(name => !Object.prototype.hasOwnProperty.call(ALLOWED_COMPONENT_METHODS, name)), permissionReason: 'Only the existing finite invocation allowlist is permitted; discovered names do not grant execution rights.' })) };
    }

    @utcpTool(
        'listComponentClasses',
        'List editor classes, filter by base class e.g. cc.Component.',
        {
            type: 'object',
            properties: {
                extends: { type: 'string', description: 'Base class name to filter by, e.g. cc.Component' },
                excludeSelf: { type: 'boolean', description: 'Exclude the base class itself from results', default: false },
                filter: { type: 'string', description: 'Case-insensitive substring match on class name' }
            }
        },
        { type: 'object', properties: { classes: { type: 'array', items: { type: 'string' } } }, required: ['classes'] }, "GET", ['scene', 'class', 'component', 'list', 'types', 'script']
    )
    async listComponentClasses(args: { extends?: string, excludeSelf?: boolean, filter?: string }): Promise<{ classes: string[] }> {
        const options: { extends?: string, excludeSelf?: boolean } = {
            extends: args.extends || 'cc.Component',
        };
        if (args.excludeSelf) {
            options.excludeSelf = true;
        }
        const classes = await Editor.Message.request('scene', 'query-classes', options);
        if (!Array.isArray(classes)) {
            throw new Error('Failed to query classes');
        }
        const lowerFilter = args.filter ? args.filter.toLowerCase() : null;
        const names = classes
            .map((c: any) => (c && c.name) as string)
            .filter((name: any) => typeof name === 'string' && (!lowerFilter || name.toLowerCase().includes(lowerFilter)));
        return { classes: names };
    }

    @utcpTool(
        'nodeClipboard',
        'Copy/cut/paste nodes via editor clipboard. Paste returns references of pasted nodes.',
        {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['copy', 'cut', 'paste'] },
                references: { type: 'array', items: InstanceReferenceSchema, description: 'For copy/cut: the nodes to copy/cut. For paste: the copied node references to paste.' },
                targetReference: InstanceReferenceSchema,
                keepWorldTransform: { type: 'boolean', description: 'For paste: keep world transform of pasted nodes', default: true },
                pasteAsChild: { type: 'boolean', description: 'For paste: paste as child of the target node', default: false }
            },
            required: ['operation', 'references']
        },
        {
            type: 'object',
            properties: {
                success: { type: 'boolean' },
                references: { type: 'array', items: InstanceReferenceSchema }
            },
            required: ['success']
        }, "POST", ['scene', 'node', 'copy', 'cut', 'paste', 'clipboard']
    )
    async nodeClipboard(args: { operation: string, references: IInstanceReference[], targetReference?: IInstanceReference, keepWorldTransform?: boolean, pasteAsChild?: boolean }):
        Promise<{ success: boolean, references?: IInstanceReference[] }> {
        const uuids = (args.references || []).map((r: IInstanceReference) => r.id).filter((id: string) => !!id);
        if (uuids.length === 0) {
            throw new Error('nodeClipboard requires non-empty references');
        }

        switch (args.operation) {
            case 'copy': {
                const copied = await Editor.Message.request('scene', 'copy-node', uuids);
                if (!Array.isArray(copied)) {
                    throw new Error(`Copy failed for nodes ${uuids.join(', ')}`);
                }
                return { success: true, references: copied.map((id: string) => ({ id, type: 'cc.Node' })) };
            }
            case 'cut': {
                await Editor.Message.request('scene', 'cut-node', uuids);
                await Editor.Message.request('scene', 'snapshot');
                return { success: true, references: uuids.map((id: string) => ({ id, type: 'cc.Node' })) };
            }
            case 'paste': {
                if (!args.targetReference || !args.targetReference.id) {
                    throw new Error('targetReference required for paste');
                }
                const pasted = await Editor.Message.request('scene', 'paste-node', {
                    target: args.targetReference.id,
                    uuids: uuids,
                    keepWorldTransform: args.keepWorldTransform ?? true,
                    pasteAsChild: args.pasteAsChild ?? false
                });
                if (!Array.isArray(pasted) || pasted.length === 0) {
                    throw new Error('Paste returned no nodes');
                }
                await Editor.Message.request('scene', 'snapshot');
                return { success: true, references: pasted.map((id: string) => ({ id, type: 'cc.Node' })) };
            }
            default:
                throw new Error(`Unknown clipboard operation: ${args.operation}`);
        }
    }
    @utcpTool(
        'nodeGetTree',
        'Get node hierarchy tree. Defaults maxDepth=4/maxNodes=200; verbose=true raises caps to depth 99/nodes 10000. Supports fields filter and bounded root-child pagination with a hierarchy revision token.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                maxDepth: { type: 'number', minimum: 0, maximum: VERBOSE_TREE_DEPTH, default: DEFAULT_TREE_MAX_DEPTH, description: 'Max recursion depth. 0 = root only, 1 = root + direct children.' },
                maxNodes: { type: 'number', minimum: 1, maximum: VERBOSE_TREE_NODES, default: DEFAULT_TREE_MAX_NODES, description: 'Max descendant nodes to walk; guards wide scenes where maxDepth alone does not bound.' },
                verbose: { type: 'boolean', description: 'When true, raises omitted caps to depth 99/nodes 10000.' },
                fields: { type: 'array', items: { type: 'string' }, description: 'Optional: only keep these node keys per node (e.g. ["name","active","components"]). reference+children always kept. Omit for all fields.' },
                childOffset: { type: 'integer', minimum: 0, maximum: MAX_TREE_CHILD_OFFSET, default: 0, description: 'Zero-based window offset among the requested root node children.' },
                pageSize: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT, description: 'Maximum root children in this window. Descendant depth/node budgets still apply.' },
                expectedRevision: { type: 'string', minLength: 1, maxLength: 128, description: 'Optional hierarchy revision token from an earlier page; changed topology is rejected with 409.' }
            }
        },
        SceneTreeItemSchema, 'GET', ['scene', 'graph', 'node', 'hierarchy', 'tree']
    )
    async nodeGetTree(args: { reference?: IInstanceReference, maxDepth?: number, maxNodes?: number, verbose?: boolean, fields?: string[], childOffset?: number, pageSize?: number, expectedRevision?: string }): Promise<ISceneTreeItem> {
        if (args.reference?.id && args.reference.id.includes('#')) {
            const [file, uuid] = args.reference.id.split('#');
            throw new ToolError({
                code: 'COMPOSITE_HANDLE_NOT_SUPPORTED',
                status: 400,
                message: `Composite graph handle "${args.reference.id}" passed to live tool nodeGetTree. Pass bare engine UUID only.`,
                details: { file, uuid, reference: args.reference },
                recovery: `Node belongs to "${file}". Check if this file is currently open via sceneGetInfo. If it is a prefab, inspect offline via readPrefabJson or cocos-graph navigate. Otherwise pass bare uuid "${uuid}".`
            });
        }

        const maxDepth = args.maxDepth === undefined
            ? (args.verbose ? VERBOSE_TREE_DEPTH : DEFAULT_TREE_MAX_DEPTH)
            : args.maxDepth;
        const maxNodes = args.maxNodes === undefined
            ? (args.verbose ? VERBOSE_TREE_NODES : DEFAULT_TREE_MAX_NODES)
            : args.maxNodes;
        if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > VERBOSE_TREE_DEPTH) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `maxDepth must be an integer from 0 to ${VERBOSE_TREE_DEPTH}.` });
        }
        if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > VERBOSE_TREE_NODES) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `maxNodes must be an integer from 1 to ${VERBOSE_TREE_NODES}.` });
        }
        const childOffset = args.childOffset === undefined ? 0 : args.childOffset;
        const pageSize = args.pageSize === undefined ? DEFAULT_LIST_LIMIT : args.pageSize;
        if (!Number.isInteger(childOffset) || childOffset < 0 || childOffset > MAX_TREE_CHILD_OFFSET) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `childOffset must be an integer from 0 to ${MAX_TREE_CHILD_OFFSET}.` });
        }
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_LIST_LIMIT) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `pageSize must be an integer from 1 to ${MAX_LIST_LIMIT}.` });
        }
        if (args.expectedRevision !== undefined && (typeof args.expectedRevision !== 'string' || !args.expectedRevision || args.expectedRevision.length > 128)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedRevision must be a non-empty revision token.' });
        }

        let treeBase: unknown;
        if (args.reference) {
            treeBase = await Editor.Message.request('scene', 'query-node-tree', args.reference.id);
        } else {
            treeBase = await Editor.Message.request('scene', 'query-node-tree');
            treeBase = (await this.findPrefabEditRoot(treeBase)) ?? treeBase;
        }

        if (!treeBase || typeof treeBase !== 'object' || Array.isArray(treeBase)) {
            const currentRaw = (await Editor.Message.request('scene', 'query-current-scene').catch(() => undefined)) as unknown;
            let currentSceneUuid = 'unknown';
            if (typeof currentRaw === 'string') currentSceneUuid = currentRaw;
            else if (currentRaw && typeof currentRaw === 'object' && typeof (currentRaw as Record<string, unknown>).uuid === 'string') currentSceneUuid = (currentRaw as Record<string, unknown>).uuid as string;
            const isRootQuery = !args.reference?.id;
            throw new ToolError({
                code: 'TARGET_NOT_FOUND', status: 404,
                message: isRootQuery ? 'Node tree not found: no active scene or prefab is currently open in the editor.' : `Node tree not found for node "${args.reference?.id}" in the currently open scene.`,
                details: { requestedId: args.reference?.id ?? null, currentSceneUuid },
                recovery: isRootQuery ? "Open a scene first using sceneOpen({ assetPath: 'db://assets/.../scene_name.scene' })." : 'Refresh the active scene and retry with a current node reference.'
            });
        }

        const root = treeBase as Record<string, unknown>;
        const rawChildren = Array.isArray(root.children) ? root.children : [];
        if (childOffset > rawChildren.length) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `childOffset ${childOffset} is outside the root child range 0-${rawChildren.length}.`, details: { childOffset, childrenCount: rawChildren.length } });
        }
        const topology = (node: unknown): unknown => {
            if (!node || typeof node !== 'object' || Array.isArray(node)) return { id: null, children: [] };
            const value = node as Record<string, unknown>;
            const children = Array.isArray(value.children) ? value.children : [];
            return { id: typeof value.uuid === 'string' ? value.uuid : null, children: children.map(topology) };
        };
        const currentRaw = (await Editor.Message.request('scene', 'query-current-scene').catch(() => undefined)) as unknown;
        const sceneUuid = typeof currentRaw === 'string' ? currentRaw : currentRaw && typeof currentRaw === 'object' && typeof (currentRaw as Record<string, unknown>).uuid === 'string' ? (currentRaw as Record<string, unknown>).uuid as string : '';
        const revision = createHash('sha256').update(JSON.stringify({ sceneUuid, root: topology(root) })).digest('hex');
        if (args.expectedRevision !== undefined && args.expectedRevision !== revision) {
            throw new ToolError({ code: 'HIERARCHY_REVISION_CONFLICT', status: 409, message: 'Scene hierarchy changed since the requested revision; page was not returned.', details: { expectedRevision: args.expectedRevision, actualRevision: revision, reference: args.reference ?? null } });
        }

        const budget = { left: maxNodes };
        const fieldSet = args.fields && args.fields.length > 0 ? new Set(args.fields) : null;
        const want = (key: string) => !fieldSet || fieldSet.has(key);
        const formatNode = (nodeValue: unknown, depth: number): ISceneTreeItem => {
            const node = nodeValue as Record<string, unknown>;
            const atMaxDepth = depth >= maxDepth;
            const descendants = Array.isArray(node.children) ? node.children : [];
            const children: ISceneTreeItem[] = [];
            let truncated: 'maxDepth' | 'nodeLimit' | undefined;
            let childrenOmitted: number | undefined;
            if (atMaxDepth && descendants.length > 0) {
                truncated = 'maxDepth';
                childrenOmitted = descendants.length;
            } else if (!atMaxDepth) {
                for (let index = 0; index < descendants.length; index += 1) {
                    if (budget.left <= 0) { truncated = 'nodeLimit'; childrenOmitted = descendants.length - index; break; }
                    budget.left -= 1;
                    children.push(formatNode(descendants[index], depth + 1));
                }
            }
            const item: ISceneTreeItem = {
                reference: { id: typeof node.uuid === 'string' ? node.uuid : '', type: 'cc.Node' },
                children,
            };
            if (want('name') && (typeof node.name === 'string' || (node.name && typeof node.name === 'object'))) item.name = typeof node.name === 'string' ? node.name : String((node.name as Record<string, unknown>).value ?? '');
            if (want('active') && typeof node.active === 'boolean') item.active = node.active;
            if (want('components')) {
                const components = Array.isArray(node.components) ? node.components : [];
                item.components = components.map((component: unknown) => {
                    const row = component && typeof component === 'object' ? component as Record<string, unknown> : {};
                    const id = componentUuid(component);
                    const type = componentClassId(component);
                    if (!id || !type) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: `nodeGetTree received a component without authoritative uuid/type on node ${typeof node.uuid === 'string' ? node.uuid : 'unknown'}.`, details: { nodeUuid: node.uuid ?? null, component: row }, recovery: 'Refresh the scene and retry; inspect the raw Creator node dump for schema drift.' });
                    return { id, type };
                });
            }
            if (want('path') && typeof node.path === 'string') item.path = node.path;
            if (truncated) item.truncated = truncated;
            if (childrenOmitted !== undefined) item.childrenOmitted = childrenOmitted;
            return item;
        };

        const pageEnd = Math.min(rawChildren.length, childOffset + pageSize);
        const selectedChildren = rawChildren.slice(childOffset, pageEnd);
        const rootForFormatting: Record<string, unknown> = { ...root, children: selectedChildren };
        const result = formatNode(rootForFormatting, 0);
        result.childrenCount = rawChildren.length;
        result.childOffset = childOffset;
        result.pageSize = pageSize;
        result.nextOffset = pageEnd < rawChildren.length ? pageEnd : null;
        result.revision = revision;
        return result;
    }

    @utcpTool(
        'nodeGetAtPath',
        'Get nodes at hierarchy path.',
        {
            type: 'object',
            properties: {
                hierarchyPath: { type: 'string', description: 'Path to the node in the scene hierarchy"' },
            },
            required: ['hierarchyPath']
        }, { type: 'object', properties: { references: { type: 'array', items: InstanceReferenceSchema } }, required: ['references'] }, "GET",  ['scene', 'node', 'get', 'path', 'find', 'look', 'instance', 'hierarchy']
    )
    async nodeGetAtPath(args: { hierarchyPath: string }): Promise<{ references: IInstanceReference[] }> {
        const nodeTree = await Editor.Message.request('scene', 'query-node-tree');
        if (!nodeTree) {
            throw new Error(`Scene is empty or could not retrieve scene tree.`);
        }

        const sceneRootName = (nodeTree.name as unknown as string);
        if (args.hierarchyPath.startsWith('/')) {
            args.hierarchyPath = args.hierarchyPath.slice(1);
        }
        if (args.hierarchyPath.startsWith(`${sceneRootName}`)) {
            args.hierarchyPath = args.hierarchyPath.slice(sceneRootName.length);
        }
        if (args.hierarchyPath === '') {
            return { references: [{ id: (nodeTree.uuid as unknown as string) }] };
        }

        const pathParts = args.hierarchyPath.split('/').filter(p => p.length > 0);
        let currentNodes = [nodeTree];
        for (const part of pathParts) {
            const nextNodes: any[] = [];
            for (const node of currentNodes) {
                const matchingChildren = (node.children || []).filter((child: any) => child.name === part);
                nextNodes.push(...matchingChildren);
            }
            currentNodes = nextNodes;
            if (currentNodes.length === 0) {
                break;
            }
        }

        return { references: currentNodes.map((node: any) => ({ id: node.uuid, type: 'cc.Node' })) };
    }

    @utcpTool(
        'nodeCreatePrimitive',
        'Create primitive node (Capsule/Cube/Sphere etc.) under parent.',
         {  type: 'object',
            properties: {
                name: { type: 'string' },
                primitiveType: { type: 'string', enum: [
                    'Capsule', 'Cone', 'Cube', 'Cylinder', 'Plane', 'Quad', 'Sphere', 'Torus',
                ] },
                parentReference: InstanceReferenceSchema
            },
            required: ['name', 'primitiveType']
         }, 
         { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, "POST",  ['scene', 'node', 'create', 'add']
    )
    async sceneCreatePrimitiveNode(args: { name: string, primitiveType: string, parentReference?: IInstanceReference }): Promise<{ reference: IInstanceReference }> {
        const primitiveMap: Record<string, string> = {
            'Capsule': "db://internal/default_prefab/3d/Capsule.prefab",
            'Cone': "db://internal/default_prefab/3d/Cone.prefab",
            'Cube': "db://internal/default_prefab/3d/Cube.prefab",
            'Cylinder': "db://internal/default_prefab/3d/Cylinder.prefab",
            'Plane': "db://internal/default_prefab/3d/Plane.prefab",
            'Quad': "db://internal/default_prefab/3d/Quad.prefab",
            'Sphere': "db://internal/default_prefab/3d/Sphere.prefab",
            'Torus': "db://internal/default_prefab/3d/Torus.prefab",
        };

        if (!primitiveMap[args.primitiveType]) {
            throw new Error(`Unsupported primitive type: ${args.primitiveType}`);
        }

        const prefabUrl = primitiveMap[args.primitiveType];
        const assetUuid = await Editor.Message.request('asset-db', 'query-uuid', prefabUrl);
        if (!assetUuid) {
            throw new Error(`Failed to find asset for primitive type ${args.primitiveType} at ${prefabUrl}`);
        }
        return await this.sceneCreateNode({
            name: args.name,
            parentReference: args.parentReference,
            assetReference: { id: assetUuid, type: 'cc.Prefab' },
            unwrapPrefab: true
        });
    }

    @utcpTool(
        'nodeCreate',
        'Create a new node in the scene. If no parent is specified, root node is used. Returns reference to the new node.',
        {
            type: 'object',
            properties: {
                name: { type: 'string' },
                parentReference: InstanceReferenceSchema,
                assetReference: InstanceReferenceSchema,
                unwrapPrefab: { type: 'boolean', default: false }
            },
            required: ['name']
        },
        { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, "POST",  ['scene', 'node', 'create', 'add']
    )
    async sceneCreateNode(args: { name: string, parentReference?: IInstanceReference, assetReference?: IInstanceReference, unwrapPrefab?: boolean }): Promise<{ reference: IInstanceReference }> {
        const options: any = {
            name: args.name
        };
        if (args.parentReference) {
            options.parent = args.parentReference.id;
        } else {
            // Force root if no parent provided
            options.parent = (await Editor.Message.request('scene', 'query-node-tree')).uuid;
        }

        let assetUuid: string | null = null;

        // 1. Determine Asset UUID
        if ((args.assetReference && 'id' in args.assetReference)) {
            const assetInfo = await Editor.Message.request('asset-db', 'query-asset-info', args.assetReference.id);
            if (!assetInfo) {
                throw new Error(`Asset reference not found: ${args.assetReference.id}`);
            }

            let prefabFound = assetInfo.type === 'cc.Prefab';
            // If not a prefab, check if it has a prefab sub-asset (like in case of FBX)
            if (!prefabFound) {
                for (let subAsset of Object.values(assetInfo.subAssets)) {
                    if (subAsset.type === 'cc.Prefab') {
                        assetUuid = subAsset.uuid;
                        prefabFound = true;
                        break;
                    }
                }
            } else {
                assetUuid = assetInfo.uuid;
            }

            if (!prefabFound) {
                throw new Error(`Provided asset reference ${args.assetReference.id} is not a prefab and does not contain a prefab sub-asset.`);
            } else {
                if (!args.unwrapPrefab) {
                    options.unlinkPrefab = false;
                    options.type = 'cc.Prefab';
                }
            }
        }

        if (assetUuid) {
            options.assetUuid = assetUuid;
        }

        // 2. Create Node
        const result = await Editor.Message.request('scene', 'create-node', options);
        const newNodeUuid = Array.isArray(result) ? result[0] : result;

        if (typeof newNodeUuid !== 'string' || !newNodeUuid) {
            throw new ToolError({ code: 'NODE_CREATE_UNCONFIRMED', status: 502, message: `Creator did not return a UUID for node ${args.name}.` });
        }

        await Editor.Message.request('scene', 'snapshot');
        const readBack = await Editor.Message.request('scene', 'query-node', newNodeUuid);
        const readBackUuid = typeof readBack?.uuid === 'string' ? readBack.uuid : readBack?.uuid?.value;
        if (!readBack || readBackUuid !== newNodeUuid) {
            throw new ToolError({
                code: 'NODE_CREATE_UNCONFIRMED',
                status: 502,
                message: `Creator did not confirm creation of node ${newNodeUuid}.`,
                details: { requestedName: args.name, nodeUuid: newNodeUuid },
                recovery: 'Query nodeGetTree and retry after the editor finishes the scene operation.',
            });
        }

        return { reference: { id: newNodeUuid, type: 'cc.Node' } };
    }

    @utcpTool(
        'nodeOperate',
        'Node operations: hierarchy locking, prefab link/unlink/create/save. Lock prevents edit/select in scene view.',
        {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['move', 'copy', 'delete', 'lock', 'unlock', 'create_prefab', 'link_prefab', 'revert_prefab', 'apply_prefab', 'unwrap_prefab', 'unwrap_prefab_completely', 'open_prefab'] },
                reference: InstanceReferenceSchema,
                newParentReference: InstanceReferenceSchema,
                newPrefabPath: { type: 'string', description: 'For create_prefab: target db:// path', nullable: true },
                prefabAssetReference: InstanceReferenceSchema,
                siblingIndex: { type: 'integer', description: 'For move/copy: target index in parent children array', nullable: true },
                recursive: { type: 'boolean', description: 'For lock/unlock: also apply to all descendants', default: false }
            },
            required: ['operation', 'reference']
        },
        { type: 'object',
            properties: {
                success: { type: 'boolean' },
                createdPrefabAssetReference: InstanceReferenceSchema,
                updatedNodeReference: InstanceReferenceSchema,
                copiedNodeReference: InstanceReferenceSchema
            }
        }, "POST",  ['scene', 'node', 'remove', 'move', 'copy', 'delete', 'lock', 'unlock', 'prefab', 'apply', 'revert', 'unwrap', 'create', 'link', 'bind']
    )
    async nodeOperate(args: { operation: string, reference: IInstanceReference, newParentReference?: IInstanceReference, newPrefabPath?: string, prefabAssetReference?: IInstanceReference, siblingIndex?: number, recursive?: boolean }): Promise<{ success?: boolean, createdPrefabAssetReference?: IInstanceReference, updatedNodeReference?: IInstanceReference, copiedNodeReference?: IInstanceReference }> {
        if (await Editor.Message.request('scene', 'query-node', args.reference.id) === null) {
            throw new Error(`Target node ${args.reference.id} not found`);
        }

        switch (args.operation) {
            case 'move':
                if (!args.newParentReference) {
                    throw new Error("newParentReference required for move");
                }

                await Editor.Message.request('scene', 'set-parent', {
                    parent: args.newParentReference.id,
                    uuids: args.reference.id,
                    keepWorldTransform: true
                });

                if (args.siblingIndex !== undefined) {
                    await this.setSiblingIndex(args.reference.id, args.siblingIndex);
                }

                await Editor.Message.request('scene', 'snapshot');
                const movedNode = await Editor.Message.request('scene', 'query-node', args.reference.id);
                const movedParent = movedNode?.parent?.value?.uuid ?? movedNode?.parent?.uuid;
                if (!movedNode || movedParent !== args.newParentReference.id) {
                    throw new ToolError({
                        code: 'NODE_MOVE_UNCONFIRMED', status: 502,
                        message: `Creator did not confirm node ${args.reference.id} under parent ${args.newParentReference.id}.`,
                        details: { nodeId: args.reference.id, requestedParentId: args.newParentReference.id, actualParentId: movedParent ?? null },
                    });
                }
                return { success: true };

            case 'copy':
                 const duplicateResult = await Editor.Message.request('scene', 'duplicate-node', [args.reference.id]);
                 if (!duplicateResult || duplicateResult.length === 0) {
                    throw new Error(`Node ${args.reference.id} duplication failed`);
                 }
                 
                 const newNodes = duplicateResult as string[];
                 const newNodeId = newNodes[0]; 
                 
                 if (args.newParentReference) {
                     await Editor.Message.request('scene', 'set-parent', {
                        parent: args.newParentReference.id,
                        uuids: newNodes,
                        keepWorldTransform: true
                     });
                 }

                 if (args.siblingIndex !== undefined) {
                     await this.setSiblingIndex(newNodeId, args.siblingIndex);
                 }

                 await Editor.Message.request('scene', 'snapshot');
                 const copiedNode = await Editor.Message.request('scene', 'query-node', newNodeId);
                 const copiedNodeUuid = typeof copiedNode?.uuid === 'string' ? copiedNode.uuid : copiedNode?.uuid?.value;
                 if (!copiedNode || copiedNodeUuid !== newNodeId) {
                    throw new ToolError({ code: 'NODE_COPY_UNCONFIRMED', status: 502, message: `Creator did not confirm duplicated node ${newNodeId}.` });
                 }
                 if (args.newParentReference) {
                    const copiedParent = copiedNode.parent?.value?.uuid ?? copiedNode.parent?.uuid;
                    if (copiedParent !== args.newParentReference.id) {
                        throw new ToolError({
                            code: 'NODE_COPY_UNCONFIRMED', status: 502,
                            message: `Creator did not confirm duplicated node ${newNodeId} under parent ${args.newParentReference.id}.`,
                            details: { nodeId: newNodeId, requestedParentId: args.newParentReference.id, actualParentId: copiedParent ?? null },
                        });
                    }
                 }
                 return { success: true, copiedNodeReference: { id: newNodeId, type: 'cc.Node' } };

            case 'delete':
                await Editor.Message.request('scene', 'remove-node', {
                    uuid: args.reference.id
                });

                const nodeCheck = await Editor.Message.request('scene', 'query-node', args.reference.id);
                if (nodeCheck !== null && nodeCheck !== undefined) {
                    throw new Error(`Node ${args.reference.id} still exists after removal`);
                }

                await Editor.Message.request('scene', 'snapshot');

                return { success: true };

            case 'lock':
            case 'unlock':
                await Editor.Message.request('scene', 'change-node-lock',
                    args.reference.id, args.operation === 'lock', !!args.recursive);
                await Editor.Message.request('scene', 'snapshot');
                return { success: true };

            case 'create_prefab':
                if (!args.newPrefabPath) {
                    throw new Error("newPrefabPath required for create_prefab");
                }
                const parentInfo = await this.getParentAndSiblingIndex(args.reference.id);

                const createdPrefabUuid = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: packageJSON.name,
                    method: 'createPrefabFromNode',
                    args: [args.reference.id, args.newPrefabPath]
                });
                
                if (!createdPrefabUuid) {
                    throw new Error("Failed to create prefab asset.");
                }
                const updatedNodeId = await this.getUpdatedUuid(parentInfo.parentUuid, parentInfo.siblingIndex);

                await Editor.Message.request('scene', 'snapshot');

                return { success: true, createdPrefabAssetReference: { id: createdPrefabUuid, type: 'cc.Prefab' }, updatedNodeReference: { id: updatedNodeId, type: 'cc.Node' } };

            case 'link_prefab': {
                if (!args.prefabAssetReference || !args.prefabAssetReference.id) {
                    throw new Error('prefabAssetReference required for link_prefab');
                }
                const prefabInfo = await Editor.Message.request('asset-db', 'query-asset-info', args.prefabAssetReference.id);
                if (!prefabInfo) {
                    throw new Error(`Prefab asset ${args.prefabAssetReference.id} not found`);
                }
                await Editor.Message.request('scene', 'link-prefab', args.reference.id, args.prefabAssetReference.id);
                await Editor.Message.request('scene', 'snapshot');
                return { success: true };
            }
            case 'revert_prefab':
                // restore-prefab is result: boolean — a false/undefined return means the node
                // was NOT reverted; reporting it as opaque data is a docs §2 silent failure.
                const revertSuccess = await restorePrefabNode(args.reference.id);
                if (revertSuccess !== true) {
                    throw new Error(`revert_prefab failed: restore-prefab returned ${JSON.stringify(revertSuccess ?? null)} for ${args.reference.id}`);
                }
                await Editor.Message.request('scene', 'snapshot');
                return { success: true };

            case 'apply_prefab':
                const applyError = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: packageJSON.name,
                    method: 'applyPrefabByNode',
                    args: [args.reference.id]
                });

                if (applyError != null) {
                    throw new Error(`Failed to apply prefab: ${applyError}`);
                }

                await Editor.Message.request('scene', 'snapshot');

                return { success: true };

            case 'unwrap_prefab':
                const unwrapError = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: packageJSON.name,
                    method: 'unlinkPrefabByNode',
                    args: [args.reference.id, false]
                });
                
                if (unwrapError != null) {
                    throw new Error(`Failed to unwrap prefab: ${unwrapError}`);
                }

                await Editor.Message.request('scene', 'snapshot');

                return { success: true };

            case 'unwrap_prefab_completely':
                const unwrapAllError = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: packageJSON.name,
                    method: 'unlinkPrefabByNode',
                    args: [args.reference.id, true]
                });
                
                if (unwrapAllError != null) {
                    throw new Error(`Failed to unwrap prefab completely: ${unwrapAllError}`);
                }

                await Editor.Message.request('scene', 'snapshot');

                return { success: true };

            case 'open_prefab':
                const nodeForPrefab: any = await Editor.Message.request('scene', 'query-node', args.reference.id);
                if (!nodeForPrefab) {
                    throw new Error(`Node ${args.reference.id} not found`);
                }
                 
                const pInfo = nodeForPrefab.__prefab__ || nodeForPrefab._prefab || (nodeForPrefab.value && (nodeForPrefab.value.__prefab__ || nodeForPrefab.value._prefab));
                const pValue = pInfo?.value || pInfo;
                const targetUuid = pValue?.assetUuid || pValue?.uuid;

                if (!targetUuid) {
                    throw new Error(`Node ${args.reference.id} is not linked to a prefab`);
                }

                try { 
                    await Editor.Message.request('asset-db', 'open-asset', targetUuid);
                } catch (error: any) {
                    throw new Error(`Failed to open prefab asset ${targetUuid}. Reason: ${error?.message || error}`);
                }

                return { success: true };

            default:
                throw new Error(`Unknown scene node operation: ${args.operation}`);
        }
    }

    // Helpers

    private treeNodeName(node: SceneTreeNode): string {
        if (typeof node.name === 'string') return node.name;
        return node.name?.value ?? node.uuid ?? '';
    }

    private findTreeNode(root: SceneTreeNode, uuid: string): SceneTreeNode | null {
        const stack: SceneTreeNode[] = [root];
        while (stack.length) {
            const node = stack.pop()!;
            if (node.uuid === uuid) return node;
            const children = node.children ?? [];
            for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
        }
        return null;
    }

    /**
     * When a prefab is open for editing, 'query-current-scene' reports the prefab
     * ASSET uuid rather than a scene uuid. Walk the wrapper hierarchy for the node
     * whose __prefab__ marks it as that asset's root and return its subtree.
     * Returns null in ordinary scene mode, or if no such root is found.
     */
    private async findPrefabEditRoot(sceneTree: any): Promise<any | null> {
        if (!sceneTree) return null;

        const current: any = await Editor.Message.request('scene', 'query-current-scene');
        const openUuid = typeof current === 'string' ? current : current?.uuid;
        if (!openUuid) return null;

        // A real scene's root IS the open asset — nothing to unwrap.
        if (sceneTree.uuid === openUuid) return null;

        const asset = await Editor.Message.request('asset-db', 'query-asset-info', openUuid);
        if (!asset || asset.type !== 'cc.Prefab') return null;

        // Breadth-first: the prefab root is the shallowest node claiming to be one.
        const queue: any[] = [sceneTree];
        const visited = new Set<object>();
        for (let cursor = 0; cursor < queue.length; cursor++) {
            const node = queue[cursor];
            if (!node || typeof node !== 'object' || visited.has(node)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Prefab edit hierarchy contains an invalid or repeated node.' });
            visited.add(node);

            if (node.uuid && node.uuid !== sceneTree.uuid) {
                const dump: any = await Editor.Message.request('scene', 'query-node', node.uuid)
                    .catch(() => null);
                const prefab = dump?.__prefab__?.value ?? dump?.__prefab__;
                const assetUuid = prefab?.prefabStateInfo?.assetUuid ?? prefab?.uuid;
                if (prefab && assetUuid === openUuid && prefab.rootUuid === node.uuid) {
                    return node;
                }
            }

            const children = node.children ?? [];
            if (!Array.isArray(children)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Prefab edit hierarchy children must be an array.' });
            if (queue.length + children.length > VERBOSE_TREE_NODES) throw new ToolError({ code: 'LIMIT_EXCEEDED', status: 413, message: 'Prefab edit hierarchy exceeds the 10000-node traversal budget.' });
            for (const child of children) {
                queue.push(child);
            }
        }

        return null;
    }

    private async getParent(nodeUuid: string): Promise<string> {
        const node = await Editor.Message.request('scene', 'query-node', nodeUuid);
        if (node?.parent?.value?.uuid) return node.parent.value.uuid;
        if (node?.parent?.uuid) return node.parent.uuid;

        // No parent recorded — the node sits directly under the scene root, so the
        // scene itself is the parent. 'scene:query-uuid' was used here before and
        // exists in neither 3.7.3 nor 3.8.7, meaning this path always threw.
        // query-current-scene returns either a uuid string or a scene info object.
        const current = await Editor.Message.request('scene', 'query-current-scene');
        if (typeof current === 'string') return current;
        return (current as any)?.uuid ?? '';
    }

    // Helper to set sibling index
    private async setSiblingIndex(uuid: string, index: number) {
        // Get parent first
        const parentUuid = await this.getParent(uuid);
        if (!parentUuid) {
            throw new Error(`Node ${uuid} has no parent`);
        }

        // Get children of parent
        const parentNode = await Editor.Message.request('scene', 'query-node', parentUuid);
        const childrenArray = parentNode.children;
        if (!childrenArray || !Array.isArray(childrenArray)) {
            throw new Error(`Parent node ${parentUuid} has no children`);
        }

        const currentIndex = childrenArray.findIndex((child: any) => child.value.uuid === uuid);
        if (currentIndex === -1) {
            throw new Error(`Node ${uuid} not found in parent children`);
        }

        if (currentIndex === index) return true;

        // Clamp hid an out-of-range request: the agent asked for index N, got the last
        // slot, and read `success`. Reject it — class, state and recovery are all known.
        if (index < 0 || index > childrenArray.length - 1) {
            throw new ToolError({
                code: 'INDEX_OUT_OF_RANGE',
                status: 422,
                message: `siblingIndex ${index} is out of range for parent ${parentUuid} (0..${childrenArray.length - 1})`,
                details: { index, maxIndex: childrenArray.length - 1, parentUuid },
                recovery: 'Pass siblingIndex between 0 and the parent child count minus one, or query nodeGetTree first.',
            });
        }

        const offset = index - currentIndex;

        if (offset === 0) return true;

        const moved = await Editor.Message.request('scene', 'move-array-element', {
            uuid: parentUuid,
            path: 'children',
            target: currentIndex,
            offset: offset,
        });
        if (moved === false) throw new Error(`move-array-element refused for ${uuid} (offset ${offset})`);
        return moved;
    }

    private async getParentAndSiblingIndex(uuid: string): Promise<{ parentUuid: string, siblingIndex: number }> {
        const parentUuid = await this.getParent(uuid);
        if (!parentUuid) {
            throw new Error(`Node ${uuid} has no parent`);
        }

        const parentNode = await Editor.Message.request('scene', 'query-node', parentUuid);
        const childrenArray = parentNode.children;
        if (!childrenArray || !Array.isArray(childrenArray)) {
            throw new Error(`Parent node ${parentUuid} has no children`);
        }
        const index = childrenArray.findIndex((child: any) => child.value.uuid === uuid);
        if (index === -1) {
            throw new Error(`Node ${uuid} not found in parent children`);
        }
        return { parentUuid, siblingIndex: index };
    }
    
    private async getUpdatedUuid(parentUuid: string, siblingIndex: number): Promise<string> {
        const parentNodeInfo = await Editor.Message.request('scene', 'query-node', parentUuid);
        if (!parentNodeInfo || !parentNodeInfo.children || !Array.isArray(parentNodeInfo.children) || !parentNodeInfo.children[siblingIndex]) {
            throw new Error(`Failed to retrieve updated node info after prefab creation.`);
        }
        return parentNodeInfo.children[siblingIndex].value.uuid;
    }
}