// Gaussian-splat PLY: the reference 3DGS binary layout, and the PlayCanvas
// "compressed" chunked layout.

import { alloc, checkCount, checkInt, checkPayload } from '../core/limits.js';
import { makeStaticScene, SH_C0 } from '../core/scene.js';
import { degreeForRestCount } from '../core/sh.js';

const TYPE_SIZE = {
  char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

export function parsePlyHeader(bytes) {
  if (bytes.length < 3 || bytes[0] !== 0x70 || bytes[1] !== 0x6c || bytes[2] !== 0x79) {
    throw new Error('ply: bad magic (expected "ply")');
  }
  const dec = new TextDecoder('ascii');
  let text = '';
  let pos = 0;
  let dataStart = -1;
  while (pos < bytes.length) {
    const end = Math.min(pos + 8192, bytes.length);
    text += dec.decode(bytes.subarray(pos, end), { stream: true });
    const at = text.indexOf('end_header\n');
    if (at !== -1) {
      dataStart = at + 'end_header\n'.length;
      text = text.slice(0, at);
      break;
    }
    pos = end;
    if (pos > 1 << 20) throw new Error('ply: header too large or missing "end_header"');
  }
  if (dataStart === -1) throw new Error('ply: "end_header" not found (truncated or not a PLY file)');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const formatLine = lines.find((l) => l.startsWith('format'));
  if (!formatLine) throw new Error('ply: no "format" line in the header');
  const format = formatLine.split(/\s+/)[1] ?? '';
  if (format !== 'binary_little_endian') {
    throw new Error(`ply: only binary_little_endian is supported (this file is "${format}")`);
  }
  const elements = [];
  const comments = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts[0] === 'element') {
      if (elements.length >= 64) throw new Error('ply: implausible element count (> 64)');
      elements.push({
        name: parts[1],
        count: checkInt(`ply element "${parts[1]}" count`, parseInt(parts[2], 10), 0, 2 ** 32 - 1),
        properties: [],
      });
    } else if (parts[0] === 'property') {
      const el = elements[elements.length - 1];
      if (!el) throw new Error('ply: a "property" line appeared before any "element"');
      if (parts[1] === 'list') throw new Error('ply: list properties are not supported for splat data');
      if (el.properties.length >= 4096) throw new Error('ply: implausible property count (> 4096)');
      if (TYPE_SIZE[parts[1]] == null) throw new Error(`ply: unsupported property type "${parts[1]}" on "${parts[2]}"`);
      el.properties.push({ type: parts[1], name: parts[2] });
    } else if (parts[0] === 'comment') {
      comments.push(line.slice(8));
    }
  }
  if (!elements.length) throw new Error('ply: the header declares no elements');
  let offset = dataStart;
  for (const el of elements) {
    el.stride = el.properties.reduce((s, p) => s + TYPE_SIZE[p.type], 0);
    el.offset = offset;
    offset += el.stride * el.count;
  }
  return { elements, dataStart, format, comments };
}

function propertyReader(view, prop) {
  switch (prop.type) {
    case 'float': case 'float32': return (o) => view.getFloat32(o, true);
    case 'double': case 'float64': return (o) => view.getFloat64(o, true);
    case 'uchar': case 'uint8': return (o) => view.getUint8(o);
    case 'char': case 'int8': return (o) => view.getInt8(o);
    case 'ushort': case 'uint16': return (o) => view.getUint16(o, true);
    case 'short': case 'int16': return (o) => view.getInt16(o, true);
    case 'uint': case 'uint32': return (o) => view.getUint32(o, true);
    default: return (o) => view.getInt32(o, true);
  }
}

// --- PlayCanvas compressed PLY ---------------------------------------------

const CHUNK_SIZE = 256;
const CHUNK_PROPS = [
  'min_x', 'min_y', 'min_z', 'max_x', 'max_y', 'max_z',
  'min_scale_x', 'min_scale_y', 'min_scale_z', 'max_scale_x', 'max_scale_y', 'max_scale_z',
  'min_r', 'min_g', 'min_b', 'max_r', 'max_g', 'max_b',
];
const PACKED_PROPS = ['packed_position', 'packed_rotation', 'packed_scale', 'packed_color'];
const SH_BANDS = { 9: 3, 24: 8, 45: 15 };

