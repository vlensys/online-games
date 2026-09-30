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

// Like the original, speed only goes up in steps: every speed tunnel ends a section and
// pushes the ball's target speed up a notch.
export function sectionSpeed(section) {
  return Math.min(24 + section * 6, 74);
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

// Horizontal distance of a ballistic flight that lands H units below the launch point.
function flightDist(v, angle, H) {
  const vy = v * Math.sin(angle),
    vx = v * Math.cos(angle);
  const t = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * Math.max(H, 0))) / GRAVITY;
  return { d: vx * t, t };
}

const TINT_FLOOR = new THREE.Color(1, 1, 1);
const TINT_GATE = new THREE.Color(1.1, 0.35, 1.2);
const _scale = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

// Obstacle catalogue, straight from the original game's level generation:
//   early: RNG blocks, slants, straights · middle: treblocks, tunnels, snakes · late: hors, verts
// Every section ends in a speed tunnel. Section 1 = 1 early obstacle, section 2 = 2 early + 2 middle,
// section 3 = 3 of each tier, then 4 of each tier from section 4 on.
const EARLY = ['rng', 'slant', 'straight'];
const MIDDLE = ['treblocks', 'tunnel', 'snake'];
const LATE = ['hors', 'verts'];

export class Track {
  constructor(scene, pools, makeSign, makeShield) {
    this.scene = scene;
    this.pools = pools;
    this.makeSign = makeSign;
    this.makeShield = makeShield;
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
    this.pitch = 18;
    this.W = 10;
    this.lastEnds = [];
    this.pending = [];
    this.pid = 0;
    this.genSection = 0;
    this.queue = [];
    this.lastName = '';
    this.cityZ = 60;
    this.lastShieldPid = 0;
    this.pieces = 0;
    this.safeZ = 1e9; // no pending landing zone

    // start platform (a wide rooftop)
    this.tile(40, { w: 12, pitch: 10 });
    this.tile(24, { w: 11, pitch: 16, join: true });
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

  // ------------------------------------------------------------------ primitives
  // A platform segment. Each call is a new "platform" for scoring unless join:true.
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
    const start = this.cur.clone();
    if (o.xOff) start.x += o.xOff;
    const center = start.clone().addScaledVector(dir, len / 2).addScaledVector(up, -thick / 2);
    const box = makeBox(center, q, new THREE.Vector3(w / 2, thick / 2, len / 2), { surface: o.surface !== false, bounce: o.bounce });
    if (!o.join || !this.pid) this.pid++;
    box.pid = this.pid;
    const end = start.clone().addScaledVector(dir, len);
    const t = { box, start, end, dir, up, right, q, len, w, thick, pid: this.pid, slot: -1 };
    t.slot = this.pools.tiles.add(box.pos, q, _scale.set(w, thick, len), o.tint || TINT_FLOOR);
    this.tiles.push(t);

    if (o.connect !== false) {
      for (const prev of this.lastEnds) {
        if (prev.end.distanceTo(start) < 0.05 + prev.w / 2 && Math.abs(prev.end.y - start.y) < 0.35 && Math.abs(prev.end.z - start.z) < 0.6) {
          prev.box.connectEnd = true;
          box.connectStart = true;
        }
      }
    }
    if (o.advance === false) {
      this.pending.push(t);
    } else {
      this.center.push({ z: start.z, y: start.y, x: start.x });
      this.cur.copy(end);
      if (o.xOff) this.cur.x -= o.xOff;
      this.center.push({ z: end.z, y: end.y, x: this.cur.x });
      this.lastEnds = [...this.pending, t];
      this.pending = [];
    }
    return t;
  }

