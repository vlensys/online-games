// Textures drawn on canvases at load time (no image files to fetch).
import * as THREE from 'three';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function tex(c, repeat = true, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function rnd(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function shade(hex, f) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(f);
  return '#' + c.getHexString();
}

export function asphalt(color) {
  const [c, g] = canvas(256, 256);
  g.fillStyle = color;
  g.fillRect(0, 0, 256, 256);
  const r = rnd(7);
  for (let i = 0; i < 5000; i++) {
    const v = r();
    g.fillStyle = v < 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.07)';
    g.fillRect(r() * 256, r() * 256, 1 + r() * 2, 1 + r() * 2);
  }
  // faint wheel tracks along the middle of each lane
  g.fillStyle = 'rgba(0,0,0,0.06)';
  for (const x of [56, 92, 164, 200]) g.fillRect(x, 0, 14, 256);
  // white edge lines
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(6, 0, 5, 256);
  g.fillRect(245, 0, 5, 256);
  return tex(c);
}

export function neonRoad(color) {
  const [c, g] = canvas(256, 256);
  g.fillStyle = color;
  g.fillRect(0, 0, 256, 256);
  const r = rnd(3);
  for (let i = 0; i < 2500; i++) {
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(r() * 256, r() * 256, 2, 2);
  }
  g.strokeStyle = 'rgba(120,220,255,0.18)';
  g.lineWidth = 2;
  for (let y = 0; y < 256; y += 32) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(256, y);
    g.stroke();
  }
  g.fillStyle = 'rgba(255,255,255,0.8)';
  g.fillRect(6, 0, 4, 256);
  g.fillRect(246, 0, 4, 256);
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(126, 0, 4, 128);
  return tex(c);
}

export function curb(a, b) {
  const [c, g] = canvas(32, 64);
  g.fillStyle = a;
  g.fillRect(0, 0, 32, 32);
  g.fillStyle = b;
  g.fillRect(0, 32, 32, 32);
  g.fillStyle = 'rgba(0,0,0,0.15)';
  g.fillRect(0, 0, 3, 64);
  return tex(c);
}

export function checker(n = 8) {
  const [c, g] = canvas(128, 128);
  const s = 128 / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      g.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f4';
      g.fillRect(i * s, j * s, s, s);
    }
  return tex(c);
}

export function ground(c1, c2, seed = 1) {
  const [c, g] = canvas(256, 256);
  g.fillStyle = c1;
  g.fillRect(0, 0, 256, 256);
  const r = rnd(seed * 31 + 5);
  for (let i = 0; i < 160; i++) {
    const x = r() * 256,
      y = r() * 256,
      rad = 8 + r() * 30;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, c2);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = 0.5;
    g.fillStyle = gr;
    for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) g.fillRect(x - rad + ox, y - rad + oy, rad * 2, rad * 2);
  }
  g.globalAlpha = 1;
  for (let i = 0; i < 3000; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
    g.fillRect(r() * 256, r() * 256, 2, 2);
  }
  return tex(c);
}

export function chevrons(color) {
  const [c, g] = canvas(64, 128);
  g.fillStyle = '#1b1208';
  g.fillRect(0, 0, 64, 128);
  g.fillStyle = color;
  for (let k = 0; k < 2; k++) {
    const y = k * 64;
    g.beginPath();
    g.moveTo(6, y + 50);
    g.lineTo(32, y + 18);
    g.lineTo(58, y + 50);
    g.lineTo(58, y + 62);
    g.lineTo(32, y + 30);
    g.lineTo(6, y + 62);
    g.closePath();
    g.fill();
  }
  return tex(c);
}

export function stripes(a, b) {
  const [c, g] = canvas(64, 64);
  g.fillStyle = a;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = b;
  for (let i = -64; i < 64; i += 32) {
    g.beginPath();
    g.moveTo(i, 64);
    g.lineTo(i + 16, 64);
    g.lineTo(i + 80, 0);
    g.lineTo(i + 64, 0);
    g.closePath();
    g.fill();
  }
  return tex(c);
}

export function itemBox() {
  const [c, g] = canvas(128, 128);
  const gr = g.createLinearGradient(0, 0, 128, 128);
  gr.addColorStop(0, '#ff5fb7');
  gr.addColorStop(0.35, '#ffd23f');
  gr.addColorStop(0.7, '#3fe0ff');
  gr.addColorStop(1, '#8a5bff');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = 'rgba(255,255,255,0.75)';
  g.fillRect(10, 10, 108, 108);
  g.fillStyle = '#2a2350';
  g.font = 'bold 92px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('?', 64, 70);
  return tex(c, false);
}

