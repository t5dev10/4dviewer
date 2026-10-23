// IEEE 754 binary16 <-> binary32. Decoding goes through a lazily built
// 65536-entry table because 4D colour tables run to tens of millions of halves.

let table = null;

function decodeOne(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

export function halfTable() {
  if (!table) {
    table = new Float32Array(65536);
    for (let i = 0; i < 65536; ++i) table[i] = decodeOne(i);
  }
  return table;
}

export function halfToFloat(h) {
  return halfTable()[h & 0xffff];
}

export function halfsToFloats(src, dst = new Float32Array(src.length)) {
  const t = halfTable();
  for (let i = 0; i < src.length; ++i) dst[i] = t[src[i]];
  return dst;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

// Round-to-nearest-even float -> half.
export function floatToHalf(value) {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && (half & 1))) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++;
  return sign | half;
}

export function floatsToHalfs(src, dst = new Uint16Array(src.length)) {
  for (let i = 0; i < src.length; ++i) dst[i] = floatToHalf(src[i]);
  return dst;
}

// Truncating table conversion (van der Zijp) for bulk GPU staging, where one
// half ulp is far below the 8-bit output precision.
let baseT = null, shiftT = null;
function buildFastTables() {
  baseT = new Uint16Array(512);
  shiftT = new Uint8Array(512);
  for (let i = 0; i < 256; ++i) {
    const e = i - 127;
    let base, shift;
    if (e < -24) { base = 0; shift = 24; }
    else if (e < -14) { base = 0x0400 >> (-e - 14); shift = -e - 1; }
    else if (e <= 15) { base = (e + 15) << 10; shift = 13; }
    else if (e < 128) { base = 0x7c00; shift = 24; }
    else { base = 0x7c00; shift = 13; }
    baseT[i] = base;
    baseT[i | 0x100] = base | 0x8000;
    shiftT[i] = shift;
    shiftT[i | 0x100] = shift;
  }
}

const fastF = new Float32Array(1);
const fastU = new Uint32Array(fastF.buffer);
export function floatToHalfFast(v) {
  if (!baseT) buildFastTables();
  fastF[0] = v;
  const f = fastU[0];
  const e = (f >>> 23) & 0x1ff;
  return baseT[e] + ((f & 0x7fffff) >>> shiftT[e]);
}
