// Online private games. The host's browser runs the server (ServerRunner); remote players
// connect peer-to-peer over WebRTC data channels (PeerJS signaling). The "server address"
// is the host's public IP (found with STUN) plus a random port number, mapped to a PeerJS
// id. `?net=local` swaps PeerJS for a BroadcastChannel so two tabs can play offline.
const ID_PREFIX = 'stormroyale-v1-';
const BC_NAME = 'stormroyale-local-v1';
const STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CHUNK = 48000;

export function netMode() {
  return new URLSearchParams(location.search).get('net') === 'local' ? 'local' : 'peer';
}

function randInt(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

function makeCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s.slice(0, 4) + '-' + s.slice(4);
}

export function addrToId(addr) {
  const a = String(addr || '').trim().toLowerCase();
  const m = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{2,5})$/);
  if (m) {
    const parts = m.slice(1, 5).map(Number);
    if (parts.some((p) => p > 255)) return null;
    return ID_PREFIX + parts.join('-') + '-' + Number(m[5]);
  }
  const code = a.replace(/[^a-z0-9]/g, '');
  if (code.length >= 6 && code.length <= 12 && !/^\d+$/.test(code)) return ID_PREFIX + 'c-' + code;
  return null;
}

// Public IPv4 from a server-reflexive ICE candidate (null if STUN is blocked)
export function publicIp(timeout = 3500) {
  return new Promise((resolve) => {
    let pc;
    let done = false;
    const finish = (ip) => {
      if (done) return;
      done = true;
      try {
        pc.close();
      } catch (e) {
        /* ignore */
      }
      resolve(ip);
    };
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] });
    } catch (e) {
      resolve(null);
      return;
    }
    pc.createDataChannel('probe');
    pc.onicecandidate = (e) => {
      if (!e.candidate) return finish(null);
      const c = e.candidate.candidate || '';
      if (!/ typ srflx/.test(c)) return;
      const m = c.match(/ (\d{1,3}(?:\.\d{1,3}){3}) \d+ typ srflx/);
      if (m) finish(m[1]);
    };
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch(() => finish(null));
    setTimeout(() => finish(null), timeout);
  });
}

function iceServers(adv) {
  const list = [{ urls: STUN }];
  if (adv && adv.turn) list.push({ urls: adv.turn, username: adv.turnUser || undefined, credential: adv.turnPass || undefined });
  return list;
}

