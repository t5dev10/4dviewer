// Markup and styles of the viewer. The default view is the scene alone: a menu
// button, a slim playback bar for 4D scenes, and everything else in a drawer.
// Elements are addressed by data-el so several viewers can share a page.

const ICON = {
  menu: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  upload: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" stroke-linecap="round"/></svg>',
};

const axisRow = (key, label, min, max, step) => `
  <div class="row axis" data-axis="${key}">
    <span class="lab">${label}</span>
    <input type="range" min="${min}" max="${max}" step="${step}" value="0" data-xf="${key}" aria-label="${label}" />
    <input type="number" step="${step}" value="0" data-xf-num="${key}" aria-label="${label} value" />
  </div>`;

export const TEMPLATE = `
<canvas class="tg4d-gpu hidden" data-el="gpu" role="img" aria-label="Volumetric scene"></canvas>
<div class="tg4d-stats hidden" data-el="stats" aria-hidden="true"></div>
<div class="tg4d-sr" data-el="sr-status" role="status" aria-live="polite" aria-atomic="true"></div>
<button type="button" class="tg4d-burger" data-el="burger" aria-label="Open menu" aria-expanded="false">${ICON.menu}</button>

<div class="tg4d-drop" data-el="drop">
  <div class="tg4d-card">
    <div data-el="drop-ui">
      <div class="tg4d-mark" aria-hidden="true"></div>
      <h2>4D Viewer</h2>
      <p>Drop a splat file anywhere, or</p>
      <p><button type="button" class="primary" data-el="pick">${ICON.upload} Upload scene</button></p>
      <p class="formats"><code>.nx4d</code> <code>.nxs4</code> <code>.ply</code> <code>.sog4d</code> <code>.spz</code> <code>.sog</code> <code>.glb</code> <code>.splat</code> <code>.ksplat</code> <code>.usdz</code></p>
    </div>
    <div data-el="drop-loading" class="loading-box" aria-live="polite">
      <div class="tg4d-spinner" aria-hidden="true"></div>
      <div class="loading-title" data-el="loading-title">Loading scene</div>
      <div class="prog"><div data-el="prog-bar"></div></div>
      <div class="prog-text" data-el="prog-text"></div>
    </div>
    <p class="err" data-el="err" role="alert"></p>
  </div>
</div>
<div class="tg4d-dropzone hidden" data-el="dropzone" aria-hidden="true"><span>Drop to open</span></div>
<input data-el="file" type="file" accept=".nx4d,.nxs4,.ply,.sog4d,.spz,.sog,.gltf,.glb,.splat,.ksplat,.usdz,.usda" hidden />

<div class="tg4d-hud hidden" data-el="hud" role="group" aria-label="Playback">
  <button type="button" class="round" data-el="play" title="Play / pause (space)" aria-label="Pause" aria-pressed="true">⏸</button>
  <input type="range" data-el="scrub" min="0" max="1" step="0.001" value="0" aria-label="Timeline position" aria-valuetext="0.00 seconds" />
  <span class="time" data-el="time" aria-hidden="true"></span>
  <button type="button" class="round hidden" data-el="mute" title="Sound on / off" aria-label="Unmute" aria-pressed="false">🔇</button>
</div>
<div class="tg4d-toast" data-el="toast" role="status" aria-live="polite"></div>

<div class="tg4d-scrim hidden" data-el="scrim"></div>
<aside class="tg4d-menu" data-el="menu" aria-label="Viewer menu" aria-hidden="true">
  <header class="menu-head">
    <div class="brand"><span class="tg4d-mark small" aria-hidden="true"></span>4D Viewer</div>
    <button type="button" class="icon" data-el="menu-close" aria-label="Close menu">${ICON.close}</button>
  </header>

  <section>
    <h3>Scene</h3>
    <div class="scene-info" data-el="scene-info">No scene loaded</div>
    <button type="button" class="primary wide" data-el="upload">${ICON.upload} Upload scene…</button>
    <p class="hint">Or drop a file anywhere. It is read in this tab only.</p>
    <div class="scene-list" data-el="scene-list" role="list"></div>
    <button type="button" class="wide" data-el="copy-link">Copy link to this view</button>
  </section>

  <section>
    <h3>Coordinates</h3>
    <div class="sub">Up axis of the file</div>
    <div class="seg" data-el="up-presets">
      <button type="button" data-up="y-down" title="3DGS / COLMAP (default)">Y↓</button>
      <button type="button" data-up="y-up" title="glTF / three.js">Y↑</button>
      <button type="button" data-up="z-up" title="Blender / USD / CAD">Z↑</button>
      <button type="button" data-up="z-down" title="Some scanners">Z↓</button>
    </div>
    <div class="sub">Rotate (degrees)</div>
    ${axisRow('rx', 'X', -180, 180, 1)}
    ${axisRow('ry', 'Y', -180, 180, 1)}
    ${axisRow('rz', 'Z', -180, 180, 1)}
    <div class="seg small" data-el="rot-steps">
      <button type="button" data-step="rx:-90">X −90</button><button type="button" data-step="rx:90">X +90</button>
      <button type="button" data-step="ry:-90">Y −90</button><button type="button" data-step="ry:90">Y +90</button>
      <button type="button" data-step="rz:-90">Z −90</button><button type="button" data-step="rz:90">Z +90</button>
    </div>
    <div class="sub">Position and scale</div>
    <div class="grid3">
      <label>X<input type="number" step="0.01" value="0" data-xf-num="tx" /></label>
      <label>Y<input type="number" step="0.01" value="0" data-xf-num="ty" /></label>
      <label>Z<input type="number" step="0.01" value="0" data-xf-num="tz" /></label>
    </div>
    <label class="inline">Scale<input type="number" step="0.01" min="0.001" value="1" data-xf-num="s" /></label>
    <button type="button" class="wide" data-el="xf-reset">Reset coordinates</button>

    <div class="sub">Camera</div>
    <div class="grid3">
      <label>Yaw°<input type="number" step="1" data-cam="yaw" /></label>
      <label>Pitch°<input type="number" step="1" data-cam="pitch" /></label>
      <label>Roll°<input type="number" step="1" data-cam="roll" /></label>
      <label>Distance<input type="number" step="0.05" min="0.05" data-cam="dolly" /></label>
      <label>FOV°<input type="number" step="1" min="20" max="110" data-cam="fov" /></label>
      <span></span>
      <label>Target X<input type="number" step="0.01" data-cam="px" /></label>
      <label>Target Y<input type="number" step="0.01" data-cam="py" /></label>
      <label>Target Z<input type="number" step="0.01" data-cam="pz" /></label>
    </div>
    <button type="button" class="wide" data-el="cam-reset">Reset view</button>
  </section>

  <section>
    <h3>View</h3>
    <div class="buttons">
      <button type="button" data-el="fullscreen">Fullscreen</button>
      <button type="button" class="hidden" data-el="xr-vr">Enter VR</button>
      <button type="button" class="hidden" data-el="xr-ar">Enter AR</button>
      <a class="btn hidden" data-el="ar-quicklook" rel="ar" href="#">View in AR</a>
    </div>
    <label class="check"><input type="checkbox" data-el="show-stats" /> Show stats</label>
    <label class="check hidden" data-el="sound-row"><input type="checkbox" data-el="sound" /> Sound</label>
    <label class="inline">Quality
      <select data-el="quality">
        <option value="auto">Auto</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
      </select>
    </label>
  </section>

  <section>
    <h3>Export this moment</h3>
    <p class="hint">With the coordinates above applied.</p>
    <div class="buttons">
      <button type="button" data-el="ply" disabled>PLY</button>
      <button type="button" data-el="glb" disabled>GLB</button>
    </div>
  </section>

  <details class="section" data-el="publish-box">
    <summary>Publish to this site</summary>
    <p class="hint">For the site owner: commits the open scene to the site's GitHub repository so it gets its own link.
      Needs a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a>
      limited to this repository with <em>Contents: read and write</em>. The token is sent only to api.github.com.</p>
    <label>Token<input type="password" autocomplete="off" spellcheck="false" data-el="pub-token" placeholder="github_pat_…" /></label>
    <label class="check"><input type="checkbox" data-el="pub-remember" /> Remember on this device</label>
    <label>Link name<input type="text" spellcheck="false" data-el="pub-id" placeholder="my-scene" /></label>
    <label>Title<input type="text" data-el="pub-name" placeholder="My scene" /></label>
    <label class="check"><input type="checkbox" checked data-el="pub-xf" /> Save current coordinates</label>
    <label class="check"><input type="checkbox" checked data-el="pub-cam" /> Save current view as the opening view</label>
    <button type="button" class="primary wide" data-el="pub-go" disabled>Publish</button>
    <div class="pub-status" data-el="pub-status" aria-live="polite"></div>
  </details>

  <details class="section">
    <summary>Controls</summary>
    <p class="hint desk">Drag: orbit · Scroll: zoom · Ctrl/⌘ or middle drag: pan · Alt/⌥ drag: yaw &amp; roll ·
      Double-click or R: reset view · Space: play/pause · M: menu</p>
    <p class="hint touch">Drag: orbit · Pinch: zoom · Two-finger drag: pan · Double-tap: reset view</p>
  </details>
  <footer class="credit" data-el="credit"></footer>
</aside>
`;

