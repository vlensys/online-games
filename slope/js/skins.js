import * as THREE from 'three';

// Ball skins are drawn procedurally onto an equirectangular canvas (no image files needed).
export const SKINS = [
  { id: 'classic', name: 'Classic', price: 0 },
  { id: 'checker', name: 'Checker', price: 40 },
  { id: 'beach', name: 'Beach Ball', price: 80 },
  { id: 'eight', name: 'Eight Ball', price: 120 },
  { id: 'earth', name: 'Planet', price: 180 },
  { id: 'magma', name: 'Magma', price: 250 },
  { id: 'melon', name: 'Melon', price: 320 },
  { id: 'galaxy', name: 'Galaxy', price: 420 },
  { id: 'disco', name: 'Disco', price: 550 },
  { id: 'gold', name: 'Solid Gold', price: 800 },
];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function draw(id, ctx, W, H) {
  const r = rng(id.length * 977 + id.charCodeAt(0));
  switch (id) {
    case 'classic': {
      // black ball with bands (used as a glow mask tinted with the section colour)
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 9;
      const line = (x0, y0, x1, y1) => {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      };
      line(0, H / 2, W, H / 2);
      line(0, H * 0.14, W, H * 0.14);
      line(0, H * 0.86, W, H * 0.86);
      for (const x of [0, W / 2]) line(x, 0, x, H);
      for (const x of [W / 4, (W * 3) / 4]) line(x, H * 0.14, x, H * 0.86);
      break;
    }
    case 'checker': {
      const n = 8;
      for (let y = 0; y < n / 2; y++)
        for (let x = 0; x < n; x++) {
          ctx.fillStyle = (x + y) % 2 ? '#111' : '#f5f5f5';
          ctx.fillRect((x * W) / n, (y * H) / (n / 2), W / n + 1, H / (n / 2) + 1);
        }
      break;
    }
    case 'beach': {
      const cols = ['#ff3b3b', '#ffffff', '#ffd400', '#ffffff', '#2f7bff', '#ffffff'];
      cols.forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.fillRect((i * W) / cols.length, 0, W / cols.length + 1, H);
      });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H * 0.08);
      ctx.fillRect(0, H * 0.92, W, H * 0.08);
      break;
    }
    case 'eight': {
      ctx.fillStyle = '#0b0b0e';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(W * 0.25, H * 0.5, W * 0.07, H * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.font = `bold ${H * 0.2}px Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('8', W * 0.25, H * 0.51);
      break;
    }
    case 'earth': {
      ctx.fillStyle = '#1560bd';
      ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < 60; i++) {
        ctx.fillStyle = r() < 0.7 ? '#3aa845' : '#c2a35a';
        ctx.beginPath();
        const x = r() * W,
          y = H * 0.15 + r() * H * 0.7;
        ctx.ellipse(x, y, 20 + r() * 50, 12 + r() * 30, r() * 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#f0f6ff';
      ctx.fillRect(0, 0, W, H * 0.08);
      ctx.fillRect(0, H * 0.92, W, H * 0.08);
      break;
    }
    case 'magma': {
      ctx.fillStyle = '#1a0a05';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#ff6a00';
      for (let i = 0; i < 40; i++) {
        ctx.lineWidth = 2 + r() * 5;
        ctx.beginPath();
        let x = r() * W,
          y = r() * H;
        ctx.moveTo(x, y);
        for (let k = 0; k < 6; k++) {
          x += (r() - 0.5) * 80;
          y += (r() - 0.5) * 60;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }
    case 'melon': {
      ctx.fillStyle = '#2e8b3a';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#123d18';
      for (let i = 0; i < 12; i++) {
        ctx.beginPath();
        const x0 = (i * W) / 12;
        ctx.moveTo(x0, 0);
        for (let y = 0; y <= H; y += 16) ctx.lineTo(x0 + Math.sin(y * 0.08 + i) * 8 + 10, y);
        for (let y = H; y >= 0; y -= 16) ctx.lineTo(x0 + Math.sin(y * 0.08 + i) * 8 + 26, y);
        ctx.fill();
      }
      break;
    }
    case 'galaxy': {
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#12002b');
      g.addColorStop(0.5, '#3a0a6b');
      g.addColorStop(1, '#070224');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < 12; i++) {
        const rg = ctx.createRadialGradient(r() * W, r() * H, 0, r() * W, r() * H, 60 + r() * 80);
        rg.addColorStop(0, `hsla(${260 + r() * 80},100%,60%,0.35)`);
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = rg;
        ctx.fillRect(0, 0, W, H);
      }
      for (let i = 0; i < 400; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.4 + r() * 0.6})`;
        const s = r() < 0.9 ? 1.5 : 3;
        ctx.fillRect(r() * W, r() * H, s, s);
      }
      break;
    }
    case 'disco': {
      const n = 32;
      for (let y = 0; y < n / 2; y++)
        for (let x = 0; x < n; x++) {
          const v = 150 + Math.floor(r() * 105);
          ctx.fillStyle = `rgb(${v},${v},${v + 10})`;
          ctx.fillRect((x * W) / n + 1, (y * H) / (n / 2) + 1, W / n - 2, H / (n / 2) - 2);
        }
      break;
    }
    case 'gold': {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#fff1a8');
      g.addColorStop(0.5, '#e0a81e');
      g.addColorStop(1, '#8a5a00');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      break;
    }
  }
}

const cache = new Map();

export function skinTexture(id) {
  if (cache.has(id)) return cache.get(id);
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d');
  draw(id, ctx, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(id, tex);
  return tex;
}

export function skinMaterialParams(id) {
  switch (id) {
    case 'gold':
      return { metalness: 1, roughness: 0.18, emissiveIntensity: 0.12 };
    case 'disco':
      return { metalness: 1, roughness: 0.08, emissiveIntensity: 0.1 };
    case 'magma':
      return { metalness: 0.1, roughness: 0.6, emissiveIntensity: 0.7 };
    case 'galaxy':
      return { metalness: 0.2, roughness: 0.3, emissiveIntensity: 0.35 };
    case 'classic':
      return { metalness: 0.2, roughness: 0.45, emissiveIntensity: 1 };
    default:
      return { metalness: 0.15, roughness: 0.35, emissiveIntensity: 0.08 };
  }
}

// Small preview canvas for the skins menu
export function skinPreview(id, size = 96) {
  const src = skinTexture(id).image;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(src, 0, 0, src.width / 2, src.height, 0, 0, size, size);
  const g = ctx.createRadialGradient(size * 0.35, size * 0.3, 2, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.5, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();
  return c;
}
