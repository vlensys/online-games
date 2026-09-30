// Instanced scene views: build pieces, props, characters, items, chests, effects, storm.
import * as THREE from 'three';
import { GRID, LEVEL, RARITY, ITEM_TYPES, WEAPONS, isWeapon, isConsumable } from '../core/config.js';
import { K_WALL, K_FLOOR, K_RAMP, RAMP_T, CONE_H, computeBoxes } from '../core/pieces.js';
import { M_FALL, M_GLIDE, M_SWIM } from '../core/physics.js';
import { PROP_TYPES } from '../core/props.js';
import * as MD from './models.js';

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

// Growable InstancedMesh wrapper
class Pool {
  constructor(scene, geo, mat, cap = 16, opts = {}) {
    this.scene = scene;
    this.geo = geo;
    this.mat = mat;
    this.opts = opts;
    this.count = 0;
    this.mesh = null;
    this.alloc(cap);
  }
  alloc(cap) {
    const old = this.mesh;
    const m = new THREE.InstancedMesh(this.geo, this.mat, cap);
    m.frustumCulled = false;
    m.castShadow = !!this.opts.cast;
    m.receiveShadow = !!this.opts.receive;
    m.instanceMatrix.setUsage(this.opts.dynamic ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage);
    if (this.opts.color !== false) {
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      if (this.opts.dynamic) m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    if (old) {
      m.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, this.count * 16));
      if (old.instanceColor && m.instanceColor) m.instanceColor.array.set(old.instanceColor.array.subarray(0, this.count * 3));
      this.scene.remove(old);
      old.dispose();
    }
    m.count = this.count;
    m.visible = this.count > 0;
    if (this.opts.order !== undefined) m.renderOrder = this.opts.order;
    this.scene.add(m);
    this.mesh = m;
    this.cap = cap;
  }
  ensure(n) {
    if (n > this.cap) this.alloc(Math.max(n, this.cap * 2));
  }
  setShadows(cast, receive) {
    this.opts.cast = cast;
    this.opts.receive = receive;
    this.mesh.castShadow = cast;
    this.mesh.receiveShadow = receive;
  }
  set(i, mat, col) {
    this.mesh.setMatrixAt(i, mat);
    if (col && this.mesh.instanceColor) this.mesh.setColorAt(i, col);
  }
  commit(n = this.count) {
    this.count = n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
  }
}

// ------------------------------------------------------------------ piece geometry (planar UVs)
function boxUV(b) {
  const [x0, y0, z0, x1, y1, z1] = b;
  const pos = [];
  const nor = [];
  const uv = [];
  const quad = (a, bb, c, d, n, uvf) => {
    for (const p of [a, bb, c, a, c, d]) {
      pos.push(p[0], p[1], p[2]);
      nor.push(n[0], n[1], n[2]);
      const [u, v] = uvf(p);
      uv.push(u, v);
    }
  };
  const S = 1 / GRID;
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], (p) => [p[2] * S, p[1] * S]);
  quad([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0], (p) => [p[2] * S, p[1] * S]);
  quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0], (p) => [p[0] * S, p[2] * S]);
  quad([x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [0, -1, 0], (p) => [p[0] * S, p[2] * S]);
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], (p) => [p[0] * S, p[1] * S]);
  quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], (p) => [p[0] * S, p[1] * S]);
  return { pos, nor, uv };
}

function geoFrom(parts) {
  const pos = [];
  const nor = [];
  const uv = [];
  for (const p of parts) {
    pos.push(...p.pos);
    nor.push(...p.nor);
    uv.push(...p.uv);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

function wallGeo(v) {
  const boxes = computeBoxes({ k: K_WALL, x: 0, y: 0, z: 0, o: 0, v });
  return geoFrom(boxes.map(boxUV));
}

function rampGeo() {
  const T = RAMP_T;
  const L = GRID;
  const H = LEVEL;
  const A = [0, 0, 0];
  const B = [0, 0, L];
  const Cc = [L, H, L];
  const D = [L, H, 0];
  const A2 = [0, -T, 0];
  const B2 = [0, -T, L];
  const C2 = [L, H - T, L];
  const D2 = [L, H - T, 0];
  const pos = [];
  const nor = [];
  const uv = [];
  const s2 = Math.SQRT1_2;
  const quad = (a, b, c, d, n, uvs) => {
    const vs = [a, b, c, a, c, d];
    const us = [uvs[0], uvs[1], uvs[2], uvs[0], uvs[2], uvs[3]];
    vs.forEach((p, i) => {
      pos.push(...p);
      nor.push(...n);
      uv.push(...us[i]);
    });
  };
  const sl = Math.SQRT2;
  quad(A, B, Cc, D, [-s2, s2, 0], [[0, 0], [1, 0], [1, sl], [0, sl]]);
  quad(A2, D2, C2, B2, [s2, -s2, 0], [[0, 0], [0, sl], [1, sl], [1, 0]]);
  quad(A, D, D2, A2, [0, 0, -1], [[0, 0], [1, 1], [1, 0.9], [0, -0.1]]);
  quad(B, B2, C2, Cc, [0, 0, 1], [[0, 0], [0, -0.1], [1, 0.9], [1, 1]]);
  quad(A, A2, B2, B, [-1, 0, 0], [[0, 0], [0, 0.1], [1, 0.1], [1, 0]]);
  quad(D, Cc, C2, D2, [1, 0, 0], [[0, 0], [1, 0], [1, 0.1], [0, 0.1]]);
  return geoFrom([{ pos, nor, uv }]);
}

function coneGeo() {
  const H = CONE_H;
  const L = GRID;
  const apex = [2, H, 2];
  const c = [[0, 0, 0], [L, 0, 0], [L, 0, L], [0, 0, L]];
  const pos = [];
  const nor = [];
  const uv = [];
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) & 3];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [apex[0] - a[0], apex[1] - a[1], apex[2] - a[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...n);
    n = n.map((x) => x / l);
    if (n[1] < 0) n = n.map((x) => -x);
    // order so the face points outward (CCW seen from outside)
    const tri = n[1] > 0 ? [a, apex, b] : [a, b, apex];
    for (const p of tri) {
      pos.push(...p);
      nor.push(...n);
      uv.push(p[0] / L + p[2] / L * 0.0, p[1] / 2 + (i % 2 ? p[2] : p[0]) / L * 0.0 + (i % 2 ? p[2] : p[0]) / L);
    }
  }
  // underside
  for (const p of [c[0], c[1], c[2], c[0], c[2], c[3]]) {
    pos.push(p[0], p[1] - 0.05, p[2]);
    nor.push(0, -1, 0);
    uv.push(p[0] / L, p[2] / L);
  }
  const g = geoFrom([{ pos, nor, uv }]);
  return g;
}

