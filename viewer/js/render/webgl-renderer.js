// WebGL2 splat renderer. Splat attributes live in float textures laid out on a
// near-square grid; a sorted index texture drives one instanced quad per splat,
// composited back to front with premultiplied alpha.

import { VERTEX, FRAGMENT, MAX_FOURIER } from './shaders.js';
import { floatToHalfFast } from '../core/half.js';
import { SH_C0 } from '../core/scene.js';
import { transposeToColumnMajor } from '../core/camera.js';
import { groupPosesAt, POSE_STRIDE } from '../core/groups.js';
import { ALPHA_CUT, EXT_STRIDE } from '../core/temporal-build.js';

const UNIFORMS = ['uView', 'uViewport', 'uFocal', 'uPrincipal', 'uCamPos', 'uMaxRadius', 'uGrow', 'uRevealOrigin',
  'uRevealInvRadius', 'uRevealWidth', 'uT', 'uDuration', 'uShF', 'uShB', 'uShStride', 'uMotion', 'uStaticRule',
  'uAlphaCut', 'uExt', 'uGroupCount', 'uTexWidth', 'uT0', 'uT1', 'uT2', 'uT3', 'uT4', 'uGroups', 'uTC', 'uOrder'];
const BAND_TEXELS = 1 << 20;
const BAND_STEPS = [16, 9, 4, 1];

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`webgl-renderer: shader compile failed: ${log}`);
  }
  return sh;
}

function covariance(q0, q1, q2, q3, s0, s1, s2, out, o) {
  const w = q0, x = q1, y = q2, z = q3;
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - w * z), r02 = 2 * (x * z + w * y);
  const r10 = 2 * (x * y + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - w * x);
  const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y);
  const m00 = r00 * s0, m01 = r01 * s1, m02 = r02 * s2;
  const m10 = r10 * s0, m11 = r11 * s1, m12 = r12 * s2;
  const m20 = r20 * s0, m21 = r21 * s1, m22 = r22 * s2;
  out[o] = m00 * m00 + m01 * m01 + m02 * m02;
  out[o + 1] = m00 * m10 + m01 * m11 + m02 * m12;
  out[o + 2] = m00 * m20 + m01 * m21 + m02 * m22;
  out[o + 3] = m10 * m10 + m11 * m11 + m12 * m12;
  out[o + 4] = m10 * m20 + m11 * m21 + m12 * m22;
  out[o + 5] = m20 * m20 + m21 * m21 + m22 * m22;
}

export class WebGLSplatRenderer {
  static create(canvas, opts = {}) {
    const gl = canvas.getContext('webgl2', {
      xrCompatible: !!opts.xrCompatible,
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
      ...(opts.powerPreference ? { powerPreference: opts.powerPreference } : {}),
    });
    if (!gl) throw new Error('webgl-renderer: WebGL2 is not available in this browser');
    const r = new WebGLSplatRenderer(gl, canvas);
    if (opts.colorSpace === 'display-p3' && 'drawingBufferColorSpace' in gl) {
      gl.drawingBufferColorSpace = 'display-p3';
      r.colorSpace = gl.drawingBufferColorSpace;
    }
    return r;
  }

