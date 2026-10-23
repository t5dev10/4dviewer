#!/usr/bin/env python3
"""Procedural 4D demo scene ("Lumen") written as .nx4d.

  python tools/make_demo_scene.py viewer/assets/scenes/lumen.nx4d

It exercises the 4D model the way a reconstruction does: moving splats are
short-lived samples along each particle's path (mu + v·dt, temporal gate),
trails are stationary splats that light up as a particle passes, the floor is
static, sparks twinkle, and the core "breathes" through a first Fourier colour
order. Everything is periodic in the clip length, so the loop is seamless.
Frame: x right, y down, z forward (the viewer's native frame).
"""
import colorsys
import gzip
import json
import struct
import sys

import numpy as np

MAGIC = 0x3464584E
T = 8.0
SH_C0 = 0.28209479177387814
rng = np.random.default_rng(2026)
parts = []


def tau_for(sigma):
    return 1.0 / (2.0 * sigma * sigma)


def add(mu, mu_t, vel, tau, scale, opacity, rgb, fourier=None):
    """Append splats. scale: (n,3) std devs along x y z (axis-aligned)."""
    n = len(mu)
    geo = np.zeros((n, 16), np.float32)
    geo[:, 0:3] = mu
    geo[:, 3] = mu_t
    geo[:, 4:7] = vel
    geo[:, 7] = tau
    s2 = np.asarray(scale, np.float64) ** 2
    geo[:, 8] = s2[:, 0]
    geo[:, 11] = s2[:, 1]
    geo[:, 13] = s2[:, 2]
    geo[:, 14] = opacity
    sht = np.zeros((n, 2, 1, 3), np.float32)
    sht[:, 0, 0, :] = (np.asarray(rgb) - 0.5) / SH_C0
    if fourier is not None:
        sht[:, 1, 0, :] = np.asarray(fourier) / SH_C0
    parts.append((geo, sht))


def knot(phi, p=2, q=3, scale=0.42, lift=0.22):
    r = np.cos(q * phi) + 2.2
    x = r * np.cos(p * phi) * scale
    z = r * np.sin(p * phi) * scale
    y = -np.sin(q * phi) * lift - 0.15
    return np.stack([x, y, z], -1)


def knot_vel(phi, dphi_dt, **kw):
    h = 1e-4
    return (knot(phi + h, **kw) - knot(phi - h, **kw)) / (2 * h) * dphi_dt


strands, per_strand = 6, 60
dt_head = T / 240
heads_k = np.arange(-4, 244)          # samples beyond [0, T) keep the loop seamless
trail_dt = T / 60
trail_k = np.arange(-6, 66)
for s in range(strands):
    hue = s / strands
    base_rgb = np.array(colorsys.hsv_to_rgb(0.47 + 0.42 * hue, 0.75, 1.0))
    knot_kw = dict(scale=0.42 + 0.025 * np.sin(s * 1.7), lift=0.2 + 0.04 * np.cos(s * 2.3))
    turns = 1 if s % 2 == 0 else -1
    for j in range(per_strand):
        phase = 2 * np.pi * (j / per_strand + s / (strands * per_strand))
        w = turns * 2 * np.pi / T              # one lap per loop
        # moving head samples
        t = heads_k * dt_head
        phi = phase + w * t
        mu = knot(phi, **knot_kw)
        vel = knot_vel(phi, w, **knot_kw)
        sz = 0.010 + 0.004 * (j % 3 == 0)
        add(mu, t, vel, tau_for(0.6 * dt_head), np.full((len(t), 3), sz), 0.9,
            np.tile(np.clip(base_rgb * 1.05 + 0.08, 0, 1), (len(t), 1)))
        # glowing trail, lit just after the head passes
        tt = trail_k * trail_dt
        mu = knot(phase + w * tt, **knot_kw)
        add(mu, tt + 0.18, np.zeros_like(mu), tau_for(0.16), np.full((len(tt), 3), 0.024), 0.32,
            np.tile(base_rgb * 0.85, (len(tt), 1)))

# static floor disc (+y is down, so the floor sits at positive y)
n_floor = 26000
r = 1.75 * np.sqrt(rng.uniform(0, 1, n_floor))
a = rng.uniform(0, 2 * np.pi, n_floor)
mu = np.stack([r * np.cos(a), np.full(n_floor, 0.62) + rng.normal(0, 0.002, n_floor), r * np.sin(a)], -1)
ring = 0.5 + 0.5 * np.cos(r * 18.0)
rgb = np.stack([0.05 + 0.05 * ring, 0.09 + 0.20 * ring * np.exp(-r), 0.12 + 0.25 * ring * np.exp(-r)], -1)
add(mu, np.full(n_floor, T / 2), np.zeros((n_floor, 3)), 1e-6,
    np.stack([np.full(n_floor, 0.03), np.full(n_floor, 0.002), np.full(n_floor, 0.03)], -1), 0.55, rgb)

