// Scene setup: renderer, camera, lights, terrain, water, sky, roads, clouds + quality presets.
import * as THREE from 'three';
import { fbm, smoothstep, mulberry32 } from '../core/rng.js';
import { WATER_Y } from '../core/config.js';
import * as MD from './models.js';
import { woodTexture, brickTexture, metalTexture } from './textures.js';
import { PiecesView, PropsView, CharsView, ItemsView, ChestsView, FxView, StormView, GhostView, swayMaterial } from './views.js';

export const QUALITY = {
  low: { ratio: 0.7, far: 460, fogNear: 140, shadows: false, clouds: 10, decor: 0, decorFar: 0 },
  medium: { ratio: 1.0, far: 640, fogNear: 200, shadows: false, clouds: 22, decor: 0.5, decorFar: 230 },
  high: { ratio: 1.5, far: 900, fogNear: 280, shadows: true, clouds: 30, decor: 1, decorFar: 320 },
};

// ground cover budget at decor = 1 (instances over the whole island)
const DECOR = { grass: 18000, flowerA: 2200, flowerB: 2200, pebbles: 2600 };
const DECOR_CHUNK = 200;


const HORIZON = new THREE.Color('#cfe7f6');

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) {
    return false;
  }
}

export class Renderer {
  constructor(canvas, quality, isMobile) {
    this.canvas = canvas;
    this.isMobile = isMobile;
    const q = quality === 'auto' ? (isMobile ? 'low' : 'medium') : quality;
    this.q = q;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: q === 'high' || (q === 'medium' && !isMobile), powerPreference: 'high-performance', stencil: false });
    this.contextLost = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      if (this.onContextLost) this.onContextLost();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      if (this.onContextRestored) this.onContextRestored();
    });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = HORIZON.clone();
    this.scene.fog = new THREE.Fog(HORIZON.clone(), 200, 640);
    this.camera = new THREE.PerspectiveCamera(80, 1, 0.1, 900);
    this.hemi = new THREE.HemisphereLight(0xe4f2ff, 0x8a9a66, 1.95);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 1.85);
    this.sun.position.set(-160, 260, 110);
    this.sunDir = this.sun.position.clone().normalize();
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    const sc = this.sun.shadow.camera;
    sc.left = -70;
    sc.right = 70;
    sc.top = 70;
    sc.bottom = -70;
    sc.near = 10;
    sc.far = 600;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.4;
    this.textures = [woodTexture(this.gl), brickTexture(this.gl), metalTexture(this.gl)];
    this.time = { value: 0 }; // shared by the wind sway and water shaders
    this.makeSky();
    this.world = null;
    this.resize();
    this.applyQuality(q);
  }

  applyQuality(q) {
    this.q = q;
    const Q = QUALITY[q];
    const dpr = window.devicePixelRatio || 1;
    let ratio = Math.min(dpr, Q.ratio);
    if (q === 'low') ratio = Math.min(dpr, 1) * Q.ratio;
    this.gl.setPixelRatio(ratio);
    this.camera.far = Q.far;
    this.camera.updateProjectionMatrix();
    if (this.sky) this.sky.scale.setScalar((Q.far * 0.92) / 1200);
    this.scene.fog.near = Q.fogNear;
    this.scene.fog.far = Q.far - 10;
    this.gl.shadowMap.enabled = Q.shadows;
    this.sun.castShadow = Q.shadows;
    if (this.views) {
      this.views.pieces.setShadows(Q.shadows);
      this.views.props.setShadows(Q.shadows);
      this.views.chars.setShadows(Q.shadows);
      if (this.terrain) this.terrain.receiveShadow = Q.shadows;
    }
    if (this.clouds) this.clouds.count = Math.min(this.cloudMax, Q.clouds);
    if (Q.decor > 0 && !this.decor && this.map && this.worldGroup) {
      this.decor = this.makeDecor(this.map);
      if (this.decor) this.worldGroup.add(this.decor.group);
    }
    if (this.decor) {
      this.decor.group.visible = Q.decor > 0;
      for (const c of this.decor.chunks) c.mesh.count = Math.floor(c.full * Q.decor);
    }
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  makeSky() {
    const g = new THREE.SphereGeometry(1200, 24, 12);
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color('#3d8fe0') },
        mid: { value: new THREE.Color('#8cc4ef') },
        bot: { value: HORIZON.clone() },
        sunDir: { value: this.sunDir.clone() },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bot; uniform vec3 sunDir; varying vec3 vP;
        void main(){ vec3 d = normalize(vP); float h = d.y;
        vec3 c = h > 0.18 ? mix(mid, top, smoothstep(0.18, 0.8, h)) : mix(bot, mid, smoothstep(0.0, 0.18, h));
        float s = max(dot(d, sunDir), 0.0);
        c += vec3(1.0, 0.92, 0.75) * (pow(s, 12.0) * 0.18 + pow(s, 90.0) * 0.35);
        c = mix(c, vec3(1.0, 0.98, 0.9), smoothstep(0.9975, 0.9988, s));
        gl_FragColor = vec4(c, 1.0); }`,
    });
    this.sky = new THREE.Mesh(g, m);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    // clouds
    const cg = MD.cloudGeometry(5);
    const cm = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: new THREE.Color('#9fb3c8') });
    this.cloudMax = 30;
    this.clouds = new THREE.InstancedMesh(cg, cm, this.cloudMax);
    const _m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < this.cloudMax; i++) {
      const a = (i / this.cloudMax) * Math.PI * 2 + i * 1.7;
      const r = 250 + ((i * 97) % 500);
      const s = 0.8 + ((i * 37) % 10) / 10;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * 2.1);
      _m.compose(new THREE.Vector3(Math.cos(a) * r, 190 + ((i * 53) % 90), Math.sin(a) * r), q, new THREE.Vector3(s, s, s));
      this.clouds.setMatrixAt(i, _m);
    }
    this.clouds.frustumCulled = false;
    this.scene.add(this.clouds);
  }

  // Build all world geometry for a generated map
  buildWorld(map, world, loot) {
    this.clearWorld();
    const group = new THREE.Group();
    this.worldGroup = group;
    this.scene.add(group);
    this.map = map;
    this.decor = null; // ground cover is built by applyQuality() when the preset wants it
    this.terrain = this.makeTerrain(map);
    group.add(this.terrain);
    group.add(this.makeRoads(map));
    group.add(this.makeWater());
    this.views = {
      pieces: new PiecesView(group, this.textures),
      props: new PropsView(group, world, this.time),
      chars: new CharsView(group, 72),
      items: new ItemsView(group),
      chests: new ChestsView(group, map, loot.chests, loot.boxes),
      fx: new FxView(group),
      storm: new StormView(group),
      ghost: new GhostView(group),
    };
    for (const p of world.pieces.byId.values()) this.views.pieces.add(p);
    this.views.pieces.flush();
    this.bus = new THREE.Mesh(MD.busModel(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.bus.visible = false;
    group.add(this.bus);
    this.applyQuality(this.q);
  }

  clearWorld() {
    if (!this.worldGroup) return;
    this.scene.remove(this.worldGroup);
    const mats = new Set();
    this.worldGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.isInstancedMesh) o.dispose();
      if (o.material) mats.add(o.material);
    });
    for (const m of mats) m.dispose(); // shared textures stay alive
    this.worldGroup = null;
    this.views = null;
    this.terrain = null;
    this.decor = null;
    this.map = null;
  }

  // Grass, flowers and pebbles in noise-driven patches (visual only, no collision), split into
  // chunks so off-screen and far-away patches are skipped.
  makeDecor(map) {
    const D = MD.decoModels();
    if (!D || !this.terrain) return null;
    const T = map.terrain;
    const tcol = this.terrain.geometry.attributes.color;
    const rnd = mulberry32((map.seed ^ 0x5eed) >>> 0);
    const seed = map.seed;
    const half = T.half;
    const nrm = [0, 1, 0];
    const roads = map.roads.map((r) => {
      const dx = r.x2 - r.x1;
      const dz = r.z2 - r.z1;
      return { ...r, dx, dz, l2: Math.max(1e-6, dx * dx + dz * dz) };
    });
    const nearRoad = (x, z) => {
      for (const r of roads) {
        const t = Math.max(0, Math.min(1, ((x - r.x1) * r.dx + (z - r.z1) * r.dz) / r.l2));
        const ex = r.x1 + r.dx * t - x;
        const ez = r.z1 + r.dz * t - z;
        if (ex * ex + ez * ez < 30) return true;
      }
      return false;
    };
    const blocked = (x, z) => {
      for (const f of map.footprints) if (x > f.x0 - 1.5 && x < f.x1 + 1.5 && z > f.z0 - 1.5 && z < f.z1 + 1.5) return true;
      return false;
    };
    const nChunk = Math.ceil((2 * half) / DECOR_CHUNK);
    const buckets = {};
    const push = (type, x, y, z, s, rot, r, g, b) => {
      const ci = Math.min(nChunk - 1, Math.floor((x + half) / DECOR_CHUNK));
      const cj = Math.min(nChunk - 1, Math.floor((z + half) / DECOR_CHUNK));
      const key = type + ':' + ci + ':' + cj;
      (buckets[key] = buckets[key] || { type, ci, cj, list: [] }).list.push(x, y, z, s, rot, r, g, b);
    };
    const tries = { grass: DECOR.grass * 3, flowerA: DECOR.flowerA * 6, flowerB: DECOR.flowerB * 6, pebbles: DECOR.pebbles * 3 };
    for (const type of Object.keys(DECOR)) {
      let placed = 0;
      for (let k = 0; k < tries[type] && placed < DECOR[type]; k++) {
        const x = (rnd() * 2 - 1) * half * 0.98;
        const z = (rnd() * 2 - 1) * half * 0.98;
        const r1 = rnd();
        const r2 = rnd();
        const h = T.heightAt(x, z);
        if (type === 'pebbles' ? h < 0.6 || h > 70 : h < 3.2 || h > 56) continue;
        const patch = fbm(x * 0.012, z * 0.012, seed + (type === 'grass' ? 77 : type === 'pebbles' ? 79 : 78), 2);
        if (type === 'grass' && patch < 0.42) continue;
        if ((type === 'flowerA' || type === 'flowerB') && patch < (type === 'flowerA' ? 0.6 : 0.62)) continue;
        if (type === 'pebbles' && patch < 0.5) continue;
        T.normalAt(x, z, nrm);
        if (nrm[1] < (type === 'pebbles' ? 0.7 : 0.84)) continue;
        if (blocked(x, z) || nearRoad(x, z)) continue;
        // tint grass with the terrain color under it so it blends into the ground
        let cr = 1;
        let cg = 1;
        let cb = 1;
        if (type === 'grass') {
          const i = Math.max(0, Math.min(T.n - 1, Math.round((x + half) / T.cell)));
          const j = Math.max(0, Math.min(T.n - 1, Math.round((z + half) / T.cell)));
          const vi = j * T.n + i;
          cr = tcol.getX(vi);
          cg = tcol.getY(vi);
          cb = tcol.getZ(vi);
        } else {
          cr = cg = cb = 0.88 + r2 * 0.24;
        }
        const s = type === 'grass' ? 0.8 + r1 * 0.7 : 0.75 + r1 * 0.5;
        push(type, x, h - 0.04, z, s, r2 * Math.PI * 2, cr, cg, cb);
        placed++;
      }
    }
    const group = new THREE.Group();
    const mats = {
      grass: swayMaterial(this.time, 0.0, 0.18), // blades are modelled double sided
      flowerA: swayMaterial(this.time, 0.05, 0.12),
      flowerB: swayMaterial(this.time, 0.05, 0.12),
      pebbles: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    };
    const chunks = [];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const c = new THREE.Color();
    // shuffle instance order so lowering the count thins patches evenly instead of emptying areas
    for (const b of Object.values(buckets)) {
      const n = b.list.length / 8;
      const order = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const mesh = new THREE.InstancedMesh(D[b.type], mats[b.type], n);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      order.forEach((src, i) => {
        const L = b.list;
        const o = src * 8;
        q.setFromAxisAngle(up, L[o + 4]);
        m4.compose(p.set(L[o], L[o + 1], L[o + 2]), q, sc.set(L[o + 3], L[o + 3], L[o + 3]));
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, c.setRGB(L[o + 5], L[o + 6], L[o + 7]));
      });
      mesh.computeBoundingSphere();
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      chunks.push({
        mesh,
        full: n,
        x: -half + (b.ci + 0.5) * DECOR_CHUNK,
        z: -half + (b.cj + 0.5) * DECOR_CHUNK,
      });
    }
    return { group, chunks };
  }

  makeTerrain(map) {
    const T = map.terrain;
    const n = T.n;
    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const seed = map.seed;
    const c = new THREE.Color();
    const sand = new THREE.Color('#ecd9a0');
    const wet = new THREE.Color('#d9c48a');
    const deep = new THREE.Color('#5aa6b8');
    const grassA = new THREE.Color('#77c24a');
    const grassB = new THREE.Color('#5fb13f');
    const grassC = new THREE.Color('#8ccf55');
    const dirt = new THREE.Color('#b59868');
    const rock = new THREE.Color('#9a9a94');
    const rockD = new THREE.Color('#84847f');
    const snow = new THREE.Color('#f4f7fb');
    const foam = new THREE.Color('#f7f3e6');
    const nrm = [0, 1, 0];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = T.vx(i);
        const z = T.vx(j);
        const h = T.h[k];
        pos[k * 3] = x;
        pos[k * 3 + 1] = h;
        pos[k * 3 + 2] = z;
        T.normalAt(x + 0.01, z + 0.01, nrm);
        const noise = fbm(x * 0.02, z * 0.02, seed + 50, 2);
        const noise2 = fbm(x * 0.05 + 7, z * 0.05, seed + 51, 2);
        if (h < -1.2) c.copy(wet).lerp(deep, smoothstep(-1.2, -10, h));
        else if (h < 0.35) c.copy(foam).lerp(wet, smoothstep(0.35, -1.2, h));
        else if (h < 2.6) c.copy(sand);
        else {
          c.copy(grassA).lerp(grassB, smoothstep(0.35, 0.65, noise));
          if (noise2 > 0.62) c.lerp(grassC, 0.5);
          if (noise > 0.7 && h < 40) c.lerp(dirt, smoothstep(0.7, 0.8, noise) * 0.6);
          if (h < 3.4) c.lerp(sand, smoothstep(3.4, 2.6, h));
          if (h > 48) c.lerp(rockD, smoothstep(48, 70, h) * 0.55);
          const steep = smoothstep(0.82, 0.62, nrm[1]);
          if (steep > 0) c.lerp(noise2 > 0.5 ? rock : rockD, steep);
          if (h > 74) c.lerp(snow, smoothstep(74, 82, h + noise * 6) * (1 - steep * 0.6));
        }
        col[k * 3] = c.r;
        col[k * 3 + 1] = c.g;
        col[k * 3 + 2] = c.b;
      }
    }
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let q = 0;
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        const b = a + 1;
        const cc = a + n;
        const d = cc + 1;
        idx[q++] = a;
        idx[q++] = cc;
        idx[q++] = b;
        idx[q++] = b;
        idx[q++] = cc;
        idx[q++] = d;
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    return mesh;
  }

  makeRoads(map) {
    const T = map.terrain;
    const pos = [];
    const colA = [];
    const c1 = new THREE.Color('#8f8a80');
    const c2 = new THREE.Color('#f2eee0');
    const W = 3.4;
    const push = (x, z, h, cc) => {
      pos.push(x, h, z);
      colA.push(cc.r, cc.g, cc.b);
    };
    for (const r of map.roads) {
      const dx = r.x2 - r.x1;
      const dz = r.z2 - r.z1;
      const len = Math.sqrt(dx * dx + dz * dz);
      const ux = dx / len;
      const uz = dz / len;
      const nx = -uz;
      const nz = ux;
      const steps = Math.ceil(len / 3);
      for (let s = 0; s < steps; s++) {
        const t0 = (s / steps) * len;
        const t1 = ((s + 1) / steps) * len;
        const pts = [];
        for (const t of [t0, t1])
          for (const side of [-1, 1]) {
            const x = r.x1 + ux * t + nx * W * side;
            const z = r.z1 + uz * t + nz * W * side;
            pts.push([x, z, T.heightAt(x, z) + 0.12]);
          }
        const hA = Math.max(pts[0][2], pts[1][2]) ;
        void hA;
        const [a, b, cc, d] = pts;
        if (a[2] < 0.4 && b[2] < 0.4) continue;
        push(a[0], a[1], a[2], c1);
        push(cc[0], cc[1], cc[2], c1);
        push(b[0], b[1], b[2], c1);
        push(b[0], b[1], b[2], c1);
        push(cc[0], cc[1], cc[2], c1);
        push(d[0], d[1], d[2], c1);
        // dashed center line
        if (s % 3 === 0) {
          const mx = r.x1 + ux * (t0 + 0.2);
          const mz = r.z1 + uz * (t0 + 0.2);
          const ex = r.x1 + ux * (t1 - 0.2);
          const ez = r.z1 + uz * (t1 - 0.2);
          const w = 0.18;
          const q = [
            [mx + nx * w, mz + nz * w],
            [mx - nx * w, mz - nz * w],
            [ex + nx * w, ez + nz * w],
            [ex - nx * w, ez - nz * w],
          ].map(([x, z]) => [x, z, T.heightAt(x, z) + 0.17]);
          push(q[0][0], q[0][1], q[0][2], c2);
          push(q[2][0], q[2][1], q[2][2], c2);
          push(q[1][0], q[1][1], q[1][2], c2);
          push(q[1][0], q[1][1], q[1][2], c2);
          push(q[2][0], q[2][1], q[2][2], c2);
          push(q[3][0], q[3][1], q[3][2], c2);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colA, 3));
    g.computeVertexNormals();
    const m = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    return mesh;
  }

  makeWater() {
    const g = new THREE.PlaneGeometry(4000, 4000, 1, 1);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshLambertMaterial({ color: '#2ea6de', transparent: true, opacity: 0.8, depthWrite: false });
    // gentle moving ripples + sparkles (world-space, so the 1-quad plane needs no extra vertices)
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.time;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vWXZ;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vWXZ;\nuniform float uTime;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            vec2 p = vWXZ;
            float w = sin(p.x * 0.085 + uTime * 0.7) * sin(p.y * 0.105 - uTime * 0.55)
              + 0.55 * sin((p.x + p.y) * 0.21 + uTime * 1.25) + 0.3 * sin((p.x - p.y) * 0.37 - uTime * 1.7);
            float near = 1.0 - smoothstep(60.0, 260.0, length(vViewPosition)); // avoid shimmer noise far away
            diffuseColor.rgb *= 1.0 + 0.06 * w * (0.4 + 0.6 * near);
            diffuseColor.rgb += vec3(0.16, 0.18, 0.18) * smoothstep(1.35, 1.65, w) * near;
          }`,
        );
    };
    m.customProgramCacheKey = () => 'water';
    const mesh = new THREE.Mesh(g, m);
    mesh.position.y = WATER_Y;
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    return mesh;
  }

  // Follow the camera with sky and shadow frustum
  frame(dt, t) {
    this.time.value = (this.time.value + Math.min(dt || 0, 0.1)) % 3600;
    this.sky.position.copy(this.camera.position);
    if (this.decor && this.decor.group.visible) {
      const far = QUALITY[this.q].decorFar + DECOR_CHUNK * 0.71;
      const cp = this.camera.position;
      for (const c of this.decor.chunks) {
        const dx = c.x - cp.x;
        const dz = c.z - cp.z;
        c.mesh.visible = dx * dx + dz * dz < far * far;
      }
    }
    if (this.sun.castShadow) {
      const p = this.camera.position;
      this.sun.target.position.set(p.x, 0, p.z);
      this.sun.position.set(p.x + this.sunDir.x * 300, this.sunDir.y * 300, p.z + this.sunDir.z * 300);
    }
    if (this.views) {
      this.views.props.update(dt);
      this.views.chests.update(t);
    }
    if (!this.contextLost) this.gl.render(this.scene, this.camera);
  }
}
