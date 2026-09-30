// Persistent save data (localStorage, wrapped so private/blocked storage never breaks the game)
const KEY = 'slopeplus.save.v1';

const DEFAULTS = {
  best: { plus: 0, classic: 0 },
  gems: 0,
  owned: ['classic'],
  skin: 'classic',
  runs: 0,
  totalDistance: 0,
  hintsSeen: {},
  settings: {
    mode: 'plus',
    quality: 'auto',
    music: 0.5,
    sfx: 0.8,
    shake: true,
    showFps: false,
    sensitivity: 1.0,
  },
};

function merge(base, extra) {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return extra === undefined ? base : extra;
  }
  const out = { ...base };
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) out[k] = k in base ? merge(base[k], extra[k]) : extra[k];
  }
  return out;
}

export function loadSave() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return merge(DEFAULTS, {});
    return merge(DEFAULTS, JSON.parse(raw));
  } catch {
    return merge(DEFAULTS, {});
  }
}

export function writeSave(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable: progress just won't persist */
  }
}

export function resetSave() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
  return merge(DEFAULTS, {});
}
