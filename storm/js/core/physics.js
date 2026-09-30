// Character movement shared by the local player (client prediction) and bots (host).
import { CHAR, WATER_Y, WORLD_HALF } from './config.js';

export const M_BUS = 0;
export const M_FALL = 1;
export const M_GLIDE = 2;
export const M_GROUND = 3;
export const M_SWIM = 4;
export const M_DEAD = 5;

const SWIM_Y = WATER_Y - 1.15;

export function makeChar(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    vx: 0, vy: 0, vz: 0,
    yaw: 0, pitch: 0,
    mode: M_GROUND,
    grounded: false,
    crouch: false,
    peakY: y,
    blocked: 0,
  };
}

export function makeInput() {
  return { fwd: 0, right: 0, sprint: false, jump: false, crouch: false, ads: false, slow: 1 };
}

export function makeStepOut() {
  return { landed: false, fallDmg: 0, jumped: false, deployed: false, landVel: 0, blocked: false, blockPiece: null, blockProp: null };
}

export function charHeight(c) {
  return c.crouch ? CHAR.crouchHeight : CHAR.height;
}

function approach(cur, target, maxDelta) {
  const d = target - cur;
  if (d > maxDelta) return cur + maxDelta;
  if (d < -maxDelta) return cur - maxDelta;
  return target;
}

function moveXZ(world, c, dx, dz, height, out) {
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 1e-7) return;
  const n = Math.ceil(dist / 0.35);
  const sx = dx / n;
  const sz = dz / n;
  const headY = c.y + height;
  for (let i = 0; i < n; i++) {
    let nx = c.x + sx;
    let nz = c.z + sz;
    if (world.slopeBlocks(nx, nz, c.y, headY)) {
      if (!world.slopeBlocks(nx, c.z, c.y, headY)) nz = c.z;
      else if (!world.slopeBlocks(c.x, nz, c.y, headY)) nx = c.x;
      else {
        out.blocked = true;
        break;
      }
    }
    const contacts = world.pushOut(nx, nz, c.y, headY);
    if (contacts) {
      out.blocked = true;
      if (world.contactPiece) out.blockPiece = world.contactPiece;
      if (world.contactProp) out.blockProp = world.contactProp;
    }
    c.x = world._n[0];
    c.z = world._n[1];
  }
}

function wishDir(c, inp, o) {
  const s = Math.sin(c.yaw);
  const co = Math.cos(c.yaw);
  let wx = -s * inp.fwd + co * inp.right;
  let wz = -co * inp.fwd - s * inp.right;
  const l = Math.sqrt(wx * wx + wz * wz);
  if (l > 1) {
    wx /= l;
    wz /= l;
  }
  o[0] = wx;
  o[1] = wz;
  return o;
}

const wd = [0, 0];

export function stepChar(world, c, inp, dt, out) {
  out.landed = false;
  out.fallDmg = 0;
  out.jumped = false;
  out.deployed = false;
  out.blocked = false;
  out.blockPiece = null;
  out.blockProp = null;
  switch (c.mode) {
    case M_FALL:
      stepFall(world, c, inp, dt, out);
      break;
    case M_GLIDE:
      stepGlide(world, c, inp, dt, out);
      break;
    case M_GROUND:
      stepGround(world, c, inp, dt, out);
      break;
    case M_SWIM:
      stepSwim(world, c, inp, dt, out);
      break;
    default:
      break;
  }
  const lim = WORLD_HALF - 8;
  if (c.x > lim) c.x = lim;
  if (c.x < -lim) c.x = -lim;
  if (c.z > lim) c.z = lim;
  if (c.z < -lim) c.z = -lim;
}

