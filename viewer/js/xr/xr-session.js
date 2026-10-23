// Immersive VR / AR. The scene is stood upright in the XR space (its native
// frame is y-down, z-forward), each eye's view is converted to the renderer's
// x-right / y-down / z-forward convention, and the eye projections — which
// can be off-axis — become per-view intrinsics.
//
// VR: select on the floor teleports. AR: select places the scene on the hit
// surface. Both: two-hand pinch scales, thumbsticks turn and scale.

import { multiplyRowMajor, transposeToColumnMajor } from '../core/camera.js';

const FLIP_YZ = Float32Array.from([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);

function percentile(values, q) {
  const s = Float32Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))] ?? 0;
}

// Scene extents along its own axes, sampled.
function sceneExtent(scene) {
  const n = scene.count;
  const stride = Math.max(1, Math.floor(n / 50000));
  const xs = [], ys = [], zs = [];
  const P = scene.kind === 'temporal' ? scene.geo : scene.positions;
  const w = scene.kind === 'temporal' ? 16 : 3;
  for (let i = 0; i < n; i += stride) {
    xs.push(P[i * w]);
    ys.push(P[i * w + 1]);
    zs.push(P[i * w + 2]);
  }
  return {
    centre: [percentile(xs, 0.5), percentile(ys, 0.5), percentile(zs, 0.5)],
    bottom: percentile(ys, 0.98), // +y is down in the scene frame
    top: percentile(ys, 0.02),
  };
}

function rayFloor(origin, dir, floorY = 0, maxDist = 30) {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(len > 1e-9)) return null;
  const dy = dir[1] / len;
  if (Math.abs(dy) < 1e-4) return null;
  const t = (floorY - origin[1]) / dy;
  if (t <= 0 || t > maxDist) return null;
  return [origin[0] + (dir[0] / len) * t, floorY, origin[2] + (dir[2] / len) * t];
}

export class XRPlayer {
  constructor(renderer, scene, clock) {
    this.renderer = renderer;
    this.scene = scene;
    this.clock = clock;
    this.session = null;
    this.refSpace = null;
    this.baseRefSpace = null;
    this.mode = null;
    this.yaw = 0;
    this.scale = 1;
    this.anchor = [0, 0, -1.5];
    this.pinch = null;
    this.sortInFlight = false;
    this.lastTime = 0;
    const ext = sceneExtent(scene);
    this.extent = ext;
    // Unknown units: assume metres unless the scene is implausibly small or big.
    const height = Math.abs(ext.bottom - ext.top) || 1;
    this.baseScale = height > 6 || height < 0.15 ? 1.7 / height : 1;
  }

  static async isSupported(mode) {
    if (typeof navigator === 'undefined' || !navigator.xr) return false;
    try {
      return await navigator.xr.isSessionSupported(mode);
    } catch {
      return false;
    }
  }

  // Scene -> XR world, row-major: translate(anchor) · rotY(yaw) · scale · flip(y, z) · translate(-feet).
  modelMatrix() {
    const s = this.baseScale * this.scale;
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    const { centre, bottom } = this.extent;
    // flip(y,z) then rotY, applied to (p - feet), feet = scene point that lands on the floor.
    const feet = [centre[0], bottom, centre[2]];
    const R = [c, 0, sn, 0, 1, 0, -sn, 0, c]; // rotY
    const F = [1, 0, 0, 0, -1, 0, 0, 0, -1];
    const RF = [
      R[0] * F[0], R[1] * F[4], R[2] * F[8],
      R[3] * F[0], R[4] * F[4], R[5] * F[8],
      R[6] * F[0], R[7] * F[4], R[8] * F[8],
    ];
    const m = new Float32Array(16);
    for (let r = 0; r < 3; ++r) {
      for (let k = 0; k < 3; ++k) m[r * 4 + k] = RF[r * 3 + k] * s;
      m[r * 4 + 3] = this.anchor[r] - s * (RF[r * 3] * feet[0] + RF[r * 3 + 1] * feet[1] + RF[r * 3 + 2] * feet[2]);
    }
    m[15] = 1;
    return m;
  }

