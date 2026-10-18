import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { InstanceReferenceSchema, IInstanceReference } from '../schemas';
import { UiTools } from './ui-tools';
import { AssetTools } from './asset-tools';

import { installVirtualListRuntime } from '../utils/ui-virtual-list-runtime';
import { installFormValidationRuntime } from '../utils/ui-form-validation-runtime';
const MAX_VISIBLE_ITEMS = 20;

export class PortfolioCompletionTools {
    @utcpTool('assetSceneUsageAudit', 'Audit bounded scene-root reachability using Creator asset graph v4 evidence.', {
        type: 'object', additionalProperties: false,
        properties: {
            assetPath: { type: 'string', minLength: 1, maxLength: 256 },
            maxAssets: { type: 'integer', minimum: 1, maximum: 128, default: 64 },
            maxGraphAssets: { type: 'integer', minimum: 1, maximum: 5000, default: 5000 },
            sceneReferences: { type: 'array', minItems: 1, maxItems: 128, items: InstanceReferenceSchema },
        },
    }, {
        type: 'object', properties: {
            graphVersion: { type: 'string' }, complete: { type: 'boolean' }, roots: { type: 'array' },
            graphAssets: { type: 'integer' }, graphEdges: { type: 'integer' }, candidates: { type: 'array' },
            referenceEvidence: { type: 'array' }, dynamicLoadCaveat: { type: 'string' },
        }, required: ['graphVersion', 'complete', 'roots', 'graphAssets', 'graphEdges', 'candidates', 'referenceEvidence', 'dynamicLoadCaveat'],
    }, 'GET', ['asset', 'scene', 'usage', 'audit'])
    async assetSceneUsageAudit(args: { assetPath?: string, maxAssets?: number, maxGraphAssets?: number, sceneReferences?: IInstanceReference[] } = {}): Promise<Record<string, unknown>> {
        const result = await new AssetTools().assetUsageAnalyze({
            assetPath: args.assetPath,
            maxAssets: args.maxAssets,
            maxGraphAssets: args.maxGraphAssets,
            rootReferences: args.sceneReferences,
        });
        return result;
    }


