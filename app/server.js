/**
 * Kartenrunde – Server (Node, ohne Abhängigkeiten).
 *
 *   GET  /                          -> public/index.html
 *   GET  /admin.html                -> Adminbereich
 *   GET  /api?a=state|get|config|info
 *   GET  /r/CODE                    -> Einladung mit Vorschau (WhatsApp & Co.), leitet auf /#CODE weiter
 *   POST /api?a=create|set|del|chip|rename|record|addbot|replacebot|sphand|voice|signal|signals|react|botify
 *   POST /admin-api?a=login|config|rooms|delroom   (Header x-admin-secret)
 *   WS   /ws?room=CODE              -> Push bei jeder Änderung
 *
 * Räume liegen als JSON-Datei in ./data/. Kein Build, keine Datenbank.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* Log-Datei für Betrieb ohne Shell-Zugang (per FTP lesbar): logs/app.log
   Schutz gegen Log-Flut: höchstens LOG_PER_MIN Zeilen je Minute, ab LOG_MAX wird nach app.log.1 rotiert. */
const LOG_FILE = path.join(__dirname, 'logs', 'app.log');
const LOG_MAX = 5 * 1024 * 1024;
const LOG_PER_MIN = 120;
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch (e) { /* egal */ }
let logSize = 0, logMin = 0, logCount = 0, logDropped = 0;
try { logSize = fs.statSync(LOG_FILE).size; } catch (e) { /* neu */ }
function logLine(level, args) {
  const min = Math.floor(Date.now() / 60000);
  if (min !== logMin) {
    if (logDropped) { const d = logDropped; logDropped = 0; logMin = min; logCount = 0; logLine('WARN', [d + ' Logzeilen unterdrückt (Flut)']); }
    logMin = min; logCount = 0;
  }
  if (++logCount > LOG_PER_MIN) { logDropped++; return; }
  const msg = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 2000);
  const line = new Date().toISOString() + ' ' + level + ' ' + msg + '\n';
  try {
    if (logSize + line.length > LOG_MAX) { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); logSize = 0; }
    fs.appendFileSync(LOG_FILE, line); logSize += line.length;
  } catch (e) { /* egal */ }
}
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => { try { logLine(level.toUpperCase(), args); orig(...args); } catch (e) { /* Logging darf nie werfen */ } };
}
/* Unerwarteter Fehler: Räume sichern, dann beenden (Passenger startet neu). Normalerweise nie erreicht,
   weil alle Handler und Timer über guard() laufen. */
process.on('uncaughtException', (e) => { console.error('uncaughtException', e); try { flushAll(); } catch (x) { /* egal */ } process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('unhandledRejection', e); });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { flushAll(); } catch (x) { /* egal */ } process.exit(0); });
console.log('Start: Node ' + process.version + ', PORT=' + (process.env.PORT || '(leer)') + ', cwd=' + process.cwd());
/* Callback, der nie den Prozess beenden kann (für Timer und Socket-Ereignisse) */
function guard(fn, what) {
  return function () {
    try { return fn.apply(this, arguments); } catch (e) { console.error('Fehler in ' + (what || 'Handler'), e); }
  };
}

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
// Dateien entweder in public/ oder flach neben server.js
const PUBLIC = fs.existsSync(path.join(ROOT, 'public', 'index.html'))
  ? path.join(ROOT, 'public') : ROOT;
const DATA = path.join(ROOT, 'data');

/* Grenzen – ein echter Raum (3 Spieler, 2 Hände) hat ca. 20 KB und 18 Dokumente */
const MAX_BODY = 131072;             // 128 KB je Dokument
const MAX_ROOM = 524288;             // 512 KB je Raum
const MAX_DOCS = 200;                // Dokumente je Raum
const MAX_DEPTH = 16;                // Verschachtelungstiefe eines Dokuments
const MAX_NODES = 20000;             // Werte je Dokument
const MAX_SOCKETS = 1000;            // WebSockets gesamt
const MAX_ROOM_SOCKETS = 40;         // WebSockets je Raum
const MAX_IP_SOCKETS = 30;           // WebSockets je IP
const WS_IN_MAX = 4096;              // Client schickt nur Pongs/Lebenszeichen
const WS_OUT_MAX = 2 * 1024 * 1024;  // Sendepuffer je Socket; wer nicht liest, fliegt raus
const MAX_ROOMS = 300;               // Räume gesamt (Platte)
const CREATE_LIMIT = 20;             // neue Räume je IP …
const CREATE_GLOBAL = 120;           // … und insgesamt …
const CREATE_WINDOW = 10 * 60 * 1000; // … in 10 Minuten
const RATE_BURST = 240;              // Anfragen je IP auf Vorrat …
const RATE_PER_SEC = 40;             // … und Nachschub je Sekunde (8 Spieler hinter einem WLAN brauchen ~20/s)
const MAX_SCHEDULED = 50;            // geplante Räume (leben lange) – Rest bleibt für spontane Räume frei
const SCHEDULE_MAX_MS = 30 * 24 * 3600 * 1000;  // höchstens 30 Tage im Voraus …
const SCHEDULE_MIN_MS = Number(process.env.KR_SCHEDULE_MIN_MS) || 60000;  // … und mindestens 1 Minute (Test: kürzer)
const ROOM_IDLE_MS = 10 * 60 * 1000; // Raum ohne Zugriff so lange im Speicher, danach nur noch auf Platte
const MEM_SOFT = (Number(process.env.KR_MEM_MB) || 350) * 1024 * 1024;  // darüber: keine neuen Räume/Dokumente
const CODE_RE = /^[A-Z0-9]{1,8}$/;
const PATH_RE = /^[A-Za-z0-9_.~:@+-]+(\/[A-Za-z0-9_.~:@+-]+){0,2}$/;
const ID_RE = /[^A-Za-z0-9_.~:@+-]/g;

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

/* ------------------------------------------------ Einstellungen ---------- */
const DEFAULTS = {
  minPlayers: 3,            // unter 3 ist das verteilte Geben nicht sicher
  maxPlayers: 8,
  holeCards: 2,             // Handkarten je Spieler
  chipsResetEachStage: false,
  allowSteal: true,         // Chips dürfen anderen weggenommen werden
  guessEnabled: true,       // gemeinsamer Tipp vor dem Aufdecken
  revealHighestFirst: true, // sonst von Chip 1 aufwärts
  voiceEnabled: false,      // Voice-Chat (WebRTC, Geräte direkt verbunden); im Admin einschaltbar
  roomTtlHours: 48
};
const CONF_FILE = path.join(DATA, 'config.json');
let config = Object.assign({}, DEFAULTS);
try {
  const c = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
  if (c && typeof c === 'object') config = sanitizeConfig(c);
} catch (e) { /* Standard */ }

function sanitizeConfig(inp) {
  const c = Object.assign({}, config);
  const num = (v, lo, hi, def) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  if (inp.minPlayers !== undefined) c.minPlayers = num(inp.minPlayers, 2, 12, c.minPlayers);
  if (inp.maxPlayers !== undefined) c.maxPlayers = num(inp.maxPlayers, 2, 12, c.maxPlayers);
  if (inp.holeCards !== undefined) c.holeCards = num(inp.holeCards, 1, 5, c.holeCards);
  if (inp.roomTtlHours !== undefined) c.roomTtlHours = num(inp.roomTtlHours, 1, 720, c.roomTtlHours);
  for (const k of ['chipsResetEachStage', 'allowSteal', 'guessEnabled', 'revealHighestFirst', 'voiceEnabled'])
    if (inp[k] !== undefined) c[k] = !!inp[k];
  if (c.maxPlayers < c.minPlayers) c.maxPlayers = c.minPlayers;
  if (c.holeCards * c.maxPlayers + 5 > 52) c.holeCards = Math.max(1, Math.floor((52 - 5) / c.maxPlayers));
  return c;
}
function saveConfig() {
  try { fs.writeFileSync(CONF_FILE, JSON.stringify(config, null, 2)); }
  catch (e) { console.error('config', e.message); }
}

