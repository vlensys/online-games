// Procedural canvas textures (no image files). Mostly light/greyscale so per-instance
// colors tint them (map buildings are pastel, player builds use material colors).
import * as THREE from 'three';
import { mulberry32 } from '../core/rng.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function finish(c, renderer) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = Math.min(4, renderer ? renderer.capabilities.getMaxAnisotropy() : 1);
  return t;
}

function frame(g, S, col, w) {
  g.fillStyle = col;
  g.fillRect(0, 0, S, w);
  g.fillRect(0, S - w, S, w);
  g.fillRect(0, 0, w, S);
  g.fillRect(S - w, 0, w, S);
}

export function woodTexture(renderer) {
  const S = 256;
  const c = canvas(S, S);
  const g = c.getContext('2d');
  const rnd = mulberry32(11);
  g.fillStyle = '#f4f1ec';
  g.fillRect(0, 0, S, S);
  const planks = 5;
  const ph = S / planks;
  for (let i = 0; i < planks; i++) {
    const v = 232 + Math.floor(rnd() * 22);
    g.fillStyle = `rgb(${v},${v - 4},${v - 10})`;
    g.fillRect(0, i * ph, S, ph);
    // grain
    g.strokeStyle = 'rgba(120,100,80,0.10)';
    g.lineWidth = 1.5;
    for (let k = 0; k < 4; k++) {
      const y = i * ph + 6 + rnd() * (ph - 12);
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(S * 0.3, y + rnd() * 6 - 3, S * 0.6, y + rnd() * 6 - 3, S, y);
      g.stroke();
    }
    g.fillStyle = 'rgba(80,60,40,0.35)';
    g.fillRect(0, i * ph, S, 3);
    // plank end joint
    const jx = Math.floor(rnd() * S);
    g.fillRect(jx, i * ph, 3, ph);
    // nails
    g.fillStyle = 'rgba(60,50,40,0.45)';
    g.fillRect(14, i * ph + ph / 2 - 2, 4, 4);
    g.fillRect(S - 18, i * ph + ph / 2 - 2, 4, 4);
  }
  frame(g, S, 'rgba(70,50,30,0.3)', 5);
  return finish(c, renderer);
}

export function brickTexture(renderer) {
  const S = 256;
  const c = canvas(S, S);
  const g = c.getContext('2d');
  const rnd = mulberry32(22);
  g.fillStyle = '#d9d4cf';
  g.fillRect(0, 0, S, S);
  const rows = 8;
  const bh = S / rows;
  const bw = S / 4;
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? bw / 2 : 0;
    for (let k = -1; k < 5; k++) {
      const v = 226 + Math.floor(rnd() * 29);
      g.fillStyle = `rgb(${v},${v - 6},${v - 8})`;
      g.fillRect(k * bw + off + 3, r * bh + 3, bw - 6, bh - 6);
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(k * bw + off + 3, r * bh + 3, bw - 6, 3);
    }
  }
  frame(g, S, 'rgba(60,40,35,0.3)', 5);
  return finish(c, renderer);
}

export function metalTexture(renderer) {
  const S = 256;
  const c = canvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = '#e9edf0';
  g.fillRect(0, 0, S, S);
  const n = 12;
  const w = S / n;
  for (let i = 0; i < n; i++) {
    const grd = g.createLinearGradient(i * w, 0, (i + 1) * w, 0);
    grd.addColorStop(0, '#f8fafb');
    grd.addColorStop(0.5, '#d2d8dd');
    grd.addColorStop(1, '#f2f5f7');
    g.fillStyle = grd;
    g.fillRect(i * w, 0, w, S);
  }
  g.fillStyle = 'rgba(40,50,60,0.25)';
  g.fillRect(0, S / 2 - 3, S, 6);
  frame(g, S, 'rgba(40,50,60,0.35)', 7);
  g.fillStyle = 'rgba(40,50,60,0.55)';
  for (const x of [18, S / 2, S - 18]) for (const y of [18, S - 18]) {
    g.beginPath();
    g.arc(x, y, 4, 0, Math.PI * 2);
    g.fill();
  }
  return finish(c, renderer);
}

// Small item icons for the hotbar (drawn once per type/rarity)
const iconCache = new Map();
export function itemIcon(t) {
  if (iconCache.has(t)) return iconCache.get(t);
  const c = canvas(96, 96);
  const g = c.getContext('2d');
  g.translate(48, 48);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  const dark = '#2a2f36';
  const fill = (col, path) => {
    g.fillStyle = col;
    g.beginPath();
    path();
    g.fill();
  };
  const rect = (x, y, w, h, col) => {
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
  };
  g.rotate(-0.35);
  switch (t) {
    case 'pickaxe':
      g.rotate(0.35 + 0.8);
      rect(-3, -30, 6, 62, '#8a5a32');
      fill('#7fd0ff', () => {
        g.moveTo(-30, -26);
        g.quadraticCurveTo(0, -42, 30, -26);
        g.lineTo(26, -20);
        g.quadraticCurveTo(0, -32, -26, -20);
        g.closePath();
      });
      break;
    case 'pistol':
      rect(-20, -12, 40, 12, dark);
      rect(-18, -2, 11, 20, '#4a515b');
      break;
    case 'smg':
      rect(-30, -10, 56, 13, dark);
      rect(-8, 2, 7, 20, '#4a515b');
      rect(-26, 2, 9, 12, '#4a515b');
      rect(24, -8, 12, 5, '#4a515b');
      break;
    case 'ar':
      rect(-40, -9, 64, 13, dark);
      rect(22, -6, 18, 5, '#4a515b');
      rect(-6, 3, 8, 20, '#4a515b');
      rect(-40, -6, 14, 18, dark);
      rect(-4, -15, 10, 6, '#222');
      break;
    case 'shotgun':
      rect(-40, -9, 76, 9, dark);
      rect(0, 0, 22, 8, '#8a5a32');
      rect(-40, -6, 18, 16, '#8a5a32');
      break;
    case 'sniper':
      rect(-42, -7, 84, 10, dark);
      rect(-10, -17, 26, 8, '#1f1f24');
      rect(-42, -4, 16, 16, '#8a5a32');
      break;
    case 'rocket':
      rect(-40, -10, 80, 18, '#4d5a3d');
      rect(-6, 8, 8, 14, dark);
      rect(36, -12, 8, 22, '#3a4430');
      break;
    case 'bandage':
      g.rotate(0.35);
      fill('#f3efe6', () => g.arc(0, 0, 22, 0, Math.PI * 2));
      fill('#d9cdb2', () => g.arc(0, 0, 9, 0, Math.PI * 2));
      break;
    case 'medkit':
      g.rotate(0.35);
      rect(-26, -18, 52, 36, '#f7f7f7');
      rect(-14, -4, 28, 8, '#e0403a');
      rect(-4, -14, 8, 28, '#e0403a');
      break;
    case 'shieldS':
      g.rotate(0.35);
      fill('#4cc6ff', () => g.arc(0, 6, 17, 0, Math.PI * 2));
      rect(-5, -22, 10, 14, '#e8e8e8');
      break;
    case 'shieldL':
      g.rotate(0.35);
      rect(-16, -18, 32, 40, '#2f8cff');
      rect(-7, -28, 14, 10, '#e8e8e8');
      rect(-16, 0, 32, 6, '#9fd8ff');
      break;
    default:
      rect(-16, -16, 32, 32, '#999');
  }
  iconCache.set(t, c);
  return c;
}
