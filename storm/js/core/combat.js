// Shared shooting helpers: character hitboxes, spread cones, item codes.
import { CHAR, ITEM_ID, ITEM_TYPES, WEAPONS } from './config.js';

export const BODY_R = 0.46;
export const HEAD_R = 0.29;

// Ray vs character standing with feet at (x,y,z). Returns t (Infinity = miss); out.head set.
export function rayChar(ox, oy, oz, dx, dy, dz, maxT, x, y, z, crouch, out) {
  const h = crouch ? CHAR.crouchHeight : CHAR.height;
  let best = Infinity;
  let head = false;
  // head sphere
  const hy = y + h - 0.24;
  let px = ox - x;
  let py = oy - hy;
  let pz = oz - z;
  let b = px * dx + py * dy + pz * dz;
  let c = px * px + py * py + pz * pz - HEAD_R * HEAD_R;
  let disc = b * b - c;
  if (disc >= 0) {
    const t = -b - Math.sqrt(disc);
    if (t >= 0 && t < maxT) {
      best = t;
      head = true;
    }
  }
  // body: vertical cylinder from y to y + h - 0.5
  const y0 = y;
  const y1 = y + h - 0.5;
  const a = dx * dx + dz * dz;
  let tmin = 0;
  let tmax = Math.min(maxT, best);
  let ok = true;
  if (a > 1e-12) {
    const bb = 2 * (px * dx + pz * dz);
    const cc = px * px + pz * pz - BODY_R * BODY_R;
    const dd = bb * bb - 4 * a * cc;
    if (dd < 0) ok = false;
    else {
      const sq = Math.sqrt(dd);
      const t1 = (-bb - sq) / (2 * a);
      const t2 = (-bb + sq) / (2 * a);
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) ok = false;
    }
  } else if (px * px + pz * pz > BODY_R * BODY_R) ok = false;
  if (ok) {
    if (Math.abs(dy) > 1e-9) {
      let t1 = (y0 - oy) / dy;
      let t2 = (y1 - oy) / dy;
      if (t1 > t2) {
        const tt = t1;
        t1 = t2;
        t2 = tt;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) ok = false;
    } else if (oy < y0 || oy > y1) ok = false;
  }
  if (ok && tmin < best) {
    best = tmin;
    head = false;
  }
  if (out) out.head = head;
  return best;
}

// Perturb a unit direction inside a cone of half-angle `deg` using two uniform randoms.
export function spreadDir(dx, dy, dz, deg, r1, r2, out) {
  if (deg <= 0.0001) {
    out[0] = dx;
    out[1] = dy;
    out[2] = dz;
    return out;
  }
  const ang = (deg * Math.PI) / 180 * Math.sqrt(r2);
  const phi = r1 * Math.PI * 2;
  // basis
  let ux, uy, uz;
  if (Math.abs(dy) < 0.95) {
    // u = normalize(cross(d, up))
    ux = -dz;
    uy = 0;
    uz = dx;
  } else {
    ux = 0;
    uy = dz;
    uz = -dy;
  }
  let l = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= l;
  uy /= l;
  uz /= l;
  // v = cross(d, u)
  const vx = dy * uz - dz * uy;
  const vy = dz * ux - dx * uz;
  const vz = dx * uy - dy * ux;
  const t = Math.tan(ang);
  const cx = Math.cos(phi) * t;
  const cy = Math.sin(phi) * t;
  let nx = dx + ux * cx + vx * cy;
  let ny = dy + uy * cx + vy * cy;
  let nz = dz + uz * cx + vz * cy;
  l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  out[0] = nx / l;
  out[1] = ny / l;
  out[2] = nz / l;
  return out;
}

export function dirFromAngles(yaw, pitch, out = [0, 0, 0]) {
  const cp = Math.cos(pitch);
  out[0] = -Math.sin(yaw) * cp;
  out[1] = Math.sin(pitch);
  out[2] = -Math.cos(yaw) * cp;
  return out;
}

export function anglesTo(dx, dy, dz) {
  const h = Math.sqrt(dx * dx + dz * dz);
  return [Math.atan2(-dx, -dz), Math.atan2(dy, h)];
}

export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Compact held-item code for snapshots: 0 = pickaxe / nothing
export function itemCode(slot) {
  if (!slot) return 0;
  return ITEM_ID[slot.t] * 8 + (slot.r | 0) + 1;
}
export function decodeItem(code) {
  if (!code) return null;
  const c = code - 1;
  return { t: ITEM_TYPES[c >> 3], r: c & 7 };
}

export function isAuto(t) {
  return !!(WEAPONS[t] && WEAPONS[t].auto);
}

// Hit kinds used on the wire
export const HK_NONE = 0;
export const HK_CHAR = 1;
export const HK_PIECE = 2;
export const HK_PROP = 3;
export const HK_WORLD = 4;
