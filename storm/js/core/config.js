// Shared game constants (used by the simulation server, bots and the client).

export const VERSION = 'sr1';

// World
export const WORLD_HALF = 600; // terrain spans [-WORLD_HALF, WORLD_HALF] on x and z
export const TERRAIN_SEG = 160; // terrain grid segments per side
export const WATER_Y = 0;
export const GRID = 4; // build grid cell size (x/z)
export const LEVEL = 4; // build grid level height (y)
export const BUS_HEIGHT = 230;
export const BUS_SPEED = 30;

// Character
export const CHAR = {
  radius: 0.42,
  height: 1.85,
  crouchHeight: 1.25,
  eye: 1.6,
  crouchEye: 1.05,
  step: 0.62,
  gravity: 26,
  jumpVel: 8.6,
  run: 5.4,
  sprint: 7.3,
  crouchSpeed: 2.8,
  adsSpeed: 3.7,
  swimSpeed: 3.9,
  accelGround: 60,
  accelAir: 10,
  fallSpeed: 21, // skydive vertical speed
  diveSpeed: 44, // looking straight down
  fallHoriz: 22,
  glideSpeed: 14,
  glideFall: 7.5,
  glideDeploy: 42, // auto deploy height above ground
  fallDmgStart: 9.5,
  fallDmgPerUnit: 5.2,
};

export const HP_MAX = 100;
export const SHIELD_MAX = 100;

export const RARITY = [
  { name: 'Common', color: '#a0a8b2', dmg: 1.0, spread: 1.0, reload: 1.0, rate: 1.0 },
  { name: 'Uncommon', color: '#4dbb4a', dmg: 1.05, spread: 0.95, reload: 0.95, rate: 1.0 },
  { name: 'Rare', color: '#3796f2', dmg: 1.1, spread: 0.9, reload: 0.9, rate: 1.03 },
  { name: 'Epic', color: '#b05df0', dmg: 1.16, spread: 0.86, reload: 0.85, rate: 1.05 },
  { name: 'Legendary', color: '#f3a334', dmg: 1.22, spread: 0.82, reload: 0.8, rate: 1.08 },
];

// spread values are degrees (max half angle); fall = [startDist, endDist, minMultiplier]
export const WEAPONS = {
  pickaxe: { id: 0, name: 'Pickaxe', melee: true, dmg: 20, sdmg: 55, rate: 1.75, range: 3.3 },
  pistol: {
    id: 1, name: 'Pistol', ammo: 'light', dmg: 24, sdmg: 22, rate: 6.5, mag: 16, reload: 1.4,
    hip: 2.4, ads: 0.9, bloom: 0.6, bloomMax: 3.2, range: 220, fall: [22, 70, 0.62], head: 2.0,
    pellets: 1, rMin: 0, rMax: 3, auto: false, zoom: 1.25,
  },
  smg: {
    id: 2, name: 'SMG', ammo: 'light', dmg: 16, sdmg: 16, rate: 12, mag: 30, reload: 2.1,
    hip: 3.0, ads: 1.8, bloom: 0.35, bloomMax: 3.6, range: 160, fall: [14, 45, 0.55], head: 1.75,
    pellets: 1, rMin: 0, rMax: 3, auto: true, zoom: 1.25,
  },
  ar: {
    id: 3, name: 'Assault Rifle', ammo: 'medium', dmg: 30, sdmg: 30, rate: 5.5, mag: 30, reload: 2.3,
    hip: 2.3, ads: 0.5, bloom: 0.55, bloomMax: 3.2, range: 300, fall: [40, 110, 0.7], head: 1.5,
    pellets: 1, rMin: 0, rMax: 4, auto: true, zoom: 1.45,
  },
  shotgun: {
    id: 4, name: 'Pump Shotgun', ammo: 'shells', dmg: 9, sdmg: 8, rate: 0.85, mag: 5, reload: 4.4,
    hip: 5.4, ads: 4.3, bloom: 0, bloomMax: 0, range: 55, fall: [6, 24, 0.3], head: 2.0,
    pellets: 10, rMin: 0, rMax: 4, auto: false, zoom: 1.15,
  },
  sniper: {
    id: 5, name: 'Bolt Sniper', ammo: 'heavy', dmg: 100, sdmg: 90, rate: 0.36, mag: 1, reload: 2.4,
    hip: 6, ads: 0.02, bloom: 0, bloomMax: 0, range: 700, fall: [0, 0, 1], head: 2.5,
    pellets: 1, rMin: 2, rMax: 4, auto: false, scope: true, zoom: 5,
  },
  rocket: {
    id: 6, name: 'Rocket Launcher', ammo: 'rockets', dmg: 105, sdmg: 520, rate: 0.8, mag: 1, reload: 2.8,
    hip: 1.2, ads: 0.4, bloom: 0, bloomMax: 0, range: 400, fall: [0, 0, 1], head: 1,
    pellets: 1, rMin: 3, rMax: 4, auto: false, projectile: true, splash: 5.5, speed: 62, zoom: 1.3,
  },
};
export const WEAPON_LIST = ['pickaxe', 'pistol', 'smg', 'ar', 'shotgun', 'sniper', 'rocket'];

