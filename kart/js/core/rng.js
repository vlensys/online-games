// Small seeded random generator (mulberry32) so a race can be replayed / shared online.
export function makeRng(seed) {
  let a = seed >>> 0 || 1;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + r() * (hi - lo);
  r.int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.weighted = (obj) => {
    let tot = 0;
    for (const k in obj) tot += obj[k];
    let x = r() * tot;
    for (const k in obj) {
      x -= obj[k];
      if (x <= 0) return k;
    }
    return Object.keys(obj)[0];
  };
  return r;
}
