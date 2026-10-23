// The viewer application: one call mounts a complete player into an element.
//
//   const handle = mountViewer(el, { scene: 'bloom', onEvent(type, data) {} });
//   const handle = mountViewer(el, { fromUrl: true }); // standalone page: read ?scene=…

import { TEMPLATE, injectStyles } from './template.js';
import { detectCapabilities, preferredColorSpace, preferredPowerMode } from '../core/capabilities.js';
import { detectFormatFromName, formatLabel, parseUrlConfig } from '../core/formats.js';
import {
  FOV_Y, clampOrbit, defaultOrbit, focalPx, orbitFromView, orbitView, projectPoint,
} from '../core/camera.js';
import { applyRendererPolicy, createQuality, QUALITY_TIERS, updateQuality } from '../core/quality.js';
import { dataBudget, dataTier, readEnvSignals, readTierEnvironment, resolveTier } from '../core/device-tier.js';
import { buildShareUrl, parseDeepLink } from '../core/deeplink.js';
import { subscribeFrames } from '../core/frame-driver.js';
import { runWorkerJob } from '../core/workers.js';
import { validateFile } from '../core/validate.js';
import { WebGLSplatRenderer } from '../render/webgl-renderer.js';
import { sliceAt } from '../export/slice.js';
import { sceneToGLB, sceneToPLY } from '../export/writers.js';

const ASSETS = new URL('../../assets/', import.meta.url);
const GROW_MS = 1600;
const INERTIA_TAU = 300;
const STOP_SPEED = 4e-5;
const MAX_SPEED = 0.004;
const ORBIT_GAIN = 0.5;
const ROLL_GAIN = 0.25;
const SAMPLE_WINDOW = 60;
const MIN_SAMPLE_SPAN = 12;
const DOUBLE_TAP_MS = 320;

class Gone extends Error {
  constructor() {
    super('4dviewer: instance destroyed while loading');
    this.name = 'InstanceGone';
  }
}
const quiet = (err) => err instanceof Gone || err?.name === 'InstanceGone' || err?.name === 'AbortError';

function decodeInWorker(buffer, format, sourceUrl, up) {
  return runWorkerJob('scene-decode',
    () => new Worker(new URL('../loaders/decode-worker.js', import.meta.url), { type: 'module' }),
    { buffer, format, sourceUrl, up }, [buffer]).then((r) => r.scene);
}

