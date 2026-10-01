import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { Track, sectionSpeed, gravityFor, jumpVFor, steerFor, latDampFor, latCapFor, GRAVITY, BALL_R, POWERUPS } from './track.js';
import { sphereTouchesBox, boundsOverlapSphere, topHeightBelow, rayBox } from './physics.js';
import { createBall, stepController, COYOTE, JUMP_BUFFER, DASH_CD, PHASE_TIME } from './ball.js';
import { InstancedPool, createTileMaterial, createHazardMaterial, createTowerMaterial, createPadMaterial, Background, Trail, Particles, Shards, LandingMarker, makeSign } from './render.js';
import { GameAudio } from './audio.js';
import { SKINS, skinTexture, skinMaterialParams, skinPreview } from './skins.js';
import { loadSave, writeSave, resetSave } from './storage.js';

window.__slopeStarted = true;
const $ = (id) => document.getElementById(id);

// ============================================================================ constants
const STEP = 1 / 120;

// one colour per section, like the original's colour changes
const THEMES = [
  { neon: '#1eff3c', ui: '30, 255, 60' },
  { neon: '#1ee4ff', ui: '30, 228, 255' },
  { neon: '#a066ff', ui: '160, 102, 255' },
  { neon: '#ff3cf0', ui: '255, 60, 240' },
  { neon: '#ff8c1e', ui: '255, 140, 30' },
  { neon: '#4a78ff', ui: '74, 120, 255' },
  { neon: '#f2f2f2', ui: '242, 242, 242' },
];

// ============================================================================ save / settings
let save = loadSave();
const settings = save.settings;
const persist = () => writeSave(save);

// ============================================================================ renderer
const coarse = matchMedia('(pointer: coarse)').matches;
let renderer;
try {
  // MSAA gives clean lines; skipped on the Low preset (and phones default to Low)
  const wantAA = !(settings.quality === 'low' || (settings.quality === 'auto' && (save.autoLevel === 'low' || coarse)));
  renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: wantAA, powerPreference: 'high-performance', stencil: false });
} catch (e) {
  fatal('WebGL is not available on this device/browser. ' + (e && e.message ? e.message : ''));
  throw e;
}
renderer.setClearColor(0x000000, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 2000);
camera.position.set(0, 5, 12);

// lighting for the ball / gems (track is self-lit)
scene.add(new THREE.HemisphereLight(0xbfdfff, 0x101018, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.3);
sun.position.set(-4, 10, 6);
scene.add(sun);
scene.add(sun.target);
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
}

// ============================================================================ quality
const urlQ = new URLSearchParams(location.search).get('quality');
if (['auto', 'low', 'medium', 'high'].includes(urlQ)) settings.quality = urlQ;
const autoDefault = () => save.autoLevel || (coarse ? 'low' : 'medium');
let quality = settings.quality === 'auto' ? autoDefault() : settings.quality;

function applyQuality() {
  const dpr = window.devicePixelRatio || 1;
  const pr = quality === 'low' ? Math.min(dpr, 1.5) * 0.7 : quality === 'medium' ? Math.min(dpr, 1.5) : Math.min(dpr, 2);
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight, false);
}
applyQuality();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  applyQuality();
});

// ============================================================================ world objects
const fogColor = new THREE.Color('#000000');
const tileMat = createTileMaterial(fogColor);
const towerMat = createTowerMaterial(fogColor, tileMat);
const hazardMat = createHazardMaterial(fogColor);
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const pools = {
  tiles: new InstancedPool(unitBox, tileMat, 1100),
  hazards: new InstancedPool(unitBox, hazardMat, 500),
  towers: new InstancedPool(unitBox, towerMat, 2400),
  pads: new InstancedPool(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), createPadMaterial(), 16),
  gems: new InstancedPool(
    new THREE.CylinderGeometry(0.62, 0.62, 0.16, 20).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: '#ffc928', emissive: '#7a4a00', emissiveIntensity: 0.9, metalness: 0.85, roughness: 0.3 }),
    400
  ),
};
scene.add(pools.tiles.mesh, pools.hazards.mesh, pools.gems.mesh, pools.towers.mesh, pools.pads.mesh);

// Power-up pickups: each has its own shape and colour so they read at a glance.
const POWER_INFO = {
  shield: { label: 'SHIELD', color: '#46c8e6', time: 0 },
  magnet: { label: 'MAGNET', color: '#ff4d4d', time: 10 },
  double: { label: '2X POINTS', color: '#ffd23f', time: 12 },
  slowmo: { label: 'SLOW-MO', color: '#b36bff', time: 5 },
};
function makePickup(type) {
  const g = new THREE.Group();
  const c = POWER_INFO[type].color;
  const mat = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.55, metalness: 0.3, roughness: 0.4, flatShading: true });
  const cage = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.05, 0)), new THREE.LineBasicMaterial({ color: c }));
  g.add(cage);
  if (type === 'shield') g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), mat));
  else if (type === 'magnet') {
    const u = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.16, 8, 16, Math.PI), mat);
    u.rotation.z = Math.PI;
    const tipMat = new THREE.MeshStandardMaterial({ color: '#f2f2f2', emissive: '#777777', emissiveIntensity: 0.4 });
    for (const x of [-0.42, 0.42]) {
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.3, 10), tipMat);
      tip.position.set(x, 0.12, 0);
      g.add(tip);
    }
    g.add(u);
  } else if (type === 'double') {
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 128;
    const x = cv.getContext('2d');
    x.fillStyle = c;
    x.fillRect(0, 0, 128, 128);
    x.fillStyle = '#1a1000';
    x.font = 'bold 72px system-ui, Arial, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('2x', 64, 68);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.85, 0.85), new THREE.MeshBasicMaterial({ map: tex })));
  } else {
    const top = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.5, 12), mat);
    top.position.y = 0.26;
    top.rotation.x = Math.PI;
    const bot = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.5, 12), mat);
    bot.position.y = -0.26;
    g.add(top, bot);
  }
  return g;
}

const track = new Track(scene, pools, makeSign, makePickup);
const bg = new Background(scene, quality);
const trail = new Trail(scene);
const particles = new Particles(scene);
const shards = new Shards(scene);
const marker = new LandingMarker(scene);

