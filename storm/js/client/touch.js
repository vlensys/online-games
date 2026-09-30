// On-screen touch controls: floating joystick, look drag, action buttons (multi-touch via
// pointer events, each pointer tracked by id).
export class Touch {
  constructor(root) {
    this.root = root;
    this.mx = 0;
    this.my = 0;
    this.sprint = false;
    this.dx = 0;
    this.dy = 0;
    this.held = new Set();
    this.pressed = new Set();
    this.enabled = false;
    this.joy = null;
    this.looks = new Map();
    this.onTouch = null;
    this.base = root.querySelector('#joyBase');
    this.knob = root.querySelector('#joyKnob');
    const joyZone = root.querySelector('#joyZone');
    const lookZone = root.querySelector('#lookZone');
    joyZone.addEventListener('pointerdown', (e) => this.joyDown(e));
    lookZone.addEventListener('pointerdown', (e) => this.lookDown(e));
    window.addEventListener('pointermove', (e) => this.move(e), { passive: false });
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.up(e));
    for (const b of root.querySelectorAll('.tbtn')) {
      b.addEventListener('pointerdown', (e) => this.btnDown(e, b));
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    // any touch switches the UI into touch mode
    window.addEventListener(
      'touchstart',
      () => {
        if (this.onTouch) this.onTouch();
      },
      { passive: true },
    );
  }

  joyDown(e) {
    e.preventDefault();
    if (this.joy) return;
    const r = this.base.parentElement.getBoundingClientRect();
    this.joy = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
    const hw = this.base.offsetWidth / 2 || 65;
    this.base.style.left = e.clientX - r.left - hw + 'px';
    this.base.style.top = e.clientY - r.top - hw + 'px';
    this.base.style.bottom = 'auto';
    try {
      e.target.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
    this.updateJoy(e.clientX, e.clientY);
  }

  updateJoy(x, y) {
    const R = this.base.offsetWidth * 0.42 || 55;
    let dx = x - this.joy.ox;
    let dy = y - this.joy.oy;
    const l = Math.sqrt(dx * dx + dy * dy);
    if (l > R) {
      dx = (dx / l) * R;
      dy = (dy / l) * R;
    }
    this.mx = dx / R;
    this.my = -dy / R;
    this.sprint = l > R * 1.25 && this.my > 0.5;
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    this.base.classList.toggle('sprint', this.sprint);
  }

  lookDown(e) {
    e.preventDefault();
    this.looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      e.target.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
  }

  btnDown(e, b) {
    e.preventDefault();
    e.stopPropagation();
    const a = b.dataset.a;
    this.held.add(a);
    this.pressed.add(a);
    b.classList.add('active');
    const id = e.pointerId;
    this.looks.set(id, { x: e.clientX, y: e.clientY, btn: b, a });
    try {
      b.setPointerCapture(id);
    } catch (err) {
      /* ignore */
    }
  }

  move(e) {
    if (this.joy && e.pointerId === this.joy.id) {
      e.preventDefault();
      this.updateJoy(e.clientX, e.clientY);
      return;
    }
    const l = this.looks.get(e.pointerId);
    if (!l) return;
    e.preventDefault();
    // buttons other than fire/aim don't turn the camera
    if (!l.btn || l.a === 'fire' || l.a === 'aim' || l.a === 'jump') {
      this.dx += e.clientX - l.x;
      this.dy += e.clientY - l.y;
    }
    l.x = e.clientX;
    l.y = e.clientY;
  }

  up(e) {
    if (this.joy && e.pointerId === this.joy.id) {
      this.joy = null;
      this.mx = 0;
      this.my = 0;
      this.sprint = false;
      this.knob.style.transform = '';
      this.base.classList.remove('sprint');
      this.base.style.left = '';
      this.base.style.top = '';
      this.base.style.bottom = '';
      return;
    }
    const l = this.looks.get(e.pointerId);
    if (!l) return;
    this.looks.delete(e.pointerId);
    if (l.btn) {
      l.btn.classList.remove('active');
      // only release the action if no other pointer holds the same action
      let still = false;
      for (const o of this.looks.values()) if (o.a === l.a) still = true;
      if (!still) this.held.delete(l.a);
    }
  }

  takeLook() {
    const r = [this.dx, this.dy];
    this.dx = 0;
    this.dy = 0;
    return r;
  }
  hit(a) {
    return this.pressed.has(a);
  }
  down(a) {
    return this.held.has(a);
  }
  endFrame() {
    this.pressed.clear();
  }
  reset() {
    this.held.clear();
    this.pressed.clear();
    this.looks.clear();
    this.joy = null;
    this.mx = this.my = 0;
    this.dx = this.dy = 0;
    this.sprint = false;
    for (const b of this.root.querySelectorAll('.tbtn')) b.classList.remove('active');
  }
}
