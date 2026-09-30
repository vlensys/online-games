// In-match client: owns the local world mirror, predicts the local player, interpolates
// everyone else from snapshots, does client-side hit detection, building, HUD and camera.
import * as THREE from 'three';
import * as C from '../core/config.js';
import { generateMap, DEFAULT_TINT } from '../core/mapgen.js';
import { World, HIT_PIECE, HIT_PROP, HIT_TERRAIN, HIT_WATER } from '../core/world.js';
import { generateFloorLoot } from '../core/items.js';
import { stormState, outsideStorm } from '../core/storm.js';
import { makeChar, makeInput, makeStepOut, stepChar, eyeY, M_BUS, M_FALL, M_GLIDE, M_GROUND, M_SWIM, M_DEAD } from '../core/physics.js';
import { rayChar, spreadDir, decodeItem, wrapAngle, HK_NONE, HK_CHAR, HK_PIECE, HK_PROP, HK_WORLD } from '../core/combat.js';
import { buildTarget, placeCheck } from '../core/buildtarget.js';
import { K_WALL, K_FLOOR, K_RAMP, K_CONE, PIECE_NAMES } from '../core/pieces.js';
import { PROP_TYPES } from '../core/props.js';
import { busPos, F_CROUCH, F_ADS, F_SPRINT, F_BUILD, F_HEAL, F_RELOAD, F_SWING } from '../core/match.js';
import { MapPainter, killfeedHtml, fmtTime } from './hud.js';

const INTERP = 0.11;
const MAT_KEYS = ['wood', 'brick', 'metal'];
const DIG = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'];
const PIECE_KEY = { KeyQ: 0, KeyZ: 1, KeyX: 2, KeyV: 3 };
const SURF_COL = [0xcdb58a, 0xb98a55, 0x9aa0a6];

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = [0, 0, 0];
const _pd = [0, 0, 0];
const _hit = { head: false };

