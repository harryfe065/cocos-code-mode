// Instance reference should newer be kept in memory
// Agent-facing tool surface for Cocos Creator 3.7.x.
// Type-only documentation namespace: ccp3x. Runtime manuals use ccp3x_<port>.
// Register and call the exact per-port manual; no bare runtime latest alias exists.
// STATIC hand-written. See source/utcp/tools/*.ts for impl.

type InstanceReference = { id: string; type: string };

interface EditorPromptFieldBase { name: string; label: string; required?: boolean }
type EditorPromptField =
    | (EditorPromptFieldBase & { type: "text"; defaultValue?: string; maxLength?: number })
    | (EditorPromptFieldBase & { type: "select"; options: string[]; defaultValue?: string })
    | (EditorPromptFieldBase & { type: "confirm"; defaultValue?: boolean });

type AssetImportSettingValue = null | string | number | boolean | AssetImportSettingValue[] | { [key: string]: AssetImportSettingValue };
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
    enumValues?: AssetImportSettingValue[];
}
interface AssetImportSettingsSchema {
    importer: string;
    className: string;
    properties: AssetImportSettingDescriptor[];
    mutablePaths: string[];
}
interface AssetImportSettingsResult {
    reference: InstanceReference;
    importer: string;
    schema: AssetImportSettingsSchema;
    settings: { [key: string]: AssetImportSettingValue };
    source: AssetImportSettingsSource;
}
interface EngineApiDiscoveryArgs { operation?: 'records' | 'list_domains' | 'list_classes' | 'list_namespaces' | 'list_modules' | 'list_kinds' | 'list_visibility' | 'list_contexts' | 'list_evidence' | 'list_static' | 'list_members' | 'get_signature' | 'get_related_types' | 'lookup_editor_message' | 'explain_bridge_route' | 'compare_version'; namespace?: 'engine-runtime' | 'engine-authoring' | 'editor-ipc' | 'bridge'; className?: string; targetVersion?: '3.7.3' | '3.8.8'; domain?: string; kind?: string; module?: string; visibility?: 'public' | 'protected' | 'private' | 'internal'; context?: string; evidenceState?: string; member?: string; filter?: string; recordId?: string; compareVersion?: '3.7.3' | '3.8.8'; compareRecordId?: string; reference?: InstanceReference; maxEntries?: number; maxBytes?: number; cursor?: string; timeoutMs?: number; maxPages?: number }
type EngineApiDiscoveryResult = { version: string; operation: 'records' | 'list_domains' | 'list_classes' | 'list_namespaces' | 'list_modules' | 'list_kinds' | 'list_visibility' | 'list_contexts' | 'list_evidence' | 'list_static' | 'list_members' | 'get_signature' | 'get_related_types' | 'lookup_editor_message' | 'explain_bridge_route'; coverage: { scope: string; fullCatalogLoaded: boolean; originalCatalogHash: string | null }; catalogHash: string; records: Array<Record<string, unknown>>; total: number; count: number; truncated: boolean; nextCursor: string | null; live: Record<string, unknown>; runtimeVerified: false; qualified: false } | { version: string; operation: 'compare_version'; semanticKey: string; before: { version: string; recordId: string; catalogHash: string; coverage: Record<string, unknown> }; after: { version: string; recordId: string; catalogHash: string; coverage: Record<string, unknown> }; comparison: { signatures: 'unchanged' | 'changed' | 'unknown'; metadata: 'unchanged' | 'changed' | 'unknown'; resolution: 'unchanged' | 'changed' | 'unknown' }; permitted: false; mutationAuthorized: false; runtimeVerified: false; qualified: false };
interface ImportOutputEvidence { kind: 'source' | 'library'; extension: string; path: string; status: 'verified' | 'missing' | 'unreadable' | 'too_large' | 'changed' | 'empty'; bytes: number | null; sha256: string | null }
interface UiReflowEvidence {
    success: boolean; operation: 'reflow'; sceneSaved: false; complete: boolean;
    reference: InstanceReference; checkedNodes: number; changedNodeIds: string[];
    restoration: 'not-needed' | 'confirmed' | 'partial' | 'unknown';
    history: { status: 'not-requested' | 'snapshot-requested' | 'unknown'; undoRedoVerified: false };
    preservation: 'confirmed' | 'unknown'; before?: Record<string, unknown>[]; after?: Record<string, unknown>[];
    order?: Array<{ nodeId: string; componentType: 'cc.Layout' | 'cc.Widget' }>;
    error?: { code: string; message: string; mutationStarted: boolean };
}
interface NativeGraphInspection {
    reference: InstanceReference; format: 'native-creator-3.7' | 'legacy-synthetic' | 'unsupported';
    nativeShape: boolean; structuralValid: boolean; semanticsVerified: false; runtimeVerified: false;
    layers: Record<string, unknown>[]; stateMachines: Record<string, unknown>[]; states: Record<string, unknown>[];
    transitions: Record<string, unknown>[]; variables: Record<string, unknown>[]; conditions: Record<string, unknown>[];
    layerCount: number; stateMachineCount: number; stateCount: number; transitionCount: number; variableCount: number; conditionCount: number;
    issues: Array<{ code: string; path: string }>; truncated: boolean; limits: Record<string, number>; verificationScope: string;
}
interface IAssetTree {
    filesystemPath?: string;
    reference: InstanceReference;
    name: string;
    children: IAssetTree[];
    truncated?: string;
    childrenOmitted?: number;
    childrenCount?: number;
}
interface IHierarchyTree {
    path?: string;
    reference: InstanceReference;
    name: string;
    active: boolean;
    components: InstanceReference[];
    children: IHierarchyTree[];
    truncated?: string;
    childrenOmitted?: number;
    childrenCount?: number;
}

interface IExposedAttributes { type?: string, visible?: boolean, multiline?: boolean, min?: number, max?: number }
// Decorator for properties
declare function property(options: IExposedAttributes): any

// Cocos types
type Vector2 = { x: number; y: number };
type Vector3 = { x: number; y: number; z: number };
type Vector4 = { x: number; y: number; z: number; w: number };
type Quaternion = { x: number; y: number; z: number; w: number };
type Vec2 = Vector2;
type Vec3 = Vector3;
type Vec4 = Vector4;
type Quat = Quaternion;
type Mat3 = {
    m00: number; m01: number; m02: number;
    m03: number; m04: number; m05: number;
    m06: number; m07: number; m08: number;
}
type Mat4 = {
    m00: number; m01: number; m02: number; m03: number;
    m04: number; m05: number; m06: number; m07: number;
    m08: number; m09: number; m10: number; m11: number;
    tm12: number; m13: number; m14: number; m15: number;
}
type Color = { r: number; g: number; b: number; a: number; }
type Rect = { x: number; y: number; width: number; height: number; }
type Size = { width: number, height: number };
// The single difference between Unity and Cocos gradient is color represented as flat 3 numbers array (r, g, b)
type Gradient = { colorKeys: Array<{ color: Array<number>, time: number }>, alphaKeys: Array<{ alpha: number, time: number }>, mode: number }

/**
 * Cocos Editor Tools — 46 tools (36 standalone + 10 consolidated)
 * Legacy inspector/scene/editor/build + preview/program/project shims removed in 2.0.x — use consolidated entry points.
 */
declare namespace ccp3x {
    /** Remove or reorder ONE element of an array-valued property by index. Use instead of inspectorSet, which replaces the whole array and loses object references. */
    function propertyArrayElement(args: {
        operation: "remove" | "move",
        reference: InstanceReference,
        propertyPath: string,
        index: number,
        toIndex?: number
    }): { success: boolean, error?: string };

    /** Get the asset and subAsset hierarchy tree. Pass maxDepth/maxNodes to bound wide scenes (truncated branches set truncated/childrenOmitted). */
    function assetGetTree(args: {
        reference?: InstanceReference,
        assetPath?: string,
        maxDepth?: number,
        maxNodes?: number
    }): IAssetTree;

    /** Get asset reference by given local path and name. */
    function assetGetAtPath(args: { assetPath: string }): { reference: InstanceReference };

    /** Resolve asset locations (uuid <-> db:// url <-> filesystem path) and probe existence. Accepts uuid (reference) OR db:// path (assetPath). */
    function assetResolvePath(args: { reference?: InstanceReference, assetPath?: string }): { filesystemPath: string, url?: string, uuid?: string, exists: boolean, isDirectory?: boolean, type?: string, importer?: string };

    /** Read text content of an asset by uuid or db:// path. Rejects binary/oversized files; use maxBytes to raise the cap. */
    function assetReadContent(args: { reference?: InstanceReference, assetPath?: string, maxBytes?: number }): { content: string, filesystemPath: string, bytes: number, truncated: boolean };

    /** Asset-level dependency analysis: used_by = assets/scripts referencing this asset (who breaks if deleted), depends_on = assets it references. Wider than findNodesByAsset, which only scans the open scene. */
    function assetFindReferences(args: {
        direction?: "used_by" | "depends_on",
        reference: InstanceReference,
        assetKind?: "asset" | "script" | "all",
        resolveUrls?: boolean,
        limit?: number
    }): { references: InstanceReference[], assets?: { uuid: string, url?: string, type?: string }[], total: number, truncated: boolean };

    /** Search the asset database with filters (glob pattern, ccType, importer, extname, isBundle). At least one filter required. */
    function assetQuery(args: {
        name?: string,
        pattern?: string,
        ccType?: string,
        importer?: string,
        extname?: string,
        isBundle?: boolean,
        limit?: number
    }): { assets: { uuid: string, name: string, url: string, type: string, importer?: string, isDirectory: boolean }[], total: number, truncated: boolean };

    /** Queries 1–100 filter sets in input order; explicit limits are capped at 200 per query. Any query failure rejects the batch, not a per-item outcome. Native scans are not an atomic snapshot. */
    function assetBatchQuery(args: { queries: Array<{
        name?: string; pattern?: string; ccType?: string; importer?: string; extname?: string; isBundle?: boolean; limit?: number;
    }> }): { results: Array<ReturnType<typeof assetQuery>> };

    /** dataBytes is full serialized JSON size. Truncated data is a UTF-8-bounded text prefix ending on a code-point boundary, not necessarily valid JSON; unserializable native data throws ASSET_DATA_UNSERIALIZABLE; meta is not byte-capped. */
    function assetInspect(args: { reference?: InstanceReference; assetPath?: string; maxDataBytes?: number }): {
        uuid: string; url: string; type: string; file: string; isDirectory: boolean; importer: string;
        meta: unknown; dataBytes: number;
    } & ({ dataTruncated: true; data: string } | { dataTruncated: false; data: unknown });

    /** Editor pipeline snapshot only; oversized complete responses throw instead of truncating. No runtime frame sampling. */
    function renderPipelineInspect(args: { reference: InstanceReference; maxBytes?: number }): {
        reference: InstanceReference; pipeline: unknown; bytes: number; truncated: false;
    };
    /** Validates native/importer response shape, not rendering correctness or persisted material state. */
    function materialValidate(args: { reference: InstanceReference }): {
        valid: boolean; reference: InstanceReference; importer: string; issues: Array<Record<string, unknown>>;
        native: unknown; settings: Record<string, unknown>;
    };
    /** supported=false reports unavailable editor IPC. A successful inspection is not runtime sampling or render correctness. */
    function renderDiagnosticsCollect(args: { reference: InstanceReference; maxBytes?: number }): {
        reference: InstanceReference; supported: boolean; pipeline?: unknown;
        diagnostics: Array<Record<string, unknown>>; runtimeSampling: false;
    };
    /** Applies 1–32 non-overlapping scene updates with read-back and guarded restoration, not an atomic transaction. Lost dispatch responses throw RENDER_MUTATION_OUTCOME_UNKNOWN/retrySafe:false/restored:null; external changes refuse rollback. */
    function renderConfigurationApply(args: { updates: Array<{ reference: InstanceReference; path: string; value: unknown }> }): {
        changed: string[]; readBack: Array<{ reference: InstanceReference; path: string; value: unknown }>; verified: true;
    };

    /** Creates a node with cc.Camera and reads back identity/projection. Does not certify scene save/reopen; failed creation reports ROLLBACK_FAILED when owned-node absence cannot be confirmed. */
    function cameraCreate(args: { name?: string; is2D?: boolean; parentReference?: InstanceReference }): {
        nodeReference: InstanceReference; cameraReference: InstanceReference;
    };
    /** Capped camera results; hierarchy traversal refuses repeated objects or more than 10000 scheduled entries/components. Serialized inventory also refuses more than 10000 aggregate components before filtering. Raw IPC allocations are not bounded. Native values remain unknown; total counts observed camera components. */
    function cameraList(args?: { maxResults?: number }): {
        cameras: Array<{ nodeReference: InstanceReference; cameraReference: InstanceReference; name: unknown; priority: unknown; visibility: unknown; projection: unknown }>;
        total: number; truncated: boolean;
    };
    /** Updates 1–32 identifier-named camera properties with identity/read-back checks and guarded partial rollback. Restoration requires the same unique camera UUID/type/index and prior value. Hierarchy components and each serialized node inspection are bounded to 10000. Unknown dispatched outcomes throw CAMERA_MUTATION_OUTCOME_UNKNOWN with retrySafe:false and restored:null; external value changes refuse restoration. */
    function cameraSetProperties(args: { reference: InstanceReference; properties: Record<string, unknown> }): { updated: true; reference: InstanceReference };

    /** Read bounded importer-specific settings, typed property descriptors, and explicit source identity for one asset. */
    function assetImportSettingsGet(args: { reference: InstanceReference }): AssetImportSettingsResult;

    /** Preflight and set one typed mutable importer property, reimport, and verify read-back. */
    function assetImportSettingsSet(args: {
        reference: InstanceReference,
        path: string,
        value: AssetImportSettingValue
    }): {
        changed: boolean,
        path: string,
        previous: AssetImportSettingValue,
        readBack: AssetImportSettingValue,
        result: AssetImportSettingsResult,
        settingsSaved: boolean,
        importComplete: boolean | null,
        generatedOutputVerified: boolean | null,
        retrySafe: false,
        importCompletion: { signal: 'asset-db/is-busy' | 'unsupported' | 'unavailable' | 'not_requested'; polls: number },
        outputs: ImportOutputEvidence[],
        outputsTruncated: boolean
    };

    /** Imported script metadata only. Missing class identity is null; dependencies are capped at maxDependencies (1–128). Does not compile or execute source. */
    function scriptAssetInspect(args: { reference: InstanceReference; maxDependencies?: number }): {
        reference: InstanceReference;
        className: string | null;
        classId: string | null;
        url: string;
        importer: string;
        bytes: number;
        dependencies: string[];
        totalDependencies: number;
        truncated: boolean;
    };

    /** Validate exposed script class identity, not compilation, runtime behavior, or complete dependency coverage. */
    function scriptAssetValidate(args: { reference: InstanceReference }): {
        valid: boolean;
        reference: InstanceReference;
        issues: Array<{ code: 'SCRIPT_NAME_UNAVAILABLE' | 'SCRIPT_CLASS_ID_UNAVAILABLE' }>;
        className: string | null;
        classId: string | null;
    };

    /** Inspect 1–32 scripts. Envelope truncated=false does not imply each dependency inventory is complete; check item.result.truncated. */
    function scriptAssetBatchInspect(args: { references: InstanceReference[]; maxDependencies?: number }): {
        items: Array<
            { index: number; ok: true; result: ReturnType<typeof scriptAssetInspect> } |
            { index: number; ok: false; reference: InstanceReference; error: { message: string } }
        >;
        succeeded: number;
        failed: number;
        truncated: false;
    };

    /** Validate 1–32 scripts. succeeded counts completed inspections, including valid=false; invalid counts those negative results. partial means mixed success/error outcomes. */
    function scriptAssetBatchValidate(args: { references: InstanceReference[] }): {
        outcomes: Array<
            { index: number; ok: true; result: ReturnType<typeof scriptAssetValidate> } |
            { index: number; ok: false; reference: InstanceReference; error: { message: string } }
        >;
        succeeded: number;
        failed: number;
        invalid: number;
        partial: boolean;
    };

    /** Bounded Asset DB metadata, not runtime/dynamic-load completeness. Each direction carries its own truncation flag. */
    function scriptDependencyImpactInspect(args: { reference: InstanceReference; limit?: number; resolveAssets?: boolean }): {
        reference: InstanceReference;
        dependencies: { references: InstanceReference[]; assets?: Array<{ uuid: string; url?: string; type?: string }>; total: number; truncated: boolean };
        users: { references: InstanceReference[]; assets?: Array<{ uuid: string; url?: string; type?: string }>; total: number; truncated: boolean };
    };

    /** Inspect 1–32 scripts; truncated aggregates either direction of successful items only. Errors remain separate outcomes. */
    function scriptDependencyImpactBatchInspect(args: { references: InstanceReference[]; limit?: number; resolveAssets?: boolean }): {
        items: Array<
            { index: number; ok: true; result: ReturnType<typeof scriptDependencyImpactInspect> } |
            { index: number; ok: false; reference: InstanceReference; error: { message: string } }
        >;
        succeeded: number;
        failed: number;
        truncated: boolean;
    };

    /** Shape validation only; valid=true does not certify an untruncated or complete dependency graph. */
    function scriptDependencyImpactValidate(args: { reference: InstanceReference }): {
        valid: boolean;
        reference: InstanceReference;
        issues: Array<{ code: 'IMPACT_RESULT_MALFORMED'; direction: 'dependencies' | 'users' }>;
    };

    /** Inspect typed model importer settings and up to 128 imported outputs; outputsTruncated means validation cannot claim complete coverage. */
    function modelImportInspect(args: { reference: InstanceReference }): {
        reference: InstanceReference,
        importer: string,
        settings: Record<string, unknown>,
        schema: Record<string, unknown>,
        outputs: Array<Record<string, unknown>>,
        totalOutputs: number,
        outputsTruncated: boolean
    };

    /** Validate imported model output identities and settings; truncated inventories return valid=false. */
    function modelImportValidate(args: { reference: InstanceReference }): {
        valid: boolean,
        reference: InstanceReference,
        importer: string,
        issues: Array<{ code: string; index?: number; message?: string }>,
        outputs: Array<Record<string, unknown>>
    };

    /** Inspect up to 128 imported model outputs with stable identities; truncated is true when the inventory exceeds maxOutputs. */
    function modelImportOutputsInspect(args: { reference: InstanceReference; maxOutputs?: number }): {
        reference: InstanceReference,
        outputs: Array<{
            uuid: string,
            url: string,
            type: string,
            importer: string | null,
            name: string | null,
            userData: unknown
        }>,
        total: number,
        truncated: boolean
    };

