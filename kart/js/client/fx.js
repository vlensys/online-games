// Particles: drift sparks (colour = mini-turbo charge), dust, boost sparks, explosions, item box
// confetti, and the shockwave ring.
import * as THREE from 'three';
import * as TX from './textures.js';

const DRIFT_COLORS = [
  [1, 0.85, 0.45],
  [0.35, 0.7, 1],
  [1, 0.55, 0.15],
  [0.8, 0.35, 1],
];

class Particles {
  constructor(scene, max, additive, tex) {
    this.max = max;
    this.n = 0;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.c = new Float32Array(max * 3);
    this.a = new Float32Array(max);
    this.s = new Float32Array(max);
    this.life = new Float32Array(max);
    this.max0 = new Float32Array(max);
    this.g = new Float32Array(max);
    this.grow = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    this.pa = new THREE.BufferAttribute(this.p, 3);
    this.ca = new THREE.BufferAttribute(this.c, 3);
    this.aa = new THREE.BufferAttribute(this.a, 1);
    this.sa = new THREE.BufferAttribute(this.s, 1);
    for (const x of [this.pa, this.ca, this.aa, this.sa]) x.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pa);
    geo.setAttribute('color', this.ca);
    geo.setAttribute('alpha', this.aa);
    geo.setAttribute('size', this.sa);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, scale: { value: 400 } },
      vertexShader:
        'attribute float alpha; attribute float size; attribute vec3 color; varying vec3 vC; varying float vA; uniform float scale; void main(){ vC = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform sampler2D map; varying vec3 vC; varying float vA; void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vC * t.rgb, t.a * vA); if (gl_FragColor.a < 0.01) discard; }',
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    geo.setDrawRange(0, 0);
    scene.add(this.points);
  }
  spawn(x, y, z, vx, vy, vz, life, size, r, g, b, grav = 0, grow = 0) {
    let i = this.n;
    if (i >= this.max) i = Math.floor(Math.random() * this.max);
    else this.n++;
    this.p.set([x, y, z], i * 3);
    this.v.set([vx, vy, vz], i * 3);
    this.c.set([r, g, b], i * 3);
    this.life[i] = this.max0[i] = life;
    this.s[i] = size;
    this.g[i] = grav;
    this.grow[i] = grow;
    this.a[i] = 1;
  }
  update(dt) {
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        n--;
        if (i !== n) {
          this.p.copyWithin(i * 3, n * 3, n * 3 + 3);
          this.v.copyWithin(i * 3, n * 3, n * 3 + 3);
          this.c.copyWithin(i * 3, n * 3, n * 3 + 3);
          this.life[i] = this.life[n];
          this.max0[i] = this.max0[n];
          this.s[i] = this.s[n];
          this.g[i] = this.g[n];
          this.grow[i] = this.grow[n];
          i--;
        }
        continue;
      }
      const j = i * 3;
      this.v[j + 1] -= this.g[i] * dt;
      this.p[j] += this.v[j] * dt;
      this.p[j + 1] += this.v[j + 1] * dt;
      this.p[j + 2] += this.v[j + 2] * dt;
      this.s[i] += this.grow[i] * dt;
      this.a[i] = Math.min(1, (this.life[i] / this.max0[i]) * 1.6);
    }
    this.n = n;
    for (const x of [this.pa, this.ca, this.aa, this.sa]) x.needsUpdate = true;
    this.points.geometry.setDrawRange(0, n);
  }
  clear() {
    this.n = 0;
    this.points.geometry.setDrawRange(0, 0);
  }
}

