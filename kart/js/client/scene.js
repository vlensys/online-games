// Builds the 3D world for a track: sky, light, terrain, the road with curbs and barriers, ramps,
// the start gantry, scenery for the theme, item boxes and boost pads.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { THEMES } from './themes.js';
import * as TX from './textures.js';
import { gridSlot, trackPoint } from '../core/trackgeo.js';

const BARRIER_H = { tires: 1.0, wood: 1.1, snow: 1.3, stone: 1.4, neon: 1.5, rope: 0.9, rail: 0.9 };

// ------------------------------------------------------------------ noise
function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y) {
  const xi = Math.floor(x),
    yi = Math.floor(y);
  const xf = x - xi,
    yf = y - yi;
  const u = xf * xf * (3 - 2 * xf),
    v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi),
    b = hash(xi + 1, yi),
    c = hash(xi, yi + 1),
    d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y) {
  return vnoise(x, y) * 0.6 + vnoise(x * 2.1 + 5, y * 2.1 + 3) * 0.28 + vnoise(x * 4.3 + 9, y * 4.3 + 1) * 0.12;
}

// nearest track sample to (x, z): coarse pass then refine
function makeNearest(T) {
  const step = 4;
  return (x, z) => {
    let best = 0,
      bd = Infinity;
    for (let i = 0; i < T.n; i += step) {
      const dx = x - T.px[i],
        dz = z - T.pz[i];
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    for (let k = -step; k <= step; k++) {
      const i = (best + k + T.n) % T.n;
      const dx = x - T.px[i],
        dz = z - T.pz[i];
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return { i: best, dist: Math.sqrt(bd) };
  };
}

// ------------------------------------------------------------------ ribbons along the track
// a strip from lateral offset a(i) to b(i), at height y(i) (+ per side), u across 0..uw, v = s / vs
function ribbon(T, a, b, ya, yb, vs, uw = 1) {
  const n = T.n;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const uv = new Float32Array((n + 1) * 2 * 2);
  for (let k = 0; k <= n; k++) {
    const i = k % n;
    const A = a(i),
      B = b(i);
    pos.set([T.px[i] + T.rx[i] * A, ya(i), T.pz[i] + T.rz[i] * A, T.px[i] + T.rx[i] * B, yb(i), T.pz[i] + T.rz[i] * B], k * 6);
    const v = (k * T.sp) / vs;
    uv.set([0, v, uw, v], k * 4);
  }
  const idx = [];
  for (let k = 0; k < n; k++) {
    const p = k * 2;
    idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function lambert(color, o = {}) {
  return new THREE.MeshLambertMaterial({ color, ...o });
}

// ------------------------------------------------------------------ the world
export function buildWorld(scene, T, quality) {
  const th = THEMES[T.def.theme] || THEMES.meadow;
  const root = new THREE.Group();
  scene.add(root);
  const anim = [];
  const disposables = [];
  const keep = (o) => {
    root.add(o);
    return o;
  };
  const hi = quality !== 'low';

  // sky dome, fog, light
  const fogCol = new THREE.Color(th.fog);
  scene.fog = new THREE.Fog(fogCol, th.fogNear, th.fogFar * (hi ? 1 : 0.8));
  scene.background = fogCol;
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: new THREE.Color(th.sky[0]) }, bot: { value: new THREE.Color(th.sky[1]) }, fogc: { value: fogCol } },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader:
      'uniform vec3 top; uniform vec3 bot; uniform vec3 fogc; varying vec3 vP; void main(){ float h = normalize(vP).y; vec3 c = mix(bot, top, smoothstep(0.0, 0.55, h)); c = mix(c, fogc, smoothstep(0.12, -0.05, h)); gl_FragColor = vec4(c,1.0); }',
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1800, 32, 16), skyMat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  keep(sky);
  anim.push((t, cam) => sky.position.copy(cam.position));
  if (th.night) {
    const n = 900,
      p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2,
        e = Math.random() * 1.3 + 0.08;
      p.set([Math.cos(a) * Math.cos(e) * 1500, Math.sin(e) * 1500, Math.sin(a) * Math.cos(e) * 1500], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85 }));
    stars.frustumCulled = false;
    keep(stars);
    anim.push((t, cam) => stars.position.copy(cam.position));
  }
  const hemi = new THREE.HemisphereLight(th.hemi[0], th.hemi[1], th.hemi[2]);
  keep(hemi);
  const sun = new THREE.DirectionalLight(th.sun, th.sunI);
  const sunDir = new THREE.Vector3(0.45, 0.8, 0.35).normalize();
  sun.position.copy(sunDir).multiplyScalar(80);
  if (quality === 'high' || quality === 'medium') {
    sun.castShadow = true;
    const s = quality === 'high' ? 2048 : 1024;
    sun.shadow.mapSize.set(s, s);
    const c = sun.shadow.camera;
    c.left = c.bottom = -55;
    c.right = c.top = 55;
    c.near = 1;
    c.far = 220;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
  }
  keep(sun);
  keep(sun.target);
  anim.push((t, cam, focus) => {
    if (!focus) return;
    sun.target.position.set(focus.x, focus.y, focus.z);
    sun.position.set(focus.x + sunDir.x * 90, focus.y + sunDir.y * 90, focus.z + sunDir.z * 90);
  });
  if (!th.night) {
    const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: TX.softDot(), color: 0xfff6dd, fog: false, depthWrite: false, transparent: true }));
    sunSprite.scale.set(260, 260, 1);
    keep(sunSprite);
    anim.push((t, cam) => sunSprite.position.copy(cam.position).addScaledVector(sunDir, 1400));
  }

  // ---------------------------------------------------------------- road
  const py = (i) => T.py[i];
  const road = new THREE.Mesh(
    ribbon(T, (i) => -T.hw[i], (i) => T.hw[i], py, py, 14),
    new THREE.MeshLambertMaterial({ map: th.night ? TX.neonRoad(th.road) : TX.asphalt(th.road) }),
  );
  road.receiveShadow = true;
  keep(road);
  const curbTex = TX.curb(th.curb[0], th.curb[1]);
  const curbMat = new THREE.MeshLambertMaterial({ map: curbTex, emissive: th.night ? new THREE.Color(th.curb[0]).multiplyScalar(0.25) : 0x000000 });
  for (const s of [-1, 1]) {
    const c = new THREE.Mesh(
      ribbon(T, (i) => s * (T.hw[i] - 0.15), (i) => s * (T.hw[i] + 0.9), (i) => T.py[i] + 0.04, (i) => T.py[i] + 0.04, 4),
      curbMat,
    );
    if (s < 0) c.material = curbMat.clone();
    c.material.side = THREE.DoubleSide;
    c.receiveShadow = true;
    keep(c);
  }
  // shoulders (rough ground between the road and the barrier) and a skirt down to the terrain
  const shoulderTex = th.ground ? TX.ground(th.shoulder, th.ground[1], 3) : TX.ground(th.shoulder, '#4a3a8a', 3);
  shoulderTex.repeat.set(1, 1);
  const shMat = new THREE.MeshLambertMaterial({ map: shoulderTex, side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(
      ribbon(T, (i) => s * (T.hw[i] + 0.8), (i) => s * T.lim[i], (i) => T.py[i] - 0.03, (i) => T.py[i] - 0.03, 10, 0.6),
      shMat,
    );
    m.receiveShadow = true;
    keep(m);
    if (th.ground) {
      keep(new THREE.Mesh(ribbon(T, (i) => s * T.lim[i], (i) => s * (T.lim[i] + 12), (i) => T.py[i] - 0.03, (i) => T.py[i] - 3.5, 10, 0.6), shMat));
    } else {
      // floating track: a slab edge under it
      keep(
        new THREE.Mesh(
          ribbon(T, (i) => s * T.lim[i], (i) => s * T.lim[i], (i) => T.py[i] - 0.03, (i) => T.py[i] - 2.2, 10),
          new THREE.MeshLambertMaterial({ color: 0x3a2a6a, emissive: 0x1a0a3a, side: THREE.DoubleSide }),
        ),
      );
    }
  }
  if (!th.ground) {
    keep(new THREE.Mesh(ribbon(T, (i) => T.lim[i], (i) => -T.lim[i], (i) => T.py[i] - 2.2, (i) => T.py[i] - 2.2, 10), new THREE.MeshLambertMaterial({ color: 0x241848, side: THREE.DoubleSide })));
  }
  // barriers
  const bh = BARRIER_H[th.barrier] || 1;
  const bTex = TX.barrierTex(th.barrier, th);
  const glow = th.barrier === 'neon' || th.barrier === 'rail';
  const bMat = new THREE.MeshLambertMaterial({ map: bTex, side: THREE.DoubleSide, emissive: glow ? 0xffffff : 0x000000, emissiveMap: glow ? bTex : null, emissiveIntensity: glow ? 0.8 : 0 });
  for (const s of [-1, 1]) {
    const g = ribbon(T, (i) => s * T.lim[i], (i) => s * T.lim[i], (i) => T.py[i] - 0.05, (i) => T.py[i] + bh, 4);
    // u runs along the wall here: swap so the texture repeats along it
    const uv = g.attributes.uv.array;
    for (let k = 0; k < uv.length; k += 4) {
      const v = uv[k + 1];
      uv[k] = v;
      uv[k + 1] = 0;
      uv[k + 2] = v;
      uv[k + 3] = 1;
    }
    const m = new THREE.Mesh(g, bMat);
    m.castShadow = hi;
    m.receiveShadow = true;
    keep(m);
    // a cap along the top
    keep(new THREE.Mesh(ribbon(T, (i) => s * T.lim[i], (i) => s * (T.lim[i] + 0.5), (i) => T.py[i] + bh, (i) => T.py[i] + bh, 4), new THREE.MeshLambertMaterial({ color: glow ? th.curb[0] : '#2a2a30', emissive: glow ? th.curb[0] : '#000000', side: THREE.DoubleSide })));
  }
  // jump ramps: striped surface and solid sides
  const rampMat = new THREE.MeshLambertMaterial({ map: TX.stripes('#ffd23f', '#1a1a1a'), side: THREE.DoubleSide });
  const sideMat = lambert('#3a3a40', { side: THREE.DoubleSide });
  for (const j of T.jumps) {
    const m = (j.i1 - j.i0 + T.n) % T.n;
    const posA = [],
      idxA = [],
      uvA = [];
    const sideP = [];
    for (let k = 0; k <= m; k++) {
      const i = (j.i0 + k) % T.n;
      const y = T.py[i] + 0.06,
        base = T.py[i] - (j.h * k) / m;
      for (const s of [-1, 1]) posA.push(T.px[i] + T.rx[i] * s * T.hw[i], y, T.pz[i] + T.rz[i] * s * T.hw[i]);
      uvA.push(0, k * 0.5, 4, k * 0.5);
      if (k < m) {
        const p = k * 2;
        idxA.push(p, p + 2, p + 1, p + 1, p + 2, p + 3);
      }
      sideP.push({ i, y, base });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(posA, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvA, 2));
    g.setIndex(idxA);
    g.computeVertexNormals();
    keep(new THREE.Mesh(g, rampMat));
    // sides and the drop at the end
    const sp = [],
      si = [];
    for (const s of [-1, 1]) {
      const b0 = sp.length / 3;
      for (const q of sideP) {
        const x = T.px[q.i] + T.rx[q.i] * s * T.hw[q.i],
          z = T.pz[q.i] + T.rz[q.i] * s * T.hw[q.i];
        sp.push(x, q.y, z, x, q.base - 0.05, z);
      }
      for (let k = 0; k < sideP.length - 1; k++) {
        const p = b0 + k * 2;
        si.push(p, p + 2, p + 1, p + 1, p + 2, p + 3);
      }
    }
    const last = sideP[sideP.length - 1];
    const b0 = sp.length / 3;
    for (const s of [-1, 1]) {
      const x = T.px[last.i] + T.rx[last.i] * s * T.hw[last.i],
        z = T.pz[last.i] + T.rz[last.i] * s * T.hw[last.i];
      sp.push(x, last.y, z, x, last.base - 0.05, z);
    }
    si.push(b0, b0 + 2, b0 + 1, b0 + 1, b0 + 2, b0 + 3);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    sg.setIndex(si);
    sg.computeVertexNormals();
    keep(new THREE.Mesh(sg, sideMat));
  }

  // start line, grid marks and the gantry
  {
    const g = ribbon(T, (i) => -T.hw[i], (i) => T.hw[i], (i) => T.py[i] + 0.05, (i) => T.py[i] + 0.05, 2);
    // keep only the two segments either side of the line
    const idx = [];
    for (const k of [T.n - 1, 0]) {
      const p = k * 2;
      idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2);
    }
    g.setIndex(idx);
    const ct = TX.checker(8);
    ct.repeat.set(2, 1);
    keep(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: ct, polygonOffset: true, polygonOffsetFactor: -2 })));
    const mark = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 });
    for (let k = 0; k < 8; k++) {
      const gs = gridSlot(T, k);
      const p = trackPoint(T, gs.fi + 1.4, gs.d);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.35), mark);
      m.rotation.set(-Math.PI / 2, 0, p.yaw);
      m.position.set(p.x, p.y + 0.06, p.z);
      keep(m);
    }
    const p0 = trackPoint(T, 0, 0);
    const gantry = new THREE.Group();
    const w = T.hw[0] + 1.6;
    const postMat = lambert('#30313a');
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.8, 7, 0.8), postMat);
      post.position.set(s * w, 3.5, 0);
      post.castShadow = hi;
      gantry.add(post);
    }
    const bt = TX.banner('TURBO KARTS');
    const beam = new THREE.Mesh(new THREE.BoxGeometry(w * 2 + 0.8, 1.8, 0.6), [postMat, postMat, postMat, postMat, new THREE.MeshBasicMaterial({ map: bt }), new THREE.MeshBasicMaterial({ map: bt })]);
    beam.position.y = 7;
    gantry.add(beam);
    gantry.position.set(p0.x, p0.y, p0.z);
    gantry.rotation.y = p0.yaw;
    keep(gantry);
  }

  // ---------------------------------------------------------------- terrain
  const nearest = makeNearest(T);
  const b = T.bounds;
  const amp = th.hills.amp,
    hs = th.hills.scale;
  const beach = !!th.water;
  const waterY = b.minY - 2.2;
  const heightAt = (x, z) => {
    const nn = nearest(x, z);
    const i = nn.i;
    const base = T.py[i] - 3.6;
    const lim = T.lim[i];
    const t = Math.min(1, Math.max(0, (nn.dist - lim - 10) / 70));
    const tt = t * t * (3 - 2 * t);
    let far = base + 3.6 + (fbm(x / hs, z / hs) - 0.35) * amp * (0.4 + tt);
    if (beach) far = base + 3.6 - 6 + (fbm(x / hs, z / hs) - 0.5) * 8;
    if (th.barrier === 'neon') far = base + 3.4;
    return { h: base + (far - base) * tt, dist: nn.dist, lim, i };
  };
  const decorSpots = [];
  if (th.ground) {
    const margin = 300;
    const x0 = b.minX - margin,
      x1 = b.maxX + margin,
      z0 = b.minZ - margin,
      z1 = b.maxZ + margin;
    const res = quality === 'low' ? 110 : 160;
    const nx = res,
      nz = Math.max(40, Math.round((res * (z1 - z0)) / (x1 - x0)));
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, nx, nz);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const c1 = new THREE.Color(th.ground[0]),
      c2 = new THREE.Color(th.ground[1]);
    const sand = new THREE.Color('#f1dc9c'),
      tmp = new THREE.Color();
    const cx = (x0 + x1) / 2,
      cz = (z0 + z1) / 2;
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k) + cx,
        z = pos.getZ(k) + cz;
      const r = heightAt(x, z);
      pos.setXYZ(k, x, r.h, z);
      tmp.copy(c1).lerp(c2, fbm(x / 40, z / 40));
      if (beach && r.h < waterY + 1.2) tmp.lerp(sand, 0.7);
      col.set([tmp.r, tmp.g, tmp.b], k * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const gt = TX.ground('#ffffff', '#d8d8d8', 9);
    gt.repeat.set((x1 - x0) / 30, (z1 - z0) / 30);
    const terrain = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, map: gt }));
    terrain.receiveShadow = true;
    keep(terrain);
    // scenery spots
    const rnd = mulberry(T.n * 13 + 7);
    for (let k = 0; k < 2600; k++) {
      const x = x0 + rnd() * (x1 - x0),
        z = z0 + rnd() * (z1 - z0);
      const r = heightAt(x, z);
      if (r.dist < r.lim + 5) continue;
      if (beach && r.h < waterY + 0.6) continue;
      decorSpots.push({ x, z, y: r.h, dist: r.dist - r.lim, i: r.i, r: rnd() });
    }
  }
  if (beach) {
    const wt = TX.ground('#1aa3cf', '#53c9ec', 5);
    wt.repeat.set(40, 40);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshLambertMaterial({ map: wt, transparent: true, opacity: 0.92 }));
    water.rotation.x = -Math.PI / 2;
    water.position.set((b.minX + b.maxX) / 2, waterY, (b.minZ + b.maxZ) / 2);
    keep(water);
    anim.push((t) => {
      wt.offset.set(t * 0.01, t * 0.006);
    });
  }
  if (th.clouds) {
    const ct = TX.softDot();
    const mat = new THREE.MeshBasicMaterial({ map: ct, color: 0xb9a2ff, transparent: true, opacity: 0.55, depthWrite: false });
    const geo = new THREE.PlaneGeometry(1, 1);
    const n = 70;
    const inst = new THREE.InstancedMesh(geo, mat, n);
    const m = new THREE.Matrix4(),
      q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)),
      s = new THREE.Vector3(),
      p = new THREE.Vector3();
    const rnd = mulberry(5);
    for (let k = 0; k < n; k++) {
      const sc = 80 + rnd() * 180;
      p.set(b.minX - 300 + rnd() * (b.maxX - b.minX + 600), b.minY - 30 - rnd() * 60, b.minZ - 300 + rnd() * (b.maxZ - b.minZ + 600));
      s.set(sc, sc * 0.6, 1);
      m.compose(p, q, s);
      inst.setMatrixAt(k, m);
    }
    keep(inst);
    // floating star pylons along the track
    const pyl = new THREE.Mesh(new THREE.OctahedronGeometry(1.2), new THREE.MeshBasicMaterial({ color: 0xffd23f }));
    for (let i = 0; i < T.n; i += 18) {
      for (const sd of [-1, 1]) {
        const o = pyl.clone();
        o.position.set(T.px[i] + T.rx[i] * sd * (T.lim[i] + 3), T.py[i] + 4, T.pz[i] + T.rz[i] * sd * (T.lim[i] + 3));
        keep(o);
        anim.push((t) => (o.rotation.y = t * 1.5 + i));
      }
    }
  }

  // distant mountains
  if (th.mountains) {
    const cx = (b.minX + b.maxX) / 2,
      cz = (b.minZ + b.maxZ) / 2;
    const R = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 520;
    const geos = [];
    const rnd = mulberry(11);
    for (let k = 0; k < 30; k++) {
      const a = (k / 30) * Math.PI * 2 + rnd() * 0.15;
      const h = 110 + rnd() * 170,
        r = 120 + rnd() * 120;
      const g = new THREE.ConeGeometry(r, h, 7, 1);
      g.translate(cx + Math.cos(a) * (R + rnd() * 140), b.minY - 8 + h / 2, cz + Math.sin(a) * (R + rnd() * 140));
      geos.push(g);
    }
    const mm = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshLambertMaterial({ color: th.mountains, flatShading: true }));
    keep(mm);
  }
  if (th.volcano) {
    const cx = (b.minX + b.maxX) / 2 + 380,
      cz = (b.minZ + b.maxZ) / 2 - 420;
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(60, 260, 260, 12, 1, true), new THREE.MeshLambertMaterial({ color: '#2a1a16', flatShading: true }));
    cone.position.set(cx, b.minY + 120, cz);
    keep(cone);
    const glowM = new THREE.Mesh(new THREE.CircleGeometry(58, 16), new THREE.MeshBasicMaterial({ color: 0xff6a1a, fog: false }));
    glowM.rotation.x = -Math.PI / 2;
    glowM.position.set(cx, b.minY + 248, cz);
    keep(glowM);
    anim.push((t) => glowM.material.color.setHSL(0.05, 1, 0.5 + Math.sin(t * 2) * 0.08));
  }

  placeDecor(root, th, T, decorSpots, quality, anim);

  // ---------------------------------------------------------------- item boxes, pads
  const boxTex = TX.itemBox();
  const boxGeo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
  const boxMat = new THREE.MeshLambertMaterial({ map: boxTex, transparent: true, opacity: 0.92, emissive: 0x332244 });
  const boxes = [];
  const padTex = TX.chevrons('#ffb000');
  const padMat = new THREE.MeshBasicMaterial({ map: padTex, transparent: true, opacity: 0.95, polygonOffset: true, polygonOffsetFactor: -3 });
  const pads = [];
  const world = {
    theme: th,
    root,
    sunDir,
    waterY: beach ? waterY : null,
    heightAt: (x, z) => heightAt(x, z).h,
    setRace(race) {
      for (const m of boxes) root.remove(m);
      for (const m of pads) root.remove(m);
      boxes.length = pads.length = 0;
      for (const bx of race.boxes) {
        const m = new THREE.Mesh(boxGeo, boxMat);
        m.position.set(bx.x, bx.y, bx.z);
        m.castShadow = hi;
        m.userData.box = bx;
        m.userData.pop = 1;
        root.add(m);
        boxes.push(m);
      }
      for (const p of race.pads) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 6), padMat);
        m.rotation.order = 'YXZ';
        m.rotation.set(-Math.PI / 2, p.yaw + Math.PI, 0);
        m.position.set(p.x, p.y + 0.07, p.z);
        root.add(m);
        pads.push(m);
      }
    },
    update(t, dt, cam, focus) {
      for (const f of anim) f(t, cam, focus);
      for (const m of boxes) {
        const bx = m.userData.box;
        if (!bx.alive) {
          m.visible = false;
          m.userData.pop = 0;
          continue;
        }
        m.visible = true;
        m.userData.pop = Math.min(1, m.userData.pop + dt * 3);
        const s = m.userData.pop;
        m.scale.setScalar(s);
        m.rotation.set(t * 0.9 + bx.x, t * 1.3, t * 0.7);
        m.position.y = bx.y + Math.sin(t * 2.5 + bx.z) * 0.18;
      }
      padTex.offset.y = -t * 1.8;
    },
    dispose() {
      scene.remove(root);
      root.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) for (const m of [].concat(o.material)) {
            if (m.map) m.map.dispose();
            m.dispose();
          }
      });
      for (const d of disposables) d.dispose();
    },
  };
  return world;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ scenery
