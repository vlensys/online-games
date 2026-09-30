import * as THREE from 'three';
import { integrateBall } from './physics.js';
import { GRAVITY, JUMP_V } from './track.js';

// Ball controller shared by the game and the headless track tester.
const _up = new THREE.Vector3(0, 1, 0);
export const COYOTE = 0.12;
export const JUMP_BUFFER = 0.14;
export const DASH_CD = 2.0;
export const PHASE_TIME = 0.4;

export function createBall() {
  return {
    pos: new THREE.Vector3(),
    prev: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    grounded: false,
    groundN: new THREE.Vector3(0, 1, 0),
    coyote: 0,
    jumpLock: 0,
    airTime: 0,
    dashCD: 0,
    dashTime: 0,
    phase: 0,
    shield: false,
    invuln: 0,
    alive: true,
  };
}

// ctl: { steer, target, plus, jumpQueued (seconds of buffer left), dashQueued }
export function stepController(b, h, ctl, tiles, extra = null) {
  b.dashCD = Math.max(0, b.dashCD - h);
  b.phase = Math.max(0, b.phase - h);
  b.dashTime = Math.max(0, b.dashTime - h);
  b.invuln = Math.max(0, b.invuln - h);
  b.jumpLock = Math.max(0, b.jumpLock - h);
  ctl.jumpQueued = Math.max(0, ctl.jumpQueued - h);
  if (b.grounded && b.jumpLock <= 0) b.coyote = COYOTE;
  else b.coyote = Math.max(0, b.coyote - h);

  const steer = ctl.steer;
  let jumped = false,
    dashed = false;
  if (ctl.plus) {
    if (ctl.jumpQueued > 0 && b.coyote > 0) {
      // jump relative to the slope: while rolling, vel.y already follows the surface, so adding the
      // impulse gives the same small hop on any slope (world-up jumps on a steep descent flew for seconds)
      b.vel.y = Math.max(b.vel.y, -26) + JUMP_V;
      b.grounded = false;
      b.coyote = 0;
      b.jumpLock = 0.1;
      ctl.jumpQueued = 0;
      jumped = true;
    }
    if (ctl.dashQueued) {
      ctl.dashQueued = false;
      if (b.dashCD <= 0) {
        b.dashCD = DASH_CD;
        b.phase = PHASE_TIME;
        b.dashTime = 0.24;
        if (Math.abs(steer) > 0.3) b.vel.x = Math.sign(steer) * Math.max(Math.abs(b.vel.x), 25);
        b.vel.z -= 11;
        if (!b.grounded) b.vel.y = Math.max(b.vel.y, 3.5);
        dashed = true;
      }
    }
  } else {
    ctl.jumpQueued = 0;
    ctl.dashQueued = false;
  }

  // forward drive towards the target speed
  // (a governor, not just a motor: gravity on steep slopes / landings must not snowball the speed)
  const target = ctl.target;
  const fwd = -b.vel.z;
  const over = fwd - target;
  if (b.grounded) {
    if (over < 0) b.vel.z -= Math.min(24 * h, -over);
    else b.vel.z += Math.min((over * 2.5 + 10) * h, over);
  } else {
    if (over < -0.15 * target) b.vel.z -= 6 * h;
    else if (over > 0.08 * target) b.vel.z += (over - 0.08 * target) * 2.2 * h;
  }

  // steering: snappy, with quick counter-steer and gentle auto-centering of lateral speed
  const latAcc = b.grounded ? 64 : 40;
  b.vel.x += steer * latAcc * h;
  if (Math.abs(steer) < 0.05 || Math.sign(steer) !== Math.sign(b.vel.x)) b.vel.x *= Math.exp(-(b.grounded ? 3.4 : 1.1) * h);
  const maxLat = 13 + Math.max(fwd, 0) * 0.12;
  if (b.dashTime <= 0 && Math.abs(b.vel.x) > maxLat) b.vel.x = THREE.MathUtils.lerp(b.vel.x, Math.sign(b.vel.x) * maxLat, 1 - Math.exp(-10 * h));

  b.vel.y -= GRAVITY * h;
  if (b.vel.y < -48) b.vel.y = -48; // terminal velocity

  const res = integrateBall(b, h, tiles, 1, extra);
  res.wasGrounded = b.grounded;
  b.grounded = res.grounded;
  b.airTime = res.grounded ? 0 : b.airTime + h;
  if (!res.grounded) b.groundN.lerp(_up, 0.05);
  res.jumped = jumped;
  res.dashed = dashed;
  res.fwd = fwd;
  return res;
}
