// GLSL for the WebGL2 path. One program draws both static and 4D scenes: a
// static scene is the 4D model with no motion texture, gate ≡ 1 and one
// Fourier order. 4D scenes may add per-splat time windows and rigid group
// poses (uT4 / uGroups).

export const MAX_FOURIER = 16;

export const VERTEX = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2DArray;

uniform mat4 uView;          // world -> view (x right, y down, z forward)
uniform vec2 uViewport;      // pixels
uniform vec2 uFocal;         // fx, fy in pixels
uniform vec2 uPrincipal;     // cx, cy in pixels
uniform vec3 uCamPos;        // world-space eye, for the SH direction
uniform float uMaxRadius;    // projected-radius clamp in px (overdraw control)
uniform float uGrow;         // 0 -> 1 entrance ramp
uniform vec3 uRevealOrigin;
uniform float uRevealInvRadius;
uniform float uRevealWidth;
uniform float uT;
uniform float uDuration;
uniform int uShF;            // Fourier orders in use
uniform int uShB;            // SH bands per order in use, (l+1)^2
uniform int uShStride;       // layers per order in the colour texture
uniform bool uMotion;
uniform bool uStaticRule;    // nx4d: splats living longer than 0.6 T never fade
uniform float uAlphaCut;     // source-specific visibility floor (>= 0.0016)
uniform bool uAntialiased;   // opacity compensation of the low-pass (gsplat "antialiased"; off for "classic")
uniform bool uExt;
uniform int uGroupCount;
uniform int uTexWidth;
uniform sampler2D uT0;       // mu.xyz, mu_t
uniform sampler2D uT1;       // v.xyz, tau
uniform sampler2D uT2;       // Sxx Sxy Sxz Syy
uniform sampler2D uT3;       // Syz Szz opacity flags
uniform sampler2D uT4;       // window lo, window hi, group, -
uniform sampler2D uGroups;   // row g: (0) quaternion xyzw, (1) translation
uniform sampler2DArray uTC;  // layer n*uShStride + b: SH coefficient rgb
uniform usampler2D uOrder;

out vec2 vLocal;
out vec4 vColor;

const float SH_C0 = 0.28209479177387814;
const float SH_C1 = 0.4886025119029199;
const float TWO_PI = 6.283185307179586;

float revealFactor(vec3 p) {
  if (uRevealWidth <= 0.0) return uGrow;
  float phase = clamp(length(p - uRevealOrigin) * uRevealInvRadius, 0.0, 1.0);
  float front = uGrow * (1.0 + 2.0 * uRevealWidth) - uRevealWidth;
  return smoothstep(phase - uRevealWidth, phase + uRevealWidth, front);
}

void cull() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vColor = vec4(0.0);
  vLocal = vec2(0.0);
}

mat3 quatMat(vec4 q) {
  float x = q.x, y = q.y, z = q.z, w = q.w;
  return mat3(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
              2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
              2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y));
}

