// Private online races. The host's browser runs the race (bots, items, laps); every player drives
// their own kart locally and streams its state to the host 20 times a second, and the host streams
// everything back. Hits are decided by the host and sent to the kart's owner.
import { HostNet, joinGame, netMode } from './net.js';
import { DRIVERS, driverById, VERSION, ITEMS, DT, CLASSES } from '../core/config.js';
import { TRACKS } from '../core/tracks.js';
import { spawnItem, stepPads } from '../core/items.js';
import { initBot } from '../core/ai.js';

const SEND_EVERY = 3; // sim steps between state messages (20 Hz)
const MAX_PLAYERS = 8;
// race events the other players should see / hear
const SHARED = new Set(['boom', 'fire', 'hit', 'shieldpop', 'emp', 'box', 'mini', 'ricochet', 'oil', 'nitro', 'shield']);

export class Online {
  constructor(app) {
    this.app = app;
    this.role = null; // 'host' | 'client'
    this.net = null;
    this.link = null;
    this.players = new Map(); // host: cid -> {cid, name, driver, send, q}
    this.phase = 'lobby';
    this.step = 0;
    this.bindUi();
  }

  // ---------------------------------------------------------------- UI
  bindUi() {
    const { $, S } = this.app;
    for (const b of document.querySelectorAll('#mOnline .tabs button'))
      b.onclick = () => {
        for (const o of document.querySelectorAll('#mOnline .tabs button')) o.classList.toggle('on', o === b);
        $('tabHost').classList.toggle('hidden', b.dataset.tab !== 'host');
        $('tabJoin').classList.toggle('hidden', b.dataset.tab !== 'join');
      };
    const sel = $('onDriver');
    sel.innerHTML = DRIVERS.map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
    $('hostTrack').innerHTML = TRACKS.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
    $('hostOpen').onclick = () => this.host();
    $('joinGo').onclick = () => this.join();
    $('lobbyLeave').onclick = () => {
      this.leave();
      this.app.toMenu();
    };
    $('hostStart').onclick = () => this.hostStartRace();
    $('hostAddr').onclick = () => this.setStreamer(!S.streamer);
    $('streamer').onchange = () => this.setStreamer($('streamer').checked);
    $('copyAddr').onclick = () => {
      try {
        navigator.clipboard.writeText(this.address || '');
        $('copyAddr').textContent = 'Copied';
        setTimeout(() => ($('copyAddr').textContent = 'Copy'), 1200);
      } catch (e) {
        /* ignore */
      }
    };
  }

  show() {
    const { $, S } = this.app;
    this.app.showScreen('mOnline');
    $('onName').value = S.name;
    $('onDriver').value = S.driver;
    $('hostPw').value = S.host.pw;
    $('joinAddr').value = S.join.addr;
    $('joinPw').value = '';
    $('joinStatus').textContent = '';
    $('advPeer').value = S.adv.peer;
    $('advTurn').value = S.adv.turn;
    $('advTurnUser').value = S.adv.turnUser;
    $('advTurnPass').value = S.adv.turnPass;
  }

  readForm() {
    const { $, S } = this.app;
    S.name = $('onName').value.trim().slice(0, 14);
    S.driver = $('onDriver').value;
    S.adv = { peer: $('advPeer').value.trim(), turn: $('advTurn').value.trim(), turnUser: $('advTurnUser').value.trim(), turnPass: $('advTurnPass').value };
    this.app.save();
    return S.name || 'Player';
  }

  setStreamer(on) {
    const { $, S } = this.app;
    S.streamer = on;
    this.app.save();
    $('streamer').checked = on;
    $('hostAddr').classList.toggle('hidden-addr', on);
  }

