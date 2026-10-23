// Header-only validation of a picked file: what it really is, what it holds,
// and a sentence a person can act on when it cannot be opened. Reads at most
// the first 256 KB.

import { checkInt, decompress, LIMITS, parseJsonHeader } from './limits.js';
import { detectFormatFromName, formatsAgree, MAGIC, resolveFormat, sniffFormat } from './formats.js';
import { parsePlyHeader, isCompressedPly } from '../loaders/ply.js';
import { parseNxs4Superblock } from '../loaders/nx4d.js';
import { readKsplatHeader } from '../loaders/ksplat.js';
import { SPLAT_RECORD } from '../loaders/splat.js';
import { firstZipEntryName } from '../loaders/zip.js';

const PROBE = 256 * 1024;
const STATIC_NOTE = (what) => `${what} is a static format: it will load as a single frame, not a 4D clip.`;

export async function validateFile(file, { name } = {}) {
  const fileName = name ?? file.name ?? '';
  const size = file.size;
  const warnings = [];
  const head = new Uint8Array(await file.slice(0, Math.min(PROBE, size)).arrayBuffer());
  const byName = detectFormatFromName(fileName);
  const byBytes = sniffFormat(head);
  const format = resolveFormat(byName, byBytes);
  if (!format) {
    return {
      ok: false, format: null, bytes: size, metadata: null, warnings,
      reason: `Unrecognised file. Supported: .nx4d, .nxs4, .ply, .spz, .sog, .gltf/.glb, .splat, .ksplat, .usdz (the name suggests ${byName ?? 'nothing'} and the first bytes suggest ${byBytes ?? 'nothing'}).`,
    };
  }
  if (byName && byBytes && !formatsAgree(byName, byBytes) && byName !== format) {
    warnings.push(`The extension says ${byName} but the contents look like ${byBytes}; trusting the contents.`);
  }
  try {
    const metadata = await probe(format, file, head, warnings);
    return { ok: true, format, bytes: size, metadata, warnings, reason: null };
  } catch (err) {
    return {
      ok: false, format, bytes: size, metadata: null, warnings,
      reason: err?.name === 'HostileInputError' ? err.message : `${format}: ${err?.message || err}`,
    };
  }
}

async function probe(format, file, head, warnings) {
  switch (format) {
    case 'nxs4': return probeNxs4(head, file, warnings);
    case 'nx4d': return probeNx4d(head, warnings);
    case 'spz': return probeSpz(head, warnings);
    case 'ply': return probePly(head, file, warnings);
    case 'sog':
      warnings.push(STATIC_NOTE('SOG'));
      return { kind: 'static', note: 'SOG metadata lives inside the archive and is checked on load.' };
    case 'gltf': return probeGltf(head, warnings);
    case 'splat': return probeSplat(file, warnings);
    case 'ksplat': return probeKsplat(head, file, warnings);
    case 'usdz': return probeUsdz(head, warnings);
    default: throw new Error(`no validator for ${format}`);
  }
}

function probeNxs4(head, file, warnings) {
  const sb = parseNxs4Superblock(head);
  const h = sb.header;
  if (!h.coarse_chunk_count) {
    warnings.push('No coarse layer: this scene will not paint until a full chunk arrives. Re-pack it for a fast first paint.');
  }
  if (sb.chunkIndexOffset + sb.chunkCount * 64 > file.size) {
    throw new Error('the chunk index runs past the end of the file (truncated copy?)');
  }
  return {
    kind: 'temporal', streamable: true, count: h.count_total, duration: h.duration, shDegree: h.sh_l,
    fourierOrders: h.sh_f, chunks: sb.chunkCount, coarseChunks: h.coarse_chunk_count,
    audioTracks: sb.audioTrackCount, hasPoster: !!h.poster, credit: h.credit ?? null, up: h.up ?? 'y', profile: h.profile,
  };
}