/* ------------------------------------------------ Admin-Secret ----------- */
const SECRET_FILE = path.join(DATA, 'admin-secret.txt');
let ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();
if (!ADMIN_SECRET) {
  try { ADMIN_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) { /* neu */ }
}
if (!ADMIN_SECRET) {
  ADMIN_SECRET = crypto.randomBytes(12).toString('base64url');
  try { fs.writeFileSync(SECRET_FILE, ADMIN_SECRET + '\n', { mode: 0o600 }); } catch (e) { /* egal */ }
  console.log('Neues Admin-Secret erzeugt: ' + ADMIN_SECRET + '  (steht in data/admin-secret.txt)');
}
function secretOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(ADMIN_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------ Räume ------------------ */
const rooms = new Map();             // code -> {version, docs}
const subs = new Map();              // code -> Set(socket)
const dirty = new Set();
const touched = new Map();           // code -> letzter Zugriff (ms), zum Entladen ruhender Räume

function file(code) { return path.join(DATA, code + '.json'); }
/* Raumdatei lesen, ohne sie im Speicher zu halten (Raumliste) */
function peek(code) {
  if (rooms.has(code)) return rooms.get(code);
  try {
    if (fs.statSync(file(code)).size > MAX_ROOM * 2) return null;
    const r = JSON.parse(fs.readFileSync(file(code), 'utf8'));
    if (r && typeof r === 'object' && r.docs && typeof r.docs === 'object') return r;
  } catch (e) { /* nicht vorhanden/kaputt */ }
  return null;
}
function load(code) {
  const r = peek(code);
  if (r) { if (!rooms.has(code)) rooms.set(code, r); touched.set(code, Date.now()); }
  return r;
}
function save(code) {
  const r = rooms.get(code); if (!r) return;
  const tmp = file(code) + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(r)); fs.renameSync(tmp, file(code)); }
  catch (e) { console.error('save', code, e.message); }
}
function flushAll() { for (const c of dirty) save(c); dirty.clear(); saveCounters(); }

/* Zähler für die Startseite: gespielte Hände in Räumen (mp) und im Übungsraum (sp) */
const COUNT_FILE = path.join(DATA, 'counters.json');
const counters = { mp: 0, sp: 0 };
let countersDirty = false;
try {
  const c = JSON.parse(fs.readFileSync(COUNT_FILE, 'utf8'));
  counters.mp = Math.max(0, parseInt(c.mp, 10) || 0); counters.sp = Math.max(0, parseInt(c.sp, 10) || 0);
} catch (e) { /* neu */ }
function bump(k) { counters[k]++; countersDirty = true; }
function saveCounters() {
  if (!countersDirty) return;
  try { fs.writeFileSync(COUNT_FILE + '.tmp', JSON.stringify(counters)); fs.renameSync(COUNT_FILE + '.tmp', COUNT_FILE); countersDirty = false; }
  catch (e) { console.error('counters', e.message); }
}
/* Bremsen gegen Aufblähen: je Raum höchstens eine Hand je 10 s, Übungsraum je IP eine Hand je 8 s */
const lastMpCount = new Map(), lastSpCount = new Map();
function countMpHand(code) {
  const now = Date.now();
  if (now - (lastMpCount.get(code) || 0) < 10000) return;
  if (lastMpCount.size > 5000) lastMpCount.clear();
  lastMpCount.set(code, now); bump('mp');
}
function countSpHand(ip, n) {
  const now = Date.now(), k = ip || '?';
  if (now - (lastSpCount.get(k) || 0) < (ip ? 8000 : 1000)) return;
  if (lastSpCount.size > 20000) lastSpCount.clear();
  lastSpCount.set(k, now); counters.sp += (n || 1) - 1; bump('sp');
}
setInterval(guard(flushAll, 'save'), 2000).unref();

/* Ruhende Räume (kein WebSocket, lange kein Zugriff) aus dem Speicher nehmen – sie liegen ja auf Platte */
function evict(maxIdle) {
  const now = Date.now();
  for (const code of [...rooms.keys()]) {
    if (subs.has(code) || now - (touched.get(code) || 0) < maxIdle) continue;
    if (dirty.has(code)) { save(code); dirty.delete(code); }
    rooms.delete(code); touched.delete(code); seen.delete(code);
  }
}
setInterval(guard(() => evict(ROOM_IDLE_MS), 'evict'), 60000).unref();

/* Speicher knapp → zuerst entladen, und solange es knapp bleibt keine neuen Räume/Dokumente */
let memTight = false, memCheckedAt = 0;
function memoryTight() {
  const now = Date.now();
  if (now - memCheckedAt < 1000) return memTight;
  memCheckedAt = now;
  let rss = process.memoryUsage().rss;
  if (rss > MEM_SOFT) { evict(5000); rss = process.memoryUsage().rss; }
  if ((rss > MEM_SOFT) !== memTight) console.warn('Speicher ' + (rss > MEM_SOFT ? 'knapp' : 'wieder ok') + ': ' + Math.round(rss / 1048576) + ' MB');
  memTight = rss > MEM_SOFT;
  return memTight;
}

function gc() {
  const ttl = config.roomTtlHours * 3600 * 1000;
  const now = Date.now();
  let files = [];
  try { files = fs.readdirSync(DATA); } catch (e) { console.error('gc', e.message); return; }
  for (const f of files) {
    if (!f.endsWith('.json') || f === 'config.json') continue;
    try {
      const p = path.join(DATA, f);
      const c0 = f.replace(/\.json$/, '');
      if (scheduled.has(c0) && scheduled.get(c0) + ttl > now) continue;     // geplant: erst ab Startzeit + TTL
      if (now - fs.statSync(p).mtimeMs > ttl) { fs.unlinkSync(p); rooms.delete(c0); scheduled.delete(c0); console.log('Raum ' + f + ' nach Ablauf aufgeräumt'); }
    } catch (e) { /* egal */ }
  }
  for (const [ip, l] of createLog) if (!l.length || now - l[l.length - 1] > CREATE_WINDOW) createLog.delete(ip);
  for (const [ip, b] of buckets) if (now - b.t > 60000) buckets.delete(ip);
  for (const [code, m] of seen) {
    if (!rooms.has(code)) { seen.delete(code); continue; }
    for (const [id, ts] of m) if (now - ts > 3600 * 1000) m.delete(id);
  }
}
setTimeout(guard(gc, 'gc'), 0);
setInterval(guard(gc, 'gc'), 10 * 60 * 1000).unref();

function commit(code, changed) {         // changed: [pfad, ...]
  const r = rooms.get(code);
  r.version++;
  dirty.add(code);
  broadcast(code, {
    type: 'docs', version: r.version,
    changes: changed.map((p) => ({ path: p, doc: r.docs[p] === undefined ? null : r.docs[p] }))
  });
  return r.version;
}
function change(code, p, doc) {
  const r = rooms.get(code); if (!r) return null;
  if (doc === null) {
    delete r.docs[p];
  } else {
    if (r.docs[p] === undefined && Object.keys(r.docs).length >= MAX_DOCS) return null;
    const prev = r.docs[p];
    r.docs[p] = doc;
    let size = Infinity;
    try { size = JSON.stringify(r.docs).length; } catch (e) { /* nicht serialisierbar → ablehnen */ }
    if (size > MAX_ROOM) {
      if (prev === undefined) delete r.docs[p]; else r.docs[p] = prev;
      return null;
    }
  }
  return commit(code, [p]);
}
/**
 * Chipwechsel – in einem Zug, damit nichts flackert und zwei gleichzeitige
 * Griffe nach demselben Chip deterministisch aufgelöst werden: der Server
 * bearbeitet die Anfragen in Eingangsreihenfolge und stempelt sie.
 */
function chipMove(code, n, who, h, take) {
  const r = rooms.get(code); if (!r) return null;
  const key = 'chips/' + n;
  const cur = r.docs[key];
  const opt = (r.docs['state/main'] && r.docs['state/main'].opt) || {};
  const steal = opt.allowSteal !== undefined ? opt.allowSteal : config.allowSteal;
  const ts = Date.now();
  const changed = [];

  if (take && !steal && cur && cur.hand === h && cur.holder && cur.holder !== who) {
    return { ok: false, version: r.version, reason: 'belegt' };
  }
  if (take) {
    for (const k of Object.keys(r.docs)) {
      if (k.indexOf('chips/') !== 0 || k === key) continue;
      const c = r.docs[k];
      if (c && c.hand === h && c.holder === who) { r.docs[k] = { holder: null, hand: h, ts: ts }; changed.push(k); }
    }
    r.docs[key] = { holder: who, hand: h, ts: ts };
  } else {
    r.docs[key] = { holder: null, hand: h, ts: ts };
  }
  changed.push(key);
  const pd = r.docs['players/' + who];
  if (pd && pd.ready) { pd.ready = null; changed.push('players/' + who); }
  return { ok: true, version: commit(code, changed) };
}

