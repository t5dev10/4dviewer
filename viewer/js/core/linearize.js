// Curved motion -> the viewer's linear model, within a stated error.
//
// The 4D model moves a splat on a straight line; trajectories that bend
// (polynomial motion, sampled frames) become several "pieces": copies of the
// splat that each own a slice of time (a window) and follow the chord across
// it. A chord is extended until some sample along it strays more than `eps`
// from the true path, so a splat that barely moves stays one piece and one
// that swerves gets as many as its curvature needs.

// sample(t, out3) gives the true position; returns piece end times.
// Greedy chord growth over `steps` samples of [a, b]; at most maxPieces.
export function chordBreaks(sample, a, b, eps, steps = 64, maxPieces = 32) {
  if (!(b > a)) return [a, b];
  const n = Math.max(2, Math.min(1024, steps));
  const ts = new Float64Array(n + 1);
  const ps = new Float64Array((n + 1) * 3);
  const p = [0, 0, 0];
  for (let k = 0; k <= n; ++k) {
    ts[k] = a + ((b - a) * k) / n;
    sample(ts[k], p);
    ps[k * 3] = p[0]; ps[k * 3 + 1] = p[1]; ps[k * 3 + 2] = p[2];
  }
  const fits = (i, j) => {
    const span = ts[j] - ts[i];
    for (let k = i + 1; k < j; ++k) {
      const f = (ts[k] - ts[i]) / span;
      for (let c = 0; c < 3; ++c) {
        const chord = ps[i * 3 + c] + (ps[j * 3 + c] - ps[i * 3 + c]) * f;
        if (Math.abs(chord - ps[k * 3 + c]) > eps) return false;
      }
    }
    return true;
  };
  const breaks = [a];
  let i = 0;
  while (i < n) {
    // Longest chord from i that still fits (galloping, then binary search).
    let good = i + 1, step = 1;
    while (good + step <= n && fits(i, good + step)) {
      good += step;
      step *= 2;
    }
    let lo = good, hi = Math.min(n, good + step);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (fits(i, mid)) lo = mid;
      else hi = mid;
    }
    i = lo;
    breaks.push(ts[i]);
    if (breaks.length > maxPieces) {
      breaks.push(b);
      break;
    }
  }
  breaks[breaks.length - 1] = b;
  return breaks;
}

// Growable typed-array columns for emitting pieces.
export class Columns {
  constructor(spec, capacity = 1024) {
    this.spec = spec; // { name: [Ctor, per] }
    this.n = 0;
    this.cap = capacity;
    this.cols = {};
    for (const [name, [Ctor, per]] of Object.entries(spec)) this.cols[name] = new Ctor(capacity * per);
  }

  push() {
    if (this.n === this.cap) {
      this.cap *= 2;
      for (const [name, [Ctor, per]] of Object.entries(this.spec)) {
        const grown = new Ctor(this.cap * per);
        grown.set(this.cols[name]);
        this.cols[name] = grown;
      }
    }
    return this.n++;
  }

  trimmed() {
    const out = {};
    for (const [name, [, per]] of Object.entries(this.spec)) out[name] = this.cols[name].slice(0, this.n * per);
    return out;
  }
}