export const AMMO = {
  light: { name: 'Light Ammo', max: 360, pack: 30, color: '#a8c8e8' },
  medium: { name: 'Medium Ammo', max: 360, pack: 30, color: '#7fb86a' },
  heavy: { name: 'Heavy Ammo', max: 60, pack: 6, color: '#c06a4a' },
  shells: { name: 'Shells', max: 60, pack: 8, color: '#d8b04a' },
  rockets: { name: 'Rockets', max: 12, pack: 3, color: '#7a7f86' },
};
export const AMMO_LIST = ['light', 'medium', 'heavy', 'shells', 'rockets'];

export const CONSUMABLES = {
  bandage: { name: 'Bandages', hp: 15, hpMax: 75, time: 3.5, stack: 15, spawn: 5, rarity: 1 },
  medkit: { name: 'Med Kit', hp: 100, hpMax: 100, time: 8, stack: 3, spawn: 1, rarity: 1 },
  shieldS: { name: 'Small Shield', sh: 25, shMax: 50, time: 2, stack: 6, spawn: 3, rarity: 1 },
  shieldL: { name: 'Shield Potion', sh: 50, shMax: 100, time: 5, stack: 3, spawn: 1, rarity: 2 },
};

export const MATERIALS = [
  { key: 'wood', name: 'Wood', hp: 170, time: 1.3, color: '#b98a55' },
  { key: 'brick', name: 'Brick', hp: 300, time: 3.2, color: '#b25c43' },
  { key: 'metal', name: 'Metal', hp: 450, time: 5.2, color: '#8e9aa6' },
];
export const BUILD_COST = 10;
export const MAT_MAX = 999;
export const START_MATS = [50, 0, 0];

// Ground item type ids (network-compact)
export const ITEM_TYPES = [
  'pistol', 'smg', 'ar', 'shotgun', 'sniper', 'rocket',
  'bandage', 'medkit', 'shieldS', 'shieldL',
  'a_light', 'a_medium', 'a_heavy', 'a_shells', 'a_rockets',
  'm_wood', 'm_brick', 'm_metal',
];
export const ITEM_ID = Object.fromEntries(ITEM_TYPES.map((t, i) => [t, i]));

export function isWeapon(t) {
  return t in WEAPONS && t !== 'pickaxe';
}
export function isConsumable(t) {
  return t in CONSUMABLES;
}

export function itemName(t, r) {
  if (isWeapon(t)) return `${RARITY[r].name} ${WEAPONS[t].name}`;
  if (isConsumable(t)) return CONSUMABLES[t].name;
  if (t.startsWith('a_')) return AMMO[t.slice(2)].name;
  if (t.startsWith('m_')) return MATERIALS.find((m) => m.key === t.slice(2)).name;
  return t;
}

