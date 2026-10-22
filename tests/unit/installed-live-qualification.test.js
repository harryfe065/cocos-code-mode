'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { signedEvents, sha, scan } = require('../../scripts/installed-live-qualification');
const { request, materialize } = require('../../scripts/run-installed-live-qualification');
const { creditOperation } = require('../../scripts/verify-installed-live-qualification');
const { LocalHttpServer, sendJson, bindJsonWitness } = require('../../dist/utcp/http-server');
const { QualificationTraceRecorder } = require('../../dist/protected/qualification-trace');
function directory() { const dir = fs.mkdtempSync(path.join(os.homedir(), '.ccp-installed-live-test-')); return dir; }
function identity() {
  const keys = crypto.generateKeyPairSync('ed25519'); const publicKeyDer = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  return { keys, publicKeyDer, deviceKeyId: 'device-' + sha(Buffer.from(publicKeyDer, 'base64url')).slice(0, 24), deviceId: crypto.randomUUID() };
}
test('source fixture relabeling, unsigned live rows, signature tampering and replay cannot satisfy installed-live reader', () => {
  const dir = directory(); const file = path.join(dir, 'live.ndjson'); const id = identity(); const runId = crypto.randomUUID(); const binding = { packageHash: 'a'.repeat(64), targetPayloadHash: 'b'.repeat(64) };
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, evidenceScope: 'installed-live', traceComplete: true }) + '\n');
  assert.throws(() => signedEvents(file, id, runId, binding), /unsigned or source-only/);
  const event = { schemaVersion: 1, evidenceScope: 'installed-live', runId, evidenceErrors: [], type: 'http-result', binding: { ...binding, deviceId: id.deviceId, publicKeyDer: id.publicKeyDer } };
  const payload = Buffer.from(JSON.stringify(event));
  const wrapper = { keyId: id.deviceKeyId, payload: payload.toString('base64'), signature: crypto.sign(null, Buffer.concat([Buffer.from('CCP1 installed-live-witness\n'), payload]), id.keys.privateKey).toString('base64') };
  fs.writeFileSync(file, JSON.stringify(wrapper) + '\n');
  assert.equal(signedEvents(file, id, runId, binding).events.length, 1);
  assert.throws(() => signedEvents(file, id, crypto.randomUUID(), binding), /binding/);
  wrapper.payload = Buffer.from(JSON.stringify({ ...event, type: 'protected-dispatch' })).toString('base64');
  fs.writeFileSync(file, JSON.stringify(wrapper) + '\n');
  assert.throws(() => signedEvents(file, id, runId, binding), /forged/);
});
test('real post-serialization HTTP error bytes are independently hashed and signed without retaining payload', async () => {
  const dir = directory(); const id = identity(); const runId = crypto.randomUUID();
  const previous = { run: process.env.CCP_QUALIFICATION_LIVE_RUN_ID, file: process.env.CCP_QUALIFICATION_LIVE_TRACE_PATH };
  process.env.CCP_QUALIFICATION_LIVE_RUN_ID = runId; process.env.CCP_QUALIFICATION_LIVE_TRACE_PATH = path.join(dir, 'live.ndjson');
  const recorder = new QualificationTraceRecorder(path.join(dir, 'source.ndjson'));
  const binding = { packageHash: 'a'.repeat(64), targetPayloadHash: 'b'.repeat(64), deviceId: id.deviceId, publicKeyDer: id.publicKeyDer };
  recorder.configureLive(id.keys.privateKey, id.deviceKeyId, binding);
  const auth = { relayInstanceId: crypto.randomUUID(), token: 'x'.repeat(43), tokenPath: 'unused', variableName: 'CCP_LOCAL_TOKEN' };
  const server = new LocalHttpServer(auth); const callId = crypto.randomUUID();
  server.route('POST', '/denied', ({ response }) => {
    bindJsonWitness(response, (status, bytes, finished) => recorder.httpResult(callId, null, 'nodeCreate', status, bytes, finished));
    sendJson(response, 422, { code: 'CCP_PROJECT_DENIED', error: 'PRIVATE_RESULT_MUST_NOT_RETAIN' });
  });
  const port = await server.listen(0);
  try {
    const result = await request(port, '/denied', 'POST', { 'x-ccp-local-token': auth.token, 'x-ccp-relay-instance': auth.relayInstanceId }, {});
    const signed = signedEvents(process.env.CCP_QUALIFICATION_LIVE_TRACE_PATH, id, runId, binding); const event = signed.events[0];
    assert.equal(event.finished, true); assert.equal(event.status, 422); assert.equal(event.sha256, result.sha256); assert.equal(event.bytes, result.bytes);
    assert.equal(Buffer.from(JSON.parse(fs.readFileSync(process.env.CCP_QUALIFICATION_LIVE_TRACE_PATH, 'utf8')).payload, 'base64').includes(Buffer.from('PRIVATE_RESULT_MUST_NOT_RETAIN')), false);
    result.sha256 = 'c'.repeat(64);
    const credit = creditOperation({ id: 'denied', callId, toolId: 'nodeCreate', http: result }, { expectedOutcome: 'denied' }, signed.events, {});
    assert.equal(credit.pass, false); assert.match(credit.gaps.join(','), /HTTP client\/server boundary mismatch/);
  } finally {
    await server.close(); recorder.close();
    for (const [name, value] of [['CCP_QUALIFICATION_LIVE_RUN_ID', previous.run], ['CCP_QUALIFICATION_LIVE_TRACE_PATH', previous.file]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
test('truncated and non-JSON HTTP results cannot become measured successes', async () => {
  const server = require('node:http').createServer((req, res) => { res.setHeader('content-type', 'application/json'); if (req.url === '/invalid') res.end('not-json'); else { res.setHeader('content-length', '100'); res.end('{}'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(request(server.address().port, '/invalid'), /not valid JSON/); await assert.rejects(request(server.address().port, '/truncated'), /aborted|boundary/); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
test('actual scenario references fail closed rather than substituting made-up node IDs', () => {
  const results = new Map([['create', { node: { uuid: 'actual-node' } }]]);
  assert.deepEqual(materialize({ reference: { id: { $result: 'create/node/uuid' } } }, results), { reference: { id: 'actual-node' } });
  assert.throws(() => materialize({ $result: 'create/node/missing' }, results), /unavailable/);
});
test('surface scan rejects planted forbidden canary and missing mandatory capture', () => {
  const dir = directory(); const markersPath = path.join(dir, 'markers.json'); const surfacesPath = path.join(dir, 'surfaces.json');
  const surfaces = ['gateway-db-snapshot', 'gateway-logs', 'metrics', 'relay-logs', 'update-state', 'support-bundle'].map(name => { const root = path.join(dir, name); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'actual.txt'), 'captured evidence'); return { name, root }; });
  fs.writeFileSync(markersPath, JSON.stringify([{ label: 'private', value: 'FORBIDDEN_CANARY_1234', allowedSurfaces: [], allowedInGatewayRequest: false, sourceKind: 'local-result' }]));
  fs.writeFileSync(surfacesPath, JSON.stringify(surfaces));
  assert.equal(scan({ markersPath, surfacesPath }, [markersPath, surfacesPath]).reports.length, 6);
  fs.writeFileSync(path.join(surfaces[1].root, 'actual.txt'), 'FORBIDDEN_CANARY_1234');
  assert.throws(() => scan({ markersPath, surfacesPath }, [markersPath, surfacesPath]), /forbidden canary/);
  fs.writeFileSync(surfacesPath, JSON.stringify(surfaces.slice(1)));
  assert.throws(() => scan({ markersPath, surfacesPath }, [markersPath, surfacesPath]), /unavailable/);
});
test('signed canonical key ordering does not invalidate an independently matched actual screenshot', () => {
  const operation = { id: 'screenshot', toolId: 'captureSceneScreenshot', callId: 'call', http: { status: 200, bytes: 200, sha256: 'a'.repeat(64) }, screenshot: { bytes: 100, sha256: 'b'.repeat(64), mimeType: 'image/jpeg' } };
  const event = { type: 'http-result', toolId: operation.toolId, callId: 'call', requestId: null, status: 200, bytes: 200, sha256: 'a'.repeat(64), finished: true, resultBoundary: 'local-http-response-bytes', screenshot: { bytes: 100, mimeType: 'image/jpeg', sha256: 'b'.repeat(64) } };
  assert.equal(creditOperation(operation, { workflow: 'local-screenshot' }, [event], {}).pass, true);
  event.screenshot.sha256 = 'c'.repeat(64);
  assert.equal(creditOperation(operation, { workflow: 'local-screenshot' }, [event], {}).pass, false);
});
test('bounded pointer audit leaves projection unverified without discarding separately measured Creator execution', () => {
  const run = { connection: { gateway: { projectId: 'project' }, relayInstanceId: 'relay' }, packageBinding: { packageHash: 'a'.repeat(64), version: 'version' }, identity: { creatorVersion: '3.7.3' } };
  const operation = { id: 'create', toolId: 'nodeCreate', callId: 'call', inputSha256: 'b'.repeat(64), http: { status: 200, bytes: 50, sha256: 'c'.repeat(64) } };
  const record = { schemaVersion: 2, traceComplete: false, request: { pointerTruncated: true }, evidenceErrors: [], requestId: 'request', toolId: 'nodeCreate', outcome: 'completed', kind: 'execute', inputSha256: operation.inputSha256, binding: { projectId: 'project', relayInstanceId: 'relay', relay: { packageHash: run.packageBinding.packageHash, build: 'version', creatorVersion: '3.7.3' } }, creator: { observationIpc: 2, postGatewayIpc: 4, totalIpc: 6 }, gateway: { requests: 1, responses: 1, responseBytes: 200, responseSha256: 'd'.repeat(64), concurrent: false, requestsDuringExecution: 0, responsesDuringExecution: 0 }, phases: { 'request-built': 0, 'transport-send': 1, 'transport-response': 2, 'decision-verified': 3, 'execution-start': 4, 'execution-finish': 5, 'result-serialized': 6 }, durationMs: 7, executionCommandCount: 1, result: { bytes: 50, sha256: 'c'.repeat(64) } };
  const boundary = { type: 'http-result', toolId: operation.toolId, callId: 'call', requestId: 'request', status: 200, bytes: 50, sha256: operation.http.sha256, finished: true, resultBoundary: 'local-http-response-bytes' };
  const events = [{ type: 'protected-dispatch', callId: 'call', record }, boundary];
  const credit = creditOperation(operation, { workflow: 'mutation', expectedOutcome: 'completed' }, events, run);
  assert.equal(credit.pass, true); assert.equal(credit.observed.payloadProjectionVerified, false);
  record.creator.postGatewayIpc = null;
  assert.equal(creditOperation(operation, { workflow: 'mutation', expectedOutcome: 'completed' }, events, run).pass, false);
});
test('denied mutation credits actual zero effect IPC while retaining measured upfront observation IPC', () => {
  const run = { connection: { gateway: { projectId: 'project' }, relayInstanceId: 'relay' }, packageBinding: { packageHash: 'a'.repeat(64), version: 'version' }, identity: { creatorVersion: '3.7.3' } };
  const operation = { id: 'denied', toolId: 'nodeCreate', callId: 'call', inputSha256: 'b'.repeat(64), errorCode: 'CCP_PROJECT_DENIED', http: { status: 422, bytes: 50, sha256: 'c'.repeat(64) } };
  const record = { schemaVersion: 2, traceComplete: true, request: { pointerTruncated: false }, evidenceErrors: [], requestId: 'request', toolId: 'nodeCreate', outcome: 'denied', kind: 'denied', errorCode: 'CCP_PROJECT_DENIED', inputSha256: operation.inputSha256, binding: { projectId: 'project', relayInstanceId: 'relay', relay: { packageHash: run.packageBinding.packageHash, build: 'version', creatorVersion: '3.7.3' } }, creator: { observationIpc: 2, postGatewayIpc: 0, totalIpc: 2 }, gateway: { requests: 1, responses: 1, responseBytes: 200, responseSha256: 'd'.repeat(64), concurrent: false, requestsDuringExecution: null, responsesDuringExecution: null }, phases: { 'request-built': 0, 'transport-send': 1, 'transport-response': 2 }, durationMs: 3, result: null };
  const boundary = { type: 'http-result', toolId: operation.toolId, callId: 'call', requestId: 'request', status: 422, bytes: 50, sha256: operation.http.sha256, finished: true, resultBoundary: 'local-http-response-bytes' };
  const events = [{ type: 'protected-dispatch', callId: 'call', record }, boundary];
  const credit = creditOperation(operation, { workflow: 'mutation', expectedOutcome: 'denied' }, events, run);
  assert.equal(credit.pass, true); assert.deepEqual(credit.observed.creator, { observationIpc: 2, postGatewayIpc: 0, totalIpc: 2 });
  record.creator.postGatewayIpc = 1; record.creator.totalIpc = 3;
  assert.equal(creditOperation(operation, { workflow: 'mutation', expectedOutcome: 'denied' }, events, run).pass, false);
});
