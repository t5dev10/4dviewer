// Row allocator for the streaming GPU pool. Chunks occupy whole texture rows;
// when full, the least recently touched evictable chunk is freed.

export function createPool({ capacity, rowWidth }) {
  const rows = Math.floor(capacity / rowWidth);
  if (rows < 1) throw new Error('pool: capacity smaller than one texture row');
  return {
    rowWidth, rows, capacity: rows * rowWidth,
    used: new Map(), freeRows: [{ start: 0, count: rows }],
    residentSplats: 0, peakResidentSplats: 0, evictions: 0, clock: 0,
  };
}

function takeRows(pool, n) {
  for (let i = 0; i < pool.freeRows.length; ++i) {
    const r = pool.freeRows[i];
    if (r.count >= n) {
      const start = r.start;
      r.start += n;
      r.count -= n;
      if (r.count === 0) pool.freeRows.splice(i, 1);
      return start;
    }
  }
  return -1;
}

function giveRows(pool, start, count) {
  pool.freeRows.push({ start, count });
  pool.freeRows.sort((a, b) => a.start - b.start);
  for (let i = pool.freeRows.length - 2; i >= 0; --i) {
    const a = pool.freeRows[i], b = pool.freeRows[i + 1];
    if (a.start + a.count === b.start) {
      a.count += b.count;
      pool.freeRows.splice(i + 1, 1);
    }
  }
}

export const isResident = (pool, key) => pool.used.has(key);

export function touch(pool, key) {
  const e = pool.used.get(key);
  if (e) e.lastTouch = ++pool.clock;
}

export function release(pool, key) {
  const e = pool.used.get(key);
  if (!e) return null;
  pool.used.delete(key);
  pool.residentSplats -= e.splatCount;
  giveRows(pool, e.rowStart, e.rowCount);
  return e;
}

// Returns { rowStart, slotOffset, splatCount, evicted: [{key, entry}] } or null.
export function allocate(pool, key, splatCount, { pinned = false, evictable = () => true } = {}) {
  if (pool.used.has(key)) throw new Error(`pool: "${key}" already resident`);
  const need = Math.ceil(splatCount / pool.rowWidth);
  if (need > pool.rows) return null;
  const evicted = [];
  for (;;) {
    const start = takeRows(pool, need);
    if (start !== -1) {
      const entry = {
        rowStart: start, rowCount: need, slotOffset: start * pool.rowWidth, slotCount: need * pool.rowWidth,
        splatCount, lastTouch: ++pool.clock, pinned,
      };
      pool.used.set(key, entry);
      pool.residentSplats += splatCount;
      pool.peakResidentSplats = Math.max(pool.peakResidentSplats, pool.residentSplats);
      return { rowStart: start, slotOffset: entry.slotOffset, splatCount, evicted };
    }
    let victim = null;
    for (const [k, e] of pool.used) {
      if (e.pinned || !evictable(k)) continue;
      if (!victim || e.lastTouch < pool.used.get(victim).lastTouch) victim = k;
    }
    if (victim === null) return null;
    evicted.push({ key: victim, entry: pool.used.get(victim) });
    release(pool, victim);
    pool.evictions++;
  }
}

export function clearPool(pool) {
  pool.used.clear();
  pool.freeRows = [{ start: 0, count: pool.rows }];
  pool.residentSplats = 0;
  pool.clock = 0;
}

// Splat capacity from device memory, form factor and the scene's per-splat cost.
// `slack` covers what has to live beside the full-detail layer: the pinned
// coarse layer and each chunk's partly filled last row. When it fits, every
// chunk can be resident at once and nothing has to be evicted.
export function poolCapacity({ deviceMemory, coarsePointer, countTotal, shF, shB, override, slack = 0 }) {
  if (override > 0) return Math.min(override, countTotal + slack);
  const roomy = (deviceMemory ?? 8) >= 8 && !coarsePointer;
  const tight = coarsePointer && (deviceMemory ?? 4) <= 4;
  const maxSplats = roomy ? 16e6 : tight ? 1.5e6 : 4e6;
  const maxBytes = (roomy ? 1024 : tight ? 256 : 512) * 1024 * 1024;
  const perSplat = 64 + 8 * shF * shB + 4;
  return Math.max(1, Math.min(maxSplats, Math.floor(maxBytes / perSplat), countTotal + slack));
}
