import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { InstanceReferenceSchema, IInstanceReference } from '../schemas';
import { IProperty } from '@cocos/creator-types/editor/packages/scene/@types/public';
import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import { AUDIO_TARGETS, AudioAssetInfo, AudioAssetReference, AudioCompatibilityAuditResult, AudioTarget, buildAudioAssetCompatibilityAudit } from '../../audio-asset-compatibility-audit';
import { requireCreator38 } from '../utils/creator38-capability';
import { auditTranslationText } from '../localization-text-audit';
import { inspectLocalizationResources } from '../localization-resource-inspect';
const AUDIO_COMPAT_ISSUE_SCHEMA: any = {
    type: 'object',
    additionalProperties: false,
    properties: {
        code: { type: 'string', enum: ['ASSET_NOT_FOUND', 'TYPE_MISMATCH', 'UNSUPPORTED_FORMAT', 'UNKNOWN_METADATA', 'IMPORT_FAILED', 'TARGET_UNSUPPORTED'] },
        assetId: { type: 'string' },
        field: { type: 'string' },
        value: {},
        message: { type: 'string' },
    },
    required: ['code', 'assetId', 'message'],
};
const AUDIO_COMPAT_ITEM_SCHEMA: any = {
    type: 'object',
    additionalProperties: false,
    properties: {
        reference: { type: 'object' },
        target: { type: 'string', enum: [...AUDIO_TARGETS] },
        valid: { type: 'boolean' },
        url: { type: 'string' },
        path: { type: 'string' },
        extension: { type: 'string' },
        importer: { type: 'string' },
        loadMode: { type: 'string' },
        issues: { type: 'array', maxItems: 256, items: AUDIO_COMPAT_ISSUE_SCHEMA },
    },
    required: ['reference', 'target', 'valid', 'issues'],
};

interface ComponentRecord { type?: string; cid?: string; value?: Record<string, any>; }
interface NodeRecord { uuid?: string; name?: any; children?: NodeRecord[]; __comps__?: ComponentRecord[]; }

async function sceneNodes(rootUuid?: string): Promise<NodeRecord[]> {
    const tree = (rootUuid ? await Editor.Message.request('scene', 'query-node-tree', rootUuid) : await Editor.Message.request('scene', 'query-node-tree')) as unknown as NodeRecord | null;
    if (!tree) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: 'Scene subtree not found' });
    const result: NodeRecord[] = [];
    const visit = async (node: NodeRecord): Promise<void> => {
        if (result.length >= 128 || !node.uuid) return;
        const dump = await Editor.Message.request('scene', 'query-node', node.uuid) as unknown as NodeRecord | null;
        if (!dump) return;
        result.push(dump);
        for (const child of node.children ?? []) await visit(child);
    };
    await visit(tree);
    return result;
}

function nodeName(node: NodeRecord): string { return typeof node.name === 'string' ? node.name : node.name?.value ?? node.uuid ?? ''; }
function componentType(component: ComponentRecord): string {
    return component.type ?? component.value?.__type__?.value ?? component.value?.__type__ ?? component.cid ?? component.value?.cid ?? '';
}
function componentTypes(node: NodeRecord): string[] { return (node.__comps__ ?? []).map(componentType).filter(Boolean); }
function audioProperties(component: ComponentRecord): Record<string, unknown> { return component.value ?? {}; }
function propertyValue(value: unknown): unknown {
    if (!value || typeof value !== 'object' || !('value' in value)) return value;
    return value.value;
}
function componentUuid(component: ComponentRecord | undefined): unknown {
    const raw = component as (ComponentRecord & { uuid?: unknown }) | undefined;
    return propertyValue(component?.value?.uuid ?? raw?.uuid);
}

function referenceUuid(value: unknown): string | undefined {
    const unwrapped = propertyValue(value);
    if (typeof unwrapped === 'string' && unwrapped) return unwrapped;
    if (!unwrapped || typeof unwrapped !== 'object') return undefined;
    const uuid = propertyValue((unwrapped as Record<string, unknown>).uuid);
    return typeof uuid === 'string' && uuid ? uuid : undefined;
}

function cloneDump<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function dumpsEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}
async function hashFile(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    return hash.digest('hex');
}

