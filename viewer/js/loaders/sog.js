// PlayCanvas SOG: WebP planes plus meta.json, bundled in a ZIP (.sog) or
// unbundled next to meta.json. Version 2 (codebooks) and legacy version 1
// (per-channel ranges) are both read, mirroring PlayCanvas's splat-transform.

import { alloc, checkCount, checkEntryName, checkInt, LIMITS } from '../core/limits.js';
import { makeStaticScene, SH_C0 } from '../core/scene.js';
import { readZip } from './zip.js';

const SH_COEFFS = [0, 3, 8, 15];
const V1_BANDS_BY_WIDTH = { 192: 1, 512: 2, 960: 3 };
const QUAT_IDX = [1, 2, 3, 0, 2, 3, 0, 1, 3, 0, 1, 2];

let glReader = null;

// Exact RGBA texels. A 2D canvas stores premultiplied colour, which would
// destroy the sh0 colour of low-opacity splats, so WebGL readback comes first.
function readbackExact(bitmap) {
  try {
    if (!glReader) {
      if (typeof OffscreenCanvas === 'undefined') return null;
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { premultipliedAlpha: false, antialias: false });
      if (!gl) return null;
      glReader = { gl, tex: gl.createTexture(), fb: gl.createFramebuffer() };
    }
    const { gl, tex, fb } = glReader;
    const { width, height } = bitmap;
    if (width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
    const out = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return out;
  } catch {
    return null;
  }
}

async function decodeWebp(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }),
    { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const { width, height } = bitmap;
  try {
    let data = readbackExact(bitmap);
    if (!data) {
      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      data = ctx.getImageData(0, 0, width, height).data;
    }
    return { width, height, data };
  } finally {
    bitmap.close?.();
  }
}

