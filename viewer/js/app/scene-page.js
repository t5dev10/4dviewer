// Builds the static page a scene gets at /<id>/index.html: a copy of the app
// page whose title and link-preview tags name the scene. Pure string work,
// shared by the in-browser publisher and tools/build_pages.mjs.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function sceneDescription(entry) {
  const parts = [];
  if (entry.count) parts.push(`${Number(entry.count).toLocaleString('en-US')} splats`);
  if (entry.duration) parts.push(`${entry.duration} s 4D clip`);
  else parts.push('static scene');
  return `${parts.join(' · ')} — open it in your browser, orbit and scrub; nothing to install.`;
}

export function makeScenePage(appHtml, entry) {
  const title = `${entry.name || entry.id} · 4D Viewer`;
  const desc = sceneDescription(entry);
  return appHtml
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(desc)}$2`);
}
