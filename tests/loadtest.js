/* Lasttest gegen einen laufenden Server (live oder lokal), gestuft, bricht bei hoher Fehlerquote ab.
   Nutzung: node --experimental-websocket tests/loadtest.js https://gang.aize.eu/ [phasen]
   Phasen (Standard alle): static, api, rooms
   Achtung: von einer IP greifen die Schutzgrenzen des Servers (40 API/s, 30 WebSockets, 20 Räume/10 min). */
'use strict';
const BASE = (process.argv[2] || 'http://127.0.0.1:3000/').replace(/\/?$/, '/');
const PHASES = (process.argv[3] || 'static,api,rooms').split(',');
const OPT = { rooms: Number(process.env.LT_ROOMS) || 3, players: Number(process.env.LT_PLAYERS) || 8,
  rates: (process.env.LT_RATES || '10,20,40,80').split(',').map(Number),
  conc: (process.env.LT_CONC || '10,25,50,100').split(',').map(Number),
  writeRates: (process.env.LT_WRATES || '10,25').split(',').map(Number), secs: Number(process.env.LT_SECS) || 8 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]); };
const stat = (lat) => 'p50 ' + pct(lat, 0.5) + ' ms · p95 ' + pct(lat, 0.95) + ' ms · max ' + pct(lat, 1) + ' ms';

async function timed(url, init) {
  const t = performance.now();
  try { const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(10000) }, init)); await r.arrayBuffer(); return { s: r.status, ms: performance.now() - t }; }
  catch (e) { return { s: 0, ms: performance.now() - t }; }
}
function summary(label, res, secs) {
  const by = {}; for (const r of res) by[r.s] = (by[r.s] || 0) + 1;
  const ok = res.filter((r) => r.s === 200);
  console.log(label.padEnd(26) + (res.length / secs).toFixed(0).padStart(5) + ' req/s · ok ' + ok.length + '/' + res.length +
    ' · ' + JSON.stringify(by) + ' · ' + stat(ok.map((r) => r.ms)));
  return { errRate: 1 - ok.length / Math.max(1, res.length), p95: pct(ok.map((r) => r.ms), 0.95) };
}

/* 1) Statische Dateien: feste Anzahl paralleler Clients */
async function phaseStatic() {
  console.log('\n== Statisch (Startseite, parallele Clients je ' + OPT.secs + ' s) ==');
  for (const c of OPT.conc) {
    const res = [], end = Date.now() + OPT.secs * 1000;
    await Promise.all(Array.from({ length: c }, async () => { while (Date.now() < end) res.push(await timed(BASE)); }));
    const s = summary('  ' + c + ' parallel', res, OPT.secs);
    if (s.errRate > 0.1 || s.p95 > 5000) { console.log('  → Abbruch der Stufe (Fehler/Latenz)'); break; }
    await sleep(2000);
  }
}

/* 2) API: feste Anfragerate (leichte Anfrage ?a=config) */
async function phaseApi() {
  console.log('\n== API ?a=config (feste Rate je ' + OPT.secs + ' s) ==');
  for (const rate of OPT.rates) {
    await sleep(8000);   // Token-Bucket wieder auffüllen
    const res = [], jobs = [], n = rate * OPT.secs, t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const wait = t0 + i * 1000 / rate - performance.now(); if (wait > 0) await sleep(wait);
      jobs.push(timed(BASE + 'api?a=config').then((r) => res.push(r)));
    }
    await Promise.all(jobs);
    summary('  ' + rate + '/s', res, OPT.secs);
  }
}

