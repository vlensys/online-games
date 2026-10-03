// Arcade kart physics. A kart keeps a horizontal velocity that grip pulls towards where it is
// pointing (so it slides when grip is low: drifting, off-road, in the air), a forward engine,
// and a vertical velocity for hops and jumps. The track is a corridor: road, then rough ground,
// then a barrier, all at the height of the centre line.
import { GRAVITY, BOOST, DRIFT_LEVELS, statFactors, driverById } from './config.js';
import { locate } from './trackgeo.js';

export function makeKart(id, driverId, ctrl, cls, name) {
  const drv = driverById(driverId);
  const f = statFactors(drv);
  return {
    id,
    driver: drv.id,
    name: name || drv.name,
    ctrl, // 'player' | 'bot' | 'remote'
    human: ctrl !== 'bot',
    top: cls.top * f.top,
    accel: cls.accel * f.accel,
    turn: 2.3 * f.turn,
    grip: f.grip,
    mass: f.mass,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    vx: 0,
    vz: 0,
    vy: 0,
    vf: 0,
    gy: 0,
    grounded: true,
    air: 0,
    offroad: false,
    drift: 0,
    driftCharge: 0,
    driftLevel: 0,
    driftPending: false,
    hopT: 0,
    boostT: 0,
    boostP: 1,
    spinT: 0,
    spinAng: 0,
    shieldT: 0,
    trick: 0,
    canTrick: 0,
    item: null,
    itemN: 0,
    rollT: 0,
    in: { steer: 0, gas: 0, brake: 0, drift: false, item: false, back: false },
    prevDrift: false,
    prevItem: false,
    loc: {},
    hint: -1,
    lap: 0,
    s: 0,
    half: true,
    prog: 0,
    finished: false,
    finishT: 0,
    place: 1,
    lapTimes: [],
    lapStart: 0,
    wrongT: 0,
    rb: 1,
    stuckT: 0,
    revT: 0,
    bonk: 0,
    steerVis: 0,
    wheelRot: 0,
    startCharge: 0,
  };
}

// put a kart on the track at sample fraction fi, lateral offset d, facing along the track
export function placeKart(k, T, pt) {
  k.x = pt.x;
  k.z = pt.z;
  k.y = pt.y;
  k.gy = pt.y;
  k.yaw = pt.yaw;
  k.vx = k.vz = k.vy = k.vf = 0;
  k.grounded = true;
  k.hint = -1;
  locate(T, k.x, k.y, k.z, -1, k.loc);
  k.hint = k.loc.i;
  k.s = k.loc.s;
}

export function giveBoost(k, b) {
  k.boostP = k.boostT > 0 ? Math.max(k.boostP, b.p) : b.p;
  k.boostT = Math.max(k.boostT, b.t);
}

