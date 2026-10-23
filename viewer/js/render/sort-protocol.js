// What the sort workers need from a scene, shared by the page view and XR.

import { groupPosesAt } from '../core/groups.js';

// The first message for a scene's sort worker (copies, so the scene keeps its arrays).
export function sortInitMessage(scene) {
  if (scene.kind === 'temporal') {
    const geo = scene.geo.slice();
    const ext = scene.ext ? scene.ext.slice() : null;
    const msg = {
      geo, count: scene.count, duration: scene.duration, ext,
      staticRule: scene.staticRule !== false, alphaCut: scene.alphaCut ?? 0,
    };
    return { msg, transfer: ext ? [geo.buffer, ext.buffer] : [geo.buffer] };
  }
  const positions = scene.positions.slice(), opacities = scene.opacities.slice(), scales = scene.scales.slice();
  return {
    msg: { positions, count: scene.count, opacities, scales },
    transfer: [positions.buffer, opacities.buffer, scales.buffer],
  };
}

// Group poses for a sort request at time t (null when the scene has none).
export function sortPoses(scene, t) {
  return scene?.kind === 'temporal' && scene.groups ? groupPosesAt(scene.groups, t) : null;
}

// Seconds of clock a sorted order has to cover: the worker's round trip,
// a frame, and slack so playback never outruns the list.
export const sortWindow = (rtt) => 1.5 * (rtt || 0) + 1 / 30 + 0.05;