/* 3) Räume mit Spielern: WebSockets, Schreiben (ready-Status), Push-Latenz */
async function phaseRooms() {
  console.log('\n== Räume: ' + OPT.rooms + ' × ' + OPT.players + ' Spieler (WebSocket) ==');
  await sleep(8000);
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase(), rooms = [];
  const api = (a, code, key, q, body) => timed(BASE + 'api?a=' + a + '&room=' + code + (q || ''), { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-kr-key': key }, body: body ? JSON.stringify(body) : undefined });
  const sent = new Map(), pushLat = [];   // marker -> Sendezeit
  let wsOpen = 0, wsFail = 0, wsDrop = 0;
  try {
    for (let i = 0; i < OPT.rooms; i++) {
      const code = 'LT' + tag + i, players = [];
      for (let j = 0; j < OPT.players; j++) players.push({ id: 'lt' + j, key: 'lasttest-' + tag + '-' + i + '-' + j + '-schluessel' });
      const c = await api('create', code, players[0].key, '', { hostId: players[0].id, name: 'Lasttest' });
      if (c.s !== 200) throw new Error('create ' + code + ' → ' + c.s);
      for (const p of players) {
        const r = await api('set', code, p.key, '&path=players/' + p.id, { name: 'Last ' + p.id, ready: { hand: 0, stage: 0 } });
        if (r.s !== 200) throw new Error('join → ' + r.s);
      }
      rooms.push({ code, players });
    }
    const wsBase = BASE.replace(/^http/, 'ws');
    await Promise.all(rooms.flatMap((room) => room.players.map((p) => new Promise((resolve) => {
      const ws = new WebSocket(wsBase + 'ws?room=' + room.code + '&u=' + p.id); p.ws = ws;
      const t = setTimeout(() => { wsFail++; resolve(); }, 10000);
      ws.onopen = () => { clearTimeout(t); wsOpen++; resolve(); };
      ws.onerror = () => { clearTimeout(t); };
      ws.onclose = () => { if (p.open) wsDrop++; p.open = false; clearTimeout(t); resolve(); };
      ws.onmessage = (ev) => {
        p.open = true;
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        const chs = m.type === 'doc' ? [m] : m.type === 'docs' ? m.changes || [] : [];
        for (const ch of chs) { const k = ch.doc && ch.doc.name && sent.get(room.code + ch.doc.name + (ch.doc.ready && ch.doc.ready.stage)); if (k) pushLat.push(performance.now() - k); }
      };
    }))));
    console.log('  WebSockets offen ' + wsOpen + ', fehlgeschlagen ' + wsFail);
    const all = rooms.flatMap((room) => room.players.map((p) => ({ room, p })));
    let stage = 0;
    for (const rate of OPT.writeRates) {
      await sleep(8000);
      pushLat.length = 0;
      const res = [], jobs = [], n = rate * OPT.secs, t0 = performance.now();
      for (let i = 0; i < n; i++) {
        const wait = t0 + i * 1000 / rate - performance.now(); if (wait > 0) await sleep(wait);
        const { room, p } = all[i % all.length], st = ++stage;
        sent.set(room.code + 'Last ' + p.id + st, performance.now());
        jobs.push(api('set', room.code, p.key, '&path=players/' + p.id, { name: 'Last ' + p.id, ready: { hand: 0, stage: st } }).then((r) => res.push(r)));
      }
      await Promise.all(jobs); await sleep(1500);
      summary('  Schreiben ' + rate + '/s', res, OPT.secs);
      console.log('    Push an andere Spieler: ' + pushLat.length + ' Zustellungen · ' + stat(pushLat) + ' (Senden → Empfang)');
    }
    console.log('  WebSockets unterwegs abgebrochen: ' + wsDrop);
  } catch (e) { console.log('  FEHLER: ' + e.message); }
  finally {
    for (const room of rooms) {
      for (const p of room.players) try { p.ws && p.ws.close(); } catch (e) { /* egal */ }
      await sleep(300);
      const r = await api('close', room.code, room.players[0].key, '', { uid: room.players[0].id });
      console.log('  Raum ' + room.code + ' geschlossen → ' + r.s);
    }
  }
}

(async () => {
  console.log('Ziel ' + BASE + ' · ' + new Date().toISOString());
  if (PHASES.includes('static')) await phaseStatic();
  if (PHASES.includes('api')) await phaseApi();
  if (PHASES.includes('rooms')) await phaseRooms();
  process.exit(0);
})();
