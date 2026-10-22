import { utcpTool } from '../decorators';
import { Base64ImageSchema, IBase64Image, InstanceReferenceSchema, IInstanceReference, ISuccessIndicator, SuccessIndicatorSchema } from '../schemas';
import { ToolError } from '../tool-error';
import path from 'path';
import os from 'os';
import { basename, extname } from 'path';
import fs from 'fs-extra';
import packageJSON from '../../../package.json';
import { AssetInfo, AssetOperationOption, IAssetInfo, IAssetMeta } from '@cocos/creator-types/editor/packages/asset-db/@types/public';
import { AssetTreeItemSchema, IAssetTreeItem } from '../schemas';
import { DEFAULT_TREE_MAX_DEPTH, DEFAULT_TREE_MAX_NODES } from '../utils/tools-utils';
import { VERBOSE_TREE_DEPTH, VERBOSE_TREE_NODES, VERBOSE_FILE_BYTES } from '../utils/verbose';
import { assetQueryMemo, invalidateAfterWrite } from '../utils/memo-cache';
import { createHash } from 'crypto';
import { ImporterManager, IAssetImporter } from '../utils/asset-importers';

// helpers (shared by previewManage + kept methods)
async function queryAssetsCompat(options: { pattern?: string, [k: string]: any }): Promise<any[]> {
    // M4 L2: asset listing is stable for seconds — cache 5s cross-request, keyed by serialized query.
    const cacheKey = JSON.stringify(options);
    const cached = assetQueryMemo.get<any[]>(cacheKey);
    if (cached) return cached;
    try {
        const result = await Editor.Message.request('asset-db', 'query-assets', options as any);
        if (Array.isArray(result)) { assetQueryMemo.set(cacheKey, result); return result; }
    } catch (e) { /* probe: options variant unsupported here — the pattern-only fallback below propagates */ }
    const result = await Editor.Message.request('asset-db', 'query-assets', (options.pattern ?? 'db://assets/**') as any);
    if (Array.isArray(result)) assetQueryMemo.set(cacheKey, result);
    return Array.isArray(result) ? result : [];
}
function boundedUtf8Preview(text: string, maxBytes: number): string {
    const bytes = Buffer.allocUnsafe(maxBytes);
    const written = bytes.write(text, 'utf8');
    return bytes.toString('utf8', 0, written);
}
async function sha256File(filePath: string, maxBytes = Infinity): Promise<string> {
    const hash = createHash('sha256');
    // Keep executor form for Creator 3.7's older Node runtime.
    await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        const timer = Number.isFinite(maxBytes) ? setTimeout(() => stream.destroy(new Error('File hashing deadline exceeded.')), 2000) : undefined;
        stream.on('close', () => clearTimeout(timer));
        let bytes = 0;
        stream.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > maxBytes) stream.destroy(new Error('File exceeded the hashing byte limit.'));
            else hash.update(chunk);
        });
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    return hash.digest('hex');
}
async function toAssetUrl(id: string): Promise<string> {
    if (!id) throw new Error('Asset reference id is empty');
    if (id.startsWith('db://')) return id;
    const info = await Editor.Message.request('asset-db', 'query-asset-info', id).catch(() => null);
    if (info?.url) return info.url;
    const url = await Editor.Message.request('asset-db', 'query-url', id).catch(() => null);
    if (url) return url as string;
    throw new Error(`Cannot resolve asset reference '${id}' to a db:// url.`);
}
function normalizePath(p?: string): string {
    if (!p) return 'db://assets';
    let path2 = p.replace(/\\/g, '/').trim();
    if (path2.startsWith('db://')) return path2.endsWith('/') && path2 !== 'db://' ? path2.slice(0, -1) : path2;
    if (path2.startsWith('/')) path2 = path2.slice(1);
    if (path2 === '' || path2 === 'assets') return 'db://assets';
    if (path2.startsWith('assets/')) { const r='db://'+path2; return r.endsWith('/')?r.slice(0,-1):r; }
    if (path2.endsWith('/')) path2=path2.slice(0,-1);
    return `db://assets/${path2}`;
}
function enforceProjectFilePath(filePath: string, operation: string): string {
    const project = Reflect.get(Editor, 'Project');
    const projectPath = project && typeof project === 'object' ? Reflect.get(project, 'path') : undefined;
    if (typeof projectPath !== 'string' || !projectPath) return filePath;
    const root = path.resolve(projectPath);
    const resolved = path.resolve(filePath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new ToolError({
            code: 'INVALID_ARGUMENT',
            status: 400,
            message: `${operation} source path escapes the project boundary.`,
            details: { operation },
            recovery: 'Use an asset whose source file is inside the open project.',
        });
    }
    return resolved;
}
const MAX_MANIFEST_ASSET_PATH_LENGTH = 256;
const MAX_MANIFEST_DEPENDENCIES = 128;
const MAX_USAGE_REFERENCES = 128;

