// Niantic SPZ. Versions 1-3 are one gzip stream behind a 16-byte header;
// version 4 has a plaintext 32-byte header, a TOC and one zstd stream per
// attribute. SPZ stores right-up-back coordinates; the viewer frame is
// right-down-front, so y and z flip (positions, quaternions and SH).

import { alloc, checkCount, checkInt, checkPayload, decompress, HostileInputError, refuse } from '../core/limits.js';
import { halfToFloat } from '../core/half.js';
import { makeStaticScene, emptyStaticScene, SH_C0 } from '../core/scene.js';
import { FLIP_RUB_TO_RDF } from '../core/sh.js';
import { MAGIC } from '../core/formats.js';
import { decompress as zstdDecompress } from '../vendor/fzstd.js';

const COLOR_SCALE = 0.15;
const DIM = [0, 3, 8, 15, 24]; // rest coefficients per channel by degree
const FLAG_ANTIALIASED = 1;

function zstd(what, src, expected) {
  const out = alloc(what, Uint8Array, expected);
  let res;
  try {
    res = zstdDecompress(src, out);
  } catch (err) {
    throw err instanceof HostileInputError ? err : new HostileInputError(`${what}: zstd decompression failed (${err.message ?? err})`);
  }
  if (res.byteLength !== expected) refuse(`${what}: zstd stream inflated to ${res.byteLength} B, header declares ${expected} B`);
  return res;
}

function unpack({ n, version, shDegree, fractionalBits, flags, positions: pos, alphas, colors, scales: sc, rotations: rot, sh }) {
  const smallestThree = version >= 3;
  const float16 = version === 1;
  const dim = DIM[shDegree];
  const K = Math.min(dim, 15);
  const { flipP, flipQ, flipSh } = FLIP_RUB_TO_RDF;

  const positions = alloc('spz positions', Float32Array, n * 3);
  const scales = alloc('spz scales', Float32Array, n * 3);
  const rotations = alloc('spz rotations', Float32Array, n * 4);
  const opacities = alloc('spz opacities', Float32Array, n);
  const colorsDC = alloc('spz colors', Float32Array, n * 3);
  const shRest = K ? alloc('spz shRest', Float32Array, n * K * 3) : null;

  const pv = new DataView(pos.buffer, pos.byteOffset, pos.byteLength);
  const fixed = 1 / 2 ** fractionalBits;
  for (let i = 0; i < n; ++i) {
    for (let a = 0; a < 3; ++a) {
      let v;
      if (float16) {
        v = halfToFloat(pv.getUint16(i * 6 + a * 2, true));
      } else {
        const o = i * 9 + a * 3;
        let f = pos[o] | (pos[o + 1] << 8) | (pos[o + 2] << 16);
        if (f & 0x800000) f |= 0xff000000;
        v = f * fixed;
      }
      positions[i * 3 + a] = v * flipP[a];
      scales[i * 3 + a] = Math.exp(sc[i * 3 + a] / 16 - 10);
      colorsDC[i * 3 + a] = SH_C0 * ((colors[i * 3 + a] / 255 - 0.5) / COLOR_SCALE);
    }
    opacities[i] = alphas[i] / 255;

    let x, y, z, w;
    if (smallestThree) {
      let comp = (rot[i * 4] | (rot[i * 4 + 1] << 8) | (rot[i * 4 + 2] << 16) | (rot[i * 4 + 3] << 24)) >>> 0;
      const largest = comp >>> 30;
      const q = [0, 0, 0, 0];
      let sum = 0;
      for (let k = 3; k >= 0; --k) {
        if (k === largest) continue;
        const mag = comp & 511;
        const neg = (comp >>> 9) & 1;
        comp >>>= 10;
        let v = (Math.SQRT1_2 * mag) / 511;
        if (neg) v = -v;
        q[k] = v;
        sum += v * v;
      }
      q[largest] = Math.sqrt(Math.max(0, 1 - sum));
      [x, y, z, w] = q;
    } else {
      x = rot[i * 3] / 127.5 - 1;
      y = rot[i * 3 + 1] / 127.5 - 1;
      z = rot[i * 3 + 2] / 127.5 - 1;
      w = Math.sqrt(Math.max(0, 1 - (x * x + y * y + z * z)));
    }
    rotations[i * 4] = w;
    rotations[i * 4 + 1] = x * flipQ[0];
    rotations[i * 4 + 2] = y * flipQ[1];
    rotations[i * 4 + 3] = z * flipQ[2];

    if (shRest) {
      // File: coefficient-major with rgb interleaved; viewer: channel-major.
      for (let k = 0; k < K; ++k) {
        const src = (i * dim + k) * 3;
        for (let c = 0; c < 3; ++c) shRest[(i * 3 + c) * K + k] = ((sh[src + c] - 128) / 128) * flipSh[k];
      }
    }
  }
  const warnings = [];
  if (dim > K) warnings.push('SPZ carries SH degree 4; the viewer renders bands up to degree 3.');
  const scene = makeStaticScene({
    count: n, positions, scales, rotations, opacities, colorsDC, shRest,
    shDegree: Math.min(shDegree, 3), sourceFormat: 'spz', warnings,
  });
  scene.antialiased = !!(flags & FLAG_ANTIALIASED);
  scene.spzVersion = version;
  return scene;
}

