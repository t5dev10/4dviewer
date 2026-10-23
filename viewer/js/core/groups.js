// Rigid groups: splats that ride a sampled pose track (4DGSX bodies, .4dgs
// object tracks). A group's pose maps its splats' rest frame into the scene:
// p_scene = R(t) p_rest + T(t), Σ_scene = R Σ Rᵀ, and view-dependent colour is
// evaluated with the view direction carried back into the rest frame.
//
// track: { count, tracks: [{ times: Float64Array(k), pos: Float32Array(3k),
//          rot: Float32Array(4k) (x y z w), step: bool } | null, ...] }
// Poses are written 8 floats per group: quaternion x y z w, translation x y z, 0.

export const POSE_STRIDE = 8;

export function createGroupTrack(count) {
  return { count, tracks: new Array(count).fill(null) };
}

function upper(times, t) {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Lerp for translation, shortest-arc slerp for rotation, clamped (not
// extrapolated) outside the sampled range.
export function groupPosesAt(groups, t, out = new Float32Array(groups.count * POSE_STRIDE)) {
  for (let g = 0; g < groups.count; ++g) {
    const o = g * POSE_STRIDE;
    const tr = groups.tracks[g];
    if (!tr || !tr.times.length) {
      out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 1;
      out[o + 4] = 0; out[o + 5] = 0; out[o + 6] = 0; out[o + 7] = 0;
      continue;
    }
    const k = tr.times.length;
    const j = upper(tr.times, t);
    let a = Math.max(0, j - 1), b = Math.min(k - 1, j), f = 0;
    if (j === 0) b = 0;
    else if (j >= k) a = k - 1;
    else if (!tr.step) f = (t - tr.times[a]) / Math.max(tr.times[b] - tr.times[a], 1e-12);
    for (let c = 0; c < 3; ++c) out[o + 4 + c] = tr.pos[a * 3 + c] * (1 - f) + tr.pos[b * 3 + c] * f;
    let x0 = tr.rot[a * 4], y0 = tr.rot[a * 4 + 1], z0 = tr.rot[a * 4 + 2], w0 = tr.rot[a * 4 + 3];
    if (f <= 0) {
      const l = Math.hypot(x0, y0, z0, w0) || 1;
      out[o] = x0 / l; out[o + 1] = y0 / l; out[o + 2] = z0 / l; out[o + 3] = w0 / l;
    } else {
      let x1 = tr.rot[b * 4], y1 = tr.rot[b * 4 + 1], z1 = tr.rot[b * 4 + 2], w1 = tr.rot[b * 4 + 3];
      const l0 = Math.hypot(x0, y0, z0, w0) || 1, l1 = Math.hypot(x1, y1, z1, w1) || 1;
      x0 /= l0; y0 /= l0; z0 /= l0; w0 /= l0;
      x1 /= l1; y1 /= l1; z1 /= l1; w1 /= l1;
      let d = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
      if (d < 0) { x1 = -x1; y1 = -y1; z1 = -z1; w1 = -w1; d = -d; }
      let s0 = 1 - f, s1 = f;
      if (d < 0.9995) {
        const th = Math.acos(Math.min(1, d)), sn = Math.sin(th);
        s0 = Math.sin((1 - f) * th) / sn;
        s1 = Math.sin(f * th) / sn;
      }
      const x = s0 * x0 + s1 * x1, y = s0 * y0 + s1 * y1, z = s0 * z0 + s1 * z1, w = s0 * w0 + s1 * w1;
      const l = Math.hypot(x, y, z, w) || 1;
      out[o] = x / l; out[o + 1] = y / l; out[o + 2] = z / l; out[o + 3] = w / l;
    }
    out[o + 7] = 0;
  }
  return out;
}

// Row-major 3x3 rotation of pose g (x y z w quaternion).
export function poseMatrix(poses, g, out = new Float64Array(9)) {
  const o = g * POSE_STRIDE;
  const x = poses[o], y = poses[o + 1], z = poses[o + 2], w = poses[o + 3];
  out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y - w * z); out[2] = 2 * (x * z + w * y);
  out[3] = 2 * (x * y + w * z); out[4] = 1 - 2 * (x * x + z * z); out[5] = 2 * (y * z - w * x);
  out[6] = 2 * (x * z - w * y); out[7] = 2 * (y * z + w * x); out[8] = 1 - 2 * (x * x + y * y);
  return out;
}

// Applies a fixed rotation R (row-major 3x3, a proper rotation) to every
// sample of every track: used to bring a z-up or Unreal-axes file into the
// viewer frame. Rotations compose as q' = q_R q q_R⁻¹ on the rest frame too,
// so the caller rotates the splats' rest data by the same R.
export function rotateGroupTrack(groups, R, qR) {
  for (const tr of groups.tracks) {
    if (!tr) continue;
    const k = tr.times.length;
    for (let i = 0; i < k; ++i) {
      const px = tr.pos[i * 3], py = tr.pos[i * 3 + 1], pz = tr.pos[i * 3 + 2];
      tr.pos[i * 3] = R[0] * px + R[1] * py + R[2] * pz;
      tr.pos[i * 3 + 1] = R[3] * px + R[4] * py + R[5] * pz;
      tr.pos[i * 3 + 2] = R[6] * px + R[7] * py + R[8] * pz;
      // q' = qR * q * conj(qR), all x y z w
      const q = [tr.rot[i * 4], tr.rot[i * 4 + 1], tr.rot[i * 4 + 2], tr.rot[i * 4 + 3]];
      const r = mulXyzw(mulXyzw(qR, q), [-qR[0], -qR[1], -qR[2], qR[3]]);
      tr.rot.set(r, i * 4);
    }
  }
}

export function mulXyzw(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
