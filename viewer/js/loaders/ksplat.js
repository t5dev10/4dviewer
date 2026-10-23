// GaussianSplats3D ".ksplat" (layout 0.x): a 4096-byte header, 1024-byte
// section headers, then per-section bucket tables and splat records at one of
// three compression levels.

import { alloc, checkCount, checkInt, checkPayload } from '../core/limits.js';
import { halfToFloat } from '../core/half.js';
import { makeStaticScene } from '../core/scene.js';

const MAIN_HEADER = 4096;
const SECTION_HEADER = 1024;
const BUCKET_FLOATS = 3;
const MAX_SECTIONS = 1024;
const DEFAULT_SH_RANGE = 2;

const LEVELS = {
  0: { centre: 12, scale: 12, rot: 16, scaleOffset: 12, rotOffset: 24, colourOffset: 40, shOffset: 44, scaleRange: 1, shBytes: 4 },
  1: { centre: 6, scale: 6, rot: 8, scaleOffset: 6, rotOffset: 12, colourOffset: 20, shOffset: 24, scaleRange: 32767, shBytes: 2 },
  2: { centre: 6, scale: 6, rot: 8, scaleOffset: 6, rotOffset: 12, colourOffset: 20, shOffset: 24, scaleRange: 32767, shBytes: 1 },
};
const SH_COEFFS = [0, 3, 8];

export function readKsplatHeader(view) {
  return {
    versionMajor: view.getUint8(0),
    versionMinor: view.getUint8(1),
    maxSections: view.getUint32(4, true),
    sections: view.getUint32(8, true),
    splatCount: view.getUint32(16, true),
    level: view.getUint16(20, true),
    shMin: view.getFloat32(36, true) || -DEFAULT_SH_RANGE,
    shMax: view.getFloat32(40, true) || DEFAULT_SH_RANGE,
  };
}