/* ------------------------------------------------ WebSocket -------------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(str, opcode) {
  const p = Buffer.from(str === null ? '' : str, 'utf8');
  const len = p.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | (opcode || 0x1);
  return Buffer.concat([head, p]);
}
/* Schreiben mit Gegendruck: wer seinen Puffer nicht abholt (hängendes Handy, Angreifer), wird getrennt */
function put(sock, buf) {
  if (sock.destroyed) return;
  if (sock.writableLength > WS_OUT_MAX) return drop(sock);
  try { sock.write(buf); } catch (e) { drop(sock); }
}
function send(sock, obj) { put(sock, frame(JSON.stringify(obj), 0x1)); }
function broadcast(code, obj) {
  const set = subs.get(code); if (!set) return;
  let buf;
  try { buf = frame(JSON.stringify(obj), 0x1); } catch (e) { console.error('broadcast', code, e.message); return; }
  for (const s of set) put(s, buf);
}
function broadcastAll(obj) { for (const code of subs.keys()) broadcast(code, obj); }
const wsPerIp = new Map();             // ip -> offene WebSockets
function drop(sock) {
  if (sock.__dropped) return;
  sock.__dropped = true;
  if (sock.__ip) { const n = (wsPerIp.get(sock.__ip) || 1) - 1; if (n > 0) wsPerIp.set(sock.__ip, n); else wsPerIp.delete(sock.__ip); }
  const set = sock.__room && subs.get(sock.__room);
  if (set) { set.delete(sock); if (!set.size) subs.delete(sock.__room); }
  try { sock.destroy(); } catch (e) { /* egal */ }
}

/* Anwesenheit: wer hat in den letzten Sekunden gepollt oder hält einen WebSocket offen */
const seen = new Map();                // code -> Map(uid -> ms)
const ONLINE_MS = 15000;
const MAX_SEEN = 200;                   // Anwesende je Raum (Spieler + Zuschauer); erfundene IDs füllen sonst den Speicher
function markSeen(code, uid, r) {
  if (!uid) return;
  if (!seen.has(code)) seen.set(code, new Map());
  const m = seen.get(code), now = Date.now();
  if (!m.has(uid) && m.size >= MAX_SEEN) {
    for (const [id, ts] of m) if (now - ts > ONLINE_MS && !r.docs['players/' + id]) m.delete(id);
    if (m.size >= MAX_SEEN && !r.docs['players/' + uid]) return;
  }
  m.set(uid, now);
}
const STARTED = Date.now();
const TAKEOVER_MS = Number(process.env.KR_TAKEOVER_MS) || 30000;    // so lange weg, bis ein Platz übernommen werden darf
const HOST_MOVE_MS = Number(process.env.KR_HOST_MOVE_MS) || 120000;  // so lange weg, bis die Host-Rolle weiterwandert
/* Zuletzt gesehen: Poll oder Lebenszeichen über WebSocket (Pong/Nachricht). Ein offener,
   aber stummer Socket (Handy gesperrt) zählt nicht mehr als anwesend. */
function lastSeen(code, uid) {
  let ts = 0;
  for (const s of (subs.get(code) || [])) if (s.__uid === uid && s.__last > ts) ts = s.__last;
  const m = seen.get(code);
  if (m && m.get(uid) > ts) ts = m.get(uid);
  return ts || STARTED;                  // nach Neustart zählt die Wartezeit ab Start
}
/* Übernehmbar: nicht der Host (Host-Rechte bleiben beim Gerät des Hosts) und >= 60 s weg */
function takeable(code, r, pid) {
  return !!r.docs['players/' + pid] && !isBotId(r, pid) && pid !== roomHost(r) && Date.now() - lastSeen(code, pid) >= TAKEOVER_MS;
}
function isBotId(r, id) { return !!(r && r.bots && r.bots[id]); }
function betweenHands(r) { const ph = (r.docs['state/main'] || {}).phase; return !ph || ph === 'lobby' || ph === 'done'; }
function idleList(code, r) {
  return Object.keys(r.docs).filter((k) => k.indexOf('players/') === 0).map((k) => k.slice(8))
    .filter((id) => takeable(code, r, id));
}
function onlineList(code) {
  const out = new Set(), now = Date.now();
  for (const [id, ts] of (seen.get(code) || new Map())) if (now - ts < ONLINE_MS) out.add(id);
  for (const s of (subs.get(code) || [])) if (s.__uid && now - s.__last < 40000) out.add(s.__uid);
  const r = rooms.get(code);
  if (r && r.bots) for (const id of Object.keys(r.bots)) out.add(id);   // Bots sind immer da
  return [...out];
}
/* Wie lange ist wer weg (nur Spieler, die gerade offline sind) */
function awayMap(code, r) {
  const on = onlineList(code), out = {}, now = Date.now();
  for (const k of Object.keys(r.docs)) {
    if (k.indexOf('players/') !== 0) continue;
    const id = k.slice(8);
    if (on.indexOf(id) < 0) out[id] = now - lastSeen(code, id);
  }
  return out;
}
/* Host dauerhaft weg → Host-Rolle an den am längsten anwesenden Online-Spieler */
function maybeMoveHost(code, r) {
  const h = roomHost(r);
  if (!h || Date.now() - lastSeen(code, h) < HOST_MOVE_MS) return false;
  const on = onlineList(code);
  const cand = Object.keys(r.docs).filter((k) => k.indexOf('players/') === 0)
    .map((k) => ({ id: k.slice(8), j: (r.docs[k] && r.docs[k].joinedAt) || 0 }))
    .filter((x) => x.id !== h && on.indexOf(x.id) >= 0 && !isBotId(r, x.id))   // ein Bot wird nie Host
    .sort((a, b) => a.j - b.j || (a.id < b.id ? -1 : 1));
  if (!cand.length) return false;
  r.docs.room = Object.assign({}, r.docs.room, { hostId: cand[0].id, hostMovedFrom: h, hostMovedAt: Date.now() });
  commit(code, ['room']);
  console.log('Host-Rolle in ' + code + ' weitergegeben (Host ' + Math.round((Date.now() - lastSeen(code, h)) / 1000) + ' s weg)');
  return true;
}

/* Geräteschlüssel: jeder Browser schickt x-kr-key; der Server bindet den Hash an die Spieler-ID
   (beim ersten Mal). Damit lassen sich Kick (nur Host) und fremde Spieler-Einträge absichern. */
function keyHash(req) {
  const k = String(req.headers['x-kr-key'] || '');
  return k.length >= 16 ? crypto.createHash('sha256').update(k).digest('hex') : '';
}
function keyOk(r, uid, kh, bindIfFree) {
  if (!uid || !kh) return false;
  r.keys = r.keys || {};
  if (!r.keys[uid]) { if (!bindIfFree) return false; r.keys[uid] = kh; return true; }
  return r.keys[uid] === kh;
}
/* Gehört der Geräteschlüssel zu irgendeinem Spieler dieses Raums? */
function memberId(r, kh) {
  if (!kh || !r.keys) return null;
  for (const id of Object.keys(r.keys)) if (r.keys[id] === kh && r.docs['players/' + id]) return id;
  return null;
}
/* Spieler-ID + passender Schlüssel (für Chip, Tipp, Chat, Anstupsen) */
function authPlayer(r, uid, req) {
  return !!uid && !!r.docs['players/' + uid] && keyOk(r, uid, keyHash(req), false);
}
/* Client-IP hinter nginx/Passenger. Den ersten X-Forwarded-For-Eintrag kann jeder frei setzen;
   verlässlich ist der von unserem Proxy angehängte, also der letzte öffentliche Eintrag. */
