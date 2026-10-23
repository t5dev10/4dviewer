// OpenUSD ParticleField3DGaussianSplat prims from an ASCII layer (.usda), or
// from the ASCII root layer of a .usdz package. Binary crates are refused
// with the command that converts them.

import { alloc, checkCount, checkInt, LIMITS } from '../core/limits.js';
import { makeStaticScene, SH_C0 } from '../core/scene.js';
import { FLIP_RUB_TO_RDF, R_ZUP, quatMul, Q_ZUP, rotateShRest } from '../core/sh.js';
import { readZip } from './zip.js';

const PRIM = 'ParticleField3DGaussianSplat';
const TEXT_CEILING = 256 * 1024 * 1024;

function readArray(text, from) {
  const open = text.indexOf('[', from);
  if (open === -1) return null;
  let depth = 0, close = -1;
  for (let i = open; i < text.length; ++i) {
    const ch = text[i];
    if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close === -1) throw new Error('usdz: an array literal is never closed');
  const values = [];
  const re = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  const body = text.slice(open + 1, close);
  let m;
  while ((m = re.exec(body)) !== null) {
    values.push(parseFloat(m[0]));
    if (values.length > LIMITS.MAX_SPLATS * 16) throw new Error('usdz: an array literal is implausibly long');
  }
  return values;
}

function primBlocks(text) {
  const out = [];
  const re = new RegExp(`\\bdef\\s+${PRIM}\\s+"([^"]*)"`, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const open = text.indexOf('{', m.index);
    if (open === -1) continue;
    let depth = 0, close = -1;
    for (let i = open; i < text.length; ++i) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close === -1) throw new Error(`usdz: the "${m[1]}" prim block is never closed`);
    out.push({ name: m[1], body: text.slice(open + 1, close) });
    re.lastIndex = close;
  }
  return out;
}

const esc = (name) => name.replace(/[:]/g, '\\:');

function attr(body, names) {
  for (const name of names) {
    const plain = new RegExp(`(?:^|\\s)${esc(name)}\\s*=`, 'm').exec(body);
    if (plain) {
      const v = readArray(body, plain.index + plain[0].length);
      if (v) return v;
    }
    const sampled = new RegExp(`(?:^|\\s)${esc(name)}\\.timeSamples\\s*=\\s*\\{\\s*[-+\\d.eE]+\\s*:`, 'm').exec(body);
    if (sampled) {
      const v = readArray(body, sampled.index + sampled[0].length);
      if (v) return v;
    }
  }
  return null;
}

function intAttr(body, name, fallback) {
  const m = new RegExp(`${esc(name)}\\s*=\\s*(-?\\d+)`).exec(body);
  return m ? parseInt(m[1], 10) : fallback;
}

