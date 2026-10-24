import fs from 'fs';
import path from 'path';
import http from 'http';
import { ToolError } from '../tool-error';

export const BUNDLE_RESOURCE_TYPES = ['JsonAsset', 'TextAsset', 'ImageAsset', 'Texture2D', 'SpriteFrame', 'AudioClip'] as const;
export type BundleResourceType = typeof BUNDLE_RESOURCE_TYPES[number];
export interface BundleArtifact { root: string; name: string; version: string; configFile: string; indexFile: string; config: Buffer; index: Buffer }
const LIMIT = 1024 * 1024;
function inside(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function invalid(message: string): never { throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message }); }
function prerequisite(message: string): never { throw new ToolError({ code: 'BUNDLE_BUILD_REQUIRED', status: 409, message, recovery: 'Build a standalone data-only web bundle inside this project; supply its exact build/... bundlePath and bundleName.' }); }
function readBounded(root: string, file: string): Buffer {
    const real = fs.realpathSync(path.join(root, file));
    if (!inside(root, real)) invalid('Bundle artifact symlinks must remain inside the approved bundle directory.');
    const handle = fs.openSync(real, 'r');
    try {
        const before = fs.fstatSync(handle);
        if (!before.isFile() || before.size > LIMIT) prerequisite('Bundle config/index must be regular files no larger than 1 MiB.');
        const bytes = Buffer.allocUnsafe(before.size + 1);
        let count = 0;
        while (count < bytes.length) {
            const read = fs.readSync(handle, bytes, count, bytes.length - count, null);
            if (!read) break;
            count += read;
        }
        const after = fs.fstatSync(handle);
        const current = fs.statSync(real);
        if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
            || current.ino !== after.ino || current.dev !== after.dev || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs
            || fs.realpathSync(path.join(root, file)) !== real) {
            throw new ToolError({ code: 'BUNDLE_ARTIFACT_CHANGED', status: 409, message: 'Bundle artifact changed during bounded read; no load or serving dispatched.' });
        }
        return bytes.subarray(0, count);
    } finally { fs.closeSync(handle); }
}

