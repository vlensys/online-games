// Storm Royale entry: boot, menus, sessions (solo / host / join), main loop.
import { VERSION, LOOT_MODES } from './core/config.js';
import { randomSeed, clamp } from './core/rng.js';
import { generateMap } from './core/mapgen.js';
import { World } from './core/world.js';
import { generateFloorLoot } from './core/items.js';
import { Renderer, webglAvailable } from './client/render.js';
import { Hud, fmtTime } from './client/hud.js';
import { Input } from './client/input.js';
import { Touch } from './client/touch.js';
import { Sfx } from './client/audio.js';
import { Game } from './client/game.js';
import { ServerRunner, LocalLink } from './sim/runner.js';
import { loadSettings, saveSettings } from './ui/settings.js';
import { HostNet, joinGame, netMode } from './net/net.js';
import { preventPageZoom } from './ui/nozoom.js';

preventPageZoom();

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';
const TS = DEBUG ? clamp(+params.get('timescale') || 1, 0.1, 20) : 1;

const app = {
  settings: loadSettings(),
  renderer: null,
  hud: null,
  input: null,
  touch: null,
  sfx: new Sfx(),
  game: null,
  session: null,
  screen: 'main',
  prevScreen: 'main',
  touchMode: false,
  menuSeed: randomSeed(),
  fpsHist: [],
};
window.__stormApp = app;

function isMobileUA() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
}

// ------------------------------------------------------------------ boot
function fatal(msg) {
  $('fatalText').textContent = msg;
  $('fatal').classList.remove('hidden');
  $('menu').classList.add('hidden');
}

function boot() {
  if (!webglAvailable()) {
    fatal('Your browser or device could not start WebGL 3D graphics. Try updating the browser, enabling hardware acceleration, or another device.');
    return;
  }
  try {
    const q = params.get('quality') || app.settings.quality;
    app.renderer = new Renderer($('view'), q, isMobileUA());
  } catch (e) {
    console.error(e);
    fatal('3D graphics failed to start (' + (e.message || e) + ').');
    return;
  }
  app.renderer.onContextLost = () => toast('Graphics were interrupted - recovering\u2026', 4);
  app.renderer.onContextRestored = () => toast('Graphics restored', 2);
  app.hud = new Hud();
  app.input = new Input($('view'));
  app.touch = new Touch($('touch'));
  app.sfx.setVolume(app.settings.volume);
  app.input.onDesktop = () => setTouchMode(false);
  app.touch.onTouch = () => setTouchMode(true);
  app.input.onUnlock = () => {
    if (app.game && !app.touchMode && !app.game.result && !app.game.mapOpen && $('results').classList.contains('hidden')) showPause(true);
  };
  app.input.onLock = () => showPause(false);
  if (isMobileUA()) setTouchMode(true);
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  document.addEventListener('pointerdown', () => app.sfx.unlock(), { capture: true });
  document.addEventListener('keydown', () => app.sfx.unlock(), { capture: true });
  setupMenus();
  menuBackdrop();
  requestAnimationFrame(loop);
  if (DEBUG && params.get('autostart') === '1') startSolo();
}

function setTouchMode(on) {
  if (app.touchMode === on) return;
  app.touchMode = on;
  document.body.classList.toggle('touch', on);
  updateTouchUi();
}

function updateTouchUi() {
  const inGame = !!app.game;
  $('touch').classList.toggle('hidden', !(inGame && app.touchMode));
  if (!app.touchMode) app.touch.reset();
  onResize();
}

function onResize() {
  if (app.renderer) app.renderer.resize();
  const portrait = window.innerHeight > window.innerWidth * 1.05;
  $('rotate').classList.toggle('hidden', !(app.game && app.touchMode && portrait));
}

// ------------------------------------------------------------------ menu backdrop
function menuBackdrop() {
  const map = generateMap(app.menuSeed);
  const world = new World(map);
  const loot = generateFloorLoot(map, 1, 'normal');
  app.renderer.buildWorld(map, world, loot);
  app.renderer.views.items.set(new Map(loot.items.map((i) => [i.id, i])));
  app.menuMap = map;
  app.menuT = 0;
}

