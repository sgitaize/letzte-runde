/* Benutzerkonten: Name + Passwort, keine E-Mail.
 * Wiederherstellung per einmaligem Wiederherstellungscode (bei Registrierung angezeigt), Admin kann Passwort zurücksetzen.
 * Zweck: Statistik (Übungsraum + Räume) im Konto statt nur im Browser.
 *
 * Ablage: data/accounts/<id>.json   = Anmeldedaten (klein, beim Start alle gelesen → Namens-/Sitzungsindex)
 *         data/accounts/<id>.stats.json = Hände + Nutzung (erst bei Bedarf gelesen)
 * Passwörter: scrypt mit Salz. Wiederherstellungscode und Sitzungen: nur sha256 gespeichert (zufällig, 80/256 Bit).
 *
 *   POST /api?a=acct.register {name, pw}            -> {recovery, account} + Cookie
 *   POST /api?a=acct.login    {name, pw}            -> {account} + Cookie
 *   POST /api?a=acct.recover  {name, recovery, pw}  -> {recovery, account} + Cookie   (alle Sitzungen beendet)
 *   GET  /api?a=acct.me                             -> {account, stats}            Sitzung im HttpOnly-Cookie kr_acct
 *   POST /api?a=acct.logout | acct.password {old, pw} | acct.newrecovery {pw} | acct.delete {pw}
 *   POST /api?a=acct.sphands {hands:[…], usage?}    -> Übungsraum-Hände übernehmen (doppelte zählen nicht)
 *   POST /api?a=acct.mphand  {room, hand, day, hr}  -> Raum-Hand aus der Raumstatistik übernehmen (Header x-kr-key)
 *   Admin: accounts | acctreset {id} | acctdel {id}
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ACCOUNTS = Number(process.env.KR_MAX_ACCOUNTS) || 2000;
const MAX_SESSIONS = 10;
const SESSION_TTL = 180 * 24 * 3600 * 1000;   // ungenutzte Anmeldung verfällt nach 180 Tagen
const SP_KEEP = 300, MP_KEEP = 300, USAGE_DAYS = 400;
const REG_IP = 5, REG_ALL = 60, REG_WINDOW = 3600 * 1000;
const FAIL_MAX_NAME = 10, FAIL_MAX_IP = 30, FAIL_WINDOW = 15 * 60 * 1000;
/* scrypt nach OWASP-Empfehlung (N=2^16, r=8, p=2 ≈ 64 MB, ~0,2 s). Parameter stehen je Konto in der Datei → später erhöhbar. */
const SCRYPT = { N: 65536, r: 8, p: 2 };
const COOKIE = 'kr_acct';
const COMMON_PW = new Set(['12345678', '123456789', '1234567890', 'password', 'passwort', 'passwort1', 'password1', 'qwertz123', 'qwerty123',
  'qwertzui', 'qwertyui', 'iloveyou', 'letzterunde', 'abcdefgh', '11111111', '00000000', 'hallo123', 'hallo1234', 'schatz123', 'geheim123', 'sommer2026']);
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // ohne 0/O, 1/I
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function (o) {
  const DIR = path.join(o.DATA, 'accounts');
  try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.chmodSync(DIR, 0o700); } catch (e) { /* egal */ }
  const { json, readBody, clientIp, cleanName } = o;

  const accts = new Map();      // id -> Anmeldedaten
  const byName = new Map();     // Namensschlüssel -> id
  const bySess = new Map();     // sha256(token) -> id
  const statCache = new Map();  // id -> Statistik (nur zuletzt benutzte)

  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const nameKey = (n) => String(n).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const authFile = (id) => path.join(DIR, id + '.json');
  const statFile = (id) => path.join(DIR, id + '.stats.json');

  /* Server-Geheimnis: Umgebungsvariable KR_ACCT_SECRET (empfohlen, liegt dann nicht neben den Daten),
     sonst data/account-secret.txt (beim ersten Start erzeugt). Daraus per HKDF:
     - Pepper für die Passwort-Hashes (gestohlene Kontodateien allein reichen nicht zum Raten),
     - Schlüssel für AES-256-GCM, mit dem jede Kontodatei verschlüsselt auf der Platte liegt.
     Geht das Geheimnis verloren, sind alle Konten unlesbar → sichern! */
  const SECRET_F = path.join(o.DATA, 'account-secret.txt');
  let master = String(process.env.KR_ACCT_SECRET || '').trim(), masterSrc = 'Umgebungsvariable KR_ACCT_SECRET';
  if (master.length < 32) {
    masterSrc = 'data/account-secret.txt';
    try { master = fs.readFileSync(SECRET_F, 'utf8').trim(); } catch (e) { master = ''; }
    if (master.length < 32) {
      master = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(SECRET_F, master + '\n', { mode: 0o600 });
      console.log('Konten: neues Server-Geheimnis in data/account-secret.txt erzeugt (besser als KR_ACCT_SECRET setzen und sichern)');
    }
  }
  try { fs.chmodSync(SECRET_F, 0o600); } catch (e) { /* nicht vorhanden */ }
  const hk = (info) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(master, 'utf8'), Buffer.from('letzte-runde'), Buffer.from(info), 32));
  const PEPPER = hk('password-pepper'), ENC_KEY = hk('file-encryption');
  console.log('Konten: Geheimnis aus ' + masterSrc + ' (Fingerabdruck ' + crypto.createHash('sha256').update(PEPPER).digest('hex').slice(0, 8) + ')');

  function seal(obj, id) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
    c.setAAD(Buffer.from(id));   // Datei gehört zu genau diesem Konto (kein Vertauschen)
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
  function unseal(txt, id) {
    const e = JSON.parse(txt);
    if (!e || e.v !== 1) throw new Error('unbekanntes Format');
    const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(e.iv, 'base64'));
    d.setAAD(Buffer.from(id)); d.setAuthTag(Buffer.from(e.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8'));
  }
  function writeAtomic(f, obj, id) { fs.writeFileSync(f + '.tmp', seal(obj, id), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); }
  function readSealed(f, id) { return unseal(fs.readFileSync(f, 'utf8'), id); }
  function saveAuth(a) { try { writeAtomic(authFile(a.id), a, a.id); } catch (e) { console.error('Konto speichern', a.id, e.message); } }

  /* Beim Start alle Anmeldedaten lesen */
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!/^a[0-9a-f]{16}\.json$/.test(f)) continue;
      try {
        const a = readSealed(path.join(DIR, f), f.slice(0, -5));
        if (!a || !a.id || !a.name || !a.pw) continue;
        accts.set(a.id, a); byName.set(nameKey(a.name), a.id);
        for (const s of a.sessions || []) bySess.set(s.h, a.id);
      } catch (e) { console.error('Konto lesen', f, e.message + ' (falsches Server-Geheimnis?)'); }
    }
    if (accts.size) console.log('Konten: ' + accts.size);
  } catch (e) { /* noch keine */ }

  function code(n) { const b = crypto.randomBytes(n); let s = ''; for (let i = 0; i < n; i++) s += B32[b[i] & 31]; return s; }
  function newRecovery() { const c = code(16); return c.match(/.{4}/g).join('-'); }
  const recNorm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  /* Passwort-Hash: scrypt(HMAC(Pepper, Passwort)). Immer nur einer gleichzeitig (Speicher), Warteschlange begrenzt. */
  let hashQueue = Promise.resolve(), hashWaiting = 0;
  function hashPw(pw, salt, prm) {
    if (hashWaiting > 50) return Promise.reject(Object.assign(new Error('Server ausgelastet – bitte gleich nochmal'), { busy: true }));
    hashWaiting++;
    const pre = crypto.createHmac('sha256', PEPPER).update(String(pw).normalize('NFC'), 'utf8').digest();
    const opt = { N: prm.N, r: prm.r, p: prm.p, maxmem: 128 * prm.N * prm.r * prm.p * 2 };
    const job = hashQueue.then(() => new Promise((res, rej) => crypto.scrypt(pre, Buffer.from(salt, 'hex'), 32, opt, (e, k) => (e ? rej(e) : res(k.toString('hex'))))));
    hashQueue = job.catch(() => {}).then(() => { hashWaiting--; });
    return job;
  }
  async function setPw(a, pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    a.pw = { alg: 'scrypt+hmac-pepper', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt, hash: await hashPw(pw, salt, SCRYPT) };
  }
  const DUMMY = { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: '00'.repeat(16), hash: '00'.repeat(32) };
  /* Unbekannter Name rechnet trotzdem einen Hash → gleiche Antwortzeit, niemand erfährt so, ob es den Namen gibt */
  async function pwOk(a, pw) {
    const p = (a && a.pw) || DUMMY;
    if (typeof pw !== 'string' || pw.length > 200) pw = '';
    const h = await hashPw(pw, p.salt, p);
    return !!a && crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(p.hash, 'hex'));
  }
  function pwProblem(pw, name) {
    if (typeof pw !== 'string' || [...pw].length < 8) return 'Passwort: mindestens 8 Zeichen';
    if (pw.length > 200) return 'Passwort: höchstens 200 Zeichen';
    const low = pw.toLowerCase();
    if (new Set(low).size < 4 || COMMON_PW.has(low) || (name && low.indexOf(nameKey(name)) >= 0)) return 'Passwort zu leicht zu erraten (kein Name, keine Allerweltspasswörter)';
    return '';
  }
  function dropSessions(a) { for (const s of a.sessions || []) bySess.delete(s.h); a.sessions = []; }
  function newSession(a) {
    const t = crypto.randomBytes(32).toString('hex'), now = Date.now();
    a.sessions = (a.sessions || []).filter((s) => now - s.seen < SESSION_TTL);
    while (a.sessions.length >= MAX_SESSIONS) bySess.delete(a.sessions.shift().h);
    a.sessions.push({ h: sha(t), ts: now, seen: now });
    bySess.set(sha(t), a.id);
    return t;
  }
  function pub(a) { return { id: a.id, name: a.name, created: a.created, reset: !!a.reset }; }

  /* Sitzung nur als HttpOnly-Cookie: Skripte auf der Seite kommen nicht heran, SameSite=Strict gegen fremde Seiten */
  function tokenOf(req) {
    const m = /(?:^|;\s*)kr_acct=([0-9a-f]{64})(?:;|$)/.exec(String(req.headers.cookie || ''));
    return m ? m[1] : '';
  }
  function setCookie(req, res, t) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) && !/https/.test(String(req.headers['x-forwarded-proto'] || ''));
    res.setHeader('Set-Cookie', COOKIE + '=' + (t || '') + '; Path=/; HttpOnly; SameSite=Strict' + (local ? '' : '; Secure') +
      '; Max-Age=' + (t ? Math.floor(SESSION_TTL / 1000) : 0));
  }
  /* Angemeldetes Konto aus dem Cookie */
  function current(req) {
    const t = tokenOf(req);
    if (t.length !== 64) return null;
    const h = sha(t), id = bySess.get(h), a = id && accts.get(id);
    if (!a) return null;
    const s = (a.sessions || []).find((x) => x.h === h);
    if (!s) return null;
    const now = Date.now();
    if (now - s.seen > SESSION_TTL) { a.sessions = a.sessions.filter((x) => x !== s); bySess.delete(h); saveAuth(a); return null; }
    if (now - s.seen > 3600 * 1000) { s.seen = now; a.seen = now; saveAuth(a); }   // „zuletzt gesehen“ höchstens stündlich schreiben
    return a;
  }

  /* Statistik je Konto */
  function emptyStats() { return { sp: [], mp: [], usage: { sp: usageNew(), mp: usageNew() } }; }
  function usageNew() { return { d: {}, h: new Array(24).fill(0) }; }
  function stats(id) {
    if (statCache.has(id)) { const s = statCache.get(id); statCache.delete(id); statCache.set(id, s); return s; }
    let s = null;
    try { s = readSealed(statFile(id), id); } catch (e) { if (e.code !== 'ENOENT') console.error('Kontostatistik lesen', id, e.message); }
    if (!s || typeof s !== 'object') s = emptyStats();
    for (const k of ['sp', 'mp']) { if (!Array.isArray(s[k])) s[k] = []; }
    s.usage = s.usage || {}; for (const k of ['sp', 'mp']) if (!s.usage[k] || !Array.isArray(s.usage[k].h)) s.usage[k] = usageNew();
    statCache.set(id, s);
    while (statCache.size > 50) statCache.delete(statCache.keys().next().value);
    return s;
  }
  function saveStats(id) { const s = statCache.get(id); if (s) try { writeAtomic(statFile(id), s, id); } catch (e) { console.error('Kontostatistik', id, e.message); } }
  function usageAdd(u, day, hr, e) {
    if (!DAY_RE.test(day) || !(hr >= 0 && hr < 24)) return;
    const d = u.d[day] || (u.d[day] = [0, 0, 0]);
    d[0]++; if (e.players.every((p) => p.ok)) d[1]++;
    const me = e.players.find((p) => p.id === 'me'); if (me && me.ok) d[2]++;
    u.h[hr]++;
    const ks = Object.keys(u.d).sort(); for (const k of ks.slice(0, -USAGE_DAYS)) delete u.d[k];
  }
  /* Nutzung aus dem Browser übernehmen (einmal beim Verknüpfen): je Tag/Stunde das Maximum */
  function usageMerge(u, inp) {
    if (!inp || typeof inp !== 'object' || !inp.d || typeof inp.d !== 'object') return;
    let n = 0;
    for (const k of Object.keys(inp.d)) {
      if (++n > USAGE_DAYS || !DAY_RE.test(k) || !Array.isArray(inp.d[k])) continue;
      const v = inp.d[k].slice(0, 3).map((x) => Math.max(0, Math.min(100000, parseInt(x, 10) || 0)));
      const d = u.d[k] || (u.d[k] = [0, 0, 0]);
      for (let i = 0; i < 3; i++) d[i] = Math.max(d[i], v[i] || 0);
    }
    if (Array.isArray(inp.h)) for (let i = 0; i < 24; i++) u.h[i] = Math.max(u.h[i], Math.max(0, Math.min(1e7, parseInt(inp.h[i], 10) || 0)));
    const ks = Object.keys(u.d).sort(); for (const k of ks.slice(0, -USAGE_DAYS)) delete u.d[k];
  }
  const rounds = (x) => (Array.isArray(x && x.rounds) ? [0, 1, 2, 3].map((i) => (x.rounds[i] === true ? true : x.rounds[i] === false ? false : null)) : null);
  /* Übungsraum-Hand vom Client prüfen. Eigener Spieler heißt „me“, Bots „bot:<Name>“. */
  function cleanSp(e) {
    if (!e || typeof e !== 'object') return null;
    const hand = Number(e.hand), ts = Number(e.ts);
    if (!Number.isInteger(hand) || hand < 0 || hand > 1e7) return null;
    if (!Number.isFinite(ts) || ts < 1.6e12 || ts > Date.now() + 86400000) return null;
    const pl = (Array.isArray(e.players) ? e.players : []).slice(0, 8).map((p) => {
      const id = String((p && p.id) || '');
      if (id !== 'me' && !/^bot:[^<>\u0000-\u001f]{1,24}$/.test(id)) return null;
      const x = { id: id, name: cleanName(p.name).slice(0, 18), ok: !!p.ok }, r = rounds(p);
      if (r) x.rounds = r;
      return x;
    });
    if (!pl.length || pl.some((p) => !p) || !pl.some((p) => p.id === 'me')) return null;
    let guess = null;
    const g = e.guess;
    if (g && typeof g === 'object' && pl.some((p) => p.id === String(g.target))) {
      const of = Number(g.of), hits = Number(g.hits);
      if (Number.isInteger(of) && of >= 1 && of <= 5 && Number.isInteger(hits) && hits >= 0 && hits <= of) guess = { target: String(g.target), hits: hits, of: of };
    }
    return { hand: hand, ts: Math.round(ts), win: !!e.win && pl.every((p) => p.ok), players: pl, guess: guess };
  }

  /* Bremsen: Registrierungen je IP/insgesamt, Fehlversuche je Name und je IP */
  let regAll = []; const regIp = new Map(), failName = new Map(), failIp = new Map();
  function windowed(m, k, win) { const now = Date.now(); const l = (m.get(k) || []).filter((t) => now - t < win); if (l.length) m.set(k, l); else m.delete(k); return l; }
  function failCount(nk, ip) { return Math.max(windowed(failName, nk, FAIL_WINDOW).length >= FAIL_MAX_NAME ? 1 : 0, ip && windowed(failIp, ip, FAIL_WINDOW).length >= FAIL_MAX_IP ? 1 : 0); }
  async function fail(nk, ip) {
    if (failName.size < 50000) failName.set(nk, windowed(failName, nk, FAIL_WINDOW).concat([Date.now()]));
    if (ip && failIp.size < 50000) failIp.set(ip, windowed(failIp, ip, FAIL_WINDOW).concat([Date.now()]));
    await new Promise((r) => setTimeout(r, 400));
  }
  setInterval(() => { const now = Date.now();
    for (const m of [failName, failIp]) for (const [k, l] of m) if (!l.length || now - l[l.length - 1] > FAIL_WINDOW) m.delete(k);
    for (const [k, l] of regIp) if (!l.length || now - l[l.length - 1] > REG_WINDOW) regIp.delete(k);
  }, 10 * 60 * 1000).unref();

  function nameProblem(n) {
    const c = cleanName(n);
    if (typeof n !== 'string' || !n.trim()) return 'Name fehlt';
    if (c.length < 2 || c.length > 18) return 'Name: 2 bis 18 Zeichen';
    if (/^bot:/i.test(c) || nameKey(c) === 'me') return 'Dieser Name ist nicht erlaubt';
    return '';
  }

  async function body(req, res) { try { return await readBody(req); } catch (e) { json(res, 400, { error: 'Body' }); return null; } }

  /* Öffentliche Aktionen (acct.*). Gibt false zurück, wenn die Aktion nicht hierher gehört. */
  /* Schutz vor Anfragen fremder Seiten (CSRF): POST nur als JSON und – falls der Browser es mitschickt – vom eigenen Host */
  function sameOrigin(req) {
    if (req.method !== 'POST') return true;
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return false;
    const org = req.headers.origin;
    if (!org) return true;
    try { return new URL(org).host === String(req.headers['x-forwarded-host'] || req.headers.host || ''); } catch (e) { return false; }
  }
  async function handle(a, req, res, u) {
    if (a.indexOf('acct.') !== 0) return false;
    if (!sameOrigin(req)) return json(res, 403, { error: 'Anfrage von fremder Seite abgelehnt' }), true;
    try { return await handle2(a, req, res, u); }
    catch (e) { if (e && e.busy) return json(res, 503, { error: e.message }), true; throw e; }
  }
  async function handle2(a, req, res, u) {
    const ip = clientIp(req);
    if (a === 'acct.register') {
      const b = await body(req, res); if (!b) return true;
      const np = nameProblem(b.name); if (np) return json(res, 400, { error: np }), true;
      const pp = pwProblem(b.pw, b.name); if (pp) return json(res, 400, { error: pp }), true;
      const name = cleanName(b.name).slice(0, 18), nk = nameKey(name);
      if (byName.has(nk)) return json(res, 409, { error: 'Den Namen gibt es schon – bitte einen anderen wählen' }), true;
      if (accts.size >= MAX_ACCOUNTS) return json(res, 503, { error: 'Keine neuen Konten möglich' }), true;
      const now = Date.now();
      regAll = regAll.filter((t) => now - t < REG_WINDOW);
      const rl = ip ? windowed(regIp, ip, REG_WINDOW) : [];
      if (regAll.length >= REG_ALL || rl.length >= REG_IP) return json(res, 429, { error: 'Zu viele neue Konten – bitte später' }), true;
      regAll.push(now); if (ip && regIp.size < 20000) regIp.set(ip, rl.concat([now]));
      const acc = { id: 'a' + crypto.randomBytes(8).toString('hex'), name: name, created: now, seen: now, sessions: [] };
      await setPw(acc, b.pw);
      if (byName.has(nk)) return json(res, 409, { error: 'Den Namen gibt es schon – bitte einen anderen wählen' }), true;   // während scrypt vergeben
      const rec = newRecovery(); acc.rec = sha(recNorm(rec));
      const t = newSession(acc);
      accts.set(acc.id, acc); byName.set(nk, acc.id); saveAuth(acc);
      console.log('Konto angelegt: ' + acc.id);
      setCookie(req, res, t);
      return json(res, 200, { ok: true, recovery: rec, account: pub(acc) }), true;
    }
    if (a === 'acct.login' || a === 'acct.recover') {
      const b = await body(req, res); if (!b) return true;
      const nk = nameKey(cleanName(b.name));
      if (failCount(nk, ip)) return json(res, 429, { error: 'Zu viele Fehlversuche – bitte 15 Minuten warten' }), true;
      const acc = accts.get(byName.get(nk));
      if (a === 'acct.login') {
        const good = await pwOk(acc, b.pw);
        if (!good) { await fail(nk, ip); return json(res, 401, { error: 'Name oder Passwort falsch' }), true; }
        const t = newSession(acc); acc.seen = Date.now(); saveAuth(acc);
        setCookie(req, res, t);
        return json(res, 200, { ok: true, account: pub(acc) }), true;
      }
      const pp = pwProblem(b.pw, acc ? acc.name : cleanName(b.name)); if (pp) return json(res, 400, { error: pp }), true;
      const given = sha(recNorm(b.recovery));
      if (!acc || !acc.rec || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(acc.rec))) {
        await fail(nk, ip); return json(res, 401, { error: 'Name oder Wiederherstellungscode falsch' }), true;
      }
      await setPw(acc, b.pw); delete acc.reset;
      dropSessions(acc);
      const rec = newRecovery(); acc.rec = sha(recNorm(rec));   // Code gilt nur einmal → neuer Code
      const t = newSession(acc); saveAuth(acc);
      console.log('Konto wiederhergestellt: ' + acc.id);
      setCookie(req, res, t);
      return json(res, 200, { ok: true, recovery: rec, account: pub(acc) }), true;
    }
    if (a === 'acct.mphand') return mpHand(req, res, u), true;
    const acc = current(req);
    if (!acc) return json(res, 401, { error: 'Nicht angemeldet' }), true;
    if (a === 'acct.me') {
      const s = stats(acc.id);
      return json(res, 200, { ok: true, account: pub(acc), stats: { sp: s.sp, mp: s.mp, usage: s.usage } }), true;
    }
    if (a === 'acct.logout') {
      const h = sha(tokenOf(req));
      acc.sessions = (acc.sessions || []).filter((s) => s.h !== h); bySess.delete(h); saveAuth(acc);
      setCookie(req, res, '');
      return json(res, 200, { ok: true }), true;
    }
    if (a === 'acct.sphands') {
      const b = await body(req, res); if (!b) return true;
      const s = stats(acc.id), have = new Set(s.sp.map((e) => e.ts + '.' + e.hand));
      let added = 0;
      for (const raw of (Array.isArray(b.hands) ? b.hands : []).slice(0, SP_KEEP)) {
        const e = cleanSp(raw); if (!e || have.has(e.ts + '.' + e.hand)) continue;
        have.add(e.ts + '.' + e.hand); s.sp.push(e); added++;
        if (!b.usage) usageAdd(s.usage.sp, String(raw.day || ''), Number(raw.hr), e);
      }
      if (b.usage) usageMerge(s.usage.sp, b.usage);   // erstes Verknüpfen: Nutzung des Browsers übernehmen statt zählen
      s.sp.sort((x, y) => x.ts - y.ts); s.sp = s.sp.slice(-SP_KEEP);
      if (added || b.usage) saveStats(acc.id);
      return json(res, 200, { ok: true, added: added }), true;
    }
    const b = await body(req, res); if (!b) return true;
    if (a === 'acct.password') {
      if (!(await pwOk(acc, b.old))) { await fail(nameKey(acc.name), ip); return json(res, 401, { error: 'Altes Passwort falsch' }), true; }
      const pp = pwProblem(b.pw, acc.name); if (pp) return json(res, 400, { error: pp }), true;
      await setPw(acc, b.pw); delete acc.reset;
      const h = sha(tokenOf(req));   // andere Geräte abmelden, dieses bleibt
      for (const s of acc.sessions) if (s.h !== h) bySess.delete(s.h);
      acc.sessions = acc.sessions.filter((s) => s.h === h); saveAuth(acc);
      return json(res, 200, { ok: true, account: pub(acc) }), true;
    }
    const pwGood = await pwOk(acc, b.pw);
    if (!pwGood) { await fail(nameKey(acc.name), ip); return json(res, 401, { error: 'Passwort falsch' }), true; }
    if (a === 'acct.newrecovery') {
      const rec = newRecovery(); acc.rec = sha(recNorm(rec)); saveAuth(acc);
      return json(res, 200, { ok: true, recovery: rec }), true;
    }
    if (a === 'acct.delete') {
      remove(acc.id); setCookie(req, res, ''); console.log('Konto vom Besitzer gelöscht: ' + acc.id);
      return json(res, 200, { ok: true }), true;
    }
    return json(res, 400, { error: 'Unbekannte Aktion' }), true;
  }

  /* Raum-Hand: der Server übernimmt den Eintrag aus der Raumstatistik selbst (nichts vom Client),
     eigener Platz = Spieler mit dem Geräteschlüssel dieses Aufrufs → „me“. */
  async function mpHand(req, res, u) {
    const acc = current(req);
    if (!acc) return json(res, 401, { error: 'Nicht angemeldet' });
    const b = await body(req, res); if (!b) return;
    const roomCode = String(b.room || '').toUpperCase(), hand = Number(b.hand);
    const r = /^[A-Z0-9]{1,8}$/.test(roomCode) && o.load(roomCode);
    if (!r) return json(res, 404, { error: 'Raum nicht gefunden' });
    const me = o.memberId(r, o.keyHash(req));
    if (!me) return json(res, 403, { error: 'Nur Spieler dieses Raums' });
    const e = ((r.docs.stats && r.docs.stats.hands) || []).find((x) => x.hand === hand);
    if (!e) return json(res, 409, { error: 'Hand noch nicht in der Statistik' });
    if (!e.players.some((p) => p.id === me)) return json(res, 403, { error: 'Nicht mitgespielt' });
    const key = roomCode + '.' + ((r.docs.room && r.docs.room.createdAt) || 0) + '.' + hand;
    const s = stats(acc.id);
    if (s.mp.some((x) => x.key === key)) return json(res, 200, { ok: true, dup: true });
    const entry = JSON.parse(JSON.stringify(e));
    entry.key = key; entry.room = roomCode; entry.roomName = String((r.docs.room && r.docs.room.name) || '').slice(0, 30);
    for (const p of entry.players) if (p.id === me) p.id = 'me';
    if (entry.guess && entry.guess.target === me) entry.guess.target = 'me';
    s.mp.push(entry); s.mp = s.mp.slice(-MP_KEEP);
    usageAdd(s.usage.mp, String(b.day || ''), Number(b.hr), entry);
    saveStats(acc.id);
    return json(res, 200, { ok: true });
  }

  function remove(id) {
    const a = accts.get(id); if (!a) return false;
    dropSessions(a); byName.delete(nameKey(a.name)); accts.delete(id); statCache.delete(id);
    for (const f of [authFile(id), statFile(id)]) try { fs.unlinkSync(f); } catch (e) { /* egal */ }
    return true;
  }

  /* Admin: Liste, Passwort zurücksetzen (Einmal-Passwort anzeigen), löschen */
  async function admin(a, req, res) {
    if (a === 'accounts') {
      const list = [...accts.values()].map((x) => {
        let hands = null;
        try { const s = statCache.get(x.id) || readSealed(statFile(x.id), x.id); hands = { sp: s.sp.length, mp: s.mp.length }; } catch (e) { hands = { sp: 0, mp: 0 }; }
        return { id: x.id, name: x.name, created: x.created, seen: x.seen || x.created, sessions: (x.sessions || []).length, reset: !!x.reset, hands: hands };
      }).sort((p, q) => q.seen - p.seen);
      return json(res, 200, { ok: true, accounts: list }), true;
    }
    if (a !== 'acctreset' && a !== 'acctdel') return false;
    const b = await body(req, res); if (!b) return true;
    const acc = accts.get(String(b.id || ''));
    if (!acc) return json(res, 404, { error: 'Konto nicht gefunden' }), true;
    if (a === 'acctdel') { remove(acc.id); console.log('Admin: Konto gelöscht ' + acc.id); return json(res, 200, { ok: true }), true; }
    const tmp = code(10);
    await setPw(acc, tmp); acc.reset = true; dropSessions(acc); saveAuth(acc);
    failName.delete(nameKey(acc.name));   // Sperre nach Fehlversuchen aufheben
    console.log('Admin: Passwort zurückgesetzt ' + acc.id);
    return json(res, 200, { ok: true, password: tmp }), true;
  }

  return { handle, admin, count: () => accts.size };
};
