// Freezes a 4D scene at time t into a static scene: positions moved to t,
// opacity × temporal gate, Σ split into scale + rotation, and every SH band
// evaluated at t across the Fourier orders.

import { halfTable } from '../core/half.js';
import { makeStaticScene, SH_C0, isStaticSplat } from '../core/scene.js';

// Jacobi eigen-decomposition of a symmetric 3x3 [xx xy xz yy yz zz].
function eigenSym(s, values, vectors) {
  const a = [[s[0], s[1], s[2]], [s[1], s[3], s[4]], [s[2], s[4], s[5]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; ++sweep) {
    if (Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]) < 1e-30) break;
    for (let p = 0; p < 2; ++p) {
      for (let q = p + 1; q < 3; ++q) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
        for (let k = 0; k < 3; ++k) {
          const x = a[k][p], y = a[k][q];
          a[k][p] = c * x - sn * y;
          a[k][q] = sn * x + c * y;
        }
        for (let k = 0; k < 3; ++k) {
          const x = a[p][k], y = a[q][k];
          a[p][k] = c * x - sn * y;
          a[q][k] = sn * x + c * y;
          const vx = v[k][p], vy = v[k][q];
          v[k][p] = c * vx - sn * vy;
          v[k][q] = sn * vx + c * vy;
        }
      }
    }
  }
  for (let k = 0; k < 3; ++k) {
    values[k] = Math.max(a[k][k], 1e-30);
    for (let r = 0; r < 3; ++r) vectors[r][k] = v[r][k];
  }
  const det = vectors[0][0] * (vectors[1][1] * vectors[2][2] - vectors[1][2] * vectors[2][1]) -
    vectors[0][1] * (vectors[1][0] * vectors[2][2] - vectors[1][2] * vectors[2][0]) +
    vectors[0][2] * (vectors[1][0] * vectors[2][1] - vectors[1][1] * vectors[2][0]);
  if (det < 0) for (let r = 0; r < 3; ++r) vectors[r][2] = -vectors[r][2];
}

// Rotation matrix (columns = axes) -> unit quaternion w x y z with w >= 0.
function matToQuat(m, q) {
  const tr = m[0][0] + m[1][1] + m[2][2];
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q[0] = 0.25 * s; q[1] = (m[2][1] - m[1][2]) / s; q[2] = (m[0][2] - m[2][0]) / s; q[3] = (m[1][0] - m[0][1]) / s;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    q[0] = (m[2][1] - m[1][2]) / s; q[1] = 0.25 * s; q[2] = (m[0][1] + m[1][0]) / s; q[3] = (m[0][2] + m[2][0]) / s;
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    q[0] = (m[0][2] - m[2][0]) / s; q[1] = (m[0][1] + m[1][0]) / s; q[2] = 0.25 * s; q[3] = (m[1][2] + m[2][1]) / s;
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    q[0] = (m[1][0] - m[0][1]) / s; q[1] = (m[0][2] + m[2][0]) / s; q[2] = (m[1][2] + m[2][1]) / s; q[3] = 0.25 * s;
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]) * (q[0] < 0 ? -1 : 1);
  for (let k = 0; k < 4; ++k) q[k] /= l;
}

export function sliceAt(scene, t, cut = 1 / 255) {
  const { count, geo, sht, shF, shB, duration } = scene;
  const half = halfTable();
  const K = shB - 1;
  const keep = new Int32Array(count);
  let n = 0;
  for (let i = 0; i < count; ++i) {
    const g = i * 16;
    const dt = t - geo[g + 3];
    const still = isStaticSplat(geo[g + 7], duration);
    const a = geo[g + 14] * (still ? 1 : Math.exp(-dt * dt * geo[g + 7]));
    keep[i] = a >= cut ? n++ : -1;
  }
  const positions = new Float32Array(n * 3);
  const scales = new Float32Array(n * 3);
  const rotations = new Float32Array(n * 4);
  const opacities = new Float32Array(n);
  const colorsDC = new Float32Array(n * 3);
  const shRest = K ? new Float32Array(n * K * 3) : null;
  const vals = [0, 0, 0];
  const vecs = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const q = [1, 0, 0, 0];
  const s6 = [0, 0, 0, 0, 0, 0];
  const coef = new Float64Array(shB * 3);
  for (let i = 0; i < count; ++i) {
    const o = keep[i];
    if (o < 0) continue;
    const g = i * 16;
    const dt = t - geo[g + 3];
    const still = isStaticSplat(geo[g + 7], duration);
    positions[o * 3] = geo[g] + geo[g + 4] * dt;
    positions[o * 3 + 1] = geo[g + 1] + geo[g + 5] * dt;
    positions[o * 3 + 2] = geo[g + 2] + geo[g + 6] * dt;
    opacities[o] = geo[g + 14] * (still ? 1 : Math.exp(-dt * dt * geo[g + 7]));
    for (let k = 0; k < 6; ++k) s6[k] = geo[g + 8 + k];
    eigenSym(s6, vals, vecs);
    matToQuat(vecs, q);
    rotations.set(q, o * 4);
    scales[o * 3] = Math.sqrt(vals[0]);
    scales[o * 3 + 1] = Math.sqrt(vals[1]);
    scales[o * 3 + 2] = Math.sqrt(vals[2]);
    coef.fill(0);
    const base = i * shF * shB * 3;
    for (let f = 0; f < shF; ++f) {
      if (still && f > 0) break;
      const phi = f === 0 ? 1 : Math.cos((2 * Math.PI * f * dt) / duration);
      const row = base + f * shB * 3;
      for (let b = 0; b < shB * 3; ++b) coef[b] += phi * half[sht[row + b]];
    }
    for (let c = 0; c < 3; ++c) {
      colorsDC[o * 3 + c] = SH_C0 * coef[c];
      if (shRest) for (let k = 0; k < K; ++k) shRest[(o * 3 + c) * K + k] = coef[(k + 1) * 3 + c];
    }
  }
  return makeStaticScene({
    count: n, positions, scales, rotations, opacities, colorsDC, shRest,
    shDegree: Math.round(Math.sqrt(shB)) - 1, sourceFormat: `${scene.sourceFormat}-slice`,
  });
}
