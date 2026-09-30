// Authoritative match simulation. Runs in the host's browser (a Web Worker when possible):
// lobby, players, bots, loot, storm, builds, damage and eliminations. Clients talk to it with
// small JSON messages (see handle()); it answers with per-connection message batches.
import * as C from '../core/config.js';
import { RNG, randomSeed, clamp } from '../core/rng.js';
import { generateMap, DEFAULT_TINT } from '../core/mapgen.js';
import { World, HIT_PIECE, HIT_PROP, HIT_TERRAIN } from '../core/world.js';
import { makeChar, makeStepOut, stepChar, eyeY, M_BUS, M_FALL, M_GLIDE, M_GROUND, M_SWIM, M_DEAD } from '../core/physics.js';
import { generateFloorLoot, rollChest, rollAmmoBox, weaponScore } from '../core/items.js';
import { makeStormPlan, stormState, outsideStorm } from '../core/storm.js';
import { rayChar, spreadDir, dirFromAngles, itemCode, HK_CHAR, HK_PIECE, HK_PROP } from '../core/combat.js';
import { placeCheck } from '../core/buildtarget.js';
import { PROP_TYPES } from '../core/props.js';
import { BotBrain } from './bots.js';

export const TICK = 1 / 30;
const SNAP_EVERY = 2; // 15 Hz
const VIEW_R = 460;
const PIECE_YIELD = [8, 7, 6];

import { F_CROUCH, F_ADS, F_SPRINT, F_BUILD, F_HEAL, F_RELOAD, F_SWING, busPath, busPos } from '../core/match.js';

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

class ItemGrid {
  constructor() {
    this.cells = new Map();
    this.S = 16;
  }
  key(x, z) {
    return (Math.floor(x / this.S) + 100) * 1000 + (Math.floor(z / this.S) + 100);
  }
  add(it) {
    const k = this.key(it.x, it.z);
    it._k = k;
    let s = this.cells.get(k);
    if (!s) this.cells.set(k, (s = new Set()));
    s.add(it);
  }
  remove(it) {
    const s = this.cells.get(it._k);
    if (s) s.delete(it);
  }
  query(x, z, r, fn) {
    const S = this.S;
    const x0 = Math.floor((x - r) / S), x1 = Math.floor((x + r) / S);
    const z0 = Math.floor((z - r) / S), z1 = Math.floor((z + r) / S);
    for (let a = x0; a <= x1; a++)
      for (let b = z0; b <= z1; b++) {
        const s = this.cells.get((a + 100) * 1000 + (b + 100));
        if (!s) continue;
        for (const it of s) {
          const dx = it.x - x;
          const dz = it.z - z;
          if (dx * dx + dz * dz <= r * r && fn(it) === true) return;
        }
      }
  }
}

export { busPath, busPos };

export class GameServer {
  constructor(cfg, out) {
    this.cfg = Object.assign(
      { bots: 24, diff: 1, loot: 'normal', storm: 'normal', max: 8, pw: '', solo: false, debug: false, seed: 0 },
      cfg || {},
    );
    this.out = out; // (cid, msgs[]) => void ; msgs may contain {t:'_close'}
    this.conns = new Map();
    this.players = new Map();
    this.plist = [];
    this.state = 'lobby';
    this.nextPid = 1;
    this.t = 0;
    this.tickN = 0;
    this.rng = new RNG(randomSeed());
    this.inbox = [];
    this.stepOut = makeStepOut();
    this.tmpDir = [0, 0, 0];
    this.tmpDir2 = [0, 0, 0];
    this.hitOut = { head: false };
    this.storm = {};
    this.noises = [];
    this.stats = { shots: 0, builds: 0, kills: 0 };
  }

  // ---------------------------------------------------------------- connections
  open(cid) {
    this.conns.set(cid, { cid, pid: 0, owner: this.conns.size === 0 && cid === 0, loaded: false, q: [] });
  }

  close(cid) {
    const conn = this.conns.get(cid);
    if (!conn) return;
    this.conns.delete(cid);
    const p = conn.pid && this.players.get(conn.pid);
    if (!p) return;
    p.conn = null;
    if (this.state === 'lobby') {
      this.players.delete(p.id);
      this.plist = this.plist.filter((q) => q !== p);
      this.sendLobby();
    } else if (p.alive) {
      this.eliminate(p, null, 'left', false);
    }
  }

  recv(cid, msg) {
    this.inbox.push(cid, msg);
  }

  send(conn, msg) {
    if (conn) conn.q.push(msg);
  }

  sendP(p, msg) {
    if (p.conn) p.conn.q.push(msg);
  }

  broadcast(msg, exceptConn = null) {
    for (const c of this.conns.values()) if (c !== exceptConn && c.pid) c.q.push(msg);
  }

  flush() {
    for (const c of this.conns.values()) {
      if (c.q.length) {
        const q = c.q;
        c.q = [];
        this.out(c.cid, q);
      }
    }
  }

  publicCfg() {
    const c = this.cfg;
    return { bots: c.bots, diff: c.diff, loot: c.loot, storm: c.storm, max: c.max, pw: !!c.pw, solo: c.solo };
  }

  sendLobby() {
    const ps = this.plist.filter((p) => p.human).map((p) => ({ id: p.id, n: p.name, h: !!(p.conn && p.conn.owner) }));
    this.broadcast({ t: 'lobby', ps, cfg: this.publicCfg(), st: this.state });
  }

  // ---------------------------------------------------------------- messages
  processInbox() {
    const box = this.inbox;
    this.inbox = [];
    for (let i = 0; i < box.length; i += 2) {
      const conn = this.conns.get(box[i]);
      if (!conn) continue;
      try {
        this.handle(conn, box[i + 1]);
      } catch (e) {
        console.error('server handle error', e);
      }
    }
  }

