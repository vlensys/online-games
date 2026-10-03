// Track geometry, shared by the simulation and the renderer (plain numbers, no three.js).
// A track is written as a "turtle" program of straights and turns; it is sampled every SP metres
// into a centre line with a tangent, a right vector, road half-width, barrier distance, height and
// curvature, plus the racing line and corner speeds the bots use.
import { TRACKS } from './tracks.js';

export const SP = 2; // metres between samples
const D2R = Math.PI / 180;
const ALAT = 34; // lateral grip the bots plan corners with (m/s²)
const BRAKE = 20; // and their braking (m/s²)

function cmdOpts(c) {
  return (c[0] === 'S' ? c[2] : c[3]) || {};
}

// trace the program into a dense polyline (0.5 m steps)
function trace(prog, lens) {
  let x = 0,
    z = 0,
    yaw = 0,
    s = 0,
    y = 0;
  const pts = [{ x, z, s, y }];
  const feats = [];
  const dirs = [];
  prog.forEach((c, ci) => {
    const o = cmdOpts(c);
    let L, r, turn;
    if (c[0] === 'S') {
      L = lens[ci] ?? c[1];
      turn = 0;
    } else {
      r = c[2];
      L = c[1] * D2R * r;
      turn = c[0] === 'L' ? 1 : -1;
    }
    dirs[ci] = yaw;
    const s0 = s,
      y0 = y,
      dy = o.dy || 0;
    for (const f of o.items || []) feats.push({ kind: 'items', s: s0 + f * L });
    for (const p of o.pads || []) feats.push({ kind: 'pad', s: s0 + p[0] * L, d: p[1] });
    if (o.jump) feats.push({ kind: 'jump', s: s0 + (o.jump.at ?? 0.3) * L, len: o.jump.len, h: o.jump.h });
    if (o.w) feats.push({ kind: 'w', s: s0, w: o.w });
    const n = Math.max(1, Math.ceil(L / 0.5));
    const ds = L / n;
    for (let k = 1; k <= n; k++) {
      const half = turn ? (turn * ds) / r / 2 : 0;
      yaw += half;
      x += Math.sin(yaw) * ds;
      z += Math.cos(yaw) * ds;
      yaw += half;
      s += ds;
      y = y0 + (dy * k) / n;
      pts.push({ x, z, s, y });
    }
  });
  return { pts, feats, dirs, len: s, end: { x, z, y, yaw } };
}

function smoothRing(a, rad, passes) {
  const n = a.length;
  let src = Float32Array.from(a);
  for (let p = 0; p < passes; p++) {
    const dst = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -rad; k <= rad; k++) sum += src[(i + k + n) % n];
      dst[i] = sum / (2 * rad + 1);
    }
    src = dst;
  }
  return src;
}

const cache = new Map();
export function getTrack(id) {
  if (!cache.has(id)) cache.set(id, buildTrack(TRACKS.find((t) => t.id === id) || TRACKS[0]));
  return cache.get(id);
}