export class Game {
  constructor(o) {
    this.o = o;
    this.R = o.renderer;
    this.hud = o.hud;
    this.input = o.input;
    this.touch = o.touch;
    this.sfx = o.sfx;
    this.S = o.settings;
    this.link = o.link;
    this.ts = o.ts || 1;
    const s = o.start;
    this.startMsg = s;
    this.myId = s.you;
    this.debug = !!s.debug;
    this.plan = s.plan;
    this.bus = s.bus;
    this.cfg = s.cfg || {};
    this.solo = !!this.cfg.solo;
    this.map = generateMap(s.seed);
    this.world = new World(this.map);
    const loot = generateFloorLoot(this.map, s.lootSeed, s.loot);
    this.items = new Map();
    for (const it of loot.items) this.items.set(it.id, it);
    this.chestAvail = loot.chests;
    this.boxAvail = loot.boxes;
    this.R.buildWorld(this.map, this.world, loot);
    this.V = this.R.views;
    this.V.items.set(this.items);
    this.painter = new MapPainter(this.map);
    this.players = new Map();
    this.names = new Map();
    for (const p of s.players) {
      this.players.set(p.id, {
        id: p.id,
        name: p.n,
        human: !!p.h,
        outfit: p.o,
        snaps: [],
        alive: true,
        vis: false,
        r: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, mode: M_BUS, crouch: false, flags: 0, item: null, hp: 100, sh: 0, grounded: true },
        walk: 0,
        speed: 0,
        px: 0,
        pz: 0,
        stepPhase: 0,
        swing: 0,
      });
      this.names.set(p.id, p.n);
    }
    this.aliveCount = s.players.length;
    const me = this.players.get(this.myId);
    this.me = {
      c: makeChar(),
      inp: makeInput(),
      out: makeStepOut(),
      alive: true,
      hp: 100,
      sh: 0,
      inv: { slots: [null, null, null, null, null], cur: 0, ammo: { light: 0, medium: 0, heavy: 0, shells: 0, rockets: 0 }, mats: C.START_MATS.slice() },
      cur: 0,
      q: 0,
      pending: [],
      corr: 0,
      nextFire: 0,
      bloom: 0,
      recoil: 0,
      reload: null,
      use: null,
      build: false,
      piece: 0,
      mat: 0,
      rot: 0,
      lastPlace: 0,
      lastSlotKey: '',
      ads: false,
      adsT: 0,
      crouch: false,
      kills: 0,
      dmg: 0,
      swingT: -9,
      walk: 0,
      stepPhase: 0,
      outfit: me ? me.outfit : C.OUTFIT_COLORS.slice(0, 5),
      tmpId: -1,
      temps: new Map(),
      lastSend: 0,
      landT: 0,
      lastHitPos: null,
      dead: null,
      placeHeld: 0,
    };
    this.me.c.mode = M_BUS;
    this.yaw = 0;
    this.pitch = -0.15;
    this.state = 'wait';
    this.offset = null;
    this.clock = 0;
    this.T = 0;
    this.storm = stormState(this.plan, 0, {});
    this.lastPhaseKey = '';
    this.specId = 0;
    this.mapOpen = false;
    this.mapT = 0;
    this.pieceHpT = 0;
    this.pieceHpRef = null;
    this.shake = 0;
    this.result = null;
    this.ended = false;
    this.fpsAcc = 0;
    this.fpsN = 0;
    this.camPos = new THREE.Vector3();
    this.aimPoint = new THREE.Vector3();
    this.aimHit = { kind: HK_NONE, id: 0 };
    this.onUseTarget = null;
    this.link.onMessages = (msgs) => this.onNet(msgs);
    this.link.onClose = (why) => this.o.onDisconnect && this.o.onDisconnect(why);
    this.hud.clearTransient();
    this.hud.onSlot = (i) => this.selectSlot(i);
    this.hud.onPiece = (i) => this.enterBuild(i);
    this.sendCmd({ t: 'ld' }, false);
    this.link.flush();
    window.__storm = this;
  }

  // ---------------------------------------------------------------- time
  now() {
    return performance.now() / 1000;
  }
  serverNow() {
    if (this.offset === null) return 0;
    return this.now() * this.ts + this.offset;
  }

  sendCmd(m, seq = true) {
    if (seq) m.q = ++this.me.q;
    this.link.send(m);
    return m.q;
  }

  // ---------------------------------------------------------------- network
  onNet(msgs) {
    for (const m of msgs) {
      try {
        this.handle(m);
      } catch (e) {
        console.error('client handle', m && m.t, e);
      }
    }
  }

  handle(m) {
    const me = this.me;
    switch (m.t) {
      case 's':
        this.onSnap(m);
        break;
      case 'go':
        this.state = 'bus';
        this.hud.big('JUMP FROM THE BUS', 3);
        break;
      case 'drop': {
        const c = me.c;
        const fresh = this.now() - (me.jumpT || 0) < 1.5;
        if (c.mode === M_BUS || (fresh && c.mode === M_FALL && Math.hypot(c.x - m.x, c.z - m.z) > 20)) {
          c.x = m.x;
          c.y = m.y;
          c.z = m.z;
          c.vx = c.vz = 0;
          c.vy = -5;
        }
        if (c.mode === M_BUS) c.mode = M_FALL;
        this.state = 'play';
        if (m.f) this.hud.alert('The bus dropped you off', '', 2);
        break;
      }
      case 'pos':
        me.c.x = m.x;
        me.c.y = m.y;
        me.c.z = m.z;
        me.c.vx = me.c.vy = me.c.vz = 0;
        me.corr = m.c;
        break;
      case 'inv':
        this.onInv(m);
        break;
      case 'hu':
        this.onHurt(m);
        break;
      case 'ht':
        this.onHitConfirm(m);
        break;
      case 'kf':
        this.onKill(m);
        break;
      case 'dead':
        this.onDead(m);
        break;
      case 'end':
        this.onEnd(m);
        break;
      case 'fx':
        this.onFx(m);
        break;
      case 'sw':
        this.onSwing(m);
        break;
      case 'pa':
        this.onPieceAdd(m);
        break;
      case 'prj':
        this.removeTemp(m.tmp);
        break;
      case 'ph': {
        const p = this.world.pieces.get(m.id);
        if (p) {
          p.hp = m.hp;
          this.V.pieces.update(p);
        }
        break;
      }
      case 'pd':
        for (const id of m.ids) {
          const p = this.world.pieces.get(id);
          if (!p) continue;
          const a = p.aabb;
          const cx = (a[0] + a[3]) / 2;
          const cy = (a[1] + a[4]) / 2;
          const cz = (a[2] + a[5]) / 2;
          if (this.camPos.distanceToSquared(_v1.set(cx, cy, cz)) < 120 * 120) {
            this.V.fx.burst(cx, cy, cz, p.c || DEFAULT_TINT[p.m], 10, 4, 2.2, 12);
            this.sfx.impact(p.m, cx, cy, cz, 1.3);
          }
          this.world.pieces.remove(id);
          this.V.pieces.remove(id);
        }
        break;
      case 'xd': {
        const p = this.world.propById.get(m.id);
        if (p) {
          const def = PROP_TYPES[p.type];
          this.world.killProp(m.id);
          this.V.props.kill(m.id);
          if (this.camPos.distanceToSquared(_v1.set(p.x, p.y, p.z)) < 120 * 120) {
            this.V.fx.burst(p.x, p.y + 2, p.z, def.tree ? 0x4f9a3a : def.mat === 1 ? 0x9ea3a8 : 0x8a8f96, 14, 5, 2.4, 10);
            this.sfx.impact(Math.max(0, def.mat), p.x, p.y + 1, p.z, 1.4);
          }
        }
        break;
      }
      case 'xh':
        this.V.props.hit(m.id);
        break;
      case 'ia':
        for (const a of m.i) {
          const it = { id: a[0], t: C.ITEM_TYPES[a[1]], r: a[2], n: a[3], x: a[4], y: a[5], z: a[6] };
          this.items.set(it.id, it);
        }
        break;
      case 'ir':
        this.items.delete(m.id);
        break;
      case 'iu': {
        const it = this.items.get(m.id);
        if (it) it.n = m.n;
        break;
      }
      case 'co': {
        this.V.chests.open(m.k, m.id);
        if (m.k === 'b') this.boxAvail[m.id] = false;
        else this.chestAvail[m.id] = false;
        const ch = (m.k === 'b' ? this.map.boxes : this.map.chests)[m.id];
        if (ch) this.sfx.chest(ch.x, ch.y, ch.z);
        break;
      }
      case 'rk':
        this.V.fx.rocket(m.id, m.o, m.d, m.v);
        if (m.s !== this.myId) this.sfx.shot('rocket', m.o[0], m.o[1], m.o[2]);
        break;
      case 'bm': {
        this.V.fx.removeRocket(m.id);
        this.V.fx.boom(m.x, m.y, m.z);
        this.sfx.boom(m.x, m.y, m.z);
        const d = this.camPos.distanceTo(_v1.set(m.x, m.y, m.z));
        if (d < 40) this.shake = Math.max(this.shake, 0.5 * (1 - d / 40));
        break;
      }
      case 'us':
        if (!me.use) me.use = { t0: this.now(), t1: this.now() + m.d / this.ts, slot: me.cur };
        break;
      case 'ud':
        if (me.use) this.sfx.heal(true);
        me.use = null;
        break;
      case 'ux':
        me.use = null;
        break;
      case 'got':
        this.sfx.pickup();
        break;
      case 'hv':
        if (me.lastHitPos) this.hud.number(me.lastHitPos[0], me.lastHitPos[1] + 0.4, me.lastHitPos[2], '+' + m.n, 'mat');
        break;
      case 'msg':
        this.hud.alert(m.m, '', 2);
        break;
      case 'plan':
        this.plan = m.plan;
        break;
      case 'lobby':
        if (this.o.onLobby) this.o.onLobby(m);
        break;
      case 'rej':
        if (this.o.onDisconnect) this.o.onDisconnect(m.r);
        break;
      default:
        break;
    }
  }

  onSnap(m) {
    const local = this.now() * this.ts;
    const sample = m.T - local;
    if (this.offset === null || sample > this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.02;
    if (this.state === 'wait') this.state = 'bus';
    this.aliveCount = m.a;
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    for (const r of m.p) {
      const id = r[0];
      const pl = this.players.get(id);
      if (!pl) continue;
      seen.add(id);
      if (id === this.myId) {
        this.me.hp = r[9];
        this.me.sh = r[10];
        pl.hpSnap = r[9];
        continue;
      }
      const sn = { T: m.T, x: r[1], y: r[2], z: r[3], yaw: r[4], pitch: r[5], mode: r[6], flags: r[7], item: r[8], hp: r[9], sh: r[10] };
      if (!pl.vis) {
        pl.snaps.length = 0;
        pl.r.x = sn.x;
        pl.r.y = sn.y;
        pl.r.z = sn.z;
        pl.px = sn.x;
        pl.pz = sn.z;
      }
      pl.snaps.push(sn);
      if (pl.snaps.length > 12) pl.snaps.shift();
      pl.vis = true;
      pl.alive = true;
    }
    for (const pl of this.players.values()) if (pl.vis && !seen.has(pl.id)) pl.vis = false;
  }

  onInv(m) {
    const me = this.me;
    const inv = me.inv;
    inv.slots = m.s.map((s) => (s ? { t: s[0], r: s[1], n: s[2] } : null));
    inv.cur = m.c;
    C.AMMO_LIST.forEach((k, i) => (inv.ammo[k] = m.a[i]));
    const oldMats = inv.mats;
    inv.mats = m.m.slice();
    // re-apply shots the server hasn't processed yet
    me.pending = me.pending.filter((p) => p.q > m.q);
    for (const p of me.pending) {
      const s = inv.slots[p.slot - 1];
      if (s && C.isWeapon(s.t) && s.n > 0) s.n--;
    }
    // re-apply our own not-yet-confirmed builds
    for (const tp of me.temps.values()) if (tp.q > m.q) inv.mats[tp.m] = Math.max(0, inv.mats[tp.m] - C.BUILD_COST);
    void oldMats;
    // a local reload that already finished but the server hasn't finished yet (it started later)
    const rd = me.reloadDone;
    if (rd && this.now() - rd.t < 1.2 * Math.max(1, this.ts) && rd.slot === me.cur) {
      const s = inv.slots[rd.slot - 1];
      if (s && C.WEAPONS[s.t] && s.t === rd.type && s.n < rd.n) {
        const w = C.WEAPONS[s.t];
        const take = Math.min(rd.n - s.n, inv.ammo[w.ammo]);
        s.n += take;
        inv.ammo[w.ammo] -= take;
      } else me.reloadDone = null;
    } else me.reloadDone = null;
  }

  onHurt(m) {
    const me = this.me;
    if (m.a && m.a !== this.myId) {
      const pl = this.players.get(m.a);
      const ax = pl && pl.vis ? pl.r.x : m.x;
      const az = pl && pl.vis ? pl.r.z : m.z;
      const ang = Math.atan2(-(ax - me.c.x), -(az - me.c.z));
      this.hud.dmgDir(-(ang - this.yaw));
    }
    const hadShield = me.sh > 0;
    if (m.s && hadShield && me.sh - m.d <= 0) this.sfx.shieldBreak();
    else this.sfx.hurt(!!m.s);
    // immediate local estimate (snapshot will correct)
    let d = m.d;
    if (m.k !== 'storm' && m.k !== 'fall') {
      const sd = Math.min(me.sh, d);
      me.sh -= sd;
      d -= sd;
    }
    me.hp = Math.max(0, me.hp - d);
    this.shake = Math.max(this.shake, Math.min(0.25, m.d / 200));
  }

  onHitConfirm(m) {
    const me = this.me;
    me.dmg += m.d;
    this.hud.hitmarker(m.k ? 'kill' : m.h ? 'head' : 'body');
    this.hud.number(m.x, m.y + 0.3, m.z, String(m.d), m.h ? 'hs' : m.s ? 'sh' : '');
    this.sfx.hitmark(!!m.h, !!m.s);
  }

  onKill(m) {
    this.aliveCount = m.a;
    this.hud.killfeed(killfeedHtml(this.names, this.myId, m));
    const v = this.players.get(m.v);
    if (v) {
      v.alive = false;
      v.vis = false;
      if (v.r && this.camPos.distanceToSquared(_v1.set(v.r.x, v.r.y, v.r.z)) < 150 * 150) this.V.fx.burst(v.r.x, v.r.y + 1, v.r.z, 0x7fd0ff, 18, 3, 1.4, -2);
    }
    if (m.k === this.myId && m.v !== this.myId) {
      this.me.kills++;
      this.sfx.elim();
      this.hud.alert('You eliminated ' + (this.names.get(m.v) || '?'), 'good', 3);
    }
    if (m.v === this.specId && this.me.dead) {
      this.specKiller = m.k;
      this.specSwitchT = this.now() + 1.2;
    }
    if (!this.me.dead && [25, 10, 5, 3, 2].includes(m.a)) this.hud.alert(m.a + ' players left', '', 2.5);
  }

  onDead(m) {
    const me = this.me;
    me.alive = false;
    me.dead = m;
    me.c.mode = M_DEAD;
    me.build = false;
    me.use = null;
    me.reload = null;
    this.state = 'dead';
    this.specId = m.by && m.by !== this.myId ? m.by : this.pickSpec(0);
    this.hud.big(m.place === 1 ? '' : 'ELIMINATED', 2);
    this.V.fx.burst(me.c.x, me.c.y + 1, me.c.z, 0x7fd0ff, 20, 3, 1.4, -2);
    setTimeout(() => {
      if (this.destroyed || this.ended) return;
      this.showResults(false);
    }, 1600 / Math.min(4, this.ts));
  }

  onEnd(m) {
    this.ended = true;
    this.endMsg = m;
    this.state = 'end';
    const win = m.w === this.myId;
    if (win) {
      this.me.dead = { place: 1, kills: this.me.kills, dmg: this.me.dmg, T: m.T };
      this.hud.big('#1 - STORM CHAMPION', 4);
      this.sfx.elim();
    }
    this.specId = m.w;
    setTimeout(() => {
      if (!this.destroyed) this.showResults(true);
    }, (win ? 2600 : 1200) / Math.min(4, this.ts));
  }

  showResults(final) {
    const me = this.me;
    const d = me.dead || { place: this.aliveCount, kills: me.kills, dmg: me.dmg, T: this.T };
    let top = [];
    if (final && this.endMsg) top = this.endMsg.r.slice(0, 5).map((r) => ({ name: this.names.get(r[0]) || '?', place: r[1], kills: r[2], me: r[0] === this.myId }));
    const killer = d.by ? this.names.get(d.by) : null;
    const res = {
      place: d.place,
      win: d.place === 1,
      final,
      kills: d.kills !== undefined ? d.kills : me.kills,
      dmg: d.dmg !== undefined ? d.dmg : Math.round(me.dmg),
      time: d.T || this.T,
      sub:
        d.place === 1
          ? 'You are the last one standing.'
          : killer
            ? 'Eliminated by ' + killer
            : d.w === 'storm'
              ? 'Lost in the storm'
              : d.w === 'fall'
                ? 'Took a bad fall'
                : 'Eliminated',
      top,
      winner: final && this.endMsg ? this.names.get(this.endMsg.w) : null,
    };
    this.result = res;
    if (this.o.onResults) this.o.onResults(res);
  }

  pickSpec(dir) {
    const alive = [...this.players.values()].filter((p) => p.alive && p.id !== this.myId);
    if (!alive.length) return 0;
    alive.sort((a, b) => a.id - b.id);
    let i = alive.findIndex((p) => p.id === this.specId);
    i = i < 0 ? 0 : (i + dir + alive.length) % alive.length;
    return alive[i].id;
  }

  onFx(m) {
    if (m.s === this.myId) return;
    const [ox, oy, oz] = m.o;
    const d2 = this.camPos.distanceToSquared(_v1.set(ox, oy, oz));
    this.sfx.shot(m.w, ox, oy, oz);
    if (d2 > 260 * 260) return;
    const pl = this.players.get(m.s);
    if (pl) pl.fireT = this.now();
    let mx = ox;
    let my = oy;
    let mz = oz;
    if (pl && pl.vis) {
      const yaw = pl.r.yaw;
      mx = pl.r.x - Math.sin(yaw) * 0.8 + Math.cos(yaw) * 0.18;
      my = pl.r.y + (pl.r.crouch ? 0.95 : 1.4);
      mz = pl.r.z - Math.cos(yaw) * 0.8 - Math.sin(yaw) * 0.18;
    }
    this.V.fx.flash(mx, my, mz);
    const e = m.e || [];
    for (let i = 0; i + 2 < e.length; i += 3) {
      if (i < 3 * 3 || m.w !== 'shotgun') this.V.fx.tracer(mx, my, mz, e[i], e[i + 1], e[i + 2], m.w === 'sniper' ? 0xffffff : 0xfff1b0);
      if (Math.random() < 0.6) this.V.fx.burst(e[i], e[i + 1], e[i + 2], 0xd8cbb0, 2, 1.5, 0.7);
    }
  }

  onSwing(m) {
    const pl = this.players.get(m.s);
    if (pl) pl.swing = 0.001;
    if (m.k === HK_PIECE || m.k === HK_PROP) {
      if (this.camPos.distanceToSquared(_v1.set(m.x, m.y, m.z)) < 60 * 60) {
        this.sfx.impact(0, m.x, m.y, m.z, 0.8);
        this.V.fx.burst(m.x, m.y, m.z, 0xb98a55, 4, 2, 0.8);
      }
    }
  }

  onPieceAdd(m) {
    const a = m.p;
    const P = this.world.pieces;
    if (m.o === this.myId && m.tmp) this.removeTemp(m.tmp, true);
    const piece = { id: a[0], k: a[1], x: a[2], y: a[3], z: a[4], o: a[5], m: a[6], c: a[7], v: a[8], hp: a[9], max: a[10], owner: m.o, map: false };
    // a local temp piece in the same slot loses
    const clash = P.atSlot(piece.k, piece.x, piece.y, piece.z, piece.o);
    if (clash && clash.id < 0) this.removeTemp(clash.id);
    else if (clash) return;
    if (P.add(piece)) {
      this.V.pieces.add(piece);
      if (m.o !== this.myId) this.sfx.build(piece.m, piece.x * 4 + 2, piece.y * 4 + 2, piece.z * 4 + 2);
    }
  }

  removeTemp(tmp, confirmed = false) {
    const t = this.me.temps.get(tmp);
    if (!t) return;
    this.me.temps.delete(tmp);
    this.world.pieces.remove(tmp);
    this.V.pieces.remove(tmp);
    if (!confirmed) this.me.inv.mats[t.m] = Math.min(C.MAT_MAX, this.me.inv.mats[t.m] + C.BUILD_COST);
  }

  // ---------------------------------------------------------------- inventory helpers
  held() {
    const me = this.me;
    return me.cur > 0 ? me.inv.slots[me.cur - 1] : null;
  }

  selectSlot(i) {
    const me = this.me;
    if (!me.alive) return;
    if (i < 0 || i > 5) return;
    me.build = false;
    if (me.cur === i) return;
    me.cur = i;
    me.reload = null;
    me.reloadDone = null;
    if (me.use) {
      me.use = null;
    }
    me.bloom = 0;
    me.nextFire = Math.max(me.nextFire, this.now() + 0.2);
    this.sendCmd({ t: 'sl', i });
    this.sfx.ui();
  }

  enterBuild(k) {
    const me = this.me;
    if (!me.alive || this.state === 'bus') return;
    if (me.build && me.piece === k) {
      me.build = false;
      return;
    }
    me.build = true;
    me.piece = k;
    me.ads = false;
    if (me.use) {
      this.sendCmd({ t: 'cx' });
      me.use = null;
    }
    me.reload = null;
    if (me.inv.mats[me.mat] < C.BUILD_COST) {
      for (let i = 0; i < 3; i++)
        if (me.inv.mats[i] >= C.BUILD_COST) {
          me.mat = i;
          break;
        }
    }
  }

  // ---------------------------------------------------------------- per frame
  frame(dt) {
    if (this.destroyed) return;
    const now = this.now();
    this.clock += dt;
    this.T = this.serverNow();
    stormState(this.plan, Math.max(0, this.T), this.storm);
    const A = this.gatherActions(dt);
    this.updateLocal(dt, A);
    this.updateRemotes(dt);
    this.updateCamera(dt, A);
    this.updateAim();
    if (this.me.alive && this.state === 'play') this.updateCombat(dt, A, now);
    this.updateHud(dt, A);
    this.renderChars(dt);
    const cam = this.R.camera;
    this.V.fx.update(dt, cam);
    this.V.items.update(this.clock, cam.position.x, cam.position.z);
    this.V.storm.update(this.storm, this.clock);
    this.V.pieces.flush();
    this.sfx.setListener(cam.position.x, cam.position.y, cam.position.z, this.yaw);
    this.updateLoops();
    this.R.frame(dt, this.clock);
    this.hud.update(dt, cam);
    // send our state ~30 Hz
    if (this.me.alive && this.me.c.mode !== M_BUS && this.state !== 'wait' && now - this.me.lastSend >= 1 / 30 - 0.002) {
      this.me.lastSend = now;
      const c = this.me.c;
      const f = (c.crouch ? F_CROUCH : 0) | (this.me.ads ? F_ADS : 0) | (this.me.inp.sprint ? F_SPRINT : 0) | (this.me.build ? F_BUILD : 0);
      this.link.send({ t: 'in', x: +c.x.toFixed(3), y: +c.y.toFixed(3), z: +c.z.toFixed(3), yw: +this.yaw.toFixed(3), pt: +this.pitch.toFixed(3), m: c.mode, f, c: this.me.corr });
    }
    this.link.flush();
  }

  gatherActions(dt) {
    const I = this.input;
    const T = this.touch;
    const touch = this.o.isTouch();
    const A = {};
    const kd = (c) => I.down(c);
    const kh = (c) => I.hit(c);
    A.fwd = (kd('KeyW') || kd('ArrowUp') ? 1 : 0) - (kd('KeyS') || kd('ArrowDown') ? 1 : 0);
    A.right = (kd('KeyD') || kd('ArrowRight') ? 1 : 0) - (kd('KeyA') || kd('ArrowLeft') ? 1 : 0);
    A.sprint = kd('ShiftLeft') || kd('ShiftRight');
    A.jump = kh('Space');
    A.jumpHeld = kd('Space');
    A.crouch = kh('KeyC');
    A.fire = I.mouse(0);
    A.fireHit = I.mouseHit(0);
    A.ads = I.mouse(2);
    A.adsHit = I.mouseHit(2);
    A.reload = kh('KeyR');
    A.use = kh('KeyE');
    A.buildToggle = kh('KeyB') || kh('KeyF');
    A.piece = -1;
    for (const k of Object.keys(PIECE_KEY)) if (kh(k)) A.piece = PIECE_KEY[k];
    A.rotate = kh('KeyG') || (this.me.build && kh('KeyR'));
    A.mat = kh('KeyT') || (this.me.build && A.adsHit);
    A.slot = -1;
    DIG.forEach((k, i) => {
      if (kh(k)) A.slot = i;
    });
    A.wheel = I.takeWheel();
    A.map = kh('KeyM');
    A.pause = kh('KeyP');
    let [dx, dy] = I.takeLook();
    const sensMul = this.me.ads ? this.S.adsSens / (this.adsZoom || 1) : 1;
    A.lookX = dx * 0.0022 * this.S.sens * sensMul;
    A.lookY = dy * 0.0022 * this.S.sens * sensMul;
    if (touch) {
      if (Math.abs(T.mx) > 0.12 || Math.abs(T.my) > 0.12) {
        A.fwd = T.my;
        A.right = T.mx;
        A.sprint = T.sprint;
      }
      A.jump = A.jump || T.hit('jump') || (this.me.c.mode === M_BUS && T.hit('fire'));
      A.crouch = A.crouch || T.hit('crouch');
      A.fire = A.fire || T.down('fire');
      A.fireHit = A.fireHit || T.hit('fire');
      if (T.hit('aim')) this.touchAds = !this.touchAds;
      A.ads = A.ads || !!this.touchAds;
      A.reload = A.reload || T.hit('reload');
      A.use = A.use || T.hit('use');
      if (T.hit('build')) A.buildToggle = true;
      for (let i = 0; i < 4; i++) if (T.hit('p' + i)) A.piece = i;
      A.rotate = A.rotate || T.hit('rotate');
      A.mat = A.mat || T.hit('mat');
      A.map = A.map || T.hit('map');
      A.pause = A.pause || T.hit('pause');
      [dx, dy] = T.takeLook();
      const ts = this.S.touchSens * 0.0048 * (this.me.ads ? this.S.adsSens / (this.adsZoom || 1) : 1);
      A.lookX += dx * ts;
      A.lookY += dy * ts;
    }
    if (this.S.invertY) A.lookY = -A.lookY;
    I.endFrame();
    T.endFrame();
    void dt;
    return A;
  }

  updateLocal(dt, A) {
    const me = this.me;
    const c = me.c;
    // look
    this.yaw = wrapAngle(this.yaw - A.lookX);
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - A.lookY));
    if (A.map) this.toggleMap();
    if (A.pause && this.o.onPause) this.o.onPause();
    if (!me.alive) {
      if ((A.jump || A.fireHit) && this.state !== 'end') this.specId = this.pickSpec(1);
      if (this.specSwitchT && this.now() > this.specSwitchT) {
        this.specSwitchT = 0;
        const k = this.players.get(this.specKiller);
        this.specId = k && k.alive ? k.id : this.pickSpec(1);
      }
      return;
    }
    if (c.mode === M_BUS) {
      busPos(this.bus, Math.max(0, this.T), _dir);
      c.x = _dir[0];
      c.y = _dir[1];
      c.z = _dir[2];
      if (A.jump && this.state === 'bus' && this.T >= this.bus.door) {
        this.sendCmd({ t: 'jmp' });
        me.jumpT = this.now();
        c.mode = M_FALL;
        c.y = this.bus.y - 3;
        c.vy = -5;
        c.vx = c.vz = 0;
        this.state = 'play';
        this.pitch = -0.6;
      }
      return;
    }
    if (this.state === 'bus') this.state = 'play';
    // actions that don't need physics
    if (A.crouch && c.mode === M_GROUND) me.crouch = !me.crouch;
    const inp = me.inp;
    inp.fwd = A.fwd;
    inp.right = A.right;
    const healing = !!me.use;
    inp.sprint = A.sprint && !me.ads && !healing;
    inp.crouch = me.crouch;
    inp.ads = me.ads;
    inp.slow = healing ? 0.7 : 1;
    c.yaw = this.yaw;
    c.pitch = this.pitch;
    const sdt = Math.min(0.25, dt * this.ts);
    const n = Math.max(1, Math.ceil(sdt / (1 / 60)));
    const h = sdt / n;
    let fallDmg = 0;
    let landed = false;
    const wasMode = c.mode;
    for (let i = 0; i < n; i++) {
      inp.jump = i === 0 && A.jump;
      stepChar(this.world, c, inp, h, me.out);
      if (me.out.fallDmg) fallDmg += me.out.fallDmg;
      if (me.out.landed) landed = true;
      if (me.out.jumped) me.crouch = false;
    }
    if (wasMode !== M_GROUND && c.mode === M_GROUND) {
      this.sfx.land();
      me.landT = this.now();
    } else if (landed && me.out.landVel > 9) this.sfx.land();
    if (fallDmg > 0) this.sendCmd({ t: 'fd', d: fallDmg });
    if (c.mode !== M_GROUND) me.crouch = false;
    // footsteps
    const sp = Math.hypot(c.vx, c.vz);
    if (c.mode === M_GROUND && c.grounded && sp > 1) {
      me.walk += sp * dt * this.ts * 1.9;
      if (Math.floor(me.walk / Math.PI) !== me.stepPhase) {
        me.stepPhase = Math.floor(me.walk / Math.PI);
        this.sfx.step(this.world.groundKind === 1 ? 1 : 0, undefined, undefined, undefined, c.crouch ? 0.4 : 1);
      }
    }
    // reload finishing
    if (me.reload && this.now() >= me.reload.t1) {
      const s = me.inv.slots[me.reload.slot - 1];
      if (s && C.WEAPONS[s.t] && me.cur === me.reload.slot) {
        const w = C.WEAPONS[s.t];
        const take = Math.min(w.mag - s.n, me.inv.ammo[w.ammo]);
        s.n += take;
        me.inv.ammo[w.ammo] -= take;
        me.reloadDone = { t: this.now(), slot: me.reload.slot, type: s.t, n: s.n };
      }
      me.reload = null;
    }
    if (me.use && this.now() > me.use.t1 + 1.5) me.use = null;
  }

  // ---------------------------------------------------------------- remote players
  updateRemotes(dt) {
    const rt = this.T - INTERP * this.ts;
    for (const pl of this.players.values()) {
      if (pl.id === this.myId || !pl.vis || !pl.alive) continue;
      const S = pl.snaps;
      if (!S.length) continue;
      let a = S[0];
      let b = S[0];
      if (rt <= S[0].T) {
        a = b = S[0];
      } else if (rt >= S[S.length - 1].T) {
        a = b = S[S.length - 1];
      } else {
        for (let i = 0; i < S.length - 1; i++) {
          if (S[i].T <= rt && S[i + 1].T >= rt) {
            a = S[i];
            b = S[i + 1];
            break;
          }
        }
      }
      const f = b.T > a.T ? (rt - a.T) / (b.T - a.T) : 1;
      const r = pl.r;
      const teleport = Math.abs(b.x - a.x) + Math.abs(b.z - a.z) > 30;
      const ff = teleport ? 1 : f;
      r.x = a.x + (b.x - a.x) * ff;
      r.y = a.y + (b.y - a.y) * ff;
      r.z = a.z + (b.z - a.z) * ff;
      r.yaw = a.yaw + wrapAngle(b.yaw - a.yaw) * ff;
      r.pitch = a.pitch + (b.pitch - a.pitch) * ff;
      const s = f < 0.5 ? a : b;
      r.mode = s.mode;
      r.flags = s.flags;
      r.crouch = !!(s.flags & F_CROUCH);
      r.item = decodeItem(s.item);
      r.hp = s.hp;
      r.sh = s.sh;
      const mdx = r.x - pl.px;
      const mdz = r.z - pl.pz;
      const spd = dt > 0 ? Math.sqrt(mdx * mdx + mdz * mdz) / (dt * this.ts) : 0;
      pl.speed += (Math.min(12, spd) - pl.speed) * Math.min(1, dt * 10);
      pl.px = r.x;
      pl.pz = r.z;
      r.grounded = Math.abs(b.y - a.y) < 0.25 || r.mode !== M_GROUND;
      if (r.mode === M_GROUND && pl.speed > 0.8) {
        pl.walk += pl.speed * dt * this.ts * 1.9;
        const ph = Math.floor(pl.walk / Math.PI);
        if (ph !== pl.stepPhase) {
          pl.stepPhase = ph;
          if (!r.crouch && this.camPos.distanceToSquared(_v1.set(r.x, r.y, r.z)) < 32 * 32) this.sfx.step(0, r.x, r.y, r.z, (r.flags & F_SPRINT) ? 1.2 : 0.8);
        }
      } else if (r.mode === M_GLIDE || r.mode === M_SWIM) pl.walk += dt * 4;
      if (pl.swing > 0) {
        pl.swing += dt * 3 * this.ts;
        if (pl.swing > 1) pl.swing = 0;
      } else if (r.flags & F_SWING && !(pl.lastFlags & F_SWING)) pl.swing = 0.001;
      pl.lastFlags = r.flags;
    }
  }

  renderChars(dt) {
    const V = this.V.chars;
    V.begin();
    const cam = this.R.camera.position;
    const me = this.me;
    for (const pl of this.players.values()) {
      if (pl.id === this.myId) continue;
      if (!pl.vis || !pl.alive) continue;
      const r = pl.r;
      if (r.mode === M_BUS || r.mode === M_DEAD) continue;
      const dx = r.x - cam.x;
      const dz = r.z - cam.z;
      if (dx * dx + dz * dz > 330 * 330) continue;
      V.draw({
        x: r.x,
        y: r.y,
        z: r.z,
        yaw: r.yaw,
        pitch: r.pitch,
        mode: r.mode,
        crouch: r.crouch,
        walk: pl.walk,
        speed: pl.speed,
        sprint: !!(r.flags & F_SPRINT),
        item: r.item,
        swing: pl.swing,
        building: !!(r.flags & F_BUILD),
        grounded: r.grounded,
        outfit: pl.outfit,
      });
    }
    const c = me.c;
    const scoped = this.scoped || (this.camNear !== undefined && this.camNear < 1.0);
    if (me.alive && c.mode !== M_BUS && !scoped) {
      if (me.swingT > 0) {
        me.swingP = (this.now() - me.swingT) * 3.2 * this.ts;
        if (me.swingP > 1) me.swingP = 0;
      }
      V.draw({
        x: c.x,
        y: c.y,
        z: c.z,
        yaw: c.mode === M_FALL || c.mode === M_GLIDE ? this.yaw : this.bodyYaw !== undefined ? this.bodyYaw : this.yaw,
        pitch: this.pitch,
        mode: c.mode,
        crouch: c.crouch,
        walk: me.walk,
        speed: Math.hypot(c.vx, c.vz),
        sprint: me.inp.sprint,
        item: me.build ? null : me.cur === 0 ? null : this.held(),
        swing: me.swingP || 0,
        building: me.build,
        grounded: c.grounded,
        outfit: me.outfit,
      });
    }
    V.end();
    void dt;
  }

  // ---------------------------------------------------------------- camera
  updateCamera(dt, A) {
    const cam = this.R.camera;
    const me = this.me;
    const c = me.c;
    let tx;
    let ty;
    let tz;
    let yaw = this.yaw;
    let pitch = this.pitch;
    let dist = 3.7;
    let right = 0.78;
    let up = 0.3;
    let collide = true;
    let fp = false;
    const held = this.held();
    const w = held && C.WEAPONS[held.t];
    let zoom = 1;
    this.scoped = false;
    let follow = null;
    if (!me.alive) {
      const pl = this.players.get(this.specId);
      if (pl && pl.vis && pl.alive) follow = pl.r;
      else if (this.state !== 'end' || !follow) this.specId = this.pickSpec(0) || this.specId;
    }
    if (this.state === 'wait') {
      const a = this.clock * 0.05;
      cam.position.set(Math.cos(a) * 380, 230, Math.sin(a) * 380);
      cam.lookAt(0, 0, 0);
      this.camPos.copy(cam.position);
      this.setFov(1);
      return;
    }
    if (me.alive && c.mode === M_BUS) {
      busPos(this.bus, Math.max(0, this.T), _dir);
      tx = _dir[0];
      ty = _dir[1] + 5;
      tz = _dir[2];
      dist = 40;
      right = 0;
      up = 6;
      collide = false;
    } else if (follow) {
      tx = follow.x;
      ty = follow.y + 1.55;
      tz = follow.z;
      if (follow.mode === M_FALL || follow.mode === M_GLIDE) {
        dist = 7;
        up = 1.5;
      }
    } else if (!me.alive) {
      tx = c.x;
      ty = c.y + 3;
      tz = c.z;
      dist = 8;
    } else {
      tx = c.x;
      ty = c.y + (c.crouch ? CROUCH_EYE : 1.55);
      tz = c.z;
      if (c.mode === M_FALL) {
        dist = 6.5;
        up = 1.4;
        right = 0;
      } else if (c.mode === M_GLIDE) {
        dist = 6;
        up = 1.6;
        right = 0;
      } else if (c.mode === M_SWIM) {
        dist = 4;
        up = 0.6;
        ty = c.y + 1.2;
      }
      // ADS
      const canAds = c.mode === M_GROUND && !me.build && w && !w.melee && !me.use;
      me.ads = canAds && A.ads;
      me.adsT += ((me.ads ? 1 : 0) - me.adsT) * Math.min(1, dt * 14);
      if (me.adsT > 0.01 && w) {
        zoom = 1 + (w.zoom - 1) * me.adsT;
        if (w.scope && me.adsT > 0.85) {
          fp = true;
          this.scoped = true;
          zoom = w.zoom;
        }
        dist = 3.7 - 1.9 * me.adsT;
        right = 0.78 - 0.12 * me.adsT;
        up = 0.3 - 0.05 * me.adsT;
      }
    }
    this.adsZoom = zoom;
    // recoil + shake
    pitch += me.recoil;
    me.recoil *= Math.exp(-dt * 9);
    let sx = 0;
    let sy = 0;
    if (this.shake > 0.001) {
      sx = (Math.random() - 0.5) * this.shake * 0.12;
      sy = (Math.random() - 0.5) * this.shake * 0.12;
      this.shake *= Math.exp(-dt * 7);
    }
    if (follow) {
      yaw = follow.yaw;
      pitch = Math.max(-0.8, Math.min(0.6, follow.pitch)) - 0.1;
    }
    const cp = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cp;
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * cp;
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const pivot = _v1.set(tx, ty, tz);
    if (fp) {
      cam.position.set(c.x, eyeY(c), c.z);
    } else {
      const want = _v2.set(tx - fx * dist + rx * right, ty - fy * dist + up, tz - fz * dist + rz * right);
      this.camNear = 99;
      if (collide) {
        // try the normal spot, then raised spots (steep slopes right behind the player)
        let bestT = -1;
        let bx = 0;
        let by = 0;
        let bz = 0;
        const wx = want.x;
        const wy = want.y;
        const wz = want.z;
        for (let k = 0; k < 3; k++) {
          const dx = wx - pivot.x;
          const dy = wy + k * 1.3 - pivot.y;
          const dz = wz - pivot.z;
          const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const hit = this.world.raycast(pivot.x, pivot.y, pivot.z, dx / L, dy / L, dz / L, L + 0.3, 7);
          const t = hit.kind && hit.t < L + 0.3 ? Math.max(0.25, hit.t - 0.3) : L;
          if (t > bestT + 0.4) {
            bestT = t;
            bx = dx / L;
            by = dy / L;
            bz = dz / L;
          }
          if (t >= L - 0.01 || hit.kind !== HIT_TERRAIN) break;
        }
        want.set(pivot.x + bx * bestT, pivot.y + by * bestT, pivot.z + bz * bestT);
        this.camNear = bestT;
        const wh = this.world.terrain.heightAt(want.x, want.z);
        if (want.y < wh + 0.3) want.y = wh + 0.3;
        if (want.y < 0.35 && wh < 0) want.y = Math.max(want.y, 0.35);
      }
      cam.position.copy(want);
    }
    cam.position.x += sx;
    cam.position.y += sy;
    _v2.set(cam.position.x + fx, cam.position.y + fy, cam.position.z + fz);
    cam.lookAt(_v2);
    this.camPos.copy(cam.position);
    this.camFwd = [fx, fy, fz];
    this.setFov(zoom);
    this.bodyYaw = this.yaw;
  }

  setFov(zoom) {
    const cam = this.R.camera;
    const h = (this.S.fov * Math.PI) / 180;
    let v = (2 * Math.atan(Math.tan(h / 2) / Math.max(1, cam.aspect)) * 180) / Math.PI;
    v = Math.max(40, Math.min(90, v));
    const target = zoom > 1.01 ? (2 * Math.atan(Math.tan((v * Math.PI) / 360) / zoom) * 180) / Math.PI : v;
    if (Math.abs(cam.fov - target) > 0.01) {
      cam.fov = target;
      cam.updateProjectionMatrix();
    }
  }

  // aim point: camera ray, ignoring what's between the camera and the player
  updateAim() {
    const me = this.me;
    const c = me.c;
    const cam = this.camPos;
    const f = this.camFwd || [0, 0, -1];
    const range = 700;
    const px = c.x - cam.x;
    const py = eyeY(c) - cam.y;
    const pz = c.z - cam.z;
    const skip = Math.max(0, px * f[0] + py * f[1] + pz * f[2]) + 0.2;
    const ox = cam.x + f[0] * skip;
    const oy = cam.y + f[1] * skip;
    const oz = cam.z + f[2] * skip;
    const hit = this.world.raycast(ox, oy, oz, f[0], f[1], f[2], range, 7);
    let best = hit.kind ? hit.t : range;
    let kind = hit.kind === HIT_PIECE ? HK_PIECE : hit.kind === HIT_PROP ? HK_PROP : hit.kind ? HK_WORLD : HK_NONE;
    let id = hit.kind === HIT_PIECE ? hit.piece.id : hit.kind === HIT_PROP ? hit.prop.id : 0;
    const piece = hit.kind === HIT_PIECE ? hit.piece : null;
    for (const pl of this.players.values()) {
      if (pl.id === this.myId || !pl.vis || !pl.alive) continue;
      const r = pl.r;
      if (r.mode === M_BUS) continue;
      const t = rayChar(ox, oy, oz, f[0], f[1], f[2], best, r.x, r.y, r.z, r.crouch, _hit);
      if (t < best) {
        best = t;
        kind = HK_CHAR;
        id = pl.id;
      }
    }
    this.aimPoint.set(ox + f[0] * best, oy + f[1] * best, oz + f[2] * best);
    this.aimHit.kind = kind;
    this.aimHit.id = id;
    this.aimHit.dist = best + skip;
    this.aimHit.piece = kind === HK_PIECE ? piece : null;
  }

  // Trace one shot from the player's eye; returns [kind, id, head, x, y, z]
  traceShot(ox, oy, oz, dx, dy, dz, range) {
    const hit = this.world.raycast(ox, oy, oz, dx, dy, dz, range, 7 | 8);
    let best = hit.kind ? hit.t : range;
    let kind = hit.kind === HIT_PIECE ? HK_PIECE : hit.kind === HIT_PROP ? HK_PROP : hit.kind ? HK_WORLD : HK_NONE;
    let id = hit.kind === HIT_PIECE ? hit.piece.id : hit.kind === HIT_PROP ? hit.prop.id : 0;
    let head = 0;
    const hk = hit.kind;
    const surf = hk === HIT_PIECE ? hit.piece.m : hk === HIT_PROP ? Math.max(0, PROP_TYPES[hit.prop.type].mat) : hk === HIT_WATER ? 3 : -1;
    let s2 = surf;
    for (const pl of this.players.values()) {
      if (pl.id === this.myId || !pl.vis || !pl.alive) continue;
      const r = pl.r;
      if (r.mode === M_BUS) continue;
      const t = rayChar(ox, oy, oz, dx, dy, dz, best, r.x, r.y, r.z, r.crouch, _hit);
      if (t < best) {
        best = t;
        kind = HK_CHAR;
        id = pl.id;
        head = _hit.head ? 1 : 0;
        s2 = -2;
      }
    }
    const x = ox + dx * best;
    const y = oy + dy * best;
    const z = oz + dz * best;
    return { h: [kind, id, head, +x.toFixed(2), +y.toFixed(2), +z.toFixed(2)], surf: s2, x, y, z, t: best };
  }

  // ---------------------------------------------------------------- combat / building / interaction
  updateCombat(dt, A, now) {
    const me = this.me;
    const c = me.c;
    const ground = c.mode === M_GROUND;
    if (A.slot >= 0) this.selectSlot(A.slot);
    if (A.wheel && !me.build) {
      const order = [0, 1, 2, 3, 4, 5];
      let i = order.indexOf(me.cur);
      for (let k = 0; k < 6; k++) {
        i = (i + (A.wheel > 0 ? 1 : -1) + 6) % 6;
        if (i === 0 || me.inv.slots[i - 1]) break;
      }
      this.selectSlot(i);
    } else if (A.wheel && me.build) {
      me.piece = (me.piece + (A.wheel > 0 ? 1 : 3)) % 4;
    }
    if (A.buildToggle) {
      if (me.build) me.build = false;
      else this.enterBuild(me.piece);
    }
    if (A.piece >= 0) this.enterBuild(A.piece);
    if (me.build) {
      if (A.rotate) me.rot = (me.rot + 1) & 3;
      if (A.mat) {
        for (let k = 1; k <= 3; k++) {
          const m = (me.mat + k) % 3;
          if (me.inv.mats[m] >= C.BUILD_COST || k === 3) {
            me.mat = m;
            break;
          }
        }
        this.sfx.ui();
      }
    }
    // interaction target
    this.findInteract();
    if (A.use && this.onUseTarget) {
      const u = this.onUseTarget;
      if (u.kind === 'item') this.sendCmd({ t: 'pk', id: u.id });
      else this.sendCmd({ t: 'op', k: u.kind === 'box' ? 'b' : 'c', id: u.id });
    }
    // building
    if (me.build) {
      const t = buildTarget(this.world, c, this.yaw, this.pitch, me.piece, me.rot, this._bt || (this._bt = {}));
      const chk = ground || c.mode === M_SWIM ? placeCheck(this.world, t) : 3;
      const ok = chk === 0 && me.inv.mats[me.mat] >= C.BUILD_COST;
      this.V.ghost.show(t, ok);
      const key = t.k + ':' + t.x + ':' + t.y + ':' + t.z + ':' + t.o;
      const want = A.fireHit || (A.fire && (key !== me.lastSlotKey || now - me.lastPlace > 0.35));
      if (want && ok && now - me.lastPlace > 0.07) this.placePiece(t);
      if (!A.fire) me.lastSlotKey = '';
      return;
    }
    this.V.ghost.show(null);
    const held = this.held();
    if (A.reload) this.startReload();
    if (me.cur === 0) {
      if (A.fire && now >= me.nextFire) this.swingPickaxe(now);
      return;
    }
    if (!held) return;
    if (C.isConsumable(held.t)) {
      if (A.fireHit && !me.use) {
        const d = C.CONSUMABLES[held.t];
        const full = (d.hp && me.hp >= d.hpMax) || (d.sh && me.sh >= d.shMax);
        if (full) this.hud.alert(d.hp ? 'Health is already full' : 'Shield is already full', '', 1.5);
        else {
          this.sendCmd({ t: 'use' });
          me.use = { t0: now, t1: now + d.time / this.ts, slot: me.cur };
          this.sfx.heal(!!d.sh);
        }
      }
      return;
    }
    if (!C.isWeapon(held.t) || !ground) return;
    const w = C.weaponStats(held.t, held.r);
    let fire = w.auto ? A.fire : A.fireHit || (A.fire && held.t === 'pistol' && false);
    if (!fire && this.o.isTouch() && this.S.autoFire && this.aimHit.kind === HK_CHAR && this.aimHit.dist < w.range * 0.8) fire = true;
    if (!w.auto && A.fire && !A.fireHit && this.o.isTouch()) fire = true; // touch: holding fires semi-autos too
    if (fire && now >= me.nextFire && !me.reload) {
      if (held.n <= 0) {
        this.startReload();
        return;
      }
      this.shoot(held, w, now);
    }
    // bloom decay
    if (me.bloom > 0) me.bloom = Math.max(0, me.bloom - (w.bloomMax || 3) * 2.2 * dt * this.ts);
  }

  startReload() {
    const me = this.me;
    const held = this.held();
    if (!held || !C.isWeapon(held.t) || me.reload) return;
    const W = C.WEAPONS[held.t];
    if (held.n >= W.mag || me.inv.ammo[W.ammo] <= 0) {
      if (me.inv.ammo[W.ammo] <= 0 && held.n <= 0) this.hud.alert('No ammo', '', 1.2);
      return;
    }
    const w = C.weaponStats(held.t, held.r);
    const q = this.sendCmd({ t: 'rl' });
    me.reload = { t0: this.now(), t1: this.now() + w.reload / this.ts, slot: me.cur, q };
    this.sfx.reload(w.reload / this.ts);
  }

  shoot(held, w, now) {
    const me = this.me;
    const c = me.c;
    me.nextFire = now + 1 / w.rate / this.ts;
    if (me.use) {
      me.use = null;
      this.sendCmd({ t: 'cx' });
    }
    const ox = c.x;
    const oy = eyeY(c);
    const oz = c.z;
    let dx = this.aimPoint.x - ox;
    let dy = this.aimPoint.y - oy;
    let dz = this.aimPoint.z - oz;
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= L;
    dy /= L;
    dz /= L;
    const q = me.q + 1;
    if (w.projectile) {
      this.sendCmd({ t: 'rk', d: [+dx.toFixed(4), +dy.toFixed(4), +dz.toFixed(4)] });
      held.n--;
      me.pending.push({ q, slot: me.cur });
      this.sfx.shot(held.t);
      me.recoil += 0.06;
      if (held.n <= 0) setTimeout(() => !this.destroyed && this.startReload(), 250);
      return;
    }
    const moving = Math.hypot(c.vx, c.vz) > 1.2;
    const still = !moving && c.grounded;
    let spread = (me.ads ? w.ads : w.hip) * (c.crouch ? 0.75 : 1) * (moving ? 1.25 : 1) * (c.grounded ? 1 : 1.6) + me.bloom;
    // first-shot accuracy when standing still and aiming
    if (me.ads && still && me.bloom < 0.05 && (held.t === 'ar' || held.t === 'pistol' || held.t === 'sniper') && now - (me.lastShot || 0) > 0.5) spread = 0;
    me.bloom = Math.min(w.bloomMax, me.bloom + w.bloom);
    me.lastShot = now;
    const hits = [];
    const mx = ox + dx * 0.9 + Math.cos(this.yaw) * 0.2;
    const my = oy - 0.12;
    const mz = oz + dz * 0.9 - Math.sin(this.yaw) * 0.2;
    for (let i = 0; i < (w.pellets || 1); i++) {
      spreadDir(dx, dy, dz, spread, Math.random(), Math.random(), _pd);
      const r = this.traceShot(ox, oy, oz, _pd[0], _pd[1], _pd[2], w.range);
      hits.push(r.h);
      if (i < 4 || held.t !== 'shotgun') this.V.fx.tracer(mx, my, mz, r.x, r.y, r.z, held.t === 'sniper' ? 0xffffff : 0xfff1b0);
      if (r.h[0] !== HK_NONE) {
        const col = r.surf === -2 ? 0xbfe8ff : r.surf >= 0 && r.surf <= 2 ? SURF_COL[r.surf] : r.surf === 3 ? 0xd8f0ff : 0xcdb58a;
        this.V.fx.burst(r.x, r.y, r.z, col, r.surf === -2 ? 4 : 3, 2, 0.8);
      }
      if (r.h[0] === HK_PIECE) this.showPieceHp(r.h[1]);
    }
    this.sendCmd({ t: 'sh', w: me.cur, o: [+ox.toFixed(2), +oy.toFixed(2), +oz.toFixed(2)], h: hits });
    held.n--;
    me.pending.push({ q, slot: me.cur });
    this.V.fx.flash(mx, my, mz);
    this.sfx.shot(held.t);
    me.recoil += Math.min(0.05, (held.t === 'sniper' ? 0.07 : held.t === 'shotgun' ? 0.06 : 0.012) + w.bloom * 0.004);
    if (held.n <= 0 && me.inv.ammo[C.WEAPONS[held.t].ammo] > 0) setTimeout(() => !this.destroyed && this.startReload(), 180);
  }

  swingPickaxe(now) {
    const me = this.me;
    const c = me.c;
    me.nextFire = now + 1 / C.WEAPONS.pickaxe.rate / this.ts;
    me.swingT = now;
    this.sfx.swing();
    const ox = c.x;
    const oy = eyeY(c);
    const oz = c.z;
    let dx = this.aimPoint.x - ox;
    let dy = this.aimPoint.y - oy;
    let dz = this.aimPoint.z - oz;
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= L;
    dy /= L;
    dz /= L;
    const r = this.traceShot(ox, oy, oz, dx, dy, dz, C.WEAPONS.pickaxe.range + 0.5);
    if (r.h[0] === HK_NONE || r.h[0] === HK_WORLD) return;
    const k = r.h[0];
    setTimeout(() => {
      if (this.destroyed) return;
      this.sendCmd({ t: 'ml', k, id: r.h[1], x: r.h[3], y: r.h[4], z: r.h[5] });
      me.lastHitPos = [r.x, r.y, r.z];
      const mat = k === HK_PIECE ? (this.world.pieces.get(r.h[1]) || { m: 0 }).m : k === HK_PROP ? Math.max(0, PROP_TYPES[(this.world.propById.get(r.h[1]) || { type: 'oak' }).type].mat) : 3;
      this.sfx.impact(mat, r.x, r.y, r.z);
      this.V.fx.burst(r.x, r.y, r.z, mat <= 2 ? SURF_COL[mat] : 0xbfe8ff, 5, 2.5, 0.9);
      if (k === HK_PIECE) this.showPieceHp(r.h[1]);
      if (k === HK_PROP) this.V.props.hit(r.h[1]);
    }, 120 / this.ts);
  }

  showPieceHp(id) {
    this.pieceHpRef = id;
    this.pieceHpT = 1.4;
  }

  placePiece(t) {
    const me = this.me;
    const m = me.mat;
    const id = me.tmpId--;
    const max = C.MATERIALS[m].hp;
    const piece = { id, k: t.k, x: t.x, y: t.y, z: t.z, o: t.o, m, c: DEFAULT_TINT[m], v: 0, hp: max * 0.3, max, owner: this.myId, map: false, temp: true };
    if (!this.world.pieces.add(piece)) return;
    this.V.pieces.add(piece);
    const q = this.sendCmd({ t: 'bd', k: t.k, x: t.x, y: t.y, z: t.z, o: t.o, m, tmp: id });
    me.temps.set(id, { q, m });
    me.inv.mats[m] -= C.BUILD_COST;
    me.lastPlace = this.now();
    me.lastSlotKey = t.k + ':' + t.x + ':' + t.y + ':' + t.z + ':' + t.o;
    this.sfx.build(m);
    // temps expire if the server never answers
    setTimeout(() => {
      if (me.temps.has(id)) this.removeTemp(id);
    }, 5000);
  }

  findInteract() {
    const me = this.me;
    const c = me.c;
    let best = null;
    let bs = Infinity;
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    for (const it of this.items.values()) {
      if (!C.isWeapon(it.t) && !C.isConsumable(it.t)) continue;
      const dx = it.x - c.x;
      const dz = it.z - c.z;
      if (Math.abs(dx) > 2.6 || Math.abs(dz) > 2.6 || Math.abs(it.y - c.y) > 1.8) continue;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > 2.5) continue;
      const facing = d > 0.01 ? (dx * fx + dz * fz) / d : 1;
      const s = d - facing * 0.9;
      if (s < bs) {
        bs = s;
        best = { kind: 'item', id: it.id, it };
      }
    }
    const check = (list, avail, kind) => {
      for (let i = 0; i < list.length; i++) {
        if (!avail[i]) continue;
        const ch = list[i];
        const dx = ch.x - c.x;
        const dz = ch.z - c.z;
        if (Math.abs(dx) > 3 || Math.abs(dz) > 3 || Math.abs(ch.y - c.y) > 1.8) continue;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > 2.8) continue;
        const s = d - 1.2;
        if (s < bs) {
          bs = s;
          best = { kind, id: i };
        }
      }
    };
    check(this.map.chests, this.chestAvail, 'chest');
    check(this.map.boxes, this.boxAvail, 'box');
    this.onUseTarget = best;
  }

  toggleMap(force) {
    this.mapOpen = force !== undefined ? force : !this.mapOpen;
    document.getElementById('fullmap').classList.toggle('hidden', !this.mapOpen);
    if (this.mapOpen) this.drawFullMap();
  }

  drawFullMap() {
    const cv = document.getElementById('bigmap');
    const g = cv.getContext('2d');
    const me = this.me;
    const pos = this.viewPos();
    const bp = me.c.mode === M_BUS && me.alive ? busPos(this.bus, Math.max(0, this.T)) : null;
    this.painter.full(g, cv.width, pos.x, pos.z, this.yaw, this.storm, this.T < this.bus.dur + 5 ? this.bus : null, bp, this.map.pois, null);
  }

  viewPos() {
    const me = this.me;
    if (!me.alive) {
      const pl = this.players.get(this.specId);
      if (pl && pl.vis) return pl.r;
    }
    return me.c;
  }

  // ---------------------------------------------------------------- HUD
  updateHud(dt, A) {
    const hud = this.hud;
    const me = this.me;
    const now = this.now();
    // fps
    this.fpsAcc += dt;
    this.fpsN++;
    if (this.fpsAcc > 0.5) {
      this.fps = Math.round(this.fpsN / this.fpsAcc);
      if (this.S.showFps) hud.fps(this.fps + ' FPS');
      this.fpsAcc = 0;
      this.fpsN = 0;
      if (this.o.onFps) this.o.onFps(this.fps);
    }
    const spec = !me.alive ? this.players.get(this.specId) : null;
    if (spec && spec.vis) hud.vitals(spec.r.hp, spec.r.sh);
    else hud.vitals(me.hp, me.sh);
    const held = this.held();
    hud.hotbar(me.inv, me.cur, me.build, held && C.isWeapon(held.t) ? held.n : undefined);
    hud.buildbar(me.build && me.alive, me.piece, me.mat);
    hud.mats(me.inv.mats);
    hud.ammo(held && C.WEAPONS[held.t] && C.WEAPONS[held.t].ammo ? me.inv.ammo[C.WEAPONS[held.t].ammo] : null);
    // storm info
    const s = this.storm;
    let stormText = fmtTime(s.tLeft);
    let msg = '';
    if (this.T < this.plan.t0) {
      stormText = fmtTime(this.plan.t0 - this.T + this.plan.phases[0].wait);
      msg = 'Storm eye forms soon';
    } else if (s.done) {
      stormText = '0:00';
      msg = 'Final storm';
    } else msg = s.shrinking ? 'Storm eye shrinking' : 'Storm eye shrinks in ' + fmtTime(s.tLeft);
    hud.info(stormText, this.aliveCount, me.kills);
    hud.stormMsg(msg);
    const key = s.phase + ':' + s.shrinking;
    if (key !== this.lastPhaseKey && this.T > this.plan.t0) {
      if (this.lastPhaseKey) hud.alert(s.shrinking ? 'The storm eye is shrinking!' : 'Storm eye shrinks in ' + fmtTime(s.tLeft), 'storm', 3.5);
      this.lastPhaseKey = key;
    }
    const vp = this.viewPos();
    const inStorm = me.c.mode !== M_BUS && outsideStorm(s, vp.x, vp.z) && this.state !== 'wait';
    hud.tint(inStorm);
    // minimap (10 Hz)
    this.mapT -= dt;
    if (this.mapT <= 0) {
      this.mapT = 0.1;
      const bp = me.c.mode === M_BUS && me.alive ? busPos(this.bus, Math.max(0, this.T)) : null;
      this.painter.mini(hud.mini, 200, vp.x, vp.z, spec && spec.vis ? spec.r.yaw : this.yaw, s, this.T < this.bus.dur + 5 ? this.bus : null, bp, null);
      if (this.mapOpen) this.drawFullMap();
    }
    // crosshair
    const w = held && C.isWeapon(held.t) ? C.weaponStats(held.t, held.r) : null;
    let mode = 'none';
    let gap = 8;
    if (me.alive && me.c.mode === M_GROUND && this.state === 'play') {
      if (me.build) mode = 'build';
      else if (me.cur === 0 || !held || !w) mode = me.cur === 0 ? 'circle' : 'build';
      else {
        mode = w.pellets > 1 ? 'circle' : '';
        const c = me.c;
        const moving = Math.hypot(c.vx, c.vz) > 1.2;
        const spread = (me.ads ? w.ads : w.hip) * (c.crouch ? 0.75 : 1) * (moving ? 1.25 : 1) + me.bloom;
        const vf = (this.R.camera.fov * Math.PI) / 360;
        gap = 4 + (Math.tan((spread * Math.PI) / 180) / Math.tan(vf)) * (window.innerHeight / 2);
      }
      if (this.scoped) mode = 'none';
    }
    hud.crosshair(gap, mode);
    document.getElementById('scope').classList.toggle('hidden', !this.scoped);
    // prompts
    const touch = this.o.isTouch();
    const u = me.alive && this.state === 'play' ? this.onUseTarget : null;
    if (u) {
      let label;
      if (u.kind === 'item') label = C.itemName(u.it.t, u.it.r) + (C.isConsumable(u.it.t) && u.it.n > 1 ? ' x' + u.it.n : '');
      else label = u.kind === 'chest' ? 'Open Chest' : 'Open Ammo Box';
      hud.prompt(label, touch ? '' : 'E');
    } else hud.prompt(null);
    document.getElementById('tUse').classList.toggle('hidden', !u);
    // progress bars
    if (me.reload) hud.progress('Reloading', Math.min(1, (now - me.reload.t0) / (me.reload.t1 - me.reload.t0)));
    else if (me.use) hud.progress(C.CONSUMABLES[(this.held() || { t: 'bandage' }).t] ? C.CONSUMABLES[this.held().t].name : 'Using', Math.min(1, (now - me.use.t0) / (me.use.t1 - me.use.t0)));
    else hud.progress(null);
    // structure hp
    if (this.pieceHpT > 0) {
      this.pieceHpT -= dt;
      const p = this.world.pieces.get(this.pieceHpRef);
      if (p && this.pieceHpT > 0) hud.pieceHp(Math.max(0, p.hp / p.max), Math.ceil(p.hp) + ' / ' + p.max);
      else hud.pieceHp(null);
    } else hud.pieceHp(null);
    // bus hint / spectate
    const busOn = me.alive && me.c.mode === M_BUS && this.state === 'bus' && this.T >= this.bus.door;
    hud.toggle('busHint', busOn);
    if (busOn) hud.text('busText', (touch ? 'Tap DROP' : 'Jump') + ' \u00b7 auto drop in ' + Math.max(0, Math.ceil(this.bus.dur - this.T)) + 's');
    if (!me.alive && this.state !== 'end' && spec) hud.spectate(spec.name, touch ? 'Tap FIRE for next player' : 'Click / Space for next player');
    else if (this.state === 'end' && spec) hud.spectate(spec.name, 'Winner');
    else hud.spectate(null);
    // touch buttons state
    document.body.classList.toggle('building', !!(me.build && me.alive));
    if (touch) {
      document.getElementById('tBuild').classList.toggle('on', me.build);
      document.getElementById('tAim').classList.toggle('on', !!this.touchAds);
      document.getElementById('tCrouch').classList.toggle('on', me.crouch);
      document.getElementById('tPieces').classList.toggle('hidden', !me.build);
      const onBus = me.alive && me.c.mode === M_BUS;
      document.getElementById('tFire').textContent = me.build ? 'PLACE' : onBus ? 'DROP' : 'FIRE';
      document.getElementById('tJump').classList.toggle('hidden', onBus);
      if (me.build) for (const b of document.querySelectorAll('#tPieces .tbtn')) b.classList.toggle('on', b.dataset.a === 'p' + me.piece);
    }
  }

  updateLoops() {
    const me = this.me;
    const c = me.c;
    const s = this.storm;
    const vp = this.viewPos();
    const inStorm = this.state !== 'wait' && c.mode !== M_BUS && outsideStorm(s, vp.x, vp.z);
    const dEdge = Math.abs(Math.hypot(vp.x - s.cx, vp.z - s.cz) - s.r);
    this.sfx.loop('storm', inStorm ? 0.5 : Math.max(0, 0.25 * (1 - dEdge / 40)));
    const air = me.alive && (c.mode === M_FALL || c.mode === M_GLIDE);
    this.sfx.loop('wind', air ? (c.mode === M_FALL ? 0.35 + Math.min(0.3, -c.vy / 100) : 0.18) : 0);
    this.sfx.loop('bus', me.alive && c.mode === M_BUS && this.state !== 'wait' ? 0.12 : 0);
    // bus mesh
    const bus = this.R.bus;
    if (this.T < this.bus.dur + 1 && this.state !== 'wait') {
      busPos(this.bus, Math.max(0, this.T), _dir);
      bus.visible = true;
      bus.position.set(_dir[0], _dir[1] - 1.5, _dir[2]);
      bus.rotation.y = Math.atan2(-(this.bus.ex - this.bus.sx), -(this.bus.ez - this.bus.sz));
      bus.rotation.z = Math.sin(this.clock * 1.3) * 0.02;
    } else bus.visible = false;
  }

  // debug helper for tests: queue a debug command
  dbg(a, extra = {}) {
    this.sendCmd(Object.assign({ t: 'dbg', a }, extra));
  }

  destroy() {
    this.destroyed = true;
    document.body.classList.remove('building');
    this.sfx.stopLoops();
    this.toggleMap(false);
    this.link.onMessages = null;
    this.link.onClose = null;
    this.hud.onSlot = null;
    if (window.__storm === this) window.__storm = null;
  }
}

const CROUCH_EYE = 1.05;
void K_WALL;
void K_FLOOR;
void K_RAMP;
void K_CONE;
void PIECE_NAMES;
void HIT_TERRAIN;
void F_HEAL;
void F_RELOAD;
void M_DEAD;
void MAT_KEYS;
