// WebGPU path (opt-in with ?gpu=1): splats live in storage buffers, sort keys
// are generated and bitonic-sorted in compute passes, and one instanced quad
// per splat is drawn in sorted order. Same model and maths as the WebGL2 path.

import { floatToHalfFast } from '../core/half.js';
import { SH_C0 } from '../core/scene.js';

const SORT_WGSL = /* wgsl */`
struct SortU {
  row2: vec4f,       // world -> view z row
  t: f32,
  duration: f32,
  count: u32,
  padded: u32,
  motion: u32,
  pad0: u32, pad1: u32, pad2: u32,
};
@group(0) @binding(0) var<uniform> su: SortU;
@group(0) @binding(1) var<storage, read> geo: array<f32>;
@group(0) @binding(2) var<storage, read_write> keys: array<u32>;
@group(0) @binding(3) var<storage, read_write> vals: array<u32>;

const CULLED: u32 = 0xFFFFFFFFu;

@compute @workgroup_size(256)
fn keygen(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * 256u;
  if (i >= su.padded) { return; }
  vals[i] = i;
  if (i >= su.count) { keys[i] = CULLED; return; }
  let g = i * 16u;
  var p = vec3f(geo[g], geo[g + 1u], geo[g + 2u]);
  var alpha = geo[g + 14u];
  if (su.motion == 1u) {
    let dt = su.t - geo[g + 3u];
    let tau = geo[g + 7u];
    let still = tau > 0.0 && sqrt(0.5 / tau) > 0.6 * su.duration;
    alpha = alpha * select(exp(-dt * dt * tau), 1.0, still);
    p = p + vec3f(geo[g + 4u], geo[g + 5u], geo[g + 6u]) * dt;
  }
  let z = dot(su.row2, vec4f(p, 1.0));
  if (z < 0.05 || alpha < 0.0016) { keys[i] = CULLED; return; }
  // Positive float bits are order-preserving; invert for back-to-front.
  keys[i] = 0xFFFFFFFEu - bitcast<u32>(z);
}

struct StepU { k: u32, j: u32 };
@group(0) @binding(0) var<uniform> step: StepU;
@group(0) @binding(1) var<storage, read_write> skeys: array<u32>;
@group(0) @binding(2) var<storage, read_write> svals: array<u32>;

@compute @workgroup_size(256)
fn bitonic(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * 256u;
  let l = i ^ step.j;
  if (l <= i || l >= arrayLength(&skeys)) { return; }
  let ascending = (i & step.k) == 0u;
  let a = skeys[i];
  let b = skeys[l];
  if ((a > b) == ascending) {
    skeys[i] = b;
    skeys[l] = a;
    let v = svals[i];
    svals[i] = svals[l];
    svals[l] = v;
  }
}
`;

