// Static scene -> reference 3DGS PLY, or GLB with KHR_gaussian_splatting.

import { SH_C0 } from '../core/scene.js';
import { FLIP_LUF_TO_RDF } from '../core/sh.js';
import { MAGIC } from '../core/formats.js';

const logit = (p) => {
  const x = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(x / (1 - x));
};

export function sceneToPLY(scene) {
  const { count: n, positions, scales, rotations, opacities, colorsDC, shRest } = scene;
  const K = shRest ? shRest.length / Math.max(n, 1) / 3 : 0;
  const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
  for (let k = 0; k < K * 3; ++k) props.push(`f_rest_${k}`);
  props.push('opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3');
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n` +
    props.map((p) => `property float ${p}\n`).join('') + 'end_header\n';
  const stride = props.length;
  const body = new Float32Array(n * stride);
  for (let i = 0; i < n; ++i) {
    const o = i * stride;
    body[o] = positions[i * 3];
    body[o + 1] = positions[i * 3 + 1];
    body[o + 2] = positions[i * 3 + 2];
    for (let c = 0; c < 3; ++c) body[o + 6 + c] = colorsDC[i * 3 + c] / SH_C0;
    for (let k = 0; k < K * 3; ++k) body[o + 9 + k] = shRest[i * K * 3 + k];
    const r = o + 9 + K * 3;
    body[r] = logit(opacities[i]);
    for (let c = 0; c < 3; ++c) body[r + 1 + c] = Math.log(Math.max(scales[i * 3 + c], 1e-12));
    for (let c = 0; c < 4; ++c) body[r + 4 + c] = rotations[i * 4 + c];
  }
  return new Blob([header, body], { type: 'application/octet-stream' });
}

const BANDS = [1, 3, 5, 7];
const KHR = 'KHR_gaussian_splatting';

export function sceneToGLB(scene, { includeSH = true, generator = '4D Viewer · TableGo' } = {}) {
  const { count: n, positions, scales, rotations, opacities, colorsDC, shRest } = scene;
  if (!n) throw new Error('export-gltf: the scene has no splats to write');
  const K = shRest ? shRest.length / n / 3 : 0;
  let degree = 0;
  if (includeSH) {
    let used = 0;
    for (let l = 1; l < BANDS.length && used + BANDS[l] <= K; ++l) {
      used += BANDS[l];
      degree = l;
    }
  }
  const { flipP, flipQ, flipSh } = FLIP_LUF_TO_RDF; // the flips are their own inverse
  const pos = new Float32Array(n * 3), rot = new Float32Array(n * 4), scl = new Float32Array(n * 3);
  const opa = new Float32Array(n), dc = new Float32Array(n * 3);
  const rest = [];
  for (let l = 1; l <= degree; ++l) for (let k = 0; k < BANDS[l]; ++k) rest.push({ l, k, data: new Float32Array(n * 3) });
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; ++i) {
    for (let a = 0; a < 3; ++a) {
      const v = positions[i * 3 + a] * flipP[a];
      pos[i * 3 + a] = v;
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
      scl[i * 3 + a] = Math.max(0, scales[i * 3 + a]);
      dc[i * 3 + a] = colorsDC[i * 3 + a] / SH_C0;
    }
    rot[i * 4] = rotations[i * 4 + 1] * flipQ[0];
    rot[i * 4 + 1] = rotations[i * 4 + 2] * flipQ[1];
    rot[i * 4 + 2] = rotations[i * 4 + 3] * flipQ[2];
    rot[i * 4 + 3] = rotations[i * 4];
    opa[i] = Math.min(1, Math.max(0, opacities[i]));
    rest.forEach((r, k) => {
      for (let c = 0; c < 3; ++c) r.data[i * 3 + c] = shRest[(i * 3 + c) * K + k] * flipSh[k];
    });
  }
  const attrs = [
    { name: 'POSITION', data: pos, type: 'VEC3', min, max },
    { name: `${KHR}:ROTATION`, data: rot, type: 'VEC4' },
    { name: `${KHR}:SCALE`, data: scl, type: 'VEC3' },
    { name: `${KHR}:OPACITY`, data: opa, type: 'SCALAR' },
    { name: `${KHR}:SH_DEGREE_0_COEF_0`, data: dc, type: 'VEC3' },
    ...rest.map((r) => ({ name: `${KHR}:SH_DEGREE_${r.l}_COEF_${r.k}`, data: r.data, type: 'VEC3' })),
  ];
  const bufferViews = [], accessors = [], attributes = {}, parts = [];
  let offset = 0;
  for (const a of attrs) {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: a.data.byteLength });
    const acc = { bufferView: bufferViews.length - 1, componentType: 5126, count: n, type: a.type };
    if (a.min) {
      acc.min = a.min;
      acc.max = a.max;
    }
    accessors.push(acc);
    attributes[a.name] = accessors.length - 1;
    parts.push(new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength));
    offset += a.data.byteLength;
  }
  const json = {
    asset: { version: '2.0', generator },
    extensionsUsed: [KHR],
    extensionsRequired: [KHR],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'splats' }],
    meshes: [{ primitives: [{ attributes, mode: 0, extensions: { [KHR]: {} } }] }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.byteLength + jsonPad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const binPad = (4 - (offset % 4)) % 4;
  const total = 12 + 8 + jsonBytes.byteLength + 8 + offset + binPad;
  const head = new DataView(new ArrayBuffer(20));
  head.setUint32(0, MAGIC.GLB, true);
  head.setUint32(4, 2, true);
  head.setUint32(8, total, true);
  head.setUint32(12, jsonBytes.byteLength, true);
  head.setUint32(16, 0x4e4f534a, true);
  const binHead = new DataView(new ArrayBuffer(8));
  binHead.setUint32(0, offset + binPad, true);
  binHead.setUint32(4, 0x004e4942, true);
  return new Blob([head, jsonBytes, binHead, ...parts, new Uint8Array(binPad)], { type: 'model/gltf-binary' });
}
