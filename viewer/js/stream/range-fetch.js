// HTTP range reads with retry, resume of short reads, and an optional hook
// to sign requests or refresh credentials.

const isAbort = (e) => e?.name === 'AbortError';

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
}

export function createRangeFetcher(url, { onSample, maxAttempts = 4, decorate, onAuthFailure } = {}) {
  return {
    url,
    bytesReceived: 0,
    totalBytes: 0,
    requests: 0,
    retries: 0,
    resumes: 0,
    // Inclusive byte range [start, end].
    async fetchRange(start, end, { signal } = {}) {
      const began = performance.now();
      let assembled = null;
      let got = 0;
      let lastError = null;
      let refreshed = false;
      for (let attempt = 0; attempt < maxAttempts; ++attempt) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        if (attempt > 0) {
          this.retries++;
          await sleep(Math.min(2000, 120 * 2 ** (attempt - 1)), signal);
        }
        const from = start + got;
        if (got > 0) this.resumes++;
        try {
          let target = this.url;
          let headers = { Range: `bytes=${from}-${end}` };
          if (decorate) {
            const d = await decorate({ url: target, headers: { ...headers } });
            if (d?.url) target = d.url;
            if (d?.headers) headers = { ...headers, ...d.headers };
          }
          const res = await fetch(target, { headers, signal });
          this.requests++;
          if ((res.status === 401 || res.status === 403) && onAuthFailure && !refreshed) {
            refreshed = true;
            if (await onAuthFailure(res.status)) {
              lastError = new Error(`stream: credentials refreshed after ${res.status}`);
              continue;
            }
            throw new Error(`stream: access denied (${res.status}) and the host declined to refresh`);
          }
          if (res.status !== 206) {
            const err = new Error(`stream: expected 206 for range ${from}-${end}, got ${res.status} (the host must honour single byte ranges)`);
            if (res.status >= 500) {
              lastError = err;
              continue;
            }
            throw err;
          }
          const cr = res.headers.get('Content-Range');
          const m = cr && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
          if (m) this.totalBytes = Number(m[3]);
          const body = new Uint8Array(await res.arrayBuffer());
          this.bytesReceived += body.byteLength;
          const want = (this.totalBytes ? Math.min(end, this.totalBytes - 1) : end) - start + 1;
          if (got === 0 && body.byteLength === want) {
            onSample?.(body.byteLength, performance.now() - began);
            return body;
          }
          if (!assembled) assembled = new Uint8Array(want);
          if (got + body.byteLength > want) throw new Error(`stream: range ${start}-${end} over-delivered`);
          assembled.set(body, got);
          got += body.byteLength;
          if (got === want) {
            onSample?.(got, performance.now() - began);
            return assembled;
          }
          lastError = new Error(`stream: range ${start}-${end} truncated at ${got}/${want} B`);
        } catch (err) {
          if (isAbort(err) || attempt === maxAttempts - 1) throw err;
          lastError = err;
        }
      }
      throw lastError ?? new Error(`stream: range ${start}-${end} failed after ${maxAttempts} attempts`);
    },
  };
}

// Throughput estimate, smoothed by bytes rather than by time.
export function createBandwidthEstimator({ halfLifeBytes = 2 * 1024 * 1024 } = {}) {
  return {
    bytesPerSecond: 0,
    addSample(bytes, ms) {
      if (!(ms > 0) || !(bytes > 0)) return;
      const rate = bytes / (ms / 1000);
      if (this.bytesPerSecond === 0) {
        this.bytesPerSecond = rate;
        return;
      }
      const w = 1 - 0.5 ** (bytes / halfLifeBytes);
      this.bytesPerSecond += (rate - this.bytesPerSecond) * w;
    },
  };
}

// Seconds of lookahead: with throughput to spare, prefetch the whole clip.
export function lookaheadSeconds(bytesPerSecond, bytesPerSecondNeeded, duration) {
  if (!(bytesPerSecond > 0) || !(bytesPerSecondNeeded > 0)) return 1.5;
  const ratio = bytesPerSecond / bytesPerSecondNeeded;
  return ratio >= 2 ? duration : Math.min(duration, Math.max(1.5, ratio * duration * 0.5));
}