    /** Inspect imported model skeleton metadata; this is read-only and metadata-only. */
    function modelSkeletonInspect(args: { reference: InstanceReference; maxJoints?: number }): {
        reference: InstanceReference,
        skeletonId: string | null,
        joints: string[],
        totalJoints: number,
        truncated: boolean
    };

    /** Validate imported model joint identity and uniqueness; does not prove runtime skeleton binding. */
    function modelSkeletonValidate(args: { reference: InstanceReference }): {
        valid: boolean,
        reference: InstanceReference,
        skeletonId: string | null,
        jointCount: number,
        issues: Array<{ code: string; index?: number; joint?: string }>
    };

    /** Inspect imported animation clip metadata; no runtime playback or clip binding claim. */
    function modelAnimationInspect(args: { reference: InstanceReference; maxClips?: number }): {
        reference: InstanceReference,
        skeletonId: string | null,
        clips: string[],
        totalClips: number,
        truncated: boolean
    };

    /** Compare source/target/optional clip metadata only; automaticRetargeting is always false. */
    function animationRetargetValidate(args: { sourceReference: InstanceReference; targetReference: InstanceReference; clipReference?: InstanceReference }): {
        valid: boolean,
        automaticRetargeting: false,
        sourceReference: InstanceReference,
        targetReference: InstanceReference,
        clipReference?: InstanceReference,
        source: { jointCount: number; joints: string[]; skeletonId?: string },
        target: { jointCount: number; joints: string[]; skeletonId?: string },
        clip?: { clipCount: number; clips: string[]; skeletonId?: string },
        issues: Array<Record<string, unknown>>
    };

    /** Validate bounded imported animation clip names and skeleton identity; no runtime playback claim. */
    function modelAnimationValidate(args: { reference: InstanceReference }): {
        valid: boolean,
        reference: InstanceReference,
        skeletonId: string | null,
        clipCount: number,
        issues: Array<{ code: string; index?: number; clip?: string }>
    };

    /** Editor clip metadata only; maxClips is 1–200. Raw clip fields require narrowing; no runtime binding/playback proof. */
    function skeletalAnimationInspect(args: { nodeReference: InstanceReference; maxClips?: number }): {
        reference: InstanceReference; clips: Array<Record<string, unknown>>; totalClips: number; truncated: boolean;
    };
    /** Checks identities in the inspected prefix; truncated inventories return valid=false. clipCount is total inventory size, not checked count. */
    function skeletalAnimationValidate(args: { nodeReference: InstanceReference; maxClips?: number }): {
        valid: boolean; issues: string[]; clipCount: number;
    };

    /** Scene-side discovery, not playback qualification. total counts returned findings, not all scene components; inspect both truncation levels. */
    function animationCatalogInspect(args: { nodeReference: InstanceReference; maxItems?: number }): {
        nodeReference: { id: string; type: 'cc.Node' }; nodeUuid: string | null;
        findings: Array<{
            node: { id: string | null; name: string | null }; component: string;
            animations: Array<{ name: string | null; uuid: string | null; duration: number | null; source: 'clip' | 'spine-runtime' }>;
            totalAnimations: number; truncated: boolean;
        }>;
        total: number; truncated: boolean;
    };
    /** Lists regular Animation components, not SkeletalAnimation/Spine. No finite traversal or response cap is currently exposed. */
    function animationComponentsList(args?: { nodeReference?: InstanceReference; recursive?: boolean }): {
        animations: Array<{ nodeUuid: string | null; defaultClip: string | null; clips: string[] }>;
    };

    /** Assigns to regular Animation; success is immediate read-back, not scene save/reopen proof. Inspect before retry after ambiguous failure. */
    function animationClipAssign(args: { nodeReference: InstanceReference; clipReference: InstanceReference; clipName?: string }): {
        nodeReference: InstanceReference; clipReference: InstanceReference;
        nodeUuid: string; clipUuid: string; clipName: string; success: true;
        clips: Array<{ uuid: string | null; name: string | null }>;
    };
    /** Method-presence heuristics for the first selected component, not exact target identity or successful playback/cache qualification. */
    function animationCompatibilityAudit(args: { nodeReference: InstanceReference }): {
        nodeReference: { id: string; type: 'cc.Node' }; nodeUuid: string; component: string | null;
        supports: { inspect: true; playback: boolean; crossFade: boolean; tracks: boolean; seek: boolean; cacheMode: boolean; cacheInvalidation: boolean };
        supportedCacheModes: Array<'REALTIME' | 'SHARED_CACHE' | 'PRIVATE_CACHE'>;
        unsupportedOperations: string[]; recommendations: string[];
    };

    /** Configure serialized SkeletalAnimation fields with read-back; failure restores attempted fields or throws rollback failure. */
    function skeletalAnimationConfigure(args: { reference: InstanceReference; properties: { playOnLoad?: boolean; useBakedAnimation?: boolean } }): {
        reference: InstanceReference,
        componentReference: InstanceReference,
        properties: { playOnLoad?: boolean; useBakedAnimation?: boolean },
        changed: string[],
        verified: true
    };

    /** Assign a platform-aware Creator texture-compression preset and return deterministic reimport evidence. */
    function assetCompressionConfigure(args: {
        reference: InstanceReference,
        presetId: string,
        platform: "miniGame" | "web" | "ios" | "android" | "pc"
    }): {
        changed: boolean,
        reference: InstanceReference,
        presetId: string,
        previousPresetId: string | null,
        platform: "miniGame" | "web" | "ios" | "android" | "pc",
        formats: { format: string, quality: string | number }[],
        sourceSha256: string,
        generatedOutputs: { extension: string, path: string, bytes: number, sha256: string }[],
        buildArtifactVerified: boolean
    };

    /** Export a bounded deterministic asset manifest with dependencies, source hashes, and explicit exclusions. */
    function assetManifestExport(args: {
        assetPath?: string,
        maxAssets?: number,
        maxFileBytes?: number
    }): {
        assets: {
            uuid: string,
            url: string,
            type: string,
            importer: string,
            name: string,
            isSubAsset: boolean,
            dependencies: string[],
            dependenciesTruncated: boolean,
            bytes: number,
            sha256: string
        }[],
        exclusions: {
            uuid: string,
            url: string,
            reason: "source-file-unavailable" | "source-file-too-large" | "hash-failed",
            bytes?: number,
            maxFileBytes?: number
        }[],
        truncated: boolean,
        count: number,
        total: number
    };

    function assetBundleValidate(args: { reference: InstanceReference; expectedBundle?: string }): { valid: boolean; reference: InstanceReference; bundle: Record<string, unknown> | null; issues: Array<Record<string, unknown>>; runtimeCaveat: string };

    /** Analyze project-wide serialized asset reachability from scene/prefab roots with bounded graph evidence. */
    function assetUsageAnalyze(args: {
        assetPath?: string,
        maxAssets?: number,
        maxGraphAssets?: number,
        rootReferences?: InstanceReference[]
    }): {
        graphVersion: "v4",
        complete: boolean,
        roots: { id: string, url: string, type?: string }[],
        graphAssets: number,
        graphEdges: number,
        graphTruncated: boolean,
        exclusions: { uuid: string, url: string, reason: string }[],
        candidates: {
            uuid: string,
            url: string,
            type?: string,
            confidence: "serialized-project-unreachable",
            referenceCount: number,
            references: InstanceReference[]
        }[],
        checkedAssets: number,
        referenceEvidence: {
            uuid: string,
            url: string,
            type?: string,
            status: "root-reachable" | "project-unreachable",
            root: boolean,
            referenceCount: number,
            references: InstanceReference[]
        }[],
        dynamicLoadCaveat: string
    };


    /** Overwrite the content of an existing text-based asset (TypeScript, JSON, effect, txt...). Identify by db:// path or uuid. Binary not supported. */
    function assetSaveContent(args: { assetPath?: string, reference?: InstanceReference, content: string }): { reference: InstanceReference, filesystemPath?: string };

    /** Returns an available (non-colliding) db:// url for a desired path - appends suffix if an asset exists there. */
    function assetGetAvailableUrl(args: { assetPath: string }): { url: string };

    /** Create empty asset or folder of given type. */
    function assetCreate(args: {
        assetPath: string,
        preset: "folder" | "material" | "effect" | "scene" | "prefab" | "typescript" | "animation-clip" | "render-texture" | "physics-material" | "animation-graph" | "animation-graph-variant" | "animation-mask" | "auto-atlas" | "effect-header" | "label-atlas" | "terrain",
        options?: { overwrite?: boolean, rename?: boolean }
    }): { reference: InstanceReference };

    /** Import an external file as an asset into the project. */
    function assetImport(args: {

        sourceFilesystemPath: string,
        targetAssetPath: string,
        imageType?: "raw" | "texture" | "normal-map" | "sprite-frame" | "texture-cube",
        options?: { overwrite?: boolean, rename?: boolean }
    }): { reference: InstanceReference };
    /** Importer metadata only; no render or geometry correctness claim. */
    function spriteFrameInspect(args: { reference: InstanceReference }): {
        reference: InstanceReference; sourceReference: InstanceReference; url: string; importer: string; metadata: unknown;
    };
    /** Missing/non-finite numeric metadata is null. metadataAvailable does not imply all geometry fields are available. */
    function spriteFrameGeometryInspect(args: { reference: InstanceReference }): {
        reference: InstanceReference; sourceReference: InstanceReference; url: string;
        geometry: {
            rect: { x: number | null; y: number | null; width: number | null; height: number | null };
            originalSize: { width: number | null; height: number | null };
            offset: { x: number | null; y: number | null };
            borders: { left: number | null; right: number | null; top: number | null; bottom: number | null };
            rotated: boolean | null; trimmed: boolean | null;
        };
        metadataAvailable: boolean;
    };
    function spriteFrameValidate(args: { reference: InstanceReference }): {
        valid: boolean; reference: InstanceReference; sourceReference: InstanceReference;
        issues: Array<{ code: 'SPRITE_FRAME_URL_UNAVAILABLE' | 'SPRITE_FRAME_METADATA_UNAVAILABLE' }>;
    };
    /** Inspect 1–64 explicit references with independent per-item failures. */
    function spriteFrameBatchInspect(args: { references: InstanceReference[] }): {
        items: Array<
            { index: number; ok: true; result: ReturnType<typeof spriteFrameInspect> } |
            { index: number; ok: false; reference: InstanceReference; error: { message: string } }
        >;
        succeeded: number; failed: number; truncated: false;
    };
    /** Validate 1–64 references. succeeded includes valid=false; invalid counts negative validations, failed counts errors. */
    function spriteFrameBatchValidate(args: { references: InstanceReference[] }): {
        outcomes: Array<
            { index: number; ok: true; result: ReturnType<typeof spriteFrameValidate> } |
            { index: number; ok: false; reference: InstanceReference; error: { message: string } }
        >;
        succeeded: number; failed: number; invalid: number; partial: boolean;
    };

    function imageAssetInspect(args: { reference: InstanceReference; maxFrames?: number }): {
        reference: InstanceReference,
        importer: string,
        settings: Record<string, unknown>,
        schema: Record<string, unknown>,
        spriteFrames: Array<{ id: string; type: string; url: string | null; name: string | null }>,
        totalSpriteFrames: number,
        truncated: boolean
    };
    function imageAssetValidate(args: { reference: InstanceReference }): {
        valid: boolean,
        reference: InstanceReference,
        issues: Array<Record<string, unknown>>,
        spriteFrameCount: number
    };

    /** Inspect 1–32 images. Check each result.truncated; the batch envelope does not aggregate SpriteFrame truncation. */
    function imageAssetBatchInspect(args: { references: InstanceReference[]; maxFrames?: number }): {
        items: Array<
            { index: number; ok: true; result: ReturnType<typeof imageAssetInspect> } |
            { index: number; ok: false; reference: InstanceReference; error: { message: string } }
        >;
        succeeded: number; failed: number; truncated: false;
    };
    /** Validate 1–32 image importer metadata results, not decoding or rendered output. succeeded includes valid=false. */
    function imageAssetBatchValidate(args: { references: InstanceReference[] }): {
        outcomes: Array<
            { index: number; ok: true; result: ReturnType<typeof imageAssetValidate> } |
            { index: number; ok: false; reference: InstanceReference; error: { message: string } }
        >;
        succeeded: number; failed: number; invalid: number; partial: boolean;
    };
    /** Bounded metadata only. Compare spriteFrames.length with totalSpriteFrames for capped outputs; inspect each dependency direction's truncated flag. */
    function imageDependencyImpactInspect(args: { reference: InstanceReference; limit?: number; maxFrames?: number; resolveAssets?: boolean }): {
        reference: InstanceReference;
        spriteFrames: ReturnType<typeof imageAssetInspect>['spriteFrames'];
        totalSpriteFrames: number;
        dependencies: ReturnType<typeof assetFindReferences>;
        users: ReturnType<typeof assetFindReferences>;
    };

    function imageSourceMetadataInspect(args: { reference: InstanceReference }): {
        reference: InstanceReference,
        source: { url: string | null; bytes: number },
        width: number | null,
        height: number | null,
        format: string | null,
        space: string | null,
        channels: number | null,
        hasAlpha: boolean | null,
        orientation: number | null,
        density: number | null,
        pages: number | null
    };
    function imageSourceMetadataValidate(args: { reference: InstanceReference; width?: number; height?: number; formats?: string[]; hasAlpha?: boolean; orientation?: number; minDensity?: number; maxDensity?: number; pages?: number }): {
        valid: boolean,
        reference: InstanceReference,
        metadata: ReturnType<typeof imageSourceMetadataInspect>,
        issues: Array<Record<string, unknown>>
    };

    /** 1..32 requests. succeeded counts completed calls, including valid:false; failed counts thrown errors. */
    function imageSourceMetadataBatchValidate(args: { items: Array<Parameters<typeof imageSourceMetadataValidate>[0]> }): {
        outcomes: Array<{ index: number; ok: true; result: ReturnType<typeof imageSourceMetadataValidate> } | { index: number; ok: false; reference: InstanceReference; error: { message: string } }>,
        succeeded: number,
        failed: number,
        invalid: number,
        partial: boolean
    };
    function imageSourceMetadataBatchInspect(args: { references: InstanceReference[] }): {
        items: Array<{ index: number; ok: true; result: ReturnType<typeof imageSourceMetadataInspect> } | { index: number; ok: false; reference: InstanceReference; error: { message: string } }>,
        succeeded: number,
        failed: number
    };

    /** Perform operations on assets (move, copy, delete, open, refresh, reimport, save_meta). */
    function assetOperate(args: {
        operation: "move" | "copy" | "delete" | "open" | "refresh" | "reimport" | "save_meta" | 'stage_import_setting' | 'apply_import_settings' | 'restore_import_settings',
        reference: InstanceReference,
        targetAssetPath?: string,
        /** save_meta only: meta object (or JSON string) read via assetDbQuery "meta", then mutated. */
        meta?: any,
        path?: string,
        value?: AssetImportSettingValue,
        options?: { overwrite?: boolean, rename?: boolean }
    }): { reference: InstanceReference; lifecycle?: { cachedChanged?: true; sourcePersisted?: boolean; sourceSha256?: string; restored?: true; sourceBytesRestored?: true } };

    function assetImporterAudit(args: { reference: InstanceReference }): {
        valid: boolean,
        importer: string,
        settings: Record<string, unknown>,
        source: { uuid: string; url: string; type: string; name: string; isDirectory: boolean },
        issues: string[]
    };

    function assetOpen(args: { reference: InstanceReference }): { reference: InstanceReference };
    function assetCatalogManifest(args: { assetPath?: string; maxAssets?: number; maxFileBytes?: number }): {
        assets: Array<{ uuid: string; url: string; type: string; importer: string; bytes: number; sha256: string }>;
        exclusions: Array<{ uuid: string; url: string; reason: string; bytes?: number; maxFileBytes?: number }>;
        truncated: boolean;
        count: number
    };

    /** Import a bounded batch and return an outcome for every item. */
    function assetBatchImport(args: {
        items: {
            sourceFilesystemPath: string,
            targetAssetPath: string,
            imageType?: "raw" | "texture" | "normal-map" | "sprite-frame" | "texture-cube",
            options?: { overwrite?: boolean, rename?: boolean }
        }[]
    }): {
        outcomes: { index: number, ok: boolean, reference?: InstanceReference, error?: { code: string, status: number, message: string } }[],
        succeeded: number,
        failed: number,
        partial: boolean
    };

    /** Apply a bounded batch of asset operations with per-item recovery evidence. */
    function assetBatchOperate(args: {
        items: {
            operation: "move" | "copy" | "delete" | "open" | "refresh" | "reimport" | "save_meta",
            reference: InstanceReference,
            targetAssetPath?: string,
            meta?: any,
            options?: { overwrite?: boolean, rename?: boolean }
        }[]
    }): {
        outcomes: { index: number, ok: boolean, reference?: InstanceReference, error?: { code: string, status: number, message: string } }[],
        succeeded: number,
        failed: number,
        partial: boolean
    };

    /** Audit all bounded project scenes for serialized UUID references missing from the asset database. */
    function assetMissingReferenceAudit(args?: {
        assetPath?: string,
        maxScenes?: number,
        maxReferences?: number
    }): {
        complete: boolean,
        scannedScenes: number,
        missingReferences: { source: { uuid: string, url: string }, referenceId: string, line: number }[],
        exclusions: { uuid: string, url: string, reason: string, bytes?: number, error?: string }[],
        truncated: boolean,
        dynamicLoadCaveat: string
    };