export function mountViewer(root, options = {}) {
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fromUrl = !!options.fromUrl;
  const cfg = fromUrl ? parseUrlConfig() : {
    scene: options.scene ?? null, format: options.format ?? null, up: options.up ?? null, gpu: options.gpu ?? null,
    perf: options.perf ?? null, uiMin: !!options.minimalUi, usdz: options.usdz ?? null, xrDisabled: !!options.xrDisabled,
    pool: options.pool ?? null, muted: options.muted ?? null, sh: options.sh ?? null,
    dolly: options.dolly ?? null, yaw: options.yaw ?? null, pitch: options.pitch ?? null, roll: options.roll ?? null,
  };
  cfg.manifest = options.manifest || null;
  cfg.hideChips = !!options.hideSceneChips;
  const emit = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const env = readEnvSignals();
  const budget = dataBudget(dataTier(env));
  const quality = createQuality();
  const aborter = new AbortController();
  const listeners = [];
  let destroyed = false;
  let unsubscribe = null;
  let resizeObs = null;
  let mutedOverride = null;
  let device = { tier: 'desktop', policy: {}, reasons: ['capabilities not probed yet'], webview: { isWebview: false } };

  const state = {
    kind: null, temporalScene: null, staticScene: null, format: null, sourceUrl: null,
    playing: !reducedMotion && budget.autoplay !== false,
    t: 0, lastWall: 0, grow: 1, growStart: 0,
    cam: defaultOrbit(), camOverride: null, camLimits: null,
    glRenderer: null, gpuRenderer: null, usingGpu: false, webgpuDead: false,
    sortWorker: null, sortGen: 0, sortInFlight: false, sortEpoch: 0, sortSentAt: 0, sortRtt: 0,
    lastFrameKey: '', lastSortKey: '', lastStatsAt: 0,
    caps: null, manifest: null, activeSceneId: null,
    stream: null, streamController: null, audio: null, xr: null,
    quality, budget, env, hotspots: new Map(), chapters: [], playlist: { items: [], index: -1 },
    draws: 0, lastVerdict: null,
  };

  const alive = () => {
    if (destroyed) throw new Gone();
  };
  const $ = (name) => root.querySelector(`[data-el="${name}"]`);
  const els = {};
  const width = () => root.clientWidth || 1;
  const height = () => root.clientHeight || 1;

  // --- small UI helpers -------------------------------------------------------

  function announce(text) {
    if (els.sr) els.sr.textContent = text;
  }

  function showError(message) {
    els.err.textContent = message || '';
    els.drop.classList.toggle('failed', !!message);
    if (message) {
      console.error('[4dviewer]', message);
      announce(`Error: ${message}`);
      els.drop.classList.remove('hidden');
    }
  }

  function syncPlayButton() {
    const temporal = state.kind === 'temporal';
    els.play.disabled = !temporal;
    els.scrub.disabled = !temporal;
    els.hud.classList.toggle('static', state.kind === 'static');
    els.play.textContent = state.playing ? '⏸' : '▶';
    els.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    els.play.setAttribute('aria-pressed', String(state.playing));
  }

  function setCredit(entry, fromFile = false) {
    const el = $('credit');
    if (!el) return;
    // A host page that draws its own chips also shows the manifest credit itself;
    // credits carried by the file always stay visible.
    if (cfg.hideChips && !fromFile) return;
    el.textContent = entry?.credit || '';
    el.classList.toggle('format-credit', fromFile && !!entry?.credit);
  }

  function progress(loaded, total) {
    if (total > 0) {
      els.progBar.style.width = `${Math.min(100, Math.round((loaded / total) * 100))}%`;
      els.progText.textContent = `${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`;
    } else {
      els.progBar.style.width = '30%';
      els.progText.textContent = `${(loaded / 1048576).toFixed(1)} MB`;
    }
  }

  function showLoading(title = 'Loading scene') {
    els.loadingTitle.textContent = title;
    showError('');
    els.drop.classList.remove('hidden');
    els.drop.classList.add('loading');
  }

  // Scene audio starts muted (a browser would otherwise start it on the first
  // drag); ?muted=0 or setMuted(false) turns it on.
  function isMuted() {
    if (mutedOverride !== null) return mutedOverride;
    if (device.policy.allowAudio === false) return true;
    if (cfg.muted !== null && cfg.muted !== undefined) return !!cfg.muted;
    return true;
  }

  // --- scene geometry -----------------------------------------------------------

  function sceneBounds() {
    const s = state.kind === 'temporal' ? state.temporalScene : state.staticScene;
    return s ? { center: s.center, radius: s.radius } : { center: [0, 0, 0], radius: 1 };
  }

  function sceneCount() {
    return (state.kind === 'temporal' ? state.temporalScene?.count : state.staticScene?.count) ?? 0;
  }

  function initialCamera() {
    const o = state.camOverride || {};
    const { center, radius } = sceneBounds();
    const fromView = state.kind === 'temporal' && state.temporalScene?.view
      ? orbitFromView(state.temporalScene.view, center, radius) : null;
    const pick = (...v) => v.find((x) => Number.isFinite(x));
    // The field of view is fixed vertically, so a portrait screen sees less
    // width; back the opening camera off to keep wide scenes in frame.
    const aspect = width() / height();
    const portrait = aspect < 1 ? Math.min(1.9, 1 / Math.max(aspect, 0.5)) : 1;
    return {
      yaw: pick(o.yaw, cfg.yaw, fromView?.yaw, 0),
      pitch: pick(o.pitch, cfg.pitch, fromView?.pitch, -0.15),
      roll: pick(o.roll, cfg.roll, fromView?.roll, 0),
      dolly: pick(o.dolly, cfg.dolly, fromView?.dolly, 2.2) * portrait,
      pan: fromView && !Number.isFinite(o.yaw) && !Number.isFinite(cfg.yaw) ? fromView.pan.slice() : [0, 0, 0],
    };
  }

  function currentView() {
    const { center, radius } = sceneBounds();
    return orbitView(state.cam, center, radius);
  }

  function setReveal() {
    if (!state.kind) return;
    const { center, radius } = sceneBounds();
    const inv = radius > 1e-6 ? 1 / radius : 0;
    for (const r of [state.glRenderer, state.gpuRenderer]) {
      if (!r) continue;
      r.revealOrigin = [center[0], center[1], center[2]];
      r.revealInvRadius = inv;
      r.revealWidth = inv > 0 && !reducedMotion ? 0.35 : 0;
    }
  }

  function seekTo(t) {
    state.t = t;
    state.audio?.seek(t);
  }

  // Shader compilation and the first uploads stall a frame or two after a
  // load; keep that hitch out of the resolution governor.
  function warmUpQuality() {
    quality.emaGap = 16;
    quality.lastAdjustAt = performance.now() + 1000;
  }

  // --- sorting --------------------------------------------------------------------

  function stopSort() {
    state.sortWorker?.terminate();
    state.sortWorker = null;
    state.sortInFlight = false;
  }

  function onSorted(e) {
    state.sortInFlight = false;
    const rtt = (performance.now() - state.sortSentAt) / 1000;
    state.sortRtt = state.sortRtt ? 0.8 * state.sortRtt + 0.2 * rtt : rtt;
    state.sortEpoch++;
    state.glRenderer?.updateOrder(e.data.indices);
    if (e.data.indices.length > 0) state.streamController?.markFirstPaint();
  }

  function startSort(kind) {
    stopSort();
    const w = kind === 'temporal'
      ? new Worker(new URL('../render/sort-worker-temporal.js', import.meta.url), { type: 'module' })
      : new Worker(new URL('../render/sort-worker-static.js', import.meta.url), { type: 'module' });
    w.onmessage = onSorted;
    if (kind === 'temporal' && state.temporalScene && !state.temporalScene.streaming) {
      const geo = state.temporalScene.geo.slice();
      w.postMessage({ geo, count: state.temporalScene.count, duration: state.temporalScene.duration }, [geo.buffer]);
    } else if (kind === 'static') {
      const s = state.staticScene;
      const positions = s.positions.slice(), opacities = s.opacities.slice(), scales = s.scales.slice();
      w.postMessage({ positions, count: s.count, opacities, scales }, [positions.buffer, opacities.buffer, scales.buffer]);
    }
    state.sortWorker = w;
    state.lastSortKey = '';
    return w;
  }

  // --- renderers --------------------------------------------------------------------

  function ensureGl() {
    if (state.glRenderer) return state.glRenderer;
    const canvas = document.createElement('canvas');
    canvas.className = 'tg4d-gl';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Volumetric scene');
    root.insertBefore(canvas, root.firstChild);
    const r = WebGLSplatRenderer.create(canvas, {
      xrCompatible: false,
      powerPreference: preferredPowerMode({ coarsePointer: env.coarsePointer }),
      colorSpace: preferredColorSpace({
        apiSupported: typeof WebGL2RenderingContext !== 'undefined' && 'drawingBufferColorSpace' in WebGL2RenderingContext.prototype,
        gamutP3: typeof matchMedia === 'function' && matchMedia('(color-gamut: p3)').matches,
      }),
    });
    r.onContextRestored = () => {
      state.lastSortKey = '';
      state.lastFrameKey = '';
    };
    els.gl = canvas;
    attachPointer(canvas);
    state.glRenderer = r;
    return r;
  }

  const uploadOptions = () => ({
    maxShDegree: Number.isFinite(cfg.sh) ? cfg.sh : null,
    colourBudgetBytes: env.coarsePointer ? 3e8 : 1.2e9,
  });

  async function setupRenderer() {
    alive();
    state.usingGpu = false;
    const scene = state.kind === 'temporal' ? state.temporalScene : state.staticScene;
    if (state.caps?.webgpu && !state.webgpuDead && cfg.gpu === '1') {
      try {
        const { WebGPUSplatRenderer } = await import('../render/webgpu-renderer.js');
        const r = await WebGPUSplatRenderer.create(els.gpu, scene, { maxShDegree: uploadOptions().maxShDegree });
        if (destroyed) {
          r.destroy();
          throw new Gone();
        }
        r.onSorted = () => { state.sortEpoch++; };
        r.onDeviceLost = () => {
          state.webgpuDead = true;
          state.gpuRenderer = null;
          setupRenderer().catch((err) => quiet(err) || showError(String(err.message || err)));
        };
        state.gpuRenderer = r;
        state.usingGpu = true;
      } catch (err) {
        if (quiet(err)) throw err;
        console.warn('[4dviewer] WebGPU init failed, using the WebGL2 path:', err);
      }
    }
    els.gpu.classList.toggle('hidden', !state.usingGpu);
    if (!state.usingGpu) {
      const gl = ensureGl();
      gl.uploadScene(scene, uploadOptions());
      startSort(state.kind);
    } else {
      stopSort();
    }
    els.gl?.classList.toggle('hidden', state.usingGpu);
    applyRendererPolicy(quality, cfg, state);
    updateXRButtons();
  }

  function teardownScene() {
    state.audio?.destroy();
    state.audio = null;
    state.streamController?.destroy();
    state.streamController = null;
    state.stream = null;
    state.gpuRenderer?.destroy?.();
    state.gpuRenderer = null;
    stopSort();
    els.mute.classList.add('hidden');
  }

  // --- frame loop ----------------------------------------------------------------------

  const inertia = { vYaw: 0, vPitch: 0, active: false, samples: [] };
  const pointers = new Map();
  let pinchDist = 0;
  let lastTap = 0;

  function stopInertia() {
    inertia.active = false;
    inertia.vYaw = 0;
    inertia.vPitch = 0;
    inertia.samples.length = 0;
  }

  function frame(now) {
    if (destroyed || !state.kind || state.xr) return;
    if (inertia.active && pointers.size === 0) {
      const dt = state.lastWall ? Math.min(64, now - state.lastWall) : 16.67;
      state.cam.yaw += inertia.vYaw * dt;
      state.cam.pitch += inertia.vPitch * dt;
      const decay = Math.exp(-dt / INERTIA_TAU);
      inertia.vYaw *= decay;
      inertia.vPitch *= decay;
      const y0 = state.cam.yaw, p0 = state.cam.pitch;
      clampOrbit(state.cam, state.camLimits);
      if (state.cam.yaw !== y0) inertia.vYaw = 0;
      if (state.cam.pitch !== p0) inertia.vPitch = 0;
      if (Math.hypot(inertia.vYaw, inertia.vPitch) < STOP_SPEED) stopInertia();
    }
    if (state.lastWall && state.lastFrameKey) updateQuality(quality, now, now - state.lastWall, sceneCount());
    if (state.grow < 1) {
      const drawable = state.usingGpu ? sceneCount() : (state.glRenderer?.drawCount ?? 0);
      if (!state.growStart && drawable > 0) state.growStart = now;
      setReveal();
      const p = state.growStart ? Math.min(1, (now - state.growStart) / GROW_MS) : 0;
      state.grow = 1 - (1 - p) ** 3;
    }
    const duration = state.kind === 'temporal' ? state.temporalScene.duration : null;
    if (state.playing && duration && state.grow >= 1 && state.lastWall) {
      state.t = (state.t + (now - state.lastWall) / 1000) % duration;
    }
    if (duration && document.activeElement !== els.scrub) els.scrub.value = String(state.t / duration);
    state.lastWall = now;
    state.audio?.tick();

    const dpr = Math.min(devicePixelRatio || 1, 2) * quality.scale;
    const canvas = state.usingGpu ? els.gpu : els.gl;
    if (!canvas) return;
    const W = Math.max(2, Math.floor(width() * dpr));
    const H = Math.max(2, Math.floor(height() * dpr));
    const c = state.cam;
    const camKey = `${c.yaw.toFixed(4)},${c.pitch.toFixed(4)},${c.roll.toFixed(4)},${c.dolly.toFixed(4)},` +
      `${c.pan[0].toFixed(3)},${c.pan[1].toFixed(3)},${c.pan[2].toFixed(3)}`;
    const frameKey = `${camKey}|${state.t.toFixed(4)}|${state.grow.toFixed(3)}|${W}x${H}|${state.sortEpoch}|${state.usingGpu}`;
    if (frameKey === state.lastFrameKey) return;
    state.lastFrameKey = frameKey;
    state.draws++;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    els.time.textContent = duration ? `${state.t.toFixed(2)} / ${duration.toFixed(2)} s` : '';
    const { m, eye } = currentView();
    const f = focalPx(FOV_Y, H);
    const t0 = performance.now();
    const sortKey = `${camKey}|${(Math.round(state.t * 30) / 30).toFixed(3)}`;
    const needSort = sortKey !== state.lastSortKey;
    let drawn = 0;
    if (state.usingGpu && state.gpuRenderer) {
      state.gpuRenderer.grow = state.grow;
      if (needSort) {
        state.lastSortKey = sortKey;
        state.gpuRenderer.requestSort(m, state.t);
      }
      state.gpuRenderer.render(m, { fx: f, fy: f, cx: W / 2, cy: H / 2 }, eye, state.t);
      drawn = sceneCount();
    } else if (state.glRenderer) {
      const r = state.glRenderer;
      if (needSort && !state.sortInFlight && state.sortWorker) {
        state.lastSortKey = sortKey;
        state.sortInFlight = true;
        state.sortSentAt = performance.now();
        state.sortWorker.postMessage({
          view: Array.from(m), t: state.t, gen: ++state.sortGen, cap: quality.splatCap || 0,
          window: (state.sortRtt || 0) + 1 / 30,
        });
      }
      r.grow = state.grow;
      r.time = state.t;
      r.clear();
      r.render(m, { fx: f, fy: f, cx: W / 2, cy: H / 2 }, { x: 0, y: 0, width: W, height: H }, eye);
      drawn = state.temporalScene?.streaming ? state.temporalScene.count : r.count;
    }
    if (now - state.lastStatsAt > 500) {
      state.lastStatsAt = now;
      const api = state.usingGpu ? 'WebGPU' : 'WebGL2';
      const nearest = !state.usingGpu && state.glRenderer && state.glRenderer.drawCount < drawn
        ? ` · drawing ${state.glRenderer.drawCount.toLocaleString()}` : '';
      const perf = quality.software ? ' · performance mode' : quality.scale < 0.99 ? ` · ${Math.round(quality.scale * 100)}% res` : '';
      els.stats.textContent = `${drawn.toLocaleString()} splats (${state.format}, ${api}) · ${W}×${H}${nearest}${perf} · ${(performance.now() - t0).toFixed(1)} ms`;
    }
  }

  // --- pointer & keyboard ------------------------------------------------------------------

  const pxToAngle = (gain) => (2 * Math.PI * gain) / (height() > 1 ? height() : 720);

  function recordSample(now) {
    const s = inertia.samples;
    s.push({ t: now, yaw: state.cam.yaw, pitch: state.cam.pitch });
    while (s.length > 2 && now - s[1].t > SAMPLE_WINDOW) s.shift();
    if (s.length > 16) s.shift();
  }

  function releaseVelocity(now) {
    const s = inertia.samples;
    if (s.length < 2) return { vYaw: 0, vPitch: 0 };
    const a = s[0], b = s[s.length - 1];
    if (now - b.t > SAMPLE_WINDOW) return { vYaw: 0, vPitch: 0 };
    const span = b.t - a.t;
    if (span < MIN_SAMPLE_SPAN) return { vYaw: 0, vPitch: 0 };
    const clamp = (v) => Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v));
    return { vYaw: clamp((b.yaw - a.yaw) / span), vPitch: clamp((b.pitch - a.pitch) / span) };
  }

  function pan(dx, dy, gain) {
    const cam = state.cam;
    const { radius } = sceneBounds();
    const k = (radius * cam.dolly) / height();
    const { m } = currentView();
    for (let a = 0; a < 3; ++a) cam.pan[a] -= (dx * gain * m[a] + dy * gain * m[4 + a]) * k;
  }

  function attachPointer(canvas) {
    const opts = { signal: aborter.signal };
    for (const type of ['touchstart', 'touchmove']) canvas.addEventListener(type, (e) => e.preventDefault(), { passive: false, ...opts });
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) canvas.addEventListener(type, (e) => e.preventDefault(), opts);
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      root.focus?.({ preventScroll: true });
      stopInertia();
      els.hint.classList.remove('shown');
      els.help.setAttribute('aria-expanded', 'false');
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (e.pointerType === 'touch' && pointers.size === 1) {
        const now = performance.now();
        if (now - lastTap < DOUBLE_TAP_MS) state.cam = initialCamera();
        lastTap = now;
      }
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // capture is best-effort
      }
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    }, opts);
    const release = (e) => {
      pointers.delete(e.pointerId);
      pinchDist = 0;
      if (pointers.size === 0) {
        const now = performance.now();
        const { vYaw, vPitch } = releaseVelocity(now);
        inertia.vYaw = vYaw;
        inertia.vPitch = vPitch;
        inertia.active = !reducedMotion && Math.hypot(vYaw, vPitch) > STOP_SPEED * 8;
        inertia.samples.length = 0;
      }
    };
    canvas.addEventListener('pointerup', release, opts);
    canvas.addEventListener('pointercancel', release, opts);
    canvas.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      const cam = state.cam;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0 && dist > 0) cam.dolly *= pinchDist / dist;
        pinchDist = dist;
        pan(dx, dy, 0.5);
      } else if (e.metaKey || e.ctrlKey || e.buttons === 4) {
        pan(dx, dy, 1);
      } else if (e.altKey) {
        cam.yaw -= dx * pxToAngle(ORBIT_GAIN);
        cam.roll += dy * pxToAngle(ROLL_GAIN);
      } else {
        const k = pxToAngle(ORBIT_GAIN);
        cam.yaw -= dx * k;
        cam.pitch -= dy * k;
        recordSample(performance.now());
      }
      clampOrbit(cam, state.camLimits);
    }, opts);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      state.cam.dolly *= 1 + e.deltaY * 0.001;
      clampOrbit(state.cam, state.camLimits);
    }, { passive: false, ...opts });
    canvas.addEventListener('dblclick', () => {
      state.cam = initialCamera();
    }, opts);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
  }

  function attachKeys() {
    root.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
      if (e.key === ' ') {
        e.preventDefault();
        if (!els.play.disabled) els.play.click();
      } else if (e.key === 'r' || e.key === 'R') {
        state.cam = initialCamera();
      } else if (e.key === '?') {
        const shown = els.hint.classList.toggle('shown');
        els.help.setAttribute('aria-expanded', String(shown));
      }
    }, { signal: aborter.signal });
    const reset = () => {
      pointers.clear();
      pinchDist = 0;
      stopInertia();
    };
    for (const type of ['blur', 'pagehide']) {
      addEventListener(type, reset);
      listeners.push([type, reset]);
    }
  }

  // --- loading ---------------------------------------------------------------------------

  async function loadBuffer(buffer, format, sourceUrl, opts = {}) {
    alive();
    showError('');
    teardownScene();
    els.loadingTitle.textContent = 'Decoding scene';
    const scene = await decodeInWorker(buffer, format, sourceUrl, opts.up ?? cfg.up ?? null);
    alive();
    state.kind = scene.kind;
    state.format = format;
    state.sourceUrl = sourceUrl || null;
    state.t = 0;
    state.lastWall = 0;
    state.lastFrameKey = '';
    if (scene.kind === 'temporal') {
      state.temporalScene = scene;
      state.staticScene = null;
    } else {
      state.staticScene = scene;
      state.temporalScene = null;
    }
    state.cam = initialCamera();
    if (scene.credit) setCredit({ credit: scene.credit }, true);
    els.badge.textContent = formatLabel(format);
    els.drop.classList.add('hidden');
    els.drop.classList.remove('loading');
    els.ply.disabled = false;
    els.glb.disabled = false;
    els.scrub.value = '0';
    syncPlayButton();
    await setupRenderer();
    state.grow = reducedMotion ? 1 : 0;
    state.growStart = 0;
    setReveal();
    warmUpQuality();
    for (const w of scene.warnings || []) emit('warning', { message: w, format });
    emit('loaded', { format, kind: scene.kind, count: scene.count, duration: scene.kind === 'temporal' ? scene.duration : null });
    announce(`Scene loaded: ${scene.count.toLocaleString()} splats${scene.kind === 'temporal' ? `, ${scene.duration.toFixed(1)} seconds` : ''}`);
    if (scene.audio && scene.audioTracks?.length) {
      startAudio(scene, async (track) => track.bytes || null).catch((err) => quiet(err) || console.warn('[4dviewer] audio unavailable:', err));
    }
  }

  async function startAudio(scene, fetchChunk) {
    const { createAudioSync } = await import('../audio/audio-sync.js');
    const meta = scene.audio;
    if (!meta?.tracks?.length || !scene.audioTracks?.length) return;
    const sync = createAudioSync({
      getTime: () => state.t,
      getDuration: () => (state.kind === 'temporal' && state.temporalScene?.duration) || 0,
      isPlaying: () => state.playing && state.grow >= 1,
      getListener: () => {
        if (!state.kind) return null;
        const { m, eye } = currentView();
        return { position: eye, forward: [m[8], m[9], m[10]], up: [-m[4], -m[5], -m[6]] };
      },
      muted: isMuted(),
    });
    const tracks = [];
    for (let i = 0; i < scene.audioTracks.length; ++i) {
      const bytes = await fetchChunk(scene.audioTracks[i]);
      if (!bytes) continue;
      const zUp = meta.up === 'z';
      const objects = meta.tracks[i]?.objects?.map((o) => ({
        ...o,
        trajectory: o.trajectory?.map((k) => ({ t: k.t, p: zUp ? [k.p[0], -k.p[2], k.p[1]] : k.p })),
      })) ?? null;
      tracks.push({ kind: meta.tracks[i]?.kind ?? 'bed', channels: scene.audioTracks[i].channels, objects, bytes });
    }
    if (!tracks.length) return;
    const result = await sync.load(tracks);
    if (destroyed) {
      sync.destroy();
      return;
    }
    state.audio = sync;
    els.mute.classList.remove('hidden');
    syncMuteButton();
    emit('audio', { tracks: result.tracks, failed: result.failed, muted: sync.isMuted() });
  }

  function syncMuteButton() {
    const muted = state.audio ? state.audio.isMuted() : isMuted();
    els.mute.textContent = muted ? '🔇' : '🔊';
    els.mute.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    els.mute.setAttribute('aria-pressed', String(!muted));
  }

  async function fetchWithProgress(url) {
    const res = await fetch(url, { signal: aborter.signal });
    if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
    const total = Number(res.headers.get('Content-Length')) || 0;
    if (!res.body) return res.arrayBuffer();
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      progress(loaded, total);
      emit('progress', { loaded, total });
    }
    const out = new Uint8Array(loaded);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out.buffer;
  }

  async function loadUrl(url, format, opts = {}) {
    const fmt = format || detectFormatFromName(url);
    if (!fmt) {
      showError(`Could not detect the format of "${url}" — add ?format=…`);
      return false;
    }
    try {
      showLoading(fmt === 'nx4d' || fmt === 'nxs4' ? 'Streaming 4D scene' : 'Loading scene');
      progress(0, 0);
      if (fmt === 'nxs4') {
        try {
          await openStream(url, opts);
          return true;
        } catch (err) {
          if (quiet(err)) return false;
          console.warn('[4dviewer] streaming open failed, falling back to a full download:', err);
        }
      }
      const buffer = await fetchWithProgress(url);
      await loadBuffer(buffer, fmt, url, opts);
      return true;
    } catch (err) {
      if (quiet(err)) return false;
      showError(String(err.message || err));
      emit('error', { message: String(err.message || err) });
      return false;
    }
  }

  async function openStream(url, opts) {
    alive();
    showError('');
    teardownScene();
    const gl = ensureGl();
    els.gpu.classList.add('hidden');
    els.gl.classList.remove('hidden');
    state.usingGpu = false;
    const { openNxs4Stream } = await import('../stream/nxs4-stream.js');
    const sort = startSort('temporal');
    const controller = await openNxs4Stream({
      url,
      up: opts.up ?? cfg.up,
      poolOverride: Number(cfg.pool) || 0,
      renderer: gl,
      sortPost: (msg, transfer) => sort.postMessage(msg, transfer || []),
      signal: aborter.signal,
      fetchDecorator: options.fetchDecorator,
      onAuthFailure: options.onAuthFailure,
      dataBudget: budget,
      getCamera: () => {
        if (!state.kind) return null;
        const { m, eye } = currentView();
        return { m, eye, fovY: FOV_Y, aspect: width() / Math.max(height(), 1) };
      },
      getT: () => state.t,
      onFirstScene: (scene) => {
        state.kind = 'temporal';
        state.format = 'nxs4';
        state.temporalScene = scene;
        state.staticScene = null;
        state.t = 0;
        state.lastWall = 0;
        state.lastFrameKey = '';
        state.cam = initialCamera();
        els.badge.textContent = formatLabel('nxs4');
        els.drop.classList.add('hidden');
        els.drop.classList.remove('loading');
        els.ply.disabled = true;
        els.glb.disabled = true;
        els.scrub.value = '0';
        setCredit(scene.credit ? { credit: scene.credit } : null, true);
        syncPlayButton();
        applyRendererPolicy(quality, cfg, state);
        updateXRButtons();
        state.grow = reducedMotion ? 1 : 0;
        state.growStart = 0;
        setReveal();
        warmUpQuality();
        emit('loaded', { format: 'nxs4', kind: 'temporal', count: scene.count, duration: scene.duration, streaming: true });
        announce(`Streaming scene: ${scene.count.toLocaleString()} splats, ${scene.duration.toFixed(1)} seconds`);
        startStreamAudio();
      },
      onResidencyChange: () => {
        state.lastSortKey = '';
        state.lastFrameKey = '';
      },
      onPressure: (p) => emit('pressure', p),
      onError: (err) => {
        if (!destroyed && !quiet(err)) {
          showError(String(err.message || err));
          emit('error', { message: String(err.message || err) });
        }
      },
    });
    if (destroyed) {
      controller.destroy();
      throw new Gone();
    }
    state.sourceUrl = url;
    state.streamController = controller;
    state.stream = controller.stats;
    startStreamAudio();
  }

  // Needs both the first scene (audio metadata) and the controller (bytes);
  // runs once, from whichever arrives second.
  function startStreamAudio() {
    const ctl = state.streamController;
    const scene = state.temporalScene;
    if (!ctl || !scene?.streaming || !scene.audio || !ctl.audioTracks?.length || ctl.audioStarted) return;
    ctl.audioStarted = true;
    startAudio({ audio: scene.audio, audioTracks: ctl.audioTracks }, (track) => ctl.fetchAudioChunk(track.chunks[0]))
      .catch((err) => quiet(err) || console.warn('[4dviewer] audio unavailable:', err));
  }

  async function openFile(file) {
    let verdict;
    try {
      verdict = await validateFile(file);
    } catch (err) {
      showError(`Could not read "${file.name}": ${err.message || err}`);
      return;
    }
    if (!verdict.ok) {
      showError(verdict.reason);
      emit('error', { message: verdict.reason, format: verdict.format });
      return;
    }
    for (const w of verdict.warnings) emit('warning', { message: w, format: verdict.format });
    state.lastVerdict = verdict;
    state.activeSceneId = null;
    state.camOverride = null;
    state.camLimits = null;
    setCredit(null);
    renderChips();
    try {
      showLoading('Reading local file');
      progress(0, file.size);
      const buffer = await file.arrayBuffer();
      progress(file.size, file.size);
      await loadBuffer(buffer, verdict.format, null, { up: cfg.up });
    } catch (err) {
      if (quiet(err)) return;
      showError(String(err.message || err));
      emit('error', { message: String(err.message || err) });
    }
  }

  // --- scenes manifest -----------------------------------------------------------------------

  const sceneUrl = (manifest, entry) => new URL((manifest.base || '') + entry.file, new URL('scenes.json', ASSETS)).href;

  async function fetchManifest() {
    try {
      const res = await fetch(new URL('scenes.json', ASSETS), { cache: 'no-cache' });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  function groupScenes() {
    const all = state.manifest?.scenes || [];
    const group = all.find((s) => s.id === state.activeSceneId)?.group || 'home';
    return all.filter((s) => (s.group || 'home') === group);
  }

  function renderChips() {
    if (!state.manifest || cfg.uiMin || cfg.hideChips) return;
    const list = groupScenes();
    if (!list.length) return;
    els.scenes.innerHTML = '';
    for (const s of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip${s.id === state.activeSceneId ? ' active' : ''}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(s.id === state.activeSceneId));
      b.textContent = s.name;
      b.title = `${s.sizeMB} MB${s.tags?.length ? ` · ${s.tags.join(' · ')}` : ''}`;
      b.onclick = () => selectScene(s.id);
      els.scenes.appendChild(b);
    }
    els.scenes.classList.remove('hidden');
  }

  async function selectScene(id) {
    const entry = state.manifest?.scenes?.find((s) => s.id === id);
    if (!entry || state.activeSceneId === id) return;
    state.activeSceneId = id;
    state.camOverride = entry.cam || null;
    state.camLimits = entry.limits || null;
    setCredit(entry);
    renderChips();
    await loadUrl(sceneUrl(state.manifest, entry), entry.format, { up: entry.up });
  }

  // --- export & XR ---------------------------------------------------------------------------

  function exportScene(kind) {
    if (state.temporalScene?.streaming) return null;
    const scene = state.kind === 'temporal' ? sliceAt(state.temporalScene, state.t) : state.staticScene;
    if (!scene) return null;
    return kind === 'glb' ? sceneToGLB(scene) : sceneToPLY(scene);
  }

  function download(kind) {
    const btn = kind === 'glb' ? els.glb : els.ply;
    const label = btn.textContent;
    btn.textContent = 'Exporting…';
    btn.disabled = true;
    setTimeout(() => {
      try {
        const blob = exportScene(kind);
        if (blob) {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = state.kind === 'temporal' ? `frame_t${state.t.toFixed(2)}s.${kind}` : `export.${kind}`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }
      } catch (err) {
        showError(String(err.message || err));
      } finally {
        btn.textContent = label;
        btn.disabled = false;
      }
    }, 50);
  }

  function updateXRButtons() {
    const streaming = !!state.temporalScene?.streaming;
    if (cfg.xrDisabled || streaming || device.policy.offerXR === false || !state.caps) {
      els.xrVr.classList.add('hidden');
      els.xrAr.classList.add('hidden');
    } else {
      els.xrVr.classList.toggle('hidden', !state.caps.xr.immersiveVR);
      els.xrAr.classList.toggle('hidden', !state.caps.xr.immersiveAR);
    }
    if (cfg.usdz) {
      els.quickLook.href = cfg.usdz;
      els.quickLook.classList.remove('hidden');
    } else {
      els.quickLook.classList.add('hidden');
    }
  }

  async function enterXR(mode) {
    if (!state.kind) throw new Error('load a scene before entering XR');
    const { XRPlayer } = await import('../xr/xr-session.js');
    const gl = ensureGl();
    if (state.usingGpu) els.gl.classList.add('hidden');
    const scene = state.kind === 'temporal' ? state.temporalScene : state.staticScene;
    if (state.usingGpu || gl.scene !== scene) gl.uploadScene(scene, uploadOptions());
    gl.time = state.t;
    gl.grow = 1;
    const player = new XRPlayer(gl, scene, {
      getTime: () => state.t,
      setTime: (t) => { state.t = t; },
      isPlaying: () => state.playing,
    });
    state.xr = player;
    await player.start(mode, {
      onEnd: () => {
        state.xr = null;
        state.lastFrameKey = '';
        state.lastSortKey = '';
        if (state.usingGpu) gl.reset();
        else startSort(state.kind);
        emit('xrend', {});
      },
    });
    emit('xrstart', { mode });
  }

  // --- wiring --------------------------------------------------------------------------------

  function wireUi() {
    const sig = { signal: aborter.signal };
    root.addEventListener('dragover', (e) => e.preventDefault(), sig);
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) openFile(f);
    }, sig);
    els.pick.onclick = () => els.file.click();
    els.open.onclick = () => els.file.click();
    els.file.onchange = () => {
      const f = els.file.files[0];
      els.file.value = '';
      if (f) openFile(f);
    };
    els.help.onclick = () => {
      const shown = els.hint.classList.toggle('shown');
      els.help.setAttribute('aria-expanded', String(shown));
    };
    els.play.onclick = () => {
      state.playing = !state.playing;
      syncPlayButton();
      announce(state.playing ? 'Playing' : 'Paused');
      emit('playstate', { playing: state.playing });
    };
    els.scrub.oninput = () => {
      state.playing = false;
      syncPlayButton();
      const d = state.kind === 'temporal' ? state.temporalScene.duration : 1;
      seekTo(Number(els.scrub.value) * d);
      els.scrub.setAttribute('aria-valuetext', `${state.t.toFixed(2)} of ${d.toFixed(2)} seconds`);
    };
    els.mute.onclick = () => {
      mutedOverride = !(state.audio ? state.audio.isMuted() : isMuted());
      state.audio?.setMuted(mutedOverride);
      syncMuteButton();
      emit('audio', { muted: mutedOverride });
    };
    els.ply.onclick = () => download('ply');
    els.glb.onclick = () => download('glb');
    els.copyLink.onclick = async () => {
      const url = handle.getShareUrl();
      try {
        await navigator.clipboard.writeText(url);
        els.copyLink.textContent = 'Link copied';
      } catch {
        els.copyLink.textContent = 'Copy failed — see console';
        console.info('[4dviewer] share link:', url);
      }
      setTimeout(() => { els.copyLink.textContent = 'Copy link to this view'; }, 1600);
    };
    els.xrVr.onclick = () => enterXR('immersive-vr').catch((err) => showError(String(err.message || err)));
    els.xrAr.onclick = () => enterXR('immersive-ar').catch((err) => showError(String(err.message || err)));
  }

  async function init() {
    if (cfg.uiMin) root.classList.add('ui-min');
    state.caps = await detectCapabilities();
    device = resolveTier({ caps: state.caps, adSlot: !!cfg.uiMin, ...readTierEnvironment() });
    state.device = device;
    quality.maxScale = Math.min(quality.maxScale, device.policy.resolutionScale);
    quality.scale = Math.min(quality.scale, quality.maxScale);
    emit('ready', { capabilities: state.caps, device: { tier: device.tier, reasons: device.reasons } });
    state.manifest = cfg.manifest || (await fetchManifest());
    if (destroyed) return;
    if (cfg.scene) {
      const entry = state.manifest?.scenes?.find((s) => cfg.scene === s.id || cfg.scene.endsWith(s.file));
      if (entry) {
        state.activeSceneId = entry.id;
        state.camOverride = entry.cam || null;
        state.camLimits = entry.limits || null;
        setCredit(entry);
        renderChips();
        await loadUrl(sceneUrl(state.manifest, entry), entry.format || cfg.format, { up: entry.up ?? cfg.up });
      } else {
        renderChips();
        await loadUrl(new URL(cfg.scene, location.href).href, cfg.format, { up: cfg.up });
      }
    } else {
      renderChips();
    }
    if (fromUrl && state.kind) {
      const link = parseDeepLink();
      if (link.cam || link.t !== null) {
        if (link.cam) {
          Object.assign(state.cam, { yaw: link.cam.yaw, pitch: link.cam.pitch, roll: link.cam.roll, dolly: link.cam.dolly });
          state.cam.pan = [...link.cam.pan];
          clampOrbit(state.cam, state.camLimits);
        }
        if (link.t !== null) seekTo(link.t);
        state.lastFrameKey = '';
      }
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    aborter.abort();
    unsubscribe?.();
    resizeObs?.disconnect();
    for (const [type, fn] of listeners) removeEventListener(type, fn);
    state.xr?.end?.();
    teardownScene();
    state.glRenderer?.destroy();
    state.glRenderer = null;
    state.kind = null;
    root.innerHTML = '';
    root.classList.remove('tg4d', 'ui-min', 'narrow');
  }

  // --- mount ---------------------------------------------------------------------------------

  injectStyles(root.ownerDocument || document);
  root.classList.add('tg4d');
  root.tabIndex = -1;
  root.innerHTML = TEMPLATE;
  Object.assign(els, {
    gpu: $('gpu'), stats: $('stats'), sr: $('sr-status'), badge: $('format-badge'), scenes: $('scenes'),
    drop: $('drop'), err: $('err'), pick: $('pick'), file: $('file'), hud: $('hud'), play: $('play'),
    scrub: $('scrub'), time: $('time'), mute: $('mute'), open: $('open'), ply: $('ply'), glb: $('glb'),
    help: $('help'), hint: $('hint'), progBar: $('prog-bar'), progText: $('prog-text'),
    loadingTitle: $('loading-title'), xrVr: $('xr-vr'), xrAr: $('xr-ar'), quickLook: $('ar-quicklook'),
    copyLink: $('copy-link'),
  });
  if (cfg.scene) showLoading(/\.nx(4d|s4)/i.test(cfg.scene) ? 'Streaming 4D scene' : 'Loading scene');
  syncPlayButton();
  attachPointer(els.gpu);
  attachKeys();
  wireUi();
  const onResize = () => {
    root.classList.toggle('narrow', width() <= 640);
    state.lastFrameKey = '';
  };
  onResize();
  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(onResize);
    resizeObs.observe(root);
  }
  if (typeof window !== 'undefined') window.__tg4dState = state;
  unsubscribe = subscribeFrames(frame);
  init().catch((err) => quiet(err) || showError(String(err.message || err)));

  const playerState = () => {
    if (!state.kind) return 'UNSTARTED';
    if ((state.temporalScene?.streaming && !(state.glRenderer?.drawCount > 0)) || state.grow < 1) return 'BUFFERING';
    return state.playing ? 'PLAYING' : 'PAUSED';
  };

  const handle = {
    selectScene: (id) => selectScene(id),
    load: (url, format, opts) => {
      state.activeSceneId = null;
      state.camOverride = null;
      state.camLimits = null;
      setCredit(null);
      renderChips();
      return loadUrl(url, format, opts);
    },
    openFile: (file) => openFile(file),
    destroy,
    play: () => {
      state.playing = true;
      syncPlayButton();
      announce('Playing');
      emit('playstate', { playing: true });
    },
    pause: () => {
      state.playing = false;
      syncPlayButton();
      announce('Paused');
      emit('playstate', { playing: false });
    },
    seek: (t) => {
      state.playing = false;
      syncPlayButton();
      seekTo(t);
    },
    getPlayerState: playerState,
    setCam: (c) => {
      for (const k of ['yaw', 'pitch', 'roll', 'dolly']) if (Number.isFinite(c?.[k])) state.cam[k] = c[k];
      if (Array.isArray(c?.pan) && c.pan.length === 3) state.cam.pan = [...c.pan];
      clampOrbit(state.cam, state.camLimits);
    },
    getCamera: () => ({ ...state.cam, pan: [...state.cam.pan] }),
    resetView: () => { state.cam = initialCamera(); },
    setQualityTier: (tier) => {
      const s = QUALITY_TIERS[tier];
      if (s === undefined) throw new Error(`setQualityTier: unknown tier "${tier}" (auto|low|medium|high)`);
      quality.maxScale = s;
      quality.scale = tier === 'auto' ? Math.min(quality.scale, s) : s;
      state.lastFrameKey = '';
    },
    getShareUrl: (o = {}) => buildShareUrl({
      base: o.base, scene: o.scene ?? state.activeSceneId ?? state.sourceUrl ?? cfg.scene ?? null,
      t: state.kind === 'temporal' ? state.t : undefined, cam: state.cam, hotspot: o.hotspot ?? null,
    }),
    applyDeepLink: (search) => {
      const link = parseDeepLink(search);
      if (link.cam) {
        Object.assign(state.cam, { yaw: link.cam.yaw, pitch: link.cam.pitch, roll: link.cam.roll, dolly: link.cam.dolly });
        state.cam.pan = [...link.cam.pan];
        clampOrbit(state.cam, state.camLimits);
      }
      if (link.t !== null) seekTo(link.t);
      state.lastFrameKey = '';
      return link;
    },
    addHotspot: (h) => {
      if (!Array.isArray(h?.position) || h.position.length !== 3) throw new Error('addHotspot: position must be [x, y, z] in scene space');
      const id = h.id ?? `hs-${state.hotspots.size + 1}`;
      state.hotspots.set(id, {
        id, position: [...h.position], tStart: Number.isFinite(h.tStart) ? h.tStart : 0,
        tEnd: Number.isFinite(h.tEnd) ? h.tEnd : Infinity, data: h.data ?? null,
      });
      emit('hotspotadd', { id });
      return id;
    },
    removeHotspot: (id) => {
      const had = state.hotspots.delete(id);
      if (had) emit('hotspotremove', { id });
      return had;
    },
    getHotspots: () => [...state.hotspots.values()],
    projectHotspots: () => {
      if (!state.kind) return [];
      const { m } = currentView();
      const vp = { width: width(), height: height(), fovY: FOV_Y };
      return [...state.hotspots.values()]
        .filter((h) => state.t >= h.tStart && state.t <= h.tEnd)
        .map((h) => ({ h, p: projectPoint(m, h.position, vp) }))
        .filter(({ p }) => Number.isFinite(p.x) && p.x >= -vp.width && p.x <= 2 * vp.width)
        .map(({ h, p }) => ({ id: h.id, x: p.x, y: p.y, z: p.z, data: h.data }))
        .sort((a, b) => a.z - b.z);
    },
    hitTest: (x, y, radius = 24) => {
      let best = null, bestD = Infinity;
      for (const p of handle.projectHotspots()) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d <= radius && (d < bestD || (d === bestD && best && p.z < best.z))) {
          best = p;
          bestD = d;
        }
      }
      if (best) emit('hotspothit', { id: best.id, data: best.data });
      return best;
    },
    setChapters: (list) => { state.chapters = [...(list ?? [])].sort((a, b) => a.t - b.t); },
    getChapter: () => {
      let cur = null;
      for (const c of state.chapters) if (c.t <= state.t + 1e-9) cur = c;
      return cur ?? state.chapters[0] ?? null;
    },
    setPlaylist: (items) => {
      state.playlist = { items: [...(items ?? [])], index: items?.length ? 0 : -1 };
      return state.playlist.items[state.playlist.index] ?? null;
    },
    getPlaylist: () => ({ items: [...state.playlist.items], index: state.playlist.index }),
    next: async ({ loop = false } = {}) => {
      const pl = state.playlist;
      if (pl.index < 0) return null;
      if (pl.index + 1 < pl.items.length) pl.index++;
      else if (loop) pl.index = 0;
      else return null;
      const item = pl.items[pl.index];
      await loadUrl(item.scene, item.format, { up: item.up });
      return item;
    },
    validateFile: (file) => validateFile(file),
    getCapabilities: () => state.caps,
    getPolicy: () => ({ signals: { ...env }, budget: { ...budget }, device: { ...device } }),
    getBuffered: () => {
      if (!state.kind) return { time: [], space: null };
      if (state.streamController) return state.streamController.getBuffered();
      const { center: c, radius: r } = sceneBounds();
      return {
        time: [[0, state.kind === 'temporal' ? state.temporalScene.duration : 0]],
        space: { min: [c[0] - r, c[1] - r, c[2] - r], max: [c[0] + r, c[1] + r, c[2] + r] },
      };
    },
    setMuted: (m) => {
      mutedOverride = !!m;
      state.audio?.setMuted(mutedOverride);
      syncMuteButton();
      emit('audio', { muted: mutedOverride });
      return mutedOverride;
    },
    isMuted: () => (state.audio ? state.audio.isMuted() : isMuted()),
    getAudioStats: () => state.audio?.stats() ?? null,
    enterXR: (mode) => enterXR(mode),
    exitXR: () => state.xr?.end(),
    exportPLY: () => exportScene('ply'),
    exportGLB: () => exportScene('glb'),
    capturePoster: async ({ type = 'image/webp', quality: q = 0.85, maxSize = 640 } = {}) => {
      if (!state.kind) throw new Error('no scene is loaded');
      const canvas = state.usingGpu ? els.gpu : els.gl;
      state.lastFrameKey = '';
      frame(performance.now());
      const s = Math.min(1, maxSize / Math.max(canvas.width, canvas.height));
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(canvas.width * s));
      out.height = Math.max(1, Math.round(canvas.height * s));
      const ctx = out.getContext('2d');
      ctx.fillStyle = getComputedStyle(root).backgroundColor || '#08090c';
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(canvas, 0, 0, out.width, out.height);
      return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, q));
    },
    captureClip: async ({ fps = 30, durationMs = 5000 } = {}) => {
      const canvas = state.usingGpu ? els.gpu : els.gl;
      if (!canvas || typeof MediaRecorder === 'undefined') throw new Error('clip capture is unavailable in this browser');
      const mime = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
        .find((m) => MediaRecorder.isTypeSupported?.(m));
      if (!mime) throw new Error('MediaRecorder supports none of the video types this viewer can produce');
      const stream = canvas.captureStream(fps);
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const parts = [];
      rec.ondataavailable = (e) => e.data?.size && parts.push(e.data);
      const done = new Promise((resolve) => { rec.onstop = resolve; });
      rec.start(200);
      await new Promise((r) => setTimeout(r, Math.min(durationMs, 60000)));
      rec.stop();
      stream.getTracks().forEach((t) => t.stop());
      await done;
      return new Blob(parts, { type: mime });
    },
    getState: () => state,
  };
  return handle;
}