export function isCompressedPly(elements) {
  if (elements.length < 2) return false;
  const [chunk, vertex] = elements;
  if (chunk.name !== 'chunk' || vertex.name !== 'vertex') return false;
  if (chunk.properties.length !== 12 && chunk.properties.length !== 18) return false;
  if (!chunk.properties.every((p, i) => p.name === CHUNK_PROPS[i] && p.type === 'float')) return false;
  return vertex.properties.length === PACKED_PROPS.length &&
    vertex.properties.every((p, i) => p.name === PACKED_PROPS[i] && p.type === 'uint');
}

const unorm = (v, bits) => {
  const m = (1 << bits) - 1;
  return (v & m) / m;
};
const lerp = (a, b, t) => a * (1 - t) + b * t;

function unpackRotation(v, out) {
  const norm = Math.SQRT2;
  const a = (unorm(v >>> 20, 10) - 0.5) * norm;
  const b = (unorm(v >>> 10, 10) - 0.5) * norm;
  const c = (unorm(v, 10) - 0.5) * norm;
  const m = Math.sqrt(Math.max(0, 1 - (a * a + b * b + c * c)));
  switch (v >>> 30) {
    case 0: out[0] = m; out[1] = a; out[2] = b; out[3] = c; break;
    case 1: out[0] = a; out[1] = m; out[2] = b; out[3] = c; break;
    case 2: out[0] = a; out[1] = b; out[2] = m; out[3] = c; break;
    default: out[0] = a; out[1] = b; out[2] = c; out[3] = m; break;
  }
}