function menuFrame(dt) {
  const R = app.renderer;
  if (!R || !R.views) return;
  app.menuT += dt;
  // the backdrop only needs ~30 fps (keeps laptops cool in menus)
  app.menuAcc = (app.menuAcc || 0) + dt;
  if (app.menuAcc < 1 / 31) return;
  dt = app.menuAcc;
  app.menuAcc = 0;
  const a = app.menuT * 0.04;
  const cam = R.camera;
  cam.position.set(Math.cos(a) * 330, 150, Math.sin(a) * 330);
  cam.lookAt(Math.cos(a + 0.9) * 60, 10, Math.sin(a + 0.9) * 60);
  cam.fov = 55;
  cam.updateProjectionMatrix();
  R.views.chars.begin();
  R.views.chars.end();
  R.views.items.update(app.menuT, cam.position.x, cam.position.z);
  R.views.storm.update({ cx: 0, cz: 0, r: 2000 }, app.menuT);
  R.frame(dt, app.menuT);
}

// ------------------------------------------------------------------ main loop
let last = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
  last = t;
  try {
    if (app.game) app.game.frame(dt);
    else menuFrame(dt);
  } catch (e) {
    console.error(e);
  }
}

function onFps(fps) {
  if (app.settings.quality !== 'auto' || params.get('quality')) return;
  if (performance.now() < (app.fpsIgnoreUntil || 0) || document.hidden) return; // loading hitches
  const h = app.fpsHist;
  h.push(fps);
  if (h.length > 6) h.shift();
  if (h.length < 6) return;
  const avg = h.reduce((a, b) => a + b, 0) / h.length;
  const R = app.renderer;
  if (avg < 34 && R.q !== 'low') {
    R.applyQuality(R.q === 'high' ? 'medium' : 'low');
    h.length = 0;
    toast('Graphics lowered to ' + R.q.toUpperCase() + ' for smoother play');
  } else if (avg < 24 && R.q === 'low' && !app.lowered) {
    app.lowered = true;
    R.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1) * 0.55);
    R.resize();
    h.length = 0;
  }
}

let toastT = 0;
function toast(text, dur = 2.5) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.add('hidden'), dur * 1000);
}

// ------------------------------------------------------------------ screens
function show(name) {
  for (const s of document.querySelectorAll('#menu .screen')) s.classList.add('hidden');
  const el = $('menu' + name[0].toUpperCase() + name.slice(1));
  if (el) el.classList.remove('hidden');
  if (name !== 'settings' && name !== 'controls') app.prevScreen = name;
  app.screen = name;
  $('menu').classList.remove('hidden');
}

function hideMenu() {
  $('menu').classList.add('hidden');
}

function playerName() {
  let n = ($('playerName').value || '').trim().slice(0, 16);
  if (!n) n = 'Player' + Math.floor(100 + Math.random() * 900);
  return n;
}