export function pieceGeometries() {
  return [wallGeo(0), wallGeo(1), wallGeo(2), geoFrom([boxUV([0, -0.3, 0, GRID, 0, GRID])]), rampGeo(), coneGeo()];
}

export function pieceMatrix(p, out) {
  const X = p.x * GRID;
  const Y = p.y * LEVEL;
  const Z = p.z * GRID;
  if (p.k === K_WALL) {
    if ((p.o & 1) === 0) out.makeTranslation(X, Y, Z);
    else {
      out.makeRotationY(Math.PI / 2);
      out.setPosition(X, Y, Z);
    }
  } else if (p.k === K_RAMP) {
    const a = -(p.o & 3) * (Math.PI / 2);
    _m3.makeTranslation(-2, 0, -2);
    out.makeRotationY(a);
    out.multiply(_m3);
    _m2.makeTranslation(X + 2, Y, Z + 2);
    out.premultiply(_m2);
  } else out.makeTranslation(X, Y, Z);
  return out;
}

function geoIndex(p) {
  if (p.k === K_WALL) return p.v | 0;
  if (p.k === K_FLOOR) return 3;
  if (p.k === K_RAMP) return 4;
  return 5;
}

export class PiecesView {
  constructor(scene, textures) {
    this.scene = scene;
    this.geos = pieceGeometries();
    this.mats = textures.map((t) => new THREE.MeshLambertMaterial({ map: t }));
    this.pools = [];
    this.where = new Map();
    this.dirty = new Set();
    for (let g = 0; g < 6; g++) for (let m = 0; m < 3; m++) this.pools.push(null);
  }
  pool(i) {
    let p = this.pools[i];
    if (!p) {
      p = new Pool(this.scene, this.geos[Math.floor(i / 3)], this.mats[i % 3], 64, { receive: this.shadows, cast: this.shadows });
      p.ids = [];
      this.pools[i] = p;
    }
    return p;
  }
  setShadows(on) {
    this.shadows = on;
    for (const p of this.pools) if (p) p.setShadows(on, on);
  }
  color(p) {
    _c.setHex(p.c);
    const f = p.max ? 0.62 + 0.38 * Math.max(0, Math.min(1, p.hp / p.max)) : 1;
    _c.r *= f;
    _c.g *= f;
    _c.b *= f;
    if (p.temp) {
      _c.r = _c.r * 0.7 + 0.12;
      _c.g = _c.g * 0.7 + 0.22;
      _c.b = _c.b * 0.7 + 0.35;
    }
    return _c;
  }
  add(p) {
    if (this.where.has(p.id)) return;
    const bi = geoIndex(p) * 3 + (p.m | 0);
    const pool = this.pool(bi);
    pool.ensure(pool.count + 1);
    const i = pool.count++;
    pool.ids[i] = p.id;
    pool.set(i, pieceMatrix(p, _m), this.color(p));
    this.where.set(p.id, { b: bi, i });
    this.dirty.add(pool);
  }
  remove(id) {
    const w = this.where.get(id);
    if (!w) return;
    const pool = this.pools[w.b];
    const last = pool.count - 1;
    if (w.i !== last) {
      const lid = pool.ids[last];
      pool.mesh.getMatrixAt(last, _m);
      pool.mesh.setMatrixAt(w.i, _m);
      if (pool.mesh.instanceColor) {
        pool.mesh.getColorAt(last, _c);
        pool.mesh.setColorAt(w.i, _c);
      }
      pool.ids[w.i] = lid;
      this.where.get(lid).i = w.i;
    }
    pool.count = last;
    pool.ids.length = last;
    this.where.delete(id);
    this.dirty.add(pool);
  }
  update(p) {
    const w = this.where.get(p.id);
    if (!w) return;
    const pool = this.pools[w.b];
    if (pool.mesh.instanceColor) pool.mesh.setColorAt(w.i, this.color(p));
    this.dirty.add(pool);
  }
  flush() {
    for (const p of this.dirty) p.commit(p.count);
    this.dirty.clear();
  }
}

