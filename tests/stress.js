/* Belastungs- und Angriffstest: Der Server darf durch keine Anfrage abstürzen oder volllaufen.
   Startet einen eigenen Server (Port 3998) aus einer Wegwerf-Kopie von app/.
   Nutzung: node tests/stress.js <app-verzeichnis> */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), crypto = require('crypto');

const APP = path.resolve(process.argv[2] || path.join(__dirname, '..', 'app'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-stress-'));
execSync('cp -r "' + APP + '/." "' + TMP + '/"');
const PORT = 3998, BASE = 'http://127.0.0.1:' + PORT + '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) throw new Error('FEHLER: ' + m); console.log('  ok  ' + m); };
let srv;
function start() {
  srv = spawn(process.execPath, ['server.js'], { cwd: TMP, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
  srv.exited = false; srv.on('exit', () => { srv.exited = true; });
  return sleep(700);
}
const alive = async () => !srv.exited && (await fetch(BASE + 'api?a=config')).status === 200;
const ip = (n) => '203.0.113.' + n;                       // Dokumentations-Netz, gilt als „öffentlich“
const req = (a, q, body, o) => fetch(BASE + 'api?a=' + a + (q || ''), Object.assign({
  method: body !== undefined ? 'POST' : 'GET',
  headers: Object.assign({ 'Content-Type': 'application/json', 'x-kr-key': 'stress-schluessel-000001' }, (o && o.headers) || {}),
  body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
}));
/* Roh-WebSocket (ohne Bibliothek) */
function wsOpen(room, xff) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.on('error', () => {});
    s.write('GET /ws?room=' + room + '&u=x HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n' +
      (xff ? 'X-Forwarded-For: ' + xff + '\r\n' : '') + '\r\n');
    let got = '';
    s.on('data', function f(d) { got += d.toString('latin1'); if (got.includes('\r\n\r\n')) { s.removeListener('data', f); resolve({ s, ok: got.startsWith('HTTP/1.1 101') }); } });
    s.on('close', () => resolve({ s, ok: false }));
  });
}
const closed = (s, ms) => new Promise((r) => { if (s.destroyed) return r(true); const t = setTimeout(() => r(false), ms); s.on('close', () => { clearTimeout(t); r(true); }); s.resume(); });

(async () => {
  await start();
  ok(await alive(), 'Server läuft');
  const ROOM = 'STRS1';
  await req('create', '&room=' + ROOM, { hostId: 'host1', name: '<img src=x onerror=alert(1)>\u202e' + 'n'.repeat(5000) });
  let r = await req('set', '&room=' + ROOM + '&path=players/host1', { name: 'Host', joinedAt: 1 });
  ok(r.status === 200, 'Spieler angelegt');
  const nm = (await (await req('state', '&room=' + ROOM)).json()).docs.room.name;
  ok(nm.length <= 30 && !/[<>]/.test(nm), 'Raumname beim Erstellen bereinigt und gekürzt (' + nm.length + ' Zeichen)');

  // 1) Kaputte Eingaben
  for (const u of ['%E0%A4%A', 'api?a=state&room=%ZZ', 'api?a=%00', '..%2f..%2fserver.js', 'api?a=get&room=' + ROOM + '&path=' + 'a/'.repeat(500)]) {
    const s = (await fetch(BASE + u)).status; ok(s >= 400 && s < 500 || s === 200, 'kaputte URL ' + u.slice(0, 30) + ' → ' + s);
  }
  r = await req('set', '&room=' + ROOM + '&path=state/main', '{"phase":');
  ok(r.status === 400, 'kaputtes JSON → 400');
  r = await req('set', '&room=' + ROOM + '&path=state/main', '['.repeat(50000) + ']'.repeat(50000));
  ok(r.status === 400, 'Array statt Objekt → 400');
  r = await req('set', '&room=' + ROOM + '&path=state/main', '{"a":' + '{"a":'.repeat(20000) + '1' + '}'.repeat(20001));
  ok(r.status === 400, '20000-fach verschachteltes Dokument → 400 (sprengte früher JSON.stringify)');
  r = await req('set', '&room=' + ROOM + '&path=state/main', { big: 'x'.repeat(200 * 1024) });
  ok(r.status === 413, 'Dokument über 128 KB → 413');
  r = await req('set', '&room=' + ROOM + '&path=state/main', { arr: Array(30000).fill(0) });
  ok(r.status === 400, 'Dokument mit 30000 Werten → 400');
  r = await req('state', '&room=' + ROOM + '&u=host1');
  ok(r.status === 200, 'Raum danach weiter lesbar');
  ok(await alive(), 'Server lebt nach kaputten Eingaben');

  // 2) Raumgröße begrenzt
  let last = 200;
  for (let i = 0; i < 8 && last === 200; i++) last = (await req('set', '&room=' + ROOM + '&path=reveal/host1', { d: 'y'.repeat(100 * 1024), i })).status;
  ok(last === 200, 'Ersetzen eines Dokuments hält Raumgröße konstant');
  const sizes = [];
  for (const p of ['state/main', 'state/guess', 'deal/deck', 'deal/assignA', 'deal/assignB', 'deal/boardA'])
    sizes.push((await req('set', '&room=' + ROOM + '&path=' + p, { d: 'z'.repeat(100 * 1024) })).status);
  ok(sizes.includes(413), 'Raum über 512 KB → 413 (' + sizes.join(',') + ')');

  // 3) Rate-Limit je IP, nicht per X-Forwarded-For fälschbar
  let codes = [];
  for (let i = 0; i < 400; i++) codes.push(req('config', '', undefined, { headers: { 'X-Forwarded-For': '1.1.1.' + (i % 250) + ', ' + ip(7) } }).then((x) => x.status, () => 0));
  codes = await Promise.all(codes);
  ok(codes.filter((c) => c === 429).length > 50, 'Anfrageflut einer IP → 429 (' + codes.filter((c) => c === 429).length + ' von 400), trotz gefälschter erster XFF-Einträge');
  ok((await req('config', '', undefined, { headers: { 'X-Forwarded-For': ip(8) } })).status === 200, 'andere IP wird nicht mitbestraft');
  let made = 0;
  for (let i = 0; i < 30; i++) {
    const s = (await req('create', '&room=FL' + i, { hostId: 'h' }, { headers: { 'X-Forwarded-For': '9.9.9.' + i + ', ' + ip(9) } })).status;
    if (s === 200) made++;
  }
  ok(made === 20, 'Raum-Limit je IP greift trotz wechselnder erster XFF-Einträge (' + made + ' Räume)');

  // 4) Anwesenheit mit erfundenen IDs (viele IPs)
  const flood = [];
  // Bei 3000 gleichzeitigen Verbindungen weist das Betriebssystem einzelne ab (Warteschlange voll) – erlaubt,
  // entscheidend ist, dass der Server danach weiterläuft.
  for (let i = 0; i < 3000; i++) flood.push(req('state', '&room=' + ROOM + '&since=999&u=fake' + i, undefined, { headers: { 'X-Forwarded-For': '198.51.100.' + (i % 200) } }).then((x) => x.status, () => 0));
  const fl = await Promise.all(flood);
  ok(await alive(), 'Server lebt nach 3000 gleichzeitigen Anfragen (' + fl.filter((x) => x === 200).length + ' beantwortet, ' + fl.filter((x) => x === 0).length + ' Verbindungen abgewiesen)');
  r = await (await req('state', '&room=' + ROOM + '&u=host1')).json();
  ok(r.online.length <= 200, 'Anwesenheitsliste bleibt begrenzt (' + r.online.length + ' Einträge nach 3000 erfundenen IDs)');
  ok(r.online.includes('host1'), 'echter Spieler bleibt sichtbar');

  // 5) WebSocket-Angriffe
  let w = await wsOpen(ROOM); ok(w.ok, 'WebSocket verbunden');
  w.s.write(Buffer.from([0x81, 0x05, 0x68, 0x61, 0x6c, 0x6c, 0x6f]));          // unmaskiert
  ok(await closed(w.s, 3000), 'unmaskierter Frame → getrennt');
  w = await wsOpen(ROOM);
  const big = Buffer.alloc(14); big[0] = 0x81; big[1] = 0x80 | 127; big.writeBigUInt64BE(10n ** 12n, 2);
  w.s.write(big);
  ok(await closed(w.s, 3000), 'Frame mit 1 TB Längenangabe → getrennt');
  w = await wsOpen(ROOM);
  const ping = Buffer.from([0x89, 0x80, 1, 2, 3, 4]);
  w.s.write(Buffer.concat(Array(300).fill(ping)));
  ok(await closed(w.s, 3000), 'Ping-Flut → getrennt');
  const many = [];
  for (let i = 0; i < 40; i++) many.push(await wsOpen(ROOM, ip(20)));
  ok(many.filter((x) => x.ok).length === 30, 'höchstens 30 WebSockets je IP (' + many.filter((x) => x.ok).length + ')');
  many.forEach((x) => x.s.destroy());
  // Client, der nichts liest: Sendepuffer darf nicht endlos wachsen
  w = await wsOpen(ROOM); w.s.pause();
  const t0 = Date.now();
  for (let i = 0; i < 150; i++) await req('set', '&room=' + ROOM + '&path=reveal/host1', { d: String(i % 10).repeat(100 * 1024) });
  const rss = Number(execSync('ps -o rss= -p ' + srv.pid).toString().trim()) / 1024;
  ok(await closed(w.s, 5000), 'nicht lesender WebSocket nach ~15 MB Rückstau getrennt (' + (Date.now() - t0) + ' ms)');
  ok(rss < 300, 'Speicher des Servers ' + Math.round(rss) + ' MB');

  // 6) Halb gesendete Anfrage hängt nicht ewig (Slowloris)
  const slow = net.connect(PORT, '127.0.0.1'); slow.on('error', () => {});
  slow.write('POST /api?a=set&room=' + ROOM + '&path=state/main HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\nContent-Type: application/json\r\n\r\n{"a":');
  ok(await closed(slow, 70000), 'hängende Anfrage wird vom Server geschlossen');

  ok(await alive(), 'Server lebt nach allen Angriffen');

  // 7) Stopp sichert ungespeicherte Änderungen
  await req('set', '&room=' + ROOM + '&path=state/main', { phase: 'lobby', marker: 'vor-stopp' });
  srv.kill('SIGTERM'); await sleep(500);
  const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'data', ROOM + '.json'), 'utf8'));
  ok(saved.docs['state/main'] && saved.docs['state/main'].marker === 'vor-stopp', 'SIGTERM → letzte Änderung auf Platte');
  const log = fs.readFileSync(path.join(TMP, 'logs', 'app.log'), 'utf8');
  ok(!/uncaughtException/.test(log), 'kein uncaughtException im Log');
  console.log('STRESS-TEST BESTANDEN');
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; })
  .finally(() => { try { srv.kill('SIGKILL'); } catch (e) { /* egal */ } fs.rmSync(TMP, { recursive: true, force: true }); });
