// Procedural sound effects with WebAudio (no audio files). Positional via gain + stereo pan.
const GUNS = {
  pistol: { f: 1900, q: 0.9, dec: 0.13, th: [190, 60, 0.06], g: 0.65 },
  smg: { f: 2500, q: 0.9, dec: 0.075, th: [210, 80, 0.045], g: 0.5 },
  ar: { f: 1450, q: 0.8, dec: 0.15, th: [150, 45, 0.09], g: 0.75 },
  shotgun: { f: 1600, q: 0.5, dec: 0.36, th: [115, 35, 0.16], g: 0.95, lp: true },
  sniper: { f: 1150, q: 0.6, dec: 0.55, th: [95, 30, 0.22], g: 1.0, echo: true },
  rocket: { f: 700, q: 0.5, dec: 0.55, th: [80, 40, 0.2], g: 0.7, lp: true },
};

export class Sfx {
  constructor() {
    this.ctx = null;
    this.vol = 0.8;
    this.lx = 0;
    this.ly = 0;
    this.lz = 0;
    this.lyaw = 0;
    this.active = 0;
    this.loops = {};
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch (e) {
      return;
    }
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = this.vol;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master.connect(comp);
    comp.connect(c.destination);
    const len = c.sampleRate;
    this.noise = c.createBuffer(1, len, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // simple echo send for big shots / explosions
    this.echo = c.createDelay(1);
    this.echo.delayTime.value = 0.23;
    const fb = c.createGain();
    fb.gain.value = 0.28;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    this.echo.connect(lp);
    lp.connect(fb);
    fb.connect(this.echo);
    this.echoOut = c.createGain();
    this.echoOut.gain.value = 0.5;
    lp.connect(this.echoOut);
    this.echoOut.connect(this.master);
  }

  setVolume(v) {
    this.vol = v;
    if (this.master) this.master.gain.value = v;
  }

  setListener(x, y, z, yaw) {
    this.lx = x;
    this.ly = y;
    this.lz = z;
    this.lyaw = yaw;
  }

  // gain/pan/lowpass for a world position (null pos = non-positional)
  place(x, y, z, range = 60) {
    if (x === undefined || x === null) return { g: 1, pan: 0, lp: 20000, d: 0 };
    const dx = x - this.lx;
    const dy = y - this.ly;
    const dz = z - this.lz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const g = 1 / (1 + (d / range) * (d / range) * 3);
    // right vector of the listener
    const rx = Math.cos(this.lyaw);
    const rz = -Math.sin(this.lyaw);
    const pan = d > 0.5 ? Math.max(-1, Math.min(1, (dx * rx + dz * rz) / d)) * 0.8 : 0;
    const lp = 18000 / (1 + d / 25);
    return { g, pan, lp: Math.max(500, lp), d };
  }

  out(p, extraLp) {
    const c = this.ctx;
    let node = c.createGain();
    node.gain.value = p.g;
    const first = node;
    if (p.lp < 17000 || extraLp) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = Math.min(p.lp, extraLp || 20000);
      node.connect(f);
      node = f;
    }
    if (c.createStereoPanner && p.pan) {
      const s = c.createStereoPanner();
      s.pan.value = p.pan;
      node.connect(s);
      node = s;
    }
    node.connect(this.master);
    return first;
  }

  can(p) {
    return this.ctx && this.ctx.state === 'running' && p.g > 0.01 && this.active < 28;
  }

  track(node, dur) {
    this.active++;
    setTimeout(() => this.active--, dur * 1000 + 60);
    void node;
  }

  noiseHit(dest, t, dur, type, f, q, gain) {
    const c = this.ctx;
    gain = Math.max(0.001, gain);
    f = Math.max(30, f);
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filt = c.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = f;
    filt.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
    return g;
  }

