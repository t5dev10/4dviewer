// Minimal ZIP reader (STORED and DEFLATE, no ZIP64) for SOG bundles and USDZ.

import { checkEntryName, checkInt, checkPayload, decompress, LIMITS } from '../core/limits.js';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export async function readZip(buffer, { wanted = null } = {}) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchFloor = Math.max(0, bytes.length - 66000);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= searchFloor; --i) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('zip: End Of Central Directory not found');
  const count = checkInt('zip entry count', view.getUint16(eocd + 10, true), 0, LIMITS.MAX_ZIP_ENTRIES);
  let p = view.getUint32(eocd + 16, true);
  checkPayload('zip central directory', p + 46 * Math.min(count, 1), bytes.length);
  const entries = new Map();
  for (let e = 0; e < count; ++e) {
    checkPayload('zip central directory record', p + 46, bytes.length);
    if (view.getUint32(p, true) !== CENTRAL) throw new Error('zip: bad central directory header');
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localAt = view.getUint32(p + 42, true);
    checkPayload('zip entry name', p + 46 + nameLen, bytes.length);
    const name = checkEntryName(new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen)));
    checkInt(`zip entry "${name}" compressed size`, compSize, 0, LIMITS.MAX_ZIP_ENTRY_BYTES);
    checkInt(`zip entry "${name}" declared size`, size, 0, LIMITS.MAX_ZIP_ENTRY_BYTES);
    checkPayload(`zip entry "${name}" local header`, localAt + 30, bytes.length);
    if (view.getUint32(localAt, true) !== LOCAL) throw new Error(`zip: bad local file header for "${name}"`);
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    checkPayload(`zip entry "${name}" data`, compSize, bytes.length - dataAt);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (wanted && !wanted(name)) {
      entries.set(name, null);
      continue;
    }
    const data = bytes.subarray(dataAt, dataAt + compSize);
    if (method === 0) {
      entries.set(name, data.slice());
    } else if (method === 8) {
      const out = await decompress(data, 'deflate-raw', {
        what: `zip entry "${name}"`, maxOut: LIMITS.MAX_ZIP_ENTRY_BYTES, declaredOut: size,
      });
      if (out.byteLength !== size) {
        throw new Error(`zip entry "${name}": inflated to ${out.byteLength} B, central directory declared ${size} B`);
      }
      entries.set(name, out);
    } else {
      throw new Error(`zip: unsupported compression method ${method} for "${name}" (only STORED/DEFLATE)`);
    }
  }
  return entries;
}

// First entry name, straight from the local header (used for sniffing).
export function firstZipEntryName(bytes) {
  if (bytes.length < 30) return null;
  const len = bytes[26] | (bytes[27] << 8);
  if (len === 0 || 30 + len > bytes.length) return null;
  let s = '';
  for (let i = 0; i < len; ++i) s += String.fromCharCode(bytes[30 + i]);
  return s;
}