const PRIVATE_IP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80:|::ffff:127\.|unix|$)/i;
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = xf.length - 1; i >= 0; i--) if (!PRIVATE_IP.test(xf[i])) return xf[i].slice(0, 64);
  const xr = String(req.headers['x-real-ip'] || '').trim();
  if (xr && !PRIVATE_IP.test(xr)) return xr.slice(0, 64);
  const ra = String((req.socket && req.socket.remoteAddress) || '');
  return PRIVATE_IP.test(ra) ? '' : ra;   // '' = unbekannt (kein Proxy-Header) → nur globale Grenzen
}
let ipNoted = false;
function noteIpSource(req) {                // einmal je Start ins Log: woher kommt die Client-IP?
  if (ipNoted) return; ipNoted = true;
  console.log('IP-Quelle: x-forwarded-for=' + (req.headers['x-forwarded-for'] ? 'ja' : 'nein') +
    ', x-real-ip=' + (req.headers['x-real-ip'] ? 'ja' : 'nein') + ', remote=' + ((req.socket && req.socket.remoteAddress) || '-') +
    ' → ' + (clientIp(req) ? 'je IP begrenzt' : 'keine Client-IP, nur globale Grenzen'));
}
const createLog = new Map();           // ip -> [ms]
let createAll = [];                    // alle neuen Räume (ms)
function createAllowed(ip) {
  const now = Date.now();
  createAll = createAll.filter((t) => now - t < CREATE_WINDOW);
  if (createAll.length >= CREATE_GLOBAL) return false;
  if (ip) {
    const l = (createLog.get(ip) || []).filter((t) => now - t < CREATE_WINDOW);
    if (l.length >= CREATE_LIMIT) { createLog.set(ip, l); return false; }
    if (!createLog.has(ip) && createLog.size >= 20000) return false;
    l.push(now); createLog.set(ip, l);
  }
  createAll.push(now);
  return true;
}
/* Token-Bucket je IP für /api und /admin-api */
const buckets = new Map();             // ip -> {n, t}
function rateOk(ip, cost) {
  if (!ip) return true;
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) {
    if (buckets.size >= 50000) return false;
    b = { n: RATE_BURST, t: now }; buckets.set(ip, b);
  }
  b.n = Math.min(RATE_BURST, b.n + (now - b.t) / 1000 * RATE_PER_SEC); b.t = now;
  if (b.n < cost) return false;
  b.n -= cost;
  return true;
}
function roomCount() {
  try { return (fs.readdirSync(DATA) || []).filter((f) => f.endsWith('.json') && f !== 'config.json').length; } catch (e) { return 0; }
}
/* Erlaubte Dokumentpfade für allgemeines set/del; alles andere wird abgelehnt */
const DOC_RE = /^(state\/(main|guess)|deal\/(deck|assignA|assignB|boardA|boardB)|chips\/[0-9]{1,2}|reveal\/[A-Za-z0-9_.~:@+-]{1,40}|players\/[A-Za-z0-9_.~:@+-]{1,40})$/;
/* Raumname: optional, frei wählbar, aber ohne Steuerzeichen/Spitzklammern, max. 30 Zeichen */
function cleanRoomName(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30); }
/* Zeitzone des Planenden (IANA, z. B. Europe/Berlin) – nur übernehmen, wenn Node sie kennt */
function cleanTz(tz) {
  tz = String(tz || '');
  if (!/^[A-Za-z_+\-\/0-9]{1,64}$/.test(tz)) return 'Europe/Berlin';
  try { new Intl.DateTimeFormat('de-DE', { timeZone: tz }); return tz; } catch (e) { return 'Europe/Berlin'; }
}
function cleanName(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24) || 'Spieler'; }
/* Geplante Räume: code -> Startzeit. Beim Start aus den (vor Beginn winzigen) Raumdateien aufgebaut. */
const scheduled = new Map();
try {
  for (const f of fs.readdirSync(DATA)) {
    const c = f.replace(/\.json$/, '');
    if (!f.endsWith('.json') || !CODE_RE.test(c) || fs.statSync(path.join(DATA, f)).size > 65536) continue;
    const r = peek(c), t = r && r.docs.room && Number(r.docs.room.startsAt);
    if (t) scheduled.set(c, t);
  }
} catch (e) { /* egal */ }
function scheduledOpen() { let n = 0; const now = Date.now(); for (const t of scheduled.values()) if (t > now) n++; return n; }
function notOpenYet(r) { const t = r.docs.room && Number(r.docs.room.startsAt); return !!t && Date.now() < t; }
/* Voice-Chat je Raum (nur im Speicher): Mitglieder mit Lebenszeichen, Postfächer für den Verbindungsaufbau */
const voiceRooms = new Map();              // code -> { members: Map(uid -> {muted, ts}), box: Map(uid -> [msg]) }
function voiceRoom(code) {
  if (!voiceRooms.has(code)) voiceRooms.set(code, { members: new Map(), box: new Map() });
  return voiceRooms.get(code);
}
function voiceList(code) {
  const V = voiceRooms.get(code); if (!V) return [];
  const now = Date.now(), out = [];
  for (const [id, m] of V.members) { if (now - m.ts > 20000) { V.members.delete(id); V.box.delete(id); } else out.push({ id: id, muted: m.muted }); }
  if (!V.members.size) voiceRooms.delete(code);
  return out;
}
function removeRoom(c) {
  broadcast(c, { type: 'gone' });
  for (const s of (subs.get(c) || [])) drop(s);
  rooms.delete(c); dirty.delete(c); seen.delete(c); touched.delete(c); scheduled.delete(c); voiceRooms.delete(c);
  openRoomsCache = null;                 // geschlossene Räume sofort aus der Startseiten-Liste
  try { fs.unlinkSync(file(c)); return true; } catch (e) { return false; }
}
function roomHost(r) {                  // wie hostId() im Client
  const h = r.docs.room && r.docs.room.hostId;
  if (h && r.docs['players/' + h]) return h;
  const ps = Object.keys(r.docs).filter((k) => k.indexOf('players/') === 0 && !isBotId(r, k.slice(8)))
    .map((k) => ({ id: k.slice(8), j: (r.docs[k] && r.docs[k].joinedAt) || 0 }))
    .sort((a, b) => a.j - b.j || (a.id < b.id ? -1 : 1));
  return ps.length ? ps[0].id : null;
}

function upgrade(req, sock) {
  const u = new URL(req.url, 'http://x');
  const code = (u.searchParams.get('room') || '').toUpperCase();
  const key = req.headers['sec-websocket-key'];
  if (!key || !CODE_RE.test(code) || !rateOk(clientIp(req), 5) || !load(code)) { sock.destroy(); return; }
  let total = 0; for (const s of subs.values()) total += s.size;
  const ip = clientIp(req);
  if (total >= MAX_SOCKETS || (subs.get(code) && subs.get(code).size >= MAX_ROOM_SOCKETS) ||
      (ip && (wsPerIp.get(ip) || 0) >= MAX_IP_SOCKETS)) { sock.destroy(); return; }
  sock.__ip = ip;
  if (ip) wsPerIp.set(ip, (wsPerIp.get(ip) || 0) + 1);
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
             'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  sock.__room = code;
  sock.__uid = (u.searchParams.get('u') || '').replace(ID_RE, '').slice(0, 40);
  sock.__last = Date.now();
  sock.__buf = Buffer.alloc(0);
  sock.__frames = 0; sock.__framesAt = Date.now();
  if (!subs.has(code)) subs.set(code, new Set());
  subs.get(code).add(sock);

  const r = rooms.get(code);
  send(sock, { type: 'full', version: r.version, docs: r.docs, config: config });

  sock.on('data', guard((chunk) => {
    if (sock.destroyed) return;
    sock.__last = Date.now();              // jedes Lebenszeichen (auch Pong) zählt
    if (sock.__buf.length + chunk.length > WS_IN_MAX + 14) return drop(sock);
    sock.__buf = Buffer.concat([sock.__buf, chunk]);
    for (;;) {
      const b = sock.__buf;
      if (b.length < 2) return;
      const op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > WS_IN_MAX || !masked) return drop(sock);        // Client-Frames müssen maskiert sein (RFC 6455)
      if (b.length < off + 4) return;
      const mask = b.slice(off, off + 4); off += 4;
      if (b.length < off + len) return;
      const pay = Buffer.from(b.slice(off, off + len));
      for (let i = 0; i < pay.length; i++) pay[i] ^= mask[i & 3];
      sock.__buf = b.slice(off + len);
      if (op === 0x8) return drop(sock);
      if (++sock.__frames > 100) {                              // mehr als 100 Frames in 10 s = Flut
        if (Date.now() - sock.__framesAt < 10000) return drop(sock);
        sock.__frames = 0; sock.__framesAt = Date.now();
      }
      if (op === 0x9) put(sock, frame(pay.toString('utf8'), 0xA));
    }
  }, 'WebSocket'));
  sock.on('error', () => drop(sock));
  sock.on('close', () => drop(sock));
}
setInterval(guard(() => {                 // Keepalive gegen Proxy-Timeouts; stumme Sockets schließen
  const now = Date.now(), ping = frame('', 0x9);
  for (const set of [...subs.values()]) for (const s of [...set]) {
    if (s.__last && now - s.__last > 70000) { drop(s); continue; }
    put(s, ping);
  }
}, 'Keepalive'), 25000).unref();

/* ------------------------------------------------ Bots ------------------- */
const bots = require('./bots')({ rooms, commit, chipMove });
setInterval(guard(bots.tick, 'Bots'), 300).unref();

