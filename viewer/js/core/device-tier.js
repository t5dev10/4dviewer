// Device tier and data budget, decided once from what the browser reports.

export const TIERS = ['ad-slot', 'webview', 'low-android', 'mobile', 'desktop', 'quest', 'vision-pro'];

export const TIER_POLICY = Object.freeze({
  'ad-slot': { resolutionScale: 0.6, splatBudget: 4e5, maxLiveContexts: 2, offerXR: false, allowAudio: false, posterFirst: true },
  webview: { resolutionScale: 0.75, splatBudget: 8e5, maxLiveContexts: 2, offerXR: false, allowAudio: false, posterFirst: true },
  'low-android': { resolutionScale: 0.6, splatBudget: 6e5, maxLiveContexts: 2, offerXR: false, allowAudio: true, posterFirst: true },
  mobile: { resolutionScale: 1, splatBudget: 1.5e6, maxLiveContexts: 4, offerXR: true, allowAudio: true, posterFirst: false },
  desktop: { resolutionScale: 1, splatBudget: 4e6, maxLiveContexts: 8, offerXR: true, allowAudio: true, posterFirst: false },
  quest: { resolutionScale: 0.9, splatBudget: 1.5e6, maxLiveContexts: 2, offerXR: true, allowAudio: true, posterFirst: false },
  'vision-pro': { resolutionScale: 1, splatBudget: 2.5e6, maxLiveContexts: 2, offerXR: true, allowAudio: true, posterFirst: false },
});

const WEBVIEWS = [
  ['instagram', /instagram/i],
  ['facebook', /\bFBAN\b|\bFBAV\b|\bFB_IAB\b/],
  ['tiktok', /musical_ly|bytedance|tiktok/i],
  ['snapchat', /snapchat/i],
  ['twitter', /\bTwitter\b/],
  ['linkedin', /\bLinkedInApp\b/i],
  ['pinterest', /\bPinterest\b/i],
  ['line', /\bLine\//],
  ['wechat', /MicroMessenger/i],
  ['android-webview', /\bwv\b|Version\/[\d.]+ Chrome/],
];

export function detectWebview(ua = '') {
  for (const [host, re] of WEBVIEWS) if (re.test(ua)) return { isWebview: true, host, confidence: 'heuristic' };
  return { isWebview: false, host: null, confidence: 'heuristic' };
}

export function readTierEnvironment(nav = typeof navigator !== 'undefined' ? navigator : null) {
  return {
    ua: nav?.userAgent ?? '',
    deviceMemory: nav?.deviceMemory,
    hardwareConcurrency: nav?.hardwareConcurrency,
    maxTouchPoints: nav?.maxTouchPoints,
    saveData: !!nav?.connection?.saveData,
  };
}

function isLowAndroid(env) {
  if (!/Android/i.test(env.ua ?? '')) return false;
  const lowMem = typeof env.deviceMemory === 'number' && env.deviceMemory > 0 && env.deviceMemory <= 2;
  const fewCores = typeof env.hardwareConcurrency === 'number' && env.hardwareConcurrency > 0 && env.hardwareConcurrency <= 4;
  return lowMem && fewCores;
}

export function resolveTier(env = {}) {
  const caps = env.caps ?? {};
  const ua = env.ua ?? '';
  const xr = caps.xr ?? {};
  const webview = detectWebview(ua);
  const reasons = [];
  let tier;
  if (env.adSlot) {
    tier = 'ad-slot';
    reasons.push('mounted as a minimal embed');
  } else if (/OculusBrowser|Quest/i.test(ua) && (xr.immersiveVR || xr.immersiveAR)) {
    tier = 'quest';
    reasons.push('Quest Browser with an immersive session available');
  } else if (/Vision\s?Pro|visionOS/i.test(ua) ||
    (xr.immersiveVR && /Macintosh/.test(ua) && (env.maxTouchPoints ?? 0) === 0 && /Safari/.test(ua) &&
      /AppleWebKit/.test(ua) && xr.immersiveAR)) {
    tier = 'vision-pro';
    reasons.push('visionOS Safari');
  } else if (webview.isWebview) {
    tier = 'webview';
    reasons.push(`in-app webview (${webview.host}, heuristic)`);
  } else if (isLowAndroid(env)) {
    tier = 'low-android';
    reasons.push('Android with low reported memory and core count');
  } else if (/Android|iPhone|iPad|iPod/i.test(ua) || (env.maxTouchPoints ?? 0) > 1) {
    tier = 'mobile';
    reasons.push('mobile form factor');
  } else {
    tier = 'desktop';
    reasons.push('no narrower tier matched');
  }
  const policy = { ...TIER_POLICY[tier] };
  if (caps.webgl2 === false) {
    policy.offerXR = false;
    reasons.push('WebGL2 absent: no render path, so nothing to offer');
  }
  if (!xr.immersiveVR && !xr.immersiveAR) {
    if (policy.offerXR) reasons.push('XR offer withdrawn: no immersive session is supported');
    policy.offerXR = false;
  }
  if (env.saveData) {
    policy.posterFirst = true;
    policy.splatBudget = Math.min(policy.splatBudget, 4e5);
    reasons.push('Save-Data requested: poster first and the tightest budget');
  }
  return { tier, policy, webview, reasons };
}

// Network / data budget.
export function readEnvSignals(nav = typeof navigator !== 'undefined' ? navigator : {},
  mm = typeof matchMedia === 'function' ? matchMedia : null) {
  const conn = nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null;
  return {
    saveData: !!conn?.saveData,
    effectiveType: conn?.effectiveType ?? null,
    deviceMemory: nav.deviceMemory ?? null,
    coarsePointer: !!mm?.('(pointer: coarse)')?.matches,
    reducedMotion: !!mm?.('(prefers-reduced-motion: reduce)')?.matches,
    reducedData: !!mm?.('(prefers-reduced-data: reduce)')?.matches,
  };
}

export function dataTier(s = {}) {
  const saveData = s.saveData || s.reducedData;
  if (saveData || s.batterySaver || s.effectiveType === 'slow-2g' || s.effectiveType === '2g') return 'minimal';
  if (s.effectiveType === '3g' || (s.coarsePointer && (s.deviceMemory ?? 4) <= 4)) return 'reduced';
  return 'full';
}

export function dataBudget(tier) {
  switch (tier) {
    case 'minimal': return { coarseOnly: true, prefetch: false, preloadNext: false, lookaheadScale: 0.25, autoplay: false };
    case 'reduced': return { coarseOnly: false, prefetch: false, preloadNext: false, lookaheadScale: 0.5, autoplay: true };
    default: return { coarseOnly: false, prefetch: true, preloadNext: true, lookaheadScale: 1, autoplay: true };
  }
}
