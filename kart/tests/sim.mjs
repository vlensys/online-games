// Headless race test (no browser): 8 bots race every track and must all finish in sensible times
// without leaving the track or getting stuck. Usage (from the repo root):
//   node kart/tests/sim.mjs [class=150] [laps=3]
import { Race } from '../js/core/race.js';
import { TRACKS } from '../js/core/tracks.js';
import { DRIVERS } from '../js/core/config.js';

const cls = +(process.argv[2] || 150);
const laps = +(process.argv[3] || 3);
let failed = 0;
for (const def of TRACKS) {
  const race = new Race({
    track: def.id,
    cls,
    laps,
    seed: 1234,
    karts: DRIVERS.map((d) => ({ driver: d.id, ctrl: 'bot' })),
  });
  const count = {};
  let bad = 0,
    maxOut = 0;
  let t = 0;
  while (race.state !== 'done' && t < 600) {
    race.step();
    t += race.dt;
    for (const e of race.ev) count[e[0]] = (count[e[0]] || 0) + 1;
    race.ev.length = 0;
    for (const k of race.karts) {
      if (!isFinite(k.x + k.y + k.z)) bad++;
      maxOut = Math.max(maxOut, Math.abs(k.loc.d) - k.loc.lim);
    }
  }
  const est = race.karts.filter((k) => k.estimated).length;
  const times = race.order.map((k) => k.finishT.toFixed(1));
  const best = Math.min(...race.karts.flatMap((k) => k.lapTimes));
  const ok = race.state === 'done' && est === 0 && bad === 0 && maxOut < 0.5;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${def.id.padEnd(7)} ${(race.T.len | 0) + 'm'} times ${times.join(' ')} bestLap ${best.toFixed(1)} est ${est} out ${maxOut.toFixed(2)} | ` + Object.entries(count).map(([k, v]) => k + ':' + v).join(' '));
}
process.exit(failed ? 1 : 0);