/* ------------------------------------------------ HTTP ------------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json' };

function json(res, codeNum, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': b.length };
  if (res.req && res.req.tooBig) { codeNum = 413; h.Connection = 'close'; }   // Rest des Uploads nicht mehr annehmen
  res.writeHead(codeNum, h);
  res.end(b);
}
/* Tief verschachtelte Dokumente sprengen später JSON.stringify (Stack) → vorher ablehnen. Ohne Rekursion. */
function shapeOk(o) {
  const stack = [[o, 1]]; let nodes = 0;
  while (stack.length) {
    const [v, d] = stack.pop();
    if (++nodes > MAX_NODES) return false;
    if (v && typeof v === 'object') {
      if (d > MAX_DEPTH) return false;
      for (const k in v) stack.push([v[k], d + 1]);
    }
  }
  return true;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      n += c.length;
      if (n > MAX_BODY) { over = true; parts.length = 0; req.tooBig = true; reject(new Error('zu gross')); } else parts.push(c);
    });
    req.on('end', () => {
      if (over) return;
      const s = Buffer.concat(parts).toString('utf8');
      if (!s) return resolve({});
      try {
        const o = JSON.parse(s);
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('kein Objekt');
        if (!shapeOk(o)) throw new Error('zu tief/zu gross');
        resolve(o);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/* Raumübersicht – für Admin und (gekürzt) für die Startseite */
function roomList(maxAge) {
  const list = [], now = Date.now();
  let files = [];
  try { files = fs.readdirSync(DATA); } catch (e) { return list; }
  for (const f of files) {
    if (!f.endsWith('.json') || f === 'config.json') continue;
    const codeName = f.replace(/\.json$/, '');
    if (!CODE_RE.test(codeName)) continue;
    if (maxAge) {                         // alte Räume gar nicht erst lesen
      try { if (now - fs.statSync(path.join(DATA, f)).mtimeMs > maxAge) continue; } catch (e) { continue; }
    }
    const r = peek(codeName);             // nicht dauerhaft in den Speicher holen
    if (!r) continue;
    const m = r.docs['state/main'] || {};
    const names = [];
    for (const k of Object.keys(r.docs)) {
      if (k.indexOf('players/') === 0) names.push(cleanName(r.docs[k] && r.docs[k].name).slice(0, 18));
    }
    let mtime = 0;
    try { mtime = fs.statSync(path.join(DATA, f)).mtimeMs; } catch (e) { /* egal */ }
    const PH = ['lobby', 'deal', 'play', 'guess', 'reveal', 'done'];
    list.push({ code: codeName, name: cleanRoomName(r.docs.room && r.docs.room.name), startsAt: Number(r.docs.room && r.docs.room.startsAt) || 0, players: names.length, names: names, phase: PH.indexOf(m.phase) >= 0 ? m.phase : '-',
      hand: Math.max(0, parseInt(m.hand, 10) || 0),
      online: (subs.get(codeName) || { size: 0 }).size, updated: mtime });
  }
  list.sort((x, y) => y.updated - x.updated);
  return list;
}
const OPEN_ROOM_MS = 6 * 3600 * 1000;   // Startseite zeigt Räume mit Aktivität in den letzten 6 h
/* Öffentliche Raumliste: für alle gleich, daher 3 s zwischengespeichert (liest sonst bei jedem Aufruf alle Räume) */
let openRoomsCache = null, openRoomsAt = 0;
function openRooms() {
  const now = Date.now();
  if (openRoomsCache && now - openRoomsAt < 3000) return openRoomsCache;
  openRoomsCache = roomList(OPEN_ROOM_MS).filter((x) => x.players > 0)
    .map((x) => {
      const r = peek(x.code);
      const free = r ? idleList(x.code, r).map((id) => ({ id: id, name: cleanName((r.docs['players/' + id] || {}).name).slice(0, 18) })) : [];
      if (r && r.bots && betweenHands(r)) for (const id of Object.keys(r.bots))   // zwischen den Händen: Bot-Plätze sind frei
        if (r.docs['players/' + id]) free.push({ id: id, name: cleanName(r.docs['players/' + id].name).slice(0, 18), bot: true });
      return { code: x.code, name: x.name, players: x.players, names: x.names, phase: x.phase, hand: x.hand, free: free };
    });
  openRoomsAt = now;
  return openRoomsCache;
}

async function api(req, res, u) {
  const a = u.searchParams.get('a') || '';
  if (a === 'config') return json(res, 200, { config: config });
  if (a === 'rooms') return json(res, 200, { rooms: openRooms(), counts: { mp: counters.mp, sp: counters.sp } });
  if (a === 'sphand') {                   // Übungsraum meldet neue Hand(en); offline gespielte werden nachgereicht (max. 20)
    let body = {}; try { body = await readBody(req); } catch (e) { /* egal */ }
    countSpHand(clientIp(req), Math.min(20, Math.max(1, parseInt(body.n, 10) || 1)));
    return json(res, 200, { ok: true });
  }

  const code = (u.searchParams.get('room') || '').toUpperCase();
  const p = u.searchParams.get('path') || '';
  if (!CODE_RE.test(code)) return json(res, 400, { error: 'Raumcode ungueltig' });

  if (a === 'create') {
    if (!rooms.has(code) && !fs.existsSync(file(code))) {
      if (memoryTight() || roomCount() >= MAX_ROOMS) return json(res, 503, { error: 'Zu viele offene Räume – bitte später' });
      if (!createAllowed(clientIp(req))) return json(res, 429, { error: 'Zu viele neue Räume – bitte kurz warten' });
    }
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    const host = String(body.hostId || '').replace(ID_RE, '').slice(0, 40);
    /* Geplanter Raum: startsAt (ms); Host ist dann, wer ab Start als Erster beitritt */
    let startsAt = 0;
    if (body.startsAt !== undefined && body.startsAt !== null) {
      startsAt = Math.round(Number(body.startsAt));
      if (!Number.isFinite(startsAt) || startsAt < Date.now() + SCHEDULE_MIN_MS || startsAt > Date.now() + SCHEDULE_MAX_MS)
        return json(res, 400, { error: 'Startzeit muss zwischen 1 Minute und 30 Tagen in der Zukunft liegen' });
    }
    if (!host && !startsAt) return json(res, 400, { error: 'hostId fehlt' });
    if (load(code)) return json(res, 200, { exists: true });
    if (startsAt && scheduledOpen() >= MAX_SCHEDULED) return json(res, 503, { error: 'Zu viele geplante Räume – bitte später' });
    if (startsAt) scheduled.set(code, startsAt);
    rooms.set(code, { version: 1, docs: {
      room: startsAt ? { code: code, hostId: null, createdAt: Date.now(), name: cleanRoomName(body.name), startsAt: startsAt, tz: cleanTz(body.tz) }
        : { code: code, hostId: host, createdAt: Date.now(), name: cleanRoomName(body.name) },
      'state/main': { phase: 'lobby', hand: 0, stage: 0, participants: [] }
    } });
    save(code);
    return json(res, 200, { ok: true, version: 1, config: config });
  }

  const r = load(code);
  if (!r) return json(res, 404, { error: 'Raum nicht gefunden' });

  if (a === 'info') {
    /* Kurzinfo für Einladungslinks (auch vor dem Start): Name, Startzeit, Spielerzahl, Serverzeit */
    const n = Object.keys(r.docs).filter((k) => k.indexOf('players/') === 0).length;
    const room = r.docs.room || {};
    return json(res, 200, { code: code, name: cleanRoomName(room.name), startsAt: Number(room.startsAt) || 0, players: n, now: Date.now() });
  }
  if (a === 'state') {
    const pu = (u.searchParams.get('u') || '').replace(ID_RE, '').slice(0, 40);
    markSeen(code, pu, r);
    maybeMoveHost(code, r);
    const since = parseInt(u.searchParams.get('since') || '-1', 10);
    const online = onlineList(code), idle = idleList(code, r), away = awayMap(code, r);
    const pres = { online: online, idle: idle, away: away, takeoverMs: TAKEOVER_MS, hostMoveMs: HOST_MOVE_MS,
      voiceEnabled: !!config.voiceEnabled, voice: config.voiceEnabled ? voiceList(code) : [] };
    if (since === r.version) return json(res, 200, Object.assign({ version: r.version }, pres));
    return json(res, 200, Object.assign({ version: r.version, docs: r.docs, config: config }, pres));
  }
  if (a === 'guess') {
    /* Tipp atomar: Wert setzen (setzt Bestätigungen zurück) oder eigene Bestätigung umschalten */
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    const who = String(body.uid || '').replace(ID_RE, '').slice(0, 40);
    const m = r.docs['state/main'] || {};
    const g = r.docs['state/guess'];
    if (!authPlayer(r, who, req)) return json(res, 403, { error: 'Nicht dein Platz' });
    if (!who || m.phase !== 'guess' || !g || g.hand !== m.hand) return json(res, 409, { error: 'Gerade kein Tipp' });
    if (who === m.target || (m.participants || []).indexOf(who) < 0) return json(res, 403, { error: 'Du tippst nicht mit' });
    const ng = { hand: g.hand, cards: (g.cards || []).slice(), confirmed: Object.assign({}, g.confirmed || {}) };
    if (body.confirm !== undefined) {
      if (body.confirm) ng.confirmed[who] = true; else delete ng.confirmed[who];
    } else {
      const i = Number(body.i);
      const val = body.val === null ? null : Number(body.val);
      if (!Number.isInteger(i) || i < 0 || i >= ng.cards.length) return json(res, 400, { error: 'Karte ungueltig' });
      if (val !== null && !(Number.isInteger(val) && val >= 0 && val <= 12)) return json(res, 400, { error: 'Wert ungueltig' });
      ng.cards[i] = val; ng.confirmed = {};
    }
    r.docs['state/guess'] = ng;
    return json(res, 200, { ok: true, version: commit(code, ['state/guess']) });
  }
  if (a === 'kick') {
    /* Spieler entfernen: nur der Host, nachgewiesen über seinen Geräteschlüssel */
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    const who = String(body.uid || '').replace(ID_RE, '').slice(0, 40);
    const target = String(body.target || '').replace(ID_RE, '').slice(0, 40);
    if (!who || who !== roomHost(r) || !keyOk(r, who, keyHash(req), false)) return json(res, 403, { error: 'Nur der Host darf Spieler entfernen' });
    if (!target || target === who || !r.docs['players/' + target]) return json(res, 400, { error: 'Spieler unbekannt' });
    const wasBot = isBotId(r, target);
    delete r.docs['players/' + target];
    if (wasBot) bots.remove(r, target);
    console.log('Raum ' + code + ': ' + (wasBot ? 'Bot' : 'Spieler') + ' vom Host entfernt');
    return json(res, 200, { ok: true, version: commit(code, ['players/' + target]) });
  }
  if (a === 'addbot') {
    /* Bot hinzufügen: nur der Host, nur zwischen den Händen, Raum nicht voll */
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    const who = String(body.uid || '').replace(ID_RE, '').slice(0, 40);
    if (!who || who !== roomHost(r) || !keyOk(r, who, keyHash(req), false)) return json(res, 403, { error: 'Nur der Host darf Bots hinzufügen' });
    const ph = (r.docs['state/main'] || {}).phase;
    if (ph && ph !== 'lobby' && ph !== 'done') return json(res, 409, { error: 'Bots nur zwischen den Händen hinzufügen' });
    const n = Object.keys(r.docs).filter((k) => k.indexOf('players/') === 0).length;
    if (n >= (config.maxPlayers || 8)) return json(res, 409, { error: 'Raum ist voll (' + (config.maxPlayers || 8) + ' Spieler)' });
    if (memoryTight()) return json(res, 503, { error: 'Server ausgelastet – bitte kurz warten' });
    try {
      const id = await bots.add(code, r);
      return json(res, 200, { ok: true, id: id, version: r.version });
    } catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : 'Bot konnte nicht angelegt werden' }); }
  }
  if (a === 'botify') {
    /* Host ersetzt einen Offline-Spieler durch einen Bot (doppelte Bestätigung im Browser). Läuft eine Hand,
       wird sie nur mit abort=true abgebrochen – der Bot kann die Karten des alten Geräts nicht lesen. */
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    const who = String(body.uid || '').replace(ID_RE, '').slice(0, 40), target = String(body.target || '').replace(ID_RE, '').slice(0, 40);
    if (!who || who !== roomHost(r) || !keyOk(r, who, keyHash(req), false)) return json(res, 403, { error: 'Nur der Host darf Spieler ersetzen' });
    if (!target || target === who || !r.docs['players/' + target] || isBotId(r, target)) return json(res, 400, { error: 'Spieler unbekannt' });
    if (onlineList(code).indexOf(target) >= 0) return json(res, 409, { error: 'Der Spieler ist gerade online' });
    const m = r.docs['state/main'] || {}, inHand = !!m.phase && m.phase !== 'lobby' && m.phase !== 'done';
    if (inHand && !body.abort) return json(res, 409, { error: 'Es läuft eine Hand – Ersetzen bricht sie ab' });
    try { await bots.convert(code, r, target); } catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : 'Bot konnte nicht angelegt werden' }); }
    if (r.keys) delete r.keys[target];        // altes Gerät kann nicht mehr im Namen des Platzes handeln
    if (inHand) { r.docs['state/main'] = Object.assign({}, m, { phase: 'lobby', stage: 0 }); commit(code, ['state/main']); }
    return json(res, 200, { ok: true, aborted: inHand, version: r.version });
  }
  if (a === 'replacebot') {
    /* Echter Spieler übernimmt nach einer Hand den Platz eines Bots (Sitzreihenfolge bleibt, Bot verschwindet) */
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    const who = String(body.uid || '').replace(ID_RE, '').slice(0, 40), target = String(body.target || '').replace(ID_RE, '').slice(0, 40);
    const kh = keyHash(req);
    if (!who || !kh || (r.keys && r.keys[who] && r.keys[who] !== kh)) return json(res, 403, { error: 'Geraeteschluessel fehlt' });
    if (!isBotId(r, target) || !r.docs['players/' + target]) return json(res, 400, { error: 'Diesen Bot gibt es nicht (mehr)' });
    if (!betweenHands(r)) return json(res, 409, { error: 'Bot-Plätze erst nach der Hand übernehmen' });
    if (r.docs['players/' + who] && who !== target) return json(res, 409, { error: 'Du spielst schon mit' });   // who===target: eigenen Platz vom Bot zurückholen
    if (!body.pub || typeof body.pub !== 'object' || JSON.stringify(body.pub).length > 2000) return json(res, 400, { error: 'Schluessel fehlt' });
    const seat = r.docs['players/' + target].joinedAt || Date.now();
    delete r.docs['players/' + target];
    bots.remove(r, target);
    r.docs['players/' + who] = { name: cleanName(body.name), pub: body.pub, joinedAt: seat, ready: null };
    r.keys = r.keys || {}; r.keys[who] = kh;
    console.log('Raum ' + code + ': Bot-Platz von einem Spieler übernommen');
    return json(res, 200, { ok: true, version: commit(code, ['players/' + target, 'players/' + who]) });
  }
  if (a === 'voice' || a === 'signal' || a === 'signals') {
    /* Voice-Chat: der Server vermittelt nur den Verbindungsaufbau (SDP), Ton fließt direkt zwischen den Geräten */
    if (!config.voiceEnabled) return json(res, 403, { error: 'Voice-Chat ist ausgeschaltet' });
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    const who = String(body.uid || '').replace(ID_RE, '').slice(0, 40);
    if (!authPlayer(r, who, req)) return json(res, 403, { error: 'Nur Spieler' });
    const V = voiceRoom(code);
    if (a === 'voice') {
      if (body.on) V.members.set(who, { muted: !!body.muted, ts: Date.now() });
      else { V.members.delete(who); V.box.delete(who); }
      return json(res, 200, { ok: true, voice: voiceList(code) });
    }
    if (a === 'signal') {
      const to = String(body.to || '').replace(ID_RE, '').slice(0, 40), type = String(body.type || '');
      if (!V.members.has(who) || !V.members.has(to) || to === who) return json(res, 409, { error: 'Nicht im Voice-Chat' });
      if (['offer', 'answer', 'bye'].indexOf(type) < 0) return json(res, 400, { error: 'Typ' });
      const data = body.data == null ? null : String(body.data);
      if (data && data.length > 16384) return json(res, 413, { error: 'Zu gross' });
      const q = (V.box.get(to) || []).filter((m) => Date.now() - m.ts < 60000);
      if (q.length >= 60) return json(res, 429, { error: 'Postfach voll' });
      q.push({ from: who, type: type, data: data, ts: Date.now() }); V.box.set(to, q);
      return json(res, 200, { ok: true });
    }
    /* signals: eigene Nachrichten abholen (und Lebenszeichen) */
    const m = V.members.get(who);
    if (m) { m.ts = Date.now(); if (body.muted !== undefined) m.muted = !!body.muted; }
    const msgs = (V.box.get(who) || []).filter((x) => Date.now() - x.ts < 60000);
    V.box.delete(who);
    return json(res, 200, { ok: true, msgs: msgs, voice: voiceList(code) });
  }
  if (a === 'react') {
    /* Schnelle Reaktion: eines von 5 festen Emojis (Index 0..4), nur Spieler, höchstens alle 1,5 s */
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    const who = String(body.uid || '').replace(ID_RE, '').slice(0, 40), e = Number(body.e);
    if (!authPlayer(r, who, req)) return json(res, 403, { error: 'Nur Spieler' });
    if (!Number.isInteger(e) || e < 0 || e > 4) return json(res, 400, { error: 'Reaktion unbekannt' });
    const prev = r.docs['react/' + who];
    if (prev && Date.now() - prev.ts < 1500) return json(res, 429, { error: 'Nicht so schnell' });
    r.docs['react/' + who] = { e: e, ts: Date.now() };
    return json(res, 200, { ok: true, version: commit(code, ['react/' + who]) });
  }
  if (a === 'record') {
    /* Ergebnis einer fertigen Hand für die Statistik. Jeder Spieler meldet, der Server nimmt je Hand nur die erste
       Meldung, prüft Phase/Hand/Teilnehmer und übernimmt Namen selbst. Letzte 150 Hände. */
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    if (!memberId(r, keyHash(req))) return json(res, 403, { error: 'Nur Spieler dieses Raums' });
    const m = r.docs['state/main'] || {}, hand = Number(body.hand);
    if (m.phase !== 'done' || !Number.isInteger(hand) || hand !== Number(m.hand)) return json(res, 409, { error: 'Hand nicht fertig' });
    const st = (r.docs.stats && Array.isArray(r.docs.stats.hands)) ? r.docs.stats : { hands: [] };
    if (st.hands.some((h) => h.hand === hand)) return json(res, 200, { ok: true, dup: true, version: r.version });
    const parts = Array.isArray(m.participants) ? m.participants.map(String) : [];
    /* rounds: lag der Chip in Runde 1..4 schon passend zur endgültigen Stärke? (true/false/null) */
    const rounds = (x) => (Array.isArray(x && x.rounds) ? [0, 1, 2, 3].map((i) => (x.rounds[i] === true ? true : x.rounds[i] === false ? false : null)) : null);
    const pl = (Array.isArray(body.players) ? body.players : []).slice(0, 12)
      .map((x) => ({ id: String((x && x.id) || '').replace(ID_RE, '').slice(0, 40), ok: !!(x && x.ok), rounds: rounds(x) }))
      .filter((x, i, a) => parts.indexOf(x.id) >= 0 && a.findIndex((y) => y.id === x.id) === i)
      .map((x) => Object.assign({ id: x.id, name: cleanName((r.docs['players/' + x.id] || {}).name).slice(0, 18), ok: x.ok }, x.rounds ? { rounds: x.rounds } : {}));
    if (!pl.length) return json(res, 400, { error: 'Keine Spieler' });
    let guess = null;
    const g = body.guess;
    if (g && typeof g === 'object' && parts.indexOf(String(g.target)) >= 0) {
      const of = Number(g.of), hits = Number(g.hits);
      if (Number.isInteger(of) && of >= 1 && of <= 5 && Number.isInteger(hits) && hits >= 0 && hits <= of) guess = { target: String(g.target), hits: hits, of: of };
    }
    const entry = { hand: hand, ts: Date.now(), win: !!body.win && pl.every((x) => x.ok), players: pl, guess: guess };
    r.docs.stats = { hands: st.hands.concat([entry]).slice(-150) };
    return json(res, 200, { ok: true, version: commit(code, ['stats']) });
  }
  if (a === 'rename') {
    /* Raum umbenennen: nur der Host (Geräteschlüssel); `room` ist sonst nicht schreibbar */
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    const who = String(body.uid || '').replace(ID_RE, '').slice(0, 40);
    if (!who || who !== roomHost(r) || !keyOk(r, who, keyHash(req), false)) return json(res, 403, { error: 'Nur der Host darf den Raum umbenennen' });
    r.docs.room = Object.assign({}, r.docs.room, { name: cleanRoomName(body.name) });
    openRoomsCache = null;
    return json(res, 200, { ok: true, name: r.docs.room.name, version: commit(code, ['room']) });
  }
  if (a === 'close') {
    /* Raum schließen: nur der Host; alle Clients bekommen 'gone' */
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    const who = String(body.uid || '').replace(ID_RE, '').slice(0, 40);
    if (!who || who !== roomHost(r) || !keyOk(r, who, keyHash(req), false)) return json(res, 403, { error: 'Nur der Host darf den Raum schließen' });
    removeRoom(code);
    console.log('Raum ' + code + ' vom Host geschlossen');
    return json(res, 200, { ok: true });
  }
  if (a === 'nudge') {
    /* Anstupsen: nur Spieler, höchstens alle 10 s pro Paar; wird als kurzlebiges Dokument verteilt */
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    const who = String(body.uid || '').replace(ID_RE, '').slice(0, 40), target = String(body.target || '').replace(ID_RE, '').slice(0, 40);
    if (!authPlayer(r, who, req)) return json(res, 403, { error: 'Nur Spieler' });
    if (!target || target === who || !r.docs['players/' + target]) return json(res, 400, { error: 'Spieler unbekannt' });
    const prev = r.docs['nudge/' + target];
    if (prev && prev.from === who && Date.now() - prev.ts < 10000) return json(res, 429, { error: 'Gerade erst angestupst' });
    r.docs['nudge/' + target] = { from: who, ts: Date.now() };
    return json(res, 200, { ok: true, version: commit(code, ['nudge/' + target]) });
  }
  if (a === 'chat') {
    /* Chat nur für Spieler des Raums, nicht für Zuschauer */
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    const who = String(body.uid || '').replace(ID_RE, '').slice(0, 40);
    const pl = r.docs['players/' + who];
    if (!who || !pl || !authPlayer(r, who, req)) return json(res, 403, { error: 'Chat nur für Spieler' });
    const text = String(body.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
    if (!text) return json(res, 400, { error: 'Leer' });
    const list = ((r.docs.chat && r.docs.chat.msgs) || []).slice(-59);
    list.push({ id: who, name: cleanName(pl.name).slice(0, 18), text: text, ts: Date.now() });
    r.docs.chat = { msgs: list };
    return json(res, 200, { ok: true, version: commit(code, ['chat']) });
  }
  if (a === 'get') {
    if (!PATH_RE.test(p)) return json(res, 400, { error: 'Pfad ungueltig' });
    return json(res, 200, { version: r.version, doc: r.docs[p] === undefined ? null : r.docs[p] });
  }
  if (a === 'chip') {
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    const n = String(u.searchParams.get('n') || '');
    if (!/^[0-9]{1,2}$/.test(n)) return json(res, 400, { error: 'Chip ungueltig' });
    const who = String(body.uid || '').replace(ID_RE, '').slice(0, 40);
    if (!who) return json(res, 400, { error: 'uid fehlt' });
    if (!authPlayer(r, who, req)) return json(res, 403, { error: 'Nicht dein Platz' });
    const out = chipMove(code, n, who, Number(body.hand) || 0, !!body.take);
    return json(res, 200, out || { ok: false });
  }
  if ((a === 'set' || a === 'del') && !DOC_RE.test(p)) return json(res, 403, { error: 'Pfad nicht erlaubt' });
  if ((a === 'set' || a === 'del') && p.indexOf('players/') !== 0) {
    const mid = memberId(r, keyHash(req));
    if (!mid) return json(res, 403, { error: 'Nur Spieler dieses Raums' });
    if (p.indexOf('reveal/') === 0 && p.slice(7) !== mid) return json(res, 403, { error: 'Nur eigene Karten aufdecken' });
  }
  if (a === 'del' && p.indexOf('players/') === 0) return json(res, 403, { error: 'Entfernen nur ueber ?a=kick' });
  if (a === 'set' && p.indexOf('players/') === 0) {
    const pid = p.slice(8), kh = keyHash(req);
    if (!kh) return json(res, 403, { error: 'Geraeteschluessel fehlt' });
    if (!r.docs['players/' + pid] && notOpenYet(r)) return json(res, 403, { error: 'Raum ist noch nicht geöffnet' });
    if (isBotId(r, pid)) return json(res, 403, { error: 'Bot-Platz' });
    const free = !(r.keys && r.keys[pid]);
    const takeover = !free && r.keys[pid] !== kh && takeable(code, r, pid);
    if (!free && r.keys[pid] !== kh && !takeover) return json(res, 403, { error: 'Fremder Spielerplatz' });
    r.keys = r.keys || {};
    r.keys[pid] = kh;                    // neu, bestätigt oder übernommen (Spieler war offline)
  }
  if (a === 'set') {
    if (!PATH_RE.test(p)) return json(res, 400, { error: 'Pfad ungueltig' });
    if (memoryTight() && r.docs[p] === undefined) return json(res, 503, { error: 'Server ausgelastet – bitte kurz warten' });
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'Dokument fehlt' });
    if (p.indexOf('players/') === 0) {
      body = { name: cleanName(body.name), pub: (body.pub && typeof body.pub === 'object') ? body.pub : null,
        // Beitrittszeit bestimmt der Server (sonst könnte man sich per altem Datum nach vorn schieben)
        joinedAt: (r.docs[p] && Number(r.docs[p].joinedAt)) || Date.now(),
        ready: (body.ready && typeof body.ready === 'object') ? { hand: Number(body.ready.hand) || 0, stage: Number(body.ready.stage) || 0 } : null };
    }
    const prevMain = p === 'state/main' ? (r.docs['state/main'] || {}) : null;
    const v = change(code, p, body);
    /* Neue Hand gestartet (Phase „geben“, Handnummer +1) → Zähler für die Startseite */
    if (v !== null && prevMain && body.phase === 'deal' && Number(body.hand) === (Number(prevMain.hand) || 0) + 1 && prevMain.phase !== 'deal') countMpHand(code);
    if (v === null) return json(res, 413, { error: 'Raum voll' });
    if (p.indexOf('players/') === 0 && r.docs.room && !r.docs.room.hostId) {
      /* Geplanter Raum: erster Spieler wird Host (Server entscheidet, Reihenfolge der Anfragen) */
      r.docs.room = Object.assign({}, r.docs.room, { hostId: p.slice(8) });
      return json(res, 200, { ok: true, version: commit(code, ['room']) });
    }
    return json(res, 200, { ok: true, version: v });
  }
  if (a === 'del') {
    if (!PATH_RE.test(p)) return json(res, 400, { error: 'Pfad ungueltig' });
    return json(res, 200, { ok: true, version: change(code, p, null) });
  }
  return json(res, 400, { error: 'Unbekannte Aktion' });
}