function decodeCompressedPly(bytes, header) {
  const [chunkEl, vertexEl] = header.elements;
  const shEl = header.elements[2]?.name === 'sh' ? header.elements[2] : null;
  const n = checkCount('compressed-ply vertex count', vertexEl.count);
  const chunkProps = chunkEl.properties.length;
  const hasColorRange = chunkProps === 18;
  const expectedChunks = Math.ceil(n / CHUNK_SIZE);
  if (chunkEl.count !== expectedChunks) {
    throw new Error(`compressed-ply: ${n} splats need ${expectedChunks} chunks of ${CHUNK_SIZE}, but the header declares ${chunkEl.count}`);
  }
  let K = 0;
  if (shEl) {
    K = SH_BANDS[shEl.properties.length];
    if (!K) {
      throw new Error(`compressed-ply: the sh element has ${shEl.properties.length} properties (expected 9, 24 or 45 — 1, 2 or 3 SH bands)`);
    }
    if (!shEl.properties.every((p, i) => p.name === `f_rest_${i}` && p.type === 'uchar')) {
      throw new Error('compressed-ply: the sh element must be uchar f_rest_0..N');
    }
    if (shEl.count !== n) throw new Error(`compressed-ply: the sh element has ${shEl.count} rows but there are ${n} splats`);
  }
  const chunkBytes = chunkEl.count * chunkProps * 4;
  const vertexBytes = n * 16;
  const shBytes = shEl ? n * K * 3 : 0;
  checkPayload('compressed-ply body', chunkBytes + vertexBytes + shBytes, bytes.byteLength - header.dataStart);
  const view = new DataView(bytes.buffer, bytes.byteOffset + header.dataStart, chunkBytes + vertexBytes + shBytes);
  const chunk = (c, k) => view.getFloat32((c * chunkProps + k) * 4, true);
  const packed = (i, k) => view.getUint32(chunkBytes + (i * 4 + k) * 4, true);

  const positions = alloc('compressed-ply positions', Float32Array, n * 3);
  const scales = alloc('compressed-ply scales', Float32Array, n * 3);
  const rotations = alloc('compressed-ply rotations', Float32Array, n * 4);
  const opacities = alloc('compressed-ply opacities', Float32Array, n);
  const colorsDC = alloc('compressed-ply colors', Float32Array, n * 3);
  const shRest = K ? alloc('compressed-ply shRest', Float32Array, n * K * 3) : null;
  const q = [0, 0, 0, 0];
  for (let i = 0; i < n; ++i) {
    const c = Math.floor(i / CHUNK_SIZE);
    const p = packed(i, 0);
    positions[i * 3] = lerp(chunk(c, 0), chunk(c, 3), unorm(p >>> 21, 11));
    positions[i * 3 + 1] = lerp(chunk(c, 1), chunk(c, 4), unorm(p >>> 11, 10));
    positions[i * 3 + 2] = lerp(chunk(c, 2), chunk(c, 5), unorm(p, 11));
    unpackRotation(packed(i, 1), q);
    const ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    rotations[i * 4] = q[0] / ql;
    rotations[i * 4 + 1] = q[1] / ql;
    rotations[i * 4 + 2] = q[2] / ql;
    rotations[i * 4 + 3] = q[3] / ql;
    const s = packed(i, 2);
    scales[i * 3] = Math.exp(lerp(chunk(c, 6), chunk(c, 9), unorm(s >>> 21, 11)));
    scales[i * 3 + 1] = Math.exp(lerp(chunk(c, 7), chunk(c, 10), unorm(s >>> 11, 10)));
    scales[i * 3 + 2] = Math.exp(lerp(chunk(c, 8), chunk(c, 11), unorm(s, 11)));
    const col = packed(i, 3);
    let r = unorm(col >>> 24, 8), g = unorm(col >>> 16, 8), b = unorm(col >>> 8, 8);
    if (hasColorRange) {
      r = lerp(chunk(c, 12), chunk(c, 15), r);
      g = lerp(chunk(c, 13), chunk(c, 16), g);
      b = lerp(chunk(c, 14), chunk(c, 17), b);
    }
    colorsDC[i * 3] = r - 0.5;
    colorsDC[i * 3 + 1] = g - 0.5;
    colorsDC[i * 3 + 2] = b - 0.5;
    opacities[i] = unorm(col, 8);
    if (shRest) {
      const base = chunkBytes + vertexBytes + i * K * 3;
      for (let ch = 0; ch < 3; ++ch) {
        for (let k = 0; k < K; ++k) {
          shRest[(i * 3 + ch) * K + k] = view.getUint8(base + ch * K + k) * (8 / 255) - 4;
        }
      }
    }
  }
  return makeStaticScene({
    count: n, positions, scales, rotations, opacities, colorsDC, shRest,
    shDegree: degreeForRestCount(K), sourceFormat: 'ply-compressed',
  });
}

// --- reference 3DGS PLY ----------------------------------------------------

const REQUIRED = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2',
  'rot_0', 'rot_1', 'rot_2', 'rot_3'];

