// Markup and styles of the viewer surface. Everything is scoped under
// .tg4d so the viewer can live inside any page.

export const TEMPLATE = `
<canvas class="tg4d-gpu hidden" data-el="gpu" role="img" aria-label="Volumetric scene"></canvas>
<div class="tg4d-stats" data-el="stats" aria-hidden="true"></div>
<div class="tg4d-sr" data-el="sr-status" role="status" aria-live="polite" aria-atomic="true"></div>
<div class="tg4d-badge" data-el="format-badge"></div>
<div class="tg4d-scenes hidden" data-el="scenes" role="tablist" aria-label="Scenes"></div>
<div class="tg4d-credit" data-el="credit"></div>
<div class="tg4d-drop" data-el="drop">
  <div class="tg4d-drop-inner">
    <div data-el="drop-ui">
      <div class="tg4d-mark" aria-hidden="true"></div>
      <h2>4D Viewer</h2>
      <p>Drop a splat file anywhere, or</p>
      <p><button data-el="pick" type="button">Open file…</button></p>
      <p class="formats"><code>.nx4d</code> 4D &nbsp;·&nbsp; <code>.ply</code> <code>.spz</code> <code>.sog</code> <code>.glb</code> <code>.splat</code> <code>.ksplat</code> <code>.usdz</code></p>
      <p class="tg4d-privacy">Files are read in this tab and never uploaded.</p>
    </div>
    <div data-el="drop-loading" aria-live="polite">
      <div class="tg4d-spinner" aria-hidden="true"></div>
      <div>
        <h2 data-el="loading-title">Loading scene</h2>
        <p data-el="loading-sub">Decoding in this browser — no upload, no video.</p>
      </div>
      <div data-el="prog"><div data-el="prog-bar"></div></div>
      <div data-el="prog-text"></div>
    </div>
    <p data-el="err" role="alert"></p>
  </div>
</div>
<input data-el="file" type="file" accept=".nx4d,.nxs4,.ply,.spz,.sog,.gltf,.glb,.splat,.ksplat,.usdz,.usda" hidden />
<div class="tg4d-hud" data-el="hud" role="group" aria-label="Playback controls">
  <button data-el="play" type="button" title="Play / pause (space)" aria-label="Pause" aria-pressed="true">⏸</button>
  <input data-el="scrub" type="range" min="0" max="1" step="0.001" value="0" aria-label="Timeline position" aria-valuetext="0.00 seconds" />
  <span data-el="time" aria-hidden="true"></span>
  <button data-el="mute" type="button" class="hidden" title="Sound on / off" aria-label="Unmute" aria-pressed="false">🔇</button>
  <button data-el="open" type="button" title="Open a local splat file — or drop it anywhere">Open file</button>
  <button data-el="ply" type="button" title="Export the current moment as a reference 3DGS PLY" disabled>Export PLY</button>
  <button data-el="glb" type="button" title="Export the current moment as glTF (KHR_gaussian_splatting)" disabled>GLB</button>
  <button data-el="help" type="button" title="Controls" aria-label="Show controls help" aria-expanded="false">?</button>
  <button data-el="xr-vr" type="button" class="hidden xr" title="Enter immersive VR">Enter VR</button>
  <button data-el="xr-ar" type="button" class="hidden xr" title="Enter passthrough AR">Enter AR</button>
  <a data-el="ar-quicklook" class="btn hidden" rel="ar" href="#">View in AR</a>
</div>
<div class="tg4d-hint" data-el="hint" role="note" aria-label="Controls help">
  <strong>Controls</strong><br/>
  <span class="hint-desktop">
    Drag — orbit<br/>
    Scroll / pinch — zoom<br/>
    <kbd>Ctrl</kbd>/<kbd>⌘</kbd> drag or middle drag — pan<br/>
    <kbd>Alt</kbd>/<kbd>⌥</kbd> drag — yaw &amp; roll<br/>
    <kbd>Space</kbd> play / pause · <kbd>R</kbd> reset view<br/>
    Double-click — reset view<br/>
  </span>
  <span class="hint-touch">
    Drag — orbit<br/>
    Pinch — zoom<br/>
    Two-finger drag — pan<br/>
    Double-tap — reset view<br/>
  </span>
  Drop any splat file to view it<br/>
  <button data-el="copy-link" type="button">Copy link to this view</button>
</div>
`;