/* ------------------------------------------------ Admin ------------------ */
async function adminApi(req, res, u) {
  const given = req.headers['x-admin-secret'] || '';
  if (!secretOk(given)) {
    await new Promise((r) => setTimeout(r, 400));   // bremst Rateversuche
    return json(res, 401, { error: 'Falsches Secret' });
  }
  const a = u.searchParams.get('a') || '';

  if (a === 'login') return json(res, 200, { ok: true, config: config, defaults: DEFAULTS });

  if (a === 'config') {
    if (req.method === 'POST') {
      let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
      config = sanitizeConfig(body);
      saveConfig();
      broadcastAll({ type: 'config', config: config });
      console.log('Admin: Einstellungen geändert');
    }
    return json(res, 200, { ok: true, config: config });
  }

  if (a === 'rooms') return json(res, 200, { ok: true, rooms: roomList() });

  if (a === 'delroom') {
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Body' }); }
    const list = body.all ? [...rooms.keys()].concat(
      (fs.readdirSync(DATA) || []).filter((f) => f.endsWith('.json') && f !== 'config.json')
        .map((f) => f.replace(/\.json$/, ''))) : [String(body.code || '').toUpperCase()];
    let n = 0;
    for (const c of new Set(list)) {
      if (!CODE_RE.test(c)) continue;
      if (removeRoom(c)) { n++; console.log('Raum ' + c + ' im Admin gelöscht'); }
    }
    return json(res, 200, { ok: true, deleted: n });
  }
  return json(res, 400, { error: 'Unbekannte Aktion' });
}