function setupMenus() {
  const S = app.settings;
  $('playerName').value = S.name || '';
  $('joinName').value = S.name || '';
  for (const id of ['playerName', 'joinName']) {
    $(id).addEventListener('input', () => {
      S.name = $(id).value.trim().slice(0, 16);
      $(id === 'playerName' ? 'joinName' : 'playerName').value = $(id).value;
      saveSettings(S);
    });
  }
  for (const b of document.querySelectorAll('[data-go]')) {
    b.addEventListener('click', () => {
      app.sfx.ui();
      const go = b.dataset.go;
      if (go === 'back') {
        if (app.fromPause) {
          app.fromPause = false;
          hideMenu();
          showPause(true);
        } else show(app.prevScreen || 'main');
      } else if (go === 'host') openHost();
      else if (go === 'join') openJoin();
      else show(go);
    });
  }
  // solo
  const bindRange = (id, valId, get, set) => {
    const el = $(id);
    el.value = get();
    $(valId).textContent = el.value;
    el.addEventListener('input', () => {
      $(valId).textContent = el.value;
      set(el.value);
      saveSettings(S);
    });
  };
  bindRange('soloBots', 'soloBotsVal', () => S.solo.bots, (v) => (S.solo.bots = +v));
  const bindSel = (id, get, set) => {
    const el = $(id);
    el.value = String(get());
    el.addEventListener('change', () => {
      set(el.value);
      saveSettings(S);
      if (id.startsWith('host')) pushHostCfg();
    });
  };
  bindSel('soloDiff', () => S.solo.diff, (v) => (S.solo.diff = +v));
  bindSel('soloLoot', () => S.solo.loot, (v) => (S.solo.loot = v));
  bindSel('soloStorm', () => S.solo.storm, (v) => (S.solo.storm = v));
  $('soloStart').addEventListener('click', () => startSolo());
  // host
  bindRange('hostBots', 'hostBotsVal', () => S.host.bots, (v) => {
    S.host.bots = +v;
    pushHostCfg();
  });
  bindSel('hostLoot', () => S.host.loot, (v) => (S.host.loot = v));
  bindSel('hostMax', () => S.host.max, (v) => (S.host.max = +v));
  bindSel('hostDiff', () => S.host.diff, (v) => (S.host.diff = +v));
  bindSel('hostStorm', () => S.host.storm, (v) => (S.host.storm = v));
  $('hostPw').value = S.host.pw;
  $('hostPw').addEventListener('input', () => {
    S.host.pw = $('hostPw').value.slice(0, 32);
    saveSettings(S);
    pushHostCfg();
  });
  $('hostShow').addEventListener('click', () => {
    S.streamer = !S.streamer;
    saveSettings(S);
    $('setStreamer').checked = S.streamer;
    renderHostAddr();
  });
  $('hostAddr').addEventListener('click', () => {
    S.streamer = !S.streamer;
    saveSettings(S);
    renderHostAddr();
  });
  $('hostCopy').addEventListener('click', () => {
    const a = app.session && app.session.address;
    if (!a) return;
    const done = () => toast('Address copied');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(a).then(done, () => fallbackCopy(a));
    else fallbackCopy(a);
  });
  $('hostRetry').addEventListener('click', () => {
    if (app.session && app.session.kind === 'host') startHostNet(app.session);
  });
  $('hostStart').addEventListener('click', () => {
    mobileFullscreen();
    if (app.session && app.session.kind === 'host') app.session.link.send({ t: 'hc', a: 'start' }), app.session.link.flush();
  });
  $('hostBack').addEventListener('click', () => {
    endSession();
    show('main');
  });
  // advanced
  const adv = [
    ['advPeer', 'peer'],
    ['advTurn', 'turn'],
    ['advTurnUser', 'turnUser'],
    ['advTurnPass', 'turnPass'],
  ];
  for (const [id, k] of adv) {
    for (const el of [$(id), $(id + '2')]) {
      el.value = S.adv[k] || '';
      el.addEventListener('change', () => {
        S.adv[k] = el.value.trim();
        saveSettings(S);
        $(id).value = S.adv[k];
        $(id + '2').value = S.adv[k];
      });
    }
  }
  // join
  $('joinAddr').value = S.join.addr || '';
  $('joinGo').addEventListener('click', () => doJoin());
  $('lobbyLeave').addEventListener('click', () => {
    endSession();
    show('main');
  });
  // settings
  const setR = (id, key, fmt) => {
    const el = $(id);
    el.value = S[key];
    const upd = () => ($(id + 'Val').textContent = fmt(+el.value));
    upd();
    el.addEventListener('input', () => {
      S[key] = +el.value;
      upd();
      saveSettings(S);
      if (key === 'volume') app.sfx.setVolume(S.volume);
    });
  };
  setR('setSens', 'sens', (v) => v.toFixed(2));
  setR('setAds', 'adsSens', (v) => v.toFixed(2));
  setR('setTouch', 'touchSens', (v) => v.toFixed(2));
  setR('setFov', 'fov', (v) => v + '°');
  setR('setVol', 'volume', (v) => Math.round(v * 100) + '%');
  $('setQuality').value = S.quality;
  $('setQuality').addEventListener('change', () => {
    S.quality = $('setQuality').value;
    saveSettings(S);
    if (S.quality !== 'auto') app.renderer.applyQuality(S.quality);
  });
  const setC = (id, key, cb) => {
    const el = $(id);
    el.checked = !!S[key];
    el.addEventListener('change', () => {
      S[key] = el.checked;
      saveSettings(S);
      if (cb) cb();
    });
  };
  setC('setInvert', 'invertY');
  setC('setFps', 'showFps', () => $('fps').classList.toggle('hidden', !S.showFps));
  setC('setAutoFire', 'autoFire');
  setC('setStreamer', 'streamer', () => renderHostAddr());
  $('fps').classList.toggle('hidden', !S.showFps);
  $('setDone').addEventListener('click', () => {
    if (app.fromPause) {
      app.fromPause = false;
      hideMenu();
      showPause(true);
    } else show(app.prevScreen || 'main');
  });
  // pause
  $('pauseResume').addEventListener('click', () => resume());
  $('pauseSettings').addEventListener('click', () => {
    showPause(false);
    app.fromPause = true;
    show('settings');
  });
  $('pauseControls').addEventListener('click', () => {
    showPause(false);
    app.fromPause = true;
    show('controls');
  });
  $('pauseLeave').addEventListener('click', () => {
    showPause(false);
    leaveMatch();
  });
  // results
  $('resSpectate').addEventListener('click', () => {
    $('results').classList.add('hidden');
    if (!app.touchMode) app.input.lock();
  });
  $('resAgain').addEventListener('click', () => playAgain());
  $('resMenu').addEventListener('click', () => leaveMatch());
  $('fullmap').addEventListener('pointerdown', () => app.game && app.game.toggleMap(false));
  $('view').addEventListener('click', () => {
    if (app.game && !app.touchMode && !app.input.locked && $('pause').classList.contains('hidden') && $('results').classList.contains('hidden')) app.input.lock();
  });
  show('main');
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast('Address copied');
  } catch (e) {
    toast('Copy failed - select the address manually');
  }
  ta.remove();
}

