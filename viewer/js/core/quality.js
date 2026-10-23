// Adaptive resolution: when the frame gap stays long the render scale drops,
// and climbs back once there is headroom. Splats are never thrown away on a
// real GPU; only a software rasteriser gets a splat cap.

export function createQuality() {
  return { scale: 1, maxScale: 1, splatCap: 0, software: false, emaGap: 16, lastAdjustAt: 0 };
}

export function applyRendererPolicy(q, cfg, { usingGpu, glRenderer, gpuRenderer }) {
  q.software = cfg.perf !== 'full' && !usingGpu && !!glRenderer?.isSoftwareRenderer();
  if (q.software) {
    q.scale = 0.5;
    q.splatCap = 150000;
  }
  if (glRenderer) glRenderer.overdrawClamp = q.software ? 0.15 : 1.5;
  if (gpuRenderer) gpuRenderer.overdrawClamp = 1.5;
}

export function updateQuality(q, now, gapMs, splatCount) {
  q.emaGap = q.emaGap * 0.85 + gapMs * 0.15;
  if (now - q.lastAdjustAt < 600) return;
  const floor = q.software ? 0.4 : 0.72;
  if (q.emaGap > 42) {
    q.lastAdjustAt = now;
    if (q.scale > floor) {
      q.scale = Math.max(floor, q.scale * 0.85);
    } else if (q.software) {
      const cap = q.splatCap || splatCount;
      q.splatCap = Math.max(150000, Math.floor(cap * 0.8));
    }
    q.emaGap = 26;
  } else if (q.emaGap < 20 && q.scale < q.maxScale) {
    q.lastAdjustAt = now;
    q.scale = Math.min(q.maxScale, q.scale * 1.1);
  }
}

export const QUALITY_TIERS = { low: 0.5, medium: 0.75, high: 1, auto: 1 };
