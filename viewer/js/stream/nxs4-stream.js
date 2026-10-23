// Streaming player for the .nxs4 profile. The coarse layer arrives first and
// paints; full-detail chunks are then fetched by priority — alive now and in
// view, alive soon, everything else when bandwidth allows — into a fixed GPU
// pool, evicting what the clock and the camera no longer need.

import { parseNxs4Superblock, parseChunkIndex, parseAudioIndex, verifyAudioChunk, temporalZUpToViewer, CHUNK_RECORD } from '../loaders/nx4d.js';
import { temporalBounds } from '../core/scene.js';
import { aabbInFrustum, frustumPlanes } from '../core/camera.js';
import { buildPoolPage } from '../render/webgl-renderer.js';
import { createBandwidthEstimator, createRangeFetcher, lookaheadSeconds } from './range-fetch.js';
import { allocate, clearPool, createPool, isResident, poolCapacity, release, touch } from './pool.js';
import { createChunkCache } from './chunk-cache.js';

const HEAD_BYTES = 65536;
const TICK_MS = 250;
const MAX_GROUPS = 4;
const AUDIO_TAIL_MAX = 4 * 1024 * 1024;
const COALESCE_MAX = 4 * 1024 * 1024;
const PRESSURE_STEPS = [3, 8, 16];
const PRESSURE_NAMES = ['normal', 'reduced lookahead', 'coarse layer only', 'paused'];

// Seconds until a chunk's alive interval [tMin, tMax] comes round again.
export function timeToActive(t, tMin, tMax, duration) {
  return tMin <= t && t <= tMax ? 0 : (tMin - t + duration) % duration;
}

export function planFetches(records, ctx) {
  const wanted = [];
  for (let i = 0; i < records.length; ++i) {
    if (ctx.isResident(i) || ctx.inFlight(i)) continue;
    const r = records[i];
    if (i < ctx.coarseChunkCount) {
      wanted.push({ index: i, priority: 0, tDist: i });
      continue;
    }
    if (r.lodLayer !== 1 || ctx.coarseOnly) continue;
    const tDist = timeToActive(ctx.t, r.gateTMin, r.gateTMax, ctx.duration);
    const soon = tDist <= ctx.lookahead;
    const seen = !ctx.planes || aabbInFrustum(ctx.planes, r.aabbMin, r.aabbMax);
    if (soon && seen) wanted.push({ index: i, priority: 1, tDist });
    else if (soon) wanted.push({ index: i, priority: 2, tDist });
    else if (ctx.prefetchAll) wanted.push({ index: i, priority: 3, tDist });
  }
  wanted.sort((a, b) => a.priority - b.priority || a.tDist - b.tDist || a.index - b.index);
  const groups = [];
  for (const w of wanted) {
    const r = records[w.index];
    const last = groups[groups.length - 1];
    const gap = last ? r.byteOffset - (last.byteOffset + last.byteLength) : Infinity;
    if (last && last.priority === w.priority && w.priority !== 0 && gap >= 0 && gap <= 3 &&
      last.byteLength + gap + r.byteLength <= (ctx.maxCoalescedBytes ?? COALESCE_MAX)) {
      last.records.push(w.index);
      last.byteLength = r.byteOffset + r.byteLength - last.byteOffset;
    } else {
      groups.push({ records: [w.index], byteOffset: r.byteOffset, byteLength: r.byteLength, priority: w.priority });
    }
  }
  return groups;
}