  tone(dest, t, type, f0, f1, dur, gain) {
    const c = this.ctx;
    gain = Math.max(0.001, gain);
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  shot(type, x, y, z) {
    const G = GUNS[type];
    if (!G) return;
    const p = this.place(x, y, z, 70);
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    const far = Math.min(1, p.d / 120);
    this.noiseHit(out, t, G.dec * (1 + far * 0.6), G.lp ? 'lowpass' : 'bandpass', G.f * (1 - far * 0.5), G.q, G.g * 0.9);
    this.noiseHit(out, t, 0.03, 'highpass', 3000, 0.7, G.g * 0.4 * (1 - far));
    this.tone(out, t, 'triangle', G.th[0], G.th[1], G.th[2], G.g * 0.9);
    if ((G.echo || p.d > 40) && this.echo) out.connect(this.echo);
    this.track(out, G.dec + 0.3);
  }

  swing() {
    const p = { g: 0.5, pan: 0, lp: 20000 };
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    this.noiseHit(out, t, 0.12, 'bandpass', 900, 1.2, 0.35);
    this.track(out, 0.15);
  }

  impact(mat, x, y, z, loud = 1) {
    const p = this.place(x, y, z, 30);
    p.g *= loud;
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    if (mat === 0) {
      this.tone(out, t, 'sine', 330, 170, 0.08, 0.7);
      this.noiseHit(out, t, 0.06, 'bandpass', 900, 1.5, 0.4);
    } else if (mat === 1) {
      this.tone(out, t, 'triangle', 620, 380, 0.06, 0.45);
      this.noiseHit(out, t, 0.07, 'bandpass', 2600, 1.2, 0.45);
    } else if (mat === 2) {
      for (const f of [820, 1290, 1760]) this.tone(out, t, 'sine', f, f * 0.98, 0.3, 0.18);
      this.noiseHit(out, t, 0.03, 'highpass', 4000, 1, 0.25);
    } else {
      this.noiseHit(out, t, 0.05, 'lowpass', 1200, 0.8, 0.3);
    }
    this.track(out, 0.35);
  }

  build(mat = 0, x, y, z) {
    const p = this.place(x, y, z, 40);
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    this.tone(out, t, 'sine', mat === 2 ? 240 : 150, mat === 2 ? 180 : 80, 0.12, 0.6);
    this.noiseHit(out, t, 0.09, 'lowpass', mat === 1 ? 900 : 600, 0.8, 0.5);
    if (mat === 2) this.tone(out, t, 'sine', 1300, 1250, 0.18, 0.08);
    this.track(out, 0.2);
  }

  step(surface, x, y, z, loud = 1) {
    const p = x === undefined ? { g: 0.28 * loud, pan: 0, lp: 20000 } : this.place(x, y, z, 18);
    if (x !== undefined) p.g *= 0.5 * loud;
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    const f = surface === 1 ? 700 : surface === 2 ? 1400 : 420;
    this.noiseHit(out, t, 0.06, 'lowpass', f * (0.85 + Math.random() * 0.3), 1, 0.5);
    if (surface === 1) this.tone(out, t, 'sine', 140, 90, 0.05, 0.25);
    this.track(out, 0.08);
  }

  land() {
    const p = { g: 0.6, pan: 0, lp: 20000 };
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    this.tone(out, t, 'sine', 110, 50, 0.16, 0.8);
    this.noiseHit(out, t, 0.12, 'lowpass', 500, 0.8, 0.5);
    this.track(out, 0.2);
  }

  hitmark(head, shield) {
    const p = { g: 0.5, pan: 0, lp: 20000 };
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    if (head) {
      this.tone(out, t, 'sine', 2300, 2300, 0.14, 0.35);
      this.tone(out, t, 'sine', 3500, 3500, 0.1, 0.18);
    } else if (shield) {
      this.noiseHit(out, t, 0.05, 'bandpass', 5200, 2, 0.35);
      this.tone(out, t, 'sine', 1700, 1500, 0.05, 0.2);
    } else this.tone(out, t, 'square', 1500, 1200, 0.035, 0.12);
    this.track(out, 0.15);
  }

  hurt(shield) {
    const p = { g: 0.6, pan: 0, lp: 20000 };
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    if (shield) this.noiseHit(out, t, 0.12, 'bandpass', 3800, 1.5, 0.4);
    this.tone(out, t, 'sine', 160, 60, 0.18, 0.7);
    this.track(out, 0.2);
  }

  shieldBreak() {
    const p = { g: 0.7, pan: 0, lp: 20000 };
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    this.noiseHit(out, t, 0.35, 'highpass', 3000, 0.7, 0.5);
    this.tone(out, t, 'triangle', 1800, 500, 0.3, 0.3);
    this.track(out, 0.4);
  }

  chest(x, y, z) {
    const p = this.place(x, y, z, 25);
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(out, t + i * 0.055, 'sine', f, f, 0.35, 0.25));
    this.noiseHit(out, t, 0.2, 'lowpass', 700, 0.8, 0.35);
    this.track(out, 0.7);
  }