// ball
const ballMat = new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 0.4, roughness: 0.3, transparent: true });
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 48, 32), ballMat);
scene.add(ballMesh);
const bubble = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R * 1.45, 32, 20),
  new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color('#46e6ff') }, uTime: { value: 0 } },
    vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uTime; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.5); gl_FragColor = vec4(uColor * f * 0.7, 1.0);
      #include <colorspace_fragment>
    }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
);
bubble.visible = false;
scene.add(bubble);

let classicBall = false;
function applySkin(id) {
  if (!SKINS.some((k) => k.id === id)) id = save.skin = 'classic';
  const p = skinMaterialParams(id);
  const tex = skinTexture(id);
  classicBall = id === 'classic';
  ballMat.map = classicBall ? null : tex;
  ballMat.color.set(classicBall ? '#000000' : '#ffffff');
  ballMat.emissiveMap = tex;
  ballMat.emissive.set(classicBall ? theme.neon : '#ffffff');
  ballMat.emissiveIntensity = p.emissiveIntensity;
  ballMat.metalness = p.metalness;
  ballMat.roughness = p.roughness;
  ballMat.needsUpdate = true;
}

// ============================================================================ theme
const theme = {
  neon: new THREE.Color(THEMES[0].neon),
  target: 0,
};
const _tn = new THREE.Color();
function setThemeInstant(i) {
  theme.target = i;
  theme.neon.set(THEMES[i % THEMES.length].neon);
  pushTheme();
}
function pushTheme() {
  tileMat.uniforms.uColor.value.copy(theme.neon);
  trail.mat.uniforms.uColor.value.copy(theme.neon);
  if (classicBall) ballMat.emissive.copy(theme.neon);
}
function updateTheme(dt) {
  const k = 1 - Math.exp(-dt * 3);
  theme.neon.lerp(_tn.set(THEMES[theme.target % THEMES.length].neon), k);
  pushTheme();
}
function setUiTheme(i) {
  document.documentElement.style.setProperty('--neon', THEMES[i % THEMES.length].neon);
  document.documentElement.style.setProperty('--neon-rgb', THEMES[i % THEMES.length].ui);
  if (typeof hudCache !== 'undefined') hudCache.score = -1;
}
setThemeInstant(0);
applySkin(save.skin);

// ============================================================================ audio
const audio = new GameAudio();
audio.setVolumes(settings.sfx, settings.music);
function unlockAudio() {
  audio.unlock();
  audio.setVolumes(settings.sfx, settings.music);
  if (!audio.musicOn && settings.music > 0) audio.startMusic();
}

// ============================================================================ input
const keys = new Set();
const input = { jumpQueued: 0, dashQueued: false, touchSteer: 0, pad: { steer: 0, a: false, b: false, start: false }, ctl: {} };
const JUMP_KEYS = ['Space', 'KeyW', 'ArrowUp'];
const DASH_KEYS = ['ShiftLeft', 'ShiftRight', 'KeyS', 'ArrowDown', 'KeyK'];

addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') && e.code !== 'Escape') return;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  unlockAudio();
  const first = !keys.has(e.code);
  keys.add(e.code);
  if (!first) return;
  if (S.state === 'playing') {
    if (JUMP_KEYS.includes(e.code)) input.jumpQueued = JUMP_BUFFER;
    if (DASH_KEYS.includes(e.code)) input.dashQueued = true;
    if (e.code === 'Escape' || e.code === 'KeyP') pauseGame();
    if (e.code === 'KeyR') startRun();
  } else if (S.state === 'menu') {
    if (modalOpen()) {
      if (e.code === 'Escape') closeModal();
      return;
    }
    if (e.code === 'Space' || e.code === 'Enter') startRun();
  } else if (S.state === 'paused') {
    if (modalOpen()) {
      if (e.code === 'Escape') closeModal();
      return;
    }
    if (e.code === 'Escape' || e.code === 'KeyP' || e.code === 'Space' || e.code === 'Enter') resumeGame();
    if (e.code === 'KeyR') startRun();
  } else if (S.state === 'dead') {
    if (S.deadTimer > 0.55 && (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyR')) startRun();
    if (e.code === 'Escape' && S.deadTimer > 0.3) toMenu();
  }
  if (e.code === 'KeyM') {
    const m = audio.toggleMute();
    toast(m ? 'MUTED' : 'SOUND ON');
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => {
  keys.clear();
  if (S.state === 'playing') pauseGame();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && S.state === 'playing') pauseGame();
});

// ---------------------------------------------------------------- touch controls
// Hold the left / right half of the screen to steer (multi-touch, fingers can slide across).
// Swipe up = jump, swipe down = dash, or use the on-screen buttons.
let touchMode = coarse;
const touches = new Map(); // pointerId -> { x, y, t, sx, sy, fired }
const touchEl = $('touch');
function setTouchMode(on) {
  if (touchMode === on) return;
  touchMode = on;
  touchEl.classList.toggle('show', on && S.state === 'playing');
  document.body.classList.toggle('touch', on);
}
document.body.classList.toggle('touch', touchMode);
function steerFromTouches() {
  let s = 0;
  for (const t of touches.values()) s += t.x < innerWidth / 2 ? -1 : 1;
  input.touchSteer = Math.max(-1, Math.min(1, s));
}
touchEl.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  e.preventDefault();
  unlockAudio();
  try {
    touchEl.setPointerCapture(e.pointerId);
  } catch {}
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), fired: false });
  steerFromTouches();
});
touchEl.addEventListener('pointermove', (e) => {
  const t = touches.get(e.pointerId);
  if (!t) return;
  t.x = e.clientX;
  t.y = e.clientY;
  const dy = e.clientY - t.sy;
  const fast = performance.now() - t.t < 350;
  if (!t.fired && fast && Math.abs(dy) > 38 && Math.abs(dy) > Math.abs(e.clientX - t.sx) * 1.2) {
    t.fired = true;
    if (dy < 0) input.jumpQueued = JUMP_BUFFER;
    else input.dashQueued = true;
  }
  steerFromTouches();
});
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'])
  touchEl.addEventListener(ev, (e) => {
    touches.delete(e.pointerId);
    steerFromTouches();
  });
