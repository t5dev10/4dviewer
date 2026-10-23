// SuperSplat 4D .sog4d: a ZIP of WebP planes plus meta.json (type "sog4d"),
// or a "sog4d_multi" ZIP holding static SOG folders and a dynamic/ folder.
//
// The dynamic model is SpacetimeGaussians' linear one, on an absolute clock
// that plays [start, start + duration):
//   p(t) = μ + motion (t − trbf_center)
//   α(t) = opacity · exp(−((t − trbf_center) / trbf_scale)²)
// so with t measured from `start`: μt = trbf_center − start, τ = 1 / trbf_scale².
// SuperSplat hides splats whose α falls under `culling` (0.005 by default).

import { alloc, checkCount, checkEntryName, checkNumber, LIMITS, refuse } from '../core/limits.js';
import { SH_C0 } from '../core/scene.js';
import { buildTemporalScene } from '../core/temporal-build.js';
import { readZip } from './zip.js';
import { decodeSogMeta, decodeWebp } from './sog.js';

const DEFAULT_CULL = 0.005;
const QUAT_REST = [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]];

const invLog = (v) => (v < 0 ? -(Math.exp(-v) - 1) : Math.exp(v) - 1);
const deq16 = (lo, hi, min, max) => min + ((lo | (hi << 8)) / 65535) * ((max - min) || 1);

function parseMeta(bytes, what) {
  if (!bytes) refuse(`${what}: meta.json is missing`);
  if (bytes.byteLength > LIMITS.MAX_HEADER_BYTES * 8) refuse(`${what}: meta.json is implausibly large`);
  try {
    const meta = JSON.parse(new TextDecoder().decode(bytes));
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('not an object');
    return meta;
  } catch (err) {
    return refuse(`${what}: meta.json is not valid JSON (${err.message})`);
  }
}

function files(meta, key, n) {
  const list = meta[key]?.files;
  if (!Array.isArray(list) || list.length < n) refuse(`sog4d: meta.${key}.files must list ${n} file(s)`);
  return list.map(checkEntryName);
}

function triple(meta, key, field) {
  const v = meta[key]?.[field];
  if (!Array.isArray(v) || v.length < 3 || !v.slice(0, 3).every(Number.isFinite)) refuse(`sog4d: meta.${key}.${field} needs three numbers`);
  return v;
}

function codebook(meta, key, field = 'codebook') {
  const cb = meta[key]?.[field];
  if (!Array.isArray(cb) || cb.length < 2 || cb.length > 65536 || !cb.every(Number.isFinite)) {
    refuse(`sog4d: meta.${key}.${field} must be a list of numbers`);
  }
  return Float32Array.from(cb);
}

