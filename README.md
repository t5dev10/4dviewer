# 4D Viewer

A full-screen browser viewer for **4D Gaussian-splat scenes** — moving volumetric captures you can orbit and
scrub — and for the common static splat formats. Plain ES modules, no build step, no server: files are decoded in
the visitor's tab.

- `https://SITE/` opens the default scene full screen
- `https://SITE/<scene>` opens that scene (e.g. `/lumen`, `/lumen-stream`)
- `https://SITE/<scene>?t=2.5&cam=…&xf=…&fov=…` opens it at a moment, view and placement (the menu's
  *Copy link to this view* writes these)

The screen shows only the scene and, for 4D scenes, a slim playback bar; both fade after a few idle seconds.
Everything else is in the **≡ menu**:

- **Scene** — what is open, **Upload scene…** (or drop a file anywhere; it is read in the tab only), the site's
  scene list, *Copy link to this view*
- **Coordinates** — the file's up axis (Y↓ 3DGS/COLMAP, Y↑ glTF/three.js, Z↑ Blender/USD, Z↓), rotation per axis
  with ±90° steps, position and scale; the camera as numbers (yaw, pitch, roll, distance, field of view, target)
- **View** — fullscreen, VR / AR where the device supports them, stats overlay, sound, quality
- **Export this moment** — PLY or GLB with the coordinates applied
- **Publish to this site** — for the owner: commits the open scene to this repository so it gets its own link
- **Controls** — keyboard and touch help

## Formats

- **4D** — `.nx4d` (one gzip container) and `.nxs4` (streamed over HTTP byte ranges: a coarse layer paints
  first, full-detail chunks arrive by time and view, optional audio slaved to the scene clock). Each splat moves
  along its velocity, fades through a temporal Gaussian gate and is coloured by spherical harmonics × a Fourier
  series in time, all evaluated in the shader at one clock value.
- **Static** — reference 3DGS `.ply` (SH ≤ 3) and PlayCanvas compressed `.ply`, Niantic `.spz` v1–v4, PlayCanvas
  `.sog` v1/v2, glTF/GLB `KHR_gaussian_splatting`, `.splat`, `.ksplat`, ASCII OpenUSD `.usda` / `.usdz`.
  View-dependent colour is rendered for every format that carries it.

Rendering is WebGL2 everywhere (instanced quads, worker depth sort) and WebGPU compute sort + draw with `?gpu=1`.
Render resolution adapts to the frame rate; unchanged frames are not redrawn. Every container is parsed with
bounds-checked counts and decompression caps, and a file that cannot open gets a sentence saying why.

It reads the same `.nx4d` / `.nxs4` containers as the VoxaVerse Vortex viewer.

## Adding scenes to the site