// one physics step. `ev` collects events for sound/effects: [type, kart, extra]
export function kartStep(k, T, dt, race, ev) {
  const inp = k.in;
  const ctl = race.state === 'race' && k.spinT <= 0;
  const steer = ctl ? inp.steer : 0;
  const gas = ctl ? inp.gas : 0;
  const brake = ctl ? inp.brake : 0;

  const fx = Math.sin(k.yaw),
    fz = Math.cos(k.yaw);
  const rx = -fz,
    rz = fx;
  let vf = k.vx * fx + k.vz * fz;
  let vr = k.vx * rx + k.vz * rz;
  const L = k.loc;
  k.offroad = Math.abs(L.d) > L.hw + 0.2;

  if (k.boostT > 0) k.boostT -= dt;
  if (k.shieldT > 0) k.shieldT -= dt;
  if (k.bonk > 0) k.bonk -= dt;
  const boosting = k.boostT > 0;
  let top = k.top * k.rb * (boosting ? k.boostP : 1);
  if (k.offroad && !boosting) top *= T.def.offroad ?? 0.5;

  // engine, brakes, drag
  if (k.grounded) {
    if (boosting) vf = Math.min(top, vf + k.accel * 3 * dt);
    else if (gas > 0 && vf < top) vf = Math.min(top, vf + gas * k.accel * 1.5 * Math.max(0.1, 1 - vf / top) * dt);
    if (vf > top) vf = Math.max(top, vf - (k.offroad ? 34 : 9) * dt);
    if (brake > 0) {
      if (vf > 0.5) vf -= 30 * brake * dt;
      else vf = Math.max(-9, vf - 14 * brake * dt);
    } else if (gas <= 0 && !boosting) {
      vf -= (vf * 0.5 + Math.sign(vf) * 1.5) * dt;
      if (Math.abs(vf) < 0.2) vf = 0;
    }
  } else vf -= vf * 0.05 * dt;

  // spin-out: the kart keeps sliding where it was going while it turns round on the spot
  if (k.spinT > 0) {
    k.spinT -= dt;
    vf *= Math.exp(-2.4 * dt);
    vr *= Math.exp(-2.4 * dt);
    k.spinAng += 13 * dt;
    if (k.spinT <= 0) k.spinAng = 0;
    k.drift = 0;
  }

  // drifting: hop, then (still holding drift and steering) slide round, charging a mini-turbo
  const driftPress = inp.drift && !k.prevDrift;
  k.prevDrift = inp.drift;
  if (ctl && driftPress && k.grounded) {
    k.vy = 4.2;
    k.grounded = false;
    k.hopT = 0.3;
    k.driftPending = vf > 6;
    ev.push(['hop', k]);
  } else if (ctl && driftPress && !k.grounded && k.canTrick > 0) {
    k.trick = 1;
    k.canTrick = 0;
    ev.push(['trick', k]);
  }
  if (k.hopT > 0) k.hopT -= dt;
  if (k.driftPending && k.grounded) {
    k.driftPending = false;
    if (inp.drift && Math.abs(steer) > 0.25 && vf > 9) {
      k.drift = Math.sign(steer);
      k.driftCharge = 0;
      k.driftLevel = 0;
      ev.push(['drift', k]);
    }
  }
  if (k.drift) {
    if (!inp.drift || vf < 7 || !ctl) {
      if (k.driftLevel > 0 && ctl) {
        giveBoost(k, BOOST.mini[k.driftLevel]);
        ev.push(['mini', k, k.driftLevel]);
      }
      k.drift = 0;
      k.driftLevel = 0;
      k.driftCharge = 0;
    } else if (k.grounded) {
      k.driftCharge += dt * (0.55 + 0.75 * Math.max(0, steer * k.drift)) * (k.offroad ? 0.4 : 1);
      const lv = k.driftCharge >= DRIFT_LEVELS[3] ? 3 : k.driftCharge >= DRIFT_LEVELS[2] ? 2 : k.driftCharge >= DRIFT_LEVELS[1] ? 1 : 0;
      if (lv > k.driftLevel) ev.push(['charge', k, lv]);
      k.driftLevel = lv;
    }
  }

  // steering
  const sf = Math.min(1, Math.abs(vf) / 5);
  let yawRate;
  if (k.drift) yawRate = k.drift * k.turn * (0.55 + 0.5 * steer * k.drift) * sf;
  else yawRate = steer * k.turn * (1 - 0.3 * Math.min(1, Math.abs(vf) / k.top)) * sf * (vf < -0.5 ? -1 : 1);
  if (!k.grounded) yawRate *= 0.55;
  if (k.spinT > 0) yawRate = 0;

  // grip pulls the velocity round to where the kart points
  const grip = !k.grounded ? 0.35 : k.drift ? 3.2 : k.offroad ? 6 : 10 * k.grip;
  vr *= Math.exp(-grip * dt);
  // sliding sideways never adds speed
  if (k.grounded) {
    const sp = Math.hypot(vf, vr);
    const cap = Math.max(top, Math.abs(k.vf));
    if (sp > cap) {
      vf *= cap / sp;
      vr *= cap / sp;
    }
  }
  k.vx = fx * vf + rx * vr;
  k.vz = fz * vf + rz * vr;
  k.vf = vf;
  k.yaw -= yawRate * dt;
  k.steerVis += (steer - k.steerVis) * Math.min(1, dt * 10);
  k.wheelRot += (vf * dt) / 0.32;

  // move, then find the ground under the new spot
  k.x += k.vx * dt;
  k.z += k.vz * dt;
  const prevGy = k.gy;
  const wasRamp = L.ramp;
  locate(T, k.x, k.y, k.z, k.hint, L);
  k.hint = L.i;
  k.gy = L.gy;
  k.vy -= GRAVITY * dt;
  k.y += k.vy * dt;
  if (k.y <= L.gy) {
    k.y = L.gy;
    if (!k.grounded) {
      if (k.air > 0.35) ev.push(['land', k, k.air]);
      if (k.trick && k.spinT <= 0) {
        giveBoost(k, BOOST.trick);
        ev.push(['trickboost', k]);
      }
      k.trick = 0;
      k.canTrick = 0;
    }
    k.grounded = true;
    k.air = 0;
    k.vy = Math.max(k.vy, (L.gy - prevGy) / dt);
  } else {
    if (k.grounded && wasRamp && k.vy > 0.5) k.canTrick = 0.5; // launched off a ramp: press hop for a trick
    k.grounded = false;
    k.air += dt;
    if (k.canTrick > 0) k.canTrick -= dt;
  }

  // the barriers
  const lim = L.lim - 0.95;
  if (Math.abs(L.d) > lim) {
    const sg = Math.sign(L.d);
    const pen = Math.abs(L.d) - lim;
    k.x -= L.rx * sg * pen;
    k.z -= L.rz * sg * pen;
    const vn = (k.vx * L.rx + k.vz * L.rz) * sg;
    if (vn > 0) {
      k.vx -= L.rx * sg * vn * 1.4;
      k.vz -= L.rz * sg * vn * 1.4;
      const scrape = 1 - Math.min(0.35, vn * 0.025);
      k.vx *= scrape;
      k.vz *= scrape;
      if (vn > 5 && k.bonk <= 0) {
        k.bonk = 0.3;
        ev.push(['bonk', k, vn]);
        if (vn > 9) {
          k.drift = 0;
          k.driftLevel = 0;
        }
      }
    }
    // nudge the nose away from the wall so you don't grind along it
    const tdot = Math.sin(k.yaw) * L.tx + Math.cos(k.yaw) * L.tz;
    if (tdot > 0) {
      const into = (Math.sin(k.yaw) * L.rx + Math.cos(k.yaw) * L.rz) * sg;
      if (into > 0) k.yaw += sg * into * 1.5 * dt * (vn > 0 ? 1 : 0.3);
    }
  }
  updateProgress(k, T, race, ev);
}

