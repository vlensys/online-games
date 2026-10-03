// Item boxes, boost pads, and what the items do: nitro, rockets (straight, bouncing off the
// barriers), homing rockets (chase the kart in front), oil slicks, shields and the shockwave.
import { ITEMS, ITEM_ODDS, BOOST } from './config.js';
import { locate, trackPoint } from './trackgeo.js';
import { giveBoost } from './kart.js';

const BOX_RESPAWN = 1.4;
const ROLL_TIME = 1.2;

export function initItems(race) {
  const T = race.T;
  race.boxes = [];
  if (race.items) for (const row of T.items) for (const d of row.ds) {
      const p = trackPoint(T, row.i, d);
      race.boxes.push({ x: p.x, y: p.y + 1.1, z: p.z, i: row.i, alive: true, t: 0 });
    }
  race.pads = T.pads.map((p) => {
    const q = trackPoint(T, p.i, p.d);
    return { x: q.x, y: q.y, z: q.z, yaw: q.yaw, i: p.i, d: p.d };
  });
  race.proj = [];
  race.oils = [];
  race.nextId = 1;
  race.empCool = 0;
}

export function rollItem(race, k) {
  const n = race.karts.length;
  const back = n > 1 ? (k.place - 1) / (n - 1) : 0.5;
  const odds = { ...ITEM_ODDS.find((o) => back <= o.upTo).odds };
  if (race.empCool > 0 || k.place === 1) delete odds.emp;
  return race.rng.weighted(odds);
}

// a kart drives through a box (decided by the host / single player)
export function pickBox(race, k, ev) {
  if (k.item || k.rollT > 0) return;
  k.pending = rollItem(race, k);
  k.rollT = ROLL_TIME;
  ev.push(['roll', k]);
}

export function hitKart(race, k, kind, by, ev) {
  if (k.finished && k.human) return;
  if (k.hitGrace > 0) return;
  if (k.shieldT > 0) {
    k.shieldT = 0;
    k.hitGrace = 0.4;
    ev.push(['shieldpop', k, kind, by]);
    return;
  }
  if (k.spinT > 0) return;
  k.hitGrace = 0.6;
  ev.push(['hit', k, kind, by]);
  if (k.ctrl === 'remote' && race.mode === 'host') return; // its owner spins it out
  applyHit(k, kind);
}

export function applyHit(k, kind) {
  k.spinT = kind === 'oil' ? 1.0 : kind === 'emp' ? 1.2 : 1.4;
  k.spinAng = 0;
  k.drift = 0;
  k.driftLevel = 0;
  k.driftCharge = 0;
  k.boostT = 0;
  if (kind !== 'oil') k.vy = Math.max(k.vy, 5);
}

export function useItem(race, k, ev) {
  if (!k.item || k.rollT > 0) return;
  const it = k.item;
  const back = !!k.in.back;
  if (race.mode === 'client') {
    // the host spawns rockets and oil; we just tell it (boosts and shields are ours to apply)
    race.out.push({ t: 'use', it, back });
  }
  switch (it) {
    case 'nitro':
    case 'nitro3':
      giveBoost(k, BOOST.nitro);
      ev.push(['nitro', k]);
      break;
    case 'shield':
      k.shieldT = 8;
      ev.push(['shield', k]);
      break;
    default:
      if (race.mode !== 'client') spawnItem(race, k, it, back, ev);
  }
  k.itemN--;
  if (k.itemN <= 0) k.item = null;
}

// rockets, oil, the shockwave (host / single player)
export function spawnItem(race, k, it, back, ev) {
  const fx = Math.sin(k.yaw),
    fz = Math.cos(k.yaw);
  if (it === 'rocket' || it === 'homing') {
    const dir = back && it === 'rocket' ? -1 : 1;
    const sp = it === 'rocket' ? 50 : 44;
    const p = {
      id: race.nextId++,
      type: it,
      x: k.x + fx * 2.4 * dir,
      y: k.y + 0.6,
      z: k.z + fz * 2.4 * dir,
      vx: fx * sp * dir + (dir > 0 ? k.vx * 0.3 : 0),
      vz: fz * sp * dir + (dir > 0 ? k.vz * 0.3 : 0),
      life: it === 'rocket' ? 6 : 9,
      owner: k.id,
      age: 0,
      bounces: 0,
      target: null,
      hint: k.hint,
      loc: {},
    };
    if (it === 'homing') {
      const ahead = race.order.filter((o) => o.place < k.place && !o.finished);
      p.target = ahead.length ? ahead[ahead.length - 1].id : null;
    }
    race.proj.push(p);
    ev.push(['fire', k, it]);
  } else if (it === 'oil') {
    const dir = back ? 1 : -1;
    const x = k.x + fx * 3 * dir,
      z = k.z + fz * 3 * dir;
    const L = locate(race.T, x, k.y, z, k.hint, {});
    race.oils.push({ id: race.nextId++, x, y: L.gy, z, life: 30, owner: k.id, age: 0, loc: { i: L.i, t: L.t, d: L.d } });
    ev.push(['oil', k]);
  } else if (it === 'emp') {
    race.empCool = 15;
    ev.push(['emp', k]);
    for (const o of race.karts) if (o !== k && o.place < k.place) hitKart(race, o, 'emp', k.id, ev);
  }
}