for (const [id, fn] of [
  ['tb-jump', () => (input.jumpQueued = JUMP_BUFFER)],
  ['tb-dash', () => (input.dashQueued = true)],
]) {
  $(id).addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    unlockAudio();
    fn();
  });
}
// any real touch anywhere switches to touch UI; any key press switches back
addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') setTouchMode(true);
}, true);
addEventListener('keydown', () => setTouchMode(false), true);
addEventListener('contextmenu', (e) => e.preventDefault());
// iOS only unlocks audio on touchend/click
for (const ev of ['touchend', 'click']) addEventListener(ev, () => unlockAudio(), { passive: true });

function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let p = null;
  for (const g of pads) if (g && g.connected) p = p || g;
  const pad = input.pad;
  if (!p) {
    pad.steer = 0;
    return;
  }
  let ax = p.axes[0] || 0;
  if (Math.abs(ax) < 0.18) ax = 0;
  if (p.buttons[14] && p.buttons[14].pressed) ax = -1;
  if (p.buttons[15] && p.buttons[15].pressed) ax = 1;
  pad.steer = ax;
  const a = !!(p.buttons[0] && p.buttons[0].pressed);
  const b = !!((p.buttons[1] && p.buttons[1].pressed) || (p.buttons[2] && p.buttons[2].pressed) || (p.buttons[7] && p.buttons[7].pressed));
  const st = !!(p.buttons[9] && p.buttons[9].pressed);
  if (a && !pad.a) {
    if (S.state === 'playing') input.jumpQueued = JUMP_BUFFER;
    else if (S.state === 'menu' && !modalOpen()) startRun();
    else if (S.state === 'dead' && S.deadTimer > 0.55) startRun();
    else if (S.state === 'paused') resumeGame();
  }
  if (b && !pad.b && S.state === 'playing') input.dashQueued = true;
  if (st && !pad.start) {
    if (S.state === 'playing') pauseGame();
    else if (S.state === 'paused') resumeGame();
  }
  pad.a = a;
  pad.b = b;
  pad.start = st;
}

function readSteer() {
  let s = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) s -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) s += 1;
  s += input.touchSteer || 0;
  s += input.pad.steer;
  return THREE.MathUtils.clamp(s, -1, 1);
}

// ============================================================================ game state
const S = {
  state: 'menu',
  mode: settings.mode,
  time: 0,
  runTime: 0,
  distance: 0,
  score: 0,
  gems: 0,
  level: 0,
  deadTimer: 0,
  cause: '',
  slowmo: 1,
  shake: 0,
  fovKick: 0,
  acc: 0,
  stuck: 0,
  bestAtStart: 0,
};
const ball = createBall();
const renderPos = new THREE.Vector3();

function resetWorld() {
  const hints = save.runs < 8;
  // ?seed=123 replays the same track (handy for sharing a run or testing)
  const urlSeed = parseInt(new URLSearchParams(location.search).get('seed'), 10);
  track.reset(Number.isFinite(urlSeed) ? urlSeed : (Math.random() * 2 ** 31) | 0, S.mode, hints && S.mode === 'plus');
  track.update(0);
  // drop in at the top of the run-in chute, like the original
  ball.pos.copy(track.startPos);
  ball.prev.copy(ball.pos);
  ball.vel.set(0, 0, -2);
  ball.quat.identity();
  ball.grounded = false;
  ball.coyote = 0;
  ball.jumpLock = 0;
  ball.dashCD = 0;
  ball.dashTime = 0;
  ball.phase = 0;
  ball.shield = false;
  ball.invuln = 0;
  ball.alive = true;
  ball.airTime = 0;
  ballMesh.visible = true;
  shards.hide();
  particles.clear();
  S.time = 0;
  S.runTime = 0;
  S.distance = 0;
  S.score = 0;
  S.gems = 0;
  S.section = 0;
  S.lastPid = 0;
  S.secretShown = false;
  S.sectionStart = 0;
  S.powers = { magnet: 0, double: 0, slowmo: 0 };
  trail.reset();
  S.deadTimer = 0;
  S.slowmo = 1;
  S.shake = 0;
  S.acc = 0;
  S.stuck = 0;
  setThemeInstant(0);
  setUiTheme(0);
  audio.intensity = 0;
  camera.position.copy(ball.pos).add(CAM_START);
  camOffset.copy(CAM_START);
  camFollow.copy(ball.pos);
}

function startRun() {
  unlockAudio();
  closeModal();
  resetWorld();
  S.state = 'playing';
  S.bestAtStart = save.best[S.mode] || 0;
  showScreen(null);
  $('hud').classList.add('show');
  $('hud').classList.toggle('classic', S.mode === 'classic');
  touchEl.classList.toggle('show', touchMode);
  touches.clear();
  input.touchSteer = 0;
  $('touch').classList.toggle('classic', S.mode === 'classic');
  $('hud-best').innerHTML = `BEST <b>${S.bestAtStart}</b>`;
  banner('GO!');
  audio.play('go');
  $('c').focus();
}

function pauseGame() {
  if (S.state !== 'playing') return;
  S.state = 'paused';
  touchEl.classList.remove('show');
  showScreen('pause');
  audio.setMotion(false, 0, false);
}
function resumeGame() {
  if (S.state !== 'paused') return;
  closeModal();
  S.state = 'playing';
  showScreen(null);
  touchEl.classList.toggle('show', touchMode);
  S.acc = 0;
  $('c').focus();
}
function toMenu() {
  closeModal();
  S.state = 'menu';
  $('hud').classList.remove('show');
  $('touch').classList.remove('show');
  resetWorld();
  refreshMenu();
  showScreen('menu');
  audio.setMotion(false, 0, false);
}

