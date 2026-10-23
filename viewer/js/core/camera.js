// Orbit camera. The scene keeps its native frame (the reference 3DGS / COLMAP
// convention: +x right, +y down, +z forward), so the view matrix maps world to
// an OpenCV-style camera (x right, y down, z forward). All matrices here are
// row-major 4x4 unless a name says otherwise.

export const FOV_Y = (60 * Math.PI) / 180;
export const NEAR = 0.05;

export function defaultOrbit() {
  return { yaw: 0, pitch: -0.15, roll: 0, dolly: 2.2, pan: [0, 0, 0] };
}

// Global safety clamps, then optional per-scene limits {yaw,pitch,dolly: [lo, hi]}.
export function clampOrbit(cam, limits) {
  cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch));
  cam.dolly = Math.max(0.05, Math.min(10, cam.dolly));
  if (!limits) return;
  const clamp = (v, range) => (range ? Math.max(range[0], Math.min(range[1], v)) : v);
  cam.yaw = clamp(cam.yaw, limits.yaw);
  cam.pitch = clamp(cam.pitch, limits.pitch);
  cam.dolly = clamp(cam.dolly, limits.dolly);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

// World -> view for an orbit around `center`, distance radius * dolly.
export function orbitView(cam, center, radius) {
  const target = [center[0] + cam.pan[0], center[1] + cam.pan[1], center[2] + cam.pan[2]];
  const dist = radius * cam.dolly;
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const eye = [target[0] + dist * sy * cp, target[1] + dist * sp, target[2] - dist * cy * cp];
  const fwd = normalize(sub(target, eye));
  let right = normalize(cross([0, 1, 0], fwd));
  let down = cross(fwd, right);
  if (cam.roll) {
    const c = Math.cos(cam.roll), s = Math.sin(cam.roll);
    const r2 = right.map((v, i) => v * c + down[i] * s);
    down = down.map((v, i) => v * c - right[i] * s);
    right = r2;
  }
  const m = new Float32Array(16);
  [right, down, fwd].forEach((row, r) => {
    m[r * 4] = row[0];
    m[r * 4 + 1] = row[1];
    m[r * 4 + 2] = row[2];
    m[r * 4 + 3] = -dot(row, eye);
  });
  m[15] = 1;
  return { m, eye };
}

// Recover orbit parameters from a stored camera {eye, target, up}.
export function orbitFromView(view, center, radius) {
  const n = sub(view.eye, view.target);
  const dist = Math.hypot(n[0], n[1], n[2]);
  if (!(dist > 1e-9) || !(radius > 0)) return null;
  const pitch = Math.asin(Math.max(-1, Math.min(1, n[1] / dist)));
  const yaw = Math.atan2(n[0], -n[2]);
  const fwd = [-n[0] / dist, -n[1] / dist, -n[2] / dist];
  let right0 = [fwd[2], 0, -fwd[0]];
  const l0 = Math.hypot(...right0);
  if (l0 < 1e-6) return null;
  right0 = right0.map((v) => v / l0);
  let right = cross(fwd, view.up);
  const l1 = Math.hypot(...right);
  if (l1 < 1e-6) return null;
  right = right.map((v) => v / l1);
  const roll = Math.atan2(dot(cross(right0, right), fwd), dot(right0, right));
  return {
    yaw, pitch, roll,
    dolly: dist / radius,
    pan: sub(view.target, center),
  };
}

// Column-major OpenGL perspective (used for its focal terms and for XR parity).
export function perspective(fovY, aspect, near = NEAR, far = 1000) {
  const f = 1 / Math.tan(fovY / 2);
  const p = new Float32Array(16);
  p[0] = f / aspect;
  p[5] = f;
  p[10] = (far + near) / (near - far);
  p[11] = -1;
  p[14] = (2 * far * near) / (near - far);
  return p;
}

export function focalPx(fovY, heightPx) {
  return (0.5 * heightPx) / Math.tan(fovY / 2);
}

// Camera centre from a row-major world->view matrix (any invertible 3x3 part).
export function cameraPosition(m) {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-20) return [0, 0, 0];
  const inv = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
  const t = [m[3], m[7], m[11]];
  return [
    -(inv[0] * t[0] + inv[1] * t[1] + inv[2] * t[2]),
    -(inv[3] * t[0] + inv[4] * t[1] + inv[5] * t[2]),
    -(inv[6] * t[0] + inv[7] * t[1] + inv[8] * t[2]),
  ];
}

export function transposeToColumnMajor(m, out = new Float32Array(16)) {
  for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) out[c * 4 + r] = m[r * 4 + c];
  return out;
}

export function multiplyRowMajor(a, b, out = new Float32Array(16)) {
  for (let r = 0; r < 4; ++r) {
    for (let c = 0; c < 4; ++c) {
      out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
  }
  return out;
}

// Five culling planes (near + four sides) for chunk scheduling.
export function frustumPlanes(m, eye, fovY, aspect, near = NEAR) {
  const right = [m[0], m[1], m[2]];
  const down = [m[4], m[5], m[6]];
  const fwd = [m[8], m[9], m[10]];
  const ty = Math.tan(fovY / 2);
  const tx = ty * aspect;
  const comb = (a, s, b, t) => [a[0] * s + b[0] * t, a[1] * s + b[1] * t, a[2] * s + b[2] * t];
  return [
    { n: fwd, ref: comb(eye, 1, fwd, near) },
    { n: normalize(comb(fwd, 1, right, -1 / tx)), ref: eye },
    { n: normalize(comb(fwd, 1, right, 1 / tx)), ref: eye },
    { n: normalize(comb(fwd, 1, down, -1 / ty)), ref: eye },
    { n: normalize(comb(fwd, 1, down, 1 / ty)), ref: eye },
  ].map(({ n, ref }) => ({ n, d: -dot(n, ref) }));
}

export function aabbInFrustum(planes, min, max) {
  for (const { n, d } of planes) {
    const px = n[0] >= 0 ? max[0] : min[0];
    const py = n[1] >= 0 ? max[1] : min[1];
    const pz = n[2] >= 0 ? max[2] : min[2];
    if (n[0] * px + n[1] * py + n[2] * pz + d < 0) return false;
  }
  return true;
}

// World point -> CSS pixel position for overlays (hotspots).
export function projectPoint(m, p, { width, height, fovY = FOV_Y }) {
  const x = m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3];
  const y = m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7];
  const z = m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11];
  if (!(z > NEAR)) return { x: NaN, y: NaN, z };
  const f = focalPx(fovY, height);
  return { x: (f * x) / z + 0.5 * width, y: (f * y) / z + 0.5 * height, z };
}
