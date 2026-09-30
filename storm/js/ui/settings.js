// Settings persisted in localStorage (every access wrapped: storage may be blocked).
const KEY = 'stormroyale.settings.v1';

export const DEFAULTS = {
  name: '',
  sens: 1,
  adsSens: 0.7,
  touchSens: 1.2,
  fov: 90,
  quality: 'auto',
  volume: 0.8,
  invertY: false,
  showFps: false,
  autoFire: false,
  streamer: false,
  solo: { bots: 24, diff: 1, loot: 'normal', storm: 'normal' },
  host: { pw: '', bots: 20, loot: 'normal', max: 8, diff: 1, storm: 'normal' },
  join: { addr: '' },
  adv: { peer: '', turn: '', turnUser: '', turnPass: '' },
};

function merge(base, extra) {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return extra === undefined || typeof extra !== typeof base ? base : extra;
  const out = { ...base };
  if (extra && typeof extra === 'object') for (const k of Object.keys(base)) out[k] = merge(base[k], extra[k]);
  return out;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return merge(DEFAULTS, JSON.parse(raw));
  } catch (e) {
    /* storage blocked */
  }
  return merge(DEFAULTS, {});
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (e) {
    /* ignore */
  }
}