function die(cause) {
  if (!ball.alive) return;
  ball.alive = false;
  S.state = 'dead';
  touchEl.classList.remove('show');
  touches.clear();
  input.touchSteer = 0;
  S.deadTimer = 0;
  S.cause = cause;
  audio.setMotion(false, 0, false);
  if (cause === 'crash') {
    ballMesh.visible = false;
    bubble.visible = false;
    marker.hide();
    shards.explode(ball.pos, ball.vel);
    particles.burst(ball.pos, new THREE.Color('#c83040'), 30, 16, { life: 0.8, size: 0.45, drag: 1.2, gravity: -18 });
    audio.play('crash');
    S.slowmo = 0.25;
    if (settings.shake) S.shake = 1.2;
  } else {
    audio.play('fall');
  }
  // record
  const best = save.best[S.mode] || 0;
  const newBest = S.score > best;
  if (newBest) save.best[S.mode] = S.score;
  save.gems += S.gems;
  save.runs++;
  save.totalDistance += Math.floor(S.distance);
  persist();
  setTimeout(() => showGameOver(newBest), cause === 'crash' ? 900 : 1100);
}

function showGameOver(newBest) {
  if (S.state !== 'dead') return;
  $('over-title').textContent = S.cause === 'crash' ? 'CRASHED' : 'YOU FELL';
  $('over-cause').textContent = S.cause === 'crash' ? 'You hit an obstacle.' : 'Off the edge into the void.';
  $('over-score').textContent = S.score;
  $('over-best').textContent = save.best[S.mode];
  $('over-gems').textContent = '+' + S.gems;
  $('over-dist').textContent = Math.floor(S.distance) + ' m';
  $('over-time').textContent = S.runTime.toFixed(1) + 's';
  $('over-newbest').classList.toggle('show', newBest && S.score > 0);
  showScreen('over');
}

// ============================================================================ physics
const _tmp = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _col = new THREE.Color();
const GOLD = new THREE.Color('#ffc928');

function givePower(type) {
  const info = POWER_INFO[type];
  if (type === 'shield') {
    ball.shield = true;
    audio.play('shield');
  } else {
    S.powers[type] = info.time;
    audio.play(type === 'slowmo' ? 'shield' : 'buy');
  }
  toast(info.label);
}
const timeScale = () => (S.powers && S.powers.slowmo > 0 ? 0.6 : 1) * (window.__timeScale || 1);

function stepBall(h) {
  const b = ball;
  const plus = S.mode === 'plus';
  const ctl = input.ctl;
  ctl.steer = readSteer() * settings.sensitivity;
  ctl.target = sectionSpeed(S.section) + Math.min((S.distance - S.sectionStart) * 0.003, 3);
  ctl.gravity = gravityFor(S.section);
  ctl.jumpV = jumpVFor(S.section);
  ctl.steerAcc = steerFor(S.section);
  ctl.latDamp = latDampFor(S.section);
  ctl.latCap = latCapFor(S.section);
  ctl.plus = plus;
  ctl.jumpQueued = input.jumpQueued;
  ctl.dashQueued = input.dashQueued;
  const { grounded, groundBox, wasGrounded, impact, wall, jumped, dashed, fwd } = stepController(b, h, ctl, track.tiles, track.towers);
  // score: +1 for every obstacle you get through (the original's score points at the end of each)
  for (const sp of track.scores) {
    if (sp.done || b.pos.z > sp.z) continue;
    sp.done = true;
    S.score += S.powers.double > 0 ? 2 : 1;
  }
  // the hidden routes: tunnel roofs and the outside of the speed tunnels
  if (grounded && groundBox && groundBox.secret && !groundBox.found) {
    groundBox.found = true;
    if (!S.secretShown) {
      S.secretShown = true;
      banner('SECRET ROUTE!');
      audio.play('level');
    }
  }
  // speed tunnel pads
  for (const tr of track.triggers) {
    if (tr.fired || b.pos.z > tr.z) continue;
    tr.fired = true;
    S.section = tr.section;
    S.sectionStart = S.distance;
    theme.target = S.section;
    setUiTheme(S.section);
    audio.intensity = S.section;
    audio.play('level');
    banner('SPEED UP');
    S.fovKick = 10;
  }
  input.jumpQueued = ctl.jumpQueued;
  input.dashQueued = ctl.dashQueued;
  if (jumped) {
    audio.play('jump');
    flashAbility('ab-jump');
  }
  if (dashed) {
    S.fovKick = 9;
    audio.play('dash');
    flashAbility('ab-dash');
  }
  if (grounded && !wasGrounded) {
    if (impact > 6) {
      audio.play('land', impact / 30);
      if (impact > 14 && settings.shake) S.shake = Math.max(S.shake, Math.min(impact / 70, 0.35));
    }
  }
  if (wall > 5) audio.play('bump');

  // rolling rotation
  _axis.crossVectors(b.groundN, b.vel);
  const w = _axis.length() / BALL_R;
  if (w > 1e-4) {
    _axis.normalize();
    _dq.setFromAxisAngle(_axis, w * h);
    b.quat.premultiply(_dq);
  }

  // hazards
  for (const hz of track.hazards) {
    if (!hz.alive) continue;
    if (!boundsOverlapSphere(hz.box, b.pos, BALL_R)) continue;
    if (!sphereTouchesBox(b.pos, BALL_R * 0.92, hz.box)) continue;
    if (b.phase > 0 || b.invuln > 0) {
      continue;
    }
    if (b.shield) {
      b.shield = false;
      b.invuln = 0.6;
      track.killHazard(hz);
      audio.play('shieldBreak');
      particles.burst(hz.box.pos, new THREE.Color('#c83040'), 24, 12, { life: 0.6, size: 0.45, gravity: -18 });
      if (settings.shake) S.shake = 0.5;
      toast('SHIELD BROKEN');
      continue;
    }
    die('crash');
    return;
  }

  // gems
  const gr = (BALL_R + 0.95) ** 2;
  for (const g of track.gems) {
    if (g.taken) continue;
    if (g.pos.distanceToSquared(b.pos) < gr) {
      track.takeGem(g);
      S.gems++;
      audio.play('gem', S.gems);
      particles.burst(g.pos, GOLD, 6, 4, { life: 0.35, size: 0.25, gravity: 0 });
    }
  }
  for (const p of track.pickups) {
    if (p.taken) continue;
    if (p.pos.distanceToSquared(b.pos) < 2.6 * 2.6) {
      p.taken = true;
      p.mesh.visible = false;
      givePower(p.type);
    }
  }
  // coin magnet: pull nearby coins in
  if (S.powers.magnet > 0) {
    for (const g of track.gems) {
      if (g.taken) continue;
      const d2 = g.pos.distanceToSquared(b.pos);
      if (d2 < 11 * 11) g.pos.lerp(b.pos, Math.min(1, 9 * h));
    }
  }
  for (const k of ['magnet', 'double', 'slowmo']) if (S.powers[k] > 0) S.powers[k] = Math.max(0, S.powers[k] - h / timeScale());

  // progress
  const d = track.distAt(b.pos.z);
  if (d > S.distance) S.distance = d;

  // falling / stuck
  const ref = track.refAt(b.pos.z);
  if (b.pos.y < ref.y - 26) {
    die('fall');
    return;
  }
  if (fwd < 3 && S.runTime > 2) {
    S.stuck += h;
    if (S.stuck > 1.6) die('crash');
  } else S.stuck = 0;
}

