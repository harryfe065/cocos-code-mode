'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { mutateRuntimePersistentRoot } = requireDist('runtime-persistent-root.js');

afterEach(() => {
  delete global.cc;
});

function fixture() {
  const scene = { uuid: 'scene', parent: null, children: [] };
  const root = { uuid: 'root', parent: scene, children: [] };
  const nested = { uuid: 'nested', parent: root, children: [] };
  root.children.push(nested);
  scene.children.push(root);
  const calls = [];
  global.cc = {
    GAME_VIEW: true,
    ENGINE_VERSION: '3.7.3',
    director: {
      getScene: () => scene,
      addPersistRootNode: node => calls.push(['add', node.uuid]),
      removePersistRootNode: node => calls.push(['remove', node.uuid]),
    },
    isValid: () => true,
  };
  return { calls };
}

describe('runtime persistent-root helper', () => {
  it('mutates one exact scene-root child and returns lifecycle identity', () => {
    const { calls } = fixture();
    assert.deepEqual(mutateRuntimePersistentRoot('root', 'add', Date.now() + 1000), {
      nodeUuid: 'root', operation: 'add', sceneUuid: 'scene', parentUuidBefore: 'scene', parentUuidAfter: 'scene', registered: true, removed: false,
    });
    assert.deepEqual(mutateRuntimePersistentRoot('root', 'remove', Date.now() + 1000), {
      nodeUuid: 'root', operation: 'remove', sceneUuid: 'scene', parentUuidBefore: 'scene', parentUuidAfter: 'scene', registered: false, removed: true,
    });
    assert.deepEqual(calls, [['add', 'root'], ['remove', 'root']]);
  });

  it('rejects a nested node instead of claiming persistent-root ownership', () => {
    fixture();
    assert.deepEqual(mutateRuntimePersistentRoot('nested', 'add', Date.now() + 1000), {
      code: 'INVALID_PERSISTENT_ROOT_TARGET', message: 'Persistent-root operations require an exact scene-root child.',
    });
  });
});
