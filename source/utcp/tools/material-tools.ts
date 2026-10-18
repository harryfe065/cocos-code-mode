import { utcpTool } from '../decorators';
import { InstanceReferenceSchema, IInstanceReference } from '../schemas';
import { TextDecoder } from 'util';
import { isMessageNotExposed } from '../utils/editor-message-error';
import { ToolError } from '../tool-error';
import { ImporterManager } from '../utils/asset-importers';
import { IAssetInfo } from '@cocos/creator-types/editor/packages/asset-db/@types/public';
import { MaterialImporter } from '../utils/asset-importers/material-importer';

function propertyAtPath(value: unknown, path: string): unknown {
    let current = value;
    for (const segment of path.split('.')) {
        if (!current || typeof current !== 'object') return undefined;
        if (Array.isArray(current)) {
            if (!/^\d+$/.test(segment)) return undefined;
            current = current[Number(segment)];
        } else {
            if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
            current = (current as Record<string, unknown>)[segment];
        }
        if (current && typeof current === 'object' && !Array.isArray(current) && 'value' in current) current = (current as Record<string, unknown>).value;
    }
    return current;
}

function jsonEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}
function cloneValue<T>(value: T): T {
    if (value === undefined) return value;
    return JSON.parse(JSON.stringify(value)) as T;
}