// Floating origin: keep numbers small on huge runs (prevents jitter far from the start).
function maybeRecenter() {
  if (ball.pos.z > -2500) return;
  const o = new THREE.Vector3(0, -Math.round(ball.pos.y), -Math.round(ball.pos.z));
  track.shift(o);
  ball.pos.add(o);
  ball.prev.add(o);
  camera.position.add(o);
  camLook.add(o);
  particles.shift(o);
  shards.shift(o);
  trail.shift(o);
}

// ============================================================================ camera & visuals
const camLook = new THREE.Vector3();
const _desired = new THREE.Vector3();
let camUnderRoof = false;
let menuAngle = 0;

// Camera collision. The spot behind the ball is adjusted so that the ball and the road ahead stay
// in view: under a roof (tunnels) the camera stays below the ceiling; otherwise it never sinks into
// a building or rooftop (after a drop it stays above the roof you just left), and when something
// is between it and the ball it rises over it, only moving in closer as a last resort.
const _co = new THREE.Vector3(),
  _cd = new THREE.Vector3(),
  _cl = new THREE.Vector3();
const CAM_LISTS = () => [track.towers, track.tiles];

// first hit along the segment a→b (0..1 of its length), or Infinity
function sightBlocked(a, b) {
  _cd.subVectors(b, a);
  const dist = _cd.length();
  if (dist < 0.3) return Infinity;
  _cd.divideScalar(dist);
  const zlo = Math.min(a.z, b.z) - 1,
    zhi = Math.max(a.z, b.z) + 1;
  let t = dist;
  for (const list of CAM_LISTS()) {
    for (const o of list) {
      const bx = o.box;
      if (bx.max.z < zlo || bx.min.z > zhi) continue;
      const d = rayBox(a, _cd, bx, t);
      if (d < t && d > 0) t = d; // (a box the eye itself is in doesn't count)
    }
  }
  return t < dist ? t : Infinity;
}

// Lowest height the camera may have at p (or -Infinity): `clr` above the tops of buildings it is
// inside / just above, and above rooftops it is over (never ones it is underneath).
function minCamY(p, clr) {
  let need = -Infinity;
  for (const o of track.towers) {
    const b = o.box;
    if (p.z < b.min.z - clr || p.z > b.max.z + clr || p.x < b.min.x - clr || p.x > b.max.x + clr) continue;
    if (p.y < b.min.y || p.y >= b.max.y + clr) continue;
    if (b.max.y + clr > need) need = b.max.y + clr;
  }
  for (const o of track.tiles) {
    const b = o.box;
    if (p.z < b.min.z - clr || p.z > b.max.z + clr || p.x < b.min.x - clr || p.x > b.max.x + clr) continue;
    _cl.copy(p).sub(b.pos).applyQuaternion(b.invQuat);
    if (Math.abs(_cl.x) > b.half.x + clr || Math.abs(_cl.z) > b.half.z + clr) continue;
    if (_cl.y < 0 || _cl.y >= b.half.y + clr) continue; // underneath it (a roof), or already clear
    const upY = _cd.set(0, 1, 0).applyQuaternion(b.quat).y;
    if (upY < 0.3) continue; // walls / tube panels
    const y = p.y + (b.half.y + clr - _cl.y) / upY;
    if (y > need) need = y;
  }
  return need;
}

// lowest ceiling straight above the ball (and above the spot behind it, where the camera goes)
const _up = new THREE.Vector3(0, 1, 0);
function ceilingAbove(p, maxH) {
  let t = maxH;
  for (const list of CAM_LISTS()) {
    for (const o of list) {
      const b = o.box;
      if (b.max.z < p.z - 12 || b.min.z > p.z + 12 || b.min.y > p.y + maxH || b.max.y < p.y) continue;
      for (const dz of [0, 6]) {
        _co.set(p.x, p.y, p.z + dz);
        const d = rayBox(_co, _up, b, t);
        if (d < t && d > 0.2) t = d;
      }
    }
  }
  return t;
}

// Moves `cam` (a desired or actual camera position) to a spot with a clear view of the ball.
const _eye = new THREE.Vector3(),
  _try = new THREE.Vector3();
function clearCameraSpot(cam, underRoof) {
  if (window.__noCamClear) return; // debug switch for tests
  _eye.copy(renderPos);
  _eye.y += 0.6;
  if (!underRoof) {
    // out of buildings / off rooftops
    for (let k = 0; k < 3; k++) {
      const y = minCamY(cam, 0.7);
      if (!(y > cam.y)) break;
      cam.y = y + 0.01;
    }
    if (sightBlocked(_eye, cam) === Infinity) return;
    // something in the way: look over it
    for (let k = 1; k <= 8; k++) {
      _try.copy(cam);
      _try.y += k * 1.5;
      if (sightBlocked(_eye, _try) === Infinity && !(minCamY(_try, 0.7) > _try.y)) {
        cam.copy(_try);
        return;
      }
    }
  } else if (sightBlocked(_eye, cam) === Infinity) return;
  // last resort: come in closer along the sight line
  const t = sightBlocked(_eye, cam);
  if (t === Infinity) return;
  _cd.subVectors(cam, _eye).normalize();
  cam.copy(_eye).addScaledVector(_cd, Math.max(t - 0.5, 1.2));
}