export async function openNxs4Stream(opts) {
  const { renderer, sortPost, signal } = opts;
  const budget = opts.dataBudget ?? {};
  const cache = opts.cache ?? createChunkCache();
  const bw = createBandwidthEstimator();
  const fetcher = createRangeFetcher(opts.url, {
    onSample: (b, ms) => bw.addSample(b, ms),
    decorate: opts.fetchDecorator,
    onAuthFailure: opts.onAuthFailure,
  });

  const head = await fetcher.fetchRange(0, HEAD_BYTES - 1, { signal });
  const sb = parseNxs4Superblock(head);
  const h = sb.header;
  const indexEnd = sb.chunkIndexOffset + sb.chunkCount * CHUNK_RECORD;
  let indexBytes;
  if (indexEnd <= head.byteLength) {
    indexBytes = head.subarray(sb.chunkIndexOffset, indexEnd);
  } else if (sb.chunkIndexOffset < head.byteLength) {
    const rest = await fetcher.fetchRange(head.byteLength, indexEnd - 1, { signal });
    indexBytes = new Uint8Array(indexEnd - sb.chunkIndexOffset);
    indexBytes.set(head.subarray(sb.chunkIndexOffset));
    indexBytes.set(rest, head.byteLength - sb.chunkIndexOffset);
  } else {
    indexBytes = await fetcher.fetchRange(sb.chunkIndexOffset, indexEnd - 1, { signal });
  }
  const records = parseChunkIndex(indexBytes, sb.chunkCount);

  let audioTracks = [];
  let audioTail = null;
  if (sb.audioIndexOffset && sb.audioTrackCount) {
    try {
      const end = fetcher.totalBytes ? fetcher.totalBytes - 1 : sb.audioIndexOffset + AUDIO_TAIL_MAX - 1;
      if (end - sb.audioIndexOffset + 1 > AUDIO_TAIL_MAX) throw new Error('audio tail exceeds the one-shot budget');
      audioTail = await fetcher.fetchRange(sb.audioIndexOffset, end, { signal });
      audioTracks = parseAudioIndex(audioTail, 0, sb.audioTrackCount);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('[4dviewer] audio unavailable, continuing without it:', err.message || err);
      audioTracks = [];
      audioTail = null;
    }
  }

  const duration = h.duration;
  const shB = (h.sh_l + 1) ** 2;
  const fineBytes = records.filter((r) => r.lodLayer === 1).reduce((s, r) => s + r.byteLength, 0);
  const zUp = opts.up === 'z' || (h.up === 'z' && opts.up !== 'y');
  const coarseSplats = records.slice(0, h.coarse_chunk_count).reduce((s, r) => s + r.splatCount, 0);
  const capacity = poolCapacity({
    deviceMemory: typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined,
    coarsePointer: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
    countTotal: h.count_total, shF: h.sh_f, shB,
    override: opts.poolOverride || h.pool_hint_splats || 0,
    slack: coarseSplats + records.length * 4096,
  });
  let info = renderer.allocTemporalPool({ capacity, shF: h.sh_f, shB, duration });
  const pool = createPool({ capacity: info.capacity, rowWidth: info.rowWidth });
  sortPost({ poolInit: { capacity: info.capacity, duration } });
  if (signal?.aborted) throw new DOMException('stream open aborted', 'AbortError');

  // Chunk decoding in a dedicated worker.
  const worker = new Worker(new URL('./chunk-worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let seq = 0;
  worker.onmessage = (e) => {
    const p = pending.get(e.data.seq);
    if (!p) return;
    pending.delete(e.data.seq);
    if (e.data.ok) p.resolve(e.data);
    else p.reject(new Error(e.data.error));
  };
  const decode = (compressed, record) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ seq: id, compressed, record, header: { sh_f: h.sh_f, sh_l: h.sh_l }, up: zUp ? 'z' : undefined },
      [compressed.buffer]);
  });

  const coarseSlotOf = new Uint32Array(h.count_total); // slot + 1 of a splat's coarse copy
  const hasFine = new Uint8Array(h.count_total);
  const coarseChunkOf = new Map();
  const liveCoarse = new Map();
  const coarseIds = new Map();
  const inFlight = new Set();
  const controllers = new Map();
  const deferred = new Map();
  const failures = new Map();
  const superseded = new Set(); // coarse chunks whose every splat now has full detail
  let coarseResident = 0;
  let destroyed = false;
  let firstSceneSent = false;
  let pressureEvents = 0;
  let pressure = 0;
  let cacheHits = 0;

  const stats = {
    url: opts.url,
    get totalBytes() { return fetcher.totalBytes; },
    get bytesReceived() { return fetcher.bytesReceived; },
    poolCapacity: pool.capacity,
    get residentSplats() { return pool.residentSplats; },
    get chunksResident() { return pool.used.size; },
    get peakResidentSplats() { return pool.peakResidentSplats; },
    get evictions() { return pool.evictions; },
    get requests() { return fetcher.requests; },
    get retries() { return fetcher.retries; },
    get resumes() { return fetcher.resumes; },
    get deferrals() { return deferred.size; },
    get cacheHits() { return cacheHits; },
    get bandwidth() { return bw.bytesPerSecond; },
    openedAt: performance.now(),
    ttfsMs: 0,
    chunkCount: records.length,
    coarseChunkCount: h.coarse_chunk_count,
    pressureLevel: 0,
  };

  function raisePressure(reason) {
    pressureEvents++;
    const level = PRESSURE_STEPS.filter((s) => pressureEvents >= s).length;
    if (level === pressure) return;
    pressure = level;
    stats.pressureLevel = level;
    console.warn(`[4dviewer] memory pressure (${reason}) — degrading to: ${PRESSURE_NAMES[level]}`);
    opts.onPressure?.({ level, reason, what: PRESSURE_NAMES[level] });
    if (level >= 3) opts.onError?.(new Error(`out of GPU pool for this scene — playback paused (${reason})`));
  }

  function relievePressure() {
    if (pressureEvents === 0) return;
    pressureEvents = 0;
    if (pressure !== 0) {
      pressure = 0;
      stats.pressureLevel = 0;
      opts.onPressure?.({ level: 0, reason: 'recovered', what: 'normal' });
    }
  }

  function context() {
    const cam = opts.getCamera?.();
    const bitrate = fineBytes / Math.max(duration, 1e-6);
    return {
      t: opts.getT(),
      lookahead: (lookaheadSeconds(bw.bytesPerSecond, bitrate, duration) * (budget.lookaheadScale ?? 1)) / (pressure >= 1 ? 4 : 1),
      coarseOnly: pressure >= 2 || !!budget.coarseOnly,
      duration,
      planes: cam ? frustumPlanes(cam.m, cam.eye, cam.fovY, cam.aspect) : null,
      isResident: (i) => isResident(pool, String(i)) || superseded.has(i) || (deferred.get(i) ?? 0) > performance.now(),
      inFlight: (i) => inFlight.has(i),
      prefetchAll: pressure >= 1 || budget.prefetch === false || bw.bytesPerSecond === 0 ? false : bw.bytesPerSecond >= 2 * bitrate,
      coarseChunkCount: h.coarse_chunk_count,
    };
  }

  const evictable = (ctx) => (key) => {
    const r = records[Number(key)];
    if (!r || r.lodLayer !== 1) return false;
    const soon = timeToActive(ctx.t, r.gateTMin, r.gateTMax, ctx.duration) <= ctx.lookahead;
    const seen = !ctx.planes || aabbInFrustum(ctx.planes, r.aabbMin, r.aabbMax);
    return !(soon && seen);
  };

  function onEvicted(key, entry) {
    const index = Number(key);
    renderer.clearPoolRows(entry.rowStart, entry.rowCount);
    sortPost({ poolEvict: { offset: entry.slotOffset, count: entry.slotCount } });
    if (records[index]?.lodLayer === 0) {
      coarseResident -= entry.splatCount;
      for (const id of coarseIds.get(index) || []) coarseSlotOf[id] = 0;
      coarseIds.delete(index);
      liveCoarse.delete(index);
    }
  }

  function place(index, chunk) {
    const rec = records[index];
    const coarse = index < h.coarse_chunk_count;
    if (coarse && index > 0 && coarseResident + chunk.count > pool.capacity / 2) {
      deferred.set(index, Infinity);
      return false;
    }
    const res = allocate(pool, String(index), chunk.count, { pinned: coarse, evictable: evictable(context()) });
    if (!res) return false;
    for (const ev of res.evicted) onEvicted(ev.key, ev.entry);
    renderer.uploadPoolPage(res.rowStart, buildPoolPage(chunk, info.rowWidth, info));
    if (rec.lodLayer === 1) {
      const kill = [];
      for (const id of chunk.ids) {
        hasFine[id] = 1;
        const slot = coarseSlotOf[id];
        if (!slot) continue;
        kill.push(slot - 1);
        coarseSlotOf[id] = 0;
        const ci = coarseChunkOf.get(id);
        coarseChunkOf.delete(id);
        const left = (liveCoarse.get(ci) ?? 0) - 1;
        liveCoarse.set(ci, left);
        if (left === 0) {
          superseded.add(ci);
          const e = release(pool, String(ci));
          if (e) onEvicted(String(ci), e);
        }
      }
      sortPost({ poolPage: { offset: res.slotOffset, count: chunk.count, geo: chunk.geo } }, [chunk.geo.buffer]);
      if (kill.length) sortPost({ poolKill: { slots: Uint32Array.from(kill) } });
    } else {
      const kill = [];
      let live = 0;
      chunk.ids.forEach((id, j) => {
        if (hasFine[id]) {
          kill.push(res.slotOffset + j);
          return;
        }
        coarseSlotOf[id] = res.slotOffset + j + 1;
        coarseChunkOf.set(id, index);
        live++;
      });
      const ids = Array.from(chunk.ids);
      sortPost({ poolPage: { offset: res.slotOffset, count: chunk.count, geo: chunk.geo } }, [chunk.geo.buffer]);
      if (kill.length) sortPost({ poolKill: { slots: Uint32Array.from(kill) } });
      if (live === 0) {
        superseded.add(index);
        const e = release(pool, String(index));
        if (e) onEvicted(String(index), e);
      } else {
        coarseResident += chunk.count;
        liveCoarse.set(index, live);
        coarseIds.set(index, ids);
      }
    }
    return true;
  }

  function announceFirst(chunk) {
    firstSceneSent = true;
    let view = h.view || null;
    if (zUp && view) view = temporalZUpToViewer(new Float32Array(0), new Uint16Array(0), 0, h.sh_l, h.sh_f, view);
    const { center, radius } = temporalBounds(chunk.geo, chunk.count);
    opts.onFirstScene({
      kind: 'temporal', sourceFormat: 'nxs4', count: h.count_total, duration, shL: h.sh_l, shF: h.sh_f, shB,
      center, radius, view, credit: h.credit || null, streaming: true,
      audio: h.audio ? { ...h.audio, up: zUp ? 'z' : 'y' } : null,
    });
  }

  async function fetchGroup(group) {
    const ac = new AbortController();
    const onOuterAbort = () => ac.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    for (const i of group.records) {
      inFlight.add(i);
      controllers.set(i, ac);
    }
    try {
      const cached = await Promise.all(group.records.map((i) => cache.getChunk(opts.url, records[i])));
      const bytes = cached.every(Boolean) ? null
        : await fetcher.fetchRange(group.byteOffset, group.byteOffset + group.byteLength - 1, { signal: ac.signal });
      for (let k = 0; k < group.records.length; ++k) {
        const index = group.records[k];
        const rec = records[index];
        let payload;
        if (cached[k]) {
          payload = cached[k];
          cacheHits++;
        } else {
          payload = bytes.slice(rec.byteOffset - group.byteOffset, rec.byteOffset - group.byteOffset + rec.byteLength);
          cache.putChunk(opts.url, rec, payload);
        }
        const chunk = await decode(payload, rec);
        if (destroyed) return;
        if (!firstSceneSent) announceFirst(chunk);
        if (place(index, chunk)) {
          failures.delete(index);
          relievePressure();
          opts.onResidencyChange?.();
        } else {
          deferred.set(index, performance.now() + 2000);
          raisePressure(`chunk ${index} did not fit the pool`);
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        for (const i of group.records) {
          const n = (failures.get(i) ?? 0) + 1;
          failures.set(i, n);
          if (n >= 3) {
            deferred.set(i, Infinity);
            raisePressure(`chunk ${i} failed ${n}× (${err.message || err})`);
          }
        }
        opts.onError?.(err);
      }
    } finally {
      signal?.removeEventListener('abort', onOuterAbort);
      for (const i of group.records) {
        inFlight.delete(i);
        controllers.delete(i);
      }
    }
  }

  let ticking = false;
  function tick() {
    if (destroyed || ticking || pressure >= 3) return;
    ticking = true;
    try {
      const ctx = context();
      for (const [i, ac] of controllers) {
        if (i < h.coarse_chunk_count) continue;
        const r = records[i];
        if (timeToActive(ctx.t, r.gateTMin, r.gateTMax, duration) > ctx.lookahead && !ctx.prefetchAll) ac.abort();
      }
      const groups = planFetches(records, ctx);
      const active = new Set(controllers.values()).size;
      const slots = stats.ttfsMs > 0 ? MAX_GROUPS - active : active > 0 ? 0 : 1;
      for (const g of groups.slice(0, Math.max(0, slots))) {
        for (const i of g.records) touch(pool, String(i));
        fetchGroup(g);
      }
    } finally {
      ticking = false;
    }
  }

  renderer.onPoolLost = () => {
    if (destroyed) return;
    info = renderer.allocTemporalPool({ capacity: info.capacity, shF: h.sh_f, shB, duration });
    clearPool(pool);
    sortPost({ poolInit: { capacity: info.capacity, duration } });
    coarseSlotOf.fill(0);
    hasFine.fill(0);
    coarseChunkOf.clear();
    liveCoarse.clear();
    coarseIds.clear();
    deferred.clear();
    superseded.clear();
    coarseResident = 0;
    opts.onResidencyChange?.();
    tick();
  };

  const timer = setInterval(tick, TICK_MS);
  tick();

  return {
    stats,
    records,
    header: h,
    pool,
    audio: h.audio ?? null,
    audioTracks,
    async fetchAudioChunk(chunk) {
      const end = chunk.byteOffset + chunk.byteLength;
      if (audioTail && chunk.byteOffset >= sb.audioIndexOffset && end - sb.audioIndexOffset <= audioTail.byteLength) {
        const from = chunk.byteOffset - sb.audioIndexOffset;
        return verifyAudioChunk(audioTail.slice(from, from + chunk.byteLength), chunk);
      }
      return verifyAudioChunk(await fetcher.fetchRange(chunk.byteOffset, end - 1, { signal }), chunk);
    },
    markFirstPaint() {
      if (!stats.ttfsMs) stats.ttfsMs = performance.now() - stats.openedAt;
    },
    getBuffered() {
      const spans = [];
      let min = null, max = null;
      for (const key of pool.used.keys()) {
        const r = records[Number(key)];
        if (!r || r.lodLayer !== 1) continue;
        spans.push([r.gateTMin, r.gateTMax]);
        if (!min) {
          min = [...r.aabbMin];
          max = [...r.aabbMax];
        } else {
          for (let a = 0; a < 3; ++a) {
            min[a] = Math.min(min[a], r.aabbMin[a]);
            max[a] = Math.max(max[a], r.aabbMax[a]);
          }
        }
      }
      spans.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const s of spans) {
        const last = merged[merged.length - 1];
        if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
        else merged.push([...s]);
      }
      return { time: merged, space: min ? { min, max } : null };
    },
    destroy() {
      destroyed = true;
      clearInterval(timer);
      for (const ac of new Set(controllers.values())) ac.abort();
      worker.terminate();
      renderer.onPoolLost = null;
    },
  };
}