export function barrierTex(style, theme) {
  const [c, g] = canvas(128, 64);
  switch (style) {
    case 'tires': {
      g.fillStyle = '#1a1a1e';
      g.fillRect(0, 0, 128, 64);
      for (let row = 0; row < 2; row++)
        for (let i = 0; i < 4; i++) {
          const x = 16 + i * 32 + (row ? 16 : 0),
            y = 16 + row * 32;
          g.fillStyle = (i + row) % 2 ? '#e23b2e' : '#f2f2f2';
          g.beginPath();
          g.arc(x % 128, y, 15, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#111';
          g.beginPath();
          g.arc(x % 128, y, 6, 0, Math.PI * 2);
          g.fill();
        }
      break;
    }
    case 'wood': {
      for (let i = 0; i < 4; i++) {
        g.fillStyle = i % 2 ? '#8a5a2e' : '#9c6a36';
        g.fillRect(0, i * 16, 128, 16);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(0, i * 16 + 14, 128, 2);
      }
      g.fillStyle = '#5a3a1c';
      g.fillRect(0, 0, 8, 64);
      g.fillRect(64, 0, 8, 64);
      break;
    }
    case 'snow': {
      const gr = g.createLinearGradient(0, 0, 0, 64);
      gr.addColorStop(0, '#ffffff');
      gr.addColorStop(1, '#c7d9ee');
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 64);
      g.fillStyle = '#2d7de0';
      g.fillRect(0, 40, 128, 8);
      break;
    }
    case 'stone': {
      g.fillStyle = '#2b2422';
      g.fillRect(0, 0, 128, 64);
      const r = rnd(9);
      for (let i = 0; i < 18; i++) {
        g.fillStyle = shade('#4a3e3a', 0.7 + r() * 0.6);
        g.fillRect(((i % 6) * 22 + (Math.floor(i / 6) % 2) * 11) % 128, Math.floor(i / 6) * 22, 20, 19);
      }
      g.fillStyle = '#ff6a1a';
      g.fillRect(0, 0, 128, 4);
      break;
    }
    case 'neon': {
      g.fillStyle = '#101225';
      g.fillRect(0, 0, 128, 64);
      g.fillStyle = '#1fe3ff';
      g.fillRect(0, 6, 128, 6);
      g.fillStyle = '#ff2fa0';
      g.fillRect(0, 50, 128, 4);
      break;
    }
    case 'rope': {
      g.fillStyle = '#f7f1e0';
      g.fillRect(0, 0, 128, 64);
      g.fillStyle = '#ff8a1f';
      for (let i = 0; i < 128; i += 32) g.fillRect(i, 0, 16, 64);
      break;
    }
    default: {
      g.fillStyle = '#1a1036';
      g.fillRect(0, 0, 128, 64);
      g.fillStyle = '#ffd23f';
      g.fillRect(0, 0, 128, 10);
      g.fillStyle = '#ff4fd8';
      g.fillRect(0, 54, 128, 10);
    }
  }
  return tex(c);
}

export function banner(text, bg = '#1b1b24', fg = '#ffd23f') {
  const [c, g] = canvas(1024, 128);
  g.fillStyle = bg;
  g.fillRect(0, 0, 1024, 128);
  for (let i = 0; i < 16; i++) {
    g.fillStyle = i % 2 ? '#111' : '#eee';
    g.fillRect(i * 64, 0, 64, 14);
    g.fillStyle = i % 2 ? '#eee' : '#111';
    g.fillRect(i * 64, 114, 64, 14);
  }
  g.fillStyle = fg;
  g.font = 'italic 900 76px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 512, 66);
  return tex(c, false);
}

export function windows(seed, lit) {
  const [c, g] = canvas(128, 256);
  g.fillStyle = lit ? '#14152a' : '#8a8f9c';
  g.fillRect(0, 0, 128, 256);
  const r = rnd(seed);
  for (let y = 8; y < 256; y += 20)
    for (let x = 8; x < 128; x += 20) {
      const on = r();
      g.fillStyle = lit ? (on < 0.45 ? '#ffd98a' : on < 0.55 ? '#8ae6ff' : '#22243a') : on < 0.5 ? '#c9e4f2' : '#5d6b7a';
      g.fillRect(x, y, 12, 13);
    }
  return tex(c);
}

export function blob(inner = 'rgba(0,0,0,0.55)') {
  const [c, g] = canvas(64, 64);
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, inner);
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return tex(c, false, false);
}

export function softDot() {
  const [c, g] = canvas(64, 64);
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.7)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return tex(c, false, false);
}

export function oilTex() {
  const [c, g] = canvas(128, 128);
  const r = rnd(4);
  g.fillStyle = 'rgba(0,0,0,0)';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 9; i++) {
    const x = 64 + (r() - 0.5) * 50,
      y = 64 + (r() - 0.5) * 50,
      rad = 18 + r() * 26;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, 'rgba(12,10,18,0.95)');
    gr.addColorStop(0.8, 'rgba(20,16,30,0.9)');
    gr.addColorStop(1, 'rgba(20,16,30,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = 'rgba(140,90,255,0.35)';
  g.lineWidth = 3;
  g.beginPath();
  g.arc(58, 60, 22, 0.3, 2.2);
  g.stroke();
  return tex(c, false);
}

export function nameTag(text, color) {
  const [c, g] = canvas(256, 64);
  g.font = 'bold 34px Arial, sans-serif';
  const w = Math.min(250, g.measureText(text).width + 28);
  g.fillStyle = 'rgba(10,10,20,0.6)';
  g.beginPath();
  g.roundRect((256 - w) / 2, 8, w, 48, 14);
  g.fill();
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 33);
  return tex(c, false);
}