function peerOptions(adv) {
  const o = { debug: 1, config: { iceServers: iceServers(adv) } };
  const s = adv && adv.peer ? adv.peer.trim() : '';
  if (s) {
    try {
      const u = new URL(/^\w+:\/\//.test(s) ? s : 'https://' + s);
      o.host = u.hostname;
      o.secure = u.protocol === 'https:' || u.protocol === 'wss:';
      o.port = u.port ? +u.port : o.secure ? 443 : 80;
      o.path = u.pathname && u.pathname !== '/' ? u.pathname : '/';
    } catch (e) {
      /* ignore bad value, use cloud */
    }
  }
  return o;
}

// ------------------------------------------------------------------ framing (JSON + chunks)
function encode(msgs, sendRaw) {
  const s = JSON.stringify(msgs);
  if (s.length <= CHUNK) {
    sendRaw(s);
    return;
  }
  const id = Math.floor(Math.random() * 1e9);
  const n = Math.ceil(s.length / CHUNK);
  for (let i = 0; i < n; i++) sendRaw('\u0001' + id + '|' + i + '|' + n + '|' + s.slice(i * CHUNK, (i + 1) * CHUNK));
}

function makeDecoder(onMsgs) {
  const parts = new Map();
  return (data) => {
    if (typeof data !== 'string') return;
    let s = data;
    if (s.charCodeAt(0) === 1) {
      const a = s.indexOf('|');
      const b = s.indexOf('|', a + 1);
      const c = s.indexOf('|', b + 1);
      const id = s.slice(1, a);
      const i = +s.slice(a + 1, b);
      const n = +s.slice(b + 1, c);
      let e = parts.get(id);
      if (!e) parts.set(id, (e = { n, got: 0, p: [] }));
      if (e.p[i] === undefined) e.got++;
      e.p[i] = s.slice(c + 1);
      if (e.got < e.n) return;
      parts.delete(id);
      s = e.p.join('');
    }
    let m;
    try {
      m = JSON.parse(s);
    } catch (err) {
      return;
    }
    onMsgs(Array.isArray(m) ? m : [m]);
  };
}

// A connection wrapper with a uniform interface for both transports
class Conn {
  constructor(sendRaw, closeFn) {
    this.sendRaw = sendRaw;
    this.closeFn = closeFn;
    this.onMessages = null;
    this.onClose = null;
    this.closed = false;
    this.lastRx = performance.now();
    this.deliver = makeDecoder((msgs) => {
      this.lastRx = performance.now();
      if (this.onMessages) this.onMessages(msgs);
    });
  }
  sendBatch(msgs) {
    if (this.closed || !msgs.length) return;
    try {
      encode(msgs, this.sendRaw);
    } catch (e) {
      console.warn('send failed', e);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.closeFn();
    } catch (e) {
      /* ignore */
    }
    if (this.onClose) this.onClose('closed');
  }
  remoteClosed() {
    if (this.closed) return;
    this.closed = true;
    if (this.onClose) this.onClose('lost');
  }
}

// ------------------------------------------------------------------ transports
class PeerTransport {
  constructor(adv) {
    this.adv = adv;
    this.peer = null;
  }
  listen(id, onConn) {
    return new Promise((resolve, reject) => {
      if (!window.Peer) {
        reject({ type: 'nopeer', message: 'Networking library failed to load.' });
        return;
      }
      const peer = new window.Peer(id, peerOptions(this.adv));
      let opened = false;
      const t = setTimeout(() => {
        if (!opened) {
          peer.destroy();
          reject({ type: 'timeout', message: 'Could not reach the connection server. This network may block it.' });
        }
      }, 15000);
      peer.on('open', () => {
        opened = true;
        clearTimeout(t);
        this.peer = peer;
        resolve();
      });
      peer.on('error', (e) => {
        if (!opened) {
          clearTimeout(t);
          peer.destroy();
          reject({ type: e.type, message: e.message });
        } else console.warn('[host peer]', e.type, e.message);
      });
      peer.on('disconnected', () => {
        // lost the signaling server; existing games keep working. Try to come back for new joins.
        if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 2000);
      });
      peer.on('connection', (dc) => {
        const conn = new Conn(
          (s) => dc.send(s),
          () => dc.close(),
        );
        dc.on('data', (d) => conn.deliver(d));
        dc.on('close', () => conn.remoteClosed());
        dc.on('error', () => conn.remoteClosed());
        const ready = () => onConn(conn);
        if (dc.open) ready();
        else dc.on('open', ready);
      });
    });
  }
  connect(id, status) {
    return new Promise((resolve, reject) => {
      if (!window.Peer) {
        reject(new Error('Networking library failed to load. Reload the page.'));
        return;
      }
      const peer = new window.Peer(undefined, peerOptions(this.adv));
      this.peer = peer;
      let stage = 'signal';
      let finished = false;
      const fail = (msg) => {
        if (finished) return;
        finished = true;
        clearTimeout(t);
        try {
          peer.destroy();
        } catch (e) {
          /* ignore */
        }
        reject(new Error(msg));
      };
      const t = setTimeout(() => {
        if (stage === 'signal') fail('Could not reach the connection server. This network may block it (try another network or the Advanced settings).');
        else fail('Found the game but could not connect. A firewall or school network may block peer-to-peer connections. Try another network or set a TURN server in Advanced.');
      }, 20000);
      peer.on('error', (e) => {
        if (e.type === 'peer-unavailable') fail('No game found at that address. Check the address and make sure the host is still in the lobby.');
        else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') fail('Could not reach the connection server (' + e.type + ').');
        else if (e.type === 'browser-incompatible') fail('This browser does not support peer-to-peer connections.');
        else if (!finished) fail('Connection error: ' + (e.type || e.message));
      });
      peer.on('open', () => {
        stage = 'connect';
        status('Found the connection server. Connecting to the host…');
        const dc = peer.connect(id, { reliable: true, serialization: 'raw' });
        const conn = new Conn(
          (s) => dc.send(s),
          () => {
            dc.close();
            peer.destroy();
          },
        );
        dc.on('data', (d) => conn.deliver(d));
        dc.on('close', () => conn.remoteClosed());
        dc.on('error', () => conn.remoteClosed());
        dc.on('open', () => {
          if (finished) return;
          finished = true;
          clearTimeout(t);
          resolve(conn);
        });
        const pc = dc.peerConnection;
        if (pc)
          pc.addEventListener('iceconnectionstatechange', () => {
            if (pc.iceConnectionState === 'failed') fail('Peer-to-peer connection failed. The network may block it; try another network or a TURN server (Advanced).');
          });
      });
    });
  }
  close() {
    if (this.peer)
      try {
        this.peer.destroy();
      } catch (e) {
        /* ignore */
      }
  }
}