  // Raw box relative to a tile frame. surface:false boxes are solid (walls); hazard boxes live elsewhere.
  sideBox(t, lx, lz, sx, sy, sz, { roll = 0, surface = false, bounce = 0.35, lift = 0, pool = 'tiles', collide = true } = {}) {
    const q = t.q.clone();
    if (roll) q.multiply(_q.setFromAxisAngle(Z_AXIS, roll));
    const pos = t.start.clone().addScaledVector(t.right, lx).addScaledVector(t.dir, lz).addScaledVector(t.up, lift);
    const box = makeBox(pos, q, new THREE.Vector3(sx / 2, sy / 2, sz / 2), { surface, bounce });
    box.pid = t.pid;
    const s = { box, start: pos, pid: t.pid, slot: this.pools[pool].add(pos, q, _scale.set(sx, sy, sz)), pool };
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

  shield(t, lz) {
    const m = this.makeShield();
    m.position.copy(t.start).addScaledVector(t.dir, lz).addScaledVector(t.up, 1.4);
    this.scene.add(m);
    this.pickups.push({ mesh: m, pos: m.position, type: 'shield', taken: false });
  }

  // decorative wireframe building block (no collision)
  tower(cx, cz, w, d, top, bottom) {
    const h = top - bottom;
    const pos = new THREE.Vector3(cx, bottom + h / 2, cz);
    const slot = this.pools.towers.add(pos, _q.identity(), _scale.set(w, h, d));
    this.towers.push({ box: { pos, min: new THREE.Vector3(0, 0, cz - d / 2), max: new THREE.Vector3(0, 0, cz + d / 2), half: new THREE.Vector3(w / 2, h / 2, d / 2), quat: new THREE.Quaternion() }, slot, pool: 'towers', start: pos });
  }

  // a stack of building columns underneath a platform, so platforms read as rooftops
  buildingUnder(t, depth = 90) {
    const n = Math.max(1, Math.round(t.len / 6));
    for (let i = 0; i < n; i++) {
      const a = (i + 1) / n;
      const p = t.start.clone().addScaledVector(t.dir, t.len * a).addScaledVector(t.up, -t.thick);
      const p0 = t.start.clone().addScaledVector(t.dir, (t.len * i) / n);
      this.tower(p.x, (p.z + p0.z) / 2, t.w * 0.96, Math.abs(p.z - p0.z) + 0.02, p.y + 0.05, p.y - depth);
    }
  }

  // ------------------------------------------------------------------ generation
  buildQueue() {
    const k = this.genSection;
    const n = k === 0 ? 1 : k === 1 ? 2 : k === 2 ? 3 : 4;
    const q = [];
    const choose = (list, tier) => {
      let name;
      do name = this.pick(list);
      while (list.length > 1 && name === this.lastName);
      // snakes (thin) stop appearing once the run is going (original: none after 50 points)
      if (name === 'snake' && k > 2) name = this.pick(['treblocks', 'tunnel']);
      if (this.plus && this.rng() < 0.3) name = this.pick(tier === 'early' ? ['jumpGap'] : tier === 'middle' ? ['jumpGap', 'hurdles'] : ['dashGate', 'hurdles']);
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
        const x1 = ref.x + side * (this.rf(17, 21) + w1 / 2);
        this.tower(x1, z, w1, d1, ref.y + this.rf(-18, 34), ref.y - 160);
        if (this.rng() < 0.75) {
          const w2 = this.rf(9, 16),
            d2 = this.rf(8, 14);
          const x2 = ref.x + side * (this.rf(36, 60) + w2 / 2);
          this.tower(x2, z + this.rf(-3, 3), w2, d2, ref.y + this.rf(0, 60), ref.y - 160);
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
    this.pitch = clamp(this.pitch + this.rf(-3, 3), 16, 24);
    this.W = 10;
    this.pieces++;
    const z0 = this.cur.z;

    // connector between obstacles: a plain platform, a small step down onto the next rooftop,
    // or a ramp that jumps the gap between two buildings
    const gappers = ['tunnel', 'snake', 'straight', 'jumpGap', 'speedTunnel', 'hors'];
    const r = this.rng();
    if (this.pieces > 1 && r < 0.3 && this.cur.z < this.safeZ) this.buildingHop();
    else {
      if (this.pieces > 1 && r < 0.55) this.drop(this.rf(1, 2.2));
      let len = this.rf(10, 18);
      if (gappers.includes(name) && this.cur.z - len > this.safeZ) len = Math.min(this.cur.z - this.safeZ + 6, 150);
      const t = this.tile(len);
      if (this.rng() < 0.25) this.gemLine(t, 0, 0, 3, t.len - 3, 3);
    }

    this['p_' + name]();
    if (this.log) this.log.push({ name, z0, z1: this.cur.z, d: this.distAt(z0) });
  }

  // Ramp off the end of a rooftop, fly the gap, land on a lower rooftop.
  buildingHop() {
    const v = this.v;
    const pre = this.tile(this.rf(12, 18));
    this.buildingUnder(pre);
    const ang = this.rf(10, 15);
    this.tile(3, { pitch: 0, join: true });
    const ramp = this.tile(5, { pitch: -ang, join: true });
    this.launch(ramp, ang, v, this.rf(4, 8));
  }

  // Gap + landing rooftop after a ramp. Sized from the real flight so it's always makeable.
  launch(ramp, ang, v, H, landW = 12) {
    const a = ang * DEG;
    const G = Math.min(0.78 * flightDist(v * 0.72, a, H).d, 0.6 * flightDist(v * 0.9, a, H).d);
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
    this.buildingUnder(land);
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

  // ------------------------------------------------------------------ original obstacles
  // RNG blocks: a single block dropped at a random spot on a short platform.
  p_rng() {
    const n = this.ri(1, 2);
    for (let i = 0; i < n; i++) {
      if (i > 0) this.drop(this.rf(0.8, 1.6));
      const t = this.tile(this.rf(22, 28));
      const s = 2.8;
      this.hazard(t, this.rf(-t.w / 2 + s / 2, t.w / 2 - s / 2), t.len * this.rf(0.45, 0.65), s, s, s);
    }
  }

  // Slants: a wide platform tilted to one side; steer up it or roll off the low edge.
  p_slant() {
    const side = this.rng() < 0.5 ? -1 : 1;
    const maxRoll = this.rf(16, 22);
    const w = 13;
    for (const r of [maxRoll / 3, (maxRoll * 2) / 3]) this.tile(5, { roll: side * r, w, join: true });
    const hold = this.tile(this.rf(36, 52), { roll: side * maxRoll, w, join: true });
    if (this.rng() < 0.5) this.gemLine(hold, side * (w / 2 - 1.5), side * (w / 2 - 1.5), 4, hold.len - 4, 5);
    for (const r of [(maxRoll * 2) / 3, maxRoll / 3]) this.tile(5, { roll: side * r, w, join: true });
    this.tile(6, { roll: 0, w: 11, join: true });
  }

  // Straights: short, thin platforms — centre the ball and it rolls through on its own.
  p_straight() {
    const n = this.ri(2, 3);
    const w = this.rf(3.6, 4.4);
    for (let i = 0; i < n; i++) {
      if (i > 0) this.drop(this.rf(0.6, 1.4));
      const t = this.tile(this.rf(20, 30), { w });
      if (this.rng() < 0.4) this.gemLine(t, 0, 0, 4, t.len - 4, 3);
    }
  }

  // Treblocks: a pair of blocks on the edges, then a big block in the middle, then another pair further on.
  p_treblocks() {
    const w = 11,
      hw = w / 2;
    const t = this.tile(76, { w });
    const s = 3;
    for (const x of [-hw + s / 2, hw - s / 2]) this.hazard(t, x, 16, s, s, s);
    this.hazard(t, 0, 30, 4.4, s, s);
    for (const x of [-hw + s / 2, hw - s / 2]) this.hazard(t, x, 58, s, s, s);
  }

  // Tunnels: roll straight through a narrow tunnel with red walls, out onto a ramp.
  // The roof is a (safer) path too.
  p_tunnel() {
    const v = this.v;
    const fw = 5.4,
      wallT = 1.2,
      wallH = 4.4,
      len = this.rf(44, 56);
    this.tile(12, { w: 9 });
    const floor = this.tile(len, { w: fw });
    for (const s of [-1, 1]) this.hazard(floor, s * (fw / 2 + wallT / 2), len / 2, wallT, wallH, len);
    // roof slab on top of the walls (walkable)
    const roofW = fw + wallT * 2;
    const roof = this.sideBox(floor, 0, len / 2, roofW, 1, len, { surface: true, lift: wallH + 0.5, bounce: 0 });
    roof.box.pid = floor.pid;
    this.buildingUnder(floor, 60);
    const ang = this.rf(11, 15);
    this.tile(3, { pitch: 0, w: fw, join: true });
    const ramp = this.tile(5, { pitch: -ang, w: fw, join: true });
    this.launch(ramp, ang, v, this.rf(4, 7));
  }

  // Snakes: long, narrow and curvy, with a ramp at the end.
  p_snake() {
    const v = this.v;
    const w = 3.6;
    const A = this.rf(3, 4.5),
      lambda = this.rf(62, 80),
      total = this.rf(72, 92),
      seg = 3;
    const phase = this.rng() < 0.5 ? 0 : Math.PI;
    this.tile(8, { w: 8 });
    let first = true;
    for (let s = 0; s < total; s += seg) {
      const slope = ((A * 2 * Math.PI) / lambda) * Math.cos((2 * Math.PI * (s + seg / 2)) / lambda + phase);
      const t = this.tile(seg, { w, yaw: Math.atan(slope) / DEG, join: !first });
      first = false;
      if (Math.floor(s / seg) % 4 === 2 && this.rng() < 0.5) this.gem(t.start.clone().addScaledVector(t.up, 1.25));
    }
    const ang = this.rf(10, 14);
    this.tile(3, { pitch: this.pitch * 0.4, w: 5, join: true });
    this.tile(3, { pitch: 0, w: 5, join: true });
    const ramp = this.tile(5, { pitch: -ang, w: 5, join: true });
    this.launch(ramp, ang, v, this.rf(4, 7));
  }

  // Hors: big blocks sliding side to side across short platforms, each out of sync.
  p_hors() {
    const n = this.ri(3, 4);
    for (let i = 0; i < n; i++) {
      if (i > 0) this.drop(this.rf(0.8, 1.5));
      const t = this.tile(this.rf(18, 22));
      const bw = t.w * 0.36;
      this.hazard(t, 0, t.len * 0.55, bw, 2.8, 2.6, { type: 'hor', amp: t.w / 2 - bw / 2, cross: 3, phase: this.rf(0, 6) });
    }
  }

  // Verts: three side-by-side blocks rising and falling (2s up, 2s down), staggered by 3s.
  p_verts() {
    const n = this.ri(1, 2);
    for (let i = 0; i < n; i++) {
      if (i > 0) this.drop(this.rf(0.8, 1.5));
      const t = this.tile(this.rf(34, 42));
      const bw = t.w / 3;
      const base = this.rf(0, 4);
      [-1, 0, 1].forEach((k, j) => this.hazard(t, k * bw, t.len * 0.55, bw - 0.05, 3, 3, { type: 'vert', lift: 4.2, phase: base + j * 3 }));
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
    const floor = this.tile(len, { w: fw, join: true });
    // tube panels on the arc above the floor: circle centre is cy above the floor, and the circle
    // meets the floor exactly at its edges (R² = cy² + (fw/2)²)
    const n = 16;
    const a0 = Math.asin(-cy / R);
    const span = Math.PI - 2 * a0;
    const pw = 2 * R * Math.sin(span / (2 * n)) * 1.08;
    for (let i = 0; i < n; i++) {
      const aa = a0 + (span * (i + 0.5)) / n;
      const panel = this.sideBox(floor, R * Math.cos(aa), len / 2, pw, 0.6, len, { roll: aa + Math.PI / 2, surface: true, bounce: 0, lift: cy + R * Math.sin(aa) });
      // the box's inner (top) face should sit on the circle: move it outward by half its thickness
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(panel.box.quat);
      panel.box.pos.addScaledVector(up, -0.3);
      setBoxTransform(panel.box, panel.box.pos);
      this.pools.tiles.set(panel.slot, panel.box.pos, panel.box.quat, _scale.set(pw, 0.6, len));
    }
    // the building the tunnel runs through (world-aligned, decorative)
    const mid = floor.start.clone().addScaledVector(floor.dir, len / 2);
    const depth = len * Math.cos(this.pitch * DEG);
    const roofY = floor.start.y + cy + R + 0.8;
    const topY = roofY + this.rf(8, 22);
    for (const s of [-1, 1]) this.tower(mid.x + s * (R + 4.6), mid.z, 7.6, depth, topY, floor.end.y - 80);
    this.tower(mid.x, mid.z, 2 * R + 1.6, depth, topY, roofY);
    // speed pad
    const padPos = floor.start.clone().addScaledVector(floor.dir, 9).addScaledVector(floor.up, 0.04);
    this.pads.push({ pos: padPos, q: floor.q.clone(), slot: this.pools.pads.add(padPos, floor.q, _scale.set(fw * 0.7, 1, 6)) });
    this.triggers.push({ z: padPos.z, type: 'speed', fired: false, section: this.genSection + 1 });
    this.genSection++;
    // exit ramp and jump into the next section
    const ang = 13;
    this.tile(3, { pitch: 0, w: fw, join: true });
    const ramp = this.tile(5, { pitch: -ang, w: fw, join: true });
    this.launch(ramp, ang, v, this.rf(4, 7), 12);
  }

  // ------------------------------------------------------------------ Plus-mode extras (need jump / dash)
  p_jumpGap() {
    const v = this.v;
    const run = this.tile(Math.max(22, v * 0.75));
    this.sign(run, 4, 'JUMP!', 'SPACE / W / ↑', '#39ff88');
    const th = this.pitch * DEG;
    const G = clamp(v * 0.38, 9, 21);
    let yNoMax = -Infinity,
      yJumpMin = Infinity;
    for (const k of [0.8, 0.9, 1, 1.1]) {
      const t = G / (v * k);
      const base = -G * Math.tan(th) - 0.5 * GRAVITY * t * t; // rolling straight off the edge
      yNoMax = Math.max(yNoMax, base);
      yJumpMin = Math.min(yJumpMin, base + JUMP_V * t); // jump adds JUMP_V on top of the slope's own descent
    }
    const yLand = yNoMax + 0.4 * (yJumpMin - yNoMax);
    this.gap(G, -yLand, 0);
    const land = this.tile(Math.max(30, v * 0.6), { w: this.W + 1 });
    this.buildingUnder(land);
    this.safeZ = this.cur.z - v * 0.8;
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
        // triangle wave: 3s to cross from one edge to the other
        const p = ((time + m.phase) / m.cross) % 2;
        const k = p < 1 ? p : 2 - p;
        _v.copy(h.base).addScaledVector(h.right, (k * 2 - 1) * m.amp);
        setBoxTransform(h.box, _v);
        this.pools.hazards.set(h.slot, _v, h.baseQuat, h.scale);
      } else if (m.type === 'vert') {
        const p = (((time + m.phase) % 4) + 4) % 4;
        const lift = m.lift * 0.5 * (1 - Math.cos((p / 4) * Math.PI * 2));
        _v.copy(h.base).addScaledVector(h.up, lift);
        setBoxTransform(h.box, _v);
        this.pools.hazards.set(h.slot, _v, h.baseQuat, h.scale);
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
