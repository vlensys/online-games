// HUD: DOM updates (only when values change), damage numbers, minimap and full map.
import * as THREE from 'three';
import { RARITY, WEAPONS, CONSUMABLES, AMMO_LIST, WORLD_HALF, isWeapon, isConsumable } from '../core/config.js';
import { itemIcon } from './textures.js';

const $ = (id) => document.getElementById(id);
const PIECE_LABELS = ['WALL', 'FLOOR', 'STAIRS', 'ROOF'];
const PIECE_KEYS = ['Q', 'Z', 'X', 'V'];
const MAT_NAMES = ['WOOD', 'BRICK', 'METAL'];

export function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export class Hud {
  constructor() {
    this.root = $('hud');
    this.el = {};
    for (const id of [
      'stormTint', 'scope', 'dmgDirs', 'nums', 'minimap', 'stormTimer', 'aliveCount', 'killCount', 'stormMsg', 'killfeed', 'alerts', 'bigMsg',
      'crosshair', 'hitmarker', 'prompt', 'promptKey', 'promptText', 'progress', 'progressLabel', 'progressFill', 'pieceHp', 'pieceHpFill',
      'pieceHpText', 'shieldFill', 'shieldText', 'healthFill', 'healthText', 'mat0', 'mat1', 'mat2', 'ammoReserve', 'hotbar', 'buildbar',
      'spectate', 'specName', 'specHint', 'busHint', 'busText', 'lockHint', 'fps', 'netStatus', 'resources',
    ])
      this.el[id] = $(id);
    this.cache = {};
    this.nums = [];
    this.numPool = [];
    this.hmT = 0;
    this.mini = this.el.minimap.getContext('2d');
    this.onSlot = null;
    this.buildSlots();
    this._v = new THREE.Vector3();
  }

  show(on) {
    this.root.classList.toggle('hidden', !on);
  }

  set(key, val, fn) {
    if (this.cache[key] === val) return;
    this.cache[key] = val;
    fn(val);
  }

  text(id, v) {
    this.set('t_' + id, v, (x) => (this.el[id].textContent = x));
  }

  toggle(id, on) {
    this.set('v_' + id, !!on, (x) => this.el[id].classList.toggle('hidden', !x));
  }

  buildSlots() {
    const hb = this.el.hotbar;
    hb.innerHTML = '';
    this.slotEls = [];
    for (let i = 0; i < 6; i++) {
      const d = document.createElement('div');
      d.className = 'slot';
      const c = document.createElement('canvas');
      c.width = 96;
      c.height = 96;
      const n = document.createElement('span');
      n.className = 'n';
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = String(i + 1);
      d.append(c, n, k);
      d.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.onSlot) this.onSlot(i);
      });
      hb.appendChild(d);
      this.slotEls.push({ d, c, n, g: c.getContext('2d') });
    }
    const bb = this.el.buildbar;
    bb.innerHTML = '';
    this.buildEls = [];
    for (let i = 0; i < 4; i++) {
      const d = document.createElement('div');
      d.className = 'slot';
      d.innerHTML = `<span class="lbl">${PIECE_LABELS[i]}</span><span class="k">${PIECE_KEYS[i]}</span>`;
      d.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (this.onPiece) this.onPiece(i);
      });
      bb.appendChild(d);
      this.buildEls.push(d);
    }
  }

  vitals(hp, sh) {
    hp = Math.max(0, Math.ceil(hp));
    sh = Math.max(0, Math.ceil(sh));
    this.set('hp', hp, (v) => {
      this.el.healthFill.style.width = v + '%';
      this.el.healthText.textContent = v;
      this.el.healthFill.parentElement.classList.toggle('low', v <= 25);
    });
    this.set('sh', sh, (v) => {
      this.el.shieldFill.style.width = v + '%';
      this.el.shieldText.textContent = v;
    });
  }

  hotbar(inv, cur, build, localMag) {
    const sig = JSON.stringify(inv.slots) + cur + (build ? 'b' : '') + localMag;
    if (this.cache.hot === sig) return;
    this.cache.hot = sig;
    for (let i = 0; i < 6; i++) {
      const e = this.slotEls[i];
      const s = i === 0 ? { t: 'pickaxe', r: -1 } : inv.slots[i - 1];
      e.d.className = 'slot' + (s && s.r >= 0 ? ' r' + s.r : '') + (i === cur && !build ? ' sel' : '');
      e.g.clearRect(0, 0, 96, 96);
      if (s) e.g.drawImage(itemIcon(s.t), 0, 0);
      let n = '';
      if (s && isWeapon(s.t)) n = i === cur && localMag !== undefined ? localMag : s.n;
      else if (s && isConsumable(s.t)) n = s.n;
      e.n.textContent = n;
    }
  }

  buildbar(on, kind, mat) {
    this.toggle('buildbar', on);
    this.set('bb', on + ':' + kind + ':' + mat, () => {
      this.buildEls.forEach((d, i) => d.classList.toggle('sel', i === kind));
      for (const r of this.el.resources.querySelectorAll('.res[data-m]')) r.classList.toggle('sel', on && +r.dataset.m === mat);
    });
  }

  mats(m) {
    this.text('mat0', String(m[0]));
    this.text('mat1', String(m[1]));
    this.text('mat2', String(m[2]));
  }

  ammo(n) {
    this.text('ammoReserve', n === null ? '-' : String(n));
  }

  info(storm, alive, kills) {
    this.text('stormTimer', storm);
    this.text('aliveCount', String(alive));
    this.text('killCount', String(kills));
  }

  stormMsg(t) {
    this.text('stormMsg', t);
  }

  tint(on) {
    this.set('tint', !!on, (v) => this.el.stormTint.classList.toggle('on', v));
  }

  crosshair(gapPx, mode) {
    const g = Math.round(Math.min(80, gapPx));
    this.set('chg', g, (v) => this.el.crosshair.style.setProperty('--g', v + 'px'));
    this.set('chm', mode, (v) => {
      this.el.crosshair.className = v;
      this.el.crosshair.classList.toggle('hidden', v === 'none');
    });
  }

  hitmarker(kind) {
    const h = this.el.hitmarker;
    h.className = kind === 'head' ? 'head' : kind === 'kill' ? 'kill' : '';
    this.hmT = 0.16;
    this.cache.hm = true;
  }

  prompt(text, key) {
    this.set('pr', text ? key + text : '', () => {
      if (!text) this.el.prompt.classList.add('hidden');
      else {
        this.el.prompt.classList.remove('hidden');
        this.el.promptKey.textContent = key;
        this.el.promptText.textContent = text;
        this.el.promptKey.classList.toggle('hidden', !key);
      }
    });
  }

  progress(label, f) {
    if (f === null || f === undefined) {
      this.toggle('progress', false);
      return;
    }
    this.toggle('progress', true);
    this.text('progressLabel', label);
    this.el.progressFill.style.width = Math.round(f * 100) + '%';
  }

  pieceHp(f, text) {
    if (f === null) {
      this.toggle('pieceHp', false);
      return;
    }
    this.toggle('pieceHp', true);
    this.el.pieceHpFill.style.width = Math.round(f * 100) + '%';
    this.text('pieceHpText', text);
  }

  killfeed(html) {
    const d = document.createElement('div');
    d.className = 'kf';
    d.innerHTML = html;
    this.el.killfeed.appendChild(d);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.firstChild.remove();
    setTimeout(() => d.remove(), 7000);
  }

  pickup(text, color) {
    const box = document.getElementById('pickups');
    if (!box) return;
    const d = document.createElement('div');
    d.className = 'pk';
    d.textContent = text;
    if (color) d.style.borderLeftColor = color;
    box.appendChild(d);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => d.remove(), 2600);
  }

  alert(text, cls = '', dur = 3) {
    const d = document.createElement('div');
    d.className = 'alert ' + cls;
    d.textContent = text;
    this.el.alerts.appendChild(d);
    while (this.el.alerts.children.length > 3) this.el.alerts.firstChild.remove();
    setTimeout(() => d.remove(), dur * 1000);
  }

  big(text, dur = 2.5) {
    const b = this.el.bigMsg;
    b.textContent = text;
    b.classList.remove('hidden');
    clearTimeout(this.bigT);
    this.bigT = setTimeout(() => b.classList.add('hidden'), dur * 1000);
  }

  dmgDir(angle) {
    const d = document.createElement('div');
    d.className = 'dmgdir';
    d.style.transform = `rotate(${angle}rad)`;
    this.el.dmgDirs.appendChild(d);
    setTimeout(() => d.remove(), 1100);
  }

  number(x, y, z, val, cls) {
    let el = this.numPool.pop();
    if (!el) {
      el = document.createElement('div');
      this.el.nums.appendChild(el);
    }
    el.className = 'num ' + (cls || '');
    el.textContent = val;
    el.style.display = '';
    this.nums.push({ el, x, y, z, t: 0, ox: (Math.random() - 0.5) * 30 });
    if (this.nums.length > 24) {
      const n = this.nums.shift();
      n.el.style.display = 'none';
      this.numPool.push(n.el);
    }
  }

  update(dt, camera) {
    if (this.hmT > 0) {
      this.hmT -= dt;
      if (this.hmT <= 0) this.el.hitmarker.className = 'hidden';
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let i = this.nums.length - 1; i >= 0; i--) {
      const n = this.nums[i];
      n.t += dt;
      if (n.t > 0.9) {
        n.el.style.display = 'none';
        this.numPool.push(n.el);
        this.nums.splice(i, 1);
        continue;
      }
      const v = this._v.set(n.x, n.y, n.z).project(camera);
      if (v.z > 1) {
        n.el.style.opacity = 0;
        continue;
      }
      const sx = (v.x * 0.5 + 0.5) * w + n.ox * n.t;
      const sy = (-v.y * 0.5 + 0.5) * h - 40 * n.t - 20;
      const sc = n.t < 0.12 ? 1.4 - n.t * 3 : 1;
      n.el.style.opacity = n.t > 0.6 ? String(1 - (n.t - 0.6) / 0.3) : '1';
      n.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) scale(${sc.toFixed(2)})`;
    }
  }

  spectate(name, hint) {
    this.toggle('spectate', !!name);
    if (name) {
      this.text('specName', name);
      this.text('specHint', hint);
    }
  }

  fps(v) {
    this.text('fps', v);
  }

  clearTransient() {
    const pk = document.getElementById('pickups');
    if (pk) pk.innerHTML = '';
    this.el.killfeed.innerHTML = '';
    this.el.alerts.innerHTML = '';
    this.el.dmgDirs.innerHTML = '';
    for (const n of this.nums) {
      n.el.style.display = 'none';
      this.numPool.push(n.el);
    }
    this.nums = [];
    this.cache = {};
  }
}

// ------------------------------------------------------------------ maps
export class MapPainter {
  constructor(map) {
    this.map = map;
    const S = 512;
    this.S = S;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    const T = map.terrain;
    const H = WORLD_HALF;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const wx = (x / S) * 2 * H - H;
        const wz = (y / S) * 2 * H - H;
        const h = T.heightAt(wx, wz);
        let r;
        let gg;
        let b;
        if (h < 0) {
          const d = Math.min(1, -h / 12);
          r = 70 - d * 30;
          gg = 170 - d * 50;
          b = 225 - d * 25;
        } else if (h < 2.6) {
          r = 236;
          gg = 219;
          b = 160;
        } else if (h > 74) {
          r = 240;
          gg = 244;
          b = 248;
        } else if (h > 50) {
          r = 140;
          gg = 150;
          b = 120;
        } else {
          const f = Math.min(1, h / 50);
          r = 108 - f * 30;
          gg = 190 - f * 30;
          b = 72 - f * 10;
        }
        const i = (y * S + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = gg;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    g.putImageData(img, 0, 0);
    const k = S / (2 * H);
    g.strokeStyle = '#bdb6a6';
    g.lineWidth = 3;
    for (const r of map.roads) {
      g.beginPath();
      g.moveTo((r.x1 + H) * k, (r.z1 + H) * k);
      g.lineTo((r.x2 + H) * k, (r.z2 + H) * k);
      g.stroke();
    }
    g.fillStyle = '#6f6a66';
    for (const b of map.buildings) g.fillRect((b.x0 + H) * k, (b.z0 + H) * k, Math.max(2, (b.x1 - b.x0) * k), Math.max(2, (b.z1 - b.z0) * k));
    this.img = c;
    this.k = k;
  }

  toMap(x, z, cx, cz, scale, W) {
    return [(x - cx) * scale + W / 2, (z - cz) * scale + W / 2];
  }

  drawStorm(g, s, cx, cz, scale, W, fullAlpha = 0.35) {
    if (!s) return;
    const [sx, sy] = this.toMap(s.cx, s.cz, cx, cz, scale, W);
    g.save();
    g.beginPath();
    g.rect(-10, -10, W + 20, W + 20);
    g.arc(sx, sy, Math.max(0, s.r * scale), 0, Math.PI * 2, true);
    g.fillStyle = `rgba(128, 50, 200, ${fullAlpha})`;
    g.fill('evenodd');
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(190, 120, 255, 0.95)';
    g.beginPath();
    g.arc(sx, sy, Math.max(0, s.r * scale), 0, Math.PI * 2);
    g.stroke();
    const [nx, ny] = this.toMap(s.nx, s.nz, cx, cz, scale, W);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(nx, ny, Math.max(1, s.nr * scale), 0, Math.PI * 2);
    g.stroke();
    g.restore();
  }

  drawArrow(g, x, y, yaw, col, size = 8) {
    g.save();
    g.translate(x, y);
    g.rotate(-yaw);
    g.beginPath();
    g.moveTo(0, -size);
    g.lineTo(size * 0.7, size * 0.8);
    g.lineTo(0, size * 0.35);
    g.lineTo(-size * 0.7, size * 0.8);
    g.closePath();
    g.fillStyle = col;
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = '#1b1b1b';
    g.stroke();
    g.restore();
  }

  drawBus(g, bus, cx, cz, scale, W) {
    if (!bus) return;
    const [ax, ay] = this.toMap(bus.sx, bus.sz, cx, cz, scale, W);
    const [bx, by] = this.toMap(bus.ex, bus.ez, cx, cz, scale, W);
    g.save();
    g.setLineDash([8, 6]);
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.stroke();
    g.restore();
  }

  mini(g, W, px, pz, yaw, storm, bus, busPos, marks) {
    const span = 240;
    const scale = W / span;
    const H = WORLD_HALF;
    g.fillStyle = '#2c7fc4';
    g.fillRect(0, 0, W, W);
    const k = this.k;
    const sx = (px - span / 2 + H) * k;
    const sy = (pz - span / 2 + H) * k;
    g.drawImage(this.img, sx, sy, span * k, span * k, 0, 0, W, W);
    this.drawStorm(g, storm, px, pz, scale, W);
    if (bus) this.drawBus(g, bus, px, pz, scale, W);
    if (marks) for (const m of marks) {
      const [mx, my] = this.toMap(m.x, m.z, px, pz, scale, W);
      g.fillStyle = m.c;
      g.beginPath();
      g.arc(mx, my, 3, 0, Math.PI * 2);
      g.fill();
    }
    // path to safe zone
    if (storm) {
      const dx = storm.nx - px;
      const dz = storm.nz - pz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > storm.nr) {
        g.save();
        g.setLineDash([4, 4]);
        g.strokeStyle = 'rgba(255,255,255,0.8)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(W / 2, W / 2);
        const f = (d - storm.nr) / d;
        g.lineTo(W / 2 + dx * f * scale, W / 2 + dz * f * scale);
        g.stroke();
        g.restore();
      }
    }
    if (busPos) {
      const [bx, by] = this.toMap(busPos[0], busPos[2], px, pz, scale, W);
      g.fillStyle = '#2f73d8';
      g.fillRect(bx - 5, by - 3, 10, 6);
    }
    this.drawArrow(g, W / 2, W / 2, yaw, '#ffd23f');
  }

  full(g, W, px, pz, yaw, storm, bus, busPos, pois, marks) {
    const H = WORLD_HALF;
    const span = 2 * H;
    const scale = W / span;
    g.fillStyle = '#2c7fc4';
    g.fillRect(0, 0, W, W);
    g.drawImage(this.img, 0, 0, W, W);
    this.drawStorm(g, storm, 0, 0, scale, W, 0.3);
    if (bus) this.drawBus(g, bus, 0, 0, scale, W);
    g.font = '800 italic 15px system-ui, sans-serif';
    g.textAlign = 'center';
    for (const p of pois) {
      const [x, y] = this.toMap(p.x, p.z, 0, 0, scale, W);
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(0,0,0,0.65)';
      g.strokeText(p.name.toUpperCase(), x, y);
      g.fillStyle = '#ffffff';
      g.fillText(p.name.toUpperCase(), x, y);
    }
    if (marks) for (const m of marks) {
      const [mx, my] = this.toMap(m.x, m.z, 0, 0, scale, W);
      g.fillStyle = m.c;
      g.beginPath();
      g.arc(mx, my, 4, 0, Math.PI * 2);
      g.fill();
    }
    if (busPos) {
      const [bx, by] = this.toMap(busPos[0], busPos[2], 0, 0, scale, W);
      g.fillStyle = '#2f73d8';
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.fillRect(bx - 8, by - 5, 16, 10);
      g.strokeRect(bx - 8, by - 5, 16, 10);
    }
    const [mx, my] = this.toMap(px, pz, 0, 0, scale, W);
    this.drawArrow(g, mx, my, yaw, '#ffd23f', 11);
  }
}

export function killfeedHtml(names, myId, m) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const nm = (id) => `<b class="${id === myId ? 'me' : ''}">${esc(names.get(id) || '?')}</b>`;
  const v = nm(m.v);
  if (m.w === 'storm' && !m.k) return `${v} <span class="w">was lost in the storm</span>`;
  if (m.w === 'fall' && !m.k) return `${v} <span class="w">fell to their elimination</span>`;
  if (m.w === 'left') return `${v} <span class="w">left the match</span>`;
  if (!m.k) return `${v} <span class="w">was eliminated</span>`;
  const how =
    m.w === 'storm' ? 'into the storm' : m.w === 'fall' ? 'off a ledge' : m.w === 'pickaxe' ? 'with a pickaxe' : WEAPONS[m.w] ? 'with ' + WEAPONS[m.w].name + (m.h ? ' (headshot)' : '') : '';
  return `${nm(m.k)} <span class="w">eliminated</span> ${v} <span class="w">${esc(how)}</span>`;
}

export { MAT_NAMES, RARITY, AMMO_LIST, CONSUMABLES };
