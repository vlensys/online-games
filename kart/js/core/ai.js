// Computer drivers: follow the racing line a little ahead, ease off for corners they can't take
// flat out, drift through the long bends for mini-turbos, go for item boxes, dodge oil and use
// their items sensibly. Engine class sets how sharp they are.
import { trackPoint } from './trackgeo.js';

export function initBot(k, race) {
  const r = race.rng;
  const c = race.cls;
  k.ai = {
    bias: r.range(-2.2, 2.2),
    skill: c.ai * r.range(0.97, 1.02),
    lineK: c.aiLine,
    miss: c.aiMiss,
    noise: 0,
    holdT: 0,
    useAt: r.range(0.6, 2.5),
    releaseLv: r() < c.ai - 0.15 ? 2 : 1,
    revT: 0,
    stuckT: 0,
    lastD: 0,
    wobble: r.range(0, 6),
  };
}

const _p = {};

export function botThink(k, race, dt) {
  const T = race.T,
    A = k.ai,
    L = k.loc,
    inp = k.in;
  const v = Math.max(0, k.vf);
  const fi = L.i + L.t;
  // where to aim: the racing line a bit ahead, shifted for boxes, oil and karts in the way
  const la = 7 + v * 0.42;
  const ai = fi + la / T.sp;
  const ii = Math.floor(ai) % T.n;
  const hw = T.hw[ii];
  let want = T.line[ii] * A.lineK + A.bias * (1 - Math.min(1, Math.abs(T.kap[ii]) * 40));
  A.wobble += dt * 0.4;
  want += Math.sin(A.wobble) * 1.2;
  if (!k.item && k.rollT <= 0 && race.boxes.length) {
    const b = nearestBox(race.boxes, T, fi, k.loc.d);
    if (b) want = b.d;
  }
  for (const o of race.oils) {
    const q = aheadOf(T, fi, o.x, o.z, o, race);
    if (q && q.ds > 0 && q.ds < 30 && Math.abs(q.d - want) < 3) want = q.d + (q.d > 0 ? -3.5 : 3.5);
  }
  for (const o of race.karts) {
    if (o === k) continue;
    const q = aheadOf(T, fi, o.x, o.z, o, race);
    if (q && q.ds > 1 && q.ds < 12 && Math.abs(q.d - want) < 2.4 && o.vf < k.vf + 1) want = q.d + (q.d > want ? -2.8 : 2.8);
  }
  want = Math.max(-hw + 1.6, Math.min(hw - 1.6, want));
  trackPoint(T, ai, want, _p);
  const dx = _p.x - k.x,
    dz = _p.z - k.z;
  const fw = dx * Math.sin(k.yaw) + dz * Math.cos(k.yaw);
  const rt = -dx * Math.cos(k.yaw) + dz * Math.sin(k.yaw);
  const err = Math.atan2(rt, fw);
  // a little imprecision, more in the slower classes
  A.noise += ((Math.random() - 0.5) * A.miss * 40 - A.noise * 2) * dt;
  let steer = (k.drift ? err * 3 : err * 2.4) + A.noise;

  // speed for the corner coming up
  const vmax = T.vmax[Math.floor(fi + 2) % T.n] * A.skill;
  let gas = k.vf < vmax ? 1 : 0;
  let brake = k.vf > vmax + 4 ? 1 : 0;
  if (Math.abs(err) > 1.2 && v > 12) {
    gas = 0;
    brake = 1;
  }

  // drift through long bends
  let kav = 0;
  for (let m = 2; m <= 12; m++) kav += T.kap[Math.floor(fi + m) % T.n];
  kav /= 11;
  const bend = Math.abs(kav);
  let drift = false;
  if (k.drift) {
    const same = Math.sign(kav) === -k.drift; // left bend (+) means a left drift (-1)
    drift = same && bend > 0.008 && !(k.driftLevel >= A.releaseLv && bend < 0.014) && !(steer * k.drift < -0.85);
  } else if (bend > 0.016 && v > 14 && k.grounded && race.state === 'race') {
    drift = true;
    steer = -Math.sign(kav);
  } else if (k.driftPending) drift = true;

  // stuck against something: back up and turn
  if (race.state === 'race' && gas && Math.abs(k.vf) < 1.5 && k.spinT <= 0) A.stuckT += dt;
  else A.stuckT = Math.max(0, A.stuckT - dt);
  if (A.stuckT > 1.2) {
    A.revT = 0.9;
    A.stuckT = 0;
  }
  if (A.revT > 0) {
    A.revT -= dt;
    gas = 0;
    brake = 1;
    steer = -Math.sign(err || 1);
    drift = false;
  }
  inp.steer = Math.max(-1, Math.min(1, steer));
  inp.gas = gas;
  inp.brake = brake;
  inp.drift = drift;
  inp.item = false;
  inp.back = false;
  if (k.item && k.rollT <= 0 && race.state === 'race') botItems(k, race, dt, bend);
}