// Weapon stats including rarity
export function weaponStats(t, r) {
  const w = WEAPONS[t];
  if (!w || w.melee) return w;
  const R = RARITY[r] || RARITY[0];
  return {
    ...w,
    dmg: w.dmg * R.dmg,
    sdmg: w.sdmg * R.dmg,
    hip: w.hip * R.spread,
    ads: w.ads * R.spread,
    reload: w.reload * R.reload,
    rate: w.rate * R.rate,
  };
}

export function falloff(w, dist) {
  if (!w.fall || w.fall[1] <= 0) return 1;
  const [a, b, m] = w.fall;
  if (dist <= a) return 1;
  if (dist >= b) return m;
  return 1 + (m - 1) * ((dist - a) / (b - a));
}

// Storm phases for "normal" speed
export const STORM_PHASES = [
  { wait: 55, shrink: 50, r: 320, dmg: 1 },
  { wait: 45, shrink: 40, r: 185, dmg: 2 },
  { wait: 40, shrink: 30, r: 100, dmg: 4 },
  { wait: 30, shrink: 25, r: 55, dmg: 6 },
  { wait: 25, shrink: 20, r: 28, dmg: 8 },
  { wait: 20, shrink: 18, r: 12, dmg: 10 },
  { wait: 15, shrink: 22, r: 0, dmg: 12 },
];
export const STORM_START_R = 680;

export const LOOT_MODES = {
  scarce: { name: 'Scarce', floor: 0.35, chest: 0.6, rarity: [50, 30, 14, 5, 1], box: 0.5 },
  normal: { name: 'Normal', floor: 0.55, chest: 0.82, rarity: [36, 32, 20, 9, 3], box: 0.75 },
  plentiful: { name: 'Plentiful', floor: 0.82, chest: 1, rarity: [18, 28, 28, 17, 9], box: 1 },
  legendary: { name: 'Legendary only', floor: 0.8, chest: 1, rarity: [0, 0, 0, 0, 1], box: 1 },
};

export const DIFFICULTY = [
  { name: 'Easy', react: 0.95, aim: 5.5, turn: 3.2, build: 0.25, heal: 0.6, vision: 90, burst: 0.55 },
  { name: 'Normal', react: 0.6, aim: 3.0, turn: 5.5, build: 0.6, heal: 0.85, vision: 120, burst: 0.8 },
  { name: 'Hard', react: 0.33, aim: 1.7, turn: 8.5, build: 1.0, heal: 1, vision: 150, burst: 1 },
];

export const STORM_SPEEDS = { slow: 1.35, normal: 1, fast: 0.7 };

export const SERVER_TICK = 1 / 30;

export const BOT_NAMES_A = [
  'Pixel', 'Turbo', 'Sneaky', 'Lucky', 'Frosty', 'Mighty', 'Rapid', 'Cosmic', 'Silent', 'Crispy',
  'Salty', 'Brave', 'Jolly', 'Zippy', 'Rusty', 'Fuzzy', 'Captain', 'Doctor', 'Sir', 'Agent',
  'Sparky', 'Chunky', 'Wobbly', 'Grumpy', 'Clever', 'Swift', 'Stormy', 'Noodle', 'Waffle', 'Pickle',
];
export const BOT_NAMES_B = [
  'Panda', 'Builder', 'Llama', 'Moose', 'Otter', 'Falcon', 'Taco', 'Badger', 'Walrus', 'Gecko',
  'Ninja', 'Viking', 'Pilot', 'Wizard', 'Ranger', 'Penguin', 'Beaver', 'Cobra', 'Yeti', 'Toast',
  'Squid', 'Rocket', 'Hammer', 'Bean', 'Muffin', 'Raptor', 'Koala', 'Sloth', 'Shark', 'Potato',
];

export const OUTFIT_COLORS = [
  '#e8573f', '#3b82d6', '#f2b233', '#4fae57', '#8a5ad8', '#e26fae', '#2fb3b3', '#f07c2a',
  '#5b6573', '#d8d4c8', '#1f3a5f', '#b83b5e', '#6d9c3e', '#c79a5b', '#2d2d38', '#ffd23f',
];
export const SKIN_TONES = ['#f2c7a5', '#e0ac85', '#c68b62', '#a26a45', '#7b4a2e', '#f5d6c0'];