export class ExpansionTools {
    @utcpTool('particleInspect', 'Inspect bounded particle system components and serialized configuration.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { systems: { type: 'array' }, count: { type: 'integer' } }, required: ['systems', 'count'] }, 'GET', ['particle', 'inspect'])
    async particleInspect(args: { reference?: IInstanceReference }): Promise<{ systems: Array<Record<string, unknown>>, count: number }> {

        const nodes = await sceneNodes(args.reference?.id);
        const systems = nodes.flatMap((node) => (node.__comps__ ?? [])
            .filter((component) => /cc\.ParticleSystem(?:2D)?$/.test(componentType(component)))
            .map((component) => ({ node: { id: node.uuid, type: 'cc.Node' }, name: nodeName(node), type: componentType(component), properties: component.value ?? {} })));
        return { systems, count: systems.length };
    }
    @utcpTool('particleConfigure', 'Configure bounded serialized particle module/curve fields with snapshot, read-back, and rollback; never claims runtime playback.', {
        type: 'object', additionalProperties: false,
        properties: {
            reference: InstanceReferenceSchema,
            properties: { type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 16 },
        },
        required: ['reference', 'properties'],
    }, {
        type: 'object', additionalProperties: false,
        properties: { reference: InstanceReferenceSchema, componentReference: InstanceReferenceSchema, properties: { type: 'object' }, changed: { type: 'array' }, verified: { type: 'boolean', const: true } },
        required: ['reference', 'componentReference', 'properties', 'changed', 'verified'],
    }, 'POST', ['particle', 'configure', 'scene'])
    async particleConfigure(args: { reference: IInstanceReference, properties: Record<string, unknown> }): Promise<{ reference: IInstanceReference, componentReference: IInstanceReference, properties: Record<string, unknown>, changed: string[], verified: true }> {
        if (!args?.reference?.id || typeof args.reference.id !== 'string') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'reference.id is required.' });
        if (!args.properties || typeof args.properties !== 'object' || Array.isArray(args.properties)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'properties must be a non-empty object.' });
        requireCreator38('particleConfigure');
        const keys = Object.keys(args.properties);
        if (keys.length < 1 || keys.length > 16 || keys.some((key) => !/^[A-Za-z0-9_.]{1,256}$/.test(key))) throw new ToolError({ code: 'INVALID_PROPERTY', status: 400, message: 'Particle property paths must be 1 to 256 alphanumeric segments.' });
        for (let index = 0; index < keys.length; index++) {
            const key = keys[index];
            if (key.split('.').some(segment => !segment || ['__proto__', 'prototype', 'constructor'].includes(segment)) || keys.slice(0, index).some(previous => previous.startsWith(`${key}.`) || key.startsWith(`${previous}.`))) {
                throw new ToolError({ code: 'INVALID_PROPERTY', status: 400, message: 'Particle property paths must use safe nonempty segments and must not overlap.' });
            }
        }
        const nodeId = args.reference.id;
        const nodeType = args.reference.type ?? 'cc.Node';
        let requested: Record<string, unknown>;
        try { requested = cloneDump(args.properties); }
        catch { throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Particle values must be JSON-serializable.' }); }
        if (keys.some(key => !Object.prototype.hasOwnProperty.call(requested, key) || requested[key] === undefined)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Every particle field must retain a JSON-serializable value.' });
        const node = await (Editor.Message.request('scene', 'query-node', nodeId) as unknown as Promise<NodeRecord | null>);
        if (!node) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Scene node ${nodeId} was not found.` });
        const components = node.__comps__ ?? [];
        const index = components.findIndex((component) => /cc\.ParticleSystem(?:2D)?$/.test(componentType(component)));
        if (index < 0) throw new ToolError({ code: 'UNSUPPORTED_COMPONENT', status: 422, message: `Node ${nodeId} has no serialized particle system component.` });
        const component = components[index];
        const values = component.value ?? {};
        const readPath = (root: unknown, propertyPath: string): unknown => propertyPath.split('.').reduce((current: unknown, part: string) => {
            if (!current || typeof current !== 'object' || !(part in (current as Record<string, unknown>))) return undefined;
            const next = (current as Record<string, unknown>)[part];
            return next && typeof next === 'object' && !Array.isArray(next) && 'value' in next ? (next as Record<string, unknown>).value : next;
        }, root);
        const originals: Record<string, unknown> = {};
        for (const key of keys) {
            const value = readPath(values, key);
            if (value === undefined) throw new ToolError({ code: 'UNSUPPORTED_PROPERTY', status: 422, message: `Particle component does not expose serialized field ${key}.` });
            originals[key] = cloneDump(value);
        }
        const componentId = referenceUuid(componentUuid(component));
        if (!componentId) throw new ToolError({ code: 'PARTICLE_TARGET_UNVERIFIED', status: 422, message: 'Particle mutation requires a native component UUID.' });
        const expectedType = componentType(component);
        const componentReference = { id: componentId, type: expectedType };
        const queryTarget = async (): Promise<Record<string, unknown>> => {
            const current = await Editor.Message.request('scene', 'query-node', nodeId) as unknown as NodeRecord | null;
            const target = current?.__comps__?.[index];
            if (referenceUuid(current?.uuid) !== nodeId || !target || referenceUuid(componentUuid(target)) !== componentId || componentType(target) !== expectedType) {
                throw new ToolError({ code: 'PARTICLE_TARGET_CHANGED', status: 409, message: 'Particle node/component identity or index changed; no further writes or restoration were dispatched.', details: { retrySafe: false, restored: null, componentId } });
            }
            return target.value ?? {};
        };
        const applied: string[] = [];
        try {
            for (const key of keys) {
                await queryTarget();
                let result: unknown;
                try {
                    result = await Editor.Message.request('scene', 'set-property', { uuid: nodeId, path: `__comps__.${index}.${key}`, dump: { value: cloneDump(requested[key]) as never, type: 'Unknown' } });
                } catch (error) {
                    throw new ToolError({ code: 'PARTICLE_MUTATION_OUTCOME_UNKNOWN', status: 502, message: 'Particle write was dispatched but its response was lost; no restoration was dispatched.', details: { retrySafe: false, restored: null, componentId, property: key, acknowledgedProperties: [...applied], cause: error instanceof Error ? error.message : String(error) } });
                }
                if (result === false) throw new Error(`Creator refused ${key}`);
                applied.push(key);
            }
            await Editor.Message.request('scene', 'snapshot');
            const readBackValues = await queryTarget();
            const readBack: Record<string, unknown> = {};
            for (const key of keys) {
                const actual = readPath(readBackValues, key);
                if (!dumpsEqual(actual, requested[key])) throw new Error(`read-back mismatch for ${key}`);
                readBack[key] = actual;
            }
            return { reference: { id: nodeId, type: nodeType }, componentReference, properties: readBack, changed: keys, verified: true };
        } catch (error) {
            if (error instanceof ToolError && ['PARTICLE_TARGET_CHANGED', 'PARTICLE_MUTATION_OUTCOME_UNKNOWN'].includes(error.code)) throw error;
            try {
                for (const key of [...applied].reverse()) {
                    const current = await queryTarget();
                    const observed = readPath(current, key);
                    if (dumpsEqual(observed, originals[key])) continue;
                    if (!dumpsEqual(observed, requested[key])) throw new ToolError({ code: 'PARTICLE_RESTORATION_CONFLICT', status: 409, message: 'Particle field changed outside this transaction; restoration refused.', details: { retrySafe: false, restored: null, componentId, property: key } });
                    const restored = await Editor.Message.request('scene', 'set-property', { uuid: nodeId, path: `__comps__.${index}.${key}`, dump: { value: cloneDump(originals[key]) as never, type: 'Unknown' } });
                    if (restored === false) throw new Error(`Creator refused rollback ${key}`);
                }
                await Editor.Message.request('scene', 'snapshot');
                const rollbackValues = await queryTarget();
                for (const key of applied) if (JSON.stringify(readPath(rollbackValues, key)) !== JSON.stringify(originals[key])) throw new Error(`rollback read-back mismatch for ${key}`);
            } catch (rollbackError) {
                if (rollbackError instanceof ToolError && ['PARTICLE_TARGET_CHANGED', 'PARTICLE_RESTORATION_CONFLICT'].includes(rollbackError.code)) throw rollbackError;
                throw new ToolError({ code: 'ROLLBACK_FAILED', status: 500, message: `Particle configuration failed and node ${nodeId} could not be restored.`, details: { retrySafe: false, restored: null, cause: error instanceof Error ? error.message : String(error), rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) } });
            }
            throw new ToolError({ code: 'MUTATION_FAILED', status: 502, message: `Particle configuration failed for node ${nodeId}.`, details: { cause: error instanceof Error ? error.message : String(error) } });
        }
    }
    @utcpTool('terrainInspect', 'Inspect bounded Terrain components and their asset/effect configuration.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { terrains: { type: 'array' }, count: { type: 'integer' } }, required: ['terrains', 'count'] }, 'GET', ['terrain', 'inspect'])
    async terrainInspect(args: { reference?: IInstanceReference }): Promise<{ terrains: Array<Record<string, unknown>>, count: number }> {
        const nodes = await sceneNodes(args.reference?.id);
        const terrains = nodes.flatMap((node) => (node.__comps__ ?? [])
            .filter((component) => componentType(component) === 'cc.Terrain')
            .map((component) => ({ node: { id: node.uuid, type: 'cc.Node' }, name: nodeName(node), properties: component.value ?? {} })));
        return { terrains, count: terrains.length };
    }
    @utcpTool('localizationInspect', 'Inspect bounded Creator localization runtime availability, languages and text direction.', { type: 'object', properties: {} }, { type: 'object', properties: { supported: { type: 'boolean' }, currentLanguage: { type: ['string', 'null'] }, languages: { type: 'array' }, directions: { type: 'object' }, error: { type: 'string' } }, required: ['supported', 'currentLanguage', 'languages', 'directions'] }, 'GET', ['localization', 'inspect'])
    async localizationInspect(): Promise<{ supported: boolean, currentLanguage: string | null, languages: string[], directions: Record<string, string>, error?: string }> {
        return await Editor.Message.request('scene', 'execute-scene-script', { name: 'ccp3x', method: 'inspectLocalization', args: [] }) as any;
    }

    @utcpTool('localizationResourceInspect', 'Inspect official editor language/default/fallback resource metadata through main IPC. No runtime import, switch, localStorage or restart; runtime fallback resolution remains unverified.', { type: 'object', additionalProperties: false, properties: {} }, {
        type: 'object', properties: { languages: { type: 'array', maxItems: 64 }, defaultLanguage: { type: 'string' }, fallbackLanguage: { type: 'string' }, issues: { type: 'array' }, writes: { type: 'boolean', const: false }, runtimeVerified: { type: 'boolean', const: false }, verificationScope: { type: 'string' } }, required: ['languages', 'defaultLanguage', 'fallbackLanguage', 'issues', 'writes', 'runtimeVerified', 'verificationScope'],
    }, 'GET', ['localization', 'resources', 'inspect', 'read-only'])
    async localizationResourceInspect() { requireCreator38('localizationResourceInspect'); return inspectLocalizationResources(); }

    @utcpTool('localizationFallbackCoverage', 'Inspect direct and configured editor-fallback key presence using official resource-list/table IPC. Empty values remain explicit and do not imply fallback. No runtime override, subtag chain, rendering or language switch inference.', {
        type: 'object', additionalProperties: false, properties: { locale: { type: 'string', minLength: 1, maxLength: 64 }, keys: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 256 } } }, required: ['locale', 'keys'],
    }, { type: 'object', properties: { locale: { type: 'string' }, fallbackLanguage: { type: 'string' }, complete: { type: 'boolean' }, items: { type: 'array', maxItems: 64 }, writes: { type: 'boolean', const: false }, runtimeVerified: { type: 'boolean', const: false }, verificationScope: { type: 'string' } }, required: ['locale', 'fallbackLanguage', 'complete', 'items', 'writes', 'runtimeVerified', 'verificationScope'] }, 'POST', ['localization', 'fallback', 'coverage', 'read-only'])
    async localizationFallbackCoverage(args: { locale: string; keys: string[] }) {
        requireCreator38('localizationFallbackCoverage');
        if (!args || Object.keys(args).some(key => !['locale', 'keys'].includes(key)) || typeof args.locale !== 'string' || args.locale.length > 64 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(args.locale)
            || !Array.isArray(args.keys) || args.keys.length < 1 || args.keys.length > 64 || new Set(args.keys).size !== args.keys.length
            || args.keys.some(key => typeof key !== 'string' || !key.trim() || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide bounded locale and unique translation keys.' });
        const resources = await this.localizationResourceInspect();
        if (!resources.languages.includes(args.locale) || !resources.languages.includes(resources.fallbackLanguage)) throw new ToolError({ code: 'LOCALIZATION_RESOURCE_UNAVAILABLE', status: 422, message: 'Requested and configured fallback locales must both be declared by the official package.' });
        const direct = await this.localizationTableInspect({ locale: args.locale, keys: args.keys, maxBytes: 65536 });
        const fallback = args.locale === resources.fallbackLanguage ? direct : await this.localizationTableInspect({ locale: resources.fallbackLanguage, keys: args.keys, maxBytes: 65536 });
        const snapshot = (table: typeof direct) => JSON.stringify({ locale: table.locale, items: table.items.map(item => [item.key, item.valueSha256, item.value]), missingKeys: table.missingKeys, totalFound: table.totalFound, totalMissing: table.totalMissing, truncated: table.truncated });
        const directSnapshot = snapshot(direct); const fallbackSnapshot = snapshot(fallback);
        const directValues = new Map(direct.items.map(item => [item.key, item.value]));
        const fallbackValues = new Map(fallback.items.map(item => [item.key, item.value]));
        const directMissing = new Set(direct.missingKeys); const fallbackMissing = new Set(fallback.missingKeys);
        const items = args.keys.map(key => {
            const value = directValues.get(key); const fallbackValue = fallbackValues.get(key);
            const status = value !== undefined ? value.trim() ? 'direct' : 'direct-empty'
                : !directMissing.has(key) ? 'unknown'
                : fallbackValue !== undefined ? fallbackValue.trim() ? 'fallback-present' : 'fallback-empty'
                : fallbackMissing.has(key) ? 'missing-both' : 'unknown';
            return { key, status };
        });
        const directAfter = await this.localizationTableInspect({ locale: args.locale, keys: args.keys, maxBytes: 65536 });
        const fallbackAfter = args.locale === resources.fallbackLanguage ? directAfter : await this.localizationTableInspect({ locale: resources.fallbackLanguage, keys: args.keys, maxBytes: 65536 });
        if (snapshot(directAfter) !== directSnapshot || snapshot(fallbackAfter) !== fallbackSnapshot) throw new ToolError({ code: 'LOCALIZATION_TABLE_CHANGED', status: 409, message: 'Selected translation keys changed during coverage; no mixed snapshot returned.' });
        const after = await this.localizationResourceInspect();
        if (JSON.stringify(after.languages) !== JSON.stringify(resources.languages) || after.fallbackLanguage !== resources.fallbackLanguage || after.defaultLanguage !== resources.defaultLanguage) throw new ToolError({ code: 'LOCALIZATION_RESOURCE_CHANGED', status: 409, message: 'Official resource configuration changed during coverage; inspect again.' });
        return { locale: args.locale, fallbackLanguage: resources.fallbackLanguage, complete: !direct.truncated && !fallback.truncated && items.every(item => item.status !== 'unknown'), items, writes: false as const, runtimeVerified: false as const,
            verificationScope: 'Official editor-configured fallback table presence with selected-key endpoint snapshot equality. Runtime options/localStorage, subtag hierarchy, atomicity/transient ABA changes, fonts/layout and actual fallback resolution are not verified.' };
    }

    @utcpTool('localizationTableInspect', 'Read selected existing translation keys from official localization-editor main IPC. No language change, restart or write. Missing keys are explicit; returned values have a whole-response byte bound.', {
        type: 'object', additionalProperties: false,
        properties: { locale: { type: 'string', minLength: 1, maxLength: 64 }, keys: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 256 } }, maxBytes: { type: 'integer', minimum: 1024, maximum: 65536, default: 16384 } }, required: ['locale', 'keys'],
    }, { type: 'object', properties: { locale: { type: 'string' }, items: { type: 'array' }, missingKeys: { type: 'array' }, requestedKeys: { type: 'integer' }, totalFound: { type: 'integer' }, totalMissing: { type: 'integer' }, truncated: { type: 'boolean' }, writes: { type: 'boolean', const: false } }, required: ['locale', 'items', 'missingKeys', 'requestedKeys', 'totalFound', 'totalMissing', 'truncated', 'writes'] }, 'POST', ['localization', 'table', 'inspect', 'read-only'])
    async localizationTableInspect(args: { locale: string; keys: string[]; maxBytes?: number }) {
        requireCreator38('localizationTableInspect');
        const maxBytes = args?.maxBytes ?? 16384;
        if (!args || Object.keys(args).some(key => !['locale', 'keys', 'maxBytes'].includes(key)) || typeof args.locale !== 'string' || !args.locale.trim() || args.locale.length > 64
            || !Array.isArray(args.keys) || args.keys.length < 1 || args.keys.length > 64 || new Set(args.keys).size !== args.keys.length
            || args.keys.some(key => typeof key !== 'string' || !key.trim() || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key))
            || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 65536) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide bounded locale, unique keys and maxBytes1024..65536.' });
        }
        if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(args.locale)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Locale must be a bounded language tag.' });
        const raw: unknown = await Editor.Message.request('localization-editor', 'get-translate-data-object', args.locale);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('locale' in raw) || raw.locale !== args.locale || !('items' in raw) || !raw.items || typeof raw.items !== 'object' || Array.isArray(raw.items)) {
            throw new ToolError({ code: 'LOCALIZATION_INVALID_RESPONSE', status: 502, message: 'Official package returned an invalid translation table identity.' });
        }
        const table = raw.items as Record<string, unknown>;
        const response = { locale: args.locale, items: [] as Array<{ key: string; value: string; valueSha256: string }>, missingKeys: [] as string[], requestedKeys: args.keys.length, totalFound: 0, totalMissing: 0, truncated: false, writes: false as const };
        for (const key of args.keys) {
            if (!Object.prototype.hasOwnProperty.call(table, key)) { response.missingKeys.push(key); continue; }
            const item = table[key];
            if (!item || typeof item !== 'object' || !('key' in item) || item.key !== key || !('value' in item) || typeof item.value !== 'string') throw new ToolError({ code: 'LOCALIZATION_INVALID_RESPONSE', status: 502, message: 'Translation item identity/value is invalid.' });
            response.items.push({ key, value: item.value, valueSha256: createHash('sha256').update(item.value, 'utf8').digest('hex') });
        }
        response.totalFound = response.items.length;
        response.totalMissing = response.missingKeys.length;
        while (Buffer.byteLength(JSON.stringify(response), 'utf8') > maxBytes) {
            response.truncated = true;
            if (response.items.length) response.items.pop();
            else if (response.missingKeys.length) response.missingKeys.pop();
            else throw new ToolError({ code: 'LOCALIZATION_PAYLOAD_TOO_LARGE', status: 422, message: 'Required translation identity exceeds maxBytes.' });
        }
        return response;
    }

    @utcpTool('localizationTableCoverage', 'Compare selected translation keys across explicit official package locales. Reports presence/empty values only; no inferred fallback, font/layout, runtime validity or writes.', {
        type: 'object', additionalProperties: false,
        properties: { locales: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64 } }, keys: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 256 } } }, required: ['locales', 'keys'],
    }, { type: 'object', properties: { complete: { type: 'boolean' }, valid: { type: 'boolean' }, checkedLocales: { type: 'integer' }, checkedKeys: { type: 'integer' }, locales: { type: 'array' }, writes: { type: 'boolean', const: false }, fallbackVerified: { type: 'boolean', const: false } }, required: ['complete', 'valid', 'checkedLocales', 'checkedKeys', 'locales', 'writes', 'fallbackVerified'] }, 'POST', ['localization', 'table', 'coverage', 'read-only'])
    async localizationTableCoverage(args: { locales: string[]; keys: string[] }) {
        requireCreator38('localizationTableCoverage');
        if (!args || Object.keys(args).some(key => !['locales', 'keys'].includes(key)) || !Array.isArray(args.locales) || args.locales.length < 1 || args.locales.length > 8
            || new Set(args.locales).size !== args.locales.length || args.locales.some(locale => typeof locale !== 'string' || !locale.trim() || locale.length > 64)
            || !Array.isArray(args.keys) || args.keys.length < 1 || args.keys.length > 64 || new Set(args.keys).size !== args.keys.length
            || args.keys.some(key => typeof key !== 'string' || !key.trim() || key.length > 256)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide1..8 distinct locales and1..64 distinct bounded keys.' });
        }
        if (args.locales.some(locale => !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(locale))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Locales must be bounded language tags.' });
        const locales: Array<{ locale: string; missingKeys: string[]; emptyKeys: string[]; checkedKeys: number; complete: boolean }> = [];
        for (const locale of args.locales) {
            const inspected = await this.localizationTableInspect({ locale, keys: args.keys, maxBytes: 65536 });
            locales.push({ locale, missingKeys: inspected.missingKeys, emptyKeys: inspected.items.filter(item => !item.value.trim()).map(item => item.key), checkedKeys: args.keys.length, complete: !inspected.truncated });
        }
        const complete = locales.every(locale => locale.complete);
        return { complete, valid: complete && locales.every(locale => !locale.missingKeys.length && !locale.emptyKeys.length), checkedLocales: locales.length, checkedKeys: args.keys.length, locales, writes: false as const, fallbackVerified: false as const };
    }

    @utcpTool('localizationTableTextAudit', 'Compare selected simple-brace or i18next identifier placeholders and optional supplied character repertoire across official tables. No ICU/nesting/formatter evaluation, font/layout/fallback/runtime validity inference.', {
        type: 'object', additionalProperties: false, properties: { baseLocale: { type: 'string', minLength: 1, maxLength: 64 }, locales: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64 } }, keys: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 256 } }, supportedCharacters: { type: 'string', maxLength: 16384 }, placeholderSyntax: { type: 'string', enum: ['simple-braces', 'i18next'], default: 'simple-braces' } }, required: ['baseLocale', 'locales', 'keys'],
    }, { type: 'object', properties: { baseLocale: { type: 'string' }, complete: { type: 'boolean' }, issues: { type: 'array' }, checkedTranslations: { type: 'integer' }, placeholderSyntax: { type: 'string' }, characterCoverageChecked: { type: 'boolean' }, fontVerified: { type: 'boolean', const: false }, layoutVerified: { type: 'boolean', const: false }, runtimeVerified: { type: 'boolean', const: false }, writes: { type: 'boolean', const: false } }, required: ['baseLocale', 'complete', 'issues', 'checkedTranslations', 'placeholderSyntax', 'characterCoverageChecked', 'fontVerified', 'layoutVerified', 'runtimeVerified', 'writes'] }, 'POST', ['localization', 'table', 'text', 'audit', 'read-only'])
    async localizationTableTextAudit(args: { baseLocale: string; locales: string[]; keys: string[]; supportedCharacters?: string; placeholderSyntax?: 'simple-braces' | 'i18next' }) {
        requireCreator38('localizationTableTextAudit');
        if (!args || Object.keys(args).some(key => !['baseLocale', 'locales', 'keys', 'supportedCharacters', 'placeholderSyntax'].includes(key)) || args.placeholderSyntax !== undefined && args.placeholderSyntax !== 'simple-braces' && args.placeholderSyntax !== 'i18next'
            || typeof args.baseLocale !== 'string' || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(args.baseLocale) || args.baseLocale.length > 64
            || !Array.isArray(args.locales) || args.locales.length < 1 || args.locales.length > 8 || new Set(args.locales).size !== args.locales.length
            || args.locales.some(locale => typeof locale !== 'string' || locale.length > 64 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(locale))
            || !Array.isArray(args.keys) || args.keys.length < 1 || args.keys.length > 64 || new Set(args.keys).size !== args.keys.length
            || args.keys.some(key => typeof key !== 'string' || !key.trim() || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key))
            || args.supportedCharacters !== undefined && (typeof args.supportedCharacters !== 'string' || args.supportedCharacters.length > 16384)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide bounded explicit baseLocale/locales/keys and optional character repertoire.' });
        const base = await this.localizationTableInspect({ locale: args.baseLocale, keys: args.keys, maxBytes: 65536 });
        const baseValues = new Map(base.items.map(item => [item.key, item.value]));
        const issues: Array<{ locale: string; key: string; code: string; missingPlaceholders?: string[]; extraPlaceholders?: string[]; uncoveredCharacters?: string[] }> = [];
        let complete = !base.truncated; let checkedTranslations = 0;
        for (const locale of args.locales) {
            const table = locale === args.baseLocale ? base : await this.localizationTableInspect({ locale, keys: args.keys, maxBytes: 65536 });
            complete = complete && !table.truncated;
            const values = new Map(table.items.map(item => [item.key, item.value]));
            for (const key of args.keys) {
                const expected = baseValues.get(key); const translated = values.get(key);
                if (expected === undefined || translated === undefined) { issues.push({ locale, key, code: expected === undefined ? 'BASE_VALUE_UNAVAILABLE' : 'TRANSLATION_UNAVAILABLE' }); continue; }
                checkedTranslations++;
                const result = auditTranslationText(expected, translated, args.supportedCharacters, args.placeholderSyntax);
                if (!result.syntaxSupported) { complete = false; issues.push({ locale, key, code: 'PLACEHOLDER_SYNTAX_UNSUPPORTED' }); }
                if (!translated.trim()) issues.push({ locale, key, code: 'EMPTY_TRANSLATION' });
                if (result.missingPlaceholders.length || result.extraPlaceholders.length) issues.push({ locale, key, code: 'PLACEHOLDER_MISMATCH', missingPlaceholders: result.missingPlaceholders, extraPlaceholders: result.extraPlaceholders });
                if (result.uncoveredCharacters.length) issues.push({ locale, key, code: 'CHARACTER_NOT_IN_REPERTOIRE', uncoveredCharacters: result.uncoveredCharacters });
            }
        }
        const response = { baseLocale: args.baseLocale, complete, issues, checkedTranslations, placeholderSyntax: args.placeholderSyntax ?? 'simple-braces', characterCoverageChecked: args.supportedCharacters !== undefined, fontVerified: false as const, layoutVerified: false as const, runtimeVerified: false as const, writes: false as const };
        if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 65536) throw new ToolError({ code: 'LOCALIZATION_PAYLOAD_TOO_LARGE', status: 422, message: 'Text diagnostics exceed bounded response size; request fewer keys/locales.' });
        return response;
    }

    @utcpTool(
        'localizationTableEdit',
        'Edit one existing localization table value through the official localization-editor main IPC with preflight, conflict guard, read-back and rollback.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                locale: { type: 'string', minLength: 1, maxLength: 64 },
                key: { type: 'string', minLength: 1, maxLength: 256 },
                value: { type: 'string', maxLength: 4096 },
                expectedValue: { type: 'string', maxLength: 4096 },
            },
            required: ['locale', 'key', 'value', 'expectedValue'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                supported: { type: 'boolean', const: true },
                locale: { type: 'string', minLength: 1, maxLength: 64 },
                key: { type: 'string', minLength: 1, maxLength: 256 },
                changed: { type: 'boolean' },
                persisted: { type: 'boolean', const: true },
                mutationDispatched: { type: 'boolean' },
                previousValueSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                readBackValueSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                evidence: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        channel: { type: 'string', const: 'localization-editor' },
                        readMethod: { type: 'string', const: 'get-translate-data-object' },
                        writeMethod: { type: 'string', const: 'save-translate-data' },
                        payloadBytes: { type: 'integer', minimum: 1, maximum: 65536 },
                        redacted: { type: 'boolean', const: true },
                    },
                    required: ['channel', 'readMethod', 'writeMethod', 'payloadBytes', 'redacted'],
                },
            },
            required: ['supported', 'locale', 'key', 'changed', 'persisted', 'mutationDispatched', 'previousValueSha256', 'readBackValueSha256', 'evidence'],
        },
        'POST',
        ['localization', 'table', 'edit'],
    )
    async localizationTableEdit(args: { locale: string, key: string, value: string, expectedValue: string }): Promise<{ supported: true, locale: string, key: string, changed: boolean, persisted: true, mutationDispatched: boolean, previousValueSha256: string, readBackValueSha256: string, evidence: { channel: 'localization-editor', readMethod: 'get-translate-data-object', writeMethod: 'save-translate-data', payloadBytes: number, redacted: true } }> {
        requireCreator38('localizationTableEdit');
        const input = args as unknown;
        const record = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
        if (!record || Object.keys(record).length !== 4
            || typeof record.locale !== 'string' || record.locale.length < 1 || record.locale.length > 64
            || typeof record.key !== 'string' || record.key.length < 1 || record.key.length > 256
            || typeof record.value !== 'string' || record.value.length > 4096
            || typeof record.expectedValue !== 'string' || record.expectedValue.length > 4096) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'localizationTableEdit requires only locale, key, value and expectedValue within bounded lengths.' });
        }
        if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(record.locale) || ['__proto__', 'constructor', 'prototype'].includes(record.key)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Invalid locale or reserved translation key.' });
        }
        const locale = record.locale;
        const key = record.key;
        const desiredValue = record.value;
        const expectedValue = record.expectedValue;
        const requestMain = async (method: string, ...methodArgs: unknown[]): Promise<unknown> => Editor.Message.request('localization-editor', method, ...methodArgs);
        const readTable = async (): Promise<Record<string, unknown>> => {
            let raw: unknown;
            try { raw = await requestMain('get-translate-data-object', locale); }
            catch (error) {
                throw new ToolError({ code: 'LOCALIZATION_UNSUPPORTED', status: 422, message: 'Creator localization-editor does not expose the official table read IPC.', details: { route: 'localizationTableEdit', requiredVersion: '3.8.8', channel: 'localization-editor', method: 'get-translate-data-object', cause: String(error instanceof Error ? error.message : error).slice(0, 256) }, recovery: 'Use Creator3.8.8 with the official localization-editor package enabled; no filesystem fallback is available.' });
            }
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError({ code: 'LOCALIZATION_INVALID_RESPONSE', status: 502, message: 'Creator localization-editor returned an invalid table response.' });
            const table = raw as Record<string, unknown>;
            if (table.locale !== locale || !table.items || typeof table.items !== 'object' || Array.isArray(table.items)) throw new ToolError({ code: 'LOCALIZATION_INVALID_RESPONSE', status: 502, message: 'Creator localization-editor returned a table with an invalid locale or item map.' });
            return table;
        };
        const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
        const table = await readTable();
        const itemMap = table.items as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(itemMap, key)) throw new ToolError({ code: 'LOCALIZATION_KEY_NOT_FOUND', status: 404, message: 'Translation key is absent from the selected locale.' });
        const currentItem = itemMap[key];
        if (!currentItem || typeof currentItem !== 'object' || Array.isArray(currentItem)) throw new ToolError({ code: 'LOCALIZATION_KEY_NOT_FOUND', status: 404, message: `Localization key '${key}' is not present in locale '${locale}'.` });
        const currentRecord = currentItem as Record<string, unknown>;
        if (currentRecord.key !== key || typeof currentRecord.value !== 'string') throw new ToolError({ code: 'LOCALIZATION_INVALID_RESPONSE', status: 502, message: 'Creator localization-editor returned an invalid translation item.' });
        const previousValue = currentRecord.value;
        if (previousValue !== expectedValue) throw new ToolError({ code: 'LOCALIZATION_CONFLICT', status: 409, message: `Localization key '${key}' changed since the expected value was read.`, details: { locale, key, expectedValueSha256: sha256(expectedValue), actualValueSha256: sha256(previousValue) }, recovery: 'Re-read the table and retry with the current expectedValue.' });
        if (Array.isArray(currentRecord.associations) && currentRecord.associations.length > 64
            || Array.isArray(currentRecord._variants) && currentRecord._variants.length > 64) {
            throw new ToolError({ code: 'LOCALIZATION_PAYLOAD_TOO_LARGE', status: 413, message: 'Translation metadata exceeds supported bounds; no edit was dispatched.' });
        }
        const payloadItem: Record<string, unknown> = { ...currentRecord, value: desiredValue };
        const payloadBytes = Buffer.byteLength(JSON.stringify(payloadItem), 'utf8');
        if (payloadBytes < 1 || payloadBytes > 65536) throw new ToolError({ code: 'LOCALIZATION_PAYLOAD_TOO_LARGE', status: 413, message: 'Localization table edit payload exceeds the bounded 65536-byte limit.' });
        const evidence = { channel: 'localization-editor' as const, readMethod: 'get-translate-data-object' as const, writeMethod: 'save-translate-data' as const, payloadBytes, redacted: true as const };
        const previousValueSha256 = sha256(previousValue);
        if (previousValue === desiredValue) return { supported: true, locale, key, changed: false, persisted: true, mutationDispatched: false, previousValueSha256, readBackValueSha256: previousValueSha256, evidence };
        const mutationDispatched = true;
        try {
            await requestMain('save-translate-data', locale, [payloadItem], { replaceValue: true, replaceVariant: true, replaceAssociation: true });
            const readBackTable = await readTable();
            const readBackItem = (readBackTable.items as Record<string, unknown>)[key];
            const readBackValue = readBackItem && typeof readBackItem === 'object' && !Array.isArray(readBackItem) ? (readBackItem as Record<string, unknown>).value : undefined;
            if (typeof readBackValue !== 'string' || readBackValue !== desiredValue) throw new Error('persistent read-back mismatch');
            return { supported: true, locale, key, changed: true, persisted: true, mutationDispatched, previousValueSha256, readBackValueSha256: sha256(readBackValue), evidence };
        } catch (error) {
            let restored = false;
            let restoreCause = '';
            try {
                await requestMain('save-translate-data', locale, [currentRecord], { replaceValue: true, replaceVariant: true, replaceAssociation: true });
                const restoredTable = await readTable();
                const restoredItem = (restoredTable.items as Record<string, unknown>)[key];
                const restoredValue = restoredItem && typeof restoredItem === 'object' && !Array.isArray(restoredItem) ? (restoredItem as Record<string, unknown>).value : undefined;
                restored = restoredValue === previousValue;
                if (!restored) restoreCause = 'restore read-back mismatch';
            } catch (restoreError) { restoreCause = String(restoreError instanceof Error ? restoreError.message : restoreError).slice(0, 256); }
            if (!restored) throw new ToolError({ code: 'LOCALIZATION_ROLLBACK_FAILED', status: 500, message: 'Localization table edit failed and the original value could not be verified after restore.', details: { locale, key, mutationDispatched, restored: false, cause: String(error instanceof Error ? error.message : error).slice(0, 256), restoreCause }, recovery: 'Stop and inspect the localization table before retrying.' });
            throw new ToolError({ code: 'LOCALIZATION_EDIT_FAILED', status: 502, message: 'Localization table edit failed; the original value was restored and verified.', details: { locale, key, mutationDispatched, restored: true, cause: String(error instanceof Error ? error.message : error).slice(0, 256) }, recovery: 'Retry only after re-reading the locale table.' });
        }
    }

    @utcpTool('particleValidate', 'Validate bounded particle system presence and serialized component configuration.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { valid: { type: 'boolean' }, issues: { type: 'array' }, checkedNodes: { type: 'integer' } }, required: ['valid', 'issues', 'checkedNodes'] }, 'GET', ['particle', 'validate'])
    async particleValidate(args: { reference?: IInstanceReference }): Promise<{ valid: boolean, issues: string[], checkedNodes: number }> {
        const result = await this.particleInspect(args);
        const issues = result.systems.length === 0 ? ['no particle system component found'] : [];
        return { valid: issues.length === 0, issues, checkedNodes: result.count };
    }

    @utcpTool('physics2dInspect', 'Inspect bounded 2D physics bodies and colliders in the open scene.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { nodes: { type: 'array' }, count: { type: 'integer' } }, required: ['nodes', 'count'] }, 'GET', ['physics', '2d', 'inspect'])
    async physics2dInspect(args: { reference?: IInstanceReference }): Promise<{ nodes: Array<Record<string, unknown>>, count: number }> {
        const nodes = await sceneNodes(args.reference?.id);
        const rows = nodes.map((node) => ({ node: { id: node.uuid, type: 'cc.Node' }, name: nodeName(node), components: componentTypes(node).filter((type) => /RigidBody2D|Collider2D|Joint2D|PhysicsSystem2D/.test(type)) })).filter((row) => row.components.length > 0);
        return { nodes: rows, count: rows.length };
    }

    @utcpTool('physics2dValidate', 'Validate incomplete 2D rigid-body and collider combinations.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { valid: { type: 'boolean' }, issues: { type: 'array' }, checkedNodes: { type: 'integer' } }, required: ['valid', 'issues', 'checkedNodes'] }, 'GET', ['physics', '2d', 'validate'])
    async physics2dValidate(args: { reference?: IInstanceReference }): Promise<{ valid: boolean, issues: string[], checkedNodes: number }> {
        const rows = await this.physics2dInspect(args);
        const issues: string[] = [];
        for (const row of rows.nodes) {
            const components = row.components as string[];
            if (components.some((type) => type === 'cc.RigidBody2D') && !components.some((type) => type.includes('Collider2D'))) issues.push(`${row.name}: rigid body has no 2D collider`);
        }
        return { valid: issues.length === 0, issues, checkedNodes: rows.count };
    }

    @utcpTool('physics2dTopologyAudit', 'Audit bounded 2D physics body, collider and joint topology without assuming a backend.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { valid: { type: 'boolean' }, nodes: { type: 'array' }, issues: { type: 'array' }, checkedNodes: { type: 'integer' } }, required: ['valid', 'nodes', 'issues', 'checkedNodes'] }, 'GET', ['physics', '2d', 'topology', 'audit'])
    async physics2dTopologyAudit(args: { reference?: IInstanceReference }): Promise<{ valid: boolean, nodes: Array<Record<string, unknown>>, issues: string[], checkedNodes: number }> {
        const nodes = await sceneNodes(args.reference?.id);
        const issues: string[] = [];
        const topology = nodes.map((node) => {
            const types = componentTypes(node);
            const bodies = types.filter((type) => type === 'cc.RigidBody2D');
            const colliders = types.filter((type) => /Collider2D$/.test(type));
            const joints = types.filter((type) => /Joint2D$/.test(type));
            if (bodies.length > 0 && colliders.length === 0) issues.push(`${nodeName(node)}: rigid body has no collider`);
            if (joints.length > 0 && bodies.length === 0) issues.push(`${nodeName(node)}: joint has no rigid body on the same node`);
            return { node: { id: node.uuid, type: 'cc.Node' }, name: nodeName(node), bodies, colliders, joints };
        }).filter((row) => row.bodies.length > 0 || row.colliders.length > 0 || row.joints.length > 0);
        return { valid: issues.length === 0, nodes: topology, issues, checkedNodes: topology.length };
    }

    @utcpTool(
        'physics2dCompatibilityAudit',
        'Validate bounded 2D physics components against an explicit Creator backend capability matrix.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                backend: { type: 'string', enum: ['builtin', 'box2d'], description: 'Target Creator 2D physics backend.' },
                reference: InstanceReferenceSchema,
            },
            required: ['backend'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                valid: { type: 'boolean' },
                backend: { type: 'string', enum: ['builtin', 'box2d'] },
                nodes: { type: 'array' },
                issues: { type: 'array', items: { type: 'string' } },
                checkedNodes: { type: 'integer' },
            },
            required: ['valid', 'backend', 'nodes', 'issues', 'checkedNodes'],
        },
        'GET',
        ['physics', '2d', 'compatibility', 'backend', 'audit']
    )
    async physics2dCompatibilityAudit(args: { backend: 'builtin' | 'box2d', reference?: IInstanceReference }): Promise<{ valid: boolean, backend: 'builtin' | 'box2d', nodes: Array<Record<string, unknown>>, issues: string[], checkedNodes: number }> {
        const topology = await this.physics2dTopologyAudit({ reference: args.reference });
        const issues = [...topology.issues];
        if (args.backend === 'builtin') {
            for (const row of topology.nodes) {
                const bodies = row.bodies as string[];
                const joints = row.joints as string[];
                if (bodies.length > 0) issues.push(`${row.name}: ${bodies.join(', ')} requires the box2d backend`);
                if (joints.length > 0) issues.push(`${row.name}: ${joints.join(', ')} requires the box2d backend`);
            }
        }
        return { valid: issues.length === 0, backend: args.backend, nodes: topology.nodes, issues, checkedNodes: topology.checkedNodes };
    }

    @utcpTool(
        'physics2dCreateBody',
        'Create one verified Box2D rigid-body node with a bounded collider choice, snapshot, read-back, and rollback on failure.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                backend: { type: 'string', enum: ['builtin', 'box2d'] },
                collider: { type: 'string', enum: ['box', 'circle'], default: 'box' },
                name: { type: 'string', minLength: 1, maxLength: 128, default: 'Physics2DBody' },
                parentReference: InstanceReferenceSchema,
            },
            required: ['backend'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                reference: InstanceReferenceSchema,
                backend: { type: 'string', enum: ['box2d'] },
                bodyType: { type: 'string' },
                colliderType: { type: 'string' },
                components: { type: 'array', items: { type: 'string' } },
            },
            required: ['reference', 'backend', 'bodyType', 'colliderType', 'components'],
        },
        'POST',
        ['physics', '2d', 'create', 'body', 'collider', 'compound']
    )
    async physics2dCreateBody(args: { backend: 'builtin' | 'box2d', collider?: 'box' | 'circle', name?: string, parentReference?: IInstanceReference }): Promise<{ reference: IInstanceReference, backend: 'box2d', bodyType: string, colliderType: string, components: string[] }> {
        if (args.backend !== 'box2d') {
            throw new ToolError({
                code: 'UNSUPPORTED_BACKEND',
                status: 422,
                message: 'physics2dCreateBody requires the box2d backend; Creator Builtin provides collision detection without rigid bodies.',
                recovery: 'Select the box2d backend or create collider-only nodes with the ordinary component tools.',
            });
        }
        const colliderType = args.collider === 'circle' ? 'cc.CircleCollider2D' : 'cc.BoxCollider2D';
        let nodeUuid: string | undefined;
        try {
            let parentUuid = args.parentReference?.id;
            if (parentUuid) {
                const parent = await Editor.Message.request('scene', 'query-node', parentUuid);
                if (!parent) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Parent node ${parentUuid} not found` });
            } else {
                const root = await Editor.Message.request('scene', 'query-node-tree') as unknown as NodeRecord | null;
                parentUuid = root?.uuid;
                if (!parentUuid) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Open scene root not found' });
            }
            const created = await Editor.Message.request('scene', 'create-node', { name: args.name ?? 'Physics2DBody', parent: parentUuid });
            nodeUuid = Array.isArray(created) ? created[0] : created;
            if (typeof nodeUuid !== 'string' || !nodeUuid) throw new Error('Creator did not return a node UUID');
            await Editor.Message.request('scene', 'create-component', { uuid: nodeUuid, component: 'cc.RigidBody2D' });
            await Editor.Message.request('scene', 'create-component', { uuid: nodeUuid, component: colliderType });
            await Editor.Message.request('scene', 'snapshot');
            const dump = await Editor.Message.request('scene', 'query-node', nodeUuid) as unknown as NodeRecord | null;
            const components = dump ? componentTypes(dump) : [];
            if (!dump || !components.includes('cc.RigidBody2D') || !components.includes(colliderType)) {
                throw new Error(`Creator read-back did not contain cc.RigidBody2D and ${colliderType}`);
            }
            return {
                reference: { id: nodeUuid, type: 'cc.Node' },
                backend: 'box2d',
                bodyType: 'cc.RigidBody2D',
                colliderType,
                components,
            };
        } catch (error) {
            if (nodeUuid) {
                try {
                    await Editor.Message.request('scene', 'remove-node', { uuid: nodeUuid });
                    await Editor.Message.request('scene', 'snapshot');
                } catch (rollbackError) {
                    throw new ToolError({
                        code: 'ROLLBACK_FAILED',
                        status: 500,
                        message: `physics2dCreateBody failed and node ${nodeUuid} could not be rolled back`,
                        details: { cause: error instanceof Error ? error.message : String(error), rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) },
                        recovery: `Delete node ${nodeUuid} manually before retrying.`,
                    });
                }
            }
            throw error;
        }
    }

    @utcpTool(
        'physics2dCreateJoint',
        'Create one verified Box2D 2D joint between two existing rigid-body nodes with endpoint validation and rollback.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                backend: { type: 'string', enum: ['builtin', 'box2d'] },
                joint: { type: 'string', enum: ['distance', 'spring', 'hinge', 'slider', 'fixed'], default: 'distance' },
                bodyReference: InstanceReferenceSchema,
                connectedBodyReference: InstanceReferenceSchema,
            },
            required: ['backend', 'bodyReference', 'connectedBodyReference'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                backend: { type: 'string', enum: ['box2d'] },
                jointReference: InstanceReferenceSchema,
                bodyReference: InstanceReferenceSchema,
                connectedBodyReference: InstanceReferenceSchema,
                jointType: { type: 'string' },
            },
            required: ['backend', 'jointReference', 'bodyReference', 'connectedBodyReference', 'jointType'],
        },
        'POST',
        ['physics', '2d', 'create', 'joint', 'compound']
    )
    async physics2dCreateJoint(args: { backend: 'builtin' | 'box2d', joint?: 'distance' | 'spring' | 'hinge' | 'slider' | 'fixed', bodyReference: IInstanceReference, connectedBodyReference: IInstanceReference }): Promise<{ backend: 'box2d', jointReference: IInstanceReference, bodyReference: IInstanceReference, connectedBodyReference: IInstanceReference, jointType: string }> {
        if (args.backend !== 'box2d') {
            throw new ToolError({
                code: 'UNSUPPORTED_BACKEND',
                status: 422,
                message: 'physics2dCreateJoint requires the box2d backend; Creator Builtin does not support 2D joints.',
                recovery: 'Select the box2d backend or omit the joint and use collider-only nodes.',
            });
        }
        if (args.bodyReference.id === args.connectedBodyReference.id) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'A 2D joint requires two distinct rigid-body nodes' });
        }
        const body = await Editor.Message.request('scene', 'query-node', args.bodyReference.id) as unknown as NodeRecord | null;
        const connected = await Editor.Message.request('scene', 'query-node', args.connectedBodyReference.id) as unknown as NodeRecord | null;
        if (!body) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Body node ${args.bodyReference.id} not found` });
        if (!connected) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Connected body node ${args.connectedBodyReference.id} not found` });
        const componentUuid = (component: ComponentRecord): string | undefined => component.value?.uuid?.value ?? component.value?.uuid ?? component.cid ?? component.value?.cid;
        const bodyComponent = body.__comps__?.find((component) => componentType(component) === 'cc.RigidBody2D');
        const connectedBodyComponent = connected.__comps__?.find((component) => componentType(component) === 'cc.RigidBody2D');
        if (!bodyComponent) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Body node ${args.bodyReference.id} has no cc.RigidBody2D` });
        if (!connectedBodyComponent) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Connected body node ${args.connectedBodyReference.id} has no cc.RigidBody2D` });
        const connectedBodyUuid = componentUuid(connectedBodyComponent);
        if (!connectedBodyUuid) throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 500, message: `Connected body ${args.connectedBodyReference.id} has no serialized component UUID` });
        const jointType = ({
            distance: 'cc.DistanceJoint2D',
            spring: 'cc.SpringJoint2D',
            hinge: 'cc.HingeJoint2D',
            slider: 'cc.SliderJoint2D',
            fixed: 'cc.FixedJoint2D',
        } as const)[args.joint ?? 'distance'];
        let jointUuid: string | undefined;
        const containsUuid = (value: unknown, uuid: string): boolean => {
            if (value === uuid) return true;
            if (!value || typeof value !== 'object') return false;
            return Object.values(value as Record<string, unknown>).some((item) => containsUuid(item, uuid));
        };
        try {
            await Editor.Message.request('scene', 'create-component', { uuid: args.bodyReference.id, component: jointType });
            const afterCreate = await Editor.Message.request('scene', 'query-node', args.bodyReference.id) as unknown as NodeRecord | null;
            const joint = afterCreate?.__comps__?.find((component) => componentType(component) === jointType);
            jointUuid = joint ? componentUuid(joint) : undefined;
            if (!jointUuid) throw new Error(`Creator did not return the ${jointType} component UUID`);
            const jointIndex = afterCreate?.__comps__?.findIndex((component) => componentType(component) === jointType) ?? -1;
            const setResult = await Editor.Message.request('scene', 'set-property', {
                uuid: args.bodyReference.id,
                path: `_components.${jointIndex}.connectedBody`,
                dump: { value: { uuid: connectedBodyUuid }, type: 'cc.RigidBody2D' },
            });
            if (setResult === false) throw new Error(`Creator refused connectedBody assignment for ${jointType}`);
            await Editor.Message.request('scene', 'snapshot');
            const verified = await Editor.Message.request('scene', 'query-node', args.bodyReference.id) as unknown as NodeRecord | null;
            const verifiedJoint = verified?.__comps__?.find((component) => componentType(component) === jointType);
            if (!verifiedJoint || !containsUuid(verifiedJoint.value, connectedBodyUuid)) {
                throw new Error(`Creator read-back did not verify ${jointType}.connectedBody`);
            }
            return {
                backend: 'box2d',
                jointReference: { id: jointUuid, type: jointType },
                bodyReference: args.bodyReference,
                connectedBodyReference: args.connectedBodyReference,
                jointType,
            };
        } catch (error) {
            if (jointUuid) {
                try {
                    await Editor.Message.request('scene', 'remove-component', { uuid: jointUuid });
                    await Editor.Message.request('scene', 'snapshot');
                } catch (rollbackError) {
                    throw new ToolError({
                        code: 'ROLLBACK_FAILED',
                        status: 500,
                        message: `physics2dCreateJoint failed and joint ${jointUuid} could not be rolled back`,
                        details: { cause: error instanceof Error ? error.message : String(error), rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) },
                        recovery: `Remove component ${jointUuid} manually before retrying.`,
                    });
                }
            }
            throw error;
        }
    }
    @utcpTool(
        'physics3dCreateBody',
        'Create one verified PhysX rigid-body node with a bounded box collider, serialized size, and rollback on failure.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                backend: { type: 'string', enum: ['builtin', 'cannon', 'physx'], description: 'Target Creator 3D physics backend.' },
                collider: { type: 'string', enum: ['box', 'sphere', 'capsule', 'mesh'], default: 'box' },
                size: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        x: { type: 'number', minimum: 0.001, maximum: 100000 },
                        y: { type: 'number', minimum: 0.001, maximum: 100000 },
                        z: { type: 'number', minimum: 0.001, maximum: 100000 },
                    },
                    required: ['x', 'y', 'z'],
                    default: { x: 1, y: 1, z: 1 },
                },
                name: { type: 'string', minLength: 1, maxLength: 128, default: 'Physics3DBody' },
                parentReference: InstanceReferenceSchema,
            },
            required: ['backend'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                reference: InstanceReferenceSchema,
                bodyReference: InstanceReferenceSchema,
                colliderReference: InstanceReferenceSchema,
                backend: { type: 'string', enum: ['physx'] },
                bodyType: { type: 'string', enum: ['cc.RigidBody'] },
                colliderType: { type: 'string', enum: ['cc.BoxCollider'] },
                collider: { type: 'string', enum: ['box'] },
                size: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        x: { type: 'number' },
                        y: { type: 'number' },
                        z: { type: 'number' },
                    },
                    required: ['x', 'y', 'z'],
                },
                components: { type: 'array', items: { type: 'string' } },
                verified: { type: 'boolean' },
            },
            required: ['reference', 'bodyReference', 'colliderReference', 'backend', 'bodyType', 'colliderType', 'collider', 'size', 'components', 'verified'],
        },
        'POST',
        ['physics', '3d', 'create', 'body', 'collider', 'compound']
    )
    async physics3dCreateBody(args: {
        backend: 'builtin' | 'cannon' | 'physx',
        collider?: 'box' | 'sphere' | 'capsule' | 'mesh',
        size?: { x: number, y: number, z: number },
        name?: string,
        parentReference?: IInstanceReference,
    }): Promise<{
        reference: IInstanceReference,
        bodyReference: IInstanceReference,
        colliderReference: IInstanceReference,
        backend: 'physx',
        bodyType: 'cc.RigidBody',
        colliderType: 'cc.BoxCollider',
        collider: 'box',
        size: { x: number, y: number, z: number },
        components: string[],
        verified: true,
    }> {
        if (args.backend !== 'physx') {
            throw new ToolError({
                code: 'UNSUPPORTED_BACKEND',
                status: 422,
                message: `physics3dCreateBody supports only the bounded PhysX backend contract; "${args.backend}" is not supported for rigid-body creation.`,
                recovery: 'Select the physx backend or use ordinary component tools without a physics-backend claim.',
            });
        }
        const collider = args.collider ?? 'box';
        if (collider !== 'box') {
            throw new ToolError({
                code: 'UNSUPPORTED_COLLIDER',
                status: 422,
                message: `physics3dCreateBody supports only the bounded PhysX box collider contract; "${collider}" is not supported.`,
                recovery: 'Use collider "box"; create other collider classes only after their backend combination is qualified.',
            });
        }
        const size = args.size ?? { x: 1, y: 1, z: 1 };
        if (![size.x, size.y, size.z].every((value) => Number.isFinite(value) && value >= 0.001 && value <= 100000)) {
            throw new ToolError({
                code: 'INVALID_ARGUMENT',
                status: 400,
                message: 'physics3dCreateBody size axes must be finite numbers between 0.001 and 100000.',
            });
        }

        const bodyType = 'cc.RigidBody' as const;
        const colliderType = 'cc.BoxCollider' as const;
        const name = args.name ?? 'Physics3DBody';
        let nodeUuid: string | undefined;
        try {
            let parentUuid = args.parentReference?.id;
            if (parentUuid) {
                const parent = await Editor.Message.request('scene', 'query-node', parentUuid);
                if (!parent) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Parent node ${parentUuid} not found` });
            } else {
                const root = await Editor.Message.request('scene', 'query-node-tree') as unknown as NodeRecord | null;
                parentUuid = root?.uuid;
                if (!parentUuid) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Open scene root not found' });
            }

            const created = await Editor.Message.request('scene', 'create-node', { name, parent: parentUuid });
            nodeUuid = Array.isArray(created) ? created[0] : created;
            if (typeof nodeUuid !== 'string' || !nodeUuid) throw new Error('Creator did not return a node UUID');
            await Editor.Message.request('scene', 'create-component', { uuid: nodeUuid, component: bodyType });
            await Editor.Message.request('scene', 'create-component', { uuid: nodeUuid, component: colliderType });

            const afterCreate = await Editor.Message.request('scene', 'query-node', nodeUuid) as unknown as NodeRecord | null;
            const colliderIndex = afterCreate?.__comps__?.findIndex((component) => componentType(component) === colliderType) ?? -1;
            if (!afterCreate || colliderIndex < 0 || !componentTypes(afterCreate).includes(bodyType)) {
                throw new Error(`Creator read-back did not contain ${bodyType} and ${colliderType}`);
            }
            const setResult = await Editor.Message.request('scene', 'set-property', {
                uuid: nodeUuid,
                path: `__comps__.${colliderIndex}.size`,
                dump: { value: size, type: 'cc.Vec3' },
            });
            if (setResult === false) throw new Error(`Creator refused ${colliderType}.size assignment`);
            await Editor.Message.request('scene', 'snapshot');

            const verifiedNode = await Editor.Message.request('scene', 'query-node', nodeUuid) as unknown as NodeRecord | null;
            const verifiedComponents = verifiedNode?.__comps__ ?? [];
            const verifiedBody = verifiedComponents.find((component) => componentType(component) === bodyType);
            const verifiedCollider = verifiedComponents.find((component) => componentType(component) === colliderType);
            const verifiedSize = propertyValue(verifiedCollider?.value?.size) as Record<string, unknown> | undefined;
            const bodyUuid = propertyValue(verifiedBody?.value?.uuid);
            const colliderUuid = propertyValue(verifiedCollider?.value?.uuid);
            const components = verifiedNode ? componentTypes(verifiedNode) : [];
            if (
                !verifiedNode
                || nodeName(verifiedNode) !== name
                || typeof bodyUuid !== 'string'
                || typeof colliderUuid !== 'string'
                || verifiedSize?.x !== size.x
                || verifiedSize?.y !== size.y
                || verifiedSize?.z !== size.z
            ) {
                throw new Error(`Creator read-back did not verify ${name}, component references, and ${colliderType}.size`);
            }
            return {
                reference: { id: nodeUuid, type: 'cc.Node' },
                bodyReference: { id: bodyUuid, type: bodyType },
                colliderReference: { id: colliderUuid, type: colliderType },
                backend: 'physx',
                bodyType,
                colliderType,
                collider: 'box',
                size,
                components,
                verified: true,
            };
        } catch (error) {
            if (nodeUuid) {
                try {
                    await Editor.Message.request('scene', 'remove-node', { uuid: nodeUuid });
                    const remaining = await Editor.Message.request('scene', 'query-node', nodeUuid);
                    if (remaining) throw new Error(`node ${nodeUuid} still exists after remove-node`);
                    await Editor.Message.request('scene', 'snapshot');
                } catch (rollbackError) {
                    throw new ToolError({
                        code: 'ROLLBACK_FAILED',
                        status: 500,
                        message: `physics3dCreateBody failed and node ${nodeUuid} could not be rolled back`,
                        details: {
                            cause: error instanceof Error ? error.message : String(error),
                            rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                            createdNode: { id: nodeUuid, type: 'cc.Node' },
                        },
                        recovery: `Delete node ${nodeUuid} manually before retrying.`,
                    });
                }
            }
            throw error;
        }
    }
    @utcpTool(
        'physics3dCreateJoint',
        'Create one verified PhysX 3D constraint between two existing rigid-body nodes with bounded endpoint validation and rollback.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                backend: { type: 'string', enum: ['builtin', 'cannon', 'physx'], description: 'Target Creator 3D physics backend.' },
                joint: { type: 'string', enum: ['fixed', 'hinge', 'pointToPoint', 'distance'], default: 'fixed', description: 'Bounded Creator 3D constraint type; distance is explicitly unsupported.' },
                bodyReference: InstanceReferenceSchema,
                connectedBodyReference: InstanceReferenceSchema,
            },
            required: ['backend', 'bodyReference', 'connectedBodyReference'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                backend: { type: 'string', enum: ['physx'] },
                jointReference: InstanceReferenceSchema,
                bodyReference: InstanceReferenceSchema,
                connectedBodyReference: InstanceReferenceSchema,
                jointType: { type: 'string', enum: ['cc.FixedConstraint', 'cc.HingeConstraint', 'cc.PointToPointConstraint'] },
            },
            required: ['backend', 'jointReference', 'bodyReference', 'connectedBodyReference', 'jointType'],
        },
        'POST',
        ['physics', '3d', 'create', 'joint', 'compound']
    )
    async physics3dCreateJoint(args: {
        backend: 'builtin' | 'cannon' | 'physx',
        joint?: 'fixed' | 'hinge' | 'pointToPoint' | 'distance',
        bodyReference: IInstanceReference,
        connectedBodyReference: IInstanceReference,
    }): Promise<{
        backend: 'physx',
        jointReference: IInstanceReference,
        bodyReference: IInstanceReference,
        connectedBodyReference: IInstanceReference,
        jointType: 'cc.FixedConstraint' | 'cc.HingeConstraint' | 'cc.PointToPointConstraint',
    }> {
        if (args.backend !== 'physx') {
            throw new ToolError({
                code: 'UNSUPPORTED_BACKEND',
                status: 422,
                message: `physics3dCreateJoint supports only the bounded PhysX backend contract; "${args.backend}" is not supported for constraint creation.`,
                recovery: 'Select the physx backend or use ordinary component tools without a physics-backend claim.',
            });
        }
        const bodyId = args.bodyReference?.id;
        const connectedBodyId = args.connectedBodyReference?.id;
        if (typeof bodyId !== 'string' || !bodyId || typeof connectedBodyId !== 'string' || !connectedBodyId) {
            throw new ToolError({
                code: 'INVALID_ARGUMENT',
                status: 400,
                message: 'physics3dCreateJoint requires non-empty bodyReference and connectedBodyReference ids.',
            });
        }
        if (bodyId === connectedBodyId) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'A 3D joint requires two distinct rigid-body nodes' });
        }

        const jointTypeByName: Record<string, 'cc.FixedConstraint' | 'cc.HingeConstraint' | 'cc.PointToPointConstraint'> = {
            fixed: 'cc.FixedConstraint',
            hinge: 'cc.HingeConstraint',
            pointToPoint: 'cc.PointToPointConstraint',
        };
        const jointType = jointTypeByName[args.joint ?? 'fixed'];
        if (!jointType) {
            throw new ToolError({
                code: 'UNSUPPORTED_JOINT',
                status: 422,
                message: `physics3dCreateJoint supports only fixed, hinge, and pointToPoint PhysX constraints; "${String(args.joint)}" is not supported.`,
                recovery: 'Use joint "fixed", "hinge", or "pointToPoint" with the physx backend.',
            });
        }

        const body = await Editor.Message.request('scene', 'query-node', bodyId) as unknown as NodeRecord | null;
        const connected = await Editor.Message.request('scene', 'query-node', connectedBodyId) as unknown as NodeRecord | null;
        if (!body) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Body node ${bodyId} not found` });
        if (!connected) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Connected body node ${connectedBodyId} not found` });
        const bodyComponent = body.__comps__?.find((component) => componentType(component) === 'cc.RigidBody');
        const connectedBodyComponent = connected.__comps__?.find((component) => componentType(component) === 'cc.RigidBody');
        if (!bodyComponent) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Body node ${bodyId} has no cc.RigidBody` });
        if (!connectedBodyComponent) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Connected body node ${connectedBodyId} has no cc.RigidBody` });
        const bodyComponentUuid = componentUuid(bodyComponent);
        const connectedBodyUuid = componentUuid(connectedBodyComponent);
        if (typeof bodyComponentUuid !== 'string' || !bodyComponentUuid) {
            throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 500, message: `Body ${bodyId} has no serialized cc.RigidBody component UUID` });
        }
        if (typeof connectedBodyUuid !== 'string' || !connectedBodyUuid) {
            throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 500, message: `Connected body ${connectedBodyId} has no serialized cc.RigidBody component UUID` });
        }

        let jointUuid: string | undefined;
        try {
            const created = await Editor.Message.request('scene', 'create-component', { uuid: bodyId, component: jointType });
            if (typeof created === 'string' && created) jointUuid = created;
            const afterCreate = await Editor.Message.request('scene', 'query-node', bodyId) as unknown as NodeRecord | null;
            const jointIndex = afterCreate?.__comps__?.findIndex((component) => componentType(component) === jointType) ?? -1;
            const joint = jointIndex >= 0 ? afterCreate?.__comps__?.[jointIndex] : undefined;
            const readBackJointUuid = joint ? componentUuid(joint) : undefined;
            if (typeof readBackJointUuid === 'string' && readBackJointUuid) jointUuid = readBackJointUuid;
            if (!afterCreate || jointIndex < 0 || typeof readBackJointUuid !== 'string' || !readBackJointUuid) {
                throw new Error(`Creator read-back did not contain ${jointType} with a serialized component UUID`);
            }
            const setResult = await Editor.Message.request('scene', 'set-property', {
                uuid: bodyId,
                path: `_components.${jointIndex}.connectedBody`,
                dump: { value: { uuid: connectedBodyUuid }, type: 'cc.RigidBody' },
            });
            if (setResult === false) throw new Error(`Creator refused ${jointType}.connectedBody assignment`);
            await Editor.Message.request('scene', 'snapshot');

            const verified = await Editor.Message.request('scene', 'query-node', bodyId) as unknown as NodeRecord | null;
            const verifiedJoint = verified?.__comps__?.find((component) => componentType(component) === jointType);
            const containsUuid = (value: unknown, uuid: string): boolean => {
                if (value === uuid) return true;
                if (!value || typeof value !== 'object') return false;
                return Object.values(value as Record<string, unknown>).some((item) => containsUuid(item, uuid));
            };
            const verifiedJointUuid = componentUuid(verifiedJoint);
            if (
                !verifiedJoint
                || typeof verifiedJointUuid !== 'string'
                || !jointUuid
                || verifiedJointUuid !== jointUuid
                || !containsUuid(verifiedJoint.value?.connectedBody, connectedBodyUuid)
            ) {
                throw new Error(`Creator read-back did not verify ${jointType}.connectedBody and component UUID`);
            }
            const verifiedUuid = jointUuid;
            return {
                backend: 'physx',
                jointReference: { id: verifiedUuid, type: jointType },
                bodyReference: args.bodyReference,
                connectedBodyReference: args.connectedBodyReference,
                jointType,
            };
        } catch (error) {
            try {
                if (!jointUuid) {
                    const rollbackNode = await Editor.Message.request('scene', 'query-node', bodyId) as unknown as NodeRecord | null;
                    const rollbackJoint = rollbackNode?.__comps__?.find((component) => componentType(component) === jointType);
                    const discoveredUuid = rollbackJoint ? componentUuid(rollbackJoint) : undefined;
                    if (typeof discoveredUuid === 'string' && discoveredUuid) jointUuid = discoveredUuid;
                }
                if (jointUuid) {
                    await Editor.Message.request('scene', 'remove-component', { uuid: jointUuid });
                    await Editor.Message.request('scene', 'snapshot');
                    const afterRollback = await Editor.Message.request('scene', 'query-node', bodyId) as unknown as NodeRecord | null;
                    const remains = afterRollback?.__comps__?.some((component) => componentUuid(component) === jointUuid);
                    if (remains) throw new Error(`joint component ${jointUuid} remains after rollback`);
                }
            } catch (rollbackError) {
                throw new ToolError({
                    code: 'ROLLBACK_FAILED',
                    status: 500,
                    message: `physics3dCreateJoint failed and the created joint could not be rolled back`,
                    details: {
                        cause: error instanceof Error ? error.message : String(error),
                        rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                        createdJoint: jointUuid ? { id: jointUuid, type: jointType } : undefined,
                    },
                    recovery: jointUuid ? `Remove component ${jointUuid} manually before retrying.` : 'Inspect the body node for an orphaned joint before retrying.',
                });
            }
            throw error;
        }
    }

    @utcpTool('physics3dInspect', 'Inspect bounded 3D rigid bodies, colliders, materials and joints in the open scene.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { nodes: { type: 'array' }, count: { type: 'integer' } }, required: ['nodes', 'count'] }, 'GET', ['physics', '3d', 'inspect'])
    async physics3dInspect(args: { reference?: IInstanceReference }): Promise<{ nodes: Array<Record<string, unknown>>, count: number }> {
        const nodes = await sceneNodes(args.reference?.id);
        const rows = nodes.map((node) => ({ node: { id: node.uuid, type: 'cc.Node' }, name: nodeName(node), components: componentTypes(node).filter((type) => /RigidBody$|Collider$|Joint$|Constraint$|PhysicsSystem/.test(type)) })).filter((row) => row.components.length > 0);
        return { nodes: rows, count: rows.length };
    }
    @utcpTool('physics3dTopologyAudit', 'Audit bounded 3D rigid body, collider, joint and physics-system topology.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { valid: { type: 'boolean' }, nodes: { type: 'array' }, issues: { type: 'array' }, checkedNodes: { type: 'integer' } }, required: ['valid', 'nodes', 'issues', 'checkedNodes'] }, 'GET', ['physics', '3d', 'topology', 'audit'])
    async physics3dTopologyAudit(args: { reference?: IInstanceReference }): Promise<{ valid: boolean, nodes: Array<Record<string, unknown>>, issues: string[], checkedNodes: number }> {
        const nodes = await sceneNodes(args.reference?.id);
        const issues: string[] = [];
        const topology = nodes.map((node) => {
            const types = componentTypes(node);
            const bodies = types.filter((type) => /RigidBody$/.test(type));
            const colliders = types.filter((type) => /Collider$/.test(type));
            const joints = types.filter((type) => /Joint$|Constraint$/.test(type));
            const systems = types.filter((type) => /PhysicsSystem/.test(type));
            if (joints.length > 0 && bodies.length === 0) issues.push(`${nodeName(node)}: joint has no rigid body on the same node`);
            return { node: { id: node.uuid, type: 'cc.Node' }, name: nodeName(node), bodies, colliders, joints, systems };
        }).filter((row) => row.bodies.length > 0 || row.colliders.length > 0 || row.joints.length > 0 || row.systems.length > 0);
        return { valid: issues.length === 0, nodes: topology, issues, checkedNodes: topology.length };
    }
    @utcpTool('physics3dValidate', 'Validate bounded 3D physics topology and report missing collider/body relationships.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { valid: { type: 'boolean' }, issues: { type: 'array' }, checkedNodes: { type: 'integer' } }, required: ['valid', 'issues', 'checkedNodes'] }, 'GET', ['physics', '3d', 'validate'])
    async physics3dValidate(args: { reference?: IInstanceReference }): Promise<{ valid: boolean, issues: string[], checkedNodes: number }> {
        const result = await this.physics3dTopologyAudit(args);
        const issues = [...result.issues];
        for (const row of result.nodes) {
            const bodies = row.bodies as string[];
            const colliders = row.colliders as string[];
            if (bodies.length > 0 && colliders.length === 0) issues.push(`${row.name}: rigid body has no 3D collider`);
        }
        return { valid: issues.length === 0, issues, checkedNodes: result.checkedNodes };
    }

    @utcpTool('audioSourceInspect', 'Inspect bounded AudioSource components and normalized clip/playback properties.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { sources: { type: 'array' }, count: { type: 'integer' } }, required: ['sources', 'count'] }, 'GET', ['audio', 'inspect', 'source'])
    async audioSourceInspect(args: { reference?: IInstanceReference }): Promise<{ sources: Array<Record<string, unknown>>, count: number }> {
        const nodes = await sceneNodes(args.reference?.id);
        const sources = nodes.flatMap((node) => (node.__comps__ ?? []).filter((component) => componentType(component) === 'cc.AudioSource').map((component) => ({ node: { id: node.uuid, type: 'cc.Node' }, name: nodeName(node), properties: audioProperties(component) })));
        return { sources, count: sources.length };
    }
    @utcpTool(
        'audioSourceConfigure',
        'Configure bounded serialized AudioSource properties on one existing node or component, with typed preflight, read-back, and rollback. Does not start or otherwise control playback.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                reference: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        id: { type: 'string', minLength: 1 },
                        type: { type: 'string', enum: ['cc.Node', 'cc.AudioSource'] },
                    },
                    required: ['id', 'type'],
                },
                properties: {
                    type: 'object',
                    additionalProperties: false,
                    minProperties: 1,
                    properties: {
                        volume: { type: 'number', minimum: 0, maximum: 1 },
                        loop: { type: 'boolean' },
                        playOnAwake: { type: 'boolean' },
                        clip: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string', minLength: 1 },
                                type: { type: 'string', const: 'cc.AudioClip' },
                            },
                            required: ['id', 'type'],
                        },
                    },
                },
            },
            required: ['reference', 'properties'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                reference: InstanceReferenceSchema,
                componentReference: InstanceReferenceSchema,
                properties: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        volume: { type: 'number' },
                        loop: { type: 'boolean' },
                        playOnAwake: { type: 'boolean' },
                        clip: {
                            anyOf: [
                                { type: 'null' },
                                {
                                    type: 'object',
                                    additionalProperties: false,
                                    properties: { id: { type: 'string' }, type: { type: 'string', const: 'cc.AudioClip' } },
                                    required: ['id', 'type'],
                                },
                            ],
                        },
                    },
                    required: ['volume', 'loop', 'playOnAwake', 'clip'],
                },
                changed: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', enum: ['volume', 'loop', 'playOnAwake', 'clip'] } },
                verified: { type: 'boolean', const: true },
            },
            required: ['reference', 'componentReference', 'properties', 'changed', 'verified'],
        },
        'POST',
        ['audio', 'source', 'configure', 'mutation']
    )
    async audioSourceConfigure(args: {
        reference: IInstanceReference,
        properties: {
            volume?: number,
            loop?: boolean,
            playOnAwake?: boolean,
            clip?: IInstanceReference,
        },
    }): Promise<{
        reference: IInstanceReference,
        componentReference: IInstanceReference,
        properties: { volume: number, loop: boolean, playOnAwake: boolean, clip: IInstanceReference | null },
        changed: Array<'volume' | 'loop' | 'playOnAwake' | 'clip'>,
        verified: true,
    }> {
        const requested = args?.properties;
        const allowedKeys = ['volume', 'loop', 'playOnAwake', 'clip'] as const;
        const changed = requested && typeof requested === 'object' && !Array.isArray(requested)
            ? allowedKeys.filter((key) => Object.prototype.hasOwnProperty.call(requested, key))
            : [];
        if (!args?.reference?.id || !['cc.Node', 'cc.AudioSource'].includes(String(args.reference.type))) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'audioSourceConfigure requires a typed cc.Node or cc.AudioSource reference.' });
        }
        if (!requested || typeof requested !== 'object' || Array.isArray(requested) || changed.length === 0 || Object.keys(requested).some((key) => !allowedKeys.includes(key as typeof allowedKeys[number]))) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'audioSourceConfigure properties must contain at least one of volume, loop, playOnAwake, or clip and no other fields.' });
        }
        if (Object.prototype.hasOwnProperty.call(requested, 'volume') && (typeof requested.volume !== 'number' || !Number.isFinite(requested.volume) || requested.volume < 0 || requested.volume > 1)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'audioSourceConfigure volume must be a finite number between 0 and 1.' });
        }
        for (const key of ['loop', 'playOnAwake'] as const) {
            if (Object.prototype.hasOwnProperty.call(requested, key) && typeof requested[key] !== 'boolean') {
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `audioSourceConfigure ${key} must be boolean.` });
            }
        }
        if (Object.prototype.hasOwnProperty.call(requested, 'clip')) {
            const clip = requested.clip;
            if (!clip || typeof clip !== 'object' || !clip.id || clip.type !== 'cc.AudioClip' || Object.keys(clip).some((key) => !['id', 'type'].includes(key))) {
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'audioSourceConfigure clip must be a typed cc.AudioClip asset reference.' });
            }
        }

        let node: NodeRecord | null;
        let source: ComponentRecord | undefined;
        if (args.reference.type === 'cc.Node') {
            node = await Editor.Message.request('scene', 'query-node', args.reference.id) as unknown as NodeRecord | null;
            if (!node) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `AudioSource node ${args.reference.id} not found.` });
            const sources = (node.__comps__ ?? []).filter((component) => componentType(component) === 'cc.AudioSource');
            if (sources.length === 0) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Node ${args.reference.id} has no cc.AudioSource component.` });
            if (sources.length > 1) throw new ToolError({ code: 'AMBIGUOUS_TARGET', status: 409, message: `Node ${args.reference.id} has multiple cc.AudioSource components; pass a component reference.` });
            source = sources[0];
        } else {
            const component = await Editor.Message.request('scene', 'query-component', args.reference.id) as unknown as ComponentRecord | null;
            if (!component) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `AudioSource component ${args.reference.id} not found.` });
            if (componentType(component) !== 'cc.AudioSource') throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Component ${args.reference.id} is ${componentType(component) || 'unknown'}, not cc.AudioSource.` });
            const nodeUuid = referenceUuid(component.value?.node);
            if (!nodeUuid) throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 500, message: `AudioSource component ${args.reference.id} has no serialized node reference.` });
            node = await Editor.Message.request('scene', 'query-node', nodeUuid) as unknown as NodeRecord | null;
            if (!node) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Parent node ${nodeUuid} for AudioSource ${args.reference.id} not found.` });
            source = (node.__comps__ ?? []).find((candidate) => componentUuid(candidate) === args.reference.id);
            if (!source || componentType(source) !== 'cc.AudioSource') throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `AudioSource component ${args.reference.id} was not found on parent node ${nodeUuid}.` });
        }

        const nodeUuid = propertyValue(node.uuid);
        const sourceUuid = componentUuid(source);
        const sourceIndex = (node.__comps__ ?? []).indexOf(source);
        if (typeof nodeUuid !== 'string' || !nodeUuid || typeof sourceUuid !== 'string' || !sourceUuid || sourceIndex < 0) {
            throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 500, message: 'The target AudioSource does not expose stable serialized node and component UUIDs.' });
        }

        const expectedTypes: Record<typeof allowedKeys[number], string[]> = {
            volume: ['Float', 'Number', 'cc.Float', 'cc.Number'],
            loop: ['Boolean', 'cc.Boolean'],
            playOnAwake: ['Boolean', 'cc.Boolean'],
            clip: ['cc.AudioClip'],
        };
        const originals = new Map<typeof allowedKeys[number], IProperty>();
        for (const key of changed) {
            const dump = source.value?.[key];
            const type = dump && typeof dump === 'object' ? (dump as Record<string, unknown>).type : undefined;
            if (!dump || typeof dump !== 'object' || !('value' in dump) || typeof type !== 'string' || !expectedTypes[key].includes(type)) {
                throw new ToolError({
                    code: 'UNSUPPORTED_PROPERTY',
                    status: 422,
                    message: `AudioSource.${key} is unavailable or has an unsupported serialized type.`,
                    details: { property: key, actualType: type ?? null, expectedTypes: expectedTypes[key] },
                });
            }
            originals.set(key, cloneDump(dump as IProperty));
        }
        if (requested.clip) {
            const asset = await Editor.Message.request('asset-db', 'query-asset-info', requested.clip.id) as { type?: unknown } | null;
            if (!asset) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Audio clip asset ${requested.clip.id} not found.` });
            if (asset.type !== 'cc.AudioClip') {
                throw new ToolError({
                    code: 'TYPE_MISMATCH',
                    status: 422,
                    message: `Asset ${requested.clip.id} is ${asset.type || 'unknown'}, not cc.AudioClip.`,
                    details: { asset: requested.clip.id, expectedType: 'cc.AudioClip', actualType: asset.type ?? null },
                });
            }
        }

        const pathFor = (key: typeof allowedKeys[number]) => `__comps__.${sourceIndex}.${key}`;
        const requestedDump = (key: typeof allowedKeys[number]): IProperty => {
            const original = originals.get(key)!;
            const value = key === 'clip' ? { uuid: requested.clip!.id } : requested[key];
            return { ...original, value };
        };
        const attempted: Array<typeof allowedKeys[number]> = [];
        const currentSource = (dump: NodeRecord | null): ComponentRecord | undefined =>
            dump?.__comps__?.find((component) => componentUuid(component) === sourceUuid && componentType(component) === 'cc.AudioSource');
        const normalizedProperties = (component: ComponentRecord): { volume: number, loop: boolean, playOnAwake: boolean, clip: IInstanceReference | null } => {
            const clipUuid = referenceUuid(component.value?.clip);
            return {
                volume: propertyValue(component.value?.volume) as number,
                loop: propertyValue(component.value?.loop) as boolean,
                playOnAwake: propertyValue(component.value?.playOnAwake) as boolean,
                clip: clipUuid ? { id: clipUuid, type: 'cc.AudioClip' } : null,
            };
        };

        try {
            for (const key of changed) {
                attempted.push(key);
                const ok = await Editor.Message.request('scene', 'set-property', { uuid: nodeUuid, path: pathFor(key), dump: requestedDump(key) });
                if (ok === false) throw new ToolError({ code: 'MUTATION_FAILED', status: 500, message: `Creator refused AudioSource.${key} on ${nodeUuid}.` });
            }
            const snapshotResult = await Editor.Message.request('scene', 'snapshot') as unknown;
            if (snapshotResult === false) throw new ToolError({ code: 'MUTATION_FAILED', status: 500, message: `Creator refused AudioSource snapshot for ${nodeUuid}.` });
            const verifiedNode = await Editor.Message.request('scene', 'query-node', nodeUuid) as unknown as NodeRecord | null;
            const verifiedSource = currentSource(verifiedNode);
            if (!verifiedSource) throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 500, message: `AudioSource ${sourceUuid} was not found during read-back.` });
            const readback = normalizedProperties(verifiedSource);
            for (const key of changed) {
                const expected = key === 'clip' ? requested.clip!.id : requested[key];
                const actual = key === 'clip' ? readback.clip?.id : readback[key];
                if (actual !== expected) {
                    throw new ToolError({
                        code: 'POSTCONDITION_FAILED',
                        status: 500,
                        message: `AudioSource.${key} read-back did not match the requested value.`,
                        details: { property: key, expected, actual },
                    });
                }
            }
            return {
                reference: { id: nodeUuid, type: 'cc.Node' },
                componentReference: { id: sourceUuid, type: 'cc.AudioSource' },
                properties: readback,
                changed,
                verified: true,
            };
        } catch (error) {
            if (attempted.length > 0) {
                try {
                    const rollbackErrors: string[] = [];
                    for (const key of [...attempted].reverse()) {
                        try {
                            const ok = await Editor.Message.request('scene', 'set-property', { uuid: nodeUuid, path: pathFor(key), dump: originals.get(key)! });
                            if (ok === false) throw new Error(`Creator refused rollback of AudioSource.${key}`);
                        } catch (rollbackFieldError) {
                            rollbackErrors.push(rollbackFieldError instanceof Error ? rollbackFieldError.message : String(rollbackFieldError));
                        }
                    }
                    const rolledBackNode = await Editor.Message.request('scene', 'query-node', nodeUuid) as unknown as NodeRecord | null;
                    const rolledBackSource = currentSource(rolledBackNode);
                    if (!rolledBackSource || attempted.some((key) => !dumpsEqual(rolledBackSource.value?.[key], originals.get(key)))) {
                        rollbackErrors.push(`AudioSource ${sourceUuid} rollback read-back did not match the captured values`);
                    }
                    const rollbackSnapshot = await Editor.Message.request('scene', 'snapshot') as unknown;
                    if (rollbackSnapshot === false) rollbackErrors.push('Creator refused AudioSource rollback snapshot');
                    if (rollbackErrors.length > 0) throw new Error(rollbackErrors.join('; '));
                } catch (rollbackError) {
                    throw new ToolError({
                        code: 'ROLLBACK_FAILED',
                        status: 500,
                        message: `audioSourceConfigure failed and AudioSource ${sourceUuid} could not be rolled back.`,
                        details: {
                            cause: error instanceof Error ? error.message : String(error),
                            rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                            node: { id: nodeUuid, type: 'cc.Node' },
                            component: { id: sourceUuid, type: 'cc.AudioSource' },
                        },
                        recovery: `Inspect AudioSource ${sourceUuid} on node ${nodeUuid} and restore its serialized properties before retrying.`,
                    });
                }
            }
            if (error instanceof ToolError) throw error;
            throw new ToolError({
                code: 'MUTATION_FAILED',
                status: 500,
                message: `audioSourceConfigure failed for AudioSource ${sourceUuid}.`,
                details: { cause: error instanceof Error ? error.message : String(error) },
                recovery: 'The changed AudioSource properties were rolled back and verified; inspect the target before retrying.',
            });
        }
    }
    @utcpTool('audioSourceAudit', 'Audit bounded AudioSource clip and playback compatibility with normalized properties.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { valid: { type: 'boolean' }, sources: { type: 'array' }, issues: { type: 'array' }, checkedSources: { type: 'integer' } }, required: ['valid', 'sources', 'issues', 'checkedSources'] }, 'GET', ['audio', 'source', 'audit', 'compatibility'])
    async audioSourceAudit(args: { reference?: IInstanceReference }): Promise<{ valid: boolean, sources: Array<Record<string, unknown>>, issues: string[], checkedSources: number }> {
        const nodes = await sceneNodes(args.reference?.id);
        const issues: string[] = [];
        const sources = nodes.flatMap((node) => (node.__comps__ ?? []).filter((component) => componentType(component) === 'cc.AudioSource').map((component) => {
            const props = component.value ?? {};
            const clip = propertyValue(props.clip);
            const volume = propertyValue(props.volume);
            const loop = propertyValue(props.loop);
            const playOnAwake = propertyValue(props.playOnAwake);
            const name = nodeName(node);
            if (clip === null || clip === undefined || clip === '') issues.push(`${name}: missing clip`);
            if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) issues.push(`${name}: volume must be between 0 and 1`);
            return { node: { id: node.uuid, type: 'cc.Node' }, name, clip, volume, loop, playOnAwake };
        }));
        return { valid: issues.length === 0, sources, issues, checkedSources: sources.length };
    }

    @utcpTool('audioAssetValidate', 'Validate one audio asset importer/type and return bounded compatibility findings.', { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', properties: { valid: { type: 'boolean' }, importer: { type: 'string' }, type: { type: 'string' }, issues: { type: 'array' } }, required: ['valid', 'importer', 'type', 'issues'] }, 'GET', ['audio', 'asset', 'validate'])
    async audioAssetValidate(args: { reference: IInstanceReference }): Promise<{ valid: boolean, importer: string, type: string, issues: string[] }> {
        const info: any = await Editor.Message.request('asset-db', 'query-asset-info', args.reference.id);
        if (!info) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Asset ${args.reference.id} not found` });
        const issues: string[] = [];
        if (info.type !== 'cc.AudioClip') issues.push('asset type is not cc.AudioClip');
        if (info.invalid === true || info.imported === false) issues.push('asset is invalid or not fully imported');
        return { valid: issues.length === 0, importer: info.importer ?? '', type: info.type ?? '', issues };
    }

    @utcpTool(
        'audioAssetCompatibilityAudit',
        'Audit an explicit bounded list of typed cc.AudioClip assets against a declared web or native target. Uses only public asset metadata; it does not claim decode, duration, or playback success.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                assets: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 64,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            id: { type: 'string', minLength: 1 },
                            type: { type: 'string', const: 'cc.AudioClip' },
                        },
                        required: ['id', 'type'],
                    },
                },
                target: { type: 'string', enum: [...AUDIO_TARGETS] },
                maxIssues: { type: 'integer', minimum: 1, maximum: 256, default: 256 },
            },
            required: ['assets', 'target'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                target: { type: 'string', enum: [...AUDIO_TARGETS] },
                valid: { type: 'boolean' },
                complete: { type: 'boolean' },
                items: { type: 'array', maxItems: 64, items: AUDIO_COMPAT_ITEM_SCHEMA },
                issues: { type: 'array', maxItems: 256, items: AUDIO_COMPAT_ISSUE_SCHEMA },
            },
            required: ['target', 'valid', 'complete', 'items', 'issues'],
        },
        'POST',
        ['audio', 'asset', 'compatibility', 'audit', 'target'],
    )
    async audioAssetCompatibilityAudit(args: {
        assets: IInstanceReference[];
        target: AudioTarget;
        maxIssues?: number;
    }): Promise<AudioCompatibilityAuditResult> {
        if (!Array.isArray(args?.assets) || args.assets.length < 1 || args.assets.length > 64 || typeof args?.target !== 'string' || !AUDIO_TARGETS.includes(args.target as AudioTarget)) {
            throw new ToolError({
                code: 'INVALID_ARGUMENT',
                status: 400,
                message: 'audioAssetCompatibilityAudit requires 1-64 typed cc.AudioClip references and one supported target.',
            });
        }
        if (args.assets.some((reference) => !reference || typeof reference !== 'object' || typeof reference.id !== 'string' || !reference.id || reference.type !== 'cc.AudioClip' || Object.keys(reference).some((key) => !['id', 'type'].includes(key)))) {
            throw new ToolError({
                code: 'INVALID_ARGUMENT',
                status: 400,
                message: 'audioAssetCompatibilityAudit assets must be typed cc.AudioClip references with only id and type.',
            });
        }
        if (args.maxIssues !== undefined && (!Number.isInteger(args.maxIssues) || args.maxIssues < 1 || args.maxIssues > 256)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'audioAssetCompatibilityAudit maxIssues must be an integer from 1 to 256.' });
        }
        const entries = await Promise.all(args.assets.map(async (reference) => {
            try {
                const info = await Editor.Message.request('asset-db', 'query-asset-info', reference.id) as AudioAssetInfo | null;
                return { reference: { id: reference.id, type: 'cc.AudioClip' as const } satisfies AudioAssetReference, info };
            } catch (error) {
                throw new ToolError({
                    code: 'ASSET_QUERY_FAILED',
                    status: 502,
                    message: `Public asset database query failed for ${reference.id}.`,
                    details: { cause: error instanceof Error ? error.message : String(error) },
                    recovery: 'Retry after the Creator asset database is ready.',
                });
            }
        }));
        return buildAudioAssetCompatibilityAudit(args.target, entries, args.maxIssues);
    }
    @utcpTool('assetImporterAudit', 'Audit one asset importer with normalized source identity, settings and bounded compatibility findings.', { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', properties: { valid: { type: 'boolean' }, importer: { type: 'string' }, settings: { type: 'object' }, source: { type: 'object' }, issues: { type: 'array' } }, required: ['valid', 'importer', 'settings', 'source', 'issues'] }, 'GET', ['asset', 'importer', 'audit'])
    async assetImporterAudit(args: { reference: IInstanceReference }): Promise<{ valid: boolean, importer: string, settings: Record<string, unknown>, source: Record<string, unknown>, issues: string[] }> {
        const info: any = await Editor.Message.request('asset-db', 'query-asset-info', args.reference.id);
        if (!info) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Asset ${args.reference.id} not found` });
        const importer = String(info.importer ?? '');
        const settings = (info.importerSettings ?? info.meta ?? {}) as Record<string, unknown>;
        const source = { uuid: info.uuid, url: info.url, type: info.type, name: info.name, isDirectory: Boolean(info.isDirectory) };
        const issues: string[] = [];
        if (!importer) issues.push('asset has no importer');
        if (source.isDirectory) issues.push('asset reference resolves to a directory');
        return { valid: issues.length === 0, importer, settings, source, issues };
    }
    @utcpTool(
        'localizationValidate',
        'Validate 1-256 unique localization keys in the current Creator language through the fixed package scene seam.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                keys: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 256,
                    uniqueItems: true,
                    items: { type: 'string', minLength: 1, maxLength: 256 },
                },
            },
            required: ['keys'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                supported: { type: 'boolean' },
                language: { type: ['string', 'null'], minLength: 1, maxLength: 256 },
                checkedKeys: { type: 'integer', minimum: 0, maximum: 256 },
                missingKeys: {
                    type: 'array',
                    maxItems: 256,
                    uniqueItems: true,
                    items: { type: 'string', minLength: 1, maxLength: 256 },
                },
                error: { type: 'string', minLength: 1, maxLength: 512 },
            },
            required: ['supported', 'language', 'checkedKeys', 'missingKeys'],
            allOf: [{
                if: { properties: { supported: { const: false } }, required: ['supported'] },
                then: { required: ['error'] },
            }],
        },
        'GET',
        ['localization', 'validate', 'keys'],
    )
    async localizationValidate(args: { keys: string[] }): Promise<{ supported: boolean, language: string | null, checkedKeys: number, missingKeys: string[], error?: string }> {
        const input = args as unknown;
        const inputRecord = input && typeof input === 'object' && !Array.isArray(input)
            ? input as Record<string, unknown>
            : null;
        const keys = inputRecord?.keys;
        const inputKeys = inputRecord ? Object.keys(inputRecord) : [];
        if (!Array.isArray(keys)
            || keys.length < 1
            || keys.length > 256
            || inputKeys.length !== 1
            || inputKeys[0] !== 'keys') {
            throw new ToolError({
                code: 'INVALID_ARGUMENT',
                status: 400,
                message: 'localizationValidate requires only keys with 1-256 nonempty unique strings.',
            });
        }

        const uniqueKeys = new Set<string>();
        for (const key of keys) {
            if (typeof key !== 'string' || key.length < 1 || key.length > 256 || uniqueKeys.has(key)) {
                throw new ToolError({
                    code: 'INVALID_ARGUMENT',
                    status: 400,
                    message: 'localizationValidate keys must be nonempty unique strings of at most 256 characters.',
                });
            }
            uniqueKeys.add(key);
        }

        let raw: unknown;
        try {
            raw = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'ccp3x',
                method: 'validateLocalization',
                args: [keys],
            });
        } catch (error) {
            throw new ToolError({
                code: 'LOCALIZATION_VALIDATION_FAILED',
                status: 502,
                message: 'Creator scene transport failed while validating localization keys.',
                details: { cause: String(error instanceof Error ? error.message : error).slice(0, 512) },
                recovery: 'Retry after the Creator scene process and ccp3x package are ready.',
            });
        }

        if (!raw || typeof raw !== 'object' || Array.isArray(raw)
            || typeof (raw as Record<string, unknown>).supported !== 'boolean') {
            throw new ToolError({
                code: 'LOCALIZATION_INVALID_RESPONSE',
                status: 502,
                message: 'Creator localization validation returned an invalid response.',
                recovery: 'Retry with a compatible ccp3x scene package.',
            });
        }

        const response = raw as Record<string, unknown>;
        if (response.supported === false) {
            const reportedError = typeof response.error === 'string' ? response.error.trim() : '';
            return {
                supported: false,
                language: null,
                checkedKeys: 0,
                missingKeys: [],
                error: (reportedError || 'Creator localization package is unavailable.').slice(0, 512),
            };
        }

        const language = response.language;
        const checkedKeys = response.checkedKeys;
        const missingKeys = response.missingKeys;
        if ((language !== null && (typeof language !== 'string' || language.length < 1 || language.length > 256))
            || !Number.isInteger(checkedKeys)
            || checkedKeys !== keys.length
            || !Array.isArray(missingKeys)
            || missingKeys.some((key) => typeof key !== 'string' || !uniqueKeys.has(key))) {
            throw new ToolError({
                code: 'LOCALIZATION_INVALID_RESPONSE',
                status: 502,
                message: 'Creator localization validation returned an invalid response.',
                recovery: 'Retry with a compatible ccp3x scene package.',
            });
        }

        const missingSet = new Set(missingKeys as string[]);
        return {
            supported: true,
            language: language as string | null,
            checkedKeys: keys.length,
            missingKeys: keys.filter((key) => missingSet.has(key)),
        };
    }

    @utcpTool('buildPresetValidate', 'Validate bounded build options before dispatching a Creator build task.', { type: 'object', properties: { options: { type: 'object' } }, required: ['options'] }, { type: 'object', properties: { valid: { type: 'boolean' }, issues: { type: 'array' }, platform: { type: 'string' } }, required: ['valid', 'issues', 'platform'] }, 'POST', ['build', 'preset', 'validate'])
    async buildPresetValidate(args: { options: Record<string, unknown> }): Promise<{ valid: boolean, issues: string[], platform: string }> {
        const platform = typeof args.options.platform === 'string' ? args.options.platform : '';
        const issues: string[] = [];
        if (!platform) issues.push('options.platform is required');
        if (typeof args.options.buildPath === 'string' && args.options.buildPath.length > 512) issues.push('options.buildPath exceeds 512 characters');
        return { valid: issues.length === 0, issues, platform };
    }

    @utcpTool('buildArtifactInspect', 'Inspect a bounded project-local build artifact file inventory with byte sizes.', {
        type: 'object',
        additionalProperties: false,
        properties: {
            artifactPath: { type: 'string', minLength: 1 },
            maxFiles: { type: 'integer', minimum: 1, maximum: 256, default: 64 },
        },
        required: ['artifactPath'],
    }, {
        type: 'object',
        additionalProperties: false,
        properties: {
            exists: { type: 'boolean' },
            files: {
                type: 'array',
                maxItems: 256,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        path: { type: 'string' },
                        bytes: { type: 'integer', minimum: 0 },
                    },
                    required: ['path', 'bytes'],
                },
            },
            count: { type: 'integer', minimum: 0, maximum: 256 },
            truncated: { type: 'boolean' },
        },
        required: ['exists', 'files', 'count', 'truncated'],
    }, 'GET', ['build', 'artifact', 'inspect'])
    async buildArtifactInspect(args: { artifactPath: string, maxFiles?: number }): Promise<{
        exists: boolean,
        files: Array<{ path: string, bytes: number }>,
        count: number,
        truncated: boolean,
    }> {
        const artifactPath = (args as { artifactPath?: unknown } | undefined)?.artifactPath;
        const maxFilesValue = (args as { maxFiles?: unknown } | undefined)?.maxFiles;
        if (typeof artifactPath !== 'string'
            || artifactPath.length === 0
            || /[\u0000-\u001f\u007f-\u009f]/u.test(artifactPath)
            || path.isAbsolute(artifactPath)
            || path.posix.isAbsolute(artifactPath)
            || path.win32.isAbsolute(artifactPath)
            || /^[A-Za-z]:/.test(artifactPath)
            || artifactPath.split(/[\\/]+/).some((segment) => segment === '..')) {
            throw new ToolError({
                code: 'INVALID_ARGUMENT',
                status: 400,
                message: 'artifactPath must be a nonempty relative path without traversal or control characters',
            });
        }
        if (maxFilesValue !== undefined
            && (!Number.isInteger(maxFilesValue) || (maxFilesValue as number) < 1 || (maxFilesValue as number) > 256)) {
            throw new ToolError({
                code: 'INVALID_ARGUMENT',
                status: 400,
                message: 'maxFiles must be an integer between 1 and 256',
            });
        }
        const maxFiles = (maxFilesValue as number | undefined) ?? 64;
        const isWithinProject = (candidate: string, projectRoot: string): boolean => {
            const relative = path.relative(projectRoot, candidate);
            return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
        };
        const isMissingError = (error: unknown): boolean => {
            const code = (error as { code?: unknown } | null)?.code;
            return code === 'ENOENT' || code === 'ENOTDIR';
        };
        const filesystemError = (operation: string, error: unknown): ToolError => new ToolError({
            code: 'BUILD_ARTIFACT_INSPECT_FAILED',
            status: 502,
            message: `Failed to ${operation} while inspecting the build artifact.`,
            details: { cause: (error instanceof Error ? error.message : String(error)).slice(0, 512) },
            recovery: 'Retry after the project filesystem is available.',
        });

        let projectRoot: string;
        try {
            projectRoot = await fs.realpath(path.resolve(Editor.Project.path));
        } catch (error) {
            throw filesystemError('resolve the project path', error);
        }
        const target = path.resolve(projectRoot, artifactPath);
        if (!isWithinProject(target, projectRoot)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'artifactPath must remain inside the project' });
        }

        let targetRealpath: string;
        try {
            targetRealpath = await fs.realpath(target);
        } catch (error) {
            if (isMissingError(error)) return { exists: false, files: [], count: 0, truncated: false };
            throw filesystemError('resolve the artifact path', error);
        }
        if (!isWithinProject(targetRealpath, projectRoot)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'artifactPath must remain inside the project' });
        }

        const files: Array<{ path: string, bytes: number }> = [];
        const visitedDirectories = new Set<string>();
        let truncated = false;
        type FrontierEntry = { current: string, relative: string };
        const frontier: FrontierEntry[] = [{
            current: target,
            relative: path.relative(projectRoot, target).replace(/\\/g, '/'),
        }];
        const compareEntries = (left: FrontierEntry, right: FrontierEntry): number => {
            if (left.relative < right.relative) return -1;
            if (left.relative > right.relative) return 1;
            return left.current < right.current ? -1 : left.current > right.current ? 1 : 0;
        };
        const pushFrontier = (entry: FrontierEntry): void => {
            frontier.push(entry);
            let index = frontier.length - 1;
            while (index > 0) {
                const parent = Math.floor((index - 1) / 2);
                if (compareEntries(frontier[parent], entry) <= 0) break;
                frontier[index] = frontier[parent];
                index = parent;
            }
            frontier[index] = entry;
        };
        const popFrontier = (): FrontierEntry | undefined => {
            const first = frontier[0];
            const last = frontier.pop();
            if (!first || !last || frontier.length === 0) return first;
            let index = 0;
            while (true) {
                const left = index * 2 + 1;
                if (left >= frontier.length) break;
                const right = left + 1;
                const child = right < frontier.length && compareEntries(frontier[right], frontier[left]) < 0 ? right : left;
                if (compareEntries(frontier[child], last) >= 0) break;
                frontier[index] = frontier[child];
                index = child;
            }
            frontier[index] = last;
            return first;
        };

        while (frontier.length > 0) {
            const next = popFrontier();
            if (!next) break;
            let realCurrent: string;
            try {
                realCurrent = await fs.realpath(next.current);
            } catch (error) {
                throw filesystemError('resolve an artifact entry', error);
            }
            if (!isWithinProject(realCurrent, projectRoot)) {
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'artifactPath must remain inside the project' });
            }
            let currentStat: { isDirectory(): boolean, size: number };
            try {
                currentStat = await fs.stat(next.current);
            } catch (error) {
                throw filesystemError('read an artifact entry', error);
            }
            if (!currentStat.isDirectory()) {
                if (files.length >= maxFiles) {
                    truncated = true;
                    break;
                }
                files.push({ path: next.relative, bytes: currentStat.size });
                continue;
            }
            if (visitedDirectories.has(realCurrent)) continue;
            visitedDirectories.add(realCurrent);
            let entries: string[];
            try {
                entries = await fs.readdir(next.current);
            } catch (error) {
                throw filesystemError('read an artifact directory', error);
            }
            for (const entry of entries) {
                const current = path.join(next.current, entry);
                pushFrontier({
                    current,
                    relative: path.relative(projectRoot, current).replace(/\\/g, '/'),
                });
            }
        }
        return { exists: true, files, count: files.length, truncated };
    }
    @utcpTool('buildOutputAudit', 'Verify bounded build output files, byte sizes and SHA-256 hashes against an expected manifest.', {
        type: 'object',
        properties: {
            artifactPath: { type: 'string' },
            expectedFiles: { type: 'array', maxItems: 256, items: { type: 'object', properties: { path: { type: 'string' }, sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' } }, required: ['path'] } },
        },
        required: ['artifactPath', 'expectedFiles'],
    }, { type: 'object', properties: { valid: { type: 'boolean' }, issues: { type: 'array' }, files: { type: 'array' }, checkedFiles: { type: 'integer' } }, required: ['valid', 'issues', 'files', 'checkedFiles'] }, 'GET', ['build', 'output', 'audit', 'hash'])
    async buildOutputAudit(args: { artifactPath: string, expectedFiles: Array<{ path: string, sha256?: string }> }): Promise<{ valid: boolean, issues: string[], files: Array<Record<string, unknown>>, checkedFiles: number }> {
        if (!Array.isArray(args?.expectedFiles) || args.expectedFiles.length > 256) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedFiles must be an array of at most 256 entries.' });
        }
        for (const expected of args.expectedFiles) {
            if (!expected || typeof expected !== 'object' || Array.isArray(expected) || typeof expected.path !== 'string' || !expected.path.trim() || (expected.sha256 !== undefined && (typeof expected.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(expected.sha256)))) {
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Each expected file requires a non-empty path and an optional 64-digit SHA-256 hash.' });
            }
        }
        const projectRoot = await fs.realpath(path.resolve((Editor.Project as any).path));
        const isWithin = (root: string, candidate: string): boolean => {
            const relative = path.relative(root, candidate);
            return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
        };
        const requestedRoot = path.resolve(projectRoot, args.artifactPath);
        if (!isWithin(projectRoot, requestedRoot)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'artifactPath must remain inside the project' });
        const artifactRoot = await fs.realpath(requestedRoot);
        if (!isWithin(projectRoot, artifactRoot)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'artifactPath must resolve inside the project' });
        const issues: string[] = [];
        const files: Array<Record<string, unknown>> = [];
        for (const expected of args.expectedFiles) {
            const target = path.resolve(artifactRoot, expected.path);
            if (!isWithin(artifactRoot, target)) {
                issues.push(`outside-artifact:${expected.path}`);
                continue;
            }
            const realTarget = await fs.realpath(target).catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
                throw error;
            });
            if (realTarget && !isWithin(artifactRoot, realTarget)) {
                issues.push(`outside-artifact:${expected.path}`);
                continue;
            }
            const stat = realTarget ? await fs.stat(realTarget) : null;
            if (!stat?.isFile()) {
                issues.push(`missing:${expected.path}`);
                continue;
            }
            const sha256 = await hashFile(realTarget!);
            const after = await fs.stat(realTarget!).catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
                throw error;
            });
            const currentTarget = await fs.realpath(target).catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
                throw error;
            });
            if (!after?.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || currentTarget !== realTarget) {
                issues.push(`changed:${expected.path}`);
                continue;
            }
            const row = { path: path.relative(projectRoot, target).replace(/\\/g, '/'), bytes: stat.size, sha256 };
            files.push(row);
            if (expected.sha256 && expected.sha256.toLowerCase() !== sha256) issues.push(`hash-mismatch:${expected.path}`);
        }
        return { valid: issues.length === 0 && files.length === args.expectedFiles.length, issues, files, checkedFiles: files.length };
    }
}
