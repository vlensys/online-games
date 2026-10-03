// Kart models (one merged, vertex-coloured body per kart so a full grid stays cheap to draw) and
// how they move with the simulation: wheels spin and steer, the body leans, hops, drifts, spins,
// shows its boost flames and shield. Also rockets and oil slicks.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { driverById } from '../core/config.js';
import * as TX from './textures.js';

function colored(g, color) {
  g = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}

const bodyCache = new Map();
function bodyGeometry(d) {
  if (bodyCache.has(d.id)) return bodyCache.get(d.id);
  const P = [];
  const add = (g, c) => P.push(colored(g, c));
  const dark = '#24242a',
    metal = '#b9bcc6';
  add(new RoundedBoxGeometry(1.36, 0.26, 2.1, 2, 0.1).translate(0, 0.34, 0), d.body);
  add(new THREE.BoxGeometry(1.0, 0.2, 0.55).translate(0, 0.32, 1.22), d.trim);
  add(new THREE.CylinderGeometry(0.1, 0.1, 1.5, 8).rotateZ(Math.PI / 2).translate(0, 0.26, 1.5), dark);
  add(new THREE.CylinderGeometry(0.09, 0.09, 1.6, 8).rotateZ(Math.PI / 2).translate(0, 0.32, -1.18), dark);
  for (const s of [-1, 1]) {
    add(new RoundedBoxGeometry(0.28, 0.3, 1.05, 1, 0.08).translate(s * 0.74, 0.4, 0.05), d.body);
    add(new THREE.BoxGeometry(0.06, 0.5, 0.06).translate(s * 0.45, 0.85, -1.1), d.trim);
    add(new THREE.CylinderGeometry(0.08, 0.1, 0.42, 8).rotateX(Math.PI / 2).translate(s * 0.24, 0.62, -1.3), metal);
    // arms to the wheel
    add(new THREE.CylinderGeometry(0.07, 0.07, 0.55, 6).rotateX(-1.0).translate(s * 0.26, 1.02, 0.08), d.suit);
  }
  add(new THREE.BoxGeometry(0.7, 0.5, 0.14).translate(0, 0.68, -0.55), dark);
  add(new THREE.BoxGeometry(0.82, 0.42, 0.5).translate(0, 0.6, -0.98), '#3a3a42');
  add(new THREE.BoxGeometry(1.46, 0.07, 0.38).translate(0, 1.1, -1.12), d.trim);
  add(new THREE.TorusGeometry(0.17, 0.035, 6, 14).rotateX(-0.9).translate(0, 0.9, 0.38), dark);
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 5).rotateX(1.0).translate(0, 0.8, 0.52), dark);
  // driver
  add(new THREE.CapsuleGeometry(0.27, 0.32, 4, 10).translate(0, 1.0, -0.28), d.suit);
  add(new THREE.SphereGeometry(0.31, 14, 10).translate(0, 1.58, -0.22), d.helmet);
  add(new THREE.SphereGeometry(0.315, 14, 8, -0.95, 1.9, 1.15, 0.62).translate(0, 1.58, -0.22), '#1a1c26');
  add(new THREE.BoxGeometry(0.08, 0.12, 0.3).translate(0, 1.9, -0.25), d.trim);
  const g = mergeGeometries(P);
  g.computeVertexNormals();
  bodyCache.set(d.id, g);
  return g;
}

let wheelGeoF = null,
  wheelGeoR = null;
function wheelGeometry(r, w, hub) {
  const tire = colored(new THREE.CylinderGeometry(r, r, w, 16).rotateZ(Math.PI / 2), '#1b1b1f');
  const rim = colored(new THREE.CylinderGeometry(r * 0.52, r * 0.52, w + 0.02, 10).rotateZ(Math.PI / 2), hub);
  const tread = colored(new THREE.BoxGeometry(w + 0.03, 0.05, r * 0.5).translate(0, r * 0.96, 0), '#2b2b30');
  return mergeGeometries([tire, rim, tread]);
}

const shadowTex = { t: null };
const flameMat = () =>
  new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });

