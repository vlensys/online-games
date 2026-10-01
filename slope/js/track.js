import * as THREE from 'three';
import { makeBox, setBoxTransform } from './physics.js';

// Slope+ track: a rebuild of the original Slope's level generator — the same pieces with the same
// sizes, gaps, offsets and section rules — scaled ×2 so the ball has radius 1.
//
// The original builds everything with a spawn cursor that walks down a 45° slope in its own frame:
// x across, s along the slope (downhill), h straight up off the slope. Piece definitions below are
// written in the original's units in that frame; S converts to world units.

export const BALL_R = 1;
const S = 2;
const BL = 10 * Math.SQRT2; // one rooftop tile: 10 × 10 on the 45° slope (original units)
export const POWERUPS = ['shield', 'magnet', 'double', 'slowmo'];

// Forward (horizontal) speed the ball is driven to in each section; section 0 is the run-in tunnel.
// Like the original, every speed tunnel pushes it up a notch.
export function sectionSpeed(k) {
  return Math.min(26 + k * 6, 96);
}
// Everything else scales with the square of the speed (the original keeps adding "push down" and
// steering force at every speed-up), so the ball takes the same lines through the same pieces in
// every section — only faster. Gravity is strong: it pins the ball to the 45° slope, and every gap
// is a short, sharp drop rather than a long float.
const V1 = 44;
const lam2 = (k) => (sectionSpeed(k) / V1) ** 2;
export function gravityFor(k) {
  return 160 * lam2(k);
}
export const GRAVITY = gravityFor(0);
// Plus mode: a hop straight off the slope, high enough to clear a red block.
export function jumpVFor(k) {
  return Math.sqrt(2 * gravityFor(k) * Math.SQRT1_2 * 7);
}
export const JUMP_V = jumpVFor(0);
export function steerFor(k) {
  return 72 * lam2(k);
}
// how much sideways drift the ground soaks up per second, and the fastest you can slide sideways
export function latDampFor(k) {
  return 1.2 * Math.sqrt(lam2(k));
}
export function latCapFor(k) {
  return 40 * Math.sqrt(lam2(k));
}

const R = Math.SQRT1_2;
const FWD = new THREE.Vector3(0, -R, -R); // downhill along the slope
const UPN = new THREE.Vector3(0, R, -R); // straight up off the slope
const RIGHT = new THREE.Vector3(1, 0, 0);
const VERT = new THREE.Vector3(0, 1, 0);
const DEG = Math.PI / 180;
const Q45 = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 4, 0, 0));
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const lerp = THREE.MathUtils.lerp;
const _a = new THREE.Vector3(),
  _b = new THREE.Vector3(),
  _c = new THREE.Vector3(),
  _v = new THREE.Vector3(),
  _s = new THREE.Vector3(),
  _q = new THREE.Quaternion(),
  _m = new THREE.Matrix4();

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

const CITY_NEAR = new THREE.Color(0.07, 0.07, 0.07); // skyline lines are dimmer than the track
const CITY_FAR = new THREE.Color(0.035, 0.035, 0.035);
// the speed tunnels' shells are drawn a little dimmer than the track
const TINT_SHELL = new THREE.Color(0.55, 0.55, 0.55);
// the death towers are drawn in thin, dimmer red (the original's "PerilThin")
const TINT_TOWER = new THREE.Color(0.45, 0.45, 0.45);

// Speed tunnel cross-section (original units, measured across the 10-wide tile): the outer shell you
// can roll up and over ("speed tunnel skip"), and the inside of the arch.
const ARC_OUT_X = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];
const ARC_OUT_H = [0, 2.05, 2.92, 3.49, 3.91, 4.33, 4.51, 4.69, 4.88, 4.92, 4.92, 4.92, 4.88, 4.69, 4.51, 4.33, 3.91, 3.49, 2.92, 2.05, 0];
const ARC_IN_X = [2.2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 7.8];
const ARC_IN_H = [0, 2.2, 2.62, 2.96, 3.14, 3.29, 3.29, 3.29, 3.14, 2.96, 2.62, 2.2, 0];

export class Track {
  constructor(scene, pools, makeSign, makePickup) {
    this.scene = scene;
    this.pools = pools;
    this.makeSign = makeSign;
    this.makePickup = makePickup;
    this.tiles = [];
    this.hazards = [];
    this.towers = [];
    this.gems = [];
    this.pickups = [];
    this.signs = [];
    this.triggers = [];
    this.scores = [];
    this.pads = [];
    this.camZones = [];
    this.center = [];
  }

