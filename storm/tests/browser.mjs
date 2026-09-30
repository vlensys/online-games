// Browser smoke tests with Playwright (Chromium + SwiftShader).
// 1) serve the repo root:   npx http-server -p 8091 -c-1 .
// 2) run:                   node storm/tests/browser.mjs
// Env: BASE (default http://localhost:8091/storm/), PLAYWRIGHT (path to playwright's index.mjs)
const BASE = process.env.BASE || 'http://localhost:8091/storm/';
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

// ---------------------------------------------------------------- menu + solo match
{
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  watch('solo', page);
  await page.goto(BASE + '?quality=low');
  await wait(page, 3000);
  check('menu renders', await page.isVisible('#menuMain'));
  await page.goto(BASE + '?debug=1&autostart=1&bots=12&quality=low&timescale=8');
  let res = null;
  for (let i = 0; i < 90 && !res; i++) {
    await wait(page, 3000);
    res = await page.evaluate(() => {
      const g = window.__storm;
      return g && g.ended && !document.getElementById('results').classList.contains('hidden') ? document.getElementById('resTitle').textContent : null;
    });
  }
  check('solo match reaches the results screen', !!res, res || 'timeout');
  await page.close();
}

// ---------------------------------------------------------------- mobile
{
  const d = devices['iPhone 13 landscape'] || devices['iPhone 13'];
  const ctx = await browser.newContext({ ...d });
  const page = await ctx.newPage();
  watch('mobile', page);
  await page.goto(BASE + '?quality=low');
  await wait(page, 3000);
  await page.tap('#menuMain .btn.primary');
  await wait(page, 500);
  await page.tap('#soloStart');
  await wait(page, 9000);
  const ok = await page.evaluate(() => document.body.classList.contains('touch') && !document.getElementById('touch').classList.contains('hidden') && !!window.__storm);
  check('touch controls shown on a phone', ok);
  await ctx.close();
}

// ---------------------------------------------------------------- two tabs, local transport
{
  const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const host = await ctx.newPage();
  const cli = await ctx.newPage();
  watch('host', host);
  watch('client', cli);
  const url = BASE + '?net=local&debug=1&quality=low';
  await host.goto(url);
  await cli.goto(url);
  await wait(host, 2500);
  await host.click('[data-go="host"]');
  await wait(host, 1200);
  await host.fill('#hostPw', 'secret');
  await host.evaluate(() => {
    const el = document.getElementById('hostBots');
    el.value = 5;
    el.dispatchEvent(new Event('input'));
  });
  await wait(host, 500);
  const addr = await host.textContent('#hostAddr');
  check('host shows an address', /\d+\.\d+\.\d+\.\d+:\d+/.test(addr), addr);
  await cli.click('[data-go="join"]');
  await cli.fill('#joinAddr', addr);
  await cli.fill('#joinPw', 'wrong');
  await cli.click('#joinGo');
  await wait(cli, 2500);
  check('wrong password is rejected', /wrong password/i.test(await cli.textContent('#joinStatus')));
  await cli.fill('#joinAddr', '127.0.0.1:12345');
  await cli.click('#joinGo');
  await wait(cli, 4500);
  check('unknown address reports not found', /no game found/i.test(await cli.textContent('#joinStatus')));
  await cli.fill('#joinAddr', addr);
  await cli.fill('#joinPw', 'secret');
  await cli.click('#joinGo');
  await wait(cli, 2500);
  check('client reaches the lobby', await cli.isVisible('#menuLobby'));
  await host.click('#hostStart');
  await wait(host, 9000);
  const both = await Promise.all([host, cli].map((p) => p.evaluate(() => window.__storm && window.__storm.state)));
  check('match starts on both tabs', both.every((s) => s && s !== 'wait'), both.join(','));
  await host.keyboard.press('Space');
  await cli.keyboard.press('Space');
  await wait(host, 1500);
  await host.evaluate(() => {
    const g = window.__storm;
    const p = g.map.pois[0];
    Object.assign(g.me.c, { x: p.x + 3, z: p.z + 3, y: p.y + 2, mode: 3, grounded: false, vy: 0, peakY: p.y + 2 });
    g.dbg('tp');
    g.dbg('god');
    g.dbg('give', { it: 'mats' });
  });
  await wait(host, 4000);
  const before = await cli.evaluate(() => window.__storm.world.pieces.size);
  await host.keyboard.press('KeyQ');
  await wait(host, 600);
  await host.evaluate(() => window.__storm.placePiece(window.__storm._bt));
  await wait(host, 3000);
  const after = await cli.evaluate(() => window.__storm.world.pieces.size);
  check("client sees the host's build", after === before + 1, `${before} -> ${after}`);
  const bots = await cli.evaluate(() => [...window.__storm.players.values()].filter((p) => !p.human).length);
  check('client knows the bots', bots === 5, String(bots));
  await ctx.close();
}

await browser.close();
const noErr = errors.length === 0;
check('no console errors', noErr, errors.slice(0, 5).join(' | '));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