async function queryMaterial(id: string): Promise<unknown> {
    try {
        const result = await Editor.Message.request('scene', 'query-material' as any, id);
        if (!result) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Material ${id} was not readable.` });
        return result;
    } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError({ code: 'MATERIAL_QUERY_FAILED', status: 502, message: `Could not read material ${id}.`, details: { cause: error instanceof Error ? error.message : String(error) } });
    }
}
const DEFAULT_EFFECT_RESULTS = 200;
const MAX_EFFECT_RESULTS = 1000;
const DEFAULT_RAW_DATA_BYTES = 512 * 1024;
const MAX_RAW_DATA_BYTES = 1024 * 1024;
function boundedPositive(value: unknown, fallback: number, maximum: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.min(value, maximum)
        : fallback;
}

function truncateUtf8(value: string, maxBytes: number): string {
    const bytes = Buffer.from(value, 'utf8');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (let end = Math.min(bytes.length, maxBytes); end > 0; end--) {
        try {
            return decoder.decode(bytes.subarray(0, end));
        } catch {
            // Retry at the preceding byte boundary when maxBytes splits a code point.
        }
    }
    return '';
}


// Material / effect inspection and asset-db introspection.
//
// Message signatures come from the scene facade
// (@cocos/creator-types/.../cce/3d/facade/general-scene-facade.d.ts:139-142) and were
// checked against the 3.7.3 registry dump in docs/cc-3x7-message-registry.json.
// The facade types these as Promise<any>, so every result is passed through as-is —
// shapes are not runtime-verified yet.

export class MaterialTools {

    @utcpTool(
        'materialQuery',
        'Inspect materials/effects/render pipeline. Effects return at most 200 results by default and 1,000 at most.',
        {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['effects', 'effect', 'material', 'serialized_material', 'render_pipeline', 'physics_material'] },
                reference: { ...InstanceReferenceSchema, description: 'For material / serialized_material / render_pipeline / physics_material: the asset' },
                effectName: { type: 'string', description: 'For effect: the effect name as listed by the "effects" operation' },
                limit: { type: 'number', minimum: 1, maximum: MAX_EFFECT_RESULTS, default: DEFAULT_EFFECT_RESULTS, description: 'For effects: maximum effects returned' },
            },
            required: ['operation'],
            oneOf: [
                { properties: { operation: { const: 'effects' } } },
                { properties: { operation: { const: 'effect' } }, required: ['effectName'] },
                { properties: { operation: { const: 'material' } }, required: ['reference'] },
                { properties: { operation: { const: 'serialized_material' } }, required: ['reference'] },
                { properties: { operation: { const: 'render_pipeline' } }, required: ['reference'] },
                { properties: { operation: { const: 'physics_material' } }, required: ['reference'] },
            ],
        },
        { type: 'object', properties: { result: {}, total: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['result'] }, "GET",
        ['material', 'effect', 'shader', 'render', 'pipeline', 'inspect', 'physics']
    )
    async materialQuery(args: { operation: string, reference?: IInstanceReference, effectName?: string, limit?: number }): Promise<{ result: unknown, total?: number, truncated?: boolean }> {
        switch (args.operation) {
            case 'effects': {
                const rawEffects = await Editor.Message.request('scene', 'query-all-effects' as never);
                const effects: unknown[] = Array.isArray(rawEffects) ? rawEffects : [];
                const limit = boundedPositive(args.limit, DEFAULT_EFFECT_RESULTS, MAX_EFFECT_RESULTS);
                return { result: effects.slice(0, limit), total: effects.length, truncated: effects.length > limit };
            }

            case 'effect':
                if (!args.effectName) {
                    throw new ToolError({
                        code: 'INVALID_ARGUMENT',
                        status: 400,
                        message: 'materialQuery "effect" requires effectName.',
                    });
                }
                return { result: await Editor.Message.request('scene', 'query-effect' as any, args.effectName) };

            case 'material':
                if (!args.reference?.id) {
                    throw new ToolError({
                        code: 'INVALID_ARGUMENT',
                        status: 400,
                        message: 'materialQuery "material" requires reference.',
                    });
                }
                return { result: await Editor.Message.request('scene', 'query-material' as any, args.reference.id) };

            case 'serialized_material':
                if (!args.reference?.id) {
                    throw new ToolError({
                        code: 'INVALID_ARGUMENT',
                        status: 400,
                        message: 'materialQuery "serialized_material" requires reference.',
                    });
                }
                return { result: await Editor.Message.request('scene', 'query-serialized-material' as any, args.reference.id) };

            case 'render_pipeline':
                if (!args.reference?.id) {
                    throw new ToolError({
                        code: 'INVALID_ARGUMENT',
                        status: 400,
                        message: 'materialQuery "render_pipeline" requires reference.',
                    });
                }
                return { result: await Editor.Message.request('scene', 'query-render-pipeline' as any, args.reference.id) };

            case 'physics_material':
                if (!args.reference?.id) {
                    throw new ToolError({
                        code: 'INVALID_ARGUMENT',
                        status: 400,
                        message: 'materialQuery "physics_material" requires reference.',
                    });
                }
                return { result: await Editor.Message.request('scene', 'query-physics-material' as any, args.reference.id) };

            default:
                throw new ToolError({
                    code: 'INVALID_ARGUMENT',
                    status: 400,
                    message: `Unknown materialQuery operation: ${args.operation}`,
                });
        }
    }

    @utcpTool(
        'renderPipelineInspect',
        'Inspect one asset or scene render pipeline through Creator query-render-pipeline with bounded native read-back.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                reference: InstanceReferenceSchema,
                maxBytes: { type: 'integer', minimum: 1024, maximum: 262144, default: 65536 }
            },
            required: ['reference']
        },
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                pipeline: {},
                bytes: { type: 'integer' },
                truncated: { type: 'boolean' }
            },
            required: ['reference', 'pipeline', 'bytes', 'truncated']
        },
        'GET',
        ['render', 'pipeline', 'inspect', 'material']
    )
    async renderPipelineInspect(args: { reference?: IInstanceReference, maxBytes?: number }): Promise<{ reference: IInstanceReference, pipeline: unknown, bytes: number, truncated: boolean }> {
        if (!args?.reference?.id || typeof args.reference.id !== 'string') {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'renderPipelineInspect requires reference.' });
        }
        const maxBytes = args.maxBytes ?? 65536;
        if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 262144) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxBytes must be an integer from 1024 to 262144.' });
        }
        let pipeline: unknown;
        try {
            pipeline = await Editor.Message.request('scene', 'query-render-pipeline' as any, args.reference.id);
        } catch (error) {
            if (isMessageNotExposed(error, 'scene', 'query-render-pipeline')) {
                throw new ToolError({ code: 'UNSUPPORTED_EDITOR_API', status: 422, message: 'Creator does not expose scene/query-render-pipeline.', details: { api: 'scene/query-render-pipeline' } });
            }
            throw error;
        }
        if (pipeline === null || pipeline === undefined || pipeline === false) {
            throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Render pipeline target ${args.reference.id} was not found.` });
        }
        let bytes = 0;
        let serialized = '';
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const output = { reference: args.reference, pipeline, bytes, truncated: false };
            serialized = JSON.stringify(output);

            const nextBytes = Buffer.byteLength(serialized, 'utf8');
            if (nextBytes === bytes) break;
            bytes = nextBytes;
        }
        if (bytes > maxBytes) {
            throw new ToolError({ code: 'RENDER_PIPELINE_RESPONSE_TOO_LARGE', status: 413, message: `Render pipeline response is ${bytes} bytes; maxBytes is ${maxBytes}.`, details: { bytes, maxBytes } });
        }
        return { reference: args.reference, pipeline, bytes, truncated: false };
    }

    @utcpTool(
        'materialEdit',
        'Set material fields/defines/states (passes.<index>.properties|defines|states.<field>; legacy flat paths retained). Verify exact normalized native value and unchanged non-target passes. Native apply is invoked; source persistence, reimport/reopen and visual output are not implied.',
        {
            type: 'object',
            additionalProperties: false,
            properties: { reference: InstanceReferenceSchema, path: { type: 'string', minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9_.]+$' }, value: {} },
            required: ['reference', 'path', 'value']
        },
        {
            type: 'object',
            properties: { reference: InstanceReferenceSchema, path: { type: 'string' }, changed: { type: 'boolean' }, before: {}, after: {}, requestedValue: {}, readBackValue: {}, passIndices: { type: 'array', items: { type: 'integer' } }, verification: { type: 'object', properties: { requestedValueMatched: { type: 'boolean' }, unaffectedPassesUnchanged: { type: 'boolean' }, unaffectedPassesApplicable: { type: 'boolean' } }, required: ['requestedValueMatched', 'unaffectedPassesUnchanged', 'unaffectedPassesApplicable'] }, persistence: { type: 'object', properties: { nativeApplyInvoked: { type: 'boolean' }, sourceSaved: { type: ['boolean', 'null'] }, importCompleted: { type: ['boolean', 'null'] }, generatedOutputVerified: { type: ['boolean', 'null'] }, reimportVerified: { type: 'boolean' }, reopenVerified: { type: 'boolean' } }, required: ['nativeApplyInvoked', 'sourceSaved', 'importCompleted', 'generatedOutputVerified', 'reimportVerified', 'reopenVerified'] } },
            required: ['reference', 'path', 'changed', 'before', 'after']
        },
        'POST',
        ['material', 'edit', 'set', 'property']
    )
    async materialEdit(args: { reference?: IInstanceReference, path?: string, value?: unknown }): Promise<{ reference: IInstanceReference, path: string, changed: boolean, before: unknown, after: unknown, requestedValue: unknown, readBackValue: unknown, passIndices: number[], verification: { requestedValueMatched: boolean, unaffectedPassesUnchanged: boolean, unaffectedPassesApplicable: boolean }, persistence: { nativeApplyInvoked: boolean, sourceSaved: null, importCompleted: null, generatedOutputVerified: null, reimportVerified: false, reopenVerified: false } }> {
        if (!args?.reference?.id || typeof args.reference.id !== 'string') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'materialEdit requires reference.' });
        if (typeof args.path !== 'string' || !/^[A-Za-z0-9_.]{1,256}$/.test(args.path)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'materialEdit path must contain 1-256 identifier characters.' });
        const info = await Editor.Message.request('asset-db', 'query-asset-info', args.reference.id) as IAssetInfo | null;
        if (!info || info.importer !== 'material') throw new ToolError({ code: 'UNSUPPORTED_OPERATION', status: 422, message: `Asset ${args.reference.id} is not a material importer target.` });
        const materialId = typeof info.uuid === 'string' && info.uuid ? info.uuid : args.reference.id;
        const importer = ImporterManager.getInstance().getImporter('material');
        if (!(importer instanceof MaterialImporter)) throw new ToolError({ code: 'UNSUPPORTED_OPERATION', status: 422, message: 'The pass-aware material importer is unavailable.' });
        const plan = await importer.prepareEdit({ ...info, uuid: materialId }, args.path, args.value, await queryMaterial(materialId));
        if (!plan) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Material property '${args.path}' was not found or was not mutable.` });
        try {
            await importer.applyDump(materialId, plan.dump);
            const after = await importer.readBack(materialId, dump => {
                const result = importer.verifyEdit(plan, dump);
                return result.requestedValueMatched && result.unaffectedPassesUnchanged;
            });
            const verification = importer.verifyEdit(plan, after);
            if (!verification.requestedValueMatched || !verification.unaffectedPassesUnchanged) throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: `Material '${args.path}' did not match the normalized request or changed another pass.`, details: verification });
            return { reference: args.reference, path: args.path, changed: !importer.isRestored(plan.before, after), before: plan.before, after, requestedValue: verification.requestedValue, readBackValue: verification.readBackValue, passIndices: plan.passIndices, verification: { requestedValueMatched: true, unaffectedPassesUnchanged: true, unaffectedPassesApplicable: !plan.root }, persistence: { nativeApplyInvoked: true, sourceSaved: null, importCompleted: null, generatedOutputVerified: null, reimportVerified: false, reopenVerified: false } };
        } catch (error) {
            if (error instanceof ToolError && ['MATERIAL_MUTATION_OUTCOME_UNKNOWN', 'UNSUPPORTED_BROADCAST_IPC'].includes(error.code)) throw error;
            let rollbackCause: string | null = null;
            let restored = false;
            try {
                await importer.applyDump(materialId, plan.before);
                restored = importer.isRestored(plan.before, await importer.readBack(materialId, dump => importer.isRestored(plan.before, dump)));
            } catch (readError) { rollbackCause = String(readError); }
            if (!restored) throw new ToolError({ code: 'ROLLBACK_FAILED', status: 500, message: 'materialEdit failed and full material restoration could not be verified.', details: { cause: String(error), rollbackCause } });
            throw new ToolError({ code: error instanceof ToolError ? error.code : 'MUTATION_FAILED', status: error instanceof ToolError ? error.status : 502, message: `materialEdit failed for '${args.path}'; original material independently restored.`, details: { ...(error instanceof ToolError ? error.details : {}), rollback: 'verified-restored', cause: String(error), rollbackCause } });
        }
    }
    @utcpTool(
        'materialValidate',
        'Validate one material importer target with native and typed property read-back.',
        { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] },
        { type: 'object', additionalProperties: false, properties: { valid: { type: 'boolean' }, reference: InstanceReferenceSchema, importer: { type: 'string' }, issues: { type: 'array' }, native: {}, settings: {} }, required: ['valid', 'reference', 'importer', 'issues', 'native', 'settings'] },
        'GET', ['material', 'validate', 'inspect']
    )
    async materialValidate(args: { reference?: IInstanceReference }): Promise<{ valid: boolean, reference: IInstanceReference, importer: string, issues: Array<Record<string, unknown>>, native: unknown, settings: Record<string, unknown> }> {
        if (!args?.reference?.id || typeof args.reference.id !== 'string') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'materialValidate requires reference.' });
        const info = await Editor.Message.request('asset-db', 'query-asset-info', args.reference.id) as IAssetInfo | null;
        if (!info) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Material ${args.reference.id} was not found.` });
        if (info.importer !== 'material') throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Asset ${args.reference.id} is not a material importer target.` });
        const id = typeof info.uuid === 'string' && info.uuid ? info.uuid : args.reference.id;
        const native = await queryMaterial(id);
        const importer = ImporterManager.getInstance().getImporter('material');
        if (!importer) throw new ToolError({ code: 'UNSUPPORTED_OPERATION', status: 422, message: 'Material importer is unavailable.' });
        let settings: Record<string, unknown>;
        try {
            settings = await importer.getProperties({ ...info, uuid: id }) as unknown as Record<string, unknown>;
        } catch (error) {
            throw new ToolError({ code: 'IMPORTER_INSPECTION_FAILED', status: 502, message: `Material importer could not expose settings for ${id}.`, details: { cause: error instanceof Error ? error.message : String(error) } });
        }
        const issues: Array<Record<string, unknown>> = [];
        if (!native || typeof native !== 'object') issues.push({ code: 'NATIVE_READBACK_INVALID' });
        if (!settings || typeof settings !== 'object') issues.push({ code: 'IMPORTER_READBACK_INVALID' });
        return { valid: issues.length === 0, reference: { id, type: typeof info.type === 'string' ? info.type : 'cc.Material' }, importer: 'material', issues, native, settings };
    }

    @utcpTool(
        'renderConfigurationApply',
        'Apply bounded scene render-property updates with read-back and guarded restoration; not an atomic native transaction.',
        { type: 'object', additionalProperties: false, properties: { updates: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, path: { type: 'string', minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9_.]+$' }, value: {} }, required: ['reference', 'path', 'value'] } } }, required: ['updates'] },
        { type: 'object', additionalProperties: false, properties: { changed: { type: 'array' }, readBack: { type: 'array' }, verified: { type: 'boolean', const: true } }, required: ['changed', 'readBack', 'verified'] },
        'POST', ['render', 'configuration', 'apply', 'camera', 'light', 'fog', 'skybox']
    )
    async renderConfigurationApply(args: { updates?: Array<{ reference: IInstanceReference, path: string, value: unknown }> }): Promise<{ changed: string[], readBack: Array<Record<string, unknown>>, verified: true }> {
        if (!Array.isArray(args?.updates) || args.updates.length < 1 || args.updates.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'renderConfigurationApply requires 1 to 32 updates.' });
        const originals: Array<{ update: { reference: IInstanceReference, path: string, value: unknown }, original: unknown }> = [];
        for (const [index, update] of args.updates.entries()) {
            if (!update?.reference?.id || typeof update.reference.id !== 'string' || typeof update.path !== 'string' || !/^[A-Za-z0-9_.]{1,256}$/.test(update.path)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `updates[${index}] has an invalid reference or property path.` });
            if (originals.some(({ update: previous }) => previous.reference.id === update.reference.id && (
                previous.path === update.path || previous.path.startsWith(`${update.path}.`) || update.path.startsWith(`${previous.path}.`)
            ))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Render updates must not contain duplicate or overlapping paths on the same target.' });
            const node = await Editor.Message.request('scene', 'query-node', update.reference.id) as unknown as Record<string, unknown> | null;
            if (!node) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Render configuration target ${update.reference.id} was not found.` });
            originals.push({ update, original: cloneValue(propertyAtPath(node, update.path)) });
        }
        const applied: typeof originals = [];
        let mutationPending = false;
        try {
            for (const entry of originals) {
                applied.push(entry);
                mutationPending = true;
                const result = await Editor.Message.request('scene', 'set-property', { uuid: entry.update.reference.id, path: entry.update.path, dump: { value: entry.update.value as never, type: 'Unknown' } });
                mutationPending = false;
                if (result === false) throw new Error(`Creator refused ${entry.update.path}`);
            }
            await Editor.Message.request('scene', 'snapshot');
            const readBack: Array<Record<string, unknown>> = [];
            for (const entry of originals) {
                const node = await Editor.Message.request('scene', 'query-node', entry.update.reference.id) as unknown as Record<string, unknown> | null;
                const actual = node ? propertyAtPath(node, entry.update.path) : undefined;
                if (!jsonEqual(actual, entry.update.value)) throw new Error(`read-back mismatch for ${entry.update.path}`);
                readBack.push({ reference: entry.update.reference, path: entry.update.path, value: actual });
            }
            return { changed: originals.map((entry) => entry.update.path), readBack, verified: true };
        } catch (error) {
            if (mutationPending) throw new ToolError({ code: 'RENDER_MUTATION_OUTCOME_UNKNOWN', status: 502, message: 'Render property dispatch did not return a settled outcome; no restoration was dispatched.', details: { retrySafe: false, restored: null }, recovery: 'Inspect affected targets and reconcile the in-flight request before another mutation.' });
            try {
                for (const entry of [...applied].reverse()) {
                    const current = await Editor.Message.request('scene', 'query-node', entry.update.reference.id) as unknown as Record<string, unknown> | null;
                    if (!current) throw new Error('Render target is unavailable before restoration.');
                    const observed = propertyAtPath(current, entry.update.path);
                    if (jsonEqual(observed, entry.original)) continue;
                    if (!jsonEqual(observed, entry.update.value)) throw new Error('Render property changed outside this update; restoration refused.');
                    const result = await Editor.Message.request('scene', 'set-property', { uuid: entry.update.reference.id, path: entry.update.path, dump: { value: entry.original as never, type: 'Unknown' } });
                    if (result === false) throw new Error(`Creator refused rollback ${entry.update.path}`);
                }
                await Editor.Message.request('scene', 'snapshot');
                for (const entry of applied) {
                    const node = await Editor.Message.request('scene', 'query-node', entry.update.reference.id) as unknown as Record<string, unknown> | null;
                    const restored = node ? propertyAtPath(node, entry.update.path) : undefined;
                    if (!jsonEqual(restored, entry.original)) throw new Error(`rollback read-back mismatch for ${entry.update.path}`);
                }
            } catch (rollbackError) {
                throw new ToolError({ code: 'ROLLBACK_FAILED', status: 500, message: 'renderConfigurationApply failed and could not restore scene properties.', details: { cause: error instanceof Error ? error.message : String(error), rollbackCause: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) } });
            }
            throw new ToolError({ code: 'MUTATION_FAILED', status: 502, message: 'renderConfigurationApply failed.', details: { cause: error instanceof Error ? error.message : String(error) } });
        }
    }

    @utcpTool(
        'renderDiagnosticsCollect',
        'Collect editor-side render pipeline diagnostics for one target without claiming runtime frame sampling.',
        { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, maxBytes: { type: 'integer', minimum: 1024, maximum: 262144, default: 65536 } }, required: ['reference'] },
        { type: 'object', properties: { reference: InstanceReferenceSchema, supported: { type: 'boolean' }, pipeline: {}, diagnostics: { type: 'array' }, runtimeSampling: { type: 'boolean', const: false } }, required: ['reference', 'supported', 'diagnostics', 'runtimeSampling'] },
        'GET', ['render', 'diagnostics', 'editor', 'inspect']
    )
    async renderDiagnosticsCollect(args: { reference?: IInstanceReference, maxBytes?: number }): Promise<{ reference: IInstanceReference, supported: boolean, pipeline?: unknown, diagnostics: Array<Record<string, unknown>>, runtimeSampling: false }> {
        if (!args?.reference?.id || typeof args.reference.id !== 'string') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'renderDiagnosticsCollect requires reference.' });
        try {
            const inspected = await this.renderPipelineInspect({ reference: args.reference, maxBytes: args.maxBytes });
            return { reference: inspected.reference, supported: true, pipeline: inspected.pipeline, diagnostics: [], runtimeSampling: false };
        } catch (error) {
            if (error instanceof ToolError && error.code === 'TARGET_NOT_FOUND') throw error;
            if (error instanceof ToolError && error.code === 'UNSUPPORTED_EDITOR_API') return { reference: args.reference, supported: false, diagnostics: [{ code: error.code, message: error.message }], runtimeSampling: false };
            throw error;
        }
    }
    @utcpTool(
        'assetDbQuery',
        'Introspect asset-db: databases list, busy status, mtime, raw imported data, ready/missing. Raw data is capped at 512KB by default and 1MB at most.',
        {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['databases', 'busy', 'mtime', 'data', 'db_info', 'meta', 'ready', 'missing'] },
                reference: { ...InstanceReferenceSchema, description: 'For mtime / data / meta / missing: the asset; db_info also accepts reference.id' },
                dbName: { type: 'string', description: 'For db_info: database name, e.g. assets or internal' },
                maxBytes: { type: 'number', minimum: 1, maximum: MAX_RAW_DATA_BYTES, default: DEFAULT_RAW_DATA_BYTES, description: 'For data: maximum serialized bytes returned' },
            },
            required: ['operation'],
            oneOf: [
                { properties: { operation: { const: 'databases' } } },
                { properties: { operation: { const: 'busy' } } },
                { properties: { operation: { const: 'mtime' } }, required: ['reference'] },
                { properties: { operation: { const: 'data' } }, required: ['reference'] },
                { properties: { operation: { const: 'db_info' } } },
                { properties: { operation: { const: 'meta' } }, required: ['reference'] },
                { properties: { operation: { const: 'ready' } } },
                { properties: { operation: { const: 'missing' } }, required: ['reference'] },
            ],
        },
        { type: 'object', properties: { result: {}, bytes: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['result'] }, "GET",
        ['asset', 'database', 'db', 'mtime', 'busy', 'introspect', 'db-info', 'meta', 'ready', 'missing']
    )
    async assetDbQuery(args: { operation: string, reference?: IInstanceReference, dbName?: string, maxBytes?: number }): Promise<{ result: unknown, bytes?: number, truncated?: boolean }> {
        switch (args.operation) {
            case 'databases':
                return { result: await Editor.Message.request('asset-db', 'query-db-list' as any) };

            case 'busy':
                return { result: await Editor.Message.request('asset-db', 'is-busy' as any) };

            case 'mtime':
                if (!args.reference?.id) {
                    throw new Error('assetDbQuery "mtime" requires reference');
                }
                return { result: await Editor.Message.request('asset-db', 'query-asset-mtime' as any, args.reference.id) };

            case 'data': {
                if (!args.reference?.id) {
                    throw new Error('assetDbQuery "data" requires reference');
                }
                const rawData = await Editor.Message.request('asset-db', 'query-asset-data' as never, args.reference.id);
                const serialized = JSON.stringify(rawData) ?? 'null';
                const bytes = Buffer.byteLength(serialized, 'utf8');
                const maxBytes = boundedPositive(args.maxBytes, DEFAULT_RAW_DATA_BYTES, MAX_RAW_DATA_BYTES);
                if (bytes > maxBytes) {
                    const content = truncateUtf8(serialized, maxBytes);
                    return { result: content, bytes, truncated: true };
                }
                return { result: rawData, bytes, truncated: false };
            }

            case 'db_info': {
                const name = args.dbName || args.reference?.id || 'assets';
                return { result: await Editor.Message.request('asset-db', 'query-db-info' as any, name) };
            }

            // Read side of assetOperate save_meta — meta writes are read-modify-write.
            case 'meta':
                if (!args.reference?.id) {
                    throw new Error('assetDbQuery "meta" requires reference');
                }
                return { result: await Editor.Message.request('asset-db', 'query-asset-meta' as any, args.reference.id) };

            case 'ready':
                // Typed in creator-types (asset-db::query-ready) — polls whether the
                // asset-db has finished its initial open.
                return { result: await Editor.Message.request('asset-db', 'query-ready' as any) };

            case 'missing': {
                // Typed in creator-types (asset-db::query-missing-asset-info) —
                // returns MissingAssetInfo for dangling refs in the asset graph.
                if (!args.reference?.id) {
                    throw new Error('assetDbQuery "missing" requires reference.id (uuid or db:// path string)');
                }
                try {
                    return { result: await Editor.Message.request('asset-db', 'query-missing-asset-info' as any, args.reference.id) };
                } catch (e: any) {
                    if (isMessageNotExposed(e, 'asset-db', 'query-missing-asset-info')) {
                        throw new ToolError({
                            code: 'UNSUPPORTED_EDITOR_API',
                            message: 'assetDbQuery "missing" is not supported by Cocos Creator 3.7.3.',
                            recovery: 'Use meta or data for a known asset reference, or upgrade to a Creator version exposing query-missing-asset-info.',
                        });
                    }
                    throw e;
                }
            }

            default:
                throw new Error(`Unknown assetDbQuery operation: ${args.operation}`);
        }
    }
}
