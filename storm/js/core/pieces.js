// Build pieces (player builds AND map buildings share this system): geometry for
// collision/raycasts, a spatial grid, adjacency + structural support.
import { GRID, LEVEL } from './config.js';

export const K_WALL = 0;
export const K_FLOOR = 1;
export const K_RAMP = 2;
export const K_CONE = 3;
export const PIECE_NAMES = ['Wall', 'Floor', 'Ramp', 'Roof'];

export const WALL_HALF = 0.15;
export const FLOOR_T = 0.3;
export const RAMP_T = 0.42; // vertical thickness of ramp slab
export const CONE_H = 2.6;

// Ramp directions: 0 rises toward +x, 1 toward +z, 2 toward -x, 3 toward -z
export const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

export function slotKey(k, x, y, z, o) {
  const oo = k === K_WALL ? o & 1 : 0;
  return ((((x + 256) * 512 + (z + 256)) * 128 + (y + 16)) * 8 + k * 2 + oo) | 0;
}

function cellKey(cx, cy, cz) {
  return (((cx + 256) * 512 + (cz + 256)) * 128 + (cy + 16)) | 0;
}

// AABB [minx,miny,minz,maxx,maxy,maxz]
export function pieceAABB(p, out = new Array(6)) {
  const X = p.x * GRID;
  const Y = p.y * LEVEL;
  const Z = p.z * GRID;
  switch (p.k) {
    case K_WALL:
      if ((p.o & 1) === 0) {
        out[0] = X - WALL_HALF; out[1] = Y; out[2] = Z;
        out[3] = X + WALL_HALF; out[4] = Y + LEVEL; out[5] = Z + GRID;
      } else {
        out[0] = X; out[1] = Y; out[2] = Z - WALL_HALF;
        out[3] = X + GRID; out[4] = Y + LEVEL; out[5] = Z + WALL_HALF;
      }
      break;
    case K_FLOOR:
      out[0] = X; out[1] = Y - FLOOR_T; out[2] = Z;
      out[3] = X + GRID; out[4] = Y; out[5] = Z + GRID;
      break;
    case K_RAMP:
      out[0] = X; out[1] = Y - RAMP_T; out[2] = Z;
      out[3] = X + GRID; out[4] = Y + LEVEL; out[5] = Z + GRID;
      break;
    default:
      out[0] = X; out[1] = Y - FLOOR_T; out[2] = Z;
      out[3] = X + GRID; out[4] = Y + CONE_H; out[5] = Z + GRID;
  }
  return out;
}

// Solid boxes used for character collision and raycasts (walls with door/window gaps)
export function computeBoxes(p) {
  const X = p.x * GRID;
  const Y = p.y * LEVEL;
  const Z = p.z * GRID;
  if (p.k === K_FLOOR) return [[X, Y - FLOOR_T, Z, X + GRID, Y, Z + GRID]];
  if (p.k !== K_WALL) return [];
  // wall along lateral axis 'a' (z when o=0, x when o=1)
  const spans = [];
  const v = p.v | 0;
  if (v === 1) {
    spans.push([0, 1.2, 0, 4], [2.8, 4, 0, 4], [1.2, 2.8, 2.9, 4]);
  } else if (v === 2) {
    spans.push([0, 1.2, 0, 4], [2.8, 4, 0, 4], [1.2, 2.8, 0, 1.2], [1.2, 2.8, 2.6, 4]);
  } else {
    spans.push([0, 4, 0, 4]);
  }
  const out = [];
  for (const [a0, a1, y0, y1] of spans) {
    if ((p.o & 1) === 0) out.push([X - WALL_HALF, Y + y0, Z + a0, X + WALL_HALF, Y + y1, Z + a1]);
    else out.push([X + a0, Y + y0, Z - WALL_HALF, X + a1, Y + y1, Z + WALL_HALF]);
  }
  return out;
}

// Height of a ramp / cone surface at (px,pz), or -Infinity outside its footprint
export function slopeHeight(p, px, pz) {
  const X = p.x * GRID;
  const Z = p.z * GRID;
  const lx = px - X;
  const lz = pz - Z;
  if (lx < -0.01 || lz < -0.01 || lx > GRID + 0.01 || lz > GRID + 0.01) return -Infinity;
  const Y = p.y * LEVEL;
  if (p.k === K_RAMP) {
    let a;
    switch (p.o & 3) {
      case 0: a = lx; break;
      case 1: a = lz; break;
      case 2: a = GRID - lx; break;
      default: a = GRID - lz;
    }
    if (a < 0) a = 0;
    else if (a > GRID) a = GRID;
    return Y + a * (LEVEL / GRID);
  }
  if (p.k === K_CONE) {
    const m = Math.max(Math.abs(lx - 2), Math.abs(lz - 2));
    return Y + CONE_H * (1 - Math.min(1, m / 2));
  }
  return -Infinity;
}