  reset(seed, mode) {
    for (const s of this.signs) this.scene.remove(s.sprite);
    for (const p of this.pickups) this.scene.remove(p.mesh);
    for (const k of ['tiles', 'hazards', 'gems', 'towers', 'pads']) this.pools[k].clear();
    this.tiles = [];
    this.hazards = [];
    this.towers = [];
    this.gems = [];
    this.pickups = [];
    this.signs = [];
    this.triggers = [];
    this.scores = [];
    this.pads = [];
    this.camZones = [];
    this.center = [];
    this.rng = mulberry32(seed);
    this.mode = mode;
    this.plus = mode === 'plus';
    this.distBase = 0;
    this.pid = 0;
    this.lastEnds = [];
    this.cityZ = 80;
    // the original's spawner state
    this.C = new THREE.Vector3(-5 * S, 0, 0); // spawn cursor (left edge of the track, top of the roof)
    this.speedUps = 0;
    this.longWeight = 1; // thin pieces (straights, snakes) stop once you have 50 points
    this.genScore = 0;
    this.genSection = 0;
    this.queue = [];
    this.pieces = 0;
    this.goRun();
  }

  rf(a, b) {
    return a + (b - a) * this.rng();
  }
  pick(weighted) {
    let tot = 0;
    for (const [, w] of weighted) tot += w;
    let r = this.rng() * tot;
    for (const [name, w] of weighted) {
      if ((r -= w) < 0) return name;
    }
    return weighted[0][0];
  }
  distAt(z) {
    return this.distBase - z;
  }

  // ------------------------------------------------------------------ cursor (original units)
  tr(x, y, z) {
    this.C.addScaledVector(RIGHT, x * S).addScaledVector(UPN, y * S).addScaledVector(FWD, z * S);
  }
  fwd() {
    this.tr(0, 0, BL);
  }
  // point in the cursor's slope frame
  P(x, s, h, base = this.C) {
    return base.clone().addScaledVector(RIGHT, x * S).addScaledVector(FWD, s * S).addScaledVector(UPN, h * S);
  }
  // the slope frame turned about its own axes (pitch: a kicker lip, roll: a tilted roof, yaw: a snake bend)
  frame(pitch = 0, roll = 0, yaw = 0) {
    const q = Q45.clone();
    if (yaw) q.multiply(_q.setFromAxisAngle(Y_AXIS, yaw));
    if (pitch) q.multiply(_q.setFromAxisAngle(X_AXIS, pitch));
    if (roll) q.multiply(_q.setFromAxisAngle(Z_AXIS, roll));
    return q;
  }

  // ------------------------------------------------------------------ primitives (world units)
  // A rooftop: `start` is the middle of its back edge, it runs `len` along its own forward axis.
  // body: depth of the building under it (vertical walls, like the original's); without one it's
  // drawn as a slab `slab` thick. The collider is a thick slab so nothing can tunnel through it.
  plate(start, q, w, len, o = {}) {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const T = o.thick ?? 10;
    const center = start.clone().addScaledVector(dir, len / 2).addScaledVector(up, -T / 2);
    const box = makeBox(center, q, new THREE.Vector3(w / 2, T / 2, len / 2), { surface: o.surface !== false, bounce: o.bounce ?? null });
    if (!o.join || !this.pid) this.pid++;
    box.pid = this.pid;
    if (o.secret) box.secret = true;
    const end = start.clone().addScaledVector(dir, len);
    const m = new THREE.Matrix4();
    if (o.body) {
      m.makeBasis(_a.copy(right).multiplyScalar(w), _b.set(0, o.body, 0), _c.copy(dir).multiplyScalar(-len));
      m.setPosition(_v.copy(start).addScaledVector(dir, len / 2).add(_s.set(0, -o.body / 2, 0)));
    } else {
      const th = o.slab ?? 1.2;
      m.compose(_v.copy(start).addScaledVector(dir, len / 2).addScaledVector(up, -th / 2), q, _s.set(w, th, len));
    }
    const pool = o.pool || 'tiles';
    const t = { box, start, end, dir, up, right, q, len, w, pid: this.pid, pool, m, slot: this.pools[pool].addMatrix(m, o.tint || null), secret: !!o.secret };
    this.tiles.push(t);
    if (o.connect !== false) {
      for (const prev of this.lastEnds) {
        if (prev.end.distanceTo(start) < 0.05 + Math.min(prev.w, w) / 2 && Math.abs(prev.end.y - start.y) < 0.35) {
          prev.box.connectEnd = true;
          box.connectStart = true;
        }
      }
      this.lastEnds = [t];
    }
    if (o.center) this.center.push({ z: start.z, y: start.y, x: start.x }, { z: end.z, y: end.y, x: end.x });
    return t;
  }