function decorGeometry(type) {
  const parts = []; // [geometry, color]
  const add = (g, c) => parts.push([g, new THREE.Color(c)]);
  switch (type) {
    case 'tree': {
      add(new THREE.CylinderGeometry(0.35, 0.5, 3, 6).translate(0, 1.5, 0), '#6b4a2a');
      add(new THREE.IcosahedronGeometry(2.6, 0).translate(0, 4.6, 0), '#3f9a3a');
      add(new THREE.IcosahedronGeometry(1.8, 0).translate(0.9, 6, 0.4), '#4cae44');
      break;
    }
    case 'maple': {
      add(new THREE.CylinderGeometry(0.35, 0.5, 3.2, 6).translate(0, 1.6, 0), '#5a3a22');
      add(new THREE.IcosahedronGeometry(2.7, 0).translate(0, 4.8, 0), '#ffffff');
      add(new THREE.IcosahedronGeometry(1.9, 0).translate(-0.8, 6.2, 0.3), '#ffffff');
      break;
    }
    case 'pine': {
      add(new THREE.CylinderGeometry(0.3, 0.45, 2.4, 6).translate(0, 1.2, 0), '#5a3c24');
      add(new THREE.ConeGeometry(2.6, 3.6, 7).translate(0, 3.4, 0), '#2f6b45');
      add(new THREE.ConeGeometry(2.0, 3.0, 7).translate(0, 5.2, 0), '#357a4e');
      add(new THREE.ConeGeometry(1.3, 2.4, 7).translate(0, 6.9, 0), '#eef5ff');
      break;
    }
    case 'bush':
      add(new THREE.IcosahedronGeometry(1.2, 0).scale(1.3, 0.8, 1.2).translate(0, 0.6, 0), '#3c8f37');
      break;
    case 'flower':
      add(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 3).translate(0, 0.25, 0), '#2f7a2a');
      add(new THREE.IcosahedronGeometry(0.18, 0).translate(0, 0.55, 0), '#ffffff');
      break;
    case 'rock':
      add(new THREE.DodecahedronGeometry(1.4, 0).scale(1.3, 0.8, 1.1).translate(0, 0.5, 0), '#8a8580');
      break;
    case 'cactus':
      add(new THREE.CylinderGeometry(0.45, 0.5, 4, 7).translate(0, 2, 0), '#3e8a46');
      add(new THREE.CylinderGeometry(0.3, 0.3, 1.6, 6).rotateZ(Math.PI / 2).translate(0.8, 2.2, 0), '#3e8a46');
      add(new THREE.CylinderGeometry(0.3, 0.3, 1.4, 6).translate(1.5, 2.9, 0), '#3e8a46');
      add(new THREE.CylinderGeometry(0.28, 0.28, 1.2, 6).translate(-0.7, 2.8, 0), '#3e8a46');
      add(new THREE.CylinderGeometry(0.28, 0.28, 0.8, 6).rotateZ(Math.PI / 2).translate(-0.4, 2.3, 0), '#3e8a46');
      break;
    case 'mesa':
      add(new THREE.CylinderGeometry(14, 20, 26, 8).translate(0, 13, 0), '#c06a3e');
      add(new THREE.CylinderGeometry(14.2, 14.2, 1.5, 8).translate(0, 25, 0), '#a8562e');
      break;
    case 'snowman':
      add(new THREE.SphereGeometry(1.1, 10, 8).translate(0, 1, 0), '#ffffff');
      add(new THREE.SphereGeometry(0.8, 10, 8).translate(0, 2.4, 0), '#ffffff');
      add(new THREE.SphereGeometry(0.55, 10, 8).translate(0, 3.4, 0), '#ffffff');
      add(new THREE.ConeGeometry(0.12, 0.6, 6).rotateX(Math.PI / 2).translate(0, 3.4, 0.7), '#ff7a1a');
      break;
    case 'building':
      add(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), '#ffffff');
      break;
    case 'pumpkin':
      add(new THREE.SphereGeometry(0.7, 10, 8).scale(1.2, 0.85, 1.2).translate(0, 0.55, 0), '#ff8a1f');
      add(new THREE.CylinderGeometry(0.08, 0.1, 0.35, 5).translate(0, 1.2, 0), '#3e6a2a');
      break;
    case 'lava':
      add(new THREE.CircleGeometry(5, 12).rotateX(-Math.PI / 2).translate(0, 0.15, 0), '#ff5a12');
      break;
    case 'spire':
      add(new THREE.ConeGeometry(3, 18, 6).translate(0, 9, 0), '#2a201e');
      break;
    case 'palm': {
      for (let k = 0; k < 5; k++) add(new THREE.CylinderGeometry(0.3 - k * 0.03, 0.34 - k * 0.03, 1.6, 6).translate(k * 0.18, 0.8 + k * 1.5, 0), '#8a6a42');
      for (let k = 0; k < 6; k++) {
        const g = new THREE.ConeGeometry(0.6, 4, 4).scale(1, 1, 0.25).rotateZ(Math.PI / 2 + 0.5).translate(2, 7.2, 0);
        g.rotateY((k / 6) * Math.PI * 2);
        g.translate(0.8, 0, 0);
        add(g, '#3a9a3e');
      }
      break;
    }
    case 'umbrella':
      add(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 5).translate(0, 1.3, 0), '#eeeeee');
      add(new THREE.ConeGeometry(1.6, 0.7, 8).translate(0, 2.7, 0), '#ffffff');
      break;
    default:
      return null;
  }
  // merge with per-vertex colours
  const geos = parts.map(([g, c]) => {
    g = g.index ? g.toNonIndexed() : g;
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    return g;
  });
  return mergeGeometries(geos);
}