// ------------------------------------------------------------------ props
export class PropsView {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    const models = MD.propModels();
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.pools = {};
    this.where = new Map();
    const byType = {};
    for (const p of world.props) {
      if (PROP_TYPES[p.type].landmark) continue;
      (byType[p.type] = byType[p.type] || []).push(p);
    }
    const rnd = (id) => ((id * 2654435761) >>> 0) / 4294967296;
    const carColors = ['#e8483c', '#3b82d6', '#f2b233', '#f4f4f4', '#4fae57', '#2d2d38', '#8a5ad8', '#2fb3b3'];
    const contColors = ['#c9573e', '#3f7fbf', '#4f9a55', '#d9a33c', '#8a8f96', '#b2463f'];
    for (const type of Object.keys(byType)) {
      const list = byType[type];
      const geos = models[type];
      if (!geos) continue;
      this.pools[type] = geos.map((g) => {
        const pool = new Pool(scene, g, this.mat, list.length, { cast: false, receive: false });
        return pool;
      });
      list.forEach((p, i) => {
        const s = p.s || 1;
        _q.setFromAxisAngle(_v.set(0, 1, 0), p.rot || 0);
        _m.compose(_v.set(p.x, p.y, p.z), _q, _s.set(s, s, s));
        const r = rnd(p.id);
        if (type === 'car') _c.set(carColors[Math.floor(r * carColors.length)]);
        else if (type === 'container') _c.set(contColors[Math.floor(r * contColors.length)]);
        else {
          const f = 0.86 + r * 0.24;
          _c.setRGB(f, f, f);
        }
        this.pools[type].forEach((pool, k) => {
          pool.set(i, _m, k === 0 ? _c : _c.setRGB(1, 1, 1));
        });
        this.where.set(p.id, { type, i });
      });
      for (const pool of this.pools[type]) pool.commit(list.length);
    }
    // landmarks
    this.landmarks = [];
    this.blades = null;
    for (const p of world.props) {
      if (!PROP_TYPES[p.type].landmark) continue;
      const mesh = new THREE.Mesh(MD.landmarkModel(p.type), this.mat);
      mesh.position.set(p.x, p.y, p.z);
      mesh.rotation.y = p.rot || 0;
      scene.add(mesh);
      this.landmarks.push(mesh);
      if (p.type === 'windmill') {
        const b = new THREE.Mesh(MD.landmarkModel('windmillBlades'), this.mat);
        b.position.set(p.x, p.y + 15.5, p.z - 3.4);
        scene.add(b);
        this.blades = b;
      }
    }
    this.shake = new Map();
  }
  setShadows(on) {
    for (const t of Object.keys(this.pools)) for (const p of this.pools[t]) p.setShadows(on && t !== 'bush', false);
    for (const m of this.landmarks) m.castShadow = on;
  }
  kill(id) {
    const w = this.where.get(id);
    if (!w) return;
    for (const pool of this.pools[w.type]) {
      pool.mesh.setMatrixAt(w.i, ZERO);
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
    this.shake.delete(id);
  }
  hit(id) {
    if (this.where.has(id)) this.shake.set(id, 0.3);
  }
  update(dt) {
    if (this.blades) this.blades.rotation.z += dt * 0.6;
    if (!this.shake.size) return;
    for (const [id, t] of this.shake) {
      const p = this.world.propById.get(id);
      const w = this.where.get(id);
      const nt = t - dt;
      if (!p || !p.alive) {
        this.shake.delete(id);
        continue;
      }
      const s = p.s || 1;
      const a = nt > 0 ? Math.sin(nt * 60) * 0.04 * (nt / 0.3) : 0;
      _e.set(a, p.rot || 0, a * 0.6);
      _q.setFromEuler(_e);
      _m.compose(_v.set(p.x, p.y, p.z), _q, _s.set(s, s, s));
      for (const pool of this.pools[w.type]) {
        pool.mesh.setMatrixAt(w.i, _m);
        pool.mesh.instanceMatrix.needsUpdate = true;
      }
      if (nt <= 0) this.shake.delete(id);
      else this.shake.set(id, nt);
    }
  }
}

// ------------------------------------------------------------------ characters
const PARTS = ['torso', 'pelvis', 'leg', 'arm', 'hand', 'head', 'hair', 'face', 'pack', 'glider'];
const MULT = { leg: 2, arm: 2, hand: 2 };