function stepGround(world, c, inp, dt, out) {
  if (inp.crouch !== c.crouch) {
    if (inp.crouch) c.crouch = true;
    else {
      // stand up only if there's room
      const ceil = world.ceilingAt(c.x, c.z, c.y + CHAR.crouchHeight);
      if (ceil - c.y >= CHAR.height) c.crouch = false;
    }
  }
  const height = charHeight(c);
  wishDir(c, inp, wd);
  let speed = CHAR.run;
  if (c.crouch) speed = CHAR.crouchSpeed;
  else if (inp.ads) speed = CHAR.adsSpeed;
  else if (inp.sprint && inp.fwd > 0.3) speed = CHAR.sprint;
  speed *= inp.slow || 1;
  const tx = wd[0] * speed;
  const tz = wd[1] * speed;
  const acc = (c.grounded ? CHAR.accelGround : CHAR.accelAir) * dt;
  c.vx = approach(c.vx, tx, acc);
  c.vz = approach(c.vz, tz, acc);
  if (inp.jump && c.grounded) {
    c.vy = CHAR.jumpVel;
    c.grounded = false;
    c.peakY = c.y;
    out.jumped = true;
    if (c.crouch) {
      const ceil = world.ceilingAt(c.x, c.z, c.y + CHAR.crouchHeight);
      if (ceil - c.y >= CHAR.height) c.crouch = false;
    }
  }
  const ox = c.x;
  const oz = c.z;
  moveXZ(world, c, c.vx * dt, c.vz * dt, height, out);
  // kill velocity going into walls so we don't stick
  if (out.blocked && dt > 0) {
    const ax = (c.x - ox) / dt;
    const az = (c.z - oz) / dt;
    if (Math.abs(ax) < Math.abs(c.vx)) c.vx = ax;
    if (Math.abs(az) < Math.abs(c.vz)) c.vz = az;
  }
  if (c.grounded) {
    const g = world.groundAt(c.x, c.z, c.y);
    if (g >= c.y - 0.55) {
      c.y = g;
      c.vy = 0;
      c.peakY = c.y;
    } else {
      c.grounded = false;
      c.peakY = c.y;
      c.vy = Math.min(c.vy, 0);
    }
  }
  if (!c.grounded) {
    c.vy -= CHAR.gravity * dt;
    if (c.vy < -60) c.vy = -60;
    let ny = c.y + c.vy * dt;
    if (c.vy > 0) {
      const ceil = world.ceilingAt(c.x, c.z, c.y + height);
      if (ny + height > ceil) {
        ny = Math.max(c.y, ceil - height);
        c.vy = 0;
      }
    }
    const g = world.groundAt(c.x, c.z, c.y);
    if (ny <= g) {
      const fall = c.peakY - g;
      out.landVel = -c.vy;
      if (fall > CHAR.fallDmgStart) out.fallDmg = Math.round((fall - CHAR.fallDmgStart) * CHAR.fallDmgPerUnit);
      c.y = g;
      c.vy = 0;
      c.grounded = true;
      c.peakY = g;
      out.landed = true;
    } else {
      c.y = ny;
      if (c.y > c.peakY) c.peakY = c.y;
    }
  }
  // enter water
  if (c.y < SWIM_Y + 0.02 && world.terrain.heightAt(c.x, c.z) < SWIM_Y) {
    c.mode = M_SWIM;
    c.y = SWIM_Y;
    c.vy = 0;
    c.grounded = false;
    c.crouch = false;
  }
}

function stepSwim(world, c, inp, dt, out) {
  wishDir(c, inp, wd);
  const sp = CHAR.swimSpeed;
  const acc = 18 * dt;
  c.vx = approach(c.vx, wd[0] * sp, acc);
  c.vz = approach(c.vz, wd[1] * sp, acc);
  c.y = SWIM_Y;
  moveXZ(world, c, c.vx * dt, c.vz * dt, CHAR.height, out);
  const g = world.groundAt(c.x, c.z, c.y);
  if (g > SWIM_Y - 0.05) {
    c.mode = M_GROUND;
    c.y = g;
    c.grounded = true;
    c.peakY = g;
  }
}

function stepFall(world, c, inp, dt, out) {
  wishDir(c, inp, wd);
  const dive = Math.max(0, Math.min(1, (-c.pitch - 0.25) / 0.9));
  const hs = CHAR.fallHoriz * (1 - 0.55 * dive);
  const tvy = -(CHAR.fallSpeed + (CHAR.diveSpeed - CHAR.fallSpeed) * dive);
  c.vx = approach(c.vx, wd[0] * hs, 16 * dt);
  c.vz = approach(c.vz, wd[1] * hs, 16 * dt);
  c.vy = approach(c.vy, tvy, 30 * dt);
  moveXZ(world, c, c.vx * dt, c.vz * dt, CHAR.height, out);
  const ny = c.y + c.vy * dt;
  const g = world.surfaceBelow(c.x, c.z, c.y);
  const above = c.y - g;
  if (ny <= g) {
    c.y = g;
    c.mode = M_GROUND;
    c.grounded = true;
    c.vy = 0;
    c.peakY = g;
    out.landed = true;
    return;
  }
  c.y = ny;
  if (above < CHAR.glideDeploy || (inp.jump && above < 120)) {
    c.mode = M_GLIDE;
    out.deployed = true;
    c.vy = Math.max(c.vy, -16);
  }
}

function stepGlide(world, c, inp, dt, out) {
  wishDir(c, inp, wd);
  const dive = Math.max(0, Math.min(1, (-c.pitch - 0.3) / 0.8));
  const sp = CHAR.glideSpeed * (1 + 0.2 * dive);
  c.vx = approach(c.vx, wd[0] * sp, 7 * dt);
  c.vz = approach(c.vz, wd[1] * sp, 7 * dt);
  c.vy = approach(c.vy, -CHAR.glideFall * (1 + 0.7 * dive), 14 * dt);
  moveXZ(world, c, c.vx * dt, c.vz * dt, CHAR.height, out);
  const ny = c.y + c.vy * dt;
  const g = world.groundAt(c.x, c.z, c.y, undefined, Math.abs(c.vy * dt) + 3);
  if (ny <= g) {
    c.y = g;
    c.mode = M_GROUND;
    c.grounded = true;
    c.vy = 0;
    c.peakY = g;
    out.landed = true;
    return;
  }
  c.y = ny;
  if (c.y < SWIM_Y && world.terrain.heightAt(c.x, c.z) < SWIM_Y) {
    c.mode = M_SWIM;
    c.y = SWIM_Y;
    c.vy = 0;
    out.landed = true;
  }
}

// Eye position helper
export function eyeY(c) {
  return c.y + (c.crouch ? CHAR.crouchEye : CHAR.eye);
}