async function fetchSibling(name, sourceUrl) {
  if (!sourceUrl) {
    throw new Error(`sog: "${name}" lives next to meta.json and a local file cannot reach it — open the bundled .sog instead`);
  }
  const res = await fetch(new URL(name, sourceUrl));
  if (!res.ok) throw new Error(`sog: failed to fetch "${name}": ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

const invLog = (v) => (v < 0 ? -(Math.exp(-v) - 1) : Math.exp(v) - 1);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function checkFiles(meta, key) {
  const files = meta[key]?.files;
  if (!Array.isArray(files) || !files.length) throw new Error(`sog: meta.${key}.files is missing`);
  files.forEach(checkEntryName);
  return files;
}

export async function loadSog(buffer, sourceUrl) {
  const bytes = new Uint8Array(buffer);
  let metaBytes;
  let fetchFile;
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const entries = await readZip(buffer);
    const metaName = entries.has('meta.json') ? 'meta.json' : [...entries.keys()].find((k) => k.endsWith('/meta.json'));
    if (!metaName) throw new Error('sog: the archive has no "meta.json"');
    const dir = metaName.slice(0, metaName.length - 'meta.json'.length);
    metaBytes = entries.get(metaName);
    fetchFile = async (name) => {
      const data = entries.get(dir + name) ?? entries.get(name);
      if (!data) throw new Error(`sog: "${name}" not found in the archive`);
      return data;
    };
  } else {
    metaBytes = bytes;
    fetchFile = (name) => fetchSibling(name, sourceUrl);
  }
  if (metaBytes.byteLength > LIMITS.MAX_HEADER_BYTES) throw new Error(`sog: meta.json is implausibly large (${metaBytes.byteLength} B)`);
  let meta;
  try {
    meta = JSON.parse(new TextDecoder().decode(metaBytes));
  } catch (err) {
    throw new Error(`sog: meta.json is not valid JSON (${err.message})`);
  }
  if (!meta || typeof meta !== 'object') throw new Error('sog: meta.json must be a JSON object');
  if (meta.version === 2) return decodeV2(meta, fetchFile);
  if (meta.version === undefined && Array.isArray(meta.means?.shape)) return decodeV1(meta, fetchFile);
  throw new Error(`sog: unsupported meta.json version ${meta.version} (this reader handles 1 and 2)`);
}

function quatFrom(px, py, pz, tag, out) {
  if (tag < 252 || tag > 255) {
    out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
    return;
  }
  const m = tag - 252;
  const a = ((px / 255) * 2 - 1) / Math.SQRT2;
  const b = ((py / 255) * 2 - 1) / Math.SQRT2;
  const c = ((pz / 255) * 2 - 1) / Math.SQRT2;
  out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
  out[QUAT_IDX[m * 3]] = a;
  out[QUAT_IDX[m * 3 + 1]] = b;
  out[QUAT_IDX[m * 3 + 2]] = c;
  out[m] = Math.sqrt(Math.max(0, 1 - (a * a + b * b + c * c)));
}

async function decodeCommon(meta, fetchFile, count, opts) {
  for (const key of ['means', 'scales', 'quats', 'sh0']) checkFiles(meta, key);
  const { mins, maxs } = meta.means;
  if (!Array.isArray(mins) || !Array.isArray(maxs) || mins.length < 3 || maxs.length < 3) {
    throw new Error('sog: meta.means needs mins/maxs triples');
  }
  const shFiles = opts.shN ? checkFiles(meta, 'shN') : null;
  const [lo, hi, sc, qt, c0, cen, lab] = await Promise.all([
    fetchFile(meta.means.files[0]).then(decodeWebp),
    fetchFile(meta.means.files[1]).then(decodeWebp),
    fetchFile(meta.scales.files[0]).then(decodeWebp),
    fetchFile(meta.quats.files[0]).then(decodeWebp),
    fetchFile(meta.sh0.files[0]).then(decodeWebp),
    shFiles ? fetchFile(shFiles[0]).then(decodeWebp) : null,
    shFiles ? fetchFile(shFiles[1]).then(decodeWebp) : null,
  ]);
  const capacity = lo.width * lo.height;
  if (count > capacity) throw new Error(`sog: count ${count} exceeds the ${lo.width}×${lo.height} texture capacity (${capacity})`);
  for (const [name, img] of [['means_u', hi], ['scales', sc], ['quats', qt], ['sh0', c0], ['shN labels', lab]]) {
    if (img && img.width * img.height < count) throw new Error(`sog: ${name} texture is too small for ${count} splats`);
  }
  const positions = alloc('sog positions', Float32Array, count * 3);
  const rotations = alloc('sog rotations', Float32Array, count * 4);
  const q = [1, 0, 0, 0];
  const span = [maxs[0] - mins[0] || 1, maxs[1] - mins[1] || 1, maxs[2] - mins[2] || 1];
  for (let i = 0; i < count; ++i) {
    const o = i * 4;
    for (let a = 0; a < 3; ++a) {
      const v = lo.data[o + a] | (hi.data[o + a] << 8);
      positions[i * 3 + a] = invLog(mins[a] + span[a] * (v / 65535));
    }
    quatFrom(qt.data[o], qt.data[o + 1], qt.data[o + 2], qt.data[o + 3], q);
    rotations.set(q, i * 4);
  }
  return { positions, rotations, sc, c0, cen, lab };
}

async function decodeV2(meta, fetchFile) {
  const count = checkCount('sog count', meta.count);
  const bands = meta.shN ? checkInt('sog shN.bands', meta.shN.bands, 0, 3) : 0;
  const K = SH_COEFFS[bands];
  const book = (key) => {
    const cb = meta[key]?.codebook;
    if (!Array.isArray(cb) || cb.length < 256) throw new Error(`sog: meta.${key}.codebook must have 256 entries`);
    return Float32Array.from(cb);
  };
  const sBook = book('scales'), cBook = book('sh0'), nBook = K ? book('shN') : null;
  const { positions, rotations, sc, c0, cen, lab } = await decodeCommon(meta, fetchFile, count, { shN: K > 0 });
  const scales = alloc('sog scales', Float32Array, count * 3);
  const opacities = alloc('sog opacities', Float32Array, count);
  const colorsDC = alloc('sog colors', Float32Array, count * 3);
  const shRest = K ? alloc('sog shRest', Float32Array, count * K * 3) : null;
  if (K && cen.width !== 64 * K) throw new Error(`sog: shN centroids width ${cen.width} does not match ${64 * K} for ${bands} band(s)`);
  const palette = K ? (meta.shN.count ?? Math.floor(cen.width / K) * cen.height) : 0;
  for (let i = 0; i < count; ++i) {
    const o = i * 4;
    for (let a = 0; a < 3; ++a) {
      scales[i * 3 + a] = Math.exp(sBook[sc.data[o + a]]);
      colorsDC[i * 3 + a] = SH_C0 * cBook[c0.data[o + a]];
    }
    opacities[i] = c0.data[o + 3] / 255;
    if (shRest) {
      const label = lab.data[o] | (lab.data[o + 1] << 8);
      if (label >= palette) continue;
      const row = Math.floor(label / 64), colBase = (label % 64) * K;
      if (row >= cen.height) continue;
      for (let k = 0; k < K; ++k) {
        const t = (row * cen.width + colBase + k) * 4;
        for (let c = 0; c < 3; ++c) shRest[(i * 3 + c) * K + k] = nBook[cen.data[t + c]];
      }
    }
  }
  return makeStaticScene({
    count, positions, scales, rotations, opacities, colorsDC, shRest, shDegree: bands, sourceFormat: 'sog',
  });
}

async function decodeV1(meta, fetchFile) {
  const count = checkCount('sog count', meta.means.shape[0]);
  const { positions, rotations, sc, c0, cen, lab } = await decodeCommon(meta, fetchFile, count, { shN: !!meta.shN });
  const bands = cen ? (V1_BANDS_BY_WIDTH[cen.width] ?? 0) : 0;
  if (cen && !bands) throw new Error(`sog: v1 shN centroids width ${cen.width} is not 192, 512 or 960`);
  const K = SH_COEFFS[bands];
  const scales = alloc('sog scales', Float32Array, count * 3);
  const opacities = alloc('sog opacities', Float32Array, count);
  const colorsDC = alloc('sog colors', Float32Array, count * 3);
  const shRest = K ? alloc('sog shRest', Float32Array, count * K * 3) : null;
  const sMin = meta.scales.mins, sMax = meta.scales.maxs, cMin = meta.sh0.mins, cMax = meta.sh0.maxs;
  const palette = K ? Math.floor(cen.width / K) * cen.height : 0;
  const nMin = meta.shN?.mins ?? 0, nSpan = (meta.shN?.maxs ?? 0) - nMin;
  for (let i = 0; i < count; ++i) {
    const o = i * 4;
    for (let a = 0; a < 3; ++a) {
      scales[i * 3 + a] = Math.exp(sMin[a] + (sMax[a] - sMin[a]) * (sc.data[o + a] / 255));
      colorsDC[i * 3 + a] = SH_C0 * (cMin[a] + (cMax[a] - cMin[a]) * (c0.data[o + a] / 255));
    }
    opacities[i] = sigmoid(cMin[3] + (cMax[3] - cMin[3]) * (c0.data[o + 3] / 255));
    if (shRest) {
      const label = lab.data[o] | (lab.data[o + 1] << 8);
      if (label >= palette) continue;
      const row = Math.floor(label / 64), colBase = (label % 64) * K;
      if (row >= cen.height) continue;
      for (let k = 0; k < K; ++k) {
        const t = (row * cen.width + colBase + k) * 4;
        for (let c = 0; c < 3; ++c) shRest[(i * 3 + c) * K + k] = nMin + nSpan * (cen.data[t + c] / 255);
      }
    }
  }
  return makeStaticScene({
    count, positions, scales, rotations, opacities, colorsDC, shRest, shDegree: bands, sourceFormat: 'sog',
  });
}
