// Turbo Karts: menus, the game loop, and the glue between the race simulation and the 3D view.
import * as THREE from 'three';
import { Race, COUNTDOWN } from './core/race.js';
import { TRACKS, CUPS } from './core/tracks.js';
import { getTrack } from './core/trackgeo.js';
import { DRIVERS, CLASSES, POINTS, driverById, ordinal, fmtTime, DT } from './core/config.js';
import { applyHit } from './core/items.js';
import { initBot } from './core/ai.js';
import { buildWorld } from './client/scene.js';
import { KartView, ItemViews } from './client/karts.js';
import { Fx } from './client/fx.js';
import { ChaseCam } from './client/camera.js';
import { Input, TouchControls } from './client/input.js';
import { Hud, esc } from './client/hud.js';
import { GameAudio } from './client/audio.js';
import { THEMES } from './client/themes.js';
import { loadSettings, saveSettings, loadRecords, saveRecords, loadGhost, saveGhost } from './ui/settings.js';
import { preventPageZoom } from './ui/nozoom.js';
import { Online } from './net/online.js';

const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const S = loadSettings();
if (Q.get('quality')) S.quality = Q.get('quality');
const REC = loadRecords();
preventPageZoom();

// ------------------------------------------------------------------ renderer
function resolveQuality(q) {
  if (q !== 'auto') return q;
  const mobile = /Android|iPhone|iPad|iPod|Mobile|CrOS/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
  const cores = navigator.hardwareConcurrency || 4;
  return mobile || cores <= 4 ? 'low' : 'medium';
}
let quality = resolveQuality(S.quality);
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance' });
let pixelRatio = Math.min(window.devicePixelRatio || 1, quality === 'high' ? 1.75 : quality === 'medium' ? 1.25 : 1);
renderer.setPixelRatio(pixelRatio);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.2, 2600);
camera.position.set(0, 30, 60);
function applyShadows() {
  renderer.shadowMap.enabled = quality === 'high' || quality === 'medium';
  renderer.shadowMap.type = quality === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
}
applyShadows();
function resize() {
  const w = innerWidth,
    h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (G && G.fx) G.fx.setScale(h * pixelRatio);
}
addEventListener('resize', resize);

// ------------------------------------------------------------------ shared objects
const input = new Input();
const audio = new GameAudio();
audio.setVolumes(S.music, S.sfx);
const hud = new Hud();
let touchUi = null;
const unlock = () => {
  const first = !audio.ctx;
  audio.unlock();
  // the first click / key press is when the browser lets us play sound: start the music then
  if (first && audio.ctx && G) audio.startMusic(THEMES[G.race.T.def.theme].music, TRACKS.findIndex((t) => t.id === G.race.T.id) + 1);
};
addEventListener('pointerdown', unlock);
addEventListener('keydown', unlock);
addEventListener(
  'touchstart',
  () => {
    if (document.body.classList.contains('touch')) return;
    document.body.classList.add('touch');
    input.touchOn = true;
    if (!touchUi) touchUi = new TouchControls($('touch'), input);
    setTouchVisible();
  },
  { passive: true },
);
document.body.classList.toggle('autogas', !!S.autoGas);
function setTouchVisible() {
  const racing = G && G.kind !== 'attract' && !paused && $('results').classList.contains('hidden');
  $('touch').classList.toggle('hidden', !(document.body.classList.contains('touch') && racing));
}

let G = null; // the running game
let session = null; // what we're playing: gp / quick / tt / online
let paused = false;
let timeScale = +(Q.get('timescale') || 1);

// ------------------------------------------------------------------ starting / stopping a race
function disposeGame() {
  if (!G) return;
  G.world.dispose();
  for (const v of G.views) v.dispose();
  if (G.ghostView) G.ghostView.dispose();
  G.items.dispose();
  scene.remove(G.fx.sparks.points, G.fx.smoke.points);
  G = null;
}

// setup: Race setup; opts: { kind, ghost, meIdx }
function startGame(setup, opts = {}) {
  disposeGame();
  paused = false;
  const show = opts.kind !== 'attract';
  if (show) $('loading').classList.remove('hidden');
  return new Promise((resolve) => {
    setTimeout(() => {
      const race = new Race(setup);
      const world = buildWorld(scene, race.T, quality);
      world.setRace(race);
      const me = opts.meIdx !== undefined ? race.karts[opts.meIdx] : race.player;
      const online = opts.kind === 'host' || opts.kind === 'client';
      const views = race.karts.map((k) => new KartView(scene, k, { shadows: renderer.shadowMap.enabled, tag: online && k.human && k !== me ? k.name : null }));
      const fx = new Fx(scene, quality);
      const g = (G = {
        race,
        world,
        views,
        fx,
        items: new ItemViews(scene),
        cam: new ChaseCam(camera),
        me,
        kind: opts.kind || 'quick',
        acc: 0,
        t: 0,
        prev: race.karts.map((k) => ({ x: k.x, y: k.y, z: k.z, yaw: k.yaw })),
        lastCount: 99,
        follow: 0,
        followT: 0,
        rec: [],
        ghost: opts.ghost || null,
        resultsShown: false,
        net: opts.net || null,
      });
      g.cam.distMul = S.cam;
      fx.setScale(innerHeight * pixelRatio);
      if (g.ghost) {
        g.ghostView = new KartView(scene, { driver: g.ghost.driver || 'blaze' }, { ghost: true });
        g.ghostView.setVisible(false);
      }
      if (me && Q.get('auto')) {
        me.auto = true;
        initBot(me, race);
      }
      hud.setTrack(race.T);
      hud.show(show);
      $('menu').classList.toggle('hidden', show);
      $('results').classList.add('hidden');
      $('pause').classList.add('hidden');
      const th = THEMES[race.T.def.theme];
      audio.startMusic(th.music, TRACKS.findIndex((t) => t.id === race.T.id) + 1);
      audio.musicFast(false);
      $('loading').classList.add('hidden');
      setTouchVisible();
      resize();
      resolve(g);
    }, 30);
  });
}

