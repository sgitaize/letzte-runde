/**
 * Bots im Mehrspieler-Raum („Raum auffüllen“). Laufen auf dem Server und benutzen dieselben Dokumente
 * wie ein Browser: geben (wenn sie eine Rolle haben), eigene Karten entschlüsseln, Chips nehmen (unsicher →
 * „offen für Wechsel“, open/<bot>), klopfen, Tipp abgeben/bestätigen, aufdecken. Den Ablauf treiben weiter die Menschen.
 *
 * Datenschutz: Rollen beim Geben gehen zuerst an Menschen (roleOrder). Ab 2 Menschen hält der Server
 * höchstens eine der drei Rollen und kann damit keine Menschen-Karte lesen. Ein Bot kennt nur seine Karten.
 * Private Bot-Schlüssel liegen in r.bots (Raumdatei), nie in r.docs (wird nicht an Clients geschickt).
 */
'use strict';
const H = require('./public/hand.js');
const subtle = globalThis.crypto.subtle;

/* ------------------------------------------------ Krypto (wie im Browser) -- */
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const b64 = (u8) => Buffer.from(u8).toString('base64');
const ub64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64'));
const hx = (u8) => Buffer.from(u8).toString('hex');
const uhx = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const seq = (n) => Array.from({ length: n }, (_, i) => i);
const impPub = (j) => subtle.importKey('jwk', j, EC, true, []);
const impPriv = (j) => subtle.importKey('jwk', j, EC, true, ['deriveBits']);
async function shared(priv, pub) {
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
const aesRaw = (u8) => subtle.importKey('raw', u8, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
async function encJson(key, obj) {
  const iv = rnd(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return b64(iv) + '.' + b64(new Uint8Array(ct));
}
async function decJson(key, s) {
  const p = String(s).split('.');
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: ub64(p[0]) }, key, ub64(p[1]));
  return JSON.parse(new TextDecoder().decode(pt));
}
async function sealTo(pubJwk, obj) {
  const eph = await subtle.generateKey(EC, true, ['deriveBits']);
  const key = await shared(eph.privateKey, await impPub(pubJwk));
  return { e: await subtle.exportKey('jwk', eph.publicKey), c: await encJson(key, obj) };
}
async function openSealed(priv, sealed) { return decJson(await shared(priv, await impPub(sealed.e)), sealed.c); }
function xorHex(a, b) { const x = uhx(a), y = uhx(b), o = new Uint8Array(x.length); for (let i = 0; i < x.length; i++) o[i] = x[i] ^ y[i]; return o; }
async function encCard(k1, k2, card) {
  const key = await aesRaw(xorHex(k1, k2)), iv = rnd(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array([card]));
  return b64(iv) + '.' + b64(new Uint8Array(ct));
}
async function decCard(k1, k2, s) {
  const key = await aesRaw(xorHex(k1, k2)), p = String(s).split('.');
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: ub64(p[0]) }, key, ub64(p[1])))[0];
}

