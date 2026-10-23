// Landing page: mounts the viewer when it scrolls near, pauses it when it is
// off screen, shows live capability badges, scene chips, and the local-file
// panel (validate the header, then open it in the viewer above).

const DEFAULT_SCENE = 'lumen';
const LEVEL_LABEL = { native: 'Native', supported: 'Supported', 'export-only': 'Export only', unsupported: 'Not yet supported' };
const LEVEL_COLOR = { native: 'var(--native)', supported: 'var(--supported)', 'export-only': 'var(--export-only)', unsupported: 'var(--unsupported)' };
const $ = (id) => document.getElementById(id);
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ui = {
  frame: $('frame'), mount: $('mount'), poster: $('poster'), fallback: $('fallback'), retry: $('retry'),
  chips: $('chips'), credit: $('credit'), checking: $('checking'), badges: $('badges'), legend: $('legend'),
  panel: $('panel'), file: $('local-file'), pick: document.querySelector('label.pick'), status: $('local-status'),
  overlay: $('drop-overlay'),
};

let handle = null;
let mounted = false;
let ready = false;
let loaded = false;
let readyTimer = 0;
let scenes = [];
let active = DEFAULT_SCENE;
let local = { kind: 'idle' };
let lastError = null;
let userPlaying = true;
let autoPaused = false;
let quietEvents = false;
let visibilityObs = null;

function setChecking(text, isError = false) {
  ui.checking.textContent = text || '';
  ui.checking.classList.toggle('error', isError);
  ui.checking.classList.toggle('hidden', !text);
}

function renderCapabilities(caps) {
  ui.badges.innerHTML = '';
  for (const [fmt, lv] of Object.entries(caps.formats)) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.title = LEVEL_LABEL[lv.view];
    b.innerHTML = `<span class="dot" style="background:${LEVEL_COLOR[lv.view]}"></span>.${esc(fmt)} · ${LEVEL_LABEL[lv.view]}`;
    ui.badges.appendChild(b);
  }
  ui.legend.innerHTML = `<span>WebGPU: ${caps.webgpu ? 'available' : 'unavailable'} · WebGL2: ${caps.webgl2 ? 'available' : 'unavailable'}</span>` +
    `<span>VR: ${caps.xr.immersiveVR ? 'supported on this device' : 'not supported here'} · AR: ${caps.xr.immersiveAR ? 'supported on this device' : 'not supported here'}</span>`;
  for (const row of document.querySelectorAll('table.formats tr[data-f]')) {
    const lv = caps.formats[row.dataset.f]?.view ?? 'unsupported';
    row.querySelector('.lvl').innerHTML = `<span class="badge"><span class="dot" style="background:${LEVEL_COLOR[lv]}"></span>${LEVEL_LABEL[lv]}</span>`;
  }
}

function renderChips() {
  ui.chips.innerHTML = '';
  if (scenes.length < 1) return;
  for (const s of scenes) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(local.kind !== 'open' && s.id === active));
    b.disabled = !ready;
    b.innerHTML = `<span class="name">${esc(s.name)}</span><span class="meta">${s.count.toLocaleString()} splats · ${s.sizeMB} MB</span>`;
    b.onclick = () => {
      active = s.id;
      local = { kind: 'idle' };
      renderLocal();
      renderChips();
      handle?.selectScene(s.id);
    };
    ui.chips.appendChild(b);
  }
  if (local.kind === 'open') {
    const c = document.createElement('span');
    c.className = 'chip';
    c.setAttribute('aria-selected', 'true');
    c.innerHTML = `<span class="name">${esc(local.name)}</span><span class="meta">your file · never uploaded</span>`;
    ui.chips.appendChild(c);
  }
  const entry = scenes.find((s) => s.id === active);
  ui.credit.textContent = local.kind === 'open' ? '' : entry?.credit ?? '';
}

function facts(verdict) {
  const m = verdict.metadata ?? {};
  const out = [['Format', `.${verdict.format}`]];
  if (typeof m.count === 'number') out.push(['Splats', m.count.toLocaleString()]);
  if (typeof m.duration === 'number') out.push(['Duration', `${m.duration.toFixed(2)} s`]);
  else if (m.kind === 'static') out.push(['Time', 'single frame']);
  if (typeof m.shDegree === 'number') out.push(['SH degree', String(m.shDegree)]);
  if (typeof m.fourierOrders === 'number') out.push(['Motion orders', String(m.fourierOrders)]);
  return out;
}