  // ---------------------------------------------------------------- host
  host() {
    const { $, S } = this.app;
    const name = this.readForm();
    S.host.pw = $('hostPw').value;
    this.app.save();
    this.leave();
    this.role = 'host';
    this.phase = 'lobby';
    this.players = new Map();
    this.players.set(0, { cid: 0, name, driver: S.driver, host: true });
    this.cfg = { track: S.host.track, cls: S.host.cls, laps: S.host.laps, bots: S.host.bots, items: S.host.items };
    this.address = '';
    this.net = new HostNet(this, S.adv, {
      onAddress: (addr, info) => {
        this.address = addr;
        $('hostAddr').textContent = addr || '…';
        $('hostNote').textContent = info;
      },
      onError: (msg) => {
        $('hostNote').textContent = msg;
        $('hostAddr').textContent = '—';
      },
    });
    this.showLobby();
  }

  // HostNet runner interface
  open(cid, send) {
    this.players.set(cid, { cid, name: '?', driver: 'blaze', send, q: [], joined: false });
  }
  close(cid) {
    const p = this.players.get(cid);
    this.players.delete(cid);
    if (!p) return;
    const G = this.app.getGame();
    if (G && G.kind === 'host' && p.kart !== undefined) {
      // a player left mid-race: a computer driver takes over their kart
      const k = G.race.karts[p.kart];
      if (k && !k.finished) {
        k.ctrl = 'bot';
        k.human = false;
        k.name += ' (CPU)';
        initBot(k, G.race);
      }
    }
    this.broadcastLobby();
  }
  send(cid, msgs) {
    const p = this.players.get(cid);
    if (!p) return;
    for (const m of msgs) this.onClientMsg(p, m);
  }

  onClientMsg(p, m) {
    const { S } = this.app;
    if (m.t === 'hello') {
      if (m.v !== VERSION) return this.kick(p, 'Different game version. Reload the page.');
      if ((S.host.pw || '') !== (m.pw || '')) return this.kick(p, 'Wrong password.');
      if ([...this.players.values()].filter((x) => x.joined || x.host).length >= MAX_PLAYERS) return this.kick(p, 'The race is full.');
      p.name = String(m.name || 'Player').slice(0, 14);
      p.driver = driverById(m.driver).id;
      p.joined = true;
      this.to(p, { t: 'welcome', cid: p.cid });
      this.broadcastLobby();
      return;
    }
    if (!p.joined) return;
    const G = this.app.getGame();
    if (m.t === 'st' && G && G.kind === 'host' && p.kart !== undefined) {
      const k = G.race.karts[p.kart];
      if (!k || k.ctrl !== 'remote') return;
      setTarget(k, m.s);
      k.item = m.it || null;
      k.itemN = m.n || 0;
    } else if (m.t === 'use' && G && G.kind === 'host' && p.kart !== undefined) {
      const k = G.race.karts[p.kart];
      if (k && G.race.state === 'race') spawnItem(G.race, k, m.it, !!m.back, G.race.ev);
    }
  }

  kick(p, why) {
    this.to(p, { t: 'deny', why });
    this.flushTo(p);
    p.send([{ t: '_close' }]);
  }
  to(p, m) {
    if (p.cid === 0) return;
    p.q.push(m);
  }
  flushTo(p) {
    if (p.cid === 0 || !p.q.length) return;
    const q = p.q;
    p.q = [];
    p.send(q);
  }
  flushAll() {
    for (const p of this.players.values()) this.flushTo(p);
  }
  everyone(m) {
    for (const p of this.players.values()) if (p.joined) this.to(p, m);
  }

  lobbyList() {
    return [...this.players.values()].filter((p) => p.joined || p.host).map((p) => ({ cid: p.cid, name: p.name, driver: p.driver, host: !!p.host }));
  }
  broadcastLobby() {
    if (this.role !== 'host') return;
    this.everyone({ t: 'lobby', players: this.lobbyList(), cfg: this.cfg, racing: this.phase === 'race' });
    this.flushAll();
    this.renderLobby(this.lobbyList(), this.cfg);
  }