/* ------------------------------------------------ Hilfen ------------------ */
const NAMES = ['Lena', 'Max', 'Ole', 'Mia', 'Jonas', 'Emma', 'Paul', 'Nina', 'Tom', 'Lea', 'Finn', 'Ida'];
const TEMPO = 1.35 * (Number(process.env.KR_BOT_SPEED) || 1);   // wie im Übungsraum (SP_TEMPO); Tests: KR_BOT_SPEED=0.15
const MAX_BOTS_ROOM = 5;
const MAX_BOTS_TOTAL = 60;
const gauss = () => { const u = Math.random() || 1e-9, v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const RETRY = () => Object.assign(new Error('retry'), { retry: true });
const slotsFor = (st) => (st >= 4 ? [0, 1, 2, 3, 4] : st === 3 ? [0, 1, 2, 3] : st === 2 ? [0, 1, 2] : []);

module.exports = function createBots(ctx) {
  const { rooms, commit, chipMove } = ctx;
  const log = (...a) => console.log(...a);
  const rt = new Map();                    // code -> Laufzeit je Hand (nicht gespeichert, nach Neustart neu aufgebaut)
  const privCache = new Map();             // bot-id -> CryptoKey

  const isBot = (r, id) => !!(r.bots && r.bots[id] && r.docs['players/' + id]);
  const mainOf = (r) => r.docs['state/main'] || {};
  const partsOf = (m) => (Array.isArray(m.participants) ? m.participants.map(String) : []);
  const pubOf = (r, id) => (r.docs['players/' + id] || {}).pub || null;
  /* Rollen: Menschen zuerst (reihum), dann Bots – identisch zu roleOrder() im Browser */
  function roleOrder(r, m) {
    const ps = partsOf(m), h = Number(m.hand) || 0;
    const rot = (a) => (a.length ? a.slice(h % a.length).concat(a.slice(0, h % a.length)) : a);
    return rot(ps.filter((id) => !(r.docs['players/' + id] || {}).bot)).concat(rot(ps.filter((id) => (r.docs['players/' + id] || {}).bot)));
  }
  function set(code, r, p, doc) { r.docs[p] = doc; commit(code, [p]); }
  function setMain(code, r, patch) { set(code, r, 'state/main', Object.assign({}, mainOf(r), patch)); }
  async function privOf(r, id) {
    if (!privCache.has(id)) privCache.set(id, await impPriv(r.bots[id].priv));
    return privCache.get(id);
  }
  /* Asynchroner Schritt, höchstens einmal gleichzeitig; RETRY = später nochmal */
  function job(R, key, fn) {
    if (R.busy[key]) return;
    R.busy[key] = true;
    setImmediate(() => Promise.resolve().then(fn).catch((e) => {
      if (e && e.retry) { R.busy[key] = false; return; }         // später nochmal
      console.error('Bot', key, (e && e.message) || e);           // echter Fehler: einmal melden, nicht in Schleife wiederholen
    }));
  }
  const still = (code, r, h, ph) => rooms.get(code) === r && Number(mainOf(r).hand) === h && (!ph || mainOf(r).phase === ph);

  /* ------------------------------------------------ Hinzufügen / Entfernen -- */
  function total() { let n = 0; for (const r of rooms.values()) n += r.bots ? Object.keys(r.bots).length : 0; return n; }
  async function add(code, r) {
    const have = Object.keys(r.bots || {});
    if (have.length >= MAX_BOTS_ROOM) throw Object.assign(new Error('Höchstens ' + MAX_BOTS_ROOM + ' Bots je Raum'), { status: 409 });
    if (total() >= MAX_BOTS_TOTAL) throw Object.assign(new Error('Gerade zu viele Bots auf dem Server – bitte später'), { status: 503 });
    const kp = await subtle.generateKey(EC, true, ['deriveBits']);
    const pub = await subtle.exportKey('jwk', kp.publicKey), priv = await subtle.exportKey('jwk', kp.privateKey);
    const used = new Set(Object.keys(r.docs).filter((k) => k.indexOf('players/') === 0).map((k) => (r.docs[k] || {}).name));
    const free = NAMES.filter((n) => !used.has(n));
    const name = free.length ? free[Math.floor(Math.random() * free.length)] : 'Bot ' + (have.length + 1);
    const id = 'bot' + hx(rnd(5));
    r.bots = r.bots || {};
    r.bots[id] = { name, priv, noise: 0.05 + Math.random() * 0.2, stub: Math.floor(Math.random() * 3), pace: 900 + Math.random() * 1400, gut: Math.random() < 0.65 };
    r.docs['players/' + id] = { name, pub, joinedAt: Date.now(), ready: null, bot: true };
    commit(code, ['players/' + id]);
    log('Raum ' + code + ': Bot ' + name + ' hinzugefügt');
    return id;
  }
  function remove(r, id) { if (r.bots) delete r.bots[id]; privCache.delete(id); }
  /* Offline-Spieler durch Bot ersetzen: gleiche ID, Name und Sitzplatz, neuer Schlüssel (alte Karten sind für ihn nicht lesbar) */
  async function convert(code, r, id) {
    const p = r.docs['players/' + id];
    if (!p) throw Object.assign(new Error('Spieler unbekannt'), { status: 400 });
    if (Object.keys(r.bots || {}).length >= MAX_BOTS_ROOM) throw Object.assign(new Error('Höchstens ' + MAX_BOTS_ROOM + ' Bots je Raum'), { status: 409 });
    if (total() >= MAX_BOTS_TOTAL) throw Object.assign(new Error('Gerade zu viele Bots auf dem Server – bitte später'), { status: 503 });
    const kp = await subtle.generateKey(EC, true, ['deriveBits']);
    const pub = await subtle.exportKey('jwk', kp.publicKey), priv = await subtle.exportKey('jwk', kp.privateKey);
    r.bots = r.bots || {};
    const m = r.docs['state/main'] || {};
    r.bots[id] = { name: p.name, priv, noise: 0.05 + Math.random() * 0.2, stub: Math.floor(Math.random() * 3), pace: 900 + Math.random() * 1400, gut: Math.random() < 0.65,
      fromHand: (Number(m.hand) || 0) + 1 };      // Karten älterer Hände sind mit dem alten Schlüssel verschlüsselt – nicht anfassen
    privCache.delete(id);
    r.docs['players/' + id] = { name: p.name, pub, joinedAt: p.joinedAt || Date.now(), ready: null, bot: true, replaced: true };
    commit(code, ['players/' + id]);
    log('Raum ' + code + ': Spieler durch Bot ersetzt');
  }

  /* ------------------------------------------------ Geben (Rollen) ---------- */
  async function doShuffle(code, r, h, Aid, Bid) {
    const pA = pubOf(r, Aid), pB = pubOf(r, Bid);
    if (!pA || !pB) throw RETRY();
    const deck = shuffle(seq(52)), k1 = [], k2 = [];
    for (let j = 0; j < 52; j++) { k1.push(hx(rnd(32))); k2.push(hx(rnd(32))); }
    const cts = await Promise.all(deck.map((c, j) => encCard(k1[j], k2[j], c)));
    const [forA, forB] = await Promise.all([sealTo(pA, { k: k1 }), sealTo(pB, { k: k2 })]);
    if (!still(code, r, h, 'deal') || (r.docs['deal/deck'] || {}).hand === h) return;
    set(code, r, 'deal/deck', { hand: h, cts, forA, forB });
  }
  async function doAssignA(code, r, h, me, Bid) {
    const m = mainOf(r), ps = partsOf(m), K = Math.min(5, Math.max(1, Number((m.opt || {}).holeCards) || 2));
    if (ps.some((id) => !pubOf(r, id)) || !pubOf(r, Bid)) throw RETRY();
    const { k: k1 } = await openSealed(await privOf(r, me), r.docs['deal/deck'].forA);
    const slots = shuffle(seq(52)), assign = {}, board = [];
    let p = 0;
    ps.forEach((id) => { assign[id] = []; for (let z = 0; z < K; z++) assign[id].push(slots[p++]); });
    for (let i = 0; i < 5; i++) board.push(slots[p++]);
    const fp = {};
    await Promise.all(ps.map(async (id) => { fp[id] = await sealTo(pubOf(r, id), { slots: assign[id], k1: assign[id].map((sl) => k1[sl]) }); }));
    const forB = await sealTo(pubOf(r, Bid), { assign, board }), forSelf = await sealTo(pubOf(r, me), { assign, board });
    if (!still(code, r, h, 'deal') || (r.docs['deal/assignA'] || {}).hand === h) return;
    set(code, r, 'deal/assignA', { hand: h, forPlayers: fp, forB, forSelf });
  }
  async function doAssignB(code, r, h, me) {
    const ps = partsOf(mainOf(r));
    if (ps.some((id) => !pubOf(r, id))) throw RETRY();
    const priv = await privOf(r, me);
    const [{ k: k2 }, { assign }] = await Promise.all([openSealed(priv, r.docs['deal/deck'].forB), openSealed(priv, r.docs['deal/assignA'].forB)]);
    const fp = {};
    await Promise.all(ps.filter((id) => assign[id]).map(async (id) => { fp[id] = await sealTo(pubOf(r, id), { k2: assign[id].map((sl) => k2[sl]) }); }));
    if (!still(code, r, h, 'deal') || (r.docs['deal/assignB'] || {}).hand === h) return;
    set(code, r, 'deal/assignB', { hand: h, forPlayers: fp });
  }
  async function ensureBoard(code, r, h, st, me, isA) {
    const need = slotsFor(st);
    if (!need.length) return;
    const own = r.docs[isA ? 'deal/boardA' : 'deal/boardB'];
    const cur = own && own.hand === h ? own.keys || {} : {};
    const miss = need.filter((i) => !cur[String(i)]);
    if (!miss.length) return;
    const priv = await privOf(r, me);
    const keys = Object.assign({}, cur);
    if (isA) {
      const [{ k: k1 }, { board }] = await Promise.all([openSealed(priv, r.docs['deal/deck'].forA), openSealed(priv, r.docs['deal/assignA'].forSelf)]);
      miss.forEach((i) => { keys[String(i)] = { s: board[i], k: k1[board[i]] }; });
    } else {
      const bA = r.docs['deal/boardA'];
      if (!bA || bA.hand !== h || miss.some((i) => !(bA.keys || {})[String(i)])) throw RETRY();
      const [{ k: k2 }, { board }] = await Promise.all([openSealed(priv, r.docs['deal/deck'].forB), openSealed(priv, r.docs['deal/assignA'].forB)]);
      miss.forEach((i) => { keys[String(i)] = { k: k2[board[i]] }; });
    }
    if (!still(code, r, h, 'play')) return;
    set(code, r, isA ? 'deal/boardA' : 'deal/boardB', { hand: h, keys });
  }
  async function decryptHole(code, r, h, id, R) {
    const priv = await privOf(r, id);
    const [a, b] = await Promise.all([openSealed(priv, r.docs['deal/assignA'].forPlayers[id]), openSealed(priv, r.docs['deal/assignB'].forPlayers[id])]);
    const cts = r.docs['deal/deck'].cts;
    const cards = await Promise.all(a.slots.map((sl, i) => decCard(a.k1[i], b.k2[i], cts[sl])));
    if (R.hand === h) R.bots[id].hole = { cards, slots: a.slots, k1: a.k1, k2: b.k2 };
  }
  async function decryptBoard(r, h, R) {
    const bA = r.docs['deal/boardA'], bB = r.docs['deal/boardB'], deck = r.docs['deal/deck'];
    for (let i = 0; i < 5; i++) {
      const a = (bA.keys || {})[String(i)], b = (bB.keys || {})[String(i)];
      if (R.board[i] == null && a && b) { const c = await decCard(a.k, b.k, deck.cts[a.s]); if (R.hand === h) R.board[i] = c; }
    }
  }

  /* ------------------------------------------------ Chips (wie Übungsraum) -- */
  function chipOf(r, h, id) {
    for (const k of Object.keys(r.docs)) { const c = r.docs[k]; if (k.indexOf('chips/') === 0 && c && c.hand === h && c.holder === id) return Number(k.slice(6)); }
    return null;
  }
  function holderOf(r, h, n) { const c = r.docs['chips/' + n]; return c && c.hand === h ? c.holder || null : null; }
  function readyOf(r, h, st, id) { const p = r.docs['players/' + id]; return !!(p && p.ready && p.ready.hand === h && p.ready.stage === st && chipOf(r, h, id)); }
  function setReady(code, r, h, st, id) {
    const p = r.docs['players/' + id]; if (!p) return;
    set(code, r, 'players/' + id, Object.assign({}, p, { ready: { hand: h, stage: st } }));
  }

  function initStage(r, m, R, h, st, bots) {
    const n = partsOf(m).length, mid = (n + 1) / 2, prev = ((m.chipHist || {})[String(st - 1)]) || {};
    R.stageKey = h + '.' + st; R.contest = {}; R.moves = {}; R.insist = {}; R.lostBy = {}; R.humanFixed = {};
    R.prev = prev;
    const now = Date.now(), K = bots.length ? R.bots[bots[0]].hole.cards.length : 2;
    const vis = slotsFor(st).map((i) => R.board[i]);
    bots.forEach((id) => {
      const b = R.bots[id], pr = r.bots[id], last = st > 1 ? b.est : null;
      /* Gleiche Logik wie im Übungsraum (index.html, spStage): vor dem Flop Tabelle, River exakt, Fehleinschätzung einmal je Hand */
      const raw = H.estimateRank(b.hole.cards, vis, n - 1, K, 300);
      b.q = (raw - 1) / (n - 1);                                   // Anteil der Hände, die ich schlage
      b.est = mid + (raw - mid) * (st === 4 ? 1.2 : 1.7);
      if (st === 1 || b.biasHand !== h) { b.bias0 = gauss() * pr.noise; b.biasHand = h; }
      b.e = b.est + b.bias0 * [0, 1, 0.6, 0.35, 0][st];
      const pc = prev[id] != null ? Number(prev[id]) : null;
      if (pc) b.e += (pc - b.e) * [0, 0, 0.1, 0.1, 0][st];         // kleine Änderungen sind kein Grund, den Platz zu wechseln
      b.first = pr.gut; b.lost = null; b.yieldTo = {}; b.anchor = null; b.lastChip = null; b.stable = now; b.open = false; b.openShown = null; b.seen = {};
      if (last != null && pc && Math.abs(b.est - last) < 0.5) { b.anchor = pc; b.first = true; }
      b.next = now + (600 + Math.random() * pr.pace * 1.6) * TEMPO;
    });
  }
  function target(r, m, R, h, id, e) {
    const ps = partsOf(m), n = ps.length, mid = (n + 1) / 2, b = R.bots[id], fixed = {}, list = [], left = [];
    ps.forEach((q) => {
      if (q === id) { list.push({ id: q, v: e }); return; }
      const held = chipOf(r, h, q), bot = isBot(r, q);
      if (held && (b.yieldTo[q] === held || (!bot && (R.humanFixed[q] === held || (b.anchor && held === Number(R.prev[q])))))) { fixed[held] = 1; return; }
      /* Bots: für alle dieselbe Einschätzung (sonst endloses Hin und Her); Menschen: ihr Chip, ohne Chip der aus der Vorrunde */
      const pv = Number(R.prev[q]) || mid;
      const v = bot && R.bots[q] ? R.bots[q].e : held ? held + (held > mid ? -0.25 : held < mid ? 0.25 : 0) : pv;
      list.push({ id: q, v });
    });
    for (let c = 1; c <= n; c++) if (!fixed[c]) left.push(c);
    list.sort((x, y) => x.v - y.v || (x.id < y.id ? -1 : 1));
    const i = list.findIndex((x) => x.id === id);
    return left[i] || nearestFree(r, h, n, e);
  }
  function nearestFree(r, h, n, e) { let best = null; for (let c = 1; c <= n; c++) if (!holderOf(r, h, c) && (best == null || Math.abs(c - e) < Math.abs(best - e))) best = c; return best; }
  function botAct(code, r, m, R, h, st, id) {
    const b = R.bots[id], pr = r.bots[id], now = Date.now(), n = partsOf(m).length;
    const cur = chipOf(r, h, id), mv = R.moves[id] || 0;
    const later = (f) => { b.next = now + f * (400 + Math.random() * pr.pace) * TEMPO; };
    const take = (t) => {
      const prevHolder = holderOf(r, h, t), res = chipMove(code, String(t), id, h, true);
      if (!res || !res.ok) return false;                         // z. B. Wegnehmen im Admin abgeschaltet
      b.lastChip = t; b.stable = Date.now();
      if (prevHolder && !isBot(r, prevHolder)) R.lostBy[prevHolder] = t;
      if (prevHolder && isBot(r, prevHolder) && R.bots[prevHolder]) R.bots[prevHolder].next = now + (500 + Math.random() * r.bots[prevHolder].pace) * TEMPO;
      return true;
    };
    if (mv >= 8) { markOpen(code, r, h, st, id, false); if (!cur) { const f = nearestFree(r, h, n, b.e); if (f) take(f); } else if (!readyOf(r, h, st, id)) setReady(code, r, h, st, id); b.next = now + 2000; return; }
    const e = b.e;
    let t;
    if (b.first) {                                               // erster Griff: Chip der Vorrunde bzw. nur nach eigener Einschätzung
      b.first = false;
      t = b.anchor && !holderOf(r, h, b.anchor) ? b.anchor : cur ? target(r, m, R, h, id, e) : nearestFree(r, h, n, Math.max(1, Math.min(n, Math.round(e))));
    } else t = target(r, m, R, h, id, e);
    if (!t) { later(1); return; }
    if (cur === t) {
      if (!readyOf(r, h, st, id) && now - b.stable > (900 + pr.pace * 0.6) * TEMPO) setReady(code, r, h, st, id);
      later(1); return;
    }
    const holder = holderOf(r, h, t), lost = b.lost; b.lost = null;
    /* Hat ein Mensch seit meinem letzten Blick einen Chip neben meinem Ziel genommen? Dann begründe ich meinen Zug damit */
    let moved = null;
    partsOf(m).forEach((q) => {
      if (isBot(r, q)) return;
      const hc = chipOf(r, h, q);
      if (hc && hc !== b.seen[q] && Math.abs(hc - t) <= 1 && !moved) moved = { id: q, c: hc };
      b.seen[q] = hc;
    });
    if (!holder) {
      if (take(t)) {
        R.moves[id] = mv + 1;
        /* Unsicher (Einschätzung liegt zwischen zwei Chips, früh in der Hand besonders) → offen für Wechsel */
        markOpen(code, r, h, st, id, Math.abs(e - t) > (st <= 2 ? 0.3 : 0.5), t);
        if (cur && moved) say(code, r, id, (r.docs['players/' + moved.id] || {}).name + ', du nimmst die ' + moved.c + '? Dann bin ich eher die ' + t);
        else if (b.open && Math.random() < 0.7) say(code, r, id, 'Ich nehm erstmal die ' + t + ' – bin offen für Wechsel');
        else if (cur && Math.random() < 0.5) say(code, r, id, cur < t ? 'Hmm, doch besser als gedacht' : 'Ach nee, doch nicht so gut');
      }
      later(1.2); return;
    }
    const key = id + ':' + t, cc = R.contest[key] || 0;
    let p;
    if (!isBot(r, holder)) {
      const sure = Math.max(0, Math.min(1, ((e > t ? b.q : 1 - b.q) - 0.5) * 2.2)), conf = [0, 0.35, 0.6, 0.8, 1][st];   // sicher über/unter dir?
      p = 0.05 + 0.08 * pr.stub + conf * 0.75 * sure + (lost === t ? 0.15 : 0) - 0.25 * cc - 0.2 * (R.insist[t] || 0);
    } else p = 0.95 - 0.15 * cc;
    p = Math.max(0, Math.min(0.9, p));
    R.contest[key] = cc + 1;
    if (Math.random() < p && take(t)) {
      R.moves[id] = mv + 1; markOpen(code, r, h, st, id, false);
      if (!isBot(r, holder)) say(code, r, id, cc || lost === t ? 'Nee, die ' + t + ' brauch ich wirklich 😤' : 'Die ' + t + ' nehm ich lieber');
      else if (Math.random() < 0.5) say(code, r, id, 'Ich glaub, die ' + t + ' ist meine');
      later(1.3); return;
    }
    b.yieldTo[holder] = t;
    if (!isBot(r, holder)) R.humanFixed[holder] = t;
    if (!isBot(r, holder) || Math.random() < 0.3) say(code, r, id, 'Okay, die ' + t + ' gehört ' + (r.docs['players/' + holder] || {}).name);
    later(0.6);
  }
  function playStep(code, r, m, R, h, st, bots) {
    if (!bots.every((id) => R.bots[id].hole) || slotsFor(st).some((i) => R.board[i] == null)) return;
    if (R.stageKey !== h + '.' + st) initStage(r, m, R, h, st, bots);
    const ps = partsOf(m), now = Date.now();
    if (ps.every((id) => readyOf(r, h, st, id))) return;          // alle bereit → 3-2-1 läuft im Browser, nicht mehr eingreifen
    for (const x of Object.keys(R.lostBy)) if (holderOf(r, h, R.lostBy[x]) === x) { R.insist[R.lostBy[x]] = (R.insist[R.lostBy[x]] || 0) + 1; delete R.lostBy[x]; }
    /* Ein Mensch hat einen Chip bewegt → die Bots sehen es und denken bald neu nach */
    const hsig = ps.filter((q) => !isBot(r, q)).map((q) => q + ':' + chipOf(r, h, q)).join();
    if (R.humanSig !== hsig) {
      if (R.humanSig != null) bots.forEach((id) => { const b = R.bots[id]; b.next = Math.min(b.next, now + (300 + Math.random() * r.bots[id].pace * 0.7) * TEMPO); });
      R.humanSig = hsig;
    }
    for (const id of bots) {
      const b = R.bots[id], cur = chipOf(r, h, id);
      if (b.lastChip && cur !== b.lastChip) {
        const n = b.lastChip, taker = holderOf(r, h, n);
        b.lastChip = cur; b.next = Math.min(b.next, now + (500 + Math.random() * r.bots[id].pace) * TEMPO);
        if (b.open && taker && taker !== id) {                   // war „offen für Wechsel“ → gibt ihn ohne Streit ab und ordnet sich neu ein
          markOpen(code, r, h, st, id, false);
          b.yieldTo[taker] = n;
          if (!isBot(r, taker)) R.humanFixed[taker] = n;
          const tn = (r.docs['players/' + taker] || {}).name;
          say(code, r, id, isBot(r, taker) ? 'Okay, ' + tn + ' nimmt die ' + n : 'Passt ' + tn + ', nimm die ' + n + ' – ich such mir was anderes');
        } else b.lost = n;
        if (Math.random() < 0.25) react(code, r, id, Math.random() < 0.5 ? 2 : 3);      // 😬 / 🤔
      }
      if (now >= b.next) botAct(code, r, m, R, h, st, id);
    }
  }

  /* ------------------------------------------------ Tipp + Aufdecken -------- */
  /* Wie im Übungsraum (spBotGuess): Ausschlussverfahren (hand.js inferHole). Die Bots kennen ihre eigenen Karten, gehen davon
     aus, dass der Spieler mit dem höchsten Chip alle schlägt, und gewichten nach seinem Chip-Verlauf. Meist die
     wahrscheinlichste Wert-Kombination, ab und zu die zweit-/drittbeste. */
  function botGuess(m, R, t, K) {
    if (R.board.some((c) => c == null)) return null;
    const own = Object.keys(R.bots).filter((id) => id !== t && R.bots[id].hole).map((id) => R.bots[id].hole.cards);
    const ch = {}, hist = m.chipHist || {};
    for (let s = 1; s <= 4; s++) { const c = Number((hist[String(s)] || {})[t]); if (c) ch[s] = c; }
    let top = [];
    try { top = H.valueOdds(H.inferHole({ board: R.board, dead: [].concat(...own), chips: ch, n: partsOf(m).length, K, beats: own })).slice(0, 3); } catch (e) { /* Fallback unten */ }
    top = top.filter((x) => x.vals.length === K);
    if (!top.length) return Array.from({ length: K }, (_, i) => 12 - i);
    let x = Math.random() * top.reduce((a, o) => a + o.w * o.w, 0);
    for (const o of top) { x -= o.w * o.w; if (x <= 0) return o.vals.slice(); }
    return top[0].vals.slice();
  }
  function guessStep(code, r, m, R, h, bots) {
    const g = r.docs['state/guess'];
    if (!g || g.hand !== h) return;
    const t = String(m.target || ''), humans = partsOf(m).filter((id) => !isBot(r, id) && id !== t), now = Date.now();
    const filled = Array.isArray(g.cards) && g.cards.length && g.cards.every((x) => x != null);
    if (!humans.length && !filled) {                            // niemand außer Bots tippt → Bots tippen selbst
      if (!R.guessAt) { R.guessAt = now + 2500 * TEMPO; return; }
      if (now < R.guessAt) return;
      const cards = botGuess(m, R, t, g.cards.length);
      if (!cards) return;                                        // Tisch/Karten noch nicht entschlüsselt → nächster Takt
      set(code, r, 'state/guess', { hand: h, cards, confirmed: {} });
      return;
    }
    if (!filled) { R.confirmSig = null; return; }
    const sig = JSON.stringify(g.cards);
    if (R.confirmSig !== sig) { R.confirmSig = sig; R.confirmAt = {}; }
    for (const id of bots) {
      if (id === t || (g.confirmed || {})[id]) continue;
      if (!R.confirmAt[id]) { R.confirmAt[id] = now + (800 + Math.random() * 1600) * TEMPO; continue; }
      if (now >= R.confirmAt[id]) {
        const cur = r.docs['state/guess'];
        set(code, r, 'state/guess', { hand: h, cards: cur.cards.slice(), confirmed: Object.assign({}, cur.confirmed || {}, { [id]: true }) });
      }
    }
  }
  function revealStep(code, r, m, R, h) {
    const ord = Array.isArray(m.revealOrder) ? m.revealOrder : [], i = Number(m.revealIdx) || 0, cur = ord[i];
    if (!cur || !isBot(r, cur) || !R.bots[cur] || !R.bots[cur].hole) return;
    const key = 'rev' + i;
    if (!R.revAt || R.revAt.key !== key) { R.revAt = { key, at: Date.now() + (1000 + Math.random() * 1200) * TEMPO }; return; }
    if (Date.now() < R.revAt.at || R.busy[key]) return;
    R.busy[key] = true;
    const hl = R.bots[cur].hole;
    set(code, r, 'reveal/' + cur, { hand: h, slots: hl.slots, k1: hl.k1, k2: hl.k2, cards: hl.cards });
    setMain(code, r, i + 1 >= ord.length ? { phase: 'done', revealIdx: i + 1 } : { revealIdx: i + 1 });
  }

  /* ------------------------------------------------ Sprechblasen + Reaktionen (wie im Übungsraum) -- */
  /* Nur der Server schreibt say/<bot> und react/<bot>; Browser zeigen sie gut 4 s neben dem Namen */
  function say(code, r, id, text) { set(code, r, 'say/' + id, { t: String(text).slice(0, 80), ts: Date.now() }); }
  /* „🔄 offen“ im Browser: open/<bot> = {hand, stage, chip}; nur schreiben, wenn sich die Anzeige ändert */
  function markOpen(code, r, h, st, id, on, chip) {
    const R = rt.get(code), b = R && R.bots[id]; if (!b) return;
    b.open = !!on;
    const sig = on ? h + '.' + st + '.' + chip : null;
    if (b.openShown === sig || (!on && !b.openShown)) return;
    b.openShown = sig;
    set(code, r, 'open/' + id, { hand: h, stage: st, chip: on ? chip : null });
  }
  function react(code, r, id, e) { set(code, r, 'react/' + id, { e: e, ts: Date.now() }); }
  /* Nach der Hand: Ergebnis selbst ausrechnen (aufgedeckte Karten + Tisch + Chips aus Runde 4 + Tipp) und gelegentlich reagieren */
  function doneReactions(code, r, m, R, h, bots) {
    try {
      const ps = partsOf(m), h4 = ((m.chipHist || {})['4']) || {}, board = R.board.filter((c) => c != null);
      if (board.length < 5) return;
      const hands = {};
      for (const id of ps) { const rv = r.docs['reveal/' + id]; if (!rv || rv.hand !== h || !Array.isArray(rv.cards)) return; hands[id] = H.bestHand(rv.cards.concat(board), rv.cards); }
      let orderOk = true;
      for (const a of ps) for (const b of ps) if (Number(h4[a]) < Number(h4[b]) && H.cmpHand(hands[a], hands[b]) > 0) orderOk = false;
      let guessOk = true;
      const g = r.docs['state/guess'], t = m.target;
      if (g && g.hand === h && Array.isArray(g.cards) && t && r.docs['reveal/' + t]) {
        const left = r.docs['reveal/' + t].cards.map((c) => c % 13);
        guessOk = g.cards.every((v) => { const i = left.indexOf(v); if (i < 0) return false; left.splice(i, 1); return true; });
      }
      const win = orderOk && guessOk;
      bots.forEach((id, k) => {
        if (Math.random() >= 0.5) return;
        setTimeout(() => { if (rooms.get(code) === r && Number(mainOf(r).hand) === h) react(code, r, id, win ? (Math.random() < 0.5 ? 0 : 4) : [1, 2, 3][Math.floor(Math.random() * 3)]); },
          (400 + k * 500 + Math.random() * 800) * TEMPO);
      });
    } catch (e) { /* nur Deko */ }
  }

  /* ------------------------------------------------ Takt ------------------- */
  function runRoom(code, r) {
    const m = mainOf(r), h = Number(m.hand) || 0, ph = m.phase, st = Number(m.stage) || 0;
    const bots = partsOf(m).filter((id) => isBot(r, id) && (r.bots[id].fromHand || 0) <= (Number(m.hand) || 0));
    let R = rt.get(code);
    if (!R || R.hand !== h) { R = { hand: h, bots: {}, busy: {}, board: [null, null, null, null, null] }; rt.set(code, R); }
    bots.forEach((id) => { if (!R.bots[id]) R.bots[id] = {}; });
    if (!bots.length || !h) return;
    const deck = r.docs['deal/deck'], aA = r.docs['deal/assignA'], aB = r.docs['deal/assignB'];
    const ok = (d) => d && d.hand === h;
    const [Sid, Aid, Bid] = roleOrder(r, m);
    if (ph === 'deal') {
      if (isBot(r, Sid) && !ok(deck)) job(R, 'deck', () => doShuffle(code, r, h, Aid, Bid));
      if (isBot(r, Aid) && ok(deck) && !ok(aA)) job(R, 'aA', () => doAssignA(code, r, h, Aid, Bid));
      if (isBot(r, Bid) && ok(deck) && ok(aA) && !ok(aB)) job(R, 'aB', () => doAssignB(code, r, h, Bid));
    }
    if (ok(deck) && ok(aA) && ok(aB)) bots.forEach((id) => { if (!R.bots[id].hole && (aA.forPlayers || {})[id] && (aB.forPlayers || {})[id]) job(R, 'hole' + id, () => decryptHole(code, r, h, id, R)); });
    if (ph === 'play') {
      if (isBot(r, Aid)) job(R, 'bA' + st, () => ensureBoard(code, r, h, st, Aid, true));
      if (isBot(r, Bid)) job(R, 'bB' + st, () => ensureBoard(code, r, h, st, Bid, false));
    }
    if (ok(deck) && ok(r.docs['deal/boardA']) && ok(r.docs['deal/boardB'])) {
      const want = slotsFor(ph === 'play' ? st : 4).filter((i) => R.board[i] == null && (r.docs['deal/boardA'].keys || {})[String(i)] && (r.docs['deal/boardB'].keys || {})[String(i)]);
      if (want.length) job(R, 'board' + want.join(''), () => decryptBoard(r, h, R));
    }
    if (ph === 'play') playStep(code, r, m, R, h, st, bots);
    else if (ph === 'guess') guessStep(code, r, m, R, h, bots);
    else if (ph === 'reveal') revealStep(code, r, m, R, h);
    else if (ph === 'done' && R.doneReact !== h) { R.doneReact = h; doneReactions(code, r, m, R, h, bots); }
  }
  function tick() {
    for (const code of [...rt.keys()]) if (!rooms.has(code)) rt.delete(code);
    for (const [code, r] of rooms) {
      if (!r.bots || !Object.keys(r.bots).length) continue;
      try { runRoom(code, r); } catch (e) { console.error('Bots in ' + code, e); }
    }
  }
  return { add, remove, convert, tick, roleOrder, isBot, MAX_BOTS_ROOM };
};
