// Shared constants: engine classes, drivers, items, points. No three.js here, so the race
// simulation also runs headless (tests) and on an online host.
export const VERSION = 1;
export const DT = 1 / 60;
export const GRAVITY = 30;
export const KART_R = 1.15; // collision radius between karts

// Engine classes: top speed (m/s), acceleration and how sharp the bots are
export const CLASSES = {
  50: { name: '50cc', top: 22, accel: 12, ai: 0.8, aiLine: 0.55, aiMiss: 0.06 },
  100: { name: '100cc', top: 26.5, accel: 14, ai: 0.9, aiLine: 0.8, aiMiss: 0.03 },
  150: { name: '150cc', top: 31, accel: 16, ai: 0.98, aiLine: 1, aiMiss: 0.012 },
};

// Drivers: colours for the kart and the driver, and stats from 1 to 5
export const DRIVERS = [
  { id: 'blaze', name: 'Blaze', body: '#e8412c', trim: '#2b2b33', suit: '#ffcf3a', helmet: '#f4f4f4', speed: 3, accel: 3, handling: 3, weight: 3 },
  { id: 'volt', name: 'Volt', body: '#ffd21f', trim: '#1d1d24', suit: '#2c63ff', helmet: '#ffd21f', speed: 4, accel: 2, handling: 3, weight: 3 },
  { id: 'frost', name: 'Frost', body: '#3fc6ff', trim: '#e9f6ff', suit: '#ffffff', helmet: '#7fd8ff', speed: 2, accel: 4, handling: 4, weight: 2 },
  { id: 'moss', name: 'Moss', body: '#38c85a', trim: '#16351f', suit: '#a66b3a', helmet: '#2f8f45', speed: 3, accel: 4, handling: 2, weight: 3 },
  { id: 'rook', name: 'Rook', body: '#3d3f4a', trim: '#ff6a1a', suit: '#24252c', helmet: '#ff6a1a', speed: 5, accel: 1, handling: 2, weight: 5 },
  { id: 'nova', name: 'Nova', body: '#b24cff', trim: '#f3e6ff', suit: '#ff5fb7', helmet: '#ffffff', speed: 3, accel: 3, handling: 4, weight: 2 },
  { id: 'pip', name: 'Pip', body: '#ff8fc8', trim: '#ffffff', suit: '#7a4cff', helmet: '#ffd6ec', speed: 1, accel: 5, handling: 5, weight: 1 },
  { id: 'tank', name: 'Tank', body: '#8a6a3c', trim: '#3a2c18', suit: '#4f6b3a', helmet: '#c9a36b', speed: 4, accel: 2, handling: 1, weight: 5 },
];

export function driverById(id) {
  return DRIVERS.find((d) => d.id === id) || DRIVERS[0];
}

// stat (1..5) -> multipliers
export function statFactors(d) {
  return {
    top: 1 + (d.speed - 3) * 0.022,
    accel: 1 + (d.accel - 3) * 0.13,
    turn: 1 + (d.handling - 3) * 0.07,
    grip: 1 + (d.handling - 3) * 0.08,
    mass: 1 + (d.weight - 3) * 0.22,
  };
}

// Grand Prix points for 1st, 2nd, ...
export const POINTS = [15, 12, 10, 8, 6, 4, 2, 1];

export const ITEMS = {
  nitro: { name: 'Nitro', uses: 1 },
  nitro3: { name: 'Triple Nitro', uses: 3 },
  rocket: { name: 'Rocket', uses: 1 },
  homing: { name: 'Homing Rocket', uses: 1 },
  oil: { name: 'Oil Slick', uses: 1 },
  shield: { name: 'Shield', uses: 1 },
  emp: { name: 'Shockwave', uses: 1 },
};

// Item odds by how far back you are (0 = leading, 1 = last)
export const ITEM_ODDS = [
  { upTo: 0.15, odds: { oil: 34, rocket: 34, nitro: 16, shield: 16 } },
  { upTo: 0.45, odds: { rocket: 26, oil: 14, nitro: 24, homing: 16, shield: 12, nitro3: 8 } },
  { upTo: 0.75, odds: { nitro: 22, nitro3: 18, homing: 26, rocket: 14, shield: 12, emp: 8 } },
  { upTo: 1.01, odds: { nitro3: 34, homing: 26, nitro: 18, emp: 12, shield: 10 } },
];

export const BOOST = {
  nitro: { t: 1.5, p: 1.32 },
  pad: { t: 1.1, p: 1.3 },
  start: { t: 1.4, p: 1.28 },
  trick: { t: 0.7, p: 1.22 },
  mini: [null, { t: 0.55, p: 1.22 }, { t: 1.0, p: 1.26 }, { t: 1.5, p: 1.3 }],
};
// drift charge needed for each mini-turbo level
export const DRIFT_LEVELS = [0, 0.9, 1.9, 3.0];

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function fmtTime(t) {
  if (!isFinite(t) || t < 0) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3);
}