export class KartView {
  constructor(scene, k, opts = {}) {
    const d = driverById(k.driver);
    this.d = d;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.12 });
    this.mat = mat;
    const bm = new THREE.Mesh(bodyGeometry(d), mat);
    bm.castShadow = !!opts.shadows;
    this.body.add(bm);
    if (!wheelGeoF) {
      wheelGeoF = wheelGeometry(0.3, 0.28, '#c9ccd6');
      wheelGeoR = wheelGeometry(0.37, 0.38, '#c9ccd6');
    }
    const wmat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.wheels = [];
    this.steerPivots = [];
    for (const [x, y, z, front] of [
      [-0.8, 0.3, 0.82, true],
      [0.8, 0.3, 0.82, true],
      [-0.82, 0.37, -0.78, false],
      [0.82, 0.37, -0.78, false],
    ]) {
      const piv = new THREE.Group();
      piv.position.set(x, y, z);
      const w = new THREE.Mesh(front ? wheelGeoF : wheelGeoR, wmat);
      w.castShadow = !!opts.shadows;
      piv.add(w);
      this.root.add(piv);
      this.wheels.push(w);
      if (front) this.steerPivots.push(piv);
    }
    // boost flames
    this.flames = [];
    for (const s of [-1, 1]) {
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.7, 8).rotateX(-Math.PI / 2).translate(0, 0, -0.35), flameMat());
      f.position.set(s * 0.24, 0.62, -1.5);
      this.body.add(f);
      this.flames.push(f);
    }
    // shield bubble
    this.shield = new THREE.Mesh(
      new THREE.SphereGeometry(1.75, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0x5fd8ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.shield.position.y = 0.8;
    this.shield.visible = false;
    this.root.add(this.shield);
    // soft shadow when shadow maps are off
    if (!opts.shadows) {
      if (!shadowTex.t) shadowTex.t = TX.blob('rgba(0,0,0,0.6)');
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 3.0), new THREE.MeshBasicMaterial({ map: shadowTex.t, transparent: true, depthWrite: false }));
      sh.rotation.x = -Math.PI / 2;
      sh.position.y = 0.04;
      this.shadow = sh;
      scene.add(sh);
    }
    if (opts.tag) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: TX.nameTag(opts.tag, d.body === '#3d3f4a' ? '#ff9a5a' : d.body), depthTest: true, transparent: true }));
      sp.scale.set(3.2, 0.8, 1);
      sp.position.y = 2.7;
      this.root.add(sp);
      this.tag = sp;
    }
    if (opts.ghost) {
      this.root.traverse((o) => {
        if (o.material) {
          o.material = o.material.clone();
          o.material.transparent = true;
          o.material.opacity = 0.38;
          o.material.depthWrite = false;
          o.castShadow = false;
        }
      });
      this.shield.visible = false;
    }
    this.ghost = !!opts.ghost;
    this.flip = 0;
    this.squash = 0;
    scene.add(this.root);
    this.scene = scene;
  }

  // pose from kart state; p = interpolated {x,y,z,yaw}
  update(k, p, dt, t) {
    this.root.position.set(p.x, p.y, p.z);
    this.root.rotation.y = p.yaw;
    const sp = Math.min(1, Math.abs(k.vf) / 25);
    // body: drift angle, spin, lean, pitch, hop squash, trick flip
    const driftAng = -k.drift * 0.32;
    this.body.rotation.y += ((driftAng + k.spinAng) - this.body.rotation.y) * (k.spinT > 0 ? 1 : Math.min(1, dt * 10));
    const lean = -k.steerVis * 0.07 * sp - k.drift * 0.05;
    this.body.rotation.z += (lean - this.body.rotation.z) * Math.min(1, dt * 8);
    let pitch = k.grounded ? 0 : Math.max(-0.25, Math.min(0.25, -k.vy * 0.02));
    if (k.trick) this.flip = Math.min(this.flip + dt * 14, Math.PI * 2);
    else if (this.flip > 0) this.flip = 0;
    this.body.rotation.x = pitch + (k.trick ? this.flip : 0);
    this.squash = Math.max(0, this.squash - dt * 5);
    this.body.scale.set(1 + this.squash * 0.06, 1 - this.squash * 0.1, 1);
    for (const piv of this.steerPivots) piv.rotation.y = (k.spinT > 0 ? 0 : k.steerVis) * -0.42 + k.drift * 0.3;
    for (const w of this.wheels) w.rotation.x = k.wheelRot;
    // flames
    const boosting = k.boostT > 0;
    for (const f of this.flames) {
      const s = boosting ? 1.4 + Math.random() * 0.5 : 0.35 + Math.random() * 0.15;
      f.scale.set(boosting ? 1.4 : 0.9, boosting ? 1.4 : 0.9, s);
      f.material.color.setHex(boosting ? (k.boostP > 1.29 ? 0x66b8ff : 0xffa040) : 0xff8a30);
      f.material.opacity = boosting ? 0.95 : 0.55;
    }
    this.shield.visible = k.shieldT > 0 && !this.ghost;
    if (this.shield.visible) {
      this.shield.material.opacity = 0.18 + Math.sin(t * 10) * 0.05 + (k.shieldT < 2 ? (Math.sin(t * 30) > 0 ? 0.1 : -0.1) : 0);
      this.shield.rotation.y = t;
    }
    if (this.shadow) {
      this.shadow.position.set(p.x, k.gy + 0.05, p.z);
      this.shadow.rotation.z = p.yaw;
      const h = Math.max(0, p.y - k.gy);
      this.shadow.material.opacity = Math.max(0.15, 1 - h * 0.25);
    }
  }

  setVisible(v) {
    this.root.visible = v;
    if (this.shadow) this.shadow.visible = v;
  }

  dispose() {
    this.scene.remove(this.root);
    if (this.shadow) this.scene.remove(this.shadow);
    this.root.traverse((o) => {
      if (o.material) o.material.dispose();
    });
  }
}

