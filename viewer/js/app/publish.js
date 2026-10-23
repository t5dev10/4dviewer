// Owner-only publishing: commits a scene (file, manifest entry and its own
// page) to the site's GitHub repository through the REST API, as one commit.
// The token travels only to api.github.com.

import { makeScenePage } from './scene-page.js';
import { isReservedSceneId } from './router.js';

const API = 'https://api.github.com';
const TOKEN_KEY = 'tg4d-gh-token';
// Blobs travel base64-encoded inside JSON; above this the request gets too large.
export const PUBLISH_MAX_BYTES = 70 * 1024 * 1024;

export class PublishError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'PublishError';
    this.status = status;
  }
}

export function repoFor(loc, manifest) {
  if (manifest?.site?.repo) return { repo: manifest.site.repo, branch: manifest.site.branch || 'main' };
  if (loc.hostname.endsWith('.github.io')) {
    const owner = loc.hostname.split('.')[0];
    const name = loc.pathname.split('/')[1] || `${owner}.github.io`;
    return { repo: `${owner}/${name}`, branch: 'main' };
  }
  return null;
}

export function slugify(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

export function validSceneId(id) {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && !isReservedSceneId(id);
}

export function loadToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function storeToken(token, remember) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
    if (remember) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage blocked: the token lives only in the field
  }
}

async function gh(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = '';
    try {
      msg = (await res.json()).message || '';
    } catch {
      // no JSON body
    }
    throw new PublishError(res.status, explain(res.status, msg));
  }
  return res.status === 204 ? null : res.json();
}

function explain(status, msg) {
  if (status === 401) return 'GitHub rejected the token (expired or mistyped).';
  if (status === 403) return `GitHub refused the request: ${msg || 'the token lacks Contents: write on this repository, or the rate limit was hit'}.`;
  if (status === 404) return 'Repository not found for this token — give the token access to this repository.';
  if (status === 409 || status === 422) return `GitHub could not apply the change (${msg || 'the branch moved'}); try again.`;
  if (status === 413) return 'The file is too large for the GitHub API; add it with git instead.';
  return `GitHub API error ${status}: ${msg || 'unknown'}`;
}

function decodeContent(b64) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; ++i) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function fileToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error || new Error('could not read the file'));
    r.readAsDataURL(blob);
  });
}

// XHR, for upload progress on large scene files.
function uploadBlob(token, repo, base64, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API}/repos/${repo}/git/blobs`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Accept', 'application/vnd.github+json');
    xhr.setRequestHeader('X-GitHub-Api-Version', '2022-11-28');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // keep empty
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new PublishError(xhr.status, explain(xhr.status, body.message)));
    };
    xhr.onerror = () => reject(new PublishError(0, 'Network error while uploading to GitHub.'));
    xhr.send(JSON.stringify({ content: base64, encoding: 'base64' }));
  });
}

// opts: { token, repo, branch, id, entry, file (Blob|null), onStatus(text, fraction) }
// entry: manifest fields { name, format, count, duration, tags, credit, transform, cam, … }.
// With a file the scene is uploaded; without one only its manifest entry and page change.
export async function publishScene({ token, repo, branch = 'main', id, entry, file = null, onStatus }) {
  if (!validSceneId(id)) throw new PublishError(0, 'Use a link name of letters, digits and dashes (not viewer, assets or tools).');
  if (file && file.size > PUBLISH_MAX_BYTES) {
    throw new PublishError(0, `This file is ${(file.size / 1048576).toFixed(0)} MB; the browser publisher handles up to ${PUBLISH_MAX_BYTES / 1048576} MB. Add larger scenes with git (GitHub allows 100 MB per file).`);
  }
  const say = (t, f) => onStatus?.(t, f);
  say('Reading the repository…');
  const ref = await gh(token, 'GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const parent = await gh(token, 'GET', `/repos/${repo}/git/commits/${ref.object.sha}`);
  const manifestFile = await gh(token, 'GET', `/repos/${repo}/contents/viewer/assets/scenes.json?ref=${encodeURIComponent(branch)}`);
  const manifest = JSON.parse(decodeContent(manifestFile.content));
  const appPage = decodeContent((await gh(token, 'GET', `/repos/${repo}/contents/index.html?ref=${encodeURIComponent(branch)}`)).content);

  const scenes = Array.isArray(manifest.scenes) ? manifest.scenes : (manifest.scenes = []);
  const existing = scenes.find((s) => s.id === id);
  // A new upload keeps its own extension (.usda vs .usdz, .glb vs .gltf); a
  // scene already on the site can be re-published under another name with
  // its own placement and view, reusing the same file.
  const ext = (file?.name?.match(/\.([a-z0-9]+)$/i)?.[1] || entry.format).toLowerCase();
  const fileName = file ? `${id}.${ext}` : (entry.file || existing?.file);
  if (!fileName) throw new PublishError(0, `There is no scene "${id}" on the site yet; open its file first.`);
  const next = { ...(existing || {}), ...entry, id, file: fileName, group: existing?.group || entry.group || 'home' };
  if (file) next.sizeMB = Math.round((file.size / 1048576) * 10) / 10;
  for (const k of Object.keys(next)) if (next[k] === null || next[k] === undefined) delete next[k];
  if (existing) scenes[scenes.indexOf(existing)] = next;
  else scenes.push(next);

  const tree = [];
  if (file) {
    say('Encoding the scene…', 0);
    const b64 = await fileToBase64(file);
    say('Uploading the scene…', 0);
    const blob = await uploadBlob(token, repo, b64, (f) => say(`Uploading the scene… ${Math.round(f * 100)}%`, f));
    tree.push({ path: `viewer/assets/scenes/${fileName}`, mode: '100644', type: 'blob', sha: blob.sha });
  }
  say('Writing the scene list and page…');
  const manifestBlob = await gh(token, 'POST', `/repos/${repo}/git/blobs`, { content: `${JSON.stringify(manifest, null, 2)}\n`, encoding: 'utf-8' });
  const pageBlob = await gh(token, 'POST', `/repos/${repo}/git/blobs`, { content: makeScenePage(appPage, next), encoding: 'utf-8' });
  tree.push({ path: 'viewer/assets/scenes.json', mode: '100644', type: 'blob', sha: manifestBlob.sha });
  tree.push({ path: `${id}/index.html`, mode: '100644', type: 'blob', sha: pageBlob.sha });
  const newTree = await gh(token, 'POST', `/repos/${repo}/git/trees`, { base_tree: parent.tree.sha, tree });
  say('Committing…');
  const commit = await gh(token, 'POST', `/repos/${repo}/git/commits`, {
    message: `${file ? 'Publish' : 'Update'} scene "${next.name || id}" at /${id}`,
    tree: newTree.sha,
    parents: [ref.object.sha],
  });
  await gh(token, 'PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
  return { commit: commit.sha, entry: next };
}

// Polls until the scene page is served (GitHub Pages rebuilds in ~30-90 s).
export async function waitUntilLive(url, { timeoutMs = 300000, intervalMs = 5000, signal } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (signal?.aborted) return false;
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (res.status === 200) return true;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
