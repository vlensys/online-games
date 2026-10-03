// Settings, records, cup trophies and time-trial ghosts, kept in localStorage (every access is
// wrapped: storage can be blocked on school machines).
const KEY = 'turbokarts.settings.v1';
const REC = 'turbokarts.records.v1';

export const DEFAULTS = {
  name: '',
  driver: 'blaze',
  cls: 100,
  quality: 'auto',
  music: 0.5,
  sfx: 0.8,
  cam: 1,
  autoGas: true,
  showFps: false,
  streamer: false,
  quick: { track: 'meadow', laps: 3, racers: 8, items: true },
  tt: { track: 'meadow' },
  gp: { cup: 'sunrise' },
  host: { pw: '', track: 'meadow', laps: 3, bots: 5, items: true, cls: 100 },
  join: { addr: '' },
  adv: { peer: '', turn: '', turnUser: '', turnPass: '' },
};

function merge(base, extra) {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return extra === undefined || typeof extra !== typeof base ? base : extra;
  const out = { ...base };
  if (extra && typeof extra === 'object') for (const k of Object.keys(base)) out[k] = merge(base[k], extra[k]);
  return out;
}

function load(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function save(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
    return true;
  } catch (e) {
    return false;
  }
}

export function loadSettings() {
  return merge(DEFAULTS, load(KEY) || {});
}

export function saveSettings(s) {
  save(KEY, s);
}

export function loadRecords() {
  const r = load(REC) || {};
  r.tracks = r.tracks || {};
  r.cups = r.cups || {};
  return r;
}

export function saveRecords(r) {
  save(REC, r);
}

export function loadGhost(track) {
  return load('turbokarts.ghost.' + track);
}

export function saveGhost(track, g) {
  return save('turbokarts.ghost.' + track, g);
}
