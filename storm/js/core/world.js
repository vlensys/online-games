// World = terrain + build pieces + props, with collision & raycast queries.
// Both the host simulation and every client keep one (clients update theirs from events).
import { CHAR, GRID, WORLD_HALF, WATER_Y } from './config.js';
import { PieceGrid, K_RAMP, K_CONE, K_WALL, K_FLOOR, slopeHeight, RAMP_T, rayBox } from './pieces.js';
import { PROP_TYPES, propShapes } from './props.js';

const PCELL = 16;
const HIT_NONE = 0;
export const HIT_TERRAIN = 1;
export const HIT_PIECE = 2;
export const HIT_PROP = 3;
export const HIT_WATER = 4;

function pkey(cx, cz) {
  return ((cx + 128) * 256 + (cz + 128)) | 0;
}

export class World {
  constructor(map) {
    this.map = map;
    this.terrain = map.terrain;
    this.pieces = new PieceGrid(this.terrain);
    for (const p of map.pieces) this.pieces.add({ ...p });
    this.props = [];
    this.propById = new Map();
    this.propCells = new Map();
    this.propStamp = 1;
    for (const src of map.props) this.addProp({ ...src });
    this.hit = { t: Infinity, kind: HIT_NONE, piece: null, prop: null, nx: 0, ny: 1, nz: 0, x: 0, y: 0, z: 0 };
    this._n = [0, 0, 0];
  }

