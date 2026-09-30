import * as THREE from 'three';
import { makeBox, setBoxTransform } from './physics.js';

// Physics constants shared with the ball controller (the generator uses them to guarantee every
// gap / ramp it builds is actually clearable at the current speed).
export const GRAVITY = 34;
export const JUMP_V = 13;
export const BALL_R = 1;

const DEG = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;

// Like the original, speed goes up in steps: every speed tunnel ends a section and
// pushes the ball's target speed up a notch.
export function sectionSpeed(section) {
  return Math.min(27 + section * 7, 84);
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Horizontal distance of a ballistic flight (launched at `angle` above horizontal) that lands H below.
function flightDist(v, angle, H) {
  const vy = v * Math.sin(angle),
    vx = v * Math.cos(angle);
  const t = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * Math.max(H, 0))) / GRAVITY;
  return { d: vx * t, t };
}
// Rolling straight off a rooftop edge that slopes down at `pitch`: the ball keeps its forward speed v
// and its downward speed v·tan(pitch). extraVy lets us account for a jump at the edge.
function dropReach(v, pitch, H, extraVy = 0) {
  const vy = -v * Math.tan(pitch) + extraVy;
  const t = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * Math.max(H, 0))) / GRAVITY;
  return v * t;
}

const TINT_FLOOR = new THREE.Color(1, 1, 1);
const TINT_GATE = new THREE.Color(1.1, 0.35, 1.2);
const TINT_SECRET = new THREE.Color(-1.0, -0.78, -0.12); // negative = absolute colour (gold)
const _scale = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

// Obstacle catalogue, based on the original game's level generation:
//   early: RNG blocks, slants, straights · middle: treblocks, tunnels, snakes (+ spinners)
//   late: hors, verts (+ sliding gates). Every section ends in a speed tunnel.
// Everything gets harder (and more of it moves) with every section.
const EARLY = ['rng', 'slant', 'straight'];
const MIDDLE = ['treblocks', 'tunnel', 'snake', 'spinner'];
const LATE = ['hors', 'verts', 'gate'];
// pieces a hidden sky route can pass over (no big drops, nothing tall)
const SECRET_OK = ['rng', 'straight', 'treblocks', 'hors', 'slant', 'spinner', 'gate'];
export const POWERUPS = ['shield', 'magnet', 'double', 'slowmo'];

export class Track {
  constructor(scene, pools, makeSign, makePickup) {
    this.scene = scene;
    this.pools = pools;
    this.makeSign = makeSign;
    this.makePickup = makePickup;
    this.tiles = [];
    this.hazards = [];
    this.gems = [];
    this.pickups = [];
    this.signs = [];
    this.center = [];
    this.towers = [];
    this.triggers = [];
    this.pads = [];
  }

  reset(seed, mode, showHints) {
    for (const s of this.signs) this.scene.remove(s.sprite);
    for (const p of this.pickups) this.scene.remove(p.mesh);
    for (const k of ['tiles', 'hazards', 'gems', 'towers', 'pads']) this.pools[k].clear();
    this.tiles = [];
    this.hazards = [];
    this.gems = [];
    this.pickups = [];
    this.signs = [];
    this.center = [];
    this.towers = [];
    this.triggers = [];
    this.pads = [];
    this.rng = mulberry32(seed);
    this.mode = mode;
    this.plus = mode === 'plus';
    this.showHints = showHints;
    this.hintCount = {};
    this.distBase = 0;
    this.cur = new THREE.Vector3(0, 0, 14);
    this.pitch = 19;
    this.W = 10;
    this.lastEnds = [];
    this.pending = [];
    this.pid = 0;
    this.genSection = 0;
    this.queue = [];
    this.lastName = '';
    this.cityZ = 60;
    this.pieces = 0;
    this.safeZ = 1e9; // no pending landing zone
    this.forcePlain = null;
    this.lastSecret = -99;
    this.secrets = 0;

    // start rooftop
    this.tile(36, { w: 12, pitch: 10 });
    this.tile(20, { w: 11, pitch: 17, join: true });
    this.buildQueue();
  }

  rf(a, b) {
    return a + (b - a) * this.rng();
  }
  ri(a, b) {
    return Math.floor(this.rf(a, b + 1));
  }
  pick(arr) {
    return arr[Math.floor(this.rng() * arr.length)];
  }
  distAt(z) {
    return this.distBase - z;
  }
  get v() {
    return sectionSpeed(this.genSection) + 1.5;
  }
  get k() {
    return this.genSection;
  }

