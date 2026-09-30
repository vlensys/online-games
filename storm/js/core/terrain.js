// Heightfield terrain: generation + exact sampling (matches the rendered triangles).
import { fbm, ridged, smoothstep, lerp } from './rng.js';

export class Terrain {
  constructor(seg, half) {
    this.seg = seg;
    this.half = half;
    this.cell = (2 * half) / seg;
    this.n = seg + 1;
    this.h = new Float32Array(this.n * this.n);
  }

  vx(i) {
    return -this.half + i * this.cell;
  }

  get(i, j) {
    return this.h[j * this.n + i];
  }

  // Triangles per quad: (00,10,01) and (10,11,01) - diagonal from (i+1,j) to (i,j+1)
  heightAt(x, z) {
    const fx = (x + this.half) / this.cell;
    const fz = (z + this.half) / this.cell;
    if (fx < 0 || fz < 0 || fx >= this.seg || fz >= this.seg) return -18;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const n = this.n;
    const h = this.h;
    const k = j * n + i;
    if (u + v <= 1) {
      const h00 = h[k];
      return h00 + (h[k + 1] - h00) * u + (h[k + n] - h00) * v;
    }
    const h11 = h[k + n + 1];
    return h11 + (h[k + n] - h11) * (1 - u) + (h[k + 1] - h11) * (1 - v);
  }

  // Unnormalized-safe normal (returns unit vector array)
  normalAt(x, z, out = [0, 1, 0]) {
    const fx = (x + this.half) / this.cell;
    const fz = (z + this.half) / this.cell;
    if (fx < 0 || fz < 0 || fx >= this.seg || fz >= this.seg) {
      out[0] = 0;
      out[1] = 1;
      out[2] = 0;
      return out;
    }
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const n = this.n;
    const h = this.h;
    const k = j * n + i;
    const c = this.cell;
    let dx, dz;
    if (u + v <= 1) {
      dx = (h[k + 1] - h[k]) / c;
      dz = (h[k + n] - h[k]) / c;
    } else {
      dx = (h[k + n + 1] - h[k + n]) / c;
      dz = (h[k + n + 1] - h[k + 1]) / c;
    }
    const len = Math.sqrt(dx * dx + 1 + dz * dz);
    out[0] = -dx / len;
    out[1] = 1 / len;
    out[2] = -dz / len;
    return out;
  }

  // Max terrain height over an axis-aligned rectangle (sampled)
  maxOver(x0, z0, x1, z1) {
    let m = -1e9;
    const steps = 2;
    for (let a = 0; a <= steps; a++) {
      for (let b = 0; b <= steps; b++) {
        const hh = this.heightAt(x0 + ((x1 - x0) * a) / steps, z0 + ((z1 - z0) * b) / steps);
        if (hh > m) m = hh;
      }
    }
    return m;
  }

  minOver(x0, z0, x1, z1) {
    let m = 1e9;
    const steps = 2;
    for (let a = 0; a <= steps; a++) {
      for (let b = 0; b <= steps; b++) {
        const hh = this.heightAt(x0 + ((x1 - x0) * a) / steps, z0 + ((z1 - z0) * b) / steps);
        if (hh < m) m = hh;
      }
    }
    return m;
  }
}

// Base height function (before POI flattening). Pure arithmetic only (deterministic).
export function makeBaseHeight(seed, mountain) {
  return function (x, z) {
    const wx = (fbm(x * 0.003 + 11.3, z * 0.003 - 4.1, seed + 1, 3) - 0.5) * 170;
    const wz = (fbm(x * 0.003 - 7.7, z * 0.003 + 2.9, seed + 2, 3) - 0.5) * 170;
    const px = x + wx;
    const pz = z + wz;
    const d = Math.sqrt(px * px + pz * pz);
    const land = smoothstep(505, 370, d);
    let hill = fbm(x * 0.0055, z * 0.0055, seed + 3, 4);
    hill = Math.max(0, hill - 0.3) * 58;
    const small = (fbm(x * 0.03, z * 0.03, seed + 9, 2) - 0.5) * 2.2;
    let mount = 0;
    if (mountain) {
      const mdx = x - mountain.x;
      const mdz = z - mountain.z;
      const md = Math.sqrt(mdx * mdx + mdz * mdz) / mountain.r;
      if (md < 1) {
        const f = 1 - md * md;
        mount = f * f * mountain.h * (0.72 + 0.5 * ridged(x * 0.011, z * 0.011, seed + 4, 3));
      }
    }
    const hgt = 2.6 + hill + mount + small * land;
    return lerp(-16, hgt, land);
  };
}

export function fillTerrain(terrain, baseFn, flats) {
  const n = terrain.n;
  for (let j = 0; j < n; j++) {
    const z = terrain.vx(j);
    for (let i = 0; i < n; i++) {
      const x = terrain.vx(i);
      let hh = baseFn(x, z);
      for (let f = 0; f < flats.length; f++) {
        const fl = flats[f];
        const dx = x - fl.x;
        const dz = z - fl.z;
        // square-ish plateau for building footprints (Chebyshev) blended with round falloff
        const dd = fl.square ? Math.max(Math.abs(dx) - fl.hw, Math.abs(dz) - fl.hd, 0) : Math.sqrt(dx * dx + dz * dz) - fl.r;
        if (dd < fl.blend) {
          const w = smoothstep(fl.blend, 0, dd);
          hh = hh + (fl.y - hh) * w;
        }
      }
      terrain.h[j * n + i] = hh;
    }
  }
}