  constructor(gl, canvas) {
    this.gl = gl;
    this.canvas = canvas;
    this.colorSpace = 'srgb';
    this.overdrawClamp = 1.5;
    this.contextLost = false;
    this.onContextRestored = null;
    this.onPoolLost = null;
    this._resetState();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this._init();
      const scene = this.scene;
      const opts = this.uploadOpts;
      this._resetTextures();
      if (scene) this.uploadScene(scene, opts);
      else if (this.poolInfo) this.onPoolLost?.();
      this.onContextRestored?.();
    });
    this._init();
  }

  _resetState() {
    this.scene = null;
    this.uploadOpts = {};
    this.mode = null;
    this.count = 0;
    this.drawCount = 0;
    this.texWidth = 1;
    this.texHeight = 1;
    this.time = 0;
    this.duration = 0;
    this.shF = 1;
    this.shB = 1;
    this.shStride = 1;
    this.grow = 1;
    this.revealOrigin = [0, 0, 0];
    this.revealInvRadius = 0;
    this.revealWidth = 0;
    this.poolInfo = null;
    this.staticRule = true;
    this.alphaCut = ALPHA_CUT;
    this.hasExt = false;
    this.groupTrack = null;
    this.groupPoses = null;
    this.posesTime = NaN;
    this.tex = {};
  }

  _init() {
    const gl = this.gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`webgl-renderer: program link failed: ${gl.getProgramInfoLog(prog)}`);
    }
    this.program = prog;
    this.u = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)]));
    this.vao = gl.createVertexArray();
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    this.dummy = this._tex2D(gl.RGBA32F, 1, 1);
  }

  async makeXRCompatible() {
    if (this.gl.makeXRCompatible) await this.gl.makeXRCompatible();
  }

  isSoftwareRenderer() {
    try {
      const gl = this.gl;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
    } catch {
      return false;
    }
  }

  rendererName() {
    try {
      const gl = this.gl;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    } catch {
      return 'unknown';
    }
  }

  // --- textures -------------------------------------------------------------

  _tex2D(internal, w, h) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    return t;
  }

  _texArray(w, h, layers) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, w, h, layers);
    return t;
  }

  _resetTextures() {
    const gl = this.gl;
    for (const t of Object.values(this.tex)) if (t) gl.deleteTexture(t);
    this.tex = {};
  }

  _grid(n) {
    const w = Math.max(1, Math.ceil(Math.sqrt(n)));
    const h = Math.max(1, Math.ceil(n / w));
    if (w > this.maxTextureSize || h > this.maxTextureSize) {
      throw new Error(`webgl-renderer: ${n} splats exceed this GPU's ${this.maxTextureSize}² texture limit`);
    }
    this.texWidth = w;
    this.texHeight = h;
    return { w, h };
  }

  // Colour layers: shrink SH bands, then Fourier orders, to fit the layer
  // limit and the memory budget.
  _planColour(count, shF, shB, opts) {
    let f = Math.min(shF, MAX_FOURIER);
    let b = shB;
    if (opts.maxShDegree != null && opts.maxShDegree >= 0) b = Math.min(b, (opts.maxShDegree + 1) ** 2);
    const budget = opts.colourBudgetBytes ?? 1.2e9;
    const texels = this.texWidth * this.texHeight;
    const fits = () => f * b <= this.maxLayers && texels * 8 * f * b <= budget;
    while (b > 1 && !fits()) b = BAND_STEPS.find((s) => s < b);
    while (f > 1 && !fits()) f--;
    if (b < shB || f < shF) {
      console.warn(`[4dviewer] colour table reduced to ${f} Fourier order(s) × ${b} SH band(s) (file: ${shF} × ${shB}) to fit this GPU`);
    }
    return { f, b };
  }

  // Calls fill(stage, first, n) for successive row bands and uploads them.
  _uploadBands(tex, n, fill) {
    const gl = this.gl;
    const W = this.texWidth;
    const rowsPer = Math.max(1, Math.floor(BAND_TEXELS / W));
    const stage = new Float32Array(Math.min(rowsPer, this.texHeight) * W * 4);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (let row = 0; row < this.texHeight; row += rowsPer) {
      const rows = Math.min(rowsPer, this.texHeight - row);
      const first = row * W;
      const cnt = Math.max(0, Math.min(rows * W, n - first));
      stage.fill(0);
      fill(stage, first, cnt);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, W, rows, gl.RGBA, gl.FLOAT, stage, 0);
    }
  }

  _uploadColourBands(tex, layers, n, fill) {
    const gl = this.gl;
    const W = this.texWidth;
    const rowsPer = Math.max(1, Math.floor(BAND_TEXELS / W));
    const stage = new Uint16Array(Math.min(rowsPer, this.texHeight) * W * 4);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    for (let layer = 0; layer < layers; ++layer) {
      for (let row = 0; row < this.texHeight; row += rowsPer) {
        const rows = Math.min(rowsPer, this.texHeight - row);
        const first = row * W;
        const cnt = Math.max(0, Math.min(rows * W, n - first));
        stage.fill(0);
        fill(stage, layer, first, cnt);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, row, layer, W, rows, 1, gl.RGBA, gl.HALF_FLOAT, stage, 0);
      }
    }
  }

  _allocOrder() {
    const gl = this.gl;
    this.tex.order = this._tex2D(gl.R32UI, this.texWidth, this.texHeight);
    this.drawCount = 0;
  }

  uploadScene(scene, opts = {}) {
    this._resetTextures();
    this.poolInfo = null;
    this.scene = scene;
    this.uploadOpts = opts;
    this.count = scene.count;
    this.mode = scene.kind;
    this.staticRule = scene.kind !== 'temporal' || scene.staticRule !== false;
    this.alphaCut = Math.max(ALPHA_CUT, scene.alphaCut ?? ALPHA_CUT);
    this.hasExt = false;
    this.groupTrack = null;
    this.groupPoses = null;
    this.posesTime = NaN;
    if (scene.count === 0) return;
    if (scene.kind === 'temporal') this._uploadTemporal(scene, opts);
    else this._uploadStatic(scene, opts);
    this._allocOrder();
  }

  _uploadTemporal(scene, opts) {
    const gl = this.gl;
    const { count: n, geo, sht, shF, shB, duration } = scene;
    const { w, h } = this._grid(n);
    this.duration = duration;
    const { f, b } = this._planColour(n, shF, shB, opts);
    this.shF = f;
    this.shB = b;
    this.shStride = b;
    const names = ['t0', 't1', 't2', 't3'];
    names.forEach((name, k) => {
      this.tex[name] = this._tex2D(gl.RGBA32F, w, h);
      this._uploadBands(this.tex[name], n, (stage, first, cnt) => {
        for (let j = 0; j < cnt; ++j) {
          const src = (first + j) * 16 + k * 4;
          stage[j * 4] = geo[src];
          stage[j * 4 + 1] = geo[src + 1];
          stage[j * 4 + 2] = geo[src + 2];
          stage[j * 4 + 3] = geo[src + 3];
        }
      });
    });
    this.tex.tc = this._texArray(w, h, f * b);
    this._uploadColourBands(this.tex.tc, f * b, n, (stage, layer, first, cnt) => {
      const fo = Math.floor(layer / b), k = layer % b;
      for (let j = 0; j < cnt; ++j) {
        const src = (((first + j) * shF + fo) * shB + k) * 3;
        stage[j * 4] = sht[src];
        stage[j * 4 + 1] = sht[src + 1];
        stage[j * 4 + 2] = sht[src + 2];
      }
    });
    if (scene.ext) {
      this.tex.t4 = this._tex2D(gl.RGBA32F, w, h);
      this._uploadBands(this.tex.t4, n, (stage, first, cnt) => {
        stage.set(scene.ext.subarray(first * EXT_STRIDE, (first + cnt) * EXT_STRIDE));
      });
      this.hasExt = true;
    }
    if (scene.groups) {
      const G = scene.groups.count;
      if (G > this.maxTextureSize) throw new Error(`webgl-renderer: ${G} rigid groups exceed this GPU's texture limit`);
      this.tex.groups = this._tex2D(gl.RGBA32F, 2, G);
      this.groupTrack = scene.groups;
      this.groupPoses = new Float32Array(G * POSE_STRIDE);
    }
  }

  // Group poses follow the clock: re-evaluated whenever the time moves.
  _syncGroups() {
    if (!this.groupTrack || this.posesTime === this.time) return;
    groupPosesAt(this.groupTrack, this.time, this.groupPoses);
    this.posesTime = this.time;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.groups);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 2, this.groupTrack.count, gl.RGBA, gl.FLOAT, this.groupPoses, 0);
  }

  _uploadStatic(scene, opts) {
    const gl = this.gl;
    const { count: n, positions, scales, rotations, opacities, colorsDC, shRest } = scene;
    const { w, h } = this._grid(n);
    this.duration = 0;
    const K = shRest ? shRest.length / n / 3 : 0;
    const { b } = this._planColour(n, 1, Math.min(K + 1, 16), opts);
    this.shF = 1;
    this.shB = b;
    this.shStride = b;
    this.tex.t0 = this._tex2D(gl.RGBA32F, w, h);
    this._uploadBands(this.tex.t0, n, (stage, first, cnt) => {
      for (let j = 0; j < cnt; ++j) {
        const i = first + j;
        stage[j * 4] = positions[i * 3];
        stage[j * 4 + 1] = positions[i * 3 + 1];
        stage[j * 4 + 2] = positions[i * 3 + 2];
      }
    });
    // Σ = R S² Rᵀ, written band by band into t2 (xx xy xz yy) and t3 (yz zz opacity).
    this.tex.t2 = this._tex2D(gl.RGBA32F, w, h);
    this.tex.t3 = this._tex2D(gl.RGBA32F, w, h);
    const rowsPer = Math.max(1, Math.floor(BAND_TEXELS / w));
    const s2 = new Float32Array(Math.min(rowsPer, h) * w * 4);
    const s3 = new Float32Array(s2.length);
    const cov = new Float32Array(6);
    for (let row = 0; row < h; row += rowsPer) {
      const rows = Math.min(rowsPer, h - row);
      const first = row * w;
      const cnt = Math.max(0, Math.min(rows * w, n - first));
      s2.fill(0);
      s3.fill(0);
      for (let j = 0; j < cnt; ++j) {
        const i = first + j;
        covariance(rotations[i * 4], rotations[i * 4 + 1], rotations[i * 4 + 2], rotations[i * 4 + 3],
          scales[i * 3], scales[i * 3 + 1], scales[i * 3 + 2], cov, 0);
        s2[j * 4] = cov[0];
        s2[j * 4 + 1] = cov[1];
        s2[j * 4 + 2] = cov[2];
        s2[j * 4 + 3] = cov[3];
        s3[j * 4] = cov[4];
        s3[j * 4 + 1] = cov[5];
        s3[j * 4 + 2] = opacities[i];
      }
      gl.bindTexture(gl.TEXTURE_2D, this.tex.t2);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, w, rows, gl.RGBA, gl.FLOAT, s2, 0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex.t3);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, w, rows, gl.RGBA, gl.FLOAT, s3, 0);
    }
    this.tex.tc = this._texArray(w, h, b);
    const inv = 1 / SH_C0;
    this._uploadColourBands(this.tex.tc, b, n, (stage, layer, first, cnt) => {
      for (let j = 0; j < cnt; ++j) {
        const i = first + j;
        if (layer === 0) {
          stage[j * 4] = floatToHalfFast(colorsDC[i * 3] * inv);
          stage[j * 4 + 1] = floatToHalfFast(colorsDC[i * 3 + 1] * inv);
          stage[j * 4 + 2] = floatToHalfFast(colorsDC[i * 3 + 2] * inv);
        } else {
          const base = i * 3 * K + layer - 1;
          stage[j * 4] = floatToHalfFast(shRest[base]);
          stage[j * 4 + 1] = floatToHalfFast(shRest[base + K]);
          stage[j * 4 + 2] = floatToHalfFast(shRest[base + 2 * K]);
        }
      }
    });
  }

  // --- streaming pool (nxs4) --------------------------------------------------

  allocTemporalPool({ capacity, shF, shB, duration }) {
    const gl = this.gl;
    this._resetTextures();
    this.scene = null;
    this.mode = 'temporal';
    this.duration = duration;
    this.staticRule = true;
    this.alphaCut = ALPHA_CUT;
    this.hasExt = false;
    this.groupTrack = null;
    const W = Math.min(this.maxTextureSize, 4096);
    const rows = Math.max(1, Math.min(Math.ceil(capacity / W), this.maxTextureSize));
    this.texWidth = W;
    this.texHeight = rows;
    this.count = W * rows;
    const plan = this._planColour(this.count, shF, shB, {});
    this.shF = plan.f;
    this.shB = plan.b;
    this.shStride = plan.b;
    for (const name of ['t0', 't1', 't2', 't3']) this.tex[name] = this._tex2D(gl.RGBA32F, W, rows);
    // WebGL zero-initialises storage, so unfilled slots have zero opacity.
    this.tex.tc = this._texArray(W, rows, plan.f * plan.b);
    this._allocOrder();
    this.poolInfo = { capacity: this.count, rowWidth: W, rows, shF: plan.f, shB: plan.b, fileShF: shF, fileShB: shB };
    return this.poolInfo;
  }

  // page: { rows, t0..t3 Float32Array(rows*W*4), tc Uint16Array(layers*rows*W*4) }
  uploadPoolPage(rowStart, page) {
    if (this.contextLost || !this.poolInfo) return;
    const gl = this.gl;
    const W = this.texWidth;
    for (const name of ['t0', 't1', 't2', 't3']) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex[name]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, rowStart, W, page.rows, gl.RGBA, gl.FLOAT, page[name], 0);
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex.tc);
    const per = page.rows * W * 4;
    const layers = this.shF * this.shB;
    for (let l = 0; l < layers; ++l) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, rowStart, l, W, page.rows, 1, gl.RGBA, gl.HALF_FLOAT, page.tc, l * per);
    }
  }

  clearPoolRows(rowStart, rows) {
    if (this.contextLost || !this.poolInfo) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.t3);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, rowStart, this.texWidth, rows, gl.RGBA, gl.FLOAT,
      new Float32Array(this.texWidth * rows * 4), 0);
  }

  // --- draw -----------------------------------------------------------------

  updateOrder(indices) {
    if (this.contextLost || !this.tex.order) return;
    const gl = this.gl;
    const W = this.texWidth;
    const n = Math.min(indices.length, this.texWidth * this.texHeight);
    const full = Math.floor(n / W), rem = n % W;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.order);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (full) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, full, gl.RED_INTEGER, gl.UNSIGNED_INT, indices, 0);
    if (rem) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, full, rem, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, indices, full * W);
    this.drawCount = n;
  }

  // The target is explicit every time: an XR session leaves its own
  // framebuffer bound, and that one is dead once the session ends.
  clear(r = 0, g = 0, b = 0, a = 0, framebuffer = null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // view: row-major world->view; intr: { fx, fy, cx, cy } in viewport pixels.
  render(view, intr, viewport, camPos, framebuffer = null) {
    const gl = this.gl;
    if (this.contextLost || !this.mode || !this.tex.order || this.drawCount === 0) return;
    this._syncGroups();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    const u = this.u;
    gl.uniformMatrix4fv(u.uView, false, transposeToColumnMajor(view));
    gl.uniform2f(u.uViewport, viewport.width, viewport.height);
    gl.uniform2f(u.uFocal, intr.fx, intr.fy);
    gl.uniform2f(u.uPrincipal, intr.cx, intr.cy);
    gl.uniform3f(u.uCamPos, camPos[0], camPos[1], camPos[2]);
    gl.uniform1f(u.uMaxRadius, (this.overdrawClamp ?? 1.5) * Math.max(viewport.width, viewport.height));
    gl.uniform1f(u.uGrow, this.grow);
    gl.uniform3f(u.uRevealOrigin, this.revealOrigin[0], this.revealOrigin[1], this.revealOrigin[2]);
    gl.uniform1f(u.uRevealInvRadius, this.revealInvRadius);
    gl.uniform1f(u.uRevealWidth, this.revealWidth);
    gl.uniform1f(u.uT, this.time);
    gl.uniform1f(u.uDuration, Math.max(this.duration, 1e-6));
    gl.uniform1i(u.uShF, this.shF);
    gl.uniform1i(u.uShB, this.shB);
    gl.uniform1i(u.uShStride, this.shStride);
    gl.uniform1i(u.uMotion, this.mode === 'temporal' ? 1 : 0);
    gl.uniform1i(u.uStaticRule, this.staticRule ? 1 : 0);
    gl.uniform1f(u.uAlphaCut, this.alphaCut);
    gl.uniform1i(u.uExt, this.hasExt ? 1 : 0);
    gl.uniform1i(u.uGroupCount, this.groupTrack ? this.groupTrack.count : 0);
    gl.uniform1i(u.uTexWidth, this.texWidth);
    const bind = (unit, target, tex, loc) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, tex);
      gl.uniform1i(loc, unit);
    };
    bind(0, gl.TEXTURE_2D, this.tex.t0, u.uT0);
    bind(1, gl.TEXTURE_2D, this.tex.t1 || this.dummy, u.uT1);
    bind(2, gl.TEXTURE_2D, this.tex.t2, u.uT2);
    bind(3, gl.TEXTURE_2D, this.tex.t3, u.uT3);
    bind(4, gl.TEXTURE_2D_ARRAY, this.tex.tc, u.uTC);
    bind(5, gl.TEXTURE_2D, this.tex.order, u.uOrder);
    bind(6, gl.TEXTURE_2D, this.tex.t4 || this.dummy, u.uT4);
    bind(7, gl.TEXTURE_2D, this.tex.groups || this.dummy, u.uGroups);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.drawCount);
    gl.bindVertexArray(null);
  }

  reset() {
    this._resetTextures();
    this._resetState();
  }

  destroy() {
    this.reset();
    try {
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // already gone
    }
  }
}

