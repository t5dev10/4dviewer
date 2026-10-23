// Hostile-input guards shared by every parser. A malformed or malicious file
// must fail with a sentence a person can act on, never with a multi-gigabyte
// allocation or a decompression bomb.

export const LIMITS = Object.freeze({
  MAX_SPLATS: 64e6,
  MAX_HEADER_BYTES: 1 << 20,
  MAX_SH_DEGREE: 3,
  MAX_SH_FOURIER: 64,
  MAX_DECOMPRESSED_BYTES: 1.5e9,
  MAX_COMPRESSION_RATIO: 400,
  MAX_CHUNKS: 1e5,
  MAX_AUDIO_TRACKS: 64,
  MAX_AUDIO_CHUNKS_PER_TRACK: 1e5,
  MAX_ZIP_ENTRIES: 4096,
  MAX_ZIP_ENTRY_BYTES: 256 * 1024 * 1024,
  MAX_GLTF_NODES: 1e6,
  MAX_GLTF_DEPTH: 256,
  MAX_ALLOC_BYTES: 1.5e9,
});

export class HostileInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HostileInputError';
  }
}

export function refuse(message) {
  throw new HostileInputError(message);
}

export function checkInt(what, value, lo, hi) {
  if (!Number.isInteger(value) || value < lo || value > hi) {
    refuse(`${what}: expected an integer in [${lo}, ${hi}], got ${JSON.stringify(value)}`);
  }
  return value;
}

export function checkNumber(what, value, lo = -Infinity, hi = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi) {
    refuse(`${what}: expected a finite number in [${lo}, ${hi}], got ${JSON.stringify(value)}`);
  }
  return value;
}

export function checkCount(what, value) {
  return checkInt(what, value, 0, LIMITS.MAX_SPLATS);
}

// `declared` bytes must fit inside the `available` bytes actually present.
export function checkPayload(what, declared, available, { exact = false } = {}) {
  if (!Number.isFinite(declared) || declared < 0) refuse(`${what}: implausible payload size ${declared}`);
  if (declared > LIMITS.MAX_ALLOC_BYTES) {
    refuse(`${what}: declared payload ${declared} B exceeds the ${LIMITS.MAX_ALLOC_BYTES} B ceiling`);
  }
  if (available < declared) {
    refuse(`${what}: header declares ${declared} B but only ${available} B are present (truncated or fabricated count)`);
  }
  if (exact && available !== declared) refuse(`${what}: expected exactly ${declared} B, found ${available} B`);
  return declared;
}

export function alloc(what, Ctor, length) {
  const bytes = length * (Ctor.BYTES_PER_ELEMENT ?? 1);
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > LIMITS.MAX_ALLOC_BYTES) {
    refuse(`${what}: refusing to allocate ${bytes} B (ceiling ${LIMITS.MAX_ALLOC_BYTES} B)`);
  }
  try {
    return new Ctor(length);
  } catch (err) {
    refuse(`${what}: allocation of ${bytes} B failed (${err.message})`);
  }
}

function concat(chunks, total, what) {
  const out = alloc(what, Uint8Array, total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// Streaming decompression ('gzip' | 'deflate' | 'deflate-raw') with an output
// ceiling derived from the input size, so a bomb is cancelled mid-stream.
export async function decompress(input, format, opts = {}) {
  const src = input instanceof Uint8Array ? input : new Uint8Array(input);
  const what = opts.what ?? 'payload';
  const ratio = opts.maxRatio ?? LIMITS.MAX_COMPRESSION_RATIO;
  const ceiling = opts.declaredOut != null
    ? Math.min(opts.declaredOut, opts.maxOut ?? LIMITS.MAX_DECOMPRESSED_BYTES, LIMITS.MAX_DECOMPRESSED_BYTES)
    : Math.min(opts.maxOut ?? LIMITS.MAX_DECOMPRESSED_BYTES, LIMITS.MAX_DECOMPRESSED_BYTES,
      Math.max(64 * 1024, src.byteLength * ratio));
  const reader = new Response(src).body.pipeThrough(new DecompressionStream(format)).getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > ceiling) {
        await reader.cancel().catch(() => {});
        refuse(`${what}: decompressed output exceeded ${ceiling} B (input ${src.byteLength} B — refusing a ` +
          `${Math.round(total / Math.max(src.byteLength, 1))}× expansion)`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof HostileInputError) throw err;
    // A prefix probe (header sniffing) legitimately ends mid-stream.
    if (opts.allowTruncated && total > 0) return concat(chunks, total, what);
    refuse(`${what}: decompression failed (${err.message || err})`);
  }
  return concat(chunks, total, what);
}

export function parseJsonHeader(what, bytes, length) {
  checkInt(`${what} header length`, length, 2, LIMITS.MAX_HEADER_BYTES);
  checkPayload(`${what} header`, length, bytes.byteLength);
  let obj;
  try {
    obj = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
  } catch (err) {
    refuse(`${what}: header is not valid JSON (${err.message})`);
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) refuse(`${what}: header must be a JSON object`);
  return obj;
}

// Archive entry names must stay inside the archive.
export function checkEntryName(name) {
  if (typeof name !== 'string' || !name) refuse('archive: entry has no name');
  if (name.length > 1024) refuse('archive: entry name is implausibly long');
  if (name.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(name)) refuse(`archive: absolute entry path "${name}"`);
  if (name.split(/[\\/]/).includes('..')) refuse(`archive: entry path escapes the archive ("${name}")`);
  if (name.includes('\0')) refuse('archive: entry name contains a NUL byte');
  return name;
}
