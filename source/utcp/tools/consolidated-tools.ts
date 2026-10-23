import { ToolError } from '../tool-error';
import { utcpTool } from '../decorators';
import { InstanceReferenceSchema, IInstanceReference, ISuccessIndicator, SuccessIndicatorSchema } from '../schemas';
import { ToolsUtils } from '../utils/tools-utils';
import { discoverEngineApi } from '../../engine-api-discovery';
import { GetClassInfoTool } from './typescript-defenition';
import { EditorTools } from './editor-tools';

// Consolidated tools — preferred entry points that replace groups of legacy tools.
// Legacy tools remain registered with @deprecated tag for one major version (A1 shim).
// Next major: remove legacy @utcpTool registrations to reach 45 tools.

export class ConsolidatedTools {

    // ── inspectorGet: instance + settings properties ──────────────────
    @utcpTool(
        'inspectorGet',
        'Get properties for instance or settings. Use fields[] for specific keys.',
        {
            type: 'object',
            properties: {
                target: { type: 'string', enum: ['instance', 'CurrentSceneGlobals', 'ProjectSettings'], description: 'instance = node/component/asset by reference; settings = scene/project globals' },
                reference: InstanceReferenceSchema,
                fields: { type: 'array', items: { type: 'string' }, description: 'Only return these top-level keys. Omit for full dump.' },
                maxProperties: { type: 'number', minimum: 1, maximum: 1000, default: 200, description: 'Maximum top-level properties to return.' }
            },
            required: ['target'],
            allOf: [{ if: { properties: { target: { const: 'instance' } }, required: ['target'] }, then: { required: ['reference'] } }]
        },
        { type: 'object', properties: { dump: { type: 'object' }, total: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['dump', 'total', 'truncated'] }, 'GET',
        ['inspect', 'properties', 'consolidated', 'inspector']
    )
    async inspectorGet(args: { target: string, reference?: IInstanceReference, fields?: string[], maxProperties?: number }): Promise<{ dump: any, total: number, truncated: boolean }> {
        const id = args.target === 'instance'
            ? (args.reference?.id ?? (() => { throw new Error('inspectorGet target=instance requires reference.id'); })())
            : args.target;
        const info = await ToolsUtils.inspectInstance(id);
        if (!info) {
            throw new ToolError({
                code: 'TARGET_NOT_FOUND',
                status: 404,
                message: `inspectorGet: Target "${id}" not found or not supported.`,
                details: { target: args.target, id },
                recovery: 'Target ID must be a valid node/component/asset UUID, CurrentSceneGlobals, or ProjectSettings. Use nodeGetTree or assetResolvePath to obtain valid UUIDs.',
            });
        }
        const { props, type } = info;
        if (!props) throw new Error(`Could not retrieve properties for ${type} (${id}).`);
        let filteredProps: any = props;
        if (args.fields && args.fields.length > 0) {
            filteredProps = {};
            // Same guard as the delegation path (docs §2 mask-required): unknown /
            // typo'd fields must not vanish — that reads as a healthy empty dump.
            const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(props, key);
            const unknown = args.fields.filter((key) => !hasOwn(key));
            if (unknown.length > 0) {
                throw new ToolError({
                    code: 'INVALID_ARGUMENT',
                    status: 400,
                    message: `inspectorGet: fields not present on ${type} (${id}): ${unknown.join(', ')}`,
                    details: { type, id, requestedFields: args.fields, unknownFields: unknown },
                    recovery: 'Omit fields[] to inspect all available properties on this instance.',
                });
            }
            for (const key of args.fields) filteredProps[key] = (props as any)[key];
        }
        const parsed = ToolsUtils.unwrapProperties(filteredProps);
        const entries = Object.entries(parsed);
        const maxProperties = Math.min(Math.max(args.maxProperties ?? 200, 1), 1000);
        return { dump: Object.fromEntries(entries.slice(0, maxProperties)), total: entries.length, truncated: entries.length > maxProperties };
    }

    // ── inspectorSet: instance + settings ─────────────────────────────
    @utcpTool(
        'inspectorSet',
        'Set properties on instance or settings. Paths and values arrays must align.',
        {
            type: 'object',
            properties: {
                target: { type: 'string', enum: ['instance', 'CurrentSceneGlobals', 'ProjectSettings'] },
                reference: InstanceReferenceSchema,
                propertyPaths: { type: 'array', items: { type: 'string' }, description: 'Property paths, e.g. ["position.x"]' },
                values: { type: 'array', items: {} },
                propertyPath: { type: 'string' },
                value: {}
            },
            required: ['target'],
            allOf: [{ if: { properties: { target: { const: 'instance' } }, required: ['target'] }, then: { required: ['reference'] } }],
            oneOf: [{ required: ['propertyPaths', 'values'] }, { required: ['propertyPath', 'value'] }]
        },
        SuccessIndicatorSchema, 'POST',
        ['property', 'set', 'consolidated', 'inspector']
    )
    async inspectorSet(args: { target: string, reference?: IInstanceReference, propertyPaths?: string[], values?: any[], propertyPath?: string, value?: any }): Promise<ISuccessIndicator> {
        // delegate to existing SetPropertyTool logic via ToolsUtils path
        const { SetPropertyTool } = await import('./set-properties-tool');
        const tool = new (SetPropertyTool as any)();
        let propertyPaths = args.propertyPaths ?? (args.propertyPath !== undefined ? [args.propertyPath] : undefined);
        let values = args.values ?? (args.value !== undefined ? [args.value] : undefined);
        if (!propertyPaths || !values) throw new Error('inspectorSet requires propertyPaths+values (or propertyPath+value)');
        if (args.target === 'instance') {
            if (!args.reference?.id) throw new Error('inspectorSet target=instance requires reference.id');
            return tool.setInstanceProperties({ reference: args.reference, propertyPaths, values });
        }
        // settings target
        return tool.setCurrentSceneProperties({ settingsType: args.target, propertyPaths, values } as any);
    }

    // ── inspectorGetDefinition: instance + settings ───────────────────
    @utcpTool(
        'inspectorGetDefinition',
        'Generate TS definition for instance or settings. Use section for single class.',
        {
            type: 'object',
            properties: {
                target: { type: 'string', enum: ['instance', 'class', 'CommonTypes', 'CurrentSceneGlobals', 'ProjectSettings'] },
                reference: InstanceReferenceSchema,
                section: { type: 'string', description: 'Class/enum name to return only that section.' },
                className: { type: 'string', minLength: 1, maxLength: 256 },
                targetVersion: { type: 'string', enum: ['3.7.3', '3.8.8'] },
                maxEntries: { type: 'integer', minimum: 1, maximum: 200 },
                maxBytes: { type: 'integer', minimum: 1, maximum: 131072 },
                timeoutMs: { type: 'integer', minimum: 1, maximum: 30000, default: 5000 },
                maxPages: { type: 'integer', minimum: 1, maximum: 1000, default: 256 },
                cursor: { type: 'string', maxLength: 2048 },
            },
            required: ['target'],
            allOf: [{ if: { properties: { target: { const: 'instance' } }, required: ['target'] }, then: { required: ['reference'] } }]
        },
        { type: 'object', properties: { definition: { type: 'string' }, sections: { type: 'array', items: { type: 'string' } }, totalSections: { type: 'number' }, version: { type: 'string' }, catalogHash: { type: 'string' }, records: { type: 'array' }, total: { type: 'integer' }, count: { type: 'integer' }, truncated: { type: 'boolean' }, nextCursor: { type: ['string', 'null'] }, live: { type: 'object' }, runtimeVerified: { type: 'boolean' }, qualified: { type: 'boolean' } } }, 'GET',
        ['code', 'typescript', 'definition', 'consolidated']
    )
    async inspectorGetDefinition(args: { target: string, reference?: IInstanceReference, section?: string, className?: string, targetVersion?: string, maxEntries?: number, maxBytes?: number, cursor?: string, timeoutMs?: number, maxPages?: number }): Promise<unknown> {
        if (args.target === 'class') {
            return discoverEngineApi({ ...args, category: 'component_schema' });
        }
        const tool = new GetClassInfoTool();
        if (args.target === 'instance') {
            if (!args.reference?.id) throw new Error('inspectorGetDefinition target=instance requires reference.id');
            return tool.inspectorGetInstanceDefinition({ reference: args.reference, section: args.section });
        }
        return tool.inspectorGetSettingsDefinition({ settingsType: args.target, section: args.section });
    }

    // ── nodeComponentManage: add/remove ───────────────────────────────
    @utcpTool(
        'nodeComponentManage',
        'Add or remove component on node.',
        {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['add', 'remove'] },
                reference: InstanceReferenceSchema,
                componentType: { type: 'string', description: 'For add: component class name' }
            },
            required: ['operation', 'reference'],
            allOf: [{ if: { properties: { operation: { const: 'add' } }, required: ['operation'] }, then: { required: ['componentType'] } }]
        },
        { type: 'object', properties: { reference: InstanceReferenceSchema, success: { type: 'boolean' } } }, 'POST',
        ['scene', 'node', 'component', 'consolidated']
    )
    async nodeComponentManage(args: { operation: string, reference: IInstanceReference, componentType?: string }): Promise<any> {
        const { ComponentTools } = await import('./component-tools');
        const tool = new (ComponentTools as any)();
        if (args.operation === 'add') {
            if (!args.componentType) throw new Error('nodeComponentManage add requires componentType');
            return tool.nodeComponentAdd({ reference: args.reference, componentType: args.componentType });
        }
        if (args.operation === 'remove') return tool.nodeComponentRemove({ reference: args.reference });
        throw new Error(`Unknown nodeComponentManage operation: ${args.operation}`);
    }

    // ── editorQuery: introspect + listTypes ───────────────────────────
    @utcpTool(
        'editorQuery',
        'Query editor state or vocabularies.',
        {
            type: 'object',
            properties: {
                category: {
                    type: 'string',
                    enum: ['engine_api', 'component_schema', 'scene_mode', 'ready', 'enum_values', 'layers', 'sorting_layers', 'script_info', 'has_script', 'creatable_assets', 'asset_types', 'importers', 'shared_settings', 'sorted_plugins']
                },
                enumPath: { type: 'string' },
                className: { type: 'string' },
                reference: InstanceReferenceSchema,
                targetVersion: { type: 'string', enum: ['3.7.3', '3.8.8'] },
                domain: { type: 'string', maxLength: 128 },
                kind: { type: 'string', minLength: 1, maxLength: 128 },
                module: { type: 'string', minLength: 1, maxLength: 256 },
                visibility: { type: 'string', enum: ['public', 'protected', 'private', 'internal'] },
                context: { type: 'string', minLength: 1, maxLength: 128 }, evidenceState: { type: 'string', minLength: 1, maxLength: 128 },
                member: { type: 'string', minLength: 1, maxLength: 256 },
                namespace: { type: 'string', enum: ['engine-runtime', 'engine-authoring', 'editor-ipc', 'bridge'] },
                operation: { type: 'string', enum: ['records', 'list_domains', 'list_classes', 'list_namespaces', 'list_modules', 'list_kinds', 'list_members', 'get_signature', 'get_related_types', 'lookup_editor_message', 'explain_bridge_route', 'compare_version'] },
                filter: { type: 'string', maxLength: 256 },
                recordId: { type: 'string', minLength: 1, maxLength: 1024 },
                compareVersion: { type: 'string', enum: ['3.7.3', '3.8.8'] }, compareRecordId: { type: 'string', minLength: 1, maxLength: 1024 },
                // Comparison remains catalog-only; no live dispatch selectors are inferred.
                maxEntries: { type: 'integer', minimum: 1, maximum: 200 },
                maxBytes: { type: 'integer', minimum: 1, maximum: 131072 },
                timeoutMs: { type: 'integer', minimum: 1, maximum: 30000, default: 5000 },
                maxPages: { type: 'integer', minimum: 1, maximum: 1000, default: 256 },
                cursor: { type: 'string', maxLength: 2048 }
            },
            required: ['category'],
            allOf: [
                { if: { properties: { category: { const: 'enum_values' } }, required: ['category'] }, then: { required: ['enumPath'] } },
                { if: { properties: { category: { const: 'script_info' } }, required: ['category'] }, then: { required: ['reference'] } },
                { if: { properties: { category: { const: 'has_script' } }, required: ['category'] }, then: { required: ['className'] } }
            ]
        },
        { type: 'object', properties: { sceneMode: { type: 'string' }, ready: { type: 'boolean' }, values: { type: 'array', items: { type: 'object' } }, types: { type: 'array', items: { type: 'string' } }, scriptName: { type: 'string' }, scriptCid: { type: 'string' }, hasScript: { type: 'boolean' }, operation: { type: 'string' }, coverage: { type: 'object' }, version: { type: 'string' }, compareVersion: { type: 'string' }, semanticKey: { type: 'string' }, before: { type: 'object' }, after: { type: 'object' }, comparison: { type: 'object' }, permitted: { type: 'boolean' }, mutationAuthorized: { type: 'boolean' }, catalogHash: { type: 'string' }, records: { type: 'array' }, total: { type: 'integer' }, count: { type: 'integer' }, truncated: { type: 'boolean' }, nextCursor: { type: ['string', 'null'] }, live: { type: 'object' }, runtimeVerified: { type: 'boolean' }, qualified: { type: 'boolean' } } }, 'GET',
        ['editor', 'introspect', 'query', 'consolidated', 'programming', 'plugin']
    )
    async editorQuery(args: { category: string, operation?: 'records' | 'list_domains' | 'list_classes' | 'list_namespaces' | 'list_modules' | 'list_kinds' | 'list_members' | 'get_signature' | 'get_related_types' | 'lookup_editor_message' | 'explain_bridge_route' | 'compare_version', namespace?: 'engine-runtime' | 'engine-authoring' | 'editor-ipc' | 'bridge', enumPath?: string, className?: string, reference?: IInstanceReference, targetVersion?: string, domain?: string, kind?: string, module?: string, visibility?: 'public' | 'protected' | 'private' | 'internal', context?: string, evidenceState?: string, member?: string, filter?: string, recordId?: string, compareVersion?: string, compareRecordId?: string, maxEntries?: number, maxBytes?: number, cursor?: string, timeoutMs?: number, maxPages?: number }): Promise<unknown> {
        if (args.category === 'engine_api' || args.category === 'component_schema') {
            return discoverEngineApi(args);
        }
        const tool = new EditorTools();
        const vocabCategories: Record<string, true> = { creatable_assets: true, asset_types: true, importers: true };
        if (Object.prototype.hasOwnProperty.call(vocabCategories, args.category)) return tool.editorListTypes({ category: args.category });
        return tool.editorIntrospect({ category: args.category, enumPath: args.enumPath, className: args.className, reference: args.reference });
    }

    // ── sceneManage: open/save/close/soft_reload ─────────────────────
    @utcpTool(
        'sceneManage',
        'Manage scene lifecycle: open/save/close/soft_reload/save_as.',
        {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['open', 'save', 'save_as', 'close', 'soft_reload'] },
                reference: InstanceReferenceSchema
            },
            required: ['operation'],
            allOf: [{ if: { properties: { operation: { const: 'open' } }, required: ['operation'] }, then: { required: ['reference'] } }]
        },
        { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' }, reference: InstanceReferenceSchema } }, 'POST',
        ['scene', 'lifecycle', 'consolidated']
    )
    async sceneManage(args: { operation: string, reference?: IInstanceReference }): Promise<any> {
        const { SceneTools } = await import('./scene-tools');
        const { EditorTools } = await import('./editor-tools');
        const sceneTool = new (SceneTools as any)();
        const editorTool = new (EditorTools as any)();
        switch (args.operation) {
            case 'open':
                if (!args.reference?.id) throw new Error('sceneManage open requires reference.id');
                return sceneTool.sceneOpen({ reference: args.reference });
            case 'save': return editorTool.editorOperate({ operation: 'save_scene_or_prefab' });
            case 'save_as': return editorTool.editorOperate({ operation: 'save_as' });
            case 'close': return editorTool.editorOperate({ operation: 'close_scene_or_prefab' });
            case 'soft_reload': return editorTool.editorOperate({ operation: 'soft_reload' });
            default: throw new Error(`Unknown sceneManage operation: ${args.operation}`);
        }
    }

    // ── buildManage: panel/tasks/trigger/control ─────────────────────
    @utcpTool(
        'buildManage',
        'Manage builds: open panel, query tasks, trigger, control.',
        {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['panel_open', 'tasks_info', 'get_task', 'trigger', 'control'] },
                panel: { type: 'string', enum: ['default', 'build-bundle'] },
                taskId: { type: ['string', 'integer'], minLength: 1, maxLength: 256, minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                options: { type: 'object', description: 'Build options for trigger' },
                control: { type: 'string', enum: ['break', 'remove', 'recompile'] },
                limit: { type: 'number', minimum: 1, maximum: 1000, default: 200, description: 'For tasks_info: maximum tasks to return.' }
            },
            required: ['operation'],
            allOf: [
                { if: { properties: { operation: { const: 'get_task' } }, required: ['operation'] }, then: { required: ['taskId'] } },
                { if: { properties: { operation: { const: 'trigger' } }, required: ['operation'] }, then: { required: ['options'] } },
                { if: { properties: { operation: { const: 'control' } }, required: ['operation'] }, then: { required: ['taskId', 'control'] } }
            ]
        },
        { type: 'object', properties: { success: { type: 'boolean' }, submission: { type: 'string', enum: ['submitted', 'refused'] }, workerReady: { type: 'boolean' }, free: { type: 'boolean' }, tasks: { type: 'array', items: { type: 'object' } }, total: { type: 'number' }, truncated: { type: 'boolean' }, task: { type: 'object' }, options: { type: 'object' }, taskId: { type: 'string' } } }, 'POST',
        ['build', 'consolidated']
    )
    async buildManage(args: { operation: string, panel?: string, taskId?: string | number, options?: unknown, control?: string, limit?: number }): Promise<unknown> {
        const { BuildTools } = await import('./build-tools');
        const tool = new BuildTools();
        switch (args.operation) {
            case 'panel_open': return tool.buildPanelOpen({ panel: args.panel });
            case 'tasks_info': return tool.buildGetTasksInfo({ limit: args.limit });
            case 'get_task': return tool.buildGetTask({ taskId: args.taskId as string | number });
            case 'trigger': return tool.buildTrigger({ options: args.options });
            case 'control': return tool.buildTaskControl({ operation: args.control as string, taskId: args.taskId as string | number });
            default: throw new Error(`Unknown buildManage operation: ${args.operation}`);
        }
    }

    // ── previewManage: 4→1 (previewGetUrl, previewOpenInBrowser, assetGetPreview, editorGetScenePreview) ──
    @utcpTool('previewManage','Preview: get url/open browser/asset preview/scene capture.',{type:'object',properties:{operation:{type:'string',enum:['get_url','open_browser','asset_preview','scene_preview']},reference:InstanceReferenceSchema,imageSize:{oneOf:[{type:'number'},{type:'object',properties:{width:{type:'number'},height:{type:'number'}},required:['width','height']}],description:'number = square; pass {width,height} for exact aspect ratio (scene_preview)'},jpegQuality:{type:'number'},transparentColor:{type:'object',properties:{r:{type:'integer'},g:{type:'integer'},b:{type:'integer'}}},cameraPosition:{type:'object',properties:{x:{type:'number'},y:{type:'number'},z:{type:'number'}}},targetPosition:{type:'object',properties:{x:{type:'number'},y:{type:'number'},z:{type:'number'}}},orthographic:{type:'boolean'},orthographicSize:{type:'number'}},required:['operation'],allOf:[{if:{properties:{operation:{const:'asset_preview'}},required:['operation']},then:{required:['reference']}},{if:{properties:{operation:{const:'scene_preview'}},required:['operation']},then:{required:['cameraPosition','targetPosition']}}]},{type:'object',properties:{url:{type:'string'},success:{type:'boolean'},type:{type:'string'},data:{type:'string'},mimeType:{type:'string'}}},'POST',['preview','consolidated'])
    async previewManage(args:any):Promise<any>{
        const { PreviewTools } = await import('./preview-tools');
        const { AssetTools } = await import('./asset-tools');
        const { EditorTools } = await import('./editor-tools');
        switch(args.operation){
            case 'get_url': return new (PreviewTools as any)().previewGetUrl();
            case 'open_browser': return new (PreviewTools as any)().previewOpenInBrowser();
            case 'asset_preview': {
                if(!args.reference?.id) throw new Error('previewManage asset_preview requires reference.id');
                return new (AssetTools as any)().assetGetPreview({ reference:args.reference, imageSize:args.imageSize, jpegQuality:args.jpegQuality, transparentColor:args.transparentColor });
            }
            case 'scene_preview': {
                if(!args.cameraPosition||!args.targetPosition) throw new Error('previewManage scene_preview requires cameraPosition+targetPosition');
                return new (EditorTools as any)().editorGetScenePreview({ imageSize:args.imageSize, jpegQuality:args.jpegQuality, cameraPosition:args.cameraPosition, targetPosition:args.targetPosition, orthographic:args.orthographic, orthographicSize:args.orthographicSize });
            }
            default: throw new Error(`Unknown previewManage operation: ${args.operation}`);
        }
    }

    // ── programManage: 3→1 (programGetInfo, programOpen, urlOpen) ──
    @utcpTool('programManage','External programs and URL open.',{type:'object',properties:{operation:{type:'string',enum:['get_info','open','open_url']},programName:{type:'string'},commandArguments:{type:'object'},url:{type:'string'}},required:['operation'],allOf:[{if:{properties:{operation:{enum:['get_info','open']}},required:['operation']},then:{required:['programName']}},{if:{properties:{operation:{const:'open_url'}},required:['operation']},then:{required:['url']}}]},{type:'object',properties:{success:{type:'boolean'},path:{type:'string'},commandArgument:{type:'string'}}},'POST',['program','consolidated'])
    async programManage(args:any):Promise<any>{
        const { ProgramTools } = await import('./program-tools');
        const t=new (ProgramTools as any)();
        switch(args.operation){
            case 'get_info': if(!args.programName) throw new Error('programManage get_info requires programName'); return t.programGetInfo({ programName:args.programName });
            case 'open': if(!args.programName) throw new Error('programManage open requires programName'); return t.programOpen({ programName:args.programName, commandArguments:args.commandArguments });
            case 'open_url': if(!args.url) throw new Error('programManage open_url requires url'); return t.urlOpen({ url:args.url });
            default: throw new Error(`Unknown programManage operation: ${args.operation}`);
        }
    }

    // ── projectManage: 2→1 (projectGetConfig, projectSetConfig) ──
    @utcpTool('projectManage','Read/write project settings.',{type:'object',properties:{operation:{type:'string',enum:['get','set']},type:{type:'string'},key:{type:'string'},path:{type:'string'},value:{},limit:{type:'number',minimum:1,maximum:1000,default:200}},required:['operation'],allOf:[{if:{properties:{operation:{const:'set'}},required:['operation']},then:{required:['path']}}]},{type:'object',properties:{config:{},success:{type:'boolean'},total:{type:'number'},truncated:{type:'boolean'}}},'POST',['project','consolidated'])
    async projectManage(args:any):Promise<any>{
        const { ProjectTools } = await import('./project-tools');
        const t=new (ProjectTools as any)();
        if(args.operation==='get') return t.projectGetConfig({ type:args.type, key:args.key, limit:args.limit });
        if(args.operation==='set'){ if(!args.path) throw new Error('projectManage set requires path'); return t.projectSetConfig({ path:args.path, value:args.value }); }
        throw new Error(`Unknown projectManage operation: ${args.operation}`);
    }
}