    function referenceImageManage(args: { operation: "inspect" | "set" | "clear", reference?: InstanceReference, imagePath?: string }): { operation: string, supported: boolean, persisted: boolean, imagePath?: string | null, reference?: InstanceReference | null, result?: unknown };
    function prefabOverrideDiff(args: { reference: InstanceReference, baselineReference: InstanceReference }): { equal: boolean, changes: { path: string, identity: string, before: unknown, after: unknown }[], source: unknown, baseline: unknown };
    function prefabReferenceAudit(args: { reference: InstanceReference, maxReferences?: number }): { valid: boolean, nestedPrefabs: unknown[], missingReferences: unknown[], source: unknown };
    function sceneReferenceValidate(args: { reference: InstanceReference, maxReferences?: number }): { valid: boolean, references: string[], missingReferences: string[], source: unknown };
    function prefabInstantiate(args: { reference: InstanceReference, parentReference?: InstanceReference, name?: string }): { reference: InstanceReference, source: { id: string, url: string }, persisted: boolean, readBack?: unknown };
    /** Creates a linked asset and snapshots the scene; persisted does not certify scene save/reopen. Ambiguous mutation failures must be inspected before retry. */
    function prefabCreateFromNode(args: { reference: InstanceReference; assetPath: string }): {
        reference: InstanceReference; asset: { id: string; type: 'cc.Prefab'; url?: string }; persisted: true;
    };
    interface PrefabFullOperationResult {
        reference: InstanceReference; persisted: true; sceneSaved: false; readBack: unknown;
        sourceReadBack: { id: string; url: string; beforeSha256: string; afterSha256: string };
        sourceChanges: Array<{ path: string; before: unknown; after: unknown }>;
        sourceDiffTruncated: boolean; responseTruncated: boolean; readBackTruncated: boolean; result: unknown;
    }
    /** Applies the full linked instance; no scene save or selective override scope. */
    function prefabUpdate(args: { reference: InstanceReference }): PrefabFullOperationResult & { operation: 'apply' };
    /** Restores the full linked instance; source hashes are retained, but sceneSaved remains false. */
    function prefabRestore(args: { reference: InstanceReference }): PrefabFullOperationResult & { operation: 'revert' };
    function prefabApplyOverrides(args: { reference: InstanceReference, operation?: 'apply' | 'removed_component_apply', fileID?: string, expectedSourceSha256?: string, maxBytes?: number }): { reference: InstanceReference, operation: 'apply' | 'removed_component_apply', persisted: boolean, readBack: unknown, sourceReadBack: { id: string, url: string, beforeSha256: string, afterSha256: string }, sourceChanges?: Array<{ path: string; before: unknown; after: unknown }>, sourceDiffTruncated?: boolean, responseTruncated: boolean, readBackTruncated?: boolean, sceneSaved: false, outcome?: 'verified', rollbackStatus?: string, fileID?: string };
    function prefabInstanceInspect(args: { reference: InstanceReference; maxOverrides?: number; maxBytes?: number }): { reference: InstanceReference; isPrefabInstance: boolean; prefabReference: InstanceReference | null; overrides: unknown[]; mountedChildren: unknown[]; mountedComponents: unknown[]; removedComponents: unknown[]; overrideCounts: Record<'propertyOverrides' | 'mountedChildren' | 'mountedComponents' | 'removedComponents', number>; totalOverrides: number; truncated: boolean; responseTruncated: boolean; readBackTruncated: boolean; source: { id: string; url: string; sha256: string } | null; readBack: unknown };
    /** Full restore remains distinct; selective removed-component restore uses an authoritative prefab fileID. Nonempty arbitrary paths remain unsupported. */
    function prefabRevertOverrides(args: { reference: InstanceReference, operation?: 'revert' | 'removed_component_revert', fileID?: string, paths?: string[], maxBytes?: number }): { reference: InstanceReference, operation: 'revert' | 'removed_component_revert', persisted: boolean, readBack: unknown, sourceReadBack: { id: string, url: string, beforeSha256: string, afterSha256: string }, sceneSaved?: false, outcome?: 'verified', rollbackStatus?: string, fileID?: string };
    function prefabInfo(args: { reference?: InstanceReference, assetPath?: string }): { reference: InstanceReference, url: string, uuid: string, rootNode: unknown, totalEntries: number, components: string[], references: string[] };
    function prefabValidate(args: { reference?: InstanceReference, assetPath?: string, maxReferences?: number }): { valid: boolean, complete: boolean, truncated: boolean, totalReferences: number, reference: InstanceReference, url: string, uuid: string, references: string[], missingReferences: { id: string }[], issues: { code: string, id: string }[], totalEntries: number };
    function tilemapInspect(args: { reference: InstanceReference, maxLayers?: number }): { reference: InstanceReference, format: "tmx", map: Record<string, unknown>, tilesets: Record<string, unknown>[], layers: Array<{ id: string, name: string, width: number, height: number, visible: boolean, opacity: number, offsetX: number, offsetY: number, tileCount: number }>, objectGroups: Array<{ id: string, name: string, objects: Array<{ id: string, name: string, type: string, x: number, y: number, width: number, height: number }> }>, count: number };
    function tilemapLayerEdit(args: { reference: InstanceReference, path: `layers.${string}.${string}`, value: unknown }): { reference: InstanceReference, path: string, changed: boolean, previous: unknown, readBack: unknown, persisted: boolean, source: { url: string, beforeSha256: string, afterSha256: string } };
    function tilemapObjectEdit(args: { reference: InstanceReference, path: `objects.${string}.${string}`, value: unknown }): { reference: InstanceReference, path: string, changed: boolean, previous: unknown, readBack: unknown, persisted: boolean, source: { url: string, beforeSha256: string, afterSha256: string } };
    function tilemapValidate(args: { reference: InstanceReference }): { reference: InstanceReference, valid: boolean, missingReferences: { id: string }[], checkedNodes: number, source: { url: string, sha256: string, references: string[] } };
    function spriteAtlasConfigure(args: { reference: InstanceReference, presetId: "default" | "MaxRects" | "Basic", maxWidth?: number, maxHeight?: number }): { reference: InstanceReference, presetId: string, changed: boolean, operations: unknown[], generatedOutputs: { path: string, bytes: number, sha256: string }[], sourceSha256: string, settings: Record<string, unknown>, persisted: boolean };
    function uiAccessibilityAudit(args: { root?: InstanceReference, rootPath?: string, maxNodes?: number, maxIssues?: number }): { complete?: boolean, valid?: boolean, truncated?: boolean, checkedNodes?: number, root?: { uuid: string, path: string, name: string }, nodes?: unknown[], issues?: unknown[], truncation?: unknown[], error?: { code: string, message: string, evidence: Record<string, unknown> } };
    function uiResponsivePreview(args: { resolutions: { width: number, height: number }[], reference?: InstanceReference }): { supported: boolean, comparisons: Array<{ resolution: { width: number, height: number }, scale: { x: number, y: number }, projectedRects: unknown[], evidence: string }>, stable: boolean, caveat: string };
    /** Rejects with UNSUPPORTED_PREVIEW_IPC on Creator 3.7.3 because preview:set-resolution is not exposed. */
    function previewResolutionSet(args: { width: number, height: number }): { width: number, height: number, persisted: boolean, supported: boolean, readBack?: unknown };

    function physics2dQuery(args?: { reference?: InstanceReference }): { valid: boolean; nodes: Array<Record<string, unknown>>; issues: string[]; checkedNodes: number };
    function physics3dQuery(args?: { reference?: InstanceReference }): { valid: boolean; nodes: Array<Record<string, unknown>>; issues: string[]; checkedNodes: number };
    function shaderValidate(args: { effectName: string }): { valid: boolean; effectName: string; diagnostics: Array<Record<string, unknown>>; result: unknown };
    /** Creates a native graph asset only when Creator returns and preserves an imported UUID; failure attempts rollback. */
    function animationGraphCreate(args: { assetPath: string; options?: { overwrite?: boolean; rename?: boolean } }): { reference: InstanceReference; assetPath: string; verified: true };
    /** Serialized Terrain component metadata only; properties remain editor descriptors, not normalized geometry or runtime state. */
    function terrainInspect(args: { reference?: InstanceReference }): {
        terrains: Array<{ node: { id: string; type: 'cc.Node' }; name: string; properties: unknown }>;
        count: number;
    };
    /** Creator 3.7 legacy terrain path editing is refused; native cell edit requires Creator 3.8. */
    function terrainEdit(args: Record<string, unknown>): Record<string, unknown>;
    function modelImportConfigure(args: { reference: InstanceReference; path: string; value: unknown }): { changed: boolean; path: string; previous: unknown; readBack: unknown; result: Record<string, unknown> };

    function physics2dConfigure(args: { path: string; value: unknown }): { success: boolean; path: string; readBack: unknown };
    function physics3dConfigure(args: { path: string; value: unknown }): { success: boolean; path: string; readBack: unknown };
    function physics2dInspect(args?: { reference?: InstanceReference }): { nodes: Array<Record<string, unknown>>; count: number };
    function physics2dValidate(args?: { reference?: InstanceReference }): { valid: boolean; issues: string[]; checkedNodes: number };
    function physics2dTopologyAudit(args?: { reference?: InstanceReference }): { valid: boolean; nodes: Array<Record<string, unknown>>; issues: string[]; checkedNodes: number };
    function physics2dCompatibilityAudit(args: { backend: 'builtin' | 'box2d'; reference?: InstanceReference }): { valid: boolean; backend: 'builtin' | 'box2d'; nodes: Array<Record<string, unknown>>; issues: string[]; checkedNodes: number };
    function physics3dInspect(args?: { reference?: InstanceReference }): { nodes: Array<Record<string, unknown>>; count: number };
    function physics3dTopologyAudit(args?: { reference?: InstanceReference }): { valid: boolean; nodes: Array<Record<string, unknown>>; issues: string[]; checkedNodes: number };
    function physics3dValidate(args?: { reference?: InstanceReference }): { valid: boolean; issues: string[]; checkedNodes: number };
    function particleInspect(args?: { reference?: InstanceReference }): { systems: Array<Record<string, unknown>>; count: number };
    function particleValidate(args?: { reference?: InstanceReference }): { valid: boolean; issues: string[]; checkedNodes: number };
    function particleConfigure(args: { reference: InstanceReference; properties: Record<string, unknown> }): { reference: InstanceReference; componentReference: InstanceReference; properties: Record<string, unknown>; changed: string[]; verified: true };

    function audioSourceInspect(args?: { reference?: InstanceReference }): { sources: Array<Record<string, unknown>>; count: number };
    function audioSourceAudit(args?: { reference?: InstanceReference }): { valid: boolean; sources: Array<Record<string, unknown>>; issues: string[]; checkedSources: number };
    function audioAssetValidate(args: { reference: InstanceReference }): { valid: boolean; importer: string; type: string; issues: string[] };


    /** Configure serialized AudioSource properties with read-back and rollback on mutation failure; does not start playback. */
    function audioSourceConfigure(args: {
        reference: InstanceReference & { type: 'cc.Node' | 'cc.AudioSource' },
        properties: { volume?: number; loop?: boolean; playOnAwake?: boolean; clip?: InstanceReference & { type: 'cc.AudioClip' } }
    }): {
        reference: InstanceReference,
        componentReference: InstanceReference & { type: 'cc.AudioSource' },
        properties: { volume: number; loop: boolean; playOnAwake: boolean; clip: InstanceReference | null },
        changed: Array<'volume' | 'loop' | 'playOnAwake' | 'clip'>,
        verified: true
    };

    /** Lists available component class names after optional literal filter (case-insensitive by default); result prefix is capped at 1–1000 and total counts filtered registry rows. */
    function nodeGetAvailableComponentTypes(args?: { includeInternal?: boolean; scriptReference?: InstanceReference; requireSingle?: boolean; filter?: string; filterMatch?: 'contains' | 'exact' | 'prefix' | 'suffix'; filterCaseSensitive?: boolean; limit?: number }): {
        registrations: Array<{ name: string; type: string | null; assetUuid: string | null }>;
        componentTypes: string[]; total: number; truncated: boolean;
    };
    /** Reads up to 10000 serialized components bound to the requested node UUID; malformed/duplicate component identities throw before filtering rather than returning partial matches. Raw IPC allocation is not capped. */
    function nodeComponentsGet(args: { reference: InstanceReference; componentReference?: InstanceReference; componentIndex?: number; componentType?: string; componentTypes?: string[]; excludeComponentTypes?: string[]; enabled?: boolean; requireSingle?: boolean; requireMatch?: boolean; offset?: number; limit?: number; expectedRevision?: string }): { references: Array<InstanceReference & { componentIndex: number; enabled?: boolean }>; inventorySummary: { total: number; enabled: number; disabled: number; unknownEnabled: number; classCounts: Record<string, number> }; total: number; offset: number; nextOffset: number | null; truncated: boolean; revision: string };
    type ComponentInventorySummary = ReturnType<typeof nodeComponentsGet>['inventorySummary'];
    type ComponentBatchOutcome = { index: number; reference: InstanceReference } & (
        | { ok: true; result: ReturnType<typeof nodeComponentsGet> | { detailsOmitted: true; inventorySummary: ComponentInventorySummary; total: number; revision: string } }
        | { ok: false; error: { status: number; code: string; message: string; details?: Record<string, unknown>; identityMismatch?: { requestedNodeId: string; observedNodeId: string | null }; stateIdentity?: { nodeId: string; componentId: string; componentIndex: number }; matchCount?: number; revision?: string; inventorySummary?: ComponentInventorySummary; missingComponentTypes?: string[]; forbiddenComponentTypes?: string[]; forbiddenComponentCounts?: Record<string, number>; componentCountViolation?: { componentCount: number; minComponents?: number; maxComponents?: number }; unexpectedComponentCounts?: Record<string, number>; duplicateComponentCounts?: Record<string, number> } }
    );
    /** Sequential read-only inventory for1..32 nodes, default50/max100 components per node; errors remain per-item. Continue individual inventories with nodeComponentsGet and their revision. */
    function nodeComponentsBatchGet(args: { references: InstanceReference[]; offsets?: Array<{ reference: InstanceReference; offset: number }>; expectedRevisions?: Array<{ reference: InstanceReference; revision: string }>; requireRevisions?: boolean; componentTypes?: string[]; excludeComponentTypes?: string[]; requiredComponentTypes?: string[]; forbiddenComponentTypes?: string[]; allowedComponentTypes?: string[]; singletonComponentTypes?: string[]; minComponents?: number; maxComponents?: number; enabled?: boolean; requireSingle?: boolean; requireMatch?: boolean; summaryOnly?: boolean; requireAll?: boolean; limitPerNode?: number }): { items: ComponentBatchOutcome[]; errorCounts: Record<string, number>; succeeded: number; failed: number; truncated: boolean; inventorySummary: { observedNodes: number; failedNodes: number; matchedNodes: number; unmatchedNodes: number; matchedComponents: number; total: number; enabled: number; disabled: number; unknownEnabled: number; classDistribution: Record<string, { instances: number; nodes: number }> } };
    /** Lists classes known to the editor, optionally filtered by base class; filtering applies to returned class names. */
    function listComponentClasses(args: { extends?: string; excludeSelf?: boolean; filter?: string }): { classes: string[] };

    /** Get info about the current scene: bounds (canvas/scene size), unsaved changes (dirty), and which scene asset is open. */
    function sceneGetInfo(): { bounds: { x: number, y: number, width: number, height: number }, dirty: boolean, currentScene?: { uuid?: string, url?: string, name?: string } };

    /** Find all nodes in the current scene that reference the given asset uuid (reverse-reference / impact analysis). */
    function findNodesByAsset(args: { reference: InstanceReference }): { references: InstanceReference[] };

    /** Read-only AND filters; componentTypes use componentMatch all/any/none/only/subset with observed class aliases; subtree includes root unless includeRoot:false. */
    function findNodes(args: { references?: InstanceReference[]; requireAllReferences?: boolean; name?: string; names?: string[]; excludeNames?: string[]; nameMatch?: 'contains' | 'exact' | 'prefix' | 'suffix'; nameCaseSensitive?: boolean; componentType?: string; componentTypes?: string[]; excludeComponentTypes?: string[]; componentMatch?: 'all' | 'any' | 'none' | 'only' | 'subset'; pathContains?: string; pathCaseSensitive?: boolean; pathMatch?: 'contains' | 'exact' | 'prefix' | 'suffix'; active?: boolean; hierarchyActive?: boolean; minComponents?: number; maxComponents?: number; parentReference?: InstanceReference; parentReferences?: InstanceReference[]; minChildren?: number; maxChildren?: number; siblingIndex?: number; minSiblingIndex?: number; maxSiblingIndex?: number; minSiblingCount?: number; maxSiblingCount?: number; siblingPosition?: 'first' | 'last' | 'only'; rootReference?: InstanceReference; includeRoot?: boolean; excludeReferences?: InstanceReference[]; minDepth?: number; maxDepth?: number; maxResults?: number; summaryOnly?: boolean; requireSingle?: boolean; requireMatch?: boolean }): { nodes: Array<{ reference: InstanceReference; parentReference: InstanceReference | null; name: string; path: string; depth: number; componentCount: number; childCount: number; siblingIndex: number | null; siblingCount: number | null; active: boolean | null; hierarchyActive: boolean | null }>; total: number; truncated: boolean; detailsOmitted?: true };
    function sceneHierarchyAnalyze(args?: { rootReference?: InstanceReference; limit?: number }): { rootReference?: InstanceReference; checkedNodes: number; maxDepth: number; depthCounts: Record<string, number>; childCountDistribution: Record<string, number>; componentCountDistribution: Record<string, number>; missingNodeUuidCount: number; duplicateNodeUuids: Array<{ uuid: string; count: number }>; leafNodes: number; containerNodes: number; unknownChildrenNodes: number; nodesWithComponents: number; nodesWithoutComponents: number; unknownComponentsNodes: number; truncated: boolean; activeNodes: number; inactiveNodes: number; unknownActiveNodes: number; componentCounts: Record<string, number>; componentNodeCounts: Record<string, number>; duplicateNames: Array<{ name: string; count: number }>; siblingNameCollisions: Array<{ parentReference: InstanceReference; name: string; references: InstanceReference[] }>; unknownComponentCount: number; issues: string[] };
    /** Bounded path lookup with collision counts. pathUnique describes observed slash-joined paths, not future lookup stability; retain UUIDs for mutation. */
    function nodeGetPath(args: { reference: InstanceReference; relativeTo?: InstanceReference; includeRoot?: boolean; requireUnique?: boolean; expectedPath?: string; expectedAncestors?: InstanceReference[]; expectedSiblingIndex?: number | null; expectedSiblingCount?: number | null; expectedNextSibling?: InstanceReference | null; expectedPreviousSibling?: InstanceReference | null; expectedChildCount?: number; expectedDescendantCount?: number; expectedChildren?: InstanceReference[] }): { reference: InstanceReference; path: string; segments: string[]; depth: number; childCount: number; descendantCount: number; subtreeHeight: number; subtreeLeafCount: number; relativeTo?: InstanceReference; pathUnique: boolean; matchingNodeCount: number; ancestors: InstanceReference[]; parentReference: InstanceReference | null; siblingIndex: number | null; siblingCount: number | null; previousSibling: InstanceReference | null; nextSibling: InstanceReference | null; firstChild: InstanceReference | null; lastChild: InstanceReference | null };
    type NodePathBatchOutcome = { index: number; reference: InstanceReference } & (
        | { ok: true; result: ReturnType<typeof nodeGetPath> }
        | { ok: false; error: { status: number; code: string; message: string; recovery?: string; details?: { nodeId?: string; expectedDescendantCount?: number; descendantCount?: number; expectedChildCount?: number; childCount?: number; expectedPath?: string; path?: string; matchingNodeCount?: number; expectedAncestorIds?: string[]; ancestorIds?: string[]; expectedSiblingIndex?: number | null; siblingIndex?: number | null; expectedSiblingCount?: number | null; siblingCount?: number | null; expectedNextSiblingId?: string | null; nextSiblingId?: string | null; expectedPreviousSiblingId?: string | null; previousSiblingId?: string | null } } }
    );
    /** Resolve1..32 UUIDs from one captured bounded hierarchy; target failures are isolated, common hierarchy errors fail the batch. Not an atomic editor transaction. */
    function nodeGetPaths(args: { references: InstanceReference[]; expectedPaths?: Array<{ reference: InstanceReference; path: string }>; expectedAncestors?: Array<{ reference: InstanceReference; ancestors: InstanceReference[] }>; expectedSiblingIndices?: Array<{ reference: InstanceReference; siblingIndex: number | null }>; expectedSiblingCounts?: Array<{ reference: InstanceReference; siblingCount: number | null }>; expectedNeighbors?: Array<{ reference: InstanceReference; previousSibling: InstanceReference | null; nextSibling: InstanceReference | null }>; expectedChildCounts?: Array<{ reference: InstanceReference; childCount: number }>; expectedDescendantCounts?: Array<{ reference: InstanceReference; descendantCount: number }>; relativeTo?: InstanceReference; includeRoot?: boolean; requireUnique?: boolean; requireAll?: boolean; requireDisjoint?: boolean; requireDistinct?: boolean; requireSameParent?: boolean; requireSameDepth?: boolean; requireContiguous?: boolean; requireCompleteSiblings?: boolean; requireCompleteSubtrees?: boolean; requireInputOrder?: boolean; requireSiblingIndices?: boolean; requireSiblingCounts?: boolean; requireNeighbors?: boolean; requireChildCounts?: boolean; requireDescendantCounts?: boolean; requireAncestors?: boolean; requirePaths?: boolean }): { items: NodePathBatchOutcome[]; errorCounts: Record<string, number>; subtreeSelectionCoverage: { selectedCount: number; subtreeNodeCount: number; unselectedCount: number; complete: boolean } | null; selectionParentCounts: Array<{ parentReference: InstanceReference | null; references: InstanceReference[]; count: number; siblingCount: number | null; complete: boolean | null }> | null; selectionDepthCounts: Record<string, number> | null; selectionDepthRange: { min: number; max: number } | null; succeeded: number; failed: number; selectedSubtreeNodeCount: number | null; commonAncestor: InstanceReference | null; sharedParent: InstanceReference | null; siblingOrder: InstanceReference[] | null; siblingBlocks: Array<{ firstIndex: number; lastIndex: number; references: InstanceReference[] }> | null; siblingSpan: { firstIndex: number; lastIndex: number; gapCount: number } | null; selectionRoots: InstanceReference[]; selectionCoverage: Array<{ reference: InstanceReference; selectionRoot: InstanceReference; distanceFromSelectionRoot: number }> };

