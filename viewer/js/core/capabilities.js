// Live capability probe. Every badge the page shows comes from here, run in
// the visitor's browser, never from a hardcoded table.

import { FORMATS } from './formats.js';

let probe = null;

export function detectCapabilities() {
  if (!probe) {
    probe = runProbe().catch((err) => {
      probe = null;
      throw err;
    });
  }
  return probe;
}

async function runProbe() {
  const caps = {
    webgpu: false,
    webgl2: false,
    xr: { apiPresent: false, xrGpuBinding: false, immersiveVR: false, immersiveAR: false },
    reducedMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    formats: Object.fromEntries(FORMATS.map((f) => [f, { view: 'unsupported', export: 'unsupported' }])),
  };
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      caps.webgpu = !!(await navigator.gpu.requestAdapter());
    } catch {
      caps.webgpu = false;
    }
  }
  if (typeof document !== 'undefined') {
    const gl = document.createElement('canvas').getContext('webgl2');
    caps.webgl2 = !!gl;
    try {
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // probe context only
    }
  }
  if (typeof navigator !== 'undefined' && navigator.xr) {
    caps.xr.apiPresent = true;
    caps.xr.xrGpuBinding = typeof window !== 'undefined' && 'XRGPUBinding' in window;
    try {
      caps.xr.immersiveVR = await navigator.xr.isSessionSupported('immersive-vr');
    } catch {
      // unsupported
    }
    try {
      caps.xr.immersiveAR = await navigator.xr.isSessionSupported('immersive-ar');
    } catch {
      // unsupported
    }
  }
  const gl2 = caps.webgl2 ? 'supported' : 'unsupported';
  caps.formats.nx4d.view = caps.webgpu ? 'native' : gl2;
  caps.formats.nx4d.export = 'native';
  caps.formats.nxs4 = { ...caps.formats.nx4d };
  for (const f of ['ply', 'spz', 'sog', 'splat', 'ksplat', 'usdz']) caps.formats[f] = { view: gl2, export: gl2 };
  caps.formats.gltf = { view: gl2, export: caps.webgl2 ? 'native' : 'unsupported' };
  return caps;
}

export function preferredColorSpace({ apiSupported, gamutP3 }) {
  return apiSupported && gamutP3 ? 'display-p3' : 'srgb';
}

export function preferredPowerMode({ coarsePointer }) {
  return coarsePointer ? 'low-power' : 'high-performance';
}
