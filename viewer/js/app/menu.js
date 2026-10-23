// The ≡ drawer: scene list and upload, coordinates (scene placement and
// camera), view options, export, publishing and help. The viewer owns the
// state; this module turns it into controls and back.

import { IDENTITY_XF, UP_PRESETS, cloneXf } from '../core/transform.js';
import { loadToken, storeToken, publishScene, slugify, validSceneId, waitUntilLive, PUBLISH_MAX_BYTES } from './publish.js';
import { sceneHref } from './router.js';

const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
const fmt = (v, digits) => (Number.isFinite(v) ? String(Math.round(v * 10 ** digits) / 10 ** digits) : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createMenu(ctx) {
  const { root, $ } = ctx;
  const menu = $('menu');
  const all = (sel) => [...menu.querySelectorAll(sel)];
  let lastCamSync = 0;
  let publishing = false;

  function open() {
    root.classList.add('menu-open');
    menu.setAttribute('aria-hidden', 'false');
    $('burger').setAttribute('aria-expanded', 'true');
    $('scrim').classList.remove('hidden');
    refresh();
    syncCamera(true);
    $('menu-close').focus({ preventScroll: true });
    ctx.onToggle?.(true);
  }

  function close() {
    root.classList.remove('menu-open');
    menu.setAttribute('aria-hidden', 'true');
    $('burger').setAttribute('aria-expanded', 'false');
    $('scrim').classList.add('hidden');
    ctx.onToggle?.(false);
  }

  const isOpen = () => root.classList.contains('menu-open');
  const toggle = () => (isOpen() ? close() : open());

  // --- scene ---------------------------------------------------------------

  function renderSceneInfo() {
    const info = ctx.sceneInfo();
    const box = $('scene-info');
    if (!info) {
      box.textContent = 'No scene loaded';
      return;
    }
    const facts = [info.formatLabel, `${info.count.toLocaleString()} splats`];
    if (info.duration) facts.push(`${info.duration.toFixed(2)} s`);
    else facts.push('single frame');
    if (info.shDegree != null) facts.push(`SH ${info.shDegree}`);
    box.innerHTML = `<strong>${esc(info.name)}</strong><br>${esc(facts.join(' · '))}` +
      (info.local ? '<br><span>Your file · read locally</span>' : '');
    $('credit').textContent = info.credit || '';
  }

  function renderSceneList() {
    const list = $('scene-list');
    list.innerHTML = '';
    const active = ctx.activeSceneId();
    for (const s of ctx.sceneList()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'listitem');
      b.className = s.id === active ? 'active' : '';
      const meta = [s.count ? `${Number(s.count).toLocaleString()} splats` : null, s.sizeMB ? `${s.sizeMB} MB` : null,
        s.duration ? `${s.duration} s` : null].filter(Boolean).join(' · ');
      b.innerHTML = `<span>${esc(s.name || s.id)}</span><span class="meta">${esc(meta)}</span>`;
      b.onclick = () => {
        ctx.selectScene(s.id);
        if (ctx.isNarrow()) close();
      };
      list.appendChild(b);
    }
  }

  // --- coordinates ------------------------------------------------------------

  function renderXf() {
    const xf = ctx.getXf();
    for (const input of all('[data-xf]')) input.value = String(xf[input.dataset.xf]);
    for (const input of all('[data-xf-num]')) {
      if (document.activeElement !== input) input.value = fmt(xf[input.dataset.xfNum], 4);
    }
    for (const b of all('[data-up]')) {
      const p = UP_PRESETS[b.dataset.up];
      b.classList.toggle('active', xf.rx === p.rx && xf.ry === p.ry && xf.rz === p.rz);
    }
  }

  function setXfField(key, value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    const xf = ctx.getXf();
    if (key === 's') {
      if (!(v > 0)) return;
      xf.s = v;
    } else if (key.startsWith('r')) {
      xf[key] = ((((v + 180) % 360) + 360) % 360) - 180;
    } else {
      xf[key] = v;
    }
    ctx.setXf(xf);
    renderXf();
  }

  function wireXf() {
    for (const input of all('[data-xf]')) input.addEventListener('input', () => setXfField(input.dataset.xf, input.value));
    for (const input of all('[data-xf-num]')) input.addEventListener('change', () => setXfField(input.dataset.xfNum, input.value));
    for (const b of all('[data-up]')) {
      b.addEventListener('click', () => {
        const p = UP_PRESETS[b.dataset.up];
        ctx.setXf({ ...ctx.getXf(), rx: p.rx, ry: p.ry, rz: p.rz });
        renderXf();
      });
    }
    for (const b of all('[data-step]')) {
      b.addEventListener('click', () => {
        const [key, d] = b.dataset.step.split(':');
        setXfField(key, ctx.getXf()[key] + Number(d));
      });
    }
    $('xf-reset').onclick = () => {
      ctx.setXf(cloneXf(IDENTITY_XF));
      renderXf();
    };
  }

  // --- camera -------------------------------------------------------------------

  function syncCamera(force = false) {
    if (!isOpen()) return;
    const now = performance.now();
    if (!force && now - lastCamSync < 120) return;
    lastCamSync = now;
    const c = ctx.getCamera();
    const values = { yaw: deg(c.yaw), pitch: deg(c.pitch), roll: deg(c.roll), dolly: c.dolly, fov: c.fov, px: c.target[0], py: c.target[1], pz: c.target[2] };
    for (const input of all('[data-cam]')) {
      if (document.activeElement === input) continue;
      const k = input.dataset.cam;
      input.value = fmt(values[k], k === 'dolly' || k[0] === 'p' ? 3 : 1);
    }
  }

  function wireCamera() {
    for (const input of all('[data-cam]')) {
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        const k = input.dataset.cam;
        if (k === 'yaw' || k === 'pitch' || k === 'roll') ctx.setCamera({ [k]: rad(v) });
        else if (k === 'dolly') ctx.setCamera({ dolly: v });
        else if (k === 'fov') ctx.setCamera({ fov: v });
        else {
          const t = ctx.getCamera().target.slice();
          t[{ px: 0, py: 1, pz: 2 }[k]] = v;
          ctx.setCamera({ target: t });
        }
        syncCamera(true);
      });
    }
    $('cam-reset').onclick = () => {
      ctx.resetView();
      syncCamera(true);
    };
  }

  // --- view, export -----------------------------------------------------------------

  function renderView() {
    const xr = ctx.xrOffer();
    $('xr-vr').classList.toggle('hidden', !xr.vr);
    $('xr-ar').classList.toggle('hidden', !xr.ar);
    $('fullscreen').classList.toggle('hidden', !(document.fullscreenEnabled || document.webkitFullscreenEnabled));
    $('fullscreen').textContent = document.fullscreenElement || document.webkitFullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
    $('show-stats').checked = ctx.statsShown();
    $('sound-row').classList.toggle('hidden', !ctx.hasAudio());
    $('sound').checked = ctx.hasAudio() && !ctx.isMuted();
    $('quality').value = ctx.qualityTier();
    const canExport = ctx.canExport();
    $('ply').disabled = !canExport;
    $('glb').disabled = !canExport;
  }

  function wireView() {
    $('fullscreen').onclick = async () => {
      await ctx.toggleFullscreen();
      renderView();
    };
    $('xr-vr').onclick = () => ctx.enterXR('immersive-vr');
    $('xr-ar').onclick = () => ctx.enterXR('immersive-ar');
    $('show-stats').onchange = () => ctx.setStats($('show-stats').checked);
    $('sound').onchange = () => ctx.setMuted(!$('sound').checked);
    $('quality').onchange = () => ctx.setQuality($('quality').value);
    $('ply').onclick = () => ctx.exportScene('ply');
    $('glb').onclick = () => ctx.exportScene('glb');
  }

  // --- publish ----------------------------------------------------------------------

  function renderPublish() {
    const info = ctx.sceneInfo();
    const target = ctx.publishTarget();
    const box = $('publish-box');
    box.classList.toggle('hidden', !target);
    if (!target) return;
    const id = $('pub-id');
    if (info && !id.dataset.touched) id.value = info.local ? slugify(info.name) : (ctx.activeSceneId() || slugify(info.name));
    const name = $('pub-name');
    if (info && !name.dataset.touched) name.value = info.local ? info.name.replace(/\.[^.]+$/, '') : info.name;
    if (!$('pub-token').value) $('pub-token').value = loadToken();
    updatePublishButton();
  }

  function updatePublishButton() {
    const info = ctx.sceneInfo();
    const ok = !!info && !publishing && !!$('pub-token').value.trim() && validSceneId($('pub-id').value.trim()) &&
      (info.local ? !!ctx.localFile() : !!ctx.activeSceneId());
    $('pub-go').disabled = !ok;
    const status = $('pub-status');
    if (!publishing && info?.local && ctx.localFile()?.size > PUBLISH_MAX_BYTES) {
      status.innerHTML = `<span class="bad">${esc(`This file is over ${PUBLISH_MAX_BYTES / 1048576} MB; publish it with git instead.`)}</span>`;
      $('pub-go').disabled = true;
    }
  }

  function wirePublish() {
    for (const k of ['pub-id', 'pub-name']) {
      $(k).addEventListener('input', () => {
        $(k).dataset.touched = '1';
        updatePublishButton();
      });
    }
    $('pub-token').addEventListener('input', updatePublishButton);
    $('pub-go').onclick = async () => {
      const info = ctx.sceneInfo();
      const target = ctx.publishTarget();
      if (!info || !target) return;
      const token = $('pub-token').value.trim();
      const id = $('pub-id').value.trim();
      storeToken(token, $('pub-remember').checked);
      const status = $('pub-status');
      publishing = true;
      updatePublishButton();
      const entry = ctx.publishEntry({
        name: $('pub-name').value.trim() || id,
        withXf: $('pub-xf').checked,
        withCam: $('pub-cam').checked,
      });
      try {
        const res = await publishScene({
          token, repo: target.repo, branch: target.branch, id, entry,
          file: info.local ? ctx.localFile() : null,
          onStatus: (text) => { status.textContent = text; },
        });
        const url = sceneHref(id);
        status.innerHTML = `<span class="ok">Published.</span> Live in about a minute at <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
        ctx.onPublished?.(id, url, res.entry);
        waitUntilLive(url).then((live) => {
          if (live) status.innerHTML = `<span class="ok">Live:</span> <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
        });
      } catch (err) {
        status.innerHTML = `<span class="bad">${esc(err.message || String(err))}</span>`;
      } finally {
        publishing = false;
        updatePublishButton();
      }
    };
  }

  function refresh() {
    renderSceneInfo();
    renderSceneList();
    renderXf();
    renderView();
    renderPublish();
  }

  // --- wiring -----------------------------------------------------------------------

  $('burger').onclick = toggle;
  $('menu-close').onclick = close;
  $('scrim').onclick = close;
  $('upload').onclick = () => ctx.openPicker();
  $('copy-link').onclick = () => ctx.copyLink();
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      $('burger').focus({ preventScroll: true });
    }
  });
  for (const type of ['pointerdown', 'wheel', 'touchstart']) menu.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
  wireXf();
  wireCamera();
  wireView();
  wirePublish();

  return { open, close, toggle, isOpen, refresh, syncCamera, renderXf, renderView };
}