class LocalTransport {
  constructor() {
    this.bc = null;
    this.conns = new Map();
  }
  listen(id, onConn) {
    return new Promise((resolve, reject) => {
      const bc = new BroadcastChannel(BC_NAME);
      let taken = false;
      bc.onmessage = (e) => {
        const m = e.data;
        if (!m || m.to !== id) {
          if (m && m.k === 'pong' && m.from === id) taken = true;
          return;
        }
        if (m.k === 'ping') bc.postMessage({ k: 'pong', from: id });
        else if (m.k === 'conn') {
          const peerId = m.from;
          const conn = new Conn(
            (s) => bc.postMessage({ k: 'msg', to: peerId, from: id, d: s }),
            () => bc.postMessage({ k: 'close', to: peerId, from: id }),
          );
          this.conns.set(peerId, conn);
          bc.postMessage({ k: 'acc', to: peerId, from: id });
          onConn(conn);
        } else if (m.k === 'msg') {
          const c = this.conns.get(m.from);
          if (c) c.deliver(m.d);
        } else if (m.k === 'close') {
          const c = this.conns.get(m.from);
          if (c) c.remoteClosed();
          this.conns.delete(m.from);
        }
      };
      bc.postMessage({ k: 'ping', to: id, from: 'probe' });
      setTimeout(() => {
        if (taken) {
          bc.close();
          reject({ type: 'unavailable-id', message: 'taken' });
        } else {
          this.bc = bc;
          resolve();
        }
      }, 250);
    });
  }
  connect(id, status) {
    return new Promise((resolve, reject) => {
      const bc = new BroadcastChannel(BC_NAME);
      const me = 'c' + Math.floor(Math.random() * 1e9);
      let ok = false;
      const conn = new Conn(
        (s) => bc.postMessage({ k: 'msg', to: id, from: me, d: s }),
        () => {
          bc.postMessage({ k: 'close', to: id, from: me });
          setTimeout(() => bc.close(), 50);
        },
      );
      bc.onmessage = (e) => {
        const m = e.data;
        if (!m || m.to !== me) return;
        if (m.k === 'acc') {
          ok = true;
          resolve(conn);
        } else if (m.k === 'msg') conn.deliver(m.d);
        else if (m.k === 'close') conn.remoteClosed();
      };
      status('Looking for the game on this computer…');
      bc.postMessage({ k: 'conn', to: id, from: me });
      setTimeout(() => {
        if (!ok) {
          bc.close();
          reject(new Error('No game found at that address (local mode: host and player must be tabs of the same browser).'));
        }
      }, 3000);
    });
  }
  close() {
    for (const c of this.conns.values()) c.close();
    if (this.bc) setTimeout(() => this.bc.close(), 100);
  }
}

