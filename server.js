// Grand Squeeze Casino — the website and the friends' tables for every game.
// Each game's dealer lives in its own *-core.js file (shared with the browser for solo play).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
// find the game files whether they sit in ../www (the full project), ./www, or right next to this file (a flat upload)
const WWW = [path.join(__dirname, '..', 'www'), path.join(__dirname, 'www'), __dirname].find(d => fs.existsSync(path.join(d, 'index.html'))) || __dirname;
// each game's dealer is optional: if a file didn't upload, the rest of the site still runs (open /check to see what's missing)
const load = f => { try { return require(path.join(WWW, f)); } catch (e) { console.warn(`${f} is missing or broken: ${e.message.split('\n')[0]}`); return null; } };
const BAC = load('table-core.js');
// Ultimate Texas Hold'em tables (up to 5 players each) — optional, so an older upload without the file still runs baccarat
const UTH = load('holdem-core.js');
// the jackpots only grow: keep each in a small file so a restart picks up where it left off
function keepJackpot(game, file) {
  if (!game || !game.jp) return;
  const JPF = path.join(__dirname, file);
  try { game.jp.set(JSON.parse(fs.readFileSync(JPF, 'utf8')).jackpot); } catch (e) { /* first run */ }
  let saved = game.jp.get();
  setInterval(() => { const v = game.jp.get(); if (v !== saved) { saved = v; fs.writeFile(JPF, JSON.stringify({ jackpot: v }), () => {}); } }, 15000).unref();
}
keepJackpot(UTH, 'jackpot.json');

const PORT = process.env.PORT || 8080;

/* ---------------- tiny dependency-free WebSocket server (RFC 6455, text frames) ---------------- */
class Sock extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.readyState = 1; this.buf = Buffer.alloc(0);
    socket.setNoDelay(true);
    socket.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    const gone = () => { if (this.readyState !== 3) { this.readyState = 3; this.emit('close'); } };
    socket.on('close', gone); socket.on('end', gone); socket.on('error', gone);
  }
  parse() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1], op = b0 & 15, masked = b1 & 128;
      let len = b1 & 127, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 65536) return this.terminate();               // nothing legitimate is this large
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let data = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = this.buf.subarray(off, off + 4); data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= m[i & 3]; }
      this.buf = this.buf.subarray(need);
      if (op === 1) this.emit('message', data.toString('utf8'));
      else if (op === 8) { this.frame(8, Buffer.alloc(0)); this.terminate(); return; }
      else if (op === 9) this.frame(10, data);
      else if (op === 10) this.emit('pong');
    }
  }
  frame(op, payload) {
    if (this.readyState !== 1) return;
    const n = payload.length; let head;
    if (n < 126) head = Buffer.from([128 | op, n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 128 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 128 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
    this.socket.write(Buffer.concat([head, payload]));
  }
  send(text) { this.frame(1, Buffer.from(text, 'utf8')); }
  ping() { this.frame(9, Buffer.alloc(0)); }
  terminate() { this.readyState = 3; this.socket.destroy(); this.emit('close'); }
}
function acceptWebSockets(server, routes) {
  const clients = new Set();
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const onConnection = routes[(req.url || '').split('?')[0]];
    if (!onConnection || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const ws = new Sock(socket); clients.add(ws); ws.on('close', () => clients.delete(ws));
    onConnection(ws);
  });
  return clients;
}

/* ---------------- http (serves the game too) + websocket ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (url === '/check') return check(res);
  let file = path.normalize(path.join(WWW, url === '/' ? 'index.html' : url));
  if (!file.startsWith(WWW) || /(^|[\\/])(server\.js|jackpot\.json|tcp-jackpot\.json|pg-jackpot\.json|package\.json|render\.yaml|Procfile|Dockerfile|fly\.toml)$/.test(file)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
const game = (onMsg, onClose) => ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => { if (raw.length > 4096) return; let m; try { m = JSON.parse(raw); } catch { return; } try { onMsg(ws, m); } catch (e) { console.error(e); } });
  ws.on('close', () => { try { onClose(ws); } catch (e) { console.error(e); } });
};
const routes = {};
if (BAC) routes['/ws'] = game(BAC.handle, ws => (BAC.drop || BAC.leave)(ws));   // baccarat: a dropped connection keeps the seat for a while
if (UTH) routes['/uth'] = game(UTH.handle, UTH.leave);               // hold'em: your hand plays out, then your seat frees up
const TCP = load('tcp-core.js');
keepJackpot(TCP, 'tcp-jackpot.json');
if (TCP) routes['/tcp'] = game(TCP.handle, TCP.leave);
const BJ = load('bj-core.js');
if (BJ) routes['/bj'] = game(BJ.handle, BJ.leave);                   // blackjack: up to 5 players, 6-deck or double deck
const PG = load('pg-core.js');
keepJackpot(PG, 'pg-jackpot.json');
if (PG) routes['/pg'] = game(PG.handle, PG.leave);                   // face up pai gow: up to 5 players               // three card poker: same idea, up to 5 players a table
const clients = acceptWebSockets(server, routes);
// /check: a page listing every file the site needs, so a failed upload is easy to spot
const NEEDED = [['index.html', 'Game menu'], ['baccarat.html', 'Baccarat'], ['table-core.js', 'Baccarat dealer (friends\' tables)'], ['holdem.html', "Texas Hold'em"], ['holdem-core.js', "Texas Hold'em dealer"],
  ['tcp.html', 'Three Card Poker'], ['tcp-core.js', 'Three Card Poker dealer'], ['bj.html', 'Blackjack'], ['bj-core.js', 'Blackjack dealer'], ['pg.html', 'Face Up Pai Gow'], ['pg-core.js', 'Pai Gow dealer'],
  ['sw.js', 'Offline helper'], ['manifest.webmanifest', 'App icon settings'], ['privacy.html', 'Privacy page'], ['icon-192.png', 'Icon'], ['icon-512.png', 'Icon'], ['icon-maskable-512.png', 'Icon'], ['apple-touch-icon.png', 'iPhone icon']];
function check(res) {
  const engines = { 'table-core.js': BAC, 'holdem-core.js': UTH, 'tcp-core.js': TCP, 'bj-core.js': BJ, 'pg-core.js': PG };
  let miss = 0;
  const rows = NEEDED.map(([f, what]) => {
    const here = fs.existsSync(path.join(WWW, f)), broken = here && f in engines && !engines[f];
    if (!here || broken) miss++;
    return `<tr><td>${here && !broken ? '✅' : '❌'}</td><td><b>${f}</b></td><td>${what}</td><td>${!here ? 'missing — upload it to GitHub' : broken ? 'there, but it could not be loaded — upload it again' : 'OK'}</td></tr>`;
  }).join('');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Site check</title>
<body style="font:15px system-ui;background:#111;color:#eee;padding:16px;max-width:720px;margin:auto"><h1 style="color:#f0c64e">${miss ? `❌ ${miss} file${miss > 1 ? 's' : ''} need attention` : '✅ Every file is here'}</h1>
<table style="border-collapse:collapse;width:100%">${rows}</table><style>td{padding:6px 8px;border-bottom:1px solid #333}</style>
<p style="color:#aaa">Files are read from: ${path.basename(WWW) || '/'} · <a style="color:#f0c64e" href="./">Back to the casino</a></p>`);
}
setInterval(() => { for (const ws of clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 30000);
server.listen(PORT, '0.0.0.0', () => console.log(`Grand Squeeze Casino server on :${PORT}`));
