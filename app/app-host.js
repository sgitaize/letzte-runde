/**
 * Letzte Runde – Host in der App (läuft im eingebetteten Node der iOS-/Android-App, Node ≥ 18, ohne Abhängigkeiten).
 *
 * Die WebView lädt das Spiel immer von http://127.0.0.1:<KR_APP_PORT> – localhost ist ein Secure Context
 * (WebCrypto, WebSocket wie im Web) und bleibt dieselbe Origin, egal wo gespielt wird (Geräteschlüssel,
 * Name, Statistik im localStorage bleiben erhalten). Dieser Host entscheidet, wohin Anfragen gehen:
 *
 *   Modus „online“  Räume auf letzterunde.aize-it.de (Web, PWA und App spielen zusammen)
 *   Modus „lan“     Räume auf dem eingebetteten server.js; WLAN-Geräte erreichen ihn über den LAN-Listener
 *   Modus „join“    Räume auf einem anderen Gerät im WLAN, das hostet
 *
 *   Konten (/api?a=acct.*) gehen immer zum Online-Server (KR_UPSTREAM). Ohne Internet landen Übungsraum-Hände
 *   (acct.sphands) und WLAN-Hände (acct.lanhand, nur mit Opt-in) in einer Warteschlange und werden beim
 *   nächsten Kontakt nachgeschickt – nur mit Konto, denn der Client schickt sie nur angemeldet.
 *
 * Steuerung aus der App (nur 127.0.0.1, Header x-kr-app = KR_APP_TOKEN; die App reicht das Token per
 * WKUserScript/evaluateJavascript an die WebView, es steht nicht im HTML – andere Apps auf dem Gerät
 * könnten 127.0.0.1 sonst mitlesen):
 *   GET  /__app/state              -> { mode, join, lan: { on, http, https, fingerprint }, online, queue }
 *   POST /__app/mode {mode, join?} -> Modus wechseln
 *   POST /__app/lan  {on}          -> WLAN-Host an/aus
 *
 * Spiellogik nachladen (ohne Store-Release): Spiel (public/), server.js, bots.js … kommen als signiertes Bundle vom
 * Online-Server (/app/bundle.json, Ed25519, Schlüssel bundle-key.pub). Geladen wird nur auf Wunsch (Hinweis beim Start
 * auf der Seite), gespeichert in KR_VAR_DIR/bundle/<build> – danach läuft genau diese Logik, auch offline und im WLAN.
 * Fehlerhafte Bundles (Seite meldet sich nicht, eingebetteter Server stürzt ab) fallen auf das vorige bzw. eingebaute zurück.
 * Für die Seite (ohne Token, nur 127.0.0.1; Schutz ist die Signatur):
 *   GET  /__bundle/state   -> { host, active, available, required, minLogic, staged, error, apk }
 *   POST /__bundle/check   -> beim Server nachsehen
 *   POST /__bundle/apply   -> laden, prüfen, umschalten (läuft der WLAN-Host schon: ab dem nächsten App-Start)
 *   POST /__bundle/ok      -> Seite ist gestartet (beendet die Probezeit eines neuen Bundles)
 *   POST /__bundle/reset   -> zurück zur eingebauten Version
 *
 * Umgebung: KR_APP_PORT, KR_APP_TOKEN, KR_VAR_DIR (beschreibbar), KR_UPSTREAM (Standard https://letzterunde.aize-it.de; ältere Apps nutzen gang.aize.eu, das weiter funktioniert),
 *           KR_LAN_PORT (Standard 8380, HTTPS auf +1), KR_PUBLIC (gebündelte Dateien, Standard ./public),
 *           KR_PLATFORM (ios|android), KR_APP_VERSION (z. B. 1.0.3; Android: Hinweis auf neue APK)
 *           KR_STORE (Android: github|play – die Play-Fassung zeigt keinen APK-Hinweis und keinen Spendenlink)
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
const UPSTREAM = new URL(process.env.KR_UPSTREAM || 'https://letzterunde.aize-it.de');
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

/* ------------------------------------------------ Spiel-Bundle ---------- */
/* Was dieser Host kann (Brücke zur App, window.KR_APP, /__bundle). Bundles mit höherem minHost brauchen ein App-Update. */
const HOST_API = 1;
const PLATFORM = process.env.KR_PLATFORM || '';
const APP_VERSION = process.env.KR_APP_VERSION || '';
/* Sprache der Meldungen: Kopf x-kr-lang der Spielseite, sonst die Gerätesprache aus der App (KR_LANG) */
const L = (de, en) => (process.env.KR_LANG === 'en' ? en : de);
const tr = (req, de, en) => ((req && req.headers['x-kr-lang']) || process.env.KR_LANG) === 'en' ? en : de;
const STORE = process.env.KR_STORE || '';
const mf = require('./bundle-manifest.js');
const BUNDLE_DIR = path.join(VAR_DIR, 'bundle');
const BSTATE_FILE = path.join(BUNDLE_DIR, 'state.json');
let PUBKEY = '';
try { PUBKEY = fs.readFileSync(path.join(__dirname, 'bundle-key.pub'), 'utf8'); } catch (e) { /* ohne Schlüssel kein Nachladen */ }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
/* Eingebaut: Build-Stempel vom App-Build (game/bundle.json, Unix-Sekunden), Spiellogik aus hand.js */
const BUILTIN = { build: Number((readJson(path.join(__dirname, 'bundle.json')) || {}).build) || 0, logic: 0, files: null };
try { BUILTIN.logic = Number(require(path.join(PUBLIC, 'hand.js')).LOGIC_VERSION) || 1; } catch (e) { BUILTIN.logic = 1; }
fs.mkdirSync(BUNDLE_DIR, { recursive: true });
let bs = Object.assign({ active: 0, prev: 0, pending: 0, bad: [], trial: 0, boots: 0, innerTrial: 0, builtin: 0 }, readJson(BSTATE_FILE) || {});
function saveBs() { try { fs.writeFileSync(BSTATE_FILE + '.tmp', JSON.stringify(bs)); fs.renameSync(BSTATE_FILE + '.tmp', BSTATE_FILE); } catch (e) { /* egal */ } }
const bdir = (b) => path.join(BUNDLE_DIR, String(b));
const bmani = (b) => (b ? readJson(path.join(bdir(b), 'bundle.json')) : null);
const usable = (b) => !!b && bs.bad.indexOf(b) < 0 && b > BUILTIN.build && fs.existsSync(path.join(bdir(b), 'public', 'index.html')) && !!bmani(b);
function markBad(b, why) {
  if (!b) return;
  console.warn('Bundle ' + b + ' verworfen: ' + why);
  if (bs.bad.indexOf(b) < 0) bs.bad = bs.bad.concat([b]).slice(-20);
  if (bs.active === b) { bs.active = usable(bs.prev) ? bs.prev : 0; bs.prev = 0; }
  if (bs.pending === b) bs.pending = 0;
  if (bs.trial === b) { bs.trial = 0; bs.boots = 0; }
  if (bs.innerTrial === b) bs.innerTrial = 0;
  saveBs();
}
(function bootBundles() {
  /* Neue App-Version (Store/APK): ihr eingebautes Spiel ist mindestens so neu wie ältere Downloads → die fallen weg */
  if (bs.builtin !== BUILTIN.build) { bs.builtin = BUILTIN.build; ['active', 'prev', 'pending'].forEach((k) => { if (bs[k] && bs[k] <= BUILTIN.build) bs[k] = 0; }); }
  if (bs.innerTrial) markBad(bs.innerTrial, 'eingebetteter Server ist abgestürzt');   // gesetzt beim Absturz (exit ≠ 0, siehe ensureInner)
  if (bs.pending && usable(bs.pending)) { bs.prev = bs.active; bs.active = bs.pending; bs.trial = bs.pending; bs.boots = 0; }
  bs.pending = 0;
  if (!usable(bs.active)) { bs.active = 0; bs.trial = 0; }
  if (!usable(bs.prev)) bs.prev = 0;
  saveBs();
  for (const d of fs.readdirSync(BUNDLE_DIR)) {             // Aufräumen: nur aktives und voriges Bundle bleiben
    if (/^\d+$/.test(d) && Number(d) !== bs.active && Number(d) !== bs.prev) fs.rmSync(path.join(BUNDLE_DIR, d), { recursive: true, force: true });
    if (/^tmp-/.test(d)) fs.rmSync(path.join(BUNDLE_DIR, d), { recursive: true, force: true });
  }
  if (bs.active) console.log('Spiel-Bundle ' + bs.active + ' aktiv (eingebaut: ' + BUILTIN.build + ')');
})();
function gameDir() { return bs.active ? bdir(bs.active) : __dirname; }
function pubDir() { return bs.active ? path.join(bdir(bs.active), 'public') : PUBLIC; }
function activeInfo() {
  const m = bmani(bs.active);
  return m ? { build: m.build, logic: m.logic, src: 'download', trial: bs.trial === bs.active } : { build: BUILTIN.build, logic: BUILTIN.logic, src: 'builtin' };
}
function activeFiles() {
  const m = bmani(bs.active);
  if (m) return m.files;
  if (!BUILTIN.files) { try { BUILTIN.files = mf.hashes(__dirname); } catch (e) { BUILTIN.files = {}; } }
  return BUILTIN.files;
}

