// Assembles a temporal scene (the viewer's 4D model) from per-splat arrays.
// Every 4D loader other than nx4d/nxs4 lands here, so the model's
// conventions live in one place:
//
//   p(t)   = μ + v (t − μt)                        (then the group pose, if any)
//   α(t)   = opacity · exp(−(t − μt)² τ)           τ = 0: never fades
//   window: the splat exists only for t ∈ [lo, hi)
//   colour = 0.5 + Σn Σb cos(2πn (t − μt) / T) Y_b(d) c_nb
//
// Optional per-splat extension (`ext`, 4 floats): window lo, window hi,
// group index (−1 = none), reserved. `staticRule` keeps the nx4d convention
// that very long-lived splats never fade; other sources turn it off.

import { alloc, refuse } from './limits.js';
import { floatToHalf } from './half.js';
import { groupPosesAt, POSE_STRIDE } from './groups.js';

export const ALPHA_CUT = 0.0016; // the shader's visibility floor
export const EXT_STRIDE = 4;

// Σ = R S² Rᵀ (upper triangle xx xy xz yy yz zz) from a w x y z quaternion
// and linear scales.
export function covFromQuat(w, x, y, z, s0, s1, s2, out, o) {
  const l = Math.hypot(w, x, y, z) || 1;
  w /= l; x /= l; y /= l; z /= l;
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - w * z), r02 = 2 * (x * z + w * y);
  const r10 = 2 * (x * y + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - w * x);
  const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y);
  const m00 = r00 * s0, m01 = r01 * s1, m02 = r02 * s2;
  const m10 = r10 * s0, m11 = r11 * s1, m12 = r12 * s2;
  const m20 = r20 * s0, m21 = r21 * s1, m22 = r22 * s2;
  out[o] = m00 * m00 + m01 * m01 + m02 * m02;
  out[o + 1] = m00 * m10 + m01 * m11 + m02 * m12;
  out[o + 2] = m00 * m20 + m01 * m21 + m02 * m22;
  out[o + 3] = m10 * m10 + m11 * m11 + m12 * m12;
  out[o + 4] = m10 * m20 + m11 * m21 + m12 * m22;
  out[o + 5] = m20 * m20 + m21 * m21 + m22 * m22;
}

export const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// src: {
//   count, duration, positions (3n), velocities (3n) | null, muT (n) | null, tau (n) | null,
//   cov (6n) | rotations (4n, w x y z) + scales (3n, linear), opacities (n, 0..1),
//   shL, shF, and colour as one of:
//     shCoeffs: Float32Array n·shF·shB·3 (c_nb, DC is the SH coefficient f_dc)
//     shDC: Float32Array 3n (f_dc) [+ shRest: n·3·K channel-major, K = shB − 1]  (shF = 1)
//     sht: Uint16Array of halfs in the shCoeffs layout
//   windows (2n) | null, groupIds (Int32Array n, −1 none) | null, groups (track) | null,
//   staticRule, alphaCut, sourceFormat, view, credit, warnings, extra fields copied as-is
// }
export function buildTemporalScene(src) {
  const n = src.count;
  const duration = src.duration;
  if (!(duration > 0) || !Number.isFinite(duration)) refuse(`${src.sourceFormat}: the clip needs a positive duration`);
  const shL = src.shL ?? 0;
  const shF = src.shF ?? 1;
  const shB = (shL + 1) * (shL + 1);
  const geo = alloc(`${src.sourceFormat} geo`, Float32Array, n * 16);
  const { positions, velocities, muT, tau, cov, rotations, scales, opacities } = src;
  const c6 = new Float64Array(6);
  for (let i = 0; i < n; ++i) {
    const g = i * 16;
    geo[g] = positions[i * 3];
    geo[g + 1] = positions[i * 3 + 1];
    geo[g + 2] = positions[i * 3 + 2];
    geo[g + 3] = muT ? muT[i] : 0;
    if (velocities) {
      geo[g + 4] = velocities[i * 3];
      geo[g + 5] = velocities[i * 3 + 1];
      geo[g + 6] = velocities[i * 3 + 2];
    }
    geo[g + 7] = tau ? tau[i] : 0;
    if (cov) {
      for (let k = 0; k < 6; ++k) geo[g + 8 + k] = cov[i * 6 + k];
    } else {
      covFromQuat(rotations[i * 4], rotations[i * 4 + 1], rotations[i * 4 + 2], rotations[i * 4 + 3],
        scales[i * 3], scales[i * 3 + 1], scales[i * 3 + 2], c6, 0);
      for (let k = 0; k < 6; ++k) geo[g + 8 + k] = c6[k];
    }
    geo[g + 14] = opacities[i];
  }

  let sht = src.sht ?? null;
  if (!sht) {
    sht = alloc(`${src.sourceFormat} colour`, Uint16Array, n * shF * shB * 3);
    if (src.shCoeffs) {
      for (let j = 0; j < sht.length; ++j) sht[j] = floatToHalf(src.shCoeffs[j]);
    } else {
      const dc = src.shDC, rest = src.shRest;
      const K = shB - 1;
      for (let i = 0; i < n; ++i) {
        const base = i * shF * shB * 3;
        sht[base] = floatToHalf(dc[i * 3]);
        sht[base + 1] = floatToHalf(dc[i * 3 + 1]);
        sht[base + 2] = floatToHalf(dc[i * 3 + 2]);
        if (rest && K) {
          for (let k = 0; k < K; ++k) {
            for (let c = 0; c < 3; ++c) sht[base + (k + 1) * 3 + c] = floatToHalf(rest[(i * 3 + c) * K + k]);
          }
        }
      }
    }
  }

  let ext = null;
  if (src.windows || src.groupIds) {
    ext = alloc(`${src.sourceFormat} windows`, Float32Array, n * EXT_STRIDE);
    for (let i = 0; i < n; ++i) {
      const e = i * EXT_STRIDE;
      ext[e] = src.windows ? src.windows[i * 2] : -Infinity;
      ext[e + 1] = src.windows ? src.windows[i * 2 + 1] : Infinity;
      ext[e + 2] = src.groupIds ? src.groupIds[i] : -1;
    }
  }
  const groups = src.groups && src.groups.count > 0 ? src.groups : null;
  const staticRule = src.staticRule ?? false;
  const { center, radius } = temporalSceneBounds({ geo, ext, groups, count: n, duration, staticRule });
  const scene = {
    ...(src.extra || {}),
    kind: 'temporal', sourceFormat: src.sourceFormat, count: n, duration, shL, shF, shB, geo, sht,
    ext, groups, staticRule, alphaCut: src.alphaCut ?? ALPHA_CUT,
    center, radius, view: src.view ?? null, credit: src.credit ?? null, warnings: src.warnings ?? [],
  };
  return scene;
}

