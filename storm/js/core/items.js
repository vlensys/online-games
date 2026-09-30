// Loot tables and deterministic loot rolling (host and clients roll the same floor loot).
import { RNG } from './rng.js';
import { WEAPONS, CONSUMABLES, AMMO, LOOT_MODES, isWeapon } from './config.js';

const WEAPON_WEIGHTS = [
  ['pistol', 17],
  ['smg', 18],
  ['ar', 27],
  ['shotgun', 22],
  ['sniper', 10],
  ['rocket', 6],
];
const CONS_WEIGHTS = [
  ['bandage', 34],
  ['medkit', 14],
  ['shieldS', 32],
  ['shieldL', 20],
];
const AMMO_WEIGHTS = [
  ['light', 30],
  ['medium', 30],
  ['heavy', 12],
  ['shells', 22],
  ['rockets', 6],
];

function pickW(rng, table) {
  return table[rng.weighted(table.map((e) => e[1]))][0];
}

export function rollRarity(rng, mode) {
  return rng.weighted(LOOT_MODES[mode].rarity);
}

export function rollWeapon(rng, mode, minR = 0) {
  let t = pickW(rng, WEAPON_WEIGHTS);
  let r = Math.max(minR, rollRarity(rng, mode));
  const w = WEAPONS[t];
  if (mode === 'legendary') r = 4;
  if (t === 'rocket' && r < w.rMin && mode !== 'plentiful' && mode !== 'legendary' && rng.chance(0.6)) t = 'ar';
  const w2 = WEAPONS[t];
  r = Math.max(w2.rMin, Math.min(w2.rMax, r));
  return { t, r, n: w2.mag };
}

export function ammoFor(t) {
  return 'a_' + WEAPONS[t].ammo;
}

export function ammoPack(kind, mul = 1) {
  return { t: 'a_' + kind, r: 0, n: Math.max(1, Math.round(AMMO[kind].pack * mul)) };
}

export function rollConsumable(rng) {
  const t = pickW(rng, CONS_WEIGHTS);
  return { t, r: CONSUMABLES[t].rarity, n: CONSUMABLES[t].spawn };
}

export function rollFloorItems(rng, mode) {
  const roll = rng.next();
  if (roll < 0.58) {
    const w = rollWeapon(rng, mode);
    return [w, ammoPack(WEAPONS[w.t].ammo)];
  }
  if (roll < 0.84) return [rollConsumable(rng)];
  return [ammoPack(pickW(rng, AMMO_WEIGHTS)), ammoPack(pickW(rng, AMMO_WEIGHTS))];
}

export function rollChest(rng, mode) {
  const w = rollWeapon(rng, mode, 1);
  const items = [w, ammoPack(WEAPONS[w.t].ammo, 1.5), rollConsumable(rng), { t: 'm_wood', r: 0, n: 30 }];
  if (rng.chance(0.35)) items.push(ammoPack(pickW(rng, AMMO_WEIGHTS)));
  return items;
}

export function rollAmmoBox(rng) {
  return [ammoPack(pickW(rng, AMMO_WEIGHTS), 1.5), ammoPack(pickW(rng, AMMO_WEIGHTS), 1.5)];
}

// Initial floor loot: identical on host and clients (same map + lootSeed + mode)
export function generateFloorLoot(map, lootSeed, mode) {
  const rng = new RNG(lootSeed ^ 0x9e3779b9);
  const cfg = LOOT_MODES[mode] || LOOT_MODES.normal;
  const items = [];
  let id = 1;
  for (const s of map.spots) {
    const present = rng.next() < cfg.floor;
    const sub = new RNG((lootSeed + s.id * 7919) >>> 0);
    if (!present) continue;
    const list = rollFloorItems(sub, mode);
    list.forEach((it, k) => {
      const off = k === 0 ? 0 : 0.9;
      items.push({ id: id++, t: it.t, r: it.r, n: it.n, x: s.x + off * (k & 1 ? 1 : -1), y: s.y, z: s.z + off * 0.5 });
    });
  }
  const chests = map.chests.map((c) => rng.next() < cfg.chest);
  const boxes = map.boxes.map((c) => rng.next() < cfg.box);
  return { items, chests, boxes, nextId: id };
}

// Is item `a` (a ground item) better than weapon `b` in the same class? Used by bots.
export function weaponScore(t, r) {
  if (!isWeapon(t)) return 0;
  const base = { pistol: 22, smg: 38, ar: 50, shotgun: 52, sniper: 40, rocket: 45 }[t] || 10;
  return base * (1 + r * 0.16);
}
