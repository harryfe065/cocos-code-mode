import type { IInstanceReference } from '../schemas';
import { ToolError } from '../tool-error';
import { installUiRuntimeComponent } from './ui-runtime-component-install';
import { VIRTUAL_LIST_RUNTIME_CLASS, VIRTUAL_LIST_RUNTIME_SOURCE } from './ui-virtual-list-runtime-source';

export interface VirtualListRuntimeInput {
    root: IInstanceReference;
    viewport: IInstanceReference;
    content: IInstanceReference;
    itemReferences: IInstanceReference[];
    itemCount: number;
    visibleItems: number;
    startIndex: number;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return !!value && typeof value === 'object' && !Array.isArray(value); }
function unwrap(value: unknown): unknown { return record(value) && 'value' in value ? value.value : value; }
function identity(value: unknown): string | undefined {
    const raw = unwrap(value);
    if (typeof raw === 'string') return raw;
    if (record(raw)) {
        const id = unwrap(raw.uuid);
        if (typeof id === 'string') return id;
    }
    return undefined;
}
function requireValue(condition: unknown, message: string): asserts condition {
    if (!condition) throw new ToolError({ code: 'UI_LIST_RUNTIME_INVALID', status: 422, message });
}
function validReference(value: unknown): value is IInstanceReference {
    return record(value) && typeof value.id === 'string' && value.id.trim() === value.id && value.id.length > 0
        && value.id.length <= 256 && (value.type === undefined || value.type === 'cc.Node');
}
function component(node: RecordValue, type: string): RecordValue {
    const components = node.__comps__;
    requireValue(Array.isArray(components), 'Creator did not expose authoritative list node components.');
    const matches = components.filter(value => record(value) && value.type === type);
    requireValue(matches.length === 1 && record(matches[0]), `List node must have exactly one ${type}.`);
    const value = unwrap(matches[0]);
    requireValue(record(value), `Creator did not expose serialized ${type} properties.`);
    return value;
}
async function queryNode(reference: IInstanceReference): Promise<RecordValue> {
    const node: unknown = await Editor.Message.request('scene', 'query-node', reference.id);
    requireValue(record(node) && identity(node.uuid) === reference.id, 'List node identity was not confirmed by Creator.');
    return node;
}
function childIds(node: RecordValue): string[] {
    requireValue(Array.isArray(node.children), 'Creator did not expose list hierarchy children.');
    const ids = node.children.map(identity);
    requireValue(ids.every((id): id is string => typeof id === 'string' && id.length > 0), 'Creator returned an unidentifiable list child.');
    return ids;
}

/** Installs persisted source/configuration; does not claim preview, playback or scene-save verification. */
export async function installVirtualListRuntime(args: VirtualListRuntimeInput) {
    requireValue(!!args && Number.isInteger(args.itemCount) && args.itemCount >= 0 && args.itemCount <= 100000
        && Number.isInteger(args.visibleItems) && args.visibleItems >= 1 && args.visibleItems <= 20
        && Number.isInteger(args.startIndex) && args.startIndex >= 0 && args.startIndex <= args.itemCount,
    'List runtime requires itemCount0..100000, visibleItems1..20 and startIndex0..itemCount.');
    requireValue(validReference(args.root) && validReference(args.viewport) && validReference(args.content)
        && Array.isArray(args.itemReferences) && args.itemReferences.length === Math.min(args.itemCount, args.visibleItems + 1)
        && args.itemReferences.every(validReference), 'List runtime requires bounded cc.Node reference identities and exactly min(itemCount, visibleItems + 1) pooled rows.');
    args = {
        root: { id: args.root.id, type: 'cc.Node' }, viewport: { id: args.viewport.id, type: 'cc.Node' },
        content: { id: args.content.id, type: 'cc.Node' }, itemReferences: args.itemReferences.map(reference => ({ id: reference.id, type: 'cc.Node' })),
        itemCount: args.itemCount, visibleItems: args.visibleItems, startIndex: args.startIndex,
    };
    const references = [args.root, args.viewport, args.content, ...args.itemReferences];
    requireValue(new Set(references.map(reference => reference.id)).size === references.length, 'List hierarchy and pool identities must be distinct.');
    const poolSize = args.itemReferences.length;
    const startIndex = Math.min(args.startIndex, Math.max(0, args.itemCount - args.visibleItems));
    const [root, viewport, content] = await Promise.all([queryNode(args.root), queryNode(args.viewport), queryNode(args.content)]);
    const scroll = component(root, 'cc.ScrollView');
    requireValue(identity(scroll.content ?? scroll._content) === args.content.id
        && identity(content.parent) === args.viewport.id && identity(viewport.parent) === args.root.id
        && childIds(root).filter(id => id === args.viewport.id).length === 1
        && childIds(viewport).filter(id => id === args.content.id).length === 1,
    'List root, ScrollView content binding and viewport parentage do not match the owned hierarchy.');
    component(viewport, 'cc.Mask');
    component(content, 'cc.UITransform');
    const transform = component(viewport, 'cc.UITransform');
    const size = unwrap(transform.contentSize ?? transform._contentSize);
    requireValue(record(size) && typeof size.width === 'number' && typeof size.height === 'number'
        && Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0,
    'List viewport must have finite positive dimensions.');
    const children = childIds(content);
    requireValue(children.length === poolSize && args.itemReferences.every(reference => children.filter(id => id === reference.id).length === 1),
        'Only the exact acknowledged row pool may be parented under owned list content.');
    for (const reference of args.itemReferences) {
        const row = await queryNode(reference);
        requireValue(identity(row.parent) === args.content.id, 'List row is not a direct child of owned content.');
        component(row, 'cc.UITransform');
        component(row, 'cc.Label');
        const components = row.__comps__ as RecordValue[];
        requireValue(!components.some(value => (value.type === 'cc.Widget' || value.type === 'cc.Layout')
            && record(unwrap(value)) && unwrap((unwrap(value) as RecordValue).enabled) !== false),
        'List rows must not have active Widget/Layout components that conflict with runtime positioning.');
    }
    const installed = await installUiRuntimeComponent({
        source: VIRTUAL_LIST_RUNTIME_SOURCE,
        className: VIRTUAL_LIST_RUNTIME_CLASS,
        nodeReference: args.root,
        properties: [
            { name: 'viewport', type: 'cc.Node', value: args.viewport.id },
            { name: 'content', type: 'cc.Node', value: args.content.id },
            { name: 'itemReferences', type: 'cc.Node[]', value: args.itemReferences.map(reference => reference.id) },
            { name: 'itemCount', type: 'Number', value: args.itemCount },
            { name: 'visibleItems', type: 'Number', value: args.visibleItems },
            { name: 'startIndex', type: 'Number', value: startIndex },
        ],
    });
    return { ...installed, startIndex, itemHeight: size.height / args.visibleItems, poolSize };
}
