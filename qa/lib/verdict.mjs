export const VERDICT = Object.freeze({
  PASS: 'PASS',
  BLANK: 'BLANK',
  FAIL: 'FAIL',
  UPSTREAM: 'UPSTREAM',
  SKIP: 'SKIP',
});

export function isBlocking(verdict) {
  return verdict === VERDICT.FAIL;
}