// ------------------------------------------------------------------ the loop
let last = performance.now();
let fpsAcc = 0,
  fpsN = 0,
  fps = 0,
  slowT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 0.5) {
    fps = Math.round(fpsN / fpsAcc);
    fpsAcc = fpsN = 0;
    adaptResolution(fps);
  }
  const ctl = input.read(document.body.classList.contains('touch') && S.autoGas);
  if (!G) {
    renderer.render(scene, camera);
    return;
  }
  if (ctl.pause && G.kind !== 'attract' && $('results').classList.contains('hidden')) togglePause();
  const race = G.race;
  if (!paused || G.net) {
    G.acc += dt * timeScale;
    let steps = 0;
    while (G.acc >= DT && steps < 8) {
      const me = G.me;
      if (me && !me.auto && !paused) {
        // keys are all-or-nothing: ease the wheel in (and out a little faster) so steering isn't twitchy
        const want = ctl.steer;
        const cur = me.in.steer || 0;
        const rate = (Math.abs(want) > Math.abs(cur) && Math.sign(want) === Math.sign(cur || want) ? 7 : 12) * DT;
        me.in.steer = Math.abs(want - cur) <= rate ? want : cur + Math.sign(want - cur) * rate;
        // auto-accelerate waits for GO (holding the gas through the countdown stalls you)
        me.in.gas = race.state === 'countdown' && ctl.gasAuto ? 0 : ctl.gas;
        me.in.brake = ctl.brake;
        me.in.drift = ctl.drift;
        me.in.item = ctl.item;
        me.in.back = ctl.backThrow;
      } else if (me && !me.auto) me.in = { steer: 0, gas: 0, brake: 0, drift: false, item: false, back: false };
      for (let i = 0; i < race.karts.length; i++) {
        const k = race.karts[i],
          p = G.prev[i];
        p.x = k.x;
        p.y = k.y;
        p.z = k.z;
        p.yaw = k.yaw;
      }
      if (G.net) G.net.beforeStep(race);
      race.step();
      if (G.net) G.net.afterStep(race);
      onEvents(race.ev);
      race.ev.length = 0;
      if (G.kind === 'tt' && race.state === 'race' && G.me && !G.me.finished && Math.round(race.time / DT) % 6 === 0) G.rec.push([+G.me.x.toFixed(2), +G.me.y.toFixed(2), +G.me.z.toFixed(2), +G.me.yaw.toFixed(3)]);
      G.acc -= DT;
      steps++;
      if (!G) return;
    }
    if (steps === 8) G.acc = 0;
  }
  render(dt, G.acc / DT, ctl);
}
requestAnimationFrame(frame);

// drop the resolution a little if the frame rate is poor (Chromebooks)
function adaptResolution(f) {
  if (!G || G.kind === 'attract' || paused) return;
  if (f < 38) slowT += 0.5;
  else slowT = Math.max(0, slowT - 0.5);
  if (slowT >= 3 && pixelRatio > 0.6) {
    pixelRatio = Math.max(0.6, pixelRatio - 0.15);
    renderer.setPixelRatio(pixelRatio);
    resize();
    slowT = 0;
  }
}

const _p = { x: 0, y: 0, z: 0, yaw: 0 };
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
function interp(i, a) {
  const k = G.race.karts[i],
    p = G.prev[i];
  _p.x = p.x + (k.x - p.x) * a;
  _p.y = p.y + (k.y - p.y) * a;
  _p.z = p.z + (k.z - p.z) * a;
  _p.yaw = lerpAngle(p.yaw, k.yaw, a);
  return _p;
}

