import { componentScriptHash, preflightComponentScriptPath, queryComponentScriptAsset, readComponentScriptSource, resolveComponentScriptPath } from '../../component-script-source';
import type { IInstanceReference } from '../schemas';
import { ToolError } from '../tool-error';
import { invalidateAfterWrite } from './memo-cache';

export type UiRuntimeProperty =
    | { name: string; type: 'cc.Node'; value: string }
    | { name: string; type: 'cc.Node[]'; value: string[] }
    | { name: string; type: 'Number'; value: number }
    | { name: string; type: 'Boolean'; value: boolean };
export interface UiRuntimeComponentInstallResult {
    scriptReference: IInstanceReference;
    componentReference: IInstanceReference;
    assetUrl: string;
    sourceSha256: string;
    sourceCreated: boolean;
    configured: true;
    runtimeVerified: false;
    sceneSaved: false;
}
type Row = Record<string, unknown>;
function record(raw: unknown): raw is Row { return raw !== null && typeof raw === 'object' && !Array.isArray(raw); }
function field(raw: unknown, key: string): unknown { return record(raw) ? raw[key] : undefined; }
function value(raw: unknown): unknown { return record(raw) && 'value' in raw ? raw.value : raw; }
function uuid(raw: unknown): string | undefined {
    const unwrapped = value(raw);
    const id = typeof unwrapped === 'string' ? unwrapped : value(field(unwrapped, 'uuid'));
    return typeof id === 'string' && id ? id : undefined;
}
function componentUuid(raw: unknown): string | undefined { return uuid(field(field(raw, 'value'), 'uuid') ?? field(raw, 'uuid') ?? field(raw, 'value')); }
function componentClass(raw: unknown): string | undefined {
    const id = value(field(field(raw, 'value'), '__type__')) ?? field(raw, 'cid') ?? field(field(raw, 'value'), 'cid') ?? field(raw, 'type');
    return typeof id === 'string' ? id : undefined;
}
function checkedComponent(node: unknown, reference: IInstanceReference): { component: Row; index: number } {
    const components = field(node, '__comps__');
    if (!Array.isArray(components)) throw new Error('Component inventory is unavailable.');
    const matches: Array<{ component: Row; index: number }> = [];
    components.forEach((component: unknown, index: number) => {
        if (record(component) && componentUuid(component) === reference.id && componentClass(component) === reference.type) matches.push({ component, index });
    });
    if (matches.length !== 1) throw new Error('Attached component identity/class changed.');
    return matches[0];
}
function propertyMatches(raw: unknown, property: UiRuntimeProperty): boolean {
    if (property.type === 'cc.Node') return uuid(raw) === property.value;
    if (property.type === 'cc.Node[]') {
        const items = value(raw);
        return Array.isArray(items) && items.length === property.value.length && items.every((item, index) => uuid(item) === property.value[index]);
    }
    return value(raw) === property.value;
}
function propertyDump(raw: unknown, property: UiRuntimeProperty): Row {
    if (!record(raw) || typeof raw.type !== 'string') throw new Error(`Serialized property '${property.name}' is unavailable.`);
    if (property.type === 'cc.Node[]') {
        if (raw.isArray !== true || raw.type !== 'cc.Node' || !Array.isArray(raw.value)) throw new Error(`Property '${property.name}' is not a native Node array.`);
        // Native set-property consumes reference values, not serialized element descriptors.
        return { value: property.value.map(id => ({ uuid: id })), type: raw.type };
    }
    if (raw.isArray === true || (property.type === 'cc.Node' ? raw.type !== 'cc.Node' : property.type === 'Boolean' ? raw.type !== 'Boolean' && raw.type !== 'cc.Boolean' : !['Number', 'Integer', 'Float', 'cc.Integer', 'cc.Float'].includes(raw.type))) throw new Error(`Property '${property.name}' has an unexpected native type.`);
    return { value: property.type === 'cc.Node' ? { uuid: property.value } : property.value, type: raw.type };
}