// One dynamic splat set (the whole file, or the dynamic/ folder of a multi file).
async function decodeDynamic(meta, read) {
  const n = checkCount('sog4d count', meta.count);
  const start = checkNumber('sog4d start', meta.start ?? 0, -1e6, 1e6);
  const duration = checkNumber('sog4d duration', meta.duration, 1e-6, 86400);
  const cull = Math.max(0, Number(meta.visibility_cull_threshold ?? meta.culling ?? DEFAULT_CULL) || 0);
  const trbf = meta.trbf || {};
  const kmeans = trbf.encoding === 'kmeans';
  if (!kmeans && trbf.encoding !== 'quantize16') refuse(`sog4d: unknown trbf encoding "${trbf.encoding}"`);
  const img = (name) => read(name).then(decodeWebp);
  const [ml, mu] = files(meta, 'means', 2);
  const [qf] = files(meta, 'quats', 1);
  const [sf] = files(meta, 'scales', 1);
  const [cf] = files(meta, 'sh0', 1);
  const [vl, vu] = files(meta, 'motion', 2);
  const trbfFiles = files(meta, 'trbf', kmeans ? 1 : 2);
  const [L, U, Q, S, C, VL, VU, T0, T1] = await Promise.all([
    img(ml), img(mu), img(qf), img(sf), img(cf), img(vl), img(vu), img(trbfFiles[0]), kmeans ? null : img(trbfFiles[1]),
  ]);
  for (const [name, im] of [['means_l', L], ['means_u', U], ['quats', Q], ['scales', S], ['sh0', C],
    ['motion_l', VL], ['motion_u', VU], ['trbf', T0], ['trbf_u', T1]]) {
    if (im && im.width * im.height < n) refuse(`sog4d: ${name} texture (${im.width}×${im.height}) is too small for ${n} splats`);
  }
  const mMin = triple(meta, 'means', 'mins'), mMax = triple(meta, 'means', 'maxs');
  const vMin = triple(meta, 'motion', 'mins'), vMax = triple(meta, 'motion', 'maxs');
  const sBook = codebook(meta, 'scales'), cBook = codebook(meta, 'sh0');
  const tc = kmeans ? codebook(meta, 'trbf', 'center_codebook') : null;
  const ts = kmeans ? codebook(meta, 'trbf', 'scale_codebook') : null;
  if (!kmeans) {
    for (const k of ['center_min', 'center_max', 'scale_min', 'scale_max']) checkNumber(`sog4d trbf.${k}`, trbf[k]);
  }

  const positions = alloc('sog4d positions', Float32Array, n * 3);
  const velocities = alloc('sog4d motion', Float32Array, n * 3);
  const rotations = alloc('sog4d rotations', Float32Array, n * 4);
  const scales = alloc('sog4d scales', Float32Array, n * 3);
  const opacities = alloc('sog4d opacities', Float32Array, n);
  const shDC = alloc('sog4d colour', Float32Array, n * 3);
  const muT = alloc('sog4d time centres', Float32Array, n);
  const tau = alloc('sog4d time scales', Float32Array, n);
  const q = [0, 0, 0, 0];
  for (let i = 0; i < n; ++i) {
    const o = i * 4;
    for (let a = 0; a < 3; ++a) {
      positions[i * 3 + a] = invLog(deq16(L.data[o + a], U.data[o + a], mMin[a], mMax[a]));
      velocities[i * 3 + a] = invLog(deq16(VL.data[o + a], VU.data[o + a], vMin[a], vMax[a]));
      scales[i * 3 + a] = Math.exp(sBook[S.data[o + a]] ?? 0);
      shDC[i * 3 + a] = cBook[C.data[o + a]] ?? 0;
    }
    opacities[i] = C.data[o + 3] / 255;
    // Smallest-three, in the PLY's rot_0..3 order (w x y z), largest index in alpha.
    const tag = Q.data[o + 3];
    if (tag < 252) {
      rotations[i * 4] = 1;
    } else {
      const m = tag - 252, rest = QUAT_REST[m];
      q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 0;
      q[rest[0]] = ((Q.data[o] / 255) * 2 - 1) / Math.SQRT2;
      q[rest[1]] = ((Q.data[o + 1] / 255) * 2 - 1) / Math.SQRT2;
      q[rest[2]] = ((Q.data[o + 2] / 255) * 2 - 1) / Math.SQRT2;
      q[m] = Math.sqrt(Math.max(0, 1 - (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])));
      rotations.set(q, i * 4);
    }
    let centre, logScale;
    if (kmeans) {
      centre = tc[T0.data[o]] ?? 0;
      logScale = ts[T0.data[o + 1]] ?? 0;
    } else {
      centre = deq16(T0.data[o], T1.data[o], trbf.center_min, trbf.center_max);
      logScale = deq16(T0.data[o + 1], T1.data[o + 1], trbf.scale_min, trbf.scale_max);
    }
    muT[i] = centre - start;
    const width = Math.max(Math.exp(logScale), 1e-6);
    tau[i] = 1 / (width * width);
  }
  return { n, start, duration, cull, positions, velocities, rotations, scales, opacities, shDC, muT, tau };
}

export async function loadSog4d(buffer) {
  const entries = await readZip(buffer);
  const meta = parseMeta(entries.get('meta.json'), 'sog4d');
  const warnings = [];
  const parts = [];
  let dyn;
  if (meta.type === 'sog4d') {
    dyn = await decodeDynamic(meta, async (name) => entryOrFail(entries, name));
    noteExtras(meta, warnings);
  } else if (meta.type === 'sog4d_multi') {
    const dynMeta = parseMeta(entries.get('dynamic/meta.json'), 'sog4d dynamic/');
    dyn = await decodeDynamic(dynMeta, async (name) => entryOrFail(entries, `dynamic/${name}`));
    noteExtras(dynMeta, warnings);
    for (const folder of Object.keys(meta.static || {})) {
      checkEntryName(folder);
      const smeta = parseMeta(entries.get(`${folder}/meta.json`), `sog4d ${folder}/`);
      const s = await decodeSogMeta(smeta, async (name) => entryOrFail(entries, `${folder}/${name}`));
      parts.push(s);
    }
  } else {
    refuse(`sog4d: meta.json type is "${meta.type}" (expected "sog4d" or "sog4d_multi")`);
  }
  if (meta.cubemap) warnings.push('The file carries a cubemap background; it is not shown here.');
  return assemble(dyn, parts, warnings);
}

