// One requestAnimationFrame loop shared by every viewer on the page.

const subscribers = new Set();
let handle = 0;
let frames = 0;
let lastTick = 0;

function tick(now) {
  handle = subscribers.size ? requestAnimationFrame(tick) : 0;
  lastTick = now;
  frames++;
  for (const fn of [...subscribers]) {
    try {
      fn(now);
    } catch (err) {
      subscribers.delete(fn);
      console.error('[4dviewer] frame subscriber threw and was detached:', err);
    }
  }
}

export function subscribeFrames(fn) {
  subscribers.add(fn);
  if (!handle) handle = requestAnimationFrame(tick);
  return () => {
    subscribers.delete(fn);
    if (!subscribers.size && handle) {
      cancelAnimationFrame(handle);
      handle = 0;
    }
  };
}

export function frameDriverStats() {
  return { subscribers: subscribers.size, running: !!handle, frames, lastTick };
}