  // a box in the cursor's slope frame (original units) that you can roll on: tunnel ledges, roofs
  sboxTile(x0, x1, s0, s1, h0, h1, o = {}) {
    const th = (h1 - h0) * S;
    return this.plate(this.P((x0 + x1) / 2, s0, h1), Q45, (x1 - x0) * S, (s1 - s0) * S, { thick: th, slab: th, connect: false, ...o });
  }

  // a deadly red box in the slope frame (original units)
  sboxHaz(x0, x1, s0, s1, h0, h1) {
    const c = this.P((x0 + x1) / 2, (s0 + s1) / 2, (h0 + h1) / 2);
    const half = new THREE.Vector3(((x1 - x0) * S) / 2, ((h1 - h0) * S) / 2, ((s1 - s0) * S) / 2);
    const m = new THREE.Matrix4().compose(c, Q45, _s.copy(half).multiplyScalar(2));
    return this.addHazard(makeBox(c, Q45, half), m);
  }

  // a red block standing on the slope with vertical walls and a top parallel to the slope, exactly
  // like the original's (`L` = length of its foot along the slope, `Hv` = its height, original units).
  // The collider is the block's cross-section at the height where the ball's centre rolls.
  block(base, x0, x1, L, Hv, motion = null) {
    const xc = (x0 + x1) / 2,
      w = (x1 - x0) * S;
    const c = this.P(xc, (L - 1) / 2, Hv * R * 0.5, base);
    const half = new THREE.Vector3(w / 2, Hv * R * S * 0.5, (L * S) / 2);
    const m = new THREE.Matrix4().makeBasis(_a.set(w, 0, 0), _b.set(0, Hv * S, 0), _c.copy(FWD).multiplyScalar(-L * S));
    m.setPosition(this.P(xc, L / 2, 0, base).addScaledVector(VERT, (Hv * S) / 2));
    return this.addHazard(makeBox(c, Q45, half), m, motion);
  }

  addHazard(box, m, motion = null, tint = null) {
    const h = { box, base: box.pos.clone(), m, mBase: m.clone(), motion, alive: true };
    h.slot = this.pools.hazards.addMatrix(m, tint);
    this.hazards.push(h);
    return h;
  }