export function buildTrack(def) {
  const prog = def.prog;
  // close the loop: stretch the "auto" straights (least squares) so the path ends where it started
  const lens = {};
  let tr = trace(prog, lens);
  const autos = prog.map((c, i) => (c[0] === 'S' && cmdOpts(c).auto ? i : -1)).filter((i) => i >= 0);
  for (let iter = 0; iter < 4 && autos.length >= 2; iter++) {
    const free = autos.filter((i) => (lens[i] ?? prog[i][1]) > 12.01 || iter === 0);
    if (free.length < 2) break;
    // minimise the sum of squared stretches subject to closing the gap: d = -Dᵀ (D Dᵀ)⁻¹ E
    let a11 = 0,
      a12 = 0,
      a22 = 0;
    for (const i of free) {
      const dx = Math.sin(tr.dirs[i]),
        dz = Math.cos(tr.dirs[i]);
      a11 += dx * dx;
      a12 += dx * dz;
      a22 += dz * dz;
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-3) break;
    const ex = tr.end.x,
      ez = tr.end.z;
    const lx = (a22 * ex - a12 * ez) / det,
      lz = (-a12 * ex + a11 * ez) / det;
    for (const i of free) lens[i] = Math.max(12, (lens[i] ?? prog[i][1]) - (Math.sin(tr.dirs[i]) * lx + Math.cos(tr.dirs[i]) * lz));
    tr = trace(prog, lens);
    if (Math.hypot(tr.end.x, tr.end.z) < 0.05) break;
  }
  const { pts, feats, len } = tr;
  const closeErr = Math.hypot(tr.end.x, tr.end.z);
  // spread what is left of the closing error (and the height error) along the lap
  for (const p of pts) {
    const u = p.s / len;
    p.x -= tr.end.x * u;
    p.z -= tr.end.z * u;
    p.y -= tr.end.y * u;
  }
  // resample every SP metres
  const n = Math.round(len / SP);
  const sp = len / n;
  const px = new Float32Array(n),
    pz = new Float32Array(n);
  let py = new Float32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = i * sp;
    while (j < pts.length - 2 && pts[j + 1].s < s) j++;
    const a = pts[j],
      b = pts[j + 1];
    const u = (s - a.s) / (b.s - a.s || 1);
    px[i] = a.x + (b.x - a.x) * u;
    pz[i] = a.z + (b.z - a.z) * u;
    py[i] = a.y + (b.y - a.y) * u;
  }
  py = smoothRing(py, 10, 3);
  // widths
  let hw = new Float32Array(n).fill(def.width / 2);
  for (const f of feats.filter((f) => f.kind === 'w').sort((p, q) => p.s - q.s)) for (let i = Math.floor(f.s / sp); i < n; i++) hw[i] = f.w / 2;
  hw = smoothRing(hw, 8, 3);
  const shoulder = def.shoulder ?? 6;
  const lim = new Float32Array(n);
  for (let i = 0; i < n; i++) lim[i] = hw[i] + shoulder;
  // jump ramps
  const ramp = new Uint8Array(n);
  const jumps = [];
  for (const f of feats.filter((f) => f.kind === 'jump')) {
    const i0 = Math.round(f.s / sp),
      m = Math.round(f.len / sp);
    for (let k = 0; k <= m; k++) {
      const i = (i0 + k) % n;
      py[i] += f.h * (k / m);
      ramp[i] = k === m ? 2 : 1;
    }
    jumps.push({ i0, i1: (i0 + m) % n, h: f.h });
  }
  // tangents, right vectors, curvature
  const tx = new Float32Array(n),
    tz = new Float32Array(n),
    rx = new Float32Array(n),
    rz = new Float32Array(n),
    yaw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n,
      b = (i + 1) % n;
    let dx = px[b] - px[a],
      dz = pz[b] - pz[a];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    tx[i] = dx;
    tz[i] = dz;
    rx[i] = -dz;
    rz[i] = dx;
    yaw[i] = Math.atan2(dx, dz);
  }
  let kap = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let d = yaw[(i + 1) % n] - yaw[(i - 1 + n) % n];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    kap[i] = d / (2 * sp); // + = left
  }
  kap = smoothRing(kap, 2, 2);
  // racing line: towards the inside of what is coming up, then smoothed
  let line = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (let m = -4; m <= 14; m++) {
      const v = kap[(i + m + n) % n];
      if (Math.abs(v) > Math.abs(k)) k = v;
    }
    line[i] = -Math.sign(k) * Math.min(1, Math.abs(k) * 30) * Math.max(0, hw[i] - 3.2);
  }
  line = smoothRing(line, 8, 4);
  // corner speeds, then how early you have to brake for them
  const vmax = new Float32Array(n);
  for (let i = 0; i < n; i++) vmax[i] = Math.min(60, Math.sqrt(ALAT / Math.max(Math.abs(kap[i]), 1e-4)));
  for (let pass = 0; pass < 2; pass++)
    for (let i = n - 1; i >= 0; i--) {
      const nx = vmax[(i + 1) % n];
      vmax[i] = Math.min(vmax[i], Math.sqrt(nx * nx + 2 * BRAKE * sp));
    }
  // item box rows and boost pads
  const items = feats
    .filter((f) => f.kind === 'items')
    .map((f) => {
      const i = Math.round(f.s / sp) % n;
      const w = hw[i];
      const cnt = w > 10 ? 5 : 4;
      const ds = [];
      for (let k = 0; k < cnt; k++) ds.push(-w + 2.6 + ((2 * w - 5.2) * k) / (cnt - 1));
      return { i, ds };
    });
  const pads = feats.filter((f) => f.kind === 'pad').map((f) => ({ i: Math.round(f.s / sp) % n, d: f.d }));
  // bounds
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    limMax = 0;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, px[i]);
    maxX = Math.max(maxX, px[i]);
    minZ = Math.min(minZ, pz[i]);
    maxZ = Math.max(maxZ, pz[i]);
    minY = Math.min(minY, py[i]);
    maxY = Math.max(maxY, py[i]);
    limMax = Math.max(limMax, lim[i]);
  }
  return { def, id: def.id, autoLens: lens, n, sp, len: n * sp, px, py, pz, tx, tz, rx, rz, yaw, hw, lim, kap, ramp, jumps, line, vmax, items, pads, closeErr, bounds: { minX, maxX, minZ, maxZ, minY, maxY }, limMax };
}

