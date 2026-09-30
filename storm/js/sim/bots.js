// Bot players. Each bot "thinks" a few times per second (staggered) and steers every tick.
// Behaviour: pick a drop spot -> skydive -> loot (doors/stairs aware) -> heal -> harvest
// -> rotate ahead of the storm -> fight (aim error, reaction time, strafing, bursts),
// build cover / box up when shot, ramp-rush high ground, break through walls when stuck.
import * as C from '../core/config.js';
import { makeInput, eyeY, M_BUS, M_FALL, M_GLIDE, M_GROUND, M_SWIM } from '../core/physics.js';
import { weaponScore } from '../core/items.js';
import { wrapAngle } from '../core/combat.js';
import { buildTarget, placeCheck } from '../core/buildtarget.js';
import { K_WALL, K_FLOOR, K_RAMP, K_CONE, DIRS as DIRS4 } from '../core/pieces.js';
import { outsideStorm } from '../core/storm.js';
import { PROP_TYPES } from '../core/props.js';

const DEG = Math.PI / 180;
const DIR_YAW = [-Math.PI / 2, Math.PI, Math.PI / 2, 0]; // yaw facing +x, +z, -x, -z

// ------------------------------------------------------------------ navigation helpers
function buildingIndex(map) {
  if (map._bidx) return map._bidx;
  const idx = new Map();
  map.buildings.forEach((b) => {
    for (let x = Math.floor(b.x0 / 16); x <= Math.floor(b.x1 / 16); x++)
      for (let z = Math.floor(b.z0 / 16); z <= Math.floor(b.z1 / 16); z++) {
        const k = (x + 100) * 1000 + z + 100;
        let a = idx.get(k);
        if (!a) idx.set(k, (a = []));
        a.push(b);
      }
  });
  map._bidx = idx;
  return idx;
}

export function buildingAt(map, x, y, z) {
  const a = buildingIndex(map).get((Math.floor(x / 16) + 100) * 1000 + Math.floor(z / 16) + 100);
  if (!a) return null;
  for (const b of a) {
    if (x < b.x0 + 0.15 || x > b.x1 - 0.15 || z < b.z0 + 0.15 || z > b.z1 - 0.15) continue;
    const base = b.L * C.LEVEL;
    if (y < base - 1.2 || y > (b.L + b.levels) * C.LEVEL - 0.4) continue;
    const lvl = Math.max(0, Math.min(b.levels - 1, Math.floor((y - base + 1.2) / C.LEVEL)));
    return { b, lvl };
  }
  return null;
}

// Cell graph of one building from its current pieces: floors per level, walls (doors are
// passable, windows are not), ramps linking their low-end cell to the cell above their top.
function navGraph(world, b) {
  const P = world.pieces;
  const G = C.GRID;
  const cx0 = Math.round(b.x0 / G);
  const cz0 = Math.round(b.z0 / G);
  const W = Math.round((b.x1 - b.x0) / G);
  const D = Math.round((b.z1 - b.z0) / G);
  const LV = b.levels;
  const N = W * D * LV;
  const OUT = N;
  const id = (i, j, l) => (l * D + j) * W + i;
  const adj = [];
  for (let n = 0; n <= N; n++) adj.push([]);
  const walk = new Uint8Array(N);
  const ramps = [];
  const door = new Map(); // node -> [outer x, outer z]
  for (let l = 0; l < LV; l++)
    for (let j = 0; j < D; j++)
      for (let i = 0; i < W; i++) {
        const X = cx0 + i;
        const Z = cz0 + j;
        const Y = b.L + l;
        const r = P.atSlot(K_RAMP, X, Y, Z, 0);
        if (r) {
          ramps.push([i, j, l, r]);
          continue;
        }
        if (l === 0 || P.atSlot(K_FLOOR, X, Y, Z, 0)) walk[id(i, j, l)] = 1;
      }
  const open = (X, Y, Z, o) => {
    const w = P.atSlot(0, X, Y, Z, o);
    return !w || (w.v | 0) === 1;
  };
  const link = (a, c) => {
    adj[a].push(c);
    adj[c].push(a);
  };
  for (let l = 0; l < LV; l++) {
    const Y = b.L + l;
    for (let j = 0; j < D; j++)
      for (let i = 0; i < W; i++) {
        const a = id(i, j, l);
        if (!walk[a]) continue;
        if (i + 1 < W && walk[id(i + 1, j, l)] && open(cx0 + i + 1, Y, cz0 + j, 0)) link(a, id(i + 1, j, l));
        if (j + 1 < D && walk[id(i, j + 1, l)] && open(cx0 + i, Y, cz0 + j + 1, 1)) link(a, id(i, j + 1, l));
        if (l !== 0) continue;
        const cx = (cx0 + i) * G + 2;
        const cz = (cz0 + j) * G + 2;
        let d = null;
        if (i === 0 && open(cx0, Y, cz0 + j, 0)) d = [cx0 * G - 2.2, cz];
        else if (i === W - 1 && open(cx0 + W, Y, cz0 + j, 0)) d = [(cx0 + W) * G + 2.2, cz];
        else if (j === 0 && open(cx0 + i, Y, cz0, 1)) d = [cx, cz0 * G - 2.2];
        else if (j === D - 1 && open(cx0 + i, Y, cz0 + D, 1)) d = [cx, (cz0 + D) * G + 2.2];
        if (d) {
          door.set(a, d);
          link(a, OUT);
        }
      }
  }
  for (const [i, j, l, r] of ramps) {
    const n = id(i, j, l);
    const dx = DIRS4[r.o & 3][0];
    const dz = DIRS4[r.o & 3][1];
    const li = i - dx;
    const lj = j - dz;
    const hi = i + dx;
    const hj = j + dz;
    const Y = b.L + l;
    const X = cx0 + i;
    const Z = cz0 + j;
    // wall between two x/z-adjacent cells (a -> a+d)
    const between = (ai, aj, bi, bj, YY) => {
      if (ai !== bi) return open(cx0 + Math.max(ai, bi), YY, cz0 + aj, 0);
      return open(cx0 + ai, YY, cz0 + Math.max(aj, bj), 1);
    };
    if (li >= 0 && li < W && lj >= 0 && lj < D && walk[id(li, lj, l)] && between(li, lj, i, j, Y)) link(id(li, lj, l), n);
    if (l + 1 < LV && hi >= 0 && hi < W && hj >= 0 && hj < D && walk[id(hi, hj, l + 1)] && between(i, j, hi, hj, Y + 1)) link(n, id(hi, hj, l + 1));
    void X;
    void Z;
  }
  return { W, D, LV, cx0, cz0, adj, walk, OUT, door, id };
}

function bfs(g, from, to) {
  if (from === to) return [from];
  const prev = new Int32Array(g.adj.length).fill(-2);
  prev[from] = -1;
  const q = [from];
  for (let qi = 0; qi < q.length; qi++) {
    const n = q[qi];
    for (const m of g.adj[n]) {
      if (prev[m] !== -2) continue;
      prev[m] = n;
      if (m === to) {
        const path = [m];
        let k = n;
        while (k !== -1) {
          path.push(k);
          k = prev[k];
        }
        return path.reverse();
      }
      q.push(m);
    }
  }
  return null;
}