function showPause(on) {
  if (!app.game && on) return;
  $('pause').classList.toggle('hidden', !on);
  if (on) {
    const k = app.session && app.session.kind;
    $('pauseSub').textContent = k === 'solo' ? 'The match keeps running.' : k === 'host' ? 'You are hosting: leaving ends the match for everyone.' : 'Online match - the game keeps running.';
  }
}

function resume() {
  showPause(false);
  if (!app.touchMode) app.input.lock();
}

// ------------------------------------------------------------------ sessions
function soloConfig() {
  const S = app.settings.solo;
  const bots = DEBUG && params.get('bots') ? clamp(+params.get('bots'), 0, 63) : S.bots;
  return {
    bots,
    diff: DEBUG && params.get('diff') ? clamp(+params.get('diff'), 0, 2) : S.diff,
    loot: S.loot,
    storm: DEBUG && params.get('storm') ? params.get('storm') : S.storm,
    max: 1,
    pw: '',
    solo: true,
    debug: DEBUG,
    ts: TS,
    seed: DEBUG && params.get('seed') ? +params.get('seed') : app.menuSeed,
  };
}

// Phones: go fullscreen + landscape when a match starts (needs the user's tap; ignored if unsupported)
function mobileFullscreen() {
  if (!app.touchMode || document.fullscreenElement) return;
  try {
    const el = document.documentElement;
    const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : null;
    if (p && p.then)
      p.then(() => {
        try {
          const o = screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape');
          if (o && o.catch) o.catch(() => {});
        } catch (e) {
          /* ignore */
        }
      }).catch(() => {});
  } catch (e) {
    /* ignore */
  }
}