/* ------------------------------------------- eingebettetes server.js ---- */
process.env.PORT = String(INNER_PORT);
process.env.KR_LISTEN_HOST = '127.0.0.1';
process.env.KR_VAR_DIR = VAR_DIR;
process.env.KR_LEADER_SOCK = process.env.KR_LEADER_SOCK || path.join(os.tmpdir(), 'kr-' + APP_PORT + '.sock');
process.env.KR_MEM_MB = process.env.KR_MEM_MB || '120';
process.env.KR_MEM_METRIC = 'heap';           // RSS wäre die ganze App (UIKit, WebView)
/* Erst beim WLAN-Hosten gestartet – dann aus dem aktiven Bundle, damit Seite, Server und Bots dieselbe Logik haben.
   Stürzt ein nachgeladener Server ab (server.js beendet den Prozess bei einem unerwarteten Fehler mit exit 1), merkt sich
   der Host das; der nächste App-Start nimmt dann das vorige bzw. eingebaute Spiel. Wegwischen der App zählt nicht. */
let inner = null;              // { server } – für Selbstheilung (siehe unten)
function ensureInner(cb) {
  if (!inner) {
    const dir = gameDir();
    if (dir !== __dirname) { const b = bs.active; process.on('exit', (rc) => { if (rc) { bs.innerTrial = b; saveBs(); } }); }
    try { inner = require(path.join(dir, 'server.js')); }
    catch (e) {
      if (dir === __dirname) throw e;
      markBad(bs.active, 'server.js startet nicht (' + e.message + ')');
      inner = require('./server.js');
    }
  }
  let n = 0;
  (function wait() { alive(INNER_PORT, (ok) => (ok || ++n > 40 ? cb() : setTimeout(wait, 75))); })();
}

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
/* Konto-Cookie: der Online-Server setzt „Secure; SameSite=Strict“. Auf http://127.0.0.1 nimmt die WebView ein
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
    send(res, 503, { error: b.remote ? tr(req, 'Keine Verbindung zu ', 'No connection to ') + UPSTREAM.host : tr(req, 'Keine Verbindung zum Host im WLAN', 'No connection to the Wi-Fi host'), offline: true });
  });
  if (body) p.end(body); else p.end();
}
function queueable(req, body) { return req.method === 'POST' && /[?&]a=acct\.(sphands|lanhand)\b/.test(req.url) && body.length < 65536; }
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
  let rel = '';
  try { rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html'; } catch (e) { return send(res, 400, { error: 'Pfad' }); }
  if (rel.endsWith('/')) rel += 'index.html';
  /* eingebaute Dateien, die ein (älteres) Bundle nicht hat, z. B. kr-subtle.js → aus dem App-Paket */
  const base = pubDir(), cand = [path.join(base, rel)].concat(base !== PUBLIC ? [path.join(PUBLIC, rel)] : []);
  if (!cand.every((f, i) => f.startsWith((i ? PUBLIC : base) + path.sep))) return send(res, 404, { error: 'nicht gefunden' });
  const tryRead = (i) => fs.readFile(cand[i], (err, data) => {
    if (err) return i + 1 < cand.length ? tryRead(i + 1) : send(res, 404, { error: 'nicht gefunden' });
    const ext = path.extname(cand[i]);
    if (rel === 'index.html') { if (!lanGuest) trialBoot(); data = Buffer.from(injectApp(data.toString('utf8'), lanGuest)); }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
  tryRead(0);
}
/* App-Infos für den Client: Herkunft für Einladungen (statt 127.0.0.1) und ob Web-Crypto fehlt (WLAN-Gast über http).
   Probezeit eines neuen Bundles: meldet sich die Seite nicht binnen 12 s (/__bundle/ok), lädt dieser Wächter neu – der Host
   ist dann schon auf das vorige bzw. eingebaute Spiel zurückgefallen. Der Wächter gehört zum Host, nicht zum Bundle. */
function injectApp(html, lanGuest) {
  const a = activeInfo();
  const info = lanGuest
    ? { lanGuest: true }
    : { app: true, acct: UPSTREAM.origin, mode: st.mode, origin: st.mode === 'online' ? UPSTREAM.origin : (st.mode === 'lan' ? lanUrl() : st.join),
      host: HOST_API, build: a.build, logic: a.logic, bundle: a.src, platform: PLATFORM, version: APP_VERSION, store: STORE, lang: process.env.KR_LANG || '' };
  const tag = '<script>window.KR_APP=' + JSON.stringify(info).replace(/</g, '\\u003c') + ';</script>' +
    (!lanGuest && a.trial ? '<script>setTimeout(function(){if(!window.KR_BOOTED)location.reload();},12000);</script>' : '') +
    (lanGuest ? '<script src="kr-subtle.js"></script>' : '');
  return html.replace('<head>', '<head>' + tag);
}
let trialTimer = null;
function trialBoot() {
  if (!bs.trial || bs.trial !== bs.active) return;
  bs.boots++; saveBs();
  if (bs.boots > 3) return markBad(bs.trial, 'Seite startet nicht (3 Versuche)');
  clearTimeout(trialTimer);
  const b = bs.trial, at = Date.now();
  /* App im Hintergrund (iOS hält Node an): dann lief auch die Seite nicht – nicht als Fehler werten, sondern weiter warten */
  const watch = (due) => { trialTimer = setTimeout(() => { if (bs.trial !== b) return; if (Date.now() - due > 5000) return watch(Date.now() + 10000); markBad(b, 'Seite hat sich nicht gemeldet'); }, Math.max(0, due - Date.now())); };
  watch(at + 10000);
}

/* ------------------------------------------------ Bundle laden ----------- */
let upd = { available: null, minLogic: 0, checkedAt: 0, checking: null, error: '', apk: null, apkAt: 0 };
function fetchBuf(url, max, timeout) {
  return new Promise((resolve, reject) => {
    const t = new URL(url, UPSTREAM);
    const lib = t.protocol === 'https:' ? https : http;
    const rq = lib.get(t, { timeout: timeout || 10000, headers: { 'user-agent': 'LetzteRundeApp/' + (APP_VERSION || HOST_API), accept: '*/*' } }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const parts = []; let n = 0;
      r.on('data', (c) => { n += c.length; if (n > max) { rq.destroy(new Error(L('zu groß', 'too large'))); return; } parts.push(c); });
      r.on('end', () => resolve(Buffer.concat(parts)));
      r.on('error', reject);
    });
    rq.on('timeout', () => rq.destroy(new Error(L('Zeitüberschreitung', 'Timeout'))));
    rq.on('error', reject);
  });
}
/* Beim Server nachsehen: gibt es ein neueres, gültig signiertes Bundle, das sich vom aktiven unterscheidet? */
function checkUpdate() {
  if (upd.checking) return upd.checking;
  upd.checking = (async () => {
    try {
      try { upd.minLogic = Number((JSON.parse(await fetchBuf('/api?a=config', 65536, 6000)).config || {}).minLogic) || 0; } catch (e) { /* alter Server */ }
      if (!PUBKEY) { upd.error = L('Kein Schlüssel für Bundles in dieser App', 'No bundle key in this app'); upd.available = null; return; }
      let m;
      try { m = JSON.parse(await fetchBuf('/app/bundle.json', 262144, 8000)); }
      catch (e) { upd.available = null; upd.error = /HTTP 404/.test(e.message) ? '' : L('Keine Verbindung zu ', 'No connection to ') + UPSTREAM.host; return; }
      if (!mf.verify(m, PUBKEY)) { upd.available = null; upd.error = L('Bundle-Signatur ungültig', 'Invalid bundle signature'); return; }
      upd.error = '';
      const cur = activeInfo(), files = activeFiles();
      const diff = Object.keys(m.files).filter((rel) => !files[rel] || files[rel].h !== m.files[rel].h);
      if (m.build <= cur.build || !diff.length || bs.bad.indexOf(m.build) >= 0 || m.build === bs.pending) { upd.available = null; return; }
      upd.available = { build: m.build, logic: m.logic, files: diff.length, bytes: diff.reduce((a, rel) => a + m.files[rel].n, 0), needsApp: m.minHost > HOST_API, m };
    } finally { upd.checkedAt = Date.now(); upd.checking = null; }
  })();
  return upd.checking;
}
/* Laden: geänderte Dateien vom Server, unveränderte aus dem aktiven Spiel kopieren; jede Datei gegen das Manifest prüfen */
let applying = null;
function applyUpdate() {
  if (applying) return applying;
  applying = (async () => {
    try {
      if (!upd.available) await checkUpdate();
      const a = upd.available;
      if (!a) throw new Error(upd.error || L('Kein Update verfügbar', 'No update available'));
      if (a.needsApp) throw new Error('Diese Version braucht ein App-Update');
      const m = a.m, tmp = path.join(BUNDLE_DIR, 'tmp-' + m.build), have = activeFiles(), from = gameDir();
      fs.rmSync(tmp, { recursive: true, force: true });
      for (const rel of Object.keys(m.files)) {
        const want = m.files[rel], dst = path.join(tmp, rel);
        if (!mf.safeRel(rel) || !dst.startsWith(tmp + path.sep)) throw new Error('Pfad ' + rel);
        let buf = null;
        if (have[rel] && have[rel].h === want.h) { try { buf = fs.readFileSync(path.join(from, rel)); } catch (e) { buf = null; } }
        if (!buf || crypto.createHash('sha256').update(buf).digest('hex') !== want.h) buf = await fetchBuf('/app/bundle/' + rel.split('/').map(encodeURIComponent).join('/') + '?b=' + m.build, 4 * 1048576, 20000);
        if (buf.length !== want.n || crypto.createHash('sha256').update(buf).digest('hex') !== want.h) throw new Error(L('Prüfsumme falsch: ', 'Checksum mismatch: ') + rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, buf);
      }
      fs.writeFileSync(path.join(tmp, 'bundle.json'), JSON.stringify(m));
      fs.rmSync(bdir(m.build), { recursive: true, force: true });
      fs.renameSync(tmp, bdir(m.build));
      upd.available = null;
      /* Läuft der WLAN-Host schon, behält er bis zum nächsten Start seine Logik – dann wechseln Seite und Server gemeinsam */
      if (inner) { bs.pending = m.build; saveBs(); console.log('Bundle ' + m.build + ' geladen, aktiv ab dem nächsten App-Start'); return { ok: true, staged: true }; }
      bs.prev = bs.active; bs.active = m.build; bs.trial = m.build; bs.boots = 0; saveBs();
      console.log('Bundle ' + m.build + ' geladen und aktiv (Spiellogik ' + m.logic + ')');
      return { ok: true, reload: true };
    } finally { applying = null; }
  })();
  return applying;
}
/* Android: neue APK auf GitHub? (Releases „latest“, Tag vX.Y.Z) – nur ein Hinweis mit Link, kein Selbst-Update */
function checkApk() {
  if (PLATFORM !== 'android' || STORE === 'play' || !APP_VERSION || Date.now() - upd.apkAt < 6 * 3600000) return;
  upd.apkAt = Date.now();
  fetchBuf('https://api.github.com/repos/sgitaize/letzte-runde/releases/latest', 1048576, 8000).then((b) => {
    const tag = String(JSON.parse(b.toString('utf8')).tag_name || '').replace(/^v/, '');
    const n = (v) => v.split('.').map((x) => parseInt(x, 10) || 0), a = n(tag), c = n(APP_VERSION);
    let newer = false; for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (c[i] || 0)) { newer = (a[i] || 0) > (c[i] || 0); break; } }
    upd.apk = newer ? { latest: tag, current: APP_VERSION, url: 'https://github.com/sgitaize/letzte-runde/releases/latest/download/letzte-runde.apk' } : null;
  }).catch(() => { upd.apkAt = 0; });
}
function bundleState() {
  const a = activeInfo(), av = upd.available;
  return { host: HOST_API, active: a, builtin: { build: BUILTIN.build, logic: BUILTIN.logic },
    available: av ? { build: av.build, logic: av.logic, files: av.files, bytes: av.bytes, needsApp: av.needsApp } : null,
    minLogic: upd.minLogic, required: upd.minLogic > a.logic, staged: bs.pending || 0, checkedAt: upd.checkedAt, error: upd.error, apk: upd.apk, key: !!PUBKEY };
}
function bundleApi(req, res, u) {
  const p = u.pathname.slice('/__bundle/'.length);
  if (p === 'state' && req.method === 'GET') return send(res, 200, bundleState());
  if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
  readBody(req, () => {
    if (p === 'ok') { if (bs.trial && bs.trial === bs.active) { bs.trial = 0; bs.boots = 0; clearTimeout(trialTimer); saveBs(); } return send(res, 200, bundleState()); }
    if (p === 'check') return checkUpdate().then(() => send(res, 200, bundleState()), () => send(res, 200, bundleState()));
    if (p === 'apply') return applyUpdate().then((r) => send(res, 200, Object.assign(bundleState(), r)), (e) => send(res, 409, Object.assign(bundleState(), { error: e.message })));
    if (p === 'reset') { bs.pending = 0; bs.prev = 0; bs.active = 0; bs.trial = 0; saveBs(); upd.available = null; return send(res, 200, Object.assign(bundleState(), { reload: true })); }
    send(res, 404, { error: 'nicht gefunden' });
  });
}
setTimeout(() => { checkUpdate().catch(() => {}); checkApk(); }, 1500).unref();
setInterval(() => { checkUpdate().catch(() => {}); checkApk(); }, 6 * 3600000).unref();
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
  if (u.pathname.startsWith('/__app') || u.pathname.startsWith('/__bundle') || /admin/.test(u.pathname)) return send(res, 404, { error: 'nicht gefunden' });
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
  if (!inner) return ensureInner(() => lanStart(cb));
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
  if (u.pathname.startsWith('/__bundle/')) return bundleApi(req, res, u);
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
