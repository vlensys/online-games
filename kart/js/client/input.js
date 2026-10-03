// Keyboard, gamepad and touch, merged into one set of driving controls.
//  Keyboard: arrows / WASD drive, Space or Shift hop & drift, E / K / Enter use item,
//            hold S / Down while using an item to throw it backwards, Q / C look behind, Esc pause.
const KEY = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  gas: ['ArrowUp', 'KeyW'],
  brake: ['ArrowDown', 'KeyS'],
  drift: ['Space', 'ShiftLeft', 'ShiftRight'],
  item: ['KeyE', 'KeyK', 'Enter', 'KeyJ'],
  back: ['KeyQ', 'KeyC'],
  pause: ['Escape', 'KeyP'],
};

export class Input {
  constructor() {
    this.down = new Set();
    this.pressed = new Set();
    this.touch = { steer: 0, gas: false, brake: false, drift: false, item: false, back: false };
    this.touchOn = false;
    this.lastPad = {};
    addEventListener('keydown', (e) => {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
  }
  any(list) {
    return list.some((c) => this.down.has(c));
  }
  hit(list) {
    return list.some((c) => this.pressed.has(c));
  }
  pad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected && p.buttons.length >= 10) return p;
    return null;
  }
  // read the controls for this frame
  read(autoGas) {
    const o = { steer: 0, gas: 0, brake: 0, drift: false, item: false, back: false, pause: false, any: false };
    if (this.any(KEY.left)) o.steer -= 1;
    if (this.any(KEY.right)) o.steer += 1;
    if (this.any(KEY.gas)) o.gas = 1;
    if (this.any(KEY.brake)) o.brake = 1;
    o.drift = this.any(KEY.drift);
    o.item = this.any(KEY.item);
    o.back = this.any(KEY.back);
    o.pause = this.hit(KEY.pause);
    const p = this.pad();
    if (p) {
      const ax = p.axes[0] || 0;
      if (Math.abs(ax) > 0.15) o.steer = Math.max(-1, Math.min(1, o.steer + (ax - Math.sign(ax) * 0.15) / 0.85));
      const b = (i) => !!(p.buttons[i] && p.buttons[i].pressed);
      if (b(14)) o.steer = -1;
      if (b(15)) o.steer = 1;
      if (b(0) || b(7)) o.gas = 1;
      if (b(1) || b(6)) o.brake = 1;
      if (b(4) || b(5)) o.drift = true;
      if (b(2)) o.item = true;
      if (b(3)) o.back = true;
      if (b(9) && !this.lastPad.start) o.pause = true;
      this.lastPad.start = b(9);
      if (p.buttons.some((x) => x.pressed) || Math.abs(ax) > 0.3) o.any = true;
    }
    if (this.touchOn) {
      const t = this.touch;
      if (Math.abs(t.steer) > 0.01) o.steer = t.steer;
      if (!o.gas && !t.gas && autoGas) o.gasAuto = true; // only auto-accelerate is pressing the gas
      if (t.gas || autoGas) o.gas = Math.max(o.gas, 1);
      if (t.brake) {
        o.brake = 1;
        if (autoGas) o.gas = 0;
      }
      o.drift = o.drift || t.drift;
      o.item = o.item || t.item;
      o.back = o.back || t.back;
    }
    // hold brake while using an item to throw it backwards
    o.backThrow = o.brake > 0 || o.back;
    if (this.pressed.size) o.any = true;
    this.pressed.clear();
    return o;
  }
}

// On-screen touch controls: drag anywhere on the left half to steer (left/right of where your
// thumb went down), buttons on the right.
export class TouchControls {
  constructor(root, input) {
    this.root = root;
    this.input = input;
    this.steerId = null;
    this.x0 = 0;
    this.knob = root.querySelector('#tSteerKnob');
    this.base = root.querySelector('#tSteer');
    const zone = root.querySelector('#tSteerZone');
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.steerId !== null) return;
      this.steerId = e.pointerId;
      this.x0 = e.clientX;
      const r = zone.getBoundingClientRect();
      this.base.style.left = e.clientX - r.left - 70 + 'px';
      this.base.style.top = e.clientY - r.top - 70 + 'px';
      this.base.classList.add('on');
      try {
        zone.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      this.move(e);
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.steerId) this.move(e);
    });
    const up = (e) => {
      if (e.pointerId !== this.steerId) return;
      this.steerId = null;
      this.input.touch.steer = 0;
      this.knob.style.transform = 'translate(-50%,-50%)';
      this.base.classList.remove('on');
    };
    zone.addEventListener('pointerup', up);
    zone.addEventListener('pointercancel', up);
    for (const b of root.querySelectorAll('[data-t]')) {
      const k = b.dataset.t;
      const set = (v) => {
        this.input.touch[k] = v;
        b.classList.toggle('on', v);
      };
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        set(true);
        try {
          b.setPointerCapture(e.pointerId);
        } catch (err) {
          /* ignore */
        }
      });
      b.addEventListener('pointerup', () => set(false));
      b.addEventListener('pointercancel', () => set(false));
      b.addEventListener('lostpointercapture', () => set(false));
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }
  move(e) {
    const dx = e.clientX - this.x0;
    const s = Math.max(-1, Math.min(1, dx / 55));
    this.input.touch.steer = Math.abs(s) < 0.08 ? 0 : s;
    this.knob.style.transform = `translate(calc(-50% + ${s * 46}px),-50%)`;
  }
}