async function probeNx4d(head, warnings) {
  const raw = await decompress(head, 'gzip', { what: 'nx4d header', maxOut: 4 << 20, allowTruncated: true })
    .catch((err) => {
      if (/decompression failed/i.test(err.message)) return null;
      throw err;
    });
  if (!raw || raw.byteLength < 8) throw new Error('could not read a header from the first bytes');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint32(0, true) !== MAGIC.NX4D) throw new Error('bad magic (not an nx4d container)');
  const h = parseJsonHeader('nx4d', raw.subarray(8), view.getUint32(4, true));
  if (h.format !== 'nx4d-v1') throw new Error(`unknown container version "${h.format}"`);
  warnings.push('Monolithic .nx4d: the whole file downloads before playback. Pack it to the streamable .nxs4 profile for coarse-first paint.');
  return {
    kind: 'temporal', streamable: false, count: checkInt('count', h.count, 0, LIMITS.MAX_SPLATS),
    duration: h.duration, shDegree: h.sh_l, fourierOrders: h.sh_f, hasView: !!h.view,
  };
}

async function probeSpz(head, warnings) {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.byteLength >= 4 && view.getUint32(0, true) === MAGIC.NGSP) {
    if (head.byteLength < 32) throw new Error('spz v4: too short to hold its 32 B header');
    const version = view.getUint32(4, true);
    if (version !== 4) throw new Error(`plaintext NGSP header with version ${version} (only v4 uses it)`);
    warnings.push(STATIC_NOTE('SPZ'));
    return { kind: 'static', spzVersion: 4, count: checkInt('numPoints', view.getUint32(8, true), 0, LIMITS.MAX_SPLATS), shDegree: Math.min(head[12], 3) };
  }
  const raw = await decompress(head, 'gzip', { what: 'spz header', maxOut: 1 << 20, allowTruncated: true })
    .catch((err) => {
      if (/decompression failed/i.test(err.message)) return null;
      throw err;
    });
  if (!raw || raw.byteLength < 16) throw new Error('could not read a header from the first bytes');
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (v.getUint32(0, true) !== MAGIC.NGSP) throw new Error('bad magic after gunzip');
  const version = v.getUint32(4, true);
  if (version < 1 || version > 3) throw new Error(`unsupported SPZ version ${version} (readable: 1–4)`);
  warnings.push(STATIC_NOTE('SPZ'));
  return { kind: 'static', spzVersion: version, count: checkInt('numPoints', v.getUint32(8, true), 0, LIMITS.MAX_SPLATS), shDegree: Math.min(raw[12], 3) };
}

function probePly(head, file, warnings) {
  const header = parsePlyHeader(head);
  if (isCompressedPly(header.elements)) {
    const sh = header.elements[2]?.name === 'sh' ? header.elements[2] : null;
    warnings.push(STATIC_NOTE('Compressed PLY'));
    return {
      kind: 'static', variant: 'compressed', count: checkInt('vertex count', header.elements[1].count, 0, LIMITS.MAX_SPLATS),
      chunks: header.elements[0].count, shDegree: sh ? ({ 9: 1, 24: 2, 45: 3 }[sh.properties.length] ?? 0) : 0,
    };
  }
  const vertex = header.elements.find((e) => e.name === 'vertex');
  if (!vertex) throw new Error('no "vertex" element — not a Gaussian-splat PLY');
  const names = vertex.properties.map((p) => p.name);
  const missing = ['x', 'y', 'z', 'f_dc_0', 'opacity', 'scale_0', 'rot_0'].filter((m) => !names.includes(m));
  if (missing.length) {
    throw new Error(`not a Gaussian-splat PLY — missing ${missing.join(', ')} (a mesh or point-cloud PLY will not render as splats)`);
  }
  const rest = names.filter((m) => m.startsWith('f_rest_')).length / 3;
  const need = vertex.offset + vertex.count * vertex.stride;
  if (need > file.size) throw new Error(`the header declares ${need} bytes of splats but the file has ${file.size} (truncated copy?)`);
  warnings.push(STATIC_NOTE('PLY'));
  return {
    kind: 'static', count: checkInt('vertex count', vertex.count, 0, LIMITS.MAX_SPLATS),
    shDegree: rest >= 15 ? 3 : rest >= 8 ? 2 : rest >= 3 ? 1 : 0, properties: names.length,
  };
}

