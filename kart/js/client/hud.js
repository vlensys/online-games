// The in-race HUD (plain DOM): place, lap, timer, item slot with its roulette, speed, minimap,
// the running order, countdown and banners.
import { ordinal, fmtTime, driverById } from '../core/config.js';

const $ = (id) => document.getElementById(id);

export const ICONS = {
  nitro:
    '<svg viewBox="0 0 64 64"><path d="M22 10h20v6H22z" fill="#9aa"/><rect x="18" y="16" width="28" height="40" rx="8" fill="#e8412c"/><rect x="18" y="28" width="28" height="8" fill="#fff"/><path d="M32 40c-6 6-3 12 0 12s6-6 0-12z" fill="#ffd23f"/></svg>',
  nitro3:
    '<svg viewBox="0 0 64 64"><g fill="#e8412c"><rect x="4" y="20" width="16" height="32" rx="5"/><rect x="24" y="12" width="16" height="40" rx="5"/><rect x="44" y="20" width="16" height="32" rx="5"/></g><g fill="#fff"><rect x="4" y="30" width="16" height="5"/><rect x="24" y="24" width="16" height="5"/><rect x="44" y="30" width="16" height="5"/></g></svg>',
  rocket:
    '<svg viewBox="0 0 64 64"><path d="M32 4c9 8 12 20 10 34H22C20 24 23 12 32 4z" fill="#e8412c"/><circle cx="32" cy="22" r="5" fill="#fff"/><path d="M22 38l-8 12 10-4zM42 38l8 12-10-4z" fill="#30303a"/><path d="M26 42h12l-6 16z" fill="#ffb000"/></svg>',
  homing:
    '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="27" fill="none" stroke="#ff5fb7" stroke-width="4" stroke-dasharray="8 6"/><path d="M32 10c7 6 9 15 8 26H24c-1-11 1-20 8-26z" fill="#8a4cff"/><circle cx="32" cy="24" r="4" fill="#fff"/><path d="M27 38h10l-5 12z" fill="#ffb000"/></svg>',
  oil: '<svg viewBox="0 0 64 64"><path d="M10 40c0-10 12-12 20-10 4-8 22-6 22 6 6 2 6 14-4 16-8 4-34 4-38-12z" fill="#181520"/><path d="M24 36c4-3 10-3 14 0" stroke="#9a6bff" stroke-width="3" fill="none"/><path d="M40 8c-6 9-6 14 0 14s6-5 0-14z" fill="#181520"/></svg>',
  shield:
    '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="25" fill="#5fd8ff" opacity=".35"/><circle cx="32" cy="32" r="25" fill="none" stroke="#5fd8ff" stroke-width="4"/><path d="M22 22c4-4 10-5 14-3" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round"/></svg>',
  emp: '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" fill="none" stroke="#ffd23f" stroke-width="4"/><path d="M36 8L18 36h12l-4 20 20-30H34z" fill="#ffd23f"/></svg>',
};
const ROLL = Object.keys(ICONS);