// Keep roughly the same horizontal view on tall/narrow (portrait phone) screens.
function fitFov(vfov) {
  const aspect = camera.aspect;
  if (aspect >= 1.3) return vfov;
  const h = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(vfov) / 2) * 1.3);
  const v = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(h / 2) / aspect));
  return Math.min(v, 100);
}

function damp(a, b, k, dt) {
  return a + (b - a) * (1 - Math.exp(-k * dt));
}

// The original's camera rig is pinned to the ball and looks down the 45° slope at a fixed angle;
// in tunnels it tucks in close behind the ball (and stays centred on the tunnel).
const CAM_START = new THREE.Vector3(0, 12.13, 8.07); // the original's camera spot (×2)
const CAM_CLOSE = new THREE.Vector3(0, 5.4, 6.2);
const CAM_PITCH = THREE.MathUtils.degToRad(-45.23);
const camOffset = new THREE.Vector3().copy(CAM_START);
const camFollow = new THREE.Vector3();
function updateCamera(dt) {
  const p = renderPos;
  if (S.state === 'menu') {
    menuAngle += dt * 0.12;
    const r = 15;
    _desired.set(p.x + Math.sin(menuAngle) * r, p.y + 6 + Math.sin(menuAngle * 0.7) * 1.5, p.z + Math.cos(menuAngle) * r);
    camera.position.lerp(_desired, 1 - Math.exp(-2 * dt));
    camLook.lerp(_tmp.set(p.x, p.y - 2, p.z - 8), 1 - Math.exp(-3 * dt));
    camera.lookAt(camLook);
    camera.fov = damp(camera.fov, fitFov(62), 3, dt);
    camera.updateProjectionMatrix();
    camFollow.copy(p);
    return;
  }
  const speed = Math.max(-ball.vel.z, 0);
  let zone = null;
  if (S.state !== 'dead' || S.cause === 'crash') {
    zone = S.state === 'dead' ? null : track.camZoneAt(p.z);
    camOffset.lerp(zone ? CAM_CLOSE : CAM_START, 1 - Math.exp(-(zone ? 4 : 1.6) * dt));
    const tx = zone ? THREE.MathUtils.clamp(p.x, zone.x - 4, zone.x + 4) : p.x;
    camFollow.x = damp(camFollow.x, tx, 10, dt);
    camFollow.y = damp(camFollow.y, p.y, 22, dt);
    camFollow.z = p.z;
    _desired.copy(camFollow).add(camOffset);
    if (S.state !== 'dead') clearCameraSpot(_desired, !!zone);
    camera.position.copy(_desired);
    camera.rotation.set(CAM_PITCH, 0, 0);
  } else {
    // fell: the camera stays where it was and watches the ball drop away
    camLook.lerp(p, 1 - Math.exp(-4 * dt));
    camera.lookAt(camLook);
  }
  camUnderRoof = !!zone;
  if (S.state !== 'dead') camLook.copy(p);
  // lateral lean
  camera.rotateZ(THREE.MathUtils.clamp(-ball.vel.x * 0.003, -0.06, 0.06));
  // shake
  if (S.shake > 0) {
    const s = S.shake * S.shake * 0.35;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
    S.shake = Math.max(0, S.shake - dt * 2.2);
  }
  S.fovKick = damp(S.fovKick, 0, 4, dt);
  const fov = 62 + THREE.MathUtils.clamp((speed - 40) * 0.1, 0, 10) + S.fovKick;
  camera.fov = damp(camera.fov, fitFov(fov), 5, dt);
  camera.updateProjectionMatrix();
}

const _gemQ = new THREE.Quaternion();
const _gemS = new THREE.Vector3(1, 1, 1);
const _markerOut = { n: new THREE.Vector3(), p: new THREE.Vector3(), y: 0 };

function updateVisuals(dt) {
  // ball
  ballMesh.position.copy(renderPos);
  ballMesh.quaternion.copy(ball.quat);
  const phasing = ball.phase > 0;
  ballMat.opacity = phasing ? 0.4 : 1;
  bubble.visible = ball.shield && ball.alive;
  bubble.position.copy(renderPos);
  bubble.material.uniforms.uTime.value = S.time;

  if (ball.alive && S.state !== 'menu') trail.update(_tmp.copy(renderPos).addScaledVector(ball.groundN, -BALL_R + 0.03), ball.groundN, ball.grounded);
  trail.mesh.visible = S.state !== 'menu';

  // contact shadow under the ball (doubles as a landing guide in the air)
  if (ball.alive && S.state !== 'dead') {
    let best = -Infinity;
    const n = new THREE.Vector3();
    for (const t of track.tiles) {
      if (!t.box.surface) continue;
      if (renderPos.z < t.box.min.z - 1 || renderPos.z > t.box.max.z + 1) continue;
      if (topHeightBelow(t.box, renderPos, _markerOut) && _markerOut.y > best) {
        best = _markerOut.y;
        n.copy(_markerOut.n);
      }
    }
    if (best > -Infinity) marker.place(_tmp.set(renderPos.x, best, renderPos.z), n, renderPos.y - best);
    else marker.hide();
  } else marker.hide();

  // gems spin
  const pool = pools.gems;
  for (const g of track.gems) {
    if (g.taken) continue;
    _gemQ.setFromAxisAngle(_axis.set(0, 1, 0), S.time * 2.5 + g.phase);
    _tmp.copy(g.pos);
    _tmp.y += Math.sin(S.time * 3 + g.phase) * 0.15;
    pool.set(g.slot, _tmp, _gemQ, _gemS);
  }
  for (const p of track.pickups) {
    p.mesh.rotation.y += dt * 2;
    p.mesh.rotation.x += dt * 0.7;
  }

  // lights follow
  sun.position.set(renderPos.x - 4, renderPos.y + 10, renderPos.z + 6);
  sun.target.position.copy(renderPos);

  tileMat.uniforms.uTime.value = S.time;
  hazardMat.uniforms.uTime.value = S.time;
  bg.update(dt, camera);
  particles.update(dt);
  shards.update(dt);
  // upload every pool that changed this frame (buildings and pads included: a pool that isn't
  // flushed keeps drawing whatever was there when it was first uploaded)
  for (const k in pools) pools[k].flush();
}