    /** Find all nodes whose asset references are missing/broken. QA/health check for scene integrity. */
    function findNodesWithMissingAssets(): { references: InstanceReference[] };

    /** Scan the open scene/prefab for unregistered script classes and return exact node paths plus repair inputs. */
    function sceneScriptHealthScan(args?: { limit?: number }): {
        findings: {
            nodeReference: InstanceReference,
            nodeName: string,
            nodePath: string,
            componentReference?: InstanceReference,
            classId: string,
            repair: string
        }[],
        total: number,
        truncated: boolean
    };

    interface SceneScriptUsage {
        /** Validated non-empty native hierarchy UUID; re-read the node before mutation because scene state may drift. */
        nodeReference: { id: string; type: 'cc.Node' };
        nodePath: unknown;
        componentReference: InstanceReference | null;
        classId: string;
    }
    /** Read-only custom-script usage, capped result prefix with observed total. Repeated nodes or traversal beyond 10000 scheduled nodes refuse; not an atomic scene snapshot. */
    function sceneScriptUsageInspect(args?: { classId?: string; limit?: number }): { usages: SceneScriptUsage[]; total: number; truncated: boolean };
    /** Verifies imported script identity and rechecks asset/class binding after scanning. Transport errors and observed drift throw rather than reporting missing usage. */
    interface ScriptAssetSceneUsageResult {
        scriptReference: InstanceReference; classId: string; usages: SceneScriptUsage[]; total: number; truncated: boolean;
    }
    function scriptAssetSceneUsageInspect(args: { scriptReference: InstanceReference; limit?: number }): ScriptAssetSceneUsageResult;
    /** Inspects 1–32 scripts independently; errors do not imply complete or empty usage. No automatic child retry; each result retains its own truncation. */
    function scriptAssetSceneUsageBatchInspect(args: { scriptReferences: InstanceReference[]; limitPerScript?: number }): {
        items: Array<{ index: number; scriptReference: InstanceReference } & (
            { ok: true; result: ScriptAssetSceneUsageResult } |
            { ok: false; error: { code: string; message: string; recovery?: string } }
        )>;
        succeeded: number; failed: number; truncated: boolean; partial: boolean;
    };
    /** Counts all usages in the returned bounded hierarchy, without the inspection prefix cap. countsComplete=true does not imply an atomic scene snapshot. truncated describes omitted classes/node details. Traversal/class budget overflow refuses rather than returning partial counts. */
    function sceneScriptUsageSummary(args?: { maxClasses?: number; maxNodesPerClass?: number }): {
        classes: Array<{ classId: string; count: number; nodes: Array<{ nodeReference: SceneScriptUsage['nodeReference']; nodePath: unknown; componentReference: InstanceReference | null }>; truncated: boolean }>;
        totalClasses: number; totalUsages: number; countsComplete: true; truncated: boolean;
    };
    /** Replace one invalid script component with an existing registered class or script asset. */
    function sceneScriptRepair(args: {
        nodeReference: InstanceReference,
        componentReference?: InstanceReference,
        expectedClassId?: string,
        replacementClassId?: string,
        scriptReference?: InstanceReference
    }): { success: boolean, removedComponent?: string, createdComponent: InstanceReference };

    /** Reset nodes, one component, or one property to defaults. operation property needs a single uuid + propertyPath. */
    function nodeReset(args: { operation: "node" | "component" | "property", references: InstanceReference[], propertyPath?: string }): { success: boolean, error?: string };

    /** Execute a method on a component by its uuid. Arguments and return value must be JSON-serializable. Get the component uuid via nodeComponentsGet. */
    function callComponentMethod(args: { reference: InstanceReference, methodName: string, methodArgs?: any[] }): { result: any };

    /** List classes known to the editor, optionally filtered by base class (e.g. "cc.Component"). Helps resolve valid class names before nodeComponentAdd. */
    /** Lists classes known to the editor, optionally filtered by base class; filtering applies to returned class names. */
    function listComponentClasses(args?: { extends?: string; excludeSelf?: boolean; filter?: string }): { classes: string[] };

    /** Discovered methods are not automatically permitted; finite invocation allowlist is reported separately. */
    function listComponentMethods(args: { reference: InstanceReference }): {
        components: { reference: InstanceReference, methods: string[], permittedMethods: string[], deniedMethods: string[], permissionReason: string }[]
    };

    /** Copy/cut/paste nodes. For paste pass targetReference plus the copied references. Returns references of pasted nodes for paste. */
    function nodeClipboard(args: {
        operation: "copy" | "cut" | "paste",
        references: InstanceReference[],
        targetReference?: InstanceReference,
        keepWorldTransform?: boolean,
        pasteAsChild?: boolean
    }): { success: boolean, references?: InstanceReference[] };

    /** Get the hierarchy tree of specific node or scene root. Pass maxDepth/maxNodes/fields to bound payload (wide scenes). */
    function nodeGetTree(args: { reference?: InstanceReference, maxDepth?: number, maxNodes?: number, fields?: string[] }): IHierarchyTree;

    /** Get nodes at specific path in the scene hierarchy. */
    function nodeGetAtPath(args: { hierarchyPath: string }): { references?: InstanceReference[] };

    /** Create a new node with predefined primitive geometry. */
    function nodeCreatePrimitive(args: {
        name?: string,
        primitiveType?: "Capsule" | "Cone" | "Cube" | "Cylinder" | "Plane" | "Quad" | "Sphere" | "Torus",
        parentReference?: InstanceReference
    }): { reference: InstanceReference };

    /** Create a new node in the scene. */
    function nodeCreate(args: {
        name: string,
        parentReference?: InstanceReference,
        assetReference?: InstanceReference
    }): { reference: InstanceReference };

    /** Perform operation on referenced node, including prefab operations and hierarchy lock/unlock. link_prefab binds an existing node to a prefab asset (inverse of unwrap_prefab). */
    function nodeOperate(args: {
        operation: "move" | "copy" | "delete" | "lock" | "unlock" | "create_prefab" | "link_prefab" | "revert_prefab" | "apply_prefab" | "unwrap_prefab" | "unwrap_prefab_completely" | "open_prefab",
        reference: InstanceReference,
        newParentReference?: InstanceReference,
        newPrefabPath?: string,
        prefabAssetReference?: InstanceReference,
        siblingIndex?: number,
        recursive?: boolean
    }): {
        success?: boolean,
        createdPrefabAssetReference?: InstanceReference,
        updatedNodeReference?: InstanceReference,
        copiedNodeReference?: InstanceReference
    };

    /** Get info about the current editor environment: editor version, engine version and paths, native engine info, current project path. */
    function editorEnvInfo(): { editor: string, engineVersion: string, enginePath?: string, nativeVersion?: string, nativePath?: string, projectPath: string };

    /** Undo/redo/last-op snapshot; abort drops a pending snapshot without creating an undo step. */
    function editorHistory(args: { operation: "undo" | "redo" | "abort" }): { success: boolean, error?: string };

    /** Control the editor scene viewport: focus camera on nodes, 2D/3D mode, grid visibility, icon gizmo 3D/size, gizmo tool/pivot/coordinate, align view/node (align ops act on the current selection). query_viewport reads 2D/grid/icon state, query_gizmo reads gizmo state. Frame nodes before editorGetScenePreview. */
    function editorViewport(args: {
        operation: "focus" | "set_2d_mode" | "set_grid_visible" | "set_icon_gizmo_3d" | "set_icon_gizmo_size" | "set_gizmo_tool" | "set_gizmo_pivot" | "set_gizmo_coordinate" | "query_gizmo" | "query_viewport" | "align_view_to_selected_node" | "align_selected_node_to_view",
        references?: InstanceReference[],
        enabled?: boolean,
        size?: number,
        gizmoTool?: "move" | "rotate" | "scale" | "rect",
        gizmoPivot?: "center" | "pivot",
        gizmoCoordinate?: "local" | "global"
    }): {
        success: boolean,
        error?: string,
        gizmoTool?: string,
        gizmoPivot?: string,
        gizmoCoordinate?: string,
        is2D?: boolean,
        gridVisible?: boolean,
        iconGizmo3D?: boolean,
        iconGizmoSize?: number
    };

    /** Select, deselect, clear, hover, update or query the editor selection for nodes or assets. select_all selects every node of the scene. hover with no reference = hover-out. Enables align operations in editorViewport. */
    function editorSelect(args: {
        operation: "select" | "unselect" | "clear" | "query" | "select_all" | "hover" | "update",
        selectionType?: "node" | "asset",
        references?: InstanceReference[]
    }): { success: boolean, selected?: string[], lastSelected?: string, lastSelectedType?: string };

    /** Read animation data. Start with root_info on any node. clip_dump returns a track summary unless includeCurves is set. */
    function animationQuery(args: {
        operation: "root_info" | "root" | "edit_info" | "clips_info" | "clip_dump" | "properties" | "state" | "current_info" | "clip_time" | "value_at_frame",
        nodeReference?: InstanceReference,
        clipReference?: InstanceReference,
        includeCurves?: boolean,
        nodePath?: string,
        propKey?: string,
        frame?: number
    }): { result: any };

    /** Edit animation clips. Flow: record_start (root node + clip) -> operate -> save_clip -> record_stop. */
    function animationEdit(args: {
        operation: "record_start" | "record_stop" | "change_root" | "set_edit_clip" | "set_edit_time" | "clip_state" | "save_clip" | "operate",
        nodeReference?: InstanceReference,
        clipReference?: InstanceReference,
        time?: number,
        clipState?: "play" | "pause" | "resume" | "stop",
        operations?: { funcName: string, args: any[] }[]
    }): { success: boolean, error?: string, result?: any };

    /** Configure native clip sample rate, speed, or wrap mode. */
    function animationClipConfigure(args: {
        clipReference: InstanceReference,
        operation: "sample" | "speed" | "wrap_mode",
        value: number
    }): { success: boolean, error?: string, result?: any };

    /** Create, remove, move, or copy native animation property tracks. */
    function animationTrackEdit(args: {
        clipReference: InstanceReference,
        operation: "create" | "remove" | "move_node" | "copy_to",
        nodePath: string,
        propKey: string,
        destinationNodePath?: string,
        destinationPropKey?: string
    }): { success: boolean, error?: string, result?: any };

    /** Create, move, remove, copy, space, clear, or retime native animation keyframes. */
    function animationKeyframeEdit(args: {
        clipReference: InstanceReference,
        operation: "create" | "move" | "remove" | "update" | "copy_to" | "spacing" | "clear" | "modify_curve",
        nodePath: string,
        propKey: string,
        frame?: number,
        frames?: number[],
        offsets?: number | number[],
        destinationFrame?: number,
        spacingFrames?: number,
        customData?: unknown,
        curveData?: unknown
    }): { success: boolean, error?: string, result?: any };

