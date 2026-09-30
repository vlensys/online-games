// Fully synthesized audio (no sound files): sfx + a small synthwave sequencer.
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.sfxVol = 0.8;
    this.musicVol = 0.5;
    this.muted = false;
    this.musicOn = false;
    this.intensity = 0;
    this._step = 0;
    this._nextTime = 0;
    this._timer = null;
  }

  // Must be called from a user gesture (browsers block autoplay).
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch {
      return;
    }
    const c = this.ctx;
    this.master = c.createGain();
    this.master.connect(c.destination);
    this.sfx = c.createGain();
    this.sfx.connect(this.master);
    this.music = c.createGain();
    this.music.connect(this.master);
    this._applyVolumes();

    // shared white noise buffer
    const len = c.sampleRate * 2;
    this.noise = c.createBuffer(1, len, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // rolling rumble: looped noise through a lowpass, gain driven by speed
    this.roll = c.createBufferSource();
    this.roll.buffer = this.noise;
    this.roll.loop = true;
    this.rollFilter = c.createBiquadFilter();
    this.rollFilter.type = 'lowpass';
    this.rollFilter.frequency.value = 300;
    this.rollGain = c.createGain();
    this.rollGain.gain.value = 0;
    this.roll.connect(this.rollFilter).connect(this.rollGain).connect(this.sfx);
    this.roll.start();

    // wind (air) layer
    this.wind = c.createBufferSource();
    this.wind.buffer = this.noise;
    this.wind.loop = true;
    this.windFilter = c.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 800;
    this.windFilter.Q.value = 0.6;
    this.windGain = c.createGain();
    this.windGain.gain.value = 0;
    this.wind.connect(this.windFilter).connect(this.windGain).connect(this.sfx);
    this.wind.start();

    // music bus with a feedback delay for the arp
    this.delay = c.createDelay(1);
    this.delay.delayTime.value = 0.36;
    this.delayFb = c.createGain();
    this.delayFb.gain.value = 0.32;
    this.delayWet = c.createGain();
    this.delayWet.gain.value = 0.35;
    this.delay.connect(this.delayFb).connect(this.delay);
    this.delay.connect(this.delayWet).connect(this.music);
  }

  setVolumes(sfx, music) {
    this.sfxVol = sfx;
    this.musicVol = music;
    this._applyVolumes();
  }

  toggleMute() {
    this.muted = !this.muted;
    this._applyVolumes();
    return this.muted;
  }

  _applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 1, t, 0.02);
    this.sfx.gain.setTargetAtTime(this.sfxVol * 0.9, t, 0.02);
    this.music.gain.setTargetAtTime(this.musicVol * 0.55, t, 0.05);
  }

  // Continuous ball sounds. speed in units/s.
  setMotion(grounded, speed, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.min(speed / 60, 1.4);
    this.rollGain.gain.setTargetAtTime(active && grounded ? 0.05 + s * 0.12 : 0, t, 0.05);
    this.rollFilter.frequency.setTargetAtTime(160 + s * 520, t, 0.1);
    this.windGain.gain.setTargetAtTime(active ? 0.015 + s * s * 0.05 : 0, t, 0.2);
    this.windFilter.frequency.setTargetAtTime(500 + s * 1400, t, 0.2);
  }

  _env(gainNode, t, attack, peak, decay) {
    const g = gainNode.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  _tone(type, f0, f1, dur, vol, dest = this.sfx, when = 0) {
    const c = this.ctx;
    const t = c.currentTime + when;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = c.createGain();
    this._env(g, t, 0.005, vol, dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  _noise(dur, vol, type, f0, f1, q = 1, when = 0) {
    const c = this.ctx;
    const t = c.currentTime + when;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = c.createGain();
    this._env(g, t, 0.01, vol, dur);
    s.connect(f).connect(g).connect(this.sfx);
    s.start(t, Math.random());
    s.stop(t + dur + 0.05);
  }

  play(name, amount = 1) {
    if (!this.ctx || this.muted) return;
    switch (name) {
      case 'jump':
        this._tone('sine', 260, 720, 0.16, 0.35);
        this._tone('triangle', 520, 1100, 0.1, 0.12);
        break;
      case 'dash':
        this._noise(0.28, 0.5, 'bandpass', 600, 3800, 1.2);
        this._tone('sawtooth', 180, 90, 0.2, 0.12);
        break;
      case 'land': {
        const v = Math.min(amount, 1);
        this._tone('sine', 140, 45, 0.14, 0.25 + v * 0.35);
        this._noise(0.08, 0.1 + v * 0.2, 'lowpass', 900, 200, 0.7);
        break;
      }
      case 'bump':
        this._tone('sine', 110, 70, 0.08, 0.2);
        break;
      case 'gem': {
        const base = 880 * Math.pow(2, (amount % 5) / 12);
        this._tone('triangle', base, base, 0.12, 0.25);
        this._tone('sine', base * 1.5, base * 1.5, 0.18, 0.18, this.sfx, 0.06);
        break;
      }
      case 'shield':
        this._tone('sine', 400, 900, 0.3, 0.3);
        this._tone('triangle', 600, 1300, 0.35, 0.15, this.sfx, 0.05);
        break;
      case 'shieldBreak':
        this._noise(0.4, 0.5, 'highpass', 2000, 500, 0.8);
        this._tone('square', 700, 200, 0.3, 0.12);
        break;
      case 'crash':
        this._noise(0.9, 0.8, 'lowpass', 3000, 80, 0.8);
        this._tone('sawtooth', 220, 30, 0.8, 0.35);
        this._tone('sine', 90, 25, 0.9, 0.5);
        break;
      case 'fall':
        this._tone('sine', 600, 80, 1.1, 0.25);
        break;
      case 'level':
        [0, 4, 7, 12].forEach((n, i) => this._tone('square', 440 * Math.pow(2, n / 12), 440 * Math.pow(2, n / 12), 0.12, 0.12, this.sfx, i * 0.07));
        break;
      case 'click':
        this._tone('square', 900, 700, 0.04, 0.08);
        break;
      case 'go':
        this._tone('square', 660, 660, 0.12, 0.15);
        this._tone('square', 990, 990, 0.25, 0.15, this.sfx, 0.12);
        break;
      case 'buy':
        [0, 7, 12, 16].forEach((n, i) => this._tone('triangle', 523 * Math.pow(2, n / 12), 523 * Math.pow(2, n / 12), 0.15, 0.18, this.sfx, i * 0.06));
        break;
      case 'deny':
        this._tone('square', 200, 150, 0.18, 0.12);
        break;
    }
  }

  // ---------- music ----------
  startMusic() {
    if (!this.ctx || this.musicOn) return;
    this.musicOn = true;
    this._step = 0;
    this._nextTime = this.ctx.currentTime + 0.08;
    this._timer = setInterval(() => this._schedule(), 25);
  }

  stopMusic() {
    this.musicOn = false;
    clearInterval(this._timer);
    this._timer = null;
  }

  _schedule() {
    const c = this.ctx;
    if (!c) return;
    const bpm = 124;
    const stepDur = 60 / bpm / 4; // 16th notes
    while (this._nextTime < c.currentTime + 0.12) {
      this._playStep(this._step, this._nextTime, stepDur);
      this._step = (this._step + 1) % 256;
      this._nextTime += stepDur;
    }
  }

  _playStep(step, t, sd) {
    const c = this.ctx;
    const bar = Math.floor(step / 16) % 4;
    const s = step % 16;
    // A minor: Am, F, C, G
    const roots = [45, 41, 48, 43];
    const chords = [
      [57, 60, 64, 69],
      [53, 57, 60, 65],
      [55, 60, 64, 67],
      [55, 59, 62, 67],
    ];
    const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
    const lvl = this.intensity;

    // kick on quarters
    if (s % 4 === 0) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      o.connect(g).connect(this.music);
      o.start(t);
      o.stop(t + 0.3);
    }
    // snare-ish clap on 2 & 4
    if (s === 4 || s === 12) {
      const n = c.createBufferSource();
      n.buffer = this.noise;
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1800;
      const g = c.createGain();
      g.gain.setValueAtTime(0.35, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      n.connect(f).connect(g).connect(this.music);
      n.start(t, Math.random());
      n.stop(t + 0.2);
    }
    // hats on offbeats
    if (s % 2 === 1 || (lvl > 1 && s % 1 === 0)) {
      const n = c.createBufferSource();
      n.buffer = this.noise;
      const f = c.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 7000;
      const g = c.createGain();
      const v = s % 4 === 2 ? 0.14 : 0.07;
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      n.connect(f).connect(g).connect(this.music);
      n.start(t, Math.random());
      n.stop(t + 0.06);
    }
    // bass: driving 8ths with octave bounce
    if (s % 2 === 0) {
      const note = roots[bar] + (s % 4 === 2 ? 12 : 0);
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midi(note);
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(900, t);
      f.frequency.exponentialRampToValueAtTime(180, t + sd * 1.8);
      const g = c.createGain();
      g.gain.setValueAtTime(0.22, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + sd * 1.9);
      o.connect(f).connect(g).connect(this.music);
      o.start(t);
      o.stop(t + sd * 2);
    }
    // arp lead (joins after the first level)
    if (lvl >= 1) {
      const ch = chords[bar];
      const pattern = [0, 1, 2, 3, 2, 1, 0, 2];
      const note = ch[pattern[s % 8]] + 12;
      const o = c.createOscillator();
      o.type = 'square';
      o.frequency.value = midi(note);
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 2400;
      const g = c.createGain();
      g.gain.setValueAtTime(0.045, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + sd * 0.9);
      o.connect(f).connect(g);
      g.connect(this.music);
      g.connect(this.delay);
      o.start(t);
      o.stop(t + sd);
    }
    // pad swell on bar start
    if (s === 0) {
      for (const n of chords[bar].slice(0, 3)) {
        const o = c.createOscillator();
        o.type = 'triangle';
        o.frequency.value = midi(n);
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.04, t + 0.4);
        g.gain.exponentialRampToValueAtTime(0.0001, t + sd * 16);
        o.connect(g).connect(this.music);
        o.start(t);
        o.stop(t + sd * 16 + 0.05);
      }
    }
  }
}
