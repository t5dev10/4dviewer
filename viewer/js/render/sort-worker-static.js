// Depth sort for static scenes. With a splat cap (software rasterisers only)
// the most important splats (opacity × size) are kept, ranked once per scene.

let positions = null;
let count = 0;
let opacities = null;
let scales = null;
let ranked = null;

function rank() {
  const weight = new Float32Array(count);
  for (let i = 0; i < count; ++i) {
    const x = scales[i * 3], y = scales[i * 3 + 1], z = scales[i * 3 + 2];
    weight[i] = opacities[i] * (x * x + y * y + z * z);
  }
  ranked = new Uint32Array(count);
  for (let i = 0; i < count; ++i) ranked[i] = i;
  ranked.sort((a, b) => weight[b] - weight[a]);
}

onmessage = (e) => {
  const m = e.data;
  if (m.positions) {
    positions = m.positions;
    count = m.count;
    opacities = m.opacities || null;
    scales = m.scales || null;
    ranked = null;
    return;
  }
  if (!positions) return;
  const { view, cap = 0 } = m;
  const capped = cap > 0 && cap < count && opacities && scales;
  if (capped && !ranked) rank();
  const n = capped ? cap : count;
  const r0 = view[8], r1 = view[9], r2 = view[10], r3 = view[11];
  const depth = new Float32Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < n; ++j) {
    const i = capped ? ranked[j] : j;
    const d = r0 * positions[i * 3] + r1 * positions[i * 3 + 1] + r2 * positions[i * 3 + 2] + r3;
    depth[j] = d;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const scale = 65535 / Math.max(hi - lo, 1e-9);
  const keys = new Uint16Array(n);
  const counts = new Uint32Array(65536);
  for (let j = 0; j < n; ++j) {
    const k = 65535 - Math.min(65535, Math.max(0, Math.round((depth[j] - lo) * scale)));
    keys[j] = k;
    counts[k]++;
  }
  const starts = new Uint32Array(65536);
  for (let k = 1; k < 65536; ++k) starts[k] = starts[k - 1] + counts[k - 1];
  const indices = new Uint32Array(n);
  for (let j = 0; j < n; ++j) indices[starts[keys[j]]++] = capped ? ranked[j] : j;
  postMessage({ indices, gen: m.gen, epoch: m.epoch }, [indices.buffer]);
};