    /** Add, update, move, copy, or delete ordered animation event keyframes. */
    function animationEventEdit(args: {
        clipReference: InstanceReference,
        operation: "add" | "update" | "move" | "copy_to" | "delete",
        frame?: number,
        frames?: number[],
        destinationFrame?: number,
        offset?: number,
        functionName?: string,
        parameters?: string[],
        events?: unknown[]
    }): { success: boolean, error?: string, result?: any };
    interface AnimationTimelineKeyframe { index: number; frame: number | null; frameOverSample: number | null; dataValid: boolean }
    interface AnimationTimelineTrack {
        index: number;
        identity: { nodePath: string | null; property: string | null };
        component: string | null; parentProperty: string | null; displayName: string | null;
        keyframeCount: number | null; keyframeOffset: number; nextKeyframeOffset: number | null;
        matchedKeyframes: number | null;
        /** Invalid key rows across the whole retrieved track, independent of timing filters/pages; null when native keys are unavailable. */
        invalidKeyframes: number | null;
        /** Coverage of matching timing keys, not opaque values/binding/runtime validity. Missing keys cannot prove complete. */
        keyframeLimit: number; keyframesComplete: boolean; keyframesTruncated: boolean;
        keyframes: AnimationTimelineKeyframe[];
        frameRange: { first: number; last: number } | null;
        frameOverSampleRange: { first: number; last: number } | null;
        dataValid: boolean;
    }
    interface AnimationTimelineEvent { index: number; frame: number | null; frameOverSample: number | null; callback: string | null; params: string[] | null; dataValid: boolean }
    interface AnimationTimelineInspection { diagnosticSummary: Array<{ code: string; count: number }>; diagnosticCode: string | null; matchedDiagnostics: number; diagnosticOffset: number; diagnosticLimit: number; nextDiagnosticOffset: number | null; invalidKeyframesOnly: boolean; invalidEventsOnly: boolean; invalidTracksOnly: boolean; invalidTracks: number | null; invalidEvents: number | null; keyframeFrameRange: { min: number; max: number } | null; eventFrameRange: { min: number; max: number } | null; matchedEvents: number | null; eventCallback: string | null; matchedTracks: number | null; trackBinding: { nodePath: string; component?: string; parentProperty?: string; property: string } | null; revision: string; revisionScope: string; nodeReference: InstanceReference; clipReference: InstanceReference; identity: { node: string; clip: string; dumpClipUuidExposed: boolean; dumpNodeUuidExposed: boolean }; clip: { name: string | null; sample: number | null; duration: number | null; speed: number | null; wrapMode: number | null }; sourceScope: string; timingUnit: string; validityScope: string; valid: boolean; sourceComplete: boolean; complete: boolean; truncated: boolean; totalTracks: number | null; retrievedTracks: number | null; totalEvents: number | null; inspectedKeyframes: number; trackOffset: number; trackLimit: number; eventOffset: number; eventLimit: number; nextTrackOffset: number | null; nextEventOffset: number | null; tracks: AnimationTimelineTrack[]; events: AnimationTimelineEvent[]; diagnostics: Array<{ code: string; location: string }>; diagnosticCount: number; diagnosticsTruncated: boolean; runtimeVerified: false; sceneSaved: false; callbackExistenceVerified: false }
    function animationTimelineInspect(args: { diagnosticCode?: string; diagnosticOffset?: number; diagnosticLimit?: number; invalidKeyframesOnly?: boolean; invalidEventsOnly?: boolean; invalidTracksOnly?: boolean; nodeReference: InstanceReference; clipReference: InstanceReference; keyframeFrameRange?: { min: number; max: number }; eventFrameRange?: { min: number; max: number }; eventCallback?: string; trackBinding?: { nodePath: string; component?: string; parentProperty?: string; property: string }; trackOffset?: number; trackLimit?: number; eventOffset?: number; eventLimit?: number; keyframeOffset?: number; keyframeLimit?: number; expectedRevision?: string; maxBytes?: number }): AnimationTimelineInspection;
    type ComponentPropertyDescriptor = { animatable?: boolean; editorOnly?: boolean; serializable?: boolean; formerlySerializedAs?: string; tooltip?: string; displayName?: string; group?: string; visible?: boolean; readOnly?: boolean; displayOrder?: number } & (
    | { name: string; type: 'number'; array?: false; default?: number; range?: { min: number; max: number; slider?: boolean; step?: number } }
    | { name: string; type: 'integer'; array?: false; default?: number; range?: { min: number; max: number; slider?: boolean; step?: number } }
    | { name: string; type: 'enum'; array?: false; entries: Array<{ name: string; value: number }>; default: number }
    | { name: string; type: 'enum'; array: true; entries: Array<{ name: string; value: number }>; default?: number[] }
    | { name: string; type: 'string'; array?: false; default?: string; multiline?: boolean }
    | { name: string; type: 'boolean'; array?: false; default?: boolean }
    | { name: string; type: 'Vec2'; array?: false; default?: { x: number; y: number } }
    | { name: string; type: 'Vec3'; array?: false; default?: { x: number; y: number; z: number } }
    | { name: string; type: 'Vec4'; array?: false; default?: { x: number; y: number; z: number; w: number } }
    | { name: string; type: 'Size'; array?: false; default?: { width: number; height: number } }
    | { name: string; type: 'Rect'; array?: false; default?: { x: number; y: number; width: number; height: number } }
    /** Native cc.Quat data, finite xyzw preserved without normalization; omitted scalar is identity. */
    | { name: string; type: 'Quat'; array?: false; default?: { x: number; y: number; z: number; w: number } }
    | { name: string; type: 'Color'; array?: false; default?: { r: number; g: number; b: number; a: number } }
    | { name: string; type: 'Node' | 'UITransform' | 'Layout' | 'Widget' | 'Mask' | 'Canvas' | 'Label' | 'Sprite' | 'Button' | 'EditBox' | 'ScrollView' | 'Slider' | 'Toggle' | 'ProgressBar' | 'AudioSource' | 'Animation' | 'Camera' | 'MeshRenderer' | 'SkinnedMeshRenderer' | 'ParticleSystem' | 'ParticleSystem2D' | 'SkeletalAnimation' | 'AudioClip' | 'AnimationClip' | 'SpriteFrame' | 'Prefab' | 'Material' | 'JsonAsset' | 'TextAsset' | 'Texture2D' | 'Font' | 'TTFFont' | 'BitmapFont' | 'SpriteAtlas' | 'SceneAsset' | 'Mesh' | 'Skeleton' | 'RigidBody' | 'Collider' | 'RigidBody2D' | 'Collider2D' | 'BoxCollider' | 'SphereCollider' | 'CapsuleCollider' | 'MeshCollider' | 'BoxCollider2D' | 'CircleCollider2D' | 'PolygonCollider2D' | 'UIOpacity' | 'RichText' | 'ToggleContainer' | 'PageView' | 'PageViewIndicator' | 'ScrollBar' | 'SafeArea' | 'BlockInputEvents' | 'UICoordinateTracker' | 'HingeConstraint' | 'FixedConstraint' | 'PointToPointConstraint' | 'DistanceJoint2D' | 'SpringJoint2D' | 'FixedJoint2D' | 'HingeJoint2D' | 'MouseJoint2D' | 'RelativeJoint2D' | 'SliderJoint2D' | 'WheelJoint2D' | 'ImageAsset' | 'TextureCube' | 'EffectAsset' | 'PhysicsMaterial' | 'DirectionalLight' | 'SphereLight' | 'SpotLight' | 'RenderTexture' | 'LabelOutline' | 'LabelShadow' | 'Graphics' | 'TiledMap' | 'TiledLayer' | 'TiledObjectGroup' | 'TiledMapAsset' | 'TiledTile' | 'VideoPlayer' | 'VideoClip' | 'AnimationController'; array?: false; default?: null }
    | { name: string; type: 'number'; array: true; default?: number[] }
    | { name: string; type: 'integer'; array: true; default?: number[] }
    | { name: string; type: 'string'; array: true; default?: string[] }
    | { name: string; type: 'boolean'; array: true; default?: boolean[] }
    | { name: string; type: 'Vec2'; array: true; default?: { x: number; y: number }[] }
    | { name: string; type: 'Vec3'; array: true; default?: { x: number; y: number; z: number }[] }
    | { name: string; type: 'Vec4'; array: true; default?: { x: number; y: number; z: number; w: number }[] }
    | { name: string; type: 'Size'; array: true; default?: { width: number; height: number }[] }
    | { name: string; type: 'Rect'; array: true; default?: { x: number; y: number; width: number; height: number }[] }
    | { name: string; type: 'Quat'; array: true; default?: { x: number; y: number; z: number; w: number }[] }
    | { name: string; type: 'Color'; array: true; default?: { r: number; g: number; b: number; a: number }[] }
    | { name: string; type: 'Node' | 'UITransform' | 'Layout' | 'Widget' | 'Mask' | 'Canvas' | 'Label' | 'Sprite' | 'Button' | 'EditBox' | 'ScrollView' | 'Slider' | 'Toggle' | 'ProgressBar' | 'AudioSource' | 'Animation' | 'Camera' | 'MeshRenderer' | 'SkinnedMeshRenderer' | 'ParticleSystem' | 'ParticleSystem2D' | 'SkeletalAnimation' | 'AudioClip' | 'AnimationClip' | 'SpriteFrame' | 'Prefab' | 'Material' | 'JsonAsset' | 'TextAsset' | 'Texture2D' | 'Font' | 'TTFFont' | 'BitmapFont' | 'SpriteAtlas' | 'SceneAsset' | 'Mesh' | 'Skeleton' | 'RigidBody' | 'Collider' | 'RigidBody2D' | 'Collider2D' | 'BoxCollider' | 'SphereCollider' | 'CapsuleCollider' | 'MeshCollider' | 'BoxCollider2D' | 'CircleCollider2D' | 'PolygonCollider2D' | 'UIOpacity' | 'RichText' | 'ToggleContainer' | 'PageView' | 'PageViewIndicator' | 'ScrollBar' | 'SafeArea' | 'BlockInputEvents' | 'UICoordinateTracker' | 'HingeConstraint' | 'FixedConstraint' | 'PointToPointConstraint' | 'DistanceJoint2D' | 'SpringJoint2D' | 'FixedJoint2D' | 'HingeJoint2D' | 'MouseJoint2D' | 'RelativeJoint2D' | 'SliderJoint2D' | 'WheelJoint2D' | 'ImageAsset' | 'TextureCube' | 'EffectAsset' | 'PhysicsMaterial' | 'DirectionalLight' | 'SphereLight' | 'SpotLight' | 'RenderTexture' | 'LabelOutline' | 'LabelShadow' | 'Graphics' | 'TiledMap' | 'TiledLayer' | 'TiledObjectGroup' | 'TiledMapAsset' | 'TiledTile' | 'VideoPlayer' | 'VideoClip' | 'AnimationController'; array: true; default?: [] });
    type RequiredComponentType = 'UITransform' | 'Layout' | 'Widget' | 'Mask' | 'Canvas' | 'Label' | 'Sprite' | 'Button' | 'EditBox' | 'ScrollView' | 'Slider' | 'Toggle' | 'ProgressBar' | 'AudioSource' | 'Animation' | 'Camera' | 'MeshRenderer' | 'SkinnedMeshRenderer' | 'ParticleSystem' | 'ParticleSystem2D' | 'SkeletalAnimation' | 'UIOpacity' | 'RichText' | 'ToggleContainer' | 'PageView' | 'PageViewIndicator' | 'ScrollBar' | 'SafeArea' | 'BlockInputEvents' | 'UICoordinateTracker' | 'RigidBody' | 'RigidBody2D' | 'BoxCollider' | 'SphereCollider' | 'CapsuleCollider' | 'MeshCollider' | 'BoxCollider2D' | 'CircleCollider2D' | 'PolygonCollider2D' | 'DirectionalLight' | 'SphereLight' | 'SpotLight' | 'LabelOutline' | 'LabelShadow' | 'Graphics' | 'AnimationController';
    function scriptComponentCreate(args: { assetUrl: string; className: string; menu?: string; executionOrder?: number; disallowMultiple?: boolean; requiredComponents?: RequiredComponentType[]; properties?: ComponentPropertyDescriptor[]; write: boolean }): { assetUrl: string; className: string; source: string; sha256: string; bytes: number; sourceCreated: boolean; uuid: string | null; classRegistration: 'unknown' | 'pending'; attached: false; runtimeVerified: false; sceneSaved: false };

    /** Manage auxiliary animation curves and keys. */
    function animationAuxCurveEdit(args: {
        clipReference: InstanceReference,
        operation: "add" | "rename" | "remove" | "create_key" | "remove_key" | "move_keys" | "copy_key" | "modify_curve",
        name: string,
        newName?: string,
        frame?: number,
        frames?: number[],
        offset?: number | number[],
        customData?: unknown,
        curveData?: unknown,
        source?: unknown,
        destination?: unknown
    }): { success: boolean, error?: string, result?: any };

    /** Write to the editor console/project log. Message: 1-4096 characters, trimmed and non-blank. Data: JSON, at most 64 KiB serialized. debug uses console.log with a [debug] prefix. */
    function editorLog(args: {
        level: "debug" | "info" | "warn" | "error",
        message: string,
        data?: unknown
    }): { success: true, level: "debug" | "info" | "warn" | "error", message: string };

    /** Analyze scene animation usage, current states, defaults, cache modes, and setup recommendations. */
    function animationUsageAnalyze(args?: {
        nodeReference?: InstanceReference,
        maxNodes?: number
    }): {
        nodeReference: InstanceReference,
        visitedNodes: number,
        truncated: boolean,
        componentCount: number,
        findings: Array<{
            nodeUuid: string | null,
            nodeName: string | null,
            component: string,
            clipCount: number,
            clips: Array<{ uuid: string | null, name: string | null, duration: number | null, sample?: number | null }>,
            defaultClip: string | null,
            playOnLoad: boolean | null,
            stateCount: number,
            states: Array<{ name: string, playing: boolean, paused: boolean, time: number | null, speed: number | null }>,
            cacheMode: number | string | null,
            cached: boolean | null,
            recommendations: string[]
        }>
    };

    /** Control live Animation/SkeletalAnimation playback and Spine/DragonBones cache configuration with read-back. */
    function animationRuntimeControl(args: {
        nodeReference: InstanceReference,
        operation: "inspect" | "play" | "cross_fade" | "pause" | "resume" | "stop" | "set_default" | "set_play_on_load" | "set_state" | "set_cache_mode" | "invalidate_cache",
        clipName?: string,
        duration?: number,
        playOnLoad?: boolean,
        loop?: boolean,
        speed?: number,
        time?: number,
        repeatCount?: number,
        wrapMode?: number,
        cacheMode?: "REALTIME" | "SHARED_CACHE" | "PRIVATE_CACHE"
    }): {
        nodeReference: InstanceReference,
        operation: string,
        animation?: unknown,
        spine?: unknown,
        dragonBones?: unknown
    };

    type EditorTaskStatus = "running" | "completed" | "failed" | "cancelled" | "timedOut";
    interface EditorTask {
        taskId: string;
        title: string;
        message: string;
        progress: number | null;
        status: EditorTaskStatus;
        cancelRequested: boolean;
        createdAt: number;
        updatedAt: number;
        expiresAt: number;
        finishedAt: number | null;
    }
    interface EditorNotification {
        id: string;
        level: "info" | "warning" | "error";
        title: string;
        message: string;
        createdAt: number;
    }
    /** Bounded read-only snapshot with detection-only popup summary. */
    function editorState(args?: { timeoutMs?: number }): {
        capturedAt: number, projectPath: string | null, engineVersion: string | null,
        scene: { ready: boolean | null, dirty: boolean | null, current: { uuid: string | null, url: string | null, name: string | null } | null },
        busy: { scene: boolean | null, assetImport: boolean | null, build: boolean | null, tasks: boolean, inbox: boolean },
        popup: { detected: boolean | null, blocking: boolean | null, complete: boolean, count: number, raceDetected: boolean },
        tasks: { running: number, cancellationRequested: number, retained: number },
        inbox: { pending: boolean, requestId: string | null, kind: "form" | "question" | null, expiresAt: number | null },
        unavailable: string[]
    };
    /** Start cooperative work, heartbeat/update, or finish explicitly. Inactivity timeout 1-300000ms (default 60000); updates renew it, cancellation requests do not. Progress 0-100. Expiry is timedOut, not interruption. Finish completed sets progress 100. Terminal states immutable; unknown IDs 404, transitions/capacity 409. Max 100 tasks, terminal retention 5min with oldest-terminal eviction at capacity. */
    function editorProgress(args:
        | { operation: "start", title: string, message?: string, progress?: number, timeoutMs?: number }
        | { operation: "update", taskId: string, message?: string, progress?: number }
        | { operation: "finish", taskId: string, status: "completed" | "failed" | "cancelled", message?: string }
    ): EditorTask;

    /** Newest-first bounded list, default 50/max 100. Poll cancelRequested between work steps. */
    function editorTaskList(args?: { status?: EditorTaskStatus, taskId?: string, limit?: number }): { tasks: EditorTask[], total: number, truncated: boolean };

    /** Flag only, never interrupts work. requested:true while running (including repeated requests); false when already terminal. Worker must stop safely then finish cancelled. */
    function editorTaskCancel(args: { taskId: string }): { task: EditorTask, requested: boolean, interrupted: false };

    /** Bounded read-only snapshot. Default deadline 1000ms, maximum 5000ms; null + incomplete popup status means adapter uncertainty. busy.scene means not ready, not a global busy lock. Popup status is detection-only; no scene tree, prompt values, popup detail records, or dialog actions. */
    function editorState(args?: { timeoutMs?: number }): {
        capturedAt: number,
        projectPath: string | null,
        engineVersion: string | null,
        scene: { ready: boolean | null, dirty: boolean | null, current: { uuid: string | null, url: string | null, name: string | null } | null },
        busy: { scene: boolean | null, assetImport: boolean | null, build: boolean | null, tasks: boolean, inbox: boolean },
        popup: { detected: boolean | null, blocking: boolean | null, complete: boolean, count: number, raceDetected: boolean },
        tasks: { running: number, cancellationRequested: number, retained: number },
        inbox: { pending: boolean, requestId: string | null, kind: "form" | "question" | null, expiresAt: number | null },
        unavailable: string[]
    };

    /** Nonmodal Agent Inbox question by default, without opening/focusing the panel. User opens CCP 3x > Agent Inbox. Native dialogs require explicit presentation:"native"; openPanel:true permits panel activation. Default buttons OK/Cancel, cancelId last button. Deadline 1-300000ms, default 60000. Native timeout does not dismiss the native window. */
    function editorAsk(args: {
        title: string,
        message: string,
        detail?: string,
        type?: "info" | "warning" | "error" | "question",
        buttons?: string[],
        cancelId?: number,
        timeoutMs?: number,
        presentation?: "panel" | "native",
        openPanel?: boolean
    }): { buttonIndex: number | null, buttonLabel: string | null, cancelled: boolean, timedOut: boolean };

    /** Nonmodal Agent Inbox form; does not open/focus by default. openPanel:true explicitly permits activation. 1-16 uniquely named fields, text <=4096 chars, select <=64 options; required confirm means checked. One inbox request at a time (409 otherwise). Deadline 1-300000ms, default 60000. Do not request secrets. */
    function editorPrompt(args: {
        title: string,
        message: string,
        fields: EditorPromptField[],
        timeoutMs?: number,
        openPanel?: boolean
    }): { requestId: string, submitted: boolean, cancelled: boolean, timedOut: boolean, values: { [name: string]: string | boolean } };

    /** Read bounded project log entries with optional plain-text filtering. */
    function editorGetLogs(args: {
        count?: number,
        showStack?: boolean,
        order?: "newest-to-oldest" | "oldest-to-newest",
        pattern?: string,
        maxBytes?: number
    }): { logLines: string[], total: number, truncated: boolean };

    /** Fixed project log metadata only; path is project-relative. Does not expose file contents or launch an external application. */
    function editorGetLogFileInfo(): {
        path: 'temp/logs/project.log'; exists: boolean; isFile: boolean;
        sizeBytes: number; modifiedAt: string | null;
    };

    /** Project-relative existence metadata; does not read contents or imply importer availability. */
    function projectFileExists(args: { filePath: string }): { exists: boolean; isDirectory: boolean };
    /** Project-relative existence metadata using a single stat attempt. ENOENT/ENOTDIR returns exists:false; other filesystem failures throw PROJECT_FILE_STAT_FAILED. */
    /** Streams directory entries and retains a bounded prefix; limit must be integer1..1000. Returned entries use lstat and refuse symlink/special entries with PROJECT_DIRECTORY_ENTRY_UNSUPPORTED; omitted suffix entries are counted, not inspected. total is observed entry count; over100000 throws PROJECT_DIRECTORY_LIMIT. Open/stat/close failures throw typed errors. Enumeration is not an atomic snapshot. */
    function projectListDirectory(args: { dirPath?: string; limit?: number }): {
        entries: Array<{ name: string; type: 'file' | 'directory'; size?: number }>;
        total: number; truncated: boolean;
    };

    /** Reads complete UTF-8 decoded content within normal/verbose cap using a bounded file handle. sha256 hashes returned decoded text for replacement expectedSha256, not raw file bytes. Observed replacement/growth throws FILE_CHANGED_DURING_READ; oversized sources refuse. Not an atomic filesystem transaction. */
    function projectReadFile(args: { filePath: string; verbose?: boolean }): { content: string; bytes: number; sha256: string };
    /** Reads a line window (radius0–50). sha256 hashes whole decoded source, preserving source line endings, not normalized snippet. Optional expectedSha256 refuses changed text with FILE_CONTENT_CHANGED before returning a mixed-revision window. Beyond-EOF throws INVALID_ARGUMENT. Endpoint check only, not an atomic snapshot across calls. */
    function projectFileSnippet(args: { filePath: string; line: number; radius?: number; expectedSha256?: string }): { snippet: string; startLine: number; endLine: number; sha256: string };

    /** Case-insensitive glob-like regular-file search: * stays within a segment, ** crosses separators; others (including ?) literal. Links/special entries omitted. limit integer1..500 (verbose1000). total counts returned matches; truncated requires an observed omitted match. Lookahead may traverse the remaining eligible tree; beyond100000 entries throws PROJECT_SEARCH_LIMIT even after filling result cap. Read failures throw PROJECT_SEARCH_FAILED. Exclusions/concurrent changes remain outside coverage. */
    function projectSearchFiles(args: { pattern: string; directory?: string; limit?: number; verbose?: boolean }): { files: string[]; total: number; truncated: boolean };

