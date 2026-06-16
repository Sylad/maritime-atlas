import { inflateSync } from 'node:zlib';

// Concatène tous les chunks IDAT, inflate, compte les bytes distincts.
// ≤ 3 distinct = palette uniforme (filter byte + 1-2 indices) = placeholder.
export function isUniformPng(buf) {
  const idat = [];
  let off = 8; // skip signature
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len; // 4 len + 4 type + len data + 4 crc
  }
  if (!idat.length) return false;
  const raw = inflateSync(Buffer.concat(idat));
  return new Set(raw).size <= 3;
}