const DRAW_WGSL = /* wgsl */`
struct U {
  view: mat4x4f,
  focal: vec2f,
  principal: vec2f,
  viewport: vec2f,
  maxR: f32,
  grow: f32,
  camPos: vec3f,
  t: f32,
  revealOrigin: vec3f,
  revealInvRadius: f32,
  revealWidth: f32,
  duration: f32,
  shF: u32,
  shB: u32,
  motion: u32,
  count: u32,
  pad0: u32,
  pad1: u32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> geo: array<f32>;
@group(0) @binding(2) var<storage, read> sht: array<u32>;
@group(0) @binding(3) var<storage, read> order: array<u32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) rgba: vec4f,
};

const SH_C0: f32 = 0.28209479177387814;
const SH_C1: f32 = 0.4886025119029199;
const TWO_PI: f32 = 6.283185307179586;

fn coef(h: u32) -> f32 {
  let v = unpack2x16float(sht[h >> 1u]);
  return select(v.x, v.y, (h & 1u) == 1u);
}

fn revealFactor(p: vec3f) -> f32 {
  if (u.revealWidth <= 0.0) { return u.grow; }
  let phase = clamp(length(p - u.revealOrigin) * u.revealInvRadius, 0.0, 1.0);
  let front = u.grow * (1.0 + 2.0 * u.revealWidth) - u.revealWidth;
  return smoothstep(phase - u.revealWidth, phase + u.revealWidth, front);
}

fn culled() -> VOut {
  var o: VOut;
  o.pos = vec4f(0.0, 0.0, 2.0, 1.0);
  o.local = vec2f(0.0);
  o.rgba = vec4f(0.0);
  return o;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let idx = order[ii];
  if (idx >= u.count) { return culled(); }
  let g = idx * 16u;
  var p = vec3f(geo[g], geo[g + 1u], geo[g + 2u]);
  var dt = 0.0;
  var gate = 1.0;
  var still = true;
  if (u.motion == 1u) {
    dt = u.t - geo[g + 3u];
    let tau = geo[g + 7u];
    still = tau > 0.0 && sqrt(0.5 / tau) > 0.6 * u.duration;
    gate = select(exp(-dt * dt * tau), 1.0, still);
    p = p + vec3f(geo[g + 4u], geo[g + 5u], geo[g + 6u]) * dt;
  }
  let reveal = revealFactor(p);
  var alpha = geo[g + 14u] * gate * reveal;
  alpha = alpha * smoothstep(0.0020, 0.0060, alpha);
  if (alpha < 0.0016) { return culled(); }
  let v = (u.view * vec4f(p, 1.0)).xyz;
  if (v.z < 0.05) { return culled(); }

  let W = mat3x3f(u.view[0].xyz, u.view[1].xyz, u.view[2].xyz);
  let S = mat3x3f(
    vec3f(geo[g + 8u], geo[g + 9u], geo[g + 10u]),
    vec3f(geo[g + 9u], geo[g + 11u], geo[g + 12u]),
    vec3f(geo[g + 10u], geo[g + 12u], geo[g + 13u]));
  let VS = W * S * transpose(W);
  let iz = 1.0 / v.z;
  let j00 = u.focal.x * iz;
  let j02 = -u.focal.x * v.x * iz * iz;
  let j11 = u.focal.y * iz;
  let j12 = -u.focal.y * v.y * iz * iz;
  let u0 = j00 * VS[0][0] + j02 * VS[2][0];
  let u1 = j00 * VS[0][1] + j02 * VS[2][1];
  let u2 = j00 * VS[0][2] + j02 * VS[2][2];
  let a0 = u0 * j00 + u2 * j02;
  let b = u1 * j11 + u2 * j12;
  let c0 = j11 * (j11 * VS[1][1] + j12 * VS[2][1]) + j12 * (j11 * VS[1][2] + j12 * VS[2][2]);
  let a = a0 + 0.3;
  let c = c0 + 0.3;
  alpha = alpha * sqrt(max((a0 * c0 - b * b) / max(a * c - b * b, 1e-12), 2.5e-5));
  let mid = 0.5 * (a + c);
  let disc = sqrt(max(mid * mid - (a * c - b * b), 1e-9));
  let l1 = mid + disc;
  let l2 = max(mid - disc, 1e-9);
  var e1 = normalize(vec2f(b, l1 - a));
  if (abs(b) < 1e-9) { e1 = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), a >= c); }
  let e2 = vec2f(-e1.y, e1.x);
  let r1 = min(3.0 * sqrt(l1) * reveal, u.maxR);
  let r2 = min(3.0 * sqrt(l2) * reveal, u.maxR);
  let corner = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
  let centre = vec2f(u.focal.x * v.x * iz, u.focal.y * v.y * iz) + u.principal;
  let px = centre + corner.x * r1 * e1 + corner.y * r2 * e2;

  let d = normalize(p - u.camPos);
  var Y: array<f32, 16>;
  Y[0] = SH_C0;
  if (u.shB > 1u) {
    Y[1] = -SH_C1 * d.y;
    Y[2] = SH_C1 * d.z;
    Y[3] = -SH_C1 * d.x;
  }
  if (u.shB > 4u) {
    let xx = d.x * d.x; let yy = d.y * d.y; let zz = d.z * d.z;
    let xy = d.x * d.y; let yz = d.y * d.z; let xz = d.x * d.z;
    Y[4] = 1.0925484305920792 * xy;
    Y[5] = -1.0925484305920792 * yz;
    Y[6] = 0.31539156525252005 * (2.0 * zz - xx - yy);
    Y[7] = -1.0925484305920792 * xz;
    Y[8] = 0.5462742152960396 * (xx - yy);
    if (u.shB > 9u) {
      Y[9] = -0.5900435899266435 * d.y * (3.0 * xx - yy);
      Y[10] = 2.890611442640554 * xy * d.z;
      Y[11] = -0.4570457994644658 * d.y * (4.0 * zz - xx - yy);
      Y[12] = 0.3731763325901154 * d.z * (2.0 * zz - 3.0 * xx - 3.0 * yy);
      Y[13] = -0.4570457994644658 * d.x * (4.0 * zz - xx - yy);
      Y[14] = 1.445305721320277 * d.z * (xx - yy);
      Y[15] = -0.5900435899266435 * d.x * (xx - 3.0 * yy);
    }
  }
  var rgb = vec3f(0.0);
  let base = idx * u.shF * u.shB * 3u;
  for (var n = 0u; n < u.shF; n++) {
    if (still && n > 0u) { break; }
    var phi = 1.0;
    if (n > 0u) { phi = cos(TWO_PI * f32(n) * dt / u.duration); }
    let nb = base + n * u.shB * 3u;
    for (var k = 0u; k < u.shB; k++) {
      let h = nb + k * 3u;
      rgb += phi * Y[k] * vec3f(coef(h), coef(h + 1u), coef(h + 2u));
    }
  }
  var o: VOut;
  o.pos = vec4f(px.x / u.viewport.x * 2.0 - 1.0, 1.0 - px.y / u.viewport.y * 2.0, 0.0, 1.0);
  o.local = corner * 3.0;
  o.rgba = vec4f(clamp(rgb + vec3f(0.5), vec3f(0.0), vec3f(1.0)), alpha);
  return o;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4f {
  let r2 = dot(i.local, i.local);
  if (r2 > 9.0) { discard; }
  let alpha = i.rgba.a * exp(-0.5 * r2);
  if (alpha < 0.0039) { discard; }
  return vec4f(i.rgba.rgb * alpha, alpha);
}
`;

