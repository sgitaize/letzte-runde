/**
 * Letzte Runde – Host in der App (läuft im eingebetteten Node der iOS-/Android-App, Node ≥ 18, ohne Abhängigkeiten).
 *
 * Die WebView lädt das Spiel immer von http://127.0.0.1:<KR_APP_PORT> – localhost ist ein Secure Context
 * (WebCrypto, WebSocket wie im Web) und bleibt dieselbe Origin, egal wo gespielt wird (Geräteschlüssel,
 * Name, Statistik im localStorage bleiben erhalten). Dieser Host entscheidet, wohin Anfragen gehen:
 *
 *   Modus „online“  Räume auf gang.aize.eu (Web, PWA und App spielen zusammen)
 *   Modus „lan“     Räume auf dem eingebetteten server.js; WLAN-Geräte erreichen ihn über den LAN-Listener
 *   Modus „join“    Räume auf einem anderen Gerät im WLAN, das hostet
 *
 *   Konten (/api?a=acct.*) gehen immer zu gang.aize.eu. Ohne Internet landen Übungsraum-Hände
 *   (acct.sphand) in einer Warteschlange und werden beim nächsten Kontakt nachgeschickt – nur mit Konto,
 *   denn der Client schickt sie nur angemeldet.
 *
 * Steuerung aus der App (nur 127.0.0.1, Header x-kr-app = KR_APP_TOKEN; die App reicht das Token per
 * WKUserScript/evaluateJavascript an die WebView, es steht nicht im HTML – andere Apps auf dem Gerät
 * könnten 127.0.0.1 sonst mitlesen):
 *   GET  /__app/state              -> { mode, join, lan: { on, http, https, fingerprint }, online, queue }
 *   POST /__app/mode {mode, join?} -> Modus wechseln
 *   POST /__app/lan  {on}          -> WLAN-Host an/aus
 *
 * Umgebung: KR_APP_PORT, KR_APP_TOKEN, KR_VAR_DIR (beschreibbar), KR_UPSTREAM (Standard https://gang.aize.eu),
 *           KR_LAN_PORT (Standard 8380, HTTPS auf +1), KR_PUBLIC (gebündelte Dateien, Standard ./public)
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const os = require('os');

const VAR_DIR = process.env.KR_VAR_DIR || path.join(__dirname, 'var');
const PUBLIC = process.env.KR_PUBLIC || path.join(__dirname, 'public');
const APP_PORT = Number(process.env.KR_APP_PORT) || 8370;
const TOKEN = process.env.KR_APP_TOKEN || crypto.randomBytes(16).toString('hex');
const UPSTREAM = new URL(process.env.KR_UPSTREAM || 'https://gang.aize.eu');
const LAN_PORT = Number(process.env.KR_LAN_PORT) || 8380;
const INNER_PORT = APP_PORT + 1;          // eingebettetes server.js, nur 127.0.0.1
const UP_TIMEOUT = 6000;
fs.mkdirSync(VAR_DIR, { recursive: true });

/* ------------------------------------------------------------ Zustand --- */
const STATE_FILE = path.join(VAR_DIR, 'app-state.json');
const QUEUE_FILE = path.join(VAR_DIR, 'acct-queue.json');
let st = { mode: 'online', join: '' };
try { Object.assign(st, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) { /* erster Start */ }
if (st.mode === 'lan') st.mode = 'online';        // WLAN-Host startet nie von selbst
let queue = [];
try { queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')) || []; } catch (e) { queue = []; }
let online = null;                                 // null = unbekannt
function saveState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify({ mode: st.mode, join: st.join })); } catch (e) { /* egal */ } }
function saveQueue() { try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue.slice(-500))); } catch (e) { /* egal */ } }

/* ------------------------------------------- eingebettetes server.js ---- */
process.env.PORT = String(INNER_PORT);
process.env.KR_LISTEN_HOST = '127.0.0.1';
process.env.KR_VAR_DIR = VAR_DIR;
process.env.KR_LEADER_SOCK = process.env.KR_LEADER_SOCK || path.join(os.tmpdir(), 'kr-' + APP_PORT + '.sock');
process.env.KR_MEM_MB = process.env.KR_MEM_MB || '120';
const inner = require('./server.js');   // { server } – für Selbstheilung (siehe unten)

