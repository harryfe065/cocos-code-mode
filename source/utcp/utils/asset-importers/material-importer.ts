import { z } from '../../../schema-validator';
import type { infer as InferSchema } from 'zod';
import { BaseAssetImporter } from './base-importer';
import { IAssetInfo } from '@cocos/creator-types/editor/packages/asset-db/@types/public';
import { IPropertyValueType } from '@cocos/creator-types/editor/packages/scene/@types/public';
import { ToolError } from '../../tool-error';

const descriptorSchema = z.looseObject({
    name: z.string().optional(), type: z.string().optional(), value: z.unknown(),
    readonly: z.boolean().optional(), isObject: z.boolean().optional(), isArray: z.boolean().optional(),
    defines: z.array(z.string()).optional(), range: z.array(z.number()).optional(), options: z.array(z.string()).optional(),
    enumList: z.array(z.looseObject({ name: z.union([z.string(), z.number()]), value: z.unknown() })).optional(),
    extends: z.array(z.string()).optional(), displayName: z.string().optional(),
});
const passSchema = z.looseObject({ props: z.array(descriptorSchema).optional(), defines: z.array(descriptorSchema).optional(), states: descriptorSchema.optional(), phase: z.union([z.string(), z.number()]).optional() });
const dumpSchema = z.looseObject({ effect: z.string(), technique: z.number().int().nonnegative(), data: z.array(z.looseObject({ name: z.string().optional(), passes: z.array(passSchema) })) });
const effectsSchema = z.record(z.string(), z.looseObject({ name: z.string(), uuid: z.string().optional(), hideInEditor: z.boolean().optional() }));
const objectSchema = z.record(z.string(), z.unknown());
const referenceSchema = z.looseObject({ uuid: z.string().optional(), __uuid__: z.string().optional(), id: z.string().optional(), name: z.string().optional() });
const textureAssetSchema = z.looseObject({ uuid: z.string().min(1), type: z.string().optional(), importer: z.string().optional() });
type MaterialDump = InferSchema<typeof dumpSchema>;
type Descriptor = InferSchema<typeof descriptorSchema>;
type MaterialSlot = { parent: Record<string, unknown> | unknown[], key: string, path: string[], descriptor?: Descriptor };
type MaterialEditPlan = { dump: MaterialDump, before: MaterialDump, targets: Array<{ path: string[], before: unknown, requested: unknown, texture: boolean }>, passIndices: number[], technique: number, root: boolean };

function materialValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(materialValue);
    if (value && typeof value === 'object') {
        const object = objectSchema.parse(value);
        if ('value' in object && ('type' in object || 'isObject' in object || 'isArray' in object)) return materialValue(object.value);
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(object).sort()) result[key] = materialValue(object[key]);
        return result;
    }
    return value;
}
function materialEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => materialEqual(value, right[index]));
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    const leftObject = objectSchema.parse(left);
    const rightObject = objectSchema.parse(right);
    const keys = Object.keys(leftObject);
    return keys.length === Object.keys(rightObject).length && keys.every(key => Object.prototype.hasOwnProperty.call(rightObject, key) && materialEqual(leftObject[key], rightObject[key]));
}
function cloneDump<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function readNativePath(dump: unknown, path: string[]): unknown {
    let value = dump;
    for (const key of path) {
        if (Array.isArray(value)) value = value[Number(key)];
        // Traversal stays on the already-validated cloned dump; reparsing would detach mutable children.
        else if (value && typeof value === 'object') value = (value as Record<string, unknown>)[key];
        else return undefined;
    }
    return value;
}
function slotValue(slot: MaterialSlot): unknown { return readNativePath(slot.parent, [slot.key]); }
function writeSlot(slot: MaterialSlot, value: unknown): void {
    if (Array.isArray(slot.parent)) slot.parent[Number(slot.key)] = value;
    else slot.parent[slot.key] = value;
}
function slotAt(parent: unknown, key: string, path: string[], descriptor?: Descriptor): MaterialSlot | null {
    if (!parent || typeof parent !== 'object' || !Object.prototype.hasOwnProperty.call(parent, key)) return null;
    const value = readNativePath(parent, [key]);
    if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value && ('type' in value || 'isObject' in value || 'isArray' in value)) {
        const parsed = descriptorSchema.parse(value);
        // The validated descriptor belongs to the mutable cloned native dump, not a schema copy.
        return { parent: value as Record<string, unknown>, key: 'value', path: [...path, 'value'], descriptor: parsed };
    }
    // Parent comes from the validated dump or one of its JSON object/array members.
    return { parent: parent as Record<string, unknown> | unknown[], key, path, descriptor };
}
function descend(slot: MaterialSlot | null, segments: string[]): MaterialSlot | null {
    for (const segment of segments) {
        if (!slot || slot.descriptor?.readonly) return null;
        slot = slotAt(slotValue(slot), segment, [...slot.path, segment]);
    }
    return slot?.descriptor?.readonly ? null : slot;
}
function passSlot(pass: InferSchema<typeof passSchema>, base: string[], segments: string[]): MaterialSlot | null {
    const group = segments[0];
    const explicit = ['properties', 'props', 'defines', 'states'].includes(group);
    const name = segments[explicit ? 1 : 0];
    const tail = segments.slice(explicit ? 2 : 1);
    if (!name) return null;
    const collections: Array<'props' | 'defines'> = explicit ? group === 'states' ? [] : [group === 'defines' ? 'defines' : 'props'] : ['props', 'defines'];
    for (const collection of collections) {
        const entries = pass[collection];
        const index = entries?.findIndex(entry => entry.name === name) ?? -1;
        if (entries && index >= 0) {
            // Texture references are validated as whole identities, never editable uuid/id subfields.
            if (tail.length && /texture|sampler/i.test(entries[index].type || '')) return null;
            return descend(slotAt(entries[index], 'value', [...base, collection, String(index), 'value'], entries[index]), tail);
        }
    }
    if (explicit && group !== 'states') return null;
    if (pass.states?.readonly) return null;
    return descend(slotAt(pass.states?.value, name, [...base, 'states', 'value', name]), tail);
}
function textureIdentity(value: unknown): string | null | undefined {
    if (value === null || value === '') return null;
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const reference = referenceSchema.parse(value);
        const id = reference.uuid ?? reference.__uuid__ ?? reference.id;
        if (typeof id === 'string') return id || null;
    }
    return undefined;
}