    /** Writes UTF-8 text and verifies read-back. Unpaired surrogates refuse before mkdir/write; shared replacement/instruction writers also refuse output that cannot round-trip UTF-8 before writing. Optional expectedSha256 requires matching existing decoded text before mutation; optimistic only, not atomic compare-and-set. Asset refresh is best-effort. Inspect ambiguous errors before retry. */
    function projectWriteFile(args: { filePath: string; content: string; createDirs?: boolean; expectedSha256?: string }): { success: true; bytesWritten: number; sha256: string };
    /** Literal replacement, all matches by default. expectedOccurrences (integer0..524288) requires total non-overlapping literal matches even with replaceAll:false; empty search counts zero. Mismatch throws FILE_MATCH_COUNT_CHANGED before write. expectedSha256 guards decoded text. Both checks are optimistic, not atomic compare-and-set. Empty search/no match returns success=false; read-back does not certify asset reimport. */
    function projectReplaceInFile(args: { filePath: string; search: string; replace: string; replaceAll?: boolean; expectedSha256?: string; expectedOccurrences?: number }):
        { success: false; replacements: 0; sha256: string } | { success: true; replacements: number; sha256: string };

    interface ScriptDiagnostic {
        file: string; line: number; column: number; code: string; message: string;
    }
    interface ScriptDiagnosticsResult {
        ok: boolean; errorCount: number; diagnostics: ScriptDiagnostic[];
    }
    interface ScriptDiagnosticContextResult {
        ok: boolean; errorCount: number; diagnostics: Array<ScriptDiagnostic & { snippet: string }>;
    }
    interface ScriptDiagnosticsBatchResult<T> {
        outcomes: Array<
            { index: number; tsconfigPath: string; ok: true; result: T } |
            { index: number; tsconfigPath: string; ok: false; error: { message: string } }
        >;
        succeeded: number; failed: number; hasErrors: boolean; partial: boolean;
    }
    /** Runs the project compiler. Returned diagnostics are capped; errorCount may exceed their length. A failed compiler invocation is represented by diagnostics, not a clean result. */
    function runScriptDiagnostics(args: { tsconfigPath?: string }): ScriptDiagnosticsResult;
    /** Adds source snippets to a bounded diagnostic prefix; unavailable source context may be empty. */
    function getScriptDiagnosticContext(args: { tsconfigPath?: string; contextLines?: number; limit?: number; verbose?: boolean }): ScriptDiagnosticContextResult;
    /** Accepts 1–16 configs. Outcome ok means invocation returned, not compilation passed; inspect result.ok and hasErrors. */
    function scriptDiagnosticsBatch(args: { tsconfigPaths: string[] }): ScriptDiagnosticsBatchResult<ScriptDiagnosticsResult>;
    /** Separates invocation failures from compiler diagnostics; succeeded counts returned invocations, not clean projects. */
    function scriptDiagnosticContextBatch(args: { tsconfigPaths: string[]; contextLines?: number; limit?: number; verbose?: boolean }): ScriptDiagnosticsBatchResult<ScriptDiagnosticContextResult>;

    /** Reads CCP's package profile. Missing values are normalized to null; no key returns the known-key inventory only. */
    function getEditorPreference(args: { key?: string }):
        { key: string; value: unknown; all?: never } | { all: Record<string, unknown>; key?: never; value?: never };
    /** success acknowledges setConfig completion; value is the requested value, not persistence/read-back proof. */
    function setEditorPreference(args: { key: string; value: unknown }): { success: true; key: string; value: unknown };
    /** Queries Creator preferences with bounded package/key identifiers; absent values are normalized to null. */
    function queryPreferencesConfig(args: { packageName: string; key: string }): { value: unknown };
    /** updated compares immediate read-back using JSON serialization; false is not rollback or proof that nothing changed. */
    function setPreferencesConfig(args: { packageName: string; key: string; value: unknown }): { updated: boolean; value: unknown };

    /** Invokes button handlers through the scene script; not physical input or proof of application-side effects. */
    function simulateButtonClick(args: { reference: InstanceReference }): { handlersFired: number; method: string };
    /** Adds a scene button binding; handlerCount does not certify save/reopen persistence or runtime execution. */
    function bindButtonClickEvent(args: { reference: InstanceReference; componentType: string; handlerName: string; customEventData?: string }): { handlerCount: number };
    /** Reads serialized binding metadata without invoking handlers. Missing target/component/handler identities remain null. */
    function listButtonClickEvents(args: { reference: InstanceReference }): Array<{
        targetUuid: string | null; componentName: string | null; handler: string | null; customEventData: string;
    }>;

    /** Bounded UTF-8 project text. Missing files return exists=false; containment and size errors still throw. bytes measures decoded UTF-8 content. */
    function readProjectInstruction(args: { filePath: string; verbose?: boolean }):
        { exists: false; content: ''; bytes: 0; filePath: string; sha256: null } |
        { exists: true; content: string; bytes: number; filePath: string; sha256: string };
    /** Shared guarded writer; expectedSha256 is an optimistic decoded-text precondition, not atomic compare-and-set. Asset refresh is best-effort. Inspect ambiguous failures before retry. */
    function writeProjectInstruction(args: { filePath: string; content: string; expectedSha256?: string }): { success: true; filePath: string; bytesWritten: number; sha256: string };

    interface SceneSnapshotNode {
        reference: InstanceReference; children: SceneSnapshotNode[];
        components?: Array<{ reference: InstanceReference }>;
        childrenOmitted?: number; childrenCount?: number; truncated?: 'nodeLimit' | 'maxDepth';
        [field: string]: unknown;
    }
    /** Bounded formatted hierarchy, not an atomic scene transaction. Extra native fields remain unknown; field selection can omit them. */
    function sceneSnapshot(args: { reference?: InstanceReference; maxDepth?: number; maxNodes?: number; fields?: string[] }): {
        tree: SceneSnapshotNode; nodeCount: number; truncated?: 'nodeLimit' | 'maxDepth';
    };
    /** Reads 1–100 entries independently. Per-entry errors do not reject successful siblings; dumps retain native unwrapped values. */
    function sceneBatchGet(args: { entries: Array<{
        reference?: InstanceReference; target?: 'instance' | 'CurrentSceneGlobals' | 'ProjectSettings'; fields?: string[];
    }>; fields?: string[] }): { results: Array<
        { reference: InstanceReference; dump: unknown } | { reference: InstanceReference; error: string }
    > };

    /** Tracks only this module's main-process broadcastObserve listeners; excludes panel/arbitrary Creator listeners. No callbacks or event payloads are exposed. */
    function editorListenersInspect(): { supported: true; listeners: Array<{ topic: string; state: 'registered' | 'removal-failed' }>; limitation: string };

    /** Snapshot/abort IPC acceptance only, not undo/redo or independent cleanliness proof. Failure may leave ambiguous transaction state; inspect before retry. */
    function editorUndoTransactionProbe(): { supported: true; boundaries: ['snapshot', 'snapshot-abort']; clean: true };

    /** Observes the latest event in a short listener window; probe topic emits a marker. Payloads may be sensitive. No event-delivery or whole-response byte guarantee. Cleanup failures throw; inspect owned listeners before retry. */
    function broadcastObserve(args: { topic: 'ccp3x:probe' | 'scene:change' | 'asset-db:change' }): {
        topic: 'ccp3x:probe' | 'scene:change' | 'asset-db:change'; supported: true;
        observed: boolean; lifecycle: Array<'registered' | 'observed' | 'disposed'>;
        eventBytes: number; retainedListener: false;
    } & (
        { truncated: true; event: { omitted: true; bytes: number; reason: string } } |
        { truncated: false; event: unknown[] | null }
    );

    /** Inspect materials, shader effects and the render pipeline. Read-only — use inspectorSetProperty to change material properties. Result shapes are whatever the engine returns and are not yet runtime-verified. */
    function materialQuery(args: {
        operation: "effects" | "effect" | "material" | "serialized_material" | "render_pipeline" | "physics_material",
        reference?: InstanceReference,
        effectName?: string
    }): { result: any };

    /** Introspect the asset database: mounted databases, import-busy state, asset mtime, raw imported data, db_info, asset meta, ready. Poll "busy" after a refresh before trusting asset queries. */
    function assetDbQuery(args: {
        operation: "databases" | "busy" | "mtime" | "data" | "db_info" | "meta" | "ready",
        reference?: InstanceReference,
        dbName?: string
    }): { result: any };

    /** Creates the native ScrollView prefab and returns its existing bound content and masked viewport; no duplicate content/layout subtree is generated. Native read-back is not save/reopen or runtime scroll proof. */
    function uiCreateScrollView(args?: { name?: string; parentReference?: InstanceReference }): {
        reference: InstanceReference; viewport: InstanceReference; content: InstanceReference;
    };
    /** Creates a fixed-height vertical numeric-label list with visibleItems+1 bounded pool, scroll recycling and a generated project script/component. startIndex clamps to a full visible window. Requires native script import/registration. Scene is not automatically saved. Installation is not runtime/persistence qualification; partial failures retain owned identities without blind cleanup/replay. */
    function uiVirtualListCreate(args: { name?: string; parentReference?: InstanceReference; itemCount: number; visibleItems: number; startIndex?: number }): {
        reference: InstanceReference; viewport: InstanceReference; content: InstanceReference; itemReferences: InstanceReference[];
        itemCount: number; instantiatedItems: number; startIndex: number; nextIndex: number | null; virtualized: true; runtimeRecyclingBound: true;
        runtimeVerified: false; runtimeBinding: { scriptReference: InstanceReference; componentReference: InstanceReference; runtimeVerified: false };
    };
    /** Creates a bounded labeled EditBox + Submit Button form under one Widget root. Verifies all three child identities and focus order; failure reports owned-root cleanup status. Does not bind a gameplay callback or prove runtime input dispatch. */
    function uiCreateInputForm(args: { label: string; placeholder?: string; name?: string; parentReference?: InstanceReference }): {
        reference: InstanceReference; label: InstanceReference; input: InstanceReference; submit: InstanceReference; focusOrder: string[];
    };
    /** Generates/imports a project script and installs required/minLength validation on the owned form; text changes gate Submit Button.interactable. No gameplay submit callback or automatic scene save. Installation/readback is not runtime qualification. */
    function uiFormValidationBind(args: { label: string; placeholder?: string; required?: boolean; minLength?: number; name?: string; parentReference?: InstanceReference }): {
        form: { reference: InstanceReference; label: InstanceReference; input: InstanceReference; submit: InstanceReference; focusOrder: string[] };
        rules: { required: boolean; minLength: number; inputReference: InstanceReference }; focusOrder: string[]; runtimeValidationBound: true;
        runtimeVerified: false; runtimeBinding: { scriptReference: InstanceReference; componentReference: InstanceReference; runtimeVerified: false };
    };
    /** Read-only bounded live 2D UI layout diagnostics. Optional overlay returns a transient bounded PNG payload and never mutates scene state. */
    function uiLayoutReport(args: {
        root?: InstanceReference,
        rootPath?: string,
        designResolution: { width: number, height: number },
        viewport: { width: number, height: number },
        fitMode?: "fitWidth" | "fitHeight" | "contain" | "cover" | "stretch" | "none",
        maxNodes?: number,
        maxIssues?: number,
        maxBytes?: number,
        overlay?: boolean,
        alignmentTolerance?: number,
        gapTolerance?: number
    }): {
        complete: boolean,
        designResolution: Size,
        viewport: Size,
        fitMode: string,
        fit: { scale: Vector2, offset: Vector2 },
        root: { uuid: string, path: string, name: string },
        nodes: any[],
        issues: any[],
        truncation: any[],
        overlay: {
            requested: boolean, valid: boolean, rendered: boolean, cleaned: boolean,
            maxArtifactBytes: number, maxResponseBytes: number, responseBytes: number,
            sourceNodeCount: number, sourceIssueCount: number,
            artifact?: { mimeType: "image/png", encoding: "base64", data: string, byteLength: number, width: number, height: number, scale: Vector2 },
            error?: { code: string, message: string, evidence: Record<string, any> },
            dirtyBefore?: boolean, dirtyAfter?: boolean, dirtyPreserved?: boolean
        },
        tolerances: { alignment: number, gap: number }
    } | {
        error: { code: string, message: string, evidence: Record<string, any> }
    };

    /** Read-only all-node inventory in Creator tree order (maxNodes 1..128, default 64).
     * Local position/active are preserved. worldRect is the world-axis-aligned bound of the
     * node's own anchored UITransform corners, including all ancestor transforms, not descendants.
     * Nodes without UITransform have null size/anchor/worldRect; unavailable live geometry fails explicitly.
     */
    function uiLayoutInspect(args: {
        reference?: InstanceReference & { type?: "cc.Node" },
        maxNodes?: number
    }): {
        nodes: Array<{
            reference: InstanceReference & { type: "cc.Node" },
            name: string,
            active: boolean,
            position: { x: number, y: number, z: number },
            size: { width: number, height: number } | null,
            anchor: { x: number, y: number } | null,
            worldRect: { x: number, y: number, width: number, height: number } | null,
            components: string[]
        }>,
        truncated: boolean
    };

    /** Candidate: inspect active UI nodes for inferred labels, known interactability components, and duplicate or missing labels. Read-only inference only; no screen-reader runtime support is claimed. */
    function uiAccessibilityAudit(args: {
        root?: InstanceReference,
        rootPath?: string,
        maxNodes?: number,
        maxIssues?: number
    }): {
        complete: boolean,
        valid: boolean,
        truncated: boolean,
        checkedNodes: number,
        root: { uuid: string, path: string, name: string },
        nodes: Array<{
            uuid: string,
            path: string,
            name: string,
            active: true,
            role: "button" | "toggle" | "slider" | "edit-box" | "label" | "generic",
            label: string | null,
            labelSource: "label" | "descendant-label" | "edit-box-placeholder" | "node-name" | null,
            interactable: boolean,
            interactionComponent: "cc.Button" | "cc.Toggle" | "cc.Slider" | "cc.EditBox" | null,
            components: string[]
        }>,
        issues: Array<{
            code: "MISSING_ACCESSIBLE_LABEL" | "DUPLICATE_ACCESSIBLE_LABEL",
            severity: "warning",
            nodeId: string,
            relatedNodeIds: string[],
            message: string,
            evidence: Record<string, unknown>
        }>,
        truncation: Array<{ kind: "nodes" | "issues", limit: number, omitted?: number, reason: string }>
    } | {
        error: { code: string, message: string, evidence: Record<string, unknown> }
    };

    /** Candidate: inspect bounded live 2D UI bounds against a caller-provided safe-area rectangle or root-relative insets. Read-only; live evidence is required before qualification. */
    function uiSafeAreaInspect(args: {
        root?: InstanceReference,
        rootPath?: string,
        safeArea: {
            rect?: { x: number, y: number, width: number, height: number },
            insets?: { top: number, right: number, bottom: number, left: number },
            x?: number, y?: number, width?: number, height?: number
        },
        maxNodes?: number,
        maxIssues?: number
    }): {
        complete: boolean,
        valid: boolean,
        truncated: boolean,
        safeArea: { rect: { x: number, y: number, width: number, height: number }, insets?: { top: number, right: number, bottom: number, left: number } },
        root: { uuid: string, path: string, name: string },
        checkedNodes: number,
        nodes: Array<{ uuid: string, path: string, name: string, active: boolean, bounds: { x: number, y: number, width: number, height: number }, inside: boolean, overlaps: boolean, outside: boolean }>,
        issues: Array<{ code: "SAFE_AREA_OUTSIDE" | "SAFE_AREA_CLIPPED", severity: "error" | "warning", nodeId: string, message: string, evidence: Record<string, unknown> }>,
        truncation: unknown[]
    } | {
        error: { code: string, message: string, evidence: Record<string, unknown> }
    };

    /** Candidate: validate bounded UI geometry for clipping, overlap, anchors and optional safe-area constraints. Read-only; live evidence is required before qualification. */
    function uiLayoutValidate(args: {
        root?: InstanceReference,
        rootPath?: string,
        designResolution?: { width: number, height: number },
        viewport?: { width: number, height: number },
        fitMode?: "fitWidth" | "fitHeight" | "contain" | "cover" | "stretch" | "none",
        safeArea?: { rect?: { x: number, y: number, width: number, height: number }, insets?: { top: number, right: number, bottom: number, left: number } },
        maxNodes?: number,
        maxIssues?: number,
        checks?: { clipping?: boolean, overlap?: boolean, anchors?: boolean, safeArea?: boolean }
    }): {
        complete: boolean,
        valid: boolean,
        truncated: boolean,
        checkedNodes: number,
        root: Record<string, unknown>,
        nodes: unknown[],
        issues: unknown[],
        truncation: unknown[]
    } | { error: { code: string, message: string, evidence: Record<string, unknown> } }
      | { valid: boolean, issues: string[], checkedNodes: number };

    /** Candidate: create one bounded PhysX 3D constraint between two existing cc.RigidBody nodes. Other backends, constraint types, and generic mesh/compound behavior are unsupported until separately qualified. */
    function physics3dCreateJoint(args: {
        backend: "builtin" | "cannon" | "physx",
        joint?: "fixed" | "hinge" | "pointToPoint",
        bodyReference: InstanceReference,
        connectedBodyReference: InstanceReference
    }): {
        backend: "physx",
        jointReference: InstanceReference,
        bodyReference: InstanceReference,
        connectedBodyReference: InstanceReference,
        jointType: "cc.FixedConstraint" | "cc.HingeConstraint" | "cc.PointToPointConstraint"
    };

    interface LightBakeManageArgs {
        operation: "start" | "inspect" | "cancel";
        sceneUuid?: string;
        jobId?: string;
    }
    interface LightBakeManageResult {
        jobId: string;
        sceneUuid: string;
        status: "running" | "completed" | "cancelled" | "failed" | "indeterminate";
        startedAt: number;
        updatedAt: number;
        finishedAt: number | null;
        outputPath: string;
        probeCount: number;
        processId: number | null;
        native: { started: boolean; finished: boolean; error: boolean; processOpen: boolean; timerOpen: boolean; serverOpen: boolean };
        verification: { outputFile: boolean; topologyUnchanged: boolean; coefficientsFinite: boolean; coefficientsChanged: boolean };
        reason: string | null;
    }
    /** Native Creator 3.8.8 light-probe SH bake only (at most 256 finite noncoplanar probes; bounded scene GI settings). start requires the exact current edit sceneUuid; inspect/cancel require an owned jobId. Completion requires native/output/coefficient verification, not an end broadcast. Output is retained; no caller code/path, texture-lightmap bake, scene save or save/reopen persistence proof. */
    function lightBakeManage(args: LightBakeManageArgs): LightBakeManageResult;

