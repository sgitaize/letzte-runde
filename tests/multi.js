/* Mehrere App-Instanzen (wie Passenger unter Last): zwei Prozesse im selben App-Ordner, Ports 3990/3991.
   Erwartet: nur einer führt, der andere reicht Anfragen + WebSockets durch; fällt der Führende weg, übernimmt der andere. */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), crypto = require('crypto');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-multi-'));
execSync('cp -r "' + path.resolve(process.argv[2] || 'app') + '/." "' + TMP + '/"');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) throw new Error('FEHLER: ' + m); console.log('  ok  ' + m); };
const start = (port) => { const p = spawn(process.execPath, ['server.js'], { cwd: TMP, env: Object.assign({}, process.env, { PORT: String(port) }), stdio: 'ignore' }); return p; };
const post = (port, a, q, b, k) => fetch('http://127.0.0.1:' + port + '/api?a=' + a + q, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kr-key': k }, body: JSON.stringify(b) });
const state = async (port, room) => (await fetch('http://127.0.0.1:' + port + '/api?a=state&since=-1&room=' + room)).json();
let A, B;
(async () => {
  A = start(3990); await sleep(700); B = start(3991); await sleep(700);
  await post(3990, 'create', '&room=MULT1', { hostId: 'h1' }, 'schluessel-anna-000001');
  await post(3990, 'set', '&room=MULT1&path=players/h1', { name: 'Anna' }, 'schluessel-anna-000001');
  await post(3991, 'set', '&room=MULT1&path=players/b2', { name: 'Ben' }, 'schluessel-ben-0000001');   // über die zweite Instanz
  const sa = await state(3990, 'MULT1'), sb = await state(3991, 'MULT1');
  ok(sa.version === sb.version && sa.docs['players/b2'] && sb.docs['players/h1'], 'Beide Instanzen liefern denselben Stand (Version ' + sa.version + ')');
  const ws = await new Promise((res) => { const s = net.connect(3991, '127.0.0.1'); let g = '';
    s.write('GET /ws?room=MULT1&u=b2 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\n\r\n');
    s.on('data', (d) => { g += d.toString('latin1'); if (/"type":"full"/.test(g)) { res(g); s.destroy(); } }); setTimeout(() => { res(g); s.destroy(); }, 3000); });
  ok(/^HTTP\/1.1 101/.test(ws) && /"type":"full"/.test(ws), 'WebSocket über die zweite Instanz funktioniert');
  A.kill('SIGTERM'); await sleep(800);
  const sc = await state(3991, 'MULT1');
  ok(sc.docs && sc.docs['players/h1'] && sc.docs['players/b2'], 'Führende Instanz weg → zweite übernimmt mit vollständigem Raum');
  console.log('MULTI-TEST BESTANDEN');
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => { try { A.kill('SIGKILL'); B.kill('SIGKILL'); } catch (e) {} setTimeout(() => { fs.rmSync(TMP, { recursive: true, force: true }); process.exit(process.exitCode || 0); }, 300); });