// Median centre and distance quantile of where splats actually are while
// visible: each splat is placed at a time inside its window, moved by its
// velocity and its group pose (sampled at a few fixed instants).
export function temporalSceneBounds({ geo, ext, groups, count, duration, staticRule = true }, quantile = 0.5) {
  if (count === 0) return { center: [0, 0, 0], radius: 1 };
  const stride = Math.max(1, Math.ceil(count / (1 << 20)));
  const STEPS = 16;
  let poses = null;
  if (groups) {
    poses = [];
    for (let s = 0; s < STEPS; ++s) poses.push(groupPosesAt(groups, ((s + 0.5) / STEPS) * duration));
  }
  const xs = [], ys = [], zs = [];
  for (let i = 0; i < count; i += stride) {
    const g = i * 16;
    if (geo[g + 14] < ALPHA_CUT) continue;
    let ts = Math.min(Math.max(geo[g + 3], 0), duration);
    let grp = -1;
    if (ext) {
      const lo = ext[i * EXT_STRIDE], hi = ext[i * EXT_STRIDE + 1];
      if (!(hi > lo) || hi <= 0 || lo >= duration) continue;
      ts = Math.min(Math.max(ts, Math.max(lo, 0)), Math.min(hi, duration) - 1e-6);
      grp = ext[i * EXT_STRIDE + 2];
    }
    const tau = geo[g + 7];
    const still = tau <= 0 || (staticRule && Math.sqrt(0.5 / tau) > 0.6 * duration);
    if (!still && geo[g + 14] * Math.exp(-((ts - geo[g + 3]) ** 2) * tau) < ALPHA_CUT) continue;
    const dt = ts - geo[g + 3];
    let x = geo[g] + geo[g + 4] * dt, y = geo[g + 1] + geo[g + 5] * dt, z = geo[g + 2] + geo[g + 6] * dt;
    if (poses && grp >= 0) {
      const P = poses[Math.min(STEPS - 1, Math.max(0, Math.floor((ts / duration) * STEPS)))];
      const o = grp * POSE_STRIDE;
      const qx = P[o], qy = P[o + 1], qz = P[o + 2], qw = P[o + 3];
      // v' = v + 2w (q×v) + 2 q×(q×v)
      const cx = qy * z - qz * y, cy = qz * x - qx * z, cz = qx * y - qy * x;
      const dx = qy * cz - qz * cy, dy = qz * cx - qx * cz, dz = qx * cy - qy * cx;
      x += 2 * (qw * cx + dx) + P[o + 4];
      y += 2 * (qw * cy + dy) + P[o + 5];
      z += 2 * (qw * cz + dz) + P[o + 6];
    }
    xs.push(x); ys.push(y); zs.push(z);
  }
  const m = xs.length;
  if (!m) return { center: [0, 0, 0], radius: 1 };
  const med = (a) => Float64Array.from(a).sort()[a.length >> 1];
  const center = [med(xs), med(ys), med(zs)];
  const d = new Float64Array(m);
  for (let j = 0; j < m; ++j) d[j] = Math.hypot(xs[j] - center[0], ys[j] - center[1], zs[j] - center[2]);
  d.sort();
  const radius = d[Math.min(m - 1, Math.floor(quantile * m))];
  return { center, radius: radius > 0 && Number.isFinite(radius) ? radius : 1 };
}
