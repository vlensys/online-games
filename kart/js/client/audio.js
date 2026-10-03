// All sound is synthesised with Web Audio: the engine (pitch follows speed), tyre squeal while
// drifting, effects, and a little music sequencer that plays a loop in each theme's key and tempo.
const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.music = 0.5;
    this.sfx = 0.8;
    this.seq = null;
  }
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.musBus = ctx.createGain();
    this.musBus.connect(this.master);
    this.setVolumes(this.music, this.sfx);
    // noise buffer shared by everything
    const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = nb;
    // engine
    const e = (this.eng = {});
    e.a = ctx.createOscillator();
    e.a.type = 'sawtooth';
    e.b = ctx.createOscillator();
    e.b.type = 'square';
    e.f = ctx.createBiquadFilter();
    e.f.type = 'lowpass';
    e.f.frequency.value = 500;
    e.g = ctx.createGain();
    e.g.gain.value = 0;
    e.a.connect(e.f);
    e.b.connect(e.f);
    e.f.connect(e.g);
    e.g.connect(this.sfxBus);
    e.a.start();
    e.b.start();
    // tyre squeal
    e.n = this.noise(true);
    e.nf = ctx.createBiquadFilter();
    e.nf.type = 'bandpass';
    e.nf.Q.value = 6;
    e.nf.frequency.value = 1800;
    e.ng = ctx.createGain();
    e.ng.gain.value = 0;
    e.n.connect(e.nf);
    e.nf.connect(e.ng);
    e.ng.connect(this.sfxBus);
    // boost roar
    e.bn = this.noise(true);
    e.bf = ctx.createBiquadFilter();
    e.bf.type = 'lowpass';
    e.bf.frequency.value = 900;
    e.bg = ctx.createGain();
    e.bg.gain.value = 0;
    e.bn.connect(e.bf);
    e.bf.connect(e.bg);
    e.bg.connect(this.sfxBus);
  }
  setVolumes(music, sfx) {
    this.music = music;
    this.sfx = sfx;
    if (!this.ctx) return;
    this.musBus.gain.value = music * 0.32;
    this.sfxBus.gain.value = sfx * 0.9;
  }
  noise(loop = false) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = loop;
    if (loop) s.start();
    return s;
  }
  // called every frame with the player's kart (or null to silence)
  engine(k, top) {
    if (!this.ctx) return;
    const e = this.eng,
      t = this.ctx.currentTime;
    if (!k) {
      e.g.gain.setTargetAtTime(0, t, 0.05);
      e.ng.gain.setTargetAtTime(0, t, 0.05);
      e.bg.gain.setTargetAtTime(0, t, 0.05);
      return;
    }
    const sp = Math.min(1.3, Math.abs(k.vf) / top);
    const f = 48 + sp * 120 + (k.boostT > 0 ? 25 : 0) + (k.grounded ? 0 : 25);
    e.a.frequency.setTargetAtTime(f, t, 0.05);
    e.b.frequency.setTargetAtTime(f * 0.5 * 1.01, t, 0.05);
    e.f.frequency.setTargetAtTime(350 + sp * 1500, t, 0.05);
    e.g.gain.setTargetAtTime(0.035 + sp * 0.05 + (k.in.gas ? 0.02 : 0), t, 0.06);
    e.ng.gain.setTargetAtTime(k.drift && k.grounded ? 0.05 + k.driftLevel * 0.012 : k.offroad && sp > 0.3 ? 0.02 : 0, t, 0.04);
    e.nf.frequency.setTargetAtTime(k.drift ? 1500 + k.driftLevel * 500 : 500, t, 0.05);
    e.bg.gain.setTargetAtTime(k.boostT > 0 ? 0.09 : 0, t, 0.05);
  }

  // ---------------------------------------------------------------- effects
  tone(freq, dur, type = 'square', vol = 0.2, to = null, when = 0) {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.sfxBus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  hiss(dur, vol, type, f0, f1 = null, when = 0) {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const s = this.noise();
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(this.sfxBus);
    s.start(t);
    s.stop(t + dur + 0.05);
  }
  play(name, a = 0, vol = 1) {
    if (!this.ctx || this.sfx <= 0) return;
    const v = vol;
    switch (name) {
      case 'count':
        this.tone(440, 0.22, 'square', 0.18 * v);
        break;
      case 'go':
        this.tone(880, 0.6, 'square', 0.2 * v);
        break;
      case 'box':
        [660, 880, 1320].forEach((f, i) => this.tone(f, 0.12, 'triangle', 0.16 * v, null, i * 0.05));
        break;
      case 'tick':
        this.tone(1300 + Math.random() * 300, 0.03, 'square', 0.05 * v);
        break;
      case 'item':
        [988, 1319].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.18 * v, null, i * 0.07));
        break;
      case 'nitro':
      case 'pad':
        this.hiss(name === 'pad' ? 0.45 : 0.8, 0.25 * v, 'bandpass', 400, 3500);
        this.tone(90, 0.3, 'sine', 0.25 * v, 50);
        break;
      case 'start':
        this.hiss(0.9, 0.3 * v, 'bandpass', 300, 4000);
        break;
      case 'fire':
        this.hiss(0.3, 0.25 * v, 'highpass', 1500, 300);
        this.tone(900, 0.25, 'square', 0.1 * v, 200);
        break;
      case 'boom':
        this.hiss(0.7, 0.5 * v, 'lowpass', 1200, 60);
        this.tone(110, 0.4, 'sine', 0.4 * v, 35);
        break;
      case 'hit':
        this.tone(700, 0.6, 'square', 0.14 * v, 110);
        break;
      case 'bonk':
        this.tone(130, 0.14, 'sine', 0.3 * v, 60);
        this.hiss(0.08, 0.15 * v, 'lowpass', 800);
        break;
      case 'mini':
        this.tone(300 + a * 150, 0.35, 'triangle', 0.2 * v, 900 + a * 350);
        this.hiss(0.4, 0.15 * v, 'bandpass', 600, 3000);
        break;
      case 'charge':
        this.tone(600 + a * 250, 0.08, 'triangle', 0.08 * v);
        break;
      case 'lap':
        [784, 988, 1175].forEach((f, i) => this.tone(f, 0.2, 'square', 0.12 * v, null, i * 0.09));
        break;
      case 'final':
        [659, 784, 988, 1319].forEach((f, i) => this.tone(f, 0.24, 'square', 0.13 * v, null, i * 0.1));
        break;
      case 'finish':
        [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(f, i === 5 ? 0.7 : 0.18, 'square', 0.14 * v, null, i * 0.12));
        break;
      case 'lose':
        [523, 466, 415, 392].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.13 * v, null, i * 0.18));
        break;
      case 'shield':
        this.tone(1200, 0.5, 'sine', 0.12 * v, 1800);
        this.tone(1500, 0.5, 'sine', 0.08 * v, 900, 0.05);
        break;
      case 'shieldpop':
        this.hiss(0.3, 0.25 * v, 'highpass', 3000);
        break;
      case 'oil':
        this.hiss(0.3, 0.3 * v, 'lowpass', 500, 120);
        break;
      case 'emp':
        this.tone(150, 0.6, 'square', 0.15 * v, 2200);
        this.hiss(0.6, 0.2 * v, 'bandpass', 3000, 300);
        break;
      case 'land':
        this.tone(100, 0.1, 'sine', 0.25 * v, 50);
        break;
      case 'hop':
        this.tone(320, 0.06, 'sine', 0.08 * v, 520);
        break;
      case 'trick':
        this.tone(600, 0.2, 'triangle', 0.15 * v, 1500);
        break;
      case 'ui':
        this.tone(900, 0.05, 'square', 0.06 * v);
        break;
      case 'wrong':
        this.tone(160, 0.25, 'sawtooth', 0.08 * v);
        break;
    }
  }

  // ---------------------------------------------------------------- music
  startMusic(m, seed = 1) {
    this.stopMusic();
    if (!this.ctx || !m) return;
    const minor = m.mode === 'minor';
    const scale = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    const prog = minor ? [0, 5, 2, 6] : [0, 4, 5, 3]; // scale degrees of each bar's chord
    const root = 45 + m.key;
    let r = seed * 9301 + 49297;
    const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
    // a 4-bar melody, 8th notes, mostly chord tones
    const mel = [];
    for (let bar = 0; bar < 4; bar++)
      for (let s = 0; s < 8; s++) {
        const rest = rnd() < 0.22;
        const deg = prog[bar] + [0, 2, 4, 7][Math.floor(rnd() * 4)] + (rnd() < 0.3 ? 1 : 0);
        mel.push(rest ? null : deg);
      }
    const deg2note = (deg, oct) => root + oct * 12 + scale[((deg % 7) + 7) % 7] + 12 * Math.floor(deg / 7);
    const seq = (this.seq = { step: 0, next: this.ctx.currentTime + 0.1, bpm: m.bpm, fast: 1, timer: null });
    const ctx = this.ctx;
    const voice = (freq, t, dur, type, vol) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(this.musBus);
      o.start(t);
      o.stop(t + dur + 0.05);
    };
    const drum = (t, kind) => {
      if (kind === 'k') {
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(140, t);
        o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.7, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        o.connect(g);
        g.connect(this.musBus);
        o.start(t);
        o.stop(t + 0.2);
      } else {
        const s = this.noise();
        const f = ctx.createBiquadFilter();
        f.type = kind === 'h' ? 'highpass' : 'bandpass';
        f.frequency.value = kind === 'h' ? 7000 : 1800;
        const g = ctx.createGain();
        const dur = kind === 'h' ? 0.04 : 0.14;
        g.gain.setValueAtTime(kind === 'h' ? 0.12 : 0.35, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        s.connect(f);
        f.connect(g);
        g.connect(this.musBus);
        s.start(t);
        s.stop(t + dur + 0.02);
      }
    };
    const tick = () => {
      const spb = 60 / (seq.bpm * seq.fast) / 4; // seconds per 16th
      while (seq.next < ctx.currentTime + 0.15) {
        const st = seq.step % 64,
          bar = Math.floor(st / 16),
          s16 = st % 16;
        const t = seq.next;
        if (s16 % 4 === 0) drum(t, 'k');
        if (s16 === 4 || s16 === 12) drum(t, 's');
        if (s16 % 2 === 0) drum(t, 'h');
        const chord = prog[bar];
        if (s16 % 2 === 0) voice(NOTE(deg2note(chord, 0) - 12 + (s16 % 8 === 6 ? 12 : 0)), t, spb * 1.8, 'triangle', 0.3);
        if (s16 % 2 === 1) voice(NOTE(deg2note(chord + [0, 2, 4, 2][(s16 >> 1) % 4], 1)), t, spb * 1.2, 'square', 0.035);
        if (s16 % 2 === 0) {
          const n = mel[bar * 8 + s16 / 2];
          if (n !== null) voice(NOTE(deg2note(n, 2)), t, spb * 1.9, m.lead, 0.07);
        }
        seq.step++;
        seq.next += spb;
      }
    };
    seq.timer = setInterval(tick, 30);
    tick();
  }
  musicFast(on) {
    if (this.seq) this.seq.fast = on ? 1.12 : 1;
  }
  stopMusic() {
    if (this.seq) clearInterval(this.seq.timer);
    this.seq = null;
  }
}
