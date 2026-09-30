// Web Worker entry: runs the authoritative GameServer off the main thread (keeps hosting
// smooth and un-throttled even when the host's tab is in the background).
import { GameServer, TICK } from './server.js';

let sv = null;
let ts = 1;
let last = 0;
let acc = 0;
let timer = 0;

function post(m) {
  self.postMessage(m);
}

function loop() {
  const now = performance.now();
  acc += ((now - last) / 1000) * ts;
  last = now;
  let n = 0;
  try {
    while (acc >= TICK && n < 48) {
      sv.step();
      acc -= TICK;
      n++;
    }
  } catch (e) {
    post({ k: 'err', e: String((e && e.stack) || e) });
  }
  if (acc > TICK * 48) acc = 0;
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    switch (m.k) {
      case 'init':
        sv = new GameServer(m.cfg, (cid, q) => post({ k: 'out', c: cid, m: q }));
        ts = Math.max(0.1, +m.cfg.ts || 1);
        last = performance.now();
        timer = setInterval(loop, ts > 1 ? 4 : 8);
        post({ k: 'ready' });
        break;
      case 'open':
        sv.open(m.c);
        break;
      case 'msg':
        if (Array.isArray(m.m)) for (const x of m.m) sv.recv(m.c, x);
        else sv.recv(m.c, m.m);
        break;
      case 'close':
        sv.close(m.c);
        break;
      case 'stats':
        post({ k: 'stats', s: { state: sv.state, t: sv.t, alive: sv.aliveCount, stats: sv.stats, players: sv.plist.length } });
        break;
      case 'stop':
        clearInterval(timer);
        self.close();
        break;
      default:
        break;
    }
  } catch (err) {
    post({ k: 'err', e: String((err && err.stack) || err) });
  }
};
