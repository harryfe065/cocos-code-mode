import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { ToolError } from './tool-error';

export interface BuildOutputManifestArgs { taskId: string | number; expectedFiles: string[]; maxBytes?: number }
export interface BuildOutputManifest { taskId: string; platform: string; state: 'success'; artifactPath: string; files: Array<{ path: string; bytes: number; sha256: string }>; totalBytes: number; producerVerified: false; verificationScope: string }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function inside(root: string, target: string): boolean { const relative = path.relative(root, target); return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); }
function invalid(message: string): never { throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message }); }

/** Task options identify the output folder; they do not prove this task produced every byte. */
export async function inspectBuildOutputManifest(args: BuildOutputManifestArgs): Promise<BuildOutputManifest> {
    const id = typeof args?.taskId === 'number' && Number.isSafeInteger(args.taskId) && args.taskId >= 0 ? String(args.taskId) : args?.taskId;
    const maxBytes = args?.maxBytes ?? 32 * 1024 * 1024;
    if (typeof id !== 'string' || !id || id.length > 256 || /[\s\x00-\x1f\x7f]/.test(id)
        || !Array.isArray(args.expectedFiles) || args.expectedFiles.length < 1 || args.expectedFiles.length > 64 || new Set(args.expectedFiles).size !== args.expectedFiles.length
        || args.expectedFiles.some(file => typeof file !== 'string' || !file || file.length > 512 || /[\x00-\x1f\x7f]/.test(file) || path.isAbsolute(file) || path.win32.isAbsolute(file) || file.split(/[\\/]/).includes('..'))
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) invalid('Provide exact taskId,1..64 relative expectedFiles and maxBytes1..268435456.');
    const projectValue: unknown = Editor.Project?.path;
    if (typeof projectValue !== 'string' || !projectValue) throw new ToolError({ code: 'PROJECT_UNAVAILABLE', status: 503, message: 'No current Creator project.' });
    const before: unknown = await Editor.Message.request('builder', 'query-task', id);
    if (!object(before) || !object(before.options)) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Task with authoritative output options not found.' });
    if (String(before.id) !== id || before.state !== 'success') throw new ToolError({ code: 'BUILD_TASK_NOT_SUCCESSFUL', status: 409, message: 'An exact successful build task is required.' });
    const options = JSON.parse(JSON.stringify(before.options)) as Record<string, unknown>;
    if (typeof options.buildPath !== 'string' || !options.buildPath || typeof options.outputName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.outputName)
        || options.outputName === '.' || options.outputName === '..' || typeof options.platform !== 'string' || !options.platform || options.platform.length > 64) {
        throw new ToolError({ code: 'BUILD_OUTPUT_IDENTITY_UNAVAILABLE', status: 422, message: 'Task outputName/buildPath/platform identity is unavailable.' });
    }
    const root = await fs.realpath(projectValue);
    const buildPath = options.buildPath.startsWith('project://') ? path.resolve(root, options.buildPath.slice('project://'.length)) : path.resolve(root, options.buildPath);
    const output = path.resolve(buildPath, options.outputName);
    if (!inside(root, output) || output === root) invalid('Task output must be a contained project directory.');
    const realOutput = await fs.realpath(output);
    if (!inside(root, realOutput) || path.relative(root, output) !== path.relative(root, realOutput)) throw new ToolError({ code: 'BUILD_OUTPUT_PATH_UNSAFE', status: 422, message: 'Task output resolves through a link or outside project.' });
    const files: BuildOutputManifest['files'] = [];
    let totalBytes = 0;
    for (const relative of args.expectedFiles) {
        const target = path.resolve(realOutput, relative);
        if (!inside(realOutput, target) || target === realOutput) invalid('Expected file must remain under task output.');
        const realTarget = await fs.realpath(target);
        if (path.relative(realOutput, target) !== path.relative(realOutput, realTarget) || !inside(realOutput, realTarget)) throw new ToolError({ code: 'BUILD_OUTPUT_PATH_UNSAFE', status: 422, message: 'Expected file resolves through a link.' });
        const stat = await fs.stat(realTarget);
        if (!stat.isFile()) throw new ToolError({ code: 'BUILD_OUTPUT_MISSING', status: 404, message: 'Expected output is not a file.' });
        if (totalBytes + stat.size > maxBytes) throw new ToolError({ code: 'BUILD_OUTPUT_LIMIT', status: 413, message: 'Expected output exceeds total hash byte budget.' });
        const handle = await fs.open(realTarget, 'r');
        try {
            const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(65536); let readBytes = 0;
            for (;;) {
                const { bytesRead } = await fs.read(handle, buffer, 0, buffer.length, null);
                if (!bytesRead) break;
                readBytes += bytesRead;
                if (totalBytes + readBytes > maxBytes) throw new ToolError({ code: 'BUILD_OUTPUT_LIMIT', status: 413, message: 'Output grew past hash byte budget.' });
                hash.update(buffer.subarray(0, bytesRead));
            }
            const afterStat = await fs.fstat(handle);
            const currentStat = await fs.stat(realTarget);
            if (readBytes !== stat.size || afterStat.size !== stat.size || afterStat.mtimeMs !== stat.mtimeMs || afterStat.ino !== stat.ino || afterStat.dev !== stat.dev
                || currentStat.ino !== afterStat.ino || currentStat.dev !== afterStat.dev || currentStat.size !== afterStat.size || currentStat.mtimeMs !== afterStat.mtimeMs
                || await fs.realpath(target) !== realTarget) throw new ToolError({ code: 'BUILD_OUTPUT_CHANGED', status: 409, message: 'Output changed or was replaced while hashing; no stable manifest claimed.' });
            totalBytes += readBytes;
            files.push({ path: relative.replace(/\\/g, '/'), bytes: readBytes, sha256: hash.digest('hex') });
        } finally { await fs.close(handle); }
    }
    const after: unknown = await Editor.Message.request('builder', 'query-task', id);
    const afterOptions = object(after) && object(after.options) ? JSON.parse(JSON.stringify(after.options)) as Record<string, unknown> : null;
    if (!object(after) || String(after.id) !== id || after.state !== before.state || !afterOptions || !isDeepStrictEqual(afterOptions, options)) throw new ToolError({ code: 'BUILD_TASK_CHANGED', status: 409, message: 'Task identity/options changed during output inspection.' });
    return { taskId: id, platform: options.platform, state: 'success', artifactPath: path.relative(root, realOutput).replace(/\\/g, '/'), files, totalBytes, producerVerified: false,
        verificationScope: 'Successful task options identify output; stable expected-file bytes/hash observed. Producer freshness, package/device/runtime correctness are not inferred.' };
}
