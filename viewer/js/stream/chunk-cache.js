// Cache API store for streamed chunks. Only URLs that look content-versioned
// (a hash in the path, or ?v= / ?rev= / ?hash=) are cached, so an edited file
// at an unversioned URL is never served stale.

const VERSIONED = [/[.\-_/][0-9a-f]{8,}\b/i, /[?&](v|rev|version|hash)=[^&]{4,}/i];
export const isVersionedUrl = (url) => VERSIONED.some((re) => re.test(String(url)));

function keyFor(url, record) {
  const u = new URL(url, typeof location !== 'undefined' ? location.href : 'https://example.invalid/');
  u.searchParams.set('__tg4dchunk', `${record.byteOffset}+${record.byteLength}`);
  return u.toString();
}

export function createChunkCache({ enabled = true, name = 'tg4d-chunks-v1' } = {}) {
  const available = enabled && typeof caches !== 'undefined';
  return {
    available, hits: 0, misses: 0, stores: 0, declined: 0,
    async getChunk(url, record) {
      if (!available || !isVersionedUrl(url)) return null;
      try {
        const cache = await caches.open(name);
        const res = await cache.match(keyFor(url, record));
        if (!res) {
          this.misses++;
          return null;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength !== record.byteLength) {
          await cache.delete(keyFor(url, record));
          this.misses++;
          return null;
        }
        this.hits++;
        return bytes;
      } catch {
        return null;
      }
    },
    async putChunk(url, record, bytes) {
      if (!available) return false;
      if (!isVersionedUrl(url)) {
        this.declined++;
        return false;
      }
      try {
        const copy = bytes.slice();
        await (await caches.open(name)).put(keyFor(url, record), new Response(copy, {
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(copy.byteLength), 'Cache-Control': 'max-age=31536000' },
        }));
        this.stores++;
        return true;
      } catch {
        return false;
      }
    },
    stats() {
      return { available, hits: this.hits, misses: this.misses, stores: this.stores, declined: this.declined };
    },
  };
}
