// 4D containers.
//
// .nx4d (monolithic): gzip( u32 magic | u32 header_len | JSON {format:"nx4d-v1", count,
//   duration, sh_l, sh_f, view?} | f32 geo[count][16] | f16 sht[count][sh_f][(sh_l+1)^2][3] )
// .nxs4 (streamable): u32 magic | u16 major | u16 minor | u32 header_len | JSON (padded to 4)
//   | superblock { u64 chunk_index_offset, u32 chunk_count, u32 pad, u64 audio_index_offset,
//   u32 audio_track_count, u32 crc32c(file[0 .. here)) } ... chunk payloads, 64-byte chunk
//   index records, audio index. Chunk payload = gzip( u32 ids[n] | f32 geo[n][16] | f16 sht ).
//
// geo per splat: mu.xyz, mu_t, v.xyz, tau, Σxx Σxy Σxz Σyy Σyz Σzz, opacity, flags.
// p(t) = mu + v (t - mu_t), alpha(t) = opacity · exp(-(t - mu_t)² τ),
// rgb(t, d) = 0.5 + Σ_n Σ_b cos(2π n (t - mu_t) / T) Y_b(d) c_nb.

import {
  alloc, checkCount, checkInt, checkNumber, checkPayload, decompress, LIMITS, parseJsonHeader,
} from '../core/limits.js';
import { MAGIC } from '../core/formats.js';
import { crc32c } from '../core/crc32c.js';
import { halfTable, floatToHalf } from '../core/half.js';
import { temporalBounds } from '../core/scene.js';
import { R_ZUP, rotateShGroups, shRotationMatrices } from '../core/sh.js';

export const NXS4_MAJOR = 1;
const REQUIRED = ['count_total', 'duration', 'sh_l', 'sh_f', 'chunk_codec', 'profile', 'coarse_chunk_count', 'layer_count'];
const ALLOWED = new Set([...REQUIRED, 'up', 'view', 'pool_hint_splats', 'poster', 'credit', 'audio', 'color']);
const pad4 = (n) => (n + 3) & ~3;
const bands = (l) => (l + 1) * (l + 1);

// --- frame change: Z-up source -> viewer frame (x, y, z) -> (x, -z, y) -------

export function temporalZUpToViewer(geo, sht, count, shL, shF, view) {
  for (let i = 0; i < count; ++i) {
    const g = i * 16;
    let a = geo[g + 1], b = geo[g + 2];
    geo[g + 1] = -b; geo[g + 2] = a;
    a = geo[g + 5]; b = geo[g + 6];
    geo[g + 5] = -b; geo[g + 6] = a;
    const xy = geo[g + 9], xz = geo[g + 10], yy = geo[g + 11], yz = geo[g + 12], zz = geo[g + 13];
    geo[g + 9] = -xz; geo[g + 10] = xy; geo[g + 11] = zz; geo[g + 12] = -yz; geo[g + 13] = yy;
  }
  if (shL >= 1 && sht && sht.length) {
    const B = bands(shL), K = B - 1;
    const table = halfTable();
    const mats = shRotationMatrices(R_ZUP);
    rotateShGroups(count * shF, K, mats,
      (grp, c, k) => table[sht[(grp * B + k + 1) * 3 + c]],
      (grp, c, k, v) => { sht[(grp * B + k + 1) * 3 + c] = floatToHalf(v); });
  }
  if (!view) return null;
  const f = (p) => [p[0], -p[2], p[1]];
  return { ...view, eye: f(view.eye), target: f(view.target), up: f(view.up) };
}

// --- monolithic .nx4d -------------------------------------------------------

