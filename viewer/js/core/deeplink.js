// Shareable links: ?scene=…&t=…&cam=yaw.pitch.roll.dolly.panX.panY.panZ
// (each field fixed-point, base 36) &hotspot=…

const FIELDS = [
  ['yaw', 1e4], ['pitch', 1e4], ['roll', 1e4], ['dolly', 1e3], ['panX', 1e3], ['panY', 1e3], ['panZ', 1e3],
];

export function encodeCam(cam) {
  const v = {
    yaw: cam.yaw ?? 0,
    pitch: cam.pitch ?? 0,
    roll: cam.roll ?? 0,
    dolly: cam.dolly ?? 2.2,
    panX: cam.pan?.[0] ?? 0,
    panY: cam.pan?.[1] ?? 0,
    panZ: cam.pan?.[2] ?? 0,
  };
  return FIELDS.map(([k, s]) => Math.round(v[k] * s).toString(36)).join('.');
}

export function decodeCam(text) {
  if (typeof text !== 'string' || !text) return null;
  const parts = text.split('.');
  if (parts.length !== FIELDS.length) return null;
  const v = {};
  for (let i = 0; i < FIELDS.length; ++i) {
    const [k, s] = FIELDS[i];
    if (!/^-?[0-9a-z]+$/.test(parts[i])) return null;
    const x = parseInt(parts[i], 36) / s;
    if (!Number.isFinite(x)) return null;
    v[k] = x;
  }
  return { yaw: v.yaw, pitch: v.pitch, roll: v.roll, dolly: v.dolly, pan: [v.panX, v.panY, v.panZ] };
}

export function buildShareUrl({ base, scene, t, cam, hotspot }) {
  const url = new URL(base ?? (typeof location !== 'undefined' ? location.href : 'https://example.invalid/'));
  const q = new URLSearchParams();
  if (scene) q.set('scene', scene);
  if (Number.isFinite(t)) q.set('t', Number(t).toFixed(3));
  if (cam) q.set('cam', encodeCam(cam));
  if (hotspot) q.set('hotspot', hotspot);
  url.search = q.toString();
  url.hash = '';
  return url.toString();
}

export function parseDeepLink(search = typeof location !== 'undefined' ? location.search : '') {
  const q = new URLSearchParams(search);
  const tRaw = q.get('t');
  const t = tRaw === null ? null : parseFloat(tRaw);
  return {
    scene: q.get('scene') || null,
    t: Number.isFinite(t) && t >= 0 ? t : null,
    cam: decodeCam(q.get('cam')),
    hotspot: q.get('hotspot') || null,
  };
}