  addProp(p) {
    const def = PROP_TYPES[p.type];
    p.alive = p.alive !== false;
    if (p.hp === undefined) p.hp = def.hp;
    p.shapes = propShapes(p, 'shapes');
    p.hitShapes = def.hit ? propShapes(p, 'hit') : p.shapes;
    let rad = 1;
    for (const s of p.hitShapes) rad = Math.max(rad, Math.abs(s.x - p.x) + Math.abs(s.z - p.z) + s.r);
    p.brad = rad;
    this.props.push(p);
    this.propById.set(p.id, p);
    const cx0 = Math.floor((p.x - rad) / PCELL), cx1 = Math.floor((p.x + rad) / PCELL);
    const cz0 = Math.floor((p.z - rad) / PCELL), cz1 = Math.floor((p.z + rad) / PCELL);
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cz = cz0; cz <= cz1; cz++) {
        const k = pkey(cx, cz);
        let a = this.propCells.get(k);
        if (!a) this.propCells.set(k, (a = []));
        a.push(p);
      }
  }

  killProp(id) {
    const p = this.propById.get(id);
    if (!p || !p.alive) return null;
    p.alive = false;
    p.hp = 0;
    return p;
  }

  queryProps(x0, z0, x1, z1, fn) {
    const s = ++this.propStamp;
    const cx0 = Math.floor(x0 / PCELL), cx1 = Math.floor(x1 / PCELL);
    const cz0 = Math.floor(z0 / PCELL), cz1 = Math.floor(z1 / PCELL);
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cz = cz0; cz <= cz1; cz++) {
        const a = this.propCells.get(pkey(cx, cz));
        if (!a) continue;
        for (let i = 0; i < a.length; i++) {
          const p = a[i];
          if (p._s === s || !p.alive) continue;
          p._s = s;
          if (fn(p) === true) return;
        }
      }
  }

  // Highest standable surface at (x,z) that is at most `feetY + step`. Terrain always counts.
  groundAt(x, z, feetY, r = CHAR.radius, depth = 2.6) {
    let best = this.terrain.heightAt(x, z);
    this.groundKind = 0; // 0 terrain, 1 piece, 2 prop
    this.groundMat = -1;
    const lim = feetY + CHAR.step;
    if (best > lim) return best; // buried: terrain wins
    const rr = r * 0.8;
    this.pieces.query(x - r, feetY - depth, z - r, x + r, lim + 0.05, z + r, (p) => {
      if (p.k === K_RAMP || p.k === K_CONE) {
        for (let s = 0; s < 5; s++) {
          const sx = s === 1 ? x + rr : s === 2 ? x - rr : x;
          const sz = s === 3 ? z + rr : s === 4 ? z - rr : z;
          const h = slopeHeight(p, sx, sz);
          if (h <= lim && h > best) {
            best = h;
            this.groundKind = 1;
            this.groundMat = p.m;
          }
        }
      } else {
        const bs = p.boxes;
        for (let i = 0; i < bs.length; i++) {
          const b = bs[i];
          const top = b[4];
          if (top > lim || top <= best) continue;
          if (x + rr < b[0] || x - rr > b[3] || z + rr < b[2] || z - rr > b[5]) continue;
          best = top;
          this.groundKind = 1;
          this.groundMat = p.m;
        }
      }
    });
    this.queryProps(x - r - 4, z - r - 4, x + r + 4, z + r + 4, (p) => {
      for (const sh of p.shapes) {
        if (!sh.stand) continue;
        const top = sh.y1;
        if (top > lim || top <= best || top < feetY - depth) continue;
        if (this._circleShape(x, z, rr, sh)) {
          best = top;
          this.groundKind = 2;
          this.groundMat = PROP_TYPES[p.type].mat;
        }
      }
    });
    return best;
  }

  // Tallest surface below a point (for "height above ground" while skydiving)
  surfaceBelow(x, z, y) {
    const t = this.terrain.heightAt(x, z);
    if (y - t > 70) return t;
    return this.groundAt(x, z, y - CHAR.step, CHAR.radius, Math.max(2.6, y - t + 1));
  }

  _circleShape(x, z, r, sh) {
    if (sh.t === 'cyl') {
      const dx = x - sh.x;
      const dz = z - sh.z;
      const rr = r + sh.r;
      return dx * dx + dz * dz < rr * rr;
    }
    const dx = x - sh.x;
    const dz = z - sh.z;
    const lx = dx * sh.c - dz * sh.sn;
    const lz = dx * sh.sn + dz * sh.c;
    return Math.abs(lx) < sh.hx + r && Math.abs(lz) < sh.hz + r;
  }

  // Lowest ceiling above headY (Infinity if none)
  ceilingAt(x, z, headY, r = CHAR.radius) {
    let best = Infinity;
    const rr = r * 0.7;
    this.pieces.query(x - r, headY - 0.6, z - r, x + r, headY + 3, z + r, (p) => {
      if (p.k === K_RAMP || p.k === K_CONE) {
        const h = slopeHeight(p, x, z);
        if (h === -Infinity) return;
        const under = p.k === K_RAMP ? h - RAMP_T : p.y * 4 - 0.3;
        if (under >= headY - 0.5 && under < best) best = under;
      } else {
        for (const b of p.boxes) {
          if (b[1] < headY - 0.5 || b[1] >= best) continue;
          if (x + rr < b[0] || x - rr > b[3] || z + rr < b[2] || z - rr > b[5]) continue;
          best = b[1];
        }
      }
    });
    this.queryProps(x - 5, z - 5, x + 5, z + 5, (p) => {
      for (const sh of p.shapes) {
        if (sh.y0 < headY - 0.5 || sh.y0 >= best) continue;
        if (this._circleShape(x, z, rr, sh)) best = sh.y0;
      }
    });
    return best;
  }

  // Does a ramp/cone surface cut through the body at (x,z)?
  slopeBlocks(x, z, feetY, headY) {
    let blocked = false;
    const lim = feetY + CHAR.step;
    this.pieces.query(x - 0.01, feetY, z - 0.01, x + 0.01, headY, z + 0.01, (p) => {
      if (p.k !== K_RAMP && p.k !== K_CONE) return;
      const h = slopeHeight(p, x, z);
      if (h === -Infinity) return;
      const under = p.k === K_RAMP ? h - RAMP_T : p.y * 4 - 0.3;
      if (h > lim && under < headY) {
        blocked = true;
        return true;
      }
    });
    return blocked;
  }

  // Push a character circle out of walls/boxes/props. Returns [x,z] (in this._n) and count of contacts.
  pushOut(x, z, feetY, headY, r = CHAR.radius, noTrees = false) {
    const lim = feetY + CHAR.step;
    let contacts = 0;
    let hitPiece = null;
    let hitProp = null;
    for (let iter = 0; iter < 2; iter++) {
      this.pieces.query(x - r, lim, z - r, x + r, headY, z + r, (p) => {
        if (p.k !== K_WALL && p.k !== K_FLOOR) return;
        const bs = p.boxes;
        for (let i = 0; i < bs.length; i++) {
          const b = bs[i];
          if (b[4] <= lim || b[1] >= headY) continue;
          const cx = x < b[0] ? b[0] : x > b[3] ? b[3] : x;
          const cz = z < b[2] ? b[2] : z > b[5] ? b[5] : z;
          const dx = x - cx;
          const dz = z - cz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;
          contacts++;
          hitPiece = p;
          if (d2 > 1e-8) {
            const d = Math.sqrt(d2);
            const push = (r - d) / d;
            x += dx * push;
            z += dz * push;
          } else {
            const l = x - b[0], rt = b[3] - x, bk = z - b[2], fr = b[5] - z;
            const m = Math.min(l, rt, bk, fr);
            if (m === l) x = b[0] - r;
            else if (m === rt) x = b[3] + r;
            else if (m === bk) z = b[2] - r;
            else z = b[5] + r;
          }
        }
      });
      this.queryProps(x - r - 5, z - r - 5, x + r + 5, z + r + 5, (p) => {
        if (noTrees && PROP_TYPES[p.type].tree) return;
        for (const sh of p.shapes) {
          if (sh.y1 <= lim || sh.y0 >= headY) continue;
          if (sh.t === 'cyl') {
            const dx = x - sh.x;
            const dz = z - sh.z;
            const rr = r + sh.r;
            const d2 = dx * dx + dz * dz;
            if (d2 >= rr * rr) continue;
            contacts++;
            hitProp = p;
            const d = Math.sqrt(d2) || 1e-4;
            x = sh.x + (dx / d) * rr;
            z = sh.z + (dz / d) * rr;
          } else {
            const dx = x - sh.x;
            const dz = z - sh.z;
            let lx = dx * sh.c - dz * sh.sn;
            let lz = dx * sh.sn + dz * sh.c;
            const cx = Math.max(-sh.hx, Math.min(sh.hx, lx));
            const cz = Math.max(-sh.hz, Math.min(sh.hz, lz));
            let ex = lx - cx;
            let ez = lz - cz;
            const d2 = ex * ex + ez * ez;
            if (d2 >= r * r) continue;
            contacts++;
            hitProp = p;
            if (d2 > 1e-8) {
              const d = Math.sqrt(d2);
              lx = cx + (ex / d) * r;
              lz = cz + (ez / d) * r;
            } else {
              const px = sh.hx - Math.abs(lx);
              const pz = sh.hz - Math.abs(lz);
              if (px < pz) lx = Math.sign(lx || 1) * (sh.hx + r);
              else lz = Math.sign(lz || 1) * (sh.hz + r);
            }
            x = sh.x + lx * sh.c + lz * sh.sn;
            z = sh.z - lx * sh.sn + lz * sh.c;
          }
        }
      });
      if (!contacts) break;
    }
    const lim2 = WORLD_HALF - 8;
    if (x > lim2) x = lim2;
    if (x < -lim2) x = -lim2;
    if (z > lim2) z = lim2;
    if (z < -lim2) z = -lim2;
    this._n[0] = x;
    this._n[1] = z;
    this.contactPiece = hitPiece;
    this.contactProp = hitProp;
    return contacts;
  }

  // Terrain ray march. Returns t or Infinity.
  rayTerrain(ox, oy, oz, dx, dy, dz, maxT) {
    const T = this.terrain;
    let t = 0;
    let prevT = 0;
    let h = T.heightAt(ox, oz);
    if (oy < h) return 0;
    for (let guard = 0; guard < 400 && t < maxT; guard++) {
      const y = oy + dy * t;
      h = T.heightAt(ox + dx * t, oz + dz * t);
      const gap = y - h;
      if (gap <= 0) {
        // refine
        let a = prevT;
        let b = t;
        for (let k = 0; k < 7; k++) {
          const m = (a + b) * 0.5;
          if (oy + dy * m - T.heightAt(ox + dx * m, oz + dz * m) > 0) a = m;
          else b = m;
        }
        return b;
      }
      if (dy > 0 && y > 140) return Infinity;
      prevT = t;
      let step = gap * 0.55;
      if (step < 0.8) step = 0.8;
      else if (step > 24) step = 24;
      t += step;
    }
    // final check at maxT
    const y = oy + dy * maxT;
    if (y < T.heightAt(ox + dx * maxT, oz + dz * maxT)) {
      let a = prevT;
      let b = maxT;
      for (let k = 0; k < 7; k++) {
        const m = (a + b) * 0.5;
        if (oy + dy * m - T.heightAt(ox + dx * m, oz + dz * m) > 0) a = m;
        else b = m;
      }
      return b;
    }
    return Infinity;
  }

  rayProps(ox, oy, oz, dx, dy, dz, maxT, noTrees = false) {
    this.hitProp = null;
    let best = maxT;
    let bestP = null;
    const n = this._n;
    // 2D DDA over prop cells
    let cx = Math.floor(ox / PCELL);
    let cz = Math.floor(oz / PCELL);
    const hl = Math.sqrt(dx * dx + dz * dz);
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tdx = Math.abs(dx) > 1e-9 ? PCELL / Math.abs(dx) : Infinity;
    const tdz = Math.abs(dz) > 1e-9 ? PCELL / Math.abs(dz) : Infinity;
    let tmx = Math.abs(dx) > 1e-9 ? ((cx + (dx > 0 ? 1 : 0)) * PCELL - ox) / dx : Infinity;
    let tmz = Math.abs(dz) > 1e-9 ? ((cz + (dz > 0 ? 1 : 0)) * PCELL - oz) / dz : Infinity;
    const s = ++this.propStamp;
    const vertical = hl < 1e-6;
    for (let guard = 0; guard < 300; guard++) {
      // test the 3x3 neighborhood lazily: props registered in all overlapped cells so own cell is enough
      const arr = this.propCells.get(pkey(cx, cz));
      if (arr) {
        for (let i = 0; i < arr.length; i++) {
          const p = arr[i];
          if (p._s === s || !p.alive) continue;
          p._s = s;
          if (noTrees && PROP_TYPES[p.type].tree) continue;
          for (const sh of p.hitShapes) {
            const t = rayShape(ox, oy, oz, dx, dy, dz, sh, best, n);
            if (t < best) {
              best = t;
              bestP = p;
              this.hit.nx = n[0];
              this.hit.ny = n[1];
              this.hit.nz = n[2];
            }
          }
        }
      }
      if (vertical) break;
      const tnext = Math.min(tmx, tmz);
      if (bestP && best <= tnext) break;
      if (tnext > best) break;
      if (tmx < tmz) {
        cx += stepX;
        tmx += tdx;
      } else {
        cz += stepZ;
        tmz += tdz;
      }
    }
    this.hitProp = bestP;
    return bestP ? best : Infinity;
  }

  // Full raycast. mask bits: 1 terrain, 2 pieces, 4 props, 8 water, 16 (with 4) skip trees
  raycast(ox, oy, oz, dx, dy, dz, maxT, mask = 7, ignorePiece = null) {
    const hit = this.hit;
    hit.t = Infinity;
    hit.kind = HIT_NONE;
    hit.piece = null;
    hit.prop = null;
    let best = maxT;
    if (mask & 2) {
      const t = this.pieces.raycast(ox, oy, oz, dx, dy, dz, best, ignorePiece);
      if (t < best) {
        best = t;
        hit.kind = HIT_PIECE;
        hit.piece = this.pieces.hitPiece;
        hit.nx = this.pieces.hitN[0];
        hit.ny = this.pieces.hitN[1];
        hit.nz = this.pieces.hitN[2];
      }
    }
    if (mask & 4) {
      const t = this.rayProps(ox, oy, oz, dx, dy, dz, best, (mask & 16) !== 0);
      if (t < best) {
        best = t;
        hit.kind = HIT_PROP;
        hit.piece = null;
        hit.prop = this.hitProp;
      }
    }
    if (mask & 1) {
      const t = this.rayTerrain(ox, oy, oz, dx, dy, dz, best);
      if (t < best) {
        best = t;
        hit.kind = HIT_TERRAIN;
        hit.piece = null;
        hit.prop = null;
        this.terrain.normalAt(ox + dx * t, oz + dz * t, this._n);
        hit.nx = this._n[0];
        hit.ny = this._n[1];
        hit.nz = this._n[2];
      }
    }
    if (mask & 8 && dy < 0) {
      const t = (WATER_Y - oy) / dy;
      if (t >= 0 && t < best) {
        best = t;
        hit.kind = HIT_WATER;
        hit.piece = null;
        hit.prop = null;
        hit.nx = 0;
        hit.ny = 1;
        hit.nz = 0;
      }
    }
    if (hit.kind !== HIT_NONE) {
      hit.t = best;
      hit.x = ox + dx * best;
      hit.y = oy + dy * best;
      hit.z = oz + dz * best;
    }
    return hit;
  }

  // Line of sight between two points (true = clear)
  los(ax, ay, az, bx, by, bz, mask = 7) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 0.01) return true;
    const h = this.raycast(ax, ay, az, dx / d, dy / d, dz / d, d - 0.25, mask);
    return h.kind === HIT_NONE;
  }

  inBush(x, z, y) {
    let found = false;
    this.queryProps(x - 3, z - 3, x + 3, z + 3, (p) => {
      if (p.type !== 'bush') return;
      const dx = x - p.x;
      const dz = z - p.z;
      const r = PROP_TYPES.bush.hideR * p.s;
      if (dx * dx + dz * dz < r * r && y < p.y + 1.6 * p.s) {
        found = true;
        return true;
      }
    });
    return found;
  }
}