function startSolo() {
  mobileFullscreen();
  endSession();
  loading('Starting match...');
  const runner = new ServerRunner(soloConfig());
  const link = new LocalLink(runner, 0);
  const session = { kind: 'solo', runner, link };
  app.session = session;
  link.onMessages = (msgs) => sessionMsgs(session, msgs);
  link.send({ t: 'hello', v: VERSION, name: playerName(), outfit: null });
  link.flush();
}

// Messages before a Game exists (lobby, start...)
function sessionMsgs(session, msgs) {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.t === 'start') {
      // buffer everything until the Game object exists and takes over the link
      session.buffer = msgs.slice(i + 1);
      session.link.onMessages = (more) => session.buffer.push(...more);
      startGame(session, m);
      return;
    }
    if (m.t === 'welcome') session.me = m.id;
    else if (m.t === 'lobby') onLobby(session, m);
    else if (m.t === 'rej') onRejected(session, m.r);
  }
}

function loading(text) {
  show('loading');
  $('loadingText').textContent = text;
}

function startGame(session, m) {
  loading('Building the island...');
  // let the loading screen paint first
  setTimeout(() => {
    if (app.session !== session) return;
    try {
      if (app.game) app.game.destroy();
      $('results').classList.add('hidden');
      app.game = new Game({
        renderer: app.renderer,
        hud: app.hud,
        input: app.input,
        touch: app.touch,
        sfx: app.sfx,
        settings: app.settings,
        link: session.link,
        start: m,
        ts: TS,
        isTouch: () => app.touchMode,
        inputBlocked: () => !$('pause').classList.contains('hidden') || !$('menu').classList.contains('hidden'),
        onResults: (r) => showResults(r),
        onPause: () => {
          if (!$('pause').classList.contains('hidden')) return resume();
          if (!app.touchMode) app.input.unlock();
          showPause(true);
        },
        onLobby: (lm) => backToLobby(session, lm),
        onDisconnect: (why) => onDisconnected(session, why),
        onFps,
      });
      app.fpsHist.length = 0;
      app.fpsIgnoreUntil = performance.now() + 6000;
      if (session.buffer && session.buffer.length) app.game.onNet(session.buffer);
      session.buffer = null;
      hideMenu();
      app.hud.show(true);
      app.input.active = true;
      updateTouchUi();
      if (!app.touchMode) app.input.lock();
    } catch (e) {
      console.error(e);
      toast('Could not start the match: ' + (e.message || e), 5);
      endSession();
      show('main');
    }
  }, 30);
}

function showResults(r) {
  const s = app.session;
  $('resPlace').textContent = '#' + r.place;
  $('resTitle').textContent = r.win ? 'STORM CHAMPION' : r.final ? 'MATCH OVER' : 'ELIMINATED';
  $('resSub').textContent =
    r.sub + (r.final && r.winner && !r.win ? ' - ' + r.winner + ' won the match' : '') + (s.kind === 'host' && !r.final ? '. You are hosting - stay (spectate) so the match keeps running.' : '');
  $('resKills').textContent = r.kills;
  $('resDmg').textContent = Math.round(r.dmg);
  $('resTime').textContent = fmtTime(r.time);
  const top = $('resTop');
  top.innerHTML = '';
  for (const t of r.top) {
    const li = document.createElement('li');
    li.textContent = `${t.name} - ${t.kills} elim${t.kills === 1 ? '' : 's'}`;
    li.value = t.place;
    if (t.me) li.className = 'me';
    top.appendChild(li);
  }
  $('resSpectate').classList.toggle('hidden', r.final || r.win);
  const again = $('resAgain');
  if (s.kind === 'solo') {
    again.textContent = 'PLAY AGAIN';
    again.classList.remove('hidden');
  } else if (s.kind === 'host') {
    again.textContent = 'BACK TO LOBBY';
    again.classList.toggle('hidden', !r.final);
  } else again.classList.add('hidden');
  $('resMenu').textContent = s.kind === 'client' ? 'LEAVE' : 'MAIN MENU';
  $('results').classList.remove('hidden');
  app.input.unlock();
}

