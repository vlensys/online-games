// Scene setup: renderer, camera, lights, terrain, water, sky, roads, clouds + quality presets.
import * as THREE from 'three';
import { fbm, smoothstep } from '../core/rng.js';
import { WATER_Y } from '../core/config.js';
import * as MD from './models.js';
import { woodTexture, brickTexture, metalTexture } from './textures.js';
import { PiecesView, PropsView, CharsView, ItemsView, ChestsView, FxView, StormView, GhostView } from './views.js';

export const QUALITY = {
  low: { ratio: 0.7, far: 460, fogNear: 140, shadows: false, clouds: 10 },
  medium: { ratio: 1.0, far: 640, fogNear: 200, shadows: false, clouds: 22 },
  high: { ratio: 1.5, far: 900, fogNear: 280, shadows: true, clouds: 30 },
};

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
      uniforms: { top: { value: new THREE.Color('#3d8fe0') }, mid: { value: new THREE.Color('#8cc4ef') }, bot: { value: HORIZON.clone() } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bot; varying vec3 vP;
        void main(){ float h = vP.y; vec3 c = h > 0.18 ? mix(mid, top, smoothstep(0.18, 0.8, h)) : mix(bot, mid, smoothstep(0.0, 0.18, h));
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
    this.terrain = this.makeTerrain(map);
    group.add(this.terrain);
    group.add(this.makeRoads(map));
    group.add(this.makeWater());
    this.views = {
      pieces: new PiecesView(group, this.textures),
      props: new PropsView(group, world),
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
    this.worldGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.isInstancedMesh) o.dispose();
    });
    this.worldGroup = null;
    this.views = null;
    this.terrain = null;
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
    const mesh = new THREE.Mesh(g, m);
    mesh.position.y = WATER_Y;
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    return mesh;
  }

  // Follow the camera with sky and shadow frustum
  frame(dt, t) {
    this.sky.position.copy(this.camera.position);
    if (this.sun.castShadow) {
      const p = this.camera.position;
      this.sun.target.position.set(p.x, 0, p.z);
      this.sun.position.set(p.x + this.sunDir.x * 300, this.sunDir.y * 300, p.z + this.sunDir.z * 300);
    }
    if (this.views) {
      this.views.props.update(dt);
      this.views.chests.update(t);
    }
    this.gl.render(this.scene, this.camera);
  }
}
