// Scene placement chosen in the viewer: a rotation (degrees about x, then y,
// then z), a translation and a uniform scale, applied on top of the file's
// own frame (+x right, +y down, +z forward). It is folded into the view
// matrix for drawing and sorting, and baked into exports.

import { quatMul, rotateShRest } from './sh.js';
import { makeStaticScene } from './scene.js';

export const IDENTITY_XF = Object.freeze({ rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, tz: 0, s: 1 });

// Rotations that bring common source conventions into the viewer frame.
export const UP_PRESETS = {
  'y-down': { label: 'Y down', hint: '3DGS / COLMAP (default)', rx: 0, ry: 0, rz: 0 },
  'y-up': { label: 'Y up', hint: 'glTF / three.js', rx: 180, ry: 0, rz: 0 },
  'z-up': { label: 'Z up', hint: 'Blender / USD / CAD', rx: 90, ry: 0, rz: 0 },
  'z-down': { label: 'Z down', hint: 'some scanners', rx: -90, ry: 0, rz: 0 },
};

export const cloneXf = (xf) => ({ ...IDENTITY_XF, ...xf });

export function isIdentityXf(xf) {
  return !xf || (xf.rx === 0 && xf.ry === 0 && xf.rz === 0 && xf.tx === 0 && xf.ty === 0 && xf.tz === 0 && xf.s === 1);
}

const rad = (d) => (d * Math.PI) / 180;

// R = Rz · Ry · Rx, row-major 3x3.
export function rotationMatrix(xf) {
  const cx = Math.cos(rad(xf.rx)), sx = Math.sin(rad(xf.rx));
  const cy = Math.cos(rad(xf.ry)), sy = Math.sin(rad(xf.ry));
  const cz = Math.cos(rad(xf.rz)), sz = Math.sin(rad(xf.rz));
  const snap = (v) => (Math.abs(v) < 1e-12 ? 0 : v);
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ].map(snap);
}

// Unit quaternion (w x y z) of the same rotation.
export function rotationQuat(xf) {
  const h = (d) => rad(d) / 2;
  const qx = [Math.cos(h(xf.rx)), Math.sin(h(xf.rx)), 0, 0];
  const qy = [Math.cos(h(xf.ry)), 0, Math.sin(h(xf.ry)), 0];
  const qz = [Math.cos(h(xf.rz)), 0, 0, Math.sin(h(xf.rz))];
  return quatMul(qz, quatMul(qy, qx));
}

// Row-major 4x4: p_world = s · R · p + t.
export function modelMatrix(xf) {
  const R = rotationMatrix(xf), s = xf.s;
  return Float32Array.from([
    s * R[0], s * R[1], s * R[2], xf.tx,
    s * R[3], s * R[4], s * R[5], xf.ty,
    s * R[6], s * R[7], s * R[8], xf.tz,
    0, 0, 0, 1,
  ]);
}

export function applyXf(xf, p) {
  const R = rotationMatrix(xf), s = xf.s;
  return [
    s * (R[0] * p[0] + R[1] * p[1] + R[2] * p[2]) + xf.tx,
    s * (R[3] * p[0] + R[4] * p[1] + R[5] * p[2]) + xf.ty,
    s * (R[6] * p[0] + R[7] * p[1] + R[8] * p[2]) + xf.tz,
  ];
}

export function applyXfDirection(xf, d) {
  const R = rotationMatrix(xf);
  return [R[0] * d[0] + R[1] * d[1] + R[2] * d[2], R[3] * d[0] + R[4] * d[1] + R[5] * d[2], R[6] * d[0] + R[7] * d[1] + R[8] * d[2]];
}

export function unapplyXf(xf, p) {
  const R = rotationMatrix(xf), s = xf.s || 1;
  const d = [p[0] - xf.tx, p[1] - xf.ty, p[2] - xf.tz];
  return [
    (R[0] * d[0] + R[3] * d[1] + R[6] * d[2]) / s,
    (R[1] * d[0] + R[4] * d[1] + R[7] * d[2]) / s,
    (R[2] * d[0] + R[5] * d[1] + R[8] * d[2]) / s,
  ];
}

// URL form: ?xf=rx,ry,rz,tx,ty,tz,s
export function encodeXf(xf) {
  const r = (v, k) => String(Math.round(v * k) / k);
  return [r(xf.rx, 100), r(xf.ry, 100), r(xf.rz, 100), r(xf.tx, 1e4), r(xf.ty, 1e4), r(xf.tz, 1e4), r(xf.s, 1e4)].join(',');
}

export function decodeXf(text) {
  if (typeof text !== 'string' || !text) return null;
  const v = text.split(',').map(Number);
  if (v.length !== 7 || !v.every(Number.isFinite) || !(v[6] > 0)) return null;
  return { rx: v[0], ry: v[1], rz: v[2], tx: v[3], ty: v[4], tz: v[5], s: v[6] };
}

// scenes.json form: { rotate: [x, y, z], translate: [x, y, z], scale: s }
export function xfFromManifest(t) {
  if (!t || typeof t !== 'object') return null;
  const r = Array.isArray(t.rotate) ? t.rotate : [0, 0, 0];
  const p = Array.isArray(t.translate) ? t.translate : [0, 0, 0];
  const xf = { rx: +r[0] || 0, ry: +r[1] || 0, rz: +r[2] || 0, tx: +p[0] || 0, ty: +p[1] || 0, tz: +p[2] || 0, s: +t.scale > 0 ? +t.scale : 1 };
  return isIdentityXf(xf) ? null : xf;
}

export function xfToManifest(xf) {
  if (isIdentityXf(xf)) return null;
  return { rotate: [xf.rx, xf.ry, xf.rz], translate: [xf.tx, xf.ty, xf.tz], scale: xf.s };
}

// Bakes the placement into a static scene (for export): positions, splat
// rotations and sizes, and the view-dependent colour bands.
export function transformStaticScene(scene, xf) {
  if (isIdentityXf(xf)) return scene;
  const { count: n } = scene;
  const R = rotationMatrix(xf), q = rotationQuat(xf), s = xf.s;
  const positions = new Float32Array(n * 3);
  const rotations = new Float32Array(n * 4);
  const scales = new Float32Array(n * 3);
  for (let i = 0; i < n; ++i) {
    const x = scene.positions[i * 3], y = scene.positions[i * 3 + 1], z = scene.positions[i * 3 + 2];
    positions[i * 3] = s * (R[0] * x + R[1] * y + R[2] * z) + xf.tx;
    positions[i * 3 + 1] = s * (R[3] * x + R[4] * y + R[5] * z) + xf.ty;
    positions[i * 3 + 2] = s * (R[6] * x + R[7] * y + R[8] * z) + xf.tz;
    const r = quatMul(q, [scene.rotations[i * 4], scene.rotations[i * 4 + 1], scene.rotations[i * 4 + 2], scene.rotations[i * 4 + 3]]);
    rotations.set(r, i * 4);
    for (let a = 0; a < 3; ++a) scales[i * 3 + a] = scene.scales[i * 3 + a] * s;
  }
  const shRest = scene.shRest ? scene.shRest.slice() : null;
  if (shRest && scene.shDegree > 0) rotateShRest(shRest, n, shRest.length / n / 3, R);
  return makeStaticScene({
    count: n, positions, rotations, scales, opacities: scene.opacities, colorsDC: scene.colorsDC,
    shRest, shDegree: scene.shDegree, sourceFormat: scene.sourceFormat,
  });
}