export class CharsView {
  constructor(scene, maxN = 72) {
    this.scene = scene;
    const geos = MD.charParts();
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.pools = {};
    for (const k of PARTS) this.pools[k] = new Pool(scene, geos[k], this.mat, maxN * (MULT[k] || 1), { dynamic: true });
    const wm = MD.weaponModels();
    this.wmat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.wpools = {};
    for (const t of Object.keys(wm)) {
      this.wpools[t] = {
        body: new Pool(scene, wm[t].body, this.wmat, 16, { dynamic: true, color: false }),
        acc: new Pool(scene, wm[t].acc, this.wmat, 16, { dynamic: true }),
      };
    }
    this.cons = {};
    for (const t of ['bandage', 'medkit', 'shieldS', 'shieldL']) this.cons[t] = new Pool(scene, MD.consumableModel(t), this.wmat, 8, { dynamic: true, color: false });
    this.n = {};
    this.root = new THREE.Matrix4();
    this.tilt = new THREE.Matrix4();
    this.colorCache = new Map();
    this.rarityColors = RARITY.map((r) => new THREE.Color(r.color));
    this.pickColor = new THREE.Color('#7fd0ff');
    this.white = new THREE.Color(1, 1, 1);
    this._B = new THREE.Matrix4();
    this._up = new THREE.Matrix4();
    this._body = new THREE.Matrix4();
    this._head = new THREE.Matrix4();
    this._arms = [new THREE.Matrix4(), new THREE.Matrix4()];
    this._tmp = new THREE.Matrix4();
  }
  setShadows(on) {
    for (const k of PARTS) this.pools[k].setShadows(on, false);
  }
  colors(outfit) {
    const key = outfit.join(',');
    let c = this.colorCache.get(key);
    if (!c) {
      c = outfit.map((h) => new THREE.Color(h));
      this.colorCache.set(key, c);
    }
    return c;
  }
  begin() {
    for (const k of PARTS) this.n[k] = 0;
    for (const t of Object.keys(this.wpools)) {
      this.n['w_' + t] = 0;
    }
    for (const t of Object.keys(this.cons)) this.n['c_' + t] = 0;
  }
  put(key, pool, mat, col) {
    const i = this.n[key]++;
    pool.ensure(i + 1);
    pool.set(i, mat, col);
  }
  // s: {x,y,z,yaw,pitch,mode,crouch,walk,speed,item,swing,building,outfit}
  draw(s) {
    const col = this.colors(s.outfit); // [shirt, pants, skin, hair, pack]
    const R = this.root;
    R.makeRotationY(s.yaw);
    R.setPosition(s.x, s.y, s.z);
    const T = this.tilt;
    const fall = s.mode === M_FALL;
    const glide = s.mode === M_GLIDE;
    const swim = s.mode === M_SWIM;
    const crouch = s.crouch && !fall && !glide;
    const low = crouch ? 0.42 : 0;
    // body tilt around the pelvis
    if (fall) {
      _m.makeTranslation(0, 1.0, 0);
      _m2.makeRotationX(-1.25 - Math.max(-0.4, Math.min(0.3, s.pitch * 0.3)));
      T.multiplyMatrices(_m, _m2);
      _m.makeTranslation(0, -1.0, 0);
      T.multiply(_m);
    } else if (swim) {
      _m.makeTranslation(0, 1.2, 0);
      _m2.makeRotationX(-0.9);
      T.multiplyMatrices(_m, _m2);
      _m.makeTranslation(0, -1.2, 0);
      T.multiply(_m);
    } else T.identity();
    const B = this._B.multiplyMatrices(R, T); // body frame
    const amp = Math.min(1, s.speed / 6) * (s.sprint ? 0.95 : 0.7);
    const sw = Math.sin(s.walk) * amp;
    const item = s.item;
    const gun = item && isWeapon(item.t);
    const cons = item && isConsumable(item.t);
    // torso, pelvis, head, hair, face, pack
    const up = this._up.makeTranslation(0, -low, 0);
    const body = this._body.multiplyMatrices(B, up);
    if (crouch) {
      _m.makeTranslation(0, 0.9, 0);
      _m2.makeRotationX(-0.25);
      _m.multiply(_m2);
      _m2.makeTranslation(0, -0.9, 0);
      _m.multiply(_m2);
      body.multiply(_m);
    }
    this.put('torso', this.pools.torso, body, col[0]);
    this.put('pelvis', this.pools.pelvis, this._tmp.multiplyMatrices(B, up), col[1]);
    this.put('pack', this.pools.pack, body, col[4]);
    // head follows pitch a bit
    const hp = fall ? 0.9 : Math.max(-0.5, Math.min(0.5, s.pitch * 0.5));
    _m.makeTranslation(0, 1.52, 0);
    _m2.makeRotationX(hp);
    _m.multiply(_m2);
    _m2.makeTranslation(0, -1.52, 0);
    _m.multiply(_m2);
    const head = this._head.multiplyMatrices(body, _m);
    this.put('head', this.pools.head, head, col[2]);
    this.put('hair', this.pools.hair, head, col[3]);
    this.put('face', this.pools.face, head, this.white);
    // legs
    for (let side = -1; side <= 1; side += 2) {
      let rx = 0;
      let rz = 0;
      if (fall) {
        rx = 0.35;
        rz = side * 0.28;
      } else if (glide) {
        rx = Math.sin(s.walk * 0.5 + side) * 0.15;
      } else if (crouch) {
        rx = 0.9 + sw * side * 0.4;
      } else if (!s.grounded && !swim) {
        rx = side > 0 ? -0.5 : 0.25;
      } else rx = sw * side;
      if (swim) rx = Math.sin(s.walk * 1.4) * 0.4 * side;
      _m.makeTranslation(side * 0.13, 0.86 - low * 0.5, 0);
      _e.set(rx, 0, rz, 'XYZ');
      _m2.makeRotationFromEuler(_e);
      _m.multiply(_m2);
      if (crouch) {
        _m2.makeScale(1, 0.72, 1);
        _m.multiply(_m2);
      }
      this.put('leg', this.pools.leg, _m.premultiply(B), col[1]);
    }
    // arms
    const swingP = s.swing > 0 ? Math.sin(Math.min(1, s.swing) * Math.PI) : 0;
    for (let side = -1; side <= 1; side += 2) {
      let rx = 0;
      let rz = side * 0.08;
      let ry = 0;
      // arms hang along -y; positive rx swings them forward (the body faces -z)
      if (fall) {
        rx = 0.3;
        rz = side * 1.15;
      } else if (glide) {
        rx = 2.75;
        rz = side * 0.35;
      } else if (swim) {
        rx = 1.6 + Math.sin(s.walk * 1.4 + (side > 0 ? 0 : Math.PI)) * 0.9;
      } else if (gun) {
        const p = Math.max(-1.1, Math.min(1.1, s.pitch));
        rx = Math.PI / 2 + p;
        if (side < 0) {
          rz = 0.55;
          ry = 0;
          rx = Math.PI / 2 + p - 0.05;
        } else rz = -0.05;
      } else if (cons) {
        rx = side > 0 ? 0.9 : sw * 0.6;
      } else if (s.building) {
        rx = 1.1 + s.pitch * 0.5;
        rz = side * -0.25;
      } else if (item === null || (item && item.t === 'pickaxe') || !item) {
        // pickaxe: raise overhead then chop down
        const chop = s.swing > 0 ? (s.swing < 0.45 ? (s.swing / 0.45) * 2.6 : 2.6 - ((s.swing - 0.45) / 0.55) * 2.2) : 0;
        if (side > 0) rx = s.swing > 0 ? 0.4 + chop : 0.35 + sw * 0.8;
        else rx = sw * 0.8;
      }
      void swingP;
      _m.makeTranslation(side * 0.37, 1.47, 0);
      _e.set(rx, ry, rz, 'XYZ');
      _m2.makeRotationFromEuler(_e);
      _m.multiply(_m2);
      const arm = this._arms[side > 0 ? 1 : 0].multiplyMatrices(body, _m);
      this.put('arm', this.pools.arm, arm, col[0]);
      this.put('hand', this.pools.hand, arm, col[2]);
      if (side > 0) this._rightArm = arm;
    }
    // glider
    if (glide) this.put('glider', this.pools.glider, R, col[4]);
    // held item
    if (fall || glide || swim) return;
    if (gun) {
      const pool = this.wpools[item.t];
      if (!pool) return;
      const p = Math.max(-1.1, Math.min(1.1, s.pitch));
      _m.makeTranslation(0.16, 1.4, -0.12);
      _m2.makeRotationX(p);
      _m.multiply(_m2);
      _m2.makeTranslation(0, 0, -0.5);
      _m.multiply(_m2);
      _m.premultiply(body);
      this.put('w_' + item.t, pool.body, _m, null);
      this.nAcc(item.t, _m, this.rarityColors[item.r] || this.white);
    } else if (cons) {
      const pool = this.cons[item.t];
      _m2.makeTranslation(0, -0.72, -0.05);
      _m.multiplyMatrices(this._rightArm, _m2);
      this.put('c_' + item.t, pool, _m, null);
    } else if (!s.building) {
      // pickaxe in the right hand
      _m2.makeTranslation(0, -0.66, 0);
      _m.multiplyMatrices(this._rightArm, _m2);
      _m2.makeRotationX(0.5);
      _m.multiply(_m2);
      this.put('w_pickaxe', this.wpools.pickaxe.body, _m, null);
      this.nAcc('pickaxe', _m, this.pickColor);
    }
  }
  nAcc(t, mat, col) {
    const key = 'a_' + t;
    if (this.n[key] === undefined) this.n[key] = 0;
    const pool = this.wpools[t].acc;
    const i = this.n[key]++;
    pool.ensure(i + 1);
    pool.set(i, mat, col);
  }
  end() {
    for (const k of PARTS) this.pools[k].commit(this.n[k]);
    for (const t of Object.keys(this.wpools)) {
      this.wpools[t].body.commit(this.n['w_' + t] || 0);
      this.wpools[t].acc.commit(this.n['a_' + t] || 0);
      this.n['a_' + t] = 0;
    }
    for (const t of Object.keys(this.cons)) this.cons[t].commit(this.n['c_' + t] || 0);
  }
}

