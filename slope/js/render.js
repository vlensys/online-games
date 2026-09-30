import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Instanced pools: every tile / hazard / gem shares one draw call per type.
// ---------------------------------------------------------------------------
const _mat = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

export class InstancedPool {
  constructor(geometry, material, capacity) {
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    this.mesh.frustumCulled = false;
    this.capacity = capacity;
    this.free = [];
    for (let i = capacity - 1; i >= 0; i--) {
      this.free.push(i);
      this.mesh.setMatrixAt(i, _zero);
    }
    this.mesh.count = capacity;
    this.dirty = true;
  }
  add(pos, quat, scale, color) {
    const slot = this.free.pop();
    if (slot === undefined) return -1;
    this.set(slot, pos, quat, scale);
    if (color) this.mesh.setColorAt(slot, color);
    else this.mesh.setColorAt(slot, _white);
    this.mesh.instanceColor.needsUpdate = true;
    return slot;
  }
  set(slot, pos, quat, scale) {
    if (slot < 0) return;
    _mat.compose(pos, quat, scale);
    this.mesh.setMatrixAt(slot, _mat);
    this.dirty = true;
  }
  setColor(slot, color) {
    if (slot < 0) return;
    this.mesh.setColorAt(slot, color);
    this.mesh.instanceColor.needsUpdate = true;
  }
  remove(slot) {
    if (slot < 0) return;
    this.mesh.setMatrixAt(slot, _zero);
    this.free.push(slot);
    this.dirty = true;
  }
  clear() {
    this.free.length = 0;
    for (let i = this.capacity - 1; i >= 0; i--) {
      this.free.push(i);
      this.mesh.setMatrixAt(i, _zero);
    }
    this.dirty = true;
  }
  flush() {
    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.dirty = false;
    }
  }
}
const _white = new THREE.Color(1, 1, 1);

// ---------------------------------------------------------------------------
// Neon tile shader: dark glassy fill, glowing edges + grid, travelling energy pulse, fog.
// ---------------------------------------------------------------------------
const tileVert = /* glsl */ `
varying vec3 vLocal;
varying vec3 vHalf;
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vTint;
void main() {
  mat4 im = mat4(1.0);
  #ifdef USE_INSTANCING
    im = instanceMatrix;
  #endif
  vec3 sc = vec3(length(im[0].xyz), length(im[1].xyz), length(im[2].xyz));
  vLocal = position * sc;
  vHalf = sc * 0.5;
  vN = normal;
  vTint = vec3(1.0);
  #ifdef USE_INSTANCING_COLOR
    vTint = instanceColor;
  #endif
  vec4 wp = modelMatrix * im * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const commonFrag = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uFill;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uTime;
varying vec3 vLocal;
varying vec3 vHalf;
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vTint;

float gridLine(vec2 uv, float cell, float w) {
  vec2 c = uv / cell;
  vec2 f = abs(fract(c - 0.5) - 0.5);
  vec2 fw = max(fwidth(c), vec2(1e-4));
  vec2 l = 1.0 - smoothstep(vec2(w) - fw, vec2(w) + fw, f);
  // fade grid where it would alias
  float fade = 1.0 - smoothstep(0.15, 0.45, max(fw.x, fw.y));
  return max(l.x, l.y) * fade;
}

void faceCoords(out vec2 uv, out vec2 hh, out float face) {
  vec3 an = abs(vN);
  if (an.y > 0.5) { uv = vLocal.xz; hh = vHalf.xz; face = vN.y > 0.0 ? 1.0 : 0.0; }
  else if (an.x > 0.5) { uv = vLocal.zy; hh = vHalf.zy; face = 0.5; }
  else { uv = vLocal.xy; hh = vHalf.xy; face = 0.5; }
}

vec3 applyFog(vec3 col) {
  float d = distance(vWorld, cameraPosition);
  float f = smoothstep(uFogNear, uFogFar, d);
  return mix(col, uFogColor, f);
}
`;

