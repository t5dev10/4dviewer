// Real spherical harmonics in the reference 3DGS convention, plus the frame
// changes the loaders need: axis flips (sign tables) and rotations (per-band
// matrices fitted numerically, exact to float precision).

import { SH_C0 } from './scene.js';

export const SH_C1 = 0.4886025119029199;
const C2 = [1.0925484305920792, -1.0925484305920792, 0.31539156525252005, -1.0925484305920792, 0.5462742152960396];
const C3 = [-0.5900435899266435, 2.890611442640554, -0.4570457994644658, 0.3731763325901154,
  -0.4570457994644658, 1.445305721320277, -0.5900435899266435];

export const shCoeffCount = (degree) => (degree + 1) * (degree + 1) - 1;
export const degreeForRestCount = (k) => (k >= 15 ? 3 : k >= 8 ? 2 : k >= 3 ? 1 : 0);

export function shBasis(x, y, z, out = new Float64Array(16)) {
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, yz = y * z, xz = x * z;
  out[0] = SH_C0;
  out[1] = -SH_C1 * y;
  out[2] = SH_C1 * z;
  out[3] = -SH_C1 * x;
  out[4] = C2[0] * xy;
  out[5] = C2[1] * yz;
  out[6] = C2[2] * (2 * zz - xx - yy);
  out[7] = C2[3] * xz;
  out[8] = C2[4] * (xx - yy);
  out[9] = C3[0] * y * (3 * xx - yy);
  out[10] = C3[1] * xy * z;
  out[11] = C3[2] * y * (4 * zz - xx - yy);
  out[12] = C3[3] * z * (2 * zz - 3 * xx - 3 * yy);
  out[13] = C3[4] * x * (4 * zz - xx - yy);
  out[14] = C3[5] * z * (xx - yy);
  out[15] = C3[6] * x * (xx - 3 * yy);
  return out;
}

// Sign changes for an axis flip (x, y, z each ±1), as in Niantic's SPZ
// reference: flipP for positions, flipQ for quaternion x y z (w untouched),
// flipSh for rest coefficients 1..15.
export function axisFlip(x, y, z) {
  return {
    flipP: [x, y, z],
    flipQ: [y * z, x * z, x * y],
    flipSh: [y, z, x, x * y, y * z, 1, x * z, 1, y, x * y * z, y, z, x, z, x],
  };
}

export const FLIP_RUB_TO_RDF = axisFlip(1, -1, -1); // OpenGL / three.js / SPZ / USD y-up
export const FLIP_LUF_TO_RDF = axisFlip(-1, -1, 1); // glTF

// Rest coefficients, channel-major per splat: shRest[(i*3 + c)*K + k].
export function flipShRest(shRest, count, K, flipSh) {
  if (!shRest || !K) return;
  for (let i = 0; i < count; ++i) {
    for (let c = 0; c < 3; ++c) {
      const base = (i * 3 + c) * K;
      for (let k = 0; k < K; ++k) shRest[base + k] *= flipSh[k];
    }
  }
}

// --- rotations -------------------------------------------------------------

function solve(A, B, n) {
  // Gaussian elimination with partial pivoting on n x n systems, B is n x n.
  const a = A.slice(), b = B.slice();
  for (let col = 0; col < n; ++col) {
    let piv = col;
    for (let r = col + 1; r < n; ++r) if (Math.abs(a[r * n + col]) > Math.abs(a[piv * n + col])) piv = r;
    if (piv !== col) {
      for (let k = 0; k < n; ++k) {
        [a[col * n + k], a[piv * n + k]] = [a[piv * n + k], a[col * n + k]];
        [b[col * n + k], b[piv * n + k]] = [b[piv * n + k], b[col * n + k]];
      }
    }
    const d = a[col * n + col];
    for (let r = 0; r < n; ++r) {
      if (r === col) continue;
      const f = a[r * n + col] / d;
      if (!f) continue;
      for (let k = 0; k < n; ++k) {
        a[r * n + k] -= f * a[col * n + k];
        b[r * n + k] -= f * b[col * n + k];
      }
    }
  }
  for (let r = 0; r < n; ++r) {
    const d = a[r * n + r];
    for (let k = 0; k < n; ++k) b[r * n + k] /= d;
  }
  return b;
}

