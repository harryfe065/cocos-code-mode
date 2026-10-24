import { join, normalize } from 'path';
import { homedir } from 'os';
import { connect } from 'net';
import packageJSON from '../../package.json';
import { Registry, readRegistry, mutateRegistry } from './config-transaction';

export class UtcpConfigManager {
    private static instance: UtcpConfigManager;
    private configPath = '';
    private constructor() {}
    static getInstance(): UtcpConfigManager {
        if (!this.instance) this.instance = new UtcpConfigManager();
        return this.instance;
    }
    async initialize(): Promise<void> {
        const saved = await Editor.Profile.getConfig(packageJSON.name, 'utcpConfigPath');
        this.configPath = typeof saved === 'string' && saved ? saved : join(homedir(), '.utcp_config.json');
    }
    getConfigPath(): string {
        if (!this.configPath) this.configPath = join(homedir(), '.utcp_config.json');
        return this.configPath;
    }
    async setConfigPath(path: string): Promise<void> {
        await Editor.Profile.setConfig(packageJSON.name, 'utcpConfigPath', path);
        this.configPath = path;
    }
    readConfig(): Registry { return readRegistry(this.getConfigPath()); }
    writeConfig(config: Registry): void {
        void mutateRegistry(this.getConfigPath(), (next) => {
            next.manual_call_templates = config.manual_call_templates;
            if ('variables' in config) next.variables = config.variables as Record<string, string>;
        }).catch((e) => { console.warn('[ccp][config] writeConfig failed', e); });
    }
    mutateConfig(mutator: (config: Registry) => void): Promise<boolean> {
        return mutateRegistry(this.getConfigPath(), mutator);
    }
    async ensureCocosEditorTemplate(port: number, instanceId: string, projectPath?: string): Promise<boolean> {
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{32}$/.test(instanceId)) {
            throw new Error('Publishing CCP requires a bound port and a valid instanceId.');
        }
        const closed = await this.findClosedCcpPorts();
        const project = typeof projectPath === 'string' && projectPath ? normalize(projectPath) : undefined;
        const name = 'ccp3x_' + port;
        return this.mutateConfig(config => {
            const existing = config.manual_call_templates.find(template => template.name === name
                || template.url?.replace(/\/utcp\/?$/, '') === 'http://localhost:' + port
                || template.url?.replace(/\/utcp\/?$/, '') === 'http://127.0.0.1:' + port);
            if (existing && (existing.headers || existing.auth)) {
                throw new Error('Port belongs to an authenticated project relay; select a different port.');
            }
            const templates = new Map<string, Registry['manual_call_templates'][number]>();
            const others: Registry['manual_call_templates'] = [];
            for (const template of config.manual_call_templates) {
                // Legacy migration inputs only; authenticated relays require their own protocol cutover.
                if (['cocos-pilot-3x', 'cc-bridge-3x', 'ccb3x', 'cc3x7', 'ccp-3x', 'ccp_3x'].includes(template.name)
                    || /^(?:ccb3x|cocos-pilot-3x|cc-bridge-3x)_\d+$/.test(template.name)) {
                    if (template.headers || template.auth) others.push(template);
                    continue;
                }
                if (template.name === 'ccp3x' || /^ccp3x_\d+$/.test(template.name)) {
                    if (template.headers || template.auth) {
                        others.push(template);
                        continue;
                    }
                    const url = new URL(template.url ?? '');
                    const endpointPort = Number(url.port);
                    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.protocol !== 'http:' || endpointPort < 1) {
                        throw new Error('Invalid CCP endpoint in registry.');
                    }
                    const observedOwner = closed.get(endpointPort);
                    if (!template.headers && !template.auth && endpointPort !== port && closed.has(endpointPort)
                        && config.variables?.['CCP3X_OWNER_' + endpointPort] === observedOwner) {
                        delete config.variables?.['CCP3X_OWNER_' + endpointPort];
                        delete config.variables?.['CCP3X_PROJECT_' + endpointPort];
                        continue;
                    }
                    const name = 'ccp3x_' + endpointPort;
                    templates.set(name, { ...template, name });
                } else others.push(template);
            }
            templates.set(name, {
                name, call_template_type: 'http', url: 'http://localhost:' + port + '/utcp',
                http_method: 'GET', content_type: 'application/json',
            });
            config.manual_call_templates = [...others, ...templates.values()];
            config.variables = { ...config.variables, ['CCP3X_OWNER_' + port]: instanceId };
            if (project) config.variables['CCP3X_PROJECT_' + port] = project;
        });
    }
    private async findClosedCcpPorts(): Promise<Map<number, string | undefined>> {
        const config = this.readConfig();
        const candidates = new Map<number, string>();
        for (const template of config.manual_call_templates) {
            const match = /^ccp3x_(\d+)$/.exec(template.name);
            if (template.headers || template.auth) continue;
            if (!match || typeof template.url !== 'string') continue;
            try {
                const url = new URL(template.url);
                const port = Number(match[1]);
                if (!Number.isInteger(port) || port < 1 || port > 65535 || Number(url.port || 80) !== port
                    || !['localhost', '127.0.0.1'].includes(url.hostname)) continue;
                candidates.set(port, '127.0.0.1');
            } catch { /* Invalid endpoints are rejected by the locked mutation. */ }
        }
        const results = await Promise.all([...candidates].map(async ([port, host]) => ({
            port, closed: await this.isLoopbackPortClosed(host, port), owner: config.variables?.['CCP3X_OWNER_' + port],
        })));
        return new Map(results.filter(result => result.closed).map(result => [result.port, result.owner]));
    }
    private isLoopbackPortClosed(host: string, port: number): Promise<boolean> {
        // Creator 3.7's Node runtime has no Promise.withResolvers.
        return new Promise(resolve => {
            const socket = connect({ host, port });
            let settled = false;
            const finish = (closed: boolean) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                resolve(closed);
            };
            socket.setTimeout(250, () => finish(false));
            socket.once('connect', () => finish(false));
            socket.once('error', error => finish(error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED'));
        });
    }
    async removeCocosEditorTemplate(port: number, instanceId: string, configPath = this.getConfigPath()): Promise<boolean> {
        return mutateRegistry(configPath, config => {
            const key = 'CCP3X_OWNER_' + port;
            if (!instanceId || config.variables?.[key] !== instanceId) return;
            const template = config.manual_call_templates.find(t => t.name === 'ccp3x_' + port);
            if (template?.headers || template?.auth) return;
            config.manual_call_templates = config.manual_call_templates.filter(t => t.name !== 'ccp3x_' + port);
            delete config.variables[key];
            delete config.variables?.['CCP3X_PROJECT_' + port];
        });
    }
    async getCurrentPort(): Promise<number> {
        const port = await Editor.Profile.getConfig(packageJSON.name, 'fixedServerPort');
        if (port === undefined || port === null) return 0;
        // Older generic preference writes could persist the numeric port as a string; canonicalize it once.
        const normalized = typeof port === 'string' && /^\d+$/.test(port.trim()) ? Number(port.trim()) : port;
        if (typeof normalized === 'number' && Number.isInteger(normalized) && normalized >= 0 && normalized <= 65535) {
            if (normalized !== port) await Editor.Profile.setConfig(packageJSON.name, 'fixedServerPort', normalized);
            return normalized;
        }
        console.warn('[cx3][config] Invalid fixedServerPort preference; resetting to automatic port selection.');
        try { await Editor.Profile.setConfig(packageJSON.name, 'fixedServerPort', 0); }
        catch (error) { console.warn(`[cx3][config] Could not reset fixedServerPort: ${error instanceof Error ? error.message : String(error)}`); }
        return 0;
    }
    async setConfiguredPort(port: number): Promise<void> {
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
        await Editor.Profile.setConfig(packageJSON.name, 'fixedServerPort', port);
    }
    async getLastAutoPort(): Promise<number> {
        const port = await Editor.Profile.getConfig(packageJSON.name, 'lastAutoServerPort');
        return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
    }
    async setLastAutoPort(port: number): Promise<void> {
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Auto port must be a bound port.');
        await Editor.Profile.setConfig(packageJSON.name, 'lastAutoServerPort', port);
    }
    async updatePort(port: number, instanceId: string): Promise<void> {
        await this.ensureCocosEditorTemplate(port, instanceId, typeof Editor.Project?.path === 'string' ? Editor.Project.path : undefined);
    }
    async getToolProfileConfig(): Promise<{ profile: string, enabled: string[], disabled: string[], envelope: boolean }> {
        const profile = await Editor.Profile.getConfig(packageJSON.name, 'toolProfile') as string || 'full';
        const enabled = await Editor.Profile.getConfig(packageJSON.name, 'enabledTools') as string[] || [];
        const disabled = await Editor.Profile.getConfig(packageJSON.name, 'disabledTools') as string[] || [];
        const envelope = await Editor.Profile.getConfig(packageJSON.name, 'responseEnvelope') as boolean || false;
        return { profile, enabled, disabled, envelope };
    }
    async setToolProfileConfig(config: { profile: string, enabled: string[], disabled: string[], envelope: boolean }): Promise<void> {
        await Editor.Profile.setConfig(packageJSON.name, 'toolProfile', config.profile);
        await Editor.Profile.setConfig(packageJSON.name, 'enabledTools', config.enabled);
        await Editor.Profile.setConfig(packageJSON.name, 'disabledTools', config.disabled);
        await Editor.Profile.setConfig(packageJSON.name, 'responseEnvelope', config.envelope);
        console.log(`[cx3][config] Tool profile config saved: profile=${config.profile}, envelope=${config.envelope}`);
    }
}
export function getConfigManager(): UtcpConfigManager { return UtcpConfigManager.getInstance(); }
