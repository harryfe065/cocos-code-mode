import packageJSON from '../../../package.json';

export interface StatusSession {
    sessionId: string; label: string | null; transport: 'http-helper' | 'code-mode';
    lastSeen: number; ageMs: number; status: 'Active' | 'Stale' | 'Expired';
}

export interface StatusActivity {
    activeCount: number;
    active: Array<{ requestId: string; tool: string; startedAt: number; ageMs: number }>;
    overflowCount: number;
    lastReceived: { tool: string; receivedAt: number; ageMs: number } | null;
    recentFinished: Array<{ requestId: string; tool: string; outcome: 'completed' | 'failed'; status: number; finishedAt: number; durationMs: number }>;
}

export interface Status {
    checkedAt: number;
    build: { version: string; commit: string; branch: string; dirty: boolean; builtAt: string };
    projectPath: string | null;
    editorVersion: string | null;
    server: {
        running: boolean; port: number; instanceId: string | null;
        namespace: string | null; url: string | null; debug: boolean;
        logging: { server: boolean; scene: 'enabled' | 'disabled' | 'unavailable' | 'error' | 'unknown'; logDirectory: string | null; logFile: string | null };
    };
    registry: { path: string; status: 'matched' | 'missing' | 'mismatch' | 'error' | 'not-running'; detail: string | null };
    http: { status: 'ok' | 'error' | 'not-running'; detail: string | null };
    probe: { status: string; sceneReady: boolean | null; code: string | null } | null;
    sessions: StatusSession[];
    activity: StatusActivity;
    startupFailure: { code: string; message: string; requestedPort: number; recoverable: boolean; occurredAt: number } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableText(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}
function isStatusActivity(value: unknown): value is StatusActivity {
    if (!isRecord(value) || typeof value.activeCount !== 'number' || !Number.isInteger(value.activeCount) || value.activeCount < 0
        || !Array.isArray(value.active) || value.active.length > 20
        || !value.active.every((entry) => isRecord(entry)
            && typeof entry.requestId === 'string' && entry.requestId.length > 0 && entry.requestId.length <= 32
            && typeof entry.tool === 'string' && entry.tool.length > 0 && entry.tool.length <= 128
            && typeof entry.startedAt === 'number' && Number.isInteger(entry.startedAt) && entry.startedAt > 0
            && typeof entry.ageMs === 'number' && Number.isFinite(entry.ageMs) && entry.ageMs >= 0)
        || typeof value.overflowCount !== 'number' || !Number.isInteger(value.overflowCount) || value.overflowCount < 0) return false;
    if (value.lastReceived !== null && (!isRecord(value.lastReceived)
        || typeof value.lastReceived.tool !== 'string' || value.lastReceived.tool.length < 1 || value.lastReceived.tool.length > 128
        || typeof value.lastReceived.receivedAt !== 'number' || !Number.isInteger(value.lastReceived.receivedAt) || value.lastReceived.receivedAt <= 0
        || typeof value.lastReceived.ageMs !== 'number' || !Number.isFinite(value.lastReceived.ageMs) || value.lastReceived.ageMs < 0)) return false;
    return Array.isArray(value.recentFinished) && value.recentFinished.length <= 20 && value.recentFinished.every((entry) => isRecord(entry)
        && typeof entry.requestId === 'string' && entry.requestId.length > 0 && entry.requestId.length <= 32
        && typeof entry.tool === 'string' && entry.tool.length > 0 && entry.tool.length <= 128
        && (entry.outcome === 'completed' || entry.outcome === 'failed')
        && typeof entry.status === 'number' && Number.isInteger(entry.status) && entry.status >= 100 && entry.status <= 599
        && typeof entry.finishedAt === 'number' && Number.isInteger(entry.finishedAt) && entry.finishedAt > 0
        && typeof entry.durationMs === 'number' && Number.isInteger(entry.durationMs) && entry.durationMs >= 0);
}

export function isStatus(value: unknown): value is Status {
    if (!isRecord(value)) return false;
    const { checkedAt, build, server, registry, http, probe, sessions, activity, startupFailure } = value;
    return typeof checkedAt === 'number' && Number.isInteger(checkedAt) && checkedAt > 0 && checkedAt <= 8640000000000000
        && isRecord(build) && typeof build.version === 'string' && typeof build.commit === 'string'
        && typeof build.branch === 'string' && typeof build.dirty === 'boolean' && typeof build.builtAt === 'string'
        && isRecord(server) && typeof server.running === 'boolean'
        && typeof server.port === 'number' && Number.isInteger(server.port) && server.port >= 0 && server.port <= 65535
        && isNullableText(server.instanceId) && isNullableText(server.namespace) && isNullableText(server.url) && typeof server.debug === 'boolean'
        && isRecord(server.logging) && typeof server.logging.server === 'boolean'
        && (server.logging.scene === 'enabled' || server.logging.scene === 'disabled' || server.logging.scene === 'unavailable' || server.logging.scene === 'error' || server.logging.scene === 'unknown')
        && isNullableText(server.logging.logDirectory) && isNullableText(server.logging.logFile)
        && isRecord(registry) && typeof registry.path === 'string' && isNullableText(registry.detail)
        && (registry.status === 'matched' || registry.status === 'missing' || registry.status === 'mismatch' || registry.status === 'error' || registry.status === 'not-running')
        && isRecord(http) && (http.status === 'ok' || http.status === 'error' || http.status === 'not-running') && isNullableText(http.detail)
        && (probe === null || (isRecord(probe) && typeof probe.status === 'string'
            && (probe.sceneReady === null || typeof probe.sceneReady === 'boolean') && isNullableText(probe.code)))
        && Array.isArray(sessions) && sessions.length <= 100 && sessions.every((session) => isRecord(session)
            && typeof session.sessionId === 'string' && session.sessionId.length > 0 && session.sessionId.length <= 128
            && isNullableText(session.label) && (session.label === null || session.label.length <= 256)
            && (session.transport === 'http-helper' || session.transport === 'code-mode')
            && typeof session.lastSeen === 'number' && Number.isFinite(session.lastSeen)
            && typeof session.ageMs === 'number' && Number.isFinite(session.ageMs) && session.ageMs >= 0
            && (session.status === 'Active' || session.status === 'Stale' || session.status === 'Expired'))
        && (startupFailure === null || (isRecord(startupFailure)
            && typeof startupFailure.code === 'string' && startupFailure.code.length > 0 && startupFailure.code.length <= 64
            && typeof startupFailure.message === 'string' && startupFailure.message.length > 0 && startupFailure.message.length <= 512
            && typeof startupFailure.requestedPort === 'number' && Number.isInteger(startupFailure.requestedPort) && startupFailure.requestedPort >= 0 && startupFailure.requestedPort <= 65535
            && typeof startupFailure.recoverable === 'boolean'
            && typeof startupFailure.occurredAt === 'number' && Number.isInteger(startupFailure.occurredAt) && startupFailure.occurredAt > 0))
        && isStatusActivity(activity);
}
const registryLabels = { matched: 'Matched this instance', missing: 'Missing', mismatch: 'Mismatch', error: 'Error', 'not-running': 'Not checked — server stopped' };
const httpLabels = { ok: 'Verified this instance', error: 'Error', 'not-running': 'Not checked — server stopped' };
export function formatElapsed(ageMs: number): string {
    const seconds = Math.floor(ageMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
}
export function renderStatus(container: HTMLElement, snapshot: Status | null): void {
    const build = snapshot?.build;
    const server = snapshot?.server;
    const probe = snapshot?.probe;
    const sessionRows: Array<[string, string]> = [['Meaning', 'Caller-reported heartbeat presence, not model activity or verified Code Mode connectivity. Check Status to refresh.']];
    if (!snapshot?.sessions.length) sessionRows.push(['Sessions', 'No session heartbeat observed']);
    for (const session of snapshot?.sessions ?? []) {
        sessionRows.push([session.label || session.sessionId,
            `${session.status} — ${session.transport} (caller-reported)\nSession: ${session.sessionId}\nLast seen: ${new Date(session.lastSeen).toLocaleString()}\nAge: ${Math.floor(session.ageMs / 1000)}s`]);
    }
    const activeSessionCount = snapshot?.sessions.filter((session) => session.status === 'Active').length ?? 0;
    const staleSessionCount = snapshot?.sessions.filter((session) => session.status === 'Stale').length ?? 0;
    const expiredSessionCount = snapshot?.sessions.filter((session) => session.status === 'Expired').length ?? 0;
    const activityRows: Array<[string, string]> = snapshot ? [
        ['State', snapshot.activity.activeCount > 0 ? `Processing — ${snapshot.activity.activeCount} request${snapshot.activity.activeCount === 1 ? '' : 's'}` : 'Ready · Idle'],
        ['Active requests', `${snapshot.activity.activeCount}${snapshot.activity.overflowCount ? ` (+${snapshot.activity.overflowCount} hidden)` : ''}`],
        ['Sessions', `${activeSessionCount} active · ${staleSessionCount} stale · ${expiredSessionCount} expired`],
        ['Since last tool request', snapshot.activity.lastReceived ? `${formatElapsed(snapshot.activity.lastReceived.ageMs)} ago · ${snapshot.activity.lastReceived.tool}` : 'No tool request received'],
    ] : [['State', 'Unavailable']];
    const startup = snapshot?.startupFailure;
    const groups: Array<[string, Array<[string, string | null | undefined]>]> = [
        ['Operational status', activityRows],
        ['Recent requests (latest 20)', []],
        ['Session connections', sessionRows],
        ['Server', [
            ['State', server ? (server.running ? 'Running' : 'Stopped') : null],
            ['Port', server ? String(server.port) : null], ['URL', server?.url],
        ]],
        ['Startup recovery', [
            ['State', startup ? (startup.recoverable ? 'Action available' : 'Manual investigation required') : 'No startup failure'],
            ['Code', startup?.code],
            ['Requested port', startup ? String(startup.requestedPort) : null],
            ['Detail', startup?.message],
        ]],
        ['Logging', [
            ['Interaction log', server?.logging.server ? 'Verbose logging ON' : 'Warnings/errors only'],
            ['Scene console', server?.logging.scene === 'enabled' ? 'Captured' : server?.logging.scene === 'disabled' ? 'Disabled' : server?.logging.scene === 'unknown' ? 'Not checked' : `Unavailable (${server?.logging.scene})`],
            ['Log file', server?.logging.logFile],
        ]],
        ['Project & editor', [['Project path', snapshot?.projectPath], ['Creator version', snapshot?.editorVersion]]],
        ['HTTP handshake', [['State', snapshot ? httpLabels[snapshot.http.status] : null], ['Detail', snapshot?.http.detail]]],
        ['Scene probe', [
            ['Status', probe?.status ?? (server && !server.running ? 'Not checked — server stopped' : 'Unavailable — no verified probe')],
            ['Scene ready', probe?.sceneReady === null || probe?.sceneReady === undefined ? null : (probe.sceneReady ? 'Yes' : 'No')], ['Code', probe?.code],
        ]],
        ['Technical details', [
            ['Extension', packageJSON.name], ['Version', build?.version], ['Commit', build?.commit],
            ['Branch', build?.branch], ['Working tree', build ? (build.dirty ? 'Modified at build time' : 'Clean at build time') : null], ['Built at', build?.builtAt],
            ['Instance ID', server?.instanceId], ['Namespace', server?.namespace],
            ['Registry state', snapshot ? registryLabels[snapshot.registry.status] : null], ['Registry path', snapshot?.registry.path], ['Registry detail', snapshot?.registry.detail],
        ]],
    ];
    const document = container.ownerDocument;
    const fragment = document.createDocumentFragment();
    const requestListFocused = container.ownerDocument.activeElement === container.querySelector('.request-list');
    const requestScrollTop = container.querySelector('.request-list')?.scrollTop ?? 0;
    const expanded = container.querySelector('details')?.open ?? false;
    for (const [heading, rows] of groups) {
        const technical = heading === 'Technical details';
        const section = document.createElement(technical ? 'details' : 'section');
        if (technical) (section as HTMLDetailsElement).open = expanded;
        const title = document.createElement(technical ? 'summary' : 'h2');
        title.textContent = heading;
        if (heading === 'Recent requests (latest 20)') {
            const list = document.createElement('ol');
            list.className = 'request-list';
            list.setAttribute('aria-label', 'Recent completed tool requests, newest first');
            list.tabIndex = 0;
            for (const entry of snapshot?.activity.recentFinished ?? []) {
                const item = document.createElement('li');
                const time = document.createElement('time');
                time.dateTime = new Date(entry.finishedAt).toISOString();
                time.textContent = new Date(entry.finishedAt).toLocaleTimeString();
                const tool = document.createElement('span');
                tool.className = 'request-tool';
                tool.textContent = entry.tool;
                const result = document.createElement('span');
                result.textContent = `${entry.outcome} · ${entry.status} · ${entry.durationMs}ms`;
                item.title = `${time.textContent} · ${entry.tool} · ${result.textContent}`;
                item.append(time, tool, result);
                list.append(item);
            }
            if (!list.children.length) {
                const empty = document.createElement('li');
                empty.textContent = 'No completed tool requests yet';
                list.append(empty);
            }
            section.append(title, list);
        } else {
            const list = document.createElement('dl');
            for (const [label, value] of rows) {
                const term = document.createElement('dt');
                term.textContent = label;
                const detail = document.createElement('dd');
                detail.textContent = value?.trim() || 'Unavailable';
                list.append(term, detail);
            }
            section.append(title, list);
        }
        fragment.append(section);
    }
    container.replaceChildren(fragment);
    const requestList = container.querySelector('.request-list');
    if (requestList) requestList.scrollTop = requestScrollTop;
    if (requestListFocused) (requestList as HTMLElement | null)?.focus();
}