// laps and the distance raced (also used for karts whose position came over the network)
export function updateProgress(k, T, race, ev) {
  const s = k.loc.s;
  const ds = s - k.s;
  if (ds < -T.len / 2) {
    // forwards over the line
    if (k.half) {
      k.half = false;
      // when, exactly, did we cross? (for fair lap times)
      const frac = (T.len - k.s) / Math.max(0.001, T.len - k.s + s);
      const tc = race.time - race.dt * (1 - frac);
      if (k.lap >= 1) k.lapTimes.push(tc - k.lapStart);
      k.lapStart = tc;
      k.lap++;
      if (k.lap > race.laps && !k.finished) {
        k.finished = true;
        k.finishT = tc;
        ev.push(['finish', k]);
      } else if (k.lap > 1) ev.push(['lap', k, k.lap]);
    }
  } else if (ds > T.len / 2) {
    // backwards over the line
    if (!k.half) {
      k.half = true;
      k.lap--;
    }
  }
  if (!k.half && s > T.len * 0.45 && s < T.len * 0.9) k.half = true;
  k.s = s;
  k.prog = (k.lap - 1) * T.len + s;
  // going the wrong way?
  const fdot = k.vx * k.loc.tx + k.vz * k.loc.tz;
  const head = Math.sin(k.yaw) * k.loc.tx + Math.cos(k.yaw) * k.loc.tz;
  if (head < -0.35 && fdot < -2) k.wrongT += race.dt;
  else k.wrongT = Math.max(0, k.wrongT - race.dt * 3);
}

// karts bump each other; heavier (and boosting / shielded) karts push harder
export function collideKarts(karts, movable) {
  for (let a = 0; a < karts.length; a++)
    for (let b = a + 1; b < karts.length; b++) {
      const A = karts[a],
        B = karts[b];
      const dx = B.x - A.x,
        dz = B.z - A.z;
      if (Math.abs(B.y - A.y) > 1.6) continue;
      const d2 = dx * dx + dz * dz;
      const R = 2.3;
      if (d2 >= R * R || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d,
        nz = dz / d;
      const mA = A.mass * (A.boostT > 0 ? 1.6 : 1) * (A.shieldT > 0 ? 1.3 : 1);
      const mB = B.mass * (B.boostT > 0 ? 1.6 : 1) * (B.shieldT > 0 ? 1.3 : 1);
      const canA = movable(A),
        canB = movable(B);
      if (!canA && !canB) continue;
      const wA = canA ? (canB ? mB / (mA + mB) : 1) : 0;
      const wB = canB ? (canA ? mA / (mA + mB) : 1) : 0;
      const ov = R - d;
      A.x -= nx * ov * wA;
      A.z -= nz * ov * wA;
      B.x += nx * ov * wB;
      B.z += nz * ov * wB;
      const rel = (B.vx - A.vx) * nx + (B.vz - A.vz) * nz;
      if (rel < 0) {
        const j = -1.35 * rel;
        A.vx -= nx * j * wA;
        A.vz -= nz * j * wA;
        B.vx += nx * j * wB;
        B.vz += nz * j * wB;
        A.bumpT = B.bumpT = 0.2;
      }
    }
}
