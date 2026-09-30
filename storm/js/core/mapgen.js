// Procedural island: terrain, named locations (POIs) with grid-aligned buildings made of
// regular build pieces, props, chests and loot spots. Fully deterministic from the seed.
import { RNG, fbm } from './rng.js';
import { Terrain, makeBaseHeight, fillTerrain } from './terrain.js';
import { TERRAIN_SEG, WORLD_HALF, GRID, LEVEL, MATERIALS } from './config.js';
import { K_WALL, K_FLOOR, K_RAMP, K_CONE, DIRS } from './pieces.js';

const POI_DEFS = [
  { name: 'Frostpeak Lodge', style: 'lodge', mountain: true, n: [3, 4], r: 42 },
  { name: 'Harbor Point', style: 'harbor', coastal: true, n: [4, 6], r: 54, landmark: 'lighthouse', dock: true },
  { name: 'Driftwood Bay', style: 'beach', coastal: true, n: [5, 7], r: 56, dock: true },
  { name: 'Stonegate', style: 'brick', n: [6, 8], r: 66 },
  { name: 'Timber Town', style: 'wood', n: [6, 8], r: 62 },
  { name: 'Copper Yard', style: 'metal', n: [4, 5], r: 62, containers: true },
  { name: 'Mossy Marsh', style: 'hut', n: [6, 8], r: 54 },
  { name: 'Hilltop Ranch', style: 'ranch', n: [3, 4], r: 56, landmark: 'watertower', hay: true },
  { name: 'Old Mill', style: 'mill', n: [3, 5], r: 50, landmark: 'windmill' },
  { name: 'Sunset Suburbs', style: 'suburb', n: [7, 9], r: 70 },
];

const PASTEL = [0xf4e6c6, 0xcfe3f1, 0xd7ecc6, 0xf5d2c6, 0xfbeeb0, 0xf7f7f2, 0xe6d6f0, 0xc9ece4];
const BRICKS = [0xc2644a, 0xb8876a, 0xa9a39b, 0xcf8a5c, 0x9c5140];
const METALS = [0x6fa3a8, 0xc9774a, 0x6d86b3, 0xa4acb4, 0xb8a860, 0x7aa36b];
const ROOFS = [0xa73c2f, 0x4b5b7c, 0x4f7a42, 0x6e4a33, 0x2f6f73, 0x8a3b5a];

const STYLES = {
  wood: { mat: 0, sizes: [[2, 2, 2], [2, 3, 2], [3, 3, 1], [2, 2, 1], [2, 3, 1]], roof: 'gable', wall: PASTEL },
  beach: { mat: 0, sizes: [[2, 2, 1], [2, 3, 1], [2, 2, 2]], roof: 'gable', wall: PASTEL },
  metal: { mat: 2, sizes: [[3, 4, 2, 'hollow'], [3, 3, 2, 'hollow'], [2, 3, 1], [2, 2, 2]], roof: 'flat', wall: METALS },
  brick: { mat: 1, sizes: [[3, 3, 3], [2, 3, 2], [3, 4, 2], [2, 2, 3], [2, 3, 3]], roof: 'flat', wall: BRICKS },
  lodge: { mat: 0, sizes: [[3, 4, 2], [2, 2, 1], [3, 3, 2]], roof: 'gable', wall: [0xc98f5e, 0xb07a4c, 0xd9a877] },
  hut: { mat: 0, sizes: [[1, 2, 1], [2, 2, 1], [1, 1, 1], [2, 2, 1]], roof: 'cone', wall: [0xa6b58a, 0xc2a877, 0x9fb09a] },
  ranch: { mat: 0, sizes: [[3, 4, 2, 'hollow'], [2, 3, 2], [2, 2, 1]], roof: 'gable', wall: [0xc2493b, 0xf4e6c6, 0xb33f33] },
  mill: { mat: 0, sizes: [[2, 3, 2], [3, 3, 1], [2, 2, 1]], roof: 'gable', wall: PASTEL },
  harbor: { mat: 0, sizes: [[2, 3, 1], [3, 4, 1, 'hollow'], [2, 2, 2]], roof: 'gable', wall: PASTEL, alt: 2 },
  suburb: { mat: 0, sizes: [[2, 3, 2], [3, 3, 2], [2, 2, 2], [2, 3, 1]], roof: 'gable', wall: PASTEL, alt: 1 },
};