// ------------------------------------------------------------------ floor items
export class ItemsView {
  constructor(scene) {
    this.scene = scene;
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const wm = MD.weaponModels();
    this.pools = {};
    this.accPools = {};
    for (const t of ITEM_TYPES) {
      let g;
      if (isWeapon(t)) {
        g = wm[t].body;
        this.accPools[t] = new Pool(scene, wm[t].acc, this.mat, 16, { dynamic: true });
      } else if (isConsumable(t)) g = MD.consumableModel(t);
      else if (t.startsWith('a_')) g = MD.ammoModel();
      else g = MD.matModel(['m_wood', 'm_brick', 'm_metal'].indexOf(t));
      this.pools[t] = new Pool(scene, g, this.mat, 16, { dynamic: true });
    }
    const ring = new THREE.RingGeometry(0.5, 0.72, 24);
    ring.rotateX(-Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, depthWrite: false, fog: true });
    this.ring = new Pool(scene, ring, this.ringMat, 64, { dynamic: true, order: 2 });
    const beam = new THREE.CylinderGeometry(0.05, 0.05, 1, 5, 1, true);
    beam.translate(0, 0.5, 0);
    this.beamMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false });
    this.beam = new Pool(scene, beam, this.beamMat, 32, { dynamic: true, order: 3 });
    this.items = new Map();
    this.dirty = true;
    this.rarity = RARITY.map((r) => new THREE.Color(r.color));
    this.ammoCol = {
      a_light: new THREE.Color('#a8c8e8'),
      a_medium: new THREE.Color('#7fb86a'),
      a_heavy: new THREE.Color('#c06a4a'),
      a_shells: new THREE.Color('#d8b04a'),
      a_rockets: new THREE.Color('#7a7f86'),
    };
    this.white = new THREE.Color(1, 1, 1);
  }
  set(map) {
    this.items = map;
    this.dirty = true;
  }
  markDirty() {
    this.dirty = true;
  }
  update(t, cx, cz) {
    // rebuild all instances (a few hundred items) every frame near the camera for spin
    const counts = {};
    let rc = 0;
    let bc = 0;
    for (const k of ITEM_TYPES) counts[k] = 0;
    const accCounts = {};
    for (const it of this.items.values()) {
      const dx = it.x - cx;
      const dz = it.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > 260 * 260) continue;
      const pool = this.pools[it.t];
      if (!pool) continue;
      const wpn = isWeapon(it.t);
      const cons = isConsumable(it.t);
      const near = d2 < 45 * 45;
      const ang = near ? t * 1.2 + it.id : it.id * 1.7;
      const bob = near ? Math.sin(t * 2 + it.id) * 0.06 : 0;
      const sc = wpn ? 1.35 : cons ? 1.25 : 0.95;
      _q.setFromAxisAngle(_v.set(0, 1, 0), ang);
      if (wpn) {
        _e.set(0, ang, 0.35);
        _q.setFromEuler(_e);
      }
      _m.compose(_v.set(it.x, it.y + (wpn ? 0.55 : 0.3) + bob, it.z), _q, _s.set(sc, sc, sc));
      const i = counts[it.t]++;
      pool.ensure(i + 1);
      const col = it.t.startsWith('a_') ? this.ammoCol[it.t] : this.white;
      pool.set(i, _m, col);
      if (wpn) {
        const ap = this.accPools[it.t];
        const j = (accCounts[it.t] = (accCounts[it.t] || 0) + 1) - 1;
        ap.ensure(j + 1);
        ap.set(j, _m, this.rarity[it.r] || this.white);
      }
      if (wpn || cons) {
        _m.makeTranslation(it.x, it.y + 0.05, it.z);
        this.ring.ensure(rc + 1);
        this.ring.set(rc++, _m, this.rarity[it.r] || this.white);
        if (it.r >= 2 && d2 < 160 * 160) {
          _m.compose(_v.set(it.x, it.y, it.z), _q.identity(), _s.set(1, 2.2 + it.r * 0.6, 1));
          this.beam.ensure(bc + 1);
          this.beam.set(bc++, _m, this.rarity[it.r]);
        }
      }
    }
    for (const k of ITEM_TYPES) {
      this.pools[k].commit(counts[k]);
      if (this.accPools[k]) this.accPools[k].commit(accCounts[k] || 0);
    }
    this.ring.commit(rc);
    this.beam.commit(bc);
  }
}

