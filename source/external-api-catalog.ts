import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { TextDecoder } from 'util';
import { z } from './schema-validator';
import { ToolError } from './utcp/tool-error';
import type { infer as InferSchema } from 'zod';

export function parseCatalogJson(bytes: Buffer): unknown {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Catalog input is not valid UTF-8 JSON.' }); }
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const EntrySchema = z.object({ id: z.string().min(1), shard: z.number().int().nonnegative(), namespace: z.string(), className: z.string().nullable(), name: z.string(), member: z.string().nullable(), kind: z.string(), module: z.string().min(1).optional(), visibility: z.enum(['public', 'protected', 'private', 'internal']).nullable().optional(), contexts: z.array(z.string().min(1).max(128)).max(32).nullable().optional(), evidenceState: z.string().min(1).max(128).nullable().optional(), domain: z.string() });
const StaticEntrySchema = EntrySchema.extend({ static: z.boolean().nullable().optional() });
const LookupSchema = z.object({ schemaVersion: z.literal(1), version: z.string(), catalogHash: digest, sourceIndexSha256: digest, shards: z.array(z.object({ file: z.string(), sha256: digest, count: z.number().int().nonnegative(), domain: z.string() })).max(1000), entries: z.array(StaticEntrySchema).max(100000) });
const SourceIndexSchema = z.object({ schemaVersion: z.literal(1), version: z.string(), catalogHash: digest, recordCount: z.number().int().nonnegative().optional(), domains: z.array(z.object({ name: z.string(), file: z.string(), count: z.number().int().nonnegative() })).max(1000) });
const ConfigSchema = z.object({ schemaVersion: z.literal(1), catalogs: z.array(z.object({ version: z.enum(['3.7.3', '3.8.8']), catalogRoot: z.string().min(1), lookupRoot: z.string().min(1), lookupSha256: digest, catalogHash: digest })).max(2) });
type Lookup = InferSchema<typeof LookupSchema>;
export type ExternalApiEntry = InferSchema<typeof StaticEntrySchema>;
const cache = new Map<string, { bytes: number; records: Map<string, Record<string, unknown>> }>();
let cacheBytes = 0;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

export function readBounded(root: string, basename: string, maximum: number, expected?: string): Buffer {
    if (path.basename(basename) !== basename || basename === '.' || basename === '..') throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Unsafe catalog path.' });
    const file = fs.realpathSync(path.join(root, basename));
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Catalog file escapes its approved root.' });
    const fd = fs.openSync(file, 'r');
    let readFailed = false;
    try {
        const before = fs.fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.size > BigInt(maximum)) throw new ToolError({ code: 'CATALOG_LIMIT_EXCEEDED', status: 422, message: 'Catalog file exceeds its read bound.' });
        const data = Buffer.allocUnsafe(Number(before.size) + 1);
        let offset = 0;
        while (offset < data.length) {
            const count = fs.readSync(fd, data, offset, data.length - offset, null);
            if (!count) break;
            offset += count;
        }
        const after = fs.fstatSync(fd, { bigint: true });
        const current = fs.statSync(file, { bigint: true });
        const unchanged = (stat: typeof before) => stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs;
        if (BigInt(offset) !== before.size || !unchanged(after) || !unchanged(current) || fs.realpathSync(path.join(root, basename)) !== file) throw new ToolError({ code: 'CATALOG_CHANGED', status: 409, message: 'Catalog input changed while reading.' });
        const bytes = data.subarray(0, offset);
        if (expected && crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw new ToolError({ code: 'CATALOG_HASH_MISMATCH', status: 409, message: 'Catalog bytes do not match the approved identity.' });
        return bytes;
    } catch (error: unknown) {
        readFailed = true;
        throw error;
    } finally {
        try { fs.closeSync(fd); }
        catch { if (!readFailed) throw new ToolError({ code: 'CATALOG_READ_FAILED', status: 502, message: 'Catalog descriptor cleanup could not be confirmed.' }); }
    }
}

export interface ExternalApiCatalog {
    catalogHash: string;
    snapshotHash: string;
    entries: ExternalApiEntry[];
    domains: Array<{ name: string; file: string; count: number }>;
    findEntry(id: string): ExternalApiEntry | undefined;
    readRecord(id: string): Record<string, unknown>;
}

/** Operator-owned project config only. No request supplies filesystem paths or chooses a trust root. */
export function openExternalApiCatalog(version: string): ExternalApiCatalog | null {
    const projectPath: unknown = typeof Editor !== 'undefined' ? Editor.Project?.path : undefined;
    if (typeof projectPath !== 'string' || !projectPath) return null;
    const project = fs.realpathSync(projectPath);
    const configPath = path.join(project, '.ccp', 'engine-api-catalogs.json');
    if (!fs.existsSync(configPath)) return null;
    const configReal = fs.realpathSync(configPath);
    const configRelative = path.relative(project, configReal);
    if (configRelative.startsWith(`..${path.sep}`) || path.isAbsolute(configRelative)) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Catalog configuration escapes the project.' });
    const config = ConfigSchema.parse(parseCatalogJson(readBounded(path.dirname(configReal), path.basename(configReal), 16384)));
    if (new Set(config.catalogs.map(item => item.version)).size !== config.catalogs.length) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Duplicate catalog version configuration.' });
    const selected = config.catalogs.find(item => item.version === version);
    if (!selected) return null;
    if (!path.isAbsolute(selected.catalogRoot) || !path.isAbsolute(selected.lookupRoot)) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Configured catalog roots must be absolute operator-owned paths.' });
    const root = fs.realpathSync(selected.catalogRoot), lookupRoot = fs.realpathSync(selected.lookupRoot);
    const lookup = LookupSchema.parse(parseCatalogJson(readBounded(lookupRoot, 'lookup.json', 32 * 1024 * 1024, selected.lookupSha256)));
    if (lookup.version !== version || lookup.catalogHash !== selected.catalogHash) throw new ToolError({ code: 'CATALOG_HASH_MISMATCH', status: 409, message: 'Lookup version/catalog identity differs from configuration.' });
    const sourceIndex = SourceIndexSchema.parse(parseCatalogJson(readBounded(root, 'index.json', 1024 * 1024, lookup.sourceIndexSha256)));
    if (sourceIndex.version !== version || sourceIndex.catalogHash !== lookup.catalogHash) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Source index version/catalog identity differs from lookup.' });
    if (lookup.shards.some(shard => ['index.json', 'lookup.json', 'manifest.json'].includes(shard.file.toLowerCase()))) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Reserved catalog metadata filename cannot be used as a shard.' });
    if (lookup.shards.some(shard => path.basename(shard.file) !== shard.file || path.win32.basename(shard.file) !== shard.file || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/.test(shard.file))) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Unsafe external catalog shard filename.' });
    const sourceDomains = new Map(sourceIndex.domains.map(domain => [domain.file, domain]));
    const lookupFiles = new Set(lookup.shards.map(shard => shard.file));
    if (new Set(sourceIndex.domains.map(domain => domain.file.toLowerCase())).size !== sourceIndex.domains.length
        || new Set(lookup.shards.map(shard => shard.file.toLowerCase())).size !== lookup.shards.length) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Catalog manifest contains case-colliding shard filenames.' });
    if (sourceDomains.size !== sourceIndex.domains.length || lookupFiles.size !== lookup.shards.length || sourceDomains.size !== lookupFiles.size
        || lookup.shards.some(shard => { const domain = sourceDomains.get(shard.file); return !domain || domain.name !== shard.domain || domain.count !== shard.count; })
        || sourceIndex.recordCount !== undefined && sourceIndex.recordCount !== lookup.entries.length) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Lookup shard manifest differs from the verified source index.' });
    const entriesById = new Map<string, ExternalApiEntry>();
    const indexedCounts = lookup.shards.map(() => 0);
    for (const entry of lookup.entries) {
        if (!entry.namespace || !entry.id.startsWith(`${version}:${entry.namespace}:`)) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Lookup record identity differs from its version/namespace.' });
        if (!entry.domain.startsWith(`${entry.namespace}.`)) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Lookup domain does not belong to the record namespace.' });
        if (entriesById.has(entry.id) || !lookup.shards[entry.shard] || entry.domain !== lookup.shards[entry.shard].domain) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Catalog lookup identities are inconsistent.' });
        entriesById.set(entry.id, entry);
        indexedCounts[entry.shard]++;
    }
    if (lookup.shards.some((shard, index) => shard.count !== indexedCounts[index])) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Lookup entry counts differ from declared shard counts.' });
    return {
        snapshotHash: crypto.createHash('sha256').update(JSON.stringify([project, version, root, lookupRoot, selected.lookupSha256])).digest('hex'),
        catalogHash: lookup.catalogHash, entries: lookup.entries.map(entry => ({ ...entry, ...(entry.contexts ? { contexts: [...entry.contexts] } : {}) })),
        domains: lookup.shards.map(shard => ({ name: shard.domain, file: shard.file, count: shard.count })),
        findEntry(id) { return entriesById.get(id); },
        readRecord(id) {
            const entry = entriesById.get(id);
            if (!entry) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Catalog record was not indexed.' });
            const shard = lookup.shards[entry.shard];
            const bytes = readBounded(root, shard.file, 8 * 1024 * 1024, shard.sha256);
            const key = `${root}:${version}:${lookup.catalogHash}:${shard.file}:${shard.sha256}`;
            let cached = cache.get(key);
            if (!cached) {
                const parsed = z.object({ records: z.array(z.record(z.string(), z.unknown())).max(10000) }).parse(parseCatalogJson(bytes));
                if (parsed.records.length !== shard.count) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Shard record count differs from lookup.' });
                const records = new Map<string, Record<string, unknown>>();
                for (const record of parsed.records) {
                    if (typeof record.id !== 'string' || typeof record.namespace !== 'string' || !record.namespace || !record.id.startsWith(`${version}:${record.namespace}:`) || records.has(record.id) || record.version !== version) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Shard record identity/version is invalid.' });
                    if (record.static != null && typeof record.static !== 'boolean') throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Shard record static metadata is invalid.' });
                    records.set(record.id, record);
                }
                cached = { bytes: bytes.length, records };
                while (cache.size >= 8 || cacheBytes + cached.bytes > MAX_CACHE_BYTES) {
                    const oldest = cache.keys().next().value;
                    if (!oldest) break;
                    cacheBytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
                }
                cache.set(key, cached); cacheBytes += cached.bytes;
            } else { cache.delete(key); cache.set(key, cached); }
            if (cached.records.size !== shard.count) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Cached shard record count differs from lookup.' });
            for (const recordId of cached.records.keys()) {
                if (entriesById.get(recordId)?.shard !== entry.shard) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Shard record IDs differ from the selected lookup.' });
            }
            const record = cached.records.get(id);
            const recordDomain = record && (typeof record.domain === 'string' && record.domain || (record.domain == null || record.domain === '') && typeof record.module === 'string' && record.module.replace(/[^\w-]/g, '-'));
            if (!record || typeof recordDomain !== 'string' || !recordDomain || record.namespace !== entry.namespace || record.className !== entry.className || record.kind !== entry.kind || `${record.namespace}.${recordDomain}` !== entry.domain) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Indexed record does not match its actual shard metadata.' });
            if (record.name !== entry.name || record.member !== entry.member) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Indexed name/member differs from verified record metadata.' });
            if (entry.static !== undefined && (record.static ?? null) !== entry.static) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Indexed static identity differs from verified record metadata.' });
            if (entry.module !== undefined && record.module !== entry.module) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Indexed module differs from verified record metadata.' });
            if (entry.visibility !== undefined && (record.visibility ?? null) !== entry.visibility) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Indexed visibility differs from verified record metadata.' });
            const execution = record.contextConstraints && typeof record.contextConstraints === 'object' ? (record.contextConstraints as Record<string, unknown>).execution ?? null : null;
            if (entry.contexts !== undefined && JSON.stringify(execution) !== JSON.stringify(entry.contexts)) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Indexed execution contexts differ from verified record metadata.' });
            if (entry.evidenceState !== undefined && (record.evidenceStatus ?? null) !== entry.evidenceState) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Indexed evidence state differs from verified record metadata.' });
            return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
        },
    };
}
