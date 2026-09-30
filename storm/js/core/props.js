// Static world props (trees, rocks, cars...). Shapes are in prop-local units and scaled by
// the prop's scale `s` (offsets rotate with the prop).
// mat: material index harvested (0 wood, 1 brick, 2 metal), yield per pickaxe hit.

export const PROP_TYPES = {
  pine: {
    mat: 0, hp: 150, yield: 9, tree: true,
    shapes: [{ t: 'cyl', r: 0.38, y0: 0, y1: 9 }],
    hit: [
      { t: 'cyl', r: 0.45, y0: 0, y1: 3 },
      { t: 'cyl', r: 1.9, y0: 2.8, y1: 9.3 },
    ],
  },
  oak: {
    mat: 0, hp: 170, yield: 10, tree: true,
    shapes: [{ t: 'cyl', r: 0.45, y0: 0, y1: 7 }],
    hit: [
      { t: 'cyl', r: 0.5, y0: 0, y1: 3 },
      { t: 'cyl', r: 2.6, y0: 3, y1: 7.6 },
    ],
  },
  palm: {
    mat: 0, hp: 110, yield: 8, tree: true,
    shapes: [{ t: 'cyl', r: 0.32, y0: 0, y1: 8 }],
    hit: [
      { t: 'cyl', r: 0.36, y0: 0, y1: 7 },
      { t: 'cyl', r: 2.2, y0: 7, y1: 8.8 },
    ],
  },
  rock: {
    mat: 1, hp: 300, yield: 11,
    shapes: [{ t: 'cyl', r: 1.45, y0: -0.4, y1: 1.7, stand: true }],
  },
  bush: {
    mat: -1, hp: 40, yield: 0, bush: true,
    shapes: [],
    hit: [],
    hideR: 1.3,
  },
  car: {
    mat: 2, hp: 320, yield: 12,
    shapes: [{ t: 'box', hx: 1.05, hz: 2.15, y0: 0, y1: 1.55, stand: true }],
  },
  container: {
    mat: 2, hp: 520, yield: 14,
    shapes: [{ t: 'box', hx: 1.3, hz: 3.1, y0: 0, y1: 2.75, stand: true }],
  },
  crate: {
    mat: 0, hp: 110, yield: 8,
    shapes: [{ t: 'box', hx: 0.75, hz: 0.75, y0: 0, y1: 1.5, stand: true }],
  },
  hay: {
    mat: 0, hp: 90, yield: 6,
    shapes: [{ t: 'cyl', r: 0.95, y0: 0, y1: 1.5, stand: true }],
  },
  lighthouse: {
    mat: -1, hp: Infinity, yield: 0, landmark: true,
    shapes: [
      { t: 'cyl', r: 3.3, y0: -1, y1: 24, stand: true },
      { t: 'cyl', r: 2.2, y0: 24, y1: 30, stand: true },
    ],
  },
  windmill: {
    mat: -1, hp: Infinity, yield: 0, landmark: true,
    shapes: [{ t: 'cyl', r: 3.2, y0: -1, y1: 16, stand: true }],
  },
  watertower: {
    mat: -1, hp: Infinity, yield: 0, landmark: true,
    shapes: [
      { t: 'cyl', r: 4.3, y0: 11, y1: 17.5, stand: true },
      { t: 'cyl', r: 0.35, x: 3, z: 3, y0: -1, y1: 11 },
      { t: 'cyl', r: 0.35, x: -3, z: 3, y0: -1, y1: 11 },
      { t: 'cyl', r: 0.35, x: 3, z: -3, y0: -1, y1: 11 },
      { t: 'cyl', r: 0.35, x: -3, z: -3, y0: -1, y1: 11 },
    ],
  },
  radiotower: {
    mat: -1, hp: Infinity, yield: 0, landmark: true,
    shapes: [{ t: 'box', hx: 1.6, hz: 1.6, y0: -1, y1: 34 }],
  },
};

export const PROP_LIST = Object.keys(PROP_TYPES);

// Build world-space shapes for a prop instance
export function propShapes(p, which = 'shapes') {
  const def = PROP_TYPES[p.type];
  const src = (which === 'hit' && def.hit) || def.shapes;
  const s = p.s || 1;
  const c = Math.cos(p.rot || 0);
  const sn = Math.sin(p.rot || 0);
  const out = [];
  for (const sh of src) {
    const ox = (sh.x || 0) * s;
    const oz = (sh.z || 0) * s;
    const wx = p.x + ox * c + oz * sn;
    const wz = p.z - ox * sn + oz * c;
    const o = {
      t: sh.t,
      x: wx,
      z: wz,
      y0: p.y + sh.y0 * s,
      y1: p.y + sh.y1 * s,
      stand: !!sh.stand,
    };
    if (sh.t === 'cyl') o.r = sh.r * s;
    else {
      o.hx = sh.hx * s;
      o.hz = sh.hz * s;
      o.c = c;
      o.sn = sn;
      o.r = Math.sqrt(o.hx * o.hx + o.hz * o.hz);
    }
    out.push(o);
  }
  return out;
}
