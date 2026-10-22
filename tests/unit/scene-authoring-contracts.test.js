'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');

const { SceneTools } = requireDist('utcp/tools/scene-tools.js');
const { ComponentTools } = requireDist('utcp/tools/component-tools.js');
const { SetPropertyTool } = requireDist('utcp/tools/set-properties-tool.js');

const previousEditor = global.Editor;
afterEach(() => { global.Editor = previousEditor; });

it('creates a Creator3.7 scene from its exact flat native template and confirms the output importer', async () => {
  const calls = [];
  global.Editor = { App: { version: '3.7.3' }, Message: { request: async (_module, message, ...args) => {
    calls.push([message, args[0]]);
    if (message === 'query-asset-info') return args[0] === 'scene-created' ? { uuid: 'scene-created', type: 'cc.SceneAsset', isDirectory: false } : { type: 'cc.Asset', isDirectory: false, url: args[0] };
    if (message === 'copy-asset') return { uuid: 'scene-created' };
    throw new Error(message);
  } } };
  const created = await new SceneTools().sceneCreate({ assetPath: 'db://assets/scene.scene' });
  assert.equal(created.reference.type, 'cc.SceneAsset');
  assert.deepEqual(calls[0], ['query-asset-info', 'db://internal/default_file_content/scene']);
});

describe('scene authoring mutation postconditions', () => {
  it('confirms opened scene identity and rejects mismatched read-back', async () => {
    const calls = [];
    global.Editor = { Message: { request: async (_module, message, payload) => {
      calls.push([message, payload]);
      if (message === 'open-scene') return true;
      if (message === 'query-current-scene') return { uuid: 'other-scene' };
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SceneTools().sceneOpen({ reference: { id: 'requested-scene' } }),
      error => error.code === 'SCENE_OPEN_UNCONFIRMED' && error.status === 502,
    );
    assert.deepEqual(calls, [['open-scene', 'requested-scene'], ['query-current-scene', undefined]]);
  });

  it('creates a node only when query-node confirms the returned UUID', async () => {
    let confirmed = false;
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'create-node') return 'created-node';
      if (message === 'snapshot') return true;
      if (message === 'query-node') return confirmed ? { uuid: payload } : null;
      throw new Error(`unexpected ${message}`);
    } } };
    const tool = new SceneTools();
    await assert.rejects(
      tool.sceneCreateNode({ name: 'Child', parentReference: { id: 'parent' } }),
      error => error.code === 'NODE_CREATE_UNCONFIRMED',
    );
    confirmed = true;
    assert.deepEqual(await tool.sceneCreateNode({ name: 'Child', parentReference: { id: 'parent' } }), {
      reference: { id: 'created-node', type: 'cc.Node' },
    });
  });

  it('fails move when the authoritative parent read-back differs', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'query-node') {
        queries++;
        return queries === 1 ? { uuid: payload } : { uuid: payload, parent: { value: { uuid: 'wrong-parent' } } };
      }
      if (message === 'set-parent' || message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SceneTools().nodeOperate({ operation: 'move', reference: { id: 'child' }, newParentReference: { id: 'parent' } }),
      error => error.code === 'NODE_MOVE_UNCONFIRMED',
    );
  });
});

describe('component authoring mutation postconditions', () => {
  it('removes a component only when query-component confirms absence', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async (_module, message) => {
      if (message === 'query-component') return ++queries === 1 ? { uuid: 'component' } : { uuid: 'component' };
      if (message === 'remove-component') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new ComponentTools().nodeComponentRemove({ reference: { id: 'component' } }),
      /still exists after removal/,
    );
  });

  it('adds a component with type and UUID verified from node read-back', async () => {
    let queryCount = 0;
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'query-node') {
        queryCount++;
        if (queryCount === 1) return { uuid: 'node', __comps__: [] };
        return { uuid: 'node', __comps__: [{ type: 'cc.Label', value: { uuid: { value: 'label-component' } } }] };
      }
      if (message === 'execute-scene-script') {
        if (payload.method === 'startCatchLogging') return { owner: payload.args[0], active: true, expiresAt: payload.args[1] };
        if (payload.method === 'inspectCatchLogging') return { active: false, owned: false, handlerCurrent: false };
        return [];
      }
      if (message === 'create-component' || message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(
      await new ComponentTools().nodeComponentAdd({ reference: { id: 'node' }, componentType: 'cc.Label' }),
      { reference: { id: 'label-component', type: 'cc.Label' } },
    );
  });
});

describe('inspector property mutation postconditions', () => {
  it('rejects a set-property success when a fresh dump keeps the old value', async () => {
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'query-node') return {
        uuid: payload,
        __type__: 'cc.Node',
        __comps__: [],
        children: { value: [] },
        active: { value: false, type: 'Boolean' },
      };
      if (message === 'set-property' || message === 'snapshot') return true;
      if (_module === 'asset-db') return null;
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SetPropertyTool().setInstanceProperties({ reference: { id: 'node' }, propertyPaths: ['active'], values: [true] }),
      /Property mutation was not confirmed/,
    );
  });
});

describe('scene inspection identity contracts', () => {
  it('nodeGetTree returns authoritative component UUID and type', async () => {
    global.Editor = { Message: { request: async (_module, message) => {
      if (message === 'query-node-tree') return {
        uuid: 'root', name: 'Root', components: [{ value: { uuid: { value: 'comp-1' }, __type__: { value: 'cc.Label' } } }], children: [],
      };
      if (message === 'query-current-scene') return null;
      throw new Error(`unexpected ${message}`);
    } } };
    const result = await new SceneTools().nodeGetTree({ fields: ['components'] });
    assert.deepEqual(result.reference, { id: 'root', type: 'cc.Node' });
    assert.deepEqual(result.components, [{ id: 'comp-1', type: 'cc.Label' }]);
    assert.deepEqual(result.children, []);
    assert.equal(result.childrenCount, 0);
    assert.equal(result.childOffset, 0);
    assert.equal(result.pageSize, 200);
    assert.equal(result.nextOffset, null);
    assert.match(result.revision, /^[a-f0-9]{64}$/);
  });
  it('nodeGetTree accepts Creator 3.7 scalar component UUID dumps', async () => {
    global.Editor = { Message: { request: async (_module, message) => {
      if (message === 'query-node-tree') return {
        uuid: 'root', name: 'Root', components: [{ type: 'cc.DirectionalLight', value: 'component-3x7' }], children: [],
      };
      if (message === 'query-current-scene') return null;
      throw new Error(`unexpected ${message}`);
    } } };
    const result = await new SceneTools().nodeGetTree({ fields: ['components'] });
    assert.deepEqual(result.reference, { id: 'root', type: 'cc.Node' });
    assert.deepEqual(result.components, [{ id: 'component-3x7', type: 'cc.DirectionalLight' }]);
    assert.deepEqual(result.children, []);
    assert.equal(result.childrenCount, 0);
    assert.equal(result.childOffset, 0);
    assert.equal(result.pageSize, 200);
    assert.equal(result.nextOffset, null);
    assert.match(result.revision, /^[a-f0-9]{64}$/);
  });
  it('pages root children in native order with a stable revision token', async () => {
    const tree = { uuid: 'root', name: 'Root', children: [
      { uuid: 'a', name: 'A', children: [] },
      { uuid: 'b', name: 'B', children: [] },
      { uuid: 'c', name: 'C', children: [] },
    ] };
    global.Editor = { Message: { request: async (_module, message) => {
      if (message === 'query-node-tree') return tree;
      if (message === 'query-current-scene') return { uuid: 'scene-1' };
      if (_module === 'asset-db' && message === 'query-asset-info') return null;
      throw new Error(`unexpected ${message}`);
    } } };
    const tools = new SceneTools();
    const first = await tools.nodeGetTree({ pageSize: 2 });
    assert.deepEqual(first.children.map((item) => item.reference.id), ['a', 'b']);
    assert.equal(first.childrenCount, 3);
    assert.equal(first.childOffset, 0);
    assert.equal(first.pageSize, 2);
    assert.equal(first.nextOffset, 2);
    assert.match(first.revision, /^[a-f0-9]{64}$/);
    const second = await tools.nodeGetTree({ childOffset: first.nextOffset, pageSize: 2, expectedRevision: first.revision });
    assert.deepEqual(second.children.map((item) => item.reference.id), ['c']);
    assert.equal(second.nextOffset, null);
  });

  it('rejects a page when the hierarchy revision changes', async () => {
    let tree = { uuid: 'root', name: 'Root', children: [{ uuid: 'a', name: 'A', children: [] }] };
    global.Editor = { Message: { request: async (_module, message) => {
      if (message === 'query-node-tree') return tree;
      if (message === 'query-current-scene') return { uuid: 'scene-1' };
      if (_module === 'asset-db' && message === 'query-asset-info') return null;
      throw new Error(`unexpected ${message}`);
    } } };
    const tools = new SceneTools();
    const first = await tools.nodeGetTree({ pageSize: 1 });
    tree = { uuid: 'root', name: 'Root', children: [{ uuid: 'b', name: 'B', children: [] }] };
    await assert.rejects(
      tools.nodeGetTree({ childOffset: 0, pageSize: 1, expectedRevision: first.revision }),
      (error) => error.code === 'HIERARCHY_REVISION_CONFLICT' && error.status === 409,
    );
  });

  it('nodeComponentsGet rejects a matched component missing authoritative type', async () => {
    global.Editor = { Message: { request: async (_module, message) => {
      if (message === 'query-node') return { uuid: 'node', __comps__: [{ value: { uuid: { value: 'comp-1' } } }] };
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new ComponentTools().nodeComponentsGet({ reference: { id: 'node' } }),
      error => error.code === 'INVALID_RESPONSE' && error.status === 502 && error.details.componentIndex === 0
        && error.details.missingType === true && error.details.missingUuid === false,
    );
  });

  it('inspectorSet rejects malformed property arrays with typed error', async () => {
    await assert.rejects(
      new SetPropertyTool().setInstanceProperties({ reference: { id: 'node' }, propertyPaths: [], values: [] }),
      error => error.code === 'INVALID_ARGUMENT' && error.status === 400,
    );
  });
});
describe('camera authoring adapters', () => {
  it('creates a camera and confirms node/component identity', async () => {
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'query-node-tree') return { uuid: 'root' };
      if (message === 'create-node') return 'camera-node';
      if (message === 'create-component') return true;
      if (message === 'query-node') return { uuid: payload, __comps__: [{ type: 'cc.Camera', uuid: 'camera-component' }] };
      if (message === 'snapshot' || message === 'set-property') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().cameraCreate({ name: 'Camera' }), {
      nodeReference: { id: 'camera-node', type: 'cc.Node' },
      cameraReference: { id: 'camera-component', type: 'cc.Camera' },
    });
  });

  it('lists cameras with bounded authoritative component references', async () => {
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'query-node-tree') return { uuid: 'root', name: 'Root', children: [{ uuid: 'node-1', name: 'Main Camera', children: [] }] };
      if (message === 'query-node') return payload === 'root' ? { uuid: 'root', __comps__: [] } : { uuid: payload, __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, projection: { value: 0 } } }] };
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().cameraList(), {
      cameras: [{ nodeReference: { id: 'node-1', type: 'cc.Node' }, name: 'Main Camera', cameraReference: { id: 'camera-1', type: 'cc.Camera' }, priority: undefined, visibility: undefined, projection: 0 }],
      total: 1,
      truncated: false,
    });
  });

  it('sets camera properties only when read-back matches', async () => {
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'query-node-tree') return { uuid: 'root', children: [{ uuid: 'node-1', __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, fov: { value: 45 } } }], children: [] }] };
      if (message === 'query-node') return { uuid: 'node-1', __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, fov: { value: 45 } } }] };
      if (message === 'set-property' || message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().cameraSetProperties({ reference: { id: 'camera-1' }, properties: { fov: 45 } }), { updated: true, reference: { id: 'camera-1', type: 'cc.Camera' } });
  });
});
  it('restores earlier camera properties when a later write fails', async () => {
    let fov = 45;
    let writes = 0;
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'query-node-tree') return { uuid: 'root', children: [{ uuid: 'node-1', __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, fov: { value: fov }, priority: { value: 1 } } }] }] };
      if (message === 'query-node') return { uuid: 'node-1', __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, fov: { value: fov }, priority: { value: 1 } } }] };
      if (message === 'set-property') { writes++; if (payload.path.endsWith('.fov')) { fov = payload.dump.value; return true; } return false; }
      if (message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SceneTools().cameraSetProperties({ reference: { id: 'camera-1' }, properties: { fov: 60, priority: 2 } }),
      error => error.code === 'CAMERA_PROPERTY_UPDATE_FAILED' && error.details.rollbackFailure === null,
    );
    assert.equal(fov, 45);
    assert.equal(writes, 3);
  });