// ------------------------------------------------------------------ chests & ammo boxes
export class ChestsView {
  constructor(scene, map, availC, availB) {
    this.map = map;
    const md = MD.chestModels();
    this.matClosed = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color('#3a2a00') });
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.cBody = new Pool(scene, md.body, this.matClosed, map.chests.length || 1, { color: true });
    this.cLid = new Pool(scene, md.lid, this.matClosed, map.chests.length || 1, { color: true });
    this.oBody = new Pool(scene, md.body, this.mat, 16, { color: true });
    this.oLid = new Pool(scene, md.lid, this.mat, 16, { color: true });
    this.bBody = new Pool(scene, md.boxBody, this.mat, map.boxes.length || 1, { color: true });
    this.bLid = new Pool(scene, md.boxLid, this.mat, map.boxes.length || 1, { color: true });
    this.availC = availC;
    this.availB = availB;
    this.openC = new Set();
    this.openB = new Set();
    this.rebuild();
  }
  open(kind, id) {
    if (kind === 'b') this.openB.add(id);
    else this.openC.add(id);
    this.rebuild();
  }
  rebuild() {
    const dim = new THREE.Color(0.62, 0.62, 0.62);
    const full = new THREE.Color(1, 1, 1);
    let nc = 0;
    let no = 0;
    this.map.chests.forEach((c, i) => {
      if (!this.availC[i] && !this.openC.has(i)) return;
      const opened = this.openC.has(i);
      _q.setFromAxisAngle(_v.set(0, 1, 0), (c.yaw || 0) + Math.PI);
      _m.compose(_v.set(c.x, c.y, c.z), _q, _s.set(1, 1, 1));
      _m2.makeTranslation(0, 0.56, 0.31);
      _m3.makeRotationX(opened ? -1.9 : 0);
      _m2.multiply(_m3);
      _m2.premultiply(_m);
      if (opened) {
        this.oBody.ensure(no + 1);
        this.oLid.ensure(no + 1);
        this.oBody.set(no, _m, dim);
        this.oLid.set(no++, _m2, dim);
      } else {
        this.cBody.set(nc, _m, full);
        this.cLid.set(nc++, _m2, full);
      }
    });
    this.cBody.commit(nc);
    this.cLid.commit(nc);
    this.oBody.commit(no);
    this.oLid.commit(no);
    let nb = 0;
    this.map.boxes.forEach((b, i) => {
      if (!this.availB[i] && !this.openB.has(i)) return;
      const opened = this.openB.has(i);
      _q.setFromAxisAngle(_v.set(0, 1, 0), (b.yaw || 0) + Math.PI);
      _m.compose(_v.set(b.x, b.y, b.z), _q, _s.set(1, 1, 1));
      _m2.makeTranslation(0, 0.38, 0.26);
      _m3.makeRotationX(opened ? -1.7 : 0);
      _m2.multiply(_m3);
      _m2.premultiply(_m);
      this.bBody.set(nb, _m, opened ? dim : full);
      this.bLid.set(nb++, _m2, opened ? dim : full);
    });
    this.bBody.commit(nb);
    this.bLid.commit(nb);
  }
  update(t) {
    const k = 0.5 + 0.5 * Math.sin(t * 3);
    this.matClosed.emissive.setRGB(0.12 + 0.14 * k, 0.08 + 0.1 * k, 0);
  }
}

