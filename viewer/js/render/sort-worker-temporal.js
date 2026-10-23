// Depth sort for 4D scenes: positions are evaluated at the requested time,
// then a 16-bit counting sort orders splats back to front. With a splat cap,
// only splats alive at t (cyclic gate, widened by the sort latency window) are
// kept, ranked by opacity × size.

let geo = null;
let count = 0;
let duration = 1;
let alive = null; // streaming pool residency
const CUT = 1 / 255;

function countingSort(depth, ids, n) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; ++i) {
    const d = depth[i];
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const scale = 65535 / Math.max(hi - lo, 1e-9);
  const keys = new Uint16Array(n);
  const counts = new Uint32Array(65536);
  for (let i = 0; i < n; ++i) {
    const k = 65535 - Math.min(65535, Math.max(0, Math.round((depth[i] - lo) * scale)));
    keys[i] = k;
    counts[k]++;
  }
  const starts = new Uint32Array(65536);
  for (let k = 1; k < 65536; ++k) starts[k] = starts[k - 1] + counts[k - 1];
  const out = new Uint32Array(n);
  if (ids) for (let i = 0; i < n; ++i) out[starts[keys[i]]++] = ids[i];
  else for (let i = 0; i < n; ++i) out[starts[keys[i]]++] = i;
  return out;
}

function sort({ view, t, cap = 0, window: win = 0 }) {
  const r0 = view[8], r1 = view[9], r2 = view[10], r3 = view[11];
  let ids = null;
  let depth;
  let n = 0;
  if (cap > 0 && cap < count) {
    ids = new Uint32Array(count);
    depth = new Float32Array(count);
    const weight = new Float32Array(count);
    for (let i = 0; i < count; ++i) {
      if (alive && !alive[i]) continue;
      const g = i * 16;
      const dt = t - geo[g + 3];
      const tau = geo[g + 7];
      let a;
      if (tau > 0 && Math.sqrt(0.5 / tau) > 0.6 * duration) {
        a = geo[g + 14];
      } else {
        const ad = Math.abs(dt);
        const gap = Math.max(0, Math.min(ad, duration - ad) - win);
        a = geo[g + 14] * Math.exp(-gap * gap * tau);
      }
      if (a < CUT) continue;
      const x = geo[g] + geo[g + 4] * dt, y = geo[g + 1] + geo[g + 5] * dt, z = geo[g + 2] + geo[g + 6] * dt;
      ids[n] = i;
      depth[n] = r0 * x + r1 * y + r2 * z + r3;
      weight[n] = a * (geo[g + 8] + geo[g + 11] + geo[g + 13]);
      n++;
    }
    if (cap < n) {
      const order = new Uint32Array(n);
      for (let i = 0; i < n; ++i) order[i] = i;
      order.sort((a, b) => weight[b] - weight[a]);
      const ids2 = new Uint32Array(cap), depth2 = new Float32Array(cap);
      for (let i = 0; i < cap; ++i) {
        ids2[i] = ids[order[i]];
        depth2[i] = depth[order[i]];
      }
      ids = ids2;
      depth = depth2;
      n = cap;
    }
  } else if (alive) {
    ids = new Uint32Array(count);
    depth = new Float32Array(count);
    for (let i = 0; i < count; ++i) {
      if (!alive[i]) continue;
      const g = i * 16;
      const dt = t - geo[g + 3];
      ids[n] = i;
      depth[n] = r0 * (geo[g] + geo[g + 4] * dt) + r1 * (geo[g + 1] + geo[g + 5] * dt) + r2 * (geo[g + 2] + geo[g + 6] * dt) + r3;
      n++;
    }
  } else {
    n = count;
    depth = new Float32Array(count);
    for (let i = 0; i < count; ++i) {
      const g = i * 16;
      const dt = t - geo[g + 3];
      depth[i] = r0 * (geo[g] + geo[g + 4] * dt) + r1 * (geo[g + 1] + geo[g + 5] * dt) + r2 * (geo[g + 2] + geo[g + 6] * dt) + r3;
    }
  }
  return countingSort(depth, ids, n);
}

onmessage = (e) => {
  const m = e.data;
  if (m.geo) {
    geo = m.geo;
    count = m.count;
    duration = m.duration || 1;
    alive = null;
    return;
  }
  if (m.poolInit) {
    count = m.poolInit.capacity;
    duration = m.poolInit.duration || 1;
    geo = new Float32Array(count * 16);
    alive = new Uint8Array(count);
    return;
  }
  if (m.poolPage) {
    const { offset, geo: g, count: c } = m.poolPage;
    geo.set(g.subarray(0, c * 16), offset * 16);
    alive.fill(1, offset, offset + c);
    return;
  }
  if (m.poolEvict) {
    alive.fill(0, m.poolEvict.offset, m.poolEvict.offset + m.poolEvict.count);
    return;
  }
  if (m.poolKill) {
    for (const s of m.poolKill.slots) alive[s] = 0;
    return;
  }
  if (!geo) return;
  const indices = sort(m);
  postMessage({ indices, t: m.t, gen: m.gen, epoch: m.epoch }, [indices.buffer]);
};
