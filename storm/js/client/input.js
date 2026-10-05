// Keyboard + mouse (pointer lock). Tracks held keys and per-frame presses by KeyboardEvent.code.
const GAME_KEYS = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Quote', 'Slash', 'Backspace']);

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();
    this.buttons = 0;
    this.mpressed = 0;
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.locked = false;
    this.active = false; // true while a match is on screen
    this.onDesktop = null; // called when keyboard/mouse is used (switch UI back from touch)
    this.onUnlock = null;
    this.onLock = null;
    window.addEventListener('keydown', (e) => this.keydown(e), { passive: false });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.buttons = 0;
    });
    window.addEventListener('mousemove', (e) => {
      if (this.locked) {
        // ignore absurd spikes some browsers produce right after locking
        if (Math.abs(e.movementX) < 400 && Math.abs(e.movementY) < 400) {
          this.dx += e.movementX;
          this.dy += e.movementY;
        }
      }
      if (e.movementX || e.movementY) this.desktop();
    });
    canvas.addEventListener('mousedown', (e) => this.mousedown(e));
    window.addEventListener('mouseup', (e) => {
      this.buttons &= ~(1 << e.button);
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (!this.active) return;
        this.wheel += Math.sign(e.deltaY);
        e.preventDefault();
      },
      { passive: false },
    );
    window.addEventListener('contextmenu', (e) => {
      if (this.active || e.target === canvas) e.preventDefault();
    });
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === canvas;
      if (this.locked && this.onLock) this.onLock();
      if (was && !this.locked) {
        this.buttons = 0;
        if (this.onUnlock) this.onUnlock();
      }
    });
  }

  desktop() {
    if (this.onDesktop) this.onDesktop();
  }

  keydown(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
    if (this.active && (GAME_KEYS.has(e.code) || e.code.startsWith('Digit') || e.code.startsWith('Key'))) {
      if (!e.ctrlKey && !e.metaKey) e.preventDefault();
    }
    if (!e.repeat) this.pressed.add(e.code);
    this.keys.add(e.code);
    this.desktop();
  }

  mousedown(e) {
    this.desktop();
    if (!this.active) return;
    if (!this.locked) {
      this.lock();
      return;
    }
    this.buttons |= 1 << e.button;
    this.mpressed |= 1 << e.button;
    e.preventDefault();
  }

  // onFail: the browser refused (no user gesture, or too soon after Esc)
  lock(onFail) {
    const fail = () => {
      if (!this.locked && onFail) onFail();
    };
    const plain = () => {
      try {
        const p2 = this.canvas.requestPointerLock();
        if (p2 && p2.catch) p2.catch(fail);
      } catch (e) {
        fail();
      }
    };
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(plain);
    } catch (e) {
      plain();
    }
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  down(code) {
    return this.keys.has(code);
  }
  hit(code) {
    return this.pressed.has(code);
  }
  mouse(b) {
    return (this.buttons & (1 << b)) !== 0;
  }
  mouseHit(b) {
    return (this.mpressed & (1 << b)) !== 0;
  }
  takeLook() {
    const r = [this.dx, this.dy];
    this.dx = 0;
    this.dy = 0;
    return r;
  }
  takeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }
  endFrame() {
    this.pressed.clear();
    this.mpressed = 0;
  }
}