function normalizeBoundedAssetPath(value: unknown, toolName: string): string {
    if (value === undefined) return 'db://assets';
    if (typeof value !== 'string') {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${toolName} assetPath must be a string.` });
    }
    const input = value.trim();
    if (!input || input.length > MAX_MANIFEST_ASSET_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(input)) {
        throw new ToolError({
            code: 'INVALID_ARGUMENT',
            status: 400,
            message: `${toolName} assetPath must be a normalized non-empty path of at most ${MAX_MANIFEST_ASSET_PATH_LENGTH} characters.`,
        });
    }
    const normalized = normalizePath(input);
    if (normalized !== 'db://assets' && !normalized.startsWith('db://assets/')) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${toolName} assetPath must resolve inside db://assets.` });
    }
    const segments = normalized.slice('db://assets'.length).split('/').filter(Boolean);
    if (segments.some((segment) => segment === '.' || segment === '..' || /[*?[\]]/.test(segment))) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${toolName} assetPath contains an invalid path segment.` });
    }
    return normalized;
}

function normalizeManifestAssetPath(value: unknown): string {
    return normalizeBoundedAssetPath(value, 'assetManifestExport');
}

function validateManifestMaxAssets(value: unknown): number {
    if (value === undefined) return 128;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 512) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetManifestExport maxAssets must be an integer from 1 to 512.' });
    }
    return value;
}
function validateManifestMaxFileBytes(value: unknown): number {
    if (value === undefined) return 10 * 1024 * 1024;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 50 * 1024 * 1024) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetManifestExport maxFileBytes must be an integer from 1 to 52428800.' });
    }
    return value;
}

function validateUsageMaxAssets(value: unknown): number {
    if (value === undefined) return 64;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 128) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetUsageAnalyze maxAssets must be an integer from 1 to 128.' });
    }
    return value;
}
function validateUsageMaxGraphAssets(value: unknown): number {
    if (value === undefined) return 5000;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5000) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetUsageAnalyze maxGraphAssets must be an integer from 1 to 5000.' });
    }
    return value;
}

const SERIALIZED_ASSET_EXTENSIONS = new Set([
    '.scene', '.prefab', '.anim', '.mtl', '.effect', '.json', '.pac', '.labelatlas',
    '.terrain', '.animgraph', '.animgraphvari', '.animask', '.plist', '.tmx', '.tsx',
]);
const SERIALIZED_GRAPH_FILE_BYTES = 5 * 1024 * 1024;

function assetUuidBase(value: string): string {
    const separator = value.indexOf('@');
    return separator < 0 ? value : value.slice(0, separator);
}

function serializedAssetReferences(content: string): string[] {
    const references = new Set<string>();
    const pattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:@[A-Za-z0-9_-]+)?/gi;
    for (const match of content.matchAll(pattern)) references.add(assetUuidBase(match[0].toLowerCase()));
    return [...references].sort();
}
const ASSET_GRAPH_EXCLUSION_REASONS = ['source-file-unavailable', 'source-file-too-large', 'source-read-failed'] as const;

function serializedAssetReferenceOccurrences(content: string): Array<{ id: string, line: number }> {
    const occurrences: Array<{ id: string, line: number }> = [];
    const pattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:@[A-Za-z0-9_-]+)?/gi;
    for (const match of content.matchAll(pattern)) {
        occurrences.push({
            id: assetUuidBase(match[0].toLowerCase()),
            line: content.slice(0, match.index ?? 0).split('\n').length,
        });
    }
    return occurrences;
}
function isAssetGraphRoot(row: Record<string, unknown>): boolean {
    const extension = extname(typeof row.url === 'string' ? row.url : '').toLowerCase();
    return row.type === 'cc.SceneAsset'
        || row.type === 'cc.Prefab'
        || row.importer === 'scene'
        || row.importer === 'prefab'
        || extension === '.scene'
        || extension === '.prefab';
}

function isManifestRow(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function manifestDependencies(row: unknown): string[] | undefined {
    if (!isManifestRow(row) || !Array.isArray(row.depends)) return undefined;
    return [...new Set(row.depends.filter((dependency: unknown): dependency is string => typeof dependency === 'string' && dependency.length > 0))]
        .sort()
        .slice(0, MAX_MANIFEST_DEPENDENCIES);
}


function assetManifestError(error: unknown): ToolError {
    return new ToolError({
        code: 'ASSET_QUERY_FAILED',
        status: 502,
        message: 'assetManifestExport could not query the Creator asset database.',
        details: { cause: error instanceof Error ? error.message : String(error) },
        recovery: 'Retry after the Creator asset database is ready.',
    });
}

function assetUsageError(error: unknown): ToolError {
    return new ToolError({
        code: 'ASSET_QUERY_FAILED',
        status: 502,
        message: 'assetUsageAnalyze could not query the Creator asset database.',
        details: { cause: error instanceof Error ? error.message : String(error) },
        recovery: 'Retry after the Creator asset database is ready.',
    });
}

function boundedPositive(value: unknown, fallback: number, maximum: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.min(value, maximum)
        : fallback;
}

const MAX_IMPORT_REFERENCE_ID_LENGTH = 256;
const MAX_IMPORT_REFERENCE_TYPE_LENGTH = 128;
const MAX_IMPORT_SOURCE_URL_LENGTH = 2048;
const MAX_IMPORT_SOURCE_NAME_LENGTH = 256;
const MAX_IMPORT_METADATA_DEPTH = 6;
const MAX_IMPORT_METADATA_OBJECT_PROPERTIES = 64;
const MAX_IMPORT_METADATA_ARRAY_ITEMS = 64;
const MAX_IMPORT_METADATA_ENTRIES = 256;
const MAX_IMPORT_METADATA_KEY_LENGTH = 128;
const MAX_IMPORT_METADATA_STRING_LENGTH = 2048;
const OMIT_IMPORT_METADATA = Symbol('omit-import-metadata');

type AssetImportMetadataValue =
    | string
    | number
    | boolean
    | null
    | AssetImportMetadataValue[]
    | { [key: string]: AssetImportMetadataValue };

interface AssetImportSettingsSource {
    uuid: string;
    url: string;
    type: string;
    name: string;
    isDirectory: boolean;
}

interface AssetImportSettingDescriptor {
    path: string;
    type: string;
    readonly: boolean;
    visible: boolean;
    displayName?: string;
    enumValues?: AssetImportMetadataValue[];
}

interface AssetImportSettingsSchema {
    importer: string;
    className: string;
    properties: AssetImportSettingDescriptor[];
    mutablePaths: string[];
}

interface AssetImportSettingsResult {
    reference: IInstanceReference;
    importer: string;
    schema: AssetImportSettingsSchema;
    settings: Record<string, AssetImportMetadataValue>;
    source: AssetImportSettingsSource;
}

interface AssetImportOutputEvidence {
    kind: 'source' | 'library';
    extension: string;
    path: string;
    status: 'verified' | 'missing' | 'unreadable' | 'too_large' | 'changed' | 'empty';
    bytes: number | null;
    sha256: string | null;
}

interface AssetImportCompletion {
    signal: 'asset-db/is-busy' | 'unsupported' | 'unavailable' | 'not_requested';
    polls: number;
}

export interface AssetImportSettingsSetResult {
    changed: boolean;
    path: string;
    previous: AssetImportMetadataValue;
    readBack: AssetImportMetadataValue;
    result: AssetImportSettingsResult;
    settingsSaved: boolean;
    importComplete: boolean | null;
    generatedOutputVerified: boolean | null;
    retrySafe: false;
    importCompletion: AssetImportCompletion;
    outputs: AssetImportOutputEvidence[];
    outputsTruncated: boolean;
}

interface RestorableAssetImporter extends IAssetImporter {
    restore(assetInfo: IAssetInfo): Promise<{ restored: true, sourceBytesRestored: true }>;
}

function supportsImporterRestore(importer: IAssetImporter): importer is RestorableAssetImporter {
    return 'restore' in importer && typeof importer.restore === 'function';
}

interface ImportMetadataBudget {
    remainingEntries: number;
    arrayItems?: number;
    ancestors: WeakSet<object>;
}

function invalidImportReference(message: string): ToolError {
    return new ToolError({
        code: 'INVALID_ARGUMENT',
        status: 400,
        message,
        recovery: 'Provide an asset reference with a non-empty id and, when present, a non-empty type string.',
    });
}

function validateImportReference(args: unknown): IInstanceReference {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw invalidImportReference('assetImportSettingsGet requires a reference object.');
    }
    const reference = Reflect.get(args, 'reference');
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
        throw invalidImportReference('assetImportSettingsGet reference must be an object.');
    }
    const id = Reflect.get(reference, 'id');
    const type = Reflect.get(reference, 'type');
    if (typeof id !== 'string' || !id || id !== id.trim() || id.length > MAX_IMPORT_REFERENCE_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(id)) {
        throw invalidImportReference(`assetImportSettingsGet reference.id must be a normalized non-empty string of at most ${MAX_IMPORT_REFERENCE_ID_LENGTH} characters.`);
    }
    if (type !== undefined && (typeof type !== 'string' || !type || type !== type.trim() || type.length > MAX_IMPORT_REFERENCE_TYPE_LENGTH || /[\u0000-\u001f\u007f]/.test(type))) {
        throw invalidImportReference(`assetImportSettingsGet reference.type must be a normalized non-empty string of at most ${MAX_IMPORT_REFERENCE_TYPE_LENGTH} characters when provided.`);
    }
    return type === undefined ? { id } : { id, type };
}

function boundedImportText(value: unknown, maximum: number, fallback = ''): string {
    return typeof value === 'string' ? value.slice(0, maximum) : fallback;
}

function isValidImportIdentity(value: unknown, maximum: number): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maximum
        && value === value.trim()
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeImportMetadataValue(
    value: unknown,
    depth: number,
    budget: ImportMetadataBudget,
): AssetImportMetadataValue | typeof OMIT_IMPORT_METADATA {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.slice(0, MAX_IMPORT_METADATA_STRING_LENGTH);
    if (typeof value === 'number') return Number.isFinite(value) ? value : OMIT_IMPORT_METADATA;
    if (typeof value !== 'object' || depth >= MAX_IMPORT_METADATA_DEPTH || budget.ancestors.has(value)) {
        return OMIT_IMPORT_METADATA;
    }

    budget.ancestors.add(value);
    if (Array.isArray(value)) {
        const normalized: AssetImportMetadataValue[] = [];
        const itemCount = Math.min(value.length, budget.arrayItems ?? MAX_IMPORT_METADATA_ARRAY_ITEMS);
        for (let index = 0; index < itemCount && budget.remainingEntries > 0; index++) {
            budget.remainingEntries--;
            let item: unknown;
            try {
                item = value[index];
            } catch {
                normalized.push(null);
                continue;
            }
            const bounded = normalizeImportMetadataValue(item, depth + 1, budget);
            normalized.push(bounded === OMIT_IMPORT_METADATA ? null : bounded);
        }
        budget.ancestors.delete(value);
        return normalized;
    }

    const normalized: Record<string, AssetImportMetadataValue> = {};
    let acceptedProperties = 0;
    let keys: string[];
    try {
        keys = Object.keys(value).sort();
    } catch {
        return normalized;
    }
    for (const key of keys) {
        if (acceptedProperties >= MAX_IMPORT_METADATA_OBJECT_PROPERTIES || budget.remainingEntries <= 0) break;
        if (!key || key.length > MAX_IMPORT_METADATA_KEY_LENGTH || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        budget.remainingEntries--;
        let propertyValue: unknown;
        try {
            propertyValue = Reflect.get(value, key);
        } catch {
            continue;
        }
        const bounded = normalizeImportMetadataValue(propertyValue, depth + 1, budget);
        if (bounded === OMIT_IMPORT_METADATA) continue;
        normalized[key] = bounded;
        acceptedProperties++;
    }
    budget.ancestors.delete(value);
    return normalized;
}

function importSettingDescriptor(path: string, property: unknown): AssetImportSettingDescriptor | null {
    if (!property || typeof property !== 'object' || Array.isArray(property)) return null;
    const type = boundedImportText(Reflect.get(property, 'type'), MAX_IMPORT_REFERENCE_TYPE_LENGTH);
    if (!type) return null;
    const displayName = boundedImportText(Reflect.get(property, 'displayName'), MAX_IMPORT_SOURCE_NAME_LENGTH);
    const enumList = Reflect.get(property, 'enumList');
    const enumValues = Array.isArray(enumList)
        ? enumList.slice(0, MAX_IMPORT_METADATA_ARRAY_ITEMS).map((item: unknown) => {
            const value = item && typeof item === 'object' ? Reflect.get(item, 'value') : item;
            const normalized = normalizeImportMetadataValue(value, 0, { remainingEntries: MAX_IMPORT_METADATA_ENTRIES, ancestors: new WeakSet<object>() });
            return normalized === OMIT_IMPORT_METADATA ? null : normalized;
        })
        : undefined;
    return {
        path,
        type,
        readonly: Reflect.get(property, 'readonly') === true,
        visible: Reflect.get(property, 'visible') !== false,
        ...(displayName ? { displayName } : {}),
        ...(enumValues ? { enumValues } : {}),
    };
}

function normalizeImporterProperties(
    importerName: string,
    className: string,
    properties: unknown,
): { schema: AssetImportSettingsSchema, settings: Record<string, AssetImportMetadataValue> } {
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
        throw new Error(`Importer '${importerName}' returned an invalid property map.`);
    }
    const settings: Record<string, AssetImportMetadataValue> = {};
    const descriptors: AssetImportSettingDescriptor[] = [];
    const nativeAnimation = importerName === 'animation-mask' || importerName === 'animation-graph-variant';
    const budget: ImportMetadataBudget = { remainingEntries: nativeAnimation ? 4096 : MAX_IMPORT_METADATA_ENTRIES, arrayItems: nativeAnimation ? 256 : MAX_IMPORT_METADATA_ARRAY_ITEMS, ancestors: new WeakSet<object>() };
    for (const path of Object.keys(properties).sort().slice(0, MAX_IMPORT_METADATA_OBJECT_PROPERTIES)) {
        const property = Reflect.get(properties, path);
        const descriptor = importSettingDescriptor(path, property);
        if (!descriptor) continue;
        const normalized = normalizeImportMetadataValue(Reflect.get(property, 'value'), 0, budget);
        if (normalized === OMIT_IMPORT_METADATA) continue;
        descriptors.push(descriptor);
        settings[path] = normalized;
    }
    return {
        schema: {
            importer: importerName,
            className: boundedImportText(className, MAX_IMPORT_REFERENCE_TYPE_LENGTH),
            properties: descriptors,
            mutablePaths: descriptors.filter((descriptor) => !descriptor.readonly).map((descriptor) => descriptor.path),
        },
        settings,
    };
}

function importSettingAtPath(settings: Record<string, AssetImportMetadataValue>, path: string): AssetImportMetadataValue | undefined {
    let current: AssetImportMetadataValue | undefined = settings;
    for (const segment of path.split('.')) {
        if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
        current = current[segment];
    }
    return current;
}

function expectedImportPatch(previous: AssetImportMetadataValue, value: AssetImportMetadataValue, key: string | null): AssetImportMetadataValue {
    if (!key) return value;
    if (!Array.isArray(previous) || !Array.isArray(value) || value.length === 0 || value.length > MAX_IMPORT_METADATA_ARRAY_ITEMS) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Native animation edits require one to 64 selected entries with a complete preflight collection.' });
    }
    const edits = new Map<string, Record<string, AssetImportMetadataValue>>();
    for (const edit of value) {
        if (!edit || typeof edit !== 'object' || Array.isArray(edit) || typeof edit[key] !== 'string' || edits.has(edit[key])) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Native animation edits require unique selected entry identities.' });
        }
        edits.set(edit[key], edit);
    }
    const expected = previous.map(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry[key] !== 'string') {
            throw new ToolError({ code: 'IMPORTER_INSPECTION_FAILED', status: 502, message: 'Native preflight collection has an invalid entry identity.' });
        }
        const edit = edits.get(entry[key]);
        edits.delete(entry[key]);
        return edit ? { ...entry, ...edit } : entry;
    });
    if (edits.size > 0) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Selected native animation entry is absent from the complete preflight collection.' });
    return expected;
}

function importSettingMatches(actual: AssetImportMetadataValue | undefined, expected: AssetImportMetadataValue, key: string | null): boolean {
    if (!key) return JSON.stringify(actual) === JSON.stringify(expected);
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
    const byIdentity = new Map<string, AssetImportMetadataValue>();
    for (const entry of actual) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry[key] !== 'string' || byIdentity.has(entry[key])) return false;
        byIdentity.set(entry[key], entry);
    }
    return expected.every(entry => !!entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry[key] === 'string'
        && JSON.stringify(byIdentity.get(entry[key])) === JSON.stringify(entry));
}

function assetImportSettingsQueryError(error: unknown): ToolError {
    return new ToolError({
        code: 'ASSET_QUERY_FAILED',
        status: 502,
        message: 'assetImportSettingsGet could not query the Creator asset database.',
        details: { cause: boundedImportText(error instanceof Error ? error.message : String(error), 512) },
        recovery: 'Retry after the Creator asset database is ready.',
    });
}
const MAX_IMPORT_SET_PATH_LENGTH = 128;
const MAX_IMPORT_SET_VALUE_BYTES = 16384;

function validateImportSet(args: unknown): { reference: IInstanceReference, path: string, value: AssetImportMetadataValue } {
    const reference = validateImportReference(args);
    const pathValue = Reflect.get(args as object, 'path');
    if (typeof pathValue !== 'string' || !pathValue || pathValue.length > MAX_IMPORT_SET_PATH_LENGTH
        || pathValue !== pathValue.trim() || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(pathValue)) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `assetImportSettingsSet path must be dot-separated identifiers of at most ${MAX_IMPORT_SET_PATH_LENGTH} characters.` });
    }
    const value = Reflect.get(args as object, 'value');
    if (Array.isArray(value) && value.length > MAX_IMPORT_METADATA_ARRAY_ITEMS) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Importer array edits must contain at most 64 items; truncated mutation requests are not accepted.' });
    }
    const normalized = normalizeImportMetadataValue(value, 0, { remainingEntries: MAX_IMPORT_METADATA_ENTRIES, ancestors: new WeakSet<object>() });
    if (normalized === OMIT_IMPORT_METADATA || JSON.stringify(normalized).length > MAX_IMPORT_SET_VALUE_BYTES) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `assetImportSettingsSet value must be bounded JSON-compatible data under ${MAX_IMPORT_SET_VALUE_BYTES} bytes.` });
    }
    return { reference, path: pathValue, value: normalized };
}

const MAX_IMPORT_OUTPUTS = 32;
const MAX_IMPORT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_IMPORT_TOTAL_OUTPUT_BYTES = 64 * 1024 * 1024;
const IMPORT_REQUEST_TIMEOUT_MS = 5000;
const IMPORT_BUSY_POLL_LIMIT = 20;

async function boundedImportRequest<T>(operation: Promise<T>, mutationPending = false, timeoutMs = IMPORT_REQUEST_TIMEOUT_MS): Promise<T> {
    // Creator 3.7 runs on Node without Promise.withResolvers.
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ToolError({
                code: 'ASSET_IMPORT_DEADLINE', status: 504,
                message: 'Importer outcome could not be observed within the bounded deadline.',
                details: { retrySafe: false, mutationPending },
                recovery: 'Read current settings and asset-db busy state before any further mutation.',
            })), timeoutMs);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

async function importerCompletion(uuid: string): Promise<{ complete: boolean | null, evidence: AssetImportCompletion }> {
    for (let polls = 1; polls <= IMPORT_BUSY_POLL_LIMIT; polls++) {
        let busy: unknown;
        try {
            busy = await boundedImportRequest(Editor.Message.request('asset-db', 'is-busy'), false, 250);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            const unsupported = /(?:unknown|unsupported|not found|not exist|not registered|no handler).*(?:message|is-busy)|(?:message|is-busy).*(?:unknown|unsupported|not found|not exist|not registered|no handler)/i.test(message);
            return { complete: null, evidence: { signal: unsupported ? 'unsupported' : 'unavailable', polls } };
        }
        if (typeof busy !== 'boolean') return { complete: null, evidence: { signal: 'unsupported', polls } };
        if (!busy) {
            let info: IAssetInfo | null;
            try {
                info = await boundedImportRequest(Editor.Message.request('asset-db', 'query-asset-info', uuid));
            } catch {
                return { complete: null, evidence: { signal: 'unavailable', polls } };
            }
            if (info?.invalid === true) return { complete: false, evidence: { signal: 'asset-db/is-busy', polls } };
            if (info?.imported === true && info.invalid === false) return { complete: true, evidence: { signal: 'asset-db/is-busy', polls } };
            if (!info || typeof info.imported !== 'boolean' || typeof info.invalid !== 'boolean') {
                return { complete: null, evidence: { signal: 'asset-db/is-busy', polls } };
            }
        }
        if (polls < IMPORT_BUSY_POLL_LIMIT) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { complete: false, evidence: { signal: 'asset-db/is-busy', polls: IMPORT_BUSY_POLL_LIMIT } };
}

async function importerOutputEvidence(info: IAssetInfo): Promise<{ outputs: AssetImportOutputEvidence[], truncated: boolean }> {
    const candidates: Array<{ kind: 'source' | 'library', extension: string, path: string }> = [];
    if (typeof info.file === 'string' && info.file) candidates.push({ kind: 'source', extension: extname(info.file).slice(0, 128), path: info.file });
    const library = info.library && typeof info.library === 'object' && !Array.isArray(info.library) ? info.library : {};
    const keys = Object.keys(library).sort();
    let truncated = keys.length + candidates.length > MAX_IMPORT_OUTPUTS;
    for (const extension of keys.slice(0, MAX_IMPORT_OUTPUTS - candidates.length)) {
        const filePath = Reflect.get(library, extension);
        if (typeof filePath !== 'string' || !filePath) { truncated = true; continue; }
        candidates.push({ kind: 'library', extension: boundedImportText(extension, 128), path: filePath });
    }
    const outputs: AssetImportOutputEvidence[] = [];
    let remainingBytes = MAX_IMPORT_TOTAL_OUTPUT_BYTES;
    for (const candidate of candidates) {
        const output: AssetImportOutputEvidence = { ...candidate, path: candidate.path.slice(0, 4096), status: 'unreadable', bytes: null, sha256: null };
        outputs.push(output);
        if (candidate.path.length > 4096 || !path.isAbsolute(candidate.path)) continue;
        try {
            const before = await boundedImportRequest(fs.stat(candidate.path), false, 1000);
            output.bytes = before.size;
            if (!before.isFile()) continue;
            if (before.size === 0) { output.status = 'empty'; continue; }
            if (before.size > Math.min(MAX_IMPORT_OUTPUT_BYTES, remainingBytes)) { output.status = 'too_large'; continue; }
            const limit = before.size;
            remainingBytes -= before.size;
            const hash = await sha256File(candidate.path, limit);
            const after = await boundedImportRequest(fs.stat(candidate.path), false, 1000);
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) { output.status = 'changed'; continue; }
            output.status = 'verified';
            output.sha256 = hash;
        } catch (error: unknown) {
            output.status = error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT' ? 'missing' : 'unreadable';
        }
    }
    return { outputs, truncated };
}

function importerOutputVerified(outputs: AssetImportOutputEvidence[], truncated: boolean, importComplete: boolean | null): boolean | null {
    const sourcePath = outputs.find((output) => output.kind === 'source')?.path;
    const generated = outputs.filter((output) => output.kind === 'library' && (!sourcePath || path.normalize(output.path) !== path.normalize(sourcePath)) && extname(output.path) !== '.meta');
    if (truncated || generated.some((output) => output.status !== 'verified')) return false;
    if (generated.length === 0 || importComplete === null) return null;
    return importComplete;
}
type TextureCompressionPlatform = 'miniGame' | 'web' | 'ios' | 'android' | 'pc';

interface TextureCompressionFormat {
    format: string;
    quality: string | number;
}

interface TextureCompressionOutputEvidence {
    extension: string;
    path: string;
    bytes: number;
    sha256: string;
}

function validateCompressionArgs(args: unknown): { reference: IInstanceReference, presetId: string, platform: TextureCompressionPlatform } {
    const reference = validateImportReference(args);
    const presetId = Reflect.get(args as object, 'presetId');
    const platform = Reflect.get(args as object, 'platform');
    if (typeof presetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(presetId)) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetCompressionConfigure presetId must be a normalized identifier of at most 128 characters.' });
    }
    if (!['miniGame', 'web', 'ios', 'android', 'pc'].includes(platform)) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetCompressionConfigure platform is unsupported.' });
    }
    return { reference, presetId, platform };
}

function compressionFormats(value: unknown): TextureCompressionFormat[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.keys(value).sort().slice(0, 32).map((format) => {
        const config = Reflect.get(value, format);
        const quality = config && typeof config === 'object' ? Reflect.get(config, 'quality') : config;
        return { format, quality: typeof quality === 'number' || typeof quality === 'string' ? quality : '' };
    });
}

async function compressionOutputEvidence(library: unknown): Promise<TextureCompressionOutputEvidence[]> {
    if (!library || typeof library !== 'object' || Array.isArray(library)) return [];
    const output: TextureCompressionOutputEvidence[] = [];
    for (const extension of Object.keys(library).sort().slice(0, 32)) {
        const filePath = Reflect.get(library, extension);
        if (typeof filePath !== 'string' || !await fs.pathExists(filePath)) continue;
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) continue;
        output.push({ extension, path: filePath, bytes: stat.size, sha256: await sha256File(filePath) });
    }
    return output;
}
async function waitForCompressionLibrary(uuid: string, initial: IAssetInfo): Promise<IAssetInfo> {
    let current = initial;
    for (let attempt = 0; attempt < 50; attempt++) {
        if ((await compressionOutputEvidence(current.library)).length > 0) return current;
        await new Promise((resolve) => setTimeout(resolve, 100));
        const refreshed = await Editor.Message.request('asset-db', 'query-asset-info', uuid) as IAssetInfo | null;
        if (refreshed) current = refreshed;
    }
    return current;
}
type AssetReadback = AssetInfo & { uuid: string, url?: string, type?: string };

function assetReadbackError(operation: string, cause: unknown): ToolError {
    return new ToolError({
        code: 'ASSET_READBACK_FAILED',
        status: 502,
        message: `${operation} completed without an authoritative asset identity read-back.`,
        details: { cause: boundedImportText(cause instanceof Error ? cause.message : String(cause), 512) },
        recovery: 'Retry after the Creator asset database finishes processing the operation.',
    });
}

async function readBackAsset(identifier: string, operation: string): Promise<AssetReadback> {
    let info: unknown;
    try {
        info = await Editor.Message.request('asset-db', 'query-asset-info', identifier);
    } catch (error: unknown) {
        throw assetReadbackError(operation, error);
    }
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
        throw assetReadbackError(operation, new Error(`Asset '${identifier}' was not returned by query-asset-info.`));
    }
    const uuid = Reflect.get(info, 'uuid');
    if (!isValidImportIdentity(uuid, MAX_IMPORT_REFERENCE_ID_LENGTH)) {
        throw assetReadbackError(operation, new Error(`Asset '${identifier}' has no stable UUID.`));
    }
    return info as AssetReadback;
}

async function assertAssetRemoved(identifier: string, operation: string): Promise<void> {
    let info: unknown;
    try {
        info = await Editor.Message.request('asset-db', 'query-asset-info', identifier);
    } catch (error: unknown) {
        throw assetReadbackError(operation, error);
    }
    if (info !== null && info !== undefined) {
        throw assetReadbackError(operation, new Error(`Asset '${identifier}' is still present after deletion.`));
    }
}





export class AssetTools {

    @utcpTool('assetGetTree', 'Get asset hierarchy tree. Defaults maxDepth=4/maxNodes=200; explicit values are capped at depth 99 and 10,000 nodes. Marks truncated branches.', {
        type: 'object',
        properties: {
            reference: InstanceReferenceSchema,
            assetPath: { type: 'string' },
            maxDepth: { type: 'number', minimum: 1, maximum: VERBOSE_TREE_DEPTH },
            maxNodes: { type: 'number', minimum: 1, maximum: VERBOSE_TREE_NODES },
            verbose: { type: 'boolean', description: 'When true, lifts omitted caps to verbose ceilings unless maxDepth/maxNodes explicitly set' }
        }
    }, AssetTreeItemSchema, "GET", ['asset', 'file', 'tree', 'hierarchy', 'folder', 'subasset'])
    async assetGetTree(args: { reference?: IInstanceReference, assetPath?: string, maxDepth?: number, maxNodes?: number, verbose?: boolean }): Promise<IAssetTreeItem> {
        if (args.reference) {
            const info = await Editor.Message.request('asset-db', 'query-asset-info', args.reference.id);
            if (!info) throw new Error(`Asset with UUID ${args.reference.id} not found.`);
            args.assetPath = info.url;
        }
        let rootPath = normalizePath(args.assetPath);
        const pattern = `${rootPath}/**`;
        // M1: asset scan + root uuid are independent -> 1 round
        const [assets, rootUuid] = await Promise.all([
            queryAssetsCompat({ pattern }),
            Editor.Message.request('asset-db', 'query-uuid', rootPath),
        ]);
        const assetsMap = new Map<string, IAssetTreeItem>();
        const rootName = rootPath.split('/').pop() || 'assets';
        const rootNode: IAssetTreeItem = { filesystemPath: (Editor.Project as any).path + '/' + rootPath.replace('db://',''), reference:{id:rootUuid||'root', type:'folder'}, name:rootName, children:[] };
        assetsMap.set(rootPath, rootNode);
        assets.forEach((asset:any)=>{ if(asset.url===rootPath) return; assetsMap.set(asset.url,{ reference:{id:asset.uuid, type:asset.isDirectory?'folder':asset.type}, name:asset.name, children:[] }); });
        assets.forEach((asset:any)=>{ if(asset.url===rootPath) return; const ti=assetsMap.get(asset.url); if(!ti) return; const pu=asset.url.substring(0,asset.url.lastIndexOf('/')); const pi=assetsMap.get(pu); if(pi) pi.children.push(ti); });
        // ponytail: default budgets — a bare call must not dump the whole asset DB.
        // Defaults apply per-param only when omitted; pass larger values for the full
        // tree. Same truncated/childrenOmitted convention as nodeGetTree.
        const maxDepth = boundedPositive(args.maxDepth, args.verbose ? VERBOSE_TREE_DEPTH : DEFAULT_TREE_MAX_DEPTH, VERBOSE_TREE_DEPTH);
        const maxNodes = boundedPositive(args.maxNodes, args.verbose ? VERBOSE_TREE_NODES : DEFAULT_TREE_MAX_NODES, VERBOSE_TREE_NODES);
        const prune=(n:IAssetTreeItem,d:number)=>{ if(d>=maxDepth){ (n as any).truncated='maxDepth'; (n as any).childrenOmitted=n.children.length; (n as any).childrenCount=n.children.length; n.children=[]; } else n.children.forEach(c=>prune(c,d+1)); }; prune(rootNode,0);
        const budget={left:maxNodes}; const trunc=(n:IAssetTreeItem,d:number)=>{ const ch=n.children; if(!ch||!ch.length) return; (n as any).childrenCount=ch.length; const kept:IAssetTreeItem[]=[]; for(let i=0;i<ch.length;i++){ if(budget.left<=0){ (n as any).truncated=(n as any).truncated||'nodeLimit'; (n as any).childrenOmitted=ch.length-i; break; } budget.left--; trunc(ch[i],d+1); kept.push(ch[i]); } if(kept.length!==ch.length) n.children=kept; }; trunc(rootNode,0);
        return rootNode;
    }

    @utcpTool('assetGetAtPath','Get asset reference by db:// path.',{type:'object',properties:{assetPath:{type:'string'}},required:['assetPath']},{type:'object',properties:{reference:InstanceReferenceSchema},required:['reference']},"GET",['asset','get','path','look','find'])
    async assetGetAtPath(args:{assetPath:string}):Promise<{reference:IInstanceReference}>{ const p=normalizePath(args.assetPath); const info=await Editor.Message.request('asset-db','query-asset-info',p); if(!info) throw new ToolError({code:'TARGET_NOT_FOUND',status:404,message:`Asset not found at path: ${p}`,details:{assetPath:p},recovery:'Use assetQuery to discover a current db:// asset path before retrying.'}); return {reference:{id:info.uuid, type:info.type}}; }

    @utcpTool(
        'assetResolvePath',
        'Resolve asset locations (uuid <-> db:// url <-> filesystem path) and probe existence. Accepts uuid (reference) OR db:// path (assetPath).',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                assetPath: { type: 'string', description: 'db:// url or path, alternative to reference.id' }
            },
            anyOf: [
                { required: ['reference'] },
                { required: ['assetPath'] },
            ]
        },
        {
            type: 'object',
            properties: {
                filesystemPath: { type: 'string' },
                url: { type: 'string' },
                uuid: { type: 'string' },
                exists: { type: 'boolean' },
                isDirectory: { type: 'boolean' },
                type: { type: 'string' },
                importer: { type: 'string' },
                isSubAsset: { type: 'boolean', description: 'True if this asset is a sub-asset (e.g. sprite-frame inside a texture). Sourced from AssetInfo.isSubAsset.' },
                containsSubAssets: { type: 'boolean', description: 'True if this asset contains sub-assets.' },
                relativePath: { type: 'string', description: 'Path relative to project root (Editor.Project.path).' },
                backupPath: { type: 'string', description: 'Filesystem path of the .meta sidecar (fspath + .meta).' }
            },
            required: ['filesystemPath']
        },
        "GET",
        ['asset', 'resolve', 'path', 'url', 'filesystem', 'uuid', 'exists']
    )
    async assetResolvePath(args: { reference?: IInstanceReference, assetPath?: string }): Promise<{ filesystemPath: string, url?: string, uuid?: string, exists: boolean, isDirectory?: boolean, type?: string, importer?: string, isSubAsset?: boolean, containsSubAssets?: boolean, relativePath?: string, backupPath?: string }> {
        const referenceId = args.reference?.id;
        const assetPath = referenceId ? undefined : (args.assetPath ? normalizePath(args.assetPath) : undefined);
        const id = referenceId || assetPath;
        if (!id) throw new Error('assetResolvePath requires reference.id or assetPath');
        const fromReference = typeof referenceId === 'string' && referenceId.length > 0;

        let fp2: string | null = null;
        let url2: string | null = null;
        let inf3: Record<string, unknown> | null = null;

        if (fromReference) {
            // A reference id is an asset identity only after asset-db confirms it.
            // Do not echo arbitrary node/unknown ids as asset UUIDs.
            const queried = await Editor.Message.request('asset-db', 'query-asset-info', referenceId).catch(() => null) as unknown;
            inf3 = isManifestRow(queried) ? queried : null;
            const authoritativeUuid = typeof inf3?.uuid === 'string' && inf3.uuid.length > 0 ? inf3.uuid : undefined;
            if (!authoritativeUuid) return { filesystemPath: '', exists: false };
            fp2 = typeof inf3?.file === 'string' ? inf3.file : await Editor.Message.request('asset-db', 'query-path', authoritativeUuid).catch(() => null) as string | null;
            if (!fp2) return { filesystemPath: '', url: typeof inf3?.url === 'string' ? inf3.url : undefined, uuid: authoritativeUuid, exists: false };
            url2 = await Editor.Message.request('asset-db', 'query-url', fp2).catch(() => null) as string | null;
        } else {
            const queried = await Editor.Message.request('asset-db', 'query-asset-info', id).catch(() => null) as unknown;
            const inf2 = isManifestRow(queried) ? queried : null;
            if (typeof inf2?.file === 'string') fp2 = inf2.file;
            else fp2 = await Editor.Message.request('asset-db', 'query-path', id).catch(() => null) as string | null;
            url2 = assetPath || null;
            inf3 = inf2; // same key -> reuse, avoids a 2nd identical lookup
        }

        if (!fp2) return { filesystemPath: '', url: fromReference ? (typeof inf3?.url === 'string' ? inf3.url : undefined) : assetPath, uuid: fromReference ? undefined : (typeof inf3?.uuid === 'string' && inf3.uuid.length > 0 ? inf3.uuid : undefined), exists: false };
        const uuidResolved = typeof inf3?.uuid === 'string' && inf3.uuid.length > 0 ? inf3.uuid : undefined;
        // G1 parity: isSubAsset/containsSubAssets from AssetInfo, relativePath/backupPath derived.
        // 3.7.3 asset-db exposes no dedicated message for these (registry 45 msgs), so derive — guard
        // every field because AssetInfo shape is version-dependent.
        const subAssets3 = inf3?.subAssets;
        const containsSubAssets = Array.isArray(subAssets3)
            ? subAssets3.length > 0
            : isManifestRow(subAssets3) && Object.keys(subAssets3).length > 0;
        // relativePath only makes sense inside the project — internal/engine assets
        // resolve outside projectPath and path.relative would return the absolute path.
        const projectPath3 = (Editor.Project as { path?: unknown } | undefined)?.path;
        let relativePath: string | undefined;
        if (typeof projectPath3 === 'string' && fp2) {
            const rel = path.relative(projectPath3, fp2);
            if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) relativePath = rel;
        }
        const backupCandidate = fp2 + '.meta';
        const backupPath = fs.existsSync(backupCandidate) ? backupCandidate : undefined;
        return { filesystemPath: fp2, url: url2 || (typeof inf3?.url === 'string' ? inf3.url : undefined), uuid: uuidResolved, exists: !!uuidResolved, isDirectory: typeof inf3?.isDirectory === 'boolean' ? inf3.isDirectory : undefined, type: typeof inf3?.type === 'string' ? inf3.type : undefined, importer: typeof inf3?.importer === 'string' ? inf3.importer : undefined, isSubAsset: typeof inf3?.isSubAsset === 'boolean' ? inf3.isSubAsset : false, containsSubAssets, relativePath, backupPath };
    }

    @utcpTool(
        'assetReadContent',
        'Read text content of an asset by uuid or db:// path. Rejects binary/oversized files; maxBytes or verbose=true (10MB) to raise the cap.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                assetPath: { type: 'string', description: 'db:// url or path' },
                maxBytes: { type: 'number', minimum: 1, maximum: VERBOSE_FILE_BYTES, description: 'Size cap in bytes, default 512KB; maximum 10MB' },
                verbose: { type: 'boolean', description: 'When true, lifts the omitted cap to 10MB; explicit maxBytes still wins.' }
            },
            anyOf: [
                { required: ['reference'] },
                { required: ['assetPath'] },
            ]
        },
        {
            type: 'object',
            properties: {
                content: { type: 'string' },
                filesystemPath: { type: 'string' },
                bytes: { type: 'number' },
                truncated: { type: 'boolean' }
            },
            required: ['content']
        },
        "GET",
        ['asset', 'read', 'content', 'text', 'file', 'source']
    )
    async assetReadContent(args: { reference?: IInstanceReference, assetPath?: string, maxBytes?: number, verbose?: boolean }): Promise<{ content: string, filesystemPath: string, bytes: number, truncated: boolean }> {
        const ident = args.reference?.id || (args.assetPath ? normalizePath(args.assetPath) : undefined);
        if (!ident) throw new Error('assetReadContent requires reference.id or assetPath');
        const asUuid2 = !ident.startsWith('db://');
        let fpR: string | null = null;
        if (asUuid2) fpR = await Editor.Message.request('asset-db', 'query-path', ident);
        else {
            const infR: any = await Editor.Message.request('asset-db', 'query-asset-info', ident).catch(() => null);
            if (infR?.file) fpR = infR.file;
            else fpR = await Editor.Message.request('asset-db', 'query-path', ident).catch(() => null);
        }
        if (!fpR) {
            throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Asset not found: ${ident}`, details: { asset: ident }, recovery: 'Use assetGetTree or assetResolvePath to inspect available assets.' });
        }
        const fpResolved = enforceProjectFilePath(fpR as string, 'assetReadContent');
        const extR = path.extname(fpResolved).toLowerCase();
        const BINARY = ['.png', '.jpg', '.jpeg', '.webp', '.mp3', '.ogg', '.wav', '.ttf', '.woff', '.mp4', '.mov', '.zip', '.gz', '.bmp', '.tga', '.psd'];
        if ((BINARY as string[]).includes(extR)) {
            throw new ToolError({
                code: 'ASSET_BINARY_UNREADABLE',
                status: 422,
                message: `Asset ${ident} is binary and cannot be read as UTF-8 text.`,
                details: { asset: ident, extension: extR },
                recovery: 'Use assetResolvePath, previewManage, or assetGetAvailableUrl for binary assets.',
            });
        }
        const stat: any = await (fs as any).stat(fpResolved).catch(() => null);
        if (!stat) {
            throw new ToolError({
                code: 'TARGET_NOT_FOUND',
                status: 404,
                message: `Asset file not found on disk: ${ident}`,
                details: { asset: ident, filesystemPath: fpResolved },
                recovery: 'Refresh the asset database and retry assetResolvePath.',
            });
        }
        const cap = boundedPositive(args.maxBytes, args.verbose ? VERBOSE_FILE_BYTES : 512 * 1024, VERBOSE_FILE_BYTES);
        if (stat.size > cap) {
            throw new ToolError({
                code: 'PAYLOAD_TOO_LARGE',
                status: 413,
                message: `Asset is ${stat.size} bytes, over the ${cap} byte cap.`,
                details: { asset: ident, bytes: stat.size, cap },
                recovery: args.verbose ? 'The asset exceeds the maximum 10MB readable size.' : 'Pass verbose=true or a larger maxBytes value.',
            });
        }
        const content = await (fs as any).readFile(fpResolved, 'utf8');
        return { content, filesystemPath: fpResolved, bytes: stat.size, truncated: false };
    }
    @utcpTool('assetSaveContent', 'Overwrite content of a text-based asset (TS, JSON, effect, txt). Identify by db:// path or uuid. No binary.', {
        type: 'object',
        properties: { assetPath: { type: 'string' }, reference: InstanceReferenceSchema, content: { type: 'string' } },
        required: ['content'],
        anyOf: [{ required: ['reference'] }, { required: ['assetPath'] }],
    }, { type: 'object', properties: { reference: InstanceReferenceSchema, filesystemPath: { type: 'string' } }, required: ['reference'] }, "POST", ['asset', 'save', 'write', 'content', 'script', 'text', 'edit', 'generate'])
    async assetSaveContent(args: { assetPath?: string, reference?: IInstanceReference, content: string }): Promise<{ reference: IInstanceReference, filesystemPath?: string }> {
        let url: string | null = null;
        if (args.reference?.id) {
            const info = await readBackAsset(args.reference.id, 'assetSaveContent.preflight');
            url = info.url ?? null;
        } else if (args.assetPath) url = normalizePath(args.assetPath);
        if (!url) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetSaveContent requires assetPath or reference.id.' });
        const saved = await Editor.Message.request('asset-db', 'save-asset', url, args.content ?? '');
        if (!saved?.uuid) throw new ToolError({ code: 'ASSET_OPERATION_FAILED', status: 502, message: `Failed to save content to ${url}.` });
        const readBack = await readBackAsset(saved.uuid, 'assetSaveContent');
        invalidateAfterWrite();
        return { reference: { id: readBack.uuid, type: readBack.type || saved.type || 'cc.Asset' }, filesystemPath: readBack.file || saved.file || undefined };
    }

    @utcpTool('assetGetAvailableUrl','Return a non-colliding db:// url for the given path (appends suffix if exists). Use before assetCreate.',{type:'object',properties:{assetPath:{type:'string'}},required:['assetPath']},{type:'object',properties:{url:{type:'string'}},required:['url']},"GET",['asset','available','url','collision','unique','name'])
    async assetGetAvailableUrl(args:{assetPath:string}):Promise<{url:string}> {
        if (!args.assetPath) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetGetAvailableUrl requires assetPath.' });
        const url = await Editor.Message.request('asset-db', 'generate-available-url', normalizePath(args.assetPath));
        if (typeof url !== 'string' || !url) throw new ToolError({ code: 'ASSET_QUERY_FAILED', status: 502, message: `Failed to generate available url for ${args.assetPath}.` });
        return { url };
    }


    @utcpTool('assetFindReferences', 'Find asset references. Defaults direction to used_by; pass depends_on for assets this asset references. Returns at most 200 results by default and 1,000 at most.', {
        type: 'object',
        properties: {
            direction: { type: 'string', enum: ['used_by', 'depends_on'], default: 'used_by' },
            reference: InstanceReferenceSchema,
            assetKind: { type: 'string', enum: ['asset', 'script', 'all'], default: 'all' },
            resolveUrls: { type: 'boolean', default: false },
            limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
        },
        required: ['reference'],
    }, {
        type: 'object',
        properties: {
            references: { type: 'array', items: InstanceReferenceSchema },
            assets: { type: 'array', items: { type: 'object', properties: { uuid: { type: 'string' }, url: { type: 'string' }, type: { type: 'string' } } } },
            total: { type: 'number' },
            truncated: { type: 'boolean' },
        },
        required: ['references', 'total', 'truncated'],
    }, "GET", ['asset', 'reference', 'dependency', 'used', 'usage', 'impact'])
    async assetFindReferences(args: { direction?: 'used_by' | 'depends_on', reference: IInstanceReference, assetKind?: 'asset' | 'script' | 'all', resolveUrls?: boolean, limit?: number }): Promise<{ references: IInstanceReference[], assets?: Array<{ uuid: string, url?: string, type?: string }>, total: number, truncated: boolean }> {
        if (!args || typeof args !== 'object' || !args.reference || typeof args.reference.id !== 'string' || !args.reference.id.trim() || args.reference.id.length > 256) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetFindReferences requires a non-empty reference.id of at most 256 characters.' });
        }
        const direction = args.direction ?? 'used_by';
        if (direction !== 'used_by' && direction !== 'depends_on') {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'direction must be used_by or depends_on.' });
        }
        const kind = args.assetKind ?? 'all';
        if (!['asset', 'script', 'all'].includes(kind)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetKind must be asset, script, or all.' });
        }
        if (args.resolveUrls !== undefined && typeof args.resolveUrls !== 'boolean') {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'resolveUrls must be a boolean.' });
        }
        const limit = args.limit === undefined ? 200 : args.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'limit must be an integer from 1 to 1000.' });
        }
        const candidates = direction === 'used_by'
            ? ['query-asset-users', 'query-asset-used']
            : ['query-asset-dependencies', 'query-asset-dependinces'];
        let raw: unknown;
        let lastError: unknown;
        for (const method of candidates) {
            try {
                raw = await Editor.Message.request('asset-db', method, args.reference.id, kind);
                lastError = undefined;
                break;
            } catch (error: unknown) {
                lastError = error;
            }
        }
        if (lastError) {
            const reason = lastError instanceof Error ? lastError.message : String(lastError);
            throw new ToolError({ code: 'ASSET_REFERENCE_QUERY_FAILED', status: 502, message: `Failed to query asset ${direction}.`, details: { cause: reason.slice(0, 512), direction, referenceId: args.reference.id } });
        }
        if (!Array.isArray(raw) || raw.length > 10000) {
            throw new ToolError({ code: 'INVALID_ASSET_REFERENCE_RESPONSE', status: 502, message: 'Creator returned an invalid or oversized asset reference list.', details: { maxEntries: 10000 } });
        }
        const uuids: string[] = [];
        for (const item of raw) {
            const uuid = typeof item === 'string' ? item : item && typeof item === 'object' ? Reflect.get(item, 'uuid') ?? Reflect.get(item, 'id') : undefined;
            if (typeof uuid !== 'string' || !uuid || uuid.length > 256) {
                throw new ToolError({ code: 'INVALID_ASSET_REFERENCE_RESPONSE', status: 502, message: 'Creator returned an asset reference without a bounded UUID.', details: { maxLength: 256 } });
            }
            uuids.push(uuid);
        }
        const total = uuids.length;
        const limitedUuids = uuids.slice(0, limit);
        const references = limitedUuids.map((id): IInstanceReference => ({ id }));
        const truncated = total > references.length;
        if (!args.resolveUrls) return { references, total, truncated };
        const assets: Array<{ uuid: string, url?: string, type?: string }> = [];
        for (const uuid of limitedUuids) {
            const info: AssetInfo | null = await Editor.Message.request('asset-db', 'query-asset-info', uuid);
            assets.push({ uuid, url: typeof info?.url === 'string' ? info.url : undefined, type: typeof info?.type === 'string' ? info.type : undefined });
        }
        return { references, assets, total, truncated };
    }

    @utcpTool('assetQuery', 'Search asset database by name, glob, ccType, importer, extname or isBundle. At least one filter is required. Returns at most 200 results by default and 1,000 at most.', {
        type: 'object',
        properties: {
            name: { type: 'string', minLength: 1, maxLength: 256 },
            pattern: { type: 'string' },
            ccType: { type: 'string' },
            importer: { type: 'string' },
            extname: { type: 'string' },
            isBundle: { type: 'boolean' },
            limit: { type: 'number', minimum: 1, maximum: 1000, default: 200 },
        },
        anyOf: [
            { required: ['name'] },
            { required: ['pattern'] },
            { required: ['ccType'] },
            { required: ['importer'] },
            { required: ['extname'] },
            { required: ['isBundle'] },
        ],
    }, {
        type: 'object',
        properties: {
            assets: { type: 'array', items: { type: 'object', properties: { uuid: { type: 'string' }, name: { type: 'string' }, url: { type: 'string' }, type: { type: 'string' }, importer: { type: 'string' }, isDirectory: { type: 'boolean' } } } },
            total: { type: 'number' },
            truncated: { type: 'boolean' },
        },
        required: ['assets', 'total', 'truncated'],
    }, "GET", ['asset', 'query', 'search', 'find', 'filter', 'list', 'discover', 'bundle', 'spine', 'prefab', 'name'])
    async assetQuery(args: { name?: string, pattern?: string, ccType?: string, importer?: string, extname?: string, isBundle?: boolean, limit?: number }): Promise<{ assets: { uuid: string, name: string, url: string, type: string, importer?: string, isDirectory: boolean }[], total: number, truncated: boolean }> {
        const opts: { name?: string, pattern?: string, ccType?: string, importer?: string, extname?: string, isBundle?: boolean } = {};
        if (args.name) opts.name = args.name;
        if (args.pattern) opts.pattern = normalizePath(args.pattern);
        if (args.ccType) opts.ccType = args.ccType;
        if (args.importer) opts.importer = args.importer;
        if (args.extname) opts.extname = args.extname;
        if (args.isBundle !== undefined) opts.isBundle = args.isBundle;
        if (Object.keys(opts).length === 0) throw new Error('assetQuery requires at least one filter');
        const raw = await queryAssetsCompat(opts) as Array<{ uuid: string, name: string, url: string, type: string, importer?: string, isDirectory?: boolean, isBundle?: boolean }>;
        const filtered = raw.filter((asset) => {
            if (opts.name && asset.name !== opts.name) return false;
            if (opts.ccType && asset.type !== opts.ccType) return false;
            if (opts.importer && asset.importer !== opts.importer) return false;
            if (opts.extname && extname(asset.url || asset.name || '') !== opts.extname) return false;
            if (opts.isBundle !== undefined && !!asset.isBundle !== opts.isBundle) return false;
            return true;
        });
        const limit = boundedPositive(args.limit, 200, 1000);
        const assets = filtered.slice(0, limit).map((asset) => ({ uuid: asset.uuid, name: asset.name, url: asset.url, type: asset.isDirectory ? 'folder' : asset.type, importer: asset.importer, isDirectory: !!asset.isDirectory }));
        return { assets, total: filtered.length, truncated: filtered.length > assets.length };
    }

    @utcpTool('assetInspect', 'Inspect authoritative asset identity, importer metadata, and bounded serialized data by UUID or db:// path.', {
        type: 'object',
        additionalProperties: false,
        properties: {
            reference: InstanceReferenceSchema,
            assetPath: { type: 'string', maxLength: MAX_MANIFEST_ASSET_PATH_LENGTH },
            maxDataBytes: { type: 'integer', minimum: 1, maximum: 1048576, default: 524288 },
        },
        anyOf: [{ required: ['reference'] }, { required: ['assetPath'] }],
    }, {
        type: 'object',
        additionalProperties: false,
        properties: {
            uuid: { type: 'string' },
            url: { type: 'string' },
            type: { type: 'string' },
            file: { type: 'string' },
            isDirectory: { type: 'boolean' },
            importer: { type: 'string' },
            meta: {},
            data: {},
            dataBytes: { type: 'integer' },
            dataTruncated: { type: 'boolean' },
        },
        required: ['uuid', 'url', 'type', 'file', 'isDirectory', 'meta', 'data', 'dataBytes', 'dataTruncated'],
    }, 'GET', ['asset', 'inspect', 'details', 'info', 'metadata', 'data'])
    async assetInspect(args: { reference?: IInstanceReference, assetPath?: string, maxDataBytes?: number }): Promise<Record<string, unknown>> {
        const identifier = args.reference?.id || (args.assetPath ? normalizeBoundedAssetPath(args.assetPath, 'assetInspect') : '');
        if (!identifier) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetInspect requires reference.id or assetPath.' });
        const info = await readBackAsset(identifier, 'assetInspect');
        const meta = await Editor.Message.request('asset-db', 'query-asset-meta', info.uuid).catch(() => null);
        const rawData = await Editor.Message.request('asset-db', 'query-asset-data', info.uuid).catch(() => null);
        let serializedData: string;
        try { serializedData = JSON.stringify(rawData ?? null); }
        catch { throw new ToolError({ code: 'ASSET_DATA_UNSERIALIZABLE', status: 502, message: 'Asset data could not be serialized within the bounded inspection contract.' }); }
        const maxDataBytes = typeof args.maxDataBytes === 'number' && Number.isInteger(args.maxDataBytes) && args.maxDataBytes > 0
            ? Math.min(args.maxDataBytes, 1048576)
            : 524288;
        const dataBytes = Buffer.byteLength(serializedData, 'utf8');
        const dataTruncated = dataBytes > maxDataBytes;
        const data = dataTruncated ? boundedUtf8Preview(serializedData, maxDataBytes) : rawData;
        return {
            uuid: info.uuid,
            url: typeof info.url === 'string' ? info.url : '',
            type: typeof info.type === 'string' ? info.type : '',
            file: typeof info.file === 'string' ? info.file : '',
            isDirectory: info.isDirectory === true,
            importer: typeof info.importer === 'string' ? info.importer : '',
            meta: meta ?? null,
            data,
            dataBytes,
            dataTruncated,
        };
    }

    @utcpTool('scriptAssetInspect', 'Inspect one imported TypeScript or JavaScript asset with stable class identity, source size, and bounded dependency references.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, maxDependencies: { type: 'integer', minimum: 1, maximum: 128, default: 64 } }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, className: { type: ['string', 'null'] }, classId: { type: ['string', 'null'] }, url: { type: 'string' }, importer: { type: 'string' }, bytes: { type: 'integer' }, dependencies: { type: 'array' }, totalDependencies: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['reference', 'className', 'classId', 'url', 'importer', 'bytes', 'dependencies', 'totalDependencies', 'truncated'] }, 'GET', ['script', 'asset', 'typescript', 'javascript', 'inspect'])
    async scriptAssetInspect(args: { reference: IInstanceReference, maxDependencies?: number }): Promise<Record<string, unknown>> {
        const info = await readBackAsset(args.reference.id, 'scriptAssetInspect');
        if (!['typescript', 'javascript'].includes(String(info.importer ?? '')) && !/\.(?:ts|js)$/i.test(String(info.url ?? ''))) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Asset ${args.reference.id} is not an imported script.` });
        const maxDependencies = args.maxDependencies ?? 64;
        if (!Number.isInteger(maxDependencies) || maxDependencies < 1 || maxDependencies > 128) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxDependencies must be an integer from 1 to 128.' });
        const [className, classId, dependencies] = await Promise.all([
            Editor.Message.request('scene', 'query-script-name', info.uuid).catch(() => null),
            Editor.Message.request('scene', 'query-script-cid', info.uuid).catch(() => null),
            Editor.Message.request('asset-db', 'query-asset-dependencies', info.uuid).catch(() => []),
        ]);
        const rows = Array.isArray(dependencies) ? dependencies.filter((value): value is string => typeof value === 'string') : [];
        let bytes = 0;
        if (typeof info.file === 'string' && info.file) bytes = (await fs.stat(info.file).catch(() => null))?.size ?? 0;
        return { reference: { id: info.uuid, type: info.type || 'cc.Script' }, className: typeof className === 'string' ? className : null, classId: typeof classId === 'string' ? classId : null, url: info.url || '', importer: info.importer || '', bytes, dependencies: rows.slice(0, maxDependencies), totalDependencies: rows.length, truncated: rows.length > maxDependencies };
    }
    @utcpTool('scriptAssetValidate', 'Validate imported script class identity and bounded dependency metadata.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { valid: { type: 'boolean' }, reference: InstanceReferenceSchema, issues: { type: 'array' }, className: { type: ['string', 'null'] }, classId: { type: ['string', 'null'] } }, required: ['valid', 'reference', 'issues', 'className', 'classId'] }, 'GET', ['script', 'asset', 'validate', 'class'])
    async scriptAssetValidate(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        const inspected = await this.scriptAssetInspect({ reference: args.reference, maxDependencies: 128 });
        const issues: Array<Record<string, unknown>> = [];
        if (!inspected.className) issues.push({ code: 'SCRIPT_NAME_UNAVAILABLE' });
        if (!inspected.classId) issues.push({ code: 'SCRIPT_CLASS_ID_UNAVAILABLE' });
        return { valid: issues.length === 0, reference: inspected.reference, issues, className: inspected.className, classId: inspected.classId };
    }
    @utcpTool('scriptDependencyImpactInspect', 'Inspect bounded script dependencies and reverse users with optional asset identity read-back.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 }, resolveAssets: { type: 'boolean', default: true } }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, dependencies: { type: 'object' }, users: { type: 'object' } }, required: ['reference', 'dependencies', 'users'] }, 'GET', ['script', 'dependency', 'impact', 'usage'])
    async scriptDependencyImpactInspect(args: { reference: IInstanceReference, limit?: number, resolveAssets?: boolean }): Promise<Record<string, unknown>> {
        await this.scriptAssetInspect({ reference: args.reference, maxDependencies: 1 });
        const [dependencies, users] = await Promise.all([
            this.assetFindReferences({ direction: 'depends_on', reference: args.reference, assetKind: 'all', resolveUrls: args.resolveAssets !== false, limit: args.limit }),
            this.assetFindReferences({ direction: 'used_by', reference: args.reference, assetKind: 'all', resolveUrls: args.resolveAssets !== false, limit: args.limit }),
        ]);
        return { reference: args.reference, dependencies, users };
    }



    @utcpTool('scriptDependencyImpactBatchInspect', 'Inspect bounded dependency and reverse-user impact for multiple imported scripts.', { type: 'object', additionalProperties: false, properties: { references: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema }, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 }, resolveAssets: { type: 'boolean', default: true } }, required: ['references'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated'] }, 'GET', ['script', 'dependency', 'impact', 'batch'])
    async scriptDependencyImpactBatchInspect(args: { references: IInstanceReference[], limit?: number, resolveAssets?: boolean }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.references) || args.references.length < 1 || args.references.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references must contain 1 to 32 items.' });
        const items: Array<Record<string, unknown>> = [];
        for (const [index, reference] of args.references.entries()) {
            try {
                items.push({ index, ok: true, result: await this.scriptDependencyImpactInspect({ reference, limit: args.limit, resolveAssets: args.resolveAssets }) });
            } catch (error) {
                items.push({ index, ok: false, reference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        const truncated = items.some((item) => item.ok === true && (((item.result as any)?.dependencies?.truncated === true) || ((item.result as any)?.users?.truncated === true)));
        return { items, succeeded, failed: items.length - succeeded, truncated };
    }

    @utcpTool('spriteFrameInspect', 'Inspect a SpriteFrame sub-asset and its source image identity with bounded importer metadata.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, sourceReference: InstanceReferenceSchema, url: { type: 'string' }, importer: { type: 'string' }, metadata: {} }, required: ['reference', 'sourceReference', 'url', 'importer', 'metadata'] }, 'GET', ['sprite', 'frame', 'image', 'inspect'])
    async spriteFrameInspect(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        const info = await readBackAsset(args.reference.id, 'spriteFrameInspect');
        if (info.importer !== 'sprite-frame' && info.type !== 'cc.SpriteFrame' && !args.reference.id.includes('@')) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Asset ${args.reference.id} is not a SpriteFrame sub-asset.` });
        const sourceId = args.reference.id.includes('@') ? args.reference.id.slice(0, args.reference.id.indexOf('@')) : info.uuid;
        const source = await readBackAsset(sourceId, 'spriteFrameInspect.source');
        const meta = await Editor.Message.request('asset-db', 'query-asset-meta', source.uuid).catch(() => null);
        return { reference: { id: info.uuid, type: info.type || 'cc.SpriteFrame' }, sourceReference: { id: source.uuid, type: source.type || 'cc.ImageAsset' }, url: info.url || '', importer: info.importer || 'sprite-frame', metadata: meta?.subMetas ?? meta?.userData ?? meta ?? null };
    }
    @utcpTool('spriteFrameGeometryInspect', 'Inspect bounded SpriteFrame geometry metadata normalized from Creator importer sub-meta records.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, sourceReference: InstanceReferenceSchema, url: { type: 'string' }, geometry: { type: 'object' }, metadataAvailable: { type: 'boolean' } }, required: ['reference', 'sourceReference', 'url', 'geometry', 'metadataAvailable'] }, 'GET', ['sprite', 'frame', 'geometry', 'inspect'])
    async spriteFrameGeometryInspect(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        const inspected = await this.spriteFrameInspect(args);
        const metadata = inspected.metadata && typeof inspected.metadata === 'object' ? inspected.metadata as Record<string, unknown> : {};
        const source = metadata.frame && typeof metadata.frame === 'object' ? metadata.frame as Record<string, unknown> : metadata;
        const userData = source.userData && typeof source.userData === 'object' ? source.userData as Record<string, unknown> : source;
        const number = (key: string): number | null => typeof userData[key] === 'number' && Number.isFinite(userData[key]) ? userData[key] as number : null;
        const boolean = (key: string): boolean | null => typeof userData[key] === 'boolean' ? userData[key] as boolean : null;
        const geometry = { rect: { x: number('x'), y: number('y'), width: number('width'), height: number('height') }, originalSize: { width: number('originalWidth') ?? number('width'), height: number('originalHeight') ?? number('height') }, offset: { x: number('offsetX'), y: number('offsetY') }, borders: { left: number('borderLeft'), right: number('borderRight'), top: number('borderTop'), bottom: number('borderBottom') }, rotated: boolean('rotated'), trimmed: boolean('trimmed') };
        return { reference: inspected.reference, sourceReference: inspected.sourceReference, url: inspected.url, geometry, metadataAvailable: Object.keys(userData).length > 0 };
    }

    @utcpTool('spriteFrameValidate', 'Validate SpriteFrame source identity and importer metadata without mutating the asset.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { valid: { type: 'boolean' }, reference: InstanceReferenceSchema, sourceReference: InstanceReferenceSchema, issues: { type: 'array' } }, required: ['valid', 'reference', 'sourceReference', 'issues'] }, 'GET', ['sprite', 'frame', 'validate', 'image'])
    async spriteFrameValidate(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        const inspected = await this.spriteFrameInspect(args);
        const issues: Array<Record<string, unknown>> = [];
        if (!inspected.url) issues.push({ code: 'SPRITE_FRAME_URL_UNAVAILABLE' });
        if (!inspected.metadata) issues.push({ code: 'SPRITE_FRAME_METADATA_UNAVAILABLE' });
        return { valid: issues.length === 0, reference: inspected.reference, sourceReference: inspected.sourceReference, issues };
    }


    @utcpTool('imageAssetInspect', 'Inspect one imported image asset with typed importer settings and SpriteFrame sub-assets.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, maxFrames: { type: 'integer', minimum: 1, maximum: 256, default: 128 } }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, importer: { type: 'string' }, settings: { type: 'object' }, schema: { type: 'object' }, spriteFrames: { type: 'array' }, totalSpriteFrames: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['reference', 'importer', 'settings', 'schema', 'spriteFrames', 'totalSpriteFrames', 'truncated'] }, 'GET', ['asset', 'image', 'texture', 'sprite', 'inspect'])
    async imageAssetInspect(args: { reference: IInstanceReference, maxFrames?: number }): Promise<Record<string, unknown>> {
        const info = await readBackAsset(args.reference.id, 'imageAssetInspect');
        if (!['image', 'texture'].includes(String(info.importer ?? '')) && !['cc.ImageAsset', 'cc.Texture2D'].includes(String(info.type ?? ''))) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Asset ${args.reference.id} is not an imported image.` });
        const maxFrames = args.maxFrames ?? 128;
        if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxFrames must be an integer from 1 to 256.' });
        const imported = await this.assetImportSettingsGet({ reference: args.reference });
        const frames = Object.values(info.subAssets ?? {}).filter((frame: any) => frame?.importer === 'sprite-frame' || frame?.type === 'cc.SpriteFrame');
        return { reference: imported.reference, importer: imported.importer, settings: imported.settings, schema: imported.schema, spriteFrames: frames.slice(0, maxFrames).map((frame: any) => ({ id: frame.uuid, type: frame.type ?? 'cc.SpriteFrame', url: frame.url ?? null, name: frame.name ?? null })), totalSpriteFrames: frames.length, truncated: frames.length > maxFrames };
    }
    @utcpTool('imageSourceMetadataInspect', 'Inspect bounded source-file image dimensions, format, alpha, orientation, and density metadata.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, source: { type: 'object' }, width: { type: ['integer', 'null'] }, height: { type: ['integer', 'null'] }, format: { type: ['string', 'null'] }, space: { type: ['string', 'null'] }, channels: { type: ['integer', 'null'] }, hasAlpha: { type: ['boolean', 'null'] }, orientation: { type: ['integer', 'null'] }, density: { type: ['number', 'null'] }, pages: { type: ['integer', 'null'] } }, required: ['reference', 'source', 'width', 'height', 'format', 'space', 'channels', 'hasAlpha', 'orientation', 'density', 'pages'] }, 'GET', ['asset', 'image', 'source', 'metadata', 'dimensions'])
    async imageSourceMetadataInspect(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        const info = await readBackAsset(args.reference.id, 'imageSourceMetadataInspect');
        if (!['image', 'texture'].includes(String(info.importer ?? '')) && !['cc.ImageAsset', 'cc.Texture2D'].includes(String(info.type ?? ''))) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Asset ${args.reference.id} is not an imported image.` });
        if (typeof info.file !== 'string' || !info.file) throw new ToolError({ code: 'SOURCE_UNAVAILABLE', status: 422, message: `Image source is unavailable for ${args.reference.id}.` });
        const filePath = enforceProjectFilePath(info.file, 'imageSourceMetadataInspect');
        if (!await fs.pathExists(filePath)) throw new ToolError({ code: 'SOURCE_UNAVAILABLE', status: 422, message: `Image source is unavailable for ${args.reference.id}.` });
        let metadata: any;
        try { metadata = await require('sharp')(filePath).metadata(); }
        catch (error) { throw new ToolError({ code: 'IMAGE_METADATA_FAILED', status: 502, message: 'Image source metadata could not be decoded.', details: { cause: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } }); }
        const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
        return { reference: { id: info.uuid, type: info.type || 'cc.ImageAsset' }, source: { url: info.url || null, bytes: (await fs.stat(filePath)).size }, width: Number.isInteger(metadata.width) ? metadata.width : null, height: Number.isInteger(metadata.height) ? metadata.height : null, format: typeof metadata.format === 'string' ? metadata.format : null, space: typeof metadata.space === 'string' ? metadata.space : null, channels: Number.isInteger(metadata.channels) ? metadata.channels : null, hasAlpha: typeof metadata.hasAlpha === 'boolean' ? metadata.hasAlpha : null, orientation: Number.isInteger(metadata.orientation) ? metadata.orientation : null, density: finite(metadata.density), pages: Number.isInteger(metadata.pages) ? metadata.pages : null };
    }
    @utcpTool('imageSourceMetadataValidate', 'Validate bounded source-file image metadata against optional dimensions, format, alpha, orientation, density, and page constraints.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, formats: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', maxLength: 32 } }, hasAlpha: { type: 'boolean' }, orientation: { type: 'integer', minimum: 1, maximum: 8 }, minDensity: { type: 'number', minimum: 0 }, maxDensity: { type: 'number', minimum: 0 }, pages: { type: 'integer', minimum: 1 } }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { valid: { type: 'boolean' }, reference: InstanceReferenceSchema, metadata: { type: 'object' }, issues: { type: 'array' } }, required: ['valid', 'reference', 'metadata', 'issues'] }, 'GET', ['asset', 'image', 'source', 'metadata', 'validate'])
    async imageSourceMetadataValidate(args: { reference: IInstanceReference, width?: number, height?: number, formats?: string[], hasAlpha?: boolean, orientation?: number, minDensity?: number, maxDensity?: number, pages?: number }): Promise<Record<string, unknown>> {
        if (args.minDensity !== undefined && args.maxDensity !== undefined && args.minDensity > args.maxDensity) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'minDensity must not exceed maxDensity.' });
        if (args.formats !== undefined && (!Array.isArray(args.formats) || args.formats.length < 1 || args.formats.length > 16 || args.formats.some((format) => typeof format !== 'string' || !format.trim() || format.length > 32))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'formats must contain 1 to 16 non-empty strings of at most 32 characters.' });
        const metadata = await this.imageSourceMetadataInspect({ reference: args.reference });
        const issues: Array<Record<string, unknown>> = [];
        if (args.width !== undefined && metadata.width !== args.width) issues.push({ code: 'IMAGE_WIDTH_MISMATCH', expected: args.width, actual: metadata.width });
        if (args.height !== undefined && metadata.height !== args.height) issues.push({ code: 'IMAGE_HEIGHT_MISMATCH', expected: args.height, actual: metadata.height });
        if (args.formats !== undefined && (typeof metadata.format !== 'string' || !args.formats.includes(metadata.format))) issues.push({ code: 'IMAGE_FORMAT_MISMATCH', expected: args.formats, actual: metadata.format });
        if (args.hasAlpha !== undefined && metadata.hasAlpha !== args.hasAlpha) issues.push({ code: 'IMAGE_ALPHA_MISMATCH', expected: args.hasAlpha, actual: metadata.hasAlpha });
        if (args.orientation !== undefined && metadata.orientation !== args.orientation) issues.push({ code: 'IMAGE_ORIENTATION_MISMATCH', expected: args.orientation, actual: metadata.orientation });
        if (args.minDensity !== undefined && (typeof metadata.density !== 'number' || metadata.density < args.minDensity)) issues.push({ code: 'IMAGE_DENSITY_BELOW_MINIMUM', expected: args.minDensity, actual: metadata.density });
        if (args.maxDensity !== undefined && (typeof metadata.density !== 'number' || metadata.density > args.maxDensity)) issues.push({ code: 'IMAGE_DENSITY_ABOVE_MAXIMUM', expected: args.maxDensity, actual: metadata.density });
        if (args.pages !== undefined && metadata.pages !== args.pages) issues.push({ code: 'IMAGE_PAGE_COUNT_MISMATCH', expected: args.pages, actual: metadata.pages });
        return { valid: issues.length === 0, reference: metadata.reference, metadata, issues };
    }
    @utcpTool('imageSourceMetadataBatchValidate', 'Validate bounded source-file image metadata for multiple imported images with per-item constraints and errors.', { type: 'object', additionalProperties: false, properties: { items: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, formats: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', maxLength: 32 } }, hasAlpha: { type: 'boolean' }, orientation: { type: 'integer', minimum: 1, maximum: 8 }, minDensity: { type: 'number', minimum: 0 }, maxDensity: { type: 'number', minimum: 0 }, pages: { type: 'integer', minimum: 1 } }, required: ['reference'] } } }, required: ['items'] }, { type: 'object', additionalProperties: false, properties: { outcomes: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, invalid: { type: 'integer' }, partial: { type: 'boolean' } }, required: ['outcomes', 'succeeded', 'failed', 'invalid', 'partial'] }, 'GET', ['asset', 'image', 'source', 'metadata', 'batch', 'validate'])
    async imageSourceMetadataBatchValidate(args: { items: Array<{ reference: IInstanceReference, width?: number, height?: number, formats?: string[], hasAlpha?: boolean, orientation?: number, minDensity?: number, maxDensity?: number, pages?: number }> }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.items) || args.items.length < 1 || args.items.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'items must contain 1 to 32 image metadata validation requests.' });
        const outcomes: Array<Record<string, unknown>> = [];
        for (const [index, item] of args.items.entries()) {
            try { outcomes.push({ index, ok: true, result: await this.imageSourceMetadataValidate(item) }); }
            catch (error) { outcomes.push({ index, ok: false, reference: item.reference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } }); }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        const invalid = outcomes.filter((outcome) => outcome.ok === true && (outcome.result as Record<string, unknown>)?.valid === false).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, invalid, partial: succeeded > 0 && succeeded < outcomes.length };
    }

    @utcpTool('imageSourceMetadataBatchInspect', 'Inspect source-file metadata for a bounded batch of imported images with per-item errors.', { type: 'object', additionalProperties: false, properties: { references: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema } }, required: ['references'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' } }, required: ['items', 'succeeded', 'failed'] }, 'GET', ['asset', 'image', 'source', 'metadata', 'batch'])
    async imageSourceMetadataBatchInspect(args: { references: IInstanceReference[] }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.references) || args.references.length < 1 || args.references.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references must contain 1 to 32 items.' });
        const items: Array<Record<string, unknown>> = [];
        for (const [index, reference] of args.references.entries()) {
            try { items.push({ index, ok: true, result: await this.imageSourceMetadataInspect({ reference }) }); }
            catch (error) { items.push({ index, ok: false, reference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } }); }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        return { items, succeeded, failed: items.length - succeeded };
    }

    @utcpTool('imageAssetValidate', 'Validate imported image settings and SpriteFrame outputs without mutating the asset.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { valid: { type: 'boolean' }, reference: InstanceReferenceSchema, issues: { type: 'array' }, spriteFrameCount: { type: 'integer' } }, required: ['valid', 'reference', 'issues', 'spriteFrameCount'] }, 'GET', ['asset', 'image', 'texture', 'validate'])
    async imageAssetValidate(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        const inspected = await this.imageAssetInspect({ reference: args.reference, maxFrames: 256 });
        const issues: Array<Record<string, unknown>> = [];
        if (!inspected.schema || typeof inspected.schema !== 'object') issues.push({ code: 'IMAGE_IMPORTER_SCHEMA_UNAVAILABLE' });
        return { valid: issues.length === 0, reference: inspected.reference, issues, spriteFrameCount: inspected.totalSpriteFrames };
    }
    @utcpTool('imageDependencyImpactInspect', 'Inspect bounded image dependencies, reverse users, and SpriteFrame outputs with optional asset identity read-back.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 }, maxFrames: { type: 'integer', minimum: 1, maximum: 256, default: 128 }, resolveAssets: { type: 'boolean', default: true } }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, spriteFrames: { type: 'array' }, totalSpriteFrames: { type: 'integer' }, dependencies: { type: 'object' }, users: { type: 'object' } }, required: ['reference', 'spriteFrames', 'totalSpriteFrames', 'dependencies', 'users'] }, 'GET', ['asset', 'image', 'texture', 'dependency', 'impact'])
    async imageDependencyImpactInspect(args: { reference: IInstanceReference, limit?: number, maxFrames?: number, resolveAssets?: boolean }): Promise<Record<string, unknown>> {
        const image = await this.imageAssetInspect({ reference: args.reference, maxFrames: args.maxFrames });
        const [dependencies, users] = await Promise.all([
            this.assetFindReferences({ direction: 'depends_on', reference: args.reference, assetKind: 'all', resolveUrls: args.resolveAssets !== false, limit: args.limit }),
            this.assetFindReferences({ direction: 'used_by', reference: args.reference, assetKind: 'all', resolveUrls: args.resolveAssets !== false, limit: args.limit }),
        ]);
        return { reference: image.reference, spriteFrames: image.spriteFrames, totalSpriteFrames: image.totalSpriteFrames, dependencies, users };
    }

    @utcpTool('scriptDependencyImpactValidate', 'Validate bounded script dependency and reverse-user query result shapes.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { valid: { type: 'boolean' }, reference: InstanceReferenceSchema, issues: { type: 'array' } }, required: ['valid', 'reference', 'issues'] }, 'GET', ['script', 'dependency', 'impact', 'validate'])
    async scriptDependencyImpactValidate(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        const inspected = await this.scriptDependencyImpactInspect({ reference: args.reference, limit: 1000, resolveAssets: true });
        const issues: Array<Record<string, unknown>> = [];
        for (const direction of ['dependencies', 'users']) {
            const result = inspected[direction] as Record<string, unknown>;
            if (!result || !Array.isArray(result.references) || typeof result.total !== 'number' || typeof result.truncated !== 'boolean') issues.push({ code: 'IMPACT_RESULT_MALFORMED', direction });
        }
        return { valid: issues.length === 0, reference: args.reference, issues };
    }


    @utcpTool('imageAssetBatchValidate', 'Validate a bounded batch of imported images with per-item importer and SpriteFrame outcomes.', { type: 'object', additionalProperties: false, properties: { references: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema } }, required: ['references'] }, { type: 'object', additionalProperties: false, properties: { outcomes: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, invalid: { type: 'integer' }, partial: { type: 'boolean' } }, required: ['outcomes', 'succeeded', 'failed', 'invalid', 'partial'] }, 'GET', ['asset', 'image', 'texture', 'batch', 'validate'])
    async imageAssetBatchValidate(args: { references: IInstanceReference[] }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.references) || args.references.length < 1 || args.references.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references must contain 1 to 32 items.' });
        const outcomes: Array<Record<string, unknown>> = [];
        for (const [index, reference] of args.references.entries()) {
            try {
                outcomes.push({ index, ok: true, result: await this.imageAssetValidate({ reference }) });
            } catch (error) {
                outcomes.push({ index, ok: false, reference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        const invalid = outcomes.filter((outcome) => outcome.ok === true && (outcome.result as Record<string, unknown>)?.valid === false).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, invalid, partial: succeeded > 0 && succeeded < outcomes.length };
    }

    @utcpTool('spriteFrameBatchValidate', 'Validate a bounded batch of SpriteFrame source identities and importer metadata.', { type: 'object', additionalProperties: false, properties: { references: { type: 'array', minItems: 1, maxItems: 64, items: InstanceReferenceSchema } }, required: ['references'] }, { type: 'object', additionalProperties: false, properties: { outcomes: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, invalid: { type: 'integer' }, partial: { type: 'boolean' } }, required: ['outcomes', 'succeeded', 'failed', 'invalid', 'partial'] }, 'GET', ['asset', 'sprite', 'frame', 'batch', 'validate'])
    async spriteFrameBatchValidate(args: { references: IInstanceReference[] }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.references) || args.references.length < 1 || args.references.length > 64) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references must contain 1 to 64 items.' });
        const outcomes: Array<Record<string, unknown>> = [];
        for (const [index, reference] of args.references.entries()) {
            try {
                outcomes.push({ index, ok: true, result: await this.spriteFrameValidate({ reference }) });
            } catch (error) {
                outcomes.push({ index, ok: false, reference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        const invalid = outcomes.filter((outcome) => outcome.ok === true && (outcome.result as Record<string, unknown>)?.valid === false).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, invalid, partial: succeeded > 0 && succeeded < outcomes.length };
    }

    @utcpTool('spriteFrameBatchInspect', 'Inspect a bounded batch of SpriteFrame sub-assets with source identity and per-item errors.', { type: 'object', additionalProperties: false, properties: { references: { type: 'array', minItems: 1, maxItems: 64, items: InstanceReferenceSchema } }, required: ['references'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated'] }, 'GET', ['asset', 'sprite', 'frame', 'batch', 'inspect'])
    async spriteFrameBatchInspect(args: { references: IInstanceReference[] }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.references) || args.references.length < 1 || args.references.length > 64) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references must contain 1 to 64 items.' });
        const items: Array<Record<string, unknown>> = [];
        for (const [index, reference] of args.references.entries()) {
            try {
                items.push({ index, ok: true, result: await this.spriteFrameInspect({ reference }) });
            } catch (error) {
                items.push({ index, ok: false, reference, error: { message: error instanceof Error ? error.message : String(error) } });
            }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        return { items, succeeded, failed: items.length - succeeded, truncated: false };
    }

    @utcpTool('imageAssetBatchInspect', 'Inspect a bounded batch of imported image assets with SpriteFrame inventories and per-item errors.', { type: 'object', additionalProperties: false, properties: { references: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema }, maxFrames: { type: 'integer', minimum: 1, maximum: 256, default: 128 } }, required: ['references'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated'] }, 'GET', ['asset', 'image', 'texture', 'batch', 'inspect'])
    async imageAssetBatchInspect(args: { references: IInstanceReference[], maxFrames?: number }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.references) || args.references.length < 1 || args.references.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references must contain 1 to 32 items.' });
        const maxFrames = args.maxFrames ?? 128;
        if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxFrames must be an integer from 1 to 256.' });
        const items: Array<Record<string, unknown>> = [];
        for (const [index, reference] of args.references.entries()) {
            try {
                items.push({ index, ok: true, result: await this.imageAssetInspect({ reference, maxFrames }) });
            } catch (error) {
                items.push({ index, ok: false, reference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        return { items, succeeded, failed: items.length - succeeded, truncated: false };
    }
    @utcpTool('scriptAssetBatchInspect', 'Inspect a bounded batch of imported scripts with class identity and dependency summaries.', { type: 'object', additionalProperties: false, properties: { references: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema }, maxDependencies: { type: 'integer', minimum: 1, maximum: 128, default: 64 } }, required: ['references'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated'] }, 'GET', ['script', 'asset', 'batch', 'inspect'])
    async scriptAssetBatchInspect(args: { references: IInstanceReference[], maxDependencies?: number }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.references) || args.references.length < 1 || args.references.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references must contain 1 to 32 items.' });
        const maxDependencies = args.maxDependencies ?? 64;
        if (!Number.isInteger(maxDependencies) || maxDependencies < 1 || maxDependencies > 128) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxDependencies must be an integer from 1 to 128.' });
        const items: Array<Record<string, unknown>> = [];
        for (const [index, reference] of args.references.entries()) {
            try {
                items.push({ index, ok: true, result: await this.scriptAssetInspect({ reference, maxDependencies }) });
            } catch (error) {
                items.push({ index, ok: false, reference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        return { items, succeeded, failed: items.length - succeeded, truncated: false };
    }

    @utcpTool('scriptAssetBatchValidate', 'Validate a bounded batch of imported script class identities and dependency metadata.', { type: 'object', additionalProperties: false, properties: { references: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema } }, required: ['references'] }, { type: 'object', additionalProperties: false, properties: { outcomes: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, invalid: { type: 'integer' }, partial: { type: 'boolean' } }, required: ['outcomes', 'succeeded', 'failed', 'invalid', 'partial'] }, 'GET', ['script', 'asset', 'batch', 'validate'])
    async scriptAssetBatchValidate(args: { references: IInstanceReference[] }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.references) || args.references.length < 1 || args.references.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references must contain 1 to 32 items.' });
        const outcomes: Array<Record<string, unknown>> = [];
        for (const [index, reference] of args.references.entries()) {
            try {
                outcomes.push({ index, ok: true, result: await this.scriptAssetValidate({ reference }) });
            } catch (error) {
                outcomes.push({ index, ok: false, reference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        const invalid = outcomes.filter((outcome) => outcome.ok === true && (outcome.result as Record<string, unknown>)?.valid === false).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, invalid, partial: succeeded > 0 && succeeded < outcomes.length };
    }

    @utcpTool('assetCreate','Create an asset or folder at a db:// path from a Creator 3.7 preset.',{type:'object',properties:{assetPath:{type:'string'},preset:{type:'string',enum:['folder','material','effect','scene','prefab','typescript','animation-clip','render-texture','physics-material','animation-graph','animation-graph-variant','animation-mask','auto-atlas','effect-header','terrain']},options:{type:'object',properties:{overwrite:{type:'boolean'},rename:{type:'boolean'}},nullable:true}},required:['assetPath','preset']},{type:'object',properties:{reference:InstanceReferenceSchema},required:['reference']},"POST",['asset','create','new','preset','folder','typescript'])
    async assetCreate(args:{assetPath:string;preset:string;options?:{overwrite?:boolean,rename?:boolean}}):Promise<{reference:IInstanceReference}> {
        let targetPath = normalizePath(args.assetPath);
        const type = args.preset;
        const presetMap: Record<string, { source: string, extension: string }> = {
            material: { source: 'db://internal/default_file_content/material/default.mtl', extension: '.mtl' },
            effect: { source: 'db://internal/default_file_content/effect/default.effect', extension: '.effect' },
            scene: { source: 'db://internal/default_file_content/scene/default.scene', extension: '.scene' },
            prefab: { source: 'db://internal/default_file_content/prefab/default.prefab', extension: '.prefab' },
            'animation-clip': { source: 'db://internal/default_file_content/animation-clip/default.anim', extension: '.anim' },
            'render-texture': { source: 'db://internal/default_file_content/render-texture/default.rt', extension: '.rt' },
            'physics-material': { source: 'db://internal/default_file_content/physics-material/default.pmtl', extension: '.pmtl' },
            'animation-graph': { source: 'db://internal/default_file_content/animation-graph/default.animgraph', extension: '.animgraph' },
            'animation-graph-variant': { source: 'db://internal/default_file_content/animation-graph-variant/default.animgraph', extension: '.animgraph' },
            'animation-mask': { source: 'db://internal/default_file_content/animation-mask/default.mask', extension: '.mask' },
            'auto-atlas': { source: 'db://internal/default_file_content/auto-atlas/default.pac', extension: '.pac' },
            'effect-header': { source: 'db://internal/default_file_content/effect-header/default.effect', extension: '.effect' },
            terrain: { source: 'db://internal/default_file_content/terrain/default.terrain', extension: '.terrain' },
        };
        const assetOptions: AssetOperationOption = { overwrite: args.options?.overwrite ?? false, rename: args.options?.rename ?? false };
        let created: AssetInfo | null;
        if (type === 'folder' || type === 'typescript') {
            let content: string | null = null;
            if (type === 'typescript') {
                const currentExtension = extname(targetPath);
                if (currentExtension !== '.ts') targetPath = `${currentExtension ? targetPath.slice(0, -currentExtension.length) : targetPath}.ts`;
                content = this.generateTypescriptClassTemplate(basename(targetPath.slice('db://'.length), '.ts'));
            }
            created = await Editor.Message.request('asset-db', 'create-asset', targetPath, content, assetOptions);
        } else {
            const preset = presetMap[type];
            if (!preset) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Unknown asset preset type: ${type}` });
            if (extname(targetPath) === '') targetPath += preset.extension;
            created = await Editor.Message.request('asset-db', 'copy-asset', preset.source, targetPath, assetOptions);
        }
        if (!created?.uuid) throw new ToolError({ code: 'ASSET_CREATE_FAILED', status: 502, message: `Failed to create ${type} at ${targetPath}.` });
        const readBack = await readBackAsset(created.uuid, 'assetCreate');
        invalidateAfterWrite();
        return { reference: { id: readBack.uuid, type: readBack.type || created.type || type } };
    }

    @utcpTool('assetImport','Import external file as asset.',{type:'object',properties:{sourceFilesystemPath:{type:'string'},targetAssetPath:{type:'string'},imageType:{type:'string',enum:['raw','texture','normal-map','sprite-frame','texture-cube']},options:{type:'object',properties:{overwrite:{type:'boolean'},rename:{type:'boolean'}}}},required:['sourceFilesystemPath','targetAssetPath']},{type:'object',properties:{reference:InstanceReferenceSchema},required:['reference']},"POST",['asset','import','file','external','image'])
    async assetImport(args:{sourceFilesystemPath:string,targetAssetPath:string,imageType?:string,options?:{overwrite?:boolean,rename?:boolean}}):Promise<{reference:IInstanceReference}>{
        const targetPath = normalizePath(args.targetAssetPath);
        const assetOptions: AssetOperationOption = { overwrite: args.options?.overwrite ?? false, rename: args.options?.rename ?? false };
        let sourcePath = args.sourceFilesystemPath;
        if (sourcePath.startsWith('~')) sourcePath = path.join(os.homedir(), sourcePath.slice(1));
        sourcePath = await fs.realpath(path.resolve(sourcePath));
        let existingAssetInfo: AssetInfo | null = null;
        const projectPath = typeof Editor.Project?.path === 'string' ? Editor.Project.path : '';
        if (`${projectPath}${targetPath.slice('db:/'.length)}` === sourcePath) {
            await Editor.Message.request('asset-db', 'refresh-asset', targetPath);
            existingAssetInfo = await Editor.Message.request('asset-db', 'query-asset-info', targetPath);
        }
        const assetInfo = existingAssetInfo ?? await Editor.Message.request('asset-db', 'import-asset', sourcePath, targetPath, assetOptions) as AssetInfo | null;
        if (!assetInfo?.uuid) throw new ToolError({ code: 'ASSET_IMPORT_FAILED', status: 502, message: `Failed to import asset to ${targetPath}.` });
        if (assetInfo.extends && assetInfo.importer === 'image' && args.imageType) {
            const meta = await Editor.Message.request('asset-db', 'query-asset-meta', assetInfo.uuid);
            if (meta?.userData) {
                meta.userData.type = args.imageType === 'normal-map' ? 'normal map' : args.imageType === 'texture-cube' ? 'texture cube' : args.imageType;
                await Editor.Message.request('asset-db', 'save-asset-meta', assetInfo.uuid, JSON.stringify(meta));
            }
        }
        const readBack = await readBackAsset(assetInfo.uuid, 'assetImport');
        invalidateAfterWrite();
        return { reference: { id: readBack.uuid, type: readBack.type || assetInfo.type || 'cc.Asset' } };
    }
    @utcpTool('assetOpen', 'Open one imported asset in Creator by authoritative UUID and return bounded asset identity read-back.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, 'POST', ['asset', 'open', 'editor', 'external'])
    async assetOpen(args: { reference: IInstanceReference }): Promise<{ reference: IInstanceReference }> {
        return await this.assetOperate({ operation: 'open', reference: args.reference });
    }

    @utcpTool('assetOperate', 'Move/copy/delete/open/refresh/reimport asset, or save_meta (read meta via assetDbQuery meta first).', {
        type: 'object',
        properties: {
            operation: { type: 'string', enum: ['move', 'copy', 'delete', 'open', 'refresh', 'reimport', 'save_meta', 'stage_import_setting', 'apply_import_settings', 'restore_import_settings'] },
            reference: InstanceReferenceSchema,
            targetAssetPath: { type: 'string' },
            meta: { description: 'For save_meta: full meta object (or JSON string) from assetDbQuery meta, mutated' },
            path: { type: 'string', maxLength: 256 },
            value: {},
            options: { type: 'object', properties: { overwrite: { type: 'boolean' }, rename: { type: 'boolean' } }, nullable: true },
        },
        required: ['operation', 'reference'],
        anyOf: [
            { properties: { operation: { const: 'move' } }, required: ['targetAssetPath'] },
            { properties: { operation: { const: 'copy' } }, required: ['targetAssetPath'] },
            { properties: { operation: { const: 'save_meta' } }, required: ['meta'] },
            { properties: { operation: { const: 'delete' } } },
            { properties: { operation: { const: 'open' } } },
            { properties: { operation: { const: 'refresh' } } },
            { properties: { operation: { const: 'reimport' } } },
            { properties: { operation: { const: 'stage_import_setting' } }, required: ['path', 'value'] },
            { properties: { operation: { const: 'apply_import_settings' } } },
            { properties: { operation: { const: 'restore_import_settings' } } },
        ],
    }, { type: 'object', properties: { reference: InstanceReferenceSchema, lifecycle: { type: 'object' } }, required: ['reference'] }, "POST", ['asset', 'operate', 'move', 'copy', 'delete', 'open', 'refresh', 'reimport', 'meta'])
    async assetOperate(args:{operation:string,reference:IInstanceReference,targetAssetPath?:string,meta?:unknown,path?:string,value?:unknown,options?:{overwrite?:boolean,rename?:boolean}}):Promise<{reference:IInstanceReference,lifecycle?:unknown}>{
        if (['stage_import_setting', 'apply_import_settings', 'restore_import_settings'].includes(args.operation)) {
            const info = await Editor.Message.request('asset-db', 'query-asset-info', args.reference.id);
            if (!info || !['animation-mask', 'animation-graph-variant'].includes(info.importer)) throw new ToolError({ code: 'UNSUPPORTED_OPERATION', status: 422, message: 'Explicit cached lifecycle is supported only by native animation mask/variant adapters.' });
            const adapter = ImporterManager.getInstance().getImporter(info.importer);
            if (!adapter || !('changeProperty' in adapter) || !('apply' in adapter) || !('restore' in adapter) || typeof adapter.changeProperty !== 'function' || typeof adapter.apply !== 'function' || typeof adapter.restore !== 'function') throw new ToolError({ code: 'UNSUPPORTED_OPERATION', status: 422, message: 'Native asset lifecycle adapter is unavailable.' });
            let lifecycle: unknown;
            if (args.operation === 'stage_import_setting') {
                if (!args.path) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Staging requires a typed path.' });
                lifecycle = await adapter.changeProperty(info, args.path, args.value);
            } else if (args.operation === 'apply_import_settings') lifecycle = await adapter.apply(info);
            else lifecycle = await adapter.restore(info);
            invalidateAfterWrite();
            return { reference: { id: info.uuid, type: info.type }, lifecycle };
        }
        const assetOptions = { overwrite: args.options?.overwrite ?? false, rename: args.options?.rename ?? false };
        const sourceUrl = await toAssetUrl(args.reference.id);
        const hasTarget = typeof args.targetAssetPath === 'string' && args.targetAssetPath.length > 0;
        const targetUrl = hasTarget ? normalizePath(args.targetAssetPath) : undefined;
        let result: AssetReadback | null = null;
        switch (args.operation) {
            case 'move':
                if (!targetUrl) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'targetAssetPath is required for move.' });
                await Editor.Message.request('asset-db', 'move-asset', sourceUrl, targetUrl, assetOptions);
                result = await readBackAsset(targetUrl, 'assetOperate.move');
                break;
            case 'copy':
                if (!targetUrl) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'targetAssetPath is required for copy.' });
                await Editor.Message.request('asset-db', 'copy-asset', sourceUrl, targetUrl, assetOptions);
                result = await readBackAsset(targetUrl, 'assetOperate.copy');
                break;
            case 'delete':
                await Editor.Message.request('asset-db', 'delete-asset', sourceUrl);
                await assertAssetRemoved(args.reference.id, 'assetOperate.delete');
                break;
            case 'open':
                await Editor.Message.request('asset-db', 'open-asset', args.reference.id);
                result = await readBackAsset(args.reference.id, 'assetOperate.open');
                break;
            case 'refresh':
                await Editor.Message.request('asset-db', 'refresh-asset', sourceUrl);
                result = await readBackAsset(args.reference.id, 'assetOperate.refresh');
                break;
            case 'reimport':
                await Editor.Message.request('asset-db', 'reimport-asset', sourceUrl);
                result = await readBackAsset(args.reference.id, 'assetOperate.reimport');
                break;
            case 'save_meta': {
                if (args.meta === undefined || args.meta === null) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'save_meta requires meta.' });
                const payload = typeof args.meta === 'string' ? args.meta : JSON.stringify(args.meta);
                const saved = await Editor.Message.request('asset-db', 'save-asset-meta', args.reference.id, payload);
                if (!saved) throw new ToolError({ code: 'ASSET_OPERATION_FAILED', status: 502, message: `Failed to save meta for ${args.reference.id}.` });
                result = await readBackAsset(args.reference.id, 'assetOperate.save_meta');
                break;
            }
            default:
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Unknown operation: ${args.operation}.` });
        }
        if (args.operation !== 'delete') invalidateAfterWrite();
        return { reference: { id: result?.uuid ?? args.reference.id, type: result?.type ?? args.reference.type ?? 'cc.Asset' } };
    }

    @utcpTool('assetBatchImport', 'Import a bounded batch of external files and return per-item outcomes without stopping on one failure.', {
        type: 'object',
        additionalProperties: false,
        properties: {
            items: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        sourceFilesystemPath: { type: 'string', minLength: 1, maxLength: 2048 },
                        targetAssetPath: { type: 'string', minLength: 1, maxLength: 2048 },
                        imageType: { type: 'string', enum: ['raw', 'texture', 'normal-map', 'sprite-frame', 'texture-cube'] },
                        options: { type: 'object', properties: { overwrite: { type: 'boolean' }, rename: { type: 'boolean' } } },
                    },
                    required: ['sourceFilesystemPath', 'targetAssetPath'],
                },
            },
        },
        required: ['items'],
    }, {
        type: 'object',
        additionalProperties: false,
        properties: {
            outcomes: { type: 'array', maxItems: 64, items: { type: 'object' } },
            succeeded: { type: 'integer', minimum: 0, maximum: 64 },
            failed: { type: 'integer', minimum: 0, maximum: 64 },
            partial: { type: 'boolean' },
        },
        required: ['outcomes', 'succeeded', 'failed', 'partial'],
    }, 'POST', ['asset', 'batch', 'import', 'items'])
    async assetBatchImport(args: { items: Array<{ sourceFilesystemPath: string, targetAssetPath: string, imageType?: string, options?: { overwrite?: boolean, rename?: boolean } }> }): Promise<{
        outcomes: Array<Record<string, unknown>>,
        succeeded: number,
        failed: number,
        partial: boolean,
    }> {
        if (!Array.isArray(args?.items) || args.items.length < 1 || args.items.length > 64) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetBatchImport items must contain 1 to 64 entries.' });
        }
        const outcomes: Array<Record<string, unknown>> = [];
        for (let index = 0; index < args.items.length; index += 1) {
            const item = args.items[index];
            try {
                const result = await this.assetImport(item);
                outcomes.push({ index, ok: true, reference: result.reference });
            } catch (error: unknown) {
                outcomes.push({
                    index,
                    ok: false,
                    error: {
                        code: error instanceof ToolError ? error.code : 'ASSET_IMPORT_FAILED',
                        status: error instanceof ToolError ? error.status : 502,
                        message: boundedImportText(error instanceof Error ? error.message : String(error), 512),
                    },
                });
            }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, partial: succeeded > 0 && succeeded < outcomes.length };
    }

    @utcpTool('assetBatchOperate', 'Apply a bounded batch of asset operations and return per-item outcomes with partial recovery.', {
        type: 'object',
        additionalProperties: false,
        properties: {
            items: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        operation: { type: 'string', enum: ['move', 'copy', 'delete', 'open', 'refresh', 'reimport', 'save_meta'] },
                        reference: InstanceReferenceSchema,
                        targetAssetPath: { type: 'string', maxLength: 2048 },
                        meta: { type: 'object' },
                        options: { type: 'object', properties: { overwrite: { type: 'boolean' }, rename: { type: 'boolean' } } },
                    },
                    required: ['operation', 'reference'],
                },
            },
        },
        required: ['items'],
    }, {
        type: 'object',
        additionalProperties: false,
        properties: {
            outcomes: { type: 'array', maxItems: 64, items: { type: 'object' } },
            succeeded: { type: 'integer', minimum: 0, maximum: 64 },
            failed: { type: 'integer', minimum: 0, maximum: 64 },
            partial: { type: 'boolean' },
        },
        required: ['outcomes', 'succeeded', 'failed', 'partial'],
    }, 'POST', ['asset', 'batch', 'operate', 'items'])
    async assetBatchOperate(args: { items: Array<{ operation: string, reference: IInstanceReference, targetAssetPath?: string, meta?: unknown, options?: { overwrite?: boolean, rename?: boolean } }> }): Promise<{
        outcomes: Array<Record<string, unknown>>,
        succeeded: number,
        failed: number,
        partial: boolean,
    }> {
        if (!Array.isArray(args?.items) || args.items.length < 1 || args.items.length > 64) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetBatchOperate items must contain 1 to 64 entries.' });
        }
        const outcomes: Array<Record<string, unknown>> = [];
        for (let index = 0; index < args.items.length; index += 1) {
            const item = args.items[index];
            try {
                const result = await this.assetOperate(item);
                outcomes.push({ index, ok: true, reference: result.reference });
            } catch (error: unknown) {
                outcomes.push({
                    index,
                    ok: false,
                    error: {
                        code: error instanceof ToolError ? error.code : 'ASSET_OPERATION_FAILED',
                        status: error instanceof ToolError ? error.status : 502,
                        message: boundedImportText(error instanceof Error ? error.message : String(error), 512),
                    },
                });
            }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, partial: succeeded > 0 && succeeded < outcomes.length };
    }

    // assetGetPreview is now via previewManage (consolidated) — method kept for delegation, no @utcpTool
    async assetGetPreview(args: { reference: IInstanceReference, imageSize?: number, jpegQuality?: number, transparentColor?: { r: number, g: number, b: number } }): Promise<IBase64Image> {
        const info = await Editor.Message.request('asset-db', 'query-asset-info', args.reference.id);
        if (!info) throw new Error(`Asset ${args.reference.id} not found.`);
        if (!info.importer) throw new Error(`Asset ${args.reference.id} has no importer and cannot be previewed.`);
        args.imageSize = args.imageSize || 512; args.jpegQuality = args.jpegQuality || 80; args.transparentColor = args.transparentColor || { r:0,g:0,b:0 };
        let importer = info.importer;
        const supportedImporters=['erp-texture-cube','image','sprite-frame','texture','fbx','gltf','gltf-mesh','prefab','material','spine','gltf-skeleton','scene'];
        if (!supportedImporters.includes(importer)) throw new Error(`Asset preview not supported for asset type: ${info.type}`);
        if (importer==='fbx'||importer==='gltf'){ const mesh=Object.values(info.subAssets).find((s:any)=>s.importer==='gltf-mesh'); if(!mesh) throw new Error(`Asset ${args.reference.id} has no gltf-mesh sub-asset.`); args.reference.id=(mesh as any).uuid; importer='gltf-mesh'; }
        let sourcePath:string|null=null;
        if (importer==='gltf-mesh'||importer==='mesh') sourcePath=(await Editor.Message.request('asset-db','query-asset-thumbnail',args.reference.id,"origin") as any).value;
        else if (['erp-texture-cube','image','sprite-frame','texture'].includes(importer)){ let fu=args.reference.id; if(fu.includes('@')) fu=fu.split('@')[0]; const fi=await Editor.Message.request('asset-db','query-asset-info',fu); if(fi&&fi.file) sourcePath=fi.file; }
        if (sourcePath && fs.existsSync(sourcePath)){
            try{ const sharp=require('sharp'); const image=sharp(sourcePath); const meta=await image.metadata(); const rs=args.imageSize||512; let proc=image; if((meta.width&&meta.width>rs)||(meta.height&&meta.height>rs)) proc=proc.resize(rs,rs,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}); let buf; if(meta.format==='png'||meta.hasAlpha) buf=await proc.flatten({background:args.transparentColor}).jpeg({quality:args.jpegQuality||80}).toBuffer(); else buf=await proc.jpeg({quality:args.jpegQuality||80}).toBuffer(); return {type:"image",data:buf.toString('base64'),mimeType:"image/jpeg"}; }catch(e){ console.error(`[cx3] Failed sharp ${sourcePath}:`,e); }
        }
        const previewPanel=`${packageJSON.name}.preview`; const panelApi=Editor.Panel as any; if(typeof panelApi.openBeside==='function') await panelApi.openBeside('scene',previewPanel); else await Editor.Panel.open(previewPanel);
        let b64:string; try{ b64=await Editor.Message.request(packageJSON.name,'generate-preview',args.reference.id,args.imageSize||512,args.imageSize||512,(args.jpegQuality||80)/100);} finally{ await Editor.Panel.close(previewPanel); } if(!b64) throw new Error(`Failed to generate preview for asset ${args.reference.id}.`); return {type:"image",data:b64,mimeType:"image/jpeg"};
    }

    @utcpTool('assetImportSettingsGet', 'Read bounded importer-specific settings, typed property descriptors, and explicit source identity for one asset.', {
        type: 'object',
        additionalProperties: false,
        properties: { reference: InstanceReferenceSchema },
        required: ['reference'],
    }, {
        type: 'object',
        additionalProperties: false,
        properties: {
            reference: InstanceReferenceSchema,
            importer: { type: 'string', maxLength: MAX_IMPORT_REFERENCE_TYPE_LENGTH },
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    importer: { type: 'string', maxLength: MAX_IMPORT_REFERENCE_TYPE_LENGTH },
                    className: { type: 'string', maxLength: MAX_IMPORT_REFERENCE_TYPE_LENGTH },
                    properties: {
                        type: 'array',
                        maxItems: MAX_IMPORT_METADATA_OBJECT_PROPERTIES,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                path: { type: 'string', maxLength: MAX_IMPORT_METADATA_KEY_LENGTH },
                                type: { type: 'string', maxLength: MAX_IMPORT_REFERENCE_TYPE_LENGTH },
                                readonly: { type: 'boolean' },
                                visible: { type: 'boolean' },
                                displayName: { type: 'string', maxLength: MAX_IMPORT_SOURCE_NAME_LENGTH },
                                enumValues: { type: 'array', maxItems: MAX_IMPORT_METADATA_ARRAY_ITEMS },
                            },
                            required: ['path', 'type', 'readonly', 'visible'],
                        },
                    },
                    mutablePaths: { type: 'array', maxItems: MAX_IMPORT_METADATA_OBJECT_PROPERTIES, items: { type: 'string', maxLength: MAX_IMPORT_METADATA_KEY_LENGTH } },
                },
                required: ['importer', 'className', 'properties', 'mutablePaths'],
            },
            settings: {
                type: 'object',
                maxProperties: MAX_IMPORT_METADATA_OBJECT_PROPERTIES,
                additionalProperties: true,
                description: 'Importer-normalized JSON-compatible property values keyed by the typed schema paths.',
            },
            source: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    uuid: { type: 'string', maxLength: MAX_IMPORT_REFERENCE_ID_LENGTH },
                    url: { type: 'string', maxLength: MAX_IMPORT_SOURCE_URL_LENGTH },
                    type: { type: 'string', maxLength: MAX_IMPORT_REFERENCE_TYPE_LENGTH },
                    name: { type: 'string', maxLength: MAX_IMPORT_SOURCE_NAME_LENGTH },
                    isDirectory: { type: 'boolean' },
                },
                required: ['uuid', 'url', 'type', 'name', 'isDirectory'],
            },
        },
        required: ['reference', 'importer', 'schema', 'settings', 'source'],
    }, 'GET', ['asset', 'import', 'settings', 'inspect'])
    async assetImportSettingsGet(args: { reference: IInstanceReference }): Promise<AssetImportSettingsResult> {
        const requestedReference = validateImportReference(args);
        let info: unknown;
        try {
            info = await Editor.Message.request('asset-db', 'query-asset-info', requestedReference.id);
        } catch (error: unknown) {
            throw assetImportSettingsQueryError(error);
        }
        if (info === null || info === undefined) {
            throw new ToolError({
                code: 'TARGET_NOT_FOUND',
                status: 404,
                message: `Asset ${requestedReference.id} not found.`,
                details: { reference: requestedReference },
                recovery: 'Use assetQuery to discover a current asset reference before retrying.',
            });
        }
        if (typeof info !== 'object' || Array.isArray(info)) {
            throw assetImportSettingsQueryError(new Error('Creator returned an invalid asset record.'));
        }

        const uuidValue = Reflect.get(info, 'uuid');
        const urlValue = Reflect.get(info, 'url');
        const typeValue = Reflect.get(info, 'type');
        if (!isValidImportIdentity(uuidValue, MAX_IMPORT_REFERENCE_ID_LENGTH)
            || !isValidImportIdentity(urlValue, MAX_IMPORT_SOURCE_URL_LENGTH)

            || !isValidImportIdentity(typeValue, MAX_IMPORT_REFERENCE_TYPE_LENGTH)) {
            throw assetImportSettingsQueryError(new Error('Creator returned an asset record without a valid uuid, url, and type.'));
        }
        const uuid = uuidValue;
        const url = urlValue;
        const type = typeValue;
        const importerName = boundedImportText(Reflect.get(info, 'importer'), MAX_IMPORT_REFERENCE_TYPE_LENGTH);
        const importer = ImporterManager.getInstance().getImporter(importerName);
        if (!importer) {
            throw new ToolError({
                code: 'UNSUPPORTED_OPERATION',
                status: 422,
                message: `No registered importer supports '${importerName}'.`,
                recovery: 'Use assetQuery to select an asset whose Creator importer has a typed bridge adapter.',
            });
        }
        let normalized: { schema: AssetImportSettingsSchema, settings: Record<string, AssetImportMetadataValue> };
        try {
            normalized = normalizeImporterProperties(importerName, importer.className, await importer.getProperties(info as IAssetInfo));
        } catch (error: unknown) {
            if (error instanceof ToolError) throw error;
            throw new ToolError({
                code: 'IMPORTER_INSPECTION_FAILED',
                status: 502,
                message: `Importer '${importerName}' could not expose typed settings.`,
                details: { cause: boundedImportText(error instanceof Error ? error.message : String(error), 512) },
                recovery: 'Retry after the asset importer and its metadata are ready.',
            });
        }
        return {
            reference: { id: uuid, type },
            importer: importerName,
            schema: normalized.schema,
            settings: normalized.settings,
            source: {
                uuid,
                url: boundedImportText(Reflect.get(info, 'url'), MAX_IMPORT_SOURCE_URL_LENGTH),
                type,
                name: boundedImportText(Reflect.get(info, 'name'), MAX_IMPORT_SOURCE_NAME_LENGTH),
                isDirectory: Reflect.get(info, 'isDirectory') === true,
            },
        };
    }
    @utcpTool('assetImportSettingsSet', 'Set one typed importer property, reimport the asset, and read back the resulting settings.', {
        type: 'object', additionalProperties: false,
        properties: {
            reference: InstanceReferenceSchema,
            path: { type: 'string', minLength: 1, maxLength: MAX_IMPORT_SET_PATH_LENGTH, pattern: '^[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*$' },
            value: { description: 'Finite JSON-compatible importer value bounded by importer metadata limits.' },
        },
        required: ['reference', 'path', 'value'],
    }, {
        type: 'object',
        additionalProperties: false,
        properties: {
            changed: { type: 'boolean' },
            path: { type: 'string', maxLength: MAX_IMPORT_SET_PATH_LENGTH },
            previous: {},
            readBack: {},
            result: { type: 'object' },
            settingsSaved: { type: 'boolean', description: 'Requested setting independently read back through the importer adapter; does not imply generated output readiness.' },
            importComplete: { type: ['boolean', 'null'], description: 'Native busy/imported/invalid signals; null when unavailable, unsupported, or no reimport was requested.' },
            generatedOutputVerified: { type: ['boolean', 'null'], description: 'All exposed bounded library outputs hashed and stable with native import completion. Source/metadata alone never proves generated readiness.' },
            retrySafe: { type: 'boolean', const: false },
            importCompletion: {
                type: 'object', additionalProperties: false,
                properties: {
                    signal: { type: 'string', enum: ['asset-db/is-busy', 'unsupported', 'unavailable', 'not_requested'] },
                    polls: { type: 'integer', minimum: 0, maximum: IMPORT_BUSY_POLL_LIMIT },
                }, required: ['signal', 'polls'],
            },
            outputs: {
                type: 'array', maxItems: MAX_IMPORT_OUTPUTS,
                items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        kind: { type: 'string', enum: ['source', 'library'] },
                        extension: { type: 'string', maxLength: 128 },
                        path: { type: 'string', maxLength: 4096 },
                        status: { type: 'string', enum: ['verified', 'missing', 'unreadable', 'too_large', 'changed', 'empty'] },
                        bytes: { type: ['integer', 'null'], minimum: 0 },
                        sha256: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' },
                    }, required: ['kind', 'extension', 'path', 'status', 'bytes', 'sha256'],
                },
            },
            outputsTruncated: { type: 'boolean' },
        },
        required: ['changed', 'path', 'previous', 'readBack', 'result', 'settingsSaved', 'importComplete', 'generatedOutputVerified', 'retrySafe', 'importCompletion', 'outputs', 'outputsTruncated'],
    }, 'POST', ['asset', 'import', 'settings', 'configure', 'reimport'])
    async assetImportSettingsSet(args: { reference: IInstanceReference, path: string, value: unknown }): Promise<AssetImportSettingsSetResult> {
        const request = validateImportSet(args);
        const before = await boundedImportRequest(this.assetImportSettingsGet({ reference: request.reference }));
        const descriptor = before.schema.properties.find((property) => property.path === request.path);
        if (!descriptor) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Importer '${before.importer}' does not expose typed property '${request.path}'.` });
        }
        if (descriptor.readonly) {
            throw new ToolError({ code: 'READ_ONLY_PROPERTY', status: 422, message: `Importer property '${request.path}' is read-only.` });
        }
        const previous = importSettingAtPath(before.settings, request.path);
        if (previous === undefined) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Importer property '${request.path}' has no readable preflight value.` });
        }
        const patchKey = before.importer === 'animation-mask' && request.path === 'joints' ? 'path'
            : before.importer === 'animation-graph-variant' && request.path === 'clipOverrides' ? 'original' : null;
        const expected = expectedImportPatch(previous, request.value, patchKey);
        const record = await boundedImportRequest(Editor.Message.request('asset-db', 'query-asset-info', before.reference.id));
        if (!record || record.uuid !== before.reference.id || record.importer !== before.importer) {
            throw new ToolError({ code: 'ASSET_IDENTITY_CHANGED', status: 409, message: 'Asset identity/importer changed after settings preflight.' });
        }
        if (importSettingMatches(previous, expected, patchKey)) {
            const evidence = await importerOutputEvidence(record);
            return {
                changed: false, path: request.path, previous, readBack: previous, result: before,
                settingsSaved: false, importComplete: null,
                generatedOutputVerified: importerOutputVerified(evidence.outputs, evidence.truncated, null),
                retrySafe: false, importCompletion: { signal: 'not_requested', polls: 0 },
                outputs: evidence.outputs, outputsTruncated: evidence.truncated,
            };
        }
        const importer = ImporterManager.getInstance().getImporter(before.importer);
        if (!importer) throw new ToolError({ code: 'UNSUPPORTED_OPERATION', status: 422, message: `No registered importer supports '${before.importer}'.` });
        let settingsSaved: boolean | null = null;
        let importComplete: boolean | null = null;
        let importCompletion: AssetImportCompletion = { signal: 'not_requested', polls: 0 };
        let mutationStarted = false;
        try {
            mutationStarted = true;
            if (!await boundedImportRequest(importer.setProperty(record, request.path, request.value), true)) {
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Importer '${before.importer}' rejected property '${request.path}'.` });
            }
            const saved = await boundedImportRequest(this.assetImportSettingsGet({ reference: before.reference }));
            settingsSaved = importSettingMatches(importSettingAtPath(saved.settings, request.path), expected, patchKey);
            if (!settingsSaved) throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: `Importer property '${request.path}' was not saved as requested.` });
            await boundedImportRequest(Editor.Message.request('asset-db', 'reimport-asset', record.uuid), true);
            const completion = await importerCompletion(record.uuid);
            importComplete = completion.complete;
            importCompletion = completion.evidence;
            const result = await boundedImportRequest(this.assetImportSettingsGet({ reference: before.reference }));
            const readBack = importSettingAtPath(result.settings, request.path);
            if (readBack === undefined || !importSettingMatches(readBack, expected, patchKey)) {
                settingsSaved = false;
                throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: `Importer property '${request.path}' changed after reimport.`, details: { requested: request.value, readBack: readBack ?? null } });
            }
            const outputRecord = await boundedImportRequest(Editor.Message.request('asset-db', 'query-asset-info', record.uuid));
            if (!outputRecord || outputRecord.uuid !== record.uuid || outputRecord.importer !== before.importer) throw new ToolError({ code: 'ASSET_IDENTITY_CHANGED', status: 409, message: 'Asset identity/importer changed during output readback.' });
            const evidence = await importerOutputEvidence(outputRecord);
            return {
                changed: true, path: request.path, previous, readBack, result, settingsSaved: true, importComplete,
                generatedOutputVerified: importerOutputVerified(evidence.outputs, evidence.truncated, importComplete),
                retrySafe: false, importCompletion, outputs: evidence.outputs, outputsTruncated: evidence.truncated,
            };
        } catch (error: unknown) {
            const details = { ...(error instanceof ToolError ? error.details : {}), settingsSaved, importComplete, importCompletion, retrySafe: false };
            // Timed-out native mutations may still finish. Never race them with a rollback.
            if (error instanceof ToolError && (error.details?.mutationPending === true || error.details?.mutationDispatched === false || importComplete === false)) {
                throw new ToolError({ code: error.code, status: error.status, message: error.message, details: { ...details, restored: null }, recovery: error.recovery ?? 'Read current settings and native import state before another mutation.' });
            }
            let restored: boolean | null = null;
            let rollbackImportComplete: boolean | null = null;
            if (mutationStarted) {
                try {
                    const current = await boundedImportRequest(Editor.Message.request('asset-db', 'query-asset-info', record.uuid));
                    if (!current || current.uuid !== record.uuid || current.importer !== before.importer) throw new Error('Rollback asset identity/importer changed.');
                    if (supportsImporterRestore(importer)) {
                        await boundedImportRequest(importer.restore(current), true);
                    } else if (!await boundedImportRequest(importer.setProperty(current, request.path, previous), true)) {
                        throw new Error('Importer rejected rollback value.');
                    }
                    await boundedImportRequest(Editor.Message.request('asset-db', 'reimport-asset', record.uuid), true);
                    rollbackImportComplete = (await importerCompletion(record.uuid)).complete;
                    const rollback = await boundedImportRequest(this.assetImportSettingsGet({ reference: before.reference }));
                    restored = importSettingMatches(importSettingAtPath(rollback.settings, request.path), previous, patchKey);
                    if (!restored) throw new Error('Independent rollback settings readback did not match the previous value.');
                } catch (rollbackError: unknown) {
                    throw new ToolError({
                        code: 'ROLLBACK_FAILED', status: 500,
                        message: `assetImportSettingsSet failed; restoration of '${request.path}' could not be independently verified.`,
                        details: { ...details, restored, rollbackImportComplete,
                            cause: boundedImportText(error instanceof Error ? error.message : String(error), 512),
                            rollbackCause: boundedImportText(rollbackError instanceof Error ? rollbackError.message : String(rollbackError), 512),
                        }, recovery: 'Inspect current settings and native busy state before restoring manually; do not blindly retry the mutation.',
                    });
                }
            }
            throw new ToolError({
                code: error instanceof ToolError ? error.code : 'ASSET_IMPORT_FAILED',
                status: error instanceof ToolError ? error.status : 502,
                message: error instanceof ToolError ? error.message : 'assetImportSettingsSet could not update and reimport the asset.',
                details: { ...details, restored, rollbackImportComplete, cause: boundedImportText(error instanceof Error ? error.message : String(error), 512) },
                recovery: 'Read current settings and importer outcomes before deciding on another mutation.',
            });
        }
    }

    @utcpTool('assetCompressionConfigure', 'Assign a platform-aware Creator texture-compression preset, reimport, and return source/import-output evidence.', {
        type: 'object',
        additionalProperties: false,
        properties: {
            reference: InstanceReferenceSchema,
            presetId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
            platform: { type: 'string', enum: ['miniGame', 'web', 'ios', 'android', 'pc'] },
        },
        required: ['reference', 'presetId', 'platform'],
    }, {
        type: 'object',
        additionalProperties: false,
        properties: {
            changed: { type: 'boolean' },
            reference: InstanceReferenceSchema,
            presetId: { type: 'string' },
            previousPresetId: { type: 'string', nullable: true },
            platform: { type: 'string' },
            formats: {
                type: 'array',
                maxItems: 32,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { format: { type: 'string' }, quality: { type: ['string', 'number'] } },
                    required: ['format', 'quality'],
                },
            },
            sourceSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            generatedOutputs: {
                type: 'array',
                maxItems: 32,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        extension: { type: 'string' },
                        path: { type: 'string' },
                        bytes: { type: 'integer', minimum: 0 },
                        sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                    },
                    required: ['extension', 'path', 'bytes', 'sha256'],
                },
            },
            buildArtifactVerified: { type: 'boolean', const: false },
        },
        required: ['changed', 'reference', 'presetId', 'previousPresetId', 'platform', 'formats', 'sourceSha256', 'generatedOutputs', 'buildArtifactVerified'],
    }, 'POST', ['asset', 'texture', 'compression', 'platform', 'preset', 'reimport'])
    async assetCompressionConfigure(args: { reference: IInstanceReference, presetId: string, platform: TextureCompressionPlatform }): Promise<{
        changed: boolean,
        reference: IInstanceReference,
        presetId: string,
        previousPresetId: string | null,
        platform: TextureCompressionPlatform,
        formats: TextureCompressionFormat[],
        sourceSha256: string,
        generatedOutputs: TextureCompressionOutputEvidence[],
        buildArtifactVerified: false,
    }> {
        const request = validateCompressionArgs(args);
        const record = await Editor.Message.request('asset-db', 'query-asset-info', request.reference.id) as IAssetInfo | null;
        if (!record) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Asset ${request.reference.id} not found.` });
        if (record.importer !== 'image') {
            throw new ToolError({ code: 'UNSUPPORTED_OPERATION', status: 422, message: `assetCompressionConfigure supports Creator image imports, not '${record.importer}'.` });
        }
        const defaults = await Editor.Profile.getProject('builder', 'textureCompressConfig', 'default') as any;
        const project = await Editor.Profile.getProject('builder', 'textureCompressConfig', 'project').catch(() => null) as any;
        const presets = { ...(defaults?.defaultConfig ?? {}), ...(project?.defaultConfig ?? {}) };
        const preset = presets[request.presetId];
        if (!preset || typeof preset !== 'object') {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Compression preset '${request.presetId}' does not exist in the effective Creator project settings.` });
        }
        const formats = compressionFormats(preset.options?.[request.platform]);
        if (formats.length === 0) {
            throw new ToolError({ code: 'UNSUPPORTED_OPERATION', status: 422, message: `Compression preset '${request.presetId}' has no formats for platform '${request.platform}'.` });
        }
        const meta = await Editor.Message.request('asset-db', 'query-asset-meta', record.uuid) as IAssetMeta | null;
        if (!meta?.userData) throw new ToolError({ code: 'ASSET_QUERY_FAILED', status: 502, message: 'Creator returned no image importer metadata.' });
        const previousValue = meta.userData.presetId;
        const previousPresetId = typeof previousValue === 'string' ? previousValue : null;
        const changed = previousPresetId !== request.presetId;
        if (changed) {
            meta.userData.presetId = request.presetId;
            try {
                const saved = await Editor.Message.request('asset-db', 'save-asset-meta', record.uuid, JSON.stringify(meta));
                if (!saved) throw new Error('Creator refused the compression metadata update.');
                await Editor.Message.request('asset-db', 'reimport-asset', record.uuid);
                const readBackMeta = await Editor.Message.request('asset-db', 'query-asset-meta', record.uuid) as IAssetMeta | null;
                if (readBackMeta?.userData?.presetId !== request.presetId) throw new Error('Compression preset read-back did not match.');
            } catch (error: unknown) {
                if (previousPresetId === null) delete meta.userData.presetId;
                else meta.userData.presetId = previousPresetId;
                try {
                    await Editor.Message.request('asset-db', 'save-asset-meta', record.uuid, JSON.stringify(meta));
                    await Editor.Message.request('asset-db', 'reimport-asset', record.uuid);
                } catch (rollbackError: unknown) {
                    throw new ToolError({
                        code: 'ROLLBACK_FAILED',
                        status: 500,
                        message: 'Compression configuration failed and the original preset could not be restored.',
                        details: { cause: String(error), rollbackCause: String(rollbackError) },
                    });
                }
                throw new ToolError({ code: 'MUTATION_FAILED', status: 502, message: 'Compression configuration failed and was rolled back.', details: { cause: String(error) } });
            }
        }
        const refreshed = await Editor.Message.request('asset-db', 'query-asset-info', record.uuid) as IAssetInfo | null;
        const evidenced = refreshed ? await waitForCompressionLibrary(record.uuid, refreshed) : refreshed;
        if (!evidenced?.file || !await fs.pathExists(enforceProjectFilePath(evidenced.file, 'assetCompressionConfigure'))) {
            throw new ToolError({ code: 'READBACK_FAILED', status: 502, message: 'Configured image source is unavailable for evidence hashing.' });
        }
        return {
            changed,
            reference: { id: evidenced.uuid, type: evidenced.type },
            presetId: request.presetId,
            previousPresetId,
            platform: request.platform,
            formats,
            sourceSha256: await sha256File(enforceProjectFilePath(evidenced.file, 'assetCompressionConfigure')),
            generatedOutputs: await compressionOutputEvidence(evidenced.library),
            buildArtifactVerified: false,
        };
    }


    @utcpTool('assetManifestExport', 'Export a bounded deterministic asset manifest with dependencies, source hashes, and explicit exclusions.', {
        type: 'object',
        additionalProperties: false,
        properties: {
            assetPath: { type: 'string', minLength: 1, maxLength: MAX_MANIFEST_ASSET_PATH_LENGTH },
            maxAssets: { type: 'integer', minimum: 1, maximum: 512, default: 128 },
            maxFileBytes: { type: 'integer', minimum: 1, maximum: 52428800, default: 10485760 },
        },
    }, {
        type: 'object',
        additionalProperties: false,
        properties: {
            assets: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        uuid: { type: 'string' },
                        url: { type: 'string' },
                        type: { type: 'string' },
                        importer: { type: 'string' },
                        name: { type: 'string' },
                        isSubAsset: { type: 'boolean' },
                        dependencies: { type: 'array', items: { type: 'string' }, maxItems: MAX_MANIFEST_DEPENDENCIES },
                        dependenciesTruncated: { type: 'boolean' },
                        bytes: { type: 'integer', minimum: 0 },
                        sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                    },
                    required: ['uuid', 'url', 'type', 'importer', 'name', 'isSubAsset', 'dependencies', 'dependenciesTruncated', 'bytes', 'sha256'],
                },
            },
            exclusions: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        uuid: { type: 'string' },
                        url: { type: 'string' },
                        reason: { type: 'string', enum: ['source-file-unavailable', 'source-file-too-large', 'hash-failed'] },
                        bytes: { type: 'integer', minimum: 0 },
                        maxFileBytes: { type: 'integer', minimum: 1 },
                    },
                    required: ['uuid', 'url', 'reason'],
                },
            },
            truncated: { type: 'boolean' },
            count: { type: 'integer' },
            total: { type: 'integer' },
        },
        required: ['assets', 'exclusions', 'truncated', 'count', 'total'],
    }, 'GET', ['asset', 'manifest', 'export', 'dependencies', 'hash', 'sha256'])
    async assetManifestExport(args: { assetPath?: string, maxAssets?: number, maxFileBytes?: number }): Promise<{
        assets: Array<Record<string, unknown>>,
        exclusions: Array<Record<string, unknown>>,
        truncated: boolean,
        count: number,
        total: number,
    }> {
        const maxAssets = validateManifestMaxAssets(args?.maxAssets);
        const maxFileBytes = validateManifestMaxFileBytes(args?.maxFileBytes);
        const rootPath = normalizeManifestAssetPath(args?.assetPath);
        let rows: unknown[];
        try {
            rows = await queryAssetsCompat({ pattern: `${rootPath}/**` });
        } catch (error: unknown) {
            throw assetManifestError(error);
        }
        const files = rows
            .filter(isManifestRow)
            .filter((row) => !row.isDirectory)
            .sort((a, b) => String(a.url).localeCompare(String(b.url)) || String(a.uuid).localeCompare(String(b.uuid)));
        const assets: Array<Record<string, unknown>> = [];
        const exclusions: Array<Record<string, unknown>> = [];
        for (const row of files.slice(0, maxAssets)) {
            const uuid = typeof row.uuid === 'string' ? row.uuid : '';
            const url = typeof row.url === 'string' ? row.url : '';
            const info = typeof row.file === 'string'
                ? row
                : await Editor.Message.request('asset-db', 'query-asset-info', uuid || url).catch(() => null) as unknown;
            const sourcePath = isManifestRow(info) && typeof info.file === 'string' ? enforceProjectFilePath(info.file, 'assetManifestExport') : '';
            if (!sourcePath) {
                exclusions.push({ uuid, url, reason: 'source-file-unavailable' });
                continue;
            }
            const stat = await fs.stat(sourcePath).catch(() => null);
            if (!stat?.isFile()) {
                exclusions.push({ uuid, url, reason: 'source-file-unavailable' });
                continue;
            }
            if (stat.size > maxFileBytes) {
                exclusions.push({ uuid, url, reason: 'source-file-too-large', bytes: stat.size, maxFileBytes });
                continue;
            }
            try {
                const dependencyRows = await Editor.Message.request('asset-db', 'query-assets', { pattern: uuid || url }).catch(() => []);
                const rawDependencies = manifestDependencies(row) ?? manifestDependencies(Array.isArray(dependencyRows) ? dependencyRows[0] : undefined) ?? [];
                assets.push({
                    uuid,
                    url,
                    type: typeof row.type === 'string' ? row.type : '',
                    importer: typeof row.importer === 'string' ? row.importer : isManifestRow(info) && typeof info.importer === 'string' ? info.importer : '',
                    name: typeof row.name === 'string' ? row.name : '',
                    isSubAsset: Boolean(row.isSubAsset),
                    dependencies: rawDependencies,
                    dependenciesTruncated: Array.isArray(row.depends) && row.depends.length > rawDependencies.length,
                    bytes: stat.size,
                    sha256: await sha256File(sourcePath),
                });
            } catch {
                exclusions.push({ uuid, url, reason: 'hash-failed' });
            }
        }
        return { assets, exclusions, truncated: files.length > maxAssets, count: assets.length, total: files.length };
    }

    @utcpTool('assetCatalogManifest', 'Build a bounded deterministic asset catalog with source hashes and explicit exclusions.', {
        type: 'object',
        properties: {
            assetPath: { type: 'string' },
            maxAssets: { type: 'integer', minimum: 1, maximum: 128, default: 64 },
            maxFileBytes: { type: 'integer', minimum: 1, maximum: 10485760, default: 10485760 },
        },
    }, { type: 'object', properties: { assets: { type: 'array' }, exclusions: { type: 'array' }, truncated: { type: 'boolean' }, count: { type: 'integer' } }, required: ['assets', 'exclusions', 'truncated', 'count'] }, 'GET', ['asset', 'catalog', 'manifest', 'hash', 'sha256'])
    async assetCatalogManifest(args: { assetPath?: string, maxAssets?: number, maxFileBytes?: number }): Promise<{ assets: Array<Record<string, unknown>>, exclusions: Array<Record<string, unknown>>, truncated: boolean, count: number }> {
        const maxAssets = Math.min(Math.max(args.maxAssets ?? 64, 1), 128);
        const maxFileBytes = Math.min(Math.max(args.maxFileBytes ?? 10485760, 1), 10485760);
        const rows: any[] = await queryAssetsCompat({ pattern: `${normalizePath(args.assetPath)}/**` });
        const files = rows.filter((row) => !row.isDirectory).sort((a, b) => String(a.url).localeCompare(String(b.url)));
        const assets: Array<Record<string, unknown>> = [];
        const exclusions: Array<Record<string, unknown>> = [];
        for (const row of files.slice(0, maxAssets)) {
            const info: Record<string, unknown> | null = isManifestRow(row)
                ? row
                : await Editor.Message.request('asset-db', 'query-asset-info', String(row.uuid ?? row.url)).catch(() => null) as Record<string, unknown> | null;
            const sourcePath = typeof info?.file === 'string' ? enforceProjectFilePath(info.file, 'assetCatalogManifest') : '';
            if (!sourcePath) {
                exclusions.push({ uuid: row.uuid, url: row.url, reason: 'source-file-unavailable' });
                continue;
            }
            const stat = await fs.stat(sourcePath).catch(() => null);
            if (!stat?.isFile()) {
                exclusions.push({ uuid: row.uuid, url: row.url, reason: 'source-file-unavailable' });
                continue;
            }
            if (stat.size > maxFileBytes) {
                exclusions.push({ uuid: row.uuid, url: row.url, reason: 'source-file-too-large', bytes: stat.size, maxFileBytes });
                continue;
            }
            assets.push({ uuid: row.uuid, url: row.url, type: row.type, importer: row.importer ?? info?.importer ?? '', bytes: stat.size, sha256: await sha256File(sourcePath) });
        }
        return { assets, exclusions, truncated: files.length > maxAssets, count: assets.length };
    }

    @utcpTool('assetUsageAnalyze', 'Analyze project-wide serialized asset reachability from explicit or discovered scene/prefab roots using graph-v4 evidence.', {
        type: 'object',
        additionalProperties: false,
        properties: {
            assetPath: { type: 'string', minLength: 1, maxLength: MAX_MANIFEST_ASSET_PATH_LENGTH },
            maxAssets: { type: 'integer', minimum: 1, maximum: 128, default: 64 },
            maxGraphAssets: { type: 'integer', minimum: 1, maximum: 5000, default: 5000 },
            rootReferences: { type: 'array', minItems: 1, maxItems: 128, items: InstanceReferenceSchema },
        },
    }, {
        type: 'object',
        additionalProperties: false,
        properties: {
            graphVersion: { type: 'string', const: 'v4' },
            complete: { type: 'boolean' },
            roots: { type: 'array', maxItems: 5000, items: InstanceReferenceSchema },
            graphAssets: { type: 'integer' },
            graphEdges: { type: 'integer' },
            graphTruncated: { type: 'boolean' },
            exclusions: { type: 'array', maxItems: 5000, items: { type: 'object' } },
            candidates: { type: 'array', maxItems: 128, items: { type: 'object' } },
            checkedAssets: { type: 'integer' },
            referenceEvidence: { type: 'array', maxItems: 128, items: { type: 'object' } },
            dynamicLoadCaveat: { type: 'string' },
        },
        required: ['graphVersion', 'complete', 'roots', 'graphAssets', 'graphEdges', 'graphTruncated', 'exclusions', 'candidates', 'checkedAssets', 'referenceEvidence', 'dynamicLoadCaveat'],
    }, 'GET', ['asset', 'usage', 'analyze', 'references', 'project', 'graph', 'roots'])
    async assetUsageAnalyze(args: { assetPath?: string, maxAssets?: number, maxGraphAssets?: number, rootReferences?: IInstanceReference[] } = {}): Promise<{
        graphVersion: 'v4',
        complete: boolean,
        roots: IInstanceReference[],
        graphAssets: number,
        graphEdges: number,
        graphTruncated: boolean,
        exclusions: Array<Record<string, unknown>>,
        candidates: Array<Record<string, unknown>>,
        checkedAssets: number,
        referenceEvidence: Array<Record<string, unknown>>,
        dynamicLoadCaveat: string,
    }> {
        const maxAssets = validateUsageMaxAssets(args.maxAssets);
        const maxGraphAssets = validateUsageMaxGraphAssets(args.maxGraphAssets);
        const targetPath = normalizeBoundedAssetPath(args.assetPath, 'assetUsageAnalyze');
        let queried: unknown[];
        try {
            queried = await queryAssetsCompat({ pattern: 'db://assets/**' });
        } catch (error: unknown) {
            throw assetUsageError(error);
        }
        const allRows = queried
            .filter(isManifestRow)
            .filter((row) => !row.isDirectory && typeof row.uuid === 'string' && typeof row.url === 'string')
            .map((row) => row as Record<string, unknown> & { uuid: string, url: string })
            .sort((left, right) => left.url.localeCompare(right.url) || left.uuid.localeCompare(right.uuid));
        const graphRows = allRows.slice(0, maxGraphAssets);
        const requestedRoots = args.rootReferences?.map((reference) => assetUuidBase(validateImportReference({ reference }).id.toLowerCase()));
        if (requestedRoots) {
            for (const rootId of requestedRoots) {
                const rootRow = allRows.find((row) => assetUuidBase(row.uuid.toLowerCase()) === rootId);
                if (rootRow && !graphRows.some((row) => assetUuidBase(row.uuid.toLowerCase()) === rootId)) graphRows.push(rootRow);
            }
        }
        const graphTruncated = allRows.length > maxGraphAssets;
        const known = new Map(graphRows.map((row) => [assetUuidBase(row.uuid.toLowerCase()), row]));
        const edges = new Map<string, Set<string>>();
        const incoming = new Map<string, Set<string>>();
        const exclusions: Array<Record<string, unknown>> = [];

        for (const row of graphRows) {
            const sourceId = assetUuidBase(row.uuid.toLowerCase());
            const dependencies = new Set((manifestDependencies(row) ?? []).map((value) => assetUuidBase(value.toLowerCase())).filter((value) => known.has(value)));
            const extension = extname(row.url).toLowerCase();
            if (SERIALIZED_ASSET_EXTENSIONS.has(extension)) {
                const info = typeof row.file === 'string'
                    ? row
                    : await Editor.Message.request('asset-db', 'query-asset-info', row.uuid).catch(() => null) as unknown;
                const filePath = isManifestRow(info) && typeof info.file === 'string' ? enforceProjectFilePath(info.file, 'assetUsageAnalyze') : '';
                if (!filePath) {
                    exclusions.push({ uuid: row.uuid, url: row.url, reason: 'source-file-unavailable' });
                } else {
                    const stat = await fs.stat(filePath).catch(() => null);
                    if (!stat?.isFile()) exclusions.push({ uuid: row.uuid, url: row.url, reason: 'source-file-unavailable' });
                    else if (stat.size > SERIALIZED_GRAPH_FILE_BYTES) exclusions.push({ uuid: row.uuid, url: row.url, reason: 'source-file-too-large', bytes: stat.size });
                    else {
                        try {
                            for (const dependency of serializedAssetReferences(await fs.readFile(filePath, 'utf8'))) {
                                if (known.has(dependency) && dependency !== sourceId) dependencies.add(dependency);
                            }
                        } catch (error: unknown) {
                            exclusions.push({ uuid: row.uuid, url: row.url, reason: 'source-read-failed', error: boundedImportText(error instanceof Error ? error.message : String(error), 256) });
                        }
                    }
                }
            }
            edges.set(sourceId, dependencies);
            for (const dependency of dependencies) {
                const sources = incoming.get(dependency) ?? new Set<string>();
                sources.add(sourceId);
                incoming.set(dependency, sources);
            }
        }

        const rootIds = requestedRoots ?? graphRows
            .filter(isAssetGraphRoot)
            .map((row) => assetUuidBase(row.uuid.toLowerCase()));
        const missingRoots = rootIds.filter((id) => !known.has(id));
        if (missingRoots.length > 0) {
            throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Asset usage roots not found: ${missingRoots.join(', ')}` });
        }
        const reachable = new Set<string>();
        const queue = [...new Set(rootIds)].sort();
        while (queue.length) {
            const id = queue.shift()!;
            if (reachable.has(id)) continue;
            reachable.add(id);
            for (const dependency of edges.get(id) ?? []) if (!reachable.has(dependency)) queue.push(dependency);
        }
        const targets = graphRows
            .filter((row) => row.url === targetPath || row.url.startsWith(`${targetPath}/`))
            .slice(0, maxAssets);
        const referenceEvidence = targets.map((row) => {
            const id = assetUuidBase(row.uuid.toLowerCase());
            const sourceIds = [...(incoming.get(id) ?? [])].sort();
            const references = sourceIds.slice(0, MAX_USAGE_REFERENCES).map((sourceId) => {
                const source = known.get(sourceId)!;
                return { id: source.uuid, type: typeof source.type === 'string' ? source.type : 'cc.Asset' };
            });
            return {
                uuid: row.uuid,
                url: row.url,
                ...(typeof row.type === 'string' ? { type: row.type } : {}),
                status: reachable.has(id) ? 'root-reachable' : 'project-unreachable',
                root: rootIds.includes(id),
                referenceCount: sourceIds.length,
                references,
                truncated: sourceIds.length > references.length,
            };
        });
        const candidates = referenceEvidence
            .filter((evidence) => evidence.status === 'project-unreachable')
            .map((evidence) => ({ ...evidence, confidence: 'serialized-project-unreachable' }));
        const graphEdges = [...edges.values()].reduce((sum, dependencies) => sum + dependencies.size, 0);
        const complete = !graphTruncated && exclusions.length === 0;
        return {
            graphVersion: 'v4',
            complete,
            roots: [...new Set(rootIds)].sort().map((id) => {
                const row = known.get(id)!;
                return { id: row.uuid, type: typeof row.type === 'string' ? row.type : 'cc.Asset' };
            }),
            graphAssets: graphRows.length,
            graphEdges,
            graphTruncated,
            exclusions,
            candidates,
            checkedAssets: targets.length,
            referenceEvidence,
            dynamicLoadCaveat: 'Static graph-v4 covers serialized UUID references from project scene, prefab, and supported text asset roots; dynamic runtime addressables, resources.load, and computed string paths remain outside static proof.',
        };
    }

    @utcpTool('assetMissingReferenceAudit', 'Audit all project scene files for bounded serialized UUID references that do not resolve to known assets.', {
        type: 'object',
        additionalProperties: false,
        properties: {
            assetPath: { type: 'string', minLength: 1, maxLength: MAX_MANIFEST_ASSET_PATH_LENGTH },
            maxScenes: { type: 'integer', minimum: 1, maximum: 128, default: 128 },
            maxReferences: { type: 'integer', minimum: 1, maximum: 2000, default: 2000 },
        },
    }, {
        type: 'object',
        additionalProperties: false,
        properties: {
            complete: { type: 'boolean' },
            scannedScenes: { type: 'integer', minimum: 0, maximum: 128 },
            missingReferences: { type: 'array', maxItems: 2000, items: { type: 'object' } },
            exclusions: { type: 'array', maxItems: 128, items: { type: 'object' } },
            truncated: { type: 'boolean' },
            dynamicLoadCaveat: { type: 'string' },
        },
        required: ['complete', 'scannedScenes', 'missingReferences', 'exclusions', 'truncated', 'dynamicLoadCaveat'],
    }, 'GET', ['asset', 'missing', 'reference', 'audit', 'scene'])
    async assetMissingReferenceAudit(args: { assetPath?: string, maxScenes?: number, maxReferences?: number } = {}): Promise<{
        complete: boolean,
        scannedScenes: number,
        missingReferences: Array<Record<string, unknown>>,
        exclusions: Array<Record<string, unknown>>,
        truncated: boolean,
        dynamicLoadCaveat: string,
    }> {
        const maxScenes = args.maxScenes ?? 128;
        const maxReferences = args.maxReferences ?? 2000;
        if (!Number.isInteger(maxScenes) || maxScenes < 1 || maxScenes > 128 || !Number.isInteger(maxReferences) || maxReferences < 1 || maxReferences > 2000) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetMissingReferenceAudit bounds are invalid.' });
        }
        const targetPath = normalizeBoundedAssetPath(args.assetPath, 'assetMissingReferenceAudit');
        let queried: unknown[];
        try {
            queried = await queryAssetsCompat({ pattern: 'db://assets/**' });
        } catch (error: unknown) {
            throw new ToolError({ code: 'ASSET_QUERY_FAILED', status: 502, message: 'assetMissingReferenceAudit could not query the Creator asset database.', details: { cause: boundedImportText(error instanceof Error ? error.message : String(error), 512) } });
        }
        const rows = queried
            .filter(isManifestRow)
            .filter((row) => !row.isDirectory && typeof row.uuid === 'string' && typeof row.url === 'string')
            .map((row) => row as Record<string, unknown> & { uuid: string, url: string })
            .sort((left, right) => left.url.localeCompare(right.url) || left.uuid.localeCompare(right.uuid));
        const known = new Set(rows.map((row) => assetUuidBase(row.uuid.toLowerCase())));
        const scenes = rows.filter((row) => {
            const inTarget = row.url === targetPath || row.url.startsWith(`${targetPath}/`);
            return inTarget && extname(row.url).toLowerCase() === '.scene';
        });
        const exclusions: Array<Record<string, unknown>> = [];
        const missingReferences: Array<Record<string, unknown>> = [];
        for (const row of scenes.slice(0, maxScenes)) {
            const info = typeof row.file === 'string' ? row : await Editor.Message.request('asset-db', 'query-asset-info', row.uuid).catch(() => null) as unknown;
            const filePath = isManifestRow(info) && typeof info.file === 'string' ? enforceProjectFilePath(info.file, 'assetMissingReferenceAudit') : '';
            if (!filePath) {
                exclusions.push({ uuid: row.uuid, url: row.url, reason: 'source-file-unavailable' });
                continue;
            }
            const stat = await fs.stat(filePath).catch(() => null);
            if (!stat?.isFile()) {
                exclusions.push({ uuid: row.uuid, url: row.url, reason: 'source-file-unavailable' });
                continue;
            }
            if (stat.size > SERIALIZED_GRAPH_FILE_BYTES) {
                exclusions.push({ uuid: row.uuid, url: row.url, reason: 'source-file-too-large', bytes: stat.size });
                continue;
            }
            try {
                const content = await fs.readFile(filePath, 'utf8');
                for (const occurrence of serializedAssetReferenceOccurrences(content)) {
                    if (known.has(occurrence.id)) continue;
                    if (missingReferences.length >= maxReferences) break;
                    missingReferences.push({ source: { uuid: row.uuid, url: row.url }, referenceId: occurrence.id, line: occurrence.line });
                }
            } catch (error: unknown) {
                exclusions.push({ uuid: row.uuid, url: row.url, reason: 'source-read-failed', error: boundedImportText(error instanceof Error ? error.message : String(error), 256) });
            }
            if (missingReferences.length >= maxReferences) break;
        }
        const truncated = scenes.length > maxScenes || missingReferences.length >= maxReferences;
        return {
            complete: !truncated && exclusions.length === 0,
            scannedScenes: Math.min(scenes.length, maxScenes),
            missingReferences,
            exclusions,
            truncated,
            dynamicLoadCaveat: 'Static audit covers serialized UUID references in scene files; runtime resource loads, addressables, and computed paths require separate runtime evidence.',
        };
    }

    private generateTypescriptClassTemplate(className: string): string {
        return `import { _decorator, Component, Node } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('${className}')
export class ${className} extends Component {
    start() {}
    update(deltaTime: number) {}
}`;
    }
}