**From the browser (owner):** open the file with *Upload scene…*, set the coordinates and the view you want people
to start from, then *Publish to this site*. It needs a
[fine-grained token](https://github.com/settings/personal-access-tokens/new) for this repository only, with
*Contents: read and write*; the token is sent only to `api.github.com`. One commit adds the file, its entry in
`viewer/assets/scenes.json` and its page at `/<id>/`; GitHub Pages serves it about a minute later. The browser
route handles files up to 70 MB.

**With git:** copy the file into `viewer/assets/scenes/`, add an entry to `viewer/assets/scenes.json`, run
`node tools/build_pages.mjs`, commit and push. GitHub refuses files over 100 MB.

```json
{
  "id": "my-scene", "name": "My scene", "file": "my-scene.nx4d", "format": "nx4d",
  "transform": { "rotate": [90, 0, 0], "translate": [0, 0, 0], "scale": 1 },
  "cam": { "yaw": 0.3, "pitch": -0.2, "roll": 0, "dolly": 2.5, "pan": [0, 0, 0], "fov": 60 }
}
```

How `/<scene>` works on a static host: `index.html` is the app; `404.html` is a copy of it (GitHub Pages serves
that for unknown paths, so any name reaches the app with a 404 status); `<id>/index.html` gives listed scenes a
real page (status 200, link previews). `tools/build_pages.mjs` regenerates both.

## Run it locally

```bash
node tools/serve.mjs                                 # http://127.0.0.1:8790/
node tools/serve.mjs --mount /local=/path/to/scenes  # then /?scene=/local/my-scene.nx4d
```

The dev server answers byte ranges (for `.nxs4`) and falls back to `404.html` like GitHub Pages.

## Query parameters

| Parameter | Meaning |
|---|---|
| `scene` / `src` | Scene id or URL (the path form `/<scene>` is preferred) |
| `format` | Force a format when the URL has no telling extension |
| `t`, `cam` | Time in seconds; camera `yaw.pitch.roll.dolly.panX.panY.panZ` (fixed point, base 36) |
| `xf` | Scene placement `rx,ry,rz,tx,ty,tz,scale` (degrees, scene units) |
| `fov` | Vertical field of view in degrees (default 60) |
| `yaw`, `pitch`, `roll`, `dolly` | Opening camera (radians; dolly in scene radii) |
| `up=z` | Source is Z-up (converted at load, SH included) |
| `stats=1` | Show the stats overlay |
| `gpu=1` | Use WebGPU where an adapter exists |
| `sh=0…3` | Cap the spherical-harmonics degree drawn |
| `muted=0` | Start scene audio unmuted (it starts muted) |
| `xr=0` | Never offer VR/AR |
| `perf=full` | Do not drop to the software-rasteriser performance mode |
| `pool=N` | Streaming pool capacity in splats |

Keys: Space play/pause · R reset view · M menu · Esc close menu.

## Embedding

```html
<iframe src="https://SITE/my-scene" allow="xr-spatial-tracking; fullscreen"
        style="width:100%;aspect-ratio:16/9;border:0"></iframe>
```

```js
import { mountViewer } from './viewer/js/index.js';
const viewer = mountViewer(el, { scene: 'lumen', onEvent(type, data) {} });
viewer.play(); viewer.pause(); viewer.seek(1.5);
viewer.setTransform({ rx: 90 }); viewer.setCam({ yaw: 0.5, fov: 70 });
await viewer.load(url, 'nx4d');  // resolves true when the scene is on screen
viewer.getShareUrl(); viewer.exportPLY(); viewer.openMenu(); viewer.destroy();
```

## The 4D containers

**`.nx4d`** — `gzip( u32 magic 0x3464584E | u32 header_len | JSON {format:"nx4d-v1", count, duration, sh_l, sh_f,
view?, credit?} | f32 geo[count][16] | f16 sht[count][sh_f][(sh_l+1)²][3] )`

`geo` per splat: `μx μy μz μt | vx vy vz τ | Σxx Σxy Σxz Σyy | Σyz Σzz opacity flags`, in the reference 3DGS frame
(x right, y down, z forward). Position `p(t) = μ + v·(t − μt)`; opacity `α(t) = opacity · exp(−(t − μt)² τ)`;
colour `c(t, d) = 0.5 + Σₙ Σ_b cos(2π n (t − μt) / T) · Y_b(d) · c_nb`; a splat with `sqrt(0.5/τ) > 0.6·T` is static
(gate ≡ 1, orders n ≥ 1 skipped); playback loops `t ∈ [0, T)`.

**`.nxs4`** — the same model, chunked, with a CRC-32C superblock, 64-byte chunk records (byte range, splat count,
AABB, alive interval, LOD layer, SH depth, CRC), gzip chunk payloads `u32 ids | f32 geo | f16 sht`, and an
optional audio index at the end. `tools/nx4d_to_nxs4.py` documents and writes it.

## Tools

| Script | Purpose |
|---|---|
| `tools/serve.mjs` | Dev server with byte ranges, extra mounts and the 404 fallback |
| `tools/build_pages.mjs` | Regenerate `404.html` and the per-scene pages from `scenes.json` |
| `tools/nx4d_to_nxs4.py` | Pack `.nx4d` into the streamable `.nxs4` profile (optional `--audio`) |
| `tools/make_demo_scene.py` | Regenerate the procedural demo scene (and its soundtrack) |

The Python tools need `numpy`.

## Third-party code

`viewer/js/vendor/fzstd.js` — [fzstd](https://github.com/101arrowz/fzstd) 0.1.1 by Arjun Barrett, MIT licence
(header kept in the file), used for SPZ v4 streams.