/* ------------------------------------------------------------- Proxy --- */
function backend(isAcct) {
  if (isAcct || st.mode === 'online') return { url: UPSTREAM, remote: true };
  if (st.mode === 'join' && st.join) { try { return { url: new URL(st.join), remote: false }; } catch (e) { /* unten */ } }
  return { url: new URL('http://127.0.0.1:' + INNER_PORT), remote: false };
}
function hopHeaders(h, target) {
  const out = {};
  for (const k of Object.keys(h)) {
    if (/^(host|connection|upgrade|keep-alive|proxy-.*|te|trailer|transfer-encoding|origin|referer)$/i.test(k)) continue;
    out[k] = h[k];
  }
  out.host = target.host;
  if (h.origin) out.origin = target.origin;                  // Server prüft „gleicher Origin“ bei POST
  if (h.referer) out.referer = target.origin + '/';
  return out;
}
/* Konto-Cookie: gang.aize.eu setzt „Secure; SameSite=Strict“. Auf http://127.0.0.1 nimmt die WebView ein
   Secure-Cookie nicht immer an → Secure/Domain entfernen; es bleibt HttpOnly und verlässt das Gerät nur zum Upstream. */
function localCookies(sc) {
  if (!sc) return sc;
  return (Array.isArray(sc) ? sc : [sc]).map((c) => c.replace(/;\s*Secure/ig, '').replace(/;\s*Domain=[^;]*/ig, ''));
}
function proxy(req, res, body, isAcct) {
  const b = backend(isAcct);
  const t = b.url;
  const lib = t.protocol === 'https:' ? https : http;
  const p = lib.request({ protocol: t.protocol, hostname: t.hostname, port: t.port || (t.protocol === 'https:' ? 443 : 80),
    path: req.url, method: req.method, headers: hopHeaders(req.headers, t), timeout: UP_TIMEOUT }, (pr) => {
    if (b.remote) online = true;
    const h = Object.assign({}, pr.headers);
    if (h['set-cookie']) h['set-cookie'] = localCookies(h['set-cookie']);
    delete h['strict-transport-security'];
    res.writeHead(pr.statusCode, h);
    pr.pipe(res);
    if (isAcct && pr.statusCode < 500) flushQueue(req.headers);
  });
  p.on('timeout', () => p.destroy(new Error('timeout')));
  p.on('error', () => {
    if (b.remote) online = false;
    if (isAcct && body && queueable(req, body)) { queue.push({ url: req.url, body: body.toString('utf8'), at: Date.now() }); saveQueue();
      return send(res, 200, { ok: true, queued: true }); }
    send(res, 503, { error: b.remote ? 'Keine Verbindung zu gang.aize.eu' : 'Keine Verbindung zum Host im WLAN', offline: true });
  });
  if (body) p.end(body); else p.end();
}
function queueable(req, body) { return req.method === 'POST' && /[?&]a=acct\.sphand\b/.test(req.url) && body.length < 65536; }
let flushing = false;
function flushQueue(h) {
  if (flushing || !queue.length || !h.cookie) return;
  flushing = true;
  const item = queue[0];
  const req = https.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port || 443, path: item.url, method: 'POST', timeout: UP_TIMEOUT,
    headers: { 'content-type': 'application/json', cookie: h.cookie, 'x-kr-key': h['x-kr-key'] || '', origin: UPSTREAM.origin, host: UPSTREAM.host } }, (r) => {
    r.resume();
    r.on('end', () => {
      flushing = false;
      if (r.statusCode < 500) { queue.shift(); saveQueue(); if (r.statusCode < 400) flushQueue(h); }
    });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => { flushing = false; });
  req.end(item.body);
}
function proxyUpgrade(req, sock, head) {
  sock.on('error', () => { /* egal */ });
  const t = backend(false).url;
  const tls = t.protocol === 'https:';
  const port = Number(t.port) || (tls ? 443 : 80);
  const c = tls ? require('tls').connect({ host: t.hostname, port, servername: t.hostname }) : net.connect(port, t.hostname);
  c.once(tls ? 'secureConnect' : 'connect', () => {
    const hh = hopHeaders(req.headers, t);
    let s = 'GET ' + req.url + ' HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n';
    for (const k of Object.keys(hh)) s += k + ': ' + hh[k] + '\r\n';
    c.write(s + '\r\n');
    if (head && head.length) c.write(head);
    sock.pipe(c).pipe(sock);
  });
  c.on('error', () => sock.destroy());
  sock.on('close', () => c.destroy());
}

