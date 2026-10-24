// Keyboard flying: W/S forward and back, A/D left and right, E/Q up and down,
// along the camera's own axes (as brush does); Shift goes faster. The orbit
// pivot travels with the camera, so a drag afterwards turns around the new
// spot. Speed is a share of the orbit distance per second, like panning, and
// eases in and out instead of starting and stopping dead.

const AXES = {
  KeyD: [1, 0, 0], KeyA: [-1, 0, 0],
  KeyE: [0, 1, 0], KeyQ: [0, -1, 0],
  KeyW: [0, 0, 1], KeyS: [0, 0, -1],
};
const SPEED = 0.25; // orbit distances per second
const FAST = 3;     // with Shift
const EASE_MS = 150;

export function createFlyKeys() {
  const held = new Set();
  const vel = [0, 0, 0]; // right, up, forward, in orbit distances per second
  let fast = false;
  return {
    // Every key event goes through here; true for a key that flies.
    key(code, down, shift) {
      fast = shift;
      if (!AXES[code]) return false;
      if (down) held.add(code);
      else held.delete(code);
      return true;
    },
    clear() {
      held.clear();
      vel.fill(0);
    },
    get moving() {
      return held.size > 0 || vel[0] !== 0 || vel[1] !== 0 || vel[2] !== 0;
    },
    // Moves cam.pan by dt ms of flight. view: row-major world -> view (rows
    // right, down, forward); dist: the orbit distance.
    step(cam, view, dist, dt) {
      const want = [0, 0, 0];
      for (const code of held) for (let a = 0; a < 3; ++a) want[a] += AXES[code][a];
      const len = Math.hypot(want[0], want[1], want[2]);
      const speed = len > 0 ? (SPEED * (fast ? FAST : 1)) / len : 0;
      const k = 1 - Math.exp(-dt / EASE_MS);
      for (let a = 0; a < 3; ++a) vel[a] += (want[a] * speed - vel[a]) * k;
      if (!held.size && Math.hypot(vel[0], vel[1], vel[2]) < 0.01 * SPEED) vel.fill(0);
      const s = (dist * dt) / 1000;
      for (let a = 0; a < 3; ++a) cam.pan[a] += (vel[0] * view[a] - vel[1] * view[4 + a] + vel[2] * view[8 + a]) * s;
    },
  };
}
