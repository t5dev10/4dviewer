// Format identification: by file name, by leading bytes, and the labels the
// viewer shows for each container.

export const FORMATS = ['nx4d', 'nxs4', 'ply', 'spz', 'sog', 'sog4d', 'gltf', 'splat', 'ksplat', 'usdz'];

export const MAGIC = Object.freeze({
  NX4D: 0x3464584e, // "NXd4" little-endian, inside the gzip stream
  NXS4: 0x3473584e, // "NXs4" little-endian, plain
  NGSP: 0x5053474e, // SPZ
  GLB: 0x46546c67,  // "glTF"
});

export function detectFormatFromName(name) {
  const n = (name || '').toLowerCase().split('?')[0].split('#')[0];
  if (n.endsWith('.nx4d')) return 'nx4d';
  if (n.endsWith('.nxs4')) return 'nxs4';
  if (n.endsWith('.ply')) return 'ply';
  if (n.endsWith('.spz')) return 'spz';
  if (n.endsWith('.sog4d')) return 'sog4d';
  if (n.endsWith('.sog') || n.endsWith('meta.json')) return 'sog';
  if (n.endsWith('.gltf') || n.endsWith('.glb')) return 'gltf';
  if (n.endsWith('.ksplat')) return 'ksplat';
  if (n.endsWith('.splat')) return 'splat';
  if (n.endsWith('.usdz') || n.endsWith('.usda') || n.endsWith('.usd')) return 'usdz';
  return null;
}

// First-entry name of a ZIP archive tells SOG bundles and USDZ packages apart.
function sniffZip(bytes) {
  if (bytes.length < 30) return null;
  const len = bytes[26] | (bytes[27] << 8);
  if (len === 0 || 30 + len > bytes.length) return null;
  let name = '';
  for (let i = 0; i < len; ++i) name += String.fromCharCode(bytes[30 + i]);
  name = name.toLowerCase();
  if (/\.usd[ac]?$/.test(name) || name.endsWith('.usdz')) return 'usdz';
  if (name === 'meta.json' || name.endsWith('/meta.json')) return 'sog';
  return null;
}

// Returns a format id, 'gzip-ambiguous' (nx4d and legacy SPZ are both gzip),
// 'gltf-maybe-json', or null.
export function sniffFormat(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79) return 'ply';
  if (bytes.length >= 4) {
    const magic = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
    if (magic === MAGIC.GLB) return 'gltf';
    if (magic === MAGIC.NXS4) return 'nxs4';
    if (magic === MAGIC.NGSP) return 'spz';
  }
  if (bytes.length >= 1 && bytes[0] === 0x7b) return 'gltf-maybe-json';
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return sniffZip(bytes) ?? 'sog';
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip-ambiguous';
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '#usda') return 'usdz';
  return null;
}

// Name and bytes disagree: bytes win, except where the bytes cannot decide.
export function resolveFormat(byName, byBytes) {
  // A SOG and a SOG4D archive both open with meta.json; the name decides,
  // and the loader re-checks meta.json's type either way.
  if (byBytes === 'sog' && byName === 'sog4d') return 'sog4d';
  if (byBytes === 'nxs4' || byBytes === 'ply' || byBytes === 'gltf' || byBytes === 'sog' || byBytes === 'usdz') {
    return byBytes;
  }
  if (byBytes === 'spz') return 'spz';
  return byName ?? null;
}

export function formatsAgree(byName, byBytes) {
  return byName === byBytes || (byBytes === 'sog' && byName === 'sog4d') ||
    (byBytes === 'gzip-ambiguous' && (byName === 'nx4d' || byName === 'spz')) ||
    (byBytes === 'gltf-maybe-json' && byName === 'gltf');
}

export function formatLabel(format) {
  return {
    nx4d: 'nx4d · 4D scene',
    nxs4: 'nxs4 · 4D stream (streamable)',
    ply: 'PLY (reference 3DGS, or compressed)',
    spz: 'SPZ (Niantic)',
    sog: 'SOG (PlayCanvas)',
    sog4d: 'SOG4D · 4D scene (SuperSplat 4D)',
    gltf: 'glTF / KHR_gaussian_splatting',
    splat: '.splat (32-byte records)',
    ksplat: '.ksplat (GaussianSplats3D)',
    usdz: 'USDZ / USDA (ParticleField3DGaussianSplat)',
  }[format] || format;
}

// Standalone page configuration read from the query string.
export function parseUrlConfig(search = typeof location !== 'undefined' ? location.search : '') {
  const q = new URLSearchParams(search);
  const num = (k) => (q.has(k) ? parseFloat(q.get(k)) : null);
  return {
    scene: q.get('scene') || q.get('src') || null,
    format: q.get('format') || null,
    usdz: q.get('usdz') || null,
    xrDisabled: q.get('xr') === '0',
    uiMin: q.get('ui') === 'min',
    perf: q.get('perf') || null,
    up: q.get('up') || null,
    gpu: q.get('gpu'),
    pool: q.has('pool') ? parseInt(q.get('pool'), 10) : null,
    muted: q.has('muted') ? q.get('muted') !== '0' : null,
    sh: q.has('sh') ? parseInt(q.get('sh'), 10) : null,
    dolly: num('dolly'),
    yaw: num('yaw'),
    pitch: num('pitch'),
    roll: num('roll'),
  };
}