export function resolveBundleArtifact(project: string, requested: string, name: string): BundleArtifact {
    if (typeof requested !== 'string' || requested.length > 512 || !/^build[\\/]/.test(requested) || requested.includes('\0') || path.isAbsolute(requested)) invalid('bundlePath must be an explicit project-relative build/... directory. URLs and source folders are not accepted.');
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name) || ['main', 'resources', 'internal', 'start-scene'].includes(name)) invalid('bundleName must identify a non-builtin bundle using 1..128 letters, digits, underscores or hyphens.');
    let root: string;
    try {
        const projectRoot = fs.realpathSync(project);
        const buildRoot = fs.realpathSync(path.join(projectRoot, 'build'));
        root = fs.realpathSync(path.resolve(projectRoot, requested));
        if (!inside(projectRoot, buildRoot) || !inside(buildRoot, root) || root === buildRoot) invalid('Bundle output must resolve inside the active project build directory.');
        if (!fs.statSync(root).isDirectory()) prerequisite('The requested built bundle directory is missing.');
    } catch (error) { if (error instanceof ToolError) throw error; prerequisite('The requested project-contained built bundle output is unavailable.'); }
    const candidates = fs.readdirSync(root).filter(file => /^config(?:\.[A-Za-z0-9_-]+)?\.json$/.test(file));
    if (candidates.length !== 1) prerequisite('Expected exactly one emitted config[.version].json in the bundle directory.');
    const configFile = candidates[0];
    const version = configFile === 'config.json' ? '' : configFile.slice(7, -5);
    const indexFile = `index${version ? `.${version}` : ''}.js`;
    let config: Buffer; let index: Buffer;
    try { config = readBounded(root, configFile); index = readBounded(root, indexFile); }
    catch (error) { if (error instanceof ToolError) throw error; prerequisite('The emitted bundle config and matching index script are required.'); }
    let data: Record<string, unknown>;
    try { data = JSON.parse(config.toString('utf8')) as Record<string, unknown>; }
    catch { prerequisite('The emitted bundle config is not valid JSON.'); }
    if (!data || Array.isArray(data) || data.name !== name) invalid('Emitted config.name must match the explicit bundleName.');
    const types = data.types;
    const paths = data.paths;
    if (!Array.isArray(data.deps) || data.deps.length || !Array.isArray(data.uuids) || data.uuids.length > 10000 || data.uuids.some(uuid => typeof uuid !== 'string') || types !== undefined && (!Array.isArray(types) || types.some(type => typeof type !== 'string' || !BUNDLE_RESOURCE_TYPES.some(allowed => type === `cc.${allowed}`))) || !paths || typeof paths !== 'object' || Array.isArray(paths) || Object.values(paths).some(entry => !Array.isArray(entry) || !BUNDLE_RESOURCE_TYPES.some(allowed => entry[1] === `cc.${allowed}` || Array.isArray(types) && types[entry[1]] === `cc.${allowed}`)) || Array.isArray(data.redirect) && data.redirect.length) prerequisite('Only standalone, bounded data-only bundles without external dependencies, redirects or custom asset types are supported.');
    const uuidList = data.uuids as string[];
    const uuidSet = new Set(uuidList);
    if (uuidSet.size !== uuidList.length || uuidList.some(uuid => !uuid || uuid.length > 256 || /[\u0000-\u001f\u007f]/.test(uuid))) invalid('Bundle UUID metadata must contain unique bounded nonempty identities.');
    for (const [id, entry] of Object.entries(paths as Record<string, unknown[]>)) {
        const resourcePath = entry[0];
        if (typeof resourcePath !== 'string' || !resourcePath || resourcePath.length > 256 || /[\\:\u0000-\u001f\u007f]/.test(resourcePath)
            || resourcePath.split('/').some(segment => !segment || segment === '.' || segment === '..')) invalid('Every bundle resource path must be a bounded relative forward-slash path.');
        const identityValid = data.debug === true ? uuidSet.has(id) : /^(0|[1-9][0-9]*)$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) < uuidList.length;
        if (!identityValid) invalid('Bundle resource identity must resolve through emitted UUID metadata.');
        if (typeof entry[1] !== 'string' && (!Number.isInteger(entry[1]) || (entry[1] as number) < 0 || !Array.isArray(types) || (entry[1] as number) >= types.length)) invalid('Bundle resource type index must resolve through emitted types metadata.');
    }
    for (const key of ['base', 'importBase', 'nativeBase']) {
        const value = data[key];
        if (value !== undefined && (typeof value !== 'string' || value.includes('\\') || value.includes(':') || value.startsWith('/') || value.split('/').some(segment => segment === '..' || segment === '.'))) invalid('Bundle config resource bases must remain relative to this bundle.');
    }
    // loadBundle natively downloads index.js. Permit only a data-only emitted
    // entry; never evaluate project scripts, arbitrary user code, or imports.
    const script = index.toString('utf8').trim();
    const registration = /^System\.register\((?:"virtual:\/\/\/prerequisite-imports\/([A-Za-z0-9_-]+)"|\[\]),\s*\[\],\s*function\s*\(\s*(?:_export\s*,\s*_context\s*)?\)\s*\{\s*(?:["']use strict["'];?\s*)?return\s*\{\s*setters:\s*(?:\[\]|new Array\(0\)\.fill\(\(\)\s*=>\s*\{\}\)),\s*execute:\s*function\s*\(\)\s*\{\s*\}\s*,?\s*\};?\s*\}\);?$/;
    const match = registration.exec(script);
    const generatedEntry = `System.register("chunks:///_virtual/${name}", [], function () {
        return { execute: function () {} };
    });
    (function(r) {
        r('virtual:///prerequisite-imports/${name}', 'chunks:///_virtual/${name}');
    })(function(mid, cid) {
        System.register(mid, [cid], function (_export, _context) {
            return { setters: [function(_m) {
                var _exportObj = {};
                for (var _key in _m) {
                    if (_key !== "default" && _key !== "__esModule") _exportObj[_key] = _m[_key];
                }
                _export(_exportObj);
            }], execute: function () { } };
        });
    });`;
    const compact = script.replace(/\n?\/\/# sourceMappingURL=index(?:\.[A-Za-z0-9_-]+)?\.js\.map\s*$/, '').replace(/\s/g, '');
    const generated = compact === generatedEntry.replace(/\s/g, '');
    const cocosGeneratedEntry = `System.register("chunks:///_virtual/${name}",[],(function(){return{execute:function(){}}}));`
        + `(function(r) { r('virtual:///prerequisite-imports/${name}', 'chunks:///_virtual/${name}'); })(function(mid, cid) { System.register(mid, [cid], function (_export, _context) { return { setters: [function(_m) { var _exportObj = {}; for (var _key in _m) { if (_key !== "default" && _key !== "__esModule") _exportObj[_key] = _m[_key]; } _export(_exportObj); }], execute: function () { } }; }); });`;
    const cocosGenerated = compact === cocosGeneratedEntry.replace(/\s/g, '');
    if (script && !generated && !cocosGenerated && (!match || match[1] !== undefined && match[1] !== name)) prerequisite('Bundle index must be empty or an exact emitted data-only System.register entry; project scripts are excluded.');
    return { root, name, version, configFile, indexFile, config, index };
}

export async function serveBundleArtifact(artifact: BundleArtifact): Promise<{ url: string; close(): Promise<void> }> {
    const route = `/${artifact.name}/`;
    const server = http.createServer((request, response) => {
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Cache-Control', 'no-store');
        if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
        let pathname: string;
        try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname); }
        catch { response.writeHead(400); response.end(); return; }
        if (!pathname.startsWith(route)) { response.writeHead(404); response.end(); return; }
        const relative = pathname.slice(route.length);
        if (!relative || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(segment => !segment || segment === '..' || segment === '.')) { response.writeHead(403); response.end(); return; }
        if (relative.endsWith('.js')) {
            if (relative !== artifact.indexFile) { response.writeHead(403); response.end(); return; }
            response.setHeader('Content-Type', 'application/javascript'); response.end(artifact.index); return;
        }
        if (relative === artifact.configFile) { response.setHeader('Content-Type', 'application/json'); response.end(artifact.config); return; }
        try {
            const file = fs.realpathSync(path.resolve(artifact.root, relative));
            const stat = fs.statSync(file);
            if (!inside(artifact.root, file) || !stat.isFile() || stat.size > 16 * LIMIT || !/^(?:import|native)\//.test(relative)) { response.writeHead(403); response.end(); return; }
            if (file.endsWith('.json')) response.setHeader('Content-Type', 'application/json');
            const stream = fs.createReadStream(file);
            stream.once('error', () => response.destroy()); stream.pipe(response);
        } catch { response.writeHead(404); response.end(); }
    });
    server.requestTimeout = 5000; server.headersTimeout = 5000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw new ToolError({ code: 'BUNDLE_SERVE_FAILED', status: 502, message: 'Bundle server has no verified loopback endpoint.' }); }
    return { url: `http://127.0.0.1:${address.port}${route.slice(0, -1)}`, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
