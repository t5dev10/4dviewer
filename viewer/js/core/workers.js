// Shared decode workers: a few per page, reused across loads and viewers.

const pools = new Map();
let seq = 0;

const decodeCap = () => Math.max(1, Math.min(4, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4) - 2));

function pool(name, factory) {
  let p = pools.get(name);
  if (!p) {
    p = { slots: [], queue: [], factory };
    pools.set(name, p);
  }
  return p;
}

function retire(p, slot, error) {
  const job = slot.job;
  slot.job = null;
  try {
    slot.worker.terminate();
  } catch {
    // already gone
  }
  p.slots.splice(p.slots.indexOf(slot), 1);
  job?.reject(error instanceof Error ? error : new Error(String(error)));
}

function pump(p) {
  while (p.queue.length) {
    let slot = p.slots.find((s) => !s.job);
    if (!slot && p.slots.length < decodeCap()) {
      slot = { worker: p.factory(), job: null };
      p.slots.push(slot);
      slot.worker.onmessage = (e) => {
        const job = slot.job;
        if (!job || e.data?.seq !== job.seq) return;
        slot.job = null;
        if (e.data.ok) job.resolve(e.data);
        else job.reject(new Error(e.data.error || 'worker job failed'));
        pump(p);
      };
      slot.worker.onerror = (e) => {
        e.preventDefault?.();
        retire(p, slot, e.message || 'worker error');
        pump(p);
      };
    }
    if (!slot) return;
    const job = p.queue.shift();
    slot.job = job;
    try {
      slot.worker.postMessage({ ...job.message, seq: job.seq }, job.transfer);
    } catch (err) {
      slot.job = null;
      job.reject(err);
    }
  }
}

export function runWorkerJob(name, factory, message, transfer = []) {
  const p = pool(name, factory);
  return new Promise((resolve, reject) => {
    p.queue.push({ message, transfer, resolve, reject, seq: ++seq });
    pump(p);
  });
}

export function workerPoolStats() {
  const out = {};
  for (const [name, p] of pools) out[name] = { workers: p.slots.length, queued: p.queue.length };
  return out;
}
