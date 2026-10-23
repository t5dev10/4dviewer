// Scene containers produced by the loaders.
//
// static:   { kind:'static', count, positions(3n), scales(3n, linear), rotations(4n, w x y z),
//             opacities(n, 0..1), colorsDC(3n, = SH_C0 * f_dc), shRest(n*K*3, channel-major) | null,
//             shDegree, center, radius, sourceFormat }
// temporal: { kind:'temporal', count, duration, shL, shF, shB, geo(16n f32), sht(n*shF*shB*3 halfs),
//             center, radius, view, credit, audio, sourceFormat }
//   geo = mu.xyz, mu_t, v.xyz, tau, Σxx Σxy Σxz Σyy Σyz Σzz, opacity, flags

export const SH_C0 = 0.28209479177387814;

// Per-axis median and a distance quantile, over a strided sample for big scenes.
function bounds(count, read, quantile) {
  if (count === 0) return { center: [0, 0, 0], radius: 1 };
  const stride = Math.max(1, Math.ceil(count / (1 << 20)));
  const m = Math.ceil(count / stride);
  const tmp = new Float32Array(m);
  const center = [0, 0, 0];
  for (let axis = 0; axis < 3; ++axis) {
    for (let i = 0, j = 0; i < count; i += stride, ++j) tmp[j] = read(i, axis);
    tmp.sort();
    center[axis] = tmp[m >> 1] || 0;
  }
  for (let i = 0, j = 0; i < count; i += stride, ++j) {
    const dx = read(i, 0) - center[0], dy = read(i, 1) - center[1], dz = read(i, 2) - center[2];
    tmp[j] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  tmp.sort();
  const radius = tmp[Math.min(m - 1, Math.floor(quantile * m))];
  return { center, radius: radius > 0 && Number.isFinite(radius) ? radius : 1 };
}

export function staticBounds(positions, count) {
  return bounds(count, (i, a) => positions[i * 3 + a], 0.9);
}

export function temporalBounds(geo, count) {
  return bounds(count, (i, a) => geo[i * 16 + a], 0.5);
}

export function makeStaticScene({
  count, positions, scales, rotations, opacities, colorsDC,
  shRest = null, shDegree = 0, sourceFormat, warnings = [],
}) {
  const { center, radius } = staticBounds(positions, count);
  return {
    kind: 'static', count, positions, scales, rotations, opacities, colorsDC,
    shRest, shDegree, center, radius, sourceFormat, warnings,
  };
}

export function emptyStaticScene(sourceFormat) {
  return makeStaticScene({
    count: 0,
    positions: new Float32Array(0),
    scales: new Float32Array(0),
    rotations: new Float32Array(0),
    opacities: new Float32Array(0),
    colorsDC: new Float32Array(0),
    sourceFormat,
  });
}

// The 4D model's static rule (sqrt(Σtt) > 0.6 T with Σtt = 1/(2τ)): gate ≡ 1
// and Fourier orders n ≥ 1 are skipped, so long-lived splats never fade at clip edges.
export function isStaticSplat(tau, duration) {
  return tau > 0 && Math.sqrt(0.5 / tau) > 0.6 * duration;
}

export function sceneTransferables(scene) {
  const list = [];
  for (const key of ['positions', 'scales', 'rotations', 'opacities', 'colorsDC', 'shRest', 'geo', 'sht', 'ext']) {
    const a = scene[key];
    if (a && a.buffer && !list.includes(a.buffer)) list.push(a.buffer);
  }
  return list;
}
