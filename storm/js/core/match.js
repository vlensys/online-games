// Match helpers shared by the server and clients: bus path, snapshot flags.
import { BUS_HEIGHT, BUS_SPEED } from './config.js';
import { clamp } from './rng.js';

export const F_CROUCH = 1;
export const F_ADS = 2;
export const F_SPRINT = 4;
export const F_BUILD = 8;
export const F_HEAL = 16;
export const F_RELOAD = 32;
export const F_SWING = 64;

export function busPath(rng) {
  const ang = rng.float(0, Math.PI * 2);
  const dx = Math.cos(ang);
  const dz = Math.sin(ang);
  const off = rng.float(-150, 150);
  const px = -dz * off;
  const pz = dx * off;
  const L = 560;
  return { sx: px - dx * L, sz: pz - dz * L, ex: px + dx * L, ez: pz + dz * L, y: BUS_HEIGHT, dur: (2 * L) / BUS_SPEED, door: 3 };
}

export function busPos(bus, t, out = [0, 0, 0]) {
  const f = clamp(t / bus.dur, 0, 1);
  out[0] = bus.sx + (bus.ex - bus.sx) * f;
  out[1] = bus.y;
  out[2] = bus.sz + (bus.ez - bus.sz) * f;
  return out;
}