export class MaterialImporter extends BaseAssetImporter {
    name = 'material';

    async getProperties(assetInfo: IAssetInfo): Promise<{ [key: string]: IPropertyValueType }> {
        const dump = dumpSchema.parse(await Editor.Message.request('scene', 'query-material', assetInfo.uuid));
        const effects = Object.values(effectsSchema.parse(await Editor.Message.request('scene', 'query-all-effects'))).filter(effect => !effect.hideInEditor).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        const container: Record<string, unknown> = {
            effect: { value: dump.effect, type: 'Enum', userData: { enumName: 'MaterialEffectAssetName' }, enumList: effects.map(effect => ({ name: effect.name.replace('../', ''), value: effect.name })), visible: true, readonly: false },
            technique: { value: dump.technique, type: 'Enum', enumList: dump.data.map((technique, index) => ({ name: technique.name || String(index), value: index })), visible: true, readonly: false },
        };
        const passes = dump.data[dump.technique]?.passes.map((pass, index) => {
            const fields: Record<string, unknown> = {};
            const properties: Record<string, unknown> = {};
            const defines: Record<string, unknown> = {};
            const defineMap = Object.fromEntries((pass.defines || []).map(define => [define.name, define.value]));
            for (const [group, entries] of [['defines', pass.defines || []], ['properties', pass.props || []]] as const) {
                for (const entry of entries) {
                    if (!entry.name) continue;
                    const property: Record<string, unknown> = { ...entry, visible: (entry.defines || []).every(name => name.startsWith('!') ? !defineMap[name.slice(1)] : !!defineMap[name]) };
                    if (group === 'defines') {
                        if (entry.type !== 'Number' && entry.type !== 'String' && entry.type !== 'Enum') property.type = 'Boolean';
                        if (entry.options) { property.type = 'Enum'; property.enumList = entry.options.map(value => ({ name: value, value })); }
                        else if (entry.type === 'Number' && entry.range && entry.range[1] - entry.range[0] <= 256) {
                            property.type = 'Enum'; property.enumList = Array.from({ length: entry.range[1] - entry.range[0] + 1 }, (_, offset) => ({ name: `Variant${entry.range![0] + offset}`, value: entry.range![0] + offset }));
                        }
                    } else if (['Vec2', 'Vec3', 'Vec4', 'Color', 'Rect', 'Size', 'Quat', 'Mat3', 'Mat4'].includes(entry.type || '')) {
                        property.extends = (entry.extends || []).includes('cc.ValueType') ? entry.extends : [...(entry.extends || []), 'cc.ValueType'];
                    }
                    fields[entry.name] = property;
                    (group === 'defines' ? defines : properties)[entry.name] = property;
                }
            }
            fields.properties = { type: 'cc.Object', value: properties, visible: true };
            fields.defines = { type: 'cc.Object', value: defines, visible: true };
            if (pass.states) {
                fields.states = pass.states;
                if (pass.states.value && typeof pass.states.value === 'object' && !Array.isArray(pass.states.value)) for (const [name, state] of Object.entries(objectSchema.parse(pass.states.value))) if (!(name in fields)) fields[name] = state;
            }
            fields.phase = { type: 'String', value: pass.phase ?? '', readonly: true, visible: true, extends: [] };
            return { type: `cc.MaterialPass${Object.keys(properties).length + Object.keys(defines).length ? index : ''}`, extends: ['cc.MaterialPass'], value: fields };
        });
        if (passes) container.passes = { type: 'cc.MaterialPasses', value: passes, visible: true };
        // These runtime-validated native descriptors retain the Creator property-wrapper contract.
        return container as unknown as { [key: string]: IPropertyValueType };
    }