// ------------------------------------------------------------------ effects
export class FxView {
  constructor(scene) {
    this.scene = scene;
    const tg = new THREE.BoxGeometry(1, 1, 1);
    tg.translate(0, 0, -0.5);
    this.tracerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
    this.tracers = new Pool(scene, tg, this.tracerMat, 64, { dynamic: true, order: 4 });
    this.tlist = [];
    const pg = new THREE.TetrahedronGeometry(0.12, 0);
    this.partMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.parts = new Pool(scene, pg, this.partMat, 256, { dynamic: true });
    this.plist = [];
    const fg = new THREE.OctahedronGeometry(0.22, 0);
    this.flashMat = new THREE.MeshBasicMaterial({ color: 0xffe28a, transparent: true, opacity: 0.9, depthWrite: false });
    this.flashes = new Pool(scene, fg, this.flashMat, 32, { dynamic: true, color: false, order: 4 });
    this.flist = [];
    const eg = new THREE.IcosahedronGeometry(1, 1);
    this.boomMat = new THREE.MeshBasicMaterial({ color: 0xffa640, transparent: true, opacity: 0.7, depthWrite: false });
    this.booms = new Pool(scene, eg, this.boomMat, 8, { dynamic: true, color: false, order: 5 });
    this.blist = [];
    const rg = MD.merge([MD.cyl(0.09, 0.12, 0.7, 6, '#5a6648', { rx: Math.PI / 2 }), MD.cyl(0.0, 0.12, 0.3, 6, '#d84a3a', { rx: -Math.PI / 2, z: -0.5 })]);
    this.rocketMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.rockets = new Pool(scene, rg, this.rocketMat, 8, { dynamic: true, color: false });
    this.rlist = new Map();
  }
  tracer(ox, oy, oz, ex, ey, ez, color = 0xfff1b0) {
    const dx = ex - ox;
    const dy = ey - oy;
    const dz = ez - oz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.5) return;
    this.tlist.push({ ox, oy, oz, dx: dx / len, dy: dy / len, dz: dz / len, len, t: 0, col: new THREE.Color(color) });
    if (this.tlist.length > 60) this.tlist.shift();
  }
  burst(x, y, z, color, n = 6, speed = 3, size = 1, grav = 9) {
    const col = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      this.plist.push({
        x,
        y,
        z,
        vx: (Math.random() - 0.5) * speed * 2,
        vy: Math.random() * speed * 1.2,
        vz: (Math.random() - 0.5) * speed * 2,
        t: 0,
        life: 0.35 + Math.random() * 0.35,
        s: size * (0.6 + Math.random() * 0.8),
        col,
        g: grav,
        rx: Math.random() * 6,
      });
    }
    if (this.plist.length > 250) this.plist.splice(0, this.plist.length - 250);
  }
  flash(x, y, z) {
    this.flist.push({ x, y, z, t: 0 });
  }
  boom(x, y, z) {
    this.blist.push({ x, y, z, t: 0 });
    this.burst(x, y, z, 0x5b5b5b, 16, 9, 2.2, 6);
    this.burst(x, y, z, 0xffa640, 10, 7, 1.6, 2);
  }
  rocket(id, o, d, v) {
    this.rlist.set(id, { x: o[0], y: o[1], z: o[2], dx: d[0], dy: d[1], dz: d[2], v, t: 0 });
  }
  removeRocket(id) {
    this.rlist.delete(id);
  }
  update(dt, cam) {
    // tracers: a short streak racing from muzzle to impact
    let n = 0;
    for (let i = this.tlist.length - 1; i >= 0; i--) {
      const tr = this.tlist[i];
      tr.t += dt;
      const speed = 520;
      const head = Math.min(tr.len, tr.t * speed);
      const tail = Math.max(0, head - Math.min(5, tr.len * 0.5));
      if (tail >= tr.len - 0.01 || tr.t > 0.5) {
        this.tlist.splice(i, 1);
        continue;
      }
      const l = head - tail;
      // don't draw streaks passing right next to the camera (they fill the screen)
      if (cam) {
        const hx = tr.ox + tr.dx * head - cam.position.x;
        const hy = tr.oy + tr.dy * head - cam.position.y;
        const hz = tr.oz + tr.dz * head - cam.position.z;
        if (hx * hx + hy * hy + hz * hz < 9) continue;
      }
      _v.set(tr.ox + tr.dx * tail, tr.oy + tr.dy * tail, tr.oz + tr.dz * tail);
      _m.lookAt(_v, _s.set(_v.x + tr.dx, _v.y + tr.dy, _v.z + tr.dz), THREE.Object3D.DEFAULT_UP);
      _m.setPosition(_v);
      _m2.makeScale(0.018, 0.018, l);
      _m.multiply(_m2);
      // lookAt makes -z point at target in camera convention; our geometry extends to -z
      this.tracers.ensure(n + 1);
      this.tracers.set(n++, _m, tr.col);
    }
    this.tracers.commit(n);
    // particles
    n = 0;
    for (let i = this.plist.length - 1; i >= 0; i--) {
      const p = this.plist[i];
      p.t += dt;
      if (p.t > p.life) {
        this.plist.splice(i, 1);
        continue;
      }
      p.vy -= p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const s = p.s * (1 - p.t / p.life);
      _e.set(p.rx + p.t * 8, p.rx, 0);
      _q.setFromEuler(_e);
      _m.compose(_v.set(p.x, p.y, p.z), _q, _s.set(s, s, s));
      this.parts.ensure(n + 1);
      this.parts.set(n++, _m, p.col);
    }
    this.parts.commit(n);
    n = 0;
    for (let i = this.flist.length - 1; i >= 0; i--) {
      const f = this.flist[i];
      f.t += dt;
      if (f.t > 0.05) {
        this.flist.splice(i, 1);
        continue;
      }
      const s = 1 + Math.random() * 0.6;
      _m.compose(_v.set(f.x, f.y, f.z), _q.setFromEuler(_e.set(Math.random(), Math.random(), 0)), _s.set(s, s, s));
      this.flashes.ensure(n + 1);
      this.flashes.set(n++, _m);
    }
    this.flashes.commit(n);
    n = 0;
    for (let i = this.blist.length - 1; i >= 0; i--) {
      const b = this.blist[i];
      b.t += dt;
      if (b.t > 0.45) {
        this.blist.splice(i, 1);
        continue;
      }
      const s = 1 + b.t * 12;
      _m.compose(_v.set(b.x, b.y, b.z), _q.identity(), _s.set(s, s, s));
      this.booms.set(n++, _m);
    }
    this.boomMat.opacity = this.blist.length ? 0.7 * (1 - this.blist[0].t / 0.45) : 0;
    this.booms.commit(n);
    n = 0;
    for (const r of this.rlist.values()) {
      r.t += dt;
      if (r.t > 7) continue;
      r.x += r.dx * r.v * dt;
      r.y += r.dy * r.v * dt;
      r.z += r.dz * r.v * dt;
      _v.set(r.x, r.y, r.z);
      _m.lookAt(_v, _s.set(r.x + r.dx, r.y + r.dy, r.z + r.dz), THREE.Object3D.DEFAULT_UP);
      _m.setPosition(_v);
      this.rockets.ensure(n + 1);
      this.rockets.set(n++, _m);
      if (Math.random() < 0.5) this.burst(r.x - r.dx * 0.5, r.y - r.dy * 0.5, r.z - r.dz * 0.5, 0xdddddd, 1, 0.6, 1.2, -1);
    }
    this.rockets.commit(n);
    void cam;
  }
}

