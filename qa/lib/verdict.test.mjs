import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERDICT, isBlocking } from './verdict.mjs';

test('VERDICT exposes the 5 verdicts', () => {
  assert.deepEqual(
    Object.values(VERDICT).sort(),
    ['BLANK', 'FAIL', 'PASS', 'SKIP', 'UPSTREAM'],
  );
});

test('only FAIL blocks the gate', () => {
  assert.equal(isBlocking(VERDICT.FAIL), true);
  assert.equal(isBlocking(VERDICT.BLANK), false);
  assert.equal(isBlocking(VERDICT.UPSTREAM), false);
  assert.equal(isBlocking(VERDICT.PASS), false);
  assert.equal(isBlocking(VERDICT.SKIP), false);
});