// For a rotation R (row-major 3x3, new = R · old) returns per-band matrices
// M_l with c'_l = M_l c_l, so Σ c'_k Y_k(R d) = Σ c_k Y_k(d) for every d.
export function shRotationMatrices(R) {
  const N = 96;
  const dirs = [];
  for (let i = 0; i < N; ++i) { // Fibonacci sphere
    const z = 1 - (2 * i + 1) / N;
    const r = Math.sqrt(1 - z * z);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    dirs.push([r * Math.cos(phi), r * Math.sin(phi), z]);
  }
  const y0 = new Float64Array(16), y1 = new Float64Array(16);
  const bands = [];
  for (let l = 1; l <= 3; ++l) {
    const n = 2 * l + 1, off = l * l;
    const AtA = new Float64Array(n * n), AtB = new Float64Array(n * n);
    for (const d of dirs) {
      const rd = [
        R[0] * d[0] + R[1] * d[1] + R[2] * d[2],
        R[3] * d[0] + R[4] * d[1] + R[5] * d[2],
        R[6] * d[0] + R[7] * d[1] + R[8] * d[2],
      ];
      shBasis(rd[0], rd[1], rd[2], y0); // A row
      shBasis(d[0], d[1], d[2], y1);    // B row
      for (let i = 0; i < n; ++i) {
        for (let j = 0; j < n; ++j) {
          AtA[i * n + j] += y0[off + i] * y0[off + j];
          AtB[i * n + j] += y0[off + i] * y1[off + j];
        }
      }
    }
    bands.push(solve(AtA, AtB, n));
  }
  return bands; // [M1 3x3, M2 5x5, M3 7x7]
}

// Rotates rest coefficients in place. `get(i, c, k)` / `set(i, c, k, v)` address
// coefficient k (0-based rest index) of channel c in group i.
export function rotateShGroups(groups, K, bands, get, set) {
  const deg = degreeForRestCount(K);
  const tmp = new Float64Array(7), out = new Float64Array(7);
  for (let g = 0; g < groups; ++g) {
    for (let c = 0; c < 3; ++c) {
      for (let l = 1; l <= deg; ++l) {
        const n = 2 * l + 1, off = l * l - 1, M = bands[l - 1];
        for (let k = 0; k < n; ++k) tmp[k] = get(g, c, off + k);
        for (let r = 0; r < n; ++r) {
          let s = 0;
          for (let k = 0; k < n; ++k) s += M[r * n + k] * tmp[k];
          out[r] = s;
        }
        for (let k = 0; k < n; ++k) set(g, c, off + k, out[k]);
      }
    }
  }
}

export function rotateShRest(shRest, count, K, R) {
  if (!shRest || !K) return;
  const bands = shRotationMatrices(R);
  rotateShGroups(count, K, bands,
    (i, c, k) => shRest[(i * 3 + c) * K + k],
    (i, c, k, v) => { shRest[(i * 3 + c) * K + k] = v; });
}

// Z-up source -> this viewer's frame: (x, y, z) -> (x, -z, y), i.e. R_x(+90°).
export const R_ZUP = [1, 0, 0, 0, 0, -1, 0, 1, 0];
export const Q_ZUP = [Math.SQRT1_2, Math.SQRT1_2, 0, 0]; // w x y z

export function quatMul(a, b) { // w x y z
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

// Rotates a static scene from Z-up into the viewer frame.
export function staticZUpToViewer(scene) {
  const { count, positions, rotations } = scene;
  for (let i = 0; i < count; ++i) {
    const y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    positions[i * 3 + 1] = -z;
    positions[i * 3 + 2] = y;
    const q = quatMul(Q_ZUP, [rotations[i * 4], rotations[i * 4 + 1], rotations[i * 4 + 2], rotations[i * 4 + 3]]);
    rotations.set(q, i * 4);
  }
  if (scene.shRest && scene.shDegree > 0) {
    rotateShRest(scene.shRest, count, scene.shRest.length / count / 3, R_ZUP);
  }
}