function probeGltf(head, warnings) {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const glb = head.byteLength >= 4 && view.getUint32(0, true) === MAGIC.GLB;
  let json;
  if (glb) {
    const len = view.getUint32(12, true);
    checkInt('glb JSON chunk length', len, 2, LIMITS.MAX_HEADER_BYTES);
    if (20 + len > head.byteLength) throw new Error('the JSON chunk is larger than the probed prefix');
    json = JSON.parse(new TextDecoder().decode(head.subarray(20, 20 + len)));
  } else {
    const text = new TextDecoder().decode(head);
    if (!text.trimStart().startsWith('{')) throw new Error('not JSON and not a GLB');
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('the .gltf JSON is larger than the probed prefix or malformed — prefer a self-contained .glb');
    }
  }
  const used = json.extensionsUsed ?? [];
  if (!used.includes('KHR_gaussian_splatting')) throw new Error('this glTF does not declare KHR_gaussian_splatting, so it carries no splats');
  if (!glb && (json.buffers ?? []).some((b) => b.uri && !b.uri.startsWith('data:'))) {
    warnings.push('This .gltf references external buffers, which a single local file cannot resolve. Export a self-contained .glb.');
  }
  warnings.push(STATIC_NOTE('glTF'));
  return { kind: 'static', container: glb ? 'glb' : 'gltf', extensions: used };
}

function probeSplat(file, warnings) {
  if (file.size === 0) throw new Error('the file is empty');
  if (file.size % SPLAT_RECORD) {
    throw new Error(`${file.size} bytes is not a whole number of ${SPLAT_RECORD}-byte records, so it is truncated or not a .splat`);
  }
  warnings.push('.splat is a static, DC-only format: it loads as a single frame with no view-dependent colour and no motion.');
  return { kind: 'static', count: file.size / SPLAT_RECORD, shDegree: 0 };
}

function probeKsplat(head, file, warnings) {
  if (file.size < 4096) throw new Error(`${file.size} bytes is too short to hold a 4096-byte header`);
  const h = readKsplatHeader(new DataView(head.buffer, head.byteOffset, head.byteLength));
  if (h.versionMajor !== 0) throw new Error(`version ${h.versionMajor}.${h.versionMinor} is not readable (this runtime reads the 0.x layout)`);
  if (h.level > 2) throw new Error(`unknown compression level ${h.level} (expected 0, 1 or 2)`);
  warnings.push(STATIC_NOTE('.ksplat'));
  const shDegree = head.byteLength >= 4096 + 42 ? new DataView(head.buffer, head.byteOffset).getUint16(4096 + 40, true) : 0;
  return {
    kind: 'static', count: checkInt('ksplat splatCount', h.splatCount, 0, LIMITS.MAX_SPLATS),
    sections: h.sections, compressionLevel: h.level, shDegree,
  };
}

function probeUsdz(head, warnings) {
  if (!(head.byteLength >= 4 && head[0] === 0x50 && head[1] === 0x4b)) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(head.subarray(0, Math.min(head.byteLength, 4096)));
    if (!/^#usda\b/.test(text.trimStart())) throw new Error('not a ZIP archive and not a "#usda" text layer');
    warnings.push(STATIC_NOTE('USD'));
    return { kind: 'static', container: 'usda' };
  }
  const first = firstZipEntryName(head);
  if (!first) throw new Error("the archive's first entry name could not be read");
  const extra = head[28] | (head[29] << 8);
  const dataAt = 30 + first.length + extra;
  const magic = head.byteLength >= dataAt + 8 ? String.fromCharCode(...head.subarray(dataAt, dataAt + 8)) : '';
  if (magic === 'PXR-USDC') {
    throw new Error(`"${first}" is a binary USD crate (PXR-USDC), which the web platform cannot decode. Convert it to ASCII first (\`usdcat -o scene.usda scene.usdc\`) and re-package, or export USDZ with an ASCII root layer.`);
  }
  if (!/\.usd[ac]?$/i.test(first)) throw new Error(`the archive's first entry is "${first}", not a .usd/.usda/.usdc root layer`);
  warnings.push(STATIC_NOTE('USD'));
  return { kind: 'static', container: 'usdz', rootLayer: first };
}
