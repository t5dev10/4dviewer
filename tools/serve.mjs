#!/usr/bin/env node
// Static dev server with HTTP Range support (the .nxs4 streaming path needs
// 206 responses).
//
//   node tools/serve.mjs [--port 8790] [--root .] [--mount /local=/path/to/scenes] [--isolate]
//
// --mount serves an extra directory under a URL prefix, so local test scenes
// can be opened without copying them into the site.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const opts = { port: 8790, root: path.resolve(here, '..'), mounts: [], isolate: false, host: '127.0.0.1' };
for (let i = 2; i < process.argv.length; ++i) {
  const a = process.argv[i];
  if (a === '--port') opts.port = Number(process.argv[++i]);
  else if (a === '--root') opts.root = path.resolve(process.argv[++i]);
  else if (a === '--host') opts.host = process.argv[++i];
  else if (a === '--isolate') opts.isolate = true;
  else if (a === '--mount') {
    const [prefix, dir] = process.argv[++i].split('=');
    opts.mounts.push({ prefix: prefix.replace(/\/?$/, '/'), dir: path.resolve(dir) });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.usdz': 'model/vnd.usdz+zip', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg',
};

function resolve(urlPath) {
  for (const m of opts.mounts) {
    if (urlPath.startsWith(m.prefix)) return { base: m.dir, file: path.join(m.dir, urlPath.slice(m.prefix.length)) };
  }
  return { base: opts.root, file: path.join(opts.root, urlPath) };
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const { base, file: f0 } = resolve(urlPath);
  let file = path.resolve(f0);
  if (!file.startsWith(base)) {
    res.writeHead(403).end();
    return;
  }
  let st;
  try {
    st = fs.statSync(file);
    if (st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = fs.statSync(file);
    }
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
  };
  if (opts.isolate) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  }
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
    end = Math.min(end, st.size - 1);
    if (start > end || start < 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
});

server.listen(opts.port, opts.host, () => {
  console.log(`serving ${opts.root} on http://${opts.host}:${opts.port}/`);
  for (const m of opts.mounts) console.log(`  ${m.prefix} -> ${m.dir}`);
});
