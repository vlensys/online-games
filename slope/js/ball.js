import * as THREE from 'three';
import { integrateBall } from './physics.js';
import { GRAVITY, JUMP_V, steerFor } from './track.js';

// Ball controller shared by the game and the headless track tester.
const _up = new THREE.Vector3(0, 1, 0);
const _gt = new THREE.Vector3(),
  _vt = new THREE.Vector3();
export const COYOTE = 0.12;
export const JUMP_BUFFER = 0.14;
export const DASH_CD = 2.0;
export const PHASE_TIME = 0.45;
export const DASH_TIME = 0.45;
const DASH_BOOST = 0.75; // +75% speed
// A/D + dash: a quick sideways burst of SIDE_DIST extra, the same distance at every speed
const SIDE_DIST = 8;
const SIDE_TIME = 0.17; // in section 0; shorter as the speed (and lateral cap) goes up
const SIDE_BOOST = 0.2; // forward boost of a side dash (it should read as sideways, not forwards)
const SIDE_GRACE = 0.09; // steer pressed this soon after a straight dash turns it into a side dash

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
    dashBoost: DASH_BOOST,
    dashAge: 9,
    sideDir: 0,
    sideUsed: true,
    sideTime: 0,
    phase: 0,
    shield: false,
    invuln: 0,
    alive: true,
  };
}

// ctl: { steer, target, plus, jumpQueued (seconds of buffer left), dashQueued, gravity, jumpV, steerAcc }
export function stepController(b, h, ctl, tiles, extra = null) {
  b.dashCD = Math.max(0, b.dashCD - h);
  b.phase = Math.max(0, b.phase - h);
  b.dashTime = Math.max(0, b.dashTime - h);
  b.dashAge += h;
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
      // hop straight off the surface you're rolling on (on the 45° slope that's up and forwards)
      const jv = ctl.jumpV ?? JUMP_V;
      const vn = b.vel.dot(b.groundN);
      b.vel.addScaledVector(b.groundN, jv - Math.min(vn, 0));
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
        b.dashTime = DASH_TIME;
        b.dashAge = 0;
        b.sideDir = 0;
        b.sideUsed = false;
        const side = Math.abs(steer) > 0.3;
        b.dashBoost = side ? SIDE_BOOST : DASH_BOOST;
        // a burst of speed along the way you're rolling (small when dashing sideways)
        if (b.grounded) {
          _vt.copy(b.vel).addScaledVector(b.groundN, -b.vel.dot(b.groundN));
          _vt.x = 0;
          const sp = _vt.length();
          if (sp > 1) b.vel.addScaledVector(_vt, b.dashBoost);
        } else b.vel.z -= ctl.target * b.dashBoost;
        if (side) startSideDash(b, Math.sign(steer), ctl);
        dashed = true;
      }
    }
    // pressed the dash a moment before A/D: still dash that way
    if (!b.sideUsed && b.dashTime > 0 && b.dashAge < SIDE_GRACE && Math.abs(steer) > 0.3) {
      b.dashBoost = SIDE_BOOST;
      startSideDash(b, Math.sign(steer), ctl);
    }
  } else {
    ctl.jumpQueued = 0;
    ctl.dashQueued = false;
  }
  // side dash: hold the sideways burst, then bleed it off so it doesn't fling you off the roof
  if (b.sideDir) {
    b.sideTime -= h;
    if (b.sideTime > 0) b.vel.x = b.sideDir * Math.max(b.sideDir * b.vel.x, b.sideV);
    else {
      const keep = Math.max((ctl.latCap ?? 34) * 0.35, b.sideV0);
      if (b.sideDir * b.vel.x > keep) b.vel.x = b.sideDir * keep;
      b.sideDir = 0;
    }
  }

  // forward drive towards the target speed: a governor that cancels the pull of gravity along the
  // direction you're rolling and eases the speed to the target (so steep roofs can't snowball it).
  // The sideways part of the pull stays: tilted roofs still drag you towards their low edge.
  // (while dashing the governor lets the burst run, then eases you back down)
  const target = ctl.target * (b.dashTime > 0 ? 1 + b.dashBoost : 1);
  const g = ctl.gravity ?? GRAVITY;
  const fwd = -b.vel.z;
  if (b.grounded) {
    const n = b.groundN;
    _gt.set(0, -g, 0).addScaledVector(n, g * n.y);
    _vt.copy(b.vel).addScaledVector(n, -b.vel.dot(n));
    const sp = _vt.length();
    if (sp > 1) {
      _vt.divideScalar(sp);
      b.vel.addScaledVector(_vt, -_gt.dot(_vt) * h);
      const want = (target * sp) / Math.max(fwd, target * 0.3);
      b.vel.addScaledVector(_vt, THREE.MathUtils.clamp((want - sp) * 6, -want * 1.2, want * 3) * h);
    } else b.vel.z -= target * 2 * h;
  } else {
    const over = fwd - target;
    if (over < -0.15 * target) b.vel.z -= 0.15 * target * h;
    else if (over > 0.08 * target) b.vel.z += (over - 0.08 * target) * 2.2 * h;
  }

  // steering: like the original, a sideways push with momentum (the ball drifts and you have to
  // counter-steer), only lightly damped by the ground
  const latAcc = ctl.steerAcc ?? steerFor(0);
  b.vel.x += steer * latAcc * h;
  const damp = ctl.latDamp ?? 0.9;
  b.vel.x *= Math.exp(-(b.grounded ? damp : damp * 0.3) * h);
  const maxLat = ctl.latCap ?? 34;
  if (b.dashTime <= 0 && Math.abs(b.vel.x) > maxLat) b.vel.x = THREE.MathUtils.lerp(b.vel.x, Math.sign(b.vel.x) * maxLat, 1 - Math.exp(-10 * h));

  b.vel.y -= g * h;
  const term = -(Math.max(fwd, 0) * 1.25 + 60);
  if (b.vel.y < term) b.vel.y = term; // terminal velocity

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

function startSideDash(b, dir, ctl) {
  const k = (ctl.latCap ?? 34) / 40; // grows with the section speed
  b.sideDir = dir;
  b.sideUsed = true;
  b.sideTime = SIDE_TIME / k;
  // on top of any drift you already had that way (and that drift is what you keep afterwards)
  b.sideV0 = Math.max(0, dir * b.vel.x);
  b.sideV = b.sideV0 + SIDE_DIST / b.sideTime;
}