// ------------------------------------------------------------------ storm wall
export class StormView {
  constructor(scene) {
    const g = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true);
    g.translate(0, 0.5, 0);
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { time: { value: 0 }, col: { value: new THREE.Color('#8a3fd6') } },
      vertexShader: `
        varying vec2 vUv; varying float vY;
        void main(){ vUv = uv; vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform float time; uniform vec3 col; varying vec2 vUv; varying float vY;
        void main(){
          float band = 0.5 + 0.5 * sin(vUv.x * 240.0 + vY * 14.0 - time * 1.6);
          float band2 = 0.5 + 0.5 * sin(vUv.x * 90.0 - vY * 6.0 + time * 0.9);
          float a = 0.2 + 0.1 * band + 0.06 * band2;
          a *= 1.0 - smoothstep(0.22, 0.62, vY);
          gl_FragColor = vec4(col * (0.85 + 0.25 * band), a);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);
  }
  update(s, t) {
    this.mat.uniforms.time.value = t;
    const r = Math.max(0.5, s.r);
    this.mesh.position.set(s.cx, -30, s.cz);
    this.mesh.scale.set(r, 420, r);
  }
}

// ------------------------------------------------------------------ build ghost
export class GhostView {
  constructor(scene) {
    const geos = pieceGeometries();
    this.geos = [geos[0], geos[3], geos[4], geos[5]];
    this.edges = this.geos.map((g) => new THREE.EdgesGeometry(g, 30));
    this.mat = new THREE.MeshBasicMaterial({ color: 0x4aa8ff, transparent: true, opacity: 0.32, depthWrite: false });
    this.edge = new THREE.LineBasicMaterial({ color: 0xd8efff, transparent: true, opacity: 0.9 });
    this.mesh = new THREE.Mesh(this.geos[0], this.mat);
    this.wire = new THREE.LineSegments(this.edges[0], this.edge);
    this.mesh.renderOrder = 7;
    this.wire.renderOrder = 7;
    this.mesh.matrixAutoUpdate = false;
    this.wire.matrixAutoUpdate = false;
    this.mesh.visible = this.wire.visible = false;
    scene.add(this.mesh, this.wire);
  }
  show(t, ok) {
    if (!t) {
      this.mesh.visible = this.wire.visible = false;
      return;
    }
    const g = this.geos[t.k];
    this.mesh.geometry = g;
    this.wire.geometry = this.edges[t.k];
    pieceMatrix(t, this.mesh.matrix);
    this.wire.matrix.copy(this.mesh.matrix);
    this.mat.color.setHex(ok ? 0x4aa8ff : 0xff4a4a);
    this.edge.color.setHex(ok ? 0xbfe3ff : 0xffb0b0);
    this.mesh.visible = this.wire.visible = true;
  }
}

export { Pool };
void WEAPONS;
