// glTF 2.0 / GLB with KHR_gaussian_splatting point primitives. glTF is
// left-up-front from the splat's point of view; the viewer frame is
// right-down-front, so x and y flip (positions, quaternions, SH).

import { alloc, checkInt, checkPayload, LIMITS } from '../core/limits.js';
import { makeStaticScene, SH_C0 } from '../core/scene.js';
import { FLIP_LUF_TO_RDF, quatMul } from '../core/sh.js';
import { MAGIC } from '../core/formats.js';

export const KHR = 'KHR_gaussian_splatting';
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const COMPONENT = {
  5120: { size: 1, signed: true, get: (v, o) => v.getInt8(o) },
  5121: { size: 1, signed: false, get: (v, o) => v.getUint8(o) },
  5122: { size: 2, signed: true, get: (v, o) => v.getInt16(o, true) },
  5123: { size: 2, signed: false, get: (v, o) => v.getUint16(o, true) },
  5125: { size: 4, signed: false, get: (v, o) => v.getUint32(o, true) },
  5126: { size: 4, signed: false, get: (v, o) => v.getFloat32(o, true) },
};
const ELEMENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function base64Bytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; ++i) out[i] = bin.charCodeAt(i);
  return out;
}

async function resolveUri(uri, sourceUrl) {
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    const head = uri.slice(5, comma), body = uri.slice(comma + 1);
    return head.includes('base64') ? base64Bytes(body) : new TextEncoder().encode(decodeURIComponent(body));
  }
  if (!sourceUrl) {
    throw new Error(`gltf: external buffer "${uri}" cannot be resolved for a local file — use a self-contained .glb or a data-URI .gltf`);
  }
  const res = await fetch(new URL(uri, sourceUrl));
  if (!res.ok) throw new Error(`gltf: failed to fetch "${uri}": ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function parseGltfContainer(buffer, sourceUrl) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let json;
  let bin = null;
  if (bytes.length >= 12 && view.getUint32(0, true) === MAGIC.GLB) {
    const total = view.getUint32(8, true);
    if (total > bytes.length) throw new Error('glb: declared length exceeds the file size');
    let p = 12;
    let chunks = 0;
    let jsonBytes = null;
    while (p + 8 <= total) {
      if (++chunks > 64) throw new Error('glb: implausible chunk count');
      const len = view.getUint32(p, true), type = view.getUint32(p + 4, true);
      if (p + 8 + len > total) throw new Error('glb: a chunk runs past the end of the file');
      const data = bytes.subarray(p + 8, p + 8 + len);
      if (type === CHUNK_JSON) jsonBytes = data;
      else if (type === CHUNK_BIN && !bin) bin = data;
      p += 8 + len + ((4 - (len % 4)) % 4);
    }
    if (!jsonBytes) throw new Error('glb: no JSON chunk found');
    json = JSON.parse(new TextDecoder().decode(jsonBytes));
  } else {
    json = JSON.parse(new TextDecoder().decode(bytes));
  }
  const buffers = await Promise.all((json.buffers || []).map(async (b, i) => {
    if (b.uri) return resolveUri(b.uri, sourceUrl);
    if (i === 0 && bin) return bin;
    throw new Error(`gltf: buffer ${i} has no uri and is not the GLB-embedded buffer`);
  }));
  const readAccessor = (index) => {
    const acc = json.accessors?.[index];
    if (!acc) throw new Error(`gltf: accessor ${index} does not exist`);
    const comps = ELEMENTS[acc.type];
    if (!comps) throw new Error(`gltf: unsupported accessor type "${acc.type}"`);
    const ct = COMPONENT[acc.componentType];
    if (!ct) throw new Error(`gltf: unsupported componentType ${acc.componentType}`);
    checkInt(`gltf accessor[${index}].count`, acc.count, 0, LIMITS.MAX_SPLATS);
    const out = alloc(`gltf accessor[${index}]`, Float32Array, acc.count * comps);
    if (acc.bufferView == null) return out;
    const bv = json.bufferViews?.[acc.bufferView];
    if (!bv) throw new Error(`gltf: bufferView ${acc.bufferView} does not exist`);
    const buf = buffers[bv.buffer];
    if (!buf) throw new Error(`gltf: buffer ${bv.buffer} does not exist`);
    const elem = ct.size * comps;
    const stride = bv.byteStride || elem;
    const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    checkPayload(`gltf accessor[${index}] data`, acc.count > 0 ? start + (acc.count - 1) * stride + elem : start, buf.byteLength);
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const maxInt = ct.signed ? 2 ** (ct.size * 8 - 1) - 1 : 2 ** (ct.size * 8) - 1;
    for (let i = 0; i < acc.count; ++i) {
      for (let c = 0; c < comps; ++c) {
        let x = ct.get(v, start + i * stride + c * ct.size);
        if (acc.normalized) x = Math.max(x / maxInt, ct.signed ? -1 : 0);
        out[i * comps + c] = x;
      }
    }
    return out;
  };
  return { json, readAccessor };
}

// Node TRS (or matrix) -> { t, r (x y z w), s }.
function nodeTRS(node) {
  if (node.matrix) {
    const m = node.matrix;
    const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
    const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx;
    const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
    const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
    const tr = r00 + r11 + r22;
    let x, y, z, w;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      w = 0.25 * s; x = (r21 - r12) / s; y = (r02 - r20) / s; z = (r10 - r01) / s;
    } else if (r00 > r11 && r00 > r22) {
      const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
      w = (r21 - r12) / s; x = 0.25 * s; y = (r01 + r10) / s; z = (r02 + r20) / s;
    } else if (r11 > r22) {
      const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
      w = (r02 - r20) / s; x = (r01 + r10) / s; y = 0.25 * s; z = (r12 + r21) / s;
    } else {
      const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
      w = (r10 - r01) / s; x = (r02 + r20) / s; y = (r12 + r21) / s; z = 0.25 * s;
    }
    return { t: [m[12], m[13], m[14]], r: [x, y, z, w], s: [sx, sy, sz] };
  }
  return { t: node.translation || [0, 0, 0], r: node.rotation || [0, 0, 0, 1], s: node.scale || [1, 1, 1] };
}

const xyzwToWxyz = (q) => [q[3], q[0], q[1], q[2]];
const wxyzToXyzw = (q) => [q[1], q[2], q[3], q[0]];

function rotate(v, q) { // q in x y z w
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

export async function loadGltf(buffer, sourceUrl) {
  const { json, readAccessor } = await parseGltfContainer(buffer, sourceUrl);
  if (!(json.extensionsUsed || []).includes(KHR)) {
    throw new Error(`gltf: does not declare "${KHR}" in extensionsUsed — not a Gaussian-splat glTF`);
  }
  const required = json.extensionsRequired || [];
  const compressed = [...new Set([...(json.extensionsUsed || []), ...required])]
    .filter((e) => e !== KHR && /gaussian_splatting.*compress|compress.*gaussian/i.test(e));
  if (compressed.length) {
    throw new Error(`gltf: this asset requires ${compressed.join(', ')}, a splat compression extension not in the Khronos registry. Re-export with plain ${KHR} attributes, or use SPZ / compressed PLY.`);
  }
  const unknown = required.filter((e) => e !== KHR);
  if (unknown.length) throw new Error(`gltf: required extension(s) not implemented here: ${unknown.join(', ')}`);

  const nodes = json.nodes || [];
  checkInt('gltf node count', nodes.length, 0, LIMITS.MAX_GLTF_NODES);
  const world = new Array(nodes.length);
  const seen = new Uint8Array(nodes.length);
  const visit = (i, t, r, s, depth) => {
    if (!Number.isInteger(i) || i < 0 || i >= nodes.length || seen[i]) return;
    if (depth > LIMITS.MAX_GLTF_DEPTH) throw new Error(`gltf: node graph deeper than ${LIMITS.MAX_GLTF_DEPTH}`);
    seen[i] = 1;
    const local = nodeTRS(nodes[i]);
    const rr = wxyzToXyzw(quatMul(xyzwToWxyz(r), xyzwToWxyz(local.r)));
    const ss = [s[0] * local.s[0], s[1] * local.s[1], s[2] * local.s[2]];
    const off = rotate([local.t[0] * s[0], local.t[1] * s[1], local.t[2] * s[2]], r);
    const tt = [t[0] + off[0], t[1] + off[1], t[2] + off[2]];
    world[i] = { t: tt, r: rr, s: ss };
    for (const c of nodes[i].children || []) visit(c, tt, rr, ss, depth + 1);
  };
  const roots = json.scenes?.[json.scene ?? 0]?.nodes || [];
  for (const i of roots) visit(i, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1], 0);

  const prims = [];
  nodes.forEach((node, i) => {
    if (node.mesh == null) return;
    for (const prim of json.meshes?.[node.mesh]?.primitives || []) {
      if (!prim.extensions?.[KHR] || (prim.mode != null && prim.mode !== 0)) continue;
      prims.push({ prim, world: world[i] || { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] } });
    }
  });
  if (!prims.length) throw new Error(`gltf: no primitive uses the "${KHR}" extension`);

  let total = 0;
  const parts = prims.map(({ prim, world: w }) => {
    const a = prim.attributes || {};
    if (a.POSITION == null) throw new Error('gltf: a splat primitive has no POSITION attribute');
    const position = readAccessor(a.POSITION);
    const get = (name) => (a[`${KHR}:${name}`] != null ? readAccessor(a[`${KHR}:${name}`]) : new Float32Array(0));
    const rest = [];
    for (let l = 1; l <= 3; ++l) {
      const names = [];
      for (let k = 0; k < 2 * l + 1; ++k) names.push(`${KHR}:SH_DEGREE_${l}_COEF_${k}`);
      if (!names.every((nm) => nm in a)) break;
      rest.push(...names.map((nm) => readAccessor(a[nm])));
    }
    const count = position.length / 3;
    total += count;
    return { count, position, scale: get('SCALE'), rotation: get('ROTATION'), opacity: get('OPACITY'), sh0: get('SH_DEGREE_0_COEF_0'), rest, world: w };
  });
  checkInt('gltf total splats', total, 0, LIMITS.MAX_SPLATS);
  const K = Math.max(0, ...parts.map((p) => p.rest.length));
  const positions = alloc('gltf positions', Float32Array, total * 3);
  const scales = alloc('gltf scales', Float32Array, total * 3);
  const rotations = alloc('gltf rotations', Float32Array, total * 4);
  const opacities = alloc('gltf opacities', Float32Array, total);
  const colorsDC = alloc('gltf colors', Float32Array, total * 3);
  const shRest = K ? alloc('gltf shRest', Float32Array, total * K * 3) : null;
  const { flipP, flipQ, flipSh } = FLIP_LUF_TO_RDF;
  let o = 0;
  for (const p of parts) {
    const { t, r, s } = p.world;
    for (let i = 0; i < p.count; ++i, ++o) {
      const local = [p.position[i * 3] * s[0], p.position[i * 3 + 1] * s[1], p.position[i * 3 + 2] * s[2]];
      const rp = rotate(local, r);
      for (let a = 0; a < 3; ++a) positions[o * 3 + a] = (t[a] + rp[a]) * flipP[a];
      const qLocal = p.rotation.length ? [p.rotation[i * 4], p.rotation[i * 4 + 1], p.rotation[i * 4 + 2], p.rotation[i * 4 + 3]] : [0, 0, 0, 1];
      const q = wxyzToXyzw(quatMul(xyzwToWxyz(r), xyzwToWxyz(qLocal)));
      const ql = Math.hypot(...q) || 1;
      rotations[o * 4] = q[3] / ql;
      rotations[o * 4 + 1] = (q[0] / ql) * flipQ[0];
      rotations[o * 4 + 2] = (q[1] / ql) * flipQ[1];
      rotations[o * 4 + 3] = (q[2] / ql) * flipQ[2];
      for (let a = 0; a < 3; ++a) {
        scales[o * 3 + a] = (p.scale.length ? p.scale[i * 3 + a] : 0.01) * s[a];
        colorsDC[o * 3 + a] = SH_C0 * (p.sh0.length ? p.sh0[i * 3 + a] : 0);
      }
      opacities[o] = p.opacity.length ? p.opacity[i] : 1;
      if (shRest) {
        for (let k = 0; k < p.rest.length && k < K; ++k) {
          for (let c = 0; c < 3; ++c) shRest[(o * 3 + c) * K + k] = p.rest[k][i * 3 + c] * flipSh[k];
        }
      }
    }
  }
  return makeStaticScene({
    count: total, positions, scales, rotations, opacities, colorsDC, shRest,
    shDegree: K >= 15 ? 3 : K >= 8 ? 2 : K >= 3 ? 1 : 0, sourceFormat: 'gltf',
  });
}
