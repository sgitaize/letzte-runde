/* Benutzerkonten: Registrieren, Anmelden, Bremsen, Statistik-Abgleich, Raum-Hände, Wiederherstellung, Admin.
   Startet einen eigenen Server (Port 3987) aus einer Wegwerf-Kopie von app/.
   Nutzung: node tests/accounts.js <app-verzeichnis> */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

const APP = path.resolve(process.argv[2] || path.join(__dirname, '..', 'app'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-acct-'));
execSync('cp -r "' + APP + '/." "' + TMP + '/"');
for (const f of fs.readdirSync(path.join(TMP, 'data'))) fs.rmSync(path.join(TMP, 'data', f), { recursive: true, force: true });
const PORT = 3987, BASE = 'http://127.0.0.1:' + PORT + '/', SECRET = 'test-admin-secret-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) throw new Error('FEHLER: ' + m); console.log('  ok  ' + m); };
const KEY = 'acct-test-geraeteschluessel-1';

/* Raum mit fertiger Hand in der Statistik, Spieler u1 gehört zum Geräteschlüssel KEY */
fs.writeFileSync(path.join(TMP, 'data', 'TST1.json'), JSON.stringify({ version: 5, keys: { u1: crypto.createHash('sha256').update(KEY).digest('hex') },
  docs: { room: { code: 'TST1', hostId: 'u1', createdAt: 1, name: 'Testrunde' }, 'players/u1': { name: 'Anna' }, 'players/u2': { name: 'Ben' },
    stats: { hands: [{ hand: 1, ts: Date.now(), win: true, players: [{ id: 'u1', name: 'Anna', ok: true }, { id: 'u2', name: 'Ben', ok: true }], guess: { target: 'u1', hits: 2, of: 2 } }] } } }));

let srv;
function start() {
  srv = spawn(process.execPath, ['server.js'], { cwd: TMP, env: Object.assign({}, process.env, { PORT: String(PORT), ADMIN_SECRET: SECRET }), stdio: 'ignore' });
  return sleep(700);
}
let ipn = 1;
async function call(a, body, o) {
  o = o || {};
  const h = { 'Content-Type': 'application/json', 'x-forwarded-for': o.ip || '203.0.113.' + ipn };
  if (o.tok) h.cookie = 'theme=x; kr_acct=' + o.tok;
  if (o.origin) h.origin = o.origin;
  if (o.ctype) h['Content-Type'] = o.ctype;
  if (o.key) h['x-kr-key'] = o.key;
  if (o.admin) h['x-admin-secret'] = SECRET;
  const r = await fetch(BASE + (o.admin ? 'admin-api' : 'api') + '?a=' + a, { method: body === undefined ? 'GET' : 'POST', headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch (e) { /* leer */ }
  const ck = r.headers.get('set-cookie') || '', m = /kr_acct=([0-9a-f]{64})/.exec(ck);
  return { s: r.status, j: j, tk: m ? m[1] : '', ck: ck };
}
const sp = (ts, hand, ok1) => ({ hand: hand, ts: ts, win: ok1, day: '2026-10-05', hr: 20,
  players: [{ id: 'me', name: 'Anna', ok: ok1, rounds: [true, false, null, true] }, { id: 'bot:Emma', name: 'Emma', ok: true }], guess: null });

(async () => {
  await start();
  let r = await call('acct.register', { name: 'Anna', pw: 'kurz' });
  ok(r.s === 400, 'zu kurzes Passwort abgelehnt');
  r = await call('acct.register', { name: 'Anna', pw: 'Pik-Ass-42' });
  ok(r.s === 200 && r.tk && !r.j.token && /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(r.j.recovery), 'Konto angelegt, Wiederherstellungscode im Format XXXX-…');
  const tok1 = r.tk, rec1 = r.j.recovery;
  ok(/HttpOnly/.test(r.ck) && /SameSite=Strict/.test(r.ck) && /Path=\//.test(r.ck), 'Sitzung nur als HttpOnly-Cookie (SameSite=Strict), Token nicht im JSON');
  r = await call('acct.register', { name: 'Carla', pw: 'passwort1' });
  ok(r.s === 400, 'Allerweltspasswort abgelehnt');
  r = await call('acct.register', { name: 'Carla', pw: 'carla2026x' });
  ok(r.s === 400, 'Passwort mit eigenem Namen abgelehnt');
  r = await call('acct.register', { name: 'Carla', pw: 'Pik-Ass-42' }, { origin: 'https://boese.example' });
  ok(r.s === 403, 'fremde Seite (Origin) abgelehnt');
  r = await call('acct.register', { name: 'Carla', pw: 'Pik-Ass-42' }, { ctype: 'text/plain' });
  ok(r.s === 403, 'POST ohne JSON-Content-Type abgelehnt (Formular-CSRF)');
  const files = fs.readdirSync(path.join(TMP, 'data', 'accounts')).map((f) => fs.readFileSync(path.join(TMP, 'data', 'accounts', f), 'utf8')).join('\n');
  ok(files.length > 0 && !/Anna|salt|hash|sessions/.test(files) && /"v":1,"iv"/.test(files), 'Kontodatei verschlüsselt (kein Name, Hash oder Salz im Klartext)');
  ok((fs.statSync(path.join(TMP, 'data', 'accounts')).mode & 0o077) === 0, 'Kontoordner nur für den Server-User');
  ok((fs.statSync(path.join(TMP, 'data', 'account-secret.txt')).mode & 0o077) === 0, 'Server-Geheimnis nur für den Server-User lesbar');
  r = await call('acct.register', { name: ' anna ', pw: 'Pik-Ass-42' });
  ok(r.s === 409, 'Name doppelt (Groß/Klein, Leerzeichen) abgelehnt');
  r = await call('acct.register', { name: 'bot:x', pw: 'Pik-Ass-42' });
  ok(r.s === 400, 'reservierter Name abgelehnt');

  r = await call('acct.me', undefined, {});
  ok(r.s === 401, 'ohne Anmeldung kein Zugriff');
  r = await call('acct.me', undefined, { tok: tok1 });
  ok(r.s === 200 && r.j.account.name === 'Anna' && r.j.stats.sp.length === 0, 'eigenes Konto lesbar');

  let t1 = Date.now(); r = await call('acct.login', { name: 'ANNA', pw: 'falsch123' }); t1 = Date.now() - t1;
  ok(r.s === 401, 'falsches Passwort → 401');
  let t2 = Date.now(); const r2 = await call('acct.login', { name: 'Gibtsnicht', pw: 'falsch123' }); t2 = Date.now() - t2;
  ok(r2.s === 401 && r2.j.error === r.j.error && Math.abs(t1 - t2) < 250, 'unbekannter Name: gleiche Meldung, ähnliche Zeit (' + t1 + '/' + t2 + ' ms)');
  r = await call('acct.login', { name: 'ANNA', pw: 'Pik-Ass-42' });
  ok(r.s === 200 && r.tk && r.tk !== tok1, 'Anmeldung (Name ohne Groß/Klein) gibt neue Sitzung');
  const tok2 = r.tk;

  /* Übungsraum-Hände: doppelte zählen nicht, kaputte werden verworfen, Nutzung aus Browser beim ersten Mal */
  const t0 = Date.now() - 100000;
  r = await call('acct.sphands', { hands: [sp(t0, 1, true), sp(t0 + 1000, 2, false), { hand: 'x' }, { hand: 3, ts: t0, players: [{ id: 'u9', name: 'x', ok: true }] }],
    usage: { d: { '2026-10-04': [5, 3, 4] }, h: new Array(24).fill(1) } }, { tok: tok1 });
  ok(r.s === 200 && r.j.added === 2, 'zwei gültige Hände übernommen, ungültige verworfen');
  r = await call('acct.sphands', { hands: [sp(t0, 1, true), sp(t0 + 2000, 3, true)] }, { tok: tok2 });
  ok(r.j.added === 1, 'vom zweiten Gerät: nur die neue Hand zählt');
  r = await call('acct.me', undefined, { tok: tok2 });
  const u = r.j.stats.usage.sp;
  ok(r.j.stats.sp.length === 3 && u.d['2026-10-04'][0] === 5 && u.d['2026-10-05'][0] === 1, 'Statistik + Nutzung geräteübergreifend');

  /* Raum-Hand: Server übernimmt Eintrag aus der Raumstatistik, eigener Platz → „me“ */
  r = await call('acct.mphand', { room: 'TST1', hand: 1, day: '2026-10-05', hr: 21 }, { tok: tok1, key: 'fremder-schluessel-xxxxxx' });
  ok(r.s === 403, 'Raum-Hand nur mit Geräteschlüssel eines Mitspielers');
  r = await call('acct.mphand', { room: 'TST1', hand: 1, day: '2026-10-05', hr: 21 }, { tok: tok1, key: KEY });
  ok(r.s === 200, 'Raum-Hand übernommen');
  r = await call('acct.mphand', { room: 'TST1', hand: 1, day: '2026-10-05', hr: 21 }, { tok: tok2, key: KEY });
  ok(r.j.dup, 'Raum-Hand nicht doppelt');
  r = await call('acct.mphand', { room: 'TST1', hand: 2 }, { tok: tok1, key: KEY });
  ok(r.s === 409, 'unfertige Hand abgelehnt');
  r = await call('acct.me', undefined, { tok: tok1 });
  const mp = r.j.stats.mp[0];
  ok(r.j.stats.mp.length === 1 && mp.players[0].id === 'me' && mp.guess.target === 'me' && mp.roomName === 'Testrunde', 'Raum-Hand mit „me“ und Raumname');

  /* Passwort ändern: andere Sitzungen abgemeldet */
  r = await call('acct.password', { old: 'falsch', pw: 'neuesPW123' }, { tok: tok1 });
  ok(r.s === 401, 'Passwort ändern mit falschem alten Passwort abgelehnt');
  r = await call('acct.password', { old: 'Pik-Ass-42', pw: 'neuesPW123' }, { tok: tok1 });
  ok(r.s === 200, 'Passwort geändert');
  ok((await call('acct.me', undefined, { tok: tok2 })).s === 401, 'anderes Gerät abgemeldet');
  ok((await call('acct.me', undefined, { tok: tok1 })).s === 200, 'eigenes Gerät bleibt angemeldet');

  /* Wiederherstellung: Code gilt einmal, alle Sitzungen enden */
  r = await call('acct.recover', { name: 'Anna', recovery: 'AAAA-BBBB-CCCC-DDDD', pw: 'rettung123' });
  ok(r.s === 401, 'falscher Wiederherstellungscode abgelehnt');
  r = await call('acct.recover', { name: 'Anna', recovery: rec1.toLowerCase().replace(/-/g, ' '), pw: 'rettung123' });
  ok(r.s === 200 && r.j.recovery && r.j.recovery !== rec1, 'Wiederherstellung (Kleinschreibung/Leerzeichen egal) gibt neuen Code');
  const tok3 = r.tk;
  ok((await call('acct.me', undefined, { tok: tok1 })).s === 401, 'nach Wiederherstellung alte Sitzungen beendet');
  r = await call('acct.recover', { name: 'Anna', recovery: rec1, pw: 'nochmal123' });
  ok(r.s === 401, 'alter Code gilt nicht noch einmal');
  ok((await call('acct.login', { name: 'Anna', pw: 'rettung123' })).s === 200, 'Anmeldung mit neuem Passwort');

  /* Bremse: Fehlversuche je Name */
  ipn = 50;
  for (let i = 0; i < 10; i++) { ipn = 50 + i; await call('acct.login', { name: 'Anna', pw: 'falsch' + i }); }
  ipn = 70;
  r = await call('acct.login', { name: 'Anna', pw: 'rettung123' });
  ok(r.s === 429, 'nach 10 Fehlversuchen für den Namen gesperrt (auch von neuer IP)');

  /* Admin: Liste, Zurücksetzen, Löschen */
  r = await call('accounts', {}, { admin: true });
  ok(r.s === 200 && r.j.accounts.length === 1 && r.j.accounts[0].hands.sp === 3 && r.j.accounts[0].hands.mp === 1, 'Admin sieht Konto mit Handzahlen');
  const id = r.j.accounts[0].id;
  ok(!JSON.stringify(r.j).includes('hash') && !JSON.stringify(r.j).includes('"rec"'), 'Admin-Liste ohne Hashes');
  r = await call('acctreset', { id: id }, { admin: true });
  ok(r.s === 200 && r.j.password && r.j.password.length === 10, 'Admin setzt Passwort zurück (Einmal-Passwort)');
  const tmpPw = r.j.password;
  ok((await call('acct.me', undefined, { tok: tok3 })).s === 401, 'nach Admin-Reset alle Sitzungen beendet');
  ipn = 80;
  r = await call('acct.login', { name: 'Anna', pw: tmpPw });
  ok(r.s === 200 && r.j.account.reset === true, 'Einmal-Passwort hebt Sperre auf, Konto zeigt „zurückgesetzt“');
  r = await call('acct.password', { old: tmpPw, pw: 'eigenesPW1' }, { tok: r.tk });
  ok(r.s === 200 && r.j.account.reset === false, 'eigenes Passwort gesetzt, Hinweis weg');
  r = await call('acct.register', { name: 'Ben', pw: 'Herz-Dame-9' });
  const tokB = r.tk;
  r = await call('acct.me', undefined, { tok: tokB });
  ok(r.j.stats.sp.length === 0, 'zweites Konto sieht keine fremde Statistik');

  /* Neustart: Konten und Sitzungen bleiben */
  srv.kill(); await sleep(400); await start();
  r = await call('acct.me', undefined, { tok: tokB });
  ok(r.s === 200 && r.j.account.name === 'Ben', 'nach Neustart noch angemeldet');
  ok(fs.readdirSync(path.join(TMP, 'data', 'accounts')).filter((f) => f.endsWith('.json')).length === 3, 'Dateien liegen in data/accounts/');
  ok((await call('rooms')).s === 200 && !(await call('rooms')).j.rooms.some((x) => /acc/i.test(x.code)), 'Kontodateien erscheinen nicht als Räume');

  r = await call('acct.delete', { pw: 'falsch' }, { tok: tokB });
  ok(r.s === 401, 'Löschen nur mit Passwort');
  r = await call('acct.delete', { pw: 'Herz-Dame-9' }, { tok: tokB });
  ok(r.s === 200 && /Max-Age=0/.test(r.ck) && (await call('acct.me', undefined, { tok: tokB })).s === 401, 'Konto selbst gelöscht, Cookie gelöscht');
  r = await call('acctdel', { id: id }, { admin: true });
  ok(r.s === 200 && fs.readdirSync(path.join(TMP, 'data', 'accounts')).filter((f) => f.endsWith('.json')).length === 0, 'Admin löscht Konto samt Statistik');
  srv.kill(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log('fertig'); process.exit(0);
})().catch((e) => { console.error(e.message || e); try { srv.kill(); } catch (x) { /* egal */ } process.exit(1); });