function nodeOf(g, b, x, y, z) {
  const i = Math.max(0, Math.min(g.W - 1, Math.floor(x / C.GRID) - g.cx0));
  const j = Math.max(0, Math.min(g.D - 1, Math.floor(z / C.GRID) - g.cz0));
  const l = Math.max(0, Math.min(g.LV - 1, Math.floor((y - b.L * C.LEVEL + 1.2) / C.LEVEL)));
  return g.id(i, j, l);
}

// append waypoints for a node path (OUT = outside)
function emit(g, path, w) {
  for (let k = 0; k < path.length; k++) {
    const n = path[k];
    if (n === g.OUT) {
      // leaving: previous node was the door cell
      if (k > 0) {
        const d = g.door.get(path[k - 1]);
        if (d) w.push(d);
      }
      continue;
    }
    if (k > 0 && path[k - 1] === g.OUT) {
      const d = g.door.get(n);
      if (d) w.push(d);
    }
    const i = n % g.W;
    const j = Math.floor(n / g.W) % g.D;
    w.push([(g.cx0 + i) * C.GRID + 2, (g.cz0 + j) * C.GRID + 2]);
  }
}

// Waypoints [[x,z], ...] from a character position to a target (null if unreachable)
export function planPath(world, from, to) {
  const map = world.map;
  const A = buildingAt(map, from.x, from.y, from.z);
  const B = buildingAt(map, to.x, to.y, to.z);
  const w = [];
  if (A && B && A.b === B.b) {
    const g = navGraph(world, A.b);
    const p = bfs(g, nodeOf(g, A.b, from.x, from.y, from.z), nodeOf(g, A.b, to.x, to.y, to.z));
    if (!p) return null;
    emit(g, p.slice(1), w);
  } else {
    if (A) {
      const g = navGraph(world, A.b);
      const p = bfs(g, nodeOf(g, A.b, from.x, from.y, from.z), g.OUT);
      if (p) emit(g, p.slice(1), w);
    }
    if (B) {
      const g = navGraph(world, B.b);
      const p = bfs(g, g.OUT, nodeOf(g, B.b, to.x, to.y, to.z));
      if (!p) return null;
      emit(g, p, w);
    }
  }
  w.push([to.x, to.z]);
  return w;
}

function consumableNeed(p, t) {
  const d = C.CONSUMABLES[t];
  if (d.hp) return p.hp < d.hpMax - 5;
  return p.sh < d.shMax - 5;
}

// ------------------------------------------------------------------ brain
export class BotBrain {
  constructor(sv, p, diff, rng) {
    this.sv = sv;
    this.p = p;
    this.rng = rng;
    this.d = C.DIFFICULTY[diff] || C.DIFFICULTY[1];
    this.inp = makeInput();
    this.state = 'bus';
    this.thinkT = rng.float(0, 0.3);
    this.pers = { aggro: rng.float(0.25, 1), builder: rng.float(0.45, 1), looter: rng.float(0.3, 1) };
    this.goal = null;
    this.path = [];
    this.target = null;
    this.targetSeenT = -99;
    this.targetFirstT = 0;
    this.reactT = 0;
    this.lastKnown = { x: 0, y: 0, z: 0 };
    this.blockedByPiece = null;
    this.errY = 0;
    this.errP = 0;
    this.errTY = 0;
    this.errTP = 0;
    this.strafe = 0;
    this.strafeT = 0;
    this.burst = 0;
    this.burstLen = 6;
    this.burstPauseT = 0;
    this.buildCD = 0;
    this.buildingNow = false;
    this.rampRushT = 0;
    this.stuck = 0;
    this.progT = 0;
    this.progX = 0;
    this.progZ = 0;
    this.blockPiece = null;
    this.blockProp = null;
    this.blockT = -9;
    this.breakObj = null;
    this.breakUntil = 0;
    this.blacklist = new Map();
    this.lastDamageT = -99;
    this.attacker = null;
    this.wantMove = false;
    this.switchT = 0;
    this.lootUntil = 0;
    this.holdT = 0;
    this.zoneKey = '';
    this.zoneGoal = null;
    this.boxedUntil = 0;
    this.jumpReq = false;
    this.detourT = 0;
    this.detourX = 0;
    this.detourZ = 0;
    this.noise = null;
    this.dropX = 0;
    this.dropZ = 0;
    this.dropT = 0;
    this.chooseDrop();
  }

  chooseDrop() {
    const sv = this.sv;
    const map = sv.map;
    const bus = sv.bus;
    const rng = this.rng;
    const bdx = bus.ex - bus.sx;
    const bdz = bus.ez - bus.sz;
    const L = Math.sqrt(bdx * bdx + bdz * bdz);
    const ux = bdx / L;
    const uz = bdz / L;
    const claims = sv.dropClaims || (sv.dropClaims = new Map());
    const nb = sv.plist.length;
    const cap = Math.max(2, Math.ceil((nb * 0.62) / Math.max(1, map.pois.length)));
    for (let k = 0; k < 24; k++) {
      let x;
      let z;
      let poiName = null;
      if (rng.chance(0.62) && map.pois.length) {
        const poi = rng.pick(map.pois);
        if ((claims.get(poi.name) || 0) >= cap && k < 18) continue;
        poiName = poi.name;
        const a = rng.float(0, Math.PI * 2);
        const r = rng.float(0, poi.r * 0.8);
        x = poi.x + Math.cos(a) * r;
        z = poi.z + Math.sin(a) * r;
      } else {
        const s = rng.pick(rng.chance(0.5) && map.chests.length ? map.chests : map.spots);
        x = s.x;
        z = s.z;
      }
      const rx = x - bus.sx;
      const rz = z - bus.sz;
      const along = rx * ux + rz * uz;
      const perp = Math.abs(rx * uz - rz * ux);
      if (perp > 230 || along < 30 || along > L - 10) continue;
      if (map.terrain.heightAt(x, z) < 0.8) continue;
      // keep lone drops away from other bots' spots
      if (!poiName && k < 18) {
        let near = false;
        for (const o of sv.plist) if (o.bot && o.bot !== this && o.bot.dropT && (o.bot.dropX - x) ** 2 + (o.bot.dropZ - z) ** 2 < 55 * 55) near = true;
        if (near) continue;
      }
      if (poiName) claims.set(poiName, (claims.get(poiName) || 0) + 1);
      this.dropX = x;
      this.dropZ = z;
      this.dropT = Math.max(bus.door + rng.float(0, 2.5), along / C.BUS_SPEED - perp / 130 - rng.float(0, 2));
      return;
    }
    this.dropT = rng.float(bus.door + 2, bus.dur - 2);
    const f = this.dropT / bus.dur;
    this.dropX = bus.sx + bdx * f;
    this.dropZ = bus.sz + bdz * f;
  }

  idle() {
    const i = this.inp;
    i.fwd = 0;
    i.right = 0;
    i.jump = false;
    i.sprint = false;
    i.ads = false;
    i.crouch = false;
    if (this.p.c.mode !== M_BUS && this.p.c.mode !== M_FALL && this.p.c.mode !== M_GLIDE) {
      const out = this.sv.stepOut;
      // keep physics settled (gravity) even when idle
      void out;
    }
  }

