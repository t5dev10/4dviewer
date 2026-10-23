// Freezes a 4D scene at time t into a static scene: positions moved to t,
// opacity × temporal gate, Σ split into scale + rotation, and every SH band
// evaluated at t across the Fourier orders.

import { halfTable } from '../core/half.js';
import { makeStaticScene, SH_C0, isStaticSplat } from '../core/scene.js';
import { groupPosesAt, poseMatrix, POSE_STRIDE } from '../core/groups.js';
import { shRotationMatrices } from '../core/sh.js';
import { EXT_STRIDE } from '../core/temporal-build.js';

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

// Σ' = R Σ Rᵀ on the upper triangle (xx xy xz yy yz zz), R row-major.
function rotateCov(R, s) {
  const m = [[s[0], s[1], s[2]], [s[1], s[3], s[4]], [s[2], s[4], s[5]]];
  const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; ++i) {
    for (let j = 0; j < 3; ++j) {
      let v = 0;
      for (let k = 0; k < 3; ++k) v += R[i * 3 + k] * m[k][j];
      a[i][j] = v;
    }
  }
  const out = (i, j) => a[i][0] * R[j * 3] + a[i][1] * R[j * 3 + 1] + a[i][2] * R[j * 3 + 2];
  s[0] = out(0, 0); s[1] = out(0, 1); s[2] = out(0, 2); s[3] = out(1, 1); s[4] = out(1, 2); s[5] = out(2, 2);
}

export function sliceAt(scene, t, cut = 1 / 255) {
  const { count, geo, sht, shF, shB, duration } = scene;
  const ext = scene.ext || null;
  const ruled = scene.staticRule !== false;
  const half = halfTable();
  const K = shB - 1;
  const keep = new Int32Array(count);
  cut = Math.max(cut, scene.alphaCut || 0);
  let n = 0;
  for (let i = 0; i < count; ++i) {
    const g = i * 16;
    if (ext && (t < ext[i * EXT_STRIDE] || t >= ext[i * EXT_STRIDE + 1])) {
      keep[i] = -1;
      continue;
    }
    const dt = t - geo[g + 3];
    const still = ruled && isStaticSplat(geo[g + 7], duration);
    const a = geo[g + 14] * (still ? 1 : Math.exp(-dt * dt * geo[g + 7]));
    keep[i] = a >= cut ? n++ : -1;
  }
  // Rigid groups: pose at t for positions and Σ, and per-group SH rotations.
  const poses = scene.groups ? groupPosesAt(scene.groups, t) : null;
  const rotOf = new Map();
  const groupRot = (grp) => {
    let r = rotOf.get(grp);
    if (!r) {
      const R = poseMatrix(poses, grp);
      r = { R, bands: K ? shRotationMatrices(Array.from(R)) : null };
      rotOf.set(grp, r);
    }
    return r;
  };
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
  const tmp = new Float64Array(7);
  for (let i = 0; i < count; ++i) {
    const o = keep[i];
    if (o < 0) continue;
    const g = i * 16;
    const dt = t - geo[g + 3];
    const still = ruled && isStaticSplat(geo[g + 7], duration);
    let px = geo[g] + geo[g + 4] * dt, py = geo[g + 1] + geo[g + 5] * dt, pz = geo[g + 2] + geo[g + 6] * dt;
    for (let k = 0; k < 6; ++k) s6[k] = geo[g + 8 + k];
    const grp = poses && ext ? Math.floor(ext[i * EXT_STRIDE + 2] + 0.5) : -1;
    const gr = grp >= 0 && grp < scene.groups.count ? groupRot(grp) : null;
    if (gr) {
      const R = gr.R, o8 = grp * POSE_STRIDE;
      const x = R[0] * px + R[1] * py + R[2] * pz + poses[o8 + 4];
      const y = R[3] * px + R[4] * py + R[5] * pz + poses[o8 + 5];
      const z = R[6] * px + R[7] * py + R[8] * pz + poses[o8 + 6];
      px = x; py = y; pz = z;
      rotateCov(R, s6);
    }
    positions[o * 3] = px;
    positions[o * 3 + 1] = py;
    positions[o * 3 + 2] = pz;
    opacities[o] = geo[g + 14] * (still ? 1 : Math.exp(-dt * dt * geo[g + 7]));
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
    if (gr?.bands) {
      for (let l = 1; l * l < shB; ++l) {
        const nb = 2 * l + 1, off = l * l, M = gr.bands[l - 1];
        for (let c = 0; c < 3; ++c) {
          for (let r = 0; r < nb; ++r) {
            let s = 0;
            for (let k = 0; k < nb; ++k) s += M[r * nb + k] * coef[(off + k) * 3 + c];
            tmp[r] = s;
          }
          for (let r = 0; r < nb; ++r) coef[(off + r) * 3 + c] = tmp[r];
        }
      }
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