function render(dt, alpha, ctl) {
  const race = G.race;
  G.t += dt;
  // countdown
  if (race.state === 'countdown') {
    const c = Math.ceil(-race.time);
    if (c !== G.lastCount && c <= 3 && c >= 1 && G.kind !== 'attract') {
      hud.count(String(c));
      audio.play('count');
    }
    G.lastCount = c;
  }
  for (let i = 0; i < race.karts.length; i++) {
    const k = race.karts[i];
    const p = interp(i, alpha);
    G.views[i].update(k, p, dt, G.t);
    G.fx.kart(k, dt, G.world.theme);
  }
  // camera
  let focusIdx = G.me ? G.me.id : G.follow;
  if (G.kind === 'attract') {
    G.followT -= dt;
    if (G.followT <= 0) {
      G.follow = Math.floor(Math.random() * race.karts.length);
      G.followT = 9;
      G.cam.snap(race.karts[G.follow]);
    }
    focusIdx = G.follow;
  }
  const fk = race.karts[focusIdx];
  const fp = { ...interp(focusIdx, alpha) };
  let mode = 'race',
    u = 0;
  if (race.state === 'countdown' && race.time < -2.1) {
    mode = 'intro';
    u = (race.time + COUNTDOWN) / (COUNTDOWN - 2.1);
  } else if (G.me && G.me.finished && G.kind !== 'client') mode = 'orbit';
  else if (G.me && G.me.finished) mode = 'orbit';
  else if (ctl.back && G.kind !== 'attract') mode = 'back';
  if (G.kind === 'attract' && G.followT < 3) mode = 'orbit';
  G.cam.update(fk, fp, dt, mode, u, fk.gy);
  // ghost
  if (G.ghostView) {
    const gh = G.ghost;
    const f = race.time * 10;
    if (race.state === 'race' && f >= 0 && f < gh.frames.length - 1) {
      const i = Math.floor(f),
        a = f - i;
      const A = gh.frames[i],
        B = gh.frames[i + 1];
      const gp = { x: A[0] + (B[0] - A[0]) * a, y: A[1] + (B[1] - A[1]) * a, z: A[2] + (B[2] - A[2]) * a, yaw: lerpAngle(A[3], B[3], a) };
      G.ghostView.setVisible(true);
      G.ghostView.update({ vf: 20, drift: 0, spinAng: 0, spinT: 0, steerVis: 0, grounded: true, vy: 0, trick: 0, wheelRot: G.t * 60, boostT: 0, shieldT: 0, gy: gp.y }, gp, dt, G.t);
    } else G.ghostView.setVisible(false);
  }
  G.world.update(G.t, dt, camera, fk);
  G.items.update(race, G.t);
  G.fx.update(dt);
  if (G.kind !== 'attract') hud.update(race, G.me, dt, { fps: S.showFps ? fps : 0 });
  if (G.me && G.kind !== 'attract' && !paused) audio.engine(G.me, G.me.top);
  else audio.engine(null);
  // item roulette ticks
  if (G.me && G.me.rollT > 0) {
    G.tickT = (G.tickT || 0) - dt;
    if (G.tickT <= 0) {
      audio.play('tick');
      G.tickT = 0.08;
    }
  }
  renderer.render(scene, camera);
}

