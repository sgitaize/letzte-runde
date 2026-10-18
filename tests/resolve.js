/* Verbindliche Auswertung auf dem Server (resolve.js) und alles, was daran hängt:
   - Hand aus Raum 9XV9 (Tisch 3-2-A-4-5): eigene Kombination zählt, auch wenn der Tisch allein eine Straße hat
   - gleiches Ergebnis wie hand.js resolve() im Browser; geschummeltes Aufdecken (Tischplätze) zählt nicht
   - ?a=record übernimmt die Server-Auswertung, nicht die (manipulierte) Meldung des Clients; state/result genau einmal je Hand
   - Mindest-Spiellogik für Online-Räume (Admin: minLogic), private Räume, Tipp-Vorschläge je Spieler*in
   Startet einen eigenen Server (Port 3984) aus einer Wegwerf-Kopie von app/.
   Nutzung: node tests/resolve.js <app-verzeichnis> */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

const APP = path.resolve(process.argv[2] || path.join(__dirname, '..', 'app'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-res-'));
execSync('cp -r "' + APP + '/." "' + TMP + '/"');
fs.rmSync(path.join(TMP, 'data'), { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'data'));
const PORT = 3984, BASE = 'http://127.0.0.1:' + PORT + '/', SECRET = 'test-admin-secret-res';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) throw new Error('FEHLER: ' + m); console.log('  ok  ' + m); };
const sha = (k) => crypto.createHash('sha256').update(k).digest('hex');
const H = require(path.join(TMP, 'public', 'hand.js'));
const { resolveRoom, resultDoc } = require(path.join(TMP, 'resolve.js'));

/* Karten wie im Spiel: Wert = c % 13 (0 = 2 … 12 = Ass), Farbe = floor(c / 13) */
const C = (s) => '♠♥♦♣'.indexOf(s.slice(-1)) * 13 + '23456789TJQKA'.indexOf(s.slice(0, -1));
const hex = () => crypto.randomBytes(32).toString('hex');
function enc(k1, k2, card) {
  const key = Buffer.from(k1, 'hex').map((b, i) => b ^ Buffer.from(k2, 'hex')[i]), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv), ct = Buffer.concat([c.update(Buffer.from([card])), c.final(), c.getAuthTag()]);
  return iv.toString('base64') + '.' + ct.toString('base64');
}
/* Raum mit fertiger Hand: hands = {id: ['3♥','4♦']}, chips = {id: Chip in Runde 4} */
function room(code, board, hands, chips, guess, extra) {
  const ids = Object.keys(hands), deck = [], k1 = [], k2 = [], slots = {};
  const put = (card) => { k1.push(hex()); k2.push(hex()); deck.push(enc(k1[k1.length - 1], k2[k2.length - 1], card)); return deck.length - 1; };
  const bs = board.map((c) => put(C(c)));
  ids.forEach((id) => { slots[id] = hands[id].map((c) => put(C(c))); });
  const docs = { room: { code, hostId: ids[0], createdAt: 1 }, 'deal/deck': { hand: 1, cts: deck },
    'deal/boardA': { hand: 1, keys: {} }, 'deal/boardB': { hand: 1, keys: {} },
    'state/main': { phase: 'done', hand: 1, stage: 4, participants: ids, target: guess ? guess.target : null, revealOrder: ids, revealIdx: ids.length,
      chipHist: { 1: chips, 2: chips, 3: chips, 4: chips } } };
  bs.forEach((s, i) => { docs['deal/boardA'].keys[i] = { s, k: k1[s] }; docs['deal/boardB'].keys[i] = { k: k2[s] }; });
  ids.forEach((id) => {
    docs['players/' + id] = { name: id, joinedAt: 1 };
    docs['reveal/' + id] = { hand: 1, slots: slots[id], k1: slots[id].map((s) => k1[s]), k2: slots[id].map((s) => k2[s]), cards: [0, 1] };
  });
  if (guess) docs['state/guess'] = { hand: 1, cards: guess.cards, confirmed: {} };
  Object.assign(docs, extra || {});
  return { version: 9, keys: Object.fromEntries(ids.map((id) => [id, sha('key-' + id + '-0123456789')])), docs };
}
const BOARD = ['3♠', '2♥', 'A♦', '4♣', '5♠'];
const HANDS = { du: ['3♥', '4♦'], Jonas: ['3♦', '2♣'], Paul: ['2♦', '9♣'], Benni: ['K♣', '8♥'], Ida: ['6♥', 'Q♠'], Mia: ['6♣', 'J♦'] };
const RIGHT = { Benni: 1, Paul: 2, Jonas: 3, du: 4, Ida: 5, Mia: 6 };

