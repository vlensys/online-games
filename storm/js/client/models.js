// Procedural low-poly models. Every model is one merged BufferGeometry with vertex colors
// (drawn with flat-shaded Lambert materials, instanced where there are many copies).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/rng.js';

const _c = new THREE.Color();

export function paint(geo, hex, shade = 1) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g.attributes.uv) g.deleteAttribute('uv');
  if (g.attributes.uv1) g.deleteAttribute('uv1');
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  _c.set(hex);
  const r = _c.r * shade;
  const gg = _c.g * shade;
  const b = _c.b * shade;
  for (let i = 0; i < n; i++) {
    col[i * 3] = r;
    col[i * 3 + 1] = gg;
    col[i * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

export function part(geo, hex, o = {}) {
  if (o.sx || o.sy || o.sz) geo.scale(o.sx || 1, o.sy || 1, o.sz || 1);
  if (o.rx) geo.rotateX(o.rx);
  if (o.rz) geo.rotateZ(o.rz);
  if (o.ry) geo.rotateY(o.ry);
  geo.translate(o.x || 0, o.y || 0, o.z || 0);
  return paint(geo, hex, o.shade || 1);
}

export function box(w, h, d, hex, o = {}) {
  return part(new THREE.BoxGeometry(w, h, d), hex, o);
}
export function cyl(rt, rb, h, seg, hex, o = {}) {
  return part(new THREE.CylinderGeometry(rt, rb, h, seg, 1, false), hex, o);
}
export function merge(list) {
  return mergeGeometries(list, false);
}

// jitter vertices of a non-indexed geometry consistently (same position -> same offset)
function jitter(g, amt, seed) {
  const pos = g.attributes.position;
  const map = new Map();
  const rnd = mulberry32(seed);
  for (let i = 0; i < pos.count; i++) {
    const k = pos.getX(i).toFixed(3) + ',' + pos.getY(i).toFixed(3) + ',' + pos.getZ(i).toFixed(3);
    let o = map.get(k);
    if (!o) {
      o = [(rnd() - 0.5) * amt, (rnd() - 0.5) * amt, (rnd() - 0.5) * amt];
      map.set(k, o);
    }
    pos.setXYZ(i, pos.getX(i) + o[0], pos.getY(i) + o[1], pos.getZ(i) + o[2]);
  }
  pos.needsUpdate = true;
  return g;
}

// ------------------------------------------------------------------ props
export function propModels() {
  const M = {};
  // pine
  M.pine = [
    merge([
      cyl(0.28, 0.4, 3.2, 6, '#6e4a2c', { y: 1.6 }),
      cyl(0.1, 2.3, 3.2, 7, '#2f8a45', { y: 3.6 }),
      cyl(0.1, 1.85, 2.9, 7, '#2a7d3e', { y: 5.4 }),
      cyl(0.05, 1.25, 2.4, 7, '#2f8a45', { y: 7.3 }),
    ]),
  ];
  // oak
  const blob = (r, x, y, z, hex, seed) => jitter(part(new THREE.IcosahedronGeometry(r, 0), hex, { x, y, z }), r * 0.35, seed);
  M.oak = [
    merge([
      cyl(0.32, 0.48, 4, 6, '#7a5232', { y: 2 }),
      box(0.25, 1.4, 0.25, '#7a5232', { x: 0.5, y: 3.6, rz: -0.7 }),
      blob(2.1, 0, 5.2, 0, '#5cae3c', 1),
      blob(1.6, 1.2, 4.6, 0.6, '#52a236', 2),
      blob(1.5, -1.1, 4.7, -0.4, '#62b541', 3),
      blob(1.3, 0.2, 6.5, -0.5, '#58aa3a', 4),
    ]),
  ];
  // palm
  const palmParts = [];
  for (let i = 0; i < 5; i++) palmParts.push(cyl(0.26 - i * 0.02, 0.3 - i * 0.02, 1.7, 6, i % 2 ? '#b8905a' : '#a88150', { x: i * i * 0.05, y: 0.85 + i * 1.6 }));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const leaf = new THREE.BoxGeometry(0.7, 0.08, 3);
    leaf.translate(0, 0, 1.5);
    leaf.rotateX(0.45);
    leaf.rotateY(a);
    leaf.translate(0.8, 8.1, 0);
    palmParts.push(paint(leaf, i % 2 ? '#47a53a' : '#3e9a34'));
  }
  palmParts.push(part(new THREE.IcosahedronGeometry(0.45, 0), '#7a5a2c', { x: 0.8, y: 7.9 }));
  M.palm = [merge(palmParts)];
  // rock
  const rk = new THREE.DodecahedronGeometry(1.5, 0);
  rk.scale(1.05, 0.72, 0.98);
  M.rock = [jitter(paint(rk, '#9ea3a8'), 0.45, 9)];
  M.rock[0].translate(0, 0.66, 0);
  // bush
  M.bush = [merge([blob(0.9, 0, 0.6, 0, '#46a23f', 5), blob(0.7, 0.6, 0.5, 0.3, '#3f9839', 6), blob(0.65, -0.5, 0.5, -0.3, '#4eaa45', 7)])];
  // car: body (tinted) + details
  M.car = [
    merge([box(2.1, 0.75, 4.3, '#ffffff', { y: 0.72 }), box(1.8, 0.62, 2.1, '#ffffff', { y: 1.4, z: 0.25 })]),
    merge([
      box(1.84, 0.46, 2.0, '#bfe4f5', { y: 1.42, z: 0.25, sx: 1.01 }),
      box(1.7, 0.4, 0.08, '#bfe4f5', { y: 1.45, z: -0.83 }),
      cyl(0.36, 0.36, 0.3, 8, '#2a2a2e', { rz: Math.PI / 2, x: 0.98, y: 0.36, z: 1.35 }),
      cyl(0.36, 0.36, 0.3, 8, '#2a2a2e', { rz: Math.PI / 2, x: -0.98, y: 0.36, z: 1.35 }),
      cyl(0.36, 0.36, 0.3, 8, '#2a2a2e', { rz: Math.PI / 2, x: 0.98, y: 0.36, z: -1.35 }),
      cyl(0.36, 0.36, 0.3, 8, '#2a2a2e', { rz: Math.PI / 2, x: -0.98, y: 0.36, z: -1.35 }),
      box(0.4, 0.18, 0.06, '#fff3b0', { x: 0.62, y: 0.82, z: -2.16 }),
      box(0.4, 0.18, 0.06, '#fff3b0', { x: -0.62, y: 0.82, z: -2.16 }),
      box(0.4, 0.16, 0.06, '#d8423a', { x: 0.62, y: 0.82, z: 2.16 }),
      box(0.4, 0.16, 0.06, '#d8423a', { x: -0.62, y: 0.82, z: 2.16 }),
    ]),
  ];
  // shipping container (tinted), ridges baked as slightly darker boxes
  const cont = [box(2.6, 2.75, 6.2, '#ffffff', { y: 1.375 })];
  for (let i = -5; i <= 5; i++) {
    cont.push(box(2.66, 2.6, 0.12, '#dcdcdc', { y: 1.375, z: i * 0.55 }));
  }
  cont.push(box(2.4, 2.5, 0.06, '#c8c8c8', { y: 1.375, z: -3.12 }));
  M.container = [merge(cont)];
  M.crate = [
    merge([
      box(1.5, 1.5, 1.5, '#c09058', { y: 0.75 }),
      box(1.56, 0.16, 1.56, '#8c6238', { y: 0.08 }),
      box(1.56, 0.16, 1.56, '#8c6238', { y: 1.42 }),
      box(0.16, 1.5, 1.56, '#8c6238', { x: 0.7, y: 0.75 }),
      box(0.16, 1.5, 1.56, '#8c6238', { x: -0.7, y: 0.75 }),
    ]),
  ];
  M.hay = [merge([cyl(0.95, 0.95, 1.5, 10, '#e4c35c', { y: 0.75 }), cyl(0.97, 0.97, 0.12, 10, '#c9a441', { y: 0.75 })])];
  return M;
}

export function landmarkModel(type) {
  if (type === 'lighthouse') {
    const parts = [];
    for (let i = 0; i < 6; i++) parts.push(cyl(3.3 - (i + 1) * 0.18, 3.3 - i * 0.18, 4, 12, i % 2 ? '#d8403a' : '#f7f4ee', { y: 2 + i * 4 - 1 }));
    parts.push(cyl(2.4, 2.4, 0.4, 12, '#2d2d33', { y: 23.2 }));
    parts.push(cyl(1.7, 1.7, 3.6, 10, '#fff5c2', { y: 25.2 }));
    parts.push(cyl(0.3, 2.3, 1.8, 10, '#d8403a', { y: 27.9 }));
    parts.push(cyl(2.9, 2.9, 0.3, 12, '#2d2d33', { y: 23.6 }));
    return merge(parts);
  }
  if (type === 'windmill') {
    return merge([
      cyl(2.3, 3.3, 15, 8, '#f1e8d6', { y: 7 }),
      cyl(0.2, 3, 3, 8, '#8a3b2f', { y: 16 }),
      box(1.2, 2, 0.3, '#6e4a33', { y: 1, z: -3.1 }),
    ]);
  }
  if (type === 'windmillBlades') {
    const parts = [cyl(0.4, 0.4, 0.8, 8, '#6e4a33', { rx: Math.PI / 2 })];
    for (let i = 0; i < 4; i++) {
      const g = new THREE.BoxGeometry(1.4, 7, 0.12);
      g.translate(0.3, 4, 0);
      g.rotateZ((i * Math.PI) / 2);
      parts.push(paint(g, '#f7f4ee'));
      const s = new THREE.BoxGeometry(0.18, 7.3, 0.2);
      s.translate(-0.4, 3.9, 0);
      s.rotateZ((i * Math.PI) / 2);
      parts.push(paint(s, '#7a5232'));
    }
    return merge(parts);
  }
  if (type === 'watertower') {
    const parts = [
      cyl(4.3, 4.3, 6.5, 12, '#6fa0c8', { y: 14.25 }),
      cyl(0.4, 4.6, 2.2, 12, '#51789c', { y: 18.6 }),
      cyl(4.35, 4.35, 0.3, 12, '#51789c', { y: 11.1 }),
    ];
    for (const [x, z] of [[3, 3], [-3, 3], [3, -3], [-3, -3]]) parts.push(cyl(0.3, 0.35, 12, 6, '#6b6f75', { x, y: 5, z }));
    parts.push(box(6.4, 0.25, 0.25, '#6b6f75', { y: 5, z: 3 }), box(6.4, 0.25, 0.25, '#6b6f75', { y: 5, z: -3 }));
    parts.push(box(0.25, 0.25, 6.4, '#6b6f75', { y: 5, x: 3 }), box(0.25, 0.25, 6.4, '#6b6f75', { y: 5, x: -3 }));
    return merge(parts);
  }
  if (type === 'radiotower') {
    const parts = [];
    for (const [x, z] of [[1.4, 1.4], [-1.4, 1.4], [1.4, -1.4], [-1.4, -1.4]]) parts.push(box(0.22, 34, 0.22, '#d8403a', { x, y: 16, z }));
    for (let i = 0; i < 12; i++) {
      const y = 1 + i * 2.8;
      const hex = i % 2 ? '#f7f4ee' : '#d8403a';
      parts.push(box(3, 0.18, 0.18, hex, { y, z: 1.4 }), box(3, 0.18, 0.18, hex, { y, z: -1.4 }));
      parts.push(box(0.18, 0.18, 3, hex, { y, x: 1.4 }), box(0.18, 0.18, 3, hex, { y, x: -1.4 }));
    }
    parts.push(cyl(0.1, 0.1, 6, 4, '#d8403a', { y: 36 }), box(0.6, 0.6, 0.6, '#ff5040', { y: 39 }));
    return merge(parts);
  }
  return new THREE.BoxGeometry(1, 1, 1);
}

// ------------------------------------------------------------------ characters
export function charParts() {
  const P = {};
  P.torso = merge([box(0.56, 0.62, 0.32, '#ffffff', { y: 1.2 }), box(0.58, 0.08, 0.34, '#bdbdbd', { y: 0.92 })]);
  P.pelvis = box(0.5, 0.22, 0.3, '#ffffff', { y: 0.86 });
  P.leg = merge([box(0.22, 0.7, 0.26, '#ffffff', { y: -0.35 }), box(0.24, 0.16, 0.34, '#3a3a3a', { y: -0.76, z: -0.04 })]);
  P.arm = box(0.17, 0.6, 0.19, '#ffffff', { y: -0.3 });
  P.hand = box(0.15, 0.15, 0.15, '#ffffff', { y: -0.66 });
  P.head = box(0.42, 0.42, 0.4, '#ffffff', { y: 1.72 });
  P.hair = merge([box(0.46, 0.13, 0.44, '#ffffff', { y: 1.95 }), box(0.46, 0.3, 0.1, '#ffffff', { y: 1.8, z: 0.2 })]);
  P.face = merge([box(0.07, 0.1, 0.02, '#1d1d24', { x: 0.1, y: 1.76, z: -0.205 }), box(0.07, 0.1, 0.02, '#1d1d24', { x: -0.1, y: 1.76, z: -0.205 }), box(0.14, 0.03, 0.02, '#7a3b36', { y: 1.62, z: -0.205 })]);
  P.pack = merge([box(0.38, 0.44, 0.17, '#ffffff', { y: 1.22, z: 0.25 }), box(0.3, 0.12, 0.2, '#cccccc', { y: 1.02, z: 0.27 })]);
  const canopy = new THREE.ConeGeometry(1.7, 0.7, 4, 1);
  canopy.rotateY(Math.PI / 4);
  canopy.scale(1, 1, 0.75);
  P.glider = merge([
    part(canopy, '#ffffff', { y: 3.35 }),
    cyl(0.025, 0.025, 1.6, 4, '#333333', { x: 0.9, y: 2.6, rz: 0.55 }),
    cyl(0.025, 0.025, 1.6, 4, '#333333', { x: -0.9, y: 2.6, rz: -0.55 }),
  ]);
  return P;
}

// ------------------------------------------------------------------ weapons (point toward -z, origin at grip)
export function weaponModels() {
  const dark = '#34393f';
  const mid = '#565d66';
  const wood = '#8a5a32';
  const W = {};
  W.pickaxe = {
    body: merge([cyl(0.035, 0.035, 0.95, 5, '#6b4a2e', { rx: Math.PI / 2, z: -0.3 }), box(0.07, 0.07, 0.12, '#2a2a2a', { z: 0.14 })]),
    acc: merge([box(0.62, 0.09, 0.1, '#ffffff', { y: 0, z: -0.74 }), box(0.1, 0.12, 0.14, '#ffffff', { z: -0.74 })]),
  };
  W.pistol = {
    body: merge([box(0.08, 0.11, 0.32, dark, { y: 0.08, z: -0.12 }), box(0.07, 0.16, 0.08, mid, { y: -0.03, z: 0.0, rx: -0.25 })]),
    acc: box(0.085, 0.03, 0.2, '#ffffff', { y: 0.14, z: -0.13 }),
  };
  W.smg = {
    body: merge([box(0.1, 0.13, 0.5, dark, { y: 0.06, z: -0.16 }), box(0.06, 0.2, 0.08, mid, { y: -0.08, z: -0.2 }), box(0.07, 0.14, 0.08, mid, { y: -0.04, z: 0.03, rx: -0.2 }), box(0.05, 0.05, 0.14, mid, { y: 0.08, z: -0.46 })]),
    acc: box(0.105, 0.035, 0.3, '#ffffff', { y: 0.13, z: -0.18 }),
  };
  W.ar = {
    body: merge([
      box(0.1, 0.14, 0.66, dark, { y: 0.06, z: -0.22 }),
      box(0.05, 0.05, 0.32, mid, { y: 0.08, z: -0.7 }),
      box(0.07, 0.2, 0.1, mid, { y: -0.1, z: -0.26, rx: 0.2 }),
      box(0.07, 0.15, 0.08, mid, { y: -0.04, z: 0.02, rx: -0.2 }),
      box(0.08, 0.13, 0.26, dark, { y: 0.04, z: 0.2 }),
      box(0.05, 0.06, 0.1, '#222222', { y: 0.16, z: -0.2 }),
    ]),
    acc: box(0.105, 0.035, 0.42, '#ffffff', { y: 0.14, z: -0.26 }),
  };
  W.shotgun = {
    body: merge([
      box(0.09, 0.1, 0.9, dark, { y: 0.08, z: -0.36 }),
      box(0.1, 0.1, 0.24, wood, { y: 0.0, z: -0.5 }),
      box(0.08, 0.16, 0.3, wood, { y: 0.0, z: 0.2, rx: 0.15 }),
      box(0.07, 0.14, 0.08, dark, { y: -0.04, z: 0.0 }),
    ]),
    acc: box(0.095, 0.03, 0.3, '#ffffff', { y: 0.14, z: -0.1 }),
  };
  W.sniper = {
    body: merge([
      box(0.09, 0.13, 0.9, dark, { y: 0.05, z: -0.28 }),
      box(0.045, 0.045, 0.5, mid, { y: 0.07, z: -0.95 }),
      cyl(0.055, 0.055, 0.42, 8, '#1f1f24', { rx: Math.PI / 2, y: 0.2, z: -0.25 }),
      box(0.08, 0.16, 0.3, wood, { y: 0.0, z: 0.28 }),
      box(0.07, 0.15, 0.08, dark, { y: -0.05, z: 0.02 }),
    ]),
    acc: box(0.095, 0.03, 0.34, '#ffffff', { y: 0.12, z: -0.52 }),
  };
  W.rocket = {
    body: merge([cyl(0.11, 0.11, 1.1, 8, '#4d5a3d', { rx: Math.PI / 2, y: 0.12, z: -0.2 }), box(0.07, 0.15, 0.08, dark, { y: -0.04, z: 0 }), box(0.16, 0.14, 0.14, dark, { y: 0.12, z: 0.35 })]),
    acc: cyl(0.125, 0.125, 0.14, 8, '#ffffff', { rx: Math.PI / 2, y: 0.12, z: -0.72 }),
  };
  return W;
}

// ------------------------------------------------------------------ items on the floor
export function consumableModel(t) {
  if (t === 'bandage') return merge([cyl(0.2, 0.2, 0.18, 10, '#f3efe6', { rz: Math.PI / 2 }), cyl(0.08, 0.08, 0.2, 8, '#d9cdb2', { rz: Math.PI / 2 })]);
  if (t === 'medkit') return merge([box(0.52, 0.34, 0.36, '#f7f7f7'), box(0.28, 0.08, 0.37, '#e0403a', { y: 0 }), box(0.08, 0.28, 0.37, '#e0403a'), box(0.2, 0.06, 0.1, '#888888', { y: 0.2 })]);
  if (t === 'shieldS') return merge([part(new THREE.SphereGeometry(0.17, 8, 6), '#4cc6ff'), cyl(0.06, 0.06, 0.14, 6, '#e8e8e8', { y: 0.2 })]);
  return merge([cyl(0.16, 0.2, 0.44, 8, '#2f8cff'), cyl(0.07, 0.07, 0.14, 6, '#e8e8e8', { y: 0.29 }), cyl(0.205, 0.205, 0.08, 8, '#9fd8ff', { y: 0 })]);
}

export function ammoModel() {
  return merge([box(0.46, 0.26, 0.3, '#ffffff'), box(0.48, 0.06, 0.32, '#3a3a3a', { y: 0.1 })]);
}

export function matModel(i) {
  if (i === 0) return merge([box(0.9, 0.1, 0.28, '#c98e55', { y: -0.1 }), box(0.9, 0.1, 0.28, '#b57a45', { y: 0.0, z: 0.05, ry: 0.3 }), box(0.9, 0.1, 0.28, '#d49a60', { y: 0.1, ry: -0.2 })]);
  if (i === 1) return merge([box(0.4, 0.18, 0.22, '#c2583f', { x: -0.2 }), box(0.4, 0.18, 0.22, '#b24c35', { x: 0.22 }), box(0.4, 0.18, 0.22, '#cf6a4c', { y: 0.18 })]);
  return merge([box(0.8, 0.05, 0.5, '#a3aeb9', { y: -0.05 }), box(0.8, 0.05, 0.5, '#8d98a3', { y: 0.03, ry: 0.25 }), box(0.8, 0.05, 0.5, '#b7c1cb', { y: 0.1, ry: -0.15 })]);
}

// ------------------------------------------------------------------ chests / boxes / bus
export function chestModels() {
  return {
    body: merge([
      box(1.0, 0.56, 0.62, '#e8b33a', { y: 0.28 }),
      box(1.04, 0.1, 0.66, '#7a4b1e', { y: 0.05 }),
      box(0.1, 0.58, 0.66, '#7a4b1e', { x: 0.36, y: 0.29 }),
      box(0.1, 0.58, 0.66, '#7a4b1e', { x: -0.36, y: 0.29 }),
    ]),
    // lid pivot at the back-top edge (z = +0.31, y = 0)
    lid: merge([
      box(1.02, 0.26, 0.64, '#f0c24a', { y: 0.13, z: -0.32 }),
      box(0.1, 0.28, 0.66, '#7a4b1e', { x: 0.36, y: 0.14, z: -0.32 }),
      box(0.1, 0.28, 0.66, '#7a4b1e', { x: -0.36, y: 0.14, z: -0.32 }),
      box(0.16, 0.18, 0.06, '#fff2b0', { y: 0.02, z: -0.66 }),
    ]),
    boxBody: merge([box(0.9, 0.42, 0.5, '#6d7a45', { y: 0.21 }), box(0.92, 0.06, 0.52, '#4d5732', { y: 0.34 })]),
    boxLid: box(0.92, 0.08, 0.52, '#5b673a', { y: 0.04, z: -0.26 }),
  };
}

export function busModel() {
  const parts = [
    box(3.4, 2.7, 9.6, '#2f73d8', { y: 1.9 }),
    box(3.45, 0.7, 9.65, '#f4f4f4', { y: 3.45 }),
    box(3.46, 0.8, 8.2, '#bfe4f5', { y: 2.45, z: 0.4 }),
    box(3.0, 1.1, 0.1, '#bfe4f5', { y: 2.5, z: -4.82 }),
    box(3.46, 0.3, 9.66, '#1d4c96', { y: 0.7 }),
    box(1.6, 0.5, 0.1, '#e8e8e8', { y: 1.1, z: -4.83 }),
    cyl(0.6, 0.6, 0.5, 10, '#222226', { rz: Math.PI / 2, x: 1.6, y: 0.6, z: 3.2 }),
    cyl(0.6, 0.6, 0.5, 10, '#222226', { rz: Math.PI / 2, x: -1.6, y: 0.6, z: 3.2 }),
    cyl(0.6, 0.6, 0.5, 10, '#222226', { rz: Math.PI / 2, x: 1.6, y: 0.6, z: -3.2 }),
    cyl(0.6, 0.6, 0.5, 10, '#222226', { rz: Math.PI / 2, x: -1.6, y: 0.6, z: -3.2 }),
  ];
  // balloon
  const bal = new THREE.SphereGeometry(4.6, 12, 8);
  const bg = paint(bal, '#e84a3c');
  const col = bg.attributes.color;
  const pos = bg.attributes.position;
  const w = new THREE.Color('#f7f4ee');
  for (let i = 0; i < pos.count; i += 3) {
    const a = Math.atan2((pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3, (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3);
    if (Math.floor(((a + Math.PI) / (Math.PI * 2)) * 12) % 2 === 0) for (let k = 0; k < 3; k++) col.setXYZ(i + k, w.r, w.g, w.b);
  }
  bg.scale(1, 1.15, 1);
  bg.translate(0, 12.2, 0);
  parts.push(bg);
  for (const [x, z] of [[1.4, 3.8], [-1.4, 3.8], [1.4, -3.8], [-1.4, -3.8]]) {
    const r = new THREE.CylinderGeometry(0.05, 0.05, 5.2, 4);
    r.rotateZ(x > 0 ? -0.18 : 0.18);
    r.rotateX(z > 0 ? 0.55 : -0.55);
    r.translate(x * 0.75, 5.9, z * 0.62);
    parts.push(paint(r, '#4a4a4a'));
  }
  return merge(parts);
}

export function cloudGeometry(seed) {
  const rnd = mulberry32(seed);
  const parts = [];
  const n = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const r = 8 + rnd() * 9;
    const g = new THREE.IcosahedronGeometry(r, 0);
    g.scale(1.3, 0.6, 1);
    g.translate((i - n / 2) * 11 + rnd() * 5, rnd() * 4, rnd() * 10 - 5);
    parts.push(paint(g, '#ffffff'));
  }
  return merge(parts);
}