// ------------------------------------------------------------------ events -> sound, effects, HUD
function near(x, z) {
  const d = Math.hypot(camera.position.x - x, camera.position.z - z);
  return Math.max(0, 1 - d / 90);
}
function onEvents(evs) {
  if (!evs.length || !G) return;
  const me = G.me;
  const attract = G.kind === 'attract';
  for (const e of evs) {
    const [type, k, a] = e;
    const mine = k && k === me;
    switch (type) {
      case 'go':
        if (!attract) {
          hud.count('GO!');
          audio.play('go');
        }
        break;
      case 'startboost':
        if (mine) {
          hud.banner('ROCKET START!', 'gold small', 1.2);
          audio.play('start');
        }
        break;
      case 'burnout':
        if (mine) hud.banner('Too early!', 'small', 1.2);
        break;
      case 'hop':
        if (mine) audio.play('hop');
        break;
      case 'charge':
        if (mine) audio.play('charge', a);
        break;
      case 'mini':
        G.fx.mini(k, a);
        if (mine) audio.play('mini', a);
        break;
      case 'trick':
        if (mine) audio.play('trick');
        break;
      case 'trickboost':
        if (mine) {
          audio.play('pad', 0, 0.6);
          hud.banner('TRICK!', 'small', 0.8);
        }
        break;
      case 'land':
        G.views[k.id].squash = Math.min(1, a);
        if (mine) audio.play('land');
        break;
      case 'bonk':
        if (mine) {
          audio.play('bonk');
          G.cam.shake(0.25);
        }
        G.fx.burst(k.x, k.y + 0.5, k.z, 8, 5, [[1, 0.9, 0.6]], 0.3, 0.3, 10);
        break;
      case 'box':
        G.fx.boxBurst(a.x, a.y, a.z);
        if (mine) audio.play('box');
        break;
      case 'item':
        if (mine) audio.play('item');
        break;
      case 'nitro':
      case 'pad':
        if (mine) audio.play(type);
        break;
      case 'fire':
        if (!attract) audio.play('fire', 0, mine ? 1 : near(k.x, k.z));
        break;
      case 'boom': {
        const p = a;
        G.fx.explosion(p.x, p.y, p.z);
        if (!attract) audio.play('boom', 0, Math.max(k === me ? 1 : 0, near(p.x, p.z)));
        break;
      }
      case 'ricochet':
        G.fx.burst(a.x, a.y, a.z, 6, 6, [[1, 0.8, 0.4]], 0.3, 0.25, 6);
        break;
      case 'hit':
        G.fx.burst(k.x, k.y + 1.6, k.z, 14, 5, [[1, 0.95, 0.4]], 0.5, 0.8, 3);
        if (mine) {
          audio.play('hit');
          G.cam.shake(0.5);
        } else if (!attract && a !== 'emp') audio.play('hit', 0, near(k.x, k.z) * 0.6);
        if (G.kind === 'client' && mine) applyHit(k, a);
        break;
      case 'shieldpop':
        G.fx.burst(k.x, k.y + 0.8, k.z, 20, 7, [[0.4, 0.85, 1]], 0.5, 0.4, 2);
        if (mine || !attract) audio.play('shieldpop', 0, mine ? 1 : near(k.x, k.z));
        break;
      case 'shield':
        if (mine) audio.play('shield');
        break;
      case 'oil':
        if (mine) audio.play('oil');
        break;
      case 'emp':
        G.fx.ring(k.x, k.y, k.z, 0xffd23f, 60, 0.9);
        if (!attract) audio.play('emp');
        break;
      case 'lap':
        if (mine) {
          if (a === G.race.laps) {
            hud.banner('FINAL LAP!', 'gold');
            audio.play('final');
            audio.musicFast(true);
          } else {
            hud.banner('LAP ' + a, '', 1.2);
            audio.play('lap');
          }
        }
        break;
      case 'finish':
        if (mine) {
          hud.banner(ordinal(k.place) + (k.place === 1 ? '!' : ''), k.place <= 3 ? 'gold' : '', 3);
          audio.play(k.place <= 3 || G.kind === 'tt' ? 'finish' : 'lose');
          audio.musicFast(false);
          onPlayerFinish(k);
        }
        break;
      case 'done':
        if (attract) {
          startAttract();
          return;
        }
        if (G.kind !== 'client') setTimeout(() => showResults(), 600);
        break;
    }
  }
}

// ------------------------------------------------------------------ records & ghosts
function recKey(trackId, cls) {
  return trackId + '@' + cls;
}
function onPlayerFinish(k) {
  if (!G || k.estimated) return;
  const race = G.race;
  const key = recKey(race.T.id, race.setup.cls);
  const r = (REC.tracks[key] = REC.tracks[key] || {});
  const bestLap = Math.min(...k.lapTimes);
  G.newRecord = false;
  if (!r.lap || bestLap < r.lap) r.lap = bestLap;
  if (!r.race || k.finishT < r.race) {
    r.race = k.finishT;
    G.newRecord = true;
  }
  saveRecords(REC);
  if (G.kind === 'tt') {
    const old = loadGhost(race.T.id);
    if (!old || k.finishT < old.time) {
      saveGhost(race.T.id, { time: k.finishT, driver: k.driver, frames: G.rec });
      G.newGhost = true;
    }
  }
}