/* ------------------------------------------------------------ Statisch --- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, u, lanGuest) {
  let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const f = path.join(PUBLIC, rel);
  if (!f.startsWith(PUBLIC + path.sep)) return send(res, 404, { error: 'nicht gefunden' });
  fs.readFile(f, (err, data) => {
    if (err) return send(res, 404, { error: 'nicht gefunden' });
    const ext = path.extname(f);
    if (rel === 'index.html') data = Buffer.from(injectApp(data.toString('utf8'), lanGuest));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}
/* App-Infos für den Client: Herkunft für Einladungen (statt 127.0.0.1) und ob Web-Crypto fehlt (WLAN-Gast über http) */
function injectApp(html, lanGuest) {
  const info = lanGuest
    ? { lanGuest: true }
    : { app: true, acct: UPSTREAM.origin, mode: st.mode, origin: st.mode === 'online' ? UPSTREAM.origin : (st.mode === 'lan' ? lanUrl() : st.join) };
  const tag = '<script>window.KR_APP=' + JSON.stringify(info).replace(/</g, '\\u003c') + ';</script>' +
    (lanGuest ? '<script src="kr-subtle.js"></script>' : '');
  return html.replace('<head>', '<head>' + tag);
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  const chunks = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > 262144) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => cb(Buffer.concat(chunks)));
}

/* ------------------------------------------------------- WLAN-Host ------- */
let lanHttp = null, lanHttps = null, lanCert = null;
function lanAddr() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return '';
}
function lanUrl() { const ip = lanAddr(); return ip ? 'http://' + ip + ':' + LAN_PORT : ''; }
/* WLAN-Gäste sehen nur Spiel + Räume des eingebetteten Servers: kein Admin, keine Konten, keine App-Steuerung */
function lanHandler(req, res) {
  let u; try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  if (u.pathname.startsWith('/__app') || /admin/.test(u.pathname)) return send(res, 404, { error: 'nicht gefunden' });
  if (u.pathname === '/api' && /^acct\./.test(u.searchParams.get('a') || '')) return send(res, 503, { error: 'Konten gibt es im WLAN-Spiel nicht', offline: true });
  if (u.pathname === '/kr-subtle.js' || u.pathname === '/' || u.pathname === '/index.html') return serveStatic(req, res, u, true);
  if (u.pathname === '/api' || /\/r\/[A-Za-z0-9]{1,8}\/?$/.test(u.pathname)) {
    return readBody(req, (b) => {
      const t = new URL('http://127.0.0.1:' + INNER_PORT);
      const p = http.request({ hostname: t.hostname, port: t.port, path: req.url, method: req.method,
        headers: Object.assign(hopHeaders(req.headers, t), { 'x-forwarded-for': req.socket.remoteAddress || '' }) }, (pr) => {
        res.writeHead(pr.statusCode, pr.headers); pr.pipe(res);
      });
      p.on('error', () => send(res, 503, { error: 'Server nicht erreichbar' }));
      p.end(b.length ? b : undefined);
    });
  }
  serveStatic(req, res, u, true);
}
function lanUpgrade(req, sock, head) {
  sock.on('error', () => { /* egal */ });
  const c = net.connect(INNER_PORT, '127.0.0.1', () => {
    let s = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (/^origin$/i.test(req.rawHeaders[i])) continue;
      s += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n';
    }
    c.write(s + '\r\n'); if (head && head.length) c.write(head);
    sock.pipe(c).pipe(sock);
  });
  c.on('error', () => sock.destroy());
  sock.on('close', () => c.destroy());
}
function lanStart(cb) {
  if (lanHttp) return cb();
  lanHttp = http.createServer(lanHandler);
  lanHttp.on('upgrade', lanUpgrade);
  lanHttp.on('error', (e) => console.error('WLAN-Host', e.message));
  try {
    lanCert = lanCert || require('./selfsigned.js').load(VAR_DIR);
    lanHttps = https.createServer({ key: lanCert.key, cert: lanCert.cert }, lanHandler);
    lanHttps.on('upgrade', lanUpgrade);
    lanHttps.on('error', (e) => console.error('WLAN-Host https', e.message));
    lanHttps.listen(LAN_PORT + 1, '0.0.0.0');
  } catch (e) { console.error('WLAN-Zertifikat', e.message); lanHttps = null; }
  lanHttp.listen(LAN_PORT, '0.0.0.0', cb);
}
function lanStop() {
  if (lanHttp) { lanHttp.close(); lanHttp = null; }
  if (lanHttps) { lanHttps.close(); lanHttps = null; }
}
function lanInfo() {
  const ip = lanAddr();
  return { on: !!lanHttp, ip, http: lanHttp && ip ? 'http://' + ip + ':' + LAN_PORT : '',
    https: lanHttps && ip ? 'https://' + ip + ':' + (LAN_PORT + 1) : '', fingerprint: lanCert ? lanCert.fingerprint : '' };
}

