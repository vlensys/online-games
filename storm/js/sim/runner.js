// Main-thread handle to the game server: a module Web Worker when available, otherwise the
// same GameServer running inline. Connections are numbered; 0 is always the host's own client.
import { TICK } from './server.js';

export class ServerRunner {
  constructor(cfg) {
    this.cfg = cfg;
    this.handlers = new Map();
    this.pending = [];
    this.ready = false;
    this.inline = null;
    this.stopped = false;
    this.onStats = null;
    let w = null;
    try {
      w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      w = null;
    }
    if (w) {
      this.worker = w;
      w.onmessage = (e) => this.onWorker(e.data);
      w.onerror = (e) => {
        console.error('[server worker]', e.message || e);
        if (!this.ready) this.fallback();
      };
      w.postMessage({ k: 'init', cfg });
      // If the worker never answers (very old browser), fall back to inline.
      this.readyTimer = setTimeout(() => {
        if (!this.ready) this.fallback();
      }, 4000);
    } else this.fallback();
  }

  onWorker(m) {
    if (m.k === 'out') {
      const h = this.handlers.get(m.c);
      if (h) h(m.m);
    } else if (m.k === 'ready') {
      this.ready = true;
      clearTimeout(this.readyTimer);
      for (const p of this.pending) this.worker.postMessage(p);
      this.pending = [];
    } else if (m.k === 'err') {
      console.error('[server]', m.e);
    } else if (m.k === 'stats' && this.onStats) this.onStats(m.s);
  }

  async fallback() {
    if (this.inline || this.stopped) return;
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch (e) {
        /* ignore */
      }
      this.worker = null;
    }
    console.warn('[server] running inline (no module worker)');
    const { GameServer } = await import('./server.js');
    const sv = new GameServer(this.cfg, (cid, q) => {
      const h = this.handlers.get(cid);
      if (h) setTimeout(() => h(q), 0);
    });
    this.inline = sv;
    const ts = Math.max(0.1, +this.cfg.ts || 1);
    let last = performance.now();
    let acc = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      acc += ((now - last) / 1000) * ts;
      last = now;
      let n = 0;
      while (acc >= TICK && n < 48) {
        try {
          sv.step();
        } catch (e) {
          console.error('[server]', e);
        }
        acc -= TICK;
        n++;
      }
      if (acc > TICK * 48) acc = 0;
    }, 8);
    this.ready = true;
    for (const p of this.pending) this.dispatchInline(p);
    this.pending = [];
  }

  dispatchInline(m) {
    const sv = this.inline;
    if (m.k === 'open') sv.open(m.c);
    else if (m.k === 'msg') {
      if (Array.isArray(m.m)) for (const x of m.m) sv.recv(m.c, x);
      else sv.recv(m.c, m.m);
    } else if (m.k === 'close') sv.close(m.c);
    else if (m.k === 'stats' && this.onStats) this.onStats({ state: sv.state, t: sv.t, alive: sv.aliveCount, stats: sv.stats });
  }

  post(m) {
    if (this.stopped) return;
    if (!this.ready) {
      this.pending.push(m);
      return;
    }
    if (this.inline) this.dispatchInline(m);
    else this.worker.postMessage(m);
  }

  open(cid, handler) {
    this.handlers.set(cid, handler);
    this.post({ k: 'open', c: cid });
  }

  send(cid, msgs) {
    this.post({ k: 'msg', c: cid, m: msgs });
  }

  close(cid) {
    this.handlers.delete(cid);
    this.post({ k: 'close', c: cid });
  }

  requestStats() {
    this.post({ k: 'stats' });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.readyTimer);
    if (this.worker) {
      try {
        this.worker.postMessage({ k: 'stop' });
        this.worker.terminate();
      } catch (e) {
        /* ignore */
      }
    }
    if (this.timer) clearInterval(this.timer);
    this.handlers.clear();
  }
}

// A client-side link to the server through the runner (used by the host's own client).
export class LocalLink {
  constructor(runner, cid = 0) {
    this.runner = runner;
    this.cid = cid;
    this.q = [];
    this.onMessages = null;
    this.onClose = null;
    this.closed = false;
    runner.open(cid, (msgs) => {
      if (this.closed) return;
      const close = msgs.some((m) => m.t === '_close');
      if (this.onMessages) this.onMessages(msgs.filter((m) => m.t !== '_close'));
      if (close) this.close();
    });
  }
  send(m) {
    this.q.push(m);
  }
  flush() {
    if (!this.q.length || this.closed) return;
    const q = this.q;
    this.q = [];
    this.runner.send(this.cid, q);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.onClose) this.onClose('closed');
  }
}