  sceneFromWorld(p, m) {
    // Inverse of a scaled rotation + translation.
    const s2 = m[0] * m[0] + m[4] * m[4] + m[8] * m[8];
    const d = [p[0] - m[3], p[1] - m[7], p[2] - m[11]];
    return [
      (m[0] * d[0] + m[4] * d[1] + m[8] * d[2]) / s2,
      (m[1] * d[0] + m[5] * d[1] + m[9] * d[2]) / s2,
      (m[2] * d[0] + m[6] * d[1] + m[10] * d[2]) / s2,
    ];
  }

  async start(mode, { onEnd } = {}) {
    if (!(await XRPlayer.isSupported(mode))) throw new Error(`${mode} is not supported on this device or browser`);
    const features = ['local-floor', 'bounded-floor', 'hand-tracking'];
    if (mode === 'immersive-ar') features.push('hit-test');
    const session = await navigator.xr.requestSession(mode, { optionalFeatures: features });
    this.session = session;
    this.mode = mode;
    this.onEnd = onEnd;
    await this.renderer.makeXRCompatible();
    const gl = this.renderer.gl;
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl, { antialias: false, alpha: mode === 'immersive-ar' }) });
    try {
      this.refSpace = await session.requestReferenceSpace('local-floor');
    } catch {
      this.refSpace = await session.requestReferenceSpace('local');
      this.anchor = [0, -1.4, -1.5];
    }
    this.baseRefSpace = this.refSpace;
    if (mode === 'immersive-ar' && typeof session.requestHitTestSource === 'function') {
      try {
        const viewer = await session.requestReferenceSpace('viewer');
        this.hitTestSource = await session.requestHitTestSource({ space: viewer });
      } catch {
        this.hitTestSource = null;
      }
    }
    this.startSort();
    session.addEventListener('select', this.onSelect);
    session.addEventListener('end', () => {
      this.sortWorker?.terminate();
      this.sortWorker = null;
      this.session = null;
      this.onEnd?.();
    });
    session.requestAnimationFrame(this.onFrame);
    return session;
  }

  end() {
    return this.session?.end();
  }

  startSort() {
    const scene = this.scene;
    const temporal = scene.kind === 'temporal';
    const w = temporal
      ? new Worker(new URL('../render/sort-worker-temporal.js', import.meta.url), { type: 'module' })
      : new Worker(new URL('../render/sort-worker-static.js', import.meta.url), { type: 'module' });
    if (temporal) {
      const geo = scene.geo.slice();
      w.postMessage({ geo, count: scene.count, duration: scene.duration }, [geo.buffer]);
    } else {
      const positions = scene.positions.slice();
      w.postMessage({ positions, count: scene.count }, [positions.buffer]);
    }
    w.onmessage = (e) => {
      this.sortInFlight = false;
      this.renderer.updateOrder(e.data.indices);
    };
    this.sortWorker = w;
  }

  onSelect = (e) => {
    if (!this.session || !this.frame) return;
    const pose = e.inputSource?.targetRaySpace ? this.frame.getPose(e.inputSource.targetRaySpace, this.refSpace) : null;
    if (!pose) return;
    const m = pose.transform.matrix;
    const origin = [m[12], m[13], m[14]];
    const dir = [-m[8], -m[9], -m[10]];
    if (this.mode === 'immersive-ar') {
      let hit = null;
      const results = this.hitTestSource ? this.frame.getHitTestResults(this.hitTestSource) : [];
      const hp = results?.[0]?.getPose(this.refSpace);
      if (hp) hit = [hp.transform.position.x, hp.transform.position.y, hp.transform.position.z];
      if (!hit) {
        const l = Math.hypot(...dir) || 1;
        hit = origin.map((o, i) => o + (dir[i] / l) * 1.5);
      }
      this.anchor = hit;
      return;
    }
    const target = rayFloor(origin, dir, 0);
    if (!target || !this.baseRefSpace.getOffsetReferenceSpace) return;
    // Teleport: move the reference space so the user stands at the target.
    const cur = this.offset ?? [0, 0, 0];
    const next = [cur[0] + target[0], 0, cur[2] + target[2]];
    this.offset = next;
    this.refSpace = this.baseRefSpace.getOffsetReferenceSpace(new XRRigidTransform({ x: next[0], y: 0, z: next[2] }));
  };

  handleInput(frame, dt) {
    const pinching = [];
    for (const src of this.session.inputSources) {
      const axes = src.gamepad?.axes;
      if (axes && axes.length >= 4) {
        const x = Math.abs(axes[2]) > 0.2 ? axes[2] : 0;
        const y = Math.abs(axes[3]) > 0.2 ? axes[3] : 0;
        if (src.handedness === 'right') this.yaw -= x * dt * 1.5;
        else this.scale = Math.max(0.05, Math.min(20, this.scale * (1 - y * dt)));
      }
      if (src.hand && frame.getJointPose) {
        const thumb = src.hand.get?.('thumb-tip'), index = src.hand.get?.('index-finger-tip');
        const a = thumb && frame.getJointPose(thumb, this.refSpace);
        const b = index && frame.getJointPose(index, this.refSpace);
        if (a && b) {
          const pa = a.transform.position, pb = b.transform.position;
          if (Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z) <= 0.03) pinching.push([pb.x, pb.y, pb.z]);
        }
      }
    }
    if (pinching.length === 2) {
      const d = Math.hypot(pinching[0][0] - pinching[1][0], pinching[0][1] - pinching[1][1], pinching[0][2] - pinching[1][2]);
      if (!this.pinch) this.pinch = { start: d, scale: this.scale };
      else if (this.pinch.start > 1e-4) this.scale = Math.max(0.05, Math.min(20, this.pinch.scale * (d / this.pinch.start)));
    } else {
      this.pinch = null;
    }
  }

  onFrame = (now, frame) => {
    const session = frame.session;
    session.requestAnimationFrame(this.onFrame);
    this.frame = frame;
    const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 0;
    this.lastTime = now;
    const scene = this.scene;
    if (scene.kind === 'temporal' && this.clock.isPlaying()) {
      this.clock.setTime((this.clock.getTime() + dt) % scene.duration);
    }
    this.renderer.time = this.clock.getTime();
    this.renderer.grow = 1;
    this.handleInput(frame, dt);
    const pose = frame.getViewerPose(this.refSpace);
    if (!pose) return;
    const layer = session.renderState.baseLayer;
    if (this.mode === 'immersive-ar') this.renderer.clear(0, 0, 0, 0, layer.framebuffer);
    else this.renderer.clear(0.03, 0.035, 0.045, 1, layer.framebuffer);
    const model = this.modelMatrix();
    const views = pose.views.map((v) => {
      const glView = transposeToColumnMajor(v.transform.inverse.matrix); // column-major -> row-major
      const rdf = multiplyRowMajor(FLIP_YZ, glView);
      return { v, m: multiplyRowMajor(rdf, model) };
    });
    if (views[0] && !this.sortInFlight && this.sortWorker) {
      this.sortInFlight = true;
      this.sortWorker.postMessage({ view: Array.from(views[0].m), t: this.renderer.time, gen: 0 });
    }
    for (const { v, m } of views) {
      const vp = layer.getViewport(v);
      const P = v.projectionMatrix;
      const intr = {
        fx: (P[0] * vp.width) / 2,
        fy: (P[5] * vp.height) / 2,
        cx: (vp.width / 2) * (1 - P[8]),
        cy: (vp.height / 2) * (1 + P[9]),
      };
      const p = v.transform.position;
      const cam = this.sceneFromWorld([p.x, p.y, p.z], model);
      this.renderer.render(m, intr, { x: vp.x, y: vp.y, width: vp.width, height: vp.height }, cam, layer.framebuffer);
    }
  };
}
