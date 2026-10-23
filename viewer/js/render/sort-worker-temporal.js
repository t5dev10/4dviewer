// Depth sort for 4D scenes: positions are evaluated at the requested time,
// then a 16-bit counting sort orders splats back to front.
//
// Splats that cannot be visible near t are left out of the order list, so the
// GPU never touches them: a time index (buckets over the clip) lists which
// splats can be alive in each slice of time, from each splat's gate support
// and window. With a splat cap, the alive splats are ranked by opacity × size.

let geo = null;
let count = 0;
let duration = 1;
let alive = null; // streaming pool residency
let ext = null;   // window lo, window hi, group, -
let staticRule = true;
let alphaCut = 0.0016;
let lo = null, hi = null; // per-splat support on the clock
let index = null;
let stamp = null;
let stampGen = 0;
const CUT = 1 / 255;
const EXT = 4;
const POSE = 8;

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

const isStill = (tau) => tau <= 0 || (staticRule && Math.sqrt(0.5 / tau) > 0.6 * duration);

// Support of each splat: where opacity × gate can clear the visibility floor,
// clipped to its window.
function buildSupport() {
  lo = new Float32Array(count);
  hi = new Float32Array(count);
  for (let i = 0; i < count; ++i) {
    const g = i * 16;
    const a = geo[g + 14];
    let l = -Infinity, h = Infinity;
    if (!(a >= alphaCut)) {
      l = Infinity;
      h = -Infinity;
    } else if (!isStill(geo[g + 7])) {
      const half = Math.sqrt(Math.max(0, Math.log(a / alphaCut)) / geo[g + 7]);
      l = geo[g + 3] - half;
      h = geo[g + 3] + half;
    }
    if (ext) {
      l = Math.max(l, ext[i * EXT]);
      h = Math.min(h, ext[i * EXT + 1]);
    }
    lo[i] = l;
    hi[i] = h;
  }
}

// Buckets over [0, duration): splats short enough to sit in a few buckets are
// listed per bucket; long-lived ones go to `always` and are tested each sort.
function buildIndex() {
  const NB = 512;
  const width = duration / NB;
  const span = new Int32Array(count * 2);
  const counts = new Uint32Array(NB);
  const always = [];
  let dead = 0;
  for (let i = 0; i < count; ++i) {
    const l = Math.max(lo[i], 0), h = Math.min(hi[i], duration);
    if (!(h >= l)) {
      span[i * 2] = -1;
      dead++;
      continue;
    }
    const b0 = Math.min(NB - 1, Math.floor(l / width));
    const b1 = Math.min(NB - 1, Math.floor(h / width));
    if (b1 - b0 + 1 > NB / 8) {
      span[i * 2] = -2;
      always.push(i);
      continue;
    }
    span[i * 2] = b0;
    span[i * 2 + 1] = b1;
    for (let b = b0; b <= b1; ++b) counts[b]++;
  }
  const starts = new Uint32Array(NB + 1);
  for (let b = 0; b < NB; ++b) starts[b + 1] = starts[b] + counts[b];
  const ids = new Uint32Array(starts[NB]);
  const fill = starts.slice(0, NB);
  for (let i = 0; i < count; ++i) {
    const b0 = span[i * 2];
    if (b0 < 0) continue;
    for (let b = b0; b <= span[i * 2 + 1]; ++b) ids[fill[b]++] = i;
  }
  index = { NB, width, starts, ids, always: Uint32Array.from(always), dead };
  stamp = new Uint32Array(count);
  stampGen = 0;
}

// Candidate splats for [t − win, t + win] on a looping clock.
function candidates(t, win) {
  const { NB, width, starts, ids, always } = index;
  if (++stampGen >= 0xffffffff) {
    stamp.fill(0);
    stampGen = 1;
  }
  const out = new Uint32Array(always.length + 1024);
  let list = out;
  let n = 0;
  const push = (i) => {
    if (n === list.length) {
      const grown = new Uint32Array(list.length * 2);
      grown.set(list);
      list = grown;
    }
    list[n++] = i;
  };
  for (let k = 0; k < always.length; ++k) push(always[k]);
  const ranges = [];
  const a = t - win, b = t + win;
  if (b - a >= duration) ranges.push([0, duration]);
  else {
    const a0 = ((a % duration) + duration) % duration;
    const b0 = a0 + (b - a);
    if (b0 <= duration) ranges.push([a0, b0]);
    else ranges.push([a0, duration], [0, b0 - duration]);
  }
  for (const [ra, rb] of ranges) {
    const k0 = Math.max(0, Math.min(NB - 1, Math.floor(ra / width)));
    const k1 = Math.max(0, Math.min(NB - 1, Math.floor(rb / width)));
    for (let k = k0; k <= k1; ++k) {
      for (let j = starts[k]; j < starts[k + 1]; ++j) {
        const i = ids[j];
        if (stamp[i] === stampGen) continue;
        stamp[i] = stampGen;
        push(i);
      }
    }
  }
  return { list, n };
}