function entryOrFail(entries, name) {
  const data = entries.get(name);
  if (!data) refuse(`sog4d: "${name}" is missing from the archive`);
  return data;
}

function noteExtras(meta, warnings) {
  if (meta.visibility) warnings.push('View-dependent visibility (a SuperSplat 4D fork extension) is not evaluated; splats show from every side.');
  if ((meta.sh_degree ?? 0) > 0) warnings.push(`meta.json declares SH degree ${meta.sh_degree}, but .sog4d stores only the base colour.`);
}

// Dynamic splats plus any static SOG parts (never fading, standing still).
function assemble(dyn, parts, warnings) {
  const staticCount = parts.reduce((s, p) => s + p.count, 0);
  const n = dyn.n + staticCount;
  const shL = parts.reduce((d, p) => Math.max(d, p.shDegree || 0), 0);
  const K = (shL + 1) * (shL + 1) - 1;
  if (!staticCount) {
    return buildTemporalScene({
      count: n, duration: dyn.duration, positions: dyn.positions, velocities: dyn.velocities, muT: dyn.muT,
      tau: dyn.tau, rotations: dyn.rotations, scales: dyn.scales, opacities: dyn.opacities, shL: 0, shF: 1,
      shDC: dyn.shDC, staticRule: false, alphaCut: dyn.cull, sourceFormat: 'sog4d', warnings,
    });
  }
  const cat = (what, per, fill) => {
    const out = alloc(`sog4d ${what}`, Float32Array, n * per);
    fill(out);
    return out;
  };
  const positions = cat('positions', 3, (o) => { o.set(dyn.positions); let at = dyn.n * 3; for (const p of parts) { o.set(p.positions, at); at += p.count * 3; } });
  const rotations = cat('rotations', 4, (o) => { o.set(dyn.rotations); let at = dyn.n * 4; for (const p of parts) { o.set(p.rotations, at); at += p.count * 4; } });
  const scales = cat('scales', 3, (o) => { o.set(dyn.scales); let at = dyn.n * 3; for (const p of parts) { o.set(p.scales, at); at += p.count * 3; } });
  const opacities = cat('opacities', 1, (o) => { o.set(dyn.opacities); let at = dyn.n; for (const p of parts) { o.set(p.opacities, at); at += p.count; } });
  const velocities = cat('motion', 3, (o) => o.set(dyn.velocities));
  const muT = cat('time centres', 1, (o) => o.set(dyn.muT));
  const tau = cat('time scales', 1, (o) => o.set(dyn.tau)); // static parts: τ = 0, never fade
  const shDC = cat('colour', 3, (o) => {
    o.set(dyn.shDC);
    let at = dyn.n;
    for (const p of parts) {
      for (let j = 0; j < p.count * 3; ++j) o[at * 3 + j] = p.colorsDC[j] / SH_C0;
      at += p.count;
    }
  });
  let shRest = null;
  if (K) {
    shRest = alloc('sog4d SH', Float32Array, n * 3 * K);
    let at = dyn.n;
    for (const p of parts) {
      const pk = p.shRest ? p.shRest.length / p.count / 3 : 0;
      for (let i = 0; i < p.count; ++i) {
        for (let c = 0; c < 3; ++c) {
          for (let k = 0; k < Math.min(pk, K); ++k) shRest[((at + i) * 3 + c) * K + k] = p.shRest[(i * 3 + c) * pk + k];
        }
      }
      at += p.count;
    }
  }
  return buildTemporalScene({
    count: n, duration: dyn.duration, positions, velocities, muT, tau, rotations, scales, opacities,
    shL, shF: 1, shDC, shRest, staticRule: false, alphaCut: dyn.cull, sourceFormat: 'sog4d', warnings,
  });
}