    /** Candidate: configure bounded serialized cc.AudioSource properties on one existing typed node or AudioSource component. Only volume, loop, playOnAwake, and a proven cc.AudioClip UUID are accepted; no playback is started. Typed preflight, one successful scene snapshot, read-back, and rollback on failure are part of the contract. Live evidence is required before qualification. */
    function audioSourceConfigure(args: {
        reference: InstanceReference & { type: "cc.Node" | "cc.AudioSource" },
        properties: {
            volume?: number,
            loop?: boolean,
            playOnAwake?: boolean,
            clip?: InstanceReference & { type: "cc.AudioClip" }
        }
    }): {
        reference: InstanceReference,
        componentReference: InstanceReference,
        properties: {
            volume: number,
            loop: boolean,
            playOnAwake: boolean,
            clip: (InstanceReference & { type: "cc.AudioClip" }) | null
        },
        changed: Array<"volume" | "loop" | "playOnAwake" | "clip">,
        verified: true
    };

    interface AudioPlaybackResult {
        success: true;
        sessionId: string;
        targetId: string;
        nodeUuid: string;
        componentUuid: string | null;
        clipUuid: string | null;
        operation: "play" | "pause" | "stop" | "seek" | "observe";
        state: {
            currentTime: number;
            duration: number;
            playing: boolean;
            playbackState: "init" | "playing" | "paused" | "stopped" | "interrupted";
            loaded: boolean;
            volume: number | null;
            loop: boolean | null;
            userActivation: "active" | "inactive" | "unknown";
            activationRequirement: "unknown";
        };
        started: boolean;
        ended: boolean;
    }
    /** Session-bound Game View AudioSource control with actual state/event readback; activation/timeout uncertainty fails closed. */
    function audioPlaybackControl(args: {
        sessionId: string;
        nodeReference: { id: string };
        expectedComponentUuid?: string;
        expectedClipUuid?: string;
        operation: "play" | "pause" | "stop" | "seek";
        time?: number;
        timeoutMs?: number;
    }): AudioPlaybackResult;
    /** Observe actual Game View audio state without edit-renderer substitution. */
    function audioPlaybackObserve(args: { sessionId: string; nodeReference: { id: string }; expectedComponentUuid?: string; expectedClipUuid?: string }): AudioPlaybackResult;
    /** Observe-only wait with at least one playing/loaded/minTime condition and a bounded caller deadline. Target changes refuse; playing=false is not proof of natural completion. In-flight reads may settle after timeout; no playback replay/listeners. */
    function audioPlaybackWaitForState(args: { sessionId: string; nodeReference: { id: string }; expectedComponentUuid?: string; expectedClipUuid?: string; playing?: boolean; minVolume?: number; maxVolume?: number; loop?: boolean; minDuration?: number; maxDuration?: number; userActivation?: 'active' | 'inactive' | 'unknown'; loaded?: boolean; playbackState?: 'init' | 'playing' | 'paused' | 'stopped' | 'interrupted'; maxTime?: number; minTime?: number; timeoutMs?: number; pollMs?: number }): { matched: true; observations: number; observation: AudioPlaybackResult };
    /** Preflights 1–16 runtime/audio/exact-clip animation checkpoints and bound controls. Animation assert/wait require playing/paused/minTime; observe accepts no predicates. Same-session ownership remains until pending work settles. No action replay/restore or global primitive lock. */
    /** nodeAssert/nodeWait accept local/world position and sign-invariant quaternion orientation predicates. Inclusive tolerances; nodeObserve accepts no predicates. A match is not movement/effect completion. */
    function runtimeScenarioRun(args: { sessionId: string; runId?: string; steps: Array<{ operation: 'nodeObserve' | 'nodeAssert' | 'nodeWait' | 'graphObserve' | 'graphAssert' | 'graphSet' | 'graphWait' | 'delay' | 'wait' | 'assert' | 'observe' | 'particleControl' | 'particleObserve' | 'particleAssert' | 'particleWait' | 'animationEvents' | 'animationControl' | 'animationObserve' | 'animationAssert' | 'animationWait' | 'audioObserve' | 'audioAssert' | 'audioControl' | 'audioWait' | 'pause' | 'resume' | 'step'; expectedComponentUuid?: string; expectedClipUuid?: string; siblingIndex?: number | null; minChildCount?: number; maxChildCount?: number; parentUuid?: string | null; scale?: { x: number; y: number; z: number; tolerance: number }; rotation?: { space: 'local' | 'world'; x: number; y: number; z: number; w: number; toleranceDegrees: number }; position?: { space: 'local' | 'world'; x: number; y: number; z: number; tolerance: number }; active?: boolean; activeInHierarchy?: boolean; graphUuid?: string; variableName?: string; variableType?: 'float' | 'integer' | 'boolean'; expectedValue?: number | boolean; variableRange?: { min: number; max: number }; variableValue?: number | boolean; durationMs?: number; nodeReference?: { id: string }; animationOperation?: 'play' | 'pause' | 'resume' | 'stop'; particleOperation?: 'play' | 'stop' | 'clear'; minParticleCount?: number; maxParticleCount?: number; componentId?: string; expectedEventSequence?: Array<'play' | 'pause' | 'resume' | 'stop' | 'lastframe' | 'finished'>; minEventCount?: number; expectedEvent?: 'play' | 'pause' | 'resume' | 'stop' | 'lastframe' | 'finished'; maxEvents?: number; clipName?: string; clipUuid?: string; playbackState?: 'init' | 'playing' | 'paused' | 'stopped' | 'interrupted'; maxTime?: number; minSpeed?: number; maxSpeed?: number; minTime?: number; audioOperation?: 'play' | 'pause' | 'stop' | 'seek'; time?: number; playing?: boolean; minVolume?: number; maxVolume?: number; loop?: boolean; minDuration?: number; maxDuration?: number; userActivation?: 'active' | 'inactive' | 'unknown'; loaded?: boolean; paused?: boolean; maxFrameCount?: number; minFrameCount?: number; timeoutMs?: number }>; totalTimeoutMs?: number }): { success: true; sessionId: string; runId: string; outcomes: Array<Record<string, unknown>> };
    /** Read-only inclusive frame window0..1e9, AND-composed with paused; unavailable frame metrics refuse. */
    function runtimeWaitForState(args: { sessionId: string; paused?: boolean; minFrameCount?: number; maxFrameCount?: number; timeoutMs?: number }): { success: true; sessionId: string; state: NonNullable<RuntimePreviewResult['state']>; elapsedMs: number };
    function runtimeScenarioAssert(args: { sessionId: string; paused?: boolean; minFrameCount?: number; maxFrameCount?: number }): { success: true; sessionId: string; passed: boolean; state: NonNullable<RuntimePreviewResult['state']>; issues: string[] };
    /** Exact session/run cancellation promptly ends the caller wait. Never cancels native work or releases pending ownership; inactive requests are no-ops. Use a fresh runId for each invocation. */
    function runtimeScenarioCancel(args: { sessionId: string; runId: string }): { sessionId: string; active: boolean; cancellationRequested: boolean; nativeWorkCancelled: false };
    /** Current local ownership only; inactive is not success/native completion. No historical results or native query. */
    function runtimeScenarioInspect(args: { sessionId: string; runId: string }): { sessionId: string; runId: string; active: boolean; progress: { stepIndex: number | null; operation: string | null; completedSteps: number; requestPending: boolean; callerFinished: boolean; cancellationRequested: boolean } | null };
    /** Build-folder data-only preflight; no serving, load or runtime validity inference. */
    function assetBundleArtifactInspect(args: { bundlePath: string; bundleName: string; maxResources?: number; resourceOffset?: number; expectedRevision?: string }): { bundleName: string; version: string; files: Array<{ name: string; bytes: number; sha256: string }>; revision: string; resources: Array<{ index: string; path: string; type: string | null; emittedUuid: string; uniqueAddress: boolean }>; resourceCount: number; resourceOffset: number; nextOffset: number | null; truncated: boolean; writes: false; runtimeVerified: false; verificationScope: string };
    /** Explicit built data-bundle lifecycle validation. Requested resource requires exactly one emitted path/exact cc type match before serving; subclass inference is not supported. artifactRevision identifies captured config/index bytes and bundle identity, not resource payloads or later disk state. Optional expectedRevision guards this revision before serving. expectedUuid is decoded runtime identity. Do not replay uncertain callbacks. */
    function assetBundleRuntimeValidate(args: { sessionId: string; bundlePath: string; bundleName: string; expectedRevision?: string; resource?: { path: string; type: 'JsonAsset' | 'TextAsset' | 'ImageAsset' | 'Texture2D' | 'SpriteFrame' | 'AudioClip'; expectedUuid?: string }; timeoutMs?: number }): { success: true; sessionId: string; targetId: string; bundlePath: string; bundleName: string; artifactRevision: string; loaded: true; identityVerified: true; resource: { path: string; type: string; uuid: string; loaded: true } | null; released: true; removed: true; absent: true; unrelatedPreserved: true };
    function skeletalAnimationPlay(args: { sessionId: string; nodeReference: { id: string }; componentId: string; clipName: string; clipUuid: string; operation: 'play' | 'pause' | 'resume' | 'stop' | 'observe'; timeoutMs?: number }): Record<string, unknown>;
    /** Exact clip state observation only; never starts/pauses/stops playback. Verification pending. */
    function skeletalAnimationWaitForState(args: { sessionId: string; nodeReference: { id: string }; componentId: string; clipName: string; clipUuid: string; minDuration?: number; maxDuration?: number; playing?: boolean; paused?: boolean; maxTime?: number; minSpeed?: number; maxSpeed?: number; minTime?: number; timeoutMs?: number; pollMs?: number }): { matched: boolean; timedOut: boolean; observations: number; state: Record<string, unknown> };
    function skeletalAnimationEvents(args: { sessionId: string; nodeReference: { id: string }; componentId: string; clipName: string; clipUuid: string; maxEvents?: number; timeoutMs?: number }): Record<string, unknown>;
    /** Exact attached Game View Animation/SkeletalAnimation clip read; no playback mutation. */
    function animationPlaybackObserve(args: { sessionId: string; nodeReference: { id: string }; componentId: string; clipName: string; clipUuid: string; timeoutMs?: number }): Record<string, unknown>;
    /** Read-only exact-clip polling. Requires at least one playing/paused/minTime condition. Deadline errors throw RUNTIME_STATE_TIMEOUT; unavailable time refuses rather than matching. No playback mutation or listener registration. */
    function animationPlaybackWaitForState(args: { sessionId: string; nodeReference: { id: string }; componentId: string; clipName: string; clipUuid: string; minDuration?: number; maxDuration?: number; playing?: boolean; paused?: boolean; maxTime?: number; minSpeed?: number; maxSpeed?: number; minTime?: number; timeoutMs?: number; pollMs?: number }): { matched: boolean; timedOut: boolean; observations: number; state: { playing: boolean; paused: boolean; time: number | null; duration: number | null; speed: number | null } };
    /** Read runtime clip identities without playback/state creation; duplicate names are flagged. */
    function animationClipInventory(args: { sessionId: string; nodeReference: { id: string }; componentId: string; maxClips?: number; clipOffset?: number; expectedRevision?: string; timeoutMs?: number }): { success: true; sessionId: string; targetId: string; nodeUuid: string; componentId: string; clips: Array<{ clipName: string | null; clipUuid: string | null; uniqueName: boolean; empty: boolean }>; totalClips: number; clipOffset: number; nextOffset: number | null; truncated: boolean; revision: string };
    /** Component controls refuse other active clips; exact requested clip read-back. No replay on unknown outcome. */
    function animationPlaybackControl(args: { sessionId: string; nodeReference: { id: string }; componentId: string; operation: 'play' | 'pause' | 'resume' | 'stop'; clipName: string; clipUuid: string; timeoutMs?: number }): Record<string, unknown>;
    /** Observe only events emitted after listener registration; finite deadline and cleanup, no playback dispatch. */
    function animationPlaybackEvents(args: { sessionId: string; nodeReference: { id: string }; componentId: string; clipName: string; clipUuid: string; maxEvents?: number; timeoutMs?: number }): Record<string, unknown>;
    function animationGraphPreview(args: { sessionId: string; nodeReference: { id: string }; componentId: string; operation: 'inspect' | 'setVariable'; expectedGraphUuid?: string; variable?: { name: string; type: 'float' | 'integer' | 'boolean'; value: number | boolean; expectedValue?: number | boolean }; timeoutMs?: number }): Record<string, unknown>;
    /** Exact runtime graph variable observation; no write. Deadline expiry is an error. */
    function animationGraphWaitForVariable(args: { sessionId: string; nodeReference: { id: string }; componentId: string; graphUuid: string; name: string; timeoutMs?: number; pollMs?: number } & ({ type: 'float' | 'integer' | 'boolean'; value: number | boolean; range?: never } | { type: 'float' | 'integer'; range: { min: number; max: number }; value?: never })): { matched: true; observations: number; graphUuid: string; variable: { name: string; type: 'float' | 'integer' | 'boolean'; value: number | boolean }; writes: false };
    /** Canonical descriptor/source only; no project code evaluation. Isolated pause/resume is version/API-dependent. */
    function tweenSequenceControl(args: { operation: 'start' | 'pause' | 'resume' | 'stop' | 'inspect'; sessionId: string; filePath?: string; sequence?: unknown; timeoutMs?: number }): Record<string, unknown>;

