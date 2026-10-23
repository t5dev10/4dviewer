#!/usr/bin/env node
// Regenerates the pages that make /<scene> links work on a static host:
//   404.html            — a copy of index.html (GitHub Pages serves it for unknown paths)
//   <id>/index.html     — one real page per scene in viewer/assets/scenes.json
//                         (HTTP 200 and link previews naming the scene)
//
//   node tools/build_pages.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeScenePage } from '../viewer/js/app/scene-page.js';
import { isReservedSceneId } from '../viewer/js/app/router.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
fs.writeFileSync(path.join(root, '404.html'), app);
console.log('wrote 404.html');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'viewer/assets/scenes.json'), 'utf8'));
for (const entry of manifest.scenes || []) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id) || isReservedSceneId(entry.id)) {
    console.warn(`skipped "${entry.id}": use letters, digits and dashes, not a reserved folder name`);
    continue;
  }
  const dir = path.join(root, entry.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), makeScenePage(app, entry));
  console.log(`wrote ${entry.id}/index.html`);
}
