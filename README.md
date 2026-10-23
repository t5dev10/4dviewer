# 4D Viewer

A browser viewer for **4D Gaussian-splat scenes** — moving volumetric captures you can orbit and scrub — and for
the common static splat formats. Plain ES modules, no build step, no server: files are decoded in the visitor's
tab and never uploaded.

- Landing page with a live embed: `index.html`
- Full-screen app: `viewer/index.html` (`viewer/?scene=…`)

## What it does

- **4D scenes** — `.nx4d` (one gzip container) and `.nxs4` (streamable over HTTP byte ranges: a coarse layer
  paints first, full-detail chunks arrive by time and view, optional audio). Each splat moves along its velocity,
  fades in and out through a temporal Gaussian gate, and is coloured by spherical harmonics × a Fourier series in
  time; the whole model is evaluated in the shader at one clock value.
- **Static splats** — reference 3DGS `.ply` (SH ≤ 3) and PlayCanvas compressed `.ply`, Niantic `.spz` v1–v4,
  PlayCanvas `.sog` v1/v2 (bundled or `meta.json`), glTF/GLB `KHR_gaussian_splatting`, `.splat`, `.ksplat`
  (levels 0–2), ASCII OpenUSD `.usda` / `.usdz`. View-dependent colour is rendered for every format that carries it.
- **Export** — the current moment of a 4D scene (or a static scene) as reference-3DGS PLY or GLB.
- **Rendering** — WebGL2 everywhere (instanced quads, worker-sorted back to front); WebGPU compute sort + draw with
  `?gpu=1`. Adaptive render resolution, unchanged frames are not redrawn, the landing embed pauses off screen.
- **WebXR** — Enter VR / Enter AR where the device supports it: teleport on the floor (VR), place on a surface (AR),
  two-hand pinch to scale, thumbsticks to turn and scale.
- **Links** — every view can be shared: `viewer/?scene=…&t=2.500&cam=…` (help panel → *Copy link to this view*).
- **Safety** — every container is parsed with bounds-checked counts, decompression ratio caps and allocation
  ceilings; a file that cannot open gets a sentence saying why.

It reads the same `.nx4d` / `.nxs4` containers as the VoxaVerse Vortex viewer.

## Run it locally

```bash
node tools/serve.mjs                 # http://127.0.0.1:8790/
node tools/serve.mjs --mount /local=/path/to/scenes
# then open http://127.0.0.1:8790/viewer/?scene=/local/my-scene.nx4d
```

Any static server works for `.nx4d` and the static formats; `.nxs4` streaming needs one that answers byte-range
requests with `206` (the bundled server and GitHub Pages do; otherwise the viewer falls back to a full download).

## URL parameters (`viewer/`)

| Parameter | Meaning |
|---|---|
| `scene` / `src` | Scene id from `viewer/assets/scenes.json`, or a URL |
| `format` | Force a format when the URL has no telling extension |
| `t`, `cam` | Deep link: time in seconds, camera (`yaw.pitch.roll.dolly.panX.panY.panZ`, base 36) |
| `yaw`, `pitch`, `roll`, `dolly` | Initial camera (radians; dolly in scene radii) |
| `up=z` | Source is Z-up (rotated into the viewer frame, SH included) |
| `ui=min` | Minimal chrome for embeds |
| `gpu=1` | Use WebGPU where an adapter exists |
| `sh=0…3` | Cap the spherical-harmonics degree drawn |
| `muted=0` | Start scene audio unmuted (it starts muted by default) |
| `xr=0` | Never offer VR/AR |
| `perf=full` | Do not drop to the software-rasteriser performance mode |
| `pool=N` | Streaming pool capacity in splats |
| `usdz=URL` | Offer an AR Quick Look link to a USDZ sibling |

## Embed

```html
<iframe src="https://YOUR-SITE/viewer/?scene=https://…/scene.nx4d&ui=min"
        allow="xr-spatial-tracking; fullscreen" style="width:100%;aspect-ratio:16/9;border:0"></iframe>
```

```js
import { mountViewer } from './viewer/js/index.js';

const viewer = mountViewer(document.querySelector('#stage'), {
  scene: 'lumen',                 // id from scenes.json, or a URL
  onEvent(type, data) {},         // ready, loaded, playstate, progress, warning, error, audio, xrstart, xrend …
});
viewer.play(); viewer.pause(); viewer.seek(1.5);
await viewer.load(url, 'nx4d');   // resolves true when the scene is on screen
const verdict = await viewer.validateFile(file);
viewer.getShareUrl(); viewer.exportPLY(); viewer.exportGLB(); viewer.setQualityTier('medium');
viewer.destroy();
```

The scene list for the chips lives in `viewer/assets/scenes.json` (`base` may point at a CDN; the host must send
CORS headers, and byte ranges for `.nxs4`).

## The 4D containers

**`.nx4d`** — `gzip( u32 magic 0x3464584E | u32 header_len | JSON {format:"nx4d-v1", count, duration, sh_l, sh_f,
view?, credit?} | f32 geo[count][16] | f16 sht[count][sh_f][(sh_l+1)²][3] )`

`geo` per splat: `μx μy μz μt | vx vy vz τ | Σxx Σxy Σxz Σyy | Σyz Σzz opacity flags`, in the reference 3DGS frame
(x right, y down, z forward).

- position `p(t) = μ + v·(t − μt)`, opacity `α(t) = opacity · exp(−(t − μt)² τ)`
- colour `c(t, d) = 0.5 + Σₙ Σ_b cos(2π n (t − μt) / T) · Y_b(d) · c_nb`
- a splat with `sqrt(0.5/τ) > 0.6·T` is static: gate ≡ 1 and orders n ≥ 1 are skipped
- playback loops `t ∈ [0, T)`

**`.nxs4`** — the same model, chunked: plain header + CRC-32C superblock, a 64-byte record per chunk (byte range,
splat count, AABB, alive interval, LOD layer, SH depth, CRC), gzip chunk payloads
`u32 ids | f32 geo | f16 sht`, and an optional audio index at the end. Layer 0 is a coarse preview; layer 1 covers
every splat exactly once. `tools/nx4d_to_nxs4.py` documents and writes it.

## Tools

| Script | Purpose |
|---|---|
| `tools/serve.mjs` | Static dev server with byte ranges and extra mounts |
| `tools/nx4d_to_nxs4.py` | Pack `.nx4d` into the streamable `.nxs4` profile (optional `--audio`) |
| `tools/make_demo_scene.py` | Regenerate the procedural demo scene (and its soundtrack) |

The Python tools need `numpy`.

## Deploying

The site is static: publish the repository root. On GitHub Pages it works under a project path
(`https://USER.github.io/4dviewer/`) because every URL is relative. For a custom domain such as
`4dviewer.example.com`, add a `CNAME` DNS record pointing at `USER.github.io` and set the domain in the
repository's Pages settings.

## Third-party code

`viewer/js/vendor/fzstd.js` — [fzstd](https://github.com/101arrowz/fzstd) 0.1.1 by Arjun Barrett, MIT licence
(header kept in the file), used for SPZ v4 streams.