// Where is (x, y, z) on the track? Searches near sample `hint` (pass -1 to search everywhere).
// Fills `out` with the segment, its fraction, distance along the lap, lateral offset (+ = right),
// ground height and the local frame.
export function locate(T, x, y, z, hint, out = {}) {
  const n = T.n;
  let best = -1,
    bd = Infinity;
  const scan = (from, to) => {
    for (let k = from; k <= to; k++) {
      const j = (k + n) % n;
      const dx = x - T.px[j],
        dz = z - T.pz[j],
        dy = y - T.py[j];
      const d = dx * dx + dz * dz + dy * dy * 0.3;
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
  };
  if (hint >= 0) scan(hint - 16, hint + 16);
  if (hint < 0 || bd > (T.limMax + 20) ** 2) {
    bd = Infinity;
    scan(0, n - 1);
  }
  let i = best;
  const proj = (a) => {
    const b = (a + 1) % n;
    const sx = T.px[b] - T.px[a],
      sz = T.pz[b] - T.pz[a];
    return ((x - T.px[a]) * sx + (z - T.pz[a]) * sz) / (sx * sx + sz * sz);
  };
  let t = proj(i);
  if (t < 0) {
    i = (i - 1 + n) % n;
    t = proj(i);
  }
  t = Math.min(1, Math.max(0, t));
  const j = (i + 1) % n;
  const bx = T.px[i] + (T.px[j] - T.px[i]) * t,
    bz = T.pz[i] + (T.pz[j] - T.pz[i]) * t;
  let rxv = T.rx[i] + (T.rx[j] - T.rx[i]) * t,
    rzv = T.rz[i] + (T.rz[j] - T.rz[i]) * t;
  const rl = Math.hypot(rxv, rzv) || 1;
  rxv /= rl;
  rzv /= rl;
  out.i = i;
  out.t = t;
  out.s = (i + t) * T.sp;
  out.d = (x - bx) * rxv + (z - bz) * rzv;
  out.gy = T.py[i] + (T.py[j] - T.py[i]) * t;
  out.hw = T.hw[i] + (T.hw[j] - T.hw[i]) * t;
  out.lim = T.lim[i] + (T.lim[j] - T.lim[i]) * t;
  out.rx = rxv;
  out.rz = rzv;
  out.tx = rzv;
  out.tz = -rxv;
  out.ramp = T.ramp[i];
  return out;
}

// a point on the track from (sample index or fraction, lateral offset)
export function trackPoint(T, fi, d, out = {}) {
  const n = T.n;
  const i0 = Math.floor(fi);
  const t = fi - i0;
  const i = ((i0 % n) + n) % n,
    j = (i + 1) % n;
  out.x = T.px[i] + (T.px[j] - T.px[i]) * t + (T.rx[i] + (T.rx[j] - T.rx[i]) * t) * d;
  out.z = T.pz[i] + (T.pz[j] - T.pz[i]) * t + (T.rz[i] + (T.rz[j] - T.rz[i]) * t) * d;
  out.y = T.py[i] + (T.py[j] - T.py[i]) * t;
  out.yaw = Math.atan2(T.tx[i], T.tz[i]);
  return out;
}

// the starting grid: two staggered columns behind the line
export function gridSlot(T, k) {
  const row = Math.floor(k / 2),
    col = k % 2;
  const s = T.len - 9 - row * 7 - col * 3.5;
  return { fi: s / T.sp, d: (col ? 1 : -1) * Math.min(4, T.hw[0] - 2.5) };
}