const tileFrag = /* glsl */ `
${commonFrag}
uniform float uCell;
uniform float uLine;
uniform float uAllFaces;
void main() {
  vec2 uv; vec2 hh; float face;
  faceCoords(uv, hh, face);
  vec2 ed = hh - abs(uv);
  float e = min(ed.x, ed.y);
  float fe = max(fwidth(e), 1e-4);
  float edge = 1.0 - smoothstep(uLine * 1.6, uLine * 1.6 + fe * 1.5, e);
  float top = step(0.9, face);
  float grid = gridLine(uv, uCell, uLine / uCell) * max(top, uAllFaces);
  vec3 line = uColor * vTint;
  vec3 col = uFill;
  col = mix(col, line * 0.85, grid);
  col = mix(col, line, edge);
  gl_FragColor = vec4(applyFog(col), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const hazardFrag = /* glsl */ `
${commonFrag}
void main() {
  vec2 uv; vec2 hh; float face;
  faceCoords(uv, hh, face);
  vec2 ed = hh - abs(uv);
  float e = min(ed.x, ed.y);
  float fe = max(fwidth(e), 1e-4);
  float edge = 1.0 - smoothstep(0.12, 0.12 + fe * 1.5, e);
  float grid = gridLine(uv, 1.0, 0.05);
  vec3 base = uColor * vTint;
  vec3 col = base * 0.28;
  col = mix(col, base * 0.8, grid);
  col = mix(col, base, edge);
  gl_FragColor = vec4(applyFog(col), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function neonMaterial(frag, color, fill, fog, extra = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uFill: { value: new THREE.Color(fill) },
      uFogColor: { value: fog },
      uFogNear: { value: 150 },
      uFogFar: { value: 430 },
      uTime: { value: 0 },
      uCell: { value: extra.cell ?? 2.5 },
      uLine: { value: extra.line ?? 0.09 },
      uAllFaces: { value: extra.allFaces ? 1 : 0 },
    },
    vertexShader: tileVert,
    fragmentShader: frag,
  });
}

export function createTileMaterial(fog) {
  return neonMaterial(tileFrag, '#1eff3c', '#000000', fog, { cell: 2.5, line: 0.1 });
}
// the skyline: same look, cube grid on every face
export function createTowerMaterial(fog, tileMat) {
  const m = neonMaterial(tileFrag, '#1eff3c', '#000000', fog, { cell: 4, line: 0.12, allFaces: true });
  m.uniforms.uColor = tileMat.uniforms.uColor; // share the theme colour
  return m;
}
export function createHazardMaterial(fog) {
  return neonMaterial(hazardFrag, '#ff1a1a', '#000000', fog);
}

// Speed pad: chevrons on the tunnel floor
export function createPadMaterial() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 128, 256);
  g.strokeStyle = '#fff';
  g.lineWidth = 14;
  for (let i = 0; i < 3; i++) {
    const y = 40 + i * 70;
    g.beginPath();
    g.moveTo(14, y + 40);
    g.lineTo(64, y);
    g.lineTo(114, y + 40);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  return new THREE.MeshBasicMaterial({ map: tex, color: '#ffe03a', polygonOffset: true, polygonOffsetFactor: -2 });
}

// ---------------------------------------------------------------------------
// Background: gradient sky dome, stars, drifting wireframe shapes, speed streaks.
// ---------------------------------------------------------------------------
export class Background {
  constructor() {}
  setTheme() {}
  shift() {}
  update() {}
}