export function stepItems(race, dt, ev) {
  const T = race.T;
  if (race.empCool > 0) race.empCool -= dt;
  for (const k of race.karts) {
    if (k.hitGrace > 0) k.hitGrace -= dt;
    if (k.rollT > 0) {
      k.rollT -= dt;
      if (k.rollT <= 0) {
        k.item = k.pending;
        k.itemN = ITEMS[k.item].uses;
        ev.push(['item', k, k.item]);
      }
    }
  }
  // boxes
  for (const b of race.boxes) {
    if (!b.alive) {
      b.t -= dt;
      if (b.t <= 0) b.alive = true;
      continue;
    }
    for (const k of race.karts) {
      const dx = k.x - b.x,
        dz = k.z - b.z;
      if (dx * dx + dz * dz < 2.6 * 2.6 && Math.abs(k.y + 0.6 - b.y) < 2.4) {
        b.alive = false;
        b.t = BOX_RESPAWN;
        ev.push(['box', k, b]);
        pickBox(race, k, ev);
        break;
      }
    }
  }
  stepPads(race, race.karts.filter((k) => k.ctrl !== 'remote'), dt, ev);
  // projectiles
  stepProjectiles(race, dt, ev);
}

// boost pads (an online client checks its own kart)
export function stepPads(race, karts, dt, ev) {
  const T = race.T;
  for (const p of race.pads)
    for (const k of karts) {
      if (!k.grounded) continue;
      let di = k.loc.i - p.i;
      if (di > T.n / 2) di -= T.n;
      if (di < -T.n / 2) di += T.n;
      if (di >= -1 && di <= 2 && Math.abs(k.loc.d - p.d) < 2.6 && (k.padT || 0) <= 0) {
        giveBoost(k, BOOST.pad);
        k.padT = 0.4;
        ev.push(['pad', k]);
      }
    }
  for (const k of karts) if (k.padT > 0) k.padT -= dt;
}

function stepProjectiles(race, dt, ev) {
  const T = race.T;
  for (const p of race.proj) {
    p.age += dt;
    p.life -= dt;
    if (p.type === 'homing') steerHoming(race, p, dt);
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    const L = locate(T, p.x, p.y, p.z, p.hint, p.loc);
    p.hint = L.i;
    p.y = L.gy + 0.6;
    const lim = L.lim - 0.5;
    if (Math.abs(L.d) > lim) {
      const sg = Math.sign(L.d);
      p.x -= L.rx * sg * (Math.abs(L.d) - lim);
      p.z -= L.rz * sg * (Math.abs(L.d) - lim);
      const vn = (p.vx * L.rx + p.vz * L.rz) * sg;
      if (vn > 0) {
        p.vx -= 2 * vn * L.rx * sg;
        p.vz -= 2 * vn * L.rz * sg;
        p.bounces++;
        if (p.bounces > 5) p.life = 0;
        else ev.push(['ricochet', null, p]);
      }
    }
    if (p.life <= 0) {
      p.dead = true;
      ev.push(['boom', null, p]);
      continue;
    }
    for (const k of race.karts) {
      if (k.id === p.owner && p.age < 0.5) continue;
      const dx = k.x - p.x,
        dz = k.z - p.z;
      if (dx * dx + dz * dz < 1.8 * 1.8 && Math.abs(k.y + 0.6 - p.y) < 2) {
        p.dead = true;
        ev.push(['boom', k, p]);
        hitKart(race, k, p.type, p.owner, ev);
        break;
      }
    }
    if (p.dead) continue;
    for (const o of race.oils) {
      const dx = o.x - p.x,
        dz = o.z - p.z;
      if (dx * dx + dz * dz < 2.2 * 2.2) {
        p.dead = o.dead = true;
        ev.push(['boom', null, p]);
        break;
      }
    }
  }
  // rockets hitting each other
  for (let a = 0; a < race.proj.length; a++)
    for (let b = a + 1; b < race.proj.length; b++) {
      const A = race.proj[a],
        B = race.proj[b];
      if (A.dead || B.dead) continue;
      const dx = A.x - B.x,
        dz = A.z - B.z;
      if (dx * dx + dz * dz < 2 * 2) {
        A.dead = B.dead = true;
        ev.push(['boom', null, A]);
      }
    }
  race.proj = race.proj.filter((p) => !p.dead);
  // oil
  for (const o of race.oils) {
    o.age += dt;
    o.life -= dt;
    if (o.life <= 0) o.dead = true;
    if (o.dead) continue;
    for (const k of race.karts) {
      if (k.id === o.owner && o.age < 0.8) continue;
      if (!k.grounded) continue;
      const dx = k.x - o.x,
        dz = k.z - o.z;
      if (dx * dx + dz * dz < 2.0 * 2.0 && Math.abs(k.y - o.y) < 1.5) {
        o.dead = true;
        hitKart(race, k, 'oil', o.owner, ev);
        break;
      }
    }
  }
  race.oils = race.oils.filter((o) => !o.dead);
}

// homing rockets follow the road until their target is close, then go straight for it
function steerHoming(race, p, dt) {
  const T = race.T;
  const tgt = p.target !== null ? race.karts[p.target] : null;
  let tx, tz;
  const L = p.loc.i !== undefined ? p.loc : locate(T, p.x, p.y, p.z, p.hint, p.loc);
  if (tgt && !tgt.finished) {
    const dx = tgt.x - p.x,
      dz = tgt.z - p.z;
    if (dx * dx + dz * dz < 28 * 28) {
      tx = dx;
      tz = dz;
    }
  }
  if (tx === undefined) {
    const q = trackPoint(T, L.i + 6, L.d * 0.6);
    tx = q.x - p.x;
    tz = q.z - p.z;
  }
  const sp = Math.hypot(p.vx, p.vz) || 1;
  const cur = Math.atan2(p.vx, p.vz);
  let want = Math.atan2(tx, tz) - cur;
  while (want > Math.PI) want -= 2 * Math.PI;
  while (want < -Math.PI) want += 2 * Math.PI;
  const turn = Math.max(-5 * dt, Math.min(5 * dt, want));
  const a = cur + turn;
  p.vx = Math.sin(a) * sp;
  p.vz = Math.cos(a) * sp;
}