  update(dt) {
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT += this.rng.float(0.2, 0.32);
      this.think();
    }
    this.control(dt);
  }

  // Blocked by an outer wall of a map building on the way somewhere else: walk along the
  // building's face (toward the goal) until we are past its corner.
  startRectDetour(piece) {
    const sv = this.sv;
    const c = this.p.c;
    const px = piece.x * C.GRID + 2;
    const pz = piece.z * C.GRID + 2;
    const arr = buildingIndex(sv.map).get((Math.floor(px / 16) + 100) * 1000 + Math.floor(pz / 16) + 100);
    if (!arr) return;
    let B = null;
    for (const b of arr) if (px >= b.x0 - 1 && px <= b.x1 + 1 && pz >= b.z0 - 1 && pz <= b.z1 + 1) B = b;
    if (!B) return;
    if (c.x > B.x0 && c.x < B.x1 && c.z > B.z0 && c.z < B.z1) return; // inside: graph navigation handles it
    const g = this.goal;
    const wp = this.path && this.path.length === 1 && this.path[0];
    if (!wp) return;
    if (g && g.x > B.x0 && g.x < B.x1 && g.z > B.z0 && g.z < B.z1) return; // going into this building
    const gx = wp[0] - c.x;
    const gz = wp[1] - c.z;
    const m = 1.6;
    let tx = 0;
    let tz = 0;
    let end;
    if (c.x <= B.x0 || c.x >= B.x1) {
      tz = gz > 0 ? 1 : gz < 0 ? -1 : this.rng.chance(0.5) ? 1 : -1;
      end = tz > 0 ? B.z1 + m : B.z0 - m;
    } else {
      tx = gx > 0 ? 1 : gx < 0 ? -1 : this.rng.chance(0.5) ? 1 : -1;
      end = tx > 0 ? B.x1 + m : B.x0 - m;
    }
    this.rectDetour = { tx, tz, end, until: sv.t + 5, px: c.x, pz: c.z, pt: sv.t };
  }

  onStep(out) {
    if (out.blocked && out.blockPiece && out.blockPiece.map && !this.rectDetour && this.state !== 'fight' && this.p.c.mode === M_GROUND) this.startRectDetour(out.blockPiece);
    if (out.blocked) {
      if (out.blockPiece) {
        this.blockPiece = out.blockPiece;
        this.blockT = this.sv.t;
      }
      if (out.blockProp) {
        this.blockProp = out.blockProp;
        this.blockT = this.sv.t;
      }
    }
  }

  onDamaged(att, amount) {
    const sv = this.sv;
    const t = sv.t;
    const p = this.p;
    this.lastDamageT = t;
    this.attacker = att;
    if (!this.target || !this.target.alive || t - this.targetSeenT > 1.5) {
      this.target = att;
      this.targetFirstT = t;
      this.reactT = t + this.d.react * this.rng.float(0.5, 1.0);
      this.targetSeenT = t - 0.5;
      this.lastKnown.x = att.c.x;
      this.lastKnown.y = att.c.y;
      this.lastKnown.z = att.c.z;
      this.errTY = this.rng.float(-1, 1) * this.d.aim * 2.5 * DEG;
    }
    if (p.use && amount > 5 && t > this.boxedUntil) sv.cancelUse(p);
    if (p.c.mode !== M_GROUND || t < this.buildCD) return;
    const bchance = this.d.build * this.pers.builder;
    if (!this.rng.chance(bchance)) {
      this.buildCD = t + 1;
      return;
    }
    const tot = p.hp + p.sh;
    const mats = p.mats[0] + p.mats[1] + p.mats[2];
    if (tot < 85 && mats >= 50 && this.hasHeals() && this.rng.chance(0.6)) this.boxUp();
    else this.coverWall(att);
    this.buildCD = t + this.rng.float(1.4, 3) / Math.max(0.3, this.d.build);
  }

  // ---------------------------------------------------------------- inventory helpers
  weaponSlots() {
    const out = [];
    this.p.slots.forEach((s, i) => {
      if (s && C.isWeapon(s.t)) out.push(i);
    });
    return out;
  }

  hasHeals() {
    return this.p.slots.some((s) => s && C.isConsumable(s.t) && consumableNeed(this.p, s.t));
  }

  worstWeaponSlot() {
    let w = -1;
    let ws = Infinity;
    this.p.slots.forEach((s, i) => {
      if (s && C.isWeapon(s.t)) {
        const sc = weaponScore(s.t, s.r);
        if (sc < ws) {
          ws = sc;
          w = i;
        }
      }
    });
    return w;
  }

  ammoFor(s) {
    const w = C.WEAPONS[s.t];
    return s.n + this.p.ammo[w.ammo];
  }

  wants(it) {
    const p = this.p;
    const t = it.t;
    if (C.isWeapon(t)) {
      const sc = weaponScore(t, it.r);
      const ws = this.weaponSlots();
      for (const i of ws) {
        const s = p.slots[i];
        if (s.t === t && s.r >= it.r) return false;
      }
      const empty = p.slots.indexOf(null) >= 0;
      if (empty && ws.length < 3) return true;
      const worst = this.worstWeaponSlot();
      return worst >= 0 && sc > weaponScore(p.slots[worst].t, p.slots[worst].r) + 6;
    }
    if (C.isConsumable(t)) {
      const stack = C.CONSUMABLES[t].stack;
      if (p.slots.some((s) => s && s.t === t && s.n < stack)) return true;
      const cons = p.slots.filter((s) => s && C.isConsumable(s.t)).length;
      return p.slots.indexOf(null) >= 0 && cons < 2 && this.weaponSlots().length >= 1;
    }
    if (t.startsWith('a_')) {
      const k = t.slice(2);
      if (p.ammo[k] >= 90) return false;
      return p.slots.some((s) => s && C.WEAPONS[s.t] && C.WEAPONS[s.t].ammo === k);
    }
    if (t.startsWith('m_')) {
      const mi = ['wood', 'brick', 'metal'].indexOf(t.slice(2));
      return p.mats[mi] < 400;
    }
    return false;
  }

  botPickup(it) {
    const sv = this.sv;
    const p = this.p;
    if (C.isWeapon(it.t)) {
      // upgrade of a weapon we already carry: replace it
      const same = p.slots.findIndex((s) => s && s.t === it.t && s.r < it.r);
      if (same >= 0) {
        sv.setSlot(p, same + 1);
        sv.pickup(p, it, true);
        this.equipBest(40);
        return;
      }
    }
    if (C.isWeapon(it.t) && p.slots.indexOf(null) < 0) {
      const w = this.worstWeaponSlot();
      if (w < 0) return;
      sv.setSlot(p, w + 1);
    } else if (C.isConsumable(it.t) && p.slots.indexOf(null) < 0 && !p.slots.some((s) => s && s.t === it.t)) {
      let worst = -1;
      p.slots.forEach((s, i) => {
        if (s && C.isConsumable(s.t)) worst = i;
      });
      if (worst < 0) return;
      sv.setSlot(p, worst + 1);
    }
    sv.pickup(p, it);
    this.equipBest(40);
  }

  // Choose the best weapon for a distance (or general use)
  chooseWeapon(dist) {
    const p = this.p;
    let best = 0;
    let bs = dist < 2.8 ? 30 : 1;
    p.slots.forEach((s, i) => {
      if (!s || !C.isWeapon(s.t)) return;
      if (this.ammoFor(s) <= 0) return;
      let sc;
      switch (s.t) {
        case 'shotgun':
          sc = dist < 9 ? 100 : dist < 18 ? 45 : 4;
          break;
        case 'smg':
          sc = dist < 16 ? 82 : dist < 32 ? 58 : 18;
          break;
        case 'ar':
          sc = dist < 8 ? 55 : dist < 70 ? 90 : 62;
          break;
        case 'sniper':
          sc = dist > 45 ? 96 : dist > 22 ? 48 : 6;
          break;
        case 'pistol':
          sc = dist < 25 ? 48 : 22;
          break;
        case 'rocket':
          sc = dist > 10 && dist < 70 ? (this.blockedByPiece ? 99 : 66) : 0;
          break;
        default:
          sc = 10;
      }
      sc *= 1 + s.r * 0.08;
      if (s.n <= 0) sc *= 0.6;
      if (sc > bs) {
        bs = sc;
        best = i + 1;
      }
    });
    return best;
  }

  equipBest(dist) {
    const sv = this.sv;
    const p = this.p;
    if (p.use) return;
    const slot = this.chooseWeapon(dist);
    if (slot !== p.cur && sv.t > this.switchT) {
      sv.setSlot(p, slot);
      this.switchT = sv.t + 0.35;
      this.burst = 0;
    }
  }

  // ---------------------------------------------------------------- think
  think() {
    const sv = this.sv;
    const p = this.p;
    const c = p.c;
    const t = sv.t;
    if (c.mode === M_BUS) {
      if (t >= this.dropT) sv.jumpBus(p);
      return;
    }
    if (c.mode === M_FALL || c.mode === M_GLIDE) {
      this.state = 'drop';
      return;
    }
    if (this.state === 'bus' || this.state === 'drop') {
      this.state = 'loot';
      this.lootUntil = t + 30 + 55 * this.pers.looter;
      this.goal = null;
      this.path = [];
      this.progX = c.x;
      this.progZ = c.z;
      this.progT = t;
    }
    this.perceive(t);
    this.checkProgress(t);
    this.decide(t);
    // walked into (or out of) a building the current path didn't plan for: re-plan
    const g = this.goal;
    if (g && c.mode === M_GROUND) {
      const cb = buildingAt(this.sv.map, c.x, c.y, c.z);
      const nb = cb ? cb.b : null;
      if (nb !== g.inB) {
        g.inB = nb;
        const np = planPath(this.sv.world, c, g);
        if (np) this.path = np;
      }
    }
  }

  perceive(t) {
    const sv = this.sv;
    const p = this.p;
    const c = p.c;
    const d = this.d;
    const ex = c.x;
    const ey = eyeY(c);
    const ez = c.z;
    const fx = -Math.sin(c.yaw);
    const fz = -Math.cos(c.yaw);
    const cands = [];
    for (const o of sv.plist) {
      if (o === p || !o.alive || o.c.mode === M_BUS) continue;
      const dx = o.c.x - ex;
      const dz = o.c.z - ez;
      const dy = o.c.y + 1.2 - ey;
      const air = o.c.mode === M_FALL || o.c.mode === M_GLIDE;
      const vis = d.vision * (air ? 1.25 : 1);
      const d2 = dx * dx + dz * dz + dy * dy;
      if (d2 > vis * vis) continue;
      const dist = Math.sqrt(d2);
      const special = o === this.target || (o === this.attacker && t - this.lastDamageT < 3);
      if (!special && dist > 9) {
        const hl = Math.sqrt(dx * dx + dz * dz) || 1;
        if ((dx * fx + dz * fz) / hl < -0.25) continue;
        if (dist > 14 && o.c.mode === M_GROUND && sv.world.inBush(o.c.x, o.c.z, o.c.y)) continue;
      }
      let score = dist;
      if (o === this.attacker && t - this.lastDamageT < 3) score *= 0.35;
      if (o === this.target) score *= 0.6;
      cands.push([score, o, dist]);
    }
    cands.sort((a, b) => a[0] - b[0]);
    let best = null;
    this.blockedByPiece = null;
    for (let i = 0; i < cands.length && i < 4; i++) {
      const o = cands[i][1];
      if (sv.world.los(ex, ey, ez, o.c.x, o.c.y + 1.25, o.c.z, 7) || sv.world.los(ex, ey, ez, o.c.x, o.c.y + 1.7, o.c.z, 7)) {
        best = o;
        break;
      }
      if (o === this.target) {
        const h = sv.world.hit;
        if (h.kind === 2 && h.piece && !h.piece.map) this.blockedByPiece = h.piece;
      }
    }
    if (best) {
      if (best !== this.target) {
        this.target = best;
        this.targetFirstT = t;
        const surprised = best === this.attacker ? 0.6 : 1;
        const early = p.landedT < 0 || t - p.landedT < 60 ? 1.6 : 1;
        this.reactT = t + d.react * this.rng.float(0.7, 1.3) * surprised * early;
      }
      this.targetSeenT = t;
      this.lastKnown.x = best.c.x;
      this.lastKnown.y = best.c.y;
      this.lastKnown.z = best.c.z;
    } else if (this.target && (!this.target.alive || t - this.targetSeenT > 7)) {
      this.target = null;
    }
    if (this.target && !this.target.alive) this.target = null;
    // gunshots nearby (third-partying)
    this.noise = null;
    for (let i = sv.noises.length - 1; i >= 0; i--) {
      const n = sv.noises[i];
      if (t - n.t > 1.5) break;
      if (n.id === p.id) continue;
      const dd = (n.x - c.x) ** 2 + (n.z - c.z) ** 2;
      if (dd < 120 * 120) {
        this.noise = n;
        break;
      }
    }
  }

  checkProgress(t) {
    const c = this.p.c;
    if (t - this.progT < 1) return;
    const moved = Math.sqrt((c.x - this.progX) ** 2 + (c.z - this.progZ) ** 2);
    const trying = this.wantMove && c.mode === M_GROUND && !this.p.use;
    if (trying && moved < 0.9) this.stuck++;
    else if (moved > 2) this.stuck = 0;
    this.progX = c.x;
    this.progZ = c.z;
    this.progT = t;
    if (!this.stuck) return;
    if (this.stuck === 1 || this.stuck === 4) this.jumpReq = true;
    if (this.stuck === 2 && this.goal) {
      const np = planPath(this.sv.world, c, this.goal);
      if (np) this.path = np;
    }
    if (this.stuck === 2 || this.stuck === 5) {
      const a = this.rng.float(0, Math.PI * 2);
      this.detourX = Math.cos(a);
      this.detourZ = Math.sin(a);
      this.detourT = t + 1.1;
      this.jumpReq = true;
    }
    if (this.stuck >= 3 && t - this.blockT < 2 && !this.breakObj) {
      if (this.blockPiece && this.sv.world.pieces.get(this.blockPiece.id)) {
        this.breakObj = { kind: 'piece', ref: this.blockPiece };
        this.breakUntil = t + 5;
      } else if (this.blockProp && this.blockProp.alive && PROP_TYPES[this.blockProp.type].mat >= 0) {
        this.breakObj = { kind: 'prop', ref: this.blockProp };
        this.breakUntil = t + 5;
      }
    }
    if (this.stuck >= 7) {
      if (this.goal) this.ban(this.goal);
      this.goal = null;
      this.path = [];
      this.zoneGoal = null;
      this.stuck = 0;
    }
  }

  ban(g, dur = 25) {
    this.blacklist.set(g.kind + ':' + g.id, this.sv.t + dur);
  }

  banned(kind, id) {
    const u = this.blacklist.get(kind + ':' + id);
    return u !== undefined && u > this.sv.t;
  }

  setGoal(x, y, z, kind, id, ref = null) {
    const c = this.p.c;
    const path = planPath(this.sv.world, c, { x, y, z });
    if (!path) {
      this.blacklist.set(kind + ':' + id, this.sv.t + 60);
      return false;
    }
    const inB = buildingAt(this.sv.map, c.x, c.y, c.z);
    this.goal = { x, y, z, kind, id, ref, t0: this.sv.t, replans: 0, inB: inB ? inB.b : null };
    this.path = path;
    this.stuck = 0;
    if (kind === 'item' || kind === 'chest' || kind === 'box') this.sv.claims.set(kind + ':' + id, { id: this.p.id, until: this.sv.t + 12 });
    return true;
  }

  claimed(kind, id) {
    const cl = this.sv.claims.get(kind + ':' + id);
    if (!cl || cl.id === this.p.id || cl.until < this.sv.t) return false;
    const o = this.sv.players.get(cl.id);
    return !!(o && o.alive);
  }

  decide(t) {
    const sv = this.sv;
    const p = this.p;
    const c = p.c;
    const s = sv.storm;
    const tot = p.hp + p.sh;
    const armed = this.weaponSlots().some((i) => this.ammoFor(p.slots[i]) > 0);
    const outNow = outsideStorm(s, c.x, c.z);
    const dNext = Math.sqrt((c.x - s.nx) ** 2 + (c.z - s.nz) ** 2) - s.nr;
    const travel = dNext / C.CHAR.sprint;
    const pressure = outNow || (dNext > -4 && (s.shrinking || s.tLeft < travel + 22));

    // boxed up & healing
    if (t < this.boxedUntil && this.hasHeals() && !(this.target && t - this.targetSeenT < 0.5 && tot > 110)) {
      this.state = 'heal';
      this.thinkHeal(t);
      return;
    }
    if (this.breakObj && t < this.breakUntil) {
      const alive = this.breakObj.kind === 'piece' ? sv.world.pieces.get(this.breakObj.ref.id) : this.breakObj.ref.alive;
      if (alive) {
        this.state = 'break';
        return;
      }
      this.breakObj = null;
    } else this.breakObj = null;

    let seen = this.target && t - this.targetSeenT < 3.5;
    if (seen) {
      // right after landing bots prefer looting over picking fights far away
      const o = this.target;
      const d0 = Math.sqrt((o.c.x - c.x) ** 2 + (o.c.z - c.z) ** 2);
      const early = p.landedT >= 0 && t - p.landedT < 55 + 35 * (1 - this.pers.aggro);
      const provoked = o === this.attacker && t - this.lastDamageT < 6;
      if (early && !provoked && d0 > 11 + 8 * this.pers.aggro) seen = false;
    }
    if (seen) {
      const o = this.target;
      const dist = Math.sqrt((o.c.x - c.x) ** 2 + (o.c.z - c.z) ** 2);
      const cornered = dist < 4.5 || (o === this.attacker && t - this.lastDamageT < 2 && dist < 9);
      if (armed || cornered) {
        if (!(outNow && tot < 45 && dist > 25)) {
          this.state = 'fight';
          this.thinkFight(t);
          return;
        }
      }
    }
    if (outNow) {
      this.state = 'rotate';
      this.thinkRotate(t, true);
      return;
    }
    // heal when safe
    if (this.hasHeals() && (p.hp < 75 || p.sh < 55) && t - this.lastDamageT > 1.5) {
      this.state = 'heal';
      this.thinkHeal(t);
      return;
    }
    if (pressure) {
      this.state = 'rotate';
      this.thinkRotate(t, false);
      return;
    }
    // idle reload
    const held = sv.heldSlot(p);
    if (held && C.isWeapon(held.t) && !p.reload && held.n < C.WEAPONS[held.t].mag * 0.6 && p.ammo[C.WEAPONS[held.t].ammo] > 0) sv.startReload(p);
    if (!armed || t < this.lootUntil || !this.hasHeals()) {
      if (this.thinkLoot(t, armed ? 45 : 110)) {
        this.state = 'loot';
        return;
      }
      if (armed) this.lootUntil = Math.min(this.lootUntil, t);
    }
    if (this.noise && armed && tot > 90 && this.pers.aggro > 0.45 && this.state !== 'fight') {
      const n = this.noise;
      if (!this.goal || this.goal.kind !== 'noise' || t - this.goal.t0 > 6) this.setGoal(n.x, sv.world.terrain.heightAt(n.x, n.z), n.z, 'noise', Math.floor(t));
      this.state = 'investigate';
      return;
    }
    if (p.mats[0] < 90 && t - this.lastDamageT > 5 && this.thinkHarvest(t)) {
      this.state = 'harvest';
      return;
    }
    // opportunistic looting nearby
    if (this.thinkLoot(t, 28)) {
      this.state = 'loot';
      return;
    }
    this.state = 'hold';
    this.thinkHold(t);
  }

  thinkLoot(t, radius) {
    const sv = this.sv;
    const p = this.p;
    const c = p.c;
    const g = this.goal;
    if (g && (g.kind === 'item' || g.kind === 'chest' || g.kind === 'box')) {
      let valid = false;
      if (g.kind === 'item') valid = sv.items.has(g.id);
      else if (g.kind === 'chest') valid = sv.chestAvail[g.id];
      else valid = sv.boxAvail[g.id];
      const timeout = 10 + Math.sqrt((g.x - c.x) ** 2 + (g.z - c.z) ** 2) / 4;
      if (valid && t - g.t0 < timeout) return true;
      if (valid) this.ban(g);
      this.goal = null;
    }
    let best = null;
    let bs = Infinity;
    const consider = (kind, id, x, y, z, w) => {
      if (this.banned(kind, id) || this.claimed(kind, id)) return;
      const dd = Math.sqrt((x - c.x) ** 2 + (z - c.z) ** 2) + Math.abs(y - c.y) * 2.5;
      const sc = dd * w;
      if (sc < bs) {
        bs = sc;
        best = [kind, id, x, y, z];
      }
    };
    sv.itemsNear(c.x, c.z, radius, (it) => {
      if (!this.wants(it)) return;
      const w = C.isWeapon(it.t) ? (this.weaponSlots().length ? 0.8 : 0.45) : C.isConsumable(it.t) ? 0.95 : 1.5;
      consider('item', it.id, it.x, it.y, it.z, w);
    });
    const R2 = radius * radius * 1.2;
    const chests = sv.map.chests;
    for (let i = 0; i < chests.length; i++) {
      if (!sv.chestAvail[i]) continue;
      const ch = chests[i];
      if ((ch.x - c.x) ** 2 + (ch.z - c.z) ** 2 > R2) continue;
      consider('chest', i, ch.x, ch.y, ch.z, 0.55);
    }
    const lowAmmo = this.weaponSlots().some((i) => p.ammo[C.WEAPONS[p.slots[i].t].ammo] < 40);
    if (lowAmmo) {
      const boxes = sv.map.boxes;
      for (let i = 0; i < boxes.length; i++) {
        if (!sv.boxAvail[i]) continue;
        const b = boxes[i];
        if ((b.x - c.x) ** 2 + (b.z - c.z) ** 2 > R2) continue;
        consider('box', i, b.x, b.y, b.z, 1.1);
      }
    }
    if (!best) return false;
    return this.setGoal(best[2], best[3], best[4], best[0], best[1]);
  }

  thinkRotate(t, urgent) {
    const sv = this.sv;
    const s = sv.storm;
    const c = this.p.c;
    const key = s.nx.toFixed(0) + ',' + s.nz.toFixed(0) + ',' + s.nr.toFixed(0);
    if (this.zoneKey !== key || !this.zoneGoal || (this.goal && this.goal.kind !== 'zone')) {
      this.zoneKey = key;
      let gx = s.nx;
      let gz = s.nz;
      for (let k = 0; k < 12; k++) {
        const a = this.rng.float(0, Math.PI * 2);
        const r = this.rng.float(0, s.nr * (s.nr > 40 ? 0.6 : 0.35));
        const x = s.nx + Math.cos(a) * r;
        const z = s.nz + Math.sin(a) * r;
        if (sv.world.terrain.heightAt(x, z) > 1) {
          gx = x;
          gz = z;
          break;
        }
      }
      this.zoneGoal = { x: gx, z: gz };
      const g = sv.world.groundAt(gx, gz, 300);
      if (!this.setGoal(gx, g, gz, 'zone', Math.floor(t))) {
        this.goal = { x: gx, y: g, z: gz, kind: 'zone', id: 0, t0: t, replans: 0 };
        this.path = [[gx, gz]];
      }
    }
    void urgent;
    // arrived inside next circle -> hold
    const inside = Math.sqrt((c.x - s.nx) ** 2 + (c.z - s.nz) ** 2) < s.nr * 0.8;
    if (inside && !urgent && this.goal && this.goal.kind === 'zone') {
      const dd = Math.sqrt((c.x - this.goal.x) ** 2 + (c.z - this.goal.z) ** 2);
      if (dd < 4 || s.nr < 12) this.goal = null;
    }
  }

  thinkHold(t) {
    const sv = this.sv;
    const c = this.p.c;
    const s = sv.storm;
    if (this.goal && this.goal.kind === 'hold' && t - this.goal.t0 < 9) return;
    if (t < this.holdT) {
      this.goal = null;
      return;
    }
    this.holdT = t + this.rng.float(2, 6);
    const a = this.rng.float(0, Math.PI * 2);
    const r = this.rng.float(4, 16);
    let x = c.x + Math.cos(a) * r;
    let z = c.z + Math.sin(a) * r;
    // stay well inside the safe area
    const dx = x - s.nx;
    const dz = z - s.nz;
    const dd = Math.sqrt(dx * dx + dz * dz);
    if (dd > s.nr * 0.7) {
      x = s.nx + (dx / dd) * s.nr * 0.5;
      z = s.nz + (dz / dd) * s.nr * 0.5;
    }
    if (sv.world.terrain.heightAt(x, z) < 0.8) return;
    this.setGoal(x, sv.world.groundAt(x, z, c.y + 4), z, 'hold', Math.floor(t * 10));
  }

  thinkHarvest(t) {
    const sv = this.sv;
    const c = this.p.c;
    if (this.goal && this.goal.kind === 'harvest' && this.goal.ref && this.goal.ref.alive && t - this.goal.t0 < 16) return true;
    let best = null;
    let bd = Infinity;
    sv.world.queryProps(c.x - 32, c.z - 32, c.x + 32, c.z + 32, (pr) => {
      const def = PROP_TYPES[pr.type];
      if (def.mat !== 0 || def.landmark || this.banned('harvest', pr.id)) return;
      const dd = (pr.x - c.x) ** 2 + (pr.z - c.z) ** 2;
      if (dd < bd) {
        bd = dd;
        best = pr;
      }
    });
    if (!best) return false;
    return this.setGoal(best.x, best.y, best.z, 'harvest', best.id, best);
  }

  thinkHeal(t) {
    const sv = this.sv;
    const p = this.p;
    if (p.use) return;
    // pick best consumable
    let pick = -1;
    let pv = -1;
    p.slots.forEach((s, i) => {
      if (!s || !C.isConsumable(s.t) || !consumableNeed(p, s.t)) return;
      let v = 0;
      if (s.t === 'shieldL') v = p.hp > 50 ? 90 : 40;
      else if (s.t === 'shieldS') v = p.sh < 50 ? (p.hp > 50 ? 85 : 38) : 0;
      else if (s.t === 'medkit') v = p.hp < 55 ? 95 : 30;
      else if (s.t === 'bandage') v = p.hp < 75 ? 60 : 0;
      if (v > pv) {
        pv = v;
        pick = i;
      }
    });
    if (pick < 0 || pv <= 0) {
      this.boxedUntil = 0;
      return;
    }
    if (p.cur !== pick + 1) sv.setSlot(p, pick + 1);
    sv.startUse(p);
  }

  thinkFight(t) {
    const sv = this.sv;
    const p = this.p;
    const c = p.c;
    const o = this.target;
    const rng = this.rng;
    const d = this.d;
    const dx = o.c.x - c.x;
    const dz = o.c.z - c.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (p.use) sv.cancelUse(p);
    this.boxedUntil = 0;
    this.equipBest(dist);
    const held = sv.heldSlot(p);
    if (held && C.isWeapon(held.t) && held.n <= 0 && !p.reload) {
      // swap to another loaded gun if the enemy is close, else reload
      let alt = -1;
      p.slots.forEach((s, i) => {
        if (s && C.isWeapon(s.t) && s.n > 0 && i + 1 !== p.cur) alt = i;
      });
      if (alt >= 0 && dist < 30) {
        sv.setSlot(p, alt + 1);
        this.switchT = t + 0.3;
      } else sv.startReload(p);
    }
    // aim error (degrees -> radians), bigger right after acquiring and against fast targets
    const track = t - this.targetFirstT;
    const tsp = Math.sqrt(o.c.vx * o.c.vx + o.c.vz * o.c.vz);
    const moving = Math.abs(c.vx) + Math.abs(c.vz) > 1.5;
    const e = d.aim * (1 + 1.6 * Math.max(0, 1 - track / 1.6)) * (moving ? 1.2 : 1) * (tsp > 4 ? 1.35 : 1) * (o.c.mode === M_GROUND ? 1 : 1.5);
    this.errTY = rng.float(-1, 1) * e * DEG;
    this.errTP = rng.float(-1, 1) * e * 0.55 * DEG;
    // strafing
    if (t > this.strafeT) {
      this.strafe = rng.pick([-1, 1, -0.7, 0.7, 0]);
      this.strafeT = t + rng.float(0.45, 1.3);
    }
    if (c.mode === M_GROUND && rng.chance(0.05 + 0.08 * d.burst) && dist < 40) this.jumpReq = true;
    // high ground: ramp rush
    const mats = p.mats[0] + p.mats[1] + p.mats[2];
    if (o.c.y - c.y > 3.2 && dist < 30 && mats >= 30 && t > this.rampRushT + 2 && rng.chance(d.build * this.pers.builder * 0.7)) {
      this.rampRushT = t + rng.float(1.8, 3.2);
    }
    // enemy boxed/walled and we have a lot of mats: sometimes ramp over
    if (this.blockedByPiece && dist < 14 && mats >= 30 && t > this.rampRushT + 2 && rng.chance(d.build * 0.25)) this.rampRushT = t + 2;
  }

  // ---------------------------------------------------------------- building
  pickMat(need = 10) {
    const m = this.p.mats;
    if (m[2] >= 60 && m[2] >= need) return 2;
    if (m[1] >= 60 && m[1] >= need) return 1;
    if (m[0] >= need) return 0;
    if (m[1] >= need) return 1;
    if (m[2] >= need) return 2;
    return -1;
  }

  place(kind, yaw, pitch = 0) {
    const mat = this.pickMat();
    if (mat < 0) return false;
    const t = buildTarget(this.sv.world, this.p.c, yaw, pitch, kind, 0, this._bt || (this._bt = {}));
    if (placeCheck(this.sv.world, t) !== 0) return false;
    this.buildingNow = true;
    return !!this.sv.tryBuild(this.p, t, mat);
  }

  coverWall(att) {
    const c = this.p.c;
    const yaw = Math.atan2(-(att.c.x - c.x), -(att.c.z - c.z));
    const high = att.c.y - c.y > 3;
    if (high) this.place(K_RAMP, yaw);
    else this.place(K_WALL, yaw);
  }

  boxUp() {
    for (let dI = 0; dI < 4; dI++) this.place(K_WALL, DIR_YAW[dI]);
    this.place(K_CONE, this.p.c.yaw, 0);
    this.boxedUntil = this.sv.t + 7;
  }

  // ---------------------------------------------------------------- per-tick control
  control(dt) {
    const sv = this.sv;
    const p = this.p;
    const c = p.c;
    const inp = this.inp;
    const t = sv.t;
    inp.fwd = 0;
    inp.right = 0;
    inp.jump = false;
    inp.sprint = false;
    inp.ads = false;
    inp.crouch = false;
    this.buildingNow = false;
    this.wantMove = false;
    if (c.mode === M_BUS) return;
    if (c.mode === M_FALL || c.mode === M_GLIDE) return this.controlDrop(dt);

    let mx = 0;
    let mz = 0;
    let faceYaw = null;
    let facePitch = 0;
    let turn = 7;
    let sprint = false;

    // path following
    const g = this.goal;
    if (g && this.path.length) {
      let wp = this.path[0];
      let wx = wp[0] - c.x;
      let wz = wp[1] - c.z;
      let wd = Math.sqrt(wx * wx + wz * wz);
      const last = this.path.length === 1;
      const reach = last ? (g.kind === 'harvest' ? 2.1 + (g.ref ? 0.4 : 0) : g.kind === 'hold' || g.kind === 'zone' || g.kind === 'noise' ? 2.5 : 1.35) : 0.85;
      if (wd < reach) {
        if (last) {
          if (Math.abs(g.y - c.y) < 2.2 || g.kind === 'zone' || g.kind === 'hold' || g.kind === 'noise') this.arrive(g);
          else if (g.replans++ < 2) {
            const np = planPath(sv.world, c, g);
            if (np && np.length > 1) this.path = np;
            else {
              this.ban(g);
              this.goal = null;
              this.path = [];
            }
          } else {
            this.ban(g);
            this.goal = null;
            this.path = [];
          }
        } else this.path.shift();
      } else {
        mx = wx / wd;
        mz = wz / wd;
        sprint = wd > 5 || this.path.length > 1;
      }
    }

    if (t < this.detourT) {
      mx = this.detourX;
      mz = this.detourZ;
    }
    const rd = this.rectDetour;
    if (rd) {
      let done = t > rd.until || (rd.tx > 0 ? c.x > rd.end : rd.tx < 0 ? c.x < rd.end : rd.tz > 0 ? c.z > rd.end : c.z < rd.end);
      if (t - rd.pt > 0.8) {
        // not sliding along the wall any more (another obstacle): give up the detour
        if (Math.abs(c.x - rd.px) + Math.abs(c.z - rd.pz) < 1.2) done = true;
        rd.px = c.x;
        rd.pz = c.z;
        rd.pt = t;
      }
      if (done || this.state === 'fight' || !g || this.stuck >= 2) this.rectDetour = null;
      else {
        mx = rd.tx;
        mz = rd.tz;
        sprint = true;
      }
    }

    const o = this.target;
    let aimed = false;
    if (this.state === 'fight' && o && o.alive) {
      const visible = t - this.targetSeenT < 0.4;
      const tx = visible ? o.c.x : this.lastKnown.x;
      const ty = (visible ? o.c.y : this.lastKnown.y) + (o.c.crouch ? 0.85 : 1.15) + (this.d.aim < 2 && this.rng.next() < 0.02 ? 0.45 : 0);
      const tz = visible ? o.c.z : this.lastKnown.z;
      const dx = tx - c.x;
      const dy = ty - eyeY(c);
      const dz = tz - c.z;
      const hd = Math.sqrt(dx * dx + dz * dz);
      const dist = Math.sqrt(hd * hd + dy * dy);
      // smooth aim error
      this.errY += (this.errTY - this.errY) * Math.min(1, dt * 4);
      this.errP += (this.errTP - this.errP) * Math.min(1, dt * 4);
      const wantYaw = Math.atan2(-dx, -dz);
      const wantPitch = Math.atan2(dy, hd);
      faceYaw = wantYaw + this.errY;
      facePitch = wantPitch + this.errP;
      turn = this.d.turn;
      const held = sv.heldSlot(p);
      const wt = held && C.isWeapon(held.t) ? held.t : 'pickaxe';
      const [minR, maxR] =
        wt === 'shotgun' ? [2.5, 8] : wt === 'smg' ? [4, 16] : wt === 'ar' ? [10, 45] : wt === 'sniper' ? [40, 140] : wt === 'pistol' ? [5, 20] : wt === 'rocket' ? [14, 50] : [0, 1.8];
      // approach / retreat + strafe (world space)
      const ux = dx / (hd || 1);
      const uz = dz / (hd || 1);
      let ax = 0;
      let az = 0;
      if (!visible) {
        if (!this.blockedByPiece || hd > 16) {
          ax = ux;
          az = uz;
          sprint = hd > 8;
        }
      } else if (hd > maxR) {
        ax = ux;
        az = uz;
        sprint = hd > maxR + 15 && wt !== 'sniper';
      } else if (hd < minR) {
        ax = -ux * 0.8;
        az = -uz * 0.8;
      }
      const sx = -uz * this.strafe;
      const sz = ux * this.strafe;
      if (!(g && this.path.length && this.state !== 'fight')) {
        mx = ax + sx * (visible ? 0.9 : 0.3);
        mz = az + sz * (visible ? 0.9 : 0.3);
        const ml = Math.sqrt(mx * mx + mz * mz);
        if (ml > 1) {
          mx /= ml;
          mz /= ml;
        }
      }
      if (t < this.detourT) {
        mx = this.detourX;
        mz = this.detourZ;
      }
      inp.ads = visible && hd > 16 && wt !== 'shotgun' && wt !== 'pickaxe' && !sprint;
      if (wt === 'sniper' && visible) {
        inp.crouch = hd > 60 && this.rng.next() < 0.5;
        mx *= 0.3;
        mz *= 0.3;
      }
      // ramp rush toward high ground
      if (t < this.rampRushT) {
        const dI = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 0 : 2) : dz > 0 ? 1 : 3;
        const ry = DIR_YAW[dI];
        if (this._rushTick === undefined || t - this._rushTick > 0.22) {
          this._rushTick = t;
          this.place(K_RAMP, ry, 0);
        }
        mx = -Math.sin(ry);
        mz = -Math.cos(ry);
        sprint = true;
        if (c.y > o.c.y + 0.5) this.rampRushT = 0;
      }
      // firing
      const tol = Math.max(2.2 * DEG, Math.atan2(1.1, Math.max(1, dist))) + Math.abs(this.errY);
      aimed = Math.abs(wrapAngle(c.yaw - faceYaw)) < tol + 0.02 && Math.abs(c.pitch - facePitch) < tol * 1.5 + 0.03;
      const canShootWall = !visible && this.blockedByPiece && t - this.targetSeenT < 2.5 && dist < 45;
      if (aimed && t >= this.reactT && t > this.switchT && (visible || canShootWall) && c.mode === M_GROUND) {
        if (p.cur === 0) {
          if (dist < 2.8) sv.botMelee(p);
        } else if (held && C.isWeapon(held.t)) {
          if (t > this.burstPauseT) {
            const auto = C.WEAPONS[held.t].auto;
            if (sv.botFire(p)) {
              if (auto) {
                this.burst++;
                if (this.burst >= this.burstLen) {
                  this.burst = 0;
                  this.burstLen = this.rng.int(4, 11);
                  this.burstPauseT = t + this.rng.float(0.22, 0.55) / this.d.burst;
                }
              } else if (held.t === 'pistol') this.burstPauseT = t + this.rng.float(0.12, 0.3) / this.d.burst;
              else this.burstPauseT = t + this.rng.float(0.05, 0.25) / this.d.burst;
            }
          }
        }
      }
    } else if (this.state === 'heal') {
      mx = 0;
      mz = 0;
      inp.crouch = !!p.use;
      if (this.attacker && this.attacker.alive) {
        faceYaw = Math.atan2(-(this.attacker.c.x - c.x), -(this.attacker.c.z - c.z));
        turn = 3;
      }
    } else if (this.state === 'break' && this.breakObj) {
      const b = this.breakObj;
      let bx;
      let by;
      let bz;
      if (b.kind === 'piece') {
        const a = b.ref.aabb;
        bx = (a[0] + a[3]) / 2;
        by = Math.min(a[4] - 0.3, Math.max(a[1] + 0.3, eyeY(c)));
        bz = (a[2] + a[5]) / 2;
      } else {
        bx = b.ref.x;
        by = b.ref.y + 1.2;
        bz = b.ref.z;
      }
      const dx = bx - c.x;
      const dz = bz - c.z;
      const hd = Math.sqrt(dx * dx + dz * dz);
      faceYaw = Math.atan2(-dx, -dz);
      facePitch = Math.atan2(by - eyeY(c), hd);
      turn = 8;
      mx = 0;
      mz = 0;
      if (hd > 2.4) {
        mx = dx / hd;
        mz = dz / hd;
      }
      if (p.cur !== 0) sv.setSlot(p, 0);
      else if (Math.abs(wrapAngle(c.yaw - faceYaw)) < 0.25) sv.botMelee(p);
    } else if (this.state === 'harvest' && g && g.kind === 'harvest' && g.ref && this.path.length <= 1) {
      const pr = g.ref;
      const dx = pr.x - c.x;
      const dz = pr.z - c.z;
      const hd = Math.sqrt(dx * dx + dz * dz);
      if (hd < 2.6) {
        mx = 0;
        mz = 0;
        faceYaw = Math.atan2(-dx, -dz);
        facePitch = -0.05;
        if (p.cur !== 0) sv.setSlot(p, 0);
        else if (Math.abs(wrapAngle(c.yaw - faceYaw)) < 0.3) sv.botMelee(p);
        if (!pr.alive || p.mats[0] > 220) {
          this.goal = null;
          this.path = [];
        }
      }
    }

    if (faceYaw === null) {
      if (mx !== 0 || mz !== 0) faceYaw = Math.atan2(-mx, -mz);
      else faceYaw = c.yaw;
      facePitch = 0;
    }
    // turn toward the wanted facing
    const dyaw = wrapAngle(faceYaw - c.yaw);
    const maxT = turn * dt;
    c.yaw = wrapAngle(c.yaw + Math.max(-maxT, Math.min(maxT, dyaw)));
    const dp = facePitch - c.pitch;
    c.pitch += Math.max(-maxT, Math.min(maxT, dp));
    // world move -> local input
    const sy = Math.sin(c.yaw);
    const cy = Math.cos(c.yaw);
    inp.fwd = -sy * mx - cy * mz;
    inp.right = cy * mx - sy * mz;
    this.wantMove = mx !== 0 || mz !== 0;
    inp.sprint = sprint && !inp.ads && !p.use;
    if (p.use) {
      inp.fwd *= 0.5;
      inp.right *= 0.5;
    }
    if (this.jumpReq && c.grounded) {
      inp.jump = true;
      this.jumpReq = false;
    }
    if (c.mode === M_SWIM) inp.sprint = false;
  }

  arrive(g) {
    const sv = this.sv;
    const p = this.p;
    if (g.kind === 'item') {
      const it = sv.items.get(g.id);
      if (it) this.botPickup(it);
      this.goal = null;
      this.path = [];
    } else if (g.kind === 'chest' || g.kind === 'box') {
      sv.openContainer(p, g.kind === 'box' ? 'b' : 'c', g.id);
      this.goal = null;
      this.path = [];
    } else if (g.kind === 'harvest') {
      // stay; control swings the pickaxe
      this.path = [[g.x, g.z]];
      if (!g.ref || !g.ref.alive) {
        this.goal = null;
        this.path = [];
      }
    } else {
      this.goal = null;
      this.path = [];
    }
  }

  controlDrop(dt) {
    const c = this.p.c;
    const inp = this.inp;
    const dx = this.dropX - c.x;
    const dz = this.dropZ - c.z;
    const hd = Math.sqrt(dx * dx + dz * dz);
    const ground = this.sv.world.terrain.heightAt(c.x, c.z);
    const ha = c.y - ground;
    const want = Math.atan2(-dx, -dz);
    const dyaw = wrapAngle(want - c.yaw);
    c.yaw = wrapAngle(c.yaw + Math.max(-4 * dt, Math.min(4 * dt, dyaw)));
    inp.fwd = hd > 3 ? 1 : 0;
    if (c.mode === M_FALL) c.pitch = hd < ha * 0.5 ? -1.25 : hd < ha ? -0.5 : 0;
    else c.pitch = hd < ha * 0.35 ? -1 : 0;
  }
}