export class Fx {
  constructor(scene, quality) {
    const dot = TX.softDot();
    this.mul = quality === 'low' ? 0.5 : 1;
    this.sparks = new Particles(scene, quality === 'low' ? 700 : 1600, true, dot);
    this.smoke = new Particles(scene, quality === 'low' ? 400 : 900, false, dot);
    this.scene = scene;
    this.rings = [];
    this.ringGeo = new THREE.TorusGeometry(1, 0.25, 6, 40).rotateX(Math.PI / 2);
  }
  setScale(h) {
    this.sparks.mat.uniforms.scale.value = h * 0.9;
    this.smoke.mat.uniforms.scale.value = h * 0.9;
  }
  // per kart, every frame
  kart(k, dt, theme) {
    const fx = Math.sin(k.yaw),
      fz = Math.cos(k.yaw);
    const lx = Math.cos(k.yaw),
      lz = -Math.sin(k.yaw);
    const sp = Math.abs(k.vf);
    const rear = (s) => [k.x + lx * s * 0.82 - fx * 0.9, k.y + 0.12, k.z + lz * s * 0.82 - fz * 0.9];
    if (k.drift && k.grounded) {
      const col = DRIFT_COLORS[k.driftLevel];
      const n = (k.driftLevel ? 3 : 1) * this.mul;
      for (let q = 0; q < n; q++)
        for (const s of [-1, 1]) {
          if (Math.random() > 0.7) continue;
          const [x, y, z] = rear(s);
          this.sparks.spawn(x, y, z, -fx * 3 + (Math.random() - 0.5) * 5 + lx * s * 2, 1.5 + Math.random() * 3, -fz * 3 + (Math.random() - 0.5) * 5 + lz * s * 2, 0.25 + Math.random() * 0.2, k.driftLevel ? 0.55 : 0.35, col[0], col[1], col[2], 14);
        }
    }
    if (k.grounded && sp > 6 && (k.offroad || k.drift) && Math.random() < (k.offroad ? 0.7 : 0.35) * this.mul) {
      const [x, y, z] = rear(Math.random() < 0.5 ? -1 : 1);
      const c = new THREE.Color(k.offroad ? theme.shoulder : '#9a9aa2');
      this.smoke.spawn(x, y + 0.2, z, -fx * 2 + (Math.random() - 0.5) * 2, 1 + Math.random(), -fz * 2 + (Math.random() - 0.5) * 2, 0.7, 0.9, c.r, c.g, c.b, -0.5, 2.2);
    }
    if (k.boostT > 0 && Math.random() < 0.8 * this.mul) {
      const blue = k.boostP > 1.29;
      for (const s of [-1, 1]) this.sparks.spawn(k.x + lx * s * 0.24 - fx * 1.9, k.y + 0.62, k.z + lz * s * 0.24 - fz * 1.9, -fx * 6 + k.vx * 0.6, 0.5, -fz * 6 + k.vz * 0.6, 0.18, 0.5, blue ? 0.4 : 1, blue ? 0.7 : 0.6, blue ? 1 : 0.2, 0);
    }
    if (k.spinT > 0 && Math.random() < 0.5) this.sparks.spawn(k.x + (Math.random() - 0.5), k.y + 2 + Math.random() * 0.4, k.z + (Math.random() - 0.5), (Math.random() - 0.5) * 3, 1, (Math.random() - 0.5) * 3, 0.5, 0.35, 1, 0.95, 0.4, 0);
  }
  burst(x, y, z, n, speed, colors, size = 0.5, life = 0.6, grav = 8) {
    n = Math.round(n * this.mul);
    for (let i = 0; i < n; i++) {
      const c = colors[i % colors.length];
      const a = Math.random() * Math.PI * 2,
        e = Math.random() * 1.2 - 0.2;
      const v = speed * (0.4 + Math.random() * 0.6);
      this.sparks.spawn(x, y, z, Math.cos(a) * Math.cos(e) * v, Math.sin(e) * v + 2, Math.sin(a) * Math.cos(e) * v, life * (0.6 + Math.random() * 0.6), size, c[0], c[1], c[2], grav);
    }
  }
  explosion(x, y, z) {
    this.burst(x, y + 0.5, z, 40, 14, [
      [1, 0.8, 0.3],
      [1, 0.4, 0.1],
      [1, 1, 0.8],
    ], 1.1, 0.6, 6);
    for (let i = 0; i < 14 * this.mul; i++) this.smoke.spawn(x + (Math.random() - 0.5) * 2, y + 0.6 + Math.random(), z + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 4, 2 + Math.random() * 2, (Math.random() - 0.5) * 4, 1.1, 1.6, 0.25, 0.22, 0.22, -0.5, 2.5);
  }
  boxBurst(x, y, z) {
    this.burst(x, y, z, 26, 9, [
      [1, 0.37, 0.72],
      [1, 0.82, 0.25],
      [0.25, 0.88, 1],
      [0.55, 0.36, 1],
    ], 0.45, 0.7, 10);
  }
  mini(k, level) {
    const c = DRIFT_COLORS[level];
    this.burst(k.x - Math.sin(k.yaw) * 1.4, k.y + 0.5, k.z - Math.cos(k.yaw) * 1.4, 18, 7, [c], 0.6, 0.4, 6);
  }
  ring(x, y, z, color, maxR = 40, life = 0.8) {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.set(x, y + 0.6, z);
    this.scene.add(m);
    this.rings.push({ m, t: 0, life, maxR });
  }
  update(dt) {
    this.sparks.update(dt);
    this.smoke.update(dt);
    for (const r of this.rings) {
      r.t += dt;
      const u = r.t / r.life;
      r.m.scale.setScalar(1 + u * r.maxR);
      r.m.material.opacity = 0.8 * (1 - u);
    }
    this.rings = this.rings.filter((r) => {
      if (r.t < r.life) return true;
      this.scene.remove(r.m);
      r.m.material.dispose();
      return false;
    });
  }
  clear() {
    this.sparks.clear();
    this.smoke.clear();
  }
}