// ------------------------------------------------------------------ results
function showResults() {
  if (!G || G.resultsShown) return;
  G.resultsShown = true;
  const race = G.race,
    me = G.me;
  const box = $('results');
  const rows = [];
  const lead = race.order[0].finishT;
  let title = '',
    sub = '';
  $('trophy').classList.add('hidden');
  if (session && session.kind === 'gp') {
    const gp = session;
    race.order.forEach((k, i) => {
      const id = gp.ids[k.id];
      gp.points[id] = (gp.points[id] || 0) + (POINTS[i] || 0);
    });
    gp.raceIdx++;
    const done = gp.raceIdx >= 4;
    title = done ? gp.cupName + ' — final standings' : `Race ${gp.raceIdx} of 4`;
    sub = `${race.T.def.name} · ${CLASSES[gp.cls].name}`;
    const table = race.order.map((k, i) => ({ k, id: gp.ids[k.id], pts: POINTS[i] || 0 }));
    const stand = Object.keys(gp.points)
      .map((id) => ({ id, total: gp.points[id] }))
      .sort((a, b) => b.total - a.total);
    if (done) {
      const myPlace = stand.findIndex((s) => s.id === 'me') + 1;
      const key = gp.cup + '@' + gp.cls;
      if (myPlace <= 3 && (!REC.cups[key] || myPlace < REC.cups[key])) {
        REC.cups[key] = myPlace;
        saveRecords(REC);
      }
      $('trophy').innerHTML = myPlace <= 3 ? trophySvg(myPlace) : '';
      $('trophy').classList.toggle('hidden', myPlace > 3);
      sub = myPlace <= 3 ? `You won the ${['gold', 'silver', 'bronze'][myPlace - 1]} trophy!` : `You finished ${ordinal(myPlace)} overall.`;
      rows.push('<tr><th>#</th><th>Driver</th><th class="num">Points</th></tr>');
      stand.forEach((s, i) => {
        const d = gp.drivers[s.id];
        rows.push(`<tr class="${s.id === 'me' ? 'me' : ''}"><td>${i + 1}</td><td><i style="background:${driverById(d).body}"></i> ${esc(s.id === 'me' ? gp.myName : driverById(d).name)}</td><td class="num">${s.total}</td></tr>`);
      });
    } else {
      rows.push('<tr><th>#</th><th>Driver</th><th class="num">Time</th><th class="num">Points</th></tr>');
      for (const r of table) {
        const tot = gp.points[r.id];
        rows.push(
          `<tr class="${r.k === me ? 'me' : ''}"><td>${r.k.place}</td><td><i style="background:${driverById(r.k.driver).body}"></i> ${esc(r.k.name)}</td><td class="num">${r.k.place === 1 ? fmtTime(r.k.finishT) : '+' + (r.k.finishT - lead).toFixed(2)}</td><td class="num">${tot} <span class="plus">+${r.pts}</span></td></tr>`,
        );
      }
    }
    $('resNext').textContent = done ? 'New cup' : 'Next race';
    $('resNext').classList.remove('hidden');
    $('resRetry').classList.toggle('hidden', !done);
    $('resRetry').textContent = 'Same cup again';
  } else {
    if (G.kind === 'tt') {
      title = me.finished ? 'Time: ' + fmtTime(me.finishT) : 'Time trial';
      const best = (loadGhost(race.T.id) || {}).time;
      sub = G.newGhost ? 'New best! Your ghost is saved.' : best ? 'Your best: ' + fmtTime(best) : '';
      rows.push('<tr><th>Lap</th><th class="num">Time</th></tr>');
      me.lapTimes.forEach((t, i) => rows.push(`<tr><td>Lap ${i + 1}</td><td class="num">${fmtTime(t)}</td></tr>`));
    } else {
      title = me ? (me.place === 1 ? 'You win!' : `You finished ${ordinal(me.place)}`) : 'Results';
      sub = race.T.def.name + ' · ' + CLASSES[race.setup.cls].name + (G.newRecord ? ' · new best time!' : '');
      rows.push('<tr><th>#</th><th>Driver</th><th class="num">Time</th><th class="num">Best lap</th></tr>');
      for (const k of race.order) {
        const bl = k.lapTimes.length ? Math.min(...k.lapTimes) : NaN;
        rows.push(
          `<tr class="${k === me ? 'me' : ''}"><td>${k.place}</td><td><i style="background:${driverById(k.driver).body}"></i> ${esc(k.name)}</td><td class="num">${k.estimated ? '~' : ''}${k.place === 1 ? fmtTime(k.finishT) : '+' + (k.finishT - lead).toFixed(2)}</td><td class="num">${isFinite(bl) ? fmtTime(bl) : '—'}</td></tr>`,
        );
      }
    }
    const online = G.kind === 'host' || G.kind === 'client';
    $('resNext').textContent = online ? 'Back to lobby' : G.kind === 'tt' ? 'Try again' : 'Next track';
    $('resNext').classList.remove('hidden');
    $('resRetry').classList.toggle('hidden', online || G.kind === 'tt');
    $('resRetry').textContent = 'Race again';
  }
  $('resTitle').textContent = title;
  $('resSub').textContent = sub;
  $('resTable').innerHTML = rows.join('');
  box.classList.remove('hidden');
  setTouchVisible();
}

function trophySvg(place) {
  const c = ['#ffd23f', '#d9dee8', '#d98a4a'][place - 1];
  return `<svg viewBox="0 0 64 64"><path d="M18 8h28v14c0 10-6 17-14 17S18 32 18 22z" fill="${c}"/><path d="M18 12H8c0 9 5 14 11 14M46 12h10c0 9-5 14-11 14" fill="none" stroke="${c}" stroke-width="4"/><rect x="28" y="38" width="8" height="10" fill="${c}"/><rect x="20" y="48" width="24" height="8" rx="2" fill="${c}"/><text x="32" y="28" font-size="14" font-weight="900" text-anchor="middle" fill="#1b1405">${place}</text></svg>`;
}

$('resNext').onclick = () => {
  audio.play('ui');
  if (!G) return;
  if (G.kind === 'host' || G.kind === 'client') {
    online.backToLobby();
    return;
  }
  if (session && session.kind === 'gp') {
    if (session.raceIdx >= 4) openSetup('gp');
    else startGpRace();
    return;
  }
  if (G.kind === 'tt') {
    startTimeTrial(session.track);
    return;
  }
  // quick race: next track
  const i = TRACKS.findIndex((t) => t.id === session.track);
  session.track = TRACKS[(i + 1) % TRACKS.length].id;
  S.quick.track = session.track;
  saveSettings(S);
  startQuick();
};
$('resRetry').onclick = () => {
  audio.play('ui');
  if (session && session.kind === 'gp') startGp(session.cup);
  else startQuick();
};
$('resMenu').onclick = () => {
  audio.play('ui');
  if (G && (G.kind === 'host' || G.kind === 'client')) online.leave();
  toMenu();
};