// Does splat i's support meet [t − win, t + win] on the looping clock?
function supportMeets(i, t, win) {
  const l = lo[i], h = hi[i];
  if (l === -Infinity && h === Infinity) return true;
  if (!(h >= l)) return false;
  for (let k = -1; k <= 1; ++k) {
    const c = t + k * duration;
    if (h >= c - win && l <= c + win) return true;
  }
  return false;
}

function position(i, t, poses, out) {
  const g = i * 16;
  const dt = t - geo[g + 3];
  let x = geo[g] + geo[g + 4] * dt, y = geo[g + 1] + geo[g + 5] * dt, z = geo[g + 2] + geo[g + 6] * dt;
  if (poses && ext) {
    const grp = Math.floor(ext[i * EXT + 2] + 0.5);
    if (grp >= 0 && grp * POSE < poses.length) {
      const o = grp * POSE;
      const qx = poses[o], qy = poses[o + 1], qz = poses[o + 2], qw = poses[o + 3];
      const cx = qy * z - qz * y, cy = qz * x - qx * z, cz = qx * y - qy * x;
      const dx = qy * cz - qz * cy, dy = qz * cx - qx * cz, dz = qx * cy - qy * cx;
      x += 2 * (qw * cx + dx) + poses[o + 4];
      y += 2 * (qw * cy + dy) + poses[o + 5];
      z += 2 * (qw * cz + dz) + poses[o + 6];
    }
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
}

function sortIndexed({ view, t, cap = 0, window: win = 0, poses = null }) {
  const r0 = view[8], r1 = view[9], r2 = view[10], r3 = view[11];
  const { list, n: m } = candidates(t, win);
  const ids = new Uint32Array(m);
  const depth = new Float32Array(m);
  const weight = cap > 0 ? new Float32Array(m) : null;
  const p = [0, 0, 0];
  let n = 0;
  for (let k = 0; k < m; ++k) {
    const i = list[k];
    if (!supportMeets(i, t, win)) continue;
    const g = i * 16;
    position(i, t, poses, p);
    ids[n] = i;
    depth[n] = r0 * p[0] + r1 * p[1] + r2 * p[2] + r3;
    if (weight) weight[n] = geo[g + 14] * (geo[g + 8] + geo[g + 11] + geo[g + 13]);
    n++;
  }
  if (cap > 0 && cap < n) {
    const order = new Uint32Array(n);
    for (let i = 0; i < n; ++i) order[i] = i;
    order.sort((a, b) => weight[b] - weight[a]);
    const ids2 = new Uint32Array(cap), depth2 = new Float32Array(cap);
    for (let i = 0; i < cap; ++i) {
      ids2[i] = ids[order[i]];
      depth2[i] = depth[order[i]];
    }
    return countingSort(depth2, ids2, cap);
  }
  return countingSort(depth, ids, n);
}

// Streaming pool path (nxs4): no index, residency decides.
function sortPool({ view, t, cap = 0, window: win = 0 }) {
  const r0 = view[8], r1 = view[9], r2 = view[10], r3 = view[11];
  let ids = new Uint32Array(count);
  let depth = new Float32Array(count);
  let n = 0;
  if (cap > 0 && cap < count) {
    const weight = new Float32Array(count);
    for (let i = 0; i < count; ++i) {
      if (!alive[i]) continue;
      const g = i * 16;
      const dt = t - geo[g + 3];
      const tau = geo[g + 7];
      let a;
      if (isStill(tau)) {
        a = geo[g + 14];
      } else {
        const ad = Math.abs(dt);
        const gap = Math.max(0, Math.min(ad, duration - ad) - win);
        a = geo[g + 14] * Math.exp(-gap * gap * tau);
      }
      if (a < CUT) continue;
      ids[n] = i;
      depth[n] = r0 * (geo[g] + geo[g + 4] * dt) + r1 * (geo[g + 1] + geo[g + 5] * dt) + r2 * (geo[g + 2] + geo[g + 6] * dt) + r3;
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
    return countingSort(depth, ids, n);
  }
  for (let i = 0; i < count; ++i) {
    if (!alive[i]) continue;
    const g = i * 16;
    const dt = t - geo[g + 3];
    ids[n] = i;
    depth[n] = r0 * (geo[g] + geo[g + 4] * dt) + r1 * (geo[g + 1] + geo[g + 5] * dt) + r2 * (geo[g + 2] + geo[g + 6] * dt) + r3;
    n++;
  }
  return countingSort(depth, ids, n);
}

onmessage = (e) => {
  const m = e.data;
  if (m.geo) {
    geo = m.geo;
    count = m.count;
    duration = m.duration || 1;
    ext = m.ext || null;
    staticRule = m.staticRule !== false;
    alphaCut = Math.max(0.0016, m.alphaCut || 0.0016);
    alive = null;
    buildSupport();
    buildIndex();
    return;
  }
  if (m.poolInit) {
    count = m.poolInit.capacity;
    duration = m.poolInit.duration || 1;
    geo = new Float32Array(count * 16);
    alive = new Uint8Array(count);
    ext = null;
    staticRule = true;
    alphaCut = 0.0016;
    index = null;
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
  const indices = alive ? sortPool(m) : sortIndexed(m);
  postMessage({ indices, t: m.t, gen: m.gen, epoch: m.epoch }, [indices.buffer]);
};
