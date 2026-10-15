/* Moderation: Wortfilter (Chat, Spieler-/Raumnamen), Melden, Admin-Liste der Meldungen; dazu der APK-Download.
   Startet einen eigenen Server (Port 3985) aus einer Wegwerf-Kopie von app/.
   Nutzung: node tests/moderation.js <app-verzeichnis> */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

const APP = path.resolve(process.argv[2] || path.join(__dirname, '..', 'app'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-mod-'));
execSync('cp -r "' + APP + '/." "' + TMP + '/"');
fs.rmSync(path.join(TMP, 'data'), { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'data'));
const PORT = 3985, BASE = 'http://127.0.0.1:' + PORT + '/', SECRET = 'test-admin-secret-mod';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) throw new Error('FEHLER: ' + m); console.log('  ok  ' + m); };
const KEY = 'mod-test-geraeteschluessel-1', KEY2 = 'mod-test-geraeteschluessel-2', KEY3 = 'mod-test-geraeteschluessel-3';
const h = (k) => crypto.createHash('sha256').update(k).digest('hex');

fs.writeFileSync(path.join(TMP, 'data', 'MOD1.json'), JSON.stringify({ version: 3, keys: { u1: h(KEY), u2: h(KEY2) }, bots: { bot1: { name: 'Emma' } },
  docs: { room: { code: 'MOD1', hostId: 'u1', createdAt: 1, name: 'Testrunde' }, 'players/u1': { name: 'Anna' }, 'players/u2': { name: 'Ben' }, 'players/bot1': { name: 'Emma', bot: true } } }));

