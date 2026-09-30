// Where a build piece goes, relative to a character's position and aim (shared by the
// local player's ghost preview and by bots, validated again on the host).
import { GRID, LEVEL } from './config.js';
import { K_WALL, K_FLOOR, K_RAMP, K_CONE, DIRS, slotKey, slopeHeight, pieceAABB } from './pieces.js';

export const MAX_LEVEL = 40;

export function yawDir(yaw) {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  if (Math.abs(fx) > Math.abs(fz)) return fx > 0 ? 0 : 2;
  return fz > 0 ? 1 : 3;
}

// Ramp the character is standing on (within its own cell), or null
export function rampUnder(world, x, y, z) {
  let found = null;
  world.pieces.query(x - 0.05, y - 1, z - 0.05, x + 0.05, y + 0.5, z + 0.05, (p) => {
    if (p.k !== K_RAMP) return;
    const h = slopeHeight(p, x, z);
    if (h !== -Infinity && Math.abs(h - y) < 0.45) {
      found = p;
      return true;
    }
  });
  return found;
}

// Fill `out` with {k,x,y,z,o}. rot rotates ramps by 90 degree steps.
export function buildTarget(world, c, yaw, pitch, kind, rot = 0, out = {}) {
  const d = yawDir(yaw);
  const dx = DIRS[d][0];
  const dz = DIRS[d][1];
  const cx = Math.floor(c.x / GRID);
  const cz = Math.floor(c.z / GRID);
  const y = c.y;
  const lv = Math.floor((y + 1.2) / LEVEL);
  const up = pitch > 0.62;
  const down = pitch < -0.9;
  out.k = kind;
  out.o = 0;
  switch (kind) {
    case K_WALL: {
      const L = lv + (up ? 1 : 0);
      out.y = L;
      if (d === 0) {
        out.x = cx + 1;
        out.z = cz;
        out.o = 0;
      } else if (d === 2) {
        out.x = cx;
        out.z = cz;
        out.o = 0;
      } else if (d === 1) {
        out.x = cx;
        out.z = cz + 1;
        out.o = 1;
      } else {
        out.x = cx;
        out.z = cz;
        out.o = 1;
      }
      break;
    }
    case K_FLOOR:
      if (down) {
        out.x = cx;
        out.z = cz;
        out.y = lv;
      } else if (up) {
        out.x = cx;
        out.z = cz;
        out.y = lv + 1;
      } else {
        out.x = cx + dx;
        out.z = cz + dz;
        out.y = lv;
      }
      break;
    case K_RAMP: {
      const o = (d + (rot & 3)) & 3;
      out.o = o;
      const r = rampUnder(world, c.x, y, c.z);
      if (r && r.o === d && (rot & 3) === 0) {
        out.x = r.x + dx;
        out.z = r.z + dz;
        out.y = r.y + 1;
      } else if (down) {
        out.x = cx;
        out.z = cz;
        out.y = Math.floor((y + 0.6) / LEVEL);
      } else {
        out.x = cx + dx;
        out.z = cz + dz;
        out.y = Math.floor((y + 0.6) / LEVEL);
        if (up) out.y += 1;
      }
      break;
    }
    default:
      out.k = K_CONE;
      if (down) {
        out.x = cx + dx;
        out.z = cz + dz;
        out.y = lv;
      } else {
        out.x = cx;
        out.z = cz;
        out.y = lv + 1;
      }
  }
  return out;
}

const tmpAABB = new Array(6);
// 0 = ok, 1 = occupied, 2 = unsupported, 3 = buried/out of range
export function placeCheck(world, t) {
  if (t.y < -2 || t.y > MAX_LEVEL) return 3;
  if (world.pieces.bySlot.has(slotKey(t.k, t.x, t.y, t.z, t.o))) return 1;
  const a = pieceAABB(t, tmpAABB);
  const lim = world.map.terrain.half - 12;
  if (a[0] < -lim || a[3] > lim || a[2] < -lim || a[5] > lim) return 3;
  const tmin = world.terrain.minOver(a[0], a[2], a[3], a[5]);
  if (a[4] < tmin - 0.05) return 3; // fully underground
  if (!world.pieces.isSupported(t)) return 2;
  return 0;
}