function renderLocal() {
  const s = local;
  const busy = !ready || s.kind === 'reading' || s.kind === 'loading';
  ui.file.disabled = busy;
  ui.pick.classList.toggle('disabled', busy);
  if (s.kind === 'idle') {
    ui.status.innerHTML = '';
  } else if (s.kind === 'reading') {
    ui.status.innerHTML = `<span class="working">Reading ${esc(s.name)}…</span>`;
  } else if (s.kind === 'loading') {
    ui.status.innerHTML = `<span class="working">Decoding ${esc(s.name)} · ${mb(s.bytes)}</span>`;
  } else if (s.kind === 'refused') {
    ui.status.innerHTML = `<div class="refused"><strong>${esc(s.name)} couldn’t be opened.</strong> ${esc(s.reason)}</div>`;
  } else if (s.kind === 'open') {
    ui.status.innerHTML = `<div class="open-head"><span class="dot"></span><strong>${esc(s.name)}</strong>` +
      `<span class="open-meta">${mb(s.bytes)} · read locally</span>` +
      '<button type="button" class="secondary" id="back-to-demo">Back to the showcase scenes</button></div>' +
      `<dl class="facts">${s.facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` +
      (s.notes.length ? `<ul>${s.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '');
    $('back-to-demo').onclick = () => {
      local = { kind: 'idle' };
      active = DEFAULT_SCENE;
      renderLocal();
      renderChips();
      handle?.selectScene(DEFAULT_SCENE);
    };
  }
}

async function openLocal(file) {
  if (!file || !handle || !ready) return;
  lastError = null;
  local = { kind: 'reading', name: file.name };
  renderLocal();
  let verdict;
  try {
    verdict = await handle.validateFile(file);
  } catch (err) {
    local = { kind: 'refused', name: file.name, reason: String(err?.message || err) };
    renderLocal();
    return;
  }
  if (!verdict.ok || !verdict.format) {
    local = { kind: 'refused', name: file.name, reason: verdict.reason ?? 'The viewer could not read this file.' };
    renderLocal();
    return;
  }
  local = { kind: 'loading', name: file.name, bytes: verdict.bytes };
  renderLocal();
  const url = URL.createObjectURL(file);
  try {
    const ok = await handle.load(url, verdict.format);
    if (ok) {
      local = { kind: 'open', name: file.name, bytes: verdict.bytes, facts: facts(verdict), notes: verdict.warnings };
    } else {
      local = { kind: 'refused', name: file.name, reason: lastError ?? 'The viewer could not decode this file.' };
    }
  } catch (err) {
    local = { kind: 'refused', name: file.name, reason: String(err?.message || err) };
  } finally {
    URL.revokeObjectURL(url);
  }
  renderLocal();
  renderChips();
}

function onEvent(type, data) {
  if (type === 'ready') {
    ready = true;
    clearTimeout(readyTimer);
    renderCapabilities(data.capabilities);
    setChecking(loaded ? '' : 'Streaming scene…');
    renderChips();
    renderLocal();
    watchVisibility();
  } else if (type === 'loaded') {
    loaded = true;
    ui.poster.classList.add('hidden');
    setChecking('');
  } else if (type === 'playstate') {
    if (!quietEvents) userPlaying = !!data.playing;
  } else if (type === 'error') {
    lastError = data.message || 'unknown error';
    if (local.kind !== 'loading') setChecking(`Viewer error: ${lastError}`, true);
  }
}

// Pause when less than 15% is visible; resume only if the visitor had it playing.
function watchVisibility() {
  visibilityObs?.disconnect();
  visibilityObs = new IntersectionObserver((entries) => {
    const visible = entries.some((e) => e.intersectionRatio > 0.15);
    quietEvents = true;
    try {
      if (visible && autoPaused) {
        autoPaused = false;
        if (userPlaying) handle?.play();
      } else if (!visible && !autoPaused) {
        autoPaused = true;
        handle?.pause();
      }
    } finally {
      quietEvents = false;
    }
  }, { threshold: [0, 0.15, 0.5] });
  visibilityObs.observe(ui.frame);
}

async function mount() {
  if (mounted) return;
  mounted = true;
  setChecking('Checking viewer capabilities…');
  readyTimer = setTimeout(() => {
    if (!ready) ui.fallback.classList.remove('hidden');
  }, 25000);
  try {
    const { mountViewer } = await import('../viewer/js/index.js');
    handle = mountViewer(ui.mount, { scene: DEFAULT_SCENE, hideSceneChips: true, onEvent });
    window.__tg4dHandle = handle;
  } catch (err) {
    setChecking(`Viewer error: ${err?.message || err}`, true);
    ui.fallback.classList.remove('hidden');
  }
}

ui.retry.onclick = () => {
  handle?.destroy();
  handle = null;
  mounted = ready = loaded = false;
  autoPaused = false;
  visibilityObs?.disconnect();
  ui.fallback.classList.add('hidden');
  ui.poster.classList.remove('hidden');
  mount();
};

// Lazy mount: start when the frame comes within 200 px of the viewport.
const lazy = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) {
    lazy.disconnect();
    mount();
  }
}, { rootMargin: '200px' });
lazy.observe(ui.frame);

fetch('viewer/assets/scenes.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((m) => {
    scenes = (m?.scenes ?? []).filter((s) => (s.group || 'home') === 'home');
    renderChips();
  })
  .catch(() => {});

// Drop anywhere on the page.
let depth = 0;
const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  depth++;
  ui.overlay.classList.remove('hidden');
  ui.panel.classList.add('dragging');
}, true);
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'copy';
}, true);
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  depth = Math.max(0, depth - 1);
  if (depth === 0) {
    ui.overlay.classList.add('hidden');
    ui.panel.classList.remove('dragging');
  }
}, true);
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  depth = 0;
  ui.overlay.classList.add('hidden');
  ui.panel.classList.remove('dragging');
  openLocal(e.dataTransfer.files?.[0]);
}, true);
ui.file.addEventListener('change', () => {
  const f = ui.file.files?.[0];
  ui.file.value = '';
  openLocal(f);
});
renderLocal();