fs.mkdirSync(path.join(TMP, 'public', 'app'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'public', 'app', 'letzte-runde.apk'), crypto.randomBytes(3 * 1048576));
const { filter } = require(path.join(TMP, 'moderation.js'));
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
  if (o.admin) hd['x-admin-secret'] = SECRET;
  const r = await fetch(BASE + (o.admin ? 'admin-api' : 'api') + '?a=' + a + (q || ''), { method: body === undefined ? 'GET' : 'POST', headers: hd,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let j = {}; try { j = await r.json(); } catch (e) { /* leer */ }
  return { s: r.status, j: j };
}
const docs = async () => (await call('state', '&room=MOD1&since=-1')).j.docs;

(async () => {
  /* Filter */
  ok(filter('Du Arschloch!') === 'Du *********!', 'Schimpfwort ersetzt, Satzzeichen bleibt');
  ok(filter('F1CK dich') === '**** dich' && filter('sieg  heil') === '****  ****', 'Leetspeak und Wortgruppen erkannt');
  ok(['Mongolei', 'Fagott', 'Analyse', 'Hürde', 'Kyste', 'Grüß Gott', 'Hand 4 gewonnen'].every((s) => filter(s) === s), 'harmlose Wörter bleiben unverändert');

  await start();
  /* Chat und Namen werden serverseitig gefiltert */
  let r = await call('chat', '&room=MOD1', { uid: 'u1', text: 'Ben, du Wichser' }, { key: KEY });
  ok(r.s === 200, 'Chat gesendet');
  let d = await docs();
  ok(d.chat.msgs[0].text === 'Ben, du *******', 'Chat-Nachricht gefiltert');
  r = await call('set', '&room=MOD1&path=players/u3', { name: 'Hurensohn99' }, { key: KEY3 });
  ok(r.s === 200 && (await docs())['players/u3'].name === '*********99', 'Spielername gefiltert');
  r = await call('create', '&room=MOD2', { hostId: 'h1', name: 'Fotzenrunde' }, { key: 'mod-host-schluessel-000001' });
  ok(r.s === 200, 'Raum mit anstößigem Namen erstellt');
  ok(!/fotze/i.test((await call('state', '&room=MOD2&since=-1')).j.docs.room.name), 'Raumname gefiltert');

  /* Melden */
  r = await call('report', '&room=MOD1', { uid: 'u1', target: 'u2', reason: 'beleidigung' }, { key: 'falscher-schluessel-0000001' });
  ok(r.s === 403, 'Melden nur als Spieler*in des Raums (Geräteschlüssel)');
  r = await call('report', '&room=MOD1', { uid: 'u1', target: 'u1', reason: 'spam' }, { key: KEY });
  ok(r.s === 400, 'sich selbst melden abgelehnt');
  r = await call('report', '&room=MOD1', { uid: 'u1', target: 'bot1', reason: 'spam' }, { key: KEY });
  ok(r.s === 400, 'Bots melden abgelehnt');
  r = await call('report', '&room=MOD1', { uid: 'u1', target: 'u9', reason: 'spam' }, { key: KEY });
  ok(r.s === 400, 'unbekannte Person abgelehnt');
  r = await call('report', '&room=MOD1', { uid: 'u2', target: 'u1', reason: 'beleidigung', note: 'x'.repeat(5000) + '<script>' }, { key: KEY2 });
  ok(r.s === 200 && !r.j.dup, 'Meldung angenommen');
  r = await call('report', '&room=MOD1', { uid: 'u2', target: 'u1', reason: 'spam' }, { key: KEY2 });
  ok(r.s === 200 && r.j.dup, 'gleiche Meldung binnen einer Stunde zählt nicht doppelt');
  r = await call('report', '&room=MOD1', { uid: 'u1', target: 'u2', reason: '../../etc' }, { key: KEY });
  ok(r.s === 200, 'unbekannter Grund → „sonstiges“');
  for (const b of ['null', '[]', '{"uid":{"a":1},"target":[1]}', '{']) {
    r = await call('report', '&room=MOD1', b, { key: KEY });
    ok(r.s >= 400 && r.s < 500, 'kaputte Meldung ' + b.slice(0, 20) + ' → ' + r.s);
  }

  /* Admin */
  ok((await call('reports', '', undefined, {})).s >= 400, 'Meldungen nur für den Admin');
  r = await call('reports', '', undefined, { admin: true });
  const rep = r.j.reports || [];
  ok(r.s === 200 && rep.length === 2, 'Admin sieht zwei Meldungen');
  const a = rep.find((x) => x.target === 'Anna');
  ok(a && a.by === 'Ben' && a.reason === 'beleidigung' && a.note.length <= 300 && !/</.test(a.note) && !a.key, 'Namen vom Server, Notiz gekürzt und bereinigt');
  ok(a.chat.length === 1 && a.chat[0].id === 'T' && a.chat[0].text === 'Ben, du *******', 'Chatverlauf dabei, gemeldete Person markiert');
  ok(rep.find((x) => x.target === 'Ben').reason === 'sonstiges', 'Grund „sonstiges“ gespeichert');
  await sleep(800);
  ok(!fs.existsSync(path.join(TMP, 'data', 'reports.json')) && fs.existsSync(path.join(TMP, 'data', 'moderation', 'reports.json')), 'Meldungen im Unterordner (nicht zwischen den Räumen)');
  ok((fs.statSync(path.join(TMP, 'data', 'moderation', 'reports.json')).mode & 0o077) === 0, 'Meldungsdatei nur für den Server-User lesbar');
  r = await call('repdone', '', { id: a.id }, { admin: true });
  ok(r.s === 200 && r.j.removed === 1, 'Meldung erledigt');
  r = await call('repdone', '', { all: true }, { admin: true });
  ok(r.s === 200 && (await call('reports', '', undefined, { admin: true })).j.reports.length === 0, 'alle erledigt');
  /* Android-APK: gestreamt, als Download */
  const dl = await fetch(BASE + 'app/letzte-runde.apk'), buf = Buffer.from(await dl.arrayBuffer());
  ok(dl.status === 200 && dl.headers.get('content-type') === 'application/vnd.android.package-archive' && /attachment/.test(dl.headers.get('content-disposition')) &&
    buf.equals(fs.readFileSync(path.join(TMP, 'public', 'app', 'letzte-runde.apk'))), 'APK-Download vollständig, richtiger Typ, als Anhang');
  ok((await fetch(BASE + 'app/gibtsnicht.apk')).status === 404, 'fehlende APK → 404');
  ok((await fetch(BASE + 'api?a=config')).ok, 'Server läuft weiter');
  console.log('MODERATION BESTANDEN');
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; })
  .finally(() => { try { srv.kill('SIGKILL'); } catch (e) { /* egal */ } fs.rmSync(TMP, { recursive: true, force: true }); });