export class Hud {
  constructor() {
    this.el = $('hud');
    this.last = {};
    this.mini = $('minimap');
    this.mctx = this.mini.getContext('2d');
    this.rollI = 0;
    this.bannerT = 0;
    this.listT = 0;
  }
  show(on) {
    this.el.classList.toggle('hidden', !on);
  }
  set(key, el, val, html = false) {
    if (this.last[key] === val) return;
    this.last[key] = val;
    if (html) el.innerHTML = val;
    else el.textContent = val;
  }
  // track outline for the minimap (drawn once per race)
  setTrack(T) {
    const W = this.mini.width,
      H = this.mini.height;
    const b = T.bounds;
    const w = b.maxX - b.minX,
      h = b.maxZ - b.minZ;
    const s = (Math.min(W, H) - 24) / Math.max(w, h);
    const ox = (W - w * s) / 2,
      oz = (H - h * s) / 2;
    this.map = (x, z) => [ox + (x - b.minX) * s, oz + (z - b.minZ) * s];
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const g = off.getContext('2d');
    g.lineJoin = g.lineCap = 'round';
    for (const [wid, col] of [
      [11, 'rgba(0,0,0,0.55)'],
      [6, 'rgba(255,255,255,0.92)'],
    ]) {
      g.strokeStyle = col;
      g.lineWidth = wid;
      g.beginPath();
      for (let i = 0; i <= T.n; i += 2) {
        const [x, y] = this.map(T.px[i % T.n], T.pz[i % T.n]);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.stroke();
    }
    const [sx, sy] = this.map(T.px[0], T.pz[0]);
    g.fillStyle = '#111';
    g.fillRect(sx - 4, sy - 4, 8, 8);
    g.fillStyle = '#fff';
    g.fillRect(sx - 4, sy - 4, 4, 4);
    g.fillRect(sx, sy, 4, 4);
    this.trackImg = off;
  }
  drawMap(race, me) {
    const g = this.mctx;
    g.clearRect(0, 0, this.mini.width, this.mini.height);
    if (!this.trackImg) return;
    g.drawImage(this.trackImg, 0, 0);
    for (const p of race.proj) {
      const [x, y] = this.map(p.x, p.z);
      g.fillStyle = p.type === 'homing' ? '#c58aff' : '#ff6a5a';
      g.fillRect(x - 2, y - 2, 4, 4);
    }
    const ks = [...race.karts].sort((a, b) => (a === me) - (b === me));
    for (const k of ks) {
      const [x, y] = this.map(k.x, k.z);
      const r = k === me ? 6.5 : 4.5;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = driverById(k.driver).body;
      g.fill();
      g.lineWidth = k === me ? 2.5 : 1.5;
      g.strokeStyle = k === me ? '#fff' : 'rgba(0,0,0,0.7)';
      g.stroke();
    }
  }
  update(race, me, dt, extra) {
    if (!me) return;
    const total = race.laps;
    this.set('place', $('placeN'), String(me.place));
    this.set('placeS', $('placeS'), ordinal(me.place).replace(/^\d+/, ''));
    $('place').className = 'p' + Math.min(me.place, 4);
    this.set('lap', $('lapN'), String(Math.max(1, Math.min(total, me.lap))));
    this.set('lapT', $('lapT'), String(total));
    const t = me.finished ? me.finishT : Math.max(0, race.time);
    this.set('timer', $('timer'), fmtTime(t));
    const lt = me.lapTimes.map((x, i) => `<div><span>L${i + 1}</span>${fmtTime(x)}</div>`).join('');
    this.set('laps', $('laps'), lt, true);
    this.set('speed', $('speedN'), String(Math.round(Math.abs(me.vf) * 3.6)));
    // item slot
    let icon = '',
      cnt = '';
    if (me.rollT > 0) {
      this.rollI += dt * 14;
      icon = ICONS[ROLL[Math.floor(this.rollI) % ROLL.length]];
    } else if (me.item) {
      icon = ICONS[me.item];
      if (me.itemN > 1) cnt = '×' + me.itemN;
    }
    this.set('icon', $('itemIcon'), icon, true);
    this.set('cnt', $('itemCount'), cnt);
    $('itemBox').classList.toggle('rolling', me.rollT > 0);
    $('itemBox').classList.toggle('has', !!me.item && me.rollT <= 0);
    // drift charge meter
    const lv = me.drift ? me.driftLevel : 0;
    $('driftMeter').className = me.drift ? 'on l' + lv : '';
    // wrong way
    $('wrong').classList.toggle('hidden', !(me.wrongT > 0.8 && race.state === 'race' && !me.finished));
    // running order
    this.listT -= dt;
    if (this.listT <= 0) {
      this.listT = 0.25;
      const rows = race.order
        .map((k) => `<div class="${k === me ? 'me' : ''}"><b>${k.place}</b><i style="background:${driverById(k.driver).body}"></i>${esc(k.name)}</div>`)
        .join('');
      this.set('list', $('ranking'), rows, true);
    }
    this.drawMap(race, me);
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) $('banner').classList.remove('show');
    }
    if (extra && extra.fps !== undefined) this.set('fps', $('fps'), extra.fps ? extra.fps + ' fps' : '');
  }
  banner(text, cls = '', time = 1.6) {
    const b = $('banner');
    b.textContent = text;
    b.className = 'show ' + cls;
    this.bannerT = time;
  }
  count(text) {
    const c = $('count');
    c.textContent = text;
    c.classList.remove('pop');
    void c.offsetWidth;
    if (text) c.classList.add('pop');
  }
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