// ============================================================================ HUD
const hudCache = {};
function setText(id, v) {
  if (hudCache[id] === v) return;
  hudCache[id] = v;
  $(id).textContent = v;
}
function setRing(id, p, ready) {
  const el = $(id);
  const key = id + 'p';
  const v = Math.round(p * 50) / 50;
  if (hudCache[key] !== v) {
    hudCache[key] = v;
    const bar = el.querySelector('.bar');
    if (bar) bar.style.setProperty('--p', v);
  }
  if (hudCache[id + 'r'] !== ready) {
    hudCache[id + 'r'] = ready;
    el.classList.toggle('ready', ready);
  }
}
function flashAbility() {}
function updateHud() {
  if (hudCache.score !== S.score) {
    hudCache.score = S.score;
    drawDotScore($('hud-score'), S.score);
  }
  // shown in the original's units (the world here is drawn at twice its scale)
  setText('hud-speed', String(Math.round(ball.vel.length() * 1.8)));
  setText('hud-level', 'SECTION ' + (S.section + 1));
  const gemsEl = $('hud-gems').querySelector('b');
  if (hudCache.gems !== S.gems) {
    hudCache.gems = S.gems;
    gemsEl.textContent = S.gems;
  }
  if (S.mode === 'plus') {
    setRing('ab-jump', ball.coyote > 0 ? 1 : 0.25, ball.coyote > 0);
    setRing('ab-dash', 1 - ball.dashCD / DASH_CD, ball.dashCD <= 0);
    const cool = ball.dashCD > 0;
    if (hudCache.dashCool !== cool) {
      hudCache.dashCool = cool;
      $('tb-dash').classList.toggle('cooling', cool);
    }
  }
  const pw = POWERUPS.filter((k) => k !== 'shield' && S.powers[k] > 0)
    .map((k) => `${k}:${Math.ceil(S.powers[k])}`)
    .join(',');
  if (hudCache.powers !== pw) {
    hudCache.powers = pw;
    $('hud-powers').innerHTML = POWERUPS.filter((k) => k !== 'shield' && S.powers[k] > 0)
      .map((k) => `<span style="--c:${POWER_INFO[k].color}">${POWER_INFO[k].label} ${Math.ceil(S.powers[k])}</span>`)
      .join('');
  }
  const sh = ball.shield;
  if (hudCache.shield !== sh) {
    hudCache.shield = sh;
    $('ab-shield').classList.toggle('on', sh);

  }
  if (S.score > S.bestAtStart && S.bestAtStart > 0 && !hudCache.bestBeaten) {
    hudCache.bestBeaten = true;
    toast('NEW BEST!');
  }
}

