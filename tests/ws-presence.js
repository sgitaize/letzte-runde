/* Anwesenheit über WebSocket: ein stummer Socket (Handy gesperrt) darf nicht dauerhaft "online" bleiben,
   ein Socket, der Pings beantwortet (wacher Browser), schon. Nutzung: node tests/ws-presence.js (Server auf 3999). */
const net = require('net'), crypto = require('crypto');
const PORT = Number(process.env.KR_PORT) || 3999;
const BASE = 'http://localhost:' + PORT + '/api';
const ok = (c, m) => { if (!c) { console.error('FEHLER: ' + m); process.exit(1); } console.log('  ok  ' + m); };
const post = (a, room, body, key, extra) => fetch(BASE + '?a=' + a + '&room=' + room + (extra || ''), { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-kr-key': key }, body: JSON.stringify(body) });
function wsOpen(room, uid, answerPings) {
  const s = net.connect(PORT, 'localhost');
  s.write('GET /ws?room=' + room + '&u=' + uid + ' HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  let hand = false, buf = Buffer.alloc(0);
  s.on('data', (d) => {
    if (!hand) { hand = true; const i = d.indexOf('\r\n\r\n'); d = d.slice(i + 4); }
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f; let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      if (buf.length < off + len) break;
      buf = buf.slice(off + len);
      if (op === 0x9 && answerPings) s.write(Buffer.from([0x8A, 0x80, 1, 2, 3, 4]));   // maskierter Pong
    }
  });
  return s;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const room = 'WSP' + Math.floor(Math.random() * 9), kA = 'a'.repeat(24), kB = 'b'.repeat(24);
  await post('create', room, { hostId: 'uawake' }, kA);
  await post('set', room, { name: 'Wach', joinedAt: 1 }, kA, '&path=players/uawake');
  await post('set', room, { name: 'Schlaf', joinedAt: 2 }, kB, '&path=players/usleep');
  wsOpen(room, 'uawake', true); wsOpen(room, 'usleep', false);
  await sleep(1500);
  let st = await (await fetch(BASE + '?a=state&room=' + room + '&since=-1')).json();
  ok(st.online.includes('uawake') && st.online.includes('usleep'), 'Beide Sockets anfangs online');
  console.log('  …   warte 55 s (Server pingt alle 25 s)');
  await sleep(55000);
  st = await (await fetch(BASE + '?a=state&room=' + room + '&since=-1')).json();
  ok(st.online.includes('uawake'), 'Socket, der Pings beantwortet, bleibt online');
  ok(!st.online.includes('usleep'), 'Stummer Socket (gesperrtes Handy) gilt als offline');
  ok(st.idle.includes('usleep') && st.away.usleep >= 30000, 'Stummer Spieler ist übernehmbar (weg seit ' + Math.round(st.away.usleep / 1000) + ' s)');
  await post('close', room, { uid: 'uawake' }, kA);
  console.log('WS-TEST BESTANDEN'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