// ------------------------------------------------------------------ modes
function myName() {
  return (S.name || '').trim() || 'You';
}
function botDrivers(exclude, n, rnd = Math.random) {
  const pool = DRIVERS.filter((d) => d.id !== exclude).map((d) => d.id);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

function startQuick() {
  const q = S.quick;
  session = { kind: 'quick', track: q.track };
  const n = Math.max(1, Math.min(8, q.racers));
  const karts = botDrivers(S.driver, n - 1).map((d, i) => ({ driver: d, ctrl: 'bot', grid: i }));
  karts.push({ driver: S.driver, ctrl: 'player', name: myName(), grid: n - 1 });
  startGame({ track: q.track, cls: S.cls, laps: q.laps, items: q.items, seed: (Math.random() * 1e9) | 0, karts }, { kind: 'quick' });
}

function startTimeTrial(track) {
  session = { kind: 'tt', track };
  const ghost = loadGhost(track);
  startGame(
    { track, cls: S.cls, laps: 3, items: false, seed: 1, karts: [{ driver: S.driver, ctrl: 'player', name: myName(), grid: 0, item: 'nitro3', itemN: 3 }] },
    { kind: 'tt', ghost: ghost && ghost.frames && ghost.frames.length > 10 ? ghost : null },
  );
}

function startGp(cupId) {
  const cup = CUPS.find((c) => c.id === cupId) || CUPS[0];
  const bots = botDrivers(S.driver, 7);
  const drivers = { me: S.driver };
  bots.forEach((d) => (drivers[d] = d));
  session = { kind: 'gp', cup: cup.id, cupName: cup.name, cls: S.cls, raceIdx: 0, points: { me: 0 }, drivers, bots, myName: myName() };
  for (const d of bots) session.points[d] = 0;
  startGpRace();
}

function startGpRace() {
  const gp = session;
  const cup = CUPS.find((c) => c.id === gp.cup);
  const track = cup.tracks[gp.raceIdx];
  // grid: the first race you start at the back; after that, the leaders start at the back
  let order = gp.raceIdx === 0 ? [...gp.bots, 'me'] : Object.keys(gp.points).sort((a, b) => gp.points[a] - gp.points[b] || (a === 'me' ? 1 : -1));
  const karts = order.map((id, grid) => (id === 'me' ? { driver: S.driver, ctrl: 'player', name: gp.myName, grid } : { driver: id, ctrl: 'bot', grid }));
  karts.sort((a, b) => a.grid - b.grid);
  gp.ids = karts.map((k) => (k.ctrl === 'player' ? 'me' : k.driver));
  startGame({ track, cls: gp.cls, laps: 3, items: true, seed: (Math.random() * 1e9) | 0, karts }, { kind: 'gp' });
}

function startAttract() {
  const tr = TRACKS[Math.floor(Math.random() * TRACKS.length)];
  session = null;
  startGame({ track: Q.get('menutrack') || tr.id, cls: 150, laps: 99, items: true, seed: 7, karts: DRIVERS.map((d, i) => ({ driver: d.id, ctrl: 'bot', grid: i })) }, { kind: 'attract' });
}

// ------------------------------------------------------------------ pause
function togglePause(force) {
  if (!G || G.kind === 'attract') return;
  paused = force !== undefined ? force : !paused;
  $('pause').classList.toggle('hidden', !paused);
  $('pRestart').classList.toggle('hidden', !!G.net);
  if (paused) audio.engine(null);
  setTouchVisible();
}
$('pauseBtn').onclick = () => togglePause(true);
$('pResume').onclick = () => togglePause(false);
$('pRestart').onclick = () => {
  togglePause(false);
  if (session && session.kind === 'gp') startGpRace();
  else if (session && session.kind === 'tt') startTimeTrial(session.track);
  else startQuick();
};
$('pSettings').onclick = () => {
  settingsReturn = 'pause';
  $('pause').classList.add('hidden');
  $('menu').classList.remove('hidden');
  showScreen('mSettings');
};
$('pQuit').onclick = () => {
  if (G && G.net) online.leave();
  toMenu();
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden && G && G.kind !== 'attract' && !G.net && $('results').classList.contains('hidden')) togglePause(true);
});

// ------------------------------------------------------------------ menus
let settingsReturn = 'mMain';
function showScreen(id) {
  for (const s of document.querySelectorAll('#menu .screen')) s.classList.toggle('hidden', s.id !== id);
  $('menu').scrollTop = 0;
}
function toMenu(screen = 'mMain') {
  paused = false;
  $('pause').classList.add('hidden');
  $('results').classList.add('hidden');
  hud.show(false);
  $('menu').classList.remove('hidden');
  showScreen(screen);
  if (!G || G.kind !== 'attract') startAttract();
  setTouchVisible();
}
for (const b of document.querySelectorAll('[data-go]'))
  b.addEventListener('click', () => {
    audio.play('ui');
    const go = b.dataset.go;
    if (go === 'main') showScreen('mMain');
    else if (go === 'gp' || go === 'quick' || go === 'tt') openSetup(go);
    else if (go === 'online') openOnline();
    else if (go === 'settings') {
      settingsReturn = 'mMain';
      showScreen('mSettings');
    } else if (go === 'help') showScreen('mHelp');
  });