// Dot-matrix score like the original's LED digits
const DIGITS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};
function drawDotScore(canvas, n) {
  const str = String(n);
  const dot = 7,
    pitch = 9,
    gapDigit = 10;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = str.length * (5 * pitch) + (str.length - 1) * gapDigit;
  const h = 7 * pitch;
  if (canvas.width !== Math.ceil(w * dpr)) {
    canvas.width = Math.ceil(w * dpr);
    canvas.height = Math.ceil(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--neon').trim() || '#1eff3c';
  let x0 = 0;
  for (const ch of str) {
    const rows = DIGITS[ch];
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 5; c++) {
        if (rows[r][c] !== '1') continue;
        g.beginPath();
        g.arc(x0 + c * pitch + pitch / 2, r * pitch + pitch / 2, dot / 2, 0, Math.PI * 2);
        g.fill();
      }
    x0 += 5 * pitch + gapDigit;
  }
}

let toastTimer = 0;
function toast(msg) {
  banner(msg, true);
}
function banner(msg) {
  const el = $('banner');
  el.textContent = msg;
  el.classList.remove('go');
  void el.offsetWidth;
  el.classList.add('go');
  clearTimeout(toastTimer);
}

// ============================================================================ screens / menus
function showScreen(id) {
  for (const s of ['menu', 'pause', 'over', 'loading']) $(s).classList.toggle('show', s === id);
}
function modalOpen() {
  return $('modal').classList.contains('show');
}
function openModal(panel) {
  audio.play('click');
  $('modal').classList.add('show');
  for (const s of $('modal').querySelectorAll('section')) s.classList.toggle('show', s.dataset.panel === panel);
  if (panel === 'skins') buildSkins();
  if (panel === 'settings') syncSettingsUI();
}
function closeModal() {
  $('modal').classList.remove('show');
}

function refreshMenu() {
  for (const b of document.querySelectorAll('.mode')) b.classList.toggle('active', b.dataset.mode === S.mode);
  $('menu-best').textContent = save.best[S.mode] || 0;
  $('menu-gems').textContent = save.gems;
  hudCache.bestBeaten = false;
}

for (const b of document.querySelectorAll('.mode'))
  b.addEventListener('click', () => {
    S.mode = b.dataset.mode;
    settings.mode = S.mode;
    persist();
    audio.play('click');
    refreshMenu();
    resetWorld();
  });

$('btn-play').addEventListener('click', startRun);
$('btn-skins').addEventListener('click', () => openModal('skins'));
$('btn-settings').addEventListener('click', () => openModal('settings'));
$('btn-help').addEventListener('click', () => openModal('help'));
$('modal-close').addEventListener('click', closeModal);
$('modal').addEventListener('pointerdown', (e) => {
  if (e.target === $('modal')) closeModal();
});
$('btn-resume').addEventListener('click', resumeGame);
$('btn-restart').addEventListener('click', startRun);
$('btn-pause-settings').addEventListener('click', () => openModal('settings'));
$('btn-quit').addEventListener('click', toMenu);
$('btn-retry').addEventListener('click', startRun);
$('btn-over-menu').addEventListener('click', toMenu);
$('btn-pause').addEventListener('click', pauseGame);

function syncSettingsUI() {
  $('set-quality').value = settings.quality;
  $('set-music').value = settings.music;
  $('set-sfx').value = settings.sfx;
  $('set-sens').value = settings.sensitivity;
  $('set-shake').checked = settings.shake;
  $('set-fps').checked = settings.showFps;
}
$('set-quality').addEventListener('change', (e) => {
  settings.quality = e.target.value;
  quality = settings.quality === 'auto' ? autoDefault() : settings.quality;
  applyQuality();
  persist();
});
$('set-music').addEventListener('input', (e) => {
  settings.music = +e.target.value;
  audio.setVolumes(settings.sfx, settings.music);
  if (settings.music > 0) {
    unlockAudio();
  }
  persist();
});
$('set-sfx').addEventListener('input', (e) => {
  settings.sfx = +e.target.value;
  audio.setVolumes(settings.sfx, settings.music);
  persist();
});
$('set-sfx').addEventListener('change', () => audio.play('gem', 2));
$('set-sens').addEventListener('input', (e) => {
  settings.sensitivity = +e.target.value;
  persist();
});
$('set-shake').addEventListener('change', (e) => {
  settings.shake = e.target.checked;
  persist();
});
$('set-fps').addEventListener('change', (e) => {
  settings.showFps = e.target.checked;
  $('fps').textContent = '';
  persist();
});
$('btn-reset').addEventListener('click', () => {
  if (!confirm('Reset best scores, gems and skins?')) return;
  save = resetSave();
  Object.assign(settings, save.settings);
  save.settings = settings;
  persist();
  applySkin(save.skin);
  syncSettingsUI();
  refreshMenu();
});

function buildSkins() {
  $('skins-gems').textContent = save.gems;
  const grid = $('skin-grid');
  grid.innerHTML = '';
  for (const sk of SKINS) {
    const owned = save.owned.includes(sk.id);
    const el = document.createElement('button');
    el.className = 'skin' + (owned ? '' : ' locked') + (save.skin === sk.id ? ' selected' : '');
    el.appendChild(skinPreview(sk.id));
    const name = document.createElement('div');
    name.textContent = sk.name;
    el.appendChild(name);
    const sub = document.createElement('small');
    sub.innerHTML = save.skin === sk.id ? 'EQUIPPED' : owned ? 'Tap to equip' : `<i class="gem-ico"></i> ${sk.price}`;
    el.appendChild(sub);
    el.addEventListener('click', () => {
      if (owned) {
        save.skin = sk.id;
        applySkin(sk.id);
        audio.play('click');
      } else if (save.gems >= sk.price) {
        save.gems -= sk.price;
        save.owned.push(sk.id);
        save.skin = sk.id;
        applySkin(sk.id);
        audio.play('buy');
      } else {
        audio.play('deny');
        el.animate([{ transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 180 });
        return;
      }
      persist();
      refreshMenu();
      buildSkins();
    });
    grid.appendChild(el);
  }
}

function fatal(msg) {
  const el = document.getElementById('err');
  document.getElementById('err-msg').textContent = msg;
  for (const s of document.querySelectorAll('.screen')) s.classList.remove('show');
  el.classList.add('show');
}

// ============================================================================ main loop
let last = performance.now();
let fpsFrames = 0,
  fpsTime = 0,
  perfTime = 0,
  perfFrames = 0,
  lowStrikes = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  pollGamepad();

  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    if (settings.showFps) $('fps').textContent = Math.round(fpsFrames / fpsTime) + ' fps · ' + quality;
    fpsFrames = 0;
    fpsTime = 0;
  }

  if (S.state === 'playing') {
    const ts = timeScale();
    S.acc += dt * ts;
    let steps = 0;
    while (S.acc >= STEP && steps < 12) {
      ball.prev.copy(ball.pos);
      stepBall(STEP);
      S.acc -= STEP;
      steps++;
      if (S.state !== 'playing') break;
    }
    if (steps >= 12) S.acc = 0;
    S.runTime += dt;
    S.time += dt * ts;
    renderPos.lerpVectors(ball.prev, ball.pos, THREE.MathUtils.clamp(S.acc / STEP, 0, 1));
    audio.setMotion(ball.grounded, -ball.vel.z, true);
    updateHud();
    autoQuality(dt);
  } else if (S.state === 'dead') {
    S.deadTimer += dt;
    S.slowmo = damp(S.slowmo, 1, 2, dt);
    const sdt = dt * S.slowmo;
    S.time += sdt;
    if (S.cause === 'fall') {
      ball.vel.y -= GRAVITY * sdt;
      ball.pos.addScaledVector(ball.vel, sdt);
      renderPos.copy(ball.pos);
    }
    dt = sdt;
  } else if (S.state === 'menu') {
    S.time += dt;
    renderPos.copy(ball.pos);
  }

  if (S.state !== 'paused') {
    track.update(ball.pos.z);
    track.animate(S.time);
    maybeRecenter();
    updateTheme(dt);
    updateCamera(dt);
    updateVisuals(dt);
  }

  renderer.render(scene, camera);
}

function autoQuality(dt) {
  if (settings.quality !== 'auto') return;
  perfTime += dt;
  perfFrames++;
  if (perfTime < 2.5) return;
  const fps = perfFrames / perfTime;
  perfTime = 0;
  perfFrames = 0;
  if (fps < 45 && quality !== 'low') {
    lowStrikes++;
    if (lowStrikes >= 2) {
      quality = quality === 'high' ? 'medium' : 'low';
      save.autoLevel = quality;
      persist();
      applyQuality();
      lowStrikes = 0;
    }
  } else lowStrikes = 0;
}

// ============================================================================ boot
try {
  resetWorld();
  refreshMenu();
  // warm up shaders so the first frame of play doesn't hitch
  renderer.compile(scene, camera);
  showScreen('menu');
  requestAnimationFrame((t) => {
    last = t;
    frame(t);
  });
} catch (e) {
  console.error(e);
  fatal('Something went wrong while starting: ' + e.message);
}

renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  if (S.state === 'playing') pauseGame();
});

// debug / testing hooks
window.__slope = { S, ball, track, startRun, camera, pools, THREE, sectionSpeed, renderPos, rayBox, cam: { sightBlocked, minCamY, ceilingAbove, clearCameraSpot, camLook }, scene, renderer, ballMesh };