function covariance(q, s, out, o) {
  const [w, x, y, z] = q;
  const r = [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
  const m = [r[0] * s[0], r[1] * s[1], r[2] * s[2], r[3] * s[0], r[4] * s[1], r[5] * s[2], r[6] * s[0], r[7] * s[1], r[8] * s[2]];
  out[o] = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
  out[o + 1] = m[0] * m[3] + m[1] * m[4] + m[2] * m[5];
  out[o + 2] = m[0] * m[6] + m[1] * m[7] + m[2] * m[8];
  out[o + 3] = m[3] * m[3] + m[4] * m[4] + m[5] * m[5];
  out[o + 4] = m[3] * m[6] + m[4] * m[7] + m[5] * m[8];
  out[o + 5] = m[6] * m[6] + m[7] * m[7] + m[8] * m[8];
}

// Static scenes become the 4D layout with no motion and one Fourier order.
function staticToGeo(scene, maxShDegree) {
  const { count: n, positions, scales, rotations, opacities, colorsDC, shRest } = scene;
  const K = shRest ? shRest.length / n / 3 : 0;
  let B = Math.min(K + 1, 16);
  if (maxShDegree != null && maxShDegree >= 0) B = Math.min(B, (maxShDegree + 1) ** 2);
  const geo = new Float32Array(n * 16);
  const sht = new Uint16Array(n * B * 3);
  const q = [1, 0, 0, 0], s = [1, 1, 1];
  for (let i = 0; i < n; ++i) {
    const g = i * 16;
    geo[g] = positions[i * 3];
    geo[g + 1] = positions[i * 3 + 1];
    geo[g + 2] = positions[i * 3 + 2];
    for (let k = 0; k < 4; ++k) q[k] = rotations[i * 4 + k];
    for (let k = 0; k < 3; ++k) s[k] = scales[i * 3 + k];
    covariance(q, s, geo, g + 8);
    geo[g + 14] = opacities[i];
    for (let c = 0; c < 3; ++c) {
      sht[i * B * 3 + c] = floatToHalfFast(colorsDC[i * 3 + c] / SH_C0);
      for (let k = 1; k < B; ++k) sht[(i * B + k) * 3 + c] = floatToHalfFast(shRest[(i * 3 + c) * K + k - 1]);
    }
  }
  return { geo, sht, shF: 1, shB: B, duration: 0, motion: 0 };
}

function temporalShFit(scene, maxShDegree) {
  if (maxShDegree == null || maxShDegree < 0 || (maxShDegree + 1) ** 2 >= scene.shB) {
    return { sht: scene.sht, shB: scene.shB };
  }
  const B = (maxShDegree + 1) ** 2, n = scene.count, F = scene.shF, S = scene.shB;
  const sht = new Uint16Array(n * F * B * 3);
  for (let i = 0; i < n; ++i) {
    for (let f = 0; f < F; ++f) {
      const src = ((i * F + f) * S) * 3, dst = ((i * F + f) * B) * 3;
      sht.set(scene.sht.subarray(src, src + B * 3), dst);
    }
  }
  return { sht, shB: B };
}

export class WebGPUSplatRenderer {
  static async create(canvas, scene, opts = {}) {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    const requiredLimits = {};
    for (const k of ['maxStorageBufferBindingSize', 'maxBufferSize']) {
      if (adapter.limits[k] != null) requiredLimits[k] = adapter.limits[k];
    }
    const device = await adapter.requestDevice({ requiredLimits });
    const r = new WebGPUSplatRenderer(device, canvas);
    r._upload(scene, opts);
    return r;
  }

  constructor(device, canvas) {
    this.device = device;
    this.canvas = canvas;
    this.grow = 1;
    this.revealOrigin = [0, 0, 0];
    this.revealInvRadius = 0;
    this.revealWidth = 0;
    this.overdrawClamp = 1.5;
    this.onSorted = null;
    this.onDeviceLost = null;
    device.lost.then((info) => {
      if (info.reason !== 'destroyed') this.onDeviceLost?.(info);
    }).catch(() => {});
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'premultiplied' });
  }

  _buffer(data, usage) {
    const buf = this.device.createBuffer({ size: Math.max(16, (data.byteLength + 3) & ~3), usage: usage | GPUBufferUsage.COPY_DST });
    if (data.byteLength) this.device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength & ~3);
    return buf;
  }

  _upload(scene, opts) {
    const device = this.device;
    let data;
    if (scene.kind === 'temporal') {
      const fit = temporalShFit(scene, opts.maxShDegree);
      data = { geo: scene.geo, sht: fit.sht, shF: scene.shF, shB: fit.shB, duration: scene.duration, motion: 1 };
    } else {
      data = staticToGeo(scene, opts.maxShDegree);
    }
    this.count = scene.count;
    this.shF = data.shF;
    this.shB = data.shB;
    this.duration = data.duration;
    this.motion = data.motion;
    // Halves are read as u32 pairs, so pad to an even count.
    const sht = data.sht.length % 2 ? Uint16Array.from({ length: data.sht.length + 1 }, (_, i) => data.sht[i] ?? 0) : data.sht;
    this.geoBuf = this._buffer(data.geo, GPUBufferUsage.STORAGE);
    this.shtBuf = this._buffer(new Uint32Array(sht.buffer, sht.byteOffset, sht.length / 2), GPUBufferUsage.STORAGE);
    const padded = 1 << Math.ceil(Math.log2(Math.max(2, this.count)));
    this.padded = padded;
    this.keysBuf = device.createBuffer({ size: padded * 4, usage: GPUBufferUsage.STORAGE });
    this.valsBuf = device.createBuffer({ size: padded * 4, usage: GPUBufferUsage.STORAGE });
    this.uniBuf = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sortUniBuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const drawModule = device.createShaderModule({ code: DRAW_WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: drawModule, entryPoint: 'vs' },
      fragment: {
        module: drawModule, entryPoint: 'fs',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-strip' },
    });
    this.bind = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniBuf } },
        { binding: 1, resource: { buffer: this.geoBuf } },
        { binding: 2, resource: { buffer: this.shtBuf } },
        { binding: 3, resource: { buffer: this.valsBuf } },
      ],
    });
    const sortModule = device.createShaderModule({ code: SORT_WGSL });
    this.keygenPipe = device.createComputePipeline({ layout: 'auto', compute: { module: sortModule, entryPoint: 'keygen' } });
    this.bitonicPipe = device.createComputePipeline({ layout: 'auto', compute: { module: sortModule, entryPoint: 'bitonic' } });
    this.keygenBind = device.createBindGroup({
      layout: this.keygenPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.sortUniBuf } },
        { binding: 1, resource: { buffer: this.geoBuf } },
        { binding: 2, resource: { buffer: this.keysBuf } },
        { binding: 3, resource: { buffer: this.valsBuf } },
      ],
    });
    const steps = [];
    for (let k = 2; k <= padded; k <<= 1) for (let j = k >> 1; j > 0; j >>= 1) steps.push([k, j]);
    const stride = 256;
    this.stepBuf = device.createBuffer({ size: Math.max(1, steps.length) * stride, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    steps.forEach(([k, j], i) => device.queue.writeBuffer(this.stepBuf, i * stride, Uint32Array.from([k, j])));
    this.stepBinds = steps.map((_, i) => device.createBindGroup({
      layout: this.bitonicPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.stepBuf, offset: i * stride, size: 8 } },
        { binding: 1, resource: { buffer: this.keysBuf } },
        { binding: 2, resource: { buffer: this.valsBuf } },
      ],
    }));
    this.sorted = false;
  }

  requestSort(view, t) {
    const raw = new ArrayBuffer(48);
    const f = new Float32Array(raw), u = new Uint32Array(raw);
    f[0] = view[8]; f[1] = view[9]; f[2] = view[10]; f[3] = view[11];
    f[4] = t;
    f[5] = Math.max(this.duration, 1e-6);
    u[6] = this.count;
    u[7] = this.padded;
    u[8] = this.motion;
    this.device.queue.writeBuffer(this.sortUniBuf, 0, raw);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    const groups = Math.ceil(this.padded / 256);
    pass.setPipeline(this.keygenPipe);
    pass.setBindGroup(0, this.keygenBind);
    const gx = Math.min(groups, 65535), gy = Math.ceil(groups / 65535);
    pass.dispatchWorkgroups(gx, gy);
    pass.setPipeline(this.bitonicPipe);
    for (const b of this.stepBinds) {
      pass.setBindGroup(0, b);
      pass.dispatchWorkgroups(gx, gy);
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.sorted = true;
    this.onSorted?.();
  }

  // view: row-major world->view; intr in pixels of the canvas.
  render(view, intr, camPos, t) {
    if (!this.sorted) return;
    const W = this.canvas.width, H = this.canvas.height;
    const raw = new ArrayBuffer(160);
    const f = new Float32Array(raw), u = new Uint32Array(raw);
    for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) f[c * 4 + r] = view[r * 4 + c];
    f[16] = intr.fx; f[17] = intr.fy;
    f[18] = intr.cx; f[19] = intr.cy;
    f[20] = W; f[21] = H;
    f[22] = (this.overdrawClamp ?? 1.5) * Math.max(W, H);
    f[23] = this.grow;
    f[24] = camPos[0]; f[25] = camPos[1]; f[26] = camPos[2];
    f[27] = t;
    f[28] = this.revealOrigin[0]; f[29] = this.revealOrigin[1]; f[30] = this.revealOrigin[2];
    f[31] = this.revealInvRadius;
    f[32] = this.revealWidth;
    f[33] = Math.max(this.duration, 1e-6);
    u[34] = this.shF;
    u[35] = this.shB;
    u[36] = this.motion;
    u[37] = this.count;
    this.device.queue.writeBuffer(this.uniBuf, 0, raw);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.draw(4, this.count);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  destroy() {
    try {
      this.ctx?.unconfigure?.();
    } catch {
      // canvas already gone
    }
    this.device?.destroy?.();
  }
}