/** Creates/reuses exact project source, imports, attaches and verifies serialized configuration; never proves runtime playback or saves the scene. */
export async function installUiRuntimeComponent(args: { source: string; className: string; nodeReference: IInstanceReference; properties: UiRuntimeProperty[] }): Promise<UiRuntimeComponentInstallResult> {
    if (!args.nodeReference?.id || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(args.className) || typeof args.source !== 'string' || !args.source || Buffer.byteLength(args.source, 'utf8') > 65536 || !Array.isArray(args.properties) || args.properties.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Runtime installation requires a bounded source, class, exact node reference and serialized properties.' });
    const names = new Set<string>();
    for (const property of args.properties) {
        const validValue = property.type === 'cc.Node' ? typeof property.value === 'string' && !!property.value : property.type === 'cc.Node[]' ? Array.isArray(property.value) && property.value.length <= 64 && property.value.every(id => typeof id === 'string' && !!id) : property.type === 'Boolean' ? typeof property.value === 'boolean' : property.type === 'Number' && typeof property.value === 'number' && Number.isFinite(property.value);
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(property.name) || names.has(property.name) || !validValue) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Runtime properties must have unique bounded names and exact typed values.' });
        names.add(property.name);
    }
    args = { source: args.source, className: args.className, nodeReference: { id: args.nodeReference.id, ...(args.nodeReference.type === undefined ? {} : { type: args.nodeReference.type }) }, properties: args.properties.map(property => property.type === 'cc.Node[]' ? { ...property, value: [...property.value] } : { ...property }) };
    const sourceSha256 = componentScriptHash(args.source);
    const assetUrl = `db://assets/CcpUiRuntime_${sourceSha256}.ts`;
    const generated = { source: args.source, sha256: sourceSha256, bytes: Buffer.byteLength(args.source, 'utf8'), className: args.className };
    let scriptReference: IInstanceReference | undefined;
    let componentReference: IInstanceReference | undefined;
    let sourceCreated: boolean | null = false;
    let phase = 'source-preflight';
    const acknowledgedProperties: string[] = [];
    try {
        let sourcePath = resolveComponentScriptPath(assetUrl);
        const existing = await queryComponentScriptAsset(assetUrl);
        if (existing) {
            scriptReference = { id: existing.uuid, type: 'cc.Script' };
            await readComponentScriptSource(sourcePath, existing.uuid, generated);
        } else {
            sourcePath = await preflightComponentScriptPath(assetUrl);
            phase = 'source-create';
            sourceCreated = null;
            const created: unknown = await Editor.Message.request('asset-db', 'create-asset', assetUrl, args.source, { overwrite: false, rename: false });
            const createdId = field(created, 'uuid');
            if (typeof createdId !== 'string' || !createdId) throw new Error('Asset DB did not acknowledge source identity.');
            scriptReference = { id: createdId, type: 'cc.Script' };
            sourceCreated = true;
            phase = 'source-readback';
            await readComponentScriptSource(sourcePath, scriptReference.id, generated);
        }
        phase = 'source-import';
        // Lazy tool loading breaks the portfolio -> installer -> scene/tools registration cycle.
        const { AssetTools } = await import('../tools/asset-tools');
        const imported = await new AssetTools().assetOperate({ operation: 'refresh', reference: scriptReference });
        if (imported.reference.id !== scriptReference.id) throw new Error('Imported source identity changed.');
        phase = 'class-registration';
        let classId: string | undefined;
        for (let attempt = 0; attempt < 40; attempt++) {
            const observed = await Editor.Message.request('scene', 'query-script-cid', scriptReference.id);
            if (typeof observed === 'string' && observed) {
                const registry = await Editor.Message.request('scene', 'query-components') as unknown;
                // sceneScriptAttach uses this same flat native registry identity contract.
                if (Array.isArray(registry) && registry.length <= 10000 && registry.some((entry: unknown) => record(entry) && [entry.name, entry.type, entry.cid, entry.classId].includes(observed))) { classId = observed; break; }
            }
            if (attempt < 39) await new Promise<void>(resolve => setTimeout(resolve, 250));
        }
        if (!classId) throw new Error('Creator did not register the generated component within the bounded read-only wait.');
        phase = 'attach';
        // SceneTools imports the public tool portfolio; loading it eagerly creates a decorator cycle.
        const { SceneTools } = await import('../tools/scene-tools');
        phase = 'source-recheck';
        await readComponentScriptSource(sourcePath, scriptReference.id, generated);
        if (await Editor.Message.request('scene', 'query-script-cid', scriptReference.id) !== classId) throw new Error('Source class binding changed before attachment.');
        phase = 'attach';
        const attached = await new SceneTools().sceneScriptAttach({ nodeReference: args.nodeReference, scriptReference });
        componentReference = attached.componentReference;
        if (componentReference.type !== classId) throw new Error('Attachment class differs from registered source class.');
        phase = 'configure';
        for (const property of args.properties) {
            const before: unknown = await Editor.Message.request('scene', 'query-node', args.nodeReference.id);
            if (uuid(field(before, 'uuid')) !== args.nodeReference.id) throw new Error('Configuration target node identity changed.');
            const { component, index } = checkedComponent(before, componentReference);
            const dump = propertyDump(field(component.value, property.name), property);
            const accepted = await Editor.Message.request('scene', 'set-property', { uuid: args.nodeReference.id, path: `__comps__.${index}.${property.name}`, dump: dump as never });
            if (accepted === false) throw new Error(`Creator refused serialized property '${property.name}'.`);
            const observed: unknown = await Editor.Message.request('scene', 'query-component', componentReference.id);
            if (componentUuid(observed) !== componentReference.id || componentClass(observed) !== classId || !propertyMatches(field(field(observed, 'value'), property.name), property)) throw new Error(`Serialized property '${property.name}' readback did not match.`);
            acknowledgedProperties.push(property.name);
        }
        phase = 'configuration-readback';
        const independent: unknown = await Editor.Message.request('scene', 'query-component', componentReference.id);
        const finalNode: unknown = await Editor.Message.request('scene', 'query-node', args.nodeReference.id);
        const { component } = checkedComponent(finalNode, componentReference);
        if (uuid(field(finalNode, 'uuid')) !== args.nodeReference.id || componentUuid(independent) !== componentReference.id || componentClass(independent) !== classId || args.properties.some(property => !propertyMatches(field(component.value, property.name), property) || !propertyMatches(field(field(independent, 'value'), property.name), property))) throw new Error('Independent component/configuration readback did not match.');
        phase = 'snapshot';
        const snapshot = await Editor.Message.request('scene', 'snapshot') as unknown;
        if (snapshot === false) throw new Error('Creator refused the configuration undo snapshot.');
        return { scriptReference, componentReference, assetUrl, sourceSha256, sourceCreated: sourceCreated === true, configured: true, runtimeVerified: false, sceneSaved: false };
    } catch (error) {
        throw new ToolError({ code: 'UI_RUNTIME_INSTALL_INCOMPLETE', status: 502, message: 'Persistent UI component installation did not complete; inspect retained identities before retrying.', details: { phase, nodeReference: args.nodeReference, assetUrl, sourceSha256, sourceCreated, scriptReference: scriptReference ?? null, componentReference: componentReference ?? null, acknowledgedProperties, configured: false, runtimeVerified: false, sceneSaved: false, retrySafe: false, cause: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512), nativeDetails: error instanceof ToolError ? error.details ?? null : null }, recovery: 'Inspect the exact source and node/component identities. No source deletion or blind replay was attempted.' });
    } finally {
        invalidateAfterWrite();
    }
}
