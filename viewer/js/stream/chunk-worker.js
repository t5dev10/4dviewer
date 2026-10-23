// Verifies (CRC-32C), inflates and frame-converts one .nxs4 chunk.

import { decodeChunk, temporalZUpToViewer } from '../loaders/nx4d.js';

onmessage = async (e) => {
  const { seq, compressed, record, header, up } = e.data;
  try {
    const c = await decodeChunk(compressed, record, header);
    const geo = c.geo.slice();
    const sht = c.sht.slice();
    const ids = c.ids.slice();
    if (up === 'z') temporalZUpToViewer(geo, sht, record.splatCount, c.shDepth, header.sh_f, null);
    postMessage({ seq, ok: true, ids, geo, sht, shDepth: c.shDepth, count: record.splatCount },
      [ids.buffer, geo.buffer, sht.buffer]);
  } catch (err) {
    postMessage({ seq, ok: false, error: String(err?.message || err) });
  }
};