// ------------------------------------------------------------------ rockets and oil
let rocketGeo = null;
function rocketGeometry(color) {
  return mergeGeometries([
    colored(new THREE.CylinderGeometry(0.2, 0.2, 1.0, 10).rotateX(Math.PI / 2), color),
    colored(new THREE.ConeGeometry(0.2, 0.45, 10).rotateX(Math.PI / 2).translate(0, 0, 0.72), '#f4f4f4'),
    colored(new THREE.BoxGeometry(0.7, 0.05, 0.3).translate(0, 0, -0.4), '#30303a'),
    colored(new THREE.BoxGeometry(0.05, 0.7, 0.3).translate(0, 0, -0.4), '#30303a'),
  ]);
}

export class ItemViews {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    if (!rocketGeo) rocketGeo = { rocket: rocketGeometry('#e8412c'), homing: rocketGeometry('#8a4cff') };
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x220000 });
    this.oilMat = new THREE.MeshBasicMaterial({ map: TX.oilTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    this.oilGeo = new THREE.PlaneGeometry(4.2, 4.2).rotateX(-Math.PI / 2);
    this.rockets = new Map();
    this.oils = new Map();
  }

  update(race, t) {
    const seen = new Set();
    for (const p of race.proj) {
      seen.add(p.id);
      let m = this.rockets.get(p.id);
      if (!m) {
        m = new THREE.Mesh(rocketGeo[p.type] || rocketGeo.rocket, this.mat);
        this.group.add(m);
        this.rockets.set(p.id, m);
      }
      m.position.set(p.x, p.y + Math.sin(t * 20 + p.id) * 0.05, p.z);
      m.rotation.set(0, Math.atan2(p.vx, p.vz), t * 8);
    }
    for (const [id, m] of this.rockets)
      if (!seen.has(id)) {
        this.group.remove(m);
        this.rockets.delete(id);
      }
    seen.clear();
    for (const o of race.oils) {
      seen.add(o.id);
      let m = this.oils.get(o.id);
      if (!m) {
        m = new THREE.Mesh(this.oilGeo, this.oilMat);
        m.rotation.y = o.id;
        this.group.add(m);
        this.oils.set(o.id, m);
      }
      m.position.set(o.x, o.y + 0.06, o.z);
    }
    for (const [id, m] of this.oils)
      if (!seen.has(id)) {
        this.group.remove(m);
        this.oils.delete(id);
      }
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