function seg(el, value, onChange) {
  for (const b of el.querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.v === String(value));
    b.onclick = () => {
      for (const o of el.querySelectorAll('button')) o.classList.toggle('on', o === b);
      audio.play('ui');
      onChange(b.dataset.v);
    };
  }
}

function drawKartIcon(cv, d) {
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#1b1b1f';
  g.fillRect(6, 30, 14, 12);
  g.fillRect(44, 30, 14, 12);
  g.fillStyle = d.body;
  g.beginPath();
  g.roundRect(10, 22, 44, 14, 5);
  g.fill();
  g.fillStyle = d.trim;
  g.fillRect(48, 25, 10, 8);
  g.fillStyle = d.suit;
  g.fillRect(24, 14, 14, 10);
  g.fillStyle = d.helmet;
  g.beginPath();
  g.arc(31, 11, 7, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1a1c26';
  g.fillRect(32, 8, 6, 4);
}

function drawTrackIcon(cv, id) {
  const T = getTrack(id);
  const g = cv.getContext('2d');
  const W = cv.width,
    H = cv.height;
  g.clearRect(0, 0, W, H);
  const b = T.bounds;
  const s = (Math.min(W, H) - 10) / Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  const ox = (W - (b.maxX - b.minX) * s) / 2,
    oz = (H - (b.maxZ - b.minZ) * s) / 2;
  g.strokeStyle = THEMES[T.def.theme].curb[0];
  g.lineWidth = 3;
  g.lineJoin = 'round';
  g.beginPath();
  for (let i = 0; i <= T.n; i += 3) {
    const x = ox + (T.px[i % T.n] - b.minX) * s,
      y = oz + (T.pz[i % T.n] - b.minZ) * s;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.stroke();
}

let setupMode = 'quick';
function openSetup(mode) {
  setupMode = mode;
  $('menu').classList.remove('hidden');
  $('results').classList.add('hidden');
  hud.show(false);
  if (!G || G.kind !== 'attract') startAttract();
  showScreen('mSetup');
  $('setupTitle').textContent = mode === 'gp' ? 'Grand Prix' : mode === 'tt' ? 'Time Trial' : 'Quick Race';
  $('pickTitle').textContent = mode === 'gp' ? 'Cup' : 'Track';
  $('quickOpts').classList.toggle('hidden', mode !== 'quick');
  // drivers
  const dv = $('drivers');
  dv.innerHTML = '';
  for (const d of DRIVERS) {
    const b = document.createElement('button');
    b.className = 'drv' + (d.id === S.driver ? ' on' : '');
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 48;
    drawKartIcon(cv, d);
    b.append(cv, document.createTextNode(d.name));
    b.onclick = () => {
      S.driver = d.id;
      saveSettings(S);
      audio.play('ui');
      for (const o of dv.children) o.classList.toggle('on', o === b);
      showStats();
    };
    dv.append(b);
  }
  showStats();
  seg($('clsSeg'), S.cls, (v) => {
    S.cls = +v;
    saveSettings(S);
    buildPicks();
  });
  seg($('lapSeg'), S.quick.laps, (v) => {
    S.quick.laps = +v;
    saveSettings(S);
  });
  $('racers').value = S.quick.racers;
  $('racersV').textContent = S.quick.racers;
  $('racers').oninput = () => {
    S.quick.racers = +$('racers').value;
    $('racersV').textContent = S.quick.racers;
    saveSettings(S);
  };
  $('itemsOn').checked = S.quick.items;
  $('itemsOn').onchange = () => {
    S.quick.items = $('itemsOn').checked;
    saveSettings(S);
  };
  buildPicks();
}

function showStats() {
  const d = driverById(S.driver);
  $('driverStats').innerHTML = [
    ['Speed', d.speed],
    ['Acceleration', d.accel],
    ['Handling', d.handling],
    ['Weight', d.weight],
  ]
    .map(([n, v]) => `<span>${n}</span><div class="bar"><i style="width:${v * 20}%"></i></div>`)
    .join('');
}

function buildPicks() {
  const pk = $('picks');
  pk.innerHTML = '';
  const mode = setupMode;
  if (mode === 'gp') {
    for (const c of CUPS) {
      const b = document.createElement('button');
      b.className = 'pick cup' + (c.id === S.gp.cup ? ' on' : '');
      const won = REC.cups[c.id + '@' + S.cls];
      const cv = document.createElement('canvas');
      cv.width = cv.height = 104;
      drawTrackIcon(cv, c.tracks[0]);
      const sp = document.createElement('span');
      sp.innerHTML = `<b>${c.name}${won ? ' ' + ['🥇', '🥈', '🥉'][won - 1] : ''}</b><small>${c.tracks.map((t) => TRACKS.find((x) => x.id === t).name).join(' · ')}</small>`;
      b.append(cv, sp);
      b.onclick = () => {
        S.gp.cup = c.id;
        saveSettings(S);
        audio.play('ui');
        for (const o of pk.children) o.classList.toggle('on', o === b);
      };
      pk.append(b);
    }
    $('pickNote').textContent = '4 races, 8 racers. Points: 15, 12, 10, 8, 6, 4, 2, 1. Finish in the top 3 overall for a trophy.';
    return;
  }
  const cur = mode === 'tt' ? S.tt.track : S.quick.track;
  for (const t of TRACKS) {
    const b = document.createElement('button');
    b.className = 'pick' + (t.id === cur ? ' on' : '');
    const cv = document.createElement('canvas');
    cv.width = cv.height = 104;
    drawTrackIcon(cv, t.id);
    const r = REC.tracks[recKey(t.id, S.cls)];
    const g = mode === 'tt' ? loadGhost(t.id) : null;
    const best = mode === 'tt' ? (g ? 'Ghost: ' + fmtTime(g.time) : 'No ghost yet') : r && r.race ? 'Best: ' + fmtTime(r.race) : CUPS.find((c) => c.tracks.includes(t.id)).name;
    const sp = document.createElement('span');
    sp.innerHTML = `<b>${t.name}</b><small>${best}</small>`;
    b.append(cv, sp);
    b.onclick = () => {
      if (mode === 'tt') S.tt.track = t.id;
      else S.quick.track = t.id;
      saveSettings(S);
      audio.play('ui');
      for (const o of pk.children) o.classList.toggle('on', o === b);
    };
    pk.append(b);
  }
  $('pickNote').textContent = mode === 'tt' ? 'Three laps on your own with three nitros. Your best run is saved as a ghost to race next time.' : '';
}

$('startBtn').onclick = () => {
  audio.play('ui');
  if (setupMode === 'gp') startGp(S.gp.cup);
  else if (setupMode === 'tt') startTimeTrial(S.tt.track);
  else startQuick();
};

// settings screen
function bindSettings() {
  $('setName').value = S.name;
  $('setName').oninput = () => {
    S.name = $('setName').value.slice(0, 14);
    saveSettings(S);
  };
  seg($('setQuality'), S.quality, (v) => {
    S.quality = v;
    saveSettings(S);
    quality = resolveQuality(v);
    applyShadows();
  });
  $('setMusic').value = S.music;
  $('setMusic').oninput = () => {
    S.music = +$('setMusic').value;
    audio.setVolumes(S.music, S.sfx);
    saveSettings(S);
  };
  $('setSfx').value = S.sfx;
  $('setSfx').oninput = () => {
    S.sfx = +$('setSfx').value;
    audio.setVolumes(S.music, S.sfx);
    saveSettings(S);
  };
  $('setCam').value = S.cam;
  $('setCam').oninput = () => {
    S.cam = +$('setCam').value;
    if (G) G.cam.distMul = S.cam;
    saveSettings(S);
  };
  $('setAutoGas').checked = S.autoGas;
  $('setAutoGas').onchange = () => {
    S.autoGas = $('setAutoGas').checked;
    document.body.classList.toggle('autogas', S.autoGas);
    saveSettings(S);
  };
  $('setFps').checked = S.showFps;
  $('setFps').onchange = () => {
    S.showFps = $('setFps').checked;
    saveSettings(S);
  };
}
bindSettings();
$('settingsBack').onclick = () => {
  audio.play('ui');
  if (settingsReturn === 'pause') {
    $('menu').classList.add('hidden');
    $('pause').classList.remove('hidden');
  } else showScreen('mMain');
};

// ------------------------------------------------------------------ online
const online = new Online({
  S,
  save: () => saveSettings(S),
  $,
  audio,
  showScreen,
  startGame: (setup, opts) => startGame(setup, opts),
  getGame: () => G,
  toMenu,
  showResults,
  hud,
  esc,
  setSession: (s) => (session = s),
});
function openOnline() {
  if (!G || G.kind !== 'attract') startAttract();
  $('menu').classList.remove('hidden');
  online.show();
}

// ------------------------------------------------------------------ boot
resize();
toMenu();
if (Q.get('debug')) window.__kart = { get G() { return G; }, S, online, startQuick, startGp, startTimeTrial, togglePause, showResults };
const auto = Q.get('autostart');
if (auto) {
  if (Q.get('track')) S.quick.track = S.tt.track = Q.get('track');
  if (Q.get('racers')) S.quick.racers = +Q.get('racers');
  if (Q.get('laps')) S.quick.laps = +Q.get('laps');
  if (Q.get('cls')) S.cls = +Q.get('cls');
  setTimeout(() => (auto === 'gp' ? startGp(Q.get('cup') || 'sunrise') : auto === 'tt' ? startTimeTrial(S.tt.track) : startQuick()), 200);
}
