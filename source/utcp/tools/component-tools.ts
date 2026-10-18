import { createHash, randomUUID } from 'crypto';
import packageJSON from '../../../package.json';
import { utcpTool } from '../decorators';
import { SuccessIndicatorSchema, ISuccessIndicator, InstanceReferenceSchema, IInstanceReference } from '../schemas';
import { ToolError } from '../tool-error';
import { VERBOSE_TREE_NODES } from '../utils/verbose';

function field(value: unknown, key: string): unknown {
    return value && typeof value === 'object' && key in value
        ? (value as Record<string, unknown>)[key]
        : undefined;
}

function nestedField(value: unknown, parent: string, key: string): unknown {
    return field(field(value, parent), key);
}

export class ComponentTools {

    @utcpTool(
        'nodeGetAvailableComponentTypes',
        'Get list of globally available component types (class names) at the moment.',
        {
            type: 'object',
            properties: {
                includeInternal: { type: 'boolean', default: false, description: 'Whether to include internal engine components.' },
                scriptReference: InstanceReferenceSchema,
                requireSingle: { type: 'boolean', default: false, description: 'Require exactly one filtered registry row before the output cap; no arbitrary first-class selection.' },
                filter: { type: 'string', description: 'Optional filter string to match component types or categories (case-insensitive substring match).' },
                filterMatch: { type: 'string', enum: ['contains', 'exact', 'prefix', 'suffix'], default: 'contains', description: 'Literal matching against registry type, or name when type is absent; requires a nonempty filter. Uses filterCaseSensitive.' },
                filterCaseSensitive: { type: 'boolean', default: false, description: 'Case-sensitive class filtering; requires a nonblank filter.' },
                limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200, description: 'Maximum component types to return.' }
            }
        },
        { type: 'object', properties: { registrations: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: ['string', 'null'] }, assetUuid: { type: ['string', 'null'] } }, required: ['name', 'type', 'assetUuid'] } }, componentTypes: { type: 'array', items: { type: 'string' } }, total: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['registrations', 'componentTypes', 'total', 'truncated'] }, "GET", ['scene', 'node', 'component', 'types', 'inspection']
    )
    async nodeGetAvailableComponentTypes(args: { includeInternal?: boolean, scriptReference?: IInstanceReference, requireSingle?: boolean, filter?: string, filterMatch?: 'contains' | 'exact' | 'prefix' | 'suffix', filterCaseSensitive?: boolean, limit?: number } = {}): Promise<{ registrations: Array<{ name: string, type: string | null, assetUuid: string | null }>, componentTypes: string[], total: number, truncated: boolean }> {
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 1000)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Component discovery limit must be an integer from 1 to 1000.', details: { field: 'limit' } });
        if (args.filter !== undefined && typeof args.filter !== 'string') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Component discovery filter must be a string.', details: { field: 'filter' } });
        if (args.includeInternal !== undefined && typeof args.includeInternal !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'includeInternal must be a boolean.', details: { field: 'includeInternal' } });
        if (args.scriptReference !== undefined && (typeof args.scriptReference?.id !== 'string' || !args.scriptReference.id.trim() || args.scriptReference.id.length > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'scriptReference requires a bounded exact script asset UUID.' });
        if (args.requireSingle !== undefined && typeof args.requireSingle !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireSingle must be boolean.' });
        if (args.filterMatch !== undefined && (typeof args.filter !== 'string' || !args.filter.trim() || !['contains', 'exact', 'prefix', 'suffix'].includes(args.filterMatch))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'filterMatch requires a nonempty filter and contains/exact/prefix/suffix.' });
        if (args.filterCaseSensitive !== undefined && (typeof args.filterCaseSensitive !== 'boolean' || typeof args.filter !== 'string' || !args.filter.trim())) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'filterCaseSensitive requires a boolean and a nonblank filter.' });
        const allComponents = await Editor.Message.request('scene', 'query-components');

        if (!Array.isArray(allComponents)) {
            throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator did not return a component registry array.', details: { field: 'componentRegistry' } });
        }
        for (const [registryIndex, component] of allComponents.entries()) {
            const invalidFields: string[] = [];
            if (!component || typeof component !== 'object' || Array.isArray(component)) invalidFields.push('entry');
            else {
                if (typeof component.name !== 'string' || !component.name.trim()) invalidFields.push('name');
                if ('type' in component && (typeof component.type !== 'string' || !component.type.trim())) invalidFields.push('type');
                if (component.assetUuid !== undefined && component.assetUuid !== null && typeof component.assetUuid !== 'string') invalidFields.push('assetUuid');
            }
            if (invalidFields.length) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Component registry contains malformed class metadata.', details: { registryIndex, invalidFields } });
        }

        const filterNeedle = args.filterCaseSensitive ? args.filter : args.filter?.toLowerCase();
        const filtered = allComponents.filter((comp: any) => {
            if (args.scriptReference && comp.assetUuid !== args.scriptReference.id) return false;
            let matchesFilter = true;
            if (filterNeedle) {
                const rawCandidate = comp.type ?? comp.name;
                const candidate = args.filterCaseSensitive ? rawCandidate : rawCandidate.toLowerCase();
                matchesFilter = args.filterMatch === 'exact' ? candidate === filterNeedle : args.filterMatch === 'prefix' ? candidate.startsWith(filterNeedle) : args.filterMatch === 'suffix' ? candidate.endsWith(filterNeedle) : candidate.includes(filterNeedle);
            }
            if (!args.includeInternal) {
                matchesFilter = matchesFilter && comp.assetUuid && comp.assetUuid.length > 0;
            }
            return matchesFilter;
        });

        if (args.requireSingle && filtered.length !== 1) throw new ToolError({ code: filtered.length ? 'COMPONENT_CLASS_MATCH_AMBIGUOUS' : 'COMPONENT_CLASS_MATCH_NOT_FOUND', status: filtered.length ? 409 : 404, message: 'Component class discovery requires exactly one filtered registry row.', details: { matchCount: filtered.length } });
        const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);

        const registrations: Array<{ name: string, type: string | null, assetUuid: string | null }> = filtered.slice(0, limit).map((comp: any) => ({ name: comp.name, type: comp.type ?? null, assetUuid: comp.assetUuid ?? null }));
        return { registrations, componentTypes: registrations.map(row => row.name), total: filtered.length, truncated: filtered.length > limit };
    }

    @utcpTool(
        'nodeComponentsGet',
        'Inspect exact component identities on one node; optional single class or OR class list and bounded offset/limit. Entire inventory validates before filtering/paging; pages are observations, not atomic snapshots.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                componentReference: InstanceReferenceSchema,
                componentIndex: { type: 'integer', minimum: 0, maximum: 9999, description: 'Zero-based full serialized inventory index, not filtered/page position. Re-read UUID before mutation.' },
                componentType: { type: 'string', minLength: 1, maxLength: 256 },
                componentTypes: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 } },
                excludeComponentTypes: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 } },
                offset: { type: 'integer', minimum: 0, maximum: 10000 },
                enabled: { type: 'boolean', description: 'Exact serialized component enabled flag; not runtime activation.' },
                requireSingle: { type: 'boolean', default: false, description: 'Require exactly one complete filtered match before pagination; offset must be0.' },
                requireMatch: { type: 'boolean', default: false, description: 'Require at least one complete filtered match, independently of the requested page.' },
                limit: { type: 'integer', minimum: 1, maximum: 1000 },
                expectedRevision: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Revision from a previous page; refuses changed inventory or class selectors.' },
            },
            required: ['reference']
        },
        { type: 'object', properties: { references: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string' }, componentIndex: { type: 'integer', minimum: 0 }, enabled: { type: 'boolean' } }, required: ['id', 'componentIndex'] } }, inventorySummary: { type: 'object', properties: { total: { type: 'integer' }, enabled: { type: 'integer' }, disabled: { type: 'integer' }, unknownEnabled: { type: 'integer' }, classCounts: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 } } }, required: ['total', 'enabled', 'disabled', 'unknownEnabled', 'classCounts'] }, total: { type: 'integer' }, offset: { type: 'integer' }, nextOffset: { type: ['integer', 'null'] }, truncated: { type: 'boolean' }, revision: { type: 'string' } }, required: ['references', 'inventorySummary', 'total', 'offset', 'nextOffset', 'truncated', 'revision'] }, 'GET', ['scene', 'node', 'component', 'get', 'inspection']
    )
    async nodeComponentsGet(args: { reference: IInstanceReference, componentReference?: IInstanceReference, componentIndex?: number, componentType?: string, componentTypes?: string[], excludeComponentTypes?: string[], enabled?: boolean, requireSingle?: boolean, requireMatch?: boolean, offset?: number, limit?: number, expectedRevision?: string }): Promise<{ references: Array<IInstanceReference & { componentIndex: number, enabled?: boolean }>, inventorySummary: { total: number, enabled: number, disabled: number, unknownEnabled: number, classCounts: Record<string, number> }, total: number, offset: number, nextOffset: number | null, truncated: boolean, revision: string }> {
        if (args.expectedRevision !== undefined && (typeof args.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedRevision))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedRevision requires a SHA256 revision token.' });
        if (args.componentReference !== undefined && (typeof args.componentReference?.id !== 'string' || !args.componentReference.id.trim() || args.componentReference.id.length > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'componentReference requires a bounded exact component UUID.' });
        if (args.componentIndex !== undefined && (!Number.isInteger(args.componentIndex) || args.componentIndex < 0 || args.componentIndex > 9999)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'componentIndex requires an integer0..9999.' });
        if (args.componentType !== undefined && args.componentTypes !== undefined) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Choose componentType or componentTypes, not both.' });
        const types = args.componentTypes ?? (args.componentType !== undefined ? [args.componentType] : undefined);
        if (types !== undefined && (!Array.isArray(types) || types.length < 1 || types.length > 32 || types.some(type => typeof type !== 'string' || !type.trim() || type.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Component class selectors require1..32 bounded names.' });
        if (args.excludeComponentTypes !== undefined && (!Array.isArray(args.excludeComponentTypes) || args.excludeComponentTypes.length < 1 || args.excludeComponentTypes.length > 32 || args.excludeComponentTypes.some(type => typeof type !== 'string' || !type.trim() || type.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'excludeComponentTypes requires1..32 bounded class names.' });
        for (const list of [types, args.excludeComponentTypes]) if (list !== undefined) {
            for (const type of list) if (typeof type !== 'string' || !type.trim() || type.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Component class selectors require bounded names without missing entries.' });
        }
        const excludedTypes = new Set(args.excludeComponentTypes?.map(type => type.replace(/^cc\./, '')));
        if (args.enabled !== undefined && typeof args.enabled !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'enabled must be a boolean serialized component selector.' });
        const offset = args.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 1000)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'offset must be0..10000 and limit1..1000.' });
        if (args.requireSingle !== undefined && typeof args.requireSingle !== 'boolean' || args.requireSingle === true && offset !== 0) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireSingle must be boolean and requires offset0.' });
        if (args.requireMatch !== undefined && typeof args.requireMatch !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireMatch must be boolean.' });
        const selectedTypes = types ? new Set(types.map(type => type.replace(/^cc\./, ''))) : undefined;
        if (typeof args.reference?.id !== 'string' || !args.reference.id.trim() || args.reference.id.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'reference requires a bounded exact node UUID.' });
        const node = await Editor.Message.request('scene', 'query-node', args.reference.id);
        if (node === null || node === undefined) throw new ToolError({ code: 'COMPONENT_NODE_NOT_FOUND', status: 404, message: `Node ${args.reference.id} not found`, details: { nodeId: args.reference.id } });
        const nodeUuid = field(node, 'uuid');
        const observedNodeId = typeof nodeUuid === 'string' ? nodeUuid : field(nodeUuid, 'value');
        if (observedNodeId !== args.reference.id) throw new ToolError({ code: 'COMPONENT_NODE_IDENTITY_MISMATCH', status: 502, message: 'Component inventory node identity does not match the requested target.', details: { requestedNodeId: args.reference.id, observedNodeId: typeof observedNodeId === 'string' ? observedNodeId : null } });

        if (!Array.isArray(node.__comps__)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Node dump lacks a serialized component array.', details: { nodeId: args.reference.id, field: '__comps__' } });
        const components = node.__comps__;
        if (components.length > VERBOSE_TREE_NODES) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 413, message: 'Serialized component inventory exceeds the inspection budget.', details: { nodeId: args.reference.id, componentCount: components.length, maximum: VERBOSE_TREE_NODES } });
        const identities = new Map<string, number>();
        const foundComponents: Array<IInstanceReference & { componentIndex: number, enabled?: boolean }> = [];
        const inventory: Array<{ id: string, type: string, enabled?: boolean }> = [];
        const inventorySummary = { total: components.length, enabled: 0, disabled: 0, unknownEnabled: 0, classCounts: Object.create(null) as Record<string, number> };
        for (const [componentIndex, comp] of components.entries()) {
            const value = field(comp, 'value');
            const uuidValue = field(value, 'uuid');
            const nestedUuid = field(uuidValue, 'value');
            const rawType = field(comp, 'type')
                ?? nestedField(value, '__type__', 'value') ?? field(value, '__type__')
                ?? field(comp, 'cid') ?? field(value, 'cid');
            const compUuid = typeof uuidValue === 'string'
                ? uuidValue
                : typeof nestedUuid === 'string' ? nestedUuid : field(comp, 'uuid');
            const declaredType = typeof rawType === 'string' ? rawType : undefined;
            if (typeof compUuid !== 'string' || !compUuid.trim() || !declaredType?.trim()) {
                throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Serialized component entry lacks authoritative UUID or class identity.', details: { nodeId: args.reference.id, componentIndex, missingUuid: typeof compUuid !== 'string' || !compUuid.trim(), missingType: !declaredType?.trim() } });
            }
            if (identities.has(compUuid)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Duplicate component UUID in serialized inventory.', details: { nodeId: args.reference.id, componentId: compUuid, firstComponentIndex: identities.get(compUuid)!, componentIndex } });
            identities.set(compUuid, componentIndex);
            inventorySummary.classCounts[declaredType] = (inventorySummary.classCounts[declaredType] ?? 0) + 1;
            const enabledField = field(comp, 'enabled') ?? field(value, 'enabled');
            const rawEnabled = typeof enabledField === 'boolean' ? enabledField : field(enabledField, 'value');
            if (rawEnabled === true) inventorySummary.enabled++;
            else if (rawEnabled === false) inventorySummary.disabled++;
            else inventorySummary.unknownEnabled++;
            if (args.enabled !== undefined && typeof rawEnabled !== 'boolean') throw new ToolError({ code: 'COMPONENT_STATE_UNAVAILABLE', status: 422, message: 'Serialized enabled state is unavailable; no enabled-filtered result returned.', details: { nodeId: args.reference.id, componentId: compUuid, componentIndex } });
            inventory.push({ id: compUuid, type: declaredType, ...(typeof rawEnabled === 'boolean' ? { enabled: rawEnabled } : {}) });
            if ((args.componentIndex === undefined || componentIndex === args.componentIndex) && (args.componentReference === undefined || compUuid === args.componentReference.id) && !excludedTypes.has(declaredType.replace(/^cc\./, '')) && (!selectedTypes || selectedTypes.has(declaredType.replace(/^cc\./, ''))) && (args.enabled === undefined || rawEnabled === args.enabled)) {
                foundComponents.push({ id: compUuid, type: declaredType, componentIndex, ...(typeof rawEnabled === 'boolean' ? { enabled: rawEnabled } : {}) });
            }
        }

        const revision = createHash('sha256').update(JSON.stringify({ node: args.reference.id, inventory, selector: { excludedTypes: [...excludedTypes].sort(), componentId: args.componentReference?.id ?? null, types: args.componentType !== undefined ? ['single', args.componentType.replace(/^cc\./, '')] : selectedTypes ? ['multi', [...selectedTypes].sort()] : ['all'], enabled: args.enabled ?? null, ...(args.componentIndex !== undefined ? { componentIndex: args.componentIndex } : {}) } })).digest('hex');
        if (args.expectedRevision !== undefined && args.expectedRevision !== revision) throw new ToolError({ code: 'COMPONENT_INVENTORY_CHANGED', status: 409, message: 'Component inventory or selector changed; restart pagination from a fresh observation.', details: { nodeId: args.reference.id, expectedRevision: args.expectedRevision, observedRevision: revision } });
        if (args.componentReference !== undefined && !identities.has(args.componentReference.id)) throw new ToolError({ code: 'COMPONENT_NOT_ATTACHED', status: 404, message: 'The exact component UUID is not attached to the requested node.', details: { nodeId: args.reference.id, componentId: args.componentReference.id } });
        if (args.requireSingle && foundComponents.length !== 1) throw new ToolError({ code: foundComponents.length ? 'COMPONENT_MATCH_AMBIGUOUS' : 'COMPONENT_MATCH_NOT_FOUND', status: foundComponents.length ? 409 : 404, message: 'Single-component lookup requires exactly one filtered match.', details: { nodeId: args.reference.id, matchCount: foundComponents.length } });
        if (!foundComponents.length && args.componentType) throw new ToolError({ code: 'COMPONENT_MATCH_NOT_FOUND', status: 404, message: `Components of type ${args.componentType} not found on node ${args.reference.id}`, details: { nodeId: args.reference.id, componentType: args.componentType, matchCount: 0 } });
        if (args.requireMatch && !foundComponents.length) throw new ToolError({ code: 'COMPONENT_MATCH_NOT_FOUND', status: 404, message: 'Component presence check requires at least one filtered match.', details: { nodeId: args.reference.id, matchCount: 0 } });
        if (offset > foundComponents.length) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'offset exceeds the observed filtered inventory.', details: { nodeId: args.reference.id, offset, matchCount: foundComponents.length } });
        const references = foundComponents.slice(offset, args.limit === undefined ? undefined : offset + args.limit);
        const next = offset + references.length;
        return { references, inventorySummary, total: foundComponents.length, offset, nextOffset: next < foundComponents.length ? next : null, truncated: next < foundComponents.length, revision };
    }

    @utcpTool(
        'nodeComponentsBatchGet',
        'Inspect component inventories on1..32 exact nodes sequentially with per-item errors. Class selectors use OR; each result carries its own revision. No writes or atomic cross-node snapshot.',
        { type: 'object', additionalProperties: false, properties: {
            references: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema },
            expectedRevisions: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, revision: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['reference', 'revision'] }, description: 'Optional revisions keyed by exact requested node UUID; omitted nodes are unguarded.' },
            requireRevisions: { type: 'boolean', default: false, description: 'Require a valid expected revision for every requested node before any query. Does not make reads atomic.' },
            offsets: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, offset: { type: 'integer', minimum: 0, maximum: 10000 } }, required: ['reference', 'offset'] } },
            componentTypes: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 } },
            excludeComponentTypes: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 } },
            requiredComponentTypes: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 }, description: 'Require every listed class in the full inventory before detail filters; optional cc. prefix normalization, no inheritance inference.' },
            forbiddenComponentTypes: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 }, description: 'Refuse listed classes present in the full inventory, independently of detail filters; optional cc. prefix normalization.' },
            allowedComponentTypes: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 }, description: 'Only these normalized classes may occur in the full inventory; empty allows no components.' },
            singletonComponentTypes: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 }, description: 'Require at most one instance per listed normalized class in the full inventory; absence is allowed.' },
            minComponents: { type: 'integer', minimum: 0, maximum: 10000, description: 'Minimum full inventory size, independent of detail filters and paging.' },
            maxComponents: { type: 'integer', minimum: 0, maximum: 10000, description: 'Maximum full inventory size, independent of detail filters and paging.' },
            enabled: { type: 'boolean', description: 'Exact serialized enabled selector shared by every node.' },
            requireSingle: { type: 'boolean', default: false, description: 'Require exactly one filtered match on each node; cardinality failures remain per-item.' },
            requireMatch: { type: 'boolean', default: false, description: 'Require at least one complete filtered match per node, independently of pagination. Multiple matches are allowed unless requireSingle is set.' },
            summaryOnly: { type: 'boolean', default: false, description: 'Omit component reference pages; retain full summaries, filtered totals, revisions and per-node errors.' },
            requireAll: { type: 'boolean', default: false, description: 'Refuse any per-node failure after collecting all outcomes; does not require every component detail page.' },
            limitPerNode: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        }, required: ['references'] },
        { type: 'object', properties: { items: { type: 'array' }, errorCounts: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 } }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' }, inventorySummary: { type: 'object', properties: { observedNodes: { type: 'integer' }, failedNodes: { type: 'integer' }, matchedNodes: { type: 'integer' }, unmatchedNodes: { type: 'integer' }, matchedComponents: { type: 'integer' }, total: { type: 'integer' }, enabled: { type: 'integer' }, disabled: { type: 'integer' }, unknownEnabled: { type: 'integer' }, classDistribution: { type: 'object', additionalProperties: { type: 'object', properties: { instances: { type: 'integer', minimum: 1 }, nodes: { type: 'integer', minimum: 1 } }, required: ['instances', 'nodes'] } } }, required: ['observedNodes', 'failedNodes', 'matchedNodes', 'unmatchedNodes', 'matchedComponents', 'total', 'enabled', 'disabled', 'unknownEnabled', 'classDistribution'] } }, required: ['errorCounts', 'items', 'succeeded', 'failed', 'truncated', 'inventorySummary'] },
        'GET', ['scene', 'node', 'component', 'batch', 'inspection']
    )
    async nodeComponentsBatchGet(args: { references: IInstanceReference[], offsets?: Array<{ reference: IInstanceReference, offset: number }>, expectedRevisions?: Array<{ reference: IInstanceReference, revision: string }>, requireRevisions?: boolean, componentTypes?: string[], excludeComponentTypes?: string[], requiredComponentTypes?: string[], forbiddenComponentTypes?: string[], allowedComponentTypes?: string[], singletonComponentTypes?: string[], minComponents?: number, maxComponents?: number, enabled?: boolean, requireSingle?: boolean, requireMatch?: boolean, summaryOnly?: boolean, requireAll?: boolean, limitPerNode?: number }): Promise<{ items: Array<Record<string, unknown>>, errorCounts: Record<string, number>, succeeded: number, failed: number, truncated: boolean, inventorySummary: { observedNodes: number, failedNodes: number, matchedNodes: number, unmatchedNodes: number, matchedComponents: number, total: number, enabled: number, disabled: number, unknownEnabled: number, classDistribution: Record<string, { instances: number, nodes: number }> } }> {
        if (args.enabled !== undefined && typeof args.enabled !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'enabled must be a boolean serialized component selector.' });
        if (args.requireSingle !== undefined && typeof args.requireSingle !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireSingle must be boolean.' });
        if (args.requireMatch !== undefined && typeof args.requireMatch !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireMatch must be boolean.' });
        if (args.summaryOnly !== undefined && typeof args.summaryOnly !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'summaryOnly must be boolean.' });
        if (args.requireAll !== undefined && typeof args.requireAll !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireAll must be boolean.' });
        if (args.requireRevisions !== undefined && typeof args.requireRevisions !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireRevisions must be boolean.' });
        if (args.minComponents !== undefined && (!Number.isInteger(args.minComponents) || args.minComponents < 0 || args.minComponents > 10000) || args.maxComponents !== undefined && (!Number.isInteger(args.maxComponents) || args.maxComponents < 0 || args.maxComponents > 10000) || args.minComponents !== undefined && args.maxComponents !== undefined && args.minComponents > args.maxComponents) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Component inventory bounds require integers0..10000 with minComponents<=maxComponents.' });
        if (args.requiredComponentTypes !== undefined && (!Array.isArray(args.requiredComponentTypes) || args.requiredComponentTypes.length < 1 || args.requiredComponentTypes.length > 32 || args.requiredComponentTypes.some(type => typeof type !== 'string' || !type.trim() || type.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requiredComponentTypes requires1..32 bounded class names.' });
        if (args.forbiddenComponentTypes !== undefined && (!Array.isArray(args.forbiddenComponentTypes) || args.forbiddenComponentTypes.length < 1 || args.forbiddenComponentTypes.length > 32 || args.forbiddenComponentTypes.some(type => typeof type !== 'string' || !type.trim() || type.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'forbiddenComponentTypes requires1..32 bounded class names.' });
        if (args.singletonComponentTypes !== undefined && (!Array.isArray(args.singletonComponentTypes) || args.singletonComponentTypes.length < 1 || args.singletonComponentTypes.length > 32 || args.singletonComponentTypes.some(type => typeof type !== 'string' || !type.trim() || type.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'singletonComponentTypes requires1..32 bounded class names.' });
        if (args.allowedComponentTypes !== undefined && (!Array.isArray(args.allowedComponentTypes) || args.allowedComponentTypes.length > 32 || args.allowedComponentTypes.some(type => typeof type !== 'string' || !type.trim() || type.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'allowedComponentTypes requires0..32 bounded class names.' });
        if (!Array.isArray(args?.references) || args.references.length < 1 || args.references.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references requires1..32 bounded node UUIDs.' });
        for (const reference of args.references) if (typeof reference?.id !== 'string' || !reference.id.trim() || reference.id.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references requires bounded node UUIDs without missing entries.' });
        if (args.componentTypes !== undefined && (!Array.isArray(args.componentTypes) || args.componentTypes.length < 1 || args.componentTypes.length > 32 || args.componentTypes.some(type => typeof type !== 'string' || !type.trim() || type.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'componentTypes requires1..32 bounded class names.' });
        if (args.excludeComponentTypes !== undefined && (!Array.isArray(args.excludeComponentTypes) || args.excludeComponentTypes.length < 1 || args.excludeComponentTypes.length > 32 || args.excludeComponentTypes.some(type => typeof type !== 'string' || !type.trim() || type.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'excludeComponentTypes requires1..32 bounded class names.' });
        for (const list of [args.componentTypes, args.excludeComponentTypes, args.requiredComponentTypes, args.forbiddenComponentTypes, args.singletonComponentTypes, args.allowedComponentTypes]) if (list !== undefined) {
            for (const type of list) if (typeof type !== 'string' || !type.trim() || type.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Component class selectors require bounded names without missing entries.' });
        }
        const limit = args.limitPerNode ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'limitPerNode must be1..100.' });
        const references = args.references.map(reference => ({ id: reference.id }));
        if (new Set(references.map(reference => reference.id)).size !== references.length) {
            const positions = new Map<string, number[]>();
            for (const [index, reference] of references.entries()) {
                const indices = positions.get(reference.id);
                if (indices) indices.push(index);
                else positions.set(reference.id, [index]);
            }
            const duplicates = [...positions].filter(([, indices]) => indices.length > 1).map(([id, indices]) => ({ reference: { id }, indices }));
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Batch node UUIDs must be unique to avoid double-counting inventory.', details: { duplicates } });
        }
        const expectedRevisions = new Map<string, string>();
        const requestedIds = new Set(references.map(reference => reference.id));
        if (args.expectedRevisions !== undefined) {
            if (!Array.isArray(args.expectedRevisions) || args.expectedRevisions.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedRevisions requires at most32 node-bound revisions.' });
            for (const entry of args.expectedRevisions) {
                const id = entry?.reference?.id;
                if (typeof id !== 'string' || !requestedIds.has(id) || expectedRevisions.has(id) || typeof entry.revision !== 'string' || !/^[a-f0-9]{64}$/.test(entry.revision)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Revision entries must be unique, valid and bound to requested node UUIDs.' });
                expectedRevisions.set(id, entry.revision);
            }
        }
        if (args.requireRevisions && expectedRevisions.size !== references.length) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireRevisions requires an expected revision for every requested node UUID.', details: { missingRevisionGuardIds: references.filter(reference => !expectedRevisions.has(reference.id)).map(reference => reference.id) } });
        const offsets = new Map<string, number>();
        if (args.offsets !== undefined) {
            if (!Array.isArray(args.offsets) || args.offsets.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'offsets accepts at most32 node-bound entries.' });
            for (const entry of args.offsets) {
                const id = entry?.reference?.id;
                if (typeof id !== 'string' || !requestedIds.has(id) || offsets.has(id) || !Number.isInteger(entry.offset) || entry.offset < 0 || entry.offset > 10000 || args.requireSingle && entry.offset !== 0) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Offsets require unique requested UUIDs and integers0..10000; requireSingle requires offset0.' });
                offsets.set(id, entry.offset);
            }
        }
        const componentTypes = args.componentTypes?.slice();
        const excludeComponentTypes = args.excludeComponentTypes?.slice();
        const items: Array<Record<string, unknown>> = [];
        const requiredComponentTypes = new Set(args.requiredComponentTypes?.map(type => type.replace(/^cc\./, '')));
        const forbiddenComponentTypes = new Set(args.forbiddenComponentTypes?.map(type => type.replace(/^cc\./, '')));
        const singletonComponentTypes = new Set(args.singletonComponentTypes?.map(type => type.replace(/^cc\./, '')));
        const allowedComponentTypes = args.allowedComponentTypes === undefined ? undefined : new Set(args.allowedComponentTypes.map(type => type.replace(/^cc\./, '')));
        const conflictingTypes = [...requiredComponentTypes].filter(type => forbiddenComponentTypes.has(type) || allowedComponentTypes !== undefined && !allowedComponentTypes.has(type));
        if (conflictingTypes.length) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Required component classes cannot be forbidden or outside the allowed set.', details: { conflictingComponentTypes: conflictingTypes } });
        let succeeded = 0, truncated = false;
        const errorCounts: Record<string, number> = Object.create(null);
        const inventorySummary = { observedNodes: 0, failedNodes: 0, matchedNodes: 0, unmatchedNodes: 0, matchedComponents: 0, total: 0, enabled: 0, disabled: 0, unknownEnabled: 0, classDistribution: Object.create(null) as Record<string, { instances: number, nodes: number }> };
        for (const [index, reference] of references.entries()) {
            let missingComponentTypes: string[] | undefined;
            let forbiddenTypesPresent: string[] | undefined;
            let forbiddenComponentCounts: Record<string, number> | undefined;
            let duplicateComponentCounts: Record<string, number> | undefined;
            let unexpectedComponentCounts: Record<string, number> | undefined;
            let componentCountViolation: { componentCount: number, minComponents?: number, maxComponents?: number } | undefined;
            let observedRevision: string | undefined;
            let observedSummary: { total: number, enabled: number, disabled: number, unknownEnabled: number, classCounts: Record<string, number> } | undefined;
            try {
                const result = await this.nodeComponentsGet({ reference, offset: offsets.get(reference.id) ?? 0, expectedRevision: expectedRevisions.get(reference.id), componentTypes, excludeComponentTypes, enabled: args.enabled, requireSingle: args.requireSingle, limit });
                observedRevision = result.revision;
                observedSummary = result.inventorySummary;
                if (args.minComponents !== undefined && result.inventorySummary.total < args.minComponents || args.maxComponents !== undefined && result.inventorySummary.total > args.maxComponents) componentCountViolation = { componentCount: result.inventorySummary.total, ...(args.minComponents !== undefined ? { minComponents: args.minComponents } : {}), ...(args.maxComponents !== undefined ? { maxComponents: args.maxComponents } : {}) };
                if (requiredComponentTypes.size || forbiddenComponentTypes.size || singletonComponentTypes.size || allowedComponentTypes !== undefined) {
                    const observedCounts = new Map<string, number>();
                    for (const [type, count] of Object.entries(result.inventorySummary.classCounts)) {
                        const normalized = type.replace(/^cc\./, '');
                        observedCounts.set(normalized, (observedCounts.get(normalized) ?? 0) + count);
                    }
                    const missingTypes = [...requiredComponentTypes].filter(type => !observedCounts.has(type));
                    const presentTypes = [...forbiddenComponentTypes].filter(type => observedCounts.has(type));
                    if (missingTypes.length) missingComponentTypes = missingTypes;
                    if (presentTypes.length) {
                        forbiddenTypesPresent = presentTypes;
                        forbiddenComponentCounts = Object.fromEntries(presentTypes.map(type => [type, observedCounts.get(type)!]));
                    }
                    const duplicateCounts = Object.fromEntries([...singletonComponentTypes].filter(type => (observedCounts.get(type) ?? 0) > 1).map(type => [type, observedCounts.get(type)!]));
                    if (Object.keys(duplicateCounts).length) duplicateComponentCounts = duplicateCounts;
                    if (allowedComponentTypes !== undefined) {
                        const unexpected = [...observedCounts].filter(([type]) => !allowedComponentTypes.has(type));
                        if (unexpected.length) unexpectedComponentCounts = Object.fromEntries(unexpected);
                    }
                    if (missingTypes.length) throw new ToolError({ code: 'COMPONENT_COMPOSITION_INCOMPLETE', status: 422, message: `Missing required component classes: ${missingTypes.join(', ')}`, details: { nodeId: reference.id, missingTypes } });
                    if (presentTypes.length) throw new ToolError({ code: 'COMPONENT_COMPOSITION_FORBIDDEN', status: 422, message: `Forbidden component classes present: ${presentTypes.join(', ')}` });
                    if (unexpectedComponentCounts) throw new ToolError({ code: 'COMPONENT_COMPOSITION_UNEXPECTED', status: 422, message: 'Component classes outside the allowed inventory are present.', details: { nodeId: reference.id, unexpectedComponentCounts } });
                    if (duplicateComponentCounts) throw new ToolError({ code: 'COMPONENT_SINGLETON_VIOLATION', status: 422, message: 'Requested singleton classes have multiple serialized instances.', details: { nodeId: reference.id, duplicateComponentCounts } });
                }
                if (componentCountViolation) throw new ToolError({ code: 'COMPONENT_COUNT_OUT_OF_RANGE', status: 422, message: 'Full component inventory size is outside the required bounds.', details: { nodeId: reference.id, ...componentCountViolation } });
                if (args.requireMatch && result.total === 0) throw new ToolError({ code: 'COMPONENT_MATCH_NOT_FOUND', status: 404, message: 'Component presence check requires at least one filtered match.', details: { nodeId: reference.id, matchCount: 0 } });
                items.push({ index, ok: true, reference, result: args.summaryOnly ? { inventorySummary: result.inventorySummary, total: result.total, revision: result.revision, detailsOmitted: true } : result });
                succeeded++;
                if (!args.summaryOnly) truncated ||= result.truncated;
                inventorySummary.observedNodes++;
                if (result.total > 0) inventorySummary.matchedNodes++; else inventorySummary.unmatchedNodes++;
                inventorySummary.matchedComponents += result.total;
                inventorySummary.total += result.inventorySummary.total;
                inventorySummary.enabled += result.inventorySummary.enabled;
                inventorySummary.disabled += result.inventorySummary.disabled;
                inventorySummary.unknownEnabled += result.inventorySummary.unknownEnabled;
                for (const [type, count] of Object.entries(result.inventorySummary.classCounts)) {
                    const distribution = inventorySummary.classDistribution[type] ?? (inventorySummary.classDistribution[type] = { instances: 0, nodes: 0 });
                    distribution.instances += count;
                    distribution.nodes++;
                }
            } catch (error) {
                inventorySummary.failedNodes++;
                const code = error instanceof ToolError ? error.code : 'COMPONENT_QUERY_FAILED';
                errorCounts[code] = (errorCounts[code] ?? 0) + 1;
                const matchCount = error instanceof ToolError && (error.code === 'COMPONENT_MATCH_NOT_FOUND' || error.code === 'COMPONENT_MATCH_AMBIGUOUS') ? error.details?.matchCount : undefined;
                const stateIdentity = error instanceof ToolError && error.code === 'COMPONENT_STATE_UNAVAILABLE' ? error.details : undefined;
                const identityMismatch = error instanceof ToolError && error.code === 'COMPONENT_NODE_IDENTITY_MISMATCH' ? error.details : undefined;
                items.push({ index, ok: false, reference, error: { status: error instanceof ToolError ? error.status : 500, code, message: (error instanceof Error ? error.message : String(error)).slice(0, 512), ...(error instanceof ToolError && error.details ? { details: error.details } : {}), ...(identityMismatch ? { identityMismatch } : {}), ...(stateIdentity ? { stateIdentity } : {}), ...(typeof matchCount === 'number' && Number.isInteger(matchCount) && matchCount >= 0 ? { matchCount } : {}), ...(observedRevision ? { revision: observedRevision, inventorySummary: observedSummary } : {}), ...(unexpectedComponentCounts ? { unexpectedComponentCounts } : {}), ...(componentCountViolation ? { componentCountViolation } : {}), ...(duplicateComponentCounts ? { duplicateComponentCounts } : {}), ...(missingComponentTypes ? { missingComponentTypes } : {}), ...(forbiddenTypesPresent ? { forbiddenComponentTypes: forbiddenTypesPresent, forbiddenComponentCounts } : {}) } });
            }
        }
        const result = { items, errorCounts, succeeded, failed: references.length - succeeded, truncated, inventorySummary };
        if (args.requireAll && result.failed) throw new ToolError({ code: 'COMPONENT_GROUP_INCOMPLETE', status: 409, message: 'Not every requested component inventory succeeded; inspect retained per-node outcomes.', details: result });
        return result;
    }

    async nodeComponentRemove(args: { reference: IInstanceReference }): Promise<ISuccessIndicator> {
        if (!args?.reference || typeof args.reference.id !== 'string' || !args.reference.id.trim() || args.reference.id.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nodeComponentRemove requires a bounded nonempty component reference.id.' });
        const componentId = args.reference.id;
        let mutationPending = false;
        let removalConfirmed = false;
        try {
            const component = await Editor.Message.request('scene', 'query-component', componentId);
            if (component === null || component === undefined) throw new Error(`Component ${componentId} not found`);
            const beforeUuid = field(component, 'uuid') ?? field(field(component, 'value'), 'uuid');
            const normalizedBefore = typeof beforeUuid === 'string' ? beforeUuid : field(beforeUuid, 'value');
            if (normalizedBefore !== componentId) throw new ToolError({ code: 'COMPONENT_TARGET_CHANGED', status: 409, message: `Component ${componentId} identity could not be confirmed before removal.`, details: { retrySafe: false, restored: null } });
            mutationPending = true;
            const removed = await Editor.Message.request('scene', 'remove-component', { uuid: componentId });
            mutationPending = false;
            if (removed === false) throw new Error(`Creator refused removal of component ${componentId}`);
            const remaining = await Editor.Message.request('scene', 'query-component', componentId);
            if (remaining !== null && remaining !== undefined) throw new Error(`Component ${componentId} still exists after removal`);
            removalConfirmed = true;
            const snapshot: unknown = await Editor.Message.request('scene', 'snapshot');
            if (snapshot === false) throw new Error('Creator refused the removal undo snapshot.');
            return { success: true };
        } catch (error: unknown) {
            if (mutationPending) throw new ToolError({ code: 'COMPONENT_REMOVE_OUTCOME_UNKNOWN', status: 502, message: `Component ${componentId} removal was dispatched but its outcome is unknown.`, details: { componentId, retrySafe: false, restored: null, cause: error instanceof Error ? error.message : String(error) }, recovery: 'Inspect the component inventory before another removal; do not replay automatically.' });
            if (removalConfirmed) throw new ToolError({ code: 'COMPONENT_REMOVE_SNAPSHOT_UNCONFIRMED', status: 502, message: 'Component absence was confirmed but its undo snapshot was not confirmed.', details: { componentId, removed: true, snapshotConfirmed: false, retrySafe: false, cause: error instanceof Error ? error.message : String(error) }, recovery: 'Reconcile undo/snapshot state; do not repeat component removal.' });
            if (error instanceof ToolError) throw error;
            throw new ToolError({ code: 'COMPONENT_REMOVE_FAILED', status: 502, message: `Failed to remove component ${componentId}.`, details: { componentId, retrySafe: false, restored: null, cause: error instanceof Error ? error.message : String(error) }, recovery: 'Inspect the exact component identity before retrying.' });
        }
    }

    async nodeComponentAdd(args: { reference: IInstanceReference, componentType: string }): Promise<{ reference: IInstanceReference }> {
        if (!args?.reference || typeof args.reference.id !== 'string' || !args.reference.id.trim() || args.reference.id.length > 256 || typeof args.componentType !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(args.componentType)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nodeComponentAdd requires a bounded node reference and component class identifier.' });
        args = { reference: { id: args.reference.id, ...(args.reference.type === undefined ? {} : { type: args.reference.type }) }, componentType: args.componentType };
        const node = await Editor.Message.request('scene', 'query-node', args.reference.id);
        if (!node) throw new Error(`Node ${args.reference.id} not found`);
        const checkedComponents = (dump: unknown): unknown[] => {
            const uuid = field(dump, 'uuid');
            const components = field(dump, '__comps__');
            if ((typeof uuid === 'string' ? uuid : field(uuid, 'value')) !== args.reference.id || !Array.isArray(components) || components.length > VERBOSE_TREE_NODES) {
                throw new ToolError({ code: 'COMPONENT_CREATE_POSTCONDITION_UNKNOWN', status: 502, message: 'Component add node identity or bounded inventory could not be confirmed.', details: { nodeId: args.reference.id, retrySafe: false }, recovery: 'Inspect the exact node inventory before another mutation.' });
            }
            const identities = new Set<string>();
            for (const component of components) {
                const id = componentUuid(component);
                const type = componentType(component);
                if (!id?.trim() || !type?.trim() || identities.has(id)) throw new ToolError({ code: 'COMPONENT_CREATE_POSTCONDITION_UNKNOWN', status: 502, message: 'Component add inventory contains missing or duplicate identities.', details: { nodeId: args.reference.id, retrySafe: false }, recovery: 'Inspect the complete node inventory before another mutation.' });
                identities.add(id);
            }
            return components;
        };

        const componentUuid = (component: unknown): string | undefined => {
            if (!component || typeof component !== 'object') return undefined;
            const row = component as Record<string, unknown>;
            const value = row.value && typeof row.value === 'object' ? row.value as Record<string, unknown> : undefined;
            const uuid = value?.uuid;
            if (typeof uuid === 'string') return uuid;
            if (uuid && typeof uuid === 'object' && typeof (uuid as Record<string, unknown>).value === 'string') return (uuid as Record<string, unknown>).value as string;
            return typeof row.uuid === 'string' ? row.uuid : undefined;
        };
        const componentType = (component: unknown): string | undefined => {
            if (!component || typeof component !== 'object') return undefined;
            const row = component as Record<string, unknown>;
            if (typeof row.type === 'string') return row.type;
            const value = row.value && typeof row.value === 'object' ? row.value as Record<string, unknown> : undefined;
            const declared = value?.__type__;
            if (typeof declared === 'string') return declared;
            if (declared && typeof declared === 'object' && typeof (declared as Record<string, unknown>).value === 'string') return (declared as Record<string, unknown>).value as string;
            return typeof row.cid === 'string' ? row.cid : typeof value?.cid === 'string' ? value.cid : undefined;
        };
        const existingUuids = new Set<string>(checkedComponents(node).map(componentUuid).filter((id): id is string => !!id));

        let caughtLogs: string[] = [];
        let creationDispatched = false;
        let captureAcknowledged = false;
        const loggingOwner = randomUUID();
        const loggingSetupDeadline = Date.now() + 10000;
        try {
            const capture: unknown = await Editor.Message.request('scene', 'execute-scene-script', { name: packageJSON.name, method: 'startCatchLogging', args: [loggingOwner, loggingSetupDeadline] });
            if (field(capture, 'owner') !== loggingOwner || field(capture, 'active') !== true || field(capture, 'expiresAt') !== loggingSetupDeadline) throw new Error('Scene logging collector did not acknowledge this operation owner/deadline; reload matching extension modules.');
            captureAcknowledged = true;
            if (Date.now() >= loggingSetupDeadline) throw new Error('Logging setup completed after its deadline; creation was not dispatched.');
            try {
                creationDispatched = true;
                await Editor.Message.request('scene', 'create-component', { uuid: args.reference.id, component: args.componentType });
            } catch (error) {
                throw new ToolError({ code: 'COMPONENT_CREATE_OUTCOME_UNKNOWN', status: 502, message: 'Component creation dispatch failed; the mutation outcome must be reconciled.', details: { nodeId: args.reference.id, componentType: args.componentType, retrySafe: false, cause: error instanceof Error ? error.message : String(error) }, recovery: 'Inspect the exact node component inventory before another creation attempt; do not replay this mutation automatically.' });
            }
            const logs: unknown = await Editor.Message.request('scene', 'execute-scene-script', { name: packageJSON.name, method: 'stopCatchLogging', args: [loggingOwner] });
            if (!Array.isArray(logs) || logs.length > 128 || logs.some(log => typeof log !== 'string' || log.length > 2048)) throw new Error('Scene logging collector returned an invalid bounded log response.');
            caughtLogs = logs;
        } catch (error) {
            let cleanupFailed = true;
            try {
                const state: unknown = await Editor.Message.request('scene', 'execute-scene-script', { name: packageJSON.name, method: 'inspectCatchLogging', args: [loggingOwner] });
                if (field(state, 'active') === true && field(state, 'owned') === true && field(state, 'handlerCurrent') === true) {
                    await Editor.Message.request('scene', 'execute-scene-script', { name: packageJSON.name, method: 'stopCatchLogging', args: [loggingOwner] });
                    const after: unknown = await Editor.Message.request('scene', 'execute-scene-script', { name: packageJSON.name, method: 'inspectCatchLogging', args: [loggingOwner] });
                    cleanupFailed = field(after, 'active') !== false || field(after, 'owned') !== false || field(after, 'handlerCurrent') !== false;
                } else if (captureAcknowledged && field(state, 'active') === false && field(state, 'owned') === false && field(state, 'handlerCurrent') === false) {
                    cleanupFailed = false;
                }
            } catch { /* Unknown collector state never authorizes foreign cleanup or replay. */ }
            if (error instanceof ToolError && error.code === 'COMPONENT_CREATE_OUTCOME_UNKNOWN') {
                throw new ToolError({ code: error.code, status: error.status, message: error.message, details: { ...error.details, loggingCleanupFailed: cleanupFailed }, recovery: error.recovery });
            }
            if (!creationDispatched) throw new ToolError({ code: 'COMPONENT_LOGGING_SETUP_FAILED', status: 502, message: 'Component logging setup failed before creation; no component creation was dispatched.', details: { nodeId: args.reference.id, componentType: args.componentType, mutationDispatched: false, loggingCleanupFailed: cleanupFailed, retrySafe: !cleanupFailed, cause: error instanceof Error ? error.message : String(error) }, recovery: cleanupFailed ? 'Reconcile the logging collector before another operation.' : 'Inspect logging availability before retrying.' });
            throw new ToolError({ code: 'COMPONENT_CREATE_POSTCONDITION_UNKNOWN', status: 502, message: 'Component creation returned but logging completion failed; component state is unverified.', details: { nodeId: args.reference.id, componentType: args.componentType, retrySafe: false, loggingCleanupFailed: cleanupFailed }, recovery: 'Inspect the node component inventory before retrying; the component may already exist.' });
        }

        let acknowledgedComponentId: string | null = null;
        try {
        const nodeAfter = await Editor.Message.request('scene', 'query-node', args.reference.id);
        if (!nodeAfter) throw new Error(`nodeComponentAdd: node ${args.reference.id} disappeared after create-component`);
        const newComponents = checkedComponents(nodeAfter).filter((component: unknown) => {
            const id = componentUuid(component);
            return !!id && !existingUuids.has(id) && componentType(component) === args.componentType;
        });
        if (newComponents.length > 1) throw new ToolError({ code: 'COMPONENT_CREATE_AMBIGUOUS', status: 409, message: 'Multiple new components match the requested class; creation identity is ambiguous.', details: { nodeId: args.reference.id, componentType: args.componentType, retrySafe: false }, recovery: 'Inspect the exact node inventory; do not retry creation or remove unowned components automatically.' });
        const newComponent = newComponents[0];
        const newId = componentUuid(newComponent);
        acknowledgedComponentId = newId ?? null;
        if (!newId) throw new ToolError({ code: 'COMPONENT_CREATE_POSTCONDITION_UNKNOWN', status: 502, message: 'Creation returned without a uniquely observed new component.', details: { nodeId: args.reference.id, componentType: args.componentType, retrySafe: false, logs: caughtLogs }, recovery: 'Inspect the node inventory; do not repeat creation automatically.' });

        const snapshot: unknown = await Editor.Message.request('scene', 'snapshot');
        if (snapshot === false) throw new ToolError({ code: 'COMPONENT_CREATE_SNAPSHOT_UNCONFIRMED', status: 502, message: 'A new component was observed but Creator refused its undo snapshot.', details: { nodeId: args.reference.id, componentId: newId, componentType: args.componentType, snapshotConfirmed: false, retrySafe: false }, recovery: 'Inspect the existing component and undo state; do not repeat creation.' });
        const verifiedNode = await Editor.Message.request('scene', 'query-node', args.reference.id);
        const verifiedMatches = checkedComponents(verifiedNode).filter((component: unknown) => componentUuid(component) === newId);
        if (verifiedMatches.length !== 1 || componentType(verifiedMatches[0]) !== args.componentType) throw new ToolError({ code: 'COMPONENT_CREATE_POSTCONDITION_UNKNOWN', status: 502, message: 'Added component UUID/type was not uniquely confirmed after snapshot.', details: { nodeId: args.reference.id, componentId: newId, componentType: args.componentType, retrySafe: false }, recovery: 'Inspect the node inventory before any further mutation.' });
        return { reference: { id: newId, type: args.componentType } };
        } catch (error) {
            throw new ToolError({ code: error instanceof ToolError ? error.code : 'COMPONENT_CREATE_POSTCONDITION_UNKNOWN', status: error instanceof ToolError ? error.status : 502, message: error instanceof ToolError ? error.message : 'Component creation returned but subsequent observation or snapshot failed.', details: { ...(error instanceof ToolError ? error.details : {}), nodeId: args.reference.id, componentType: args.componentType, componentId: acknowledgedComponentId, retrySafe: false, restored: null, cause: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) }, recovery: 'Inspect the exact node and any acknowledged component before another mutation; no creation replay or component deletion was attempted.' });
        }
    }

    @utcpTool(
        'addComponent',
        'Alias for bounded node component creation with authoritative UUID/type read-back.',
        { type: 'object', properties: { reference: InstanceReferenceSchema, componentType: { type: 'string' } }, required: ['reference', 'componentType'] },
        { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] },
        'POST', ['scene', 'node', 'component', 'add']
    )
    async addComponent(args: { reference: IInstanceReference, componentType: string }): Promise<{ reference: IInstanceReference }> {
        return this.nodeComponentAdd(args);
    }
}