export function loadPly(buffer) {
  const bytes = new Uint8Array(buffer);
  const header = parsePlyHeader(bytes);
  if (isCompressedPly(header.elements)) return decodeCompressedPly(bytes, header);
  const vertex = header.elements.find((e) => e.name === 'vertex');
  if (!vertex) throw new Error('ply: no "vertex" element — not a Gaussian-splat PLY');
  const n = checkCount('ply vertex count', vertex.count);
  const missing = REQUIRED.filter((name) => !vertex.properties.some((p) => p.name === name));
  if (missing.length) {
    throw new Error(`ply: missing ${missing.join(', ')} — not a Gaussian-splat PLY (a mesh or point-cloud PLY will not render as splats)`);
  }
  checkPayload('ply vertex data', vertex.offset - header.dataStart + n * vertex.stride, bytes.byteLength - header.dataStart);
  const props = vertex.properties;
  const np = props.length;
  const col = Object.fromEntries(props.map((p, i) => [p.name, i]));
  const rest = props
    .filter((p) => /^f_rest_\d+$/.test(p.name))
    .sort((a, b) => parseInt(a.name.slice(7), 10) - parseInt(b.name.slice(7), 10))
    .map((p) => col[p.name]);
  const K = Math.floor(rest.length / 3);
  const degree = degreeForRestCount(K);
  const Kused = (degree + 1) * (degree + 1) - 1;

  const positions = alloc('ply positions', Float32Array, n * 3);
  const scales = alloc('ply scales', Float32Array, n * 3);
  const rotations = alloc('ply rotations', Float32Array, n * 4);
  const opacities = alloc('ply opacities', Float32Array, n);
  const colorsDC = alloc('ply colors', Float32Array, n * 3);
  const shRest = Kused ? alloc('ply shRest', Float32Array, n * Kused * 3) : null;

  // Rows are copied block by block into an aligned float scratch: the header
  // length leaves the body at an arbitrary byte offset.
  const allFloat = props.every((p) => p.type === 'float' || p.type === 'float32');
  const BLOCK = 65536;
  const rows = new Float32Array(BLOCK * np);
  const rowBytes = new Uint8Array(rows.buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readers = props.map((p) => propertyReader(view, p));
  const offsets = [];
  props.reduce((o, p) => (offsets.push(o), o + TYPE_SIZE[p.type]), 0);
  const [cx, cy, cz] = [col.x, col.y, col.z];
  const [cs0, cs1, cs2] = [col.scale_0, col.scale_1, col.scale_2];
  const [cr0, cr1, cr2, cr3] = [col.rot_0, col.rot_1, col.rot_2, col.rot_3];
  const [cop, cd0, cd1, cd2] = [col.opacity, col.f_dc_0, col.f_dc_1, col.f_dc_2];
  for (let start = 0; start < n; start += BLOCK) {
    const cnt = Math.min(BLOCK, n - start);
    const src = vertex.offset + start * vertex.stride;
    if (allFloat) {
      rowBytes.set(bytes.subarray(src, src + cnt * vertex.stride));
    } else {
      for (let j = 0; j < cnt; ++j) {
        const base = src + j * vertex.stride;
        for (let k = 0; k < np; ++k) rows[j * np + k] = readers[k](base + offsets[k]);
      }
    }
    for (let j = 0; j < cnt; ++j) {
      const r = j * np, i = start + j;
      positions[i * 3] = rows[r + cx];
      positions[i * 3 + 1] = rows[r + cy];
      positions[i * 3 + 2] = rows[r + cz];
      scales[i * 3] = Math.exp(rows[r + cs0]);
      scales[i * 3 + 1] = Math.exp(rows[r + cs1]);
      scales[i * 3 + 2] = Math.exp(rows[r + cs2]);
      const w = rows[r + cr0], x = rows[r + cr1], y = rows[r + cr2], z = rows[r + cr3];
      const l = Math.hypot(w, x, y, z) || 1;
      rotations[i * 4] = w / l;
      rotations[i * 4 + 1] = x / l;
      rotations[i * 4 + 2] = y / l;
      rotations[i * 4 + 3] = z / l;
      opacities[i] = 1 / (1 + Math.exp(-rows[r + cop]));
      colorsDC[i * 3] = SH_C0 * rows[r + cd0];
      colorsDC[i * 3 + 1] = SH_C0 * rows[r + cd1];
      colorsDC[i * 3 + 2] = SH_C0 * rows[r + cd2];
      if (shRest) {
        // File order is channel-major: f_rest_[c*K + k].
        for (let c = 0; c < 3; ++c) {
          const dst = (i * 3 + c) * Kused;
          for (let k = 0; k < Kused; ++k) shRest[dst + k] = rows[r + rest[c * K + k]];
        }
      }
    }
  }
  const warnings = [];
  if (K > Kused) warnings.push(`SH beyond degree 3 is ignored (${K} rest coefficients per channel).`);
  return makeStaticScene({
    count: n, positions, scales, rotations, opacities, colorsDC, shRest,
    shDegree: degree, sourceFormat: 'ply', warnings,
  });
}
