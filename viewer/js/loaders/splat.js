// antimatter15 ".splat": 32-byte records, position f32x3, scale f32x3 (linear),
// rgba u8x4, quaternion u8x4 (w x y z, biased by 128). Static and DC-only.

import { alloc, checkCount } from '../core/limits.js';
import { makeStaticScene } from '../core/scene.js';

export const SPLAT_RECORD = 32;

export function loadSplat(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength === 0) throw new Error('splat: the file is empty');
  if (bytes.byteLength % SPLAT_RECORD !== 0) {
    throw new Error(`splat: ${bytes.byteLength} bytes is not a whole number of ${SPLAT_RECORD}-byte records (truncated file, or not a .splat)`);
  }
  const n = checkCount('splat count', bytes.byteLength / SPLAT_RECORD);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const positions = alloc('splat positions', Float32Array, n * 3);
  const scales = alloc('splat scales', Float32Array, n * 3);
  const rotations = alloc('splat rotations', Float32Array, n * 4);
  const opacities = alloc('splat opacities', Float32Array, n);
  const colorsDC = alloc('splat colors', Float32Array, n * 3);
  for (let i = 0; i < n; ++i) {
    const o = i * SPLAT_RECORD;
    for (let k = 0; k < 3; ++k) {
      positions[i * 3 + k] = view.getFloat32(o + k * 4, true);
      scales[i * 3 + k] = view.getFloat32(o + 12 + k * 4, true);
      colorsDC[i * 3 + k] = bytes[o + 24 + k] / 255 - 0.5;
    }
    opacities[i] = bytes[o + 27] / 255;
    const w = (bytes[o + 28] - 128) / 128, x = (bytes[o + 29] - 128) / 128;
    const y = (bytes[o + 30] - 128) / 128, z = (bytes[o + 31] - 128) / 128;
    const l = Math.hypot(w, x, y, z) || 1;
    rotations[i * 4] = w / l;
    rotations[i * 4 + 1] = x / l;
    rotations[i * 4 + 2] = y / l;
    rotations[i * 4 + 3] = z / l;
  }
  return makeStaticScene({ count: n, positions, scales, rotations, opacities, colorsDC, sourceFormat: 'splat' });
}