// Builds pool-page staging arrays for one decoded nxs4 chunk.
export function buildPoolPage(chunk, rowWidth, info) {
  const n = chunk.count;
  const rows = Math.ceil(n / rowWidth);
  const texels = rows * rowWidth;
  const page = { rows };
  for (let k = 0; k < 4; ++k) {
    const a = new Float32Array(texels * 4);
    for (let j = 0; j < n; ++j) a.set(chunk.geo.subarray(j * 16 + k * 4, j * 16 + k * 4 + 4), j * 4);
    page[`t${k}`] = a;
  }
  const B = (chunk.shDepth + 1) * (chunk.shDepth + 1);
  const layers = info.shF * info.shB;
  const tc = new Uint16Array(layers * texels * 4);
  const fileShF = info.fileShF;
  const useB = Math.min(info.shB, B);
  for (let f = 0; f < info.shF; ++f) {
    for (let b = 0; b < useB; ++b) {
      const base = (f * info.shB + b) * texels * 4;
      for (let j = 0; j < n; ++j) {
        const src = ((j * fileShF + f) * B + b) * 3;
        tc[base + j * 4] = chunk.sht[src];
        tc[base + j * 4 + 1] = chunk.sht[src + 1];
        tc[base + j * 4 + 2] = chunk.sht[src + 2];
      }
    }
  }
  page.tc = tc;
  return page;
}
