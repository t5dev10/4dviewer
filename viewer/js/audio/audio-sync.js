// Scene audio slaved to the playback clock: looping buffers re-anchored on
// large drift and nudged by a small playback-rate skew on small drift. Object
// tracks get HRTF panners that follow their trajectories; the listener
// follows the camera.

function interpolate(trajectory, t) {
  if (!trajectory?.length) return null;
  if (t <= trajectory[0].t) return trajectory[0].p;
  const last = trajectory[trajectory.length - 1];
  if (t >= last.t) return last.p;
  for (let i = 1; i < trajectory.length; ++i) {
    if (t <= trajectory[i].t) {
      const a = trajectory[i - 1], b = trajectory[i];
      const span = b.t - a.t;
      const k = span > 0 ? (t - a.t) / span : 0;
      return [a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k];
    }
  }
  return last.p;
}

export function createAudioSync(clock) {
  const s = {
    ctx: null, master: null, tracks: [], failed: [], muted: clock.muted !== false,
    anchorCtxTime: 0, anchorOffset: 0, playing: false, skew: 0,
    reanchors: 0, skews: 0, lastDrift: 0, maxAbsDrift: 0, lastCheck: 0, ready: false, resumeCalls: 0,
  };
  const period = () => Math.max(clock.getDuration() || 0, 1e-6);

  function context() {
    if (s.ctx) return s.ctx;
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    s.ctx = new Ctor();
    s.master = s.ctx.createGain();
    s.master.gain.value = s.muted ? 0 : 1;
    s.master.connect(s.ctx.destination);
    return s.ctx;
  }

  function wire(track) {
    const ctx = s.ctx;
    track.gain = ctx.createGain();
    track.gain.connect(s.master);
    if (track.kind === 'object' && ctx.createPanner) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 1;
      p.connect(track.gain);
      track.panner = p;
    }
  }

  function startSources(offset) {
    const ctx = s.ctx;
    for (const track of s.tracks) {
      const src = ctx.createBufferSource();
      src.buffer = track.buffer;
      src.loop = true;
      src.loopStart = 0;
      src.loopEnd = Math.min(period(), track.buffer.duration);
      src.playbackRate.value = 1 + s.skew;
      src.connect(track.panner ?? track.gain);
      track.source = src;
      src.start(0, offset % src.loopEnd);
    }
    s.anchorCtxTime = ctx.currentTime;
    s.anchorOffset = offset;
  }

  function stopSources() {
    for (const track of s.tracks) {
      try {
        track.source?.stop();
      } catch {
        // never started
      }
      track.source?.disconnect();
      track.source = null;
    }
  }

  function position() {
    if (!s.playing || !s.ctx) return s.anchorOffset;
    return (s.anchorOffset + (s.ctx.currentTime - s.anchorCtxTime) * (1 + s.skew)) % period();
  }

  function wrapDiff(a, b, p) {
    let d = (a - b) % p;
    if (d > p / 2) d -= p;
    if (d < -p / 2) d += p;
    return d;
  }

  function reanchor(offset) {
    stopSources();
    s.skew = 0;
    startSources(offset);
    s.reanchors++;
  }

  function setSkew(v) {
    if (v === s.skew) return;
    s.anchorOffset = position();
    s.anchorCtxTime = s.ctx.currentTime;
    s.skew = v;
    for (const t of s.tracks) if (t.source) t.source.playbackRate.value = 1 + v;
  }

  function updateSpatial() {
    const ctx = s.ctx;
    const l = clock.getListener?.();
    if (!ctx || !l) return;
    const L = ctx.listener;
    const [px, py, pz] = l.position, [fx, fy, fz] = l.forward, [ux, uy, uz] = l.up;
    if (L.positionX) {
      L.positionX.value = px; L.positionY.value = py; L.positionZ.value = pz;
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else if (L.setPosition) {
      L.setPosition(px, py, pz);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
    const t = clock.getTime();
    for (const track of s.tracks) {
      if (!track.panner || !track.objects?.length) continue;
      const p = interpolate(track.objects[0].trajectory, t);
      if (!p) continue;
      const P = track.panner;
      if (P.positionX) {
        P.positionX.value = p[0]; P.positionY.value = p[1]; P.positionZ.value = p[2];
      } else {
        P.setPosition?.(p[0], p[1], p[2]);
      }
    }
  }

  return {
    state: s,
    async load(tracks) {
      const ctx = context();
      if (!ctx) return { ok: false, tracks: 0, failed: tracks.length, reason: 'no Web Audio in this environment' };
      const out = [];
      for (const t of tracks) {
        try {
          const buffer = await ctx.decodeAudioData(t.bytes.slice().buffer);
          out.push({ ...t, buffer });
        } catch (err) {
          out.push({ ...t, buffer: null, error: String(err?.message || err) });
        }
      }
      s.tracks = out.filter((t) => t.buffer);
      s.failed = out.filter((t) => !t.buffer);
      s.tracks.forEach(wire);
      s.ready = s.tracks.length > 0;
      return { ok: s.ready, tracks: s.tracks.length, failed: s.failed.length };
    },
    play() {
      if (!s.ready) return;
      const ctx = context();
      if (!ctx) return;
      if (ctx.state === 'suspended' && !s.muted) {
        s.resumeCalls++;
        ctx.resume().catch(() => {});
      }
      if (!s.playing) {
        s.playing = true;
        s.skew = 0;
        startSources(clock.getTime() % period());
      }
    },
    pause() {
      if (!s.playing) return;
      s.anchorOffset = position();
      s.playing = false;
      stopSources();
    },
    seek(t) {
      s.anchorOffset = t % period();
      if (s.playing) reanchor(s.anchorOffset);
    },
    tick() {
      if (!s.ctx || !s.ready) return;
      const want = clock.isPlaying();
      if (want && !s.playing) this.play();
      else if (!want && s.playing) this.pause();
      updateSpatial();
      if (!s.playing) return;
      const now = s.ctx.currentTime;
      if (now - s.lastCheck < 0.032) return;
      s.lastCheck = now;
      const drift = wrapDiff(position(), clock.getTime(), period());
      s.lastDrift = drift;
      s.maxAbsDrift = Math.max(s.maxAbsDrift, Math.abs(drift));
      if (Math.abs(drift) > 0.03) {
        reanchor(clock.getTime() % period());
      } else if (Math.abs(drift) > 0.006) {
        setSkew(Math.max(-0.02, Math.min(0.02, -drift * 0.5)));
        s.skews++;
      } else if (s.skew !== 0) {
        setSkew(0);
      }
    },
    setMuted(m) {
      s.muted = !!m;
      if (s.master) s.master.gain.value = s.muted ? 0 : 1;
      if (!s.muted && s.ctx?.state === 'suspended') {
        s.resumeCalls++;
        s.ctx.resume().catch(() => {});
      }
    },
    isMuted: () => s.muted,
    stats() {
      return {
        ready: s.ready, tracks: s.tracks.length, failedTracks: s.failed.length, muted: s.muted, playing: s.playing,
        contextState: s.ctx?.state ?? 'none', position: Number(position().toFixed(4)),
        driftMs: Number((s.lastDrift * 1000).toFixed(2)), maxAbsDriftMs: Number((s.maxAbsDrift * 1000).toFixed(2)),
        reanchors: s.reanchors, skews: s.skews, skew: s.skew,
      };
    },
    destroy() {
      stopSources();
      for (const t of s.tracks) {
        t.panner?.disconnect();
        t.gain?.disconnect();
      }
      s.tracks = [];
      s.ready = false;
      s.ctx?.close?.().catch(() => {});
      s.ctx = null;
      s.master = null;
    },
  };
}