    async prepareEdit(assetInfo: IAssetInfo, path: string, value: unknown, nativeDump?: unknown): Promise<MaterialEditPlan | null> {
        if (!/^[A-Za-z0-9_.]{1,256}$/.test(path) || path.split('.').some(segment => !segment || ['__proto__', 'prototype', 'constructor'].includes(segment))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Material path must use safe, nonempty identifier segments.' });
        let encoded: string | undefined;
        try { encoded = JSON.stringify(value); } catch { /* Refuse values that cannot cross IPC. */ }
        if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 65536 || !materialEqual(value, JSON.parse(encoded))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Material value must be lossless JSON of at most 65536 bytes.' });
        if (assetInfo.readonly) throw new ToolError({ code: 'READONLY_TARGET', status: 422, message: 'Material asset is read-only.' });
        const before = dumpSchema.parse(cloneDump(nativeDump ?? await Editor.Message.request('scene', 'query-material', assetInfo.uuid)));
        const dump = cloneDump(before);
        const technique = dump.technique;
        const slots: MaterialSlot[] = [];
        const passIndices: number[] = [];
        const root = ['effect', 'effectAsset', 'technique'].includes(path);
        if (path === 'effect' || path === 'effectAsset') {
            const effects = Object.values(effectsSchema.parse(await Editor.Message.request('scene', 'query-all-effects')));
            const reference = typeof value === 'object' && value !== null && !Array.isArray(value) ? referenceSchema.parse(value) : null;
            const identity = typeof value === 'string' ? value : reference?.name ?? reference?.uuid ?? reference?.id;
            const effect = effects.find(entry => entry.name === identity || entry.uuid === identity);
            if (!effect) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Effect '${String(identity)}' not found.` });
            value = effect.name;
            if (effect.name !== dump.effect) {
                // Match the stock Inspector: a new effect rebuilds its techniques and selects index zero.
                const data = await Editor.Message.request('scene', 'query-effect', effect.name);
                dump.data = dumpSchema.shape.data.parse(data);
                dump.technique = 0;
            }
            const slot = slotAt(dump, 'effect', ['effect']);
            if (slot) slots.push(slot);
        } else if (path === 'technique') {
            if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || !dump.data[value]) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Material technique must select an existing technique index.' });
            const slot = slotAt(dump, 'technique', ['technique']);
            if (slot) slots.push(slot);
        } else {
            const segments = path.split('.');
            const passes = dump.data[technique]?.passes;
            if (!passes) return null;
            const explicit = segments[0] === 'passes';
            if (explicit && !/^(0|[1-9]\d*)$/.test(segments[1] ?? '')) return null;
            const indices = explicit ? [Number(segments[1])] : passes.map((_, index) => index);
            for (const index of indices) {
                if (!passes[index]) continue;
                const slot = passSlot(passes[index], ['data', String(technique), 'passes', String(index)], explicit ? segments.slice(2) : segments);
                if (slot) { slots.push(slot); passIndices.push(index); }
            }
        }
        if (!slots.length) return null;
        const targets: MaterialEditPlan['targets'] = [];
        for (const slot of slots) {
            let requested = value;
            const texture = /texture|sampler/i.test(slot.descriptor?.type || '');
            if (texture) {
                const id = textureIdentity(value);
                if (id === undefined) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Texture must be null, an asset UUID, or a uuid/id/__uuid__ reference.' });
                let uuid = id;
                if (id) {
                    const rawInfo = await Editor.Message.request('asset-db', 'query-asset-info', id);
                    const info = rawInfo ? textureAssetSchema.parse(rawInfo) : null;
                    const expectedCube = /cube/i.test(slot.descriptor?.type || '');
                    if (!info || !/texture/i.test(String(info.type ?? info.importer)) || expectedCube !== /cube/i.test(String(info.type ?? info.importer))) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Texture '${id}' is incompatible; use the imported texture sub-asset UUID, not its source image.` });
                    uuid = info.uuid;
                }
                requested = typeof slotValue(slot) === 'string' ? uuid ?? '' : { uuid: uuid ?? '' };
            } else {
                const descriptor = slot.descriptor;
                if (descriptor?.readonly) return null;
                const scalar = materialValue(value);
                const choices = descriptor?.enumList?.map(entry => entry.value) ?? descriptor?.options;
                if ((descriptor?.type === 'Boolean' && typeof scalar !== 'boolean') || (descriptor?.type === 'Number' && (typeof scalar !== 'number' || !Number.isFinite(scalar))) || (choices && !choices.some(choice => materialEqual(choice, scalar))) || (descriptor?.range && typeof scalar === 'number' && (scalar < descriptor.range[0] || scalar > descriptor.range[1]))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Material value does not match the native property type/range/options.' });
            }
            targets.push({ path: slot.path, before: texture ? textureIdentity(slotValue(slot)) : materialValue(slotValue(slot)), requested: texture ? textureIdentity(requested) : materialValue(requested), texture });
            writeSlot(slot, cloneDump(requested));
        }
        return { dump, before, targets, passIndices, technique, root };
    }

    verifyEdit(plan: MaterialEditPlan, nativeAfter: unknown): { requestedValue: unknown, readBackValue: unknown, requestedValueMatched: boolean, unaffectedPassesUnchanged: boolean } {
        const after = dumpSchema.parse(nativeAfter);
        const expected = plan.targets.map(target => target.requested);
        const readBack = plan.targets.map(target => {
            const identityIndex = target.path.findIndex(segment => segment === 'props' || segment === 'defines');
            if (identityIndex >= 0) {
                const identityPath = [...target.path.slice(0, identityIndex + 2), 'name'];
                if (readNativePath(plan.before, identityPath) !== readNativePath(after, identityPath)) return undefined;
            }
            return target.texture ? textureIdentity(readNativePath(after, target.path)) : materialValue(readNativePath(after, target.path));
        });
        let unaffectedPassesUnchanged = true;
        if (!plan.root) {
            unaffectedPassesUnchanged = materialEqual(after.effect, plan.before.effect) && materialEqual(after.technique, plan.before.technique) && after.data.length === plan.before.data.length;
            for (let technique = 0; technique < plan.before.data.length; technique++) {
                const previousPasses = plan.before.data[technique].passes;
                const currentPasses = after.data[technique]?.passes;
                if (previousPasses.length !== currentPasses?.length) unaffectedPassesUnchanged = false;
                for (let pass = 0; pass < previousPasses.length; pass++) {
                    if (technique === plan.technique && plan.passIndices.includes(pass)) continue;
                    if (!materialEqual(previousPasses[pass], currentPasses?.[pass])) unaffectedPassesUnchanged = false;
                }
            }
        }
        return { requestedValue: expected.length === 1 ? expected[0] : expected, readBackValue: readBack.length === 1 ? readBack[0] : readBack, requestedValueMatched: materialEqual(expected, readBack), unaffectedPassesUnchanged };
    }

    isRestored(before: unknown, restored: unknown): boolean { return materialEqual(before, restored); }

    async applyDump(uuid: string, dump: unknown): Promise<void> {
        const messages = Editor.Message as typeof Editor.Message & {
            addBroadcastListener?: (topic: string, listener: (uuid: string, info: unknown) => void) => void;
            removeBroadcastListener?: (topic: string, listener: (uuid: string, info: unknown) => void) => void;
        };
        if (typeof messages.addBroadcastListener !== 'function' || typeof messages.removeBroadcastListener !== 'function') throw new ToolError({ code: 'UNSUPPORTED_BROADCAST_IPC', status: 422, message: 'Material save requires Creator asset import completion broadcasts.' });
        let complete!: (info: Record<string, unknown>) => void;
        const imported = new Promise<Record<string, unknown>>(resolve => { complete = resolve; });
        let dispatched = false;
        let active = true;
        const onChanged = (id: string, info: unknown): void => {
            if (!active || !dispatched || id !== uuid || !info || typeof info !== 'object') return;
            const asset = objectSchema.parse(info);
            if (asset.uuid === uuid && asset.imported === true) complete(asset);
        };
        let timer: NodeJS.Timeout | undefined;
        messages.addBroadcastListener('asset-db:asset-change', onChanged);
        try {
            await Promise.race([
                (async () => {
                    // Both stock 3.7/3.8 Inspectors preview before applying. The facade drops
                    // applyMaterial's promise, so its IPC reply is not a save/import barrier.
                    await messages.request('scene', 'preview-material', uuid, dump, { emit: true });
                    if (!active) return;
                    dispatched = true;
                    await messages.request('scene', 'apply-material', uuid, dump);
                    const info = await imported;
                    if (info.invalid !== false || info.importer !== 'material') throw new ToolError({ code: 'MATERIAL_IMPORT_FAILED', status: 502, message: 'Creator completed the material import without a valid material asset.' });
                })(),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Material import completion deadline exceeded.')), 5000); }),
            ]);
        } catch (error) {
            if (error instanceof ToolError && error.code === 'MATERIAL_IMPORT_FAILED') throw error;
            // A missing reply/event does not cancel the native save. Never race it with
            // another write, including an automatic restoration of the previous dump.
            throw new ToolError({ code: 'MATERIAL_MUTATION_OUTCOME_UNKNOWN', status: 504, message: 'Material preview/save did not reach confirmed import completion; no restoration was dispatched.', details: { retrySafe: false, restored: null, cause: String(error) } });
        } finally {
            active = false;
            clearTimeout(timer);
            messages.removeBroadcastListener('asset-db:asset-change', onChanged);
        }
        messages.broadcast('material-inspector:change-dump');
    }

    async readBack(uuid: string, matches: (dump: unknown) => boolean): Promise<unknown> {
        // Asset change is emitted before the scene's asynchronous cached asset reload.
        // Only reads are repeated; a save is never retried to make read-back converge.
        const deadline = Date.now() + 3000;
        let last: unknown;
        for (let attempt = 0; attempt < 31; attempt++) {
            let timer: NodeJS.Timeout | undefined;
            try {
                last = await Promise.race([
                    Editor.Message.request('scene', 'query-material', uuid),
                    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ToolError({ code: 'MATERIAL_READBACK_TIMEOUT', status: 504, message: 'Material read-back exceeded its bounded cache reload deadline.' })), Math.max(1, deadline - Date.now())); }),
                ]);
            } finally { clearTimeout(timer); }
            if (matches(last) || Date.now() >= deadline || attempt === 30) return last;
            await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
        }
        return last;
    }

    async setProperty(assetInfo: IAssetInfo, path: string, value: unknown): Promise<boolean> {
        const plan = await this.prepareEdit(assetInfo, path, value);
        if (!plan) return false;
        try {
            await this.applyDump(assetInfo.uuid, plan.dump);
            const verified = this.verifyEdit(plan, await this.readBack(assetInfo.uuid, after => {
                const result = this.verifyEdit(plan, after);
                return result.requestedValueMatched && result.unaffectedPassesUnchanged;
            }));
            if (!verified.requestedValueMatched || !verified.unaffectedPassesUnchanged) throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: 'Material requested value or unaffected pass read-back mismatch.', details: verified });
            return true;
        } catch (error) {
            if (error instanceof ToolError && ['MATERIAL_MUTATION_OUTCOME_UNKNOWN', 'UNSUPPORTED_BROADCAST_IPC'].includes(error.code)) throw error;
            let rollbackCause: string | null = null;
            let restored = false;
            let rollback: 'partial' | 'unknown' = 'unknown';
            try {
                await this.applyDump(assetInfo.uuid, plan.before);
                restored = this.isRestored(plan.before, await this.readBack(assetInfo.uuid, after => this.isRestored(plan.before, after)));
                rollback = 'partial';
            } catch (readError) { rollbackCause = String(readError); }
            if (!restored) throw new ToolError({ code: 'ROLLBACK_FAILED', status: 500, message: 'Material edit failed; full native dump restoration could not be verified.', details: { rollback, cause: String(error), rollbackCause } });
            throw new ToolError({ code: error instanceof ToolError ? error.code : 'MUTATION_FAILED', status: 502, message: 'Material edit failed; original native dump was independently restored.', details: { rollback: 'verified-restored', cause: String(error), rollbackCause } });
        }
    }
}