function playAgain() {
  $('results').classList.add('hidden');
  const s = app.session;
  if (s && s.kind === 'host') {
    s.link.send({ t: 'hc', a: 'lobby' });
    s.link.flush();
    return;
  }
  leaveGameOnly();
  startSolo();
}

function leaveGameOnly() {
  if (app.game) {
    app.game.destroy();
    app.game = null;
  }
  app.input.active = false;
  app.input.unlock();
  app.hud.show(false);
  $('results').classList.add('hidden');
  $('pause').classList.add('hidden');
  updateTouchUi();
}

function leaveMatch() {
  leaveGameOnly();
  endSession();
  menuBackdrop();
  show('main');
}

function endSession() {
  const s = app.session;
  app.session = null;
  if (!s) return;
  try {
    if (s.net) s.net.close();
    if (s.link && s.link.close) s.link.close();
    if (s.runner) s.runner.stop();
  } catch (e) {
    console.warn(e);
  }
}

function backToLobby(session, m) {
  leaveGameOnly();
  menuBackdrop();
  if (session.kind === 'host') {
    show('host');
    onLobby(session, m);
  } else {
    show('lobby');
    onLobby(session, m);
  }
  session.link.onMessages = (msgs) => sessionMsgs(session, msgs);
}

function onDisconnected(session, why) {
  if (app.session !== session) return;
  const text = why === 'kicked' ? 'You were removed from the game by the host.' : 'Connection to the host was lost.';
  leaveGameOnly();
  endSession();
  menuBackdrop();
  show('main');
  toast(text, 5);
}

function onRejected(session, r) {
  const msgs = {
    password: 'Wrong password.',
    started: 'That match has already started.',
    full: 'The game is full.',
    version: 'The host runs a different game version. Reload the page.',
    kicked: 'You were removed from the lobby.',
  };
  const text = msgs[r] || 'Connection refused (' + r + ').';
  if (session.kind === 'client') {
    endSession();
    show('join');
    joinStatus(text, 'err');
  } else toast(text, 4);
}

// ------------------------------------------------------------------ hosting & joining
function hostConfig() {
  const H = app.settings.host;
  return { bots: H.bots, diff: H.diff, loot: H.loot, storm: H.storm, max: H.max, pw: H.pw, solo: false, debug: DEBUG, ts: TS, seed: 0 };
}

function pushHostCfg() {
  const s = app.session;
  if (!s || s.kind !== 'host') return;
  const H = app.settings.host;
  s.link.send({ t: 'hc', a: 'cfg', cfg: { bots: H.bots, diff: H.diff, loot: H.loot, storm: H.storm, max: H.max, pw: H.pw } });
  s.link.flush();
}

function renderHostAddr() {
  const s = app.session;
  const a = s && s.address;
  const el = $('hostAddr');
  if (!a) {
    el.textContent = s && s.addrError ? 'unavailable' : 'starting…';
    return;
  }
  const dots = (n) => '•'.repeat(n);
  const masked = /^\d+\.\d+\.\d+\.\d+:\d+$/.test(a) ? [dots(3), dots(3), dots(3), dots(3)].join('.') + ':' + dots(5) : dots(4) + '-' + dots(4);
  el.textContent = app.settings.streamer ? masked : a;
  $('hostShow').textContent = app.settings.streamer ? 'SHOW' : 'HIDE';
}

function openHost() {
  endSession();
  show('host');
  const runner = new ServerRunner(hostConfig());
  const link = new LocalLink(runner, 0);
  const session = { kind: 'host', runner, link, address: '' };
  app.session = session;
  link.onMessages = (msgs) => sessionMsgs(session, msgs);
  link.send({ t: 'hello', v: VERSION, name: playerName() });
  link.flush();
  renderLobby(session, { ps: [], cfg: {} });
  startHostNet(session);
}