// --- Ray tests ---------------------------------------------------------------
const tmpN = [0, 0, 0];

export function rayBox(ox, oy, oz, dx, dy, dz, b, maxT, nOut) {
  let tmin = 0;
  let tmax = maxT;
  let axis = -1;
  let sign = 0;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? ox : a === 1 ? oy : oz;
    const d = a === 0 ? dx : a === 1 ? dy : dz;
    const lo = b[a];
    const hi = b[a + 3];
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return Infinity;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      let s = -1;
      if (t1 > t2) {
        const tt = t1;
        t1 = t2;
        t2 = tt;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = a;
        sign = s;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    }
  }
  if (nOut) {
    nOut[0] = nOut[1] = nOut[2] = 0;
    if (axis >= 0) nOut[axis] = sign;
    else nOut[1] = 1;
  }
  return tmin;
}

function rayRamp(p, ox, oy, oz, dx, dy, dz, maxT, nOut) {
  const X = p.x * GRID;
  const Y = p.y * LEVEL;
  const Z = p.z * GRID;
  const dir = p.o & 3;
  const ux = DIRS[dir][0];
  const uz = DIRS[dir][1];
  // a: distance from low edge along u; b: lateral 0..4; c: (y - Y) - a in [-RAMP_T, 0]
  const lowX = ux < 0 ? X + GRID : X;
  const lowZ = uz < 0 ? Z + GRID : Z;
  const a0 = (ox - lowX) * ux + (oz - lowZ) * uz;
  const ad = dx * ux + dz * uz;
  const b0 = ux !== 0 ? oz - Z : ox - X;
  const bd = ux !== 0 ? dz : dx;
  const c0 = oy - Y - a0;
  const cd = dy - ad;
  let tmin = 0;
  let tmax = maxT;
  let hitC = false;
  const cons = [
    [a0, ad, 0, GRID, 0],
    [b0, bd, 0, GRID, 1],
    [c0, cd, -RAMP_T, 0, 2],
  ];
  for (const [f0, fd, lo, hi, id] of cons) {
    if (Math.abs(fd) < 1e-9) {
      if (f0 < lo || f0 > hi) return Infinity;
    } else {
      let t1 = (lo - f0) / fd;
      let t2 = (hi - f0) / fd;
      if (t1 > t2) {
        const tt = t1;
        t1 = t2;
        t2 = tt;
      }
      if (t1 > tmin) {
        tmin = t1;
        hitC = id === 2;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    }
  }
  if (nOut) {
    const inv = 1 / Math.SQRT2;
    const up = cd < 0 ? 1 : -1;
    nOut[0] = -ux * inv * up;
    nOut[1] = inv * up;
    nOut[2] = -uz * inv * up;
    if (!hitC) {
      nOut[0] = -Math.sign(dx) * (ux !== 0 ? 1 : 0);
      nOut[1] = 0;
      nOut[2] = -Math.sign(dz) * (uz !== 0 ? 1 : 0);
    }
  }
  return tmin;
}

function rayTri(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, cx, cy, cz, maxT) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-9) return Infinity;
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return Infinity;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t < 0 || t > maxT) return Infinity;
  return t;
}

function rayCone(p, ox, oy, oz, dx, dy, dz, maxT, nOut) {
  const X = p.x * GRID;
  const Y = p.y * LEVEL;
  const Z = p.z * GRID;
  const apx = X + 2, apy = Y + CONE_H, apz = Z + 2;
  const c = [
    [X, Z],
    [X + GRID, Z],
    [X + GRID, Z + GRID],
    [X, Z + GRID],
  ];
  let best = Infinity;
  let bi = -1;
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) & 3];
    const t = rayTri(ox, oy, oz, dx, dy, dz, a[0], Y, a[1], b[0], Y, b[1], apx, apy, apz, maxT);
    if (t < best) {
      best = t;
      bi = i;
    }
  }
  if (nOut && bi >= 0) {
    const s = CONE_H / 2;
    const n = [
      [0, 1, -s],
      [s, 1, 0],
      [0, 1, s],
      [-s, 1, 0],
    ][bi];
    const l = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    nOut[0] = n[0] / l;
    nOut[1] = n[1] / l;
    nOut[2] = n[2] / l;
  }
  return best;
}

