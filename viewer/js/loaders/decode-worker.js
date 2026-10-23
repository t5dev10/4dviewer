// Decodes any supported container off the main thread and transfers the
// typed arrays back.

import { loadPly } from './ply.js';
import { loadSpz } from './spz.js';
import { loadSog } from './sog.js';
import { loadGltf } from './gltf.js';
import { loadSplat } from './splat.js';
import { loadKsplat } from './ksplat.js';
import { loadUsdz } from './usdz.js';
import { parseNx4d, parseNxs4Whole } from './nx4d.js';
import { staticZUpToViewer } from '../core/sh.js';
import { staticBounds, sceneTransferables } from '../core/scene.js';

async function decode({ buffer, format, sourceUrl, up }) {
  switch (format) {
    case 'nx4d': return parseNx4d(buffer, { up });
    case 'nxs4': return parseNxs4Whole(buffer, { up });
    case 'ply': return loadPly(buffer);
    case 'spz': return loadSpz(buffer);
    case 'sog': return loadSog(buffer, sourceUrl);
    case 'gltf': return loadGltf(buffer, sourceUrl);
    case 'splat': return loadSplat(buffer);
    case 'ksplat': return loadKsplat(buffer);
    case 'usdz': return loadUsdz(buffer, { up: up ?? undefined });
    default: throw new Error(`unsupported format "${format}"`);
  }
}

onmessage = async (e) => {
  const { seq } = e.data;
  try {
    const scene = await decode(e.data);
    if (scene.kind === 'static' && e.data.up === 'z' && e.data.format !== 'usdz') {
      staticZUpToViewer(scene);
      Object.assign(scene, staticBounds(scene.positions, scene.count));
    }
    const transfer = sceneTransferables(scene);
    for (const track of scene.audioTracks || []) if (track.bytes) transfer.push(track.bytes.buffer);
    postMessage({ seq, ok: true, scene }, transfer);
  } catch (err) {
    postMessage({ seq, ok: false, error: String(err?.message || err) });
  }
};
