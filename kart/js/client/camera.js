// Chase camera: follows behind the kart (leaning towards where it is actually going while it
// drifts), pulls back and widens with speed, shakes on hits; plus an intro fly-by of the grid,
// a look-behind view and an orbit after the finish.
import * as THREE from 'three';

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class ChaseCam {
  constructor(camera) {
    this.cam = camera;
    this.yaw = 0;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.shakeT = 0;
    this.fov = 70;
    this.distMul = 1;
    this.inited = false;
    this._t = new THREE.Vector3();
  }
  snap(p) {
    this.yaw = p.yaw;
    this.inited = false;
  }
  shake(a = 0.4) {
    this.shakeT = Math.max(this.shakeT, a);
  }
  // mode: 'race' | 'back' | 'intro' | 'orbit'; u = 0..1 progress for intro
  update(k, p, dt, mode = 'race', u = 0, groundY = null) {
    const cam = this.cam;
    const sp = Math.min(1.4, Math.hypot(k.vx, k.vz) / 28);
    if (mode === 'intro' || mode === 'orbit') {
      const a = mode === 'intro' ? p.yaw + Math.PI * (1 - u) * 1.1 + 0.4 : performance.now() / 4000;
      const r = mode === 'intro' ? 16 - u * 9 : 9;
      const h = mode === 'intro' ? 7 - u * 4 : 3.4;
      this.pos.set(p.x + Math.sin(a) * r, p.y + h, p.z + Math.cos(a) * r);
      cam.position.copy(this.pos);
      cam.lookAt(p.x, p.y + 1, p.z);
      this.yaw = p.yaw;
      this.inited = false;
      this.setFov(68);
      return;
    }
    let target = p.yaw;
    const vsp = Math.hypot(k.vx, k.vz);
    if (vsp > 4 && k.spinT <= 0) target = lerpAngle(p.yaw, Math.atan2(k.vx, k.vz), k.drift ? 0.55 : 0.25);
    if (k.spinT > 0) target = this.yaw;
    this.yaw = lerpAngle(this.yaw, target, Math.min(1, dt * (k.drift ? 3.5 : 5)));
    const back = mode === 'back' ? -1 : 1;
    const dist = (5.8 + sp * 1.6) * this.distMul,
      height = 2.35 * this.distMul + 0.2;
    const fx = Math.sin(this.yaw),
      fz = Math.cos(this.yaw);
    const want = this._t.set(p.x - fx * dist * back, p.y + height, p.z - fz * dist * back);
    if (groundY !== null) want.y = Math.max(want.y, groundY + 1.2);
    if (!this.inited || mode === 'back' || this.lastMode === 'back') {
      this.pos.copy(want);
      this.inited = true;
    } else {
      const kh = Math.min(1, dt * 12),
        kv = Math.min(1, dt * 7);
      this.pos.x += (want.x - this.pos.x) * kh;
      this.pos.z += (want.z - this.pos.z) * kh;
      this.pos.y += (want.y - this.pos.y) * kv;
      // never fall behind more than a bit (fast boosts)
      const dx = this.pos.x - p.x,
        dz = this.pos.z - p.z;
      const d = Math.hypot(dx, dz),
        maxD = dist * 1.35;
      if (d > maxD) {
        this.pos.x = p.x + (dx / d) * maxD;
        this.pos.z = p.z + (dz / d) * maxD;
      }
    }
    this.lastMode = mode;
    cam.position.copy(this.pos);
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const s = this.shakeT * 0.5;
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
    }
    this.look.set(p.x + fx * 3.5 * back, p.y + 1.1, p.z + fz * 3.5 * back);
    cam.lookAt(this.look);
    this.setFov(66 + sp * 6 + (k.boostT > 0 ? 9 : 0));
  }
  setFov(f) {
    this.fov += (f - this.fov) * 0.1;
    if (Math.abs(this.cam.fov - this.fov) > 0.05) {
      this.cam.fov = this.fov;
      this.cam.updateProjectionMatrix();
    }
  }
}
