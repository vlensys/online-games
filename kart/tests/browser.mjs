// Browser smoke tests with Playwright (Chromium + SwiftShader).
// 1) serve the repo root:   python3 -m http.server 8091
// 2) run:                   node kart/tests/browser.mjs
// Env: BASE (default http://localhost:8091/kart/), PLAYWRIGHT (path to playwright's index.mjs)
const BASE = process.env.BASE || 'http://localhost:8091/kart/';
const ONLY = process.env.ONLY || ''; // run one group: quick, tt, mobile, online
let pw;
try {
  pw = await import(process.env.PLAYWRIGHT || 'playwright');
} catch (e) {
  pw = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
}
const { chromium, devices } = pw;
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({ args: ARGS });
const results = [];
const errors = [];
const watch = (name, page) => {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${name}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror ${e.message}`));
};
const check = (name, ok, info = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' - ' + info : ''}`);
};
const wait = (p, ms) => p.waitForTimeout(ms);
async function until(page, fn, arg, timeout = 60000, every = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    await page.waitForTimeout(every);
  }
  return null;
}

// ---------------------------------------------------------------- menu + a quick race to the finish
if (!ONLY || ONLY === 'quick') {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  watch('quick', page);
  await page.goto(BASE + '?quality=low');
  await wait(page, 3000);
  check('menu renders', await page.isVisible('#mMain'));
  await page.click('[data-go="quick"]');
  await wait(page, 500);
  check('setup lists 8 tracks and 8 drivers', (await page.locator('#picks .pick').count()) === 8 && (await page.locator('#drivers .drv').count()) === 8);
  await page.goto(BASE + '?debug=1&quality=low&autostart=quick&auto=1&track=magma&laps=1&racers=4&timescale=4');
  const res = await until(page, () => !document.getElementById('results').classList.contains('hidden') && document.getElementById('resTitle').textContent, null, 240000, 1000);
  check('quick race reaches the results', !!res, res || 'timeout');
  const rows = await page.locator('#resTable tr').count();
  check('results list every racer', rows === 5, String(rows));
  await page.close();
}

// ---------------------------------------------------------------- time trial saves a ghost
if (!ONLY || ONLY === 'tt') {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  watch('tt', page);
  await page.goto(BASE + '?debug=1&quality=low&autostart=tt&auto=1&track=star&timescale=5');
  const res = await until(page, () => !document.getElementById('results').classList.contains('hidden') && document.getElementById('resSub').textContent, null, 240000, 1000);
  check('time trial finishes and saves a ghost', !!res && /ghost/i.test(res), res || 'timeout');
  await page.close();
}

// ---------------------------------------------------------------- touch controls on a phone
if (!ONLY || ONLY === 'mobile') {
  const d = devices['iPhone 13 landscape'] || devices['iPhone 13'];
  const ctx = await browser.newContext({ ...d });
  const page = await ctx.newPage();
  watch('mobile', page);
  await page.goto(BASE + '?quality=low&debug=1');
  await wait(page, 3000);
  await page.tap('[data-go="quick"]');
  await wait(page, 400);
  await page.tap('#startBtn');
  await until(page, () => window.__kart.G && window.__kart.G.kind === 'quick', null, 30000);
  await wait(page, 1500);
  const shown = await page.evaluate(() => document.body.classList.contains('touch') && !document.getElementById('touch').classList.contains('hidden'));
  check('touch controls shown on a phone', shown);
  // hold the drift button: the kart's drift input follows it
  const box = await page.locator('[data-t="drift"]').boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  check('touch buttons respond', await page.evaluate(() => typeof window.__kart.G.me.in.drift === 'boolean'));
  await ctx.close();
}

// ---------------------------------------------------------------- online: two tabs, local transport
if (!ONLY || ONLY === 'online') {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 450 } });
  const host = await ctx.newPage();
  const cli = await ctx.newPage();
  watch('host', host);
  watch('client', cli);
  const url = BASE + '?net=local&debug=1&quality=low&auto=1&timescale=3';
  await host.goto(url);
  await cli.goto(url);
  await wait(host, 2500);
  await host.click('[data-go="online"]');
  await host.fill('#onName', 'Hosty');
  await host.fill('#hostPw', 'secret');
  await host.click('#hostOpen');
  await wait(host, 1200);
  const addr = await host.textContent('#hostAddr');
  check('host shows an address', /\d+\.\d+\.\d+\.\d+:\d+/.test(addr), addr);
  await host.click('#hostLaps button[data-v="1"]');
  await host.evaluate(() => {
    const el = document.getElementById('hostBots');
    el.value = 2;
    el.dispatchEvent(new Event('input'));
  });
  await host.selectOption('#hostTrack', 'magma');
  await cli.click('[data-go="online"]');
  await cli.click('[data-tab="join"]');
  await cli.fill('#onName', 'Clienty');
  await cli.fill('#joinAddr', addr);
  await cli.fill('#joinPw', 'wrong');
  await cli.click('#joinGo');
  await wait(cli, 2500);
  check('wrong password is rejected', /wrong password/i.test(await cli.textContent('#joinStatus')));
  await cli.fill('#joinPw', 'secret');
  await cli.click('#joinGo');
  await wait(cli, 2500);
  check('client reaches the lobby', await cli.isVisible('#mLobby'));
  check('host sees both players', (await host.locator('#lobbyList > div').count()) === 2);
  await host.click('#hostStart');
  const racing = () => window.__kart.G && (window.__kart.G.kind === 'host' || window.__kart.G.kind === 'client') && window.__kart.G.race.state === 'race' && window.__kart.G.race.karts.length;
  const both = await Promise.all([until(host, racing, null, 60000), until(cli, racing, null, 60000)]);
  check('race starts on both tabs with 4 karts', both.every((n) => n === 4), both.join(','));
  await wait(host, 6000);
  // the client sees the host's kart where the host has it, and vice versa
  const hostView = await host.evaluate(() => window.__kart.G.race.karts.map((k) => [k.ctrl, Math.round(k.x), Math.round(k.z)]));
  const cliView = await cli.evaluate(() => window.__kart.G.race.karts.map((k) => [k.ctrl, Math.round(k.x), Math.round(k.z)]));
  let maxErr = 0;
  for (let i = 0; i < hostView.length; i++) maxErr = Math.max(maxErr, Math.hypot(hostView[i][1] - cliView[i][1], hostView[i][2] - cliView[i][2]));
  check('both tabs agree where the karts are', maxErr < 25, 'max gap ' + maxErr.toFixed(1) + ' m');
  const moved = await cli.evaluate(() => window.__kart.G.race.karts.some((k) => k.ctrl === 'remote' && Math.hypot(k.vx, k.vz) > 5));
  check('client sees the other karts moving', moved);
  const res = await Promise.all([
    until(host, () => !document.getElementById('results').classList.contains('hidden') && document.getElementById('resTitle').textContent, null, 240000, 1000),
    until(cli, () => !document.getElementById('results').classList.contains('hidden') && document.getElementById('resTitle').textContent, null, 240000, 1000),
  ]);
  check('both tabs reach the results', res.every(Boolean), res.join(' | '));
  await host.click('#resNext');
  await wait(host, 1500);
  check('host returns to the lobby', await host.isVisible('#mLobby'));
  await ctx.close();
}

await browser.close();
const noErr = errors.length === 0;
check('no console errors', noErr, errors.slice(0, 5).join(' | '));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
