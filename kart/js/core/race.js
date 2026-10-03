// A race: the karts, the countdown (with a start boost for getting the timing right), items,
// laps, places, and the finish. Runs the same in single player and on an online host; an online
// client runs its own kart and shows everything else from the host's snapshots.
import { CLASSES, DT, BOOST } from './config.js';
import { getTrack, trackPoint, gridSlot, locate } from './trackgeo.js';
import { makeKart, placeKart, kartStep, collideKarts, giveBoost, updateProgress } from './kart.js';
import { initItems, stepItems, useItem } from './items.js';
import { initBot, botThink } from './ai.js';
import { makeRng } from './rng.js';

export const COUNTDOWN = 3.6; // seconds from the karts appearing to GO (3, 2, 1 at -3, -2, -1)

export class Race {
  // setup: { track, cls, laps, items, mode: 'single'|'host'|'client', seed,
  //          karts: [{ driver, ctrl: 'player'|'bot'|'remote', name, owner, grid }] }
  constructor(setup) {
    this.setup = setup;
    this.T = getTrack(setup.track);
    this.cls = CLASSES[setup.cls] || CLASSES[100];
    this.laps = setup.laps || 3;
    this.items = setup.items !== false;
    this.mode = setup.mode || 'single';
    this.rng = makeRng(setup.seed || 1);
    this.dt = DT;
    this.time = -COUNTDOWN;
    this.state = 'countdown';
    this.ev = [];
    this.out = [];
    this.karts = setup.karts.map((s, i) => {
      const k = makeKart(i, s.driver, s.ctrl, this.cls, s.name);
      k.owner = s.owner ?? null;
      const g = gridSlot(this.T, s.grid ?? i);
      placeKart(k, this.T, trackPoint(this.T, g.fi, g.d));
      if (s.ctrl === 'bot') k.top *= 0.9 + 0.1 * this.cls.ai;
      if (s.item) {
        k.item = s.item;
        k.itemN = s.itemN || 1;
      }
      return k;
    });
    initItems(this);
    for (const k of this.karts) if (k.ctrl === 'bot') initBot(k, this);
    for (const k of this.karts) if (k.ctrl === 'bot') k.startAt = -this.rng.range(0.1, k.ai.skill > 0.95 ? 1.0 : 1.8);
    this.order = [...this.karts];
    this.rank();
    this.humansDoneT = null;
  }

  get player() {
    return this.karts.find((k) => k.ctrl === 'player') || null;
  }

  step() {
    const dt = DT,
      ev = this.ev;
    this.time += dt;
    if (this.state === 'countdown') {
      for (const k of this.karts) {
        if (k.ctrl === 'remote') continue;
        if (k.ctrl === 'bot' || k.auto) k.in.gas = this.time > (k.startAt ?? -0.6) ? 1 : 0;
        if (k.in.gas) {
          if (k.gasAt === undefined) k.gasAt = this.time;
        } else k.gasAt = undefined;
      }
      if (this.time >= 0) {
        this.state = 'race';
        ev.push(['go']);
        for (const k of this.karts) {
          if (k.ctrl === 'remote' || k.gasAt === undefined) continue;
          const held = -k.gasAt;
          if (held >= 0.2 && held <= 1.05) {
            giveBoost(k, BOOST.start);
            ev.push(['startboost', k]);
          } else if (held > 1.6) {
            k.spinT = 0.6;
            ev.push(['burnout', k]);
          }
        }
      }
    }
    // drivers
    for (const k of this.karts) if (k.ctrl === 'bot' || k.auto) botThink(k, this, dt);
    // items
    for (const k of this.karts) {
      if (k.ctrl === 'remote') continue;
      if (k.in.item && !k.prevItem && this.state === 'race') useItem(this, k, ev);
      k.prevItem = k.in.item;
    }
    for (const k of this.karts) if (k.ctrl !== 'remote') kartStep(k, this.T, dt, this, ev);
    collideKarts(this.karts, (k) => k.ctrl !== 'remote');
    if (this.mode !== 'client') {
      stepItems(this, dt, ev);
      this.rubberBand(dt);
    }
    this.rank();
    for (const e of ev)
      if (e[0] === 'finish' && e[1].ctrl === 'player' && !e[1].auto) {
        e[1].auto = true;
        if (!e[1].ai) initBot(e[1], this);
      }
    if (this.state === 'race' && this.mode !== 'client') {
      const humans = this.karts.filter((k) => k.human);
      if (humans.length && this.humansDoneT === null && humans.every((k) => k.finished)) this.humansDoneT = this.time;
      if (this.karts.every((k) => k.finished) || (this.humansDoneT !== null && this.time > this.humansDoneT + 6)) this.finish();
    }
  }

  // bots well behind the leading human catch up a little, bots far ahead ease off a little
  rubberBand(dt) {
    let lead = -Infinity;
    for (const k of this.karts) if (k.human && !k.finished) lead = Math.max(lead, k.prog);
    for (const k of this.karts) {
      if (k.ctrl !== 'bot') continue;
      let target = 1;
      if (lead > -Infinity) {
        const gap = k.prog - lead;
        target = gap < -120 ? 1.07 : gap < -45 ? 1.035 : gap > 160 ? 0.95 : gap > 70 ? 0.975 : 1;
      }
      k.rb += (target - k.rb) * Math.min(1, dt * 0.6);
    }
  }

  rank() {
    this.order.sort((a, b) => {
      if (a.finished && b.finished) return a.finishT - b.finishT;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return b.prog - a.prog;
    });
    this.order.forEach((k, i) => (k.place = i + 1));
  }

  // end the race; karts still going get a finishing time from their pace so far
  finish() {
    const total = this.laps * this.T.len;
    for (const k of this.order) {
      if (k.finished) continue;
      const pace = Math.max(8, (k.prog + 10) / Math.max(1, this.time));
      k.finishT = this.time + Math.max(0, total - k.prog) / pace;
      k.finished = true;
      k.estimated = true;
    }
    this.state = 'done';
    this.rank();
    this.ev.push(['done']);
  }

  // an online kart's latest state (host side: from its owner; client side: from the host)
  applyState(k, st) {
    k.x = st[0];
    k.y = st[1];
    k.z = st[2];
    k.yaw = st[3];
    k.vx = st[4];
    k.vz = st[5];
    k.vy = st[6];
    k.vf = st[7];
    k.drift = st[8];
    k.boostT = st[9];
    k.shieldT = st[10];
    k.spinT = st[11];
    k.steerVis = st[12];
    k.grounded = !!st[13];
    k.driftLevel = st[14];
    k.trick = st[15] || 0;
    locate(this.T, k.x, k.y, k.z, k.hint, k.loc);
    k.hint = k.loc.i;
    k.gy = k.loc.gy;
  }

  stateOf(k) {
    const r = (v, m = 100) => Math.round(v * m) / m;
    return [r(k.x), r(k.y), r(k.z), r(k.yaw, 1000), r(k.vx), r(k.vz), r(k.vy), r(k.vf), k.drift, r(k.boostT), r(k.shieldT), r(k.spinT), r(k.steerVis), k.grounded ? 1 : 0, k.driftLevel, k.trick ? 1 : 0];
  }

  // host: count laps for an online kart from its reported position
  trackRemote(k) {
    updateProgress(k, this.T, this, this.ev);
  }
}