let srv;
function start() {
  srv = spawn(process.execPath, ['server.js'], { cwd: TMP, env: Object.assign({}, process.env, { PORT: String(PORT), ADMIN_SECRET: SECRET }), stdio: 'ignore' });
  return (async () => { for (let i = 0; i < 60; i++) { await sleep(250); try { if ((await fetch(BASE + 'api?a=config')).ok) return; } catch (e) { /* startet noch */ } } })();
}
let ipn = 1;
async function call(a, q, body, o) {
  o = o || {};
  const hd = { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.' + (ipn++ % 200 + 1) };
  if (o.key) hd['x-kr-key'] = o.key;
  if (o.logic != null) hd['x-kr-logic'] = String(o.logic);
  if (o.admin) hd['x-admin-secret'] = SECRET;
  const r = await fetch(BASE + (o.admin ? 'admin-api' : 'api') + '?a=' + a + (q || ''), { method: body === undefined ? 'GET' : 'POST', headers: hd,
    body: body === undefined ? undefined : JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch (e) { /* leer */ }
  return { s: r.status, j };
}
const docs = async (c) => (await call('state', '&room=' + c + '&since=-1')).j.docs;

(async () => {
  /* ---- Auswertung ohne Server ---- */
  let x = resolveRoom(room('T1', BOARD, HANDS, RIGHT));
  ok(x && x.logic === H.LOGIC_VERSION && x.res.win && !x.res.bad && !x.res.missing, 'Hand 9XV9 richtig gelegt → gewonnen');
  ok(x.res.by.du.lo === 4 && x.res.by.Jonas.lo === 3 && x.res.by.Paul.lo === 2 && x.res.by.Benni.lo === 1, 'du zwei Paare (4/3) = Platz 4, Jonas 3, Paul 2, Benni 1');
  ok(x.res.by.Ida.lo === 5 && x.res.by.Ida.hi === 6 && x.res.by.Mia.lo === 5, 'Ida und Mia gleich stark (Straße bis 6), Platz 5–6');
  const p = Object.keys(HANDS).map((id) => ({ id, chip: RIGHT[id], cards: HANDS[id].map(C) }));
  const br = H.resolve({ board: BOARD.map(C), players: p });
  ok(Object.keys(HANDS).every((id) => br.by[id].lo === x.res.by[id].lo && br.by[id].ok === x.res.by[id].ok), 'Browser-Auswertung (hand.js) = Server-Auswertung');
  x = resolveRoom(room('T2', BOARD, HANDS, Object.assign({}, RIGHT, { du: 3, Jonas: 4 })));
  ok(!x.res.win && x.res.bad === 2 && x.res.by.du.swaps[0] === 'Jonas', 'du und Jonas vertauscht → 2 falsch');
  x = resolveRoom(room('T3', BOARD, HANDS, RIGHT, { target: 'Mia', cards: [4, 9] }));
  ok(x.res.win && x.res.gr.hits === 2, 'Tipp auf Mia (6, Bube) komplett richtig');
  const cheat = room('T4', BOARD, HANDS, RIGHT);
  const bA = cheat.docs['deal/boardA'].keys, bB = cheat.docs['deal/boardB'].keys;
  cheat.docs['reveal/Benni'] = { hand: 1, slots: [bA[0].s, bA[1].s], k1: [bA[0].k, bA[1].k], k2: [bB[0].k, bB[1].k] };
  x = resolveRoom(cheat);
  ok(x.res.missing === 1 && x.res.by.Benni.hand === null && !x.res.win, 'Tischkarten als eigene Hand aufgedeckt → zählt als nicht aufgedeckt');
  const bad = room('T5', BOARD, HANDS, RIGHT);
  bad.docs['reveal/Paul'].k2[0] = hex();
  ok(resolveRoom(bad).res.by.Paul.hand === null, 'falscher Schlüssel beim Aufdecken → nicht aufgedeckt');
  const d = resultDoc(resolveRoom(room('T6', BOARD, HANDS, RIGHT)));
  ok(d.hand === 1 && d.win && d.by.du.lo === 4 && !('cards' in d.by.du) && !JSON.stringify(d).includes('"hand":{'), 'state/result: kurz, ohne Karten');

  /* ---- Server: record nimmt die eigene Auswertung ---- */
  fs.writeFileSync(path.join(TMP, 'data', 'REC1.json'), JSON.stringify(room('REC1', BOARD, HANDS, Object.assign({}, RIGHT, { du: 3, Jonas: 4 }))));
  await start();
  const KEY = 'key-du-0123456789';
  let r = await call('record', '&room=REC1', { uid: 'du', hand: 1, win: true, players: Object.keys(HANDS).map((id) => ({ id, ok: true, rounds: [true, true, true, true] })) }, { key: KEY });
  ok(r.s === 200 && r.j.server, 'record: Server wertet selbst aus');
  let dd = await docs('REC1');
  const e = dd.stats.hands[0];
  ok(dd.stats.hands.length === 1 && e.win === false && e.src === 'server' && e.logic === H.LOGIC_VERSION, 'manipulierte Meldung (alles richtig) ignoriert → verloren');
  ok(e.players.find((q) => q.id === 'du').ok === false && e.players.find((q) => q.id === 'Benni').ok === true, 'je Spieler*in richtig/falsch aus der Auswertung');
  ok(dd['state/result'] && dd['state/result'].hand === 1 && dd['state/result'].bad === 2, 'state/result liegt im Raum');
  const v1 = (await call('state', '&room=REC1&since=-1')).j.version;
  r = await call('record', '&room=REC1', { uid: 'Paul', hand: 1, win: true, players: [] }, { key: 'key-Paul-0123456789' });
  ok(r.j.dup && (await call('state', '&room=REC1&since=-1')).j.version === v1, 'zweite Meldung: nichts ändert sich (state/result nur einmal je Hand)');
  r = await call('record', '&room=REC1', { uid: 'x', hand: 1 }, { key: 'fremder-schluessel-0123' });
  ok(r.s === 403, 'record nur für Spieler*innen des Raums');
  const cfg = (await call('config')).j;
  ok(cfg.logic === H.LOGIC_VERSION && cfg.config.minLogic === 0, '/api?a=config meldet Spiellogik-Version, minLogic aus');

  /* ---- Mindest-Spiellogik für Online-Räume ---- */
  const HK = 'host-schluessel-0123456789';
  r = await call('create', '&room=OLD1', { hostId: 'h1' }, { key: HK });
  ok(r.s === 200, 'ohne Vorgabe: Raum auch ohne Versionsangabe');
  r = await call('set', '&room=OLD1&path=players/h1', { name: 'Host' }, { key: HK });
  ok(r.s === 200, 'Host sitzt im Raum');
  r = await call('config', '', { minLogic: H.LOGIC_VERSION }, { admin: true });
  ok(r.s === 200 && r.j.config.minLogic === H.LOGIC_VERSION, 'Admin verlangt Spiellogik ' + H.LOGIC_VERSION);
  r = await call('create', '&room=OLD2', { hostId: 'h2' }, { key: HK, logic: H.LOGIC_VERSION - 1 });
  ok(r.s === 426 && r.j.update && /neuere Spiellogik/.test(r.j.error), 'alte Spiellogik: kein neuer Raum (426, Update-Hinweis)');
  r = await call('create', '&room=OLD2', { hostId: 'h2' }, { key: HK });
  ok(r.s === 426, 'ganz alte Apps (ohne Versionsangabe) ebenso');
  r = await call('set', '&room=OLD1&path=players/g1', { name: 'Gast' }, { key: 'gast-schluessel-0123456789', logic: 1 });
  ok(r.s === 426, 'alte Spiellogik: kein Beitritt');
  r = await call('set', '&room=OLD1&path=players/h1', { name: 'Host', ready: null }, { key: HK, logic: 1 });
  ok(r.s === 200, 'wer schon sitzt, spielt weiter');
  r = await call('set', '&room=OLD1&path=players/g2', { name: 'Neu' }, { key: 'neu-schluessel-0123456789', logic: H.LOGIC_VERSION });
  ok(r.s === 200, 'aktuelle Spiellogik: Beitritt geht');
  await call('config', '', { minLogic: 0 }, { admin: true });

  /* ---- Private Räume (#10) ---- */
  r = await call('create', '&room=PRV1', { hostId: 'p1', name: 'Geheim', private: true }, { key: HK });
  await call('set', '&room=PRV1&path=players/p1', { name: 'Pia' }, { key: HK });
  await sleep(3200);
  let list = (await call('rooms')).j.rooms.map((x) => x.code);
  ok(list.indexOf('PRV1') < 0 && list.indexOf('OLD1') >= 0, 'privater Raum nicht in „Offene Räume“');
  ok((await call('info', '&room=PRV1')).j.name === 'Geheim', 'mit Code erreichbar');
  r = await call('roomopt', '&room=PRV1', { uid: 'p1', private: false }, { key: 'falsch-schluessel-0123456' });
  ok(r.s === 403, 'öffentlich machen nur der Host');
  r = await call('roomopt', '&room=PRV1', { uid: 'p1', private: false }, { key: HK });
  list = (await call('rooms')).j.rooms.map((x) => x.code);
  ok(r.s === 200 && !r.j.private && list.indexOf('PRV1') >= 0, 'Host macht den Raum öffentlich → in der Liste');

  /* ---- Tipp-Vorschläge je Spieler*in (#4) ---- */
  const G = room('GUE1', BOARD, { a: ['3♥', '4♦'], b: ['3♦', '2♣'], c: ['2♦', '9♣'] }, { a: 1, b: 2, c: 3 });
  G.docs['state/main'].phase = 'guess'; G.docs['state/main'].target = 'c'; G.docs['state/guess'] = { hand: 1, cards: [null, null], confirmed: {} };
  fs.writeFileSync(path.join(TMP, 'data', 'GUE1.json'), JSON.stringify(G));
  const KA = 'key-a-0123456789', KB = 'key-b-0123456789';
  await call('guess', '&room=GUE1', { uid: 'a', i: 0, val: 12 }, { key: KA });
  await call('guess', '&room=GUE1', { uid: 'a', i: 1, val: 11 }, { key: KA });
  await call('guess', '&room=GUE1', { uid: 'b', i: 1, val: 7 }, { key: KB });
  let g = (await docs('GUE1'))['state/guess'];
  ok(JSON.stringify(g.cards) === '[12,7]' && JSON.stringify(g.sug.a) === '[12,11]' && JSON.stringify(g.sug.b) === '[null,7]', 'gemeinsamer Tipp + Vorschlag je Person (live für alle)');
  r = await call('guess', '&room=GUE1', { uid: 'b', take: 'b' }, { key: KB });
  ok(r.s === 400, 'unvollständigen Vorschlag kann man nicht übernehmen');
  await call('guess', '&room=GUE1', { uid: 'b', confirm: true }, { key: KB });
  r = await call('guess', '&room=GUE1', { uid: 'b', take: 'a' }, { key: KB });
  g = (await docs('GUE1'))['state/guess'];
  ok(r.s === 200 && JSON.stringify(g.cards) === '[12,11]' && !Object.keys(g.confirmed).length && JSON.stringify(g.sug.b) === '[12,11]', 'Vorschlag von a übernommen, Bestätigungen zurückgesetzt');

  srv.kill();
  console.log('fertig');
  process.exit(0);
})().catch((e) => { console.error(e); try { srv && srv.kill(); } catch (x) { /* egal */ } process.exit(1); });
