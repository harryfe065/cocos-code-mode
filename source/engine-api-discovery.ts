import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ToolError } from './utcp/tool-error';
import { IInstanceReference } from './utcp/schemas';
import { ToolsUtils } from './utcp/utils/tools-utils';
import { z } from './schema-validator';
import type { infer as InferSchema } from 'zod';
import { openExternalApiCatalog, readBounded, parseCatalogJson } from './external-api-catalog';

export interface EngineDiscoveryArgs {
    category?: string; className?: string; targetVersion?: string; domain?: string;
    operation?: 'records' | 'list_domains' | 'list_classes' | 'list_namespaces' | 'list_members' | 'get_signature' | 'get_related_types' | 'lookup_editor_message' | 'explain_bridge_route' | 'compare_version';
    namespace?: 'engine-runtime' | 'engine-authoring' | 'editor-ipc' | 'bridge';
    kind?: string; module?: string; visibility?: 'public' | 'protected' | 'private' | 'internal';
    context?: string; evidenceState?: string;
    member?: string;
    timeoutMs?: number; maxPages?: number;
    filter?: string; recordId?: string; compareVersion?: string; compareRecordId?: string; reference?: IInstanceReference; maxEntries?: number; maxBytes?: number; cursor?: string;
}
const ApiRecordSchema = z.object({ id: z.string().min(1), className: z.string().nullable().optional(), namespace: z.string(), member: z.string().nullable().optional(), name: z.string().optional(), kind: z.string().optional(), static: z.boolean().nullable().optional(), signatures: z.array(z.unknown()).optional() }).passthrough();
type ApiRecord = InferSchema<typeof ApiRecordSchema>;
interface SignatureIdentity {
    evidence: 'catalog-signature' | 'declaration-signature';
    recordId: string;
    semanticKey: string | null;
    className: string | null;
    member: string | null;
    recordKind: string | null;
    static: boolean | null;
    overload: number | null;
    signatureId: string | null;
    signatureKind: string | null;
    accessor: 'get' | 'set' | null;
}
const CatalogIndexSchema = z.object({ schemaVersion: z.literal(1), version: z.string(), catalogHash: z.string().regex(/^[a-f0-9]{64}$/), domains: z.array(z.object({ name: z.string(), file: z.string(), count: z.number().int().nonnegative() })).max(1000) });
const CursorSchema = z.object({ hash: z.string(), selector: z.string(), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const CATALOG_ROOT = path.join(__dirname, 'engine-api-catalog');
const VERSIONS: Record<string, true> = { '3.7.3': true, '3.8.8': true };
const MAX_CATALOG_FILE = 8 * 1024 * 1024;
function jsonFile(file: string): unknown {
    const root = fs.realpathSync(path.dirname(file));
    return parseCatalogJson(readBounded(root, path.basename(file), MAX_CATALOG_FILE));
}
function signatureIdentity(record: ApiRecord, signature: Record<string, unknown>, evidence: 'catalog-signature' | 'declaration-signature'): SignatureIdentity {
    const overload = signature.overload;
    const overloadIndex = typeof overload === 'number' && Number.isInteger(overload) && overload >= 0 ? overload : null;
    const signatureKind = typeof signature.kind === 'string' ? signature.kind : null;
    return {
        evidence,
        recordId: record.id,
        semanticKey: typeof record.semanticKey === 'string' ? record.semanticKey : null,
        className: record.className ?? null,
        member: record.member ?? null,
        recordKind: record.kind ?? null,
        static: typeof record.static === 'boolean' ? record.static : null,
        overload: overloadIndex,
        signatureId: typeof signature.signatureId === 'string' ? signature.signatureId : null,
        signatureKind,
        accessor: record.kind === 'accessor' && (signatureKind === 'get' || signatureKind === 'set') ? signatureKind : null,
    };
}
function limit(value: number | undefined, fallback: number, maximum: number): number {
    const selected = value === undefined ? fallback : value;
    if (!Number.isInteger(selected) || selected < 1 || selected > maximum) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Catalog limit must be an integer from 1 to ${maximum}.` });
    return selected;
}

export async function discoverEngineApi(args: EngineDiscoveryArgs): Promise<Record<string, unknown>> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Catalog discovery requires an argument object.' });
    args = { ...args, ...(args.reference && typeof args.reference === 'object' && !Array.isArray(args.reference) ? { reference: { ...args.reference } } : {}) };
    const timeoutMs = limit(args.timeoutMs, 5000, 30000);
    const maxPages = limit(args.maxPages, 256, 1000);
    try {
        return await discoverWithinDeadline(args, Date.now() + timeoutMs, { remaining: maxPages, indexEntriesRemaining: maxPages * 256, recordsRemaining: 100000, bytesRemaining: 32 * 1024 * 1024 });
    } catch (error: unknown) {
        if (error instanceof z.ZodError) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Catalog metadata does not match its required schema.' });
        if (!(error instanceof ToolError) && error && typeof error === 'object' && 'code' in error
            && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE', 'ELOOP', 'ENAMETOOLONG', 'EBUSY'].includes(String(error.code))) throw new ToolError({ code: 'CATALOG_READ_FAILED', status: 502, message: 'Catalog input could not be read; verify the installed files and approved catalog configuration.' });
        throw error;
    }
}

async function discoverWithinDeadline(args: EngineDiscoveryArgs, deadline: number, pages: { remaining: number; indexEntriesRemaining: number; recordsRemaining: number; bytesRemaining: number }): Promise<Record<string, unknown>> {
    const checkDeadline = () => {
        if (Date.now() >= deadline) throw new ToolError({ code: 'CATALOG_QUERY_TIMEOUT', status: 409, message: 'Catalog discovery exceeded its cooperative deadline; no complete result returned.' });
    };
    const observeWithinDeadline = async <T>(observe: () => Promise<T>): Promise<T> => {
        checkDeadline();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const expired = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new ToolError({ code: 'CATALOG_QUERY_TIMEOUT', status: 409, message: 'Catalog observation exceeded the caller deadline; native read was not cancelled.' })), Math.max(0, deadline - Date.now()));
            });
            const result = await Promise.race([observe(), expired]);
            checkDeadline();
            return result;
        } finally { clearTimeout(timer); }
    };
    checkDeadline();
    const readPage = <T>(read: () => T): T => {
        checkDeadline();
        if (pages.remaining <= 0) throw new ToolError({ code: 'CATALOG_PAGE_LIMIT', status: 413, message: 'Catalog shard-read budget exhausted; narrow the query or explicitly increase maxPages.' });
        pages.remaining--;
        return read();
    };
    const version = args.targetVersion === undefined ? '3.7.3' : args.targetVersion;
    if (typeof version !== 'string' || !Object.prototype.hasOwnProperty.call(VERSIONS, version)) throw new ToolError({ code: 'UNSUPPORTED_VERSION', status: 422, message: 'Only catalogued versions 3.7.3 and 3.8.8 are available.' });
    if (args.category !== undefined && args.category !== 'engine_api' && args.category !== 'component_schema') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Catalog category must be engine_api or component_schema.' });
    if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(args.cursor))) throw new ToolError({ code: 'STALE_CURSOR', status: 409, message: 'Catalog cursor must be a bounded nonempty base64url token.' });
    for (const [field, maximum] of [['className', 256], ['domain', 256], ['filter', 1024]] as const) {
        const value = args[field];
        if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > maximum)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${field} must be a nonempty string of at most ${maximum} characters.` });
    }
    if (args.namespace !== undefined && !['engine-runtime', 'engine-authoring', 'editor-ipc', 'bridge'].includes(args.namespace)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Unknown catalog namespace selector.' });
    if (args.reference !== undefined && (!args.reference || typeof args.reference !== 'object' || Array.isArray(args.reference)
        || typeof args.reference.id !== 'string' || !args.reference.id.trim() || args.reference.id.length > 1024
        || args.reference.type !== undefined && (typeof args.reference.type !== 'string' || !args.reference.type.trim() || args.reference.type.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'reference requires a bounded nonempty id and optional nonempty type.' });
    if (args.className !== undefined && args.reference?.type !== undefined && args.className.replace(/^cc\./, '') !== args.reference.type.replace(/^cc\./, '')) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'Catalog class and instance reference type disagree.' });
    if (args.category === 'component_schema' && !args.className) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'component_schema requires className.' });
    const operation = args.operation === undefined ? 'records' : args.operation;
    if (operation === 'explain_bridge_route') {
        if (typeof args.recordId !== 'string' || !args.recordId || args.recordId.length > 1024
            || Object.keys(args).some(key => !['category', 'operation', 'targetVersion', 'recordId', 'maxEntries', 'maxBytes', 'timeoutMs', 'maxPages'].includes(key))
            || args.category !== undefined && args.category !== 'engine_api') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Route explanation requires one exact bridge record ID without live targets or filters.' });
        limit(args.maxEntries, 50, 200);
        const maxBytes = limit(args.maxBytes, 32768, 131072);
        const result = await discoverWithinDeadline({ targetVersion: version, operation: 'records', recordId: args.recordId, namespace: 'bridge', maxEntries: 1, maxBytes }, deadline, pages);
        const record = (result.records as ApiRecord[])[0];
        if (!Array.isArray(record.composedRoutes)) throw new ToolError({ code: 'CATALOG_INDEX_UPGRADE_REQUIRED', status: 409, message: 'Regenerate bridge records with composedRoutes and explicitly adopt their catalog/lookup hashes.' });
        if (!Number.isInteger(record.composedRouteCount) || record.composedRouteCount !== record.composedRoutes.length
            || record.composedRoutes.some(route => !route || typeof route !== 'object' || Array.isArray(route))) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Bridge route metadata is malformed or inconsistent.' });
        const output = { ...result, operation };
        if (Buffer.byteLength(JSON.stringify(output)) > maxBytes) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 422, message: 'Bridge route explanation exceeds maxBytes.' });
        checkDeadline();
        return output;
    }
    if (args.kind !== undefined && (typeof args.kind !== 'string' || !args.kind || args.kind.length > 128)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'kind must be a nonempty string of at most 128 characters.' });
    if (args.kind !== undefined && ['list_domains', 'lookup_editor_message', 'compare_version'].includes(operation)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'kind is not accepted for this discovery operation.' });
    if (args.module !== undefined && (typeof args.module !== 'string' || !args.module || args.module.length > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'module must be a nonempty string of at most 256 characters.' });
    if (args.module !== undefined && ['list_domains', 'lookup_editor_message', 'compare_version'].includes(operation)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'module is not accepted for this discovery operation.' });
    if (args.visibility !== undefined && !['public', 'protected', 'private', 'internal'].includes(args.visibility)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'visibility must be public, protected, private or internal.' });
    if (args.visibility !== undefined && ['list_domains', 'lookup_editor_message', 'compare_version'].includes(operation)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'visibility is not accepted for this discovery operation.' });
    for (const value of [args.context, args.evidenceState]) if (value !== undefined && (typeof value !== 'string' || !value || value.length > 128)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'context/evidenceState must be nonempty strings of at most 128 characters.' });
    if ((args.context !== undefined || args.evidenceState !== undefined) && ['list_domains', 'lookup_editor_message', 'compare_version'].includes(operation)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Context/evidence selectors are not accepted for this discovery operation.' });
    if (args.member !== undefined && (typeof args.member !== 'string' || !args.member || args.member.length > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'member must be a nonempty string of at most 256 characters.' });
    if (args.member !== undefined && ['list_domains', 'lookup_editor_message', 'compare_version'].includes(operation)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'member is not accepted for this discovery operation.' });
    if (operation === 'lookup_editor_message') {
        if (typeof args.recordId !== 'string' || !args.recordId || args.recordId.length > 1024
            || args.reference !== undefined || args.className !== undefined || args.category === 'component_schema'
            || args.cursor !== undefined || args.domain !== undefined || args.filter !== undefined || args.compareVersion !== undefined || args.compareRecordId !== undefined
            || args.namespace !== undefined && args.namespace !== 'editor-ipc') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Editor message lookup requires an exact recordId in editor-ipc without live targets.' });
        limit(args.maxEntries, 50, 200);
        const maxBytes = limit(args.maxBytes, 32768, 131072);
        const result = await discoverWithinDeadline({ targetVersion: version, operation: 'records', recordId: args.recordId, namespace: 'editor-ipc', maxEntries: 1, maxBytes }, deadline, pages);
        const output = { ...result, operation };
        if (Buffer.byteLength(JSON.stringify(output)) > limit(args.maxBytes, 32768, 131072)) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 422, message: 'Editor message lookup exceeds maxBytes.' });
        checkDeadline();
        return output;
    }
    if (!['records', 'list_domains', 'list_classes', 'list_namespaces', 'list_members', 'get_signature', 'get_related_types', 'compare_version'].includes(operation)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Unknown catalog discovery operation.' });
    if (operation === 'get_related_types' && (typeof args.recordId !== 'string' || !args.recordId || args.recordId.length > 1024)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'get_related_types requires a bounded exact recordId.' });
    if (operation === 'compare_version') {
        if (typeof args.compareVersion !== 'string' || args.compareVersion === version || !Object.prototype.hasOwnProperty.call(VERSIONS, args.compareVersion)
            || typeof args.recordId !== 'string' || !args.recordId || args.recordId.length > 1024
            || typeof args.compareRecordId !== 'string' || !args.compareRecordId || args.compareRecordId.length > 1024
            || args.reference || args.className || args.domain || args.namespace || args.filter || args.cursor || args.category === 'component_schema') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'compare_version requires distinct catalog versions and two exact record IDs without live targets, filters or cursors.' });
        limit(args.maxEntries, 50, 200);
        const maxBytes = limit(args.maxBytes, 32768, 131072);
        const before = await discoverWithinDeadline({ targetVersion: version, recordId: args.recordId, maxEntries: 1, maxBytes: 131072 }, deadline, pages);
        const after = await discoverWithinDeadline({ targetVersion: args.compareVersion, recordId: args.compareRecordId, maxEntries: 1, maxBytes: 131072 }, deadline, pages);
        const left = (before.records as ApiRecord[])[0], right = (after.records as ApiRecord[])[0];
        if (typeof left.semanticKey !== 'string' || !left.semanticKey || left.semanticKey !== right.semanticKey) throw new ToolError({ code: 'CATALOG_IDENTITY_MISMATCH', status: 409, message: 'Selected records do not prove the same version-independent semantic identity.' });
        checkDeadline();
        const compareHash = (field: string): 'unchanged' | 'changed' | 'unknown' => {
            const a = left[field], b = right[field];
            return typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && typeof b === 'string' && /^[a-f0-9]{64}$/.test(b) ? a === b ? 'unchanged' : 'changed' : 'unknown';
        };
        const result = { version, operation, semanticKey: left.semanticKey,
            before: { version, recordId: left.id, catalogHash: before.catalogHash, coverage: before.coverage },
            after: { version: args.compareVersion, recordId: right.id, catalogHash: after.catalogHash, coverage: after.coverage },
            comparison: { signatures: compareHash('signatureHash'), metadata: compareHash('metadataHash'), resolution: compareHash('resolutionHash') },
            permitted: false, mutationAuthorized: false, runtimeVerified: false, qualified: false };
        if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 422, message: 'Exact catalog comparison exceeds maxBytes.' });
        checkDeadline();
        return result;
    }
    if (args.compareVersion !== undefined || args.compareRecordId !== undefined) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Comparison selectors require compare_version.' });
    const observesTarget = operation === 'records' || operation === 'get_signature';
    if (args.reference && !observesTarget) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Catalog navigation does not accept an instance reference.' });
    if (operation !== 'records' && !['get_signature', 'get_related_types', 'list_members'].includes(operation) && (args.reference || args.recordId || args.category === 'component_schema' || args.className)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Catalog navigation does not accept an instance, record or class schema target.' });
    if (operation === 'get_signature' && (typeof args.recordId !== 'string' || !args.recordId || args.recordId.length > 1024)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'get_signature requires a bounded exact recordId.' });
    if (args.recordId !== undefined && (typeof args.recordId !== 'string' || !args.recordId || args.recordId.length > 1024 || !['records', 'get_signature', 'get_related_types'].includes(operation))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'recordId requires a record operation and a bounded nonempty identity.' });
    const maxEntries = limit(args.maxEntries, 50, 200), maxBytes = limit(args.maxBytes, 32768, 131072);
    const external = openExternalApiCatalog(version);
    checkDeadline();
    const indexPath = path.join(CATALOG_ROOT, version, 'index.json');
    if (!external && !fs.existsSync(indexPath)) throw new ToolError({ code: 'CATALOG_UNAVAILABLE', status: 422, message: `No installed catalog for ${version}.` });
    const indexBytes = external ? null : readBounded(fs.realpathSync(path.dirname(indexPath)), path.basename(indexPath), MAX_CATALOG_FILE);
    const index = external ?? CatalogIndexSchema.parse(parseCatalogJson(indexBytes!));
    const snapshotHash = external ? external.snapshotHash : crypto.createHash('sha256').update(indexBytes!).digest('hex');
    if (!external && 'version' in index && index.version !== version) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Installed catalog identity is invalid.' });
    if (!external && new Set(index.domains.map(domain => domain.file.toLowerCase())).size !== index.domains.length) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Installed catalog index contains duplicate shard filenames.' });
    if (!external && index.domains.some(domain => ['index.json', 'lookup.json', 'manifest.json'].includes(domain.file.toLowerCase()))) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Reserved catalog metadata filename cannot be used as a shard.' });
    if (!external && index.domains.some(domain => path.basename(domain.file) !== domain.file || path.win32.basename(domain.file) !== domain.file || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/.test(domain.file))) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Unsafe installed catalog shard filename.' });
    const provenancePath = path.join(CATALOG_ROOT, version, 'provenance.json');
    const provenance = !external && fs.existsSync(provenancePath) ? z.object({ scope: z.string().optional(), originalCatalogHash: z.string().nullable().optional() }).passthrough().parse(jsonFile(provenancePath)) : null;
    const coverage = { scope: external ? 'operator-configured-full-catalog' : provenance?.scope ?? 'installed-catalog-scope-unverified', fullCatalogLoaded: external !== null, originalCatalogHash: external?.catalogHash ?? provenance?.originalCatalogHash ?? null };
    const selector = JSON.stringify({ version, operation, namespace: args.namespace ?? '', domain: args.domain ?? '', filter: args.filter ?? '', className: args.className ?? '', recordId: args.recordId ?? '', kind: args.kind ?? '', module: args.module ?? '', visibility: args.visibility ?? '', context: args.context ?? '', evidenceState: args.evidenceState ?? '', member: args.member ?? '', reference: args.reference ? { id: args.reference.id, type: args.reference.type ?? null } : null });
    const categoryScope = args.category === 'component_schema' ? 'component_schema' : 'engine_api';
    const selectorHash = crypto.createHash('sha256').update(JSON.stringify([categoryScope, coverage, snapshotHash, selector])).digest('hex');
    let offset = 0;
    if (args.cursor) {
        try {
            if (!/^[A-Za-z0-9_-]{1,2048}$/.test(args.cursor)) throw new Error();
            const cursor = CursorSchema.parse(JSON.parse(Buffer.from(args.cursor.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')));
            if (cursor.hash !== index.catalogHash || cursor.selector !== selectorHash) throw new Error();
            offset = cursor.offset;
        } catch { throw new ToolError({ code: 'STALE_CURSOR', status: 409, message: 'Catalog cursor does not match this version/filter/snapshot.' }); }
    }
    const records: ApiRecord[] = [];
    const manifestNamespaces = operation === 'list_namespaces' && [args.filter, args.kind, args.module, args.visibility, args.context, args.evidenceState, args.member].every(value => value === undefined);
    if (external && operation !== 'list_domains' && !manifestNamespaces) {
        const indexedEntries = args.recordId === undefined ? external.entries : [external.findEntry(args.recordId)].filter((entry): entry is typeof external.entries[number] => entry !== undefined);
        for (const entry of indexedEntries) {
            checkDeadline();
            if (args.recordId === undefined) {
                pages.indexEntriesRemaining--;
                if (pages.indexEntriesRemaining < 0) throw new ToolError({ code: 'CATALOG_INDEX_LIMIT', status: 413, message: 'External catalog index scan budget exhausted; narrow the query or explicitly increase maxPages.' });
            }
            if (args.module !== undefined && entry.module === undefined) throw new ToolError({ code: 'CATALOG_INDEX_UPGRADE_REQUIRED', status: 409, message: 'Regenerate the approved lookup with module metadata before filtering by module.' });
            if (args.visibility !== undefined && entry.visibility === undefined) throw new ToolError({ code: 'CATALOG_INDEX_UPGRADE_REQUIRED', status: 409, message: 'Regenerate the approved lookup with explicit visibility metadata before filtering.' });
            if ((args.context !== undefined || args.evidenceState !== undefined) && (args.context !== undefined && entry.contexts === undefined || args.evidenceState !== undefined && entry.evidenceState === undefined)) throw new ToolError({ code: 'CATALOG_INDEX_UPGRADE_REQUIRED', status: 409, message: 'Regenerate lookup context/evidence metadata before filtering.' });
            if (args.recordId !== undefined && entry.id !== args.recordId) continue;
            if (args.member !== undefined && entry.member !== args.member) continue;
            if (args.kind !== undefined && entry.kind !== args.kind) continue;
            if (args.module !== undefined && entry.module !== args.module) continue;
            if (args.visibility !== undefined && entry.visibility !== args.visibility) continue;
            if (args.context !== undefined && !entry.contexts?.includes(args.context)) continue;
            if (args.evidenceState !== undefined && entry.evidenceState !== args.evidenceState) continue;
            if (args.domain && entry.domain !== args.domain) continue;
            if (args.namespace && entry.namespace !== args.namespace) continue;
            if (args.category === 'component_schema' && entry.namespace !== 'engine-runtime') continue;
            if (args.className && (entry.className ?? '').replace(/^cc\./, '') !== args.className.replace(/^cc\./, '')) continue;
            if (args.filter && !`${entry.className ?? ''}.${entry.member ?? entry.name}`.toLowerCase().includes(args.filter.toLowerCase())) continue;
            records.push({ id: entry.id, namespace: entry.namespace, className: entry.className, member: entry.member, name: entry.name, kind: entry.kind, static: entry.static ?? null });
        }
    }
    const installedRecordIds = new Set<string>();
    for (const domain of operation === 'list_domains' || external || manifestNamespaces ? [] : index.domains) {
        checkDeadline();
        if (args.domain && domain.name !== args.domain) continue;
        if (args.namespace && !domain.name.startsWith(`${args.namespace}.`)) continue;
        if (args.category === 'component_schema' && !domain.name.startsWith('engine-runtime.')) continue;
        if (domain.count > pages.recordsRemaining) throw new ToolError({ code: 'CATALOG_RECORD_LIMIT', status: 413, message: 'Installed catalog scan exceeds 100000 records; narrow the namespace/domain.' });
        if (pages.bytesRemaining === 0) throw new ToolError({ code: 'CATALOG_LIMIT_EXCEEDED', status: 413, message: 'Installed shard byte budget exhausted; narrow the namespace/domain.' });
        const bytes = readPage(() => readBounded(fs.realpathSync(path.join(CATALOG_ROOT, version)), domain.file, Math.min(MAX_CATALOG_FILE, pages.bytesRemaining)));
        pages.bytesRemaining -= bytes.length;
        const shard = z.object({ records: z.array(ApiRecordSchema).max(10000) }).parse(parseCatalogJson(bytes));
        if (shard.records.length !== domain.count) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Installed shard record count differs from its index.' });
        pages.recordsRemaining -= shard.records.length;
        for (const record of shard.records) {
            checkDeadline();
            if (record.version !== version || !record.id.startsWith(`${version}:${record.namespace}:`)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Installed record version or namespaced identity differs from its catalog.' });
            const recordDomain = typeof record.domain === 'string' && record.domain || (record.domain == null || record.domain === '') && typeof record.module === 'string' && record.module.replace(/[^\w-]/g, '-');
            if (typeof recordDomain !== 'string' || !recordDomain || domain.name !== `${record.namespace}.${recordDomain}`) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Installed record domain differs from its shard domain.' });
            if (installedRecordIds.has(record.id)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Installed catalog contains duplicate record IDs.' });
            installedRecordIds.add(record.id);
            if (args.recordId !== undefined && record.id !== args.recordId) continue;
            if (args.member !== undefined && record.member !== args.member) continue;
            if (args.kind !== undefined && record.kind !== args.kind) continue;
            if (args.module !== undefined && record.module !== args.module) continue;
            if (args.visibility !== undefined && record.visibility !== args.visibility) continue;
            const execution = record.contextConstraints && typeof record.contextConstraints === 'object' ? (record.contextConstraints as Record<string, unknown>).execution : undefined;
            if (args.context !== undefined && (!Array.isArray(execution) || !execution.includes(args.context))) continue;
            if (args.evidenceState !== undefined && record.evidenceStatus !== args.evidenceState) continue;
            if (args.namespace && record.namespace !== args.namespace) continue;
            if (args.category === 'component_schema' && record.namespace !== 'engine-runtime') continue;
            if (args.className && (record.className ?? '').replace(/^cc\./, '') !== args.className.replace(/^cc\./, '')) continue;
            if (args.filter && !`${record.className ?? ''}.${record.member ?? record.name ?? ''}`.toLowerCase().includes(args.filter.toLowerCase())) continue;
            records.push({ ...record, permitted: false, writablePath: null });
        }
    }
    records.sort((a, b) => a.id.localeCompare(b.id));
    const matchedCatalogTarget = records.length > 0;
    const engineClassTarget = records.length > 0 && records.every(record => record.namespace === 'engine-runtime');
    const exactRecordClass = args.recordId !== undefined ? records[0]?.className : undefined;
    if (operation === 'list_domains') {
        const domains = new Map<string, number>();
        for (const shard of index.domains) {
            checkDeadline();
            if (args.domain && shard.name !== args.domain) continue;
            if (args.namespace && !shard.name.startsWith(`${args.namespace}.`)) continue;
            if (args.filter && !shard.name.toLowerCase().includes(args.filter.toLowerCase())) continue;
            domains.set(shard.name, (domains.get(shard.name) ?? 0) + shard.count);
        }
        for (const [name, recordCount] of [...domains].sort(([a], [b]) => a.localeCompare(b))) records.push({ id: `${version}:domain:${name}`, namespace: name.split('.')[0], kind: 'domain', name, recordCount, permitted: false });
    } else if (operation === 'list_classes') {
        const classes = new Map<string, ApiRecord>();
        for (const record of records) {
            checkDeadline();
            if (!record.className) continue;
            const key = JSON.stringify([record.namespace, record.className]);
            const existing = classes.get(key);
            if (existing) existing.recordCount = Number(existing.recordCount) + 1;
            else classes.set(key, { id: `${version}:class-index:${key}`, namespace: record.namespace, className: record.className, name: record.className, kind: 'class-summary', recordCount: 1, permitted: false });
        }
        records.splice(0, records.length, ...[...classes.values()].sort((a, b) => a.id.localeCompare(b.id)));
    } else if (operation === 'get_related_types') {
        if (!records[0]) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Record is absent from the selected catalog scope.' });
        const source = external ? ApiRecordSchema.parse({ ...readPage(() => external.readRecord(records[0].id)), permitted: false }) : records[0];
        if (!source) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Record related types are absent from the selected catalog scope.' });
        const related: Array<Record<string, unknown>> = [];
        const seen = new Set<string>();
        let relatedEntriesRemaining = 10000;
        let containersRemaining = 10000;
        let relatedBytesRemaining = 1024 * 1024;
        const reserveContainers = (count: number) => {
            checkDeadline();
            if (count > containersRemaining) throw new ToolError({ code: 'CATALOG_RELATED_LIMIT', status: 413, message: 'Related-type signature/parameter traversal exceeds 10000 containers.' });
            containersRemaining -= count;
        };
        const collect = (value: unknown, field: string, location: { signatureIndex?: number, parameterIndex?: number } = {}) => {
            if (value === undefined || value === null) return;
            if (!Array.isArray(value)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: `Record ${field} metadata is not an array.` });
            if (value.length > relatedEntriesRemaining) throw new ToolError({ code: 'CATALOG_RELATED_LIMIT', status: 413, message: 'Related-type metadata exceeds 10000 entries; no complete dependency result returned.' });
            relatedEntriesRemaining -= value.length;
            for (const item of value) {
                checkDeadline();
                if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: `Record ${field} contains malformed related-type metadata.` });
                const row = item as Record<string, unknown>;
                const key = JSON.stringify([field, location, row]);
                const keyBytes = Buffer.byteLength(key, 'utf8');
                if (keyBytes > relatedBytesRemaining) throw new ToolError({ code: 'CATALOG_RELATED_LIMIT', status: 413, message: 'Related-type serialized metadata exceeds 1MiB; no complete dependency result returned.' });
                relatedBytesRemaining -= keyBytes;
                if (!seen.has(key)) { seen.add(key); related.push({ ...row, relation: field, ...location }); }
            }
        };
        const collectSignatureTypes = (row: Record<string, unknown>, prefix: string, signatureIndex: number) => {
            const collectType = (value: unknown, relation: string) => {
                if (value === undefined || value === null) return;
                if (typeof value !== 'object' || Array.isArray(value)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: `Record ${relation} type metadata is malformed.` });
                const type = value as Record<string, unknown>;
                collect(type.references, `${relation}.references`, { signatureIndex });
                collect(type.unresolved, `${relation}.unresolved`, { signatureIndex });
            };
            collectType(row.receiver, `${prefix}.receiver`);
            if (row.predicate !== undefined && row.predicate !== null) {
                if (typeof row.predicate !== 'object' || Array.isArray(row.predicate)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Record predicate metadata is malformed.' });
                collectType((row.predicate as Record<string, unknown>).type, `${prefix}.predicate`);
            }
        };
        collect((source as Record<string, unknown>).references, 'references');
        collect((source as Record<string, unknown>).unresolved, 'unresolved');
        const declaration = (source as Record<string, unknown>).declarationEvidence;
        if (declaration !== undefined && declaration !== null) {
            if (typeof declaration !== 'object' || Array.isArray(declaration)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Declaration evidence metadata is malformed.' });
            const declarationSignatures = (declaration as Record<string, unknown>).signatures;
            if (declarationSignatures !== undefined) {
                if (!Array.isArray(declarationSignatures)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Declaration signatures metadata is malformed.' });
                reserveContainers(declarationSignatures.length);
                for (const [signatureIndex, signature] of declarationSignatures.entries()) {
                    checkDeadline();
                    if (!signature || typeof signature !== 'object' || Array.isArray(signature)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Declaration signature metadata is malformed.' });
                    const row = signature as Record<string, unknown>;
                    collect(row.references, 'declaration.signature.references', { signatureIndex });
                    collect(row.parameterReferences, 'declaration.signature.parameterReferences', { signatureIndex });
                    collect(row.returnReferences, 'declaration.signature.returnReferences', { signatureIndex });
                    collect(row.unresolved, 'declaration.signature.unresolved', { signatureIndex });
                    collectSignatureTypes(row, 'declaration.signature', signatureIndex);
                    if (row.parameters !== undefined) {
                        if (!Array.isArray(row.parameters)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Declaration parameters metadata is malformed.' });
                        reserveContainers(row.parameters.length);
                        for (const [parameterIndex, parameter] of row.parameters.entries()) {
                            checkDeadline();
                            if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Declaration parameter metadata is malformed.' });
                            const parameterRow = parameter as Record<string, unknown>;
                            collect(parameterRow.references, 'declaration.parameter.references', { signatureIndex, parameterIndex });
                            collect(parameterRow.unresolved, 'declaration.parameter.unresolved', { signatureIndex, parameterIndex });
                        }
                    }
                }
            }
        }
        const signatures = (source as Record<string, unknown>).signatures;
        if (signatures !== undefined) {
            if (!Array.isArray(signatures)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Record signatures metadata is not an array.' });
            reserveContainers(signatures.length);
            for (const [signatureIndex, signature] of signatures.entries()) {
                checkDeadline();
                if (!signature || typeof signature !== 'object' || Array.isArray(signature)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Record signature metadata is malformed.' });
                const row = signature as Record<string, unknown>;
                collect(row.references, 'signature.references', { signatureIndex }); collect(row.returnReferences, 'signature.returnReferences', { signatureIndex }); collect(row.unresolved, 'signature.unresolved', { signatureIndex });
                collect(row.parameterReferences, 'signature.parameterReferences', { signatureIndex });
                collectSignatureTypes(row, 'signature', signatureIndex);
                if (Array.isArray(row.parameters)) reserveContainers(row.parameters.length);
                if (Array.isArray(row.parameters)) for (const [parameterIndex, parameter] of row.parameters.entries()) {
                    checkDeadline();
                    if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Record parameter metadata is malformed.' });
                    const parameterRow = parameter as Record<string, unknown>;
                    collect(parameterRow.references, 'parameter.references', { signatureIndex, parameterIndex }); collect(parameterRow.unresolved, 'parameter.unresolved', { signatureIndex, parameterIndex });
                } else if (row.parameters !== undefined) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Record signature parameters metadata is not an array.' });
            }
        }
        records.splice(0, records.length, ...related.map((item, index) => ({ id: `${version}:related:${source.id}:${index}`, namespace: source.namespace, kind: 'related-type', name: typeof item.name === 'string' ? item.name : undefined, relation: item.relation, metadata: item, permitted: false })));
    } else if (operation === 'list_namespaces') {
        const namespaces = new Map<string, number>();
        if (manifestNamespaces) {
            for (const domain of index.domains) {
                checkDeadline();
                const namespace = domain.name.split('.')[0];
                if (args.domain && domain.name !== args.domain || args.namespace && namespace !== args.namespace || domain.count === 0) continue;
                namespaces.set(namespace, (namespaces.get(namespace) ?? 0) + domain.count);
            }
        } else for (const record of records) {
            checkDeadline();
            namespaces.set(record.namespace, (namespaces.get(record.namespace) ?? 0) + 1);
        }
        records.splice(0, records.length, ...[...namespaces].sort(([a], [b]) => a.localeCompare(b)).map(([namespace, recordCount]) => ({ id: `${version}:namespace:${namespace}`, namespace, name: namespace, kind: 'namespace-summary', recordCount, permitted: false })));
    } else if (operation === 'list_members') {
        const members = new Map<string, ApiRecord>();
        for (const record of records) {
            checkDeadline();
            if (!record.className || !record.member) continue;
            const staticIdentity = typeof record.static === 'boolean' ? record.static : null;
            const memberKind = record.kind ?? null;
            const key = JSON.stringify([record.namespace, record.className, record.member, staticIdentity, memberKind]);
            const existing = members.get(key);
            if (existing) existing.recordCount = Number(existing.recordCount) + 1;
            else members.set(key, { id: `${version}:member-index:${key}`, namespace: record.namespace, className: record.className, member: record.member, name: record.member, static: staticIdentity, memberKind, kind: 'member-summary', recordCount: 1, permitted: false });
        }
        records.splice(0, records.length, ...[...members.values()].sort((a, b) => a.id.localeCompare(b.id)));
    }
    if (operation === 'get_signature') {
        const record = external && records[0] ? ApiRecordSchema.parse({ ...readPage(() => external.readRecord(records[0].id)), permitted: false }) : records[0] as ApiRecord | undefined;
        if (!record) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Record signature is absent from the selected catalog scope/version/filters.' });
        let signatureContainersRemaining = 10000;
        const reserveSignatureContainers = (count: number) => {
            checkDeadline();
            if (count > signatureContainersRemaining) throw new ToolError({ code: 'CATALOG_SIGNATURE_LIMIT', status: 413, message: 'Signature metadata exceeds 10000 signature/parameter containers.' });
            signatureContainersRemaining -= count;
        };
        const invalidSignature = (signature: unknown): boolean => {
            checkDeadline();
            if (!signature || typeof signature !== 'object' || Array.isArray(signature)) return true;
            const parameters = (signature as Record<string, unknown>).parameters;
            if (parameters === undefined) return false;
            if (!Array.isArray(parameters)) return true;
            reserveSignatureContainers(parameters.length);
            for (const parameter of parameters) {
                checkDeadline();
                if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) return true;
            }
            return false;
        };
        const sourceSignatures = record.signatures ?? [];
        reserveSignatureContainers(sourceSignatures.length);
        if (sourceSignatures.some(invalidSignature)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Record signature metadata is malformed.' });
        let declarationSignatures: unknown[] = [];
        const declaration = record.declarationEvidence;
        if (declaration !== undefined && declaration !== null) {
            if (typeof declaration !== 'object' || Array.isArray(declaration)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Declaration evidence metadata is malformed.' });
            const signatures = (declaration as Record<string, unknown>).signatures;
            if (signatures !== undefined) {
                if (!Array.isArray(signatures)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Declaration signature metadata is malformed.' });
                declarationSignatures = signatures;
                reserveSignatureContainers(signatures.length);
                for (const signature of signatures) if (invalidSignature(signature)) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Declaration signature metadata is malformed.' });
            }
        }
        const identities = (signatures: unknown[], evidence: 'catalog-signature' | 'declaration-signature') => signatures.map(signature => signatureIdentity(record, signature as Record<string, unknown>, evidence));
        records.splice(0, records.length, {
            id: record.id, namespace: record.namespace, className: record.className, member: record.member, name: record.name, kind: record.kind,
            static: typeof record.static === 'boolean' ? record.static : null, semanticKey: record.semanticKey ?? null,
            signatures: sourceSignatures, signatureIdentities: { catalog: identities(sourceSignatures, 'catalog-signature'), declaration: identities(declarationSignatures, 'declaration-signature') },
            declarationEvidence: record.declarationEvidence ?? null, permitted: false, evidenceStatus: record.evidenceStatus ?? null,
        });
    }
    if (offset > records.length) throw new ToolError({ code: 'STALE_CURSOR', status: 409, message: 'Catalog cursor offset exceeds this result set.' });
    if (args.className && records.length === 0 && !matchedCatalogTarget && operation !== 'get_related_types') throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Class ${args.className} is absent from the ${version} catalog.` });
    if (args.recordId !== undefined && records.length === 0 && operation !== 'get_related_types') throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Record is absent from the selected catalog scope/version/filters.' });
    let live: Record<string, unknown> = { checked: false, context: 'edit-scene', available: null, writablePaths: [], mutationAuthorized: false };
    if (observesTarget && args.className && engineClassTarget && version === '3.7.3' && !args.reference) {
        try {
            const availability = z.object({ available: z.boolean(), className: z.string(), engineVersion: z.string().nullable(), context: z.literal('edit-scene') }).parse(await observeWithinDeadline(() => Editor.Message.request('scene', 'execute-scene-script', { name: 'ccp3x', method: 'engineApiClassAvailability', args: [{ className: args.className }] })));
            if (availability.className.replace(/^cc\./, '') !== args.className.replace(/^cc\./, '')) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'Availability probe returned a different class identity.' });
            if (availability.engineVersion !== version) throw new ToolError({ code: 'VERSION_CONTEXT_MISMATCH', status: 422, message: 'Availability probe engine version does not match the selected catalog.' });
            live = { ...live, ...availability, checked: true, versionMatches: availability.engineVersion === version };
        } catch (error: unknown) {
            if (error instanceof ToolError && error.code === 'CATALOG_QUERY_TIMEOUT') throw error;
            live = { ...live, unavailableReason: 'Class availability probe unavailable', unavailableCode: error instanceof ToolError ? error.code : 'CLASS_AVAILABILITY_FAILED' };
        }
    }
    if (args.reference) {
        if (version !== '3.7.3') throw new ToolError({ code: 'VERSION_CONTEXT_MISMATCH', status: 422, message: 'Comparison catalog cannot be mapped to the Creator3.7 target.' });
        if (args.namespace !== undefined && args.namespace !== 'engine-runtime' || matchedCatalogTarget && !engineClassTarget) throw new ToolError({ code: 'VERSION_CONTEXT_MISMATCH', status: 422, message: 'Inspector instances cannot be mapped to nonengine or mixed catalog namespaces.' });
        if (args.recordId !== undefined && (typeof exactRecordClass !== 'string' || !exactRecordClass.trim())) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'Exact catalog record has no owning class for Inspector instance mapping.' });
        if (exactRecordClass && args.reference.type !== undefined && exactRecordClass.replace(/^cc\./, '') !== args.reference.type.replace(/^cc\./, '')) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'Exact catalog record owner and reference type disagree.' });
        // Re-read every request: project script recompilation cannot leave a persistent path cache.
        const info = await observeWithinDeadline(() => ToolsUtils.inspectInstance(args.reference!.id, false));
        if (!info?.props) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Target has no authoritative Inspector dump.' });
        if (typeof info.type !== 'string' || !info.type.trim() || typeof info.props !== 'object' || Array.isArray(info.props)) throw new ToolError({ code: 'INSPECTOR_RESPONSE_INVALID', status: 502, message: 'Inspector returned malformed class or property metadata.' });
        if (args.className && info.type.replace(/^cc\./, '') !== args.className.replace(/^cc\./, '')) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'Target class does not match requested catalog class.' });
        if (exactRecordClass && info.type.replace(/^cc\./, '') !== exactRecordClass.replace(/^cc\./, '')) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'Target class does not match the exact catalog record owner.' });
        if (args.reference.type !== undefined && info.type.replace(/^cc\./, '') !== args.reference.type.replace(/^cc\./, '')) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'Target class does not match requested reference type.' });
        live = { checked: true, context: 'edit-scene', available: true, type: info.type, writablePaths: Object.entries(info.props).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value) && 'readonly' in value && value.readonly === false).map(([key]) => key), mutationAuthorized: false, pathEvidence: 'authoritative-inspector-dump' };
    }
    const selected: ApiRecord[] = [];
    let byteLimited = false;
    const cursorAt = (next: number): string | null => next < records.length ? Buffer.from(JSON.stringify({ hash: index.catalogHash, selector: selectorHash, offset: next })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null;
    const result = (): Record<string, unknown> => ({ version, operation, coverage, catalogHash: index.catalogHash, records: selected, total: records.length, count: selected.length, truncated: offset + selected.length < records.length, truncationReason: offset + selected.length < records.length ? byteLimited ? 'maxBytes' : 'maxEntries' : null, nextCursor: cursorAt(offset + selected.length), live, runtimeVerified: false, qualified: false });
    for (const record of records.slice(offset, offset + maxEntries)) {
        checkDeadline();
        selected.push(external && operation === 'records' ? ApiRecordSchema.parse({ ...readPage(() => external.readRecord(record.id)), permitted: false, writablePath: null }) : record);
        if (Buffer.byteLength(JSON.stringify(result())) > maxBytes) { selected.pop(); byteLimited = true; break; }
    }
    if (offset < records.length && selected.length === 0) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 422, message: 'One catalog record cannot fit maxBytes; narrow the query or increase its explicit bound.' });
    if (Buffer.byteLength(JSON.stringify(result())) > maxBytes) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 422, message: 'Required catalog metadata exceeds maxBytes.' });
    checkDeadline();
    return result();
}