export const STYLES = `
.tg4d {
  --tg-bg: #08090c; --tg-text: #f4f6f8; --tg-dim: #9aa3ad;
  --tg-accent: #22d3ee; --tg-accent-2: #14b8a6; --tg-accent-soft: rgba(34,211,238,0.16);
  --tg-glass: rgba(15,18,24,0.66); --tg-stroke: rgba(255,255,255,0.10);
  --tg-ease: cubic-bezier(0.22,1,0.36,1);
  position: relative; overflow: hidden; background: var(--tg-bg); color: var(--tg-text);
  font: 13px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased;
  touch-action: none; overscroll-behavior: contain; -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none; outline: none;
}
.tg4d *, .tg4d *::before, .tg4d *::after { box-sizing: border-box; }
.tg4d .hidden { display: none !important; }
.tg4d .tg4d-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
.tg4d :focus-visible { outline: 2px solid var(--tg-accent); outline-offset: 2px; }
.tg4d canvas.tg4d-gpu, .tg4d canvas.tg4d-gl { position: absolute; inset: 0; width: 100%; height: 100%;
  display: block; touch-action: none; }

.tg4d .tg4d-scenes { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 5;
  display: flex; gap: 6px; padding: 6px; border-radius: 14px; max-width: calc(100% - 24px); overflow-x: auto;
  scrollbar-width: none; background: var(--tg-glass); border: 1px solid var(--tg-stroke);
  backdrop-filter: blur(18px) saturate(1.3); -webkit-backdrop-filter: blur(18px) saturate(1.3); }
.tg4d .tg4d-scenes::-webkit-scrollbar { display: none; }
.tg4d .tg4d-scenes:empty { display: none; }
.tg4d .tg4d-scenes .chip { background: transparent; color: var(--tg-dim); white-space: nowrap; cursor: pointer;
  border: 1px solid transparent; border-radius: 9px; padding: 6px 12px; font: inherit; font-size: 12.5px;
  transition: color 140ms var(--tg-ease), background 140ms var(--tg-ease); }
.tg4d .tg4d-scenes .chip:hover { color: var(--tg-text); background: rgba(255,255,255,0.06); }
.tg4d .tg4d-scenes .chip.active { color: var(--tg-text); background: var(--tg-accent-soft); border-color: rgba(34,211,238,0.45); }
.tg4d.ui-min .tg4d-scenes, .tg4d.ui-min .tg4d-stats, .tg4d.ui-min .tg4d-badge,
.tg4d.ui-min .tg4d-hint, .tg4d.ui-min .tg4d-credit { display: none !important; }

.tg4d .tg4d-hud { position: absolute; left: 50%; transform: translateX(-50%); z-index: 5;
  bottom: calc(14px + env(safe-area-inset-bottom, 0px)); width: min(760px, calc(100% - 24px));
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 10px 14px; border-radius: 16px;
  background: var(--tg-glass); border: 1px solid var(--tg-stroke);
  backdrop-filter: blur(18px) saturate(1.3); -webkit-backdrop-filter: blur(18px) saturate(1.3);
  box-shadow: 0 12px 40px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.05); }
.tg4d .tg4d-hud button, .tg4d .tg4d-hud a.btn { background: rgba(255,255,255,0.07); color: var(--tg-text);
  border: 1px solid var(--tg-stroke); border-radius: 10px; padding: 7px 12px; cursor: pointer; text-decoration: none;
  font: inherit; font-size: 12.5px; touch-action: manipulation;
  transition: background 140ms var(--tg-ease), border-color 140ms var(--tg-ease), transform 140ms var(--tg-ease); }
.tg4d .tg4d-hud button:hover:not(:disabled), .tg4d .tg4d-hud a.btn:hover {
  background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.2); transform: translateY(-1px); }
.tg4d .tg4d-hud button:disabled { opacity: 0.35; cursor: default; }
.tg4d .tg4d-hud button.xr { background: linear-gradient(135deg, var(--tg-accent-2), #0e7490); color: #fff;
  border-color: rgba(34,211,238,0.5); font-weight: 600; box-shadow: 0 4px 18px rgba(20,184,166,0.35); }
.tg4d .tg4d-hud [data-el="play"], .tg4d .tg4d-hud [data-el="help"], .tg4d .tg4d-hud [data-el="mute"] { min-width: 34px; }
.tg4d [data-el="time"] { font: 11px ui-monospace, 'SF Mono', Menlo, monospace; color: var(--tg-dim); min-width: 92px; text-align: center; }
.tg4d [data-el="time"]:empty { display: none; }
.tg4d .tg4d-hud input[type=range] { flex: 1; min-width: 90px; appearance: none; -webkit-appearance: none;
  height: 4px; border-radius: 2px; background: rgba(255,255,255,0.15); outline: none; }
.tg4d .tg4d-hud input[type=range]::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 14px;
  height: 14px; border-radius: 50%; border: none; background: var(--tg-accent); box-shadow: 0 0 10px rgba(34,211,238,0.6); cursor: pointer; }
.tg4d .tg4d-hud input[type=range]::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; border: none;
  background: var(--tg-accent); box-shadow: 0 0 10px rgba(34,211,238,0.6); cursor: pointer; }
.tg4d .tg4d-hud input[type=range]:disabled { opacity: 0.35; }
.tg4d .tg4d-hud.static [data-el="play"], .tg4d .tg4d-hud.static [data-el="scrub"], .tg4d .tg4d-hud.static [data-el="time"] { display: none; }
.tg4d .tg4d-hud.static { width: auto; }

.tg4d .tg4d-hint { position: absolute; right: 14px; bottom: 80px; z-index: 6; max-width: 270px;
  padding: 12px 14px; border-radius: 14px; font-size: 12px; line-height: 1.75; color: var(--tg-dim);
  background: var(--tg-glass); border: 1px solid var(--tg-stroke);
  backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
  opacity: 0; pointer-events: none; transform: translateY(6px);
  transition: opacity 360ms var(--tg-ease), transform 360ms var(--tg-ease); }
.tg4d .tg4d-hint.shown { opacity: 1; pointer-events: auto; transform: none; }
.tg4d .tg4d-hint strong { color: var(--tg-text); }
.tg4d .tg4d-hint kbd { font: 10.5px ui-monospace, 'SF Mono', Menlo, monospace; color: #a5f3fc;
  background: var(--tg-accent-soft); border: 1px solid rgba(34,211,238,0.3); border-radius: 5px; padding: 1px 5px; }
.tg4d .tg4d-hint button { margin-top: 8px; background: rgba(255,255,255,0.07); color: var(--tg-text);
  border: 1px solid var(--tg-stroke); border-radius: 8px; padding: 5px 10px; font: inherit; font-size: 12px; cursor: pointer; }

.tg4d .tg4d-drop { position: absolute; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center;
  text-align: center; padding: 16px;
  background: radial-gradient(80% 60% at 50% 30%, rgba(34,211,238,0.10), transparent 70%), rgba(8,9,12,0.94); }
.tg4d .tg4d-drop h2 { font-size: 22px; font-weight: 650; letter-spacing: -0.02em; margin: 0 0 4px; color: var(--tg-text); }
.tg4d .tg4d-drop p { margin: 8px 0; color: var(--tg-dim); }
.tg4d .tg4d-drop .formats { font: 11px ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: 0.02em; }
.tg4d .tg4d-drop .formats code { color: #a5f3fc; background: var(--tg-accent-soft); padding: 2px 6px; border-radius: 5px; }
.tg4d .tg4d-drop .tg4d-privacy { font-size: 12px; opacity: 0.8; }
.tg4d .tg4d-mark { width: 44px; height: 44px; margin: 0 auto 12px; border-radius: 12px;
  background: conic-gradient(from 210deg, #22d3ee, #14b8a6, #6366f1, #22d3ee);
  -webkit-mask: radial-gradient(circle at 50% 50%, transparent 9px, #000 10px); mask: radial-gradient(circle at 50% 50%, transparent 9px, #000 10px); }
.tg4d [data-el="pick"] { background: linear-gradient(135deg, var(--tg-accent-2), #0e7490); color: #fff; font: inherit; font-weight: 600;
  border: 1px solid rgba(34,211,238,0.5); border-radius: 10px; padding: 9px 18px; cursor: pointer;
  box-shadow: 0 4px 18px rgba(20,184,166,0.35); transition: transform 140ms var(--tg-ease), box-shadow 140ms var(--tg-ease); }
.tg4d [data-el="pick"]:hover { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(20,184,166,0.5); }
.tg4d [data-el="err"] { color: #fca5a5; max-width: 520px; margin: 12px auto 0; user-select: text; -webkit-user-select: text; }
.tg4d [data-el="err"]:empty { display: none; }
.tg4d [data-el="drop-loading"] { display: none; flex-direction: column; align-items: center; gap: 14px; }
.tg4d .tg4d-drop.loading [data-el="drop-ui"] { display: none; }
.tg4d .tg4d-drop.loading [data-el="drop-loading"] { display: flex; }
.tg4d .tg4d-drop.loading.failed [data-el="drop-loading"] { display: none; }
.tg4d .tg4d-drop.loading.failed [data-el="drop-ui"] { display: block; }
.tg4d [data-el="prog"] { width: 220px; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.1); overflow: hidden; }
.tg4d [data-el="prog-bar"] { width: 0%; height: 100%; border-radius: 2px; background: linear-gradient(90deg, var(--tg-accent-2), var(--tg-accent));
  transition: width 200ms linear; }
.tg4d [data-el="prog-text"] { font: 11px ui-monospace, 'SF Mono', Menlo, monospace; color: var(--tg-dim); min-height: 16px; }
.tg4d .tg4d-spinner { width: 34px; height: 34px; border-radius: 50%; border: 2.5px solid rgba(34,211,238,0.2);
  border-top-color: var(--tg-accent); animation: tg4d-spin 800ms linear infinite; }
@keyframes tg4d-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .tg4d .tg4d-spinner { animation-duration: 2s; } }

.tg4d .tg4d-stats { position: absolute; top: 12px; left: 12px; z-index: 5; padding: 5px 10px; border-radius: 8px;
  background: rgba(8,9,12,0.55); border: 1px solid var(--tg-stroke); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  font: 10.5px ui-monospace, 'SF Mono', Menlo, monospace; color: var(--tg-dim); white-space: pre; }
.tg4d .tg4d-stats:empty { display: none; }
.tg4d .tg4d-badge { position: absolute; top: 12px; right: 12px; z-index: 5; padding: 5px 10px; border-radius: 8px;
  font: 10.5px ui-monospace, 'SF Mono', Menlo, monospace; color: #a5f3fc; background: var(--tg-accent-soft);
  border: 1px solid rgba(34,211,238,0.4); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
.tg4d .tg4d-badge:empty { display: none; }
.tg4d .tg4d-credit { position: absolute; left: 12px; bottom: 80px; z-index: 4; max-width: 320px; font-size: 10.5px;
  line-height: 1.5; color: rgba(154,163,173,0.8); user-select: text; -webkit-user-select: text; }
.tg4d .tg4d-credit:empty { display: none; }
.tg4d .tg4d-credit.format-credit:not(:empty) { display: block !important; }
.tg4d:has(.tg4d-hint.shown) .tg4d-credit { opacity: 0; transition: opacity 200ms var(--tg-ease); }
.tg4d a { color: var(--tg-accent); }

.tg4d .hint-touch { display: none; }
@media (pointer: coarse) {
  .tg4d .hint-desktop { display: none; }
  .tg4d .hint-touch { display: inline; }
}
.tg4d.narrow .tg4d-stats, .tg4d.narrow .tg4d-badge { display: none; }
.tg4d.narrow .tg4d-scenes { top: calc(10px + env(safe-area-inset-top, 0px)); max-width: calc(100% - 20px); }
.tg4d.narrow .tg4d-scenes .chip { padding: 8px 14px; }
.tg4d.narrow .tg4d-hud { padding: 9px 10px; gap: 8px; justify-content: center; width: calc(100% - 16px); }
.tg4d.narrow .tg4d-hud input[type=range] { order: -1; flex: 1 1 100%; min-width: 0; }
.tg4d.narrow [data-el="time"] { display: none; }
.tg4d.narrow .tg4d-hud button, .tg4d.narrow .tg4d-hud a.btn { padding: 9px 13px; min-height: 40px; }
.tg4d.narrow .tg4d-hud [data-el="ply"], .tg4d.narrow .tg4d-hud [data-el="glb"] { display: none; }
.tg4d.narrow .tg4d-credit { bottom: calc(128px + env(safe-area-inset-bottom, 0px)); max-width: calc(100% - 24px); font-size: 10px; }
.tg4d.narrow .tg4d-hint { left: 12px; right: 12px; max-width: none; bottom: calc(128px + env(safe-area-inset-bottom, 0px)); }
`;

const injected = new WeakSet();
export function injectStyles(doc = document) {
  if (injected.has(doc) && doc.getElementById('tg4d-style')) return;
  const style = doc.createElement('style');
  style.id = 'tg4d-style';
  style.textContent = STYLES;
  doc.head.appendChild(style);
  injected.add(doc);
}