  showLobby() {
    const { $, S } = this.app;
    this.app.showScreen('mLobby');
    $('menu').classList.remove('hidden');
    const host = this.role === 'host';
    $('hostInfo').classList.toggle('hidden', !host);
    $('hostCfg').classList.toggle('hidden', !host);
    $('hostStart').classList.toggle('hidden', !host);
    $('lobbyTitle').textContent = host ? 'Your server' : 'Lobby';
    this.setStreamer(S.streamer);
    if (host) {
      $('hostTrack').value = this.cfg.track;
      $('hostTrack').onchange = () => this.setCfg('track', $('hostTrack').value);
      const seg = (el, v, key) => {
        for (const b of el.querySelectorAll('button')) {
          b.classList.toggle('on', b.dataset.v === String(v));
          b.onclick = () => {
            for (const o of el.querySelectorAll('button')) o.classList.toggle('on', o === b);
            this.setCfg(key, +b.dataset.v);
          };
        }
      };
      seg($('hostCls'), this.cfg.cls, 'cls');
      seg($('hostLaps'), this.cfg.laps, 'laps');
      $('hostBots').value = this.cfg.bots;
      $('hostBotsV').textContent = this.cfg.bots;
      $('hostBots').oninput = () => {
        $('hostBotsV').textContent = $('hostBots').value;
        this.setCfg('bots', +$('hostBots').value);
      };
      $('hostItems').checked = this.cfg.items;
      $('hostItems').onchange = () => this.setCfg('items', $('hostItems').checked);
      $('lobbyStatus').textContent = netMode() === 'local' ? 'Local test mode: join from another tab of this browser.' : '';
    }
    this.renderLobby(host ? this.lobbyList() : this.lastLobby || [], this.cfg || {});
  }

  setCfg(key, v) {
    const { S } = this.app;
    this.cfg[key] = v;
    S.host[key] = v;
    this.app.save();
    this.broadcastLobby();
  }

  renderLobby(list, cfg) {
    const { $, esc } = this.app;
    $('lobbyList').innerHTML = list
      .map((p) => `<div><i style="background:${driverById(p.driver).body}"></i><b>${esc(p.name)}</b> ${esc(driverById(p.driver).name)}<small>${p.host ? 'host' : ''}</small></div>`)
      .join('');
    const tr = TRACKS.find((t) => t.id === cfg.track);
    $('lobbyCfg').innerHTML = tr
      ? `<p><b>${esc(tr.name)}</b> · ${CLASSES[cfg.cls] ? CLASSES[cfg.cls].name : ''} · ${cfg.laps} laps · ${cfg.bots} computer racers · items ${cfg.items ? 'on' : 'off'}</p>`
      : '';
    $('lobbyCfg').classList.toggle('hidden', this.role === 'host');
  }

  hostStartRace() {
    const G0 = this.app.getGame();
    if (this.role !== 'host' || (G0 && G0.kind === 'host' && G0.race.state !== 'done')) return;
    const humans = this.lobbyList();
    const nb = Math.max(0, Math.min(this.cfg.bots, 8 - humans.length));
    const used = new Set(humans.map((h) => h.driver));
    const botIds = DRIVERS.map((d) => d.id).filter((d) => !used.has(d));
    while (botIds.length < nb) botIds.push(DRIVERS[botIds.length % DRIVERS.length].id);
    const shuffle = (a) => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    const bots = shuffle(botIds).slice(0, nb);
    const entries = [...bots.map((d) => ({ driver: d, bot: true })), ...shuffle(humans.map((h) => ({ driver: h.driver, name: h.name, cid: h.cid })))];
    const karts = entries.map((e, i) => ({ driver: e.driver, name: e.name, ctrl: e.bot ? 'bot' : e.cid === 0 ? 'player' : 'remote', owner: e.bot ? null : e.cid, grid: i }));
    const setup = { track: this.cfg.track, cls: this.cfg.cls, laps: this.cfg.laps, items: this.cfg.items, seed: (Math.random() * 1e9) | 0, karts };
    for (const p of this.players.values()) p.kart = undefined;
    karts.forEach((k, i) => {
      if (k.owner !== null && this.players.get(k.owner)) this.players.get(k.owner).kart = i;
    });
    this.phase = 'race';
    this.step = 0;
    for (const p of this.players.values()) {
      if (!p.joined) continue;
      // each client gets the same race, with its own kart marked as the player and everyone else remote
      const mine = karts.map((k, i) => ({ ...k, ctrl: i === p.kart ? 'player' : 'remote', name: k.name || driverById(k.driver).name }));
      this.to(p, { t: 'start', setup: { ...setup, karts: mine, mode: 'client' }, you: p.kart });
    }
    this.flushAll();
    this.app.setSession({ kind: 'online' });
    this.app.startGame({ ...setup, mode: 'host' }, { kind: 'host', net: this });
  }