# breathing core: long-lived (not static) splats whose colour swings through
# Fourier order 1; opacity and size fall off with radius for a soft glow.
n_core = 1800
d = rng.normal(size=(n_core, 3))
d /= np.linalg.norm(d, axis=1, keepdims=True)
u = rng.uniform(0, 1, n_core)
rad = 0.22 * u ** 0.7
mu = d * rad[:, None] + np.array([0, -0.15, 0])
falloff = np.exp(-(rad / 0.11) ** 2)
inner = np.array([0.95, 0.97, 1.0])
outer = np.array([0.25, 0.75, 1.0])
rgb = inner * falloff[:, None] + outer * (1 - falloff[:, None])
sizes = (0.03 + 0.045 * (1 - falloff))[:, None] * np.ones((1, 3))
swing = np.tile([0.32, -0.16, -0.30], (n_core, 1)) * (0.4 + 0.6 * falloff[:, None])
add(mu, np.full(n_core, T / 2), np.zeros((n_core, 3)), tau_for(0.45 * T), sizes, 0.03 + 0.09 * falloff, rgb,
    fourier=swing)

# twinkling sparks, duplicated across the seam
n_spark = 5000
d = rng.normal(size=(n_spark, 3))
d /= np.linalg.norm(d, axis=1, keepdims=True)
mu = d * rng.uniform(0.9, 2.2, n_spark)[:, None] * np.array([1.0, 0.55, 1.0]) + np.array([0, -0.35, 0])
mt = rng.uniform(0, T, n_spark)
sig = rng.uniform(0.08, 0.2, n_spark)
hue = rng.uniform(0.45, 0.95, n_spark)
rgb = np.array([colorsys.hsv_to_rgb(h, 0.35, 1.0) for h in hue])
for shift in (0.0, T, -T):
    keep = slice(None) if shift == 0 else (mt < 4 * sig) if shift == T else (mt > T - 4 * sig)
    m = mu[keep]
    add(m, mt[keep] + shift, np.zeros_like(m), tau_for(sig[keep]), np.full((len(m), 3), 0.009), 0.95, rgb[keep])

geo = np.concatenate([p[0] for p in parts])
sht = np.concatenate([p[1] for p in parts])
count = len(geo)
order = rng.permutation(count)  # interleave, so no structure sits in one contiguous block
geo, sht = geo[order], sht[order]
header = {
    'format': 'nx4d-v1', 'count': int(count), 'duration': T, 'sh_l': 0, 'sh_f': 2,
    'view': {'eye': [0.0, -1.55, -3.3], 'target': [0.0, -0.05, 0.0], 'up': [0.0, -1.0, 0.0]},
    'credit': 'Lumen — a procedural 4D scene generated by tools/make_demo_scene.py.',
}
hjson = json.dumps(header, separators=(',', ':')).encode()
payload = struct.pack('<II', MAGIC, len(hjson)) + hjson + geo.astype('<f4').tobytes() + sht.astype('<f2').tobytes()
out = sys.argv[1] if len(sys.argv) > 1 else 'lumen.nx4d'
with open(out, 'wb') as f:
    f.write(gzip.compress(payload, compresslevel=9, mtime=0))
print(f'wrote {out}: {count} splats, {T} s, raw {len(payload) / 1e6:.1f} MB')


def write_ambient(path, seconds=T, rate=24000):
    """Procedural ambient loop: a soft chord whose swell follows the core."""
    import wave
    t = np.arange(int(seconds * rate)) / rate
    swell = 0.55 - 0.45 * np.cos(2 * np.pi * (t - seconds / 2) / seconds)
    tone = np.zeros_like(t)
    for f, a in [(110.0, 0.5), (164.81, 0.35), (220.0, 0.3), (261.63, 0.18), (329.63, 0.12)]:
        k = round(f * seconds) / seconds  # whole cycles per loop, so the seam is silent
        tone += a * np.sin(2 * np.pi * k * t)
    for c in range(8):  # one chime per second, decaying
        ph = (t - c) % seconds
        f = [523.25, 659.25, 783.99, 987.77][c % 4]
        tone += 0.08 * np.sin(2 * np.pi * f * ph) * np.exp(-ph * 3.5) * (ph < 1.5)
    left = tone * swell * 0.22
    right = np.roll(left, int(0.012 * rate))
    pcm = (np.clip(np.stack([left, right], 1), -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    print(f'wrote {path}: {seconds} s ambient loop')


if len(sys.argv) > 2 and sys.argv[2].endswith('.wav'):
    write_ambient(sys.argv[2])