export function rayPiece(p, ox, oy, oz, dx, dy, dz, maxT, nOut) {
  if (p.k === K_RAMP) return rayRamp(p, ox, oy, oz, dx, dy, dz, maxT, nOut);
  if (p.k === K_CONE) return rayCone(p, ox, oy, oz, dx, dy, dz, maxT, nOut);
  let best = Infinity;
  const boxes = p.boxes;
  for (let i = 0; i < boxes.length; i++) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, boxes[i], Math.min(best, maxT), tmpN);
    if (t < best) {
      best = t;
      if (nOut) {
        nOut[0] = tmpN[0];
        nOut[1] = tmpN[1];
        nOut[2] = tmpN[2];
      }
    }
  }
  return best;
}

export function pieceCenter(p) {
  const b = pieceAABB(p);
  return [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
}

// --- Spatial grid ----------------------------------------------------------------
export class PieceGrid {
  constructor(terrain) {
    this.terrain = terrain;
    this.byId = new Map();
    this.bySlot = new Map();
    this.cells = new Map();
    this.stamp = 1;
    this.hitN = [0, 0, 0];
    this.hitPiece = null;
    this._aabb = new Array(6);
    this.version = 0;
  }

  get size() {
    return this.byId.size;
  }

  get(id) {
    return this.byId.get(id);
  }

  atSlot(k, x, y, z, o) {
    return this.bySlot.get(slotKey(k, x, y, z, o));
  }

  add(p) {
    p.slot = slotKey(p.k, p.x, p.y, p.z, p.o);
    if (this.bySlot.has(p.slot)) return false;
    p.aabb = pieceAABB(p, new Array(6));
    p.boxes = computeBoxes(p);
    p._s = 0;
    p.grounded = p.anchored || this.touchesTerrain(p);
    this.byId.set(p.id, p);
    this.bySlot.set(p.slot, p);
    const a = p.aabb;
    const cx0 = Math.floor((a[0] + 0.02) / GRID), cx1 = Math.floor((a[3] - 0.02) / GRID);
    const cy0 = Math.floor((a[1] + 0.02) / LEVEL), cy1 = Math.floor((a[4] - 0.02) / LEVEL);
    const cz0 = Math.floor((a[2] + 0.02) / GRID), cz1 = Math.floor((a[5] - 0.02) / GRID);
    p.cells = [];
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cz = cz0; cz <= cz1; cz++) {
          const key = cellKey(cx, cy, cz);
          let arr = this.cells.get(key);
          if (!arr) {
            arr = [];
            this.cells.set(key, arr);
          }
          arr.push(p);
          p.cells.push(key);
        }
    this.version++;
    return true;
  }

  remove(id) {
    const p = this.byId.get(id);
    if (!p) return null;
    this.byId.delete(id);
    this.bySlot.delete(p.slot);
    for (const key of p.cells) {
      const arr = this.cells.get(key);
      if (!arr) continue;
      const i = arr.indexOf(p);
      if (i >= 0) {
        arr[i] = arr[arr.length - 1];
        arr.pop();
      }
      if (!arr.length) this.cells.delete(key);
    }
    this.version++;
    return p;
  }

  // Re-key a piece (client temp id -> server id)
  rekey(oldId, newId) {
    const p = this.byId.get(oldId);
    if (!p) return null;
    this.byId.delete(oldId);
    p.id = newId;
    this.byId.set(newId, p);
    return p;
  }

  touchesTerrain(p) {
    const a = p.aabb || pieceAABB(p, this._aabb);
    const t = this.terrain.maxOver(a[0], a[2], a[3], a[5]);
    return a[1] <= t + 0.35;
  }

  // Iterate unique pieces overlapping box
  query(minx, miny, minz, maxx, maxy, maxz, fn) {
    const s = ++this.stamp;
    const cx0 = Math.floor(minx / GRID), cx1 = Math.floor(maxx / GRID);
    const cy0 = Math.floor(miny / LEVEL), cy1 = Math.floor(maxy / LEVEL);
    const cz0 = Math.floor(minz / GRID), cz1 = Math.floor(maxz / GRID);
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cz = cz0; cz <= cz1; cz++)
        for (let cy = cy0; cy <= cy1; cy++) {
          const arr = this.cells.get(cellKey(cx, cy, cz));
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            const p = arr[i];
            if (p._s === s) continue;
            p._s = s;
            if (fn(p) === true) return;
          }
        }
  }

  neighbors(p, out = []) {
    const a = p.aabb || pieceAABB(p, this._aabb);
    const e = 0.06;
    this.query(a[0] - e, a[1] - e, a[2] - e, a[3] + e, a[4] + e, a[5] + e, (q) => {
      if (q === p) return;
      const b = q.aabb;
      if (b[0] <= a[3] + e && b[3] >= a[0] - e && b[1] <= a[4] + e && b[4] >= a[1] - e && b[2] <= a[5] + e && b[5] >= a[2] - e)
        out.push(q);
    });
    return out;
  }

  // For a prospective (not yet added) piece
  isSupported(p) {
    const a = pieceAABB(p, new Array(6));
    const t = this.terrain.maxOver(a[0], a[2], a[3], a[5]);
    if (a[1] <= t + 0.35) return true;
    const e = 0.06;
    let found = false;
    this.query(a[0] - e, a[1] - e, a[2] - e, a[3] + e, a[4] + e, a[5] + e, (q) => {
      const b = q.aabb;
      if (b[0] <= a[3] + e && b[3] >= a[0] - e && b[1] <= a[4] + e && b[4] >= a[1] - e && b[2] <= a[5] + e && b[5] >= a[2] - e) {
        found = true;
        return true;
      }
    });
    return found;
  }

  // After removing `removed` (already taken out of the grid), find pieces that lost support.
  findUnsupported(removed) {
    const starts = [];
    // neighbors of the removed piece (query by its aabb)
    const a = removed.aabb;
    const e = 0.06;
    this.query(a[0] - e, a[1] - e, a[2] - e, a[3] + e, a[4] + e, a[5] + e, (q) => {
      const b = q.aabb;
      if (b[0] <= a[3] + e && b[3] >= a[0] - e && b[1] <= a[4] + e && b[4] >= a[1] - e && b[2] <= a[5] + e && b[5] >= a[2] - e)
        starts.push(q);
    });
    const doomed = [];
    const checked = new Set();
    for (const s of starts) {
      if (checked.has(s.id)) continue;
      // BFS
      const seen = new Set([s.id]);
      const queue = [s];
      let grounded = false;
      let qi = 0;
      while (qi < queue.length) {
        const cur = queue[qi++];
        if (cur.grounded) {
          grounded = true;
          break;
        }
        if (queue.length > 1200) {
          grounded = true;
          break;
        }
        const nb = this.neighbors(cur);
        for (const n of nb) {
          if (!seen.has(n.id)) {
            seen.add(n.id);
            queue.push(n);
          }
        }
      }
      for (const id of seen) checked.add(id);
      if (!grounded) for (const q of queue) doomed.push(q);
    }
    return doomed;
  }

  // Nearest hit along ray; returns t (Infinity if none); sets this.hitPiece & this.hitN
  raycast(ox, oy, oz, dx, dy, dz, maxT, ignoreId = null) {
    this.hitPiece = null;
    if (this.cells.size === 0) return Infinity;
    const s = ++this.stamp;
    let cx = Math.floor(ox / GRID);
    let cy = Math.floor(oy / LEVEL);
    let cz = Math.floor(oz / GRID);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tdx = Math.abs(dx) > 1e-9 ? GRID / Math.abs(dx) : Infinity;
    const tdy = Math.abs(dy) > 1e-9 ? LEVEL / Math.abs(dy) : Infinity;
    const tdz = Math.abs(dz) > 1e-9 ? GRID / Math.abs(dz) : Infinity;
    let tmx = Math.abs(dx) > 1e-9 ? ((cx + (dx > 0 ? 1 : 0)) * GRID - ox) / dx : Infinity;
    let tmy = Math.abs(dy) > 1e-9 ? ((cy + (dy > 0 ? 1 : 0)) * LEVEL - oy) / dy : Infinity;
    let tmz = Math.abs(dz) > 1e-9 ? ((cz + (dz > 0 ? 1 : 0)) * GRID - oz) / dz : Infinity;
    let best = maxT;
    let bestP = null;
    const n = this.hitN;
    const tn = [0, 0, 0];
    for (let guard = 0; guard < 2000; guard++) {
      const arr = this.cells.get(cellKey(cx, cy, cz));
      if (arr) {
        for (let i = 0; i < arr.length; i++) {
          const p = arr[i];
          if (p._s === s) continue;
          p._s = s;
          if (p.id === ignoreId) continue;
          const t = rayPiece(p, ox, oy, oz, dx, dy, dz, best, tn);
          if (t < best) {
            best = t;
            bestP = p;
            n[0] = tn[0];
            n[1] = tn[1];
            n[2] = tn[2];
          }
        }
      }
      const tnext = Math.min(tmx, tmy, tmz);
      if (bestP && best <= tnext) break;
      if (tnext > best) break;
      if (tmx <= tmy && tmx <= tmz) {
        cx += stepX;
        tmx += tdx;
      } else if (tmy <= tmz) {
        cy += stepY;
        tmy += tdy;
      } else {
        cz += stepZ;
        tmz += tdz;
      }
    }
    this.hitPiece = bestP;
    return bestP ? best : Infinity;
  }
}