  // ---------------------------------------------------------------- client
  async join() {
    const { $, S } = this.app;
    const name = this.readForm();
    const addr = $('joinAddr').value.trim();
    S.join.addr = addr;
    this.app.save();
    this.leave();
    $('joinGo').disabled = true;
    const status = (t) => ($('joinStatus').textContent = t);
    try {
      const link = await joinGame(addr, S.adv, status);
      this.role = 'client';
      this.link = link;
      link.onMessages = (msgs) => {
        for (const m of msgs) this.onHostMsg(m);
      };
      link.onClose = (why) => {
        if (this.link !== link) return;
        this.link = null;
        this.role = null;
        const G = this.app.getGame();
        if (G && G.kind === 'client') this.app.toMenu('mOnline');
        else this.app.showScreen('mOnline');
        status(this.denied || (why === 'lost' ? 'Lost the connection to the host.' : 'The host closed the server.'));
        this.denied = null;
      };
      status('Connected. Checking the password…');
      link.send({ t: 'hello', v: VERSION, name, driver: S.driver, pw: $('joinPw').value });
      link.flush();
    } catch (e) {
      status(e.message || String(e));
    } finally {
      $('joinGo').disabled = false;
    }
  }

  onHostMsg(m) {
    const { $ } = this.app;
    if (m.t === 'deny') {
      this.denied = m.why;
      $('joinStatus').textContent = m.why;
    } else if (m.t === 'welcome') {
      this.cid = m.cid;
      this.showLobby();
    } else if (m.t === 'lobby') {
      this.lastLobby = m.players;
      this.cfg = m.cfg;
      const G = this.app.getGame();
      if (!G || G.kind !== 'client') {
        this.renderLobby(m.players, m.cfg);
        $('lobbyStatus').textContent = m.racing ? 'A race is on. You will join the next one.' : 'Waiting for the host to start the race…';
      }
    } else if (m.t === 'start') {
      this.step = 0;
      this.app.setSession({ kind: 'online' });
      this.app.startGame(m.setup, { kind: 'client', meIdx: m.you, net: this });
    } else {
      const G = this.app.getGame();
      if (!G || G.kind !== 'client') return;
      const race = G.race;
      const me = G.me;
      if (m.t === 'snap') this.applySnap(race, me, m);
      else if (m.t === 'ev') {
        for (const e of m.e) {
          const k = e[1] >= 0 ? race.karts[e[1]] : null;
          if (k === me && e[0] !== 'box') continue; // our own effects happen locally
          if (e[0] === 'boom' || e[0] === 'ricochet') race.ev.push([e[0], k, { x: e[2], y: e[3], z: e[4] }]);
          else if (e[0] === 'box') {
            const b = race.boxes[e[2]];
            if (b) {
              b.alive = false;
              race.ev.push(['box', k, b]);
            }
          } else race.ev.push([e[0], k, e[2]]);
        }
      } else if (m.t === 'hit') {
        if (me.shieldT > 0) me.shieldT = 0;
        race.ev.push(['hit', me, m.kind]);
      } else if (m.t === 'shieldpop') {
        me.shieldT = 0;
      } else if (m.t === 'roll') {
        if (!me.item && me.rollT <= 0) {
          me.pending = m.it;
          me.rollT = 1.2;
        }
      } else if (m.t === 'results') {
        for (const [id, t, est, place] of m.order) {
          const k = race.karts[id];
          k.finished = true;
          k.finishT = t;
          k.estimated = !!est;
          k.place = place;
        }
        race.order = [...race.karts].sort((a, b) => a.place - b.place);
        race.state = 'done';
        this.app.showResults();
      }
    }
  }