// ------------------------------------------------------------------ host side
export class HostNet {
  constructor(runner, adv, cb) {
    this.runner = runner;
    this.cb = cb;
    this.nextCid = 1;
    this.conns = new Map();
    this.closed = false;
    this.transport = netMode() === 'local' ? new LocalTransport() : new PeerTransport(adv);
    this.start();
    this.idle = setInterval(() => this.checkIdle(), 3000);
  }

  async start() {
    const local = netMode() === 'local';
    let base = local ? '127.0.0.1' : null;
    let info = local ? 'Local test mode: join from another tab of this browser.' : '';
    if (!local) {
      this.cb.onAddress('', 'Finding your public address…');
      base = await publicIp();
      if (this.closed) return;
      info = base
        ? 'Share the address and password with your friends. Click the address to hide it.'
        : 'Could not detect your public IP (STUN blocked), so a game code is used instead.';
    }
    for (let attempt = 0; attempt < 6 && !this.closed; attempt++) {
      const addr = base ? base + ':' + randInt(10000, 65535) : makeCode();
      const id = addrToId(addr);
      try {
        await this.transport.listen(id, (conn) => this.onConn(conn));
        if (this.closed) {
          this.transport.close();
          return;
        }
        this.address = addr;
        this.cb.onAddress(addr, info);
        return;
      } catch (e) {
        if (e && e.type === 'unavailable-id') continue;
        this.cb.onError((e && e.message) || 'Could not open the server.');
        return;
      }
    }
    if (!this.closed) this.cb.onError('Could not reserve a server address. Try again.');
  }

  onConn(conn) {
    if (this.closed) {
      conn.close();
      return;
    }
    const cid = this.nextCid++;
    this.conns.set(cid, conn);
    this.runner.open(cid, (msgs) => {
      let close = false;
      const out = [];
      for (const m of msgs) {
        if (m.t === '_close') close = true;
        else out.push(m);
      }
      conn.sendBatch(out);
      if (close) setTimeout(() => conn.close(), 300);
    });
    conn.onMessages = (msgs) => this.runner.send(cid, msgs);
    conn.onClose = () => {
      this.runner.close(cid);
      this.conns.delete(cid);
    };
  }

  checkIdle() {
    const now = performance.now();
    for (const [cid, c] of this.conns) {
      if (now - c.lastRx > 20000) {
        c.close();
        this.conns.delete(cid);
        this.runner.close(cid);
      }
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.idle);
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    this.transport.close();
  }
}

// ------------------------------------------------------------------ client side
class RemoteLink {
  constructor(conn, transport) {
    this.conn = conn;
    this.transport = transport;
    this.q = [];
    this.onMessages = null;
    this.onClose = null;
    this.closed = false;
    conn.onMessages = (msgs) => {
      if (this.onMessages) this.onMessages(msgs);
    };
    conn.onClose = (why) => {
      this.finish(why);
    };
    this.ping = setInterval(() => {
      if (this.closed) return;
      if (performance.now() - conn.lastRx > 12000) {
        conn.close();
        return;
      }
      this.q.push({ t: 'ping', c: Math.round(performance.now()) });
      this.flush();
    }, 2000);
  }
  send(m) {
    this.q.push(m);
  }
  flush() {
    if (!this.q.length || this.closed) return;
    const q = this.q;
    this.q = [];
    this.conn.sendBatch(q);
  }
  finish(why) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    this.transport.close();
    if (this.onClose) this.onClose(why);
  }
  close() {
    if (this.closed) return;
    this.conn.close();
    this.finish('closed');
  }
}

export async function joinGame(addr, adv, status) {
  const id = addrToId(addr);
  if (!id) throw new Error('That address does not look right. It looks like 203.0.113.7:48213 (or a code like ABCD-EFGH).');
  const transport = netMode() === 'local' ? new LocalTransport() : new PeerTransport(adv);
  status(netMode() === 'local' ? 'Connecting (local mode)…' : 'Contacting the connection server…');
  const conn = await transport.connect(id, status);
  return new RemoteLink(conn, transport);
}