describe('final scene adapters', () => {
  it('refuses a directory masquerading as a scene before returning a SceneAsset reference', async () => {
    let directory = true;
    global.Editor = { Message: { request: async (_service, message, id) => {
      if (message === 'copy-asset') return { uuid: 'scene-1' };
      if (message === 'query-asset-info') return id === 'scene-1'
        ? { uuid: 'scene-1', type: directory ? 'cc.Asset' : 'cc.SceneAsset', isDirectory: directory }
        : { uuid: 'template', url: id, type: 'cc.SceneAsset', isDirectory: false };
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(new SceneTools().sceneCreate({ assetPath: 'db://assets/final.scene' }), error => error.code === 'SCENE_CREATE_UNCONFIRMED');
    directory = false;
    assert.deepEqual(await new SceneTools().sceneCreate({ assetPath: 'db://assets/final.scene' }), { success: true, reference: { id: 'scene-1', type: 'cc.SceneAsset' } });
  });

  it('returns authoritative node and component inspection payloads', async () => {
    global.Editor = { Message: { request: async (_service, message, id) => {
      if (message === 'query-node') return { uuid: id, __type__: { value: 'cc.Node' }, __comps__: [] };
      if (message === 'query-component') return { uuid: id, type: 'cc.Label', string: { value: 'hello' } };
      throw new Error(`unexpected ${message}`);
    } } };
    assert.equal((await new SceneTools().sceneNodeType({ reference: { id: 'node-1' } })).type, 'cc.Node');
    assert.equal((await new SceneTools().sceneComponentInfo({ reference: { id: 'component-1' } })).type, 'cc.Label');
  });
});

describe('scene composite residual adapters', () => {
  it('sceneGetInfo returns dirty alias and hierarchy node count', async () => {
    global.Editor = { Message: { request: async (_service, message) => {
      if (message === 'query-scene-bounds') return { x: 0, y: 0, width: 10, height: 20 };
      if (message === 'query-dirty') return true;
      if (message === 'query-current-scene') return { uuid: 'scene-1', name: 'Main' };
      if (message === 'query-node-tree') return { uuid: 'root', children: [{ uuid: 'child', children: [] }] };
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().sceneGetInfo(), { bounds: { x: 0, y: 0, width: 10, height: 20 }, name: 'Main', uuid: 'scene-1', dirty: true, isDirty: true, nodeCount: 2, currentScene: { uuid: 'scene-1', name: 'Main' } });
  });

  it('nodeSetTransform applies exact paths and confirms read-back', async () => {
    const calls = [];
    const node = { uuid: 'node-1', position: { value: { x: 1, y: 2, z: 3 } }, eulerAngles: { value: { x: 4, y: 5, z: 6 } }, scale: { value: { x: 1, y: 1, z: 1 } }, active: { value: true } };
    global.Editor = { Message: { request: async (_service, message, payload) => {
      calls.push([message, payload]);
      if (message === 'query-node') return node;
      if (message === 'set-property') { node[payload.path] = { value: payload.dump.value }; return true; }
      if (message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().nodeSetTransform({ reference: { id: 'node-1' }, position: { x: 8, y: 9, z: 10 }, rotation: { x: 11, y: 12, z: 13 }, scale: { x: 2, y: 3, z: 4 }, active: false }), { updated: true, reference: { id: 'node-1', type: 'cc.Node' } });
    assert.deepEqual(calls.filter(([message]) => message === 'set-property').map(([, payload]) => payload.path), ['position', 'eulerAngles', 'scale', 'active']);
  });

  it('lifecycle save and save-as require authoritative outcomes', async () => {
    const calls = [];
    global.Editor = { Message: { request: async (_service, message) => {
      calls.push(message);
      if (message === 'query-dirty') return false;
      if (message === 'save-as-scene') return 'scene-2';
      if (message === 'query-current-scene') return 'scene-2';
      return true;
    } } };
    const tools = new (requireDist('utcp/tools/editor-tools.js').EditorTools)();
    assert.deepEqual(await tools.editorOperate({ operation: 'save_scene_or_prefab' }), { success: true, saved: true });
    assert.deepEqual(await tools.editorOperate({ operation: 'save_as' }), { success: true, reference: { id: 'scene-2', type: 'cc.SceneAsset' } });
    assert.deepEqual(calls, ['save-scene', 'query-dirty', 'save-as-scene', 'query-current-scene']);
  });
});

describe('scene residual bounded contracts', () => {
  it('nodeGetInfo and queryComponents return authoritative bounded data', async () => {
    global.Editor = { Message: { request: async (_service, message, payload) => {
      if (message === 'query-node') return { uuid: payload, __type__: { value: 'cc.Node' }, __comps__: [] };
      if (message === 'query-components') return [{ name: 'cc.Node' }, { name: 'cc.Label' }, { name: 'GameController' }];
      throw new Error(`unexpected ${message}`);
    } } };
    const tools = new SceneTools();
    assert.equal((await tools.nodeGetInfo({ reference: { id: 'node-1' } })).uuid, 'node-1');
    assert.deepEqual(await tools.queryComponents({ filter: 'cc.', limit: 1 }), { componentTypes: ['cc.Node'], total: 2, truncated: true });
  });

  it('callComponentMethod rejects non-allowlisted methods before IPC', async () => {
    let calls = 0;
    global.Editor = { Message: { request: async () => { calls += 1; return {}; } } };
    await assert.rejects(new SceneTools().callComponentMethod({ reference: { id: 'component-1' }, methodName: 'arbitraryMethod' }), error => error.code === 'METHOD_NOT_ALLOWED' && error.status === 422);
    assert.equal(calls, 0);
  });

  it('callComponentMethod verifies component, executes, snapshots, and normalizes undefined', async () => {
    const calls = [];
    global.Editor = { Message: { request: async (_service, message, payload) => {
      calls.push(message);
      if (message === 'query-component') return { uuid: payload, type: 'cc.Label' };
      if (message === 'execute-component-method') return undefined;
      if (message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().callComponentMethod({ reference: { id: 'component-1' }, methodName: 'unscheduleAllCallbacks' }), { result: null });
    assert.deepEqual(calls, ['query-component', 'execute-component-method', 'snapshot']);
  });
});

describe('scene lifecycle close and reload contracts', () => {
  it('confirms close clears the current scene and reload preserves identity', async () => {
    const calls = [];
    let current = { uuid: 'scene-1' };
    global.Editor = { Message: { request: async (_service, message) => {
      calls.push(message);
      if (message === 'query-current-scene') return current;
      if (message === 'close-scene') { current = null; return true; }
      if (message === 'soft-reload') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    const tools = new (requireDist('utcp/tools/editor-tools.js').EditorTools)();
    assert.deepEqual(await tools.editorOperate({ operation: 'soft_reload' }), { success: true });
    assert.deepEqual(await tools.editorOperate({ operation: 'close_scene_or_prefab' }), { success: true });
    assert.deepEqual(calls, ['query-current-scene', 'soft-reload', 'query-current-scene', 'close-scene', 'query-current-scene']);
  });
});

describe('scene history residual contracts', () => {
  it('routes snapshot abort to the native transaction boundary', async () => {
    const calls = [];
    global.Editor = { Message: { request: async (_service, message) => { calls.push(message); return true; } } };
    const tools = new (requireDist('utcp/tools/editor-tools.js').EditorTools)();
    assert.deepEqual(await tools.editorHistory({ operation: 'abort' }), { success: true });
    assert.deepEqual(calls, ['snapshot-abort']);
  });
});
describe('scene upgrade read-back contracts', () => {
  it('nodeGetInfo returns the complete authoritative node dump, not only identity', async () => {
    global.Editor = { Message: { request: async (_service, message, id) => {
      if (message === 'query-node') return {
        uuid: id,
        name: 'Player',
        active: { value: true, type: 'Boolean' },
        position: { value: { x: 1, y: 2, z: 3 } },
        __comps__: [{ value: { uuid: { value: 'label-1' }, __type__: { value: 'cc.Label' } } }],
      };
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().nodeGetInfo({ reference: { id: 'node-1' } }), {
      uuid: 'node-1',
      name: 'Player',
      active: { value: true, type: 'Boolean' },
      position: { value: { x: 1, y: 2, z: 3 } },
      __comps__: [{ value: { uuid: { value: 'label-1' }, __type__: { value: 'cc.Label' } } }],
    });
  });

  it('nodeComponentsGet returns authoritative component references for the requested node', async () => {
    global.Editor = { Message: { request: async (_service, message) => {
      if (message === 'query-node') return {
        uuid: 'node-1',
        __comps__: [
          { value: { uuid: { value: 'label-1' }, __type__: { value: 'cc.Label' } } },
          { uuid: 'script-1', type: 'GameController' },
        ],
      };
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual((await new ComponentTools().nodeComponentsGet({ reference: { id: 'node-1' }, componentType: 'cc.Label' })).references, [
      { id: 'label-1', type: 'cc.Label', componentIndex: 0 },
    ]);
    assert.deepEqual((await new ComponentTools().nodeComponentsGet({ reference: { id: 'node-1' } })).references, [
      { id: 'label-1', type: 'cc.Label', componentIndex: 0 }, { id: 'script-1', type: 'GameController', componentIndex: 1 },
    ]);
  });

  it('nodeSetTransform rejects accepted writes when fresh read-back is stale', async () => {
    global.Editor = { Message: { request: async (_service, message) => {
      if (message === 'query-node') return { uuid: 'node-1', position: { value: { x: 1, y: 2, z: 3 } } };
      if (message === 'set-property' || message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SceneTools().nodeSetTransform({ reference: { id: 'node-1' }, position: { x: 8, y: 9, z: 10 } }),
      error => error.code === 'NODE_TRANSFORM_UPDATE_UNCONFIRMED' && error.status === 502,
    );
  });

  it('cameraSetProperties rejects accepted writes when fresh component read-back is stale', async () => {
    global.Editor = { Message: { request: async (_service, message) => {
      if (message === 'query-node-tree') return { uuid: 'root', children: [{ uuid: 'node-1', children: [], __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, fov: { value: 45 } } }] }] };
      if (message === 'query-node') return { uuid: 'node-1', __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, fov: { value: 45 } } }] };
      if (message === 'set-property' || message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SceneTools().cameraSetProperties({ reference: { id: 'camera-1' }, properties: { fov: 60 } }),
      error => error.code === 'CAMERA_PROPERTY_UPDATE_FAILED' && error.details.rollbackFailure === null,
    );
  });

  it('refuses restoration after an external camera value change', async () => {
    let fov = 45;
    global.Editor = { Message: { request: async (_service, message, payload) => {
      if (message === 'query-node-tree') return { uuid: 'root', children: [{ uuid: 'node-1', __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, fov } }] }] };
      if (message === 'query-node') return { uuid: 'node-1', __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, fov } }] };
      if (message === 'set-property') { fov = payload.dump.value === 60 ? 60 : payload.dump.value; return false; }
      if (message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SceneTools().cameraSetProperties({ reference: { id: 'camera-1' }, properties: { fov: 60 } }),
      error => error.code === 'ROLLBACK_FAILED' && error.details.rollbackFailure === 'fov',
    );
  });
});

describe('scene asset usage identity contracts', () => {
  const frame = 'image-uuid@spriteFrame';
  const image = 'image-uuid';

  it('rejects a scene node UUID as an asset before querying usages', async () => {
    const calls = [];
    global.Editor = { Message: { request: async (service, message, id) => {
      calls.push([service, message, id]);
      if (message === 'query-asset-info') return null;
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SceneTools().findNodesByAsset({ reference: { id: 'node-uuid', type: 'cc.Node' } }),
      error => error.code === 'TARGET_NOT_FOUND' && error.status === 404,
    );
    assert.deepEqual(calls, [['asset-db', 'query-asset-info', 'node-uuid']]);
  });

  it('preserves exact sub-asset and node IDs and counts all valid results past the limit', async () => {
    const calls = [];
    global.Editor = { Message: { request: async (service, message, id) => {
      calls.push([service, message, id]);
      if (message === 'query-asset-info') return { uuid: id, type: 'cc.SpriteFrame', importer: 'sprite-frame' };
      if (message === 'query-nodes-by-asset-uuid') return ['node-A', 'node-B', 'node-C'];
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().spriteFrameUsageInspect({ reference: { id: frame }, limit: 1 }), {
      reference: { id: frame, type: 'cc.SpriteFrame' }, nodes: [{ id: 'node-A', type: 'cc.Node' }], total: 3, truncated: true,
    });
    assert.deepEqual(calls.filter(([, message]) => message === 'query-nodes-by-asset-uuid'), [['scene', 'query-nodes-by-asset-uuid', frame]]);
    assert.equal(calls.filter(([, message]) => message === 'query-node').length, 0);
  });

  it('rejects malformed scene IPC nodes, including those beyond the returned limit', async () => {
    global.Editor = { Message: { request: async (_service, message, id) => {
      if (message === 'query-asset-info') return { uuid: id, type: 'cc.ImageAsset' };
      if (message === 'query-nodes-by-asset-uuid') return ['node-A', { uuid: '' }];
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SceneTools().findNodesByAsset({ reference: { id: image }, limit: 1 }),
      error => error.code === 'INVALID_RESPONSE' && error.status === 502,
    );
  });

  it('rejects an asset-db response for a different UUID rather than silently querying it', async () => {
    let sceneQueries = 0;
    global.Editor = { Message: { request: async (_service, message) => {
      if (message === 'query-asset-info') return { uuid: 'another-asset', type: 'cc.SpriteFrame' };
      sceneQueries++;
      return [];
    } } };
    await assert.rejects(
      new SceneTools().findNodesByAsset({ reference: { id: frame } }),
      error => error.code === 'INVALID_RESPONSE' && error.status === 502,
    );
    assert.equal(sceneQueries, 0);
  });

  it('isolates invalid SpriteFrame assets as per-item batch errors', async () => {
    global.Editor = { Message: { request: async (_service, message, id) => {
      if (message === 'query-asset-info') return id === frame ? { uuid: id, type: 'cc.SpriteFrame' } : null;
      if (message === 'query-nodes-by-asset-uuid') return ['node-A', 'node-B'];
      throw new Error(`unexpected ${message}`);
    } } };
    const result = await new SceneTools().spriteFrameUsageBatchInspect({ references: [{ id: 'node-uuid' }, { id: frame }], limitPerFrame: 1 });
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.items[0].ok, false);
    assert.deepEqual(result.items[1].result, { reference: { id: frame, type: 'cc.SpriteFrame' }, nodes: [{ id: 'node-A', type: 'cc.Node' }], total: 2, truncated: true });
  });

  it('reports complete image SpriteFrame traversal as non-truncated at the exact frame cap', async () => {
    global.Editor = { Message: { request: async (_service, message, id) => {
      if (message === 'query-asset-info') return id === image
        ? { uuid: image, type: 'cc.ImageAsset', importer: 'image', subAssets: { spriteFrame: { uuid: frame, type: 'cc.SpriteFrame', importer: 'sprite-frame' } } }
        : { uuid: frame, type: 'cc.SpriteFrame', importer: 'sprite-frame' };
      if (message === 'query-nodes-by-asset-uuid') return id === frame ? ['sprite-node'] : [];
      throw new Error(`unexpected ${message}`);
    } } };
    const result = await new SceneTools().imageSceneUsageInspect({ imageReference: { id: image }, maxFrames: 1 });
    assert.equal(result.totalSpriteFrames, 1);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.spriteFrames[0].nodes, [{ id: 'sprite-node', type: 'cc.Node' }]);
  });
});

describe('missing asset node identity contracts', () => {
  it('rejects malformed missing-assets IPC payloads instead of reporting a healthy scene', async () => {
    global.Editor = { Message: { request: async () => ['valid-node', { uuid: '' }] } };
    await assert.rejects(
      new SceneTools().findNodesWithMissingAssets({ limit: 1 }),
      error => error.code === 'INVALID_RESPONSE' && error.status === 502,
    );
  });
});

describe('selection and composition observation boundaries', () => {
  it('partitions scattered selections without filling gaps or projecting partial groups', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children:
      Array.from({ length: 6 }, (_, index) => ({ uuid: `n${index}`, name: `N${index}` })) }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const references = ['n5', 'n0', 'n4', 'n1'].map(id => ({ id }));
    const result = await tools.nodeGetPaths({ references });
    assert.deepEqual(result.siblingBlocks.map(block => block.references.map(ref => ref.id)), [['n0', 'n1'], ['n4', 'n5']]);
    assert.deepEqual(result.siblingSpan, { firstIndex: 0, lastIndex: 5, gapCount: 2 });
    const partial = await tools.nodeGetPaths({ references: [...references, { id: 'absent' }] });
    assert.equal(partial.failed, 1);
    assert.equal(partial.siblingBlocks, null);
    assert.equal(partial.siblingOrder, null);
    await assert.rejects(() => tools.nodeGetPaths({ references, requireContiguous: true }),
      error => error.code === 'NODE_SELECTION_NOT_CONTIGUOUS');
  });

  it('detects same-name reparenting even when path and sibling position are unchanged', async () => {
    let parent = 'original';
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [
      { uuid: parent, name: 'Container', children: [{ uuid: 'child', name: 'Child' }] },
    ] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const references = [{ id: 'child' }];
    const initial = (await tools.nodeGetPaths({ references })).items[0].result;
    parent = 'replacement';
    const refreshed = await tools.nodeGetPaths({ references, requireAncestors: true,
      expectedAncestors: [{ reference: references[0], ancestors: initial.ancestors }],
      expectedPaths: [{ reference: references[0], path: initial.path }],
      expectedSiblingIndices: [{ reference: references[0], siblingIndex: initial.siblingIndex }],
    });
    assert.equal(refreshed.items[0].error.code, 'NODE_ANCESTRY_CHANGED');
    assert.equal(refreshed.items[0].error.status, 409);
    assert.deepEqual(refreshed.items[0].error.details.expectedAncestorIds, ['root', 'original']);
    assert.deepEqual(refreshed.items[0].error.details.ancestorIds, ['root', 'replacement']);
    assert.equal(refreshed.siblingBlocks, null);
  });

  it('retains simultaneous composition violations but never invents findings for query failures', async () => {
    global.Editor = { Message: { request: async (_service, _message, id) => {
      if (id === 'unreadable') throw new Error('unavailable');
      return { uuid: id, __comps__: [{ uuid: 'button', type: 'cc.Button' }, { uuid: 'second-button', type: 'Button' }] };
    } } };
    const args = { references: [{ id: 'node' }, { id: 'unreadable' }],
      requiredComponentTypes: ['UITransform'], forbiddenComponentTypes: ['cc.Button'],
      excludeComponentTypes: ['Button'], summaryOnly: true, requireAll: true };
    await assert.rejects(() => new ComponentTools().nodeComponentsBatchGet(args), error => {
      assert.equal(error.code, 'COMPONENT_GROUP_INCOMPLETE');
      const [violation, unreadable] = error.details.items;
      assert.deepEqual(violation.error.missingComponentTypes, ['UITransform']);
      assert.deepEqual(violation.error.forbiddenComponentTypes, ['Button']);
      assert.deepEqual(violation.error.forbiddenComponentCounts, { Button: 2 });
      assert.equal(violation.error.inventorySummary.total, 2);
      assert.equal(violation.error.inventorySummary.unknownEnabled, 2);
      assert.deepEqual({ ...violation.error.inventorySummary.classCounts }, { 'cc.Button': 1, Button: 1 });
      assert.equal('missingComponentTypes' in unreadable.error, false);
      assert.equal('forbiddenComponentTypes' in unreadable.error, false);
      assert.equal('forbiddenComponentCounts' in unreadable.error, false);
      assert.equal('inventorySummary' in unreadable.error, false);
      assert.equal(error.details.inventorySummary.observedNodes, 0);
      return true;
    });
  });
  it('refreshes composition failures with their revision but rejects drift without fresh summary claims', async () => {
    let components = [{ uuid: 'button', type: 'cc.Button' }];
    global.Editor = { Message: { request: async () => ({ uuid: 'node', __comps__: components }) } };
    const tools = new ComponentTools();
    const args = { references: [{ id: 'node' }], forbiddenComponentTypes: ['Button'], summaryOnly: true };
    const first = (await tools.nodeComponentsBatchGet(args)).items[0].error;
    const guarded = { ...args, requireRevisions: true,
      expectedRevisions: [{ reference: { id: 'node' }, revision: first.revision }] };
    const unchanged = (await tools.nodeComponentsBatchGet(guarded)).items[0].error;
    assert.equal(unchanged.code, 'COMPONENT_COMPOSITION_FORBIDDEN');
    assert.equal(unchanged.inventorySummary.total, 1);
    components = [...components, { uuid: 'label', type: 'cc.Label' }];
    const stale = (await tools.nodeComponentsBatchGet(guarded)).items[0].error;
    assert.equal(stale.code, 'COMPONENT_INVENTORY_CHANGED');
    assert.equal(stale.details.nodeId, 'node');
    assert.equal(stale.details.expectedRevision, first.revision);
    assert.notEqual(stale.details.observedRevision, first.revision);
    const fresh = await tools.nodeComponentsGet({ reference: { id: 'node' } });
    assert.equal(stale.details.observedRevision, fresh.revision);
    assert.equal('revision' in stale, false);
    assert.equal('inventorySummary' in stale, false);
    assert.equal('forbiddenComponentTypes' in stale, false);
  });

  it('rejects incomplete tree guard coverage before querying any hierarchy', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; throw new Error('unexpected query'); } } };
    const tools = new SceneTools();
    const references = [{ id: 'first' }, { id: 'second' }];
    await assert.rejects(() => tools.nodeGetPaths({ references, requireAncestors: true,
      expectedAncestors: [{ reference: references[0], ancestors: [] }] }),
    error => error.code === 'INVALID_ARGUMENT');
    await assert.rejects(() => tools.nodeGetPaths({ references, requireSiblingIndices: true,
      expectedSiblingIndices: [{ reference: references[0], siblingIndex: 0 }] }),
    error => error.code === 'INVALID_ARGUMENT');
    assert.equal(queries, 0);
  });
  it('counts component-bearing nodes once per class and preserves descendants of malformed inventories', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', components: 'invalid', children: [
      { uuid: 'branch', name: 'Branch', components: [{ type: 'cc.Button' }, { type: 'Button' }], children: [
        { uuid: 'leaf', name: 'Leaf', components: [{ type: 'cc.Button' }, {}] },
      ] },
      { uuid: 'outside', name: 'Outside', components: [{ type: 'cc.Label' }] },
    ] }) } };
    const tools = new SceneTools();
    const full = await tools.sceneHierarchyAnalyze({ limit: 10 });
    assert.equal(full.componentCounts.Button, 3);
    assert.equal(full.componentNodeCounts.Button, 2);
    assert.equal(full.unknownComponentsNodes, 1);
    assert.equal(full.unknownComponentCount, 1);
    const subtree = await tools.sceneHierarchyAnalyze({ rootReference: { id: 'branch' }, limit: 10 });
    assert.deepEqual({ ...subtree.componentNodeCounts }, { Button: 2 });
    const prefix = await tools.sceneHierarchyAnalyze({ rootReference: { id: 'branch' }, limit: 1 });
    assert.equal(prefix.truncated, true);
    assert.deepEqual({ ...prefix.componentNodeCounts }, { Button: 1 });
    assert.equal(prefix.componentCounts.Button, 2);
  });
  it('selects original component indices and refuses stale reordering or malformed unselected entries', async () => {
    let components = [{ uuid: 'transform', type: 'cc.UITransform' },
      { uuid: 'first-label', type: 'cc.Label' }, { uuid: 'second-label', type: 'cc.Label' }];
    global.Editor = { Message: { request: async () => ({ uuid: 'node', __comps__: components }) } };
    const tools = new ComponentTools();
    const args = { reference: { id: 'node' }, componentTypes: ['Label'], componentIndex: 1 };
    const initial = await tools.nodeComponentsGet(args);
    assert.deepEqual(initial.references.map(reference => reference.id), ['first-label']);
    components = [components[0], components[2], components[1]];
    await assert.rejects(() => tools.nodeComponentsGet({ ...args, expectedRevision: initial.revision }),
      error => error.code === 'COMPONENT_INVENTORY_CHANGED');
    const refreshed = await tools.nodeComponentsGet(args);
    assert.deepEqual(refreshed.references.map(reference => reference.id), ['second-label']);
    components = [...components, { uuid: 'malformed' }];
    await assert.rejects(() => tools.nodeComponentsGet(args), Error);
  });
  it('distinguishes duplicated UUID objects from repeated objects and unseen truncated identities', async () => {
    const repeated = { uuid: 'shared', name: 'Repeated' };
    const tree = { uuid: 'root', name: 'Root', children: [repeated, repeated,
      { uuid: 'shared', name: 'DifferentObject' }, { uuid: ' ', name: 'MissingIdentity' }] };
    global.Editor = { Message: { request: async () => tree } };
    const tools = new SceneTools();
    const prefix = await tools.sceneHierarchyAnalyze({ limit: 2 });
    assert.equal(prefix.truncated, true);
    assert.deepEqual(prefix.duplicateNodeUuids, []);
    assert.equal(prefix.missingNodeUuidCount, 0);
    const full = await tools.sceneHierarchyAnalyze({ limit: 10 });
    assert.equal(full.checkedNodes, 4);
    assert.deepEqual(full.duplicateNodeUuids, [{ uuid: 'shared', count: 2 }]);
    assert.equal(full.missingNodeUuidCount, 1);
    assert.equal(Object.values(full.depthCounts).reduce((sum, count) => sum + count, 0), full.checkedNodes);
  });
  it('reports topology depth independently of slash names and path root formatting', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [
      { uuid: 'parent', name: 'A/B', children: [{ uuid: 'child', name: 'C' }] },
    ] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    assert.equal((await tools.nodeGetPath({ reference: { id: 'child' } })).depth, 2);
    const scoped = await tools.nodeGetPaths({ references: [{ id: 'parent' }, { id: 'child' }],
      relativeTo: { id: 'parent' }, includeRoot: false });
    assert.deepEqual(scoped.items.map(item => item.result.depth), [0, 1]);
    assert.deepEqual(scoped.items.map(item => item.result.childCount), [1, 0]);
    assert.deepEqual(scoped.items.map(item => item.result.siblingCount), [null, 1]);
  });
  it('navigates adjacent UUIDs without crossing parent or scope boundaries', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [
      { uuid: 'a', name: 'Same' }, { uuid: 'b', name: 'Same' }, { uuid: 'c', name: 'Same' },
    ] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const batch = await tools.nodeGetPaths({ references: ['a', 'b', 'c'].map(id => ({ id })) });
    assert.deepEqual(batch.items.map(item => [item.result.previousSibling?.id ?? null, item.result.nextSibling?.id ?? null]),
      [[null, 'b'], ['a', 'c'], ['b', null]]);
    const scoped = await tools.nodeGetPath({ reference: { id: 'b' }, relativeTo: { id: 'b' } });
    assert.equal(scoped.previousSibling, null);
    assert.equal(scoped.nextSibling, null);
    assert.equal(scoped.firstChild, null);
    assert.equal(scoped.lastChild, null);
    const root = await tools.nodeGetPath({ reference: { id: 'root' }, relativeTo: { id: 'root' } });
    assert.deepEqual(root.firstChild, { id: 'a', type: 'cc.Node' });
    assert.deepEqual(root.lastChild, { id: 'c', type: 'cc.Node' });
  });
  it('measures distance from the outermost successful selected ancestor', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [
      { uuid: 'middle', name: 'Middle', children: [{ uuid: 'leaf', name: 'Leaf' }] },
    ] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const references = ['leaf', 'middle', 'root'].map(id => ({ id }));
    const full = await tools.nodeGetPaths({ references });
    assert.deepEqual(full.items.map(item => item.result.descendantCount), [0, 1, 2]);
    assert.equal(full.selectedSubtreeNodeCount, 3);
    const duplicated = await tools.nodeGetPaths({ references: [{ id: 'middle' }, { id: 'middle' }, { id: 'leaf' }] });
    assert.equal(duplicated.selectedSubtreeNodeCount, 2);
    const scoped = await tools.nodeGetPath({ reference: { id: 'middle' }, relativeTo: { id: 'middle' } });
    assert.equal(scoped.descendantCount, 1);
    assert.deepEqual(full.selectionCoverage.map(entry => [entry.reference.id, entry.selectionRoot.id, entry.distanceFromSelectionRoot]),
      [['leaf', 'root', 2], ['middle', 'root', 1], ['root', 'root', 0]]);
    const partial = await tools.nodeGetPaths({ references, expectedPaths: [{ reference: { id: 'root' }, path: 'stale' }] });
    assert.equal(partial.selectedSubtreeNodeCount, null);
    assert.deepEqual(partial.selectionCoverage.map(entry => [entry.reference.id, entry.selectionRoot.id, entry.distanceFromSelectionRoot]),
      [['leaf', 'middle', 1], ['middle', 'middle', 0]]);
  });
  it('counts the subtree union for every nonempty selection on a branching tree', async () => {
    const children = { root: ['left', 'right'], left: ['a', 'b'], right: ['c'], a: [], b: [], c: [] };
    const build = id => ({ uuid: id, name: id, children: children[id].map(build) });
    global.Editor = { Message: { request: async () => build('root') } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const shape = await tools.nodeGetPaths({ references: ['root', 'left', 'a'].map(id => ({ id })) });
    assert.deepEqual(shape.items.map(item => [item.result.descendantCount, item.result.subtreeHeight]), [[5, 2], [2, 1], [0, 0]]);
    const ids = Object.keys(children);
    const collect = (id, union) => { union.add(id); for (const child of children[id]) collect(child, union); };
    for (let mask = 1; mask < 1 << ids.length; mask++) {
      const selected = ids.filter((_, index) => mask & 1 << index);
      const union = new Set();
      for (const id of selected) collect(id, union);
      const result = await tools.nodeGetPaths({ references: selected.map(id => ({ id })) });
      const reversed = await tools.nodeGetPaths({ references: [...selected].reverse().map(id => ({ id })) });
      assert.equal(result.selectedSubtreeNodeCount, union.size);
      assert.equal(reversed.selectedSubtreeNodeCount, union.size);
      assert.deepEqual(result.selectionRoots.map(ref => ref.id).sort(), reversed.selectionRoots.map(ref => ref.id).sort());
    }
  });
  it('uses the deepest branch for height rather than summing branch depths', async () => {
    const tree = { uuid: 'root', name: 'Root', children: [
      { uuid: 'short', name: 'Short' },
      { uuid: 'deep', name: 'Deep', children: [{ uuid: 'middle', name: 'Middle', children: [{ uuid: 'leaf', name: 'Leaf' }] }] },
    ] };
    global.Editor = { Message: { request: async () => tree } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const result = await tools.nodeGetPath({ reference: { id: 'root' } });
    assert.equal(result.childCount, 2);
    assert.equal(result.descendantCount, 4);
    assert.equal(result.subtreeHeight, 3);
    assert.equal(result.subtreeLeafCount, 2);
    const leaf = await tools.nodeGetPath({ reference: { id: 'leaf' }, relativeTo: { id: 'leaf' } });
    assert.equal(leaf.subtreeLeafCount, 1);
  });

  it('refuses subtree metadata for malformed children and duplicate or cyclic identities', async () => {
    const cycle = { uuid: 'root', name: 'Root', children: [] };
    cycle.children.push(cycle);
    const trees = [
      { uuid: 'root', name: 'Root', children: 'invalid' },
      { uuid: 'root', name: 'Root', children: [{ uuid: 'root', name: 'Duplicate' }] },
      cycle,
    ];
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    for (const tree of trees) {
      global.Editor = { Message: { request: async () => tree } };
      await assert.rejects(() => tools.nodeGetPaths({ references: [{ id: 'root' }] }),
        error => error.code === 'INVALID_RESPONSE');
    }
  });
  it('accepts the exact hierarchy budget and refuses overflow without a partial footprint', async () => {
    const tree = { uuid: 'root', name: 'Root', children: Array.from({ length: 9999 }, (_, index) =>
      ({ uuid: `child-${index}`, name: `Child${index}` })) };
    global.Editor = { Message: { request: async () => tree } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const result = await tools.nodeGetPaths({ references: [{ id: 'root' }, { id: 'child-9998' }] });
    assert.equal(result.selectedSubtreeNodeCount, 10000);
    assert.equal(result.items[0].result.subtreeLeafCount, 9999);
    assert.equal(result.items[0].result.subtreeHeight, 1);
    assert.equal(result.items[1].result.siblingIndex, 9998);
    tree.children.push({ uuid: 'overflow', name: 'Overflow' });
    await assert.rejects(() => tools.nodeGetPaths({ references: [{ id: 'root' }] }),
      error => error.code === 'RESULT_TOO_LARGE' && error.status === 413);
  });
  it('validates the full component inventory budget before selecting a bounded page', async () => {
    const components = Array.from({ length: 10000 }, (_, index) => ({ uuid: `component-${index}`, type: 'cc.Label' }));
    global.Editor = { Message: { request: async () => ({ uuid: 'node', __comps__: components }) } };
    const tools = new ComponentTools();
    const args = { reference: { id: 'node' }, offset: 9999, limit: 1 };
    const last = await tools.nodeComponentsGet(args);
    assert.deepEqual(last.references.map(reference => reference.id), ['component-9999']);
    assert.equal(last.inventorySummary.total, 10000);
    assert.equal(last.nextOffset, null);
    components.push({ uuid: 'overflow', type: 'cc.Button' });
    const refused = await tools.nodeComponentsBatchGet({ references: [{ id: 'node' }], componentTypes: ['Button'], limitPerNode: 1 });
    assert.equal(refused.succeeded, 0);
    assert.equal(refused.items[0].error.code, 'RESULT_TOO_LARGE');
    assert.equal(refused.items[0].error.status, 413);
    assert.equal('inventorySummary' in refused.items[0].error, false);
    assert.equal('revision' in refused.items[0].error, false);
  });
  it('rejects contradictory composition rules before IPC without confusing exclusions with prohibitions', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => {
      queries++;
      return { uuid: 'node', __comps__: [{ uuid: 'button', type: 'cc.Button' }] };
    } } };
    const tools = new ComponentTools();
    const references = [{ id: 'node' }];
    await assert.rejects(() => tools.nodeComponentsBatchGet({ references,
      requiredComponentTypes: ['Button', 'cc.Button'], forbiddenComponentTypes: ['cc.Button'], requireAll: true }), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(error.details.conflictingComponentTypes, ['Button']);
      return true;
    });
    assert.equal(queries, 0);
    const result = await tools.nodeComponentsBatchGet({ references, requiredComponentTypes: ['Button'],
      excludeComponentTypes: ['cc.Button'], summaryOnly: true });
    assert.equal(result.succeeded, 1);
    assert.equal(result.items[0].result.total, 0);
    assert.equal(result.items[0].result.inventorySummary.classCounts['cc.Button'], 1);
  });
  it('checks component presence and singleton cardinality against full matches, not page length', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'node', __comps__: [
      { uuid: 'first', type: 'cc.Label' }, { uuid: 'second', type: 'cc.Label' },
    ] }) } };
    const tools = new ComponentTools();
    const references = [{ id: 'node' }];
    const end = await tools.nodeComponentsBatchGet({ references, componentTypes: ['Label'], requireMatch: true,
      offsets: [{ reference: references[0], offset: 2 }], limitPerNode: 1 });
    assert.equal(end.succeeded, 1);
    assert.equal(end.items[0].result.total, 2);
    assert.deepEqual(end.items[0].result.references, []);
    assert.equal(end.items[0].result.nextOffset, null);
    const singleton = await tools.nodeComponentsBatchGet({ references, componentTypes: ['Label'], requireSingle: true, limitPerNode: 1 });
    assert.equal(singleton.items[0].error.code, 'COMPONENT_MATCH_AMBIGUOUS');
    assert.equal(singleton.items[0].error.status, 409);
    assert.equal(singleton.items[0].error.matchCount, 2);
    assert.equal(singleton.inventorySummary.observedNodes, 0);
    const absent = await tools.nodeComponentsBatchGet({ references, componentTypes: ['Button'], requireMatch: true, summaryOnly: true });
    assert.equal(absent.items[0].error.code, 'COMPONENT_MATCH_NOT_FOUND');
    assert.equal(absent.items[0].error.status, 404);
    assert.equal(absent.items[0].error.matchCount, 0);
    assert.equal(absent.items[0].error.inventorySummary.total, 2);
  });
  it('invalidates revisions on enabled-state drift and isolates unknown state from valid batch siblings', async () => {
    let enabled = true;
    global.Editor = { Message: { request: async (_service, _message, id) => ({ uuid: id, __comps__: [
      id === 'unknown' ? { uuid: `${id}-label`, type: 'cc.Label' }
        : { uuid: `${id}-label`, type: 'cc.Label', enabled: { value: enabled } },
    ] }) } };
    const tools = new ComponentTools();
    const reference = { id: 'known' };
    const initial = await tools.nodeComponentsGet({ reference, enabled: true });
    assert.deepEqual(initial.references.map(entry => entry.id), ['known-label']);
    enabled = false;
    await assert.rejects(() => tools.nodeComponentsGet({ reference, enabled: true, expectedRevision: initial.revision }),
      error => error.code === 'COMPONENT_INVENTORY_CHANGED');
    const batch = await tools.nodeComponentsBatchGet({ references: [{ id: 'unknown' }, reference], enabled: false });
    assert.equal(batch.items[0].error.code, 'COMPONENT_STATE_UNAVAILABLE');
    assert.deepEqual(batch.items[0].error.stateIdentity, { nodeId: 'unknown', componentId: 'unknown-label', componentIndex: 0 });
    assert.equal('inventorySummary' in batch.items[0].error, false);
    assert.deepEqual(batch.items[1].result.references.map(entry => entry.id), ['known-label']);
    assert.equal(batch.inventorySummary.observedNodes, 1);
    assert.equal(batch.inventorySummary.failedNodes, 1);
    assert.equal(batch.inventorySummary.disabled, 1);
  });
  it('binds batch revisions by UUID and preserves unaffected nodes when one inventory drifts', async () => {
    let queries = 0;
    const nodes = { a: [{ uuid: 'a-label', type: 'cc.Label' }], b: [{ uuid: 'b-label', type: 'cc.Label' }] };
    global.Editor = { Message: { request: async (_service, _message, id) => {
      queries++;
      return { uuid: id, __comps__: nodes[id] };
    } } };
    const tools = new ComponentTools();
    const references = [{ id: 'a' }, { id: 'b' }];
    const initial = await tools.nodeComponentsBatchGet({ references });
    const expectedRevisions = initial.items.map(item => ({ reference: item.reference, revision: item.result.revision }));
    const before = queries;
    await assert.rejects(() => tools.nodeComponentsBatchGet({ references, requireRevisions: true,
      expectedRevisions: expectedRevisions.slice(0, 1) }), error => error.code === 'INVALID_ARGUMENT');
    assert.equal(queries, before);
    const guarded = { references: [...references].reverse(), expectedRevisions, requireRevisions: true, summaryOnly: true };
    assert.equal((await tools.nodeComponentsBatchGet(guarded)).succeeded, 2);
    nodes.a.push({ uuid: 'a-button', type: 'cc.Button' });
    const changed = await tools.nodeComponentsBatchGet(guarded);
    assert.equal(changed.items[0].reference.id, 'b');
    assert.equal(changed.items[0].ok, true);
    assert.equal(changed.items[1].error.code, 'COMPONENT_INVENTORY_CHANGED');
    assert.equal(changed.inventorySummary.observedNodes, 1);
    assert.equal(changed.inventorySummary.total, 1);
    await assert.rejects(() => tools.nodeComponentsBatchGet({ ...guarded, requireAll: true }), error => {
      assert.equal(error.code, 'COMPONENT_GROUP_INCOMPLETE');
      assert.equal(error.details.items[0].ok, true);
      assert.equal(error.details.items[1].error.code, 'COMPONENT_INVENTORY_CHANGED');
      return true;
    });
  });
  it('distinguishes selection order from contiguity and refuses incomplete topology first', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children:
      ['a', 'b', 'c'].map(uuid => ({ uuid, name: 'Same' })) }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const lookup = (ids, flags) => tools.nodeGetPaths({ references: ids.map(id => ({ id })), ...flags });
    const reversed = await lookup(['b', 'a'], { requireContiguous: true });
    assert.deepEqual(reversed.siblingOrder.map(ref => ref.id), ['a', 'b']);
    await assert.rejects(() => lookup(['b', 'a'], { requireInputOrder: true }), error => {
      assert.equal(error.code, 'NODE_SELECTION_ORDER_CHANGED');
      assert.deepEqual(error.details.siblingOrder.map(ref => ref.id), ['a', 'b']);
      return true;
    });
    const gapped = await lookup(['a', 'c'], { requireInputOrder: true });
    assert.equal(gapped.siblingSpan.gapCount, 1);
    await assert.rejects(() => lookup(['c', 'a'], { requireInputOrder: true, requireContiguous: true }),
      error => error.code === 'NODE_SELECTION_NOT_CONTIGUOUS');
    await assert.rejects(() => lookup(['c', 'missing', 'a'], { requireInputOrder: true, requireContiguous: true }), error => {
      assert.equal(error.code, 'NODE_GROUP_INCOMPLETE');
      assert.equal(error.details.siblingOrder, null);
      assert.equal(error.details.selectedSubtreeNodeCount, null);
      assert.equal(error.details.items[1].error.status, 404);
      return true;
    });
  });
  it('preserves UUID topology when slash names collide with nested formatted paths', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [
      { uuid: 'flat', name: 'A/B' },
      { uuid: 'parent', name: 'A', children: [{ uuid: 'nested', name: 'B' }] },
    ] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const references = [{ id: 'flat' }, { id: 'nested' }];
    const observed = await tools.nodeGetPaths({ references });
    assert.deepEqual(observed.items.map(item => [item.result.reference.id, item.result.depth, item.result.pathUnique]),
      [['flat', 1, false], ['nested', 2, false]]);
    assert.equal(observed.items[0].result.path, observed.items[1].result.path);
    await assert.rejects(() => tools.nodeGetPath({ reference: references[0], requireUnique: true }),
      error => error.code === 'NODE_PATH_AMBIGUOUS');
    const guarded = await tools.nodeGetPaths({ references, requireUnique: true });
    assert.equal(guarded.failed, 2);
    assert.deepEqual(guarded.items.map(item => item.error.details.matchingNodeCount), [2, 2]);
    assert.equal(guarded.selectedSubtreeNodeCount, null);
  });
  it('requires exact component membership and prioritizes stale observations over removed identities', async () => {
    let components = [{ uuid: 'own', type: 'cc.Label' }];
    global.Editor = { Message: { request: async (_service, _message, id) => {
      if (id === 'unreadable') throw new Error('unavailable');
      return { uuid: id, __comps__: components };
    } } };
    const tools = new ComponentTools();
    const args = { reference: { id: 'node' }, componentReference: { id: 'own' } };
    const initial = await tools.nodeComponentsGet(args);
    assert.deepEqual(initial.references.map(ref => ref.id), ['own']);
    await assert.rejects(() => tools.nodeComponentsGet({ ...args, componentReference: { id: 'foreign' } }),
      error => error.code === 'COMPONENT_NOT_ATTACHED' && error.status === 404
        && error.details.nodeId === 'node' && error.details.componentId === 'foreign');
    components = [{ uuid: 'replacement', type: 'cc.Label' }];
    await assert.rejects(() => tools.nodeComponentsGet({ ...args, expectedRevision: initial.revision }),
      error => error.code === 'COMPONENT_INVENTORY_CHANGED');
    await assert.rejects(() => tools.nodeComponentsGet(args), error => error.code === 'COMPONENT_NOT_ATTACHED'
      && error.details.nodeId === 'node' && error.details.componentId === 'own');
    const batch = await tools.nodeComponentsBatchGet({ references: [{ id: 'unreadable' }, { id: 'node' }], componentTypes: ['Label'] });
    assert.equal(batch.items[0].ok, false);
    assert.equal('matchCount' in batch.items[0].error, false);
    assert.equal(batch.inventorySummary.unmatchedNodes, 0);
    assert.equal(batch.inventorySummary.matchedNodes, 1);
  });
  it('aggregates full class instances and node coverage independently of detail filters', async () => {
    const nodes = {
      a: [{ uuid: 'a1', type: 'cc.Label' }, { uuid: 'a2', type: 'cc.Label' }],
      b: [{ uuid: 'b1', type: 'cc.Label' }, { uuid: 'b2', type: 'Label' }],
    };
    global.Editor = { Message: { request: async (_service, _message, id) => {
      if (id === 'failed') throw new Error('unavailable');
      return { uuid: id, __comps__: nodes[id] };
    } } };
    const result = await new ComponentTools().nodeComponentsBatchGet({
      references: [{ id: 'a' }, { id: 'failed' }, { id: 'b' }], componentTypes: ['Button'], summaryOnly: true,
    });
    assert.deepEqual({ ...result.inventorySummary.classDistribution }, {
      'cc.Label': { instances: 3, nodes: 2 }, Label: { instances: 1, nodes: 1 },
    });
    assert.equal(result.inventorySummary.observedNodes, 2);
    assert.equal(result.inventorySummary.failedNodes, 1);
    assert.equal(result.inventorySummary.unmatchedNodes, 2);
    assert.equal(result.inventorySummary.matchedComponents, 0);
    assert.equal(result.inventorySummary.total, 4);
  });
  it('reports same-parent name collisions without conflating branches or unseen siblings', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [
      { uuid: 'left', name: 'Left', children: [
        { uuid: 'a', name: 'Item' }, { uuid: 'b', name: { value: 'Item' } }, { uuid: 'lower', name: 'item' },
      ] },
      { uuid: 'right', name: 'Right', children: [{ uuid: 'c', name: 'Item' }] },
    ] }) } };
    const tools = new SceneTools();
    const full = await tools.sceneHierarchyAnalyze({ limit: 10 });
    assert.deepEqual(full.siblingNameCollisions, [{ parentReference: { id: 'left', type: 'cc.Node' },
      name: 'Item', references: [{ id: 'a', type: 'cc.Node' }, { id: 'b', type: 'cc.Node' }] }]);
    const prefix = await tools.sceneHierarchyAnalyze({ limit: 3 });
    assert.equal(prefix.truncated, true);
    assert.deepEqual(prefix.siblingNameCollisions, []);
    const scoped = await tools.sceneHierarchyAnalyze({ rootReference: { id: 'right' }, limit: 10 });
    assert.equal(scoped.truncated, false);
    assert.deepEqual(scoped.siblingNameCollisions, []);
  });
  it('treats special JavaScript property names as component class data', async () => {
    const classes = ['__proto__', 'constructor', 'toString'];
    global.Editor = { Message: { request: async (_service, _message, id) => ({ uuid: id,
      __comps__: classes.map((type, index) => ({ uuid: `component-${index}`, type })),
    }) } };
    const tools = new ComponentTools();
    const references = [{ id: 'node' }];
    const observed = await tools.nodeComponentsBatchGet({ references, summaryOnly: true });
    for (const type of classes) assert.deepEqual(observed.inventorySummary.classDistribution[type], { instances: 1, nodes: 1 });
    const forbidden = await tools.nodeComponentsBatchGet({ references, forbiddenComponentTypes: classes });
    const counts = JSON.parse(JSON.stringify(forbidden.items[0].error.forbiddenComponentCounts));
    assert.deepEqual(Object.keys(counts).sort(), [...classes].sort());
    for (const type of classes) assert.equal(counts[type], 1);
    assert.equal(Object.hasOwn(counts, '__proto__'), true);
  });
  it('refuses duplicate component UUIDs beyond a requested page and preserves valid batch peers', async () => {
    global.Editor = { Message: { request: async (_service, _message, id) => ({ uuid: id, __comps__: id === 'broken' ? [
      { uuid: 'shared', type: 'cc.Label' }, { uuid: 'shared', type: 'cc.Button' },
    ] : [{ uuid: 'valid', type: 'cc.Label' }] }) } };
    const tools = new ComponentTools();
    await assert.rejects(() => tools.nodeComponentsGet({ reference: { id: 'broken' }, componentTypes: ['Label'], limit: 1 }), error => {
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.equal(error.status, 502);
      assert.deepEqual(error.details, { nodeId: 'broken', componentId: 'shared', firstComponentIndex: 0, componentIndex: 1 });
      return true;
    });
    const result = await tools.nodeComponentsBatchGet({ references: [{ id: 'broken' }, { id: 'healthy' }],
      componentTypes: ['Label'], limitPerNode: 1 });
    assert.equal(result.items[0].ok, false);
    assert.equal(result.items[0].error.code, 'INVALID_RESPONSE');
    assert.equal(result.items[0].error.status, 502);
    assert.deepEqual(result.items[0].error.details, { nodeId: 'broken', componentId: 'shared', firstComponentIndex: 0, componentIndex: 1 });
    assert.equal('revision' in result.items[0].error, false);
    assert.equal('inventorySummary' in result.items[0].error, false);
    assert.deepEqual(result.items[1].result.references.map(ref => ref.id), ['valid']);
    assert.equal(result.inventorySummary.observedNodes, 1);
    assert.equal(result.inventorySummary.total, 1);
  });
  it('continues normalized class selectors but refuses a changed filtered inventory contract', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'node', __comps__: [
      { uuid: 'label', type: 'cc.Label' }, { uuid: 'button', type: 'cc.Button' }, { uuid: 'sprite', type: 'cc.Sprite' },
    ] }) } };
    const tools = new ComponentTools();
    const reference = { id: 'node' };
    const first = await tools.nodeComponentsGet({ reference, componentTypes: ['cc.Label', 'Button'],
      excludeComponentTypes: ['Sprite'], limit: 1 });
    const next = await tools.nodeComponentsGet({ reference, componentTypes: ['cc.Button', 'Label', 'Label'],
      excludeComponentTypes: ['cc.Sprite', 'Sprite'], offset: 1, limit: 1, expectedRevision: first.revision });
    assert.deepEqual(next.references.map(ref => ref.id), ['button']);
    assert.equal(next.nextOffset, null);
    await assert.rejects(() => tools.nodeComponentsGet({ reference, componentTypes: ['Label'],
      excludeComponentTypes: ['Sprite'], expectedRevision: first.revision }),
      error => error.code === 'COMPONENT_INVENTORY_CHANGED');
  });
  it('refreshes subtree and sibling metadata after reparenting without rewriting old observations', async () => {
    const child = { uuid: 'child', name: 'Child' };
    const left = { uuid: 'left', name: 'Left', children: [child] };
    const right = { uuid: 'right', name: 'Right', children: [] };
    const tree = { uuid: 'root', name: 'Root', children: [left, right] };
    global.Editor = { Message: { request: async () => tree } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const args = { references: ['left', 'right', 'child'].map(id => ({ id })) };
    const before = await tools.nodeGetPaths(args);
    left.children = [];
    right.children = [child];
    tree.children.reverse();
    const after = await tools.nodeGetPaths(args);
    assert.deepEqual(after.items.map(item => item.result.descendantCount), [0, 1, 0]);
    assert.deepEqual(after.items.map(item => item.result.subtreeHeight), [0, 1, 0]);
    assert.equal(after.items[2].result.parentReference.id, 'right');
    assert.equal(after.items[0].result.previousSibling.id, 'right');
    assert.equal(after.items[1].result.nextSibling.id, 'left');
    assert.deepEqual(before.items.map(item => item.result.descendantCount), [1, 0, 0]);
    assert.equal(before.items[2].result.parentReference.id, 'left');
    assert.equal(before.items[0].result.nextSibling.id, 'right');
  });
  it('excludes existing out-of-scope UUIDs from selection coverage and complete footprints', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [
      { uuid: 'scope', name: 'Scope', children: [{ uuid: 'inside', name: 'Item' }] },
      { uuid: 'outside', name: 'Item' },
    ] }) } };
    const tools = new SceneTools();
    const args = { references: [{ id: 'inside' }, { id: 'outside' }], relativeTo: { id: 'scope' } };
    const result = await tools.nodeGetPaths(args);
    assert.equal(result.items[0].result.parentReference.id, 'scope');
    assert.equal(result.items[1].error.code, 'NOT_FOUND');
    assert.deepEqual(result.selectionRoots.map(ref => ref.id), ['inside']);
    assert.deepEqual(result.selectionCoverage.map(entry => entry.reference.id), ['inside']);
    assert.equal(result.selectedSubtreeNodeCount, null);
    await assert.rejects(() => tools.nodeGetPaths({ ...args, requireAll: true }),
      error => error.code === 'NODE_GROUP_INCOMPLETE' && error.details.items[1].error.status === 404);
    await assert.rejects(() => tools.nodeGetPath({ reference: { id: 'outside' }, relativeTo: { id: 'scope' } }),
      error => error.code === 'NOT_FOUND');
  });
  it('rejects repeated batch node identities before reading or double-counting inventories', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async (_service, _message, id) => {
      queries++;
      return { uuid: id, __comps__: [{ uuid: `${id}-label`, type: 'cc.Label' }] };
    } } };
    const tools = new ComponentTools();
    await assert.rejects(() => tools.nodeComponentsBatchGet({ references: [{ id: 'node' }, { id: 'node' }], summaryOnly: true }),
      error => error.code === 'INVALID_ARGUMENT');
    assert.equal(queries, 0);
    const distinct = await tools.nodeComponentsBatchGet({ references: [{ id: 'node' }, { id: 'other' }], summaryOnly: true });
    assert.deepEqual(distinct.inventorySummary.classDistribution['cc.Label'], { instances: 2, nodes: 2 });
    assert.equal(distinct.inventorySummary.observedNodes, 2);
    assert.equal(distinct.inventorySummary.total, 2);
  });
  it('combines exact parent search with subtree scope and exclusions without matching namesakes', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [
      { uuid: 'left', name: 'Container', children: [
        { uuid: 'left-item', name: 'Item', children: [{ uuid: 'nested', name: 'Item' }] },
        { uuid: 'excluded', name: 'Item' },
      ] },
      { uuid: 'right', name: 'Container', children: [{ uuid: 'right-item', name: 'Item' }] },
    ] }) } };
    const result = await new SceneTools().findNodes({ rootReference: { id: 'left' }, parentReference: { id: 'left' },
      excludeReferences: [{ id: 'excluded' }], name: 'Item', nameMatch: 'exact', requireSingle: true });
    assert.deepEqual(result.nodes.map(node => node.reference.id), ['left-item']);
    assert.equal(result.nodes[0].parentReference.id, 'left');
    assert.equal(result.nodes[0].depth, 1);
    await assert.rejects(() => new SceneTools().findNodes({ parentReference: { id: 'absent' }, name: 'Item' }),
      error => error.code === 'TARGET_NOT_FOUND');
  });
  it('does not mistake a one-row node result limit for a unique match', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [
      { uuid: 'left', name: 'Left', children: [{ uuid: 'a', name: 'Target' }] },
      { uuid: 'right', name: 'Right', children: [{ uuid: 'b', name: 'Target' }] },
    ] }) } };
    const tools = new SceneTools();
    const args = { name: 'Target', nameMatch: 'exact', maxResults: 1 };
    const limited = await tools.findNodes(args);
    assert.deepEqual(limited.nodes.map(node => node.reference.id), ['a']);
    assert.equal(limited.total, 2);
    assert.equal(limited.truncated, true);
    await assert.rejects(() => tools.findNodes({ ...args, requireSingle: true }),
      error => error.code === 'NODE_MATCH_AMBIGUOUS' && error.details.matchCount === 2);
    const unique = await tools.findNodes({ ...args, parentReference: { id: 'right' }, requireSingle: true });
    assert.deepEqual(unique.nodes.map(node => node.reference.id), ['b']);
    assert.equal(unique.total, 1);
    assert.equal(unique.truncated, false);
  });
  it('distinguishes all any and none component searches from instance counts and exclusions', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [
      { uuid: 'both', name: 'Both', components: [{ type: 'cc.Label' }, { type: 'cc.Button' }] },
      { uuid: 'labels', name: 'Labels', components: [{ type: 'Label' }, { type: 'cc.Label' }] },
      { uuid: 'empty', name: 'Empty' },
    ] }) } };
    const tools = new SceneTools();
    const args = { rootReference: { id: 'root' }, minDepth: 1, componentTypes: ['Label', 'cc.Button'] };
    const all = await tools.findNodes({ ...args, componentMatch: 'all' });
    assert.deepEqual(all.nodes.map(node => node.reference.id), ['both']);
    const any = await tools.findNodes({ ...args, componentMatch: 'any', excludeComponentTypes: ['Button'] });
    assert.deepEqual(any.nodes.map(node => node.reference.id), ['labels']);
    assert.equal(any.nodes[0].componentCount, 2);
    const none = await tools.findNodes({ ...args, componentMatch: 'none' });
    assert.deepEqual(none.nodes.map(node => node.reference.id), ['empty']);
  });
  it('distinguishes local activity from inherited inactivity and unknown ancestor state', async () => {
    const parent = { uuid: 'parent', name: 'Parent', active: false, children: [
      { uuid: 'child', name: 'Target', active: { value: true } },
    ] };
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', active: true, children: [parent] }) } };
    const tools = new SceneTools();
    const args = { name: 'Target', nameMatch: 'exact', rootReference: { id: 'parent' } };
    const local = await tools.findNodes({ ...args, active: true });
    assert.deepEqual(local.nodes.map(node => [node.reference.id, node.active, node.hierarchyActive]), [['child', true, false]]);
    assert.equal((await tools.findNodes({ ...args, hierarchyActive: true })).total, 0);
    assert.deepEqual((await tools.findNodes({ ...args, hierarchyActive: false })).nodes.map(node => node.reference.id), ['child']);
    delete parent.active;
    const unknown = await tools.findNodes({ ...args, active: true });
    assert.equal(unknown.nodes[0].hierarchyActive, null);
    await assert.rejects(() => tools.findNodes({ ...args, hierarchyActive: false }),
      error => error.code === 'NODE_STATE_UNAVAILABLE' && error.details.nodeId === 'child' && error.details.stateScope === 'hierarchy');
  });
  it('refuses class absence claims when an unknown component lies beyond the result prefix', async () => {
    const unknown = { uuid: 'unknown', name: 'Unknown', components: [{}] };
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [
      { uuid: 'empty', name: 'Empty' }, unknown,
    ] }) } };
    const tools = new SceneTools();
    const args = { rootReference: { id: 'root' }, minDepth: 1, maxResults: 1 };
    await assert.rejects(() => tools.findNodes({ ...args, componentTypes: ['Button'], componentMatch: 'none' }),
      error => error.code === 'INVALID_RESPONSE');
    await assert.rejects(() => tools.findNodes({ ...args, excludeComponentTypes: ['Button'] }),
      error => error.code === 'INVALID_RESPONSE');
    unknown.components = [{ type: 'cc.Button' }];
    const known = await tools.findNodes({ ...args, excludeComponentTypes: ['Button'] });
    assert.deepEqual(known.nodes.map(node => node.reference.id), ['empty']);
    assert.equal(known.total, 1);
    assert.equal(known.truncated, false);
  });
  it('searches direct children of multiple UUID parents once and refuses missing parents', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async (_service, message) => {
      if (message !== 'query-node-tree') return null;
      queries++;
      return { uuid: 'root', name: 'Root', children: [
        { uuid: 'left', name: 'Group', children: [{ uuid: 'a', name: 'Item', children: [{ uuid: 'nested', name: 'Item' }] }] },
        { uuid: 'right', name: 'Group', children: [{ uuid: 'b', name: 'Item' }] },
      ] };
    } } };
    const tools = new SceneTools();
    const parentReferences = [{ id: 'right' }, { id: 'left' }, { id: 'left' }];
    const result = await tools.findNodes({ parentReferences });
    assert.deepEqual(result.nodes.map(node => node.reference.id), ['a', 'b']);
    assert.equal(result.total, 2);
    assert.equal(queries, 1);
    const scoped = await tools.findNodes({ parentReferences, rootReference: { id: 'left' }, excludeReferences: [{ id: 'nested' }] });
    assert.deepEqual(scoped.nodes.map(node => node.reference.id), ['a']);
    await assert.rejects(() => tools.findNodes({ parentReferences: [{ id: 'left' }, { id: 'missing' }, { id: 'other-missing' }, { id: 'missing' }], maxResults: 1 }), error => {
      assert.equal(error.code, 'TARGET_NOT_FOUND');
      assert.deepEqual(error.details.missingParentIds, ['missing', 'other-missing']);
      return true;
    });
    const before = queries;
    await assert.rejects(() => tools.findNodes({ parentReference: { id: 'left' }, parentReferences }),
      error => error.code === 'INVALID_ARGUMENT');
    await assert.rejects(() => tools.findNodes({ parentReferences: [] }), error => error.code === 'INVALID_ARGUMENT');
    assert.equal(queries, before);
  });
  it('accepts32 empty parents but rejects an oversized parent selection before IPC', async () => {
    let queries = 0;
    const parents = Array.from({ length: 32 }, (_, index) => ({ uuid: `parent-${index}`, name: 'Parent' }));
    global.Editor = { Message: { request: async (_service, message) => {
      queries++;
      return message === 'query-node-tree' ? { uuid: 'root', name: 'Root', children: parents } : null;
    } } };
    const tools = new SceneTools();
    const parentReferences = parents.map(parent => ({ id: parent.uuid }));
    const empty = await tools.findNodes({ parentReferences });
    assert.deepEqual(empty.nodes, []);
    assert.equal(empty.total, 0);
    assert.equal(empty.truncated, false);
    const before = queries;
    await assert.rejects(() => tools.findNodes({ parentReferences: [...parentReferences, { id: 'extra' }] }),
      error => error.code === 'INVALID_ARGUMENT');
    assert.equal(queries, before);
  });
  it('matches exact name sets with case policy without duplicating hits or hiding ambiguity', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async (_service, message) => {
      queries++;
      return message === 'query-node-tree' ? { uuid: 'root', name: 'Root', children: [
        { uuid: 'title', name: 'Title' }, { uuid: 'icon', name: 'icon' }, { uuid: 'suffix', name: 'TitleExtra' },
      ] } : null;
    } } };
    const tools = new SceneTools();
    const args = { names: ['ICON', 'Title', 'title'], parentReference: { id: 'root' } };
    const result = await tools.findNodes(args);
    assert.deepEqual(result.nodes.map(node => node.reference.id), ['title', 'icon']);
    const sensitive = await tools.findNodes({ ...args, nameCaseSensitive: true });
    assert.deepEqual(sensitive.nodes.map(node => node.reference.id), ['title']);
    await assert.rejects(() => tools.findNodes({ ...args, maxResults: 1, requireSingle: true }),
      error => error.code === 'NODE_MATCH_AMBIGUOUS' && error.details.matchCount === 2);
    const before = queries;
    await assert.rejects(() => tools.findNodes({ names: ['Title'], name: 'Title' }), error => error.code === 'INVALID_ARGUMENT');
    await assert.rejects(() => tools.findNodes({ names: [] }), error => error.code === 'INVALID_ARGUMENT');
    assert.equal(queries, before);
  });
  it('keeps exact names literal and whitespace-sensitive while rejecting oversized sets before IPC', async () => {
    let queries = 0;
    const names = ['A.*', ' padded ', 'Axxx', 'padded'];
    global.Editor = { Message: { request: async (_service, message) => {
      queries++;
      return message === 'query-node-tree' ? { uuid: 'root', name: 'Root', children:
        names.map((name, index) => ({ uuid: `node-${index}`, name })) } : null;
    } } };
    const tools = new SceneTools();
    const result = await tools.findNodes({ names: ['A.*', ' padded '] });
    assert.deepEqual(result.nodes.map(node => node.reference.id), ['node-0', 'node-1']);
    const before = queries;
    await assert.rejects(() => tools.findNodes({ names: Array.from({ length: 33 }, (_, index) => `Name${index}`) }),
      error => error.code === 'INVALID_ARGUMENT');
    assert.equal(queries, before);
  });
  it('excludes exact names without pruning their descendants', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async (_service, message) => {
      queries++;
      return message === 'query-node-tree' ? { uuid: 'root', name: 'Root', children: [
        { uuid: 'debug', name: 'Debug', children: [{ uuid: 'child', name: 'Target' }] },
        { uuid: 'lower', name: 'debug' }, { uuid: 'suffix', name: 'DebugExtra' },
      ] } : null;
    } } };
    const tools = new SceneTools();
    const result = await tools.findNodes({ excludeNames: ['DEBUG'], minDepth: 1 });
    assert.deepEqual(result.nodes.map(node => node.reference.id), ['child', 'suffix']);
    const exactCase = await tools.findNodes({ excludeNames: ['Debug'], nameCaseSensitive: true, minDepth: 1 });
    assert.deepEqual(exactCase.nodes.map(node => node.reference.id), ['child', 'lower', 'suffix']);
    const before = queries;
    await assert.rejects(() => tools.findNodes({ excludeNames: [] }), error => error.code === 'INVALID_ARGUMENT');
    assert.equal(queries, before);
  });
  it('applies name exclusions before local-state and cardinality checks without skipping child state', async () => {
    const child = { uuid: 'child', name: 'Target', active: true };
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', active: true, children: [
      { uuid: 'debug', name: 'Debug', children: [child] },
    ] }) } };
    const tools = new SceneTools();
    const args = { excludeNames: ['Root', 'Debug'], active: true, requireSingle: true, maxResults: 1 };
    const result = await tools.findNodes(args);
    assert.deepEqual(result.nodes.map(node => node.reference.id), ['child']);
    assert.equal(result.total, 1);
    assert.equal(result.truncated, false);
    delete child.active;
    await assert.rejects(() => tools.findNodes(args), error => error.code === 'NODE_STATE_UNAVAILABLE');
  });
  it('preserves inherited activity through parents excluded by name', async () => {
    const parent = { uuid: 'debug', name: 'Debug', active: false, children: [
      { uuid: 'child', name: 'Target', active: true },
    ] };
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', active: true, children: [parent] }) } };
    const tools = new SceneTools();
    const args = { excludeNames: ['Root', 'Debug'], active: true };
    const inactive = await tools.findNodes({ ...args, hierarchyActive: false });
    assert.deepEqual(inactive.nodes.map(node => [node.reference.id, node.hierarchyActive]), [['child', false]]);
    assert.equal((await tools.findNodes({ ...args, hierarchyActive: true })).total, 0);
    delete parent.active;
    await assert.rejects(() => tools.findNodes({ ...args, hierarchyActive: false }),
      error => error.code === 'NODE_STATE_UNAVAILABLE');
    parent.active = true;
    const active = await tools.findNodes({ ...args, hierarchyActive: true });
    assert.deepEqual(active.nodes.map(node => node.reference.id), ['child']);
  });
  it('refuses duplicate node UUIDs beyond a search result prefix', async () => {
    global.Editor = { Message: { request: async (_service, message) => message === 'query-node-tree' ? {
      uuid: 'root', name: 'Root', children: [{ uuid: 'same', name: 'Target' }, { uuid: 'same', name: 'Other' }],
    } : null } };
    await assert.rejects(() => new SceneTools().findNodes({ name: 'Target', maxResults: 1 }),
      error => error.code === 'INVALID_RESPONSE' && error.details.nodeId === 'same'
        && error.details.firstPath === 'Root/Target' && error.details.path === 'Root/Other');
  });
  it('does not hide UUID conflicts behind excluded or out-of-scope branches', async () => {
    global.Editor = { Message: { request: async (_service, message) => message === 'query-node-tree' ? {
      uuid: 'root', name: 'Root', children: [
        { uuid: 'scope', name: 'Scope', children: [{ uuid: 'same', name: 'Target' }] },
        { uuid: 'hidden', name: 'Hidden', children: [{ uuid: 'same', name: 'Other' }] },
      ],
    } : null } };
    const tools = new SceneTools();
    await assert.rejects(() => tools.findNodes({ name: 'Target', rootReference: { id: 'scope' }, maxResults: 1 }),
      error => error.code === 'INVALID_RESPONSE' && error.status === 502);
    await assert.rejects(() => tools.findNodes({ name: 'Target', excludeReferences: [{ id: 'hidden' }], maxResults: 1 }),
      error => error.code === 'INVALID_RESPONSE' && error.status === 502);
  });
  it('requires local activity only on nodes that match the sibling selector', async () => {
    global.Editor = { Message: { request: async (_service, message) => message === 'query-node-tree' ? {
      uuid: 'root', name: 'Root', active: true, children: [
        { uuid: 'unknown', name: 'Item' }, { uuid: 'selected', name: 'Item', active: true },
        { uuid: 'disabled', name: 'Item', active: false }, { uuid: 'unknown-tail', name: 'Item' },
      ],
    } : null } };
    const tools = new SceneTools();
    const args = { parentReference: { id: 'root' }, active: true };
    const selected = await tools.findNodes({ ...args, siblingIndex: 1 });
    assert.deepEqual(selected.nodes.map(node => node.reference.id), ['selected']);
    await assert.rejects(() => tools.findNodes({ ...args, siblingIndex: 0 }),
      error => error.code === 'NODE_STATE_UNAVAILABLE' && error.details.nodeId === 'unknown' && error.details.path === 'Root/Item' && error.details.stateScope === 'local');
    const range = await tools.findNodes({ ...args, minSiblingIndex: 1, maxSiblingIndex: 2 });
    assert.deepEqual(range.nodes.map(node => [node.reference.id, node.siblingIndex]), [['selected', 1]]);
    const disabled = await tools.findNodes({ ...args, active: false, minSiblingIndex: 1, maxSiblingIndex: 2 });
    assert.deepEqual(disabled.nodes.map(node => node.reference.id), ['disabled']);
    await assert.rejects(() => tools.findNodes({ ...args, minSiblingIndex: 1, maxSiblingIndex: 3 }),
      error => error.code === 'NODE_STATE_UNAVAILABLE');
  });
  it('reports stale exclusion UUIDs without silently broadening a limited search', async () => {
    global.Editor = { Message: { request: async (_service, message) => message === 'query-node-tree' ? {
      uuid: 'root', name: 'Root', children: [{ uuid: 'target', name: 'Target' }, { uuid: 'present', name: 'Debug' }],
    } : null } };
    await assert.rejects(() => new SceneTools().findNodes({ name: 'Target', maxResults: 1,
      excludeReferences: [{ id: 'present' }, { id: 'missing-a' }, { id: 'missing-b' }, { id: 'missing-a' }] }), error => {
      assert.equal(error.code, 'TARGET_NOT_FOUND');
      assert.deepEqual(error.details.missingExcludedIds, ['missing-a', 'missing-b']);
      return true;
    });
  });
  it('excludes whole UUID subtrees including a selected search root without leaking sibling branches', async () => {
    global.Editor = { Message: { request: async (_service, message) => message === 'query-node-tree' ? {
      uuid: 'root', name: 'Root', children: [
        { uuid: 'scope', name: 'Scope', children: [
          { uuid: 'excluded', name: 'Target', children: [{ uuid: 'descendant', name: 'Target' }] },
          { uuid: 'kept', name: 'Target' },
        ] },
        { uuid: 'outside', name: 'Target' },
      ],
    } : null } };
    const tools = new SceneTools();
    const args = { rootReference: { id: 'scope' }, name: 'Target', nameMatch: 'exact' };
    const pruned = await tools.findNodes({ ...args, excludeReferences: [{ id: 'excluded' }] });
    assert.deepEqual(pruned.nodes.map(node => node.reference.id), ['kept']);
    assert.equal(pruned.total, 1);
    const empty = await tools.findNodes({ ...args, excludeReferences: [{ id: 'scope' }] });
    assert.deepEqual(empty.nodes, []);
    assert.equal(empty.total, 0);
    assert.equal(empty.truncated, false);
  });
  it('rejects foreign node dumps without leaking their components into batch coverage', async () => {
    global.Editor = { Message: { request: async (_service, _message, id) => ({
      uuid: { value: id === 'requested' ? 'foreign' : id },
      __comps__: [{ uuid: `${id}-label`, type: 'cc.Label' }],
    }) } };
    const tools = new ComponentTools();
    const result = await tools.nodeComponentsBatchGet({ references: [{ id: 'requested' }, { id: 'healthy' }] });
    assert.equal(result.items[0].ok, false);
    assert.equal(result.items[0].error.code, 'COMPONENT_NODE_IDENTITY_MISMATCH');
    assert.equal(result.items[0].error.status, 502);
    assert.deepEqual(result.items[0].error.identityMismatch, { requestedNodeId: 'requested', observedNodeId: 'foreign' });
    assert.equal('revision' in result.items[0].error, false);
    assert.equal('inventorySummary' in result.items[0].error, false);
    assert.deepEqual(result.items[1].result.references.map(ref => ref.id), ['healthy-label']);
    assert.equal(result.inventorySummary.observedNodes, 1);
    assert.equal(result.inventorySummary.failedNodes, 1);
    assert.deepEqual(result.inventorySummary.classDistribution['cc.Label'], { instances: 1, nodes: 1 });
  });
  it('retains the original off-page unknown-state identity in strict batch failures', async () => {
    global.Editor = { Message: { request: async (_service, _message, id) => ({ uuid: id, __comps__: id === 'broken' ? [
      { uuid: 'known', type: 'cc.Label', enabled: true },
      { uuid: 'unknown', type: 'cc.Button' },
    ] : [{ uuid: 'healthy-label', type: 'cc.Label', enabled: true }] }) } };
    const tools = new ComponentTools();
    await assert.rejects(() => tools.nodeComponentsGet({ reference: { id: 'broken' }, enabled: true, limit: 1 }), error => {
      assert.equal(error.code, 'COMPONENT_STATE_UNAVAILABLE');
      assert.deepEqual(error.details, { nodeId: 'broken', componentId: 'unknown', componentIndex: 1 });
      return true;
    });
    await assert.rejects(() => tools.nodeComponentsBatchGet({ references: [{ id: 'broken' }, { id: 'healthy' }],
      enabled: true, limitPerNode: 1, requireAll: true }), error => {
      assert.equal(error.code, 'COMPONENT_GROUP_INCOMPLETE');
      assert.deepEqual(error.details.items[0].error.stateIdentity,
        { nodeId: 'broken', componentId: 'unknown', componentIndex: 1 });
      assert.equal(error.details.items[0].error.status, 422);
      assert.equal(error.details.items[1].ok, true);
      assert.equal(error.details.inventorySummary.observedNodes, 1);
      return true;
    });
  });
  it('distinguishes absent nodes from transport failures without treating either as empty inventories', async () => {
    global.Editor = { Message: { request: async (_service, _message, id) => {
      if (id === 'missing') return null;
      if (id === 'transport') throw new Error('unavailable');
      return { uuid: id, __comps__: [] };
    } } };
    const tools = new ComponentTools();
    await assert.rejects(() => tools.nodeComponentsGet({ reference: { id: 'missing' } }),
      error => error.code === 'COMPONENT_NODE_NOT_FOUND' && error.status === 404 && error.details.nodeId === 'missing');
    const result = await tools.nodeComponentsBatchGet({ references: ['missing', 'transport', 'empty'].map(id => ({ id })) });
    assert.equal(result.items[0].error.code, 'COMPONENT_NODE_NOT_FOUND');
    assert.equal(result.items[0].error.status, 404);
    assert.equal(result.items[1].error.status, 500);
    assert.equal(result.items[2].ok, true);
    assert.equal(result.items[2].result.total, 0);
    assert.equal(result.inventorySummary.observedNodes, 1);
    assert.equal(result.inventorySummary.failedNodes, 2);
    assert.equal(result.inventorySummary.unmatchedNodes, 1);
  });
  it('rejects missing or malformed component arrays instead of claiming empty inventory', async () => {
    global.Editor = { Message: { request: async (_service, _message, id) => id === 'missing-array'
      ? { uuid: id } : { uuid: id, __comps__: id === 'malformed' ? {} : [] } } };
    const tools = new ComponentTools();
    const result = await tools.nodeComponentsBatchGet({ references: ['missing-array', 'malformed', 'empty'].map(id => ({ id })) });
    for (const item of result.items.slice(0, 2)) {
      assert.equal(item.error.code, 'INVALID_RESPONSE');
      assert.equal(item.error.status, 502);
      assert.equal('revision' in item.error, false);
      assert.equal('inventorySummary' in item.error, false);
    }
    assert.equal(result.items[2].ok, true);
    assert.equal(result.items[2].result.total, 0);
    assert.equal(result.inventorySummary.observedNodes, 1);
    assert.equal(result.inventorySummary.failedNodes, 2);
  });
  it('rejects malformed component owner UUIDs before IPC', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; return null; } } };
    const tools = new ComponentTools();
    for (const id of [42, {}, '   ', 'x'.repeat(257)]) {
      await assert.rejects(() => tools.nodeComponentsGet({ reference: { id } }),
        error => error.code === 'INVALID_ARGUMENT' && error.status === 400);
    }
    assert.equal(queries, 0);
  });
  it('retains mixed inspection evidence and valid peers in a strict batch failure', async () => {
    global.Editor = { Message: { request: async (_service, _message, id) => {
      if (id === 'missing') return null;
      if (id === 'foreign') return { uuid: 'other', __comps__: [] };
      if (id === 'malformed') return { uuid: id, __comps__: {} };
      return { uuid: id, __comps__: [{ uuid: 'valid-label', type: 'cc.Label' }] };
    } } };
    await assert.rejects(() => new ComponentTools().nodeComponentsBatchGet({
      references: ['missing', 'foreign', 'malformed', 'healthy'].map(id => ({ id })), requireAll: true,
    }), error => {
      assert.equal(error.code, 'COMPONENT_GROUP_INCOMPLETE');
      const [missing, foreign, malformed, healthy] = error.details.items;
      assert.deepEqual(missing.error.details, { nodeId: 'missing' });
      assert.equal(missing.error.status, 404);
      assert.deepEqual(foreign.error.details, { requestedNodeId: 'foreign', observedNodeId: 'other' });
      assert.deepEqual(malformed.error.details, { nodeId: 'malformed', field: '__comps__' });
      for (const item of [missing, foreign, malformed]) {
        assert.equal('revision' in item.error, false);
        assert.equal('inventorySummary' in item.error, false);
      }
      assert.deepEqual(healthy.result.references.map(ref => ref.id), ['valid-label']);
      assert.equal(error.details.inventorySummary.observedNodes, 1);
      assert.equal(error.details.inventorySummary.failedNodes, 3);
      assert.equal(error.details.inventorySummary.total, 1);
      return true;
    });
  });
  it('binds independent page offsets by UUID and isolates offsets beyond filtered totals', async () => {
    global.Editor = { Message: { request: async (_service, _message, id) => ({ uuid: id,
      __comps__: Array.from({ length: id === 'a' ? 3 : 1 }, (_, index) => ({ uuid: `${id}-${index}`, type: 'cc.Label' })),
    }) } };
    const tools = new ComponentTools();
    const args = { references: [{ id: 'b' }, { id: 'a' }], limitPerNode: 1,
      offsets: [{ reference: { id: 'a' }, offset: 1 }, { reference: { id: 'b' }, offset: 1 }] };
    const result = await tools.nodeComponentsBatchGet(args);
    assert.deepEqual(result.items[0].result.references, []);
    assert.equal(result.items[0].result.nextOffset, null);
    assert.deepEqual(result.items[1].result.references.map(ref => ref.id), ['a-1']);
    assert.equal(result.items[1].result.nextOffset, 2);
    assert.equal(result.inventorySummary.total, 4);
    assert.equal(result.inventorySummary.matchedNodes, 2);
    const invalid = await tools.nodeComponentsBatchGet({ ...args,
      offsets: [{ reference: { id: 'a' }, offset: 1 }, { reference: { id: 'b' }, offset: 2 }] });
    assert.equal(invalid.items[0].error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(invalid.items[0].error.details, { nodeId: 'b', offset: 2, matchCount: 1 });
    assert.deepEqual(invalid.items[1].result.references.map(ref => ref.id), ['a-1']);
    assert.equal(invalid.inventorySummary.observedNodes, 1);
    assert.equal(invalid.inventorySummary.total, 3);
  });
  it('classifies single-class no-match without changing multi-class empty results', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'node', __comps__: [{ uuid: 'label', type: 'cc.Label' }] }) } };
    const tools = new ComponentTools();
    const reference = { id: 'node' };
    await assert.rejects(() => tools.nodeComponentsGet({ reference, componentType: 'cc.Button' }), error => {
      assert.equal(error.code, 'COMPONENT_MATCH_NOT_FOUND');
      assert.equal(error.status, 404);
      assert.deepEqual(error.details, { nodeId: 'node', componentType: 'cc.Button', matchCount: 0 });
      return true;
    });
    const empty = await tools.nodeComponentsGet({ reference, componentTypes: ['cc.Button'] });
    assert.deepEqual(empty.references, []);
    assert.equal(empty.total, 0);
    assert.equal(empty.inventorySummary.total, 1);
  });
  it('accepts depth-only searches without weakening empty-selector or range validation', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async (_service, message) => {
      queries++;
      return message === 'query-node-tree' ? { uuid: 'root', name: 'Root', children: [
        { uuid: 'child', name: 'Child', children: [{ uuid: 'leaf', name: 'Leaf' }] },
      ] } : null;
    } } };
    const tools = new SceneTools();
    assert.deepEqual((await tools.findNodes({ maxDepth: 0 })).nodes.map(node => node.reference.id), ['root']);
    assert.deepEqual((await tools.findNodes({ minDepth: 1, maxDepth: 1 })).nodes.map(node => node.reference.id), ['child']);
    const before = queries;
    await assert.rejects(() => tools.findNodes({ minDepth: 2, maxDepth: 1 }), error => error.code === 'INVALID_ARGUMENT');
    await assert.rejects(() => tools.findNodes({}), error => error.code === 'INVALID_ARGUMENT');
    assert.equal(queries, before);
  });
  it('validates descendant identities even when depth-only output selects the root', async () => {
    const leaf = { uuid: 'duplicate', name: 'Leaf' };
    global.Editor = { Message: { request: async (_service, message) => message === 'query-node-tree' ? {
      uuid: 'root', name: 'Root', children: [
        { uuid: 'branch', name: 'Branch', children: [leaf] },
        { uuid: 'duplicate', name: 'Other' },
      ],
    } : null } };
    const tools = new SceneTools();
    await assert.rejects(() => tools.findNodes({ maxDepth: 0 }),
      error => error.code === 'INVALID_RESPONSE' && error.status === 502);
    leaf.uuid = 'unique-leaf';
    const result = await tools.findNodes({ maxDepth: 0 });
    assert.deepEqual(result.nodes.map(node => node.reference.id), ['root']);
    assert.equal(result.total, 1);
    assert.equal(result.truncated, false);
  });
  it('lists the remaining hierarchy with standalone subtree exclusions and refuses stale exclusions', async () => {
    global.Editor = { Message: { request: async (_service, message) => message === 'query-node-tree' ? {
      uuid: 'root', name: 'Root', children: [
        { uuid: 'debug', name: 'Debug', children: [{ uuid: 'hidden', name: 'Hidden' }] },
        { uuid: 'kept', name: 'Kept' },
      ],
    } : null } };
    const tools = new SceneTools();
    const result = await tools.findNodes({ excludeReferences: [{ id: 'debug' }] });
    assert.deepEqual(result.nodes.map(node => node.reference.id), ['root', 'kept']);
    assert.equal(result.total, 2);
    await assert.rejects(() => tools.findNodes({ excludeReferences: [{ id: 'stale' }] }),
      error => error.code === 'TARGET_NOT_FOUND' && error.details.missingExcludedIds[0] === 'stale');
  });
  it('preserves all32 selected nodes and rejects selection overflow before IPC', async () => {
    let queries = 0;
    const children = Array.from({ length: 32 }, (_, index) => ({ uuid: `node-${index}`, name: 'Same' }));
    global.Editor = { Message: { request: async () => { queries++; return { uuid: 'root', name: 'Root', children }; } } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const references = children.map(child => ({ id: child.uuid }));
    const result = await tools.nodeGetPaths({ references, requireContiguous: true, requireInputOrder: true });
    assert.equal(result.succeeded, 32);
    assert.equal(result.failed, 0);
    assert.equal(result.selectedSubtreeNodeCount, 32);
    assert.deepEqual(result.siblingBlocks[0].references.map(ref => ref.id), references.map(ref => ref.id));
    const before = queries;
    await assert.rejects(() => tools.nodeGetPaths({ references: [...references, { id: 'overflow' }] }),
      error => error.code === 'INVALID_ARGUMENT');
    assert.equal(queries, before);
  });
  it('reports inventory drift before pagination bounds when components disappear between pages', async () => {
    let components = Array.from({ length: 3 }, (_, index) => ({ uuid: `label-${index}`, type: 'cc.Label' }));
    global.Editor = { Message: { request: async () => ({ uuid: 'node', __comps__: components }) } };
    const tools = new ComponentTools();
    const reference = { id: 'node' };
    const first = await tools.nodeComponentsGet({ reference, limit: 2 });
    components = components.slice(0, 1);
    await assert.rejects(() => tools.nodeComponentsGet({ reference, offset: first.nextOffset, expectedRevision: first.revision }),
      error => error.code === 'COMPONENT_INVENTORY_CHANGED');
    await assert.rejects(() => tools.nodeComponentsGet({ reference, offset: first.nextOffset }), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(error.details, { nodeId: 'node', offset: 2, matchCount: 1 });
      return true;
    });
  });
  it('validates the full search node budget despite root-only output and a one-row cap', async () => {
    const children = Array.from({ length: 9999 }, (_, index) => ({ uuid: `child-${index}`, name: 'Child' }));
    global.Editor = { Message: { request: async (_service, message) => message === 'query-node-tree'
      ? { uuid: 'root', name: 'Root', children } : null } };
    const tools = new SceneTools();
    const args = { maxDepth: 0, maxResults: 1 };
    const exact = await tools.findNodes(args);
    assert.deepEqual(exact.nodes.map(node => node.reference.id), ['root']);
    assert.equal(exact.total, 1);
    assert.equal(exact.truncated, false);
    children.push({ uuid: 'overflow', name: 'Overflow' });
    await assert.rejects(() => tools.findNodes(args),
      error => error.code === 'RESULT_TOO_LARGE' && error.status === 413
        && error.details.scheduledNodes === 10001 && error.details.maximum === 10000);
  });
  it('refuses duplicate and foreign page offsets before reading any batch node', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async (_service, _message, id) => {
      queries++;
      return { uuid: id, __comps__: [{ uuid: `${id}-label`, type: 'cc.Label' }] };
    } } };
    const tools = new ComponentTools();
    const references = [{ id: 'a' }, { id: 'b' }];
    await assert.rejects(() => tools.nodeComponentsBatchGet({ references, offsets: [
      { reference: { id: 'a' }, offset: 0 }, { reference: { id: 'a' }, offset: 1 },
    ] }), error => error.code === 'INVALID_ARGUMENT' && error.status === 400);
    await assert.rejects(() => tools.nodeComponentsBatchGet({ references, offsets: [
      { reference: { id: 'foreign' }, offset: 0 },
    ] }), error => error.code === 'INVALID_ARGUMENT' && error.status === 400);
    assert.equal(queries, 0);
    const result = await tools.nodeComponentsBatchGet({ references, offsets: [{ reference: { id: 'a' }, offset: 1 }] });
    assert.deepEqual(result.items[0].result.references, []);
    assert.deepEqual(result.items[1].result.references.map(ref => ref.id), ['b-label']);
  });
  it('retains the missing search root UUID without broadening scope or reporting secondary absences', async () => {
    global.Editor = { Message: { request: async (_service, message) => message === 'query-node-tree'
      ? { uuid: 'scene', name: 'Scene', children: [{ uuid: 'visible', name: 'Candidate' }] } : null } };
    const tools = new SceneTools();
    await assert.rejects(() => tools.findNodes({ rootReference: { id: 'stale-root' }, name: 'Candidate',
      parentReference: { id: 'stale-parent' }, excludeReferences: [{ id: 'stale-exclusion' }], maxResults: 1 }), error => {
      assert.equal(error.code, 'TARGET_NOT_FOUND');
      assert.equal(error.status, 404);
      assert.deepEqual(error.details, { rootReference: { id: 'stale-root' } });
      return true;
    });
  });
  it('keeps exact path collisions ambiguous and applies path filters before unknown activity checks', async () => {
    const tree = { uuid: 'scene', name: 'Scene', children: [
      { uuid: 'literal', name: 'UI/Button', active: true },
      { uuid: 'ui', name: 'UI', children: [{ uuid: 'nested', name: 'Button', active: true }] },
      { uuid: 'other', name: 'ButtonExtra' },
    ] };
    global.Editor = { Message: { request: async () => tree } };
    const tools = new SceneTools();
    const args = { pathContains: 'SCENE/ui/button', pathMatch: 'exact', active: true };
    const result = await tools.findNodes({ ...args, maxResults: 1 });
    assert.equal(result.total, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.nodes[0].reference.id, 'literal');
    await assert.rejects(() => tools.findNodes({ ...args, requireSingle: true, maxResults: 1 }),
      error => error.code === 'NODE_MATCH_AMBIGUOUS' && error.details.matchCount === 2);
    await assert.rejects(() => tools.findNodes({ pathContains: 'Scene', pathMatch: 'regex' }),
      error => error.code === 'INVALID_ARGUMENT');
    await assert.rejects(() => tools.findNodes({ pathMatch: 'exact', name: 'Button' }),
      error => error.code === 'INVALID_ARGUMENT');
  });
  it('distinguishes path case without conflating name case or accepting duplicate exact paths', async () => {
    const children = [{ uuid: 'upper', name: 'Button' }, { uuid: 'lower', name: 'button' }];
    global.Editor = { Message: { request: async () => ({ uuid: 'scene', name: 'Scene', children }) } };
    const tools = new SceneTools();
    const args = { pathContains: 'Scene/Button', pathMatch: 'exact', pathCaseSensitive: true, name: 'button', nameMatch: 'exact' };
    assert.equal((await tools.findNodes({ ...args, requireSingle: true })).nodes[0].reference.id, 'upper');
    assert.equal((await tools.findNodes({ ...args, pathCaseSensitive: false })).total, 2);
    assert.equal((await tools.findNodes({ ...args, nameCaseSensitive: true })).total, 0);
    children.push({ uuid: 'duplicate', name: 'Button' });
    await assert.rejects(() => tools.findNodes({ ...args, requireSingle: true, maxResults: 1 }),
      error => error.code === 'NODE_MATCH_AMBIGUOUS' && error.details.matchCount === 2);
    await assert.rejects(() => tools.findNodes({ name: 'Button', pathCaseSensitive: true }), error => error.code === 'INVALID_ARGUMENT');
  });
  it('requires full filtered component presence without mistaking an empty terminal page for absence', async () => {
    let components = [{ uuid: 'first', type: 'cc.Label' }, { uuid: 'second', type: 'cc.Label' }];
    global.Editor = { Message: { request: async () => ({ uuid: 'node', __comps__: components }) } };
    const tools = new ComponentTools();
    const args = { reference: { id: 'node' }, componentTypes: ['cc.Label'], requireMatch: true };
    const first = await tools.nodeComponentsGet({ ...args, limit: 1 });
    assert.equal(first.total, 2);
    const terminal = await tools.nodeComponentsGet({ ...args, offset: 2, expectedRevision: first.revision });
    assert.equal(terminal.total, 2);
    assert.deepEqual(terminal.references, []);
    components = [];
    await assert.rejects(() => tools.nodeComponentsGet({ ...args, expectedRevision: first.revision }), error => error.code === 'COMPONENT_INVENTORY_CHANGED');
    await assert.rejects(() => tools.nodeComponentsGet(args), error => error.code === 'COMPONENT_MATCH_NOT_FOUND' && error.status === 404 && error.details.matchCount === 0);
    assert.deepEqual((await tools.nodeComponentsGet({ ...args, requireMatch: false })).references, []);
  });
  it('requires node group presence without imposing singleton cardinality or hiding stale scopes', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'scene', name: 'Scene', children: [
      { uuid: 'a', name: 'Button' }, { uuid: 'b', name: 'Button' },
    ] }) } };
    const tools = new SceneTools();
    const args = { name: 'Button', nameMatch: 'exact', requireMatch: true, maxResults: 1 };
    const result = await tools.findNodes(args);
    assert.equal(result.total, 2);
    assert.equal(result.truncated, true);
    await assert.rejects(() => tools.findNodes({ ...args, name: 'Missing' }),
      error => error.code === 'NODE_MATCH_NOT_FOUND' && error.status === 404 && error.details.matchCount === 0);
    await assert.rejects(() => tools.findNodes({ ...args, rootReference: { id: 'stale' } }),
      error => error.code === 'TARGET_NOT_FOUND' && error.details.rootReference.id === 'stale');
    await assert.rejects(() => tools.findNodes({ ...args, requireSingle: true }),
      error => error.code === 'NODE_MATCH_AMBIGUOUS' && error.details.matchCount === 2);
    assert.deepEqual((await tools.findNodes({ name: 'Missing' })).nodes, []);
  });
  it('omits only the scope root while preserving descendant depth and inherited activity', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'scene', name: 'Scene', active: true, children: [
      { uuid: 'ui', name: 'UI', active: false, children: [{ uuid: 'button', name: 'Button', active: true }] },
    ] }) } };
    const tools = new SceneTools();
    const args = { rootReference: { id: 'ui' }, includeRoot: false };
    const result = await tools.findNodes(args);
    assert.deepEqual(result.nodes.map(node => [node.reference.id, node.depth, node.hierarchyActive]), [['button', 1, false]]);
    assert.deepEqual((await tools.findNodes({ ...args, maxDepth: 0 })).nodes, []);
    assert.equal((await tools.findNodes({ ...args, hierarchyActive: false, requireSingle: true })).nodes[0].reference.id, 'button');
    assert.equal((await tools.findNodes({ rootReference: { id: 'ui' } })).total, 2);
  });
  it('refuses ambiguous script class registrations beyond the discovery cap instead of selecting the first class', async () => {
    let rows = [{ name: 'Controller', assetUuid: 'script' }, { name: 'Helper', assetUuid: 'script' }];
    global.Editor = { Message: { request: async () => rows } };
    const tools = new ComponentTools();
    const args = { scriptReference: { id: 'script' }, requireSingle: true, limit: 1 };
    await assert.rejects(() => tools.nodeGetAvailableComponentTypes(args),
      error => error.code === 'COMPONENT_CLASS_MATCH_AMBIGUOUS' && error.status === 409 && error.details.matchCount === 2);
    assert.deepEqual((await tools.nodeGetAvailableComponentTypes({ ...args, filter: 'controller' })).componentTypes, ['Controller']);
    rows = [];
    await assert.rejects(() => tools.nodeGetAvailableComponentTypes(args),
      error => error.code === 'COMPONENT_CLASS_MATCH_NOT_FOUND' && error.status === 404 && error.details.matchCount === 0);
  });
  it('resolves exact registry types without matching similarly named classes or display-name aliases', async () => {
    global.Editor = { Message: { request: async () => [
      { name: 'Display', type: 'Controller', assetUuid: 'script' },
      { name: 'Controller', type: 'ControllerHelper', assetUuid: 'script' },
    ] } };
    const tools = new ComponentTools();
    const args = { scriptReference: { id: 'script' }, filter: 'CONTROLLER', requireSingle: true };
    await assert.rejects(() => tools.nodeGetAvailableComponentTypes(args), error => error.code === 'COMPONENT_CLASS_MATCH_AMBIGUOUS');
    assert.deepEqual((await tools.nodeGetAvailableComponentTypes({ ...args, filterMatch: 'exact' })).componentTypes, ['Display']);
    await assert.rejects(() => tools.nodeGetAvailableComponentTypes({ ...args, filter: 'Display', filterMatch: 'exact' }), error => error.code === 'COMPONENT_CLASS_MATCH_NOT_FOUND');
  });
  it('distinguishes registry class case while retaining ambiguity for identical registrations', async () => {
    const rows = [{ name: 'Upper', type: 'Controller', assetUuid: 'script' }, { name: 'Lower', type: 'controller', assetUuid: 'script' }];
    global.Editor = { Message: { request: async () => rows } };
    const tools = new ComponentTools();
    const args = { filter: 'Controller', filterMatch: 'exact', requireSingle: true };
    await assert.rejects(() => tools.nodeGetAvailableComponentTypes(args), error => error.code === 'COMPONENT_CLASS_MATCH_AMBIGUOUS');
    assert.deepEqual((await tools.nodeGetAvailableComponentTypes({ ...args, filterCaseSensitive: true })).componentTypes, ['Upper']);
    rows.push({ name: 'Duplicate', type: 'Controller', assetUuid: 'script' });
    await assert.rejects(() => tools.nodeGetAvailableComponentTypes({ ...args, filterCaseSensitive: true, limit: 1 }),
      error => error.code === 'COMPONENT_CLASS_MATCH_AMBIGUOUS' && error.details.matchCount === 2);
  });
  it('counts summary matches beyond output caps without bypassing ambiguity or malformed descendants', async () => {
    const children = [{ uuid: 'a', name: 'Button' }, { uuid: 'b', name: 'Button' }];
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children }) } };
    const tools = new SceneTools();
    const args = { name: 'Button', summaryOnly: true, maxResults: 1 };
    assert.deepEqual(await tools.findNodes(args), { nodes: [], total: 2, truncated: true, detailsOmitted: true });
    await assert.rejects(() => tools.findNodes({ ...args, requireSingle: true }), error => error.code === 'NODE_MATCH_AMBIGUOUS' && error.details.matchCount === 2);
    assert.deepEqual(await tools.findNodes({ ...args, name: 'Missing' }), { nodes: [], total: 0, truncated: false, detailsOmitted: true });
    children.push({ uuid: 'a', name: 'OffFilter' });
    await assert.rejects(() => tools.findNodes(args), error => error.code === 'INVALID_RESPONSE');
  });
  it('matches only allowed component classes without counting aliases as extra components', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [
      { uuid: 'allowed', components: [{ type: 'cc.Label', cid: 'label-alias' }, { type: 'cc.Label' }] },
      { uuid: 'extra', components: [{ type: 'cc.Label' }, { type: 'cc.Button' }] },
      { uuid: 'empty', components: [] },
    ] }) } };
    const tools = new SceneTools();
    const args = { componentTypes: ['Label'], componentMatch: 'only' };
    assert.deepEqual((await tools.findNodes(args)).nodes.map(node => node.reference.id), ['allowed']);
    assert.deepEqual((await tools.findNodes({ ...args, componentTypes: ['Label', 'Button'] })).nodes.map(node => node.reference.id), ['extra']);
    assert.equal((await tools.findNodes({ ...args, maxComponents: 1 })).total, 0);
  });
  it('checks full batch inventory bounds despite filtered pages while retaining valid peers', async () => {
    global.Editor = { Message: { request: async (_service, _message, id) => ({ uuid: id, __comps__: id === 'large'
      ? [{ uuid: 'label', type: 'cc.Label' }, { uuid: 'button', type: 'cc.Button' }]
      : [{ uuid: 'peer-label', type: 'cc.Label' }] }) } };
    const tools = new ComponentTools();
    const result = await tools.nodeComponentsBatchGet({ references: [{ id: 'large' }, { id: 'peer' }], componentTypes: ['Label'], maxComponents: 1, limitPerNode: 1 });
    assert.equal(result.failed, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(result.items[0].error.code, 'COMPONENT_COUNT_OUT_OF_RANGE');
    assert.deepEqual(result.items[0].error.details, { nodeId: 'large', componentCount: 2, maxComponents: 1 });
    assert.equal(result.items[0].error.inventorySummary.total, 2);
    assert.equal(result.items[1].result.references[0].id, 'peer-label');
  });
  it('checks singleton classes across full inventories despite detail exclusions and preserves peers', async () => {
    global.Editor = { Message: { request: async (_service, _message, id) => ({ uuid: id, __comps__: id === 'dup'
      ? [{ uuid: 'a', type: 'cc.Button' }, { uuid: 'b', type: 'Button' }]
      : [] }) } };
    const tools = new ComponentTools();
    const args = { references: [{ id: 'dup' }, { id: 'empty' }], singletonComponentTypes: ['cc.Button', 'Button'], excludeComponentTypes: ['Button'], summaryOnly: true };
    const result = await tools.nodeComponentsBatchGet(args);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.items[0].error.code, 'COMPONENT_SINGLETON_VIOLATION');
    assert.deepEqual(result.items[0].error.details.duplicateComponentCounts, { Button: 2 });
    assert.equal(result.items[0].error.inventorySummary.total, 2);
    await assert.rejects(() => tools.nodeComponentsBatchGet({ ...args, requireAll: true }),
      error => error.code === 'COMPONENT_GROUP_INCOMPLETE' && error.details.items[0].error.code === 'COMPONENT_SINGLETON_VIOLATION');
  });
  it('retains singleton duplicates beside missing and forbidden composition findings', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'node', __comps__: [
      { uuid: 'a', type: 'cc.Button' }, { uuid: 'b', type: 'Button' },
    ] }) } };
    const tools = new ComponentTools();
    const args = { references: [{ id: 'node' }], requiredComponentTypes: ['Label'], forbiddenComponentTypes: ['Button'], singletonComponentTypes: ['Button'], maxComponents: 1, summaryOnly: true };
    const result = await tools.nodeComponentsBatchGet(args);
    const error = result.items[0].error;
    assert.equal(error.code, 'COMPONENT_COMPOSITION_INCOMPLETE');
    assert.deepEqual(error.missingComponentTypes, ['Label']);
    assert.deepEqual(error.forbiddenComponentCounts, { Button: 2 });
    assert.deepEqual(error.duplicateComponentCounts, { Button: 2 });
    assert.deepEqual(error.componentCountViolation, { componentCount: 2, maxComponents: 1 });
    await assert.rejects(() => tools.nodeComponentsBatchGet({ ...args, requireAll: true }),
      failure => failure.details.items[0].error.duplicateComponentCounts.Button === 2 && failure.details.items[0].error.componentCountViolation.componentCount === 2);
  });
  it('detects unexpected classes outside detail filters and refuses contradictory allowlists before IPC', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async (_service, _message, id) => {
      queries++;
      return { uuid: id, __comps__: id === 'extra' ? [{ uuid: 'a', type: 'cc.Label' }, { uuid: 'b', type: 'cc.Button' }] : [] };
    } } };
    const tools = new ComponentTools();
    await assert.rejects(() => tools.nodeComponentsBatchGet({ references: [{ id: 'extra' }], allowedComponentTypes: ['Label'], requiredComponentTypes: ['Button'] }), error => error.code === 'INVALID_ARGUMENT');
    assert.equal(queries, 0);
    const result = await tools.nodeComponentsBatchGet({ references: [{ id: 'extra' }, { id: 'empty' }], allowedComponentTypes: ['Label'], componentTypes: ['Label'], summaryOnly: true });
    assert.equal(result.succeeded, 1);
    assert.equal(result.items[0].error.code, 'COMPONENT_COMPOSITION_UNEXPECTED');
    assert.deepEqual(result.items[0].error.unexpectedComponentCounts, { Button: 1 });
    assert.equal(result.items[0].error.inventorySummary.total, 2);
    assert.equal((await tools.nodeComponentsBatchGet({ references: [{ id: 'empty' }], allowedComponentTypes: [] })).succeeded, 1);
  });
  it('allows incomplete and empty class subsets but refuses outside classes and unknown identities', async () => {
    const children = [
      { uuid: 'empty', components: [] },
      { uuid: 'partial', components: [{ type: 'cc.Label', cid: 'alias' }] },
      { uuid: 'extra', components: [{ type: 'cc.Button' }] },
    ];
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children }) } };
    const tools = new SceneTools();
    const args = { componentTypes: ['Label', 'UITransform'], componentMatch: 'subset', includeRoot: false, minDepth: 1 };
    assert.deepEqual((await tools.findNodes(args)).nodes.map(node => node.reference.id), ['empty', 'partial']);
    assert.deepEqual((await tools.findNodes({ ...args, minComponents: 1 })).nodes.map(node => node.reference.id), ['partial']);
    assert.equal((await tools.findNodes({ ...args, componentMatch: 'only' })).total, 0);
    children.push({ uuid: 'unknown', components: [{}] });
    await assert.rejects(() => tools.findNodes({ ...args, summaryOnly: true }), error => error.code === 'INVALID_RESPONSE');
  });
  it('filters exact UUID selections without selecting namesakes or hiding absent IDs behind caps', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [
      { uuid: 'a', name: 'Same', active: true }, { uuid: 'b', name: 'Same', active: false },
    ] }) } };
    const tools = new SceneTools();
    assert.deepEqual((await tools.findNodes({ references: [{ id: 'b' }, { id: 'b' }], name: 'Same' })).nodes.map(node => node.reference.id), ['b']);
    assert.equal((await tools.findNodes({ references: [{ id: 'b' }], active: true })).total, 0);
    await assert.rejects(() => tools.findNodes({ references: [{ id: 'a' }, { id: 'missing' }], maxResults: 1 }),
      error => error.code === 'TARGET_NOT_FOUND' && error.details.missingReferenceIds[0] === 'missing');
  });
  it('requires every selected UUID to match independently of caps and preserves missing identity precedence', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children: [
      { uuid: 'a', active: true }, { uuid: 'b', active: false },
    ] }) } };
    const tools = new SceneTools();
    const args = { references: [{ id: 'b' }, { id: 'a' }, { id: 'b' }], requireAllReferences: true, maxResults: 1 };
    assert.equal((await tools.findNodes(args)).total, 2);
    await assert.rejects(() => tools.findNodes({ ...args, active: true, summaryOnly: true }), error => {
      assert.equal(error.code, 'NODE_SELECTION_INCOMPLETE');
      assert.deepEqual(error.details, { unmatchedReferenceIds: ['b'], selectedCount: 2, matchCount: 1 });
      return true;
    });
    await assert.rejects(() => tools.findNodes({ ...args, references: [{ id: 'missing' }], active: true }), error => error.code === 'TARGET_NOT_FOUND');
  });
  it('accepts equal-depth targets across branches but refuses mixed depths and incomplete groups', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [
      { uuid: 'left', name: 'Left', children: [{ uuid: 'a', name: 'Slash/Name' }] },
      { uuid: 'right', name: 'Right', children: [{ uuid: 'b', name: 'B' }] },
    ] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const result = await tools.nodeGetPaths({ references: [{ id: 'a' }, { id: 'b' }], requireSameDepth: true });
    assert.equal(result.sharedParent, null);
    assert.deepEqual(result.selectionDepthRange, { min: 2, max: 2 });
    await assert.rejects(() => tools.nodeGetPaths({ references: [{ id: 'left' }, { id: 'a' }], requireSameDepth: true }),
      error => error.code === 'NODE_DEPTH_GROUP_MISMATCH' && error.details.selectionDepthRange.min === 1 && error.details.selectionDepthRange.max === 2);
    await assert.rejects(() => tools.nodeGetPaths({ references: [{ id: 'a' }, { id: 'missing' }], requireSameDepth: true }),
      error => error.code === 'NODE_GROUP_INCOMPLETE' && error.details.selectionDepthRange === null);
  });
  it('withholds whole-selection depth evidence after path drift while retaining unchanged peers', async () => {
    const renamed = { uuid: 'a', name: 'Before' };
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [renamed, { uuid: 'b', name: 'Peer' }] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const references = [{ id: 'a' }, { id: 'b' }];
    const first = await tools.nodeGetPaths({ references });
    assert.deepEqual({ ...first.selectionDepthCounts }, { 1: 2 });
    const expectedPaths = first.items.map(item => ({ reference: item.reference, path: item.result.path }));
    renamed.name = 'After';
    const args = { references, expectedPaths, requirePaths: true };
    const stale = await tools.nodeGetPaths(args);
    assert.equal(stale.items[0].error.code, 'NODE_PATH_CHANGED');
    assert.equal(stale.items[1].result.reference.id, 'b');
    assert.equal(stale.selectionDepthCounts, null);
    assert.equal(stale.selectionDepthRange, null);
    assert.equal(stale.selectedSubtreeNodeCount, null);
    assert.equal(stale.errorCounts.NODE_PATH_CHANGED, 1);
    await assert.rejects(() => tools.nodeGetPaths({ ...args, requireSameDepth: true }),
      error => error.code === 'NODE_GROUP_INCOMPLETE' && error.details.selectionDepthCounts === null);
  });
  it('rejects repeated UUIDs before IPC without forbidding distinct ancestor and descendant targets', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; return { uuid: 'root', name: 'Root', children: [{ uuid: 'child', name: 'Child' }] }; } } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    await assert.rejects(() => tools.nodeGetPaths({ references: [{ id: 'root' }, { id: 'root' }], requireDistinct: true }), error => error.code === 'NODE_SELECTION_OVERLAP');
    assert.equal(queries, 0);
    const result = await tools.nodeGetPaths({ references: [{ id: 'root' }, { id: 'child' }], requireDistinct: true });
    assert.equal(result.succeeded, 2);
    assert.deepEqual(result.selectionRoots.map(ref => ref.id), ['root']);
  });
  it('requires selected subtree descendants without double-counting overlapping roots or duplicate inputs', async () => {
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children: [{ uuid: 'parent', children: [{ uuid: 'child', children: [{ uuid: 'leaf' }] }] }] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const run = ids => tools.nodeGetPaths({ references: ids.map(id => ({ id })), requireCompleteSubtrees: true });
    await assert.rejects(() => run(['parent', 'child', 'child']), error => error.code === 'NODE_SUBTREE_COVERAGE_INCOMPLETE' && error.details.selectedSubtreeNodeCount === 3);
    assert.equal((await run(['parent', 'child', 'leaf', 'leaf'])).succeeded, 4);
    assert.equal((await run(['leaf'])).selectedSubtreeNodeCount, 1);
    await assert.rejects(() => run(['leaf', 'missing']), error => error.code === 'NODE_GROUP_INCOMPLETE');
  });
  it('composes UUID discovery with guarded topology and inventory refresh without accepting stale peers', async () => {
    const firstNode = { uuid: 'a', name: 'Button', components: [{ type: 'cc.Button' }] };
    const secondNode = { uuid: 'b', name: 'Button', components: [{ type: 'cc.Button' }] };
    const tree = { uuid: 'root', name: 'Root', children: [firstNode, secondNode] };
    const inventories = { a: [{ uuid: 'a-button', type: 'cc.Button' }], b: [{ uuid: 'b-button', type: 'cc.Button' }] };
    global.Editor = { Message: { request: async (_service, message, id) => {
      if (message === 'query-node-tree') return tree;
      if (message === 'query-node') return { uuid: id, __comps__: inventories[id] };
      throw new Error(`unexpected ${message}`);
    } } };
    const scene = new SceneTools();
    scene.findPrefabEditRoot = async () => null;
    const components = new ComponentTools();
    const references = (await scene.findNodes({ componentType: 'cc.Button' })).nodes.map(node => node.reference);
    const paths = await scene.nodeGetPaths({ references, requireCompleteSiblings: true });
    const expectedPaths = paths.items.map(item => ({ reference: item.reference, path: item.result.path }));
    const inventory = await components.nodeComponentsBatchGet({ references, singletonComponentTypes: ['Button'] });
    const expectedRevisions = inventory.items.map(item => ({ reference: item.reference, revision: item.result.revision }));
    firstNode.name = 'Renamed';
    await assert.rejects(() => scene.nodeGetPaths({ references, expectedPaths, requirePaths: true, requireAll: true }),
      error => error.code === 'NODE_GROUP_INCOMPLETE' && error.details.errorCounts.NODE_PATH_CHANGED === 1);
    inventories.a.push({ uuid: 'a-second', type: 'cc.Button' });
    const refreshed = await components.nodeComponentsBatchGet({ references, expectedRevisions, requireRevisions: true, singletonComponentTypes: ['Button'] });
    assert.equal(refreshed.items[0].error.code, 'COMPONENT_INVENTORY_CHANGED');
    assert.equal(refreshed.items[0].error.duplicateComponentCounts, undefined);
    assert.equal(refreshed.items[1].result.references[0].id, 'b-button');
    const fresh = await components.nodeComponentsBatchGet({ references, singletonComponentTypes: ['Button'] });
    assert.equal(fresh.items[0].error.code, 'COMPONENT_SINGLETON_VIOLATION');
    assert.deepEqual(fresh.items[0].error.duplicateComponentCounts, { Button: 2 });
  });
  it('reports every duplicate selection position without reading the hierarchy', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; throw new Error('unexpected query'); } } };
    const tools = new SceneTools();
    for (const flag of ['requireDistinct', 'requireDisjoint', 'requireContiguous', 'requireInputOrder']) await assert.rejects(() => tools.nodeGetPaths({ references: ['b', 'a', 'b', 'b', 'a'].map(id => ({ id })), [flag]: true }), error => {
      assert.equal(error.code, 'NODE_SELECTION_OVERLAP');
      assert.deepEqual(error.details.duplicates, [
        { reference: { id: 'b' }, indices: [0, 2, 3] },
        { reference: { id: 'a' }, indices: [1, 4] },
      ]);
      return true;
    });
    assert.equal(queries, 0);
  });
  it('matches subtree coverage to an independent descendant union for every branching selection', async () => {
    const children = { root: ['left', 'right'], left: ['leaf-a', 'leaf-b'], right: ['leaf-c'], 'leaf-a': [], 'leaf-b': [], 'leaf-c': [] };
    const ids = Object.keys(children);
    const build = id => ({ uuid: id, name: id, children: children[id].map(build) });
    global.Editor = { Message: { request: async () => build('root') } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    for (let mask = 1; mask < 1 << ids.length; mask++) {
      const selected = ids.filter((_id, index) => mask & 1 << index);
      const union = new Set();
      const visit = id => { if (union.has(id)) return; union.add(id); children[id].forEach(visit); };
      selected.forEach(visit);
      const references = [...selected, selected[0]].map(id => ({ id }));
      const result = await tools.nodeGetPaths({ references });
      assert.deepEqual(result.subtreeSelectionCoverage, {
        selectedCount: selected.length, subtreeNodeCount: union.size,
        unselectedCount: union.size - selected.length, complete: union.size === selected.length,
      });
      if (union.size === selected.length) assert.equal((await tools.nodeGetPaths({ references, requireCompleteSubtrees: true })).failed, 0);
      else await assert.rejects(() => tools.nodeGetPaths({ references, requireCompleteSubtrees: true }), error => error.code === 'NODE_SUBTREE_COVERAGE_INCOMPLETE');
    }
  });
  it('requires complete sibling coverage independently for every represented parent', async () => {
    const children = { root: ['left', 'right'], left: ['a', 'b'], right: ['c'], a: [], b: [], c: [] };
    const parents = new Map(Object.entries(children).flatMap(([parent, ids]) => ids.map(id => [id, parent])));
    const ids = Object.keys(children);
    const build = id => ({ uuid: id, children: children[id].map(build) });
    global.Editor = { Message: { request: async () => build('root') } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    for (let mask = 1; mask < 1 << ids.length; mask++) {
      const selected = new Set(ids.filter((_id, index) => mask & 1 << index));
      const references = [...selected, [...selected][0]].map(id => ({ id }));
      const complete = [...selected].every(id => parents.has(id) && children[parents.get(id)].every(sibling => selected.has(sibling)));
      const result = await tools.nodeGetPaths({ references });
      assert.equal(result.selectionParentCounts.every(group => group.complete === true), complete);
      if (complete) assert.equal((await tools.nodeGetPaths({ references, requireCompleteSiblings: true })).failed, 0);
      else await assert.rejects(() => tools.nodeGetPaths({ references, requireCompleteSiblings: true }), error => error.code === 'NODE_SIBLING_COVERAGE_INCOMPLETE');
    }
  });
  it('detects same-path reparenting and refreshes parent group members without rewriting prior observations', async () => {
    const moved = { uuid: 'moved', name: 'Child' };
    const peer = { uuid: 'peer', name: 'Peer' };
    const left = { uuid: 'left', name: 'Same', children: [moved] };
    const right = { uuid: 'right', name: 'Same', children: [peer] };
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [left, right] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const references = [{ id: 'moved' }, { id: 'peer' }];
    const before = await tools.nodeGetPaths({ references });
    const expectedPaths = before.items.map(item => ({ reference: item.reference, path: item.result.path }));
    const expectedAncestors = before.items.map(item => ({ reference: item.reference, ancestors: item.result.ancestors }));
    left.children = [];
    right.children = [moved, peer];
    const stale = await tools.nodeGetPaths({ references, expectedPaths, expectedAncestors, requireAncestors: true });
    assert.equal(stale.items[0].error.code, 'NODE_ANCESTRY_CHANGED');
    assert.equal(stale.items[1].result.reference.id, 'peer');
    assert.equal(stale.selectionParentCounts, null);
    const fresh = await tools.nodeGetPaths({ references, expectedPaths, requirePaths: true });
    assert.equal(fresh.items[0].result.path, before.items[0].result.path);
    assert.deepEqual(fresh.selectionParentCounts.map(group => [group.parentReference.id, group.references.map(ref => ref.id), group.complete]), [['right', ['moved', 'peer'], true]]);
    assert.deepEqual(before.selectionParentCounts.map(group => [group.parentReference.id, group.references.map(ref => ref.id), group.siblingCount]), [['left', ['moved'], 1], ['right', ['peer'], 1]]);
  });
  it('identifies unguarded UUIDs without mistaking an empty expected path for missing coverage', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; throw new Error('unexpected query'); } } };
    const tools = new SceneTools();
    await assert.rejects(() => tools.nodeGetPaths({
      references: ['b', 'a', 'b', 'c'].map(id => ({ id })), requirePaths: true,
      expectedPaths: [{ reference: { id: 'a' }, path: '' }],
    }), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(error.details, { missingPathGuardIds: ['b', 'c'] });
      return true;
    });
    assert.equal(queries, 0);
  });
  it('identifies missing component revision baselines by requested UUID before any node read', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; throw new Error('unexpected query'); } } };
    await assert.rejects(() => new ComponentTools().nodeComponentsBatchGet({
      references: ['b', 'a', 'c'].map(id => ({ id })), requireRevisions: true,
      expectedRevisions: [{ reference: { id: 'a' }, revision: '0'.repeat(64) }],
    }), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(error.details, { missingRevisionGuardIds: ['b', 'c'] });
      return true;
    });
    assert.equal(queries, 0);
  });
  it('identifies duplicate component batch request positions before reading inventories', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; throw new Error('unexpected query'); } } };
    await assert.rejects(() => new ComponentTools().nodeComponentsBatchGet({ references: ['b', 'a', 'b', 'b', 'a'].map(id => ({ id })) }), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(error.status, 400);
      assert.deepEqual(error.details.duplicates, [
        { reference: { id: 'b' }, indices: [0, 2, 3] },
        { reference: { id: 'a' }, indices: [1, 4] },
      ]);
      return true;
    });
    assert.equal(queries, 0);
  });
  it('detects sibling count drift when target path ancestry and index remain unchanged', async () => {
    const children = [{ uuid: 'target', name: 'Target' }];
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const first = await tools.nodeGetPath({ reference: { id: 'target' } });
    const args = { reference: { id: 'target' }, expectedPath: first.path, expectedAncestors: first.ancestors, expectedSiblingIndex: first.siblingIndex, expectedSiblingCount: first.siblingCount };
    children.push({ uuid: 'new', name: 'New' });
    await assert.rejects(() => tools.nodeGetPath(args), error => {
      assert.equal(error.code, 'NODE_SIBLING_COUNT_CHANGED');
      assert.deepEqual(error.details, { nodeId: 'target', expectedSiblingCount: 1, siblingCount: 2 });
      return true;
    });
    assert.equal((await tools.nodeGetPath({ ...args, expectedSiblingCount: 2 })).siblingIndex, 0);
    assert.equal((await tools.nodeGetPath({ reference: { id: 'root' }, expectedSiblingCount: null })).siblingCount, null);
  });
  it('isolates batch sibling count drift by UUID and withholds whole-selection projections', async () => {
    const left = { uuid: 'left', children: [{ uuid: 'a' }] };
    const right = { uuid: 'right', children: [{ uuid: 'b' }] };
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children: [left, right] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const references = [{ id: 'a' }, { id: 'b' }];
    const first = await tools.nodeGetPaths({ references });
    const expectedSiblingCounts = first.items.map(item => ({ reference: item.reference, siblingCount: item.result.siblingCount })).reverse();
    left.children.push({ uuid: 'new' });
    const args = { references, expectedSiblingCounts };
    const result = await tools.nodeGetPaths(args);
    assert.equal(result.items[0].error.code, 'NODE_SIBLING_COUNT_CHANGED');
    assert.deepEqual(result.items[0].error.details, { nodeId: 'a', expectedSiblingCount: 1, siblingCount: 2 });
    assert.equal(result.items[1].result.reference.id, 'b');
    assert.equal(result.selectionParentCounts, null);
    assert.equal(result.errorCounts.NODE_SIBLING_COUNT_CHANGED, 1);
    await assert.rejects(() => tools.nodeGetPaths({ ...args, requireAll: true }), error => error.code === 'NODE_GROUP_INCOMPLETE' && error.details.failed === 1);
  });
  it('requires UUID-bound sibling count coverage without treating null as an absent guard', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; return { uuid: 'root', children: [{ uuid: 'child' }] }; } } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    await assert.rejects(() => tools.nodeGetPaths({ references: ['child', 'root', 'child'].map(id => ({ id })), requireSiblingCounts: true, expectedSiblingCounts: [{ reference: { id: 'root' }, siblingCount: null }] }), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(error.details, { missingSiblingCountGuardIds: ['child'] });
      return true;
    });
    assert.equal(queries, 0);
    const result = await tools.nodeGetPaths({ references: [{ id: 'root' }, { id: 'child' }], requireSiblingCounts: true, expectedSiblingCounts: [{ reference: { id: 'root' }, siblingCount: null }, { reference: { id: 'child' }, siblingCount: 1 }] });
    assert.equal(result.failed, 0);
  });
  it('detects removed siblings but does not claim count guards identify same-count replacements', async () => {
    const children = [{ uuid: 'target', name: 'Target' }, { uuid: 'old', name: 'Sibling' }];
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const first = await tools.nodeGetPath({ reference: { id: 'target' } });
    const args = { reference: first.reference, expectedPath: first.path, expectedAncestors: first.ancestors, expectedSiblingIndex: first.siblingIndex, expectedSiblingCount: first.siblingCount };
    children[1] = { uuid: 'replacement', name: 'Sibling' };
    const replaced = await tools.nodeGetPath(args);
    assert.equal(replaced.nextSibling.id, 'replacement');
    assert.equal(first.nextSibling.id, 'old');
    children.pop();
    await assert.rejects(() => tools.nodeGetPath(args), error => {
      assert.equal(error.code, 'NODE_SIBLING_COUNT_CHANGED');
      assert.deepEqual(error.details, { nodeId: 'target', expectedSiblingCount: 2, siblingCount: 1 });
      return true;
    });
  });
  it('detects same-count next sibling replacement and validates explicit no-next baselines', async () => {
    const children = [{ uuid: 'target' }, { uuid: 'old' }];
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const first = await tools.nodeGetPath({ reference: { id: 'target' } });
    children[1] = { uuid: 'new' };
    await assert.rejects(() => tools.nodeGetPath({ reference: first.reference, expectedSiblingIndex: 0, expectedSiblingCount: 2, expectedNextSibling: first.nextSibling }), error => {
      assert.equal(error.code, 'NODE_NEXT_SIBLING_CHANGED');
      assert.deepEqual(error.details, { nodeId: 'target', expectedNextSiblingId: 'old', nextSiblingId: 'new' });
      return true;
    });
    assert.equal((await tools.nodeGetPath({ reference: { id: 'new' }, expectedNextSibling: null })).nextSibling, null);
    await assert.rejects(() => tools.nodeGetPath({ reference: { id: 'target' }, expectedNextSibling: null }), error => error.code === 'NODE_NEXT_SIBLING_CHANGED');
  });
  it('detects same-count previous sibling replacement without conflating the unchanged next neighbor', async () => {
    const children = [{ uuid: 'old' }, { uuid: 'target' }, { uuid: 'next' }];
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const first = await tools.nodeGetPath({ reference: { id: 'target' } });
    children[0] = { uuid: 'new' };
    await assert.rejects(() => tools.nodeGetPath({ reference: first.reference, expectedSiblingIndex: 1, expectedSiblingCount: 3, expectedNextSibling: first.nextSibling, expectedPreviousSibling: first.previousSibling }), error => {
      assert.equal(error.code, 'NODE_PREVIOUS_SIBLING_CHANGED');
      assert.deepEqual(error.details, { nodeId: 'target', expectedPreviousSiblingId: 'old', previousSiblingId: 'new' });
      return true;
    });
    assert.equal((await tools.nodeGetPath({ reference: { id: 'new' }, expectedPreviousSibling: null })).previousSibling, null);
  });
  it('checks neighbor UUIDs and conflict precedence across every sibling permutation', async () => {
    const original = ['a', 'target', 'b', 'c'];
    let order = original;
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children: order.map(uuid => ({ uuid })) }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const baseline = await tools.nodeGetPath({ reference: { id: 'target' } });
    const permutations = values => values.length === 0 ? [[]] : values.flatMap((value, index) => permutations(values.filter((_value, other) => other !== index)).map(rest => [value, ...rest]));
    for (const permutation of permutations(original)) {
      order = permutation;
      const index = order.indexOf('target');
      const previousId = order[index - 1] ?? null;
      const nextId = order[index + 1] ?? null;
      const args = { reference: baseline.reference, expectedNextSibling: baseline.nextSibling, expectedPreviousSibling: baseline.previousSibling };
      const code = nextId !== 'b' ? 'NODE_NEXT_SIBLING_CHANGED' : previousId !== 'a' ? 'NODE_PREVIOUS_SIBLING_CHANGED' : null;
      if (code) await assert.rejects(() => tools.nodeGetPath(args), error => {
        assert.equal(error.code, code);
        if (code === 'NODE_NEXT_SIBLING_CHANGED') assert.equal(error.details.nextSiblingId, nextId);
        else assert.equal(error.details.previousSiblingId, previousId);
        return true;
      });
      else {
        const result = await tools.nodeGetPath(args);
        assert.equal(result.previousSibling.id, 'a');
        assert.equal(result.nextSibling.id, 'b');
      }
    }
    assert.equal(baseline.previousSibling.id, 'a');
    assert.equal(baseline.nextSibling.id, 'b');
    assert.equal(baseline.siblingIndex, 1);
  });
  it('binds batch neighbor pairs by UUID while isolating drift from unchanged peers', async () => {
    const left = { uuid: 'left', children: [{ uuid: 'target' }, { uuid: 'old' }] };
    const right = { uuid: 'right', children: [{ uuid: 'peer' }] };
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children: [left, right] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const references = [{ id: 'target' }, { id: 'peer' }];
    const first = await tools.nodeGetPaths({ references });
    const expectedNeighbors = first.items.map(item => ({ reference: item.reference, previousSibling: item.result.previousSibling, nextSibling: item.result.nextSibling })).reverse();
    left.children[1] = { uuid: 'new' };
    const args = { references, expectedNeighbors };
    const result = await tools.nodeGetPaths(args);
    assert.equal(result.items[0].error.code, 'NODE_NEXT_SIBLING_CHANGED');
    assert.equal(result.items[0].error.details.nextSiblingId, 'new');
    assert.equal(result.items[1].result.reference.id, 'peer');
    assert.equal(result.selectionParentCounts, null);
    await assert.rejects(() => tools.nodeGetPaths({ ...args, requireAll: true }), error => error.code === 'NODE_GROUP_INCOMPLETE' && error.details.errorCounts.NODE_NEXT_SIBLING_CHANGED === 1);
  });
  it('requires neighbor baseline coverage by UUID without treating null pairs as absent', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; return { uuid: 'root', children: [{ uuid: 'child' }] }; } } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const expectedNeighbors = [{ reference: { id: 'root' }, previousSibling: null, nextSibling: null }];
    await assert.rejects(() => tools.nodeGetPaths({ references: ['child', 'root', 'child'].map(id => ({ id })), expectedNeighbors, requireNeighbors: true }), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(error.details, { missingNeighborGuardIds: ['child'] });
      return true;
    });
    assert.equal(queries, 0);
    const result = await tools.nodeGetPaths({ references: [{ id: 'root' }], expectedNeighbors, requireNeighbors: true });
    assert.equal(result.failed, 0);
  });
  it('rejects previous-neighbor drift without refreshing caller baselines or losing unchanged peers', async () => {
    const branch = { uuid: 'branch', children: [{ uuid: 'old' }, { uuid: 'target' }, { uuid: 'next' }] };
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children: [branch, { uuid: 'peer' }] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const references = [{ id: 'target' }, { id: 'peer' }];
    const first = await tools.nodeGetPaths({ references });
    const expectedNeighbors = first.items.map(item => ({ reference: item.reference, previousSibling: item.result.previousSibling, nextSibling: item.result.nextSibling }));
    branch.children[0] = { uuid: 'replacement' };
    const args = { references, expectedNeighbors, requireNeighbors: true };
    const stale = await tools.nodeGetPaths(args);
    assert.equal(stale.items[0].error.code, 'NODE_PREVIOUS_SIBLING_CHANGED');
    assert.deepEqual(stale.items[0].error.details, { nodeId: 'target', expectedPreviousSiblingId: 'old', previousSiblingId: 'replacement' });
    assert.equal(stale.items[1].result.reference.id, 'peer');
    assert.equal(stale.subtreeSelectionCoverage, null);
    assert.equal(expectedNeighbors[0].previousSibling.id, 'old');
    await assert.rejects(() => tools.nodeGetPaths({ ...args, requireAll: true }), error => error.code === 'NODE_GROUP_INCOMPLETE' && error.details.errorCounts.NODE_PREVIOUS_SIBLING_CHANGED === 1);
  });
  it('detects target child-count drift independently of unchanged sibling metadata', async () => {
    const target = { uuid: 'target', name: 'Target', children: [] };
    global.Editor = { Message: { request: async () => ({ uuid: 'root', name: 'Root', children: [target] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const first = await tools.nodeGetPath({ reference: { id: 'target' }, expectedChildCount: 0 });
    target.children.push({ uuid: 'new' });
    await assert.rejects(() => tools.nodeGetPath({ reference: first.reference, expectedPath: first.path, expectedSiblingIndex: first.siblingIndex, expectedSiblingCount: first.siblingCount, expectedChildCount: 0 }), error => {
      assert.equal(error.code, 'NODE_CHILD_COUNT_CHANGED');
      assert.deepEqual(error.details, { nodeId: 'target', expectedChildCount: 0, childCount: 1 });
      return true;
    });
    assert.equal((await tools.nodeGetPath({ reference: first.reference, expectedChildCount: 1 })).childCount, 1);
  });
  it('isolates UUID-bound child count drift while retaining valid batch peers', async () => {
    const target = { uuid: 'target', children: [] };
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children: [target, { uuid: 'peer' }] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const references = [{ id: 'target' }, { id: 'peer' }];
    const first = await tools.nodeGetPaths({ references });
    const expectedChildCounts = first.items.map(item => ({ reference: item.reference, childCount: item.result.childCount })).reverse();
    target.children.push({ uuid: 'new' });
    const args = { references, expectedChildCounts };
    const result = await tools.nodeGetPaths(args);
    assert.equal(result.items[0].error.code, 'NODE_CHILD_COUNT_CHANGED');
    assert.deepEqual(result.items[0].error.details, { nodeId: 'target', expectedChildCount: 0, childCount: 1 });
    assert.equal(result.items[1].result.reference.id, 'peer');
    assert.equal(result.subtreeSelectionCoverage, null);
    await assert.rejects(() => tools.nodeGetPaths({ ...args, requireAll: true }), error => error.code === 'NODE_GROUP_INCOMPLETE' && error.details.errorCounts.NODE_CHILD_COUNT_CHANGED === 1);
  });
  it('requires complete child count baselines while treating zero as a supplied guard', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; return { uuid: 'root', children: [{ uuid: 'leaf' }] }; } } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const expectedChildCounts = [{ reference: { id: 'leaf' }, childCount: 0 }];
    await assert.rejects(() => tools.nodeGetPaths({ references: ['root', 'leaf', 'root'].map(id => ({ id })), expectedChildCounts, requireChildCounts: true }), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(error.details, { missingChildCountGuardIds: ['root'] });
      return true;
    });
    assert.equal(queries, 0);
    assert.equal((await tools.nodeGetPaths({ references: [{ id: 'leaf' }], expectedChildCounts, requireChildCounts: true })).failed, 0);
  });
  it('retains old child-count baselines after removals until an explicit fresh observation', async () => {
    const container = { uuid: 'container', children: [{ uuid: 'kept' }, { uuid: 'removed' }] };
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children: [container, { uuid: 'peer' }] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const references = [{ id: 'container' }, { id: 'peer' }];
    const before = await tools.nodeGetPaths({ references });
    const expectedChildCounts = before.items.map(item => ({ reference: item.reference, childCount: item.result.childCount }));
    container.children.pop();
    const args = { references, expectedChildCounts, requireChildCounts: true };
    const stale = await tools.nodeGetPaths(args);
    assert.deepEqual(stale.items[0].error.details, { nodeId: 'container', expectedChildCount: 2, childCount: 1 });
    assert.equal(stale.items[1].result.reference.id, 'peer');
    assert.equal(stale.subtreeSelectionCoverage, null);
    assert.equal(expectedChildCounts[0].childCount, 2);
    assert.equal(before.items[0].result.childCount, 2);
    await assert.rejects(() => tools.nodeGetPaths({ ...args, requireAll: true }), error => error.code === 'NODE_GROUP_INCOMPLETE');
    const fresh = await tools.nodeGetPaths({ references });
    assert.equal(fresh.items[0].result.childCount, 1);
    assert.equal(fresh.items[0].result.firstChild.id, 'kept');
    const refreshedCounts = fresh.items.map(item => ({ reference: item.reference, childCount: item.result.childCount }));
    assert.equal((await tools.nodeGetPaths({ ...args, expectedChildCounts: refreshedCounts })).failed, 0);
  });
  it('refuses malformed child identities even when child-count baselines match', async () => {
    const children = [{ uuid: 'a' }, { uuid: 'b' }];
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    assert.equal((await tools.nodeGetPath({ reference: { id: 'root' }, expectedChildCount: 2 })).childCount, 2);
    children[1] = { uuid: 'a' };
    await assert.rejects(() => tools.nodeGetPath({ reference: { id: 'root' }, expectedChildCount: 2 }), error => error.code === 'INVALID_RESPONSE');
    await assert.rejects(() => tools.nodeGetPaths({ references: [{ id: 'root' }], expectedChildCounts: [{ reference: { id: 'root' }, childCount: 2 }], requireChildCounts: true }), error => error.code === 'INVALID_RESPONSE');
    children[1] = {};
    await assert.rejects(() => tools.nodeGetPath({ reference: { id: 'root' }, expectedChildCount: 2 }), error => error.code === 'INVALID_RESPONSE');
  });
  it('detects deep descendant growth even when the immediate child count stays unchanged', async () => {
    const branch = { uuid: 'branch', children: [] };
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children: [branch] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const first = await tools.nodeGetPath({ reference: { id: 'root' } });
    branch.children.push({ uuid: 'deep' });
    await assert.rejects(() => tools.nodeGetPath({ reference: first.reference, expectedChildCount: first.childCount, expectedDescendantCount: first.descendantCount }), error => {
      assert.equal(error.code, 'NODE_DESCENDANT_COUNT_CHANGED');
      assert.deepEqual(error.details, { nodeId: 'root', expectedDescendantCount: 1, descendantCount: 2 });
      return true;
    });
    assert.equal((await tools.nodeGetPath({ reference: { id: 'deep' }, expectedDescendantCount: 0 })).descendantCount, 0);
  });
  it('isolates deep descendant drift in UUID-bound batch guards', async () => {
    const branch = { uuid: 'branch', children: [] };
    const container = { uuid: 'container', children: [branch] };
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children: [container, { uuid: 'peer' }] }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const references = [{ id: 'container' }, { id: 'peer' }];
    const before = await tools.nodeGetPaths({ references });
    const expectedDescendantCounts = before.items.map(item => ({ reference: item.reference, descendantCount: item.result.descendantCount })).reverse();
    branch.children.push({ uuid: 'deep' });
    const args = { references, expectedDescendantCounts };
    const result = await tools.nodeGetPaths(args);
    assert.equal(result.items[0].error.code, 'NODE_DESCENDANT_COUNT_CHANGED');
    assert.deepEqual(result.items[0].error.details, { nodeId: 'container', expectedDescendantCount: 1, descendantCount: 2 });
    assert.equal(result.items[1].result.reference.id, 'peer');
    assert.equal(result.subtreeSelectionCoverage, null);
    await assert.rejects(() => tools.nodeGetPaths({ ...args, requireAll: true }), error => error.code === 'NODE_GROUP_INCOMPLETE' && error.details.errorCounts.NODE_DESCENDANT_COUNT_CHANGED === 1);
  });
  it('requires complete descendant baselines without treating zero as absent coverage', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; return { uuid: 'root', children: [{ uuid: 'leaf' }] }; } } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const expectedDescendantCounts = [{ reference: { id: 'leaf' }, descendantCount: 0 }];
    await assert.rejects(() => tools.nodeGetPaths({ references: ['root', 'leaf', 'root'].map(id => ({ id })), expectedDescendantCounts, requireDescendantCounts: true }), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(error.details, { missingDescendantCountGuardIds: ['root'] });
      return true;
    });
    assert.equal(queries, 0);
    assert.equal((await tools.nodeGetPaths({ references: [{ id: 'leaf' }], expectedDescendantCounts, requireDescendantCounts: true })).failed, 0);
  });
  it('does not mistake stable descendant totals for unchanged subtree topology', async () => {
    const leaf = { uuid: 'leaf', name: 'Leaf' };
    const branch = { uuid: 'branch', name: 'Branch', children: [] };
    const root = { uuid: 'root', name: 'Root', children: [branch, leaf] };
    global.Editor = { Message: { request: async () => root } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const before = await tools.nodeGetPath({ reference: { id: 'root' } });
    const leafBefore = await tools.nodeGetPath({ reference: { id: 'leaf' } });
    root.children.pop();
    branch.children.push(leaf);
    const after = await tools.nodeGetPath({ reference: before.reference, expectedDescendantCount: before.descendantCount });
    assert.equal(after.descendantCount, 2);
    assert.equal(after.subtreeHeight, 2);
    assert.equal(after.subtreeLeafCount, 1);
    assert.equal(before.subtreeHeight, 1);
    assert.equal(before.subtreeLeafCount, 2);
    await assert.rejects(() => tools.nodeGetPath({ reference: leafBefore.reference, expectedAncestors: leafBefore.ancestors }),
      error => error.code === 'NODE_ANCESTRY_CHANGED' && error.details.ancestorIds.includes('branch'));
  });
  it('refuses malformed off-filter registry rows before returning a capped unique registration', async () => {
    const rows = [{ name: 'Controller', type: 'Game.Controller', assetUuid: 'script' }, { name: 'Other', type: 'Game.Other', assetUuid: 42 }];
    global.Editor = { Message: { request: async () => rows } };
    const tools = new ComponentTools();
    const args = { scriptReference: { id: 'script' }, filter: 'Game.Controller', filterMatch: 'exact', requireSingle: true, limit: 1 };
    await assert.rejects(() => tools.nodeGetAvailableComponentTypes(args), error => error.code === 'INVALID_RESPONSE' && error.status === 502 && error.details.registryIndex === 1);
    rows[1].assetUuid = 'other-script';
    const result = await tools.nodeGetAvailableComponentTypes(args);
    assert.deepEqual(result.registrations, [{ name: 'Controller', type: 'Game.Controller', assetUuid: 'script' }]);
    assert.equal(result.total, 1);
    rows[1].name = ' ';
    await assert.rejects(() => tools.nodeGetAvailableComponentTypes(args), error => error.code === 'INVALID_RESPONSE' && error.status === 502 && error.details.registryIndex === 1);
  });
  it('detects child replacement and reorder despite unchanged counts', async () => {
    const children = [{ uuid: 'a' }, { uuid: 'b' }];
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const args = { reference: { id: 'root' }, expectedChildCount: 2, expectedDescendantCount: 2, expectedChildren: [{ id: 'a' }, { id: 'b' }] };
    assert.equal((await tools.nodeGetPath(args)).childCount, 2);
    children.reverse();
    await assert.rejects(() => tools.nodeGetPath(args), error => error.code === 'NODE_CHILDREN_CHANGED' && error.details.childIds.join(',') === 'b,a');
    children[0] = { uuid: 'replacement' };
    await assert.rejects(() => tools.nodeGetPath(args), error => error.code === 'NODE_CHILDREN_CHANGED' && error.details.childIds[0] === 'replacement');
    assert.equal((await tools.nodeGetPath({ reference: { id: 'a' }, expectedChildren: [] })).childCount, 0);
  });
  it('identifies the first child mismatch including appended and removed tail entries', async () => {
    let children = [{ uuid: 'a' }, { uuid: 'b' }];
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const args = { reference: { id: 'root' }, expectedChildren: [{ id: 'a' }, { id: 'b' }] };
    children = [{ uuid: 'a' }, { uuid: 'replacement' }];
    await assert.rejects(() => tools.nodeGetPath(args), error => error.code === 'NODE_CHILDREN_CHANGED' && error.details.mismatchIndex === 1 && error.details.expectedChildId === 'b' && error.details.childId === 'replacement');
    children = [{ uuid: 'a' }];
    await assert.rejects(() => tools.nodeGetPath(args), error => error.details.mismatchIndex === 1 && error.details.expectedChildId === 'b' && error.details.childId === null);
    children = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }];
    await assert.rejects(() => tools.nodeGetPath(args), error => error.details.mismatchIndex === 2 && error.details.expectedChildId === null && error.details.childId === 'c');
  });
  it('checks same-name child permutations by UUID without claiming recursive descendant identity', async () => {
    const original = ['a', 'b', 'c'];
    let children = original.map(uuid => ({ uuid, name: 'Same', children: [] }));
    global.Editor = { Message: { request: async () => ({ uuid: 'root', children }) } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    const args = { reference: { id: 'root' }, expectedChildCount: 3, expectedChildren: original.map(id => ({ id })) };
    const permutations = values => values.length ? values.flatMap((value, index) => permutations(values.filter((_value, other) => index !== other)).map(rest => [value, ...rest])) : [[]];
    for (const order of permutations(original)) {
      children = order.map(uuid => ({ uuid, name: 'Same', children: [] }));
      const mismatch = order.findIndex((id, index) => id !== original[index]);
      if (mismatch < 0) assert.equal((await tools.nodeGetPath(args)).childCount, 3);
      else await assert.rejects(() => tools.nodeGetPath(args), error => error.code === 'NODE_CHILDREN_CHANGED' && error.details.mismatchIndex === mismatch && error.details.expectedChildId === original[mismatch] && error.details.childId === order[mismatch]);
    }
    children = original.map(uuid => ({ uuid, name: 'Same', children: [] }));
    children[0].children.push({ uuid: 'deep' });
    const deep = await tools.nodeGetPath(args);
    assert.equal(deep.childCount, 3);
    assert.equal(deep.descendantCount, 4);
  });
  it('rejects invalid search limits before IPC instead of returning misleading empty hit prefixes', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; return { uuid: 'root', name: 'Root' }; } } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    for (const maxResults of [NaN, Infinity, 0, -1, 1.5, 2001, '1', null]) {
      await assert.rejects(() => tools.findNodes({ name: 'Root', maxResults }), error => error.code === 'INVALID_ARGUMENT' && error.status === 400 && error.details.field === 'maxResults');
    }
    assert.equal(queries, 0);
    assert.equal((await tools.findNodes({ name: 'Root', maxResults: 1 })).nodes[0].reference.id, 'root');
  });
  it('retains all malformed registry field names without inventing fields for non-object rows', async () => {
    let row = { name: ' ', type: 42, assetUuid: false };
    global.Editor = { Message: { request: async () => [row] } };
    const tools = new ComponentTools();
    await assert.rejects(() => tools.nodeGetAvailableComponentTypes(), error => {
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.deepEqual(error.details, { registryIndex: 0, invalidFields: ['name', 'type', 'assetUuid'] });
      return true;
    });
    row = null;
    await assert.rejects(() => tools.nodeGetAvailableComponentTypes(), error => error.code === 'INVALID_RESPONSE' && error.details.invalidFields.join(',') === 'entry');
  });
  it('refuses sparse child baselines before querying while preserving empty-list leaf checks', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; return { uuid: 'root' }; } } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    await assert.rejects(() => tools.nodeGetPath({ reference: { id: 'root' }, expectedChildren: new Array(1) }), error => error.code === 'INVALID_ARGUMENT' && error.status === 400);
    const mixed = [{ id: 'a' }, , { id: 'b' }];
    await assert.rejects(() => tools.nodeGetPath({ reference: { id: 'root' }, expectedChildren: mixed }), error => error.code === 'INVALID_ARGUMENT');
    assert.equal(queries, 0);
    assert.equal((await tools.nodeGetPath({ reference: { id: 'root' }, expectedChildren: [] })).childCount, 0);
  });
  it('rejects sparse ancestry chains instead of accepting missing identities as wildcard ancestors', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; return { uuid: 'root', children: [{ uuid: 'child' }] }; } } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    await assert.rejects(() => tools.nodeGetPath({ reference: { id: 'child' }, expectedAncestors: new Array(1) }), error => error.code === 'INVALID_ARGUMENT');
    await assert.rejects(() => tools.nodeGetPaths({ references: [{ id: 'child' }], expectedAncestors: [{ reference: { id: 'child' }, ancestors: new Array(1) }], requireAncestors: true }), error => error.code === 'INVALID_ARGUMENT');
    assert.equal(queries, 0);
    assert.equal((await tools.nodeGetPath({ reference: { id: 'root' }, expectedAncestors: [] })).depth, 0);
  });
  it('rejects sparse tree and component batch selections as caller errors before IPC', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; throw new Error('unexpected query'); } } };
    for (const [tools, method] of [[new SceneTools(), 'nodeGetPaths'], [new ComponentTools(), 'nodeComponentsBatchGet']]) {
      for (const references of [new Array(1), [{ id: 'a' }, , { id: 'b' }]]) await assert.rejects(() => tools[method]({ references }), error => error.code === 'INVALID_ARGUMENT' && error.status === 400);
    }
    assert.equal(queries, 0);
  });
  it('rejects sparse search UUID selections before querying instead of inventing missing identities', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; return { uuid: 'root' }; } } };
    const tools = new SceneTools();
    tools.findPrefabEditRoot = async () => null;
    for (const references of [new Array(1), [{ id: 'root' }, , { id: 'other' }]]) await assert.rejects(() => tools.findNodes({ references }), error => error.code === 'INVALID_ARGUMENT' && error.status === 400);
    assert.equal(queries, 0);
    assert.equal((await tools.findNodes({ references: [{ id: 'root' }, { id: 'root' }] })).total, 1);
  });
  it('rejects sparse parent and subtree-exclusion selectors before hierarchy IPC', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; throw new Error('unexpected query'); } } };
    const tools = new SceneTools();
    for (const field of ['parentReferences', 'excludeReferences']) {
      for (const references of [new Array(1), [{ id: 'root' }, , { id: 'other' }]]) await assert.rejects(() => tools.findNodes({ [field]: references }), error => error.code === 'INVALID_ARGUMENT' && error.status === 400);
    }
    assert.equal(queries, 0);
  });
  it('rejects sparse component class rules before inventing composition findings or querying nodes', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; throw new Error('unexpected query'); } } };
    const tools = new ComponentTools();
    for (const field of ['componentTypes', 'excludeComponentTypes', 'requiredComponentTypes', 'forbiddenComponentTypes', 'singletonComponentTypes', 'allowedComponentTypes']) {
      await assert.rejects(() => tools.nodeComponentsBatchGet({ references: [{ id: 'n' }], [field]: new Array(1) }), error => error.code === 'INVALID_ARGUMENT' && error.status === 400);
    }
    for (const field of ['componentTypes', 'excludeComponentTypes']) await assert.rejects(() => tools.nodeComponentsGet({ reference: { id: 'n' }, [field]: new Array(1) }), error => error.code === 'INVALID_ARGUMENT');
    assert.equal(queries, 0);
  });
  it('rejects sparse search class predicates without issuing false presence or absence results', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async () => { queries++; return { uuid: 'root' }; } } };
    const tools = new SceneTools();
    for (const field of ['componentTypes', 'excludeComponentTypes']) {
      for (const list of [new Array(1), ['cc.Label', , 'cc.Button']]) await assert.rejects(() => tools.findNodes({ [field]: list }), error => error.code === 'INVALID_ARGUMENT' && error.status === 400);
    }
    assert.equal(queries, 0);
  });
});