  applySnap(race, me, m) {
    for (const r of m.k) {
      const k = race.karts[r[0]];
      if (!k) continue;
      k.place = r[18];
      if (k === me) continue;
      setTarget(k, r.slice(1, 17));
      k.lap = r[17];
      k.finished = r[19] >= 0;
      if (k.finished) k.finishT = r[19];
    }
    race.order.sort((a, b) => a.place - b.place);
    // rockets and oil
    const seen = new Set();
    for (const p of m.p) {
      seen.add(p[0]);
      let q = race.proj.find((x) => x.id === p[0]);
      if (!q) {
        q = { id: p[0], type: p[1] };
        race.proj.push(q);
      }
      Object.assign(q, { x: p[2], y: p[3], z: p[4], vx: p[5], vz: p[6] });
    }
    race.proj = race.proj.filter((q) => seen.has(q.id));
    race.oils = m.o.map((o) => ({ id: o[0], x: o[1], y: o[2], z: o[3] }));
    for (let i = 0; i < race.boxes.length; i++) race.boxes[i].alive = m.b[i] === '1';
  }

  // ---------------------------------------------------------------- per sim step hooks
  beforeStep(race) {
    // remote karts glide between updates
    for (const k of race.karts) if (k.ctrl === 'remote') glide(k, race);
  }

  afterStep(race) {
    this.step++;
    const G = this.app.getGame();
    if (this.role === 'host') {
      for (const k of race.karts) if (k.ctrl === 'remote') race.trackRemote(k);
      // forward events
      const shared = [];
      for (const e of race.ev) {
        const [type, k, a] = e;
        if (type === 'hit' && k && k.ctrl === 'remote') {
          const p = this.ownerOf(k);
          if (p) this.to(p, { t: 'hit', kind: a });
        }
        if (type === 'shieldpop' && k && k.ctrl === 'remote') {
          const p = this.ownerOf(k);
          if (p) this.to(p, { t: 'shieldpop' });
        }
        if (type === 'roll' && k && k.ctrl === 'remote') {
          const p = this.ownerOf(k);
          if (p) this.to(p, { t: 'roll', it: k.pending });
        }
        if (type === 'done') {
          const order = race.order.map((x) => [x.id, x.finishT, x.estimated ? 1 : 0, x.place]);
          this.everyone({ t: 'results', order });
          this.phase = 'results';
        }
        if (!SHARED.has(type)) continue;
        const kid = k ? k.id : -1;
        if (type === 'boom' || type === 'ricochet') shared.push([type, kid, r2(a.x), r2(a.y), r2(a.z)]);
        else if (type === 'box') shared.push([type, kid, race.boxes.indexOf(a)]);
        else shared.push([type, kid, typeof a === 'number' || typeof a === 'string' ? a : null]);
      }
      if (shared.length) this.everyone({ t: 'ev', e: shared });
      if (this.step % SEND_EVERY === 0) {
        const k = race.karts.map((x) => [x.id, ...race.stateOf(x), x.lap, x.place, x.finished ? +x.finishT.toFixed(3) : -1]);
        const p = race.proj.map((q) => [q.id, q.type, r2(q.x), r2(q.y), r2(q.z), r2(q.vx), r2(q.vz)]);
        const o = race.oils.map((q) => [q.id, r2(q.x), r2(q.y), r2(q.z)]);
        const b = race.boxes.map((x) => (x.alive ? '1' : '0')).join('');
        this.everyone({ t: 'snap', T: +race.time.toFixed(2), k, p, o, b });
      }
      this.flushAll();
    } else if (this.role === 'client' && this.link) {
      const me = G.me;
      // our own item roulette and boost pads (the host decides boxes and hits)
      if (me.rollT > 0) {
        me.rollT -= DT;
        if (me.rollT <= 0 && me.pending) {
          me.item = me.pending;
          me.itemN = ITEMS[me.item].uses;
          race.ev.push(['item', me, me.item]);
        }
      }
      stepPads(race, [me], DT, race.ev);
      for (const q of race.proj) {
        q.x += q.vx * DT;
        q.z += q.vz * DT;
      }
      for (const m of race.out) this.link.send(m);
      race.out.length = 0;
      if (this.step % SEND_EVERY === 0) this.link.send({ t: 'st', s: race.stateOf(me), it: me.item, n: me.itemN });
      this.link.flush();
    }
  }