export function loadKsplat(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < MAIN_HEADER) {
    throw new Error(`ksplat: ${bytes.byteLength} bytes is too short to hold a ${MAIN_HEADER}-byte header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const h = readKsplatHeader(view);
  if (h.versionMajor !== 0) {
    throw new Error(`ksplat: version ${h.versionMajor}.${h.versionMinor} is not readable (this reader implements the 0.x layout)`);
  }
  const maxSections = checkInt('ksplat maxSectionCount', h.maxSections, 0, MAX_SECTIONS);
  const liveSections = checkInt('ksplat sectionCount', h.sections, 0, maxSections);
  const total = checkCount('ksplat splatCount', h.splatCount);
  const L = LEVELS[h.level];
  if (!L) throw new Error(`ksplat: unknown compression level ${h.level} (expected 0, 1 or 2)`);
  checkPayload('ksplat section headers', MAIN_HEADER + maxSections * SECTION_HEADER, bytes.byteLength);

  const sections = [];
  let cursor = MAIN_HEADER + maxSections * SECTION_HEADER;
  let maxCoeffs = 0;
  for (let s = 0; s < maxSections; ++s) {
    const o = MAIN_HEADER + s * SECTION_HEADER;
    const maxSplatCount = checkCount(`ksplat section ${s} maxSplatCount`, view.getUint32(o + 4, true));
    const bucketSize = view.getUint32(o + 8, true);
    const bucketCount = view.getUint32(o + 12, true);
    const bucketBlockSize = view.getFloat32(o + 16, true);
    const bucketStorageBytes = view.getUint16(o + 20, true);
    const scaleRange = view.getUint32(o + 24, true) || L.scaleRange;
    const fullBuckets = view.getUint32(o + 32, true);
    const partialBuckets = view.getUint32(o + 36, true);
    const shDegree = checkInt(`ksplat section ${s} shDegree`, view.getUint16(o + 40, true), 0, 2);
    const coeffs = SH_COEFFS[shDegree];
    maxCoeffs = Math.max(maxCoeffs, coeffs);
    const bytesPerSplat = L.centre + L.scale + L.rot + 4 + L.shBytes * coeffs * 3;
    const partialTable = partialBuckets * 4;
    const bucketsBytes = bucketStorageBytes * bucketCount + partialTable;
    sections.push({
      index: s, maxSplatCount, bucketSize, bucketCount, fullBuckets, partialBuckets, bucketStorageBytes,
      coeffs, bytesPerSplat, scaleRange,
      scaleFactor: bucketBlockSize / 2 / scaleRange,
      base: cursor,
      bucketsBase: cursor + partialTable,
      dataBase: cursor + bucketsBytes,
    });
    cursor += bytesPerSplat * maxSplatCount + bucketsBytes;
  }
  checkPayload('ksplat section data', cursor, bytes.byteLength);
  const live = sections.slice(0, liveSections);
  const held = live.reduce((s, sec) => s + sec.maxSplatCount, 0);
  if (held !== total) throw new Error(`ksplat: the header declares ${total} splats but its ${liveSections} live section(s) hold ${held}`);
  if (h.level >= 1) {
    for (const sec of live) {
      if (sec.bucketStorageBytes === 0 && sec.bucketCount > 0) {
        throw new Error(`ksplat: section ${sec.index} declares ${sec.bucketCount} buckets of zero bytes`);
      }
    }
  }

  const positions = alloc('ksplat positions', Float32Array, total * 3);
  const scales = alloc('ksplat scales', Float32Array, total * 3);
  const rotations = alloc('ksplat rotations', Float32Array, total * 4);
  const opacities = alloc('ksplat opacities', Float32Array, total);
  const colorsDC = alloc('ksplat colors', Float32Array, total * 3);
  const shRest = maxCoeffs ? alloc('ksplat shRest', Float32Array, total * maxCoeffs * 3) : null;
  const readF = h.level === 0 ? (o, k) => view.getFloat32(o + k * 4, true) : (o, k) => halfToFloat(view.getUint16(o + k * 2, true));

  let out = 0;
  for (const sec of live) {
    const partial = [];
    if (h.level >= 1) for (let b = 0; b < sec.partialBuckets; ++b) partial.push(view.getUint32(sec.base + b * 4, true));
    const fullSplats = sec.fullBuckets * sec.bucketSize;
    const bucketOf = (i) => {
      if (i < fullSplats) return Math.floor(i / sec.bucketSize);
      let start = fullSplats, bucket = sec.fullBuckets;
      for (const size of partial) {
        if (i >= start && i < start + size) return bucket;
        start += size;
        bucket++;
      }
      throw new Error(`ksplat: splat ${i} of section ${sec.index} falls in no bucket`);
    };
    for (let i = 0; i < sec.maxSplatCount; ++i, ++out) {
      const o = sec.dataBase + i * sec.bytesPerSplat;
      if (h.level === 0) {
        for (let k = 0; k < 3; ++k) positions[out * 3 + k] = view.getFloat32(o + k * 4, true);
      } else {
        const bucket = sec.bucketsBase + bucketOf(i) * BUCKET_FLOATS * 4;
        for (let k = 0; k < 3; ++k) {
          positions[out * 3 + k] = (view.getUint16(o + k * 2, true) - sec.scaleRange) * sec.scaleFactor +
            view.getFloat32(bucket + k * 4, true);
        }
      }
      for (let k = 0; k < 3; ++k) scales[out * 3 + k] = readF(o + L.scaleOffset, k);
      const w = readF(o + L.rotOffset, 0), x = readF(o + L.rotOffset, 1);
      const y = readF(o + L.rotOffset, 2), z = readF(o + L.rotOffset, 3);
      const l = Math.hypot(w, x, y, z) || 1;
      rotations[out * 4] = w / l;
      rotations[out * 4 + 1] = x / l;
      rotations[out * 4 + 2] = y / l;
      rotations[out * 4 + 3] = z / l;
      const c = o + L.colourOffset;
      for (let k = 0; k < 3; ++k) colorsDC[out * 3 + k] = bytes[c + k] / 255 - 0.5;
      opacities[out] = bytes[c + 3] / 255;
      if (shRest && sec.coeffs) {
        // GaussianSplats3D groups by band: [band 1: R0-2 G0-2 B0-2][band 2: R3-7 G3-7 B3-7].
        const sh = o + L.shOffset;
        for (let ch = 0; ch < 3; ++ch) {
          for (let k = 0; k < sec.coeffs; ++k) {
            const idx = k < 3 ? ch * 3 + k : 9 + ch * 5 + (k - 3);
            const v = h.level === 0 ? view.getFloat32(sh + idx * 4, true)
              : h.level === 1 ? halfToFloat(view.getUint16(sh + idx * 2, true))
                : (bytes[sh + idx] / 255) * (h.shMax - h.shMin) + h.shMin;
            shRest[(out * 3 + ch) * maxCoeffs + k] = v;
          }
        }
      }
    }
  }
  return makeStaticScene({
    count: total, positions, scales, rotations, opacities, colorsDC, shRest,
    shDegree: SH_COEFFS.indexOf(maxCoeffs), sourceFormat: 'ksplat',
  });
}