function loadV4(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 32) throw new Error('spz: v4 file too short to hold its 32 B header');
  const version = view.getUint32(4, true);
  if (version !== 4) throw new Error(`spz: plaintext NGSP header with version ${version} (only v4 uses it)`);
  const n = checkCount('spz numPoints', view.getUint32(8, true));
  const shDegree = checkInt('spz shDegree', bytes[12], 0, 4);
  const fractionalBits = checkInt('spz fractionalBits', bytes[13], 0, 31);
  const flags = bytes[14];
  const numStreams = bytes[15];
  const tocOffset = view.getUint32(16, true);
  // Extensions (flag bit 1) sit between the header and the TOC; they are skipped.
  if (tocOffset < 32) throw new Error('spz v4: TOC offset points inside the header');
  const dim = DIM[shDegree];
  const sizes = [n * 9, n, n * 3, n * 3, n * 4, n * dim * 3];
  const names = ['positions', 'alphas', 'colors', 'scales', 'rotations', 'sh'];
  const present = sizes.map((s) => s > 0);
  const presentCount = present.filter(Boolean).length;
  // The reference writer omits empty streams; tolerate writers that list all six.
  const listsEmpty = numStreams === 6 && presentCount !== 6;
  if (numStreams !== presentCount && !listsEmpty) {
    throw new Error(`spz v4: declares ${numStreams} streams, expected ${presentCount}`);
  }
  checkPayload('spz v4 TOC', 16 * numStreams, bytes.byteLength - tocOffset);
  const streams = [];
  let cursor = tocOffset + 16 * numStreams;
  let t = 0;
  for (let s = 0; s < 6; ++s) {
    if (!present[s]) {
      if (listsEmpty) t++;
      streams.push(new Uint8Array(0));
      continue;
    }
    const compressed = view.getBigUint64(tocOffset + t * 16, true);
    const raw = view.getBigUint64(tocOffset + t * 16 + 8, true);
    t++;
    if (compressed > BigInt(Number.MAX_SAFE_INTEGER) || raw > BigInt(Number.MAX_SAFE_INTEGER)) {
      refuse(`spz v4 ${names[s]}: implausible stream size in TOC`);
    }
    const cSize = Number(compressed), rSize = Number(raw);
    if (rSize !== sizes[s]) throw new Error(`spz v4 ${names[s]}: stream declares ${rSize} B raw, expected ${sizes[s]}`);
    checkPayload(`spz v4 ${names[s]} stream`, cSize, bytes.byteLength - cursor);
    streams.push(zstd(`spz v4 ${names[s]}`, bytes.subarray(cursor, cursor + cSize), rSize));
    cursor += cSize;
  }
  if (n === 0) return emptyStaticScene('spz');
  return unpack({
    n, version, shDegree, fractionalBits, flags,
    positions: streams[0], alphas: streams[1], colors: streams[2], scales: streams[3], rotations: streams[4], sh: streams[5],
  });
}

export async function loadSpz(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === MAGIC.NGSP) {
    return loadV4(bytes);
  }
  if (!(bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)) {
    throw new Error('spz: not a recognised SPZ file (expected gzip for v1-3, or a plaintext "NGSP" header for v4)');
  }
  const raw = await decompress(bytes, 'gzip', { what: 'spz' });
  if (raw.byteLength < 16) throw new Error('spz: too short to hold a header');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint32(0, true) !== MAGIC.NGSP) throw new Error('spz: bad magic after gunzip');
  const version = view.getUint32(4, true);
  const n = checkCount('spz numPoints', view.getUint32(8, true));
  const shDegree = checkInt('spz shDegree', raw[12], 0, 4);
  const fractionalBits = checkInt('spz fractionalBits', raw[13], 0, 31);
  const flags = raw[14];
  if (version < 1 || version > 3) throw new Error(`spz: unsupported legacy version ${version}`);
  if (n === 0) return emptyStaticScene('spz');
  const posBytes = version === 1 ? 6 : 9;
  const rotBytes = version >= 3 ? 4 : 3;
  const dim = DIM[shDegree];
  checkPayload('spz body', n * (posBytes + 1 + 3 + 3 + rotBytes + dim * 3), raw.byteLength - 16);
  let p = 16;
  const take = (len) => {
    const s = raw.subarray(p, p + len);
    p += len;
    return s;
  };
  return unpack({
    n, version, shDegree, fractionalBits, flags,
    positions: take(n * posBytes), alphas: take(n), colors: take(n * 3), scales: take(n * 3),
    rotations: take(n * rotBytes), sh: take(n * dim * 3),
  });
}