export async function parseNx4d(buffer, { up } = {}) {
  const raw = await decompress(buffer, 'gzip', { what: 'nx4d' });
  if (raw.byteLength < 8) throw new Error('nx4d: file is too short to hold a header');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint32(0, true) !== MAGIC.NX4D) throw new Error('nx4d: bad magic');
  const headerLen = view.getUint32(4, true);
  const h = parseJsonHeader('nx4d', raw.subarray(8), headerLen);
  if (h.format !== 'nx4d-v1') throw new Error(`nx4d: unknown format ${h.format}`);
  const count = checkCount('nx4d count', h.count);
  const duration = checkNumber('nx4d duration', h.duration, 1e-9, 86400);
  const shL = checkInt('nx4d sh_l', h.sh_l, 0, LIMITS.MAX_SH_DEGREE);
  const shF = checkInt('nx4d sh_f', h.sh_f, 1, LIMITS.MAX_SH_FOURIER);
  const shB = bands(shL);
  const geoAt = 8 + headerLen;
  const geoBytes = count * 64;
  checkPayload('nx4d geo', geoBytes, raw.byteLength - geoAt);
  const geo = new Float32Array(raw.slice(geoAt, geoAt + geoBytes).buffer);
  const shtAt = geoAt + geoBytes;
  const shtBytes = count * shF * shB * 3 * 2;
  checkPayload('nx4d sht', shtBytes, raw.byteLength - shtAt);
  const sht = new Uint16Array(raw.slice(shtAt, shtAt + shtBytes).buffer);
  let camView = h.view || null;
  if (up === 'z') camView = temporalZUpToViewer(geo, sht, count, shL, shF, camView);
  const { center, radius } = temporalBounds(geo, count);
  return {
    kind: 'temporal', sourceFormat: 'nx4d', count, duration, shL, shF, shB, geo, sht,
    center, radius, view: camView, credit: h.credit || null,
  };
}

// --- streamable .nxs4 ---------------------------------------------------------