export function upAxisOf(text) {
  const m = /upAxis\s*=\s*"([YZyz])"/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

function decodeLayer(text, up) {
  const prims = primBlocks(text);
  if (!prims.length) {
    throw new Error(`usdz: no ${PRIM} prim found — this stage carries no Gaussian splats (a mesh-only USDZ will not render as splats)`);
  }
  const parts = prims.map(({ body }) => {
    if (/xformOp/.test(body)) {
      throw new Error(`usdz: a ${PRIM} prim carries an xformOp; this reader cannot compose per-prim transforms (flatten the stage first)`);
    }
    const positions = attr(body, ['positions', 'positionsh']);
    if (!positions) throw new Error('usdz: a splat prim declares no positions, so it has no particles');
    if (positions.length % 3) throw new Error(`usdz: positions has ${positions.length} numbers, not a multiple of 3`);
    const n = positions.length / 3;
    const orient = attr(body, ['orientations', 'orientationsh']);
    const scales = attr(body, ['scales', 'scalesh']);
    const opac = attr(body, ['opacities', 'opacitiesh', 'primvars:displayOpacity']);
    const sh = attr(body, ['radiance:sphericalHarmonicsCoefficients', 'radiance:sphericalHarmonicsCoefficientsh']);
    const display = attr(body, ['primvars:displayColor']);
    const declared = checkInt('usdz sphericalHarmonicsDegree', intAttr(body, 'radiance:sphericalHarmonicsDegree', 0), 0, 3);
    const need = (arr, per, name) => {
      if (arr && arr.length !== n * per) throw new Error(`usdz: ${name} has ${arr.length} numbers but ${n} particles need ${n * per}`);
    };
    need(orient, 4, 'orientations');
    need(scales, 3, 'scales');
    need(opac, 1, 'opacities');
    need(display, 3, 'primvars:displayColor');
    let per = 0;
    if (sh) {
      if (sh.length % (n * 3)) throw new Error(`usdz: ${sh.length} SH numbers do not divide into ${n} particles × 3 channels`);
      per = sh.length / (n * 3);
      const deg = Math.round(Math.sqrt(per)) - 1;
      if ((deg + 1) ** 2 !== per) throw new Error(`usdz: ${per} SH coefficients per particle is not a whole degree`);
      if (deg > 3) throw new Error(`usdz: SH degree ${deg} is beyond what the viewer renders (3)`);
      if (declared && deg !== declared) {
        throw new Error(`usdz: the stage declares SH degree ${declared} but carries ${per} coefficients per particle (degree ${deg})`);
      }
    }
    return { n, positions, orient, scales, opac, sh, per, display };
  });
  const total = checkCount('usdz particle count', parts.reduce((s, p) => s + p.n, 0));
  const per = Math.max(0, ...parts.map((p) => p.per));
  const K = per ? per - 1 : 0;
  const positions = alloc('usdz positions', Float32Array, total * 3);
  const scales = alloc('usdz scales', Float32Array, total * 3);
  const rotations = alloc('usdz rotations', Float32Array, total * 4);
  const opacities = alloc('usdz opacities', Float32Array, total);
  const colorsDC = alloc('usdz colors', Float32Array, total * 3);
  const shRest = K ? alloc('usdz shRest', Float32Array, total * K * 3) : null;
  const zUp = up === 'z';
  const { flipP, flipQ, flipSh } = FLIP_RUB_TO_RDF;
  let o = 0;
  for (const p of parts) {
    for (let i = 0; i < p.n; ++i, ++o) {
      const x = p.positions[i * 3], y = p.positions[i * 3 + 1], z = p.positions[i * 3 + 2];
      if (zUp) positions.set([x, -z, y], o * 3);
      else positions.set([x * flipP[0], y * flipP[1], z * flipP[2]], o * 3);
      for (let a = 0; a < 3; ++a) scales[o * 3 + a] = p.scales ? p.scales[i * 3 + a] : 0.01;
      // USD quaternions are written real part first.
      let q = p.orient ? [p.orient[i * 4], p.orient[i * 4 + 1], p.orient[i * 4 + 2], p.orient[i * 4 + 3]] : [1, 0, 0, 0];
      if (zUp) q = quatMul(Q_ZUP, q);
      else q = [q[0], q[1] * flipQ[0], q[2] * flipQ[1], q[3] * flipQ[2]];
      const ql = Math.hypot(...q) || 1;
      for (let a = 0; a < 4; ++a) rotations[o * 4 + a] = q[a] / ql;
      opacities[o] = p.opac ? Math.min(1, Math.max(0, p.opac[i])) : 1;
      if (p.sh) {
        const b = i * p.per * 3;
        for (let c = 0; c < 3; ++c) colorsDC[o * 3 + c] = SH_C0 * p.sh[b + c];
        if (shRest) {
          for (let k = 0; k < K; ++k) {
            for (let c = 0; c < 3; ++c) {
              const v = k + 1 < p.per ? p.sh[b + (k + 1) * 3 + c] : 0;
              shRest[(o * 3 + c) * K + k] = zUp ? v : v * flipSh[k];
            }
          }
        }
      } else if (p.display) {
        for (let c = 0; c < 3; ++c) colorsDC[o * 3 + c] = p.display[i * 3 + c] - 0.5;
      }
    }
  }
  if (zUp && shRest) rotateShRest(shRest, total, K, R_ZUP);
  return makeStaticScene({
    count: total, positions, scales, rotations, opacities, colorsDC, shRest,
    shDegree: per ? Math.round(Math.sqrt(per)) - 1 : 0, sourceFormat: 'usdz',
  });
}

function decodeText(bytes, name) {
  if (bytes.byteLength > TEXT_CEILING) throw new Error(`usdz: "${name}" is ${bytes.byteLength} B, past the ${TEXT_CEILING} B text ceiling`);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!/^#usda\b/.test(text.trimStart())) throw new Error(`usdz: "${name}" does not start with the "#usda" magic line`);
  return text;
}

export async function loadUsdz(buffer, { up } = {}) {
  const bytes = new Uint8Array(buffer);
  if (!(bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    const text = decodeText(bytes, 'usda');
    return decodeLayer(text, up ?? upAxisOf(text) ?? 'y');
  }
  const entries = await readZip(buffer, { wanted: (n) => /\.usd[ac]?$/i.test(n) });
  const layers = [...entries.keys()].filter((n) => /\.usd[ac]?$/i.test(n));
  if (!layers.length) {
    throw new Error(`usdz: the archive contains no .usd/.usda/.usdc layer (entries: ${[...entries.keys()].slice(0, 8).join(', ') || 'none'})`);
  }
  const root = layers[0];
  const data = entries.get(root);
  if (String.fromCharCode(...data.subarray(0, 8)) === 'PXR-USDC') {
    throw new Error(`usdz: "${root}" is a binary USD crate (PXR-USDC), which this reader does not decode. Convert it to ASCII first (\`usdcat -o scene.usda scene.usdc\`) and re-package, or export USDZ with an ASCII root layer.`);
  }
  const text = decodeText(data, root);
  return decodeLayer(text, up ?? upAxisOf(text) ?? 'y');
}