  // world-aligned red box (the death towers beside the track)
  hazWorld(x0, x1, y0, y1, z0, z1, tint = null) {
    const c = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const half = new THREE.Vector3((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2);
    const m = new THREE.Matrix4().compose(c, _q.identity(), _s.copy(half).multiplyScalar(2));
    return this.addHazard(makeBox(c, _q, half), m, null, tint);
  }

  gem(pos) {
    const g = { pos: pos.clone(), taken: false, phase: this.rng() * 6 };
    g.slot = this.pools.gems.add(pos, _q.identity(), _s.set(1, 1, 1));
    this.gems.push(g);
  }
  // a line of coins along the slope frame (original units), floating just above the surface
  coins(x, s0, s1, h, n, base = this.C) {
    for (let i = 0; i < n; i++) this.gem(this.P(x, lerp(s0, s1, n === 1 ? 0.5 : i / (n - 1)), h + 1.1, base));
  }
  powerup(pos, type = this.pick(POWERUPS.map((p) => [p, 1]))) {
    const mesh = this.makePickup(type);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.pickups.push({ pos: pos.clone(), type, mesh, taken: false });
  }

  pad(t) {
    const pos = t.start.clone().addScaledVector(t.dir, t.len / 2).addScaledVector(t.up, 0.06);
    this.pads.push({ pos, q: t.q.clone(), slot: this.pools.pads.add(pos, t.q, _s.set(t.w * 0.7, 1, t.len * 0.8)) });
  }
  scorePoint() {
    this.scores.push({ z: this.C.z, done: false });
    this.genScore++;
  }

  // ------------------------------------------------------------------ the original's prefabs
  // "slope": a 10×10 rooftop on its building
  slopeTile(o = {}) {
    return this.plate(this.P(5, 0, 0), Q45, 10 * S, BL * S, { body: 45 * S, center: true, ...o });
  }
  // "slopeSpeedArrows": the same, with speed arrows on it
  arrowsTile() {
    const t = this.slopeTile();
    this.pad(t);
    return t;
  }
  // a rooftop whose far end curls up into a kicker; lip = [[s, h], ...] (original units)
  lipped(x0, x1, flatTo, lip, o = {}) {
    const xc = (x0 + x1) / 2,
      w = (x1 - x0) * S;
    const t = this.plate(this.P(xc, 0, 0), Q45, w, flatTo * S, { body: o.body ?? 45 * S, center: o.center, connect: o.connect });
    let prev = [flatTo, 0];
    for (const p of lip) {
      const ds = p[0] - prev[0],
        dh = p[1] - prev[1];
      this.plate(this.P(xc, prev[0], prev[1]), this.frame(Math.atan2(dh, ds)), w, Math.hypot(ds, dh) * S, { body: (prev[1] + 1.5) * S, join: true, connect: o.connect, thick: 4 });
      prev = p;
    }
    return t;
  }
  // "jump": rooftop with a kicker at the end (ends each tunnel run)
  jumpTile() {
    return this.lipped(
      0,
      10,
      9.9,
      [
        [11.31, 0.445],
        [12.73, 1.39],
      ],
      { center: true }
    );
  }
  // "jumpGapMid": after a red tunnel — small kickers on the sides, a bigger one in the middle
  jumpGapMid() {
    const side = [
      [11.31, 0.445],
      [12.73, 1.39],
    ];
    this.lipped(0, 3.33, 9.9, side, { connect: false });
    this.lipped(6.67, 10, 9.9, side, { connect: false });
    this.lipped(
      3.33,
      6.67,
      7.4,
      [
        [10, 0.94],
        [12.73, 2.82],
      ],
      { connect: false }
    );
    const a = this.P(5, 0, 0),
      e = this.P(5, BL, 0);
    this.center.push({ z: a.z, y: a.y, x: a.x }, { z: e.z, y: e.y, x: e.x });
    this.lastEnds = [];
  }
  // "deathTower": the tall red towers either side of where an obstacle starts
  deathTowers() {
    const c = this.C;
    const top = c.y + 10 * S,
      bottom = c.y + 10 * S - 300 * S;
    this.hazWorld(c.x - 20 * S, c.x - 10 * S, bottom, top, c.z - 10 * S, c.z, TINT_TOWER);
    this.hazWorld(c.x + 20 * S, c.x + 30 * S, bottom, top, c.z - 10 * S, c.z, TINT_TOWER);
  }
  // speed tunnel / run-in tunnel shell over the tiles starting at the cursor
  arch(sides, top, danger, long = false) {
    const base = this.C.clone();
    // outer shell (you can ride all the way over it): the full profile under the arch, with the
    // sides tapering in and out at both ends
    for (let i = 0; i < ARC_OUT_X.length - 1; i++) {
      const xa = ARC_OUT_X[i],
        xb = ARC_OUT_X[i + 1],
        ha = ARC_OUT_H[i],
        hb = ARC_OUT_H[i + 1];
      // the outer sides run on a little past the crown at the far end
      const onSide = xb <= 2 || xa >= 8;
      this.shellPanel(base, xa, ha, xb, hb, top[0], onSide ? sides[1] - 6 : top[1], true);
    }
    // a ramp up onto each side of the shell, outside the red rails (the "speed tunnel skip")
    for (const [x0, x1] of [
      [0, 1.6],
      [8.4, 10],
    ]) {
      const ds = top[0] - sides[0],
        dh = 2.92;
      this.plate(this.P((x0 + x1) / 2, sides[0], 0, base), this.frame(Math.atan2(dh, ds)), (x1 - x0) * S, Math.hypot(ds, dh) * S, { thick: 0.9, slab: 1.2, connect: false, tint: TINT_SHELL, secret: true });
    }
    // inside of the arch
    for (let i = 0; i < ARC_IN_X.length - 1; i++) {
      this.shellPanel(base, ARC_IN_X[i], ARC_IN_H[i], ARC_IN_X[i + 1], ARC_IN_H[i + 1], top[0], top[1], false);
    }
    // red strips along the bottom of the inside walls
    const keep = this.C;
    this.C = base;
    this.sboxHaz(1.66, 2.44, danger[0], danger[1], 0, 2.15);
    this.sboxHaz(7.56, 8.34, danger[0], danger[1], 0, 2.15);
    this.C = keep;
    this.camZones.push({ z0: this.P(5, danger[0], 0, base).z, z1: this.P(5, danger[1], 0, base).z, x: base.x + 5 * S, long });
    // a reward for going over the top: coins along the crown
    this.coins(5, top[0] + 4, top[1] - 4, 4.92, long ? 9 : 6, base);
  }
  // one strip of the shell between two points of the cross-section, running from s0 to s1
  shellPanel(base, xa, ha, xb, hb, s0, s1, outer) {
    const ang = Math.atan2(hb - ha, xb - xa);
    const wid = Math.hypot(xb - xa, hb - ha) * S;
    const q = this.frame(0, ang);
    const mid = this.P((xa + xb) / 2, s0, (ha + hb) / 2, base);
    if (outer) return this.plate(mid, q, wid, (s1 - s0) * S, { thick: 0.9, slab: 1.2, connect: false, tint: TINT_SHELL, secret: true });
    // inside: a solid panel just outside the arch's inner surface
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    return this.plate(mid.clone().addScaledVector(up, 1.2), q, wid, (s1 - s0) * S, { thick: 1.2, slab: 1.2, surface: false, connect: false, tint: TINT_SHELL });
  }
  // ------------------------------------------------------------------ the original's runs
  // "spawn go tunnel run": the drop-in chute, a long arched run-in with speed arrows, then a jump
  goRun() {
    this.tr(0, -6, 0);
    // the chute the ball drops into (the original drops it from above into a curved funnel)
    let p = this.P(5, 0, 0);
    const chute = [];
    for (const [pitch, len] of [
      [54, 5],
      [66, 5],
      [78, 5],
    ]) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch * DEG, 0, 0));
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      const start = p.clone().addScaledVector(dir, -len * S);
      chute.unshift({ start, q, len: len * S });
      p = start;
    }
    for (const c of chute) this.plate(c.start, c.q, 10 * S, c.len, { body: 6 * S, center: true });
    const top = chute[0];
    const up0 = new THREE.Vector3(0, 1, 0).applyQuaternion(top.q);
    this.startPos = top.start.clone().addScaledVector(up0, BALL_R + 0.15);
    // run-in tunnel: arrows tiles under a long arch
    this.arch([2, 84], [12, 75], [0, 84.8], true);
    for (let i = 0; i < 5; i++) {
      if (i > 0) this.fwd();
      this.arrowsTile();
    }
    this.speedUpPad();
    this.fwd();
    this.jumpTile();
    this.scorePoint();
  }
  // the speed-up pad: the next section starts here (the original generates it at this moment)
  speedUpPad() {
    this.genSection++;
    this.triggers.push({ z: this.C.z, type: 'speed', fired: false, section: this.genSection });
    this.planSection();
  }
  // The original's section rules: a set of early obstacles, then (from section 2) a set of middle
  // ones, then (from section 3) a set of late ones — each set is one type repeated 1, 2, 3, then 4
  // times — and a speed tunnel to finish. Thin pieces stop once the score reaches 50.
  planSection() {
    this.speedUps++;
    const laps = this.speedUps - 1;
    if (this.genScore >= 50) this.longWeight = 0;
    const reps = Math.min(this.speedUps, 4);
    const q = [];
    const easy = this.pick([
      ['easy', 1],
      ['thin', this.longWeight],
      ['tiltL', 0.5],
      ['tiltR', 0.5],
    ]);
    for (let i = 0; i < reps; i++) q.push(easy.startsWith('tilt') && i > 0 ? (this.rng() < 0.5 ? 'tiltL' : 'tiltR') : easy);
    if (laps >= 1) {
      const mid = this.pick([
        ['treblocks', 1],
        ['deathTunnel', 1],
        ['dogleg', this.longWeight],
      ]);
      for (let i = 0; i < reps; i++) q.push(mid === 'dogleg' && i === 0 ? 'doglegFirst' : mid);
    }
    if (laps >= 2) {
      const hard = this.pick([
        ['verts', 1],
        ['hors', 1],
      ]);
      for (let i = 0; i < reps; i++) q.push(hard);
    }
    q.push('tunnelRun');
    this.queue.push(...q);
  }

  // "spawn easy obsticle" (RNG blocks): three rooftops, one block that never sits on the right edge
  p_easy() {
    this.tr(0, -2, 20);
    this.slopeTile();
    this.deathTowers();
    if (this.rng() < 0.45) this.coins(5, 3, 12, 0, 3);
    this.fwd();
    this.slopeTile();
    const off = this.rf(0, 6.5);
    this.block(this.C, off, off + 1.67, 3.02, 2.93);
    this.fwd();
    this.slopeTile();
    this.scorePoint();
  }
  // "spawn thin" (straights): a long thin road off the left edge, ending in a lip; each one steps
  // further left
  p_thin() {
    this.tr(0, -2, 10);
    this.lipped(
      -2.5,
      2.5,
      74.5,
      [
        [75.6, 0.45],
        [76.8, 1.15],
      ],
      { center: true, body: 310 * S }
    );
    if (this.rng() < 0.5) this.coins(0, 12, 60, 0, 5);
    this.tr(-2.6, 0, 80);
    this.scorePoint();
    this.tr(0, 0, -5);
  }
  // "spawn tilt left/right": five wide rooftops tilted ~31° to one side
  p_tilt(side) {
    this.tr(0, -6, 20);
    const base = this.C.clone();
    const phi = Math.atan(0.422) * side;
    for (let i = 0; i < 5; i++) {
      if (i > 0) this.fwd();
      this.plate(this.P(8.375, 0, 0), this.frame(0, phi), (16.75 / Math.cos(phi)) * S, BL * S, { body: 45 * S, center: true });
    }
    // coins along the high side
    if (this.rng() < 0.4) this.coins(8.375 + side * 6, 4, 4 * BL, 6 * 0.422, 6, base);
    this.fwd();
    this.scorePoint();
    this.tr(0, -2, -10);
  }
  p_tiltL() {
    this.p_tilt(1);
  }
  p_tiltR() {
    this.p_tilt(-1);
  }
  // "spawn 5 obsticles" (treblocks): a pair on the edges, a big block in the middle shortly after,
  // and a long way further on another pair
  p_treblocks() {
    this.tr(this.rf(-5, 5), -7, 20);
    this.slopeTile();
    this.deathTowers();
    for (let i = 2; i <= 14; i++) {
      this.fwd();
      this.slopeTile();
      if (i === 6 || i === 14) {
        this.block(this.C, 0, 1.67, 3.02, 2.93);
        this.block(this.C, 8.22, 10, 3.02, 2.93);
      }
      if (i === 8) this.block(this.C, 3.33, 6.67, 4.55, 4.26);
      if (i === 10 && this.rng() < 0.5) this.coins(5, 0, 2 * BL, 0, 4);
    }
    this.scorePoint();
  }
  // "spawn death tunnel": a red tunnel with paths over it, then kickers
  p_deathTunnel() {
    this.tr(this.rf(-5, 5), -7, 20);
    this.slopeTile();
    this.deathTowers();
    for (let i = 2; i <= 8; i++) {
      this.fwd();
      this.slopeTile();
      if (i === 6) this.redTunnel();
    }
    this.fwd();
    this.jumpGapMid();
    this.scorePoint();
  }
  redTunnel() {
    const L = 41.5;
    // stepped blocks either side: green tops you can ride, red walls that kill
    this.sboxTile(0, 1.67, 0, L, 0, 1.46, { secret: true });
    this.sboxTile(1.67, 3.33, 0, L, 0, 2.96, { secret: true });
    this.sboxTile(6.67, 8.33, 0, L, 0, 2.96, { secret: true });
    this.sboxTile(8.33, 10, 0, L, 0, 1.46, { secret: true });
    // the roof over the middle lane
    this.sboxTile(3.33, 6.67, 10.6, 38.5, 2.96, 4.45, { secret: true });
    const t = 0.12;
    for (const [x, h0, h1, s0, s1] of [
      [0, 0, 1.46, 0, L],
      [1.67, 1.46, 2.96, 0, L],
      [3.33, 0, 2.96, 0, L],
      [3.33, 2.96, 4.45, 10.6, 38.5],
      [6.67, 0, 2.96, 0, L],
      [6.67, 2.96, 4.45, 10.6, 38.5],
      [8.33, 1.46, 2.96, 0, L],
      [10, 0, 1.46, 0, L],
    ]) {
      this.sboxHaz(x - t / 2, x + t / 2, s0, s1, h0, h1);
    }
    // the fronts of the side blocks and of the roof
    this.sboxHaz(0, 3.33, -t, 0, 0, 2.96);
    this.sboxHaz(6.67, 10, -t, 0, 0, 2.96);
    this.sboxHaz(3.33, 6.67, 10.6 - t, 10.6, 2.96, 4.45);
    this.camZones.push({ z0: this.P(5, 0, 0).z, z1: this.P(5, L, 0).z, x: this.C.x + 5 * S });
    // the roof is the hidden route: coins all the way, sometimes a power-up
    this.coins(5, 13, 36, 4.45, 7);
    if (this.plus && this.rng() < 0.5) this.powerup(this.P(5, 26, 4.45 + 1.6));
  }
  // "spawn dogleg run" (snakes): a long thin S-bend with a lip at the end; a set starts with a big drop
  p_doglegFirst() {
    this.tr(0, -20, 20);
    this.p_dogleg();
  }
  p_dogleg() {
    this.tr(this.rf(-5, 5), -5, 9);
    const base = this.C.clone();
    const n = 20,
      sEnd = 151.2;
    const cx = (s) => -2.8 * Math.sin((2 * Math.PI * (s / Math.SQRT2)) / 109.6);
    for (let i = 0; i < n; i++) {
      const sa = (sEnd * i) / n,
        sb = (sEnd * (i + 1)) / n;
      const A = this.P(cx(sa), sa, 0, base),
        B = this.P(cx(sb), sb, 0, base);
      const yaw = -Math.atan2(cx(sb) - cx(sa), sb - sa);
      this.plate(A, this.frame(0, 0, yaw), 5 * S, A.distanceTo(B) + 0.05, { body: 364 * S, join: i > 0, center: true });
    }
    const xe = cx(sEnd);
    let prev = [sEnd, 0];
    for (const p of [
      [152.6, 0.45],
      [154.0, 1.05],
    ]) {
      const ds = p[0] - prev[0],
        dh = p[1] - prev[1];
      this.plate(this.P(xe, prev[0], prev[1], base), this.frame(Math.atan2(dh, ds)), 5 * S, Math.hypot(ds, dh) * S, { body: (prev[1] + 1.5) * S, join: true, thick: 4 });
      prev = p;
    }
    if (this.rng() < 0.5) this.coins(cx(75), 62, 88, 0, 4, base);
    this.tr(0, 0, 76.84);
    this.tr(-2.6, 0, 80);
    this.scorePoint();
  }
  // "spawn vertical obsticles" (verts): three blocks side by side rising and falling in turn
  p_verts() {
    this.tr(this.rf(-3, 3), -3, 22);
    this.slopeTile();
    this.deathTowers();
    for (let i = 2; i <= 6; i++) {
      this.fwd();
      this.slopeTile();
      if (i === 5) {
        const r = this.rf(0, 4);
        [0, 3.333, 6.667].forEach((x0, j) => this.block(this.C, x0, x0 + 3.35, 3.02, 5.87, { type: 'vert', rise: 20 * S, half: 2, phase: r - j * 3 }));
      }
    }
    this.scorePoint();
  }
  // "spawn horiz obsticles" (hors): a big block sweeping edge to edge, 3 s per crossing
  p_hors() {
    this.tr(this.rf(-3, 3), -3, 22);
    this.slopeTile();
    this.deathTowers();
    for (let i = 2; i <= 4; i++) {
      this.fwd();
      this.slopeTile();
      if (i === 3) this.block(this.C, 3.33 - 5, 6.67 - 5, 4.55, 4.26, { type: 'hor', dist: 10 * S, cross: 3, phase: this.rf(0, 6) });
    }
    this.scorePoint();
  }
  // "spawn tunnel run": three rooftops, then a speed tunnel with the speed-up pad, then a jump
  p_tunnelRun() {
    this.tr(0, -2, 20);
    this.slopeTile();
    this.fwd();
    this.slopeTile();
    this.fwd();
    this.slopeTile();
    this.fwd();
    this.arrowsTile();
    this.arch([2, 55], [11, 47], [0, 56.6]);
    if (this.plus && this.rng() < 0.6) this.powerup(this.P(5, 29, 4.92 + 1.6));
    this.speedUpPad();
    for (let i = 0; i < 3; i++) {
      this.fwd();
      this.slopeTile();
    }
    this.fwd();
    this.jumpTile();
    this.scorePoint();
  }

  // ------------------------------------------------------------------ generation
  nextPiece() {
    if (!this.queue.length) this.planSection();
    const name = this.queue.shift();
    this.pieces++;
    const z0 = this.C.z;
    this['p_' + name]();
    if (this.log) this.log.push({ name, z0, z1: this.C.z, d: this.distAt(z0) });
  }

  update(ballZ) {
    let guard = 0;
    while (this.C.z > ballZ - 520 && guard++ < 16) this.nextPiece();
    this.buildCity(this.C.z + 60);
    this.cull(ballZ + 50);
  }

  // Background city: dim wireframe towers well off to both sides with their roofs below the track,
  // so the road is always the tallest thing around and nothing in the skyline can stand between the
  // camera and the way ahead. Spacing is measured from the real track (death towers included).
  buildCity(zLimit) {
    while (this.cityZ > zLimit) {
      const z = this.cityZ;
      const ref = this.refAt(z);
      let lo = ref.x - 12,
        hi = ref.x + 12;
      for (const list of [this.tiles, this.hazards]) {
        for (const t of list) {
          const b = t.box;
          if (b.max.z < z - 30 || b.min.z > z + 30 || b.max.y < ref.y - 60) continue;
          if (b.min.x < lo) lo = b.min.x;
          if (b.max.x > hi) hi = b.max.x;
        }
      }
      for (const side of [-1, 1]) {
        const edge = side < 0 ? lo : hi;
        const w1 = this.rf(10, 18),
          d1 = this.rf(10, 16);
        this.tower(edge + side * (this.rf(26, 40) + w1 / 2), z, w1, d1, ref.y - this.rf(14, 44), ref.y - 420, CITY_NEAR);
        if (this.rng() < 0.8) {
          const w2 = this.rf(12, 22),
            d2 = this.rf(12, 18);
          this.tower(edge + side * (this.rf(64, 120) + w2 / 2), z + this.rf(-3, 3), w2, d2, ref.y - this.rf(6, 40), ref.y - 420, CITY_FAR);
        }
      }
      this.cityZ -= this.rf(13, 18);
    }
  }
  tower(cx, cz, w, d, top, bottom, tint = null) {
    const h = top - bottom;
    if (h <= 0.05) return;
    const pos = new THREE.Vector3(cx, bottom + h / 2, cz);
    const box = makeBox(pos, _q.identity(), new THREE.Vector3(w / 2, h / 2, d / 2), { bounce: 0.25 });
    const m = new THREE.Matrix4().compose(pos, _q, _s.set(w, h, d));
    this.towers.push({ box, m, slot: this.pools.towers.addMatrix(m, tint), pool: 'towers' });
  }

  cull(zLimit) {
    const keepT = [];
    for (const t of this.tiles) {
      if (t.box.min.z > zLimit) this.pools[t.pool].remove(t.slot);
      else keepT.push(t);
    }
    this.tiles = keepT;
    const keepW = [];
    for (const t of this.towers) {
      if (t.box.min.z > zLimit + 30) this.pools[t.pool].remove(t.slot);
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
    this.triggers = this.triggers.filter((t) => t.z < zLimit + 60 || !t.fired);
    this.scores = this.scores.filter((s) => s.z < zLimit + 60 || !s.done);
    this.camZones = this.camZones.filter((c) => c.z1 < zLimit + 60);
    this.pads = this.pads.filter((p) => {
      if (p.pos.z > zLimit) {
        this.pools.pads.remove(p.slot);
        return false;
      }
      return true;
    });
    while (this.center.length > 4 && this.center[2].z > zLimit + 20) this.center.shift();
  }

  // Reference track height / centre at a given z (the main line). Used for fall detection & camera.
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
  // tunnels: the camera tucks in close there, like the original
  camZoneAt(z) {
    for (const c of this.camZones) if (z <= c.z0 + 6 && z >= c.z1) return c;
    return null;
  }

  animate(time) {
    for (const h of this.hazards) {
      const m = h.motion;
      if (!m || !h.alive) continue;
      if (m.type === 'hor') {
        // linear ping-pong from one edge of the rooftop to the other, `cross` seconds each way
        const u = (time + m.phase) / m.cross;
        _v.set((1 - Math.abs((((u % 2) + 2) % 2) - 1)) * m.dist, 0, 0);
      } else if (m.type === 'vert') {
        // straight up 20 and back down, 2 s each way
        const u = (time + m.phase) / m.half;
        _v.set(0, (1 - Math.abs((((u % 2) + 2) % 2) - 1)) * m.rise, 0);
      } else continue;
      h.box.pos.copy(h.base).add(_v);
      setBoxTransform(h.box, h.box.pos);
      h.m.copy(h.mBase);
      h.m.elements[12] += _v.x;
      h.m.elements[13] += _v.y;
      h.m.elements[14] += _v.z;
      this.pools.hazards.setMatrix(h.slot, h.m);
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
    const mv = (t) => {
      t.box.pos.add(o);
      setBoxTransform(t.box, t.box.pos);
      if (t.start) t.start.add(o);
      if (t.end) t.end.add(o);
      t.m.elements[12] += o.x;
      t.m.elements[13] += o.y;
      t.m.elements[14] += o.z;
      this.pools[t.pool].setMatrix(t.slot, t.m);
    };
    for (const t of this.tiles) mv(t);
    for (const t of this.towers) mv(t);
    for (const h of this.hazards) {
      h.base.add(o);
      h.box.pos.add(o);
      setBoxTransform(h.box, h.box.pos);
      for (const mm of [h.m, h.mBase]) {
        mm.elements[12] += o.x;
        mm.elements[13] += o.y;
        mm.elements[14] += o.z;
      }
      this.pools.hazards.setMatrix(h.slot, h.m);
    }
    for (const p of this.pads) {
      p.pos.add(o);
      this.pools.pads.set(p.slot, p.pos, p.q, _s.set(14, 1, 22.6));
    }
    for (const g of this.gems) g.pos.add(o);
    for (const p of this.pickups) {
      p.pos.add(o);
      p.mesh.position.add(o);
    }
    for (const s of this.signs) s.sprite.position.add(o);
    for (const t of this.triggers) t.z += o.z;
    for (const s of this.scores) s.z += o.z;
    for (const c of this.camZones) {
      c.z0 += o.z;
      c.z1 += o.z;
      c.x += o.x;
    }
    for (const c of this.center) {
      c.x += o.x;
      c.y += o.y;
      c.z += o.z;
    }
    this.C.add(o);
    if (this.startPos) this.startPos.add(o);
    this.cityZ += o.z;
    this.distBase += o.z;
  }
}
