import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { isUniformPng } from './png-uniform.mjs';

// Construit un PNG minimal : signature + IDAT(payload) + IEND. CRC non vérifié.
function makePng(rawBytes) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const idatData = deflateSync(Buffer.from(rawBytes));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([sig, chunk('IDAT', idatData), chunk('IEND', Buffer.alloc(0))]);
}

test('uniform palette (≤3 distinct bytes) → true', () => {
  assert.equal(isUniformPng(makePng([0, 1, 1, 1, 0, 1])), true);
});

test('real gradient (>3 distinct bytes) → false', () => {
  assert.equal(isUniformPng(makePng([0, 1, 2, 3, 4, 5, 6])), false);
});
