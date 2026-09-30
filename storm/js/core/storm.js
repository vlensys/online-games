// Storm circle plan (made by the host) and its evaluation at any time (host + clients).
import { STORM_PHASES, STORM_START_R } from './config.js';

export function makeStormPlan(rng, map, speedMul, t0) {
  const circles = [{ x: 0, z: 0, r: STORM_START_R }];
  const phases = STORM_PHASES.map((p) => ({ wait: p.wait * speedMul, shrink: p.shrink * speedMul, dmg: p.dmg }));
  const T = map.terrain;
  for (let i = 0; i < STORM_PHASES.length; i++) {
    const prev = circles[i];
    const nr = STORM_PHASES[i].r;
    const maxOff = i === 0 ? 150 : Math.max(0, prev.r - nr);
    let best = null;
    for (let k = 0; k < 60 && !best; k++) {
      const ox = rng.float(-maxOff, maxOff);
      const oz = rng.float(-maxOff, maxOff);
      if (ox * ox + oz * oz > maxOff * maxOff) continue;
      const x = prev.x + ox;
      const z = prev.z + oz;
      const h = T.heightAt(x, z);
      if (h < 1.2 || h > 90) continue;
      // keep the circle mostly on land for the later phases
      if (nr > 20) {
        let land = 0;
        const pts = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7]];
        for (const [px, pz] of pts) if (T.heightAt(x + px * nr * 0.7, z + pz * nr * 0.7) > 0.5) land++;
        if (land < 6 && k < 45) continue;
      }
      best = { x, z, r: nr };
    }
    if (!best) best = { x: prev.x * 0.8, z: prev.z * 0.8, r: nr };
    circles.push(best);
  }
  return { t0, circles, phases };
}

// Returns a fresh state object (or fills `o`)
export function stormState(plan, t, o = {}) {
  const c = plan.circles;
  o.started = t >= plan.t0;
  let tt = t - plan.t0;
  if (tt < 0) {
    o.phase = 0;
    o.shrinking = false;
    o.cx = c[0].x;
    o.cz = c[0].z;
    o.r = c[0].r;
    o.nx = c[1].x;
    o.nz = c[1].z;
    o.nr = c[1].r;
    o.tLeft = plan.phases[0].wait - tt;
    o.dmg = 0;
    o.done = false;
    return o;
  }
  for (let i = 0; i < plan.phases.length; i++) {
    const p = plan.phases[i];
    const a = c[i];
    const b = c[i + 1];
    o.phase = i;
    o.dmg = p.dmg;
    o.nx = b.x;
    o.nz = b.z;
    o.nr = b.r;
    if (tt < p.wait) {
      o.shrinking = false;
      o.cx = a.x;
      o.cz = a.z;
      o.r = a.r;
      o.tLeft = p.wait - tt;
      o.done = false;
      return o;
    }
    tt -= p.wait;
    if (tt < p.shrink) {
      const f = tt / p.shrink;
      o.shrinking = true;
      o.cx = a.x + (b.x - a.x) * f;
      o.cz = a.z + (b.z - a.z) * f;
      o.r = a.r + (b.r - a.r) * f;
      o.tLeft = p.shrink - tt;
      o.done = false;
      return o;
    }
    tt -= p.shrink;
  }
  const last = c[c.length - 1];
  o.phase = plan.phases.length - 1;
  o.shrinking = false;
  o.cx = last.x;
  o.cz = last.z;
  o.r = last.r;
  o.nx = last.x;
  o.nz = last.z;
  o.nr = last.r;
  o.tLeft = 0;
  o.dmg = plan.phases[plan.phases.length - 1].dmg + 3;
  o.done = true;
  return o;
}

export function outsideStorm(s, x, z) {
  const dx = x - s.cx;
  const dz = z - s.cz;
  return dx * dx + dz * dz > s.r * s.r;
}