const TINTS = {
  maple: ['#e8541e', '#f2a516', '#d8322a', '#f7c43a'],
  flower: ['#ff5fa2', '#ffd23f', '#ffffff', '#b07bff'],
  umbrella: ['#ff4f6a', '#3fb7ff', '#ffd23f'],
  building: ['#8b90a6', '#9aa0b8', '#6e7590', '#a4a8b8'],
  rock: ['#8a8580', '#7a756f', '#9a948c'],
};

function placeDecor(root, th, T, spots, quality, anim) {
  const mul = quality === 'low' ? 0.45 : quality === 'medium' ? 0.75 : 1;
  const m4 = new THREE.Matrix4(),
    q = new THREE.Quaternion(),
    s = new THREE.Vector3(),
    p = new THREE.Vector3(),
    e = new THREE.Euler(),
    c = new THREE.Color();
  let si = 0;
  const lit = !!th.night;
  for (const [type, count0] of th.decor) {
    const count = Math.round(count0 * mul);
    if (!count) continue;
    const geo = decorGeometry(type);
    if (!geo) continue;
    let mat;
    if (type === 'building') {
      mat = new THREE.MeshLambertMaterial({ map: TX.windows(3, lit), emissive: lit ? 0xffffff : 0x000000, emissiveMap: lit ? TX.windows(3, lit) : null, emissiveIntensity: lit ? 0.9 : 0 });
      const uv = [];
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) uv.push((pos.getX(i) + pos.getZ(i)) * 1, pos.getY(i) * 2);
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    } else if (type === 'lava') mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    else mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    inst.castShadow = quality === 'high' && type !== 'lava' && type !== 'flower';
    let n = 0;
    const tints = TINTS[type];
    for (let tries = 0; tries < spots.length && n < count; tries++) {
      const sp = spots[(si++ * 7) % spots.length];
      if (type === 'building' && sp.dist > 90 && sp.r < 0.6) continue;
      if ((type === 'mesa' || type === 'spire') && sp.dist < 40) continue;
      if (type === 'flower' && sp.dist > 60) continue;
      let sc = 0.8 + ((sp.r * 9.7) % 1) * 0.6;
      if (type === 'building') {
        const h = 14 + ((sp.r * 13.3) % 1) * 46;
        s.set(10 + sp.r * 8, h, 10 + ((sp.r * 3.1) % 1) * 8);
      } else s.set(sc, sc, sc);
      e.set(0, sp.r * 40, 0);
      q.setFromEuler(e);
      p.set(sp.x, sp.y - 0.2, sp.z);
      m4.compose(p, q, s);
      inst.setMatrixAt(n, m4);
      if (tints) inst.setColorAt(n, c.set(tints[Math.floor(sp.r * 977) % tints.length]));
      n++;
    }
    inst.count = n;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    root.add(inst);
    if (type === 'lava') anim.push((t) => mat.color.setHSL(0.06, 1, 0.55 + Math.sin(t * 3) * 0.06));
  }
  // street lamps along the city track
  if (th.lamps) {
    const pole = new THREE.CylinderGeometry(0.12, 0.16, 6, 6).translate(0, 3, 0);
    const bulbG = new THREE.SphereGeometry(0.45, 8, 6).translate(0, 6.1, 0);
    const pm = new THREE.InstancedMesh(pole, new THREE.MeshLambertMaterial({ color: 0x2a2c38 }), 200);
    const bm = new THREE.InstancedMesh(bulbG, new THREE.MeshBasicMaterial({ color: 0xffe7a8 }), 200);
    let n = 0;
    for (let i = 0; i < T.n && n < 200; i += 15)
      for (const sd of [-1, 1]) {
        p.set(T.px[i] + T.rx[i] * sd * (T.lim[i] + 1.2), T.py[i], T.pz[i] + T.rz[i] * sd * (T.lim[i] + 1.2));
        m4.makeTranslation(p.x, p.y, p.z);
        pm.setMatrixAt(n, m4);
        bm.setMatrixAt(n, m4);
        n++;
      }
    pm.count = bm.count = n;
    root.add(pm, bm);
  }
}
