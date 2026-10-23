// Site routing. The app page is both index.html and 404.html (GitHub Pages
// serves the latter for any unknown path), so https://site/<scene> opens that
// scene. The base is the repository path on *.github.io project sites and "/"
// elsewhere; <meta name="tg4d-base" content="/sub/path/"> overrides it.

const RESERVED = new Set(['viewer', 'assets', 'tools', 'index.html', '404.html', 'readme.md', 'package.json', 'favicon.ico']);

export function siteBase(loc = location, doc = typeof document !== 'undefined' ? document : null) {
  const meta = doc?.querySelector('meta[name="tg4d-base"]')?.content;
  if (meta) return meta.endsWith('/') ? meta : `${meta}/`;
  const seg = loc.pathname.split('/');
  if (loc.hostname.endsWith('.github.io') && seg.length > 2 && seg[1]) return `/${seg[1]}/`;
  return '/';
}

// The scene named by the path, or null at the site root.
export function sceneFromPath(loc = location, base = siteBase(loc)) {
  if (!loc.pathname.startsWith(base)) return null;
  let rest = loc.pathname.slice(base.length).replace(/\/index\.html$/i, '').replace(/\/+$/, '');
  if (!rest || /^(index|404)\.html$/i.test(rest)) return null;
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // keep the raw path
  }
  if (RESERVED.has(rest.split('/')[0].toLowerCase())) return null;
  return rest;
}

export const isReservedSceneId = (id) => RESERVED.has(String(id).toLowerCase());

export function sceneHref(id, params = null, loc = location) {
  const base = siteBase(loc);
  const path = id ? base + String(id).split('/').map(encodeURIComponent).join('/') : base;
  const url = new URL(path, loc.origin);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
  return url.toString();
}

// Reflect the open scene in the address bar without reloading.
export function replaceAddress(id, params = null) {
  try {
    const url = sceneHref(id, params);
    if (url !== location.href) history.replaceState(history.state, '', url);
  } catch {
    // sandboxed frames may refuse history access
  }
}

// Turns a path name into a manifest entry or a scene URL.
export function resolveSceneName(name, manifest, manifestUrl, knownFormat) {
  const list = manifest?.scenes || [];
  const lower = name.toLowerCase();
  const stem = (f) => f.toLowerCase().replace(/\.[^.]+$/, '');
  const entry = list.find((s) => s.id.toLowerCase() === lower) ||
    list.find((s) => s.file.toLowerCase() === lower || stem(s.file) === lower);
  if (entry) return { entry };
  if (/^https?:\/\//i.test(name)) return { url: name };
  if (knownFormat(name)) return { url: new URL((manifest?.base || 'scenes/') + name, manifestUrl).href };
  return null;
}