void main() {
  int slot = gl_InstanceID;
  int idx = int(texelFetch(uOrder, ivec2(slot % uTexWidth, slot / uTexWidth), 0).r);
  ivec2 tc = ivec2(idx % uTexWidth, idx / uTexWidth);
  vec4 a0 = texelFetch(uT0, tc, 0);
  vec4 a3 = texelFetch(uT3, tc, 0);

  int group = -1;
  if (uExt) {
    vec4 a4 = texelFetch(uT4, tc, 0);
    if (uT < a4.x || uT >= a4.y) { cull(); return; }
    group = int(floor(a4.z + 0.5));
  }

  float dt = 0.0;
  float gate = 1.0;
  bool isStatic = true;
  vec3 p = a0.xyz;
  if (uMotion) {
    vec4 a1 = texelFetch(uT1, tc, 0);
    dt = uT - a0.w;
    // Static rule (sqrt(Σtt) > 0.6 T with Σtt = 1/(2τ)): gate ≡ 1, orders n ≥ 1 skipped.
    isStatic = uStaticRule && a1.w > 0.0 && sqrt(0.5 / a1.w) > 0.6 * uDuration;
    gate = isStatic ? 1.0 : exp(-dt * dt * a1.w);
    p += a1.xyz * dt;
  }
  bool grouped = group >= 0 && group < uGroupCount;
  mat3 G = mat3(1.0);
  if (grouped) {
    G = quatMat(texelFetch(uGroups, ivec2(0, group), 0));
    p = G * p + texelFetch(uGroups, ivec2(1, group), 0).xyz;
  }
  float reveal = revealFactor(p);
  float alpha = a3.z * gate * reveal;
  // Fade through the visibility cut instead of popping as a gate crosses it.
  alpha *= smoothstep(0.0020, 0.0060, alpha);
  if (alpha < uAlphaCut) { cull(); return; }

  vec4 v = uView * vec4(p, 1.0);
  if (v.z < 0.05) { cull(); return; }

  vec4 a2 = texelFetch(uT2, tc, 0);
  mat3 S = mat3(a2.x, a2.y, a2.z,
                a2.y, a2.w, a3.x,
                a2.z, a3.x, a3.y);
  if (grouped) S = G * S * transpose(G);
  mat3 W = mat3(uView);
  mat3 VS = W * S * transpose(W);

  float iz = 1.0 / v.z;
  // As in 3DGS and gsplat, the projection's slope is taken at most 1.3 half fields of view off axis, so splats
  // beside the frustum are not stretched across the picture.
  vec2 margin = 0.15 * uViewport / uFocal;
  vec2 ray = clamp(v.xy * iz, -uPrincipal / uFocal - margin, (uViewport - uPrincipal) / uFocal + margin);
  float j00 = uFocal.x * iz, j02 = -uFocal.x * ray.x * iz;
  float j11 = uFocal.y * iz, j12 = -uFocal.y * ray.y * iz;
  float u0 = j00 * VS[0][0] + j02 * VS[2][0];
  float u1 = j00 * VS[0][1] + j02 * VS[2][1];
  float u2 = j00 * VS[0][2] + j02 * VS[2][2];
  float a0c = u0 * j00 + u2 * j02;
  float b = u1 * j11 + u2 * j12;
  float c0 = j11 * (j11 * VS[1][1] + j12 * VS[2][1]) + j12 * (j11 * VS[1][2] + j12 * VS[2][2]);
  // 0.3 px² low-pass, with the opacity compensation when the model was trained under it.
  float a = a0c + 0.3;
  float c = c0 + 0.3;
  float comp = uAntialiased ? sqrt(max((a0c * c0 - b * b) / max(a * c - b * b, 1e-12), 2.5e-5)) : 1.0;
  // Drawn out to where it fades below 1/255, 3.33 sigma at most (gsplat's extent).
  float peak = alpha * comp;
  if (peak < 1.0 / 255.0) { cull(); return; }
  float ext = min(3.33, sqrt(2.0 * log(peak * 255.0)));
  float mid = 0.5 * (a + c);
  float disc = sqrt(max(mid * mid - (a * c - b * b), 1e-9));
  float l1 = mid + disc;
  float l2 = max(mid - disc, 1e-9);
  vec2 e1 = abs(b) < 1e-9 ? (a >= c ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) : normalize(vec2(b, l1 - a));
  vec2 e2 = vec2(-e1.y, e1.x);
  float r1 = min(ext * sqrt(l1) * reveal, uMaxRadius);
  float r2 = min(ext * sqrt(l2) * reveal, uMaxRadius);

  vec2 corner = vec2(float(gl_VertexID & 1) * 2.0 - 1.0, float(gl_VertexID >> 1) * 2.0 - 1.0);
  vec2 centre = vec2(uFocal.x * v.x * iz, uFocal.y * v.y * iz) + uPrincipal;
  vec2 px = centre + corner.x * r1 * e1 + corner.y * r2 * e2;
  gl_Position = vec4(px.x / uViewport.x * 2.0 - 1.0, 1.0 - px.y / uViewport.y * 2.0, 0.0, 1.0);
  vLocal = corner * ext;

  // 4D spherindrical harmonics: c(d, t) = Σ_n Σ_b cos(2π n dt / T) Y_b(d) c_nb,
  // with d in the splat's own (rest) frame.
  vec3 d = normalize(p - uCamPos);
  if (grouped) d = transpose(G) * d;
  float Y[16];
  Y[0] = SH_C0;
  if (uShB > 1) {
    Y[1] = -SH_C1 * d.y;
    Y[2] = SH_C1 * d.z;
    Y[3] = -SH_C1 * d.x;
  }
  if (uShB > 4) {
    float xx = d.x * d.x, yy = d.y * d.y, zz = d.z * d.z;
    float xy = d.x * d.y, yz = d.y * d.z, xz = d.x * d.z;
    Y[4] = 1.0925484305920792 * xy;
    Y[5] = -1.0925484305920792 * yz;
    Y[6] = 0.31539156525252005 * (2.0 * zz - xx - yy);
    Y[7] = -1.0925484305920792 * xz;
    Y[8] = 0.5462742152960396 * (xx - yy);
    if (uShB > 9) {
      Y[9] = -0.5900435899266435 * d.y * (3.0 * xx - yy);
      Y[10] = 2.890611442640554 * xy * d.z;
      Y[11] = -0.4570457994644658 * d.y * (4.0 * zz - xx - yy);
      Y[12] = 0.3731763325901154 * d.z * (2.0 * zz - 3.0 * xx - 3.0 * yy);
      Y[13] = -0.4570457994644658 * d.x * (4.0 * zz - xx - yy);
      Y[14] = 1.445305721320277 * d.z * (xx - yy);
      Y[15] = -0.5900435899266435 * d.x * (xx - 3.0 * yy);
    }
  }
  vec3 rgb = vec3(0.0);
  for (int n = 0; n < ${MAX_FOURIER}; ++n) {
    if (n >= uShF || (isStatic && n > 0)) break;
    float phi = n == 0 ? 1.0 : cos(TWO_PI * float(n) * dt / uDuration);
    for (int k = 0; k < 16; ++k) {
      if (k >= uShB) break;
      rgb += phi * Y[k] * texelFetch(uTC, ivec3(tc, n * uShStride + k), 0).rgb;
    }
  }
  // Only negative colour is clipped, as in 3DGS and gsplat; the framebuffer clips the sum.
  vColor = vec4(max(rgb + 0.5, 0.0), peak);
}
`;

export const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec4 vColor;
out vec4 fragColor;
void main() {
  float alpha = min(0.999, vColor.a * exp(-0.5 * dot(vLocal, vLocal)));
  if (alpha < 1.0 / 255.0) discard;
  fragColor = vec4(vColor.rgb * alpha, alpha);
}
`;

// Copies the half-float accumulation target to the canvas: one rounding to 8
// bits at the end instead of one per blended layer.
export const RESOLVE_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const RESOLVE_FRAGMENT = `#version 300 es
precision highp float;
uniform highp sampler2D uAccum;
uniform ivec2 uOrigin;
out vec4 fragColor;
void main() {
  fragColor = texelFetch(uAccum, ivec2(gl_FragCoord.xy) - uOrigin, 0);
}
`;
