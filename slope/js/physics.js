import * as THREE from 'three';

// Oriented boxes are the only collision primitive. Track tiles are "surface" boxes: their top face
// is treated as a continuous floor and edges shared with the next/previous tile are ignored, which
// removes the seam-snagging the original game is known for.

const _m = new THREE.Matrix4();

export function makeBox(center, quat, half, opts = {}) {
  const b = {
    pos: center.clone(),
    quat: quat.clone(),
    invQuat: quat.clone().invert(),
    half: half.clone(),
    surface: !!opts.surface,
    connectStart: false,
    connectEnd: false,
    bounce: opts.bounce ?? null,
    min: new THREE.Vector3(),
    max: new THREE.Vector3(),
  };
  updateBoxBounds(b);
  return b;
}

export function setBoxTransform(b, pos, quat) {
  b.pos.copy(pos);
  if (quat) {
    b.quat.copy(quat);
    b.invQuat.copy(quat).invert();
  }
  updateBoxBounds(b);
}

export function updateBoxBounds(b) {
  _m.makeRotationFromQuaternion(b.quat);
  const e = _m.elements;
  const hx = b.half.x,
    hy = b.half.y,
    hz = b.half.z;
  const ex = Math.abs(e[0]) * hx + Math.abs(e[4]) * hy + Math.abs(e[8]) * hz;
  const ey = Math.abs(e[1]) * hx + Math.abs(e[5]) * hy + Math.abs(e[9]) * hz;
  const ez = Math.abs(e[2]) * hx + Math.abs(e[6]) * hy + Math.abs(e[10]) * hz;
  b.min.set(b.pos.x - ex, b.pos.y - ey, b.pos.z - ez);
  b.max.set(b.pos.x + ex, b.pos.y + ey, b.pos.z + ez);
}

export function boundsOverlapSphere(b, c, r) {
  return (
    c.x + r > b.min.x && c.x - r < b.max.x && c.y + r > b.min.y && c.y - r < b.max.y && c.z + r > b.min.z && c.z - r < b.max.z
  );
}

const _l = new THREE.Vector3();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Returns true on contact; out.n (world normal, pointing toward the sphere) and out.pen are filled.
export function sphereBox(c, r, b, out) {
  _l.copy(c).sub(b.pos).applyQuaternion(b.invQuat);
  const lx = _l.x,
    ly = _l.y,
    lz = _l.z;
  const hx = b.half.x,
    hy = b.half.y,
    hz = b.half.z;

  if (b.surface) {
    const inFoot = Math.abs(lx) <= hx && Math.abs(lz) <= hz;
    if (inFoot && ly >= hy - r * 0.65) {
      const pen = r - (ly - hy);
      if (pen <= 0) return false;
      out.n.set(0, 1, 0).applyQuaternion(b.quat);
      out.pen = pen;
      return true;
    }
    // beyond an edge that is shared with a neighbouring tile: the neighbour owns this contact
    if ((b.connectStart && lz > hz) || (b.connectEnd && lz < -hz)) return false;
  }

  const cx = clamp(lx, -hx, hx),
    cy = clamp(ly, -hy, hy),
    cz = clamp(lz, -hz, hz);
  const dx = lx - cx,
    dy = ly - cy,
    dz = lz - cz;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= r * r) return false;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    out.n.set(dx / d, dy / d, dz / d);
    out.pen = r - d;
  } else {
    // centre inside the box: push out along the axis of least penetration
    const px = hx - Math.abs(lx),
      py = hy - Math.abs(ly),
      pz = hz - Math.abs(lz);
    if (py <= px && py <= pz) {
      out.n.set(0, ly >= 0 ? 1 : -1, 0);
      out.pen = py + r;
    } else if (px <= pz) {
      out.n.set(lx >= 0 ? 1 : -1, 0, 0);
      out.pen = px + r;
    } else {
      out.n.set(0, 0, lz >= 0 ? 1 : -1);
      out.pen = pz + r;
    }
  }
  out.n.applyQuaternion(b.quat);
  return true;
}

// Cheap overlap test (for hazards / pickups) with a little forgiveness.
export function sphereTouchesBox(c, r, b) {
  _l.copy(c).sub(b.pos).applyQuaternion(b.invQuat);
  const dx = _l.x - clamp(_l.x, -b.half.x, b.half.x);
  const dy = _l.y - clamp(_l.y, -b.half.y, b.half.y);
  const dz = _l.z - clamp(_l.z, -b.half.z, b.half.z);
  return dx * dx + dy * dy + dz * dz < r * r;
}

// Height of a surface box's top face directly below point p (or -Infinity). Used for the landing marker.
export function topHeightBelow(b, p, out) {
  _l.copy(p).sub(b.pos).applyQuaternion(b.invQuat);
  if (Math.abs(_l.x) > b.half.x || Math.abs(_l.z) > b.half.z) return false;
  // intersect vertical ray with the top plane
  const n = out.n.set(0, 1, 0).applyQuaternion(b.quat);
  if (n.y < 0.2) return false;
  const top = out.p.set(0, b.half.y, 0).applyQuaternion(b.quat).add(b.pos);
  // plane: n·(x - top) = 0 -> y = top.y - (n.x*(px-top.x) + n.z*(pz-top.z))/n.y
  const y = top.y - (n.x * (p.x - top.x) + n.z * (p.z - top.z)) / n.y;
  if (y > p.y + 0.5) return false;
  out.y = y;
  return true;
}

// Moves the ball by one fixed step with sub-steps and resolves contacts against track boxes.
const _hit = { n: new THREE.Vector3(), pen: 0 };
export function integrateBall(b, h, tiles, R = 1) {
  const sp = b.vel.length();
  const n = Math.min(14, Math.max(1, Math.ceil((sp * h) / (R * 0.3))));
  const sh = h / n;
  let grounded = false;
  let impact = 0;
  let wall = 0;
  for (let i = 0; i < n; i++) {
    b.pos.addScaledVector(b.vel, sh);
    for (let k = 0; k < tiles.length; k++) {
      const box = tiles[k].box;
      if (!boundsOverlapSphere(box, b.pos, R)) continue;
      if (!sphereBox(b.pos, R, box, _hit)) continue;
      b.pos.addScaledVector(_hit.n, _hit.pen);
      const vn = b.vel.dot(_hit.n);
      if (vn < 0) {
        const e = box.bounce ?? (vn < -12 ? 0.15 : 0);
        b.vel.addScaledVector(_hit.n, -vn * (1 + e));
        if (_hit.n.y > 0.55) impact = Math.max(impact, -vn);
        else wall = Math.max(wall, -vn);
      }
      if (_hit.n.y > 0.55) {
        grounded = true;
        b.groundN.copy(_hit.n);
      }
    }
  }
  return { grounded, impact, wall };
}