function botItems(k, race, dt, bend) {
  const A = k.ai,
    inp = k.in,
    T = race.T;
  A.holdT += dt;
  if (A.holdT < A.useAt) return;
  const fi = k.loc.i + k.loc.t;
  let use = false;
  switch (k.item) {
    case 'nitro':
    case 'nitro3':
      use = (bend < 0.006 && !k.offroad) || k.offroad || A.holdT > 8;
      break;
    case 'rocket': {
      for (const o of race.karts) {
        if (o === k) continue;
        const q = aheadOf(T, fi, o.x, o.z, o, race);
        if (q && q.ds > 4 && q.ds < 45 && Math.abs(q.d - k.loc.d) < 2.5 && bend < 0.01) use = true;
        if (q && q.ds < -3 && q.ds > -15 && k.place === 1) {
          use = true;
          inp.back = true;
        }
      }
      if (A.holdT > 10) use = true;
      break;
    }
    case 'homing':
      use = k.place > 1 || A.holdT > 6;
      break;
    case 'oil': {
      for (const o of race.karts) {
        if (o === k) continue;
        const q = aheadOf(T, fi, o.x, o.z, o, race);
        if (q && q.ds < -2 && q.ds > -25) use = true;
      }
      if (A.holdT > 7) use = true;
      break;
    }
    case 'shield':
      use = race.proj.some((p) => p.owner !== k.id && Math.hypot(p.x - k.x, p.z - k.z) < 30) || A.holdT > 5;
      break;
    case 'emp':
      use = true;
      break;
  }
  if (use) {
    inp.item = true;
    A.holdT = 0;
    A.useAt = k.item === 'nitro3' ? 1.4 : race.rng.range(0.6, 2.5);
  }
}

// where is a point relative to the track position `fi`: distance ahead along the track, offset
function aheadOf(T, fi, x, z, o) {
  if (!o.loc || o.loc.i === undefined) return null;
  let ds = (o.loc.i + o.loc.t - fi) * T.sp;
  if (ds > T.len / 2) ds -= T.len;
  if (ds < -T.len / 2) ds += T.len;
  return { ds, d: o.loc.d };
}

// the closest box (sideways) in the next row of boxes 8-45 m ahead
function nearestBox(boxes, T, fi, d) {
  let row = Infinity,
    best = null;
  for (const b of boxes) {
    let ds = (b.i - fi) * T.sp;
    if (ds < -T.len / 2) ds += T.len;
    if (ds < 8 || ds > 45) continue;
    if (ds < row - 1) {
      row = ds;
      best = null;
    }
    if (ds > row + 1 || !b.alive) continue;
    const bd = boxD(T, b);
    if (!best || Math.abs(bd - d) < Math.abs(best.d - d)) best = { ds, d: bd };
  }
  return best;
}

function boxD(T, b) {
  if (b.d === undefined) b.d = (b.x - T.px[b.i]) * T.rx[b.i] + (b.z - T.pz[b.i]) * T.rz[b.i];
  return b.d;
}