function rayShape(ox, oy, oz, dx, dy, dz, sh, maxT, n) {
  if (sh.t === 'cyl') {
    // ray vs vertical capped cylinder
    const px = ox - sh.x;
    const pz = oz - sh.z;
    const a = dx * dx + dz * dz;
    let tmin = 0;
    let tmax = maxT;
    let side = true;
    if (a > 1e-12) {
      const b = 2 * (px * dx + pz * dz);
      const c = px * px + pz * pz - sh.r * sh.r;
      const disc = b * b - 4 * a * c;
      if (disc < 0) return Infinity;
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / (2 * a);
      const t2 = (-b + sq) / (2 * a);
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    } else if (px * px + pz * pz > sh.r * sh.r) return Infinity;
    if (Math.abs(dy) > 1e-9) {
      let t1 = (sh.y0 - oy) / dy;
      let t2 = (sh.y1 - oy) / dy;
      if (t1 > t2) {
        const tt = t1;
        t1 = t2;
        t2 = tt;
      }
      if (t1 > tmin) {
        tmin = t1;
        side = false;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    } else if (oy < sh.y0 || oy > sh.y1) return Infinity;
    if (side) {
      const hx = px + dx * tmin;
      const hz = pz + dz * tmin;
      const l = Math.sqrt(hx * hx + hz * hz) || 1;
      n[0] = hx / l;
      n[1] = 0;
      n[2] = hz / l;
    } else {
      n[0] = 0;
      n[1] = dy < 0 ? 1 : -1;
      n[2] = 0;
    }
    return tmin;
  }
  // rotated box: transform to local
  const rx = ox - sh.x;
  const rz = oz - sh.z;
  const lox = rx * sh.c - rz * sh.sn;
  const loz = rx * sh.sn + rz * sh.c;
  const ldx = dx * sh.c - dz * sh.sn;
  const ldz = dx * sh.sn + dz * sh.c;
  const b = [-sh.hx, sh.y0, -sh.hz, sh.hx, sh.y1, sh.hz];
  const t = rayBox(lox, oy, loz, ldx, dy, ldz, b, maxT, n);
  if (t < Infinity) {
    const nx = n[0];
    const nz = n[2];
    n[0] = nx * sh.c + nz * sh.sn;
    n[2] = -nx * sh.sn + nz * sh.c;
  }
  return t;
}

export { GRID };