/* ------------------------------------------------ Static ----------------- */
function serveStatic(req, res, u) {
  let rel;
  try { rel = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel.indexOf('\0') >= 0) { res.writeHead(400); return res.end(); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const f = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream',
      'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ------------------------------------------------ Einladung mit Vorschau -- */
/* Der Teil nach # erreicht nie den Server – WhatsApp & Co. holen sich die Vorschau daher von /r/CODE */
const htmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function whenText(t, tz) {
  const o = { timeZone: tz };
  const day = new Date(t).toLocaleDateString('de-DE', Object.assign({ weekday: 'short', day: '2-digit', month: '2-digit' }, o));
  const time = new Date(t).toLocaleTimeString('de-DE', Object.assign({ hour: '2-digit', minute: '2-digit' }, o));
  let zone = '';
  try { const z = new Intl.DateTimeFormat('de-DE', Object.assign({ timeZoneName: 'short' }, o)).formatToParts(new Date(t)).find((x) => x.type === 'timeZoneName'); if (z) zone = ' (' + z.value + ')'; } catch (e) { /* ohne Kürzel */ }
  return 'am ' + day + ' um ' + time + ' Uhr' + zone;
}
function invitePage(req, res, codeRaw, prefix) {
  const code = String(codeRaw).toUpperCase();
  const r = CODE_RE.test(code) ? peek(code) : null;
  const room = (r && r.docs.room) || {};
  const name = cleanRoomName(room.name), t = Number(room.startsAt) || 0;
  const host = /^[a-z0-9.-]{1,100}(:[0-9]{1,5})?$/i.test(String(req.headers.host || '')) ? req.headers.host : 'gang.aize.eu';
  const base = (/^(localhost|127\.)/.test(host) ? 'http://' : 'https://') + host + prefix;
  const title = name ? '„' + name + '“ – Letzte Runde' : 'Letzte Runde – Einladung';
  const desc = t && t > Date.now() ? 'Lass uns eine letzte Runde spielen – ' + whenText(t, cleanTz(room.tz)) + '.'
    : 'Lass uns eine letzte Runde spielen! Tippen und mitspielen' + (r ? ' (Raum ' + code + ').' : '.');
  const target = prefix + '#' + (CODE_RE.test(code) ? code : '');
  const b = Buffer.from('<!doctype html><html lang="de"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + htmlEsc(title) + '</title><meta name="description" content="' + htmlEsc(desc) + '">' +
    '<meta property="og:type" content="website"><meta property="og:site_name" content="Letzte Runde">' +
    '<meta property="og:title" content="' + htmlEsc(title) + '"><meta property="og:description" content="' + htmlEsc(desc) + '">' +
    '<meta property="og:url" content="' + htmlEsc(base + 'r/' + code) + '">' +
    '<meta property="og:image" content="' + htmlEsc(base + 'icon-512.png') + '"><meta property="og:image:width" content="512"><meta property="og:image:height" content="512">' +
    '<meta name="twitter:card" content="summary"><meta http-equiv="refresh" content="0;url=' + htmlEsc(target) + '">' +
    '</head><body style="font-family:sans-serif"><p>' + htmlEsc(desc) + '</p><p><a href="' + htmlEsc(target) + '">Weiter zum Spiel …</a></p></body></html>');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" });
  res.end(b);
}

/* Keine einzelne Anfrage darf den Prozess beenden: Fehler → 400/500, Prozess läuft weiter */
function fail(res, e) {
  console.error('Anfragefehler', (e && e.message) || e);
  try { if (!res.headersSent) json(res, 500, { error: 'Serverfehler' }); else res.end(); } catch (x) { /* egal */ }
}
const server = http.createServer((req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    const u = new URL(req.url, 'http://x');
    const isAdmin = u.pathname === '/admin-api' || u.pathname.endsWith('/admin-api');
    const isApi = u.pathname === '/api' || u.pathname.endsWith('/api');
    if (isAdmin || isApi) {
      noteIpSource(req);
      const a = u.searchParams.get('a') || '';
      const cost = isAdmin ? 10 : a === 'rooms' || a === 'create' ? 3 : 1;
      if (!rateOk(clientIp(req), cost)) {
        res.setHeader('Retry-After', '5');
        return json(res, 429, { error: 'Zu viele Anfragen – bitte kurz warten' });
      }
      (isAdmin ? adminApi : api)(req, res, u).catch((e) => fail(res, e));
      return;
    }
    const inv = /^(.*\/)r\/([A-Za-z0-9]{1,8})\/?$/.exec(u.pathname);
    if (inv) {
      if (!rateOk(clientIp(req), 1)) { res.writeHead(429); return res.end(); }
      return invitePage(req, res, inv[2], inv[1]);
    }
    serveStatic(req, res, u);
  } catch (e) { fail(res, e); }
});
server.on('upgrade', (req, sock) => {
  sock.on('error', () => { /* vor dem Handshake: still schließen */ });
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { sock.destroy(); return; }
  if (u.pathname === '/ws' || u.pathname.endsWith('/ws')) { try { upgrade(req, sock); } catch (e) { console.error('upgrade', e.message); drop(sock); } } else sock.destroy();
});
/* Langsame/hängende Verbindungen nicht ewig offen halten (Slowloris) */
server.headersTimeout = 20000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 10000;
server.maxHeadersCount = 60;
server.on('clientError', (e, sock) => { try { if (sock.writable) sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); else sock.destroy(); } catch (x) { /* egal */ } });
server.on('error', (e) => { console.error('Serverfehler', e); if (e.code === 'EADDRINUSE') process.exit(1); });
server.listen(PORT, () => console.log('Kartenrunde läuft auf Port ' + PORT));