function startHostNet(session) {
  if (session.net) session.net.close();
  session.address = '';
  session.addrError = false;
  $('hostRetry').classList.add('hidden');
  $('hostStatus').textContent = 'Opening server…';
  $('hostStatus').className = 'addr-status';
  renderHostAddr();
  session.net = new HostNet(session.runner, app.settings.adv, {
    onAddress: (addr, info) => {
      if (app.session !== session) return;
      session.address = addr;
      renderHostAddr();
      $('hostStatus').textContent = info;
    },
    onError: (msg) => {
      if (app.session !== session) return;
      session.addrError = true;
      renderHostAddr();
      $('hostStatus').textContent = msg;
      $('hostStatus').className = 'addr-status err';
      $('hostRetry').classList.remove('hidden');
    },
  });
}

function onLobby(session, m) {
  session.lobby = m;
  if (session.kind === 'host') renderLobby(session, m);
  else {
    const c = m.cfg || {};
    $('lobbyInfo').textContent = `${c.bots} bots · ${LOOT_MODES[c.loot] ? LOOT_MODES[c.loot].name : ''} loot · ${['Easy', 'Normal', 'Hard'][c.diff] || ''} bots · max ${c.max} players`;
    const ul = $('clientLobby');
    ul.innerHTML = '';
    for (const p of m.ps) {
      const li = document.createElement('li');
      li.textContent = p.n;
      if (p.h) {
        const t = document.createElement('span');
        t.className = 'tag';
        t.textContent = 'HOST';
        li.appendChild(t);
      }
      ul.appendChild(li);
    }
  }
}

function renderLobby(session, m) {
  const ul = $('hostLobby');
  ul.innerHTML = '';
  $('hostCount').textContent = m.ps.length + ' / ' + app.settings.host.max;
  for (const p of m.ps) {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.textContent = p.n;
    li.appendChild(n);
    if (p.h) {
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = 'HOST';
      li.appendChild(t);
    } else {
      const k = document.createElement('button');
      k.className = 'btn tiny ghost';
      k.textContent = 'KICK';
      k.addEventListener('click', () => {
        session.link.send({ t: 'hc', a: 'kick', id: p.id });
        session.link.flush();
      });
      li.appendChild(k);
    }
    ul.appendChild(li);
  }
}

function openJoin() {
  endSession();
  show('join');
  joinStatus('');
}

function joinStatus(text, cls = '') {
  const el = $('joinStatus');
  el.textContent = text;
  el.className = 'status ' + cls;
}

async function doJoin() {
  const addr = $('joinAddr').value.trim();
  const pw = $('joinPw').value;
  if (!addr) {
    joinStatus('Enter the server address from the host.', 'err');
    return;
  }
  app.settings.join.addr = addr;
  saveSettings(app.settings);
  endSession();
  joinStatus('Connecting…');
  $('joinGo').disabled = true;
  const session = { kind: 'client' };
  app.session = session;
  try {
    const link = await joinGame(addr, app.settings.adv, (s) => joinStatus(s));
    if (app.session !== session) {
      link.close();
      return;
    }
    session.link = link;
    session.net = link;
    link.onMessages = (msgs) => sessionMsgs(session, msgs);
    link.onClose = () => {
      if (app.session === session && !app.game) {
        endSession();
        show('join');
        joinStatus('Disconnected from the host.', 'err');
      } else if (app.game) onDisconnected(session, 'lost');
    };
    link.send({ t: 'hello', v: VERSION, name: playerName(), pw });
    link.flush();
    joinStatus('Connected. Joining lobby…', 'ok');
    const wait = setTimeout(() => {
      if (app.session === session && !session.me) {
        endSession();
        joinStatus('The host did not answer. Try again.', 'err');
      }
    }, 10000);
    const orig = link.onMessages;
    link.onMessages = (msgs) => {
      for (const m of msgs)
        if (m.t === 'welcome') {
          clearTimeout(wait);
          session.me = m.id;
          show('lobby');
        }
      orig(msgs);
    };
  } catch (e) {
    if (app.session === session) {
      app.session = null;
      joinStatus(String(e.message || e), 'err');
    }
  } finally {
    $('joinGo').disabled = false;
  }
}

void netMode;
boot();