  ownerOf(k) {
    for (const p of this.players.values()) if (p.kart === k.id && p.joined) return p;
    return null;
  }

  backToLobby() {
    const { $ } = this.app;
    $('results').classList.add('hidden');
    if (this.role === 'host') {
      this.phase = 'lobby';
      this.app.toMenu('mLobby');
      this.showLobby();
      this.broadcastLobby();
    } else if (this.role === 'client') {
      this.app.toMenu('mLobby');
      this.showLobby();
      $('lobbyStatus').textContent = 'Waiting for the host to start the next race…';
    } else this.app.toMenu('mOnline');
  }

  leave() {
    if (this.net) {
      this.everyone({ t: 'deny', why: 'The host closed the server.' });
      this.flushAll();
      this.net.close();
    }
    if (this.link) {
      const l = this.link;
      this.link = null;
      l.close();
    }
    this.net = null;
    this.role = null;
    this.players = new Map();
  }
}

function r2(v) {
  return Math.round(v * 100) / 100;
}

// smoothing for karts driven elsewhere: dead-reckon with their velocity, ease out the error
function setTarget(k, st) {
  if (!k.net) {
    k.net = { ex: 0, ey: 0, ez: 0, eyaw: 0 };
    k.x = st[0];
    k.y = st[1];
    k.z = st[2];
    k.yaw = st[3];
  }
  k.net.ex = st[0] - k.x;
  k.net.ey = st[1] - k.y;
  k.net.ez = st[2] - k.z;
  let dy = st[3] - k.yaw;
  while (dy > Math.PI) dy -= Math.PI * 2;
  while (dy < -Math.PI) dy += Math.PI * 2;
  k.net.eyaw = dy;
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
  k.spinAng = k.spinT > 0 ? (k.spinAng || 0) : 0;
}

function glide(k, race) {
  if (!k.net) return;
  const f = 0.2;
  k.x += k.vx * DT + k.net.ex * f;
  k.z += k.vz * DT + k.net.ez * f;
  k.y += k.net.ey * f + (k.grounded ? 0 : k.vy * DT);
  k.yaw += k.net.eyaw * f;
  k.net.ex *= 1 - f;
  k.net.ey *= 1 - f;
  k.net.ez *= 1 - f;
  k.net.eyaw *= 1 - f;
  if (k.spinT > 0) k.spinAng += 13 * DT;
  k.wheelRot += (k.vf * DT) / 0.32;
  // keep it on the ground and on the track
  race.applyState(k, [k.x, k.y, k.z, k.yaw, k.vx, k.vz, k.vy, k.vf, k.drift, k.boostT, k.shieldT, k.spinT, k.steerVis, k.grounded ? 1 : 0, k.driftLevel, k.trick]);
  if (k.grounded && Math.abs(k.y - k.gy) < 1) k.y = k.gy;
}