  pickup() {
    const p = { g: 0.45, pan: 0, lp: 20000 };
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    this.tone(out, t, 'sine', 700, 1200, 0.08, 0.35);
    this.noiseHit(out, t, 0.04, 'bandpass', 2500, 1, 0.2);
    this.track(out, 0.1);
  }

  reload(dur) {
    const p = { g: 0.4, pan: 0, lp: 20000 };
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    this.noiseHit(out, t + 0.05, 0.03, 'bandpass', 2800, 3, 0.5);
    this.noiseHit(out, t + dur * 0.55, 0.04, 'bandpass', 2000, 3, 0.5);
    this.noiseHit(out, t + dur * 0.92, 0.03, 'bandpass', 3400, 3, 0.55);
    this.track(out, dur + 0.1);
  }

  heal(sh) {
    const p = { g: 0.35, pan: 0, lp: 20000 };
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    this.tone(out, t, 'sine', sh ? 600 : 440, sh ? 1200 : 880, 0.3, 0.25);
    this.track(out, 0.35);
  }

  elim() {
    const p = { g: 0.55, pan: 0, lp: 20000 };
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    this.tone(out, t, 'triangle', 660, 660, 0.14, 0.35);
    this.tone(out, t + 0.1, 'triangle', 990, 990, 0.25, 0.35);
    this.track(out, 0.4);
  }

  boom(x, y, z) {
    const p = this.place(x, y, z, 90);
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    this.noiseHit(out, t, 1.0, 'lowpass', 900, 0.6, 1.0);
    this.tone(out, t, 'sine', 80, 25, 0.5, 1.0);
    if (this.echo) out.connect(this.echo);
    this.track(out, 1.1);
  }

  ui() {
    const p = { g: 0.3, pan: 0, lp: 20000 };
    if (!this.can(p)) return;
    const t = this.ctx.currentTime;
    const out = this.out(p);
    this.tone(out, t, 'sine', 900, 700, 0.05, 0.25);
    this.track(out, 0.08);
  }

  // continuous layers: storm rumble, wind, bus engine
  loop(name, level) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    let L = this.loops[name];
    const c = this.ctx;
    if (!L) {
      if (level <= 0.001) return;
      const g = c.createGain();
      g.gain.value = 0;
      g.connect(this.master);
      let src;
      if (name === 'chest') {
        // shimmering chord with a slow tremolo
        const mix = c.createGain();
        mix.gain.value = 0.5;
        const oscs = [];
        for (const f of [880, 1318.5, 1760]) {
          const o = c.createOscillator();
          o.type = 'sine';
          o.frequency.value = f;
          o.connect(mix);
          o.start();
          oscs.push(o);
        }
        const lfo = c.createOscillator();
        lfo.frequency.value = 5.5;
        const lg = c.createGain();
        lg.gain.value = 0.35;
        lfo.connect(lg);
        lg.connect(mix.gain);
        lfo.start();
        mix.connect(g);
        src = { stop: () => oscs.concat([lfo]).forEach((o) => o.stop()), start: () => {} };
      } else if (name === 'bus') {
        src = c.createOscillator();
        src.type = 'sawtooth';
        src.frequency.value = 52;
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 260;
        src.connect(f);
        f.connect(g);
      } else {
        src = c.createBufferSource();
        src.buffer = this.noise;
        src.loop = true;
        const f = c.createBiquadFilter();
        f.type = name === 'storm' ? 'lowpass' : 'bandpass';
        f.frequency.value = name === 'storm' ? 320 : 700;
        f.Q.value = name === 'storm' ? 0.7 : 0.6;
        src.connect(f);
        f.connect(g);
        if (name === 'storm') {
          const o = c.createOscillator();
          o.frequency.value = 48;
          const og = c.createGain();
          og.gain.value = 0.25;
          o.connect(og);
          og.connect(g);
          o.start();
          L = { g, src, o };
        }
      }
      src.start();
      L = L || { g, src };
      this.loops[name] = L;
    }
    L.g.gain.setTargetAtTime(Math.max(0, level), c.currentTime, 0.15);
  }

  stopLoops() {
    for (const k of Object.keys(this.loops)) {
      const L = this.loops[k];
      try {
        L.src.stop();
        if (L.o) L.o.stop();
        L.g.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    this.loops = {};
  }
}