    interface RuntimeSession {
        sessionId: string;
        targetKind: "game-view" | "browser-preview" | "simulator";
        targetId: string;
        status: "attached" | "stopped";
        createdAt: number;
        stoppedAt?: number;
    }
    interface RuntimePreviewResult {
        success: true;
        operation: string;
        session?: RuntimeSession;
        preview: { state: "play" | "pause" | "stop"; sceneUuid: string; gamePaused: boolean | null; enabled: boolean; ready: boolean; platform: string; webContentsId: number | null };
        state?: { running: boolean; paused: boolean; timeScale: number | null; frameCount: number | null; sceneUuid: string };
        ready: boolean;
    }
    /** Creator 3.7.3 game-view only. targetId is an expected real scene UUID; stop verifies native termination. */
    function runtimePreviewControl(args: {
        operation: "start" | "pause" | "resume" | "stop" | "step" | "state";
        sessionId?: string;
        targetId?: string;
        timeoutMs?: number;
    }): RuntimePreviewResult;
    /** These controls target actual Game View, never the edit renderer. Stopped/unverified targets fail closed. */
    function runtimePause(args?: { sessionId?: string; targetId?: string; timeoutMs?: number }): { success: true };
    function runtimeResume(args?: { sessionId?: string; targetId?: string; timeoutMs?: number }): { success: true };
    function runtimeSetTimeScale(args: { scale: number }): { success: true; scale: number };
    function runtimeGetState(): { paused: boolean; timeScale: number | null; frameCount: number | null };
    /** Exact Game View node read with local/world quaternions retained verbatim; no normalization, Euler conversion or mutation. */
    function runtimeNodeObserve(args: { sessionId: string; nodeReference: { id: string }; expectedHierarchyRevision?: string; childOffset?: number; timeoutMs?: number }): { sessionId: string; targetId: string; nodeUuid: string; parentUuid: string | null; siblingIndex: number | null; childUuids: string[]; childCount: number; hierarchyRevision: string; childOffset: number; nextChildOffset: number | null; childrenTruncated: boolean; active: boolean; activeInHierarchy: boolean; position: { x: number; y: number; z: number }; worldPosition: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number }; worldRotation: { x: number; y: number; z: number; w: number }; writes: false };
    /** Observe-only activation/position/orientation predicates. Quaternion comparison normalizes finite nonzero inputs and treats q/-q equally; toleranceDegrees0..180. Missing targets remain errors; in-flight reads may settle after deadline. */
    function runtimeNodeWaitForState(args: { sessionId: string; nodeReference: { id: string }; siblingIndex?: number | null; minChildCount?: number; maxChildCount?: number; parentUuid?: string | null; active?: boolean; activeInHierarchy?: boolean; position?: { space: 'local' | 'world'; x: number; y: number; z: number; tolerance: number }; rotation?: { space: 'local' | 'world'; x: number; y: number; z: number; w: number; toleranceDegrees: number }; scale?: { x: number; y: number; z: number; tolerance: number }; timeoutMs?: number; pollMs?: number }): { matched: true; observations: number; observation: ReturnType<typeof runtimeNodeObserve> };
    /** reset releases a local handle only. It does not stop the preview. */
    function runtimeSessionLifecycle(args: {
        operation: "start" | "attach" | "inspect" | "stop" | "reset" | "list";
        targetKind?: "game-view" | "browser-preview" | "simulator";
        targetId?: string;
        sessionId?: string;
        timeoutMs?: number;
    }): {
        success: boolean;
        operation: string;
        session?: RuntimeSession | { sessionId: string; reset: true };
        sessions?: RuntimeSession[];
        state?: RuntimePreviewResult["state"];
        ready?: boolean;
    };

    /** Candidate: audit up to 64 explicitly typed cc.AudioClip assets against a declared target using only public asset metadata. Reports source extension/importer and exposed web load mode; it does not claim decode, duration, or playback success. Candidate remains unqualified until live importer evidence exists. */
    function audioAssetCompatibilityAudit(args: {
        assets: Array<InstanceReference & { type: "cc.AudioClip" }>,
        target: "web-mobile" | "web-desktop" | "native-mobile" | "native-desktop",
        maxIssues?: number
    }): {
        target: "web-mobile" | "web-desktop" | "native-mobile" | "native-desktop",
        valid: boolean,
        complete: boolean,
        items: Array<{
            reference: InstanceReference & { type: "cc.AudioClip" },
            target: "web-mobile" | "web-desktop" | "native-mobile" | "native-desktop",
            valid: boolean,
            url?: string,
            path?: string,
            extension?: string,
            importer?: string,
            loadMode?: string,
            issues: Array<{
                code: "ASSET_NOT_FOUND" | "TYPE_MISMATCH" | "UNSUPPORTED_FORMAT" | "UNKNOWN_METADATA",
                assetId: string,
                field?: string,
                value?: unknown,
                message: string
            }>
        }>,
        issues: Array<{
            code: "ASSET_NOT_FOUND" | "TYPE_MISMATCH" | "UNSUPPORTED_FORMAT" | "UNKNOWN_METADATA",
            assetId: string,
            field?: string,
            value?: unknown,
            message: string
        }>
    };

    /** Wait boundedly for a Creator build task to reach a terminal state; timeout never claims completion. */
    function buildTaskWait(args: { taskId: string | number; timeoutMs?: number; pollMs?: number }): {
        completed: boolean,
        timedOut: boolean,
        task: ReturnType<typeof buildLogInspect>['task']
    };

    /** Basic options checks only (platform present and buildPath length); does not dispatch a task or qualify toolchains/platform support. */
    function buildPresetValidate(args: { options: Record<string, unknown> }): { valid: boolean; issues: string[]; platform: string };

    /** Inspect up to 256 explicit project-local artifact paths. Not whole-artifact or task provenance verification; callers must stay within the manifest bound. */
    function buildOutputAudit(args: { artifactPath: string; expectedFiles: Array<{ path: string; sha256?: string }> }): {
        valid: boolean; issues: string[];
        files: Array<{ path: string; bytes: number; sha256: string }>;
        checkedFiles: number;
    };

    /** Candidate: validate 1-256 unique localization keys (each at most 256 characters) in the current Creator language through the fixed ccp3x package scene seam. Unsupported localization packages return supported=false; this call never changes language or restarts Creator. */
    function localizationValidate(args: { keys: string[] }): {
        supported: true,
        language: string | null,
        checkedKeys: number,
        missingKeys: string[]
    } | {
        supported: false,
        language: null,
        checkedKeys: 0,
        missingKeys: [],
        error: string
    };
    /** Read current localization availability without switching language. Unsupported results may expose error; languages/directions are observations, not persistence proof. */
    function localizationInspect(): {
        supported: boolean; currentLanguage: string | null; languages: string[];
        directions: Record<string, string>; error?: string;
    };
    /** Official editor resource metadata; runtime overrides/fallback resolution and switching remain unverified. */
    function localizationResourceInspect(): { languages: string[]; defaultLanguage: string; fallbackLanguage: string; issues: Array<{ code: string; locale: string }>; writes: false; runtimeVerified: false; verificationScope: string };
    /** Official editor fallback presence; empty translations do not imply fallback, runtime policy remains unverified. */
    function localizationFallbackCoverage(args: { locale: string; keys: string[] }): { locale: string; fallbackLanguage: string; complete: boolean; items: Array<{ key: string; status: string }>; writes: false; runtimeVerified: false; verificationScope: string };
    /** Creator3.8.8 official package IPC; edits one existing key with expected-value conflict guard. Live qualification pending. */
    function localizationTableEdit(args: { locale: string; key: string; value: string; expectedValue: string }): { supported: true; locale: string; key: string; changed: boolean; persisted: true; mutationDispatched: boolean; previousValueSha256: string; readBackValueSha256: string; evidence: { channel: 'localization-editor'; readMethod: 'get-translate-data-object'; writeMethod: 'save-translate-data'; payloadBytes: number; redacted: true } };
    /** Read selected official package translations with a whole-response cap; no locale switch or write. Verification pending. */
    function localizationTableInspect(args: { locale: string; keys: string[]; maxBytes?: number }): { locale: string; items: Array<{ key: string; value: string; valueSha256: string }>; missingKeys: string[]; requestedKeys: number; totalFound: number; totalMissing: number; truncated: boolean; writes: false };
    /** Bounded key presence across explicit locales; never infers fallback/font/layout correctness. */
    function localizationTableCoverage(args: { locales: string[]; keys: string[] }): { complete: boolean; valid: boolean; checkedLocales: number; checkedKeys: number; locales: Array<{ locale: string; missingKeys: string[]; emptyKeys: string[]; checkedKeys: number; complete: boolean }>; writes: false; fallbackVerified: false };
    /** Finite Game View3.7 component controls; inspect never dispatches playback. */
    function particlePlayback(args: { sessionId: string; nodeReference: { id: string }; componentId?: string; operation: 'play' | 'stop' | 'clear' | 'inspect'; timeoutMs?: number }): { success: true; sessionId: string; targetId: string; componentId: string; nodeUuid: string; state: { playing: boolean; paused: boolean | null; stopped: boolean | null; particleCount: number | null; time: number | null } };
    /** No-mutation particle state polling under exact session/node/component identity; verification pending. */
    function particleWaitForState(args: { sessionId: string; nodeReference: { id: string }; componentId: string; playing?: boolean; minParticleCount?: number; maxParticleCount?: number; timeoutMs?: number; pollMs?: number }): { matched: boolean; timedOut: boolean; observations: number; state: Record<string, unknown> };
    /** Expected-file hashes tied to successful task options, not proof of producer freshness. Verification pending. */
    function buildTaskOutputInspect(args: { taskId: string | number; expectedFiles: string[]; maxBytes?: number }): { taskId: string; platform: string; state: 'success'; artifactPath: string; files: Array<{ path: string; bytes: number; sha256: string }>; totalBytes: number; producerVerified: false; verificationScope: string };

    /** Generates options only: no persistence/build dispatch or asset/toolchain qualification. */
    function buildTemplate(args: { operation: 'list' | 'create'; platform?: 'web-mobile' | 'web-desktop' | 'android' | 'ios' | 'windows' | 'mac'; mode?: 'debug' | 'release'; name?: string; scenes?: Array<{ uuid: string; url: string }>; startScene?: string; packageName?: string; orientation?: 'auto' | 'portrait' | 'landscape'; buildPath?: string; remoteServerAddress?: string }): { options?: Record<string, unknown>; platforms?: string[]; modes?: string[]; writes: false; readiness?: string; requirements?: string[] };
    /** Creator builder preferences only; does not mutate existing task options or trigger builds. */
    function buildSettingsManage(args: { operation: 'get' | 'set'; key?: string; value?: string | boolean; scope?: 'local' | 'global' }): Promise<{ scope: string; settings?: Record<string, unknown>; success?: boolean; affectsExistingTasks: false }>;
    /** Persistent ccp-owned project profiles, not native Creator presets. Credentials forbidden; options validated and writes read back. */
    function buildProfileManage(args: { operation: 'list' | 'get' | 'save' | 'delete'; name?: string; options?: Record<string, unknown> }): Promise<{ profiles?: Array<{ name: string; platform: string }>; total?: number; name?: string; options?: Record<string, unknown>; success?: boolean }>;
    /** Candidate: pure, read-only audit of bounded public Creator build options for six explicit targets. Reports normalized platform, supported/unsupported/unknown options, errors and warnings; it never dispatches a build or claims an artifact. Candidate remains unqualified. */
    function buildPresetAudit(args: {
        platform: "web-mobile" | "web-desktop" | "android" | "ios" | "windows" | "mac" | string,
        options: Record<string, unknown>
    }): {
        platform: string,
        supportedOptions: string[],
        unsupportedOptions: string[],
        unknownOptions: string[],
        errors: Array<{
            code: "UNKNOWN_PLATFORM" | "INVALID_OPTIONS" | "MISSING_REQUIRED_OPTION" | "INVALID_OPTION" | "UNSUPPORTED_OPTION" | "UNKNOWN_OPTION" | "OPTIONS_TRUNCATED",
            path?: string,
            value?: unknown,
            message: string
        }>,
        warnings: Array<{
            code: "UNKNOWN_PLATFORM" | "INVALID_OPTIONS" | "MISSING_REQUIRED_OPTION" | "INVALID_OPTION" | "UNSUPPORTED_OPTION" | "UNKNOWN_OPTION" | "OPTIONS_TRUNCATED",
            path?: string,
            value?: unknown,
            message: string
        }>,
        valid: boolean,
        complete: boolean
    };
    /** Candidate: inspect a bounded, read-only project-local build artifact inventory. artifactPath must be relative and contained by the project; traversal and control characters are rejected. Files are returned in lexical order up to maxFiles. */
    function buildArtifactInspect(args: {
        artifactPath: string,
        maxFiles?: number
    }): {
        exists: boolean,
        files: Array<{
            path: string,
            bytes: number
        }>,
        count: number,
        truncated: boolean
    };

    /** Candidate: inspect one Creator builder task through query-task only. Unavailable logs use available=false, never fabricated entries.
     * Integer maxEntries 1..256; integer maxBytes 256..2097152 caps the entire successful UTF-8 JSON response.
     * Oversized optional data is omitted with truncated=true; task identity/state are never sliced.
     * An unfit mandatory envelope fails with BUILD_LOG_RESPONSE_TOO_LARGE (422).
     * Invalid limits fail with INVALID_ARGUMENT (400) before IPC.
     */
    function buildLogInspect(args: {
        taskId: string | number,
        maxEntries?: number,
        maxBytes?: number
    }): {
        available: boolean,
        terminal: boolean,
        state: string,
        progress: number,
        task: {
            id: string,
            progress: number,
            state: string,
            message?: string,
            time?: string,
            stage?: string,
            dirty?: boolean,
            name?: string,
            platform?: string,
            buildPath?: string
        },
        entries: Array<{
            message: string,
            severity?: string,
            code?: string,
            file?: string,
            line?: number
        }>,
        count: number,
        truncated: boolean
    };
    /** Selected simple-braces/i18next identifiers and explicit character repertoire; no formatter/font/layout/runtime validity. */
    function localizationTableTextAudit(args: { baseLocale: string; locales: string[]; keys: string[]; supportedCharacters?: string; placeholderSyntax?: 'simple-braces' | 'i18next' }): { baseLocale: string; complete: boolean; checkedTranslations: number; issues: Array<{ locale: string; key: string; code: string; missingPlaceholders?: string[]; extraPlaceholders?: string[]; uncoveredCharacters?: string[] }>; placeholderSyntax: string; characterCoverageChecked: boolean; fontVerified: false; layoutVerified: false; runtimeVerified: false; writes: false };

    // ── Consolidated (preferred) ── 10 tools replace 26 legacy (removed in 2.0.x)
    /** Consolidated: get properties (instance or settings). Use instead of removed inspectorGet*Properties. */
    function inspectorGet(args: { target: "instance" | "CurrentSceneGlobals" | "ProjectSettings", reference?: InstanceReference, fields?: string[] }): { dump: any };
    /** Consolidated: set properties (instance or settings). */
    function inspectorSet(args: { target: "instance" | "CurrentSceneGlobals" | "ProjectSettings", reference?: InstanceReference, propertyPaths?: string[], values?: any[], propertyPath?: string, value?: any }): { success: boolean, error?: string };
    /** Consolidated: TS definition (instance or settings). */
    function inspectorGetDefinition(args: EngineApiDiscoveryArgs & { target: 'class'; className: string }): EngineApiDiscoveryResult;
    function inspectorGetDefinition(args: { target: 'instance' | 'CommonTypes' | 'CurrentSceneGlobals' | 'ProjectSettings'; reference?: InstanceReference; section?: string }): { definition: string; sections: string[]; totalSections: number };
    /** Reflow is edit-scene native Layout/Widget authoring, not Game View simulation; success does not imply save or verified undo. */
    function uiLayoutApply(args: { operation: 'reflow'; reference: InstanceReference; maxNodes?: number; maxDepth?: number; maxBytes?: number }): UiReflowEvidence;
    function uiLayoutApply(args: { operation?: 'apply'; reference: InstanceReference; position?: { x?: number; y?: number; z?: number }; size?: { width: number; height: number }; anchor?: { x: number; y: number }; active?: boolean }): { success: true; layout: Record<string, unknown> | null };
    function materialEdit(args: { reference: InstanceReference; path: string; value: unknown }): { reference: InstanceReference; path: string; changed: boolean; before: unknown; after: unknown; requestedValue: unknown; readBackValue: unknown; passIndices: number[]; verification: { requestedValueMatched: boolean; unaffectedPassesUnchanged: boolean; unaffectedPassesApplicable: boolean }; persistence: { nativeApplyInvoked: boolean; sourceSaved: null; importCompleted: null; generatedOutputVerified: null; reimportVerified: false; reopenVerified: false } };
    function animationGraphInspect(args: { reference: InstanceReference }): NativeGraphInspection;
    /** Conservative static variable/path diagnostics; no playable/runtime validity. */
    function animationGraphDiagnostics(args: { reference: InstanceReference }): { reference: InstanceReference; complete: boolean; issues: Array<{ code: string; id: string; variable?: string }>; truncated: boolean; checkedStates: number; checkedConditions: number; clips: Array<{ uuid: string; status: 'verified' | 'missing' | 'wrong-type' | 'identity-mismatch'; assetType: string | null }>; checkedClips: number; directClipsValid: boolean; clipVerificationScope: string; motionIssues: Array<{ code: string; path: string }>; motionTraversalComplete: boolean; motionTraversalTruncated: boolean; inspectedMotionObjects: number; semanticsVerified: false; runtimeVerified: false; verificationScope: string };
    function animationGraphValidate(args: { reference: InstanceReference }): NativeGraphInspection & { valid: false };
    /** Refuses synthetic node/transition edits; no verified native graph serializer is implemented. */
    function animationGraphEdit(args: { reference: InstanceReference; operations: Array<{ operation: 'add_node' | 'remove_node' | 'update_node' | 'add_transition' | 'remove_transition'; node?: unknown; nodeId?: string; transition?: unknown; transitionId?: string }> }): never;
    /** Consolidated: add/remove component on node. */
    function nodeComponentManage(args: { operation: "add" | "remove", reference: InstanceReference, componentType?: string }): { reference?: InstanceReference, success?: boolean };
    /** Consolidated: query editor state or vocabularies. Use instead of removed editorIntrospect/editorListTypes. Plus: shared_settings (= programming builtins) and sorted_plugins (typed after 3.7 — may report not-supported on 3.7.3). */
    function editorQuery(args: EngineApiDiscoveryArgs & { category: 'engine_api' | 'component_schema' }): EngineApiDiscoveryResult;
    function editorQuery(args: { category: 'scene_mode' | 'ready' | 'enum_values' | 'layers' | 'sorting_layers' | 'script_info' | 'has_script' | 'creatable_assets' | 'asset_types' | 'importers' | 'shared_settings' | 'sorted_plugins'; enumPath?: string; className?: string; reference?: InstanceReference }): Record<string, unknown>;
    /** Consolidated: scene lifecycle open/save/close/soft_reload. Use instead of removed sceneOpen/editorOperate. */
    function sceneManage(args: { operation: "open" | "save" | "save_as" | "close" | "soft_reload", reference?: InstanceReference }): { success: boolean, error?: string, reference?: InstanceReference };
    /** Consolidated: preview (asset/scene capture, get url, open browser). */
    function previewManage(args: { operation: "get_url" | "open_browser" | "asset_preview" | "scene_preview", reference?: InstanceReference, imageSize?: number, jpegQuality?: number, transparentColor?: Color, cameraPosition?: Vector3, targetPosition?: Vector3, orthographic?: boolean, orthographicSize?: number }): any;
    /** Consolidated: external programs and url open. */
    function programManage(args: { operation: "get_info" | "open" | "open_url", programName?: string, commandArguments?: Record<string, any>, url?: string }): any;
    /** Consolidated: project settings read/write. */
    function projectManage(args: { operation: "get" | "set", type?: string, key?: string, path?: string, value?: any }): any;
    /** Consolidated: build panel/tasks/trigger/control. */
    function buildManage(args: { operation: "panel_open" | "tasks_info" | "get_task" | "trigger" | "control", panel?: string, taskId?: string | number, options?: Record<string, unknown>, control?: "break" | "remove" | "recompile" }): unknown;
    /** Authoritative scene/target/bundle checks only; not toolchain or signing readiness. */
    function buildPreflight(args: { options: Record<string, unknown> }): { valid: boolean; complete: boolean; targetAvailable: boolean; sceneCount: number; issues: Array<{ code: string; path: string }>; writes: false; toolchainVerified: false; signingVerified: false };
    /** Registered SDK/NDK/Java configuration, paths redacted; never writes. */
    function buildEnvironmentInspect(args?: {}): { programs: Record<string, { available: boolean; configured: boolean; pathRedacted: true }>; writes: false; toolchainVerified: false; signingVerified: false; javaInspection: string };
    /** Guarded terminal-task update; native update-task is in-memory, not persistent preset storage. */
    function buildTaskConfigManage(args: { operation: 'get' | 'set'; taskId: string | number; options?: Record<string, unknown>; expectedOptionsSha256?: string }): { taskId: string; options: Record<string, unknown>; optionsSha256: string; writes: boolean; persisted: false };
    interface TweenSequenceDescriptor {
        version: 1; id: string; target: { id: string; type: 'cc.Node' };
        steps: Array<{ kind: 'delay'; duration: number } | { kind: 'to' | 'by'; duration: number; easing: 'linear' | 'quadIn' | 'quadOut' | 'quadInOut' | 'cubicIn' | 'cubicOut' | 'cubicInOut' | 'sineIn' | 'sineOut' | 'sineInOut'; properties: Partial<Record<'position' | 'scale' | 'eulerAngles', Vector3>> }>;
        lifecycle: { start: 'manual' | 'on-enable'; stop: 'on-disable' | 'on-destroy'; repeat: number };
    }
    interface TweenSequenceInspection {
        representation: 'project-code'; nativeAsset: false; inspectable: boolean;
        sequence?: TweenSequenceDescriptor; durationSeconds?: number;
        diagnostics: Array<{ code: string; path: string; message: string }>;
        source: Record<string, unknown>; targetBinding: string;
        runtime: { status: 'not-requested' | 'unavailable' | 'verified'; code?: string; message: string };
    }
    function tweenSequenceCreate(args: { filePath: string; sequence: TweenSequenceDescriptor; write: true }): TweenSequenceInspection & { created: boolean; bytesWritten: number };
    function tweenSequenceInspect(args: { filePath: string; sequence?: never } | { sequence: TweenSequenceDescriptor; filePath?: never }): TweenSequenceInspection;
    function tweenSequenceValidate(args: ({ filePath: string; sequence?: never } | { sequence: TweenSequenceDescriptor; filePath?: never }) & { runtime?: boolean; sessionId?: string }): TweenSequenceInspection & { valid: boolean; runtimeBinding?: Record<string, unknown>; static: { valid: boolean; diagnostics: Array<{ code: string; path: string; message: string }>; targetChecked: boolean; generatedCode: 'canonical' | 'unsupported'; compilation: 'not-run' } };
    /** T0/T1 graph lookup. Verify a bare UUID through live tools before mutation; never mutate through a composite graph handle. */
    function graphManage(args: {
        operation: 'status' | 'build' | 'query' | 'resolve' | 'navigate' | 'refs' | 'validate';
        bundle?: string; refresh?: boolean; source?: 'disk' | 'auto'; text?: string;
        byComponent?: string; byScript?: string; componentUuid?: string; pathGlob?: string;
        explain?: boolean; handle?: string; uuid?: string;
        relation?: 'ancestors' | 'children' | 'descendants'; depth?: number;
        assetUuid?: string; limit?: number; cursor?: number;
    }): any;
}