export const STYLES = `
.tg4d {
  --tg-bg: #08090c; --tg-text: #f2f5f7; --tg-dim: #9aa4ae; --tg-faint: #6b7580;
  --tg-accent: #22d3ee; --tg-accent-2: #14b8a6; --tg-soft: rgba(34,211,238,0.15);
  --tg-glass: rgba(14,17,23,0.72); --tg-stroke: rgba(255,255,255,0.10); --tg-ease: cubic-bezier(0.22,1,0.36,1);
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
.tg4d canvas.tg4d-gpu, .tg4d canvas.tg4d-gl { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
.tg4d button, .tg4d .btn { font: inherit; color: var(--tg-text); background: rgba(255,255,255,0.07); border: 1px solid var(--tg-stroke);
  border-radius: 10px; padding: 7px 12px; cursor: pointer; text-decoration: none; touch-action: manipulation;
  transition: background 140ms var(--tg-ease), border-color 140ms var(--tg-ease); }
.tg4d button:hover:not(:disabled), .tg4d .btn:hover { background: rgba(255,255,255,0.13); border-color: rgba(255,255,255,0.22); }
.tg4d button:disabled { opacity: 0.4; cursor: default; }
.tg4d button.primary { background: linear-gradient(135deg, var(--tg-accent-2), #0e7490); border-color: rgba(34,211,238,0.5); color: #fff; font-weight: 600; }
.tg4d button.primary:hover:not(:disabled) { background: linear-gradient(135deg, #19c7b4, #0f84a3); }
.tg4d button svg { vertical-align: -4px; margin-right: 4px; }

/* corner controls: fade out when idle */
.tg4d .tg4d-burger { position: absolute; top: calc(12px + env(safe-area-inset-top, 0px)); left: calc(12px + env(safe-area-inset-left, 0px));
  z-index: 12; width: 44px; height: 44px; padding: 0; display: grid; place-items: center; border-radius: 12px;
  background: var(--tg-glass); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); }
.tg4d .tg4d-burger svg { margin: 0; }
.tg4d .tg4d-burger, .tg4d .tg4d-hud { transition: opacity 450ms var(--tg-ease); }
.tg4d.idle .tg4d-burger, .tg4d.idle .tg4d-hud { opacity: 0; pointer-events: none; }
.tg4d.idle { cursor: none; }

.tg4d .tg4d-hud { position: absolute; left: 50%; transform: translateX(-50%); z-index: 5;
  bottom: calc(14px + env(safe-area-inset-bottom, 0px)); width: min(560px, calc(100% - 24px));
  display: flex; gap: 10px; align-items: center; padding: 8px 12px; border-radius: 999px;
  background: var(--tg-glass); border: 1px solid var(--tg-stroke); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); }
.tg4d .tg4d-hud .round { width: 34px; height: 34px; padding: 0; border-radius: 50%; flex: none; }
.tg4d .tg4d-hud .time { font: 11px ui-monospace, 'SF Mono', Menlo, monospace; color: var(--tg-dim); min-width: 88px; text-align: right; }
.tg4d input[type=range] { flex: 1; min-width: 60px; appearance: none; -webkit-appearance: none; height: 4px; border-radius: 2px;
  background: rgba(255,255,255,0.16); outline: none; }
.tg4d input[type=range]::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
  border: none; background: var(--tg-accent); box-shadow: 0 0 10px rgba(34,211,238,0.55); cursor: pointer; }
.tg4d input[type=range]::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; border: none; background: var(--tg-accent); cursor: pointer; }

.tg4d .tg4d-stats { position: absolute; top: calc(12px + env(safe-area-inset-top, 0px)); right: 12px; z-index: 5; padding: 5px 10px;
  border-radius: 8px; background: rgba(8,9,12,0.6); border: 1px solid var(--tg-stroke);
  font: 10.5px ui-monospace, 'SF Mono', Menlo, monospace; color: var(--tg-dim); white-space: pre; pointer-events: none; }

.tg4d .tg4d-drop { position: absolute; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center; padding: 16px;
  text-align: center; background: radial-gradient(70% 55% at 50% 40%, rgba(34,211,238,0.09), transparent 70%), rgba(8,9,12,0.94); }
.tg4d .tg4d-card { max-width: 520px; }
.tg4d .tg4d-drop h2 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.02em; }
.tg4d .tg4d-drop p { color: var(--tg-dim); margin: 8px 0; }
.tg4d .tg4d-drop .primary { padding: 10px 18px; font-size: 14px; }
.tg4d .formats code { font: 11px ui-monospace, 'SF Mono', Menlo, monospace; color: #a5f3fc; background: var(--tg-soft); padding: 2px 6px; border-radius: 5px; }
.tg4d .tg4d-mark { width: 44px; height: 44px; margin: 0 auto 12px; border-radius: 50%;
  background: conic-gradient(from 210deg, #22d3ee, #14b8a6, #6366f1, #22d3ee);
  -webkit-mask: radial-gradient(circle, transparent 10px, #000 11px); mask: radial-gradient(circle, transparent 10px, #000 11px); }
.tg4d .tg4d-mark.small { width: 18px; height: 18px; margin: 0 8px 0 0; display: inline-block; vertical-align: -3px;
  -webkit-mask: radial-gradient(circle, transparent 4px, #000 5px); mask: radial-gradient(circle, transparent 4px, #000 5px); }
.tg4d .loading-box { display: none; flex-direction: column; align-items: center; gap: 12px; }
.tg4d .tg4d-drop.loading [data-el="drop-ui"] { display: none; }
.tg4d .tg4d-drop.loading .loading-box { display: flex; }
.tg4d .tg4d-drop.failed .loading-box { display: none; }
.tg4d .tg4d-drop.failed [data-el="drop-ui"] { display: block; }
.tg4d .loading-title { font-size: 15px; font-weight: 600; }
.tg4d .prog { width: 220px; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.1); overflow: hidden; }
.tg4d .prog > div { width: 0%; height: 100%; background: linear-gradient(90deg, var(--tg-accent-2), var(--tg-accent)); transition: width 200ms linear; }
.tg4d .prog-text { font: 11px ui-monospace, 'SF Mono', Menlo, monospace; color: var(--tg-dim); min-height: 16px; }
.tg4d .tg4d-spinner { width: 34px; height: 34px; border-radius: 50%; border: 2.5px solid rgba(34,211,238,0.2); border-top-color: var(--tg-accent);
  animation: tg4d-spin 800ms linear infinite; }
@keyframes tg4d-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .tg4d .tg4d-spinner { animation-duration: 2s; } }
.tg4d .err { color: #fca5a5; margin: 12px auto 0; user-select: text; -webkit-user-select: text; }
.tg4d .err:empty { display: none; }
.tg4d .tg4d-dropzone { position: absolute; inset: 0; z-index: 30; display: grid; place-items: center; pointer-events: none;
  background: rgba(8,9,12,0.7); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }
.tg4d .tg4d-dropzone span { padding: 18px 28px; border-radius: 16px; border: 2px dashed var(--tg-accent); font-size: 18px; font-weight: 600; }
.tg4d .tg4d-toast { position: absolute; left: 50%; bottom: calc(76px + env(safe-area-inset-bottom, 0px)); transform: translate(-50%, 8px); z-index: 25;
  padding: 8px 14px; border-radius: 999px; background: rgba(14,17,23,0.92); border: 1px solid var(--tg-stroke); font-size: 13px;
  opacity: 0; pointer-events: none; transition: opacity 250ms var(--tg-ease), transform 250ms var(--tg-ease); max-width: calc(100% - 24px); }
.tg4d .tg4d-toast.shown { opacity: 1; transform: translate(-50%, 0); }

/* drawer */
.tg4d .tg4d-scrim { position: absolute; inset: 0; z-index: 19; background: rgba(0,0,0,0.35); }
.tg4d .tg4d-menu { position: absolute; top: 0; bottom: 0; left: 0; z-index: 20; width: min(360px, 92vw); overflow-y: auto; overscroll-behavior: contain;
  padding: calc(12px + env(safe-area-inset-top, 0px)) 16px calc(20px + env(safe-area-inset-bottom, 0px)) calc(16px + env(safe-area-inset-left, 0px));
  background: rgba(12,14,19,0.94); border-right: 1px solid var(--tg-stroke); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  transform: translateX(-104%); transition: transform 260ms var(--tg-ease); touch-action: pan-y; -webkit-user-select: text; user-select: text; }
.tg4d.menu-open .tg4d-menu { transform: none; }
.tg4d .menu-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.tg4d .menu-head .brand { font-weight: 650; font-size: 15px; }
.tg4d .menu-head .icon { width: 36px; height: 36px; padding: 0; display: grid; place-items: center; }
.tg4d .menu-head .icon svg { margin: 0; }
.tg4d .tg4d-menu section, .tg4d .tg4d-menu details.section { border-top: 1px solid var(--tg-stroke); padding: 14px 0 12px; }
.tg4d .tg4d-menu h3 { margin: 0 0 10px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--tg-faint); font-weight: 650; }
.tg4d .tg4d-menu summary { cursor: pointer; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--tg-faint); font-weight: 650; }
.tg4d .tg4d-menu details[open] summary { margin-bottom: 10px; }
.tg4d .tg4d-menu .sub { color: var(--tg-dim); font-size: 12px; margin: 10px 0 6px; }
.tg4d .tg4d-menu .hint { color: var(--tg-faint); font-size: 12px; margin: 6px 0 10px; }
.tg4d .tg4d-menu .hint a { color: var(--tg-accent); }
.tg4d .tg4d-menu .wide { width: 100%; margin-top: 8px; }
.tg4d .tg4d-menu .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
.tg4d .scene-info { font-size: 13px; color: var(--tg-dim); margin-bottom: 10px; line-height: 1.55; }
.tg4d .scene-info strong { color: var(--tg-text); font-size: 14px; }
.tg4d .scene-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.tg4d .scene-list button { text-align: left; display: flex; flex-direction: column; gap: 1px; padding: 8px 10px; }
.tg4d .scene-list button .meta { color: var(--tg-faint); font-size: 11.5px; }
.tg4d .scene-list button.active { background: var(--tg-soft); border-color: rgba(34,211,238,0.5); }
.tg4d .seg { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.tg4d .seg.small { grid-template-columns: repeat(6, 1fr); margin-top: 6px; }
.tg4d .seg button { padding: 6px 0; }
.tg4d .seg.small button { font-size: 11px; padding: 5px 0; }
.tg4d .seg button.active { background: var(--tg-soft); border-color: rgba(34,211,238,0.5); }
.tg4d .row.axis { display: grid; grid-template-columns: 18px 1fr 64px; gap: 8px; align-items: center; margin: 4px 0; }
.tg4d .row.axis .lab { color: var(--tg-dim); }
.tg4d .tg4d-menu input[type=number], .tg4d .tg4d-menu input[type=text], .tg4d .tg4d-menu input[type=password], .tg4d .tg4d-menu select {
  width: 100%; font: inherit; color: var(--tg-text); background: rgba(255,255,255,0.05); border: 1px solid var(--tg-stroke);
  border-radius: 8px; padding: 5px 7px; -webkit-user-select: text; user-select: text; }
.tg4d .tg4d-menu label { display: block; color: var(--tg-dim); font-size: 12px; margin: 6px 0; }
.tg4d .tg4d-menu label input, .tg4d .tg4d-menu label select { margin-top: 3px; }
.tg4d .tg4d-menu label.inline { display: flex; align-items: center; gap: 8px; }
.tg4d .tg4d-menu label.inline input, .tg4d .tg4d-menu label.inline select { margin-top: 0; max-width: 140px; }
.tg4d .tg4d-menu label.check { display: flex; align-items: center; gap: 8px; color: var(--tg-text); font-size: 13px; }
.tg4d .tg4d-menu label.check input { width: auto; margin: 0; }
.tg4d .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0 8px; }
.tg4d .pub-status { font-size: 12.5px; color: var(--tg-dim); margin-top: 8px; word-break: break-word; }
.tg4d .pub-status .ok { color: #6ee7b7; }
.tg4d .pub-status .bad { color: #fca5a5; }
.tg4d .credit { color: var(--tg-faint); font-size: 11.5px; padding-top: 12px; border-top: 1px solid var(--tg-stroke); }
.tg4d .credit:empty { display: none; }
.tg4d .hint.touch { display: none; }
@media (pointer: coarse) { .tg4d .hint.desk { display: none; } .tg4d .hint.touch { display: block; } }
.tg4d.narrow .tg4d-hud .time { display: none; }
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
