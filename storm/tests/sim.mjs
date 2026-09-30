// Headless match test (no browser): runs complete bot matches through the real GameServer
// and checks they finish with a single winner. Usage (from the repo root):
//   node storm/tests/sim.mjs [matches=3] [bots=30]
import { GameServer } from '../js/sim/server.js';
import { VERSION } from '../js/core/config.js';

const matches = +(process.argv[2] || 3);
const bots = +(process.argv[3] || 30);
let failed = 0;
for (let i = 0; i < matches; i++) {
  const seed = 1000 + i * 7919;
  let end = null;
  const kills = {};
  const sv = new GameServer({ bots, diff: i % 3, loot: ['normal', 'scarce', 'plentiful'][i % 3], seed }, (cid, q) => {
    for (const m of q) {
      if (m.t === 'end') end = m;
      if (m.t === 'kf') kills[m.w] = (kills[m.w] || 0) + 1;
    }
  });
  sv.open(0);
  sv.recv(0, { t: 'hello', v: VERSION, name: 'Spectator' });
  sv.step();
  sv.recv(0, { t: 'hc', a: 'start' });
  sv.step();
  sv.recv(0, { t: 'ld' });
  const t0 = Date.now();
  let at90 = 0;
  while (!end && sv.t < 1200) {
    sv.step();
    if (!at90 && sv.t >= 90) at90 = sv.aliveCount;
  }
  const ok = !!end && end.r.filter((r) => r[1] === 1).length === 1;
  if (!ok) failed++;
  console.log(
    `match ${i + 1}: seed ${seed} ${ok ? 'OK' : 'FAILED'} - ended at ${sv.t.toFixed(0)}s, alive at 90s ${at90}/${bots + 1}, ` +
      `shots ${sv.stats.shots}, builds ${sv.stats.builds}, kills ${JSON.stringify(kills)}, wall ${Date.now() - t0} ms`,
  );
}
process.exit(failed ? 1 : 0);