  handle(conn, m) {
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'hello') return this.onHello(conn, m);
    if (m.t === 'hc') {
      if (conn.owner) this.hostCmd(conn, m);
      return;
    }
    if (m.t === 'ld') {
      conn.loaded = true;
      return;
    }
    if (m.t === 'ping') {
      this.send(conn, { t: 'pong', c: m.c, T: this.t });
      return;
    }
    const p = conn.pid ? this.players.get(conn.pid) : null;
    if (!p || this.state !== 'match') return;
    switch (m.t) {
      case 'in':
        this.onInput(p, m);
        break;
      case 'jmp':
        this.jumpBus(p);
        break;
      case 'sh':
        this.onShot(p, m);
        break;
      case 'ml':
        this.onMelee(p, m);
        break;
      case 'rk':
        this.onRocket(p, m);
        break;
      case 'sl':
        this.setSlot(p, m.i | 0);
        break;
      case 'rl':
        this.startReload(p);
        break;
      case 'use':
        this.startUse(p);
        break;
      case 'cx':
        this.cancelUse(p);
        break;
      case 'pk':
        this.onPickup(p, m.id);
        break;
      case 'op':
        this.openContainer(p, m.k === 'b' ? 'b' : 'c', m.id | 0);
        break;
      case 'bd':
        this.onBuild(p, m);
        break;
      case 'fd':
        if (p.alive && p.c.mode === M_GROUND) this.damage(p, clamp(+m.d || 0, 0, 250), null, 'fall');
        break;
      case 'sw':
        this.swapSlots(p, m.a | 0, m.b | 0);
        break;
      case 'dbg':
        if (this.cfg.debug) this.debugCmd(p, m);
        break;
      default:
        break;
    }
    if (m.q) p.ack = m.q;
  }

  onHello(conn, m) {
    if (conn.pid) return;
    if ((m.v || '') !== C.VERSION) return this.reject(conn, 'version');
    if (this.state !== 'lobby') return this.reject(conn, 'started');
    if (!conn.owner && this.cfg.pw && String(m.pw || '') !== this.cfg.pw) return this.reject(conn, 'password');
    const humans = this.plist.filter((p) => p.human).length;
    if (humans >= this.cfg.max) return this.reject(conn, 'full');
    let name = String(m.name || 'Player').replace(/[^\w \-.]/g, '').trim().slice(0, 16) || 'Player';
    const taken = new Set(this.plist.map((p) => p.name));
    let n = 2;
    const base = name;
    while (taken.has(name)) name = base.slice(0, 13) + ' ' + n++;
    const p = this.newPlayer(name, true, conn);
    if (Array.isArray(m.outfit)) p.outfit = m.outfit.slice(0, 5).map((v) => String(v).slice(0, 7));
    conn.pid = p.id;
    this.send(conn, { t: 'welcome', id: p.id, owner: conn.owner, cfg: this.publicCfg(), name });
    this.sendLobby();
    if (this.cfg.solo && conn.owner) this.startMatch();
  }

  reject(conn, reason) {
    this.send(conn, { t: 'rej', r: reason });
    this.send(conn, { t: '_close' });
  }

  hostCmd(conn, m) {
    switch (m.a) {
      case 'cfg':
        if (this.state === 'lobby' && m.cfg) {
          const c = m.cfg;
          if (c.bots !== undefined) this.cfg.bots = clamp(c.bots | 0, 0, 63);
          if (c.diff !== undefined) this.cfg.diff = clamp(c.diff | 0, 0, 2);
          if (C.LOOT_MODES[c.loot]) this.cfg.loot = c.loot;
          if (C.STORM_SPEEDS[c.storm]) this.cfg.storm = c.storm;
          if (c.max !== undefined) this.cfg.max = clamp(c.max | 0, 1, 16);
          if (c.pw !== undefined) this.cfg.pw = String(c.pw).slice(0, 32);
          this.sendLobby();
        }
        break;
      case 'start':
        if (this.state === 'lobby') this.startMatch();
        break;
      case 'kick': {
        const p = this.players.get(m.id | 0);
        if (p && p.human && p.conn && !p.conn.owner) {
          const c = p.conn;
          this.reject(c, 'kicked');
          this.close(c.cid);
          this.flushOne(c);
        }
        break;
      }
      case 'lobby':
        if (this.state === 'end' || this.state === 'match') this.backToLobby();
        break;
      default:
        break;
    }
  }

  flushOne(c) {
    if (c.q.length) {
      const q = c.q;
      c.q = [];
      this.out(c.cid, q);
    }
  }

  // ---------------------------------------------------------------- players
  newPlayer(name, human, conn) {
    const id = this.nextPid++;
    const rng = this.rng;
    const p = {
      id,
      name,
      human,
      conn: conn || null,
      bot: null,
      c: makeChar(),
      alive: true,
      hp: C.HP_MAX,
      sh: 0,
      slots: [null, null, null, null, null],
      cur: 0,
      ammo: { light: 0, medium: 0, heavy: 0, shells: 0, rockets: 0 },
      mats: C.START_MATS.slice(),
      kills: 0,
      dmgDealt: 0,
      place: 0,
      flags: 0,
      nextFire: 0,
      nextMelee: 0,
      bloom: 0,
      lastShotT: -9,
      tokens: 3,
      tokT: 0,
      reload: null,
      use: null,
      stormAcc: 0,
      invDirty: true,
      ack: 0,
      corr: 0,
      lastInT: 0,
      trustT: 0,
      lastHitBy: 0,
      lastHitT: -99,
      jumpT: -1,
      landedT: -1,
      outfit: [
        rng.pick(C.OUTFIT_COLORS),
        rng.pick(C.OUTFIT_COLORS),
        rng.pick(C.SKIN_TONES),
        rng.pick(['#2b1d14', '#4a2f1b', '#d9b36c', '#1c1c22', '#8a3b1f', '#c9c9c9', '#6b4a8a', '#2f6fbf']),
        rng.pick(C.OUTFIT_COLORS),
      ],
      god: false,
      swingT: -9,
    };
    this.players.set(id, p);
    this.plist.push(p);
    return p;
  }

  backToLobby() {
    this.state = 'lobby';
    this.plist = this.plist.filter((p) => p.human && p.conn);
    this.players = new Map(this.plist.map((p) => [p.id, p]));
    for (const c of this.conns.values()) c.loaded = false;
    this.map = null;
    this.world = null;
    this.sendLobby();
  }

  // ---------------------------------------------------------------- match setup
  startMatch() {
    const cfg = this.cfg;
    const rng = this.rng;
    const seed = cfg.seed ? cfg.seed >>> 0 : randomSeed();
    const lootSeed = randomSeed();
    this.seed = seed;
    this.lootSeed = lootSeed;
    this.map = generateMap(seed);
    this.world = new World(this.map);
    const loot = generateFloorLoot(this.map, lootSeed, cfg.loot);
    this.items = new Map();
    this.igrid = new ItemGrid();
    for (const it of loot.items) this.addItemLocal(it);
    this.nextItemId = loot.nextId;
    this.chestAvail = loot.chests.slice();
    this.boxAvail = loot.boxes.slice();
    this.nextPieceId = 100000;
    this.building = [];
    this.rockets = [];
    this.nextRocketId = 1;
    this.bus = busPath(rng);
    this.plan = makeStormPlan(rng, this.map, C.STORM_SPEEDS[cfg.storm] || 1, this.bus.dur + 6);
    this.t = 0;
    this.tickN = 0;
    this.endT = 0;
    this.winner = 0;
    this.claims = new Map();
    // reset humans, add bots
    this.plist = this.plist.filter((p) => p.human && p.conn);
    this.players = new Map(this.plist.map((p) => [p.id, p]));
    for (const p of this.plist) this.resetPlayer(p);
    const nb = clamp(cfg.bots | 0, 0, 64 - this.plist.length);
    const names = new Set(this.plist.map((p) => p.name));
    for (let i = 0; i < nb; i++) {
      let name;
      for (let k = 0; k < 20; k++) {
        name = rng.pick(C.BOT_NAMES_A) + ' ' + rng.pick(C.BOT_NAMES_B);
        if (!names.has(name)) break;
      }
      names.add(name);
      const p = this.newPlayer(name, false, null);
      this.resetPlayer(p);
      p.bot = new BotBrain(this, p, cfg.diff, new RNG(rng.int(1, 1e9)));
    }
    this.aliveCount = this.plist.length;
    this.state = 'loading';
    this.loadT = 0;
    const plist = this.plist.map((p) => ({ id: p.id, n: p.name, h: p.human ? 1 : 0, o: p.outfit }));
    for (const conn of this.conns.values()) {
      if (!conn.pid) continue;
      conn.loaded = false;
      this.send(conn, {
        t: 'start',
        seed,
        lootSeed,
        loot: cfg.loot,
        bus: this.bus,
        plan: this.plan,
        players: plist,
        you: conn.pid,
        cfg: this.publicCfg(),
        debug: !!cfg.debug,
      });
    }
  }

  resetPlayer(p) {
    p.c = makeChar();
    p.c.mode = M_BUS;
    busPos(this.bus, 0, this.tmpDir);
    p.c.x = this.tmpDir[0];
    p.c.y = this.tmpDir[1];
    p.c.z = this.tmpDir[2];
    p.alive = true;
    p.hp = C.HP_MAX;
    p.sh = 0;
    p.slots = [null, null, null, null, null];
    p.cur = 0;
    p.ammo = { light: 0, medium: 0, heavy: 0, shells: 0, rockets: 0 };
    p.mats = C.START_MATS.slice();
    p.kills = 0;
    p.dmgDealt = 0;
    p.place = 0;
    p.reload = null;
    p.use = null;
    p.stormAcc = 0;
    p.invDirty = true;
    p.ack = 0;
    p.flags = 0;
    p.jumpT = -1;
    p.landedT = -1;
    p.lastHitBy = 0;
    p.god = false;
  }

  beginMatch() {
    this.state = 'match';
    this.t = 0;
    this.broadcast({ t: 'go', T: 0 });
  }

  // ---------------------------------------------------------------- main tick
  step() {
    this.processInbox();
    if (this.state === 'loading') {
      this.loadT += TICK;
      let all = true;
      for (const c of this.conns.values()) if (c.pid && !c.loaded) all = false;
      if (all || this.loadT > 40) this.beginMatch();
    } else if (this.state === 'match' || this.state === 'end') {
      this.t += TICK;
      this.tickN++;
      this.simulate(TICK);
      if (this.tickN % SNAP_EVERY === 0) this.snapshots();
    }
    this.flush();
  }

  simulate(dt) {
    const t = this.t;
    stormState(this.plan, t, this.storm);
    const ending = this.state === 'end';
    // bus
    const bp = busPos(this.bus, t, this.tmpDir);
    const busOver = t >= this.bus.dur;
    for (const p of this.plist) {
      if (!p.alive || p.c.mode !== M_BUS) continue;
      p.c.x = bp[0];
      p.c.y = bp[1];
      p.c.z = bp[2];
      if (busOver) this.jumpBus(p, true);
    }
    // bots
    for (let i = 0; i < this.plist.length; i++) {
      const p = this.plist[i];
      if (!p.alive || p.human) continue;
      if (ending) {
        p.bot.idle();
        continue;
      }
      p.bot.update(dt);
      if (p.c.mode !== M_BUS) {
        const out = this.stepOut;
        stepChar(this.world, p.c, p.bot.inp, dt, out);
        if (out.fallDmg > 0) this.damage(p, out.fallDmg, null, 'fall');
        if (out.landed && p.landedT < 0) p.landedT = t;
        p.bot.onStep(out);
        if (p.alive && p.c.y < -30) this.eliminate(p, null, 'fall', false);
      }
    }
    if (!ending) {
      // timers
      for (const p of this.plist) if (p.alive) this.playerTimers(p, dt);
      // storm damage
      const s = this.storm;
      if (s.dmg > 0) {
        for (const p of this.plist) {
          if (!p.alive || p.c.mode === M_BUS) continue;
          if (outsideStorm(s, p.c.x, p.c.z)) {
            p.stormAcc += dt;
            if (p.stormAcc >= 1) {
              p.stormAcc -= 1;
              this.damage(p, s.dmg, null, 'storm');
            }
          } else p.stormAcc = 0.5;
        }
      }
      // auto pickup ammo & materials
      if (this.tickN % 3 === 0) {
        for (const p of this.plist) {
          if (!p.alive || p.c.mode !== M_GROUND) continue;
          this.igrid.query(p.c.x, p.c.z, 1.7, (it) => {
            if (Math.abs(it.y - p.c.y) > 1.6) return;
            if (it.t.startsWith('a_') || it.t.startsWith('m_')) this.pickup(p, it);
          });
        }
      }
      this.updateBuilding(dt);
      this.updateRockets(dt);
    }
    // noises expire
    if (this.noises.length > 40) this.noises.splice(0, this.noises.length - 40);
    if (this.state === 'end' && t > this.endT + 12) {
      // keep the world idle; host decides when to go back to the lobby
    }
  }

  playerTimers(p, dt) {
    const t = this.t;
    // shot budget refill for humans
    if (p.reload && t >= p.reload.t1) this.finishReload(p);
    if (p.use && t >= p.use.t1) {
      const s = p.slots[p.use.slot];
      if (s && s.t === p.use.t && s.n > 0) {
        const cdef = C.CONSUMABLES[s.t];
        if (cdef.hp) p.hp = Math.min(cdef.hpMax, p.hp + cdef.hp);
        if (cdef.sh) p.sh = Math.min(cdef.shMax, p.sh + cdef.sh);
        s.n--;
        if (s.n <= 0) p.slots[p.use.slot] = null;
        p.invDirty = true;
        this.sendP(p, { t: 'ud' });
      }
      p.use = null;
      // bots chain heals themselves
    }
    if (p.bloom > 0) {
      const s = p.cur > 0 ? p.slots[p.cur - 1] : null;
      const w = s && C.WEAPONS[s.t];
      const decay = w && w.bloomMax ? w.bloomMax * 2.2 : 6;
      p.bloom = Math.max(0, p.bloom - decay * dt);
    }
    if (p.human && p.invDirty) {
      p.invDirty = false;
      this.sendInv(p);
    }
  }

  finishReload(p) {
    const s = p.slots[p.reload.slot];
    if (s && C.WEAPONS[s.t] && s === p.reload.item) {
      const w = C.WEAPONS[s.t];
      const take = Math.min(w.mag - s.n, p.ammo[w.ammo]);
      s.n += take;
      p.ammo[w.ammo] -= take;
      p.invDirty = true;
    }
    p.reload = null;
  }

  sendInv(p) {
    this.sendP(p, {
      t: 'inv',
      s: p.slots.map((s) => (s ? [s.t, s.r, s.n] : null)),
      c: p.cur,
      a: C.AMMO_LIST.map((k) => p.ammo[k]),
      m: p.mats.slice(),
      q: p.ack,
    });
  }

  // ---------------------------------------------------------------- snapshots
  snapshots() {
    const rows = [];
    for (const p of this.plist) {
      if (!p.alive) continue;
      const c = p.c;
      const held = p.cur > 0 ? p.slots[p.cur - 1] : null;
      let f = p.flags & (F_CROUCH | F_ADS | F_SPRINT | F_BUILD);
      if (!p.human) {
        const inp = p.bot.inp;
        f = (c.crouch ? F_CROUCH : 0) | (inp.ads ? F_ADS : 0) | (inp.sprint ? F_SPRINT : 0) | (p.bot.buildingNow ? F_BUILD : 0);
      } else if (c.crouch) f |= F_CROUCH;
      if (p.use) f |= F_HEAL;
      if (p.reload) f |= F_RELOAD;
      if (this.t - p.swingT < 0.35) f |= F_SWING;
      rows.push([p.id, r2(c.x), r2(c.y), r2(c.z), r3(c.yaw), r3(c.pitch), c.mode, f, itemCode(held), Math.ceil(p.hp), Math.ceil(p.sh)]);
    }
    const T = r3(this.t);
    this.snapN = (this.snapN || 0) + 1;
    const odd = this.snapN & 1;
    for (const conn of this.conns.values()) {
      if (!conn.pid) continue;
      const me = this.players.get(conn.pid);
      let list = rows;
      if (me && me.alive && me.c.mode !== M_BUS && rows.length > 12 && conn.cid !== 0) {
        // remote clients: nearby players every snapshot, far ones every other (bandwidth)
        const mx = me.c.x;
        const mz = me.c.z;
        list = rows.filter((r) => {
          if (r[0] === me.id) return true;
          const dx = r[1] - mx;
          const dz = r[3] - mz;
          const d2 = dx * dx + dz * dz;
          return d2 < 150 * 150 || (d2 < VIEW_R * VIEW_R && odd);
        });
      }
      conn.q.push({ t: 's', T, a: this.aliveCount, p: list });
    }
  }

  // ---------------------------------------------------------------- bus
  jumpBus(p, forced = false) {
    if (!p.alive || p.c.mode !== M_BUS) return;
    if (!forced && this.t < this.bus.door) return;
    const c = p.c;
    busPos(this.bus, this.t, this.tmpDir);
    c.x = this.tmpDir[0];
    c.z = this.tmpDir[2];
    c.y = this.bus.y - 3;
    c.mode = M_FALL;
    c.vx = c.vz = 0;
    c.vy = -5;
    p.jumpT = this.t;
    p.trustT = this.t + 2.5;
    if (p.human) this.sendP(p, { t: 'drop', x: r2(c.x), y: r2(c.y), z: r2(c.z), f: forced ? 1 : 0 });
  }

  // ---------------------------------------------------------------- human input
  onInput(p, m) {
    const c = p.c;
    if (!p.alive || c.mode === M_BUS || c.mode === M_DEAD) return;
    if ((m.c | 0) !== p.corr) return; // stale (sent before our last correction)
    const x = +m.x;
    const y = +m.y;
    const z = +m.z;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const el = Math.max(0.1, this.t - p.lastInT);
    p.lastInT = this.t;
    const mode = clamp(m.m | 0, M_FALL, M_SWIM);
    const dx = x - c.x;
    const dz = z - c.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const vmax = mode === M_FALL || c.mode === M_FALL ? 34 : mode === M_GLIDE ? 22 : 12;
    if (this.t > p.trustT && d > vmax * el * 2 + 3) {
      p.corr++;
      this.sendP(p, { t: 'pos', x: r2(c.x), y: r2(c.y), z: r2(c.z), c: p.corr });
      return;
    }
    const lim = C.WORLD_HALF - 8;
    c.x = clamp(x, -lim, lim);
    c.y = clamp(y, -40, 400);
    c.z = clamp(z, -lim, lim);
    c.yaw = +m.yw || 0;
    c.pitch = clamp(+m.pt || 0, -1.6, 1.6);
    if (c.mode !== mode && mode === M_GROUND && p.landedT < 0) p.landedT = this.t;
    c.mode = mode;
    p.flags = m.f | 0;
    c.crouch = !!(p.flags & F_CROUCH);
    if (p.use && p.flags & F_SPRINT) this.cancelUse(p);
    if (c.y < -30) this.eliminate(p, null, 'fall', false);
  }

  // ---------------------------------------------------------------- inventory
  heldSlot(p) {
    return p.cur > 0 ? p.slots[p.cur - 1] : null;
  }

  setSlot(p, i) {
    i = clamp(i, 0, 5);
    if (p.cur === i) return;
    p.cur = i;
    p.reload = null;
    if (p.use) this.cancelUse(p);
    p.bloom = 0;
    const s = this.heldSlot(p);
    const w = s && C.WEAPONS[s.t];
    p.nextFire = Math.max(p.nextFire, this.t + (w ? 0.2 : 0));
    p.invDirty = true;
  }

  swapSlots(p, a, b) {
    if (a < 0 || a > 4 || b < 0 || b > 4 || a === b) return;
    const t = p.slots[a];
    p.slots[a] = p.slots[b];
    p.slots[b] = t;
    if (p.cur === a + 1) p.cur = b + 1;
    else if (p.cur === b + 1) p.cur = a + 1;
    p.reload = null;
    p.use = null;
    p.invDirty = true;
  }

  startReload(p) {
    if (!p.alive || p.reload) return false;
    const s = this.heldSlot(p);
    const w = s && C.WEAPONS[s.t];
    if (!w || w.melee || !w.mag || s.n >= w.mag || p.ammo[w.ammo] <= 0) return false;
    if (p.use) this.cancelUse(p);
    const st = C.weaponStats(s.t, s.r);
    p.reload = { slot: p.cur - 1, item: s, t1: this.t + st.reload };
    return true;
  }

  startUse(p) {
    if (!p.alive || p.use) return false;
    const s = this.heldSlot(p);
    if (!s || !C.isConsumable(s.t) || s.n <= 0) return false;
    const d = C.CONSUMABLES[s.t];
    if (d.hp && p.hp >= d.hpMax) return false;
    if (d.sh && p.sh >= d.shMax) return false;
    p.reload = null;
    p.use = { slot: p.cur - 1, t: s.t, t1: this.t + d.time };
    this.sendP(p, { t: 'us', d: d.time });
    return true;
  }

  cancelUse(p) {
    if (!p.use) return;
    p.use = null;
    this.sendP(p, { t: 'ux' });
  }

  // Put an item into the inventory. Returns number taken (for stacks) or 0.
  pickup(p, it, forceSwap = false) {
    if (!p.alive || !this.items.has(it.id)) return 0;
    const t = it.t;
    let taken = 0;
    if (t.startsWith('a_')) {
      const k = t.slice(2);
      taken = Math.min(it.n, C.AMMO[k].max - p.ammo[k]);
      if (taken <= 0) return 0;
      p.ammo[k] += taken;
    } else if (t.startsWith('m_')) {
      const mi = ['wood', 'brick', 'metal'].indexOf(t.slice(2));
      taken = Math.min(it.n, C.MAT_MAX - p.mats[mi]);
      if (taken <= 0) return 0;
      p.mats[mi] += taken;
    } else if (C.isConsumable(t)) {
      const stack = C.CONSUMABLES[t].stack;
      let left = it.n;
      for (const s of p.slots) {
        if (s && s.t === t && s.n < stack && left > 0) {
          const k = Math.min(left, stack - s.n);
          s.n += k;
          left -= k;
        }
      }
      if (left > 0) {
        const e = p.slots.indexOf(null);
        if (e >= 0) {
          p.slots[e] = { t, r: it.r, n: left };
          left = 0;
        } else if (left === it.n) {
          if (!this.swapHeld(p, it)) return 0;
          left = 0;
        }
      }
      taken = it.n - left;
    } else if (C.isWeapon(t)) {
      const e = forceSwap ? -1 : p.slots.indexOf(null);
      if (e >= 0) p.slots[e] = { t, r: it.r, n: it.n };
      else if (!this.swapHeld(p, it)) return 0;
      taken = it.n;
      if (!p.human && e >= 0 && p.cur === 0) p.cur = e + 1;
    }
    if (taken <= 0) return 0;
    p.invDirty = true;
    if (taken >= it.n) this.removeItem(it);
    else {
      it.n -= taken;
      this.broadcast({ t: 'iu', id: it.id, n: it.n });
    }
    this.sendP(p, { t: 'got', it: t, r: it.r, n: taken });
    return taken;
  }

  swapHeld(p, it) {
    if (p.cur === 0) return false;
    const idx = p.cur - 1;
    const old = p.slots[idx];
    if (old) this.dropItem(old.t, old.r, old.n, p.c.x, p.c.y, p.c.z, 0.4);
    p.slots[idx] = { t: it.t, r: it.r, n: it.n };
    p.reload = null;
    p.use = null;
    return true;
  }

  onPickup(p, id) {
    const it = this.items.get(id);
    if (!it || !p.alive) return;
    const dx = it.x - p.c.x;
    const dz = it.z - p.c.z;
    if (dx * dx + dz * dz > 4.2 * 4.2 || Math.abs(it.y - p.c.y) > 3) return;
    if (!this.pickup(p, it)) this.sendP(p, { t: 'msg', m: 'Inventory full' });
  }

  // ---------------------------------------------------------------- items
  addItemLocal(it) {
    this.items.set(it.id, it);
    this.igrid.add(it);
  }

  spawnItem(t, r, n, x, y, z) {
    const g = this.world.groundAt(x, z, y + 0.9);
    const it = { id: this.nextItemId++, t, r, n, x: r2(x), y: r2(Math.max(g, -1.2)), z: r2(z) };
    this.addItemLocal(it);
    this.broadcast({ t: 'ia', i: [[it.id, C.ITEM_ID[t], r, n, it.x, it.y, it.z]] });
    return it;
  }

  dropItem(t, r, n, x, y, z, spread = 1.2) {
    const a = this.rng.float(0, Math.PI * 2);
    const d = this.rng.float(0.4, spread + 0.4);
    return this.spawnItem(t, r, n, x + Math.cos(a) * d, y, z + Math.sin(a) * d);
  }

  removeItem(it) {
    this.items.delete(it.id);
    this.igrid.remove(it);
    this.broadcast({ t: 'ir', id: it.id });
  }

  openContainer(p, kind, id) {
    if (!p.alive) return false;
    const list = kind === 'b' ? this.map.boxes : this.map.chests;
    const avail = kind === 'b' ? this.boxAvail : this.chestAvail;
    const ch = list[id];
    if (!ch || !avail[id]) return false;
    const dx = ch.x - p.c.x;
    const dz = ch.z - p.c.z;
    if (dx * dx + dz * dz > 4.2 * 4.2 || Math.abs(ch.y - p.c.y) > 3) return false;
    avail[id] = false;
    this.broadcast({ t: 'co', k: kind, id });
    const items = kind === 'b' ? rollAmmoBox(this.rng) : rollChest(this.rng, this.cfg.loot);
    // containers face local +z (see mapgen)
    const fx = Math.sin(ch.yaw || 0);
    const fz = Math.cos(ch.yaw || 0);
    items.forEach((it, i) => {
      const side = (i - (items.length - 1) / 2) * 0.75;
      const x = ch.x + fx * 1.3 + -fz * side;
      const z = ch.z + fz * 1.3 + fx * side;
      this.spawnItem(it.t, it.r, it.n, x, ch.y, z);
    });
    return true;
  }

  // ---------------------------------------------------------------- damage
  damage(v, amount, attacker, cause, head = false, pos = null) {
    if (!v.alive || amount <= 0 || this.state !== 'match') return 0;
    if (v.god) return 0;
    let d = amount;
    let shd = 0;
    if (cause !== 'storm' && cause !== 'fall') {
      shd = Math.min(v.sh, d);
      v.sh -= shd;
      d -= shd;
    }
    const hpd = Math.min(v.hp, d);
    v.hp -= hpd;
    const total = shd + hpd;
    if (attacker && attacker !== v) {
      attacker.dmgDealt += total;
      v.lastHitBy = attacker.id;
      v.lastHitT = this.t;
    }
    const killed = v.hp <= 0.001;
    if (v.human) {
      this.sendP(v, {
        t: 'hu',
        a: attacker ? attacker.id : 0,
        d: Math.round(total),
        k: cause,
        x: attacker ? r2(attacker.c.x) : 0,
        z: attacker ? r2(attacker.c.z) : 0,
        s: shd > 0 ? 1 : 0,
      });
    }
    if (attacker && attacker !== v && attacker.human) {
      const P = pos || [v.c.x, v.c.y + 1.2, v.c.z];
      this.sendP(attacker, {
        t: 'ht',
        v: v.id,
        d: Math.round(total),
        s: shd > 0 && hpd <= 0 ? 1 : 0,
        h: head ? 1 : 0,
        k: killed ? 1 : 0,
        x: r2(P[0]),
        y: r2(P[1]),
        z: r2(P[2]),
      });
    }
    if (v.bot && attacker && attacker !== v) v.bot.onDamaged(attacker, total);
    if (killed) this.eliminate(v, attacker, cause, head);
    return total;
  }

  eliminate(v, attacker, cause, head) {
    if (!v.alive) return;
    // storm/fall kills credit the last player who damaged you recently
    if (!attacker && (cause === 'storm' || cause === 'fall') && v.lastHitBy && this.t - v.lastHitT < 10) {
      const a = this.players.get(v.lastHitBy);
      if (a && a.alive) attacker = a;
    }
    v.alive = false;
    v.place = this.aliveCount;
    v.deathT = this.t;
    this.aliveCount--;
    v.reload = null;
    v.use = null;
    const c = v.c;
    const wasBus = c.mode === M_BUS;
    c.mode = M_DEAD;
    if (attacker && attacker !== v) {
      attacker.kills++;
      this.stats.kills++;
    }
    // drop loot
    if (!wasBus) {
      for (const s of v.slots) if (s) this.dropItem(s.t, s.r, s.n, c.x, c.y, c.z, 1.6);
      for (const k of C.AMMO_LIST) if (v.ammo[k] > 0) this.dropItem('a_' + k, 0, v.ammo[k], c.x, c.y, c.z, 1.8);
      ['wood', 'brick', 'metal'].forEach((m, i) => {
        if (v.mats[i] > 0) this.dropItem('m_' + m, 0, Math.min(v.mats[i], 999), c.x, c.y, c.z, 1.8);
      });
    }
    v.slots = [null, null, null, null, null];
    const how = attacker && attacker !== v ? cause : cause === 'storm' || cause === 'fall' || cause === 'left' ? cause : 'self';
    this.broadcast({ t: 'kf', k: attacker && attacker !== v ? attacker.id : 0, v: v.id, w: how, h: head ? 1 : 0, a: this.aliveCount });
    if (v.human) {
      this.sendP(v, { t: 'dead', place: v.place, by: attacker && attacker !== v ? attacker.id : 0, w: how, kills: v.kills, dmg: Math.round(v.dmgDealt), T: r3(this.t) });
    }
    if (this.aliveCount <= 1 && this.state === 'match') this.finish();
  }

  finish() {
    const alive = this.plist.filter((p) => p.alive);
    let w = alive[0];
    if (!w) {
      // everyone died at once: the last one eliminated wins
      w = this.plist.reduce((a, b) => (!a || (b.deathT || 0) > (a.deathT || 0) ? b : a), null);
    }
    this.state = 'end';
    this.endT = this.t;
    this.winner = w ? w.id : 0;
    if (w) w.place = 1;
    const res = this.plist
      .map((p) => [p.id, p.place || 1, p.kills, Math.round(p.dmgDealt), p.human ? 1 : 0])
      .sort((a, b) => a[1] - b[1]);
    this.broadcast({ t: 'end', w: this.winner, r: res, T: r3(this.t) });
  }

  // ---------------------------------------------------------------- shooting (shared)
  fireCheck(p) {
    const s = this.heldSlot(p);
    if (!s || !C.isWeapon(s.t)) return null;
    if (p.reload || s.n <= 0) return null;
    return s;
  }

  // Human shot: client did the hit detection; we validate & apply.
  onShot(p, m) {
    if (!p.alive || p.c.mode !== M_GROUND) return;
    if (typeof m.w === 'number' && m.w >= 1 && m.w <= 5 && m.w !== p.cur) this.setSlot(p, m.w);
    // the client finishes its reload one network trip earlier than we do
    if (p.reload && p.reload.t1 - this.t < 0.35) this.finishReload(p);
    const s = this.fireCheck(p);
    if (!s) return;
    const w = C.weaponStats(s.t, s.r);
    // token bucket against fire-rate cheats / duplicate packets
    const t = this.t;
    p.tokens = Math.min(2.5, p.tokens + (t - p.tokT) * w.rate * 1.3);
    p.tokT = t;
    if (p.tokens < 0.999) return;
    p.tokens -= 1;
    if (p.use) this.cancelUse(p);
    s.n--;
    p.lastShotT = t;
    this.stats.shots++;
    const ex = p.c.x;
    const ey = eyeY(p.c);
    const ez = p.c.z;
    let ox = +m.o?.[0];
    let oy = +m.o?.[1];
    let oz = +m.o?.[2];
    if (!Number.isFinite(ox) || (ox - ex) ** 2 + (oy - ey) ** 2 + (oz - ez) ** 2 > 9) {
      ox = ex;
      oy = ey;
      oz = ez;
    }
    this.noise(p, ox, oz);
    const hits = Array.isArray(m.h) ? m.h.slice(0, w.pellets || 1) : [];
    const perVictim = new Map();
    const ends = [];
    for (const h of hits) {
      if (!Array.isArray(h)) continue;
      const kind = h[0] | 0;
      const hx = +h[3];
      const hy = +h[4];
      const hz = +h[5];
      if (!Number.isFinite(hx) || !Number.isFinite(hy) || !Number.isFinite(hz)) continue;
      ends.push(r2(hx), r2(hy), r2(hz));
      const dist = Math.sqrt((hx - ox) ** 2 + (hy - oy) ** 2 + (hz - oz) ** 2);
      if (dist > w.range + 4) continue;
      if (kind === HK_CHAR) {
        const v = this.players.get(h[1] | 0);
        if (!v || !v.alive || v === p || v.c.mode === M_BUS) continue;
        // target must be near the claimed hit point (latency tolerance)
        const vx = v.c.x - hx;
        const vy = v.c.y + 0.9 - hy;
        const vz = v.c.z - hz;
        if (vx * vx + vy * vy * 0.5 + vz * vz > 4.2 * 4.2) continue;
        if (!this.clearTo(ox, oy, oz, hx, hy, hz, dist)) continue;
        const head = !!h[2];
        const dmg = w.dmg * C.falloff(w, dist) * (head ? w.head : 1);
        const e = perVictim.get(v) || { d: 0, head: false, pos: [hx, hy, hz] };
        e.d += dmg;
        e.head = e.head || head;
        perVictim.set(v, e);
      } else if (kind === HK_PIECE) {
        const pc = this.world.pieces.get(h[1] | 0);
        if (pc) this.damagePiece(pc, w.sdmg, p, false);
      } else if (kind === HK_PROP) {
        const pr = this.world.propById.get(h[1] | 0);
        if (pr && pr.alive) this.damageProp(pr, w.sdmg * 0.5, p, false);
      }
    }
    for (const [v, e] of perVictim) this.damage(v, e.d, p, s.t, e.head, e.pos);
    this.broadcast({ t: 'fx', s: p.id, w: s.t, o: [r2(ox), r2(oy), r2(oz)], e: ends }, p.conn);
  }

  // Line of sight check for validating a client hit (terrain + builds)
  clearTo(ox, oy, oz, hx, hy, hz, dist) {
    if (dist < 1.2) return true;
    const dx = (hx - ox) / dist;
    const dy = (hy - oy) / dist;
    const dz = (hz - oz) / dist;
    const hit = this.world.raycast(ox, oy, oz, dx, dy, dz, dist - 0.9, 3);
    return hit.kind === 0;
  }

  noise(p, x, z) {
    this.noises.push({ x, z, t: this.t, id: p.id });
  }

  // Bot shot: full server-side hit detection.
  botFire(p) {
    const s = this.fireCheck(p);
    if (!s) return false;
    const t = this.t;
    if (t < p.nextFire) return false;
    if (p.use) this.cancelUse(p);
    const w = C.weaponStats(s.t, s.r);
    p.nextFire = t + 1 / w.rate;
    s.n--;
    p.lastShotT = t;
    this.stats.shots++;
    const c = p.c;
    const ox = c.x;
    const oy = eyeY(c);
    const oz = c.z;
    this.noise(p, ox, oz);
    const dir = dirFromAngles(c.yaw, c.pitch, this.tmpDir);
    if (w.projectile) {
      this.spawnRocket(p, ox, oy, oz, dir[0], dir[1], dir[2], w);
      return true;
    }
    const moving = Math.abs(c.vx) + Math.abs(c.vz) > 1;
    let spread = (p.bot.inp.ads ? w.ads : w.hip) * (c.crouch ? 0.75 : 1) * (moving ? 1.25 : 1) * (c.mode === M_GROUND ? 1 : 1.6) + p.bloom;
    p.bloom = Math.min(w.bloomMax, p.bloom + w.bloom);
    const perVictim = new Map();
    const ends = [];
    const pd = this.tmpDir2;
    for (let i = 0; i < (w.pellets || 1); i++) {
      spreadDir(dir[0], dir[1], dir[2], spread, this.rng.next(), this.rng.next(), pd);
      const res = this.traceShot(p, ox, oy, oz, pd[0], pd[1], pd[2], w.range);
      ends.push(r2(res.x), r2(res.y), r2(res.z));
      if (res.kind === HK_CHAR) {
        const dmg = w.dmg * C.falloff(w, res.t) * (res.head ? w.head : 1);
        const e = perVictim.get(res.v) || { d: 0, head: false, pos: [res.x, res.y, res.z] };
        e.d += dmg;
        e.head = e.head || res.head;
        perVictim.set(res.v, e);
      } else if (res.kind === HK_PIECE) {
        this.damagePiece(res.piece, w.sdmg, p, false);
      } else if (res.kind === HK_PROP) {
        this.damageProp(res.prop, w.sdmg * 0.5, p, false);
      }
    }
    for (const [v, e] of perVictim) this.damage(v, e.d, p, s.t, e.head, e.pos);
    this.broadcast({ t: 'fx', s: p.id, w: s.t, o: [r2(ox), r2(oy), r2(oz)], e: ends });
    return true;
  }

  // Nearest hit among world + characters
  traceShot(p, ox, oy, oz, dx, dy, dz, range) {
    const hit = this.world.raycast(ox, oy, oz, dx, dy, dz, range, 7);
    let best = hit.kind ? hit.t : range;
    const res = this._res || (this._res = { kind: 0, t: 0, x: 0, y: 0, z: 0, v: null, head: false, piece: null, prop: null });
    res.kind = 0;
    res.v = null;
    res.piece = null;
    res.prop = null;
    if (hit.kind === HIT_PIECE) {
      res.kind = HK_PIECE;
      res.piece = hit.piece;
    } else if (hit.kind === HIT_PROP) {
      res.kind = HK_PROP;
      res.prop = hit.prop;
    } else if (hit.kind) res.kind = 4;
    for (const v of this.plist) {
      if (v === p || !v.alive || v.c.mode === M_BUS) continue;
      const vc = v.c;
      // broadphase: distance from ray
      const px = vc.x - ox;
      const py = vc.y + 1 - oy;
      const pz = vc.z - oz;
      const along = px * dx + py * dy + pz * dz;
      if (along < -1 || along > best + 1) continue;
      const qx = px - dx * along;
      const qy = py - dy * along;
      const qz = pz - dz * along;
      if (qx * qx + qy * qy + qz * qz > 2.5) continue;
      const tt = rayChar(ox, oy, oz, dx, dy, dz, best, vc.x, vc.y, vc.z, vc.crouch, this.hitOut);
      if (tt < best) {
        best = tt;
        res.kind = HK_CHAR;
        res.v = v;
        res.head = this.hitOut.head;
        res.piece = null;
        res.prop = null;
      }
    }
    res.t = best;
    res.x = ox + dx * best;
    res.y = oy + dy * best;
    res.z = oz + dz * best;
    return res;
  }

  // ---------------------------------------------------------------- melee / harvesting
  onMelee(p, m) {
    if (!p.alive || p.cur !== 0) return;
    const t = this.t;
    if (t < p.nextMelee - 0.12) return;
    p.nextMelee = t + 1 / C.WEAPONS.pickaxe.rate;
    p.swingT = t;
    const kind = m.k | 0;
    const hx = +m.x;
    const hy = +m.y;
    const hz = +m.z;
    if (!Number.isFinite(hx)) return;
    const ey = eyeY(p.c);
    const d2 = (hx - p.c.x) ** 2 + (hy - ey) ** 2 + (hz - p.c.z) ** 2;
    if (d2 > 5.5 * 5.5) return;
    this.applyMelee(p, kind, m.id | 0, hx, hy, hz, !!m.w);
  }

  applyMelee(p, kind, id, x, y, z, weak) {
    const W = C.WEAPONS.pickaxe;
    if (kind === HK_CHAR) {
      const v = this.players.get(id);
      if (v && v.alive && v !== p) this.damage(v, W.dmg, p, 'pickaxe', false, [x, y, z]);
    } else if (kind === HK_PIECE) {
      const pc = this.world.pieces.get(id);
      if (pc) this.damagePiece(pc, W.sdmg * (weak ? 2 : 1), p, true);
    } else if (kind === HK_PROP) {
      const pr = this.world.propById.get(id);
      if (pr && pr.alive) this.damageProp(pr, W.sdmg * (weak ? 2 : 1), p, true);
    }
  }

  botMelee(p) {
    const t = this.t;
    if (t < p.nextMelee || p.cur !== 0) return false;
    p.nextMelee = t + 1 / C.WEAPONS.pickaxe.rate;
    p.swingT = t;
    const c = p.c;
    const dir = dirFromAngles(c.yaw, c.pitch, this.tmpDir);
    const res = this.traceShot(p, c.x, eyeY(c), c.z, dir[0], dir[1], dir[2], C.WEAPONS.pickaxe.range + 0.6);
    if (res.kind === HK_CHAR) this.applyMelee(p, HK_CHAR, res.v.id, res.x, res.y, res.z, false);
    else if (res.kind === HK_PIECE) this.applyMelee(p, HK_PIECE, res.piece.id, res.x, res.y, res.z, false);
    else if (res.kind === HK_PROP) this.applyMelee(p, HK_PROP, res.prop.id, res.x, res.y, res.z, false);
    this.broadcast({ t: 'sw', s: p.id, k: res.kind, x: r2(res.x), y: r2(res.y), z: r2(res.z) });
    return res.kind;
  }

  damagePiece(pc, dmg, attacker, harvest) {
    if (!this.world.pieces.get(pc.id)) return;
    if (harvest && attacker && pc.map && !pc.owner) {
      const mi = pc.m;
      const got = Math.min(PIECE_YIELD[mi], C.MAT_MAX - attacker.mats[mi]);
      if (got > 0) {
        attacker.mats[mi] += got;
        attacker.invDirty = true;
        this.sendP(attacker, { t: 'hv', m: mi, n: got });
      }
    }
    pc.hp -= dmg;
    if (pc.hp <= 0) this.destroyPiece(pc);
    else this.broadcast({ t: 'ph', id: pc.id, hp: Math.ceil(pc.hp) });
  }

  destroyPiece(pc) {
    const P = this.world.pieces;
    if (!P.remove(pc.id)) return;
    const ids = [pc.id];
    const doomed = P.findUnsupported(pc);
    for (const q of doomed) {
      if (P.remove(q.id)) ids.push(q.id);
    }
    this.broadcast({ t: 'pd', ids });
  }

  damageProp(pr, dmg, attacker, harvest) {
    const def = PROP_TYPES[pr.type];
    if (!pr.alive || def.landmark) return;
    if (harvest && attacker && def.mat >= 0) {
      const mi = def.mat;
      const got = Math.min(def.yield, C.MAT_MAX - attacker.mats[mi]);
      if (got > 0) {
        attacker.mats[mi] += got;
        attacker.invDirty = true;
        this.sendP(attacker, { t: 'hv', m: mi, n: got });
      }
    }
    pr.hp -= dmg;
    if (pr.hp <= 0) {
      this.world.killProp(pr.id);
      this.broadcast({ t: 'xd', id: pr.id });
    } else this.broadcast({ t: 'xh', id: pr.id });
  }

  // ---------------------------------------------------------------- rockets
  onRocket(p, m) {
    if (!p.alive) return;
    if (p.reload && p.reload.t1 - this.t < 0.35) this.finishReload(p);
    const s = this.fireCheck(p);
    if (!s || s.t !== 'rocket') return;
    const w = C.weaponStats(s.t, s.r);
    if (this.t < p.nextFire - 0.15) return;
    p.nextFire = this.t + 1 / w.rate;
    s.n--;
    const c = p.c;
    let dx = +m.d?.[0];
    let dy = +m.d?.[1];
    let dz = +m.d?.[2];
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(l > 0.5 && l < 1.5)) return;
    dx /= l;
    dy /= l;
    dz /= l;
    this.noise(p, c.x, c.z);
    this.spawnRocket(p, c.x, eyeY(c), c.z, dx, dy, dz, w);
  }

  spawnRocket(p, x, y, z, dx, dy, dz, w) {
    const r = { id: this.nextRocketId++, owner: p, x, y, z, dx, dy, dz, v: w.speed, life: 6, w };
    // start slightly ahead so we don't hit ourselves
    r.x += dx * 0.8;
    r.y += dy * 0.8;
    r.z += dz * 0.8;
    this.rockets.push(r);
    this.broadcast({ t: 'rk', id: r.id, s: p.id, o: [r2(r.x), r2(r.y), r2(r.z)], d: [r3(dx), r3(dy), r3(dz)], v: w.speed });
  }

  updateRockets(dt) {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      const stepL = r.v * dt;
      r.life -= dt;
      const res = this.traceShot(r.owner, r.x, r.y, r.z, r.dx, r.dy, r.dz, stepL);
      const wh = r.dy < 0 ? (0 - r.y) / r.dy : Infinity;
      if (res.kind || r.life <= 0 || wh < stepL) {
        this.explode(r, res.kind ? res.x : r.x + r.dx * Math.min(stepL, wh), res.kind ? res.y : r.y + r.dy * Math.min(stepL, wh), res.kind ? res.z : r.z + r.dz * Math.min(stepL, wh));
        this.rockets.splice(i, 1);
        continue;
      }
      r.x += r.dx * stepL;
      r.y += r.dy * stepL;
      r.z += r.dz * stepL;
    }
  }

  explode(r, x, y, z) {
    const R = r.w.splash;
    this.broadcast({ t: 'bm', id: r.id, x: r2(x), y: r2(y), z: r2(z) });
    for (const v of this.plist) {
      if (!v.alive || v.c.mode === M_BUS) continue;
      const dx = v.c.x - x;
      const dy = v.c.y + 0.9 - y;
      const dz = v.c.z - z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > R) continue;
      if (d > 1 && !this.world.los(x, y + 0.2, z, v.c.x, v.c.y + 0.9, v.c.z, 3)) continue;
      const dmg = r.w.dmg * (1 - 0.6 * (d / R));
      this.damage(v, dmg, r.owner, 'rocket', false, [v.c.x, v.c.y + 1, v.c.z]);
    }
    const hit = [];
    this.world.pieces.query(x - R, y - R, z - R, x + R, y + R, z + R, (pc) => {
      const a = pc.aabb;
      const cx = clamp(x, a[0], a[3]);
      const cy = clamp(y, a[1], a[4]);
      const cz = clamp(z, a[2], a[5]);
      if ((cx - x) ** 2 + (cy - y) ** 2 + (cz - z) ** 2 < R * R * 0.6) hit.push(pc);
    });
    for (const pc of hit) this.damagePiece(pc, r.w.sdmg, r.owner, false);
    this.world.queryProps(x - R, z - R, x + R, z + R, (pr) => {
      if ((pr.x - x) ** 2 + (pr.z - z) ** 2 < R * R) this.damageProp(pr, r.w.sdmg * 0.5, r.owner, false);
    });
  }

  // ---------------------------------------------------------------- building
  onBuild(p, m) {
    const t = { k: m.k | 0, x: m.x | 0, y: m.y | 0, z: m.z | 0, o: m.o | 0 };
    const mat = clamp(m.m | 0, 0, 2);
    const ok = this.tryBuild(p, t, mat, m.tmp | 0);
    if (!ok) this.sendP(p, { t: 'prj', tmp: m.tmp | 0 });
  }

  tryBuild(p, t, mat, tmp = 0) {
    if (!p.alive || (p.c.mode !== M_GROUND && p.c.mode !== M_SWIM)) return false;
    if (t.k < 0 || t.k > 3) return false;
    if (p.mats[mat] < C.BUILD_COST) return false;
    const cx = t.x * C.GRID + 2 - p.c.x;
    const cz = t.z * C.GRID + 2 - p.c.z;
    const cy = t.y * C.LEVEL + 2 - p.c.y;
    if (cx * cx + cz * cz > 13 * 13 || Math.abs(cy) > 14) return false;
    if (placeCheck(this.world, t) !== 0) return false;
    const max = C.MATERIALS[mat].hp;
    const pc = {
      id: this.nextPieceId++,
      k: t.k,
      x: t.x,
      y: t.y,
      z: t.z,
      o: t.o,
      m: mat,
      c: DEFAULT_TINT[mat],
      v: 0,
      hp: max * 0.3,
      max,
      anchored: false,
      map: false,
      owner: p.id,
      building: true,
    };
    if (!this.world.pieces.add(pc)) return false;
    this.building.push(pc);
    p.mats[mat] -= C.BUILD_COST;
    p.invDirty = true;
    this.stats.builds++;
    this.broadcast({ t: 'pa', p: [pc.id, pc.k, pc.x, pc.y, pc.z, pc.o, pc.m, pc.c, pc.v, Math.ceil(pc.hp), max], o: p.id, tmp });
    return pc;
  }

  updateBuilding(dt) {
    for (let i = this.building.length - 1; i >= 0; i--) {
      const pc = this.building[i];
      if (!this.world.pieces.get(pc.id)) {
        this.building.splice(i, 1);
        continue;
      }
      pc.hp += (pc.max * 0.7 * dt) / C.MATERIALS[pc.m].time;
      if (pc.hp >= pc.max || pc.hp >= pc.max * 0.999) {
        pc.hp = Math.min(pc.hp, pc.max);
        pc.building = false;
        this.building.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------- debug helpers
  debugCmd(p, m) {
    switch (m.a) {
      case 'give': {
        const t = String(m.it);
        if (C.isWeapon(t)) this.giveDirect(p, { t, r: clamp(m.r | 0, 0, 4), n: C.WEAPONS[t].mag });
        else if (C.isConsumable(t)) this.giveDirect(p, { t, r: 1, n: C.CONSUMABLES[t].stack });
        else if (t === 'ammo') for (const k of C.AMMO_LIST) p.ammo[k] = C.AMMO[k].max;
        else if (t === 'mats') p.mats = [500, 500, 500];
        else if (t === 'shield') p.sh = 100;
        p.invDirty = true;
        break;
      }
      case 'god':
        p.god = !p.god;
        break;
      case 'tp':
        p.trustT = this.t + 1.5;
        break;
      case 'bots': {
        // move some bots next to the player (for testing fights)
        const n = m.n | 0 || 3;
        let k = 0;
        for (const b of this.plist) {
          if (b.human || !b.alive || k >= n) continue;
          if (b.c.mode === M_BUS) this.jumpBus(b, true);
          const a = (k / n) * Math.PI * 2;
          b.c.x = p.c.x + Math.cos(a) * (m.d || 18);
          b.c.z = p.c.z + Math.sin(a) * (m.d || 18);
          b.c.y = this.world.groundAt(b.c.x, b.c.z, p.c.y + 30) + 0.05;
          b.c.mode = M_GROUND;
          b.c.grounded = true;
          b.c.vy = 0;
          b.landedT = this.t;
          this.giveDirect(b, { t: 'ar', r: 2, n: 30 });
          b.ammo.medium = 120;
          b.bot.state = 'loot';
          k++;
        }
        break;
      }
      case 'storm':
        // fast-forward the storm to its next phase
        this.plan.t0 -= clamp(+m.s || 30, 0, 600);
        this.broadcast({ t: 'plan', plan: this.plan });
        break;
      default:
        break;
    }
  }

  giveDirect(p, it) {
    const e = p.slots.indexOf(null);
    if (e >= 0) p.slots[e] = it;
    else p.slots[Math.max(0, p.cur - 1)] = it;
    const w = C.WEAPONS[it.t];
    if (w && w.ammo) p.ammo[w.ammo] = Math.max(p.ammo[w.ammo], w.mag * 3);
    p.invDirty = true;
  }

  // ---------------------------------------------------------------- queries for bots
  itemsNear(x, z, r, fn) {
    this.igrid.query(x, z, r, fn);
  }
}

export { weaponScore, M_BUS, M_FALL, M_GLIDE, M_GROUND, M_SWIM, M_DEAD, HIT_TERRAIN };