  // ------------------------------------------------------------------ primitives
  // A platform segment (a rooftop). Each call is a new "platform" for scoring unless join:true.
  // bld: 'full' puts a building under it all the way down, 'pillars' thin supports, 'none' nothing.
  tile(len, o = {}) {
    const w = o.w ?? this.W;
    const pitch = (o.pitch ?? this.pitch) * DEG;
    const roll = (o.roll ?? 0) * DEG;
    const yaw = (o.yaw ?? 0) * DEG;
    const thick = o.thick ?? 1.6;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, -yaw, roll, 'YXZ'));
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const start = o.at ? o.at.clone() : this.cur.clone();
    const center = start.clone().addScaledVector(dir, len / 2).addScaledVector(up, -thick / 2);
    const box = makeBox(center, q, new THREE.Vector3(w / 2, thick / 2, len / 2), { surface: o.surface !== false, bounce: o.bounce });
    if (!o.join || !this.pid) this.pid++;
    box.pid = this.pid;
    const end = start.clone().addScaledVector(dir, len);
    const t = { box, start, end, dir, up, right, q, len, w, thick, pid: this.pid, slot: -1 };
    t.slot = this.pools.tiles.add(box.pos, q, _scale.set(w, thick, len), o.tint || TINT_FLOOR);
    this.tiles.push(t);

    if (o.connect !== false && !o.at) {
      for (const prev of this.lastEnds) {
        if (prev.end.distanceTo(start) < 0.05 + prev.w / 2 && Math.abs(prev.end.y - start.y) < 0.35 && Math.abs(prev.end.z - start.z) < 0.6) {
          prev.box.connectEnd = true;
          box.connectStart = true;
        }
      }
    }
    if (!o.at) {
      this.center.push({ z: start.z, y: start.y, x: start.x });
      this.cur.copy(end);
      this.center.push({ z: end.z, y: end.y, x: this.cur.x });
      this.lastEnds = [t];
    }
    const bld = o.bld ?? 'full';
    if (bld === 'full') this.buildingUnder(t);
    else if (bld === 'pillars') this.pillarsUnder(t);
    return t;
  }

  // Raw box relative to a tile frame. surface:false boxes are solid (walls).
  sideBox(t, lx, lz, sx, sy, sz, { roll = 0, surface = false, bounce = 0.35, lift = 0, pool = 'tiles', collide = true, tint = null } = {}) {
    const q = t.q.clone();
    if (roll) q.multiply(_q.setFromAxisAngle(Z_AXIS, roll));
    const pos = t.start.clone().addScaledVector(t.right, lx).addScaledVector(t.dir, lz).addScaledVector(t.up, lift);
    const box = makeBox(pos, q, new THREE.Vector3(sx / 2, sy / 2, sz / 2), { surface, bounce });
    box.pid = t.pid;
    const s = { box, start: pos, pid: t.pid, slot: this.pools[pool].add(pos, q, _scale.set(sx, sy, sz), tint), pool };
    if (collide) this.tiles.push(s);
    else this.towers.push(s);
    return s;
  }

  gap(len, drop, shift = 0) {
    const from = this.cur.clone();
    this.cur.z -= len;
    this.cur.y -= drop;
    this.cur.x += shift;
    this.lastEnds = [];
    this.center.push({ z: from.z, y: from.y, x: from.x });
    this.center.push({ z: this.cur.z, y: this.cur.y, x: this.cur.x });
  }

  drop(h) {
    this.cur.y -= h;
    this.lastEnds = [];
    this.center.push({ z: this.cur.z, y: this.cur.y, x: this.cur.x });
  }

  hazard(t, lx, lz, sx, sy, sz, motion = null, tint = null, lift = 0) {
    const pos = t.start.clone().addScaledVector(t.right, lx).addScaledVector(t.dir, lz).addScaledVector(t.up, sy / 2 + lift);
    const box = makeBox(pos, t.q, new THREE.Vector3(sx / 2, sy / 2, sz / 2));
    const h = { box, base: pos.clone(), baseQuat: t.q.clone(), up: t.up.clone(), right: t.right.clone(), scale: new THREE.Vector3(sx, sy, sz), motion, alive: true, gate: !!(motion && motion.gate) };
    h.slot = this.pools.hazards.add(pos, t.q, h.scale, tint);
    this.hazards.push(h);
    return h;
  }

  // sliding block helper: 'hor' motion across `amp` either side, `cross` seconds edge to edge
  slider(t, lz, sx, sy, sz, amp, cross, phase = this.rf(0, 6), lx = 0) {
    return this.hazard(t, lx, lz, sx, sy, sz, { type: 'hor', amp, cross, phase });
  }

  gem(pos) {
    const g = { pos: pos.clone(), taken: false, phase: this.rng() * 6 };
    g.slot = this.pools.gems.add(pos, _q.identity(), _scale.set(1, 1, 1));
    this.gems.push(g);
  }

  gemLine(t, x0, x1, z0, z1, n) {
    for (let i = 0; i < n; i++) {
      const k = n === 1 ? 0.5 : i / (n - 1);
      const p = t.start
        .clone()
        .addScaledVector(t.right, lerp(x0, x1, k))
        .addScaledVector(t.dir, lerp(z0, z1, k))
        .addScaledVector(t.up, 1.25);
      this.gem(p);
    }
  }

  sign(t, lz, text, sub, color) {
    if (!this.showHints) return;
    this.hintCount[text] = (this.hintCount[text] || 0) + 1;
    if (this.hintCount[text] > 2) return;
    const s = this.makeSign(text, sub, color);
    s.position.copy(t.start).addScaledVector(t.dir, lz).addScaledVector(t.up, 5.2);
    this.scene.add(s);
    this.signs.push({ sprite: s });
  }

  powerup(t, lz, type, lx = 0) {
    const m = this.makePickup(type);
    m.position.copy(t.start).addScaledVector(t.right, lx).addScaledVector(t.dir, lz).addScaledVector(t.up, 1.4);
    this.scene.add(m);
    this.pickups.push({ mesh: m, pos: m.position, type, taken: false });
  }

  // wireframe building block — solid, so the ball bounces off / lands on buildings like you'd expect
  tower(cx, cz, w, d, top, bottom) {
    const h = top - bottom;
    if (h <= 0.05) return;
    const pos = new THREE.Vector3(cx, bottom + h / 2, cz);
    const box = makeBox(pos, _q.identity(), new THREE.Vector3(w / 2, h / 2, d / 2), { bounce: 0.25 });
    const slot = this.pools.towers.add(pos, _q, _scale.set(w, h, d));
    this.towers.push({ box, slot, pool: 'towers', start: box.pos });
  }

  // The building under a rooftop, reaching all the way down. Sloped roofs get stepped columns.
  buildingUnder(t, depth = 340) {
    const slice = 6;
    const n = Math.max(1, Math.round(t.len / slice));
    const sideDrop = Math.abs(t.right.y) * (t.w / 2); // rolled roofs: the low edge is lower
    for (let i = 0; i < n; i++) {
      const p0 = t.start.clone().addScaledVector(t.dir, (t.len * i) / n);
      const p1 = t.start.clone().addScaledVector(t.dir, (t.len * (i + 1)) / n);
      const top = Math.min(p0.y, p1.y) - t.thick * Math.abs(t.up.y) - sideDrop + 0.02;
      const w = t.w * 0.98 * Math.max(Math.abs(t.right.x), 0.7);
      this.tower((p0.x + p1.x) / 2, (p0.z + p1.z) / 2, w, Math.abs(p1.z - p0.z) + Math.abs(t.dir.x) * t.w + 0.04, top, top - depth);
    }
  }

  // thin paths (snakes, straights) stand on stilts instead of a full building
  pillarsUnder(t, depth = 340) {
    if (t.len < 5 && this.rng() < 0.6) return;
    const p = t.start.clone().addScaledVector(t.dir, t.len * 0.5);
    const top = p.y - t.thick - 0.2;
    this.tower(p.x, p.z, Math.min(t.w * 0.55, 2), Math.min(2, t.len * 0.6), top, top - depth);
  }

  // ------------------------------------------------------------------ generation
  buildQueue() {
    const k = this.genSection;
    const n = k === 0 ? 2 : k === 1 ? 2 : k === 2 ? 3 : k < 5 ? 4 : 5;
    const q = [];
    const choose = (list, tier) => {
      let name;
      do name = this.pick(list);
      while (list.length > 1 && name === this.lastName);
      // snakes (thin) stop appearing once the run is going (original: none after 50 points)
      if (name === 'snake' && k > 2) name = this.pick(['treblocks', 'tunnel', 'spinner']);
      if (this.plus && this.rng() < 0.28) name = this.pick(tier === 'early' ? ['jumpGap'] : tier === 'middle' ? ['jumpGap', 'hurdles'] : ['dashGate', 'hurdles']);
      this.lastName = name;
      q.push(name);
    };
    for (let i = 0; i < n; i++) choose(EARLY, 'early');
    if (k >= 1) for (let i = 0; i < n; i++) choose(MIDDLE, 'middle');
    if (k >= 2) for (let i = 0; i < n; i++) choose(LATE, 'late');
    q.push('speedTunnel');
    this.queue = q;
  }

  update(ballZ) {
    let guard = 0;
    while (this.cur.z > ballZ - 480 && guard++ < 24) this.nextPiece();
    this.buildCity(this.cur.z + 40);
    this.cull(ballZ + 45);
  }

  // Background skyline: towers of wireframe cubes lining both sides of the descent.
  buildCity(zLimit) {
    while (this.cityZ > zLimit) {
      const z = this.cityZ;
      const ref = this.refAt(z);
      for (const side of [-1, 1]) {
        const w1 = this.rf(7, 13),
          d1 = this.rf(7, 12);
        const x1 = ref.x + side * (this.rf(19, 24) + w1 / 2);
        this.tower(x1, z, w1, d1, ref.y + this.rf(-18, 34), ref.y - 360);
        if (this.rng() < 0.75) {
          const w2 = this.rf(9, 16),
            d2 = this.rf(8, 14);
          const x2 = ref.x + side * (this.rf(38, 62) + w2 / 2);
          this.tower(x2, z + this.rf(-3, 3), w2, d2, ref.y + this.rf(0, 60), ref.y - 360);
        }
      }
      this.cityZ -= this.rf(11, 15);
    }
  }

  cull(zLimit) {
    const keepT = [];
    for (const t of this.tiles) {
      if (t.box.min.z > zLimit) this.pools[t.pool || 'tiles'].remove(t.slot);
      else keepT.push(t);
    }
    this.tiles = keepT;
    const keepW = [];
    for (const t of this.towers) {
      if (t.box.min.z > zLimit + 30) this.pools[t.pool || 'towers'].remove(t.slot);
      else keepW.push(t);
    }
    this.towers = keepW;
    const hk = [];
    for (const h of this.hazards) {
      if (h.box.min.z > zLimit || !h.alive) {
        if (h.alive) this.pools.hazards.remove(h.slot);
      } else hk.push(h);
    }
    this.hazards = hk;
    const gk = [];
    for (const g of this.gems) {
      if (g.pos.z > zLimit || g.taken) {
        if (!g.taken) this.pools.gems.remove(g.slot);
      } else gk.push(g);
    }
    this.gems = gk;
    this.pickups = this.pickups.filter((p) => {
      if (p.pos.z > zLimit || p.taken) {
        this.scene.remove(p.mesh);
        return false;
      }
      return true;
    });
    this.signs = this.signs.filter((s) => {
      if (s.sprite.position.z > zLimit - 30) {
        this.scene.remove(s.sprite);
        return false;
      }
      return true;
    });
    this.triggers = this.triggers.filter((t) => t.z < zLimit + 60 || !t.fired);
    this.pads = this.pads.filter((p) => {
      if (p.pos.z > zLimit) {
        this.pools.pads.remove(p.slot);
        return false;
      }
      return true;
    });
    while (this.center.length > 4 && this.center[2].z > zLimit + 20) this.center.shift();
  }

  // Reference track height / centre (centre line) at a given z. Used for fall detection & camera.
  refAt(z) {
    const c = this.center;
    for (let i = 0; i < c.length - 1; i++) {
      const a = c[i],
        b = c[i + 1];
      if (z <= a.z && z >= b.z) {
        const k = a.z === b.z ? 0 : (a.z - z) / (a.z - b.z);
        return { y: lerp(a.y, b.y, k), x: lerp(a.x, b.x, k) };
      }
    }
    const last = z > c[0].z ? c[0] : c[c.length - 1];
    return { y: last.y, x: last.x };
  }

  nextPiece() {
    if (!this.queue.length) this.buildQueue();
    const name = this.queue.shift();
    this.pitch = clamp(this.pitch + this.rf(-3, 3), 17, 25);
    this.W = clamp(10 - this.k * 0.35, 8, 10);
    this.pieces++;
    const z0 = this.cur.z;

    // Hidden sky route: a small side kicker launches you onto a secret rooftop lane above the
    // next obstacle, packed with coins and a power-up.
    const secret = SECRET_OK.includes(name) && this.pieces - this.lastSecret > 3 && this.pieces > 2 && this.rng() < 0.22 && this.cur.z < this.safeZ;
    if (secret) {
      this.p_secret(name);
    } else {
      this.connector(name);
      this['p_' + name]();
    }
    if (this.log) this.log.push({ name: secret ? name + '+secret' : name, z0, z1: this.cur.z, d: this.distAt(z0) });
  }

  // Connector between obstacles: mostly big gaps between buildings — roll off one rooftop onto a much
  // lower one, or hit a ramp and jump across — sometimes just a short rooftop.
  connector(name) {
    const gappers = ['tunnel', 'snake', 'straight', 'jumpGap', 'speedTunnel', 'hors'];
    if (this.forcePlain) {
      const t = this.tile(this.forcePlain.len, { pitch: this.forcePlain.pitch, w: this.forcePlain.w });
      this.forcePlain = null;
      return t;
    }
    const r = this.rng();
    const canGap = this.pieces > 1 && this.cur.z < this.safeZ;
    if (canGap && r < 0.42) return this.buildingDrop();
    if (canGap && r < 0.72) return this.buildingHop();
    let len = this.rf(10, 16);
    if (gappers.includes(name) && this.cur.z - len > this.safeZ) len = Math.min(this.cur.z - this.safeZ + 6, 150);
    const t = this.tile(len);
    if (this.rng() < 0.2) this.gemLine(t, 0, 0, 3, t.len - 3, 3);
    return t;
  }

  // Roll off the edge of a rooftop and drop onto a lower building across a wide gap.
  buildingDrop() {
    const v = this.v;
    const edge = this.tile(this.rf(10, 16));
    const th = this.pitch * DEG;
    // deep enough to feel like a real gap between buildings, shallow enough to keep the roof in view
    const H = this.rf(8, 13) + Math.min(this.k, 5) * 0.8;
    // wide enough to look scary, short enough that a slow ball still makes it
    const G = 0.62 * dropReach(v * 0.8, th, H);
    if (this.rng() < 0.5) {
      for (let i = 1; i <= 3; i++) {
        const tt = i / 4;
        const d = G * tt;
        this.gem(new THREE.Vector3(this.cur.x, edge.end.y + BALL_R - d * Math.tan(th) - 0.5 * GRAVITY * (d / v) ** 2 + 0.8, edge.end.z - d));
      }
    }
    this.gap(G, H);
    const far = dropReach(v * 1.15, th, H, this.plus ? JUMP_V : 0);
    const land = this.tile(Math.max(24, far * 1.25 - G + 10), { w: this.W + 2 });
    this.safeZ = Math.min(this.cur.z - v * 0.4, edge.end.z - far * 1.15);
    return land;
  }

  // Ramp off the end of a rooftop, fly a big gap, land on a lower rooftop.
  buildingHop() {
    const v = this.v;
    this.tile(this.rf(10, 14));
    const ang = this.rf(13, 18);
    this.tile(3, { pitch: 0, join: true });
    const ramp = this.tile(5, { pitch: -ang, join: true });
    return this.launch(ramp, ang, v, this.rf(6, 11) + Math.min(this.k, 5) * 0.6);
  }

  // Gap + landing rooftop after a ramp. Sized from the real flight so it's always makeable.
  launch(ramp, ang, v, H, landW = 12) {
    const a = ang * DEG;
    const G = Math.min(0.78 * flightDist(v * 0.72, a, H).d, 0.62 * flightDist(v * 0.9, a, H).d);
    const f = flightDist(v * 0.9, a, H);
    const vx = v * 0.9 * Math.cos(a),
      vy = v * 0.9 * Math.sin(a);
    for (let k = 1; k <= 4; k++) {
      const tt = (f.t * k) / 5;
      this.gem(new THREE.Vector3(this.cur.x, ramp.end.y + BALL_R + vy * tt - 0.5 * GRAVITY * tt * tt, ramp.end.z - vx * tt));
    }
    this.gap(G, H);
    const gapEnd = this.cur.z;
    const far = flightDist(v * 1.15, a, H).d;
    const land = this.tile(Math.max(28, far * 1.45 - G + 10), { w: landW });
    // in Plus mode a jump off the ramp stacks on the launch: keep the next gap / thin piece out of reach
    let reach = this.cur.z - v * 0.5;
    if (this.plus) {
      const vx2 = v * 1.15 * Math.cos(a),
        vy2 = v * 1.15 * Math.sin(a) + JUMP_V;
      const t2 = (vy2 + Math.sqrt(vy2 * vy2 + 2 * GRAVITY * H)) / GRAVITY;
      reach = Math.min(reach, gapEnd - vx2 * t2 * 1.15);
    }
    this.safeZ = reach;
    return land;
  }

  // ------------------------------------------------------------------ secret sky routes
  p_secret(name) {
    const v = this.v;
    // a wider rooftop so the side kicker sits well clear of the normal line down the middle
    const conn = this.tile(28, { w: this.W + 3 });
    const side = this.rng() < 0.5 ? -1 : 1;
    const P = this.cur.clone();
    const tiles0 = this.tiles.length,
      haz0 = this.hazards.length;
    this['p_' + name]();
    const Q = this.cur.clone();
    this.lastSecret = this.pieces;
    if (P.z - Q.z < 50) return;

    // how high the lane must sit above the straight line P→Q to clear everything the piece built
    const slope = (Q.y - P.y) / (Q.z - P.z);
    const line = (z) => P.y + (z - P.z) * slope;
    let clear = 0;
    // (roof surfaces are planes, so checking their two ends is exact; tilted roofs add their raised edge)
    for (let i = tiles0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      if (!t.end) {
        clear = Math.max(clear, t.box.max.y - line(t.box.pos.z));
        continue;
      }
      const edge = Math.abs(t.right.y) * (t.w / 2);
      clear = Math.max(clear, t.start.y + edge - line(t.start.z), t.end.y + edge - line(t.end.z));
    }
    for (let i = haz0; i < this.hazards.length; i++) {
      const h = this.hazards[i];
      const lift = h.motion && h.motion.type === 'vert' ? h.motion.lift : 0;
      clear = Math.max(clear, h.base.y + h.scale.y / 2 + lift - line(h.base.z));
    }
    const laneH = Math.max(clear + 2.4, 6.5);

    // side kicker near the end of the connector: a flat lip then a steep ramp (two stages so
    // the ball isn't stopped dead by one sharp crease)
    const kick = 30 * DEG,
      kLen = 5,
      kW = 3.4,
      lipLen = 3,
      lipAng = 4 * DEG;
    const lx = side * (conn.w / 2 - kW / 2 - 0.3);
    const lipStart = conn.start.clone().addScaledVector(conn.dir, conn.len - kLen - lipLen - 3).addScaledVector(conn.right, lx);
    const lq = new THREE.Quaternion().setFromEuler(new THREE.Euler(lipAng, 0, 0, 'YXZ'));
    const lDir = new THREE.Vector3(0, 0, -1).applyQuaternion(lq);
    const kStart = lipStart.clone().addScaledVector(lDir, lipLen);
    const kq = new THREE.Quaternion().setFromEuler(new THREE.Euler(kick, 0, 0, 'YXZ'));
    const kDir = new THREE.Vector3(0, 0, -1).applyQuaternion(kq);
    const kUp = new THREE.Vector3(0, 1, 0).applyQuaternion(kq);
    const kTop = kStart.clone().addScaledVector(kDir, kLen);

    // simulate the launch (slow case for height, fast case for length)
    const sim = (speed) => {
      const vy0 = speed * Math.sin(kick),
        vz0 = speed * Math.cos(kick);
      let best = -Infinity,
        bestZ = kTop.z,
        land = null;
      for (let t = 0.02; t < 3; t += 0.02) {
        const y = kTop.y + BALL_R + vy0 * t - 0.5 * GRAVITY * t * t;
        const z = kTop.z - vz0 * t;
        const rel = y - BALL_R - (line(z) + laneH);
        if (rel > best) {
          best = rel;
          bestZ = z;
        }
        if (best > 0.5 && rel < 0 && vy0 - GRAVITY * t < 0) {
          land = z;
          break;
        }
      }
      return { apex: best, apexZ: bestZ, land };
    };
    // speed lost to the two creases + climbing: be pessimistic for height, optimistic for length
    const slow = sim(v * 0.66),
      fast = sim(v * 1.05);
    if (this.debugSecret) this.debugSecret.push({ name, clear: +clear.toFixed(2), laneH: +laneH.toFixed(2), apexSlow: +slow.apex.toFixed(2), landSlow: slow.land && +(P.z - slow.land).toFixed(1), landFast: fast.land && +(P.z - fast.land).toFixed(1), apexZ: +(P.z - slow.apexZ).toFixed(1), len: +(P.z - Q.z).toFixed(1), v: +v.toFixed(1) });
    if (slow.apex < 1.4 || !slow.land) {
      // can't make it: leave the piece as a normal one (no kicker)
      this.lastSecret = this.pieces - 2;
      return;
    }
    const laneStart = Math.min(slow.apexZ, P.z - 2);
    // the lane runs over the obstacle and on past it (over a rooftop laid parallel to it) far enough
    // that even the fastest launch comes down on it
    const fastLand = fast.land ?? P.z - 170;
    const laneEnd = Math.min(Q.z + 2, fastLand - 20);
    if (laneStart - laneEnd < 30 || P.z - laneEnd > 220) {
      this.lastSecret = this.pieces - 2;
      return;
    }
    // commit: build the kicker (lip + ramp)
    const addK = (st, q, len) => {
      const d = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      const u = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const c = st.clone().addScaledVector(d, len / 2).addScaledVector(u, -0.6);
      const kb = makeBox(c, q, new THREE.Vector3(kW / 2, 0.6, len / 2), { surface: true, bounce: 0 });
      kb.pid = conn.pid;
      this.tiles.push({ box: kb, start: st.clone(), pid: conn.pid, kicker: true, slot: this.pools.tiles.add(c, q, _scale.set(kW, 1.2, len), TINT_SECRET), pool: 'tiles' });
      return kb;
    };
    const lipBox = addK(lipStart, lq, lipLen);
    const rampBox = addK(kStart, kq, kLen);
    lipBox.connectEnd = true;
    rampBox.connectStart = true;

    // the lane: a floating golden rooftop following the P→Q line
    const lanePitch = Math.atan(slope) / DEG; // slope = dy/dz > 0 (both fall going forward) → downhill pitch
    const laneAt = new THREE.Vector3(kTop.x, line(laneStart) + laneH, laneStart);
    const laneLen = (laneStart - laneEnd) / Math.cos(lanePitch * DEG);
    const lane = this.tile(laneLen, { at: laneAt, w: 4.6, pitch: lanePitch, tint: TINT_SECRET, bld: 'none' });
    lane.secret = true;
    lane.box.secret = true;
    // rewards: a coin line the whole way and a power-up near the end
    const nCoins = Math.min(40, Math.floor(laneLen / 3.2));
    this.gemLine(lane, 0, 0, 4, laneLen - 4, nCoins);
    this.powerup(lane, Math.min(laneLen - 8, (laneStart - (slow.land ?? laneStart)) / Math.cos(lanePitch * DEG) + 14), this.pick(POWERUPS));
    if (laneLen > 90) this.powerup(lane, laneLen - 10, this.pick(POWERUPS));
    this.secrets++;
    if (this.showHints || this.secrets <= 1) this.sign(conn, conn.len - 14, 'SECRET?', '', '#ffd23f');

    // under the rest of the lane and where you drop off it: one long rooftop parallel to the lane
    const fall = dropReach(v * 1.15, lanePitch * DEG, laneH + 1, this.plus ? JUMP_V : 0);
    this.forcePlain = { len: Math.max(40, (Q.z - laneEnd) / Math.cos(lanePitch * DEG) + fall * 2 + 30), pitch: lanePitch, w: this.W + 6 };
  }

  // ------------------------------------------------------------------ original obstacles (harder)
  // RNG blocks: blocks dropped at random spots on short platforms; later ones slide.
  p_rng() {
    const k = this.k;
    const n = k === 0 ? 2 : this.ri(2, 3);
    for (let i = 0; i < n; i++) {
      if (i > 0) this.drop(this.rf(0.8, 1.8));
      const t = this.tile(this.rf(22, 28));
      const s = 3;
      const blocks = k >= 3 ? 2 : 1;
      for (let j = 0; j < blocks; j++) {
        const lz = t.len * (blocks === 1 ? this.rf(0.45, 0.65) : 0.3 + j * 0.4);
        if (k >= 1 && this.rng() < Math.min(0.3 + 0.15 * k, 0.75)) this.slider(t, lz, s, s, s, t.w / 2 - s / 2, Math.max(1.3, 2.6 - 0.2 * k));
        else this.hazard(t, this.rf(-t.w / 2 + s / 2, t.w / 2 - s / 2), lz, s, s, s);
      }
    }
  }

  // Slants: wide platforms tilted to one side; later ones carry blocks.
  p_slant() {
    const k = this.k;
    const side = this.rng() < 0.5 ? -1 : 1;
    const maxRoll = this.rf(18, 24) + Math.min(k, 3);
    const w = 13;
    for (const r of [maxRoll / 3, (maxRoll * 2) / 3]) this.tile(5, { roll: side * r, w, join: true });
    const hold = this.tile(this.rf(38, 52), { roll: side * maxRoll, w, join: true });
    if (k >= 1) {
      const nb = this.ri(1, k >= 3 ? 3 : 2);
      for (let i = 0; i < nb; i++) {
        const lz = hold.len * (0.25 + (0.6 * i) / Math.max(nb, 1));
        if (this.rng() < 0.45) this.slider(hold, lz, 2.8, 2.8, 2.8, w / 2 - 1.6, 2.2);
        else this.hazard(hold, side * this.rf(0, w / 2 - 1.5), lz, 2.8, 2.8, 2.8);
      }
    } else if (this.rng() < 0.5) this.gemLine(hold, side * (w / 2 - 1.5), side * (w / 2 - 1.5), 4, hold.len - 4, 5);
    for (const r of [(maxRoll * 2) / 3, maxRoll / 3]) this.tile(5, { roll: side * r, w, join: true });
    this.tile(6, { roll: 0, w: 11, join: true });
  }

  // Straights: short thin platforms; later ones have blocks sweeping across them.
  p_straight() {
    const k = this.k;
    const n = this.ri(2, 3);
    const w = Math.max(3.1, this.rf(3.5, 4.2) - k * 0.15);
    for (let i = 0; i < n; i++) {
      if (i > 0) this.drop(this.rf(0.6, 1.6));
      const t = this.tile(this.rf(20, 30), { w, bld: 'pillars' });
      // a sweeper on a one-lane path is pure timing, so only where you can jump / dash over it
      if (this.plus && k >= 1 && this.rng() < 0.5) this.slider(t, t.len * 0.55, 2.4, 1.6, 2.4, 4, this.rf(1.2, 1.8));
      else if (this.rng() < 0.4) this.gemLine(t, 0, 0, 4, t.len - 4, 3);
    }
  }

  // Treblocks: a pair on the edges, a big block in the middle, another pair further on. The middle
  // one starts sliding in later sections.
  p_treblocks() {
    const k = this.k;
    const w = 11,
      hw = w / 2;
    const t = this.tile(76, { w });
    const s = 3;
    for (const x of [-hw + s / 2, hw - s / 2]) this.hazard(t, x, 16, s, s, s);
    if (k >= 2) this.slider(t, 30, 4.4, s, s, 2.3, 1.5);
    else this.hazard(t, 0, 30, 4.4, s, s);
    for (const x of [-hw + s / 2, hw - s / 2]) this.hazard(t, x, 58, s, s, s);
    if (k >= 3) this.hazard(t, 0, 70, 2.6, s, s);
  }

  // Tunnels: a narrow tunnel with red walls, out onto a ramp. Later ones have crushers inside.
  p_tunnel() {
    const k = this.k;
    const v = this.v;
    const fw = Math.max(4.6, 5.4 - k * 0.15),
      wallT = 1.2,
      wallH = 4.4,
      len = this.rf(44, 56);
    this.tile(12, { w: 9 });
    const floor = this.tile(len, { w: fw });
    for (const s of [-1, 1]) this.hazard(floor, s * (fw / 2 + wallT / 2), len / 2, wallT, wallH, len);
    const roofW = fw + wallT * 2;
    const roof = this.sideBox(floor, 0, len / 2, roofW, 1, len, { surface: true, lift: wallH + 0.5, bounce: 0 });
    roof.box.pid = floor.pid;
    this.gemLine(floor, 0, 0, 6, len - 6, 6);
    const ang = this.rf(12, 16);
    this.tile(3, { pitch: 0, w: fw, join: true });
    const ramp = this.tile(5, { pitch: -ang, w: fw, join: true });
    this.launch(ramp, ang, v, this.rf(7, 12));
  }

  // Snakes: long, narrow and curvy, with sweepers crossing them later on, and a ramp at the end.
  p_snake() {
    const k = this.k;
    const v = this.v;
    const w = 3.6;
    const A = this.rf(3, 4.5),
      lambda = this.rf(62, 80),
      total = this.rf(72, 92),
      seg = 3;
    const phase = this.rng() < 0.5 ? 0 : Math.PI;
    this.tile(8, { w: 8 });
    let first = true;
    const segs = [];
    for (let s = 0; s < total; s += seg) {
      const slope = ((A * 2 * Math.PI) / lambda) * Math.cos((2 * Math.PI * (s + seg / 2)) / lambda + phase);
      const t = this.tile(seg, { w, yaw: Math.atan(slope) / DEG, join: !first, bld: 'pillars' });
      segs.push(t);
      first = false;
      if (Math.floor(s / seg) % 4 === 2 && this.rng() < 0.5) this.gem(t.start.clone().addScaledVector(t.up, 1.25));
    }
    if (this.plus && k >= 1) {
      const nsw = this.ri(1, 2);
      for (let i = 0; i < nsw; i++) {
        const t = segs[Math.floor(segs.length * (0.35 + i * 0.3))];
        this.slider(t, 1.5, 2.2, 1.6, 2.2, 4.5, this.rf(1.3, 1.9));
      }
    }
    const ang = this.rf(10, 14);
    this.tile(3, { pitch: this.pitch * 0.4, w: 5, join: true });
    this.tile(3, { pitch: 0, w: 5, join: true });
    const ramp = this.tile(5, { pitch: -ang, w: 5, join: true });
    this.launch(ramp, ang, v, this.rf(6, 11));
  }

  // Spinner: a long red bar sweeping round the middle of a platform.
  p_spinner() {
    const k = this.k;
    const n = k >= 3 ? 2 : 1;
    const t = this.tile(22 + n * 22);
    let dirn = this.rng() < 0.5 ? -1 : 1;
    for (let i = 0; i < n; i++) {
      this.hazard(t, 0, 22 + i * 22, t.w * 0.9, 1, 1, { type: 'spin', speed: dirn * (1.4 + 0.18 * k), phase: this.rf(0, Math.PI) }, null, 0.25);
      dirn = -dirn;
    }
  }

  // Hors: big blocks sliding side to side across short platforms, each out of sync.
  p_hors() {
    const k = this.k;
    const n = this.ri(3, 3 + Math.min(k - 1, 3));
    const cross = Math.max(1.5, 3 - 0.3 * Math.max(k - 2, 0));
    for (let i = 0; i < n; i++) {
      if (i > 0) this.drop(this.rf(0.8, 1.6));
      const t = this.tile(this.rf(17, 21));
      const bw = t.w * 0.4;
      this.slider(t, t.len * 0.55, bw, 2.8, 2.6, t.w / 2 - bw / 2, cross);
    }
  }

  // Verts: three side-by-side blocks rising and falling, staggered.
  p_verts() {
    const k = this.k;
    const n = k >= 3 ? this.ri(2, 3) : this.ri(1, 2);
    const period = Math.max(2.6, 4 - 0.25 * Math.max(k - 2, 0));
    for (let i = 0; i < n; i++) {
      if (i > 0) this.drop(this.rf(0.8, 1.6));
      const t = this.tile(this.rf(30, 38));
      const bw = t.w / 3;
      const base = this.rf(0, 4);
      [-1, 0, 1].forEach((kk, j) => this.hazard(t, kk * bw, t.len * 0.55, bw - 0.05, 3, 3, { type: 'vert', lift: 4.2, period, phase: base + (j * 3 * period) / 4 }));
    }
  }

  // Gate: a full-width red wall with one gap in it that slides from side to side.
  p_gate() {
    const k = this.k;
    const n = this.ri(1, k >= 4 ? 3 : 2);
    const t = this.tile(18 + n * 26);
    const hole = Math.max(3.4, 4.2 - k * 0.1);
    for (let i = 0; i < n; i++) {
      const amp = t.w / 2 - hole / 2 - 0.4;
      const cross = this.rf(1.6, 2.6);
      const phase = this.rf(0, 6);
      const wallW = t.w;
      for (const s of [-1, 1]) this.slider(t, 18 + i * 26, wallW, 3.3, 1, amp, cross, phase, s * (hole / 2 + wallW / 2));
    }
  }

  // Speed tunnel: a building with a short round tunnel through it; the pad inside kicks the speed up
  // a lot, and a ramp at the far end launches you into the next section.
  p_speedTunnel() {
    const v = sectionSpeed(this.genSection + 1) + 1.5;
    const fw = 8,
      R = 5,
      cy = 3,
      len = 30;
    this.tile(14, { w: fw });
    const floor = this.tile(len, { w: fw, join: true, bld: 'none' });
    // tube panels on the arc above the floor (R² = cy² + (fw/2)²)
    const n = 16;
    const a0 = Math.asin(-cy / R);
    const span = Math.PI - 2 * a0;
    const pw = 2 * R * Math.sin(span / (2 * n)) * 1.08;
    for (let i = 0; i < n; i++) {
      const aa = a0 + (span * (i + 0.5)) / n;
      const panel = this.sideBox(floor, R * Math.cos(aa), len / 2, pw, 0.6, len, { roll: aa + Math.PI / 2, surface: true, bounce: 0, lift: cy + R * Math.sin(aa) });
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(panel.box.quat);
      panel.box.pos.addScaledVector(up, -0.3);
      setBoxTransform(panel.box, panel.box.pos);
      this.pools.tiles.set(panel.slot, panel.box.pos, panel.box.quat, _scale.set(pw, 0.6, len));
    }
    // the building the tunnel runs through (world-aligned, decorative) — reaches the bottom too
    const mid = floor.start.clone().addScaledVector(floor.dir, len / 2);
    const depth = len * Math.cos(this.pitch * DEG);
    const roofY = floor.start.y + cy + R + 0.8;
    const topY = roofY + this.rf(8, 22);
    for (const s of [-1, 1]) this.tower(mid.x + s * (R + 4.6), mid.z, 7.6, depth, topY, floor.end.y - 340);
    this.tower(mid.x, mid.z, 2 * R + 1.6, depth, topY, roofY);
    this.tower(mid.x, mid.z, fw, depth, floor.end.y - 1.7, floor.end.y - 340);
    // speed pad
    const padPos = floor.start.clone().addScaledVector(floor.dir, 9).addScaledVector(floor.up, 0.04);
    this.pads.push({ pos: padPos, q: floor.q.clone(), slot: this.pools.pads.add(padPos, floor.q, _scale.set(fw * 0.7, 1, 6)) });
    this.triggers.push({ z: padPos.z, type: 'speed', fired: false, section: this.genSection + 1 });
    this.genSection++;
    const ang = 13;
    this.tile(3, { pitch: 0, w: fw, join: true });
    const ramp = this.tile(5, { pitch: -ang, w: fw, join: true });
    this.launch(ramp, ang, v, this.rf(6, 10), 12);
  }

  // ------------------------------------------------------------------ Plus-mode extras (need jump / dash)
  p_jumpGap() {
    const v = this.v;
    const run = this.tile(Math.max(22, v * 0.75));
    this.sign(run, 4, 'JUMP!', 'SPACE / W / ↑', '#39ff88');
    const th = this.pitch * DEG;
    const G = clamp(v * 0.4, 10, 24);
    let yNoMax = -Infinity,
      yJumpMin = Infinity;
    for (const kk of [0.8, 0.9, 1, 1.1]) {
      const t = G / (v * kk);
      const base = -G * Math.tan(th) - 0.5 * GRAVITY * t * t; // rolling straight off the edge
      yNoMax = Math.max(yNoMax, base);
      yJumpMin = Math.min(yJumpMin, base + JUMP_V * t); // jump adds JUMP_V on top of the slope's own descent
    }
    const yLand = yNoMax + 0.4 * (yJumpMin - yNoMax);
    this.gap(G, -yLand, 0);
    const land = this.tile(Math.max(30, v * 0.6), { w: this.W + 1 });
    this.safeZ = this.cur.z - v * 0.8;
    if (this.rng() < 0.4) this.gemLine(land, 0, 0, 6, 20, 4);
  }

  p_hurdles() {
    const v = this.v;
    const spacing = Math.max(26, v * 0.95 + 6);
    const n = this.ri(2, 3);
    const t = this.tile(spacing * n + 14);
    this.sign(t, 0, 'HURDLES', 'JUMP OVER THEM', '#39ff88');
    for (let i = 0; i < n; i++) this.hazard(t, 0, 16 + i * spacing, t.w + 0.2, 1.1, 0.8);
  }

  p_dashGate() {
    const t = this.tile(56);
    this.sign(t, 6, 'DASH!', 'SHIFT / S / ↓ to phase', '#ff4fd8');
    this.hazard(t, 0, 34, t.w + 0.6, 6.5, 0.7, { gate: true }, TINT_GATE);
  }

  // ------------------------------------------------------------------ runtime
  animate(time) {
    for (const h of this.hazards) {
      const m = h.motion;
      if (!m || !h.alive || m.gate) continue;
      if (m.type === 'hor') {
        // triangle wave: `cross` seconds to go from one side to the other
        const p = ((((time + m.phase) / m.cross) % 2) + 2) % 2;
        const kk = p < 1 ? p : 2 - p;
        _v.copy(h.base).addScaledVector(h.right, (kk * 2 - 1) * m.amp);
        setBoxTransform(h.box, _v);
        this.pools.hazards.set(h.slot, _v, h.baseQuat, h.scale);
      } else if (m.type === 'vert') {
        const per = m.period || 4;
        const p = (((time + m.phase) % per) + per) % per;
        const lift = m.lift * 0.5 * (1 - Math.cos((p / per) * Math.PI * 2));
        _v.copy(h.base).addScaledVector(h.up, lift);
        setBoxTransform(h.box, _v);
        this.pools.hazards.set(h.slot, _v, h.baseQuat, h.scale);
      } else if (m.type === 'spin') {
        _q.setFromAxisAngle(_v.set(0, 1, 0), time * m.speed + m.phase);
        const q = h.baseQuat.clone().multiply(_q);
        setBoxTransform(h.box, h.base, q);
        this.pools.hazards.set(h.slot, h.base, q, h.scale);
      }
    }
  }

  killHazard(h) {
    h.alive = false;
    this.pools.hazards.remove(h.slot);
  }

  takeGem(g) {
    g.taken = true;
    this.pools.gems.remove(g.slot);
  }

  // Floating origin: shift everything so coordinates stay small on very long runs.
  shift(o) {
    for (const list of [this.tiles, this.towers]) {
      for (const t of list) {
        t.box.pos.add(o);
        if (t.box.invQuat) setBoxTransform(t.box, t.box.pos);
        else {
          t.box.min.z += o.z;
          t.box.max.z += o.z;
        }
        if (t.start !== t.box.pos) t.start.add(o);
        if (t.end) t.end.add(o);
        this.pools[t.pool || 'tiles'].set(t.slot, t.box.pos, t.box.quat, _scale.set(t.box.half.x * 2, t.box.half.y * 2, t.box.half.z * 2));
      }
    }
    for (const h of this.hazards) {
      h.base.add(o);
      h.box.pos.add(o);
      setBoxTransform(h.box, h.box.pos);
      this.pools.hazards.set(h.slot, h.box.pos, h.box.quat, h.scale);
    }
    for (const p of this.pads) {
      p.pos.add(o);
      this.pools.pads.set(p.slot, p.pos, p.q, _scale.set(5.6, 1, 6));
    }
    for (const g of this.gems) g.pos.add(o);
    for (const p of this.pickups) p.pos.add(o);
    for (const s of this.signs) s.sprite.position.add(o);
    for (const t of this.triggers) t.z += o.z;
    for (const c of this.center) {
      c.x += o.x;
      c.y += o.y;
      c.z += o.z;
    }
    this.cur.add(o);
    this.safeZ += o.z;
    this.cityZ += o.z;
    this.distBase += o.z;
  }
}
