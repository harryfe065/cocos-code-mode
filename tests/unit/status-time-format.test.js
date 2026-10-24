'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { formatElapsed } = requireDist('panels/status/status-view.js');

it('formats status ages using the largest useful unit through hours', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(59_999), '59s');
  assert.equal(formatElapsed(60_000), '1m');
  assert.equal(formatElapsed(3_599_999), '59m');
  assert.equal(formatElapsed(3_600_000), '1h');
  assert.equal(formatElapsed(86_400_000), '24h');
});