let _dot;
export function dotTexture() {
  if (_dot) return _dot;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(0.3, 'rgba(255,255,255,0.8)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, 64, 64);
  _dot = new THREE.CanvasTexture(c);
  return _dot;
}

// ---------------------------------------------------------------------------
// Trail: a flat ribbon on the track behind the ball, like the original
// ---------------------------------------------------------------------------
export class Trail {
  constructor(scene, n = 40) {
    this.n = n;
    this.points = [];
    this.pos = new Float32Array(n * 2 * 3);
    this.alpha = new Float32Array(n * 2);
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color('#1eff3c') } },
      vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor, vA);
        #include <colorspace_fragment>
      }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  reset() {
    this.points.length = 0;
    this.alpha.fill(0);
    this.mesh.geometry.attributes.alpha.needsUpdate = true;
  }
  shift(o) {
    for (const p of this.points) {
      p.p.add(o);
    }
  }
  // p: contact point under the ball, n: ground normal, on: touching the ground
  update(p, n, on, width = 0.28) {
    const last = this.points[0];
    if (!last || last.p.distanceToSquared(p) > 0.25) {
      this.points.unshift({ p: p.clone(), n: n.clone(), on });
      if (this.points.length > this.n) this.points.pop();
    } else {
      last.p.copy(p);
      last.on = on;
    }
    const pts = this.points;
    const side = new THREE.Vector3();
    const dir = new THREE.Vector3();
    for (let i = 0; i < this.n; i++) {
      const o = i * 6;
      if (i >= pts.length) {
        this.alpha[i * 2] = this.alpha[i * 2 + 1] = 0;
        continue;
      }
      const a = pts[Math.max(i - 1, 0)].p,
        b = pts[Math.min(i + 1, pts.length - 1)].p;
      dir.subVectors(a, b);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      side.crossVectors(dir, pts[i].n).normalize();
      const q = pts[i].p;
      this.pos[o] = q.x + side.x * width;
      this.pos[o + 1] = q.y + side.y * width;
      this.pos[o + 2] = q.z + side.z * width;
      this.pos[o + 3] = q.x - side.x * width;
      this.pos[o + 4] = q.y - side.y * width;
      this.pos[o + 5] = q.z - side.z * width;
      const t = i / (this.n - 1);
      const al = pts[i].on ? 1 - t : 0;
      this.alpha[i * 2] = this.alpha[i * 2 + 1] = al;
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.alpha.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Small point particles (gem pickups, crash debris)
// ---------------------------------------------------------------------------
export class Particles {
  constructor(scene, max = 700) {
    this.max = max;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.c = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.alive = 0;
    this.cursor = 0;
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.p, 3);
    this.aCol = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    this.aSize = new THREE.BufferAttribute(new Float32Array(max), 1);
    g.setAttribute('position', this.aPos);
    g.setAttribute('color', this.aCol);
    g.setAttribute('size', this.aSize);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: dotTexture() }, uScale: { value: 400 } },
      vertexShader: `attribute float size; attribute vec3 color; varying vec3 vC;
        uniform float uScale;
        void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D uMap; varying vec3 vC; void main(){ vec4 t = texture2D(uMap, gl_PointCoord); gl_FragColor = vec4(vC * t.a, 1.0);
        #include <colorspace_fragment>
      }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  emit(pos, vel, color, { life = 0.8, size = 0.5, drag = 1.5, gravity = -10 } = {}) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.p[i * 3] = pos.x;
    this.p[i * 3 + 1] = pos.y;
    this.p[i * 3 + 2] = pos.z;
    this.v[i * 3] = vel.x;
    this.v[i * 3 + 1] = vel.y;
    this.v[i * 3 + 2] = vel.z;
    this.c[i * 3] = color.r;
    this.c[i * 3 + 1] = color.g;
    this.c[i * 3 + 2] = color.b;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.drag[i] = drag;
    this.grav[i] = gravity;
  }
  burst(pos, color, n, speed, opts = {}) {
    const v = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.3 + Math.random() * 0.7));
      if (opts.up) v.y = Math.abs(v.y) + opts.up;
      if (opts.base) v.add(opts.base);
      this.emit(pos, v, color, { ...opts, life: (opts.life || 0.8) * (0.6 + Math.random() * 0.6) });
    }
  }
  shift(o) {
    for (let i = 0; i < this.max; i++) {
      this.p[i * 3] += o.x;
      this.p[i * 3 + 1] += o.y;
      this.p[i * 3 + 2] += o.z;
    }
  }
  clear() {
    this.life.fill(0);
  }
  update(dt) {
    const col = this.aCol.array,
      sz = this.aSize.array;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        sz[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = Math.exp(-this.drag[i] * dt);
      this.v[i * 3] *= k;
      this.v[i * 3 + 1] = this.v[i * 3 + 1] * k + this.grav[i] * dt;
      this.v[i * 3 + 2] *= k;
      this.p[i * 3] += this.v[i * 3] * dt;
      this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt;
      this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      const t = Math.max(this.life[i] / this.maxLife[i], 0);
      col[i * 3] = this.c[i * 3] * t;
      col[i * 3 + 1] = this.c[i * 3 + 1] * t;
      col[i * 3 + 2] = this.c[i * 3 + 2] * t;
      sz[i] = this.size[i] * (0.4 + 0.6 * t);
    }
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aSize.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Ball shatter effect
// ---------------------------------------------------------------------------
export class Shards {
  constructor(scene, n = 42) {
    this.n = n;
    this.mat = new THREE.MeshStandardMaterial({ color: '#b8bcc4', metalness: 0.3, roughness: 0.5 });
    this.mesh = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(0.34, 0), this.mat, n);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.items = [];
    for (let i = 0; i < n; i++) this.items.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), s: 1 });
    scene.add(this.mesh);
    this.t = 0;
  }
  explode(pos, vel) {
    this.mesh.visible = true;
    this.t = 0;
    for (const it of this.items) {
      it.p.copy(pos).add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.4));
      it.v
        .set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5)
        .normalize()
        .multiplyScalar(6 + Math.random() * 14)
        .addScaledVector(vel, 0.35);
      it.q.random();
      it.w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(14);
      it.s = 0.6 + Math.random() * 1.2;
    }
  }
  hide() {
    this.mesh.visible = false;
  }
  shift(o) {
    for (const it of this.items) it.p.add(o);
  }
  update(dt) {
    if (!this.mesh.visible) return;
    this.t += dt;
    const e = new THREE.Euler();
    const dq = new THREE.Quaternion();
    for (let i = 0; i < this.n; i++) {
      const it = this.items[i];
      it.v.y -= 22 * dt;
      it.v.multiplyScalar(Math.exp(-0.6 * dt));
      it.p.addScaledVector(it.v, dt);
      e.set(it.w.x * dt, it.w.y * dt, it.w.z * dt);
      it.q.multiply(dq.setFromEuler(e));
      const s = it.s * Math.max(0, 1 - this.t / 2.5);
      _mat.compose(it.p, it.q, _scale.set(s, s, s));
      this.mesh.setMatrixAt(i, _mat);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Landing marker: a glowing ring projected on the surface below the airborne ball
// ---------------------------------------------------------------------------
export class LandingMarker {
  constructor(scene) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const rg = g.createRadialGradient(64, 64, 0, 64, 64, 62);
    rg.addColorStop(0, 'rgba(0,0,0,0.75)');
    rg.addColorStop(0.55, 'rgba(0,0,0,0.45)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    this.mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), this.mat);
    this.mesh.visible = false;
    scene.add(this.mesh);
    this._up = new THREE.Vector3(0, 0, 1);
  }
  place(p, n, height) {
    this.mesh.visible = true;
    this.mesh.position.copy(p).addScaledVector(n, 0.05);
    this.mesh.quaternion.setFromUnitVectors(this._up, n);
    this.mesh.scale.setScalar(THREE.MathUtils.clamp(1 - height * 0.03, 0.55, 1));
    this.mat.opacity = THREE.MathUtils.clamp(1 - height * 0.05, 0.25, 1);
  }
  hide() {
    this.mesh.visible = false;
  }
}

// ---------------------------------------------------------------------------
// In-world text signs (tutorial hints)
// ---------------------------------------------------------------------------
export function makeSign(text, sub, color) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 192;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,0.55)';
  roundRect(g, 8, 8, 496, 176, 24);
  g.fill();
  g.strokeStyle = color;
  g.lineWidth = 6;
  roundRect(g, 8, 8, 496, 176, 24);
  g.stroke();
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 76px system-ui, Segoe UI, Arial, sans-serif';
  g.fillText(text, 256, sub ? 78 : 96);
  if (sub) {
    g.font = '600 36px system-ui, Segoe UI, Arial, sans-serif';
    g.fillStyle = color;
    g.fillText(sub, 256, 146);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  s.scale.set(8, 3, 1);
  return s;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