export const DEFAULT_TINT = [0xc49060, 0xbd5e46, 0x9aa6b2];

export function generateMap(seed) {
  const rng = new RNG(seed);
  const terrain = new Terrain(TERRAIN_SEG, WORLD_HALF);

  // --- mountain -------------------------------------------------------------
  let mountain = null;
  for (let i = 0; i < 200 && !mountain; i++) {
    const x = rng.float(-300, 300);
    const z = rng.float(-300, 300);
    const d = Math.sqrt(x * x + z * z);
    if (d > 150 && d < 270) mountain = { x, z, r: rng.float(150, 185), h: rng.float(88, 104) };
  }
  const base = makeBaseHeight(seed, mountain);

  // --- POIs -----------------------------------------------------------------
  const pois = [];
  const ring = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7],
  ];
  for (const def of POI_DEFS) {
    let placed = null;
    for (let attempt = 0; attempt < 900 && !placed; attempt++) {
      const relax = attempt > 600 ? 0.6 : 1;
      const x = rng.float(-440, 440);
      const z = rng.float(-440, 440);
      const h = base(x, z);
      const dc = Math.sqrt(x * x + z * z);
      if (def.mountain) {
        if (!(h > 38 && h < 82)) continue;
      } else if (def.coastal) {
        if (!(h > 1.2 && h < 9 && dc > 240)) continue;
      } else if (!(h > 2.5 && h < 34 && dc < 400)) continue;
      let ok = true;
      for (const [px, pz] of ring) {
        const hh = base(x + px * def.r * 0.8, z + pz * def.r * 0.8);
        if (!def.coastal && hh < 1.0) ok = false;
        if (def.coastal) {
          const hi = base(x + px * def.r * 0.4, z + pz * def.r * 0.4);
          if (hi < 0.3) ok = false;
        }
      }
      if (!ok) continue;
      for (const p of pois) {
        const dx = p.x - x;
        const dz = p.z - z;
        const min = p.r + def.r + 70 * relax;
        if (dx * dx + dz * dz < min * min) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const gx = Math.round(x / GRID) * GRID;
      const gz = Math.round(z / GRID) * GRID;
      const L = Math.max(1, Math.round(h / LEVEL));
      placed = { name: def.name, style: def.style, def, x: gx, z: gz, r: def.r, L, y: L * LEVEL };
    }
    if (placed) pois.push(placed);
  }

  // Landmark positions within their POIs
  const landmarks = [];
  for (const p of pois) {
    if (!p.def.landmark) continue;
    let lx = p.x;
    let lz = p.z;
    if (p.def.landmark === 'lighthouse') {
      // toward the sea (away from island center)
      const d = Math.sqrt(p.x * p.x + p.z * p.z) || 1;
      lx = p.x + (p.x / d) * (p.r - 12);
      lz = p.z + (p.z / d) * (p.r - 12);
    } else {
      lx = p.x + (rng.chance(0.5) ? 1 : -1) * (p.r - 16);
      lz = p.z + rng.float(-10, 10);
    }
    landmarks.push({ type: p.def.landmark, x: lx, z: lz, poi: p });
  }
  // Radio tower on the mountain top
  if (mountain) {
    let best = -1e9;
    let bx = mountain.x;
    let bz = mountain.z;
    for (let i = -6; i <= 6; i++)
      for (let j = -6; j <= 6; j++) {
        const x = mountain.x + i * 8;
        const z = mountain.z + j * 8;
        const h = base(x, z);
        if (h > best) {
          best = h;
          bx = x;
          bz = z;
        }
      }
    let clash = false;
    for (const p of pois) {
      const dx = p.x - bx;
      const dz = p.z - bz;
      if (dx * dx + dz * dz < (p.r + 20) * (p.r + 20)) clash = true;
    }
    if (!clash) landmarks.push({ type: 'radiotower', x: bx, z: bz, poi: null });
  }

  // --- terrain with plateaus -------------------------------------------------
  const flats = pois.map((p) => ({ x: p.x, z: p.z, r: p.r, y: p.y - 0.05, blend: 40 }));
  fillTerrain(terrain, base, flats);

  // --- buildings --------------------------------------------------------------
  const pieces = [];
  const buildings = [];
  const chests = [];
  const boxes = [];
  const spots = [];
  const footprints = [];
  let pid = 1;

  const addPiece = (k, x, y, z, o, m, c, v = 0, anchored = false) => {
    pieces.push({ id: pid++, k, x, y, z, o, m, c, v, hp: MATERIALS[m].hp, max: MATERIALS[m].hp, anchored, map: true });
  };

  const brng = rng.fork(77);
  for (const poi of pois) {
    const style = STYLES[poi.style];
    const count = brng.int(poi.def.n[0], poi.def.n[1]);
    const cells0x = Math.round(poi.x / GRID);
    const cells0z = Math.round(poi.z / GRID);
    const rc = Math.floor((poi.r - 8) / GRID);
    const local = [];
    // keep landmark area clear
    const blockers = landmarks.filter((l) => l.poi === poi).map((l) => ({ x0: l.x - 9, z0: l.z - 9, x1: l.x + 9, z1: l.z + 9 }));
    for (let n = 0, tries = 0; n < count && tries < 200; tries++) {
      let [w, d, lv, flag] = brng.pick(style.sizes);
      if (brng.chance(0.5)) [w, d] = [d, w];
      const ox = cells0x + brng.int(-rc, rc - w);
      const oz = cells0z + brng.int(-rc, rc - d);
      // inside radius?
      const corners = [
        [ox, oz], [ox + w, oz], [ox, oz + d], [ox + w, oz + d],
      ];
      let ok = true;
      for (const [cx, cz] of corners) {
        const dx = cx * GRID - poi.x;
        const dz = cz * GRID - poi.z;
        if (dx * dx + dz * dz > (poi.r - 4) * (poi.r - 4)) ok = false;
      }
      if (!ok) continue;
      const fx0 = ox * GRID - 5, fz0 = oz * GRID - 5, fx1 = (ox + w) * GRID + 5, fz1 = (oz + d) * GRID + 5;
      for (const f of local.concat(blockers)) {
        if (fx0 < f.x1 && fx1 > f.x0 && fz0 < f.z1 && fz1 > f.z0) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      local.push({ x0: ox * GRID - 1, z0: oz * GRID - 1, x1: (ox + w) * GRID + 1, z1: (oz + d) * GRID + 1 });
      let mat = style.mat;
      if (style.alt !== undefined && brng.chance(0.35)) mat = style.alt;
      const b = makeBuilding(brng, poi, ox, oz, w, d, lv, flag === 'hollow', mat, style, addPiece, chests, boxes, spots);
      buildings.push(b);
      n++;
    }
    for (const f of local) footprints.push(f);
    // docks
    if (poi.def.dock) {
      const d = Math.sqrt(poi.x * poi.x + poi.z * poi.z) || 1;
      const ux = poi.x / d;
      const uz = poi.z / d;
      let dir;
      if (Math.abs(ux) > Math.abs(uz)) dir = ux > 0 ? 0 : 2;
      else dir = uz > 0 ? 1 : 3;
      const [ddx, ddz] = DIRS[dir];
      // start from the plateau edge, walking outward until water, then extend
      let cx = cells0x;
      let cz = cells0z;
      let steps = 0;
      while (steps < 40) {
        const h = terrain.heightAt(cx * GRID + 2, cz * GRID + 2);
        if (h < poi.y - 1.2) break;
        cx += ddx;
        cz += ddz;
        steps++;
      }
      // step back one so the dock starts on land
      cx -= ddx;
      cz -= ddz;
      const len = 9;
      let blocked = false;
      for (const f of local) {
        const px = cx * GRID + 2;
        const pz = cz * GRID + 2;
        if (px > f.x0 - 4 && px < f.x1 + 4 && pz > f.z0 - 4 && pz < f.z1 + 4) blocked = true;
      }
      if (!blocked) {
        for (let i = 0; i < len; i++) {
          const x = cx + ddx * i;
          const z = cz + ddz * i;
          addPiece(K_FLOOR, x, poi.L, z, 0, 0, 0xb08a60, 0, true);
          if (ddx !== 0) {
            // side dock widening at the end
            if (i >= len - 3) {
              addPiece(K_FLOOR, x, poi.L, z + 1, 0, 0, 0xb08a60, 0, true);
              addPiece(K_FLOOR, x, poi.L, z - 1, 0, 0, 0xb08a60, 0, true);
            }
          } else if (i >= len - 3) {
            addPiece(K_FLOOR, x + 1, poi.L, z, 0, 0, 0xb08a60, 0, true);
            addPiece(K_FLOOR, x - 1, poi.L, z, 0, 0, 0xb08a60, 0, true);
          }
        }
        const ex = (cx + ddx * (len - 1)) * GRID + 2;
        const ez = (cz + ddz * (len - 1)) * GRID + 2;
        boxes.push({ x: ex, y: poi.y, z: ez, yaw: 0 });
        spots.push({ x: ex + ddz * 2.5, y: poi.y, z: ez + ddx * 2.5 });
        const fx0 = Math.min(cx, cx + ddx * len) * GRID - 6;
        const fx1 = Math.max(cx, cx + ddx * len) * GRID + 10;
        const fz0 = Math.min(cz, cz + ddz * len) * GRID - 6;
        const fz1 = Math.max(cz, cz + ddz * len) * GRID + 10;
        footprints.push({ x0: fx0, z0: fz0, x1: fx1, z1: fz1 });
      }
    }
  }

  // --- roads (MST between POIs) -------------------------------------------------
  const roads = [];
  if (pois.length > 1) {
    const inTree = [0];
    const rest = pois.map((_, i) => i).slice(1);
    while (rest.length) {
      let bi = -1;
      let bj = -1;
      let bd = Infinity;
      for (const i of inTree)
        for (const j of rest) {
          const dx = pois[i].x - pois[j].x;
          const dz = pois[i].z - pois[j].z;
          const dd = dx * dx + dz * dz;
          if (dd < bd) {
            bd = dd;
            bi = i;
            bj = j;
          }
        }
      roads.push({ x1: pois[bi].x, z1: pois[bi].z, x2: pois[bj].x, z2: pois[bj].z });
      inTree.push(bj);
      rest.splice(rest.indexOf(bj), 1);
    }
  }
  const nearRoad = (x, z, w) => {
    for (const r of roads) {
      const vx = r.x2 - r.x1;
      const vz = r.z2 - r.z1;
      const l2 = vx * vx + vz * vz;
      let t = ((x - r.x1) * vx + (z - r.z1) * vz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = r.x1 + vx * t - x;
      const pz = r.z1 + vz * t - z;
      if (px * px + pz * pz < w * w) return true;
    }
    return false;
  };
  const inFootprint = (x, z, m = 0) => {
    for (const f of footprints) if (x > f.x0 - m && x < f.x1 + m && z > f.z0 - m && z < f.z1 + m) return true;
    return false;
  };
  const inPoi = (x, z, extra = 0) => {
    for (const p of pois) {
      const dx = p.x - x;
      const dz = p.z - z;
      const r = p.r + extra;
      if (dx * dx + dz * dz < r * r) return p;
    }
    return null;
  };
  const nearLandmark = (x, z, m) => {
    for (const l of landmarks) {
      const dx = l.x - x;
      const dz = l.z - z;
      if (dx * dx + dz * dz < m * m) return true;
    }
    return false;
  };

  // --- props ----------------------------------------------------------------
  const props = [];
  const prng = rng.fork(99);
  let propId = 1;
  const addProp = (type, x, z, s, rot, yOff = 0) => {
    let y;
    if (type === 'car' || type === 'container' || type === 'crate' || type === 'hay') {
      y = terrain.minOver(x - 1.5, z - 1.5, x + 1.5, z + 1.5) - 0.05;
    } else if (type === 'rock') y = terrain.heightAt(x, z) - 0.2 * s;
    else y = terrain.heightAt(x, z) - 0.15;
    props.push({ id: propId++, type, x, y: y + yOff, z, s, rot });
  };

  for (const l of landmarks) {
    const y0 = l.poi ? l.poi.y : terrain.minOver(l.x - 3, l.z - 3, l.x + 3, l.z + 3);
    props.push({ id: propId++, type: l.type, x: l.x, y: y0 - 0.05, z: l.z, s: 1, rot: 0 });
  }

  const TG = 10;
  for (let gx = -480; gx < 480; gx += TG) {
    for (let gz = -480; gz < 480; gz += TG) {
      const x = gx + prng.float(0, TG);
      const z = gz + prng.float(0, TG);
      const r1 = prng.next();
      const r2 = prng.next();
      const s = prng.float(0.8, 1.3);
      const rot = prng.float(0, 6.283);
      const h = terrain.heightAt(x, z);
      if (h < 0.6 || h > 94) continue;
      const forest = fbm(x * 0.006, z * 0.006, seed + 20, 3);
      let p;
      let type;
      if (h < 4.5 && h > 0.6) {
        p = 0.06;
        type = 'palm';
      } else if (h < 1.2) continue;
      else {
        p = forest > 0.56 ? 0.6 : forest > 0.47 ? 0.13 : 0.025;
        const f2 = fbm(x * 0.01 + 50, z * 0.01, seed + 21, 2);
        type = h > 34 || f2 > 0.56 ? 'pine' : 'oak';
      }
      const poi = inPoi(x, z, 6);
      if (poi) p *= 0.12;
      if (r1 >= p) continue;
      if (inFootprint(x, z, 3) || nearRoad(x, z, 5) || nearLandmark(x, z, 10)) continue;
      addProp(type, x, z, type === 'palm' ? s * 1.05 : s, rot);
      void r2;
    }
  }

  const RG = 26;
  for (let gx = -480; gx < 480; gx += RG) {
    for (let gz = -480; gz < 480; gz += RG) {
      const x = gx + prng.float(2, RG - 2);
      const z = gz + prng.float(2, RG - 2);
      const r1 = prng.next();
      const s = prng.float(0.6, 1.5);
      const rot = prng.float(0, 6.283);
      const h = terrain.heightAt(x, z);
      if (h < 1.0) continue;
      let p = 0.14 + (h > 30 ? 0.3 : 0);
      if (inPoi(x, z, 4)) p *= 0.15;
      if (r1 >= p) continue;
      if (inFootprint(x, z, 4) || nearRoad(x, z, 5) || nearLandmark(x, z, 10)) continue;
      addProp('rock', x, z, h > 30 ? s * 1.3 : s, rot);
    }
  }

  const BG = 17;
  for (let gx = -480; gx < 480; gx += BG) {
    for (let gz = -480; gz < 480; gz += BG) {
      const x = gx + prng.float(0, BG);
      const z = gz + prng.float(0, BG);
      const r1 = prng.next();
      const s = prng.float(0.8, 1.25);
      const h = terrain.heightAt(x, z);
      if (h < 1.3 || h > 62) continue;
      let p = 0.2;
      if (inPoi(x, z)) p = 0.1;
      if (r1 >= p) continue;
      if (inFootprint(x, z, 1.5) || nearRoad(x, z, 3)) continue;
      addProp('bush', x, z, s, prng.float(0, 6.283));
    }
  }

  // cars along roads
  for (const r of roads) {
    const vx = r.x2 - r.x1;
    const vz = r.z2 - r.z1;
    const len = Math.sqrt(vx * vx + vz * vz);
    const ang = Math.atan2(vx, vz);
    const nx = -vz / len;
    const nz = vx / len;
    for (let t = 60; t < len - 60; t += 55) {
      const side = prng.chance(0.5) ? 1 : -1;
      const roll = prng.next();
      const jitter = prng.float(-0.25, 0.25);
      if (roll > 0.4) continue;
      const x = r.x1 + (vx * t) / len + nx * 4.2 * side;
      const z = r.z1 + (vz * t) / len + nz * 4.2 * side;
      const h = terrain.heightAt(x, z);
      if (h < 1.0 || inFootprint(x, z, 3) || nearLandmark(x, z, 10)) continue;
      addProp('car', x, z, 1, ang + jitter + (side > 0 ? 0 : Math.PI));
    }
  }

  const scatterInPoi = (poi, type, count, rotGrid, margin) => {
    for (let i = 0, tries = 0; i < count && tries < 60; tries++) {
      const x = poi.x + prng.float(-poi.r + 8, poi.r - 8);
      const z = poi.z + prng.float(-poi.r + 8, poi.r - 8);
      const rot = rotGrid ? (prng.chance(0.5) ? 0 : Math.PI / 2) : prng.float(0, 6.283);
      const dx = x - poi.x;
      const dz = z - poi.z;
      if (dx * dx + dz * dz > (poi.r - 6) * (poi.r - 6)) continue;
      if (inFootprint(x, z, margin) || nearLandmark(x, z, 10)) continue;
      footprints.push({ x0: x - 3.5, z0: z - 3.5, x1: x + 3.5, z1: z + 3.5 });
      addProp(type, x, z, 1, rot);
      i++;
    }
  };
  for (const poi of pois) {
    scatterInPoi(poi, 'car', prng.int(1, 3), false, 4);
    if (poi.def.containers) scatterInPoi(poi, 'container', prng.int(8, 12), true, 3.5);
    if (poi.def.hay) scatterInPoi(poi, 'hay', prng.int(5, 8), false, 2);
    if (poi.def.dock || poi.style === 'metal') scatterInPoi(poi, 'crate', prng.int(4, 7), true, 2);
  }

  // --- outdoor loot spots & chests ------------------------------------------------
  const lrng = rng.fork(123);
  for (const poi of pois) {
    for (let i = 0, tries = 0; i < 8 && tries < 40; tries++) {
      const x = poi.x + lrng.float(-poi.r - 10, poi.r + 10);
      const z = poi.z + lrng.float(-poi.r - 10, poi.r + 10);
      if (inFootprint(x, z, 1.5)) continue;
      const h = terrain.heightAt(x, z);
      if (h < 1) continue;
      spots.push({ x, y: h, z });
      i++;
    }
  }
  for (let i = 0, tries = 0; i < 130 && tries < 1500; tries++) {
    const x = lrng.float(-450, 450);
    const z = lrng.float(-450, 450);
    const h = terrain.heightAt(x, z);
    if (h < 1.2 || h > 95 || inFootprint(x, z, 2) || inPoi(x, z, 10)) continue;
    spots.push({ x, y: h, z });
    i++;
  }
  for (let i = 0, tries = 0; i < 26 && tries < 800; tries++) {
    const x = lrng.float(-440, 440);
    const z = lrng.float(-440, 440);
    const h = terrain.heightAt(x, z);
    if (h < 1.5 || h > 90 || inFootprint(x, z, 2) || inPoi(x, z, 15)) continue;
    chests.push({ x, y: h - 0.05, z, yaw: lrng.float(0, 6.283) });
    i++;
  }

  chests.forEach((c, i) => (c.id = i));
  boxes.forEach((c, i) => (c.id = i));
  spots.forEach((c, i) => (c.id = i));

  return { seed, terrain, mountain, pois, landmarks, buildings, pieces, props, chests, boxes, spots, roads, footprints };
}

function makeBuilding(rng, poi, ox, oz, w, d, lv, hollow, mat, style, addPiece, chests, boxes, spots) {
  const L = poi.L;
  const wallColor = rng.pick(style.wall);
  const roofColor = rng.pick(ROOFS);
  const floorColor = mat === 0 ? 0xdcb88c : mat === 1 ? 0xb4aaa0 : 0xa3a9ae;
  const inside = (x, z) => x >= ox && x < ox + w && z >= oz && z < oz + d;

  // door side: face the POI center
  const bcx = (ox + w / 2) * GRID;
  const bcz = (oz + d / 2) * GRID;
  const tdx = poi.x - bcx;
  const tdz = poi.z - bcz;
  let doorSide;
  if (Math.abs(tdx) > Math.abs(tdz)) doorSide = tdx > 0 ? 0 : 2;
  else doorSide = tdz > 0 ? 1 : 3;
  // perimeter edges: {x,z,o,side, cell inside}
  const edges = [];
  for (let x = ox; x < ox + w; x++) {
    edges.push({ x, z: oz, o: 1, side: 3, cx: x, cz: oz });
    edges.push({ x, z: oz + d, o: 1, side: 1, cx: x, cz: oz + d - 1 });
  }
  for (let z = oz; z < oz + d; z++) {
    edges.push({ x: ox, z, o: 0, side: 2, cx: ox, cz: z });
    edges.push({ x: ox + w, z, o: 0, side: 0, cx: ox + w - 1, cz: z });
  }
  const sideEdges = edges.filter((e) => e.side === doorSide);
  const doorEdge = sideEdges[Math.floor(sideEdges.length / 2)];
  const doors = [doorEdge];
  if ((w * d >= 6 || hollow) && rng.chance(0.6)) {
    const opp = edges.filter((e) => e.side === (doorSide + 2) % 4);
    doors.push(opp[Math.floor(opp.length / 2)]);
  }
  if (hollow) {
    const sides = edges.filter((e) => e.side === (doorSide + 1) % 4);
    if (sides.length) doors.push(sides[Math.floor(sides.length / 2)]);
  }
  const doorCells = new Set(doors.map((e) => e.cx + ',' + e.cz));

  // stairs
  const stairs = [];
  const holes = new Set(); // "x,z,level"
  const stairCells = new Set(); // "x,z,level"
  if (!hollow) {
    const used = new Set();
    for (let l = 0; l < lv - 1; l++) {
      const cands = [];
      for (let x = ox; x < ox + w; x++)
        for (let z = oz; z < oz + d; z++)
          for (let dir = 0; dir < 4; dir++) {
            const tx = x + DIRS[dir][0];
            const tz = z + DIRS[dir][1];
            if (!inside(tx, tz)) continue;
            const k = x + ',' + z;
            if (used.has(k)) continue;
            if (l === 0 && doorCells.has(k)) continue;
            if (holes.has(tx + ',' + tz + ',' + (l + 1))) continue;
            if (holes.has(x + ',' + z + ',' + l)) continue;
            cands.push([x, z, dir, tx, tz]);
          }
      if (!cands.length) break;
      const [sx, sz, dir, tx, tz] = rng.pick(cands);
      used.add(sx + ',' + sz);
      holes.add(sx + ',' + sz + ',' + (l + 1));
      stairCells.add(sx + ',' + sz + ',' + l);
      stairs.push({ l, x: sx, z: sz, dir, tx, tz });
      addPiece(K_RAMP, sx, L + l, sz, dir, mat === 2 ? 2 : 0, mat === 2 ? 0xa3a9ae : 0xc9a47a);
    }
  }

  // floors
  const floorLevels = hollow ? [0] : [...Array(lv).keys()];
  for (const l of floorLevels) {
    for (let x = ox; x < ox + w; x++)
      for (let z = oz; z < oz + d; z++) {
        if (holes.has(x + ',' + z + ',' + l)) continue;
        addPiece(K_FLOOR, x, L + l, z, 0, mat, floorColor, 0, l === 0);
      }
  }
  // walls
  for (let l = 0; l < lv; l++) {
    for (const e of edges) {
      let v = 0;
      if (l === 0 && doors.includes(e)) v = 1;
      else if (rng.chance(l === 0 ? 0.3 : 0.45)) v = 2;
      if (hollow && l > 0 && rng.chance(0.3)) v = 2;
      addPiece(K_WALL, e.x, L + l, e.z, e.o, mat, wallColor, v);
    }
  }
  // interior wall
  if (!hollow && (w >= 3 || d >= 3)) {
    const alongX = w >= d; // wall line splits the longer axis
    for (let l = 0; l < lv; l++) {
      if (alongX) {
        const lx = ox + Math.floor(w / 2);
        const zs = [];
        for (let z = oz; z < oz + d; z++) {
          let clash = false;
          for (const s of stairs)
            if (s.l === l && ((s.x === lx - 1 && s.tx === lx) || (s.x === lx && s.tx === lx - 1)) && s.z === z) clash = true;
          if (!clash) zs.push(z);
        }
        const gap = zs.length ? zs[Math.floor(rng.next() * zs.length)] : null;
        for (const z of zs) addPiece(K_WALL, lx, L + l, z, 0, mat, wallColor, z === gap ? 1 : 0);
      } else {
        const lz = oz + Math.floor(d / 2);
        const xs = [];
        for (let x = ox; x < ox + w; x++) {
          let clash = false;
          for (const s of stairs)
            if (s.l === l && ((s.z === lz - 1 && s.tz === lz) || (s.z === lz && s.tz === lz - 1)) && s.x === x) clash = true;
          if (!clash) xs.push(x);
        }
        const gap = xs.length ? xs[Math.floor(rng.next() * xs.length)] : null;
        for (const x of xs) addPiece(K_WALL, x, L + l, lz, 1, mat, wallColor, x === gap ? 1 : 0);
      }
    }
  }
  // roof
  const top = L + lv;
  for (let x = ox; x < ox + w; x++) for (let z = oz; z < oz + d; z++) addPiece(K_FLOOR, x, top, z, 0, mat, style.roof === 'flat' ? 0x8f8f8f : floorColor);
  const roofMat = style.roof === 'flat' ? mat : 0;
  if (style.roof === 'gable' && Math.min(w, d) <= 3 && Math.min(w, d) >= 2) {
    const short = w <= d ? 'x' : 'z';
    const span = Math.min(w, d);
    for (let i = 0; i < span; i++) {
      for (let j = 0; j < (short === 'x' ? d : w); j++) {
        const x = short === 'x' ? ox + i : ox + j;
        const z = short === 'x' ? oz + j : oz + i;
        if (i === 0) addPiece(K_RAMP, x, top, z, short === 'x' ? 0 : 1, roofMat, roofColor);
        else if (i === span - 1) addPiece(K_RAMP, x, top, z, short === 'x' ? 2 : 3, roofMat, roofColor);
        else addPiece(K_FLOOR, x, top + 1, z, 0, roofMat, roofColor);
      }
    }
  } else if (style.roof === 'cone' || (style.roof === 'gable' && Math.min(w, d) < 2)) {
    for (let x = ox; x < ox + w; x++) for (let z = oz; z < oz + d; z++) addPiece(K_CONE, x, top, z, 0, roofMat, roofColor);
  }

  // loot
  const levels = hollow ? [0] : [...Array(lv).keys()];
  let chestCount = 0;
  for (const l of levels) {
    const cells = [];
    for (let x = ox; x < ox + w; x++)
      for (let z = oz; z < oz + d; z++) {
        const k = x + ',' + z + ',' + l;
        if (holes.has(k) || stairCells.has(k)) continue;
        if (l === 0 && doorCells.has(x + ',' + z)) continue;
        cells.push([x, z]);
      }
    if (!cells.length) continue;
    rng.shuffle(cells);
    const y = (L + l) * LEVEL;
    let ci = 0;
    if (rng.chance(l === 0 ? 0.6 : 0.5) || (chestCount === 0 && l === levels.length - 1)) {
      const [cx, cz] = cells[ci++];
      // push toward a perimeter wall if on the edge
      let px = 0;
      let pz = 0;
      if (cx === ox) px = -1;
      else if (cx === ox + w - 1) px = 1;
      else if (cz === oz) pz = -1;
      else if (cz === oz + d - 1) pz = 1;
      else px = 1;
      const yaw = px === 1 ? -Math.PI / 2 : px === -1 ? Math.PI / 2 : pz === 1 ? Math.PI : 0;
      chests.push({ x: cx * GRID + 2 + px * 1.1, y, z: cz * GRID + 2 + pz * 1.1, yaw });
      chestCount++;
    }
    if (ci < cells.length && rng.chance(0.35)) {
      const [cx, cz] = cells[ci++];
      boxes.push({ x: cx * GRID + 2 + rng.float(-0.8, 0.8), y, z: cz * GRID + 2 + rng.float(-0.8, 0.8), yaw: rng.chance(0.5) ? 0 : Math.PI / 2 });
    }
    for (; ci < cells.length; ci++) {
      if (!rng.chance(hollow ? 0.45 : 0.32)) continue;
      const [cx, cz] = cells[ci];
      spots.push({ x: cx * GRID + 2 + rng.float(-1, 1), y, z: cz * GRID + 2 + rng.float(-1, 1) });
    }
  }

  // navigation info for bots
  const doorsNav = doors.map((e) => {
    const [dx, dz] = DIRS[e.side];
    const mx = e.o === 0 ? e.x * GRID : e.x * GRID + 2;
    const mz = e.o === 0 ? e.z * GRID + 2 : e.z * GRID;
    return { ox: mx + dx * 2.2, oz: mz + dz * 2.2, ix: mx - dx * 1.6, iz: mz - dz * 1.6 };
  });
  const stairsNav = stairs.map((s) => {
    const [dx, dz] = DIRS[s.dir];
    return {
      l: s.l,
      bx: s.x * GRID + 2 - dx * 1.9,
      bz: s.z * GRID + 2 - dz * 1.9,
      tx: s.tx * GRID + 2 + dx * 0.6,
      tz: s.tz * GRID + 2 + dz * 0.6,
    };
  });
  return {
    x0: ox * GRID, z0: oz * GRID, x1: (ox + w) * GRID, z1: (oz + d) * GRID,
    L, levels: lv, hollow, doors: doorsNav, stairs: stairsNav, poi: poi.name,
  };
}