export function parseNxs4Superblock(bytes) {
  if (bytes.byteLength < 4) throw new Error('nxs4: bad magic (file is only a few bytes)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC.NXS4) throw new Error('nxs4: bad magic');
  if (bytes.byteLength < 44) throw new Error('nxs4: too short to hold a superblock');
  const major = view.getUint16(4, true), minor = view.getUint16(6, true);
  if (major !== NXS4_MAJOR) throw new Error(`nxs4: unsupported stream-profile major ${major} (this runtime reads ${NXS4_MAJOR})`);
  const headerLen = checkInt('nxs4 header length', view.getUint32(8, true), 2, LIMITS.MAX_HEADER_BYTES);
  const sb = 12 + pad4(headerLen);
  checkPayload('nxs4 superblock', sb + 32, bytes.byteLength);
  if (crc32c(bytes.subarray(0, sb + 28)) !== view.getUint32(sb + 28, true)) {
    throw new Error('nxs4: superblock CRC mismatch — file corrupt or truncated');
  }
  const header = parseJsonHeader('nxs4', bytes.subarray(12), headerLen);
  for (const k of REQUIRED) if (!(k in header)) throw new Error(`nxs4: header missing required field "${k}"`);
  for (const k of Object.keys(header)) {
    if (!ALLOWED.has(k)) throw new Error(`nxs4: header carries unknown field "${k}" (the v1 field list is frozen)`);
  }
  if (header.profile !== 'f32f16') throw new Error(`nxs4: unsupported payload profile "${header.profile}" (v1 readers require "f32f16")`);
  if (header.chunk_codec !== 'gzip') throw new Error(`nxs4: unsupported chunk codec "${header.chunk_codec}"`);
  checkCount('nxs4 count_total', header.count_total);
  checkNumber('nxs4 duration', header.duration, 1e-9, 86400);
  checkInt('nxs4 sh_l', header.sh_l, 0, LIMITS.MAX_SH_DEGREE);
  checkInt('nxs4 sh_f', header.sh_f, 1, LIMITS.MAX_SH_FOURIER);
  checkInt('nxs4 coarse_chunk_count', header.coarse_chunk_count, 0, LIMITS.MAX_CHUNKS);
  checkInt('nxs4 layer_count', header.layer_count, 1, 8);
  return {
    versionMajor: major,
    versionMinor: minor,
    header,
    chunkIndexOffset: Number(view.getBigUint64(sb, true)),
    chunkCount: checkInt('nxs4 chunk_count', view.getUint32(sb + 8, true), 0, LIMITS.MAX_CHUNKS),
    audioIndexOffset: Number(view.getBigUint64(sb + 16, true)),
    audioTrackCount: checkInt('nxs4 audio_track_count', view.getUint32(sb + 24, true), 0, LIMITS.MAX_AUDIO_TRACKS),
    byteLength: sb + 32,
  };
}

export const CHUNK_RECORD = 64;

export function parseChunkIndex(bytes, count) {
  checkInt('nxs4 chunk index count', count, 0, LIMITS.MAX_CHUNKS);
  checkPayload('nxs4 chunk index', count * CHUNK_RECORD, bytes.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = [];
  for (let i = 0; i < count; ++i) {
    const o = i * CHUNK_RECORD;
    records.push({
      byteOffset: Number(view.getBigUint64(o, true)),
      byteLength: view.getUint32(o + 8, true),
      splatCount: checkCount(`nxs4 chunk[${i}] splat_count`, view.getUint32(o + 12, true)),
      aabbMin: [view.getFloat32(o + 16, true), view.getFloat32(o + 20, true), view.getFloat32(o + 24, true)],
      aabbMax: [view.getFloat32(o + 28, true), view.getFloat32(o + 32, true), view.getFloat32(o + 36, true)],
      gateTMin: view.getFloat32(o + 40, true),
      gateTMax: view.getFloat32(o + 44, true),
      lodLayer: view.getUint8(o + 48),
      shDepth: view.getUint8(o + 49),
      flags: view.getUint8(o + 50),
      crc32c: view.getUint32(o + 52, true),
    });
  }
  return records;
}

// `offset` is where the audio index starts inside `bytes` (0 is valid: the
// streaming path parses a fetched tail); chunk records carry file offsets.
export function parseAudioIndex(bytes, offset, tracks) {
  if (!tracks) return [];
  checkPayload('nxs4 audio index', offset, bytes.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let p = offset;
  for (let t = 0; t < tracks; ++t) {
    checkPayload(`nxs4 audio track[${t}] record`, p + 20, bytes.byteLength);
    const fourcc = view.getUint32(p, true);
    const track = {
      codec: String.fromCharCode(fourcc & 255, (fourcc >> 8) & 255, (fourcc >> 16) & 255, (fourcc >> 24) & 255),
      channels: view.getUint16(p + 4, true),
      ambisonicOrder: view.getUint16(p + 6, true),
      objectCount: view.getUint32(p + 8, true),
      chunkCount: checkInt(`nxs4 audio track[${t}] chunk_count`, view.getUint32(p + 12, true), 0, LIMITS.MAX_AUDIO_CHUNKS_PER_TRACK),
      crc32c: view.getUint32(p + 16, true),
      chunks: [],
    };
    p += 20;
    const listStart = p;
    for (let c = 0; c < track.chunkCount; ++c) {
      checkPayload(`nxs4 audio track[${t}] chunk[${c}] record`, p + 28, bytes.byteLength);
      track.chunks.push({
        byteOffset: Number(view.getBigUint64(p, true)),
        byteLength: view.getUint32(p + 8, true),
        tMin: view.getFloat32(p + 12, true),
        tMax: view.getFloat32(p + 16, true),
        crc32c: view.getUint32(p + 20, true),
      });
      p += 28;
    }
    if (crc32c(bytes.subarray(listStart, p)) !== track.crc32c) throw new Error(`nxs4: audio track ${t} index CRC mismatch`);
    out.push(track);
  }
  return out;
}

export function verifyAudioChunk(bytes, record) {
  if (bytes.byteLength !== record.byteLength) throw new Error('nxs4: audio chunk truncated');
  if (crc32c(bytes) !== record.crc32c) throw new Error('nxs4: audio chunk CRC mismatch — rejecting corrupt audio');
  return bytes;
}

export async function decodeChunk(compressed, record, header) {
  if (compressed.byteLength !== record.byteLength) {
    throw new Error(`nxs4: chunk read ${compressed.byteLength} bytes, index says ${record.byteLength}`);
  }
  if (crc32c(compressed) !== record.crc32c) throw new Error('nxs4: chunk CRC mismatch — rejecting corrupt chunk');
  const n = checkCount('nxs4 chunk splat_count', record.splatCount);
  const B = bands(checkInt('nxs4 chunk sh_depth', record.shDepth, 0, LIMITS.MAX_SH_DEGREE));
  const expected = n * 4 + n * 64 + n * header.sh_f * B * 3 * 2;
  const raw = await decompress(compressed, 'gzip', { what: 'nxs4 chunk', maxOut: Math.max(expected, 64) });
  if (raw.byteLength !== expected) throw new Error(`nxs4: chunk decompressed to ${raw.byteLength} bytes, expected ${expected}`);
  const buf = raw.byteOffset === 0 && raw.buffer.byteLength === raw.byteLength ? raw.buffer : raw.slice().buffer;
  return {
    ids: new Uint32Array(buf, 0, n),
    geo: new Float32Array(buf, n * 4, n * 16),
    sht: new Uint16Array(buf, n * 68, n * header.sh_f * B * 3),
    shDepth: record.shDepth,
  };
}

// Whole-file read of an .nxs4 (used when range requests are unavailable):
// every splat must be covered by exactly one full-detail (layer 1) chunk.
export async function parseNxs4Whole(buffer, { up } = {}) {
  const bytes = new Uint8Array(buffer);
  const sb = parseNxs4Superblock(bytes);
  const h = sb.header;
  const count = h.count_total, shF = h.sh_f, shB = bands(h.sh_l);
  const records = parseChunkIndex(bytes.subarray(sb.chunkIndexOffset), sb.chunkCount);
  const geo = alloc('nxs4 geo', Float32Array, count * 16);
  const sht = alloc('nxs4 sht', Uint16Array, count * shF * shB * 3);
  const covered = alloc('nxs4 coverage', Uint8Array, count);
  let seen = 0;
  for (const rec of records) {
    if (rec.lodLayer !== 1) continue;
    checkPayload('nxs4 chunk payload', rec.byteLength, bytes.byteLength - rec.byteOffset);
    const c = await decodeChunk(bytes.subarray(rec.byteOffset, rec.byteOffset + rec.byteLength), rec, h);
    if (c.shDepth !== h.sh_l) throw new Error(`nxs4: layer-1 chunk sh_depth ${c.shDepth} != scene sh_l ${h.sh_l}`);
    const per = shF * shB * 3;
    for (let j = 0; j < c.ids.length; ++j) {
      const id = c.ids[j];
      if (id >= count) throw new Error(`nxs4: splat_id ${id} out of range (count_total ${count})`);
      if (covered[id]) throw new Error(`nxs4: splat_id ${id} covered by more than one layer-1 chunk`);
      covered[id] = 1;
      seen++;
      geo.set(c.geo.subarray(j * 16, j * 16 + 16), id * 16);
      sht.set(c.sht.subarray(j * per, j * per + per), id * per);
    }
  }
  if (seen !== count) throw new Error(`nxs4: layer-1 chunks cover ${seen} of ${count} splats — incomplete file`);
  const zUp = up === 'z' || (h.up === 'z' && up !== 'y');
  let camView = h.view || null;
  if (zUp) camView = temporalZUpToViewer(geo, sht, count, h.sh_l, shF, camView);
  const { center, radius } = temporalBounds(geo, count);
  // Audio rides along as the bytes of each track's first chunk.
  let audioTracks = [];
  try {
    const tracks = sb.audioIndexOffset ? parseAudioIndex(bytes, sb.audioIndexOffset, sb.audioTrackCount) : [];
    audioTracks = tracks.map((track) => {
      const c = track.chunks[0];
      if (!c || c.byteOffset + c.byteLength > bytes.byteLength) return track;
      return { ...track, bytes: verifyAudioChunk(bytes.slice(c.byteOffset, c.byteOffset + c.byteLength), c) };
    });
  } catch (err) {
    console.warn('[4dviewer] audio unavailable:', err.message || err);
  }
  return {
    kind: 'temporal', sourceFormat: 'nxs4', count, duration: h.duration, shL: h.sh_l, shF, shB, geo, sht,
    center, radius, view: camView, credit: h.credit || null, poster: h.poster || null,
    audio: h.audio ? { ...h.audio, up: zUp ? 'z' : 'y' } : null,
    audioTracks,
  };
}