/* ------------------------------------------------------- App-Server ------ */
function control(req, res, u) {
  if (req.headers['x-kr-app'] !== TOKEN) return send(res, 403, { error: 'verboten' });
  const state = () => ({ mode: st.mode, join: st.join, lan: lanInfo(), online, queue: queue.length });
  if (u.pathname === '/__app/state') return send(res, 200, state());
  if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
  readBody(req, (b) => {
    let j = {}; try { j = JSON.parse(b.toString('utf8') || '{}'); } catch (e) { return send(res, 400, { error: 'JSON' }); }
    if (u.pathname === '/__app/mode') {
      if (!/^(online|lan|join)$/.test(j.mode || '')) return send(res, 400, { error: 'Modus' });
      if (j.mode === 'join') {
        let t; try { t = new URL(j.join); } catch (e) { return send(res, 400, { error: 'Adresse' }); }
        if (!/^https?:$/.test(t.protocol)) return send(res, 400, { error: 'Adresse' });
        st.join = t.origin;
      }
      st.mode = j.mode;
      if (st.mode !== 'lan') lanStop();
      saveState();
      return st.mode === 'lan' ? lanStart(() => send(res, 200, state())) : send(res, 200, state());
    }
    if (u.pathname === '/__app/lan') {
      if (j.on) { st.mode = 'lan'; saveState(); return lanStart(() => send(res, 200, state())); }
      lanStop(); return send(res, 200, state());
    }
    send(res, 404, { error: 'nicht gefunden' });
  });
}
const app = http.createServer((req, res) => {
  let u; try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  if (u.pathname.startsWith('/__app/')) return control(req, res, u);
  const isApi = u.pathname === '/api';
  const isAcct = isApi && /^acct\./.test(u.searchParams.get('a') || '');
  if (isApi || /\/r\/[A-Za-z0-9]{1,8}\/?$/.test(u.pathname) || u.pathname === '/admin-api') {
    if (req.method === 'POST') return readBody(req, (b) => proxy(req, res, b, isAcct));
    return proxy(req, res, null, isAcct);
  }
  serveStatic(req, res, u, false);
});
app.on('upgrade', (req, sock, head) => {
  if (/\/ws$/.test((req.url || '').split('?')[0])) proxyUpgrade(req, sock, head); else sock.destroy();
});
/* Selbstheilung: iOS nimmt horchende Sockets einer pausierten App still weg (EBADF nach dem Aufwachen).
   Alle 2 s verbindet sich der Host mit sich selbst; antwortet ein Port nicht, wird er neu geöffnet. */
function alive(port, cb) {
  const s = net.connect(port, '127.0.0.1'); let done = false;
  const fin = (ok) => { if (done) return; done = true; s.destroy(); cb(ok); };
  s.once('connect', () => fin(true)); s.once('error', () => fin(false)); s.setTimeout(1000, () => fin(false));
}
function relisten(srv, port, host, what) {
  console.log('Port ' + port + ' (' + what + ') neu geöffnet');
  try { srv.close(); } catch (e) { /* war schon zu */ }
  try { srv.listen(port, host); } catch (e) { console.error(what, e.message); }
}
setInterval(() => {
  alive(APP_PORT, (ok) => { if (!ok) relisten(app, APP_PORT, '127.0.0.1', 'App'); });
  if (inner && inner.server) alive(INNER_PORT, (ok) => { if (!ok) relisten(inner.server, INNER_PORT, '127.0.0.1', 'Spielserver'); });
  if (lanHttp) alive(LAN_PORT, (ok) => { if (!ok && lanHttp) { lanStop(); lanStart(() => console.log('WLAN-Host neu gestartet')); } });
}, 2000).unref();
app.listen(APP_PORT, '127.0.0.1', () => {
  console.log('KR_APP_READY ' + APP_PORT);
  if (typeof process.send === 'function') process.send({ ready: APP_PORT });
});
module.exports = { lanInfo };
