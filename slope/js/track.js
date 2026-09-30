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

// Target forward speed grows with distance travelled.
export function speedAt(dist) {
  return 26 + 30 * (1 - Math.exp(-Math.max(dist, 0) / 3200)) + Math.max(dist, 0) / 900;
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
const TINT_RAMP = new THREE.Color(1.35, 1.35, 1.35);
const TINT_WALL = new THREE.Color(0.65, 0.65, 0.75);
const TINT_PANEL = new THREE.Color(0.85, 0.95, 1.15);
const TINT_GATE = new THREE.Color(1.1, 0.35, 1.2);
const TINT_SPIN = new THREE.Color(1.2, 0.55, 0.2);
const _scale = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

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
  }

  reset(seed, mode, showHints) {
    for (const s of this.signs) this.scene.remove(s.sprite);
    for (const p of this.pickups) this.scene.remove(p.mesh);
    this.pools.tiles.clear();
    this.pools.hazards.clear();
    this.pools.gems.clear();
    this.tiles = [];
    this.hazards = [];
    this.gems = [];
    this.pickups = [];
    this.signs = [];
    this.center = [];
    this.rng = mulberry32(seed);
    this.mode = mode;
    this.plus = mode === 'plus';
    this.showHints = showHints;
    this.hintCount = {};
    this.distBase = 0;
    this.cur = new THREE.Vector3(0, 0, 14);
    this.pitch = 12;
    this.W = 11;
    this.lastEnds = [];
    this.pending = [];
    this.recent = [];
    this.lastShieldDist = 0;
    this.pieces = 0;
    this.safeZ = 1e9; // no pending landing zone

    // runway
    this.tile(34, { w: 14, pitch: 7 });
    this.tile(26, { w: 12, pitch: 10 });
    this.tile(20, { w: 11, pitch: 12 });
    this.gemLine(this.tiles[this.tiles.length - 1], 0, 0, 5, 18, 5);
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

  // ------------------------------------------------------------------ primitives
  tile(len, o = {}) {
    const w = o.w ?? this.W;
    const pitch = (o.pitch ?? this.pitch) * DEG;
    const roll = (o.roll ?? 0) * DEG;
    const thick = o.thick ?? 1.6;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, 0, roll, 'XYZ'));
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const start = this.cur.clone();
    if (o.xOff) start.x += o.xOff;
    const center = start.clone().addScaledVector(dir, len / 2).addScaledVector(up, -thick / 2);
    const box = makeBox(center, q, new THREE.Vector3(w / 2, thick / 2, len / 2), { surface: o.surface !== false, bounce: o.bounce });
    const end = start.clone().addScaledVector(dir, len);
    const t = { box, start, end, dir, up, right, q, len, w, thick, slot: -1 };
    t.slot = this.pools.tiles.add(box.pos, q, _scale.set(w, thick, len), o.tint || (pitch < -2 * DEG ? TINT_RAMP : TINT_FLOOR));
    this.tiles.push(t);

    if (o.connect !== false) {
      for (const prev of this.lastEnds) {
        if (Math.abs(prev.end.z - start.z) < 0.05 && Math.abs(prev.end.y - start.y) < 0.35) {
          prev.box.connectEnd = true;
          box.connectStart = true;
        }
      }
    }
    if (o.advance === false) {
      this.pending.push(t);
    } else {
      this.center.push({ z: start.z, y: start.y, x: this.cur.x });
      this.cur.y = end.y;
      this.cur.z = end.z;
      this.center.push({ z: end.z, y: end.y, x: this.cur.x });
      this.lastEnds = [...this.pending, t];
      this.pending = [];
    }
    return t;
  }

  // Raw box relative to a tile frame (walls, halfpipe panels).
  sideBox(t, lx, lz, sx, sy, sz, { roll = 0, tint = TINT_WALL, surface = false, bounce = 0.35, lift = 0 } = {}) {
    const q = t.q.clone();
    if (roll) q.multiply(_q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
    const pos = t.start.clone().addScaledVector(t.right, lx).addScaledVector(t.dir, lz).addScaledVector(t.up, lift);
    const box = makeBox(pos, q, new THREE.Vector3(sx / 2, sy / 2, sz / 2), { surface, bounce });
    const s = { box, start: pos, slot: this.pools.tiles.add(pos, q, _scale.set(sx, sy, sz), tint) };
    this.tiles.push(s);
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
    const key = text;
    this.hintCount[key] = (this.hintCount[key] || 0) + 1;
    if (this.hintCount[key] > 2) return;
    const s = this.makeSign(text, sub, color);
    s.position.copy(t.start).addScaledVector(t.dir, lz).addScaledVector(t.up, 5.2);
    this.scene.add(s);
    this.signs.push({ sprite: s, z: s.position.z });
  }

  shield(t, lz) {
    const m = this.makeShield();
    m.position.copy(t.start).addScaledVector(t.dir, lz).addScaledVector(t.up, 1.4);
    this.scene.add(m);
    this.pickups.push({ mesh: m, pos: m.position, type: 'shield', taken: false });
  }

  // ------------------------------------------------------------------ generation
  update(ballZ) {
    let guard = 0;
    while (this.cur.z > ballZ - 470 && guard++ < 20) this.nextPiece();
    this.cull(ballZ + 45);
  }

  cull(zLimit) {
    const keep = [];
    for (const t of this.tiles) {
      if (t.box.min.z > zLimit) this.pools.tiles.remove(t.slot);
      else keep.push(t);
    }
    this.tiles = keep;
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
    while (this.center.length > 4 && this.center[2].z > zLimit + 20) this.center.shift();
  }

  // Reference track height (centre line) at a given z. Used for fall detection & camera.
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
    const d = this.distAt(this.cur.z);
    const D = clamp(d / 7000, 0, 1);
    const v = speedAt(d);
    this.D = D;
    this.v = v;
    this.pitch = clamp(this.pitch + this.rf(-3, 3), lerp(11, 15, D), lerp(15, 21, D));
    this.W = clamp(lerp(10.5, 7.5, D) + this.rf(-1, 1.2), 6.5, 12);
    this.pieces++;

    const P = this.plus;
    const table = [
      ['straight', 1.6],
      ['blocks', 3 + D],
      ['slalom', 1.6],
      ['movers', d > 500 ? 1 + 2 * D : 0],
      ['narrow', 1 + D],
      ['split', 1.3],
      ['steps', 1.4],
      ['offsetDrop', 1.4],
      ['rampJump', 1.8],
      ['banked', 1.4],
      ['halfpipe', 1.0],
      ['waves', 1.3],
      ['tunnel', 1.0],
      ['pillars', 1.3],
      ['spinner', d > 900 ? 1 + D : 0],
      ['jumpGap', P ? 2.4 : 0],
      ['hurdles', P && d > 250 ? 1.8 : 0],
      ['dashGate', P && d > 700 ? 1.4 : 0],
    ];
    let name = 'straight';
    for (let tries = 0; tries < 8; tries++) {
      let total = 0;
      for (const [, w] of table) total += w;
      let r = this.rng() * total;
      for (const [n, w] of table) {
        r -= w;
        if (r <= 0) {
          name = n;
          break;
        }
      }
      if (!this.recent.includes(name)) break;
    }
    this.recent.push(name);
    if (this.recent.length > 2) this.recent.shift();

    // short lead-in so pieces never butt directly into each other; after anything that can launch
    // the ball, give a longer runway before the next gap so a big flight never skips the take-off
    const launchers = ['rampJump', 'jumpGap', 'waves', 'steps', 'offsetDrop', 'halfpipe'];
    const gappers = ['rampJump', 'jumpGap', 'offsetDrop', 'split', 'narrow', 'hurdles'];
    let leadLen = this.rf(8, 14);
    if (gappers.includes(name) && this.cur.z - leadLen > this.safeZ) leadLen = Math.min(this.cur.z - this.safeZ + 6, 90);
    const z0 = this.cur.z;
    const lead = this.tile(leadLen);
    if (name === 'straight' || this.rng() < 0.18) this.maybeGems(lead);
    this['p_' + name](D, v, d);
    // a ball launched by this piece may fly well past its end: keep the next gap out of that zone
    if (launchers.includes(name)) this.safeZ = this.cur.z - v * 0.85;
    if (this.log) this.log.push({ name, z0, z1: this.cur.z, d });
  }

  maybeGems(t) {
    if (t.len < 10) return;
    const hw = t.w / 2 - 1.2;
    const x0 = this.rf(-hw, hw),
      x1 = clamp(x0 + this.rf(-3, 3), -hw, hw);
    this.gemLine(t, x0, x1, 3, t.len - 3, Math.max(3, Math.floor(t.len / 4)));
  }

  // Reserve a free lane that drifts slowly so obstacle rows are always passable.
  laneRows(t, spacing, need, fn) {
    const hw = t.w / 2;
    let free = this.rf(-hw + need / 2, hw - need / 2);
    for (let z = 10; z < t.len - 6; z += spacing) {
      free = clamp(free + this.rf(-4.5, 4.5), -hw + need / 2, hw - need / 2);
      fn(z, free, hw);
    }
  }

  // ------------------------------------------------------------------ pieces
  p_straight(D) {
    const n = this.ri(1, 2);
    for (let i = 0; i < n; i++) {
      const t = this.tile(this.rf(18, 30));
      this.maybeGems(t);
      if (this.plus && D > 0.1 && this.distAt(t.end.z) - this.lastShieldDist > 1100 && this.rng() < 0.35) {
        this.lastShieldDist = this.distAt(t.end.z);
        this.shield(t, t.len * 0.6);
      }
    }
  }

  p_blocks(D, v) {
    const t = this.tile(this.rf(50, 76));
    const need = lerp(3.6, 3.0, D);
    const spacing = Math.max(10, v * 0.38);
    this.laneRows(t, spacing, need, (z, free, hw) => {
      const n = this.ri(1, D > 0.45 ? 3 : 2);
      for (let k = 0; k < n; k++) {
        const s = this.rf(1.6, 2.4);
        // choose the side of the free lane with room
        const leftRoom = free - need / 2 - -hw,
          rightRoom = hw - (free + need / 2);
        let x;
        if (leftRoom > s && (rightRoom <= s || this.rng() < 0.5)) x = this.rf(-hw + s / 2, free - need / 2 - s / 2);
        else if (rightRoom > s) x = this.rf(free + need / 2 + s / 2, hw - s / 2);
        else continue;
        this.hazard(t, x, z + this.rf(-1.5, 1.5), s, s, s);
      }
    });
  }

  p_slalom(D, v) {
    const spacing = Math.max(14, v * 0.5);
    const n = this.ri(3, 5);
    const t = this.tile(spacing * n + 16);
    const bw = t.w * lerp(0.5, 0.6, D);
    let side = this.rng() < 0.5 ? -1 : 1;
    for (let i = 0; i < n; i++) {
      this.hazard(t, side * (t.w / 2 - bw / 2), 12 + i * spacing, bw, 1.8, 1.2);
      side = -side;
    }
  }

  p_movers(D, v) {
    const spacing = Math.max(14, v * 0.45);
    const n = this.ri(2, 4);
    const t = this.tile(spacing * n + 14);
    const s = 2.2;
    for (let i = 0; i < n; i++) {
      this.hazard(t, 0, 12 + i * spacing, s, s, s, {
        type: 'slide',
        amp: t.w / 2 - s / 2 - 0.2,
        freq: this.rf(0.3, 0.55) * (1 + D * 0.5),
        phase: this.rf(0, Math.PI * 2),
      });
    }
  }

  p_narrow(D) {
    const w = Math.max(3.4, this.rf(4.2, 5.4) - D * 1.2);
    const shift = this.rf(-1, 1) * Math.min(this.W / 2 - w / 2, 2.5);
    this.cur.x += shift;
    const n = this.ri(1, 2);
    for (let i = 0; i < n; i++) {
      const t = this.tile(this.rf(18, 28), { w, pitch: this.pitch - 2 });
      if (this.rng() < 0.6) this.gemLine(t, 0, 0, 3, t.len - 3, Math.floor(t.len / 5));
    }
    this.tile(10, { w: this.W + 1 });
  }

  p_split(D) {
    const lane = lerp(4.2, 3.6, D),
      voidW = 2.6;
    const off = lane / 2 + voidW / 2;
    this.tile(12, { w: lane * 2 + voidW });
    const len = this.rf(38, 54);
    const a = this.tile(len, { w: lane, xOff: -off, advance: false });
    const b = this.tile(len, { w: lane, xOff: off });
    const blocked = this.rng() < 0.5 ? a : b;
    const other = blocked === a ? b : a;
    this.hazard(blocked, 0, len * this.rf(0.45, 0.7), lane * 0.8, 1.8, 1.6);
    if (this.plus && D > 0.4 && this.rng() < 0.5) this.hazard(other, 0, len * 0.2, lane * 0.8, 1.8, 1.6);
    else this.gemLine(other, 0, 0, 4, len - 4, 5);
    this.tile(14, { w: lane * 2 + voidW });
  }

  p_steps(D) {
    const n = this.ri(3, 5);
    for (let i = 0; i < n; i++) {
      this.cur.y -= this.rf(1.4, 2.8);
      if (this.rng() < 0.4) this.cur.x += this.rf(-1.5, 1.5);
      this.lastEnds = [];
      this.center.push({ z: this.cur.z, y: this.cur.y, x: this.cur.x });
      this.tile(this.rf(10, 15), { pitch: this.rf(3, 9), w: this.W + this.rf(-0.5, 1.5) });
    }
    this.tile(8, { pitch: this.pitch - 2 });
  }

  p_offsetDrop(D) {
    const G = this.rf(5, 9) + D * 2;
    const H = this.rf(4, 7);
    const wNew = this.W + 1.5;
    const S = (this.rng() < 0.5 ? -1 : 1) * this.rf(0.5, 1.05) * (wNew / 2);
    this.gap(G, H, S);
    const t = this.tile(26, { w: wNew });
    this.maybeGems(t);
  }

  p_rampJump(D, v) {
    const ang = this.rf(12, 18);
    const rw = Math.max(this.W, 8);
    // gradual transition into the ramp so the crease doesn't feel like a wall
    this.tile(3, { pitch: this.pitch * 0.5, w: rw });
    this.tile(3, { pitch: 0, w: rw });
    this.tile(3, { pitch: -ang * 0.5, w: rw });
    const ramp = this.tile(7, { pitch: -ang, w: rw });
    const a = ang * DEG;
    const H = this.rf(3, 7);
    const G = Math.min(0.8 * flightDist(v * 0.7, a, H).d, 0.62 * flightDist(v * 0.88, a, H).d);
    // gem arc along the expected flight
    const f = flightDist(v * 0.88, a, H);
    const vx = v * 0.88 * Math.cos(a),
      vy = v * 0.88 * Math.sin(a);
    for (let k = 1; k <= 5; k++) {
      const tt = (f.t * k) / 6;
      this.gem(new THREE.Vector3(this.cur.x, ramp.end.y + BALL_R + vy * tt - 0.5 * GRAVITY * tt * tt, ramp.end.z - vx * tt));
    }
    this.gap(G, H);
    const far = flightDist(v * 1.15, a, H).d;
    this.tile(Math.max(30, far * 1.5 - G + 12), { w: this.W + 2 });
  }

  p_banked(D) {
    const side = this.rng() < 0.5 ? -1 : 1;
    const maxRoll = this.rf(16, 22);
    const steps = [maxRoll / 3, (maxRoll * 2) / 3];
    for (const r of steps) this.tile(5, { roll: side * r });
    const hold = this.tile(this.rf(22, 34), { roll: side * maxRoll });
    if (D < 0.35) {
      // gentle guard wall on the low side early on
      const lowX = -side * (hold.w / 2 + 0.4);
      this.sideBox(hold, lowX, hold.len / 2, 0.8, 2.8, hold.len, { lift: 0.6 });
    } else if (this.rng() < 0.5) this.gemLine(hold, side * (hold.w / 2 - 1.3), side * (hold.w / 2 - 1.3), 4, hold.len - 4, 5);
    for (const r of steps.reverse()) this.tile(5, { roll: side * r });
    this.tile(8, { roll: 0 });
  }

  p_halfpipe(D) {
    const fw = 5.5,
      pw = 5.2,
      ang = 52 * DEG;
    const len = this.rf(50, 66);
    const t = this.tile(len, { w: fw });
    for (const s of [-1, 1]) {
      const lx = s * (fw / 2 + Math.cos(ang) * (pw / 2));
      const panel = this.sideBox(t, lx, len / 2, pw, 1.2, len, { roll: s * ang, tint: TINT_PANEL, surface: true, bounce: 0, lift: Math.sin(ang) * (pw / 2) });
      // sideBox positions the box centre at the top-face centre; drop it by half its thickness along its own up
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(panel.box.quat);
      panel.box.pos.addScaledVector(up, -0.6);
      setBoxTransform(panel.box, panel.box.pos);
      this.pools.tiles.set(panel.slot, panel.box.pos, panel.box.quat, _scale.set(pw, 1.2, len));
      // guard lip on the rim so hard steering at high speed can't launch the ball out of the pipe
      const rimX = s * (fw / 2 + Math.cos(ang) * pw);
      this.sideBox(t, rimX + s * 0.3, len / 2, 0.6, 2.4, len, { lift: Math.sin(ang) * pw + 0.5, bounce: 0.2 });
    }
    if (D > 0.25 || this.plus) {
      const n = this.ri(1, 2);
      for (let i = 0; i < n; i++) this.hazard(t, 0, len * (0.35 + i * 0.35), fw * 0.7, 1.6, 1.4);
    } else this.gemLine(t, 0, 0, 5, len - 5, 6);
    this.tile(20, { w: 12.5 });
  }

  p_waves(D) {
    const n = this.ri(4, 6);
    for (let i = 0; i < n; i++) this.tile(this.rf(7, 10), { pitch: i % 2 === 0 ? this.pitch + 9 : this.pitch - 13 });
    this.tile(10);
  }

  p_tunnel(D, v) {
    const len = this.rf(55, 75);
    const t = this.tile(len);
    for (const s of [-1, 1]) this.sideBox(t, s * (t.w / 2 + 0.4), len / 2, 0.8, 3, len, { lift: 0.7 });
    if (D > 0.2) {
      const spacing = Math.max(14, v * 0.45);
      for (let z = 14; z < len - 8; z += spacing) this.hazard(t, this.rf(-t.w / 2 + 1.5, t.w / 2 - 1.5), z, 2, 2, 2);
    } else this.gemLine(t, -t.w / 2 + 1.5, t.w / 2 - 1.5, 5, len - 5, 7);
  }

  p_pillars(D, v) {
    const t = this.tile(this.rf(60, 80), { w: this.W + 4 });
    const need = lerp(3.8, 3.1, D);
    this.laneRows(t, Math.max(9, v * 0.32), need, (z, free, hw) => {
      const n = this.ri(1, 2);
      for (let k = 0; k < n; k++) {
        const s = 1.5;
        const leftRoom = free - need / 2 + hw,
          rightRoom = hw - (free + need / 2);
        let x;
        if (leftRoom > s && (rightRoom <= s || this.rng() < 0.5)) x = this.rf(-hw + s / 2, free - need / 2 - s / 2);
        else if (rightRoom > s) x = this.rf(free + need / 2 + s / 2, hw - s / 2);
        else continue;
        this.hazard(t, x, z, s, 7, s);
      }
    });
  }

  p_spinner(D) {
    const t = this.tile(36);
    const dirn = this.rng() < 0.5 ? -1 : 1;
    this.hazard(t, 0, 18, t.w * 0.92, 0.9, 0.9, { type: 'spin', speed: dirn * this.rf(1.1, 1.9) * (1 + D * 0.4) * (this.plus ? 1 : 0.85), phase: this.rf(0, Math.PI) }, TINT_SPIN, 0.2);
    this.tile(8);
  }

  // ---- Plus-mode pieces (need jump / dash)
  p_jumpGap(D, v) {
    const run = this.tile(Math.max(22, v * 0.75));
    this.sign(run, 4, 'JUMP!', 'SPACE / W / ↑', '#39ff88');
    // Size the gap so that, anywhere in the plausible speed range, a jump clears it and rolling off doesn't.
    const th = this.pitch * DEG;
    const G = clamp(v * 0.38, 9, 21);
    let yNoMax = -Infinity,
      yJumpMin = Infinity;
    for (const k of [0.8, 0.9, 1, 1.1]) {
      const t = G / (v * k);
      yNoMax = Math.max(yNoMax, -G * Math.tan(th) - 0.5 * GRAVITY * t * t);
      yJumpMin = Math.min(yJumpMin, JUMP_V * t - 0.5 * GRAVITY * t * t);
    }
    const yLand = yNoMax + 0.4 * (yJumpMin - yNoMax);
    const shift = D > 0.4 && this.rng() < 0.4 ? this.rf(-2, 2) : 0;

    this.gap(G, -yLand, shift);
    const land = this.tile(Math.max(30, v * 0.6), { w: this.W + 1 });
    if (this.rng() < 0.5) this.gemLine(land, 0, 0, 6, 20, 4);
  }

  p_hurdles(D, v) {
    const spacing = Math.max(26, v * 0.95 + 6);
    const n = this.ri(2, 3 + Math.round(D));
    const t = this.tile(spacing * n + 14);
    this.sign(t, 0, 'HURDLES', 'JUMP OVER THEM', '#39ff88');
    for (let i = 0; i < n; i++) this.hazard(t, 0, 16 + i * spacing, t.w + 0.2, 1.1, 0.8);
  }

  p_dashGate(D, v) {
    const lead = 34;
    const n = D > 0.5 && this.rng() < 0.5 ? 2 : 1;
    const spacing = Math.max(v * 2.4, 60);
    const t = this.tile(lead + (n - 1) * spacing + 20);
    this.sign(t, 6, 'DASH!', 'SHIFT / S / ↓ to phase', '#ff4fd8');
    for (let i = 0; i < n; i++) this.hazard(t, 0, lead + i * spacing, t.w + 0.6, 6.5, 0.7, { gate: true }, TINT_GATE);
  }

  // ------------------------------------------------------------------ runtime
  animate(time) {
    for (const h of this.hazards) {
      const m = h.motion;
      if (!m || !h.alive || m.gate) continue;
      if (m.type === 'slide') {
        _v.copy(h.base).addScaledVector(h.right, Math.sin(time * m.freq * Math.PI * 2 + m.phase) * m.amp);
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
    for (const t of this.tiles) {
      t.box.pos.add(o);
      setBoxTransform(t.box, t.box.pos);
      t.start.add(o);
      if (t.end) t.end.add(o);
      this.pools.tiles.set(t.slot, t.box.pos, t.box.quat, _scale.set(t.box.half.x * 2, t.box.half.y * 2, t.box.half.z * 2));
    }
    for (const h of this.hazards) {
      h.base.add(o);
      h.box.pos.add(o);
      setBoxTransform(h.box, h.box.pos);
      this.pools.hazards.set(h.slot, h.box.pos, h.box.quat, h.scale);
    }
    for (const g of this.gems) g.pos.add(o);
    for (const p of this.pickups) p.pos.add(o);
    for (const s of this.signs) s.sprite.position.add(o);
    for (const c of this.center) {
      c.x += o.x;
      c.y += o.y;
      c.z += o.z;
    }
    // lastEnds entries are tiles already shifted above (end vectors shared)
    this.cur.add(o);
    this.safeZ += o.z;
    this.distBase += o.z;
  }
}