    @utcpTool('uiVirtualListCreate', 'Create a fixed-height vertical ScrollView list with a bounded reusable label pool and persistent runtime recycling component. Installation read-back is not live runtime qualification.', {
        type: 'object', additionalProperties: false,
        properties: {
            name: { type: 'string', minLength: 1, maxLength: 128 }, parentReference: InstanceReferenceSchema,
            itemCount: { type: 'integer', minimum: 0, maximum: 100000 },
            visibleItems: { type: 'integer', minimum: 1, maximum: MAX_VISIBLE_ITEMS },
            startIndex: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
        }, required: ['itemCount', 'visibleItems'],
    }, {
        type: 'object', properties: { reference: { type: 'object' }, viewport: { type: 'object' }, content: { type: 'object' }, itemReferences: { type: 'array' }, itemCount: { type: 'integer' }, instantiatedItems: { type: 'integer' }, virtualized: { type: 'boolean', const: true }, startIndex: { type: 'integer' }, nextIndex: { type: ['integer', 'null'] }, runtimeRecyclingBound: { type: 'boolean', const: true }, runtimeVerified: { type: 'boolean', const: false }, runtimeBinding: { type: 'object' } },
        required: ['reference', 'viewport', 'content', 'itemReferences', 'itemCount', 'instantiatedItems', 'virtualized', 'startIndex', 'nextIndex', 'runtimeRecyclingBound', 'runtimeVerified', 'runtimeBinding'],
    }, 'POST', ['ui', 'virtual', 'list', 'create'])
    async uiVirtualListCreate(args: { name?: string, parentReference?: IInstanceReference, itemCount: number, visibleItems: number, startIndex?: number }): Promise<Record<string, unknown>> {
        if (!args || !Number.isInteger(args.itemCount) || args.itemCount < 0 || args.itemCount > 100000
            || !Number.isInteger(args.visibleItems) || args.visibleItems < 1 || args.visibleItems > MAX_VISIBLE_ITEMS) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `itemCount must be an integer from 0 to 100000 and visibleItems from 1 to ${MAX_VISIBLE_ITEMS}.` });
        if (args.name !== undefined && (typeof args.name !== 'string' || args.name.length < 1 || args.name.length > 128)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'List name must be a string from 1 to 128 characters.' });
        const requestedStart = args.startIndex ?? 0;
        if (!Number.isInteger(requestedStart) || requestedStart < 0 || requestedStart > args.itemCount) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'startIndex must be an integer within 0..itemCount.' });
        const itemCount = args.itemCount;
        const visibleItems = args.visibleItems;
        const startIndex = Math.min(requestedStart, Math.max(0, itemCount - visibleItems));
        const ui = new UiTools();
        const list = await ui.uiCreateScrollView({ name: args.name ?? 'VirtualList', parentReference: args.parentReference });
        const materialized = Math.min(itemCount, visibleItems + 1);
        const firstIndex = Math.min(startIndex, Math.max(0, itemCount - materialized));
        const itemReferences: IInstanceReference[] = [];
        let pendingItemIndex: number | null = null;
        try {
            for (let index = 0; index < materialized; index++) {
                const itemIndex = firstIndex + index;
                pendingItemIndex = itemIndex;
                const item = await ui.createLabel({ name: `Item-${itemIndex}`, text: String(itemIndex), parentReference: list.content });
                if (!item?.reference || typeof item.reference.id !== 'string' || !item.reference.id
                    || itemReferences.some(reference => reference.id === item.reference.id)) throw new Error('Label creation returned a missing or duplicate item identity.');
                itemReferences.push(item.reference);
                pendingItemIndex = null;
            }
            await Editor.Message.request('scene', 'snapshot');
            const content = await Editor.Message.request('scene', 'query-node', list.content.id) as unknown;
            if (!content || typeof content !== 'object' || !('children' in content) || !Array.isArray(content.children)) throw new Error('List content children were not confirmed.');
            const uuid = 'uuid' in content ? content.uuid : undefined;
            const contentId = typeof uuid === 'string' ? uuid : uuid && typeof uuid === 'object' && 'value' in uuid ? uuid.value : undefined;
            if (contentId !== list.content.id) throw new Error('List content read-back identity does not match the bound content.');
            const children = content.children.map((child: unknown) => {
                if (!child || typeof child !== 'object') return undefined;
                if ('uuid' in child && typeof child.uuid === 'string') return child.uuid;
                if ('value' in child && child.value && typeof child.value === 'object' && 'uuid' in child.value && typeof child.value.uuid === 'string') return child.value.uuid;
                return undefined;
            });
            if (itemReferences.some(reference => children.filter(id => id === reference.id).length !== 1)) throw new Error('Created list items were not uniquely retained under the bound content.');
            const runtimeBinding = await installVirtualListRuntime({ root: list.reference, viewport: list.viewport, content: list.content, itemReferences, itemCount, visibleItems, startIndex });
            return { ...list, itemReferences, itemCount, instantiatedItems: itemReferences.length, startIndex, nextIndex: startIndex + visibleItems < itemCount ? startIndex + visibleItems : null, virtualized: true, runtimeRecyclingBound: true, runtimeVerified: false, runtimeBinding };
        } catch (error) {
            throw new ToolError({ code: 'UI_LIST_CREATE_PARTIAL', status: 502, message: 'List creation or runtime binding did not complete; inspect acknowledged identities before another create.', details: { reference: list.reference, content: list.content, itemReferences, pendingItemIndex, retrySafe: false, cleanupAttempted: false, cause: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512), bindingFailure: error instanceof ToolError ? { code: error.code, details: error.details } : null }, recovery: 'Inspect the owned list hierarchy, runtime script/component and pending item; do not replay creation or delete unconfirmed nodes automatically.' });
        }
    }

    @utcpTool('uiFormValidationBind', 'Create an input form and install persistent required/minLength validation that gates its Submit Button. No gameplay submit callback is added; runtime verification remains separate.', {
        type: 'object', additionalProperties: false,
        properties: {
            label: { type: 'string', minLength: 1, maxLength: 128 },
            placeholder: { type: 'string', maxLength: 256 },
            required: { type: 'boolean' },
            minLength: { type: 'integer', minimum: 0, maximum: 256 },
            name: { type: 'string', minLength: 1, maxLength: 128 },
            parentReference: InstanceReferenceSchema,
        },
        required: ['label'],
    }, {
        type: 'object', properties: { form: { type: 'object' }, rules: { type: 'object' }, focusOrder: { type: 'array' }, runtimeValidationBound: { type: 'boolean', const: true }, runtimeVerified: { type: 'boolean', const: false }, runtimeBinding: { type: 'object' } },
        required: ['form', 'rules', 'focusOrder', 'runtimeValidationBound', 'runtimeVerified', 'runtimeBinding'],
    }, 'POST', ['ui', 'form', 'validation', 'bind'])
    async uiFormValidationBind(args: { label: string, placeholder?: string, required?: boolean, minLength?: number, name?: string, parentReference?: IInstanceReference }): Promise<Record<string, unknown>> {
        if (!args || typeof args.label !== 'string' || args.label.length < 1 || args.label.length > 128
            || args.placeholder !== undefined && (typeof args.placeholder !== 'string' || args.placeholder.length > 256)
            || args.name !== undefined && (typeof args.name !== 'string' || args.name.length < 1 || args.name.length > 128)
            || args.required !== undefined && typeof args.required !== 'boolean'
            || args.minLength !== undefined && (!Number.isInteger(args.minLength) || args.minLength < 0 || args.minLength > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide schema-bounded form text, boolean required and integer minLength0..256.' });
        const required = args.required ?? true;
        const minLength = args.minLength ?? 0;
        if (minLength > 0 && !required) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'minLength requires required=true.' });
        const form = await new UiTools().uiCreateInputForm({ label: args.label, placeholder: args.placeholder, name: args.name, parentReference: args.parentReference });
        try {
            const runtimeBinding = await installFormValidationRuntime({ form: form.reference, input: form.input, submit: form.submit, required, minLength });
            return { form, rules: { required, minLength, inputReference: form.input }, focusOrder: form.focusOrder, runtimeValidationBound: true, runtimeVerified: false, runtimeBinding };
        } catch (error) {
            throw new ToolError({ code: 'UI_FORM_BIND_PARTIAL', status: 502, message: 'Form created but runtime validation binding was not confirmed.', details: { form, retrySafe: false, cleanupAttempted: false, bindingFailure: error instanceof ToolError ? { code: error.code, details: error.details } : null }, recovery: 'Inspect the created form and any runtime script/component before another create.' });
        }
    }
}
