/* Bots im Mehrspieler-Raum: eigener Server (Port 3996, schnelle Bots) aus einer Wegwerf-Kopie von app/,
   simulierte Browser wie in sim.js. Prüft Rechte, Rollenverteilung, komplette Hände mit 2+2, 2+1 und 1+2
   (Mensch+Bots) inkl. Geben, Tipp und Aufdecken durch Bots, und dass der Server-Log fehlerfrei bleibt.
   Nutzung: node tests/mpbots.js <app-verzeichnis> */
'use strict';
const vm = require('vm'), fs = require('fs'), os = require('os'), path = require('path'), { spawn, execSync } = require('child_process');
const APP = path.resolve(process.argv[2] || path.join(__dirname, '..', 'app'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-bots-'));
execSync('cp -r "' + APP + '/." "' + TMP + '/"');
const PORT = 3996, BASE = 'http://127.0.0.1:' + PORT + '/';
const PUB = path.join(TMP, 'public');
let src = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const st0 = src.indexOf('<script>\n') + 9; src = src.slice(st0, src.indexOf('</script>', st0));
const HANDLIB = fs.readFileSync(path.join(PUB, 'hand.js'), 'utf8'), QRLIB = fs.readFileSync(path.join(PUB, 'qrcode.js'), 'utf8');
const hook = `globalThis.__kr={S:function(){return S;},main:main,hand:hand,phase:phase,stage:stage,parts:parts,chipOf:chipOf,
 takeChip:takeChip,toggleReady:toggleReady,startHand:startHand,setGuessCard:setGuessCard,confirmGuess:confirmGuess,canGuess:canGuess,
 revealMine:revealMine,createRoom:createRoom,joinRoom:joinRoom,uid:function(){return uid;},code:function(){return code;},
 myHand:function(){return myHand;},kickPlayer:kickPlayer,err:function(){return uiErr;},pmap:pmap,isHost:isHost,isReady:isReady,
 resolveHand:resolveHand,revealedCards:revealedCards,visibleBoard:visibleBoard,addBot:addBot,roleOrder:roleOrder,isBotP:isBotP,
 online:function(){return online;},driverId:driverId,hostId:hostId,watchRoom:watchRoom,jumpIn:jumpIn,replaceBot:replaceBot,
 watching:function(){return watching;},botifyStart:botifyStart,botNext:function(){if(botifyDlg){botifyDlg.step=2;render();}},botifyConfirm:botifyConfirm,note:function(){return uiNote;},isOnline:isOnline};\n`;
const cut = src.lastIndexOf('})();'); src = src.slice(0, cut) + hook + src.slice(cut);
let consoleErrors = 0;
function client(name) {
  const ls = {};
  const els = { name: { value: name }, code: { value: '' }, app: { innerHTML: '', className: '' }, roomlist: { innerHTML: '' },
    chat: { innerHTML: '', style: {} }, chatmsgs: { innerHTML: '', scrollTop: 0, scrollHeight: 0 }, chatin: { value: '' }, toast: { textContent: '', className: '', log: [] } };
  const con = Object.assign({}, console, { error: (...a) => { consoleErrors++; console.log('[' + name + '] console.error', ...a); }, warn() {} });
  const ctx = { console: con, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, btoa, atob, crypto: globalThis.crypto,
    fetch: (u, o) => (ctx.netOff ? Promise.reject(new Error('offline')) : fetch(BASE + u, o)), location: { pathname: '/', search: '', hash: '', origin: BASE.slice(0, -1), protocol: 'http:', host: '127.0.0.1:' + PORT, reload() {} },
    navigator: {}, history: { replaceState() {} },
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } },
    document: { getElementById: (id) => ((id === 'chatmsgs' || id === 'chatin') && !els.chat.innerHTML.includes('id="' + id + '"')) ? null : (els[id] || null),
      addEventListener() {}, hidden: false, documentElement: { setAttribute() {}, getAttribute() { return null; } } } };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(HANDLIB, ctx); vm.runInContext(QRLIB + ';this.qrcode=qrcode;', ctx); vm.runInContext(src, ctx);
  ctx.els = els; ctx.ls = ls; ctx.K = ctx.__kr; return ctx;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) throw new Error('FEHLER: ' + m); console.log('  ok  ' + m); };
async function until(f, what, ms = 60000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (f()) return; } catch (e) { /* weiter */ } await sleep(50); } throw new Error('Timeout: ' + what); }
const post = (a, code, body, key) => fetch(BASE + 'api?a=' + a + '&room=' + code, { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-kr-key': key || 'fremder-schluessel-1234567890' }, body: JSON.stringify(body) });
const bots = (X) => X.K.S().players.filter((p) => p.bot).map((p) => p.id);

/* Eine komplette Hand spielen: Menschen nehmen den Chip, der zu ihrer Einschätzung passt, klopfen, tippen, decken auf */
async function playHand(humans, label, onPlay, top, noClick) {
  const H0 = humans[0], h = H0.K.hand() + 1;
  H0.K.startHand();
  await until(() => humans.every((X) => X.K.phase() === 'play' && X.K.myHand() && X.K.myHand().hand === h), label + ': Karten gegeben (Bots haben mitgeteilt)');
  if (onPlay) await onPlay();
  ok(true, label + ': Geben klappt mit Bots in der Rolle');
  for (let st = 1; st <= 4; st++) {
    await until(() => H0.K.stage() === st && H0.K.phase() === 'play' && H0.K.visibleBoard().filter((c) => c != null).length === (st === 1 ? 0 : st + 1), label + ': Runde ' + st, 90000);
    const n = H0.K.parts().length;
    const t0 = Date.now();
    while (H0.K.phase() === 'play' && H0.K.stage() === st) {
      for (const X of humans) {
        if (X.K.phase() !== 'play' || X.K.stage() !== st) continue;
        const mine = X.K.chipOf(X.K.uid());
        if (top && st === 4 && mine !== n) { X.K.takeChip(n); continue; }     // besteht auf dem höchsten Chip → wird Ziel des Tipps
        if (!mine) {
          const e = X.estimateRank(X.K.myHand().cards, X.K.visibleBoard().filter((c) => c != null), n - 1, 2, 80);
          const free = []; for (let c = 1; c <= n; c++) { const d = X.K.S().chips[String(c)]; if (!(d && d.hand === h && d.holder)) free.push(c); }
          const pick = (free.length ? free : [Math.max(1, Math.min(n, Math.round(e)))]).sort((a, b) => Math.abs(a - e) - Math.abs(b - e))[0];
          X.K.takeChip(pick);
        } else if (!X.K.isReady(X.K.pmap()[X.K.uid()]) && X.K.parts().every((id) => X.K.chipOf(id))) X.K.toggleReady();
      }
      await sleep(250);
      if (Date.now() - t0 > 90000) throw new Error(label + ': Runde ' + st + ' hängt');
    }
  }
  await until(() => H0.K.phase() === 'guess' || H0.K.phase() === 'reveal', label + ': Tipp/Aufdecken');
  if (H0.K.phase() === 'guess') {
    const tgt = H0.K.main().target, gs = humans.filter((X) => X.K.canGuess());
    ok(true, label + ': Tipp auf ' + (H0.K.isBotP(tgt) ? 'Bot' : 'Mensch') + ', ' + gs.length + ' Mensch(en) tippen' + (gs.length ? '' : ' – Bots tippen selbst'));
    if (gs.length) { gs[0].K.setGuessCard(0, 12); await sleep(300); gs[0].K.setGuessCard(1, 11); await sleep(600); for (const X of gs) X.K.confirmGuess(); }
  }
  await until(() => H0.K.phase() === 'reveal', label + ': Aufdecken', 60000);
  const waits = []; let lastIdx = -1, since = Date.now(), sawCd = false;
  while (H0.K.phase() === 'reveal') {
    const idx = H0.K.main().revealIdx, cur = H0.K.main().revealOrder[idx];
    if (idx !== lastIdx) { if (lastIdx >= 0) waits.push(Date.now() - since); lastIdx = idx; since = Date.now(); }
    const X = humans.find((x) => x.K.uid() === cur);
    if (noClick && X && !sawCd && /data-a="reveal"[^]*id="revleft">\d+</.test(X.els.app.innerHTML) && humans.some((y) => y !== X && /Warten auf[^]*id="revleft">\d+</.test(y.els.app.innerHTML))) sawCd = true;
    if (!noClick && X && X.els.app.innerHTML.includes('data-a="reveal"')) X.K.revealMine();
    await sleep(200);
  }
  if (noClick) {
    waits.push(Date.now() - since);
    ok(sawCd, label + ': Countdown neben „Meine Karten aufdecken“ und bei den anderen neben „Warten auf …“');
    ok(waits.length === humans.length && waits.every((w) => w >= 9000 && w <= 13500), label + ': niemand klickt → alle decken nach ~10 s automatisch auf (' + waits.map((w) => (w / 1000).toFixed(1) + ' s').join(', ') + ')');
  }
  await until(() => H0.K.phase() === 'done' && H0.K.resolveHand(), label + ': Auflösung');
  const ps = H0.K.parts(), all = [];
  for (const id of ps) { const rv = H0.K.revealedCards(id); ok(rv && rv.length === 2, label + ': ' + (H0.K.isBotP(id) ? 'Bot ' : 'Mensch ') + H0.K.pmap()[id].name + ' aufgedeckt (überprüft): ' + rv.join(',')); all.push(...rv); }
  all.push(...H0.K.visibleBoard());
  ok(new Set(all).size === all.length && all.every((c) => c >= 0 && c < 52), label + ': alle ' + all.length + ' Karten verschieden und gültig');
  ok(/Alles richtig|Tipp daneben|Nicht ganz/.test(H0.els.app.innerHTML), label + ': Ergebnis angezeigt');
}

let srv;
(async () => {
  srv = spawn(process.execPath, ['server.js'], { cwd: TMP, env: Object.assign({}, process.env, { PORT: String(PORT), KR_BOT_SPEED: '0.15' }), stdio: 'ignore' });
  await sleep(800);
  const A = client('Anna'), B = client('Ben');
  await sleep(500);
  A.K.createRoom(); await until(() => A.K.code() && A.K.S().players.length === 1, 'Raum');
  const code = A.K.code();
  B.K.joinRoom(code); await until(() => A.K.S().players.length === 2, 'Ben im Raum');
  ok(/data-a="addbot"/.test(A.els.app.innerHTML) && !/data-a="addbot"/.test(B.els.app.innerHTML), 'Knopf „Bot hinzufügen“ nur beim Host');
  let r = await post('addbot', code, { uid: B.K.uid() }, B.ls['kr.sk']);
  ok(r.status === 403, 'Mitspieler darf keine Bots hinzufügen (403)');
  A.K.addBot(); await until(() => A.K.S().players.length === 3, 'Bot 1');
  A.K.addBot(); await until(() => A.K.S().players.length === 4 && B.K.S().players.length === 4, 'Bot 2');
  const [b1, b2] = bots(A);
  ok(b1 && b2 && /🤖/.test(A.els.app.innerHTML), 'Zwei Bots im Raum, mit 🤖 markiert');
  ok(A.K.online().includes(b1) && A.K.hostId() === A.K.uid() && A.K.driverId() === A.K.uid(), 'Bots gelten als anwesend, Host/Ablauf bleibt bei Anna');
  r = await post('set', code + '&path=players/' + b1, { name: 'Übernommen' }, B.ls['kr.sk']);
  ok(r.status === 403, 'Bot-Platz nicht übernehmbar (403)');
  r = await post('chip', code + '&n=1', { uid: b1, hand: 0, take: true }, B.ls['kr.sk']);
  ok(r.status === 403, 'Chip im Namen eines Bots nicht möglich (403)');
  const st = await (await fetch(BASE + 'api?a=state&room=' + code)).json();
  ok(!JSON.stringify(st).includes('"priv"') && !JSON.stringify(st).includes('"d":'), 'Private Bot-Schlüssel gehen nie an Browser');
  ok(!(st.idle || []).includes(b1), 'Für Bots kann man nicht einspringen');

  // Hand 1: 2 Menschen + 2 Bots → Rollen: 2 Menschen + 1 Bot
  await sleep(200);
  await playHandWithRoles([A, B], 'Hand 1 (2 Menschen + 2 Bots)');
  // Bot entfernen → 2 Menschen + 1 Bot
  A.K.kickPlayer(b2); await until(() => A.K.S().players.length === 3, 'Bot entfernt');
  ok(!bots(A).includes(b2), 'Host entfernt Bot');
  await playHandWithRoles([A, B], 'Hand 2 (2 Menschen + 1 Bot)', async () => {
    const r2 = await post('replacebot', code, { uid: 'dora-frueh', name: 'Früh', pub: { kty: 'EC' }, target: bots(A)[0] }, 'frueh-schluessel-000000001');
    ok(r2.status === 409, 'Bot-Platz während der Hand nicht übernehmbar (409)');
  });
  // Nach der Hand: echter Spieler übernimmt den Platz des Bots (über die Startseite)
  const emma = bots(A)[0], seat = A.K.pmap()[emma].joinedAt;
  await sleep(3200);
  const rl = await (await fetch(BASE + 'api?a=rooms')).json(), me = rl.rooms.find((x) => x.code === code);
  ok(me && me.free.some((f) => f.id === emma && f.bot), 'Nach der Hand: Raumliste zeigt Bot-Platz als frei');
  const D = client('Dora'); await sleep(600);
  await until(() => /data-a="jump"[^>]*data-id="/.test(D.els.roomlist.innerHTML) && D.els.roomlist.innerHTML.includes('🤖 einspringen'), 'Startseite: „Für … 🤖 einspringen“', 15000);
  ok(true, 'Startseite zeigt „↪ Für ' + A.K.pmap()[emma].name + ' 🤖 einspringen“');
  D.K.jumpIn(code, emma);
  await until(() => A.K.S().players.length === 3 && !bots(A).length && A.K.pmap()[D.K.uid()], 'Dora übernimmt');
  ok(!D.K.watching() && A.K.pmap()[D.K.uid()].joinedAt === seat && !A.K.pmap()[D.K.uid()].bot, 'Dora sitzt auf dem Platz des Bots, Bot ist weg');
  // Countdown sichtbar bei dem, der dran ist, und bei den anderen
  await playHandWithRoles([A, B, D], 'Hand 3 (Dora statt Bot, niemand klickt „Aufdecken“)', async () => {}, false, true);

  // 1 Mensch + 2 Bots: Bots verteilen selbst (Rollen A und B) und tippen, wenn der Mensch das Ziel ist
  const C = client('Cora'); await sleep(500);
  C.K.createRoom(); await until(() => C.K.code() && C.K.S().players.length === 1, 'Coras Raum');
  C.K.addBot(); await until(() => C.K.S().players.length === 2, 'Bot'); C.K.addBot(); await until(() => C.K.S().players.length === 3, 'Bot');
  await playHandWithRoles([C], 'Cora 1 (1 Mensch + 2 Bots)');
  await playHandWithRoles([C], 'Cora 2 (1 Mensch + 2 Bots, Cora hat den höchsten Chip)', null, true);
  const g = C.K.S().guess;
  ok(C.K.main().target === C.K.uid() && g && g.cards.every((x) => x != null) && Object.keys(g.confirmed || {}).length === 2, 'Bots tippen selbst, wenn nur Bots tippen können');

  // Offline-Spieler durch Bot ersetzen (Host, doppelte Bestätigung), Rückkehr und Platz zurückholen
  const E = client('Eva'), F = client('Fritz'); await sleep(500);
  E.K.createRoom(); await until(() => E.K.code() && E.K.S().players.length === 1, 'Evas Raum');
  const ec = E.K.code();
  F.K.joinRoom(ec); await until(() => E.K.S().players.length === 2, 'Fritz im Raum');
  E.K.addBot(); await until(() => E.K.S().players.length === 3, 'Bot bei Eva');
  const fid = F.K.uid(), eh = E.K.hand() + 1;
  E.K.startHand();
  await until(() => [E, F].every((X) => X.K.phase() === 'play' && X.K.myHand() && X.K.myHand().hand === eh), 'Hand bei Eva gegeben');
  ok(!/data-botify=/.test(E.els.app.innerHTML), 'Kein „ersetzen“, solange Fritz online ist');
  F.netOff = true;
  await until(() => !E.K.isOnline(fid), 'Fritz offline', 40000);
  await until(() => new RegExp('data-botify="' + fid + '"').test(E.els.app.innerHTML), 'Knopf „🤖 ersetzen“', 5000);
  ok(!/data-botify=/.test(F.els.app.innerHTML), 'Knopf „🤖 ersetzen“ beim Host neben dem Offline-Spieler');
  r = await post('botify', ec, { uid: E.K.uid(), target: fid }, E.ls['kr.sk']);
  ok(r.status === 409, 'Während der Hand nur mit Abbrechen (409)');
  r = await post('botify', ec, { uid: fid, target: E.K.uid(), abort: true }, F.ls['kr.sk']);
  ok(r.status === 403, 'Nur der Host darf ersetzen (403)');
  E.K.botifyStart(fid);
  ok(/durch einen Bot ersetzen\?/.test(E.els.app.innerHTML) && /laufende Hand wird dafür abgebrochen/.test(E.els.app.innerHTML) && /data-a="botnext"/.test(E.els.app.innerHTML) && !/data-a="botok"/.test(E.els.app.innerHTML), '1. Bestätigung: erklärt Folgen (Hand wird abgebrochen), „Weiter“');
  E.K.botNext();
  ok(/Wirklich ersetzen\?/.test(E.els.app.innerHTML) && /data-a="botok"/.test(E.els.app.innerHTML), '2. Bestätigung: „Ja, durch Bot ersetzen“');
  E.K.botifyConfirm();
  await until(() => E.K.isBotP(fid) && E.K.phase() === 'lobby', 'Fritz ersetzt, Hand abgebrochen', 15000);
  ok(E.K.pmap()[fid].name === 'Fritz' && E.K.S().players.length === 3, 'Fritz’ Platz: gleicher Name, jetzt Bot; Hand abgebrochen');
  r = await post('chip', ec + '&n=1', { uid: fid, hand: eh, take: true }, F.ls['kr.sk']);
  ok(r.status === 403, 'Altes Gerät kann nicht mehr im Namen des Platzes handeln');
  F.netOff = false;
  await until(() => F.K.watching() && /Platz an einen Bot gegeben/.test(F.K.note()), 'Hinweis bei Fritz', 15000);
  ok(F.K.code() === ec, 'Fritz kommt zurück: Hinweis, bleibt als Zuschauer im Raum');
  await playHandWithRoles([E], 'Eva + Bot-Fritz + Bot');
  await until(() => new RegExp('data-replace="' + fid + '"').test(F.els.app.innerHTML), '„Platz übernehmen“ bei Fritz', 10000);
  F.K.replaceBot(fid);
  await until(() => !E.K.isBotP(fid) && !F.K.watching(), 'Fritz zurück', 15000);
  ok(true, 'Nach der Hand holt Fritz seinen Platz zurück');
  await playHandWithRoles([E, F], 'Eva + Fritz (zurück) + Bot');

  const log = fs.readFileSync(path.join(TMP, 'logs', 'app.log'), 'utf8');
  const errs = log.split('\n').filter((l) => / ERROR /.test(l));
  ok(!errs.length, 'Server-Log ohne Fehler' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  ok(consoleErrors === 0, 'Keine Fehler in den Browsern');
  console.log('BOTS-TEST BESTANDEN');
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; })
  .finally(() => { try { srv.kill('SIGKILL'); } catch (e) { /* egal */ } fs.rmSync(TMP, { recursive: true, force: true }); process.exit(process.exitCode || 0); });

async function playHandWithRoles(humans, label, onPlay, top, noClick) {
  const X = humans[0], h = X.K.hand() + 1;
  // Rollen der kommenden Hand vorab ausrechnen (gleiche Formel wie Browser und Server)
  const ps = X.K.S().players.map((p) => p.id), isB = (id) => X.K.isBotP(id);
  const rot = (a) => { const k = a.length ? h % a.length : 0; return a.slice(k).concat(a.slice(0, k)); };
  const roles = rot(ps.filter((id) => !isB(id))).concat(rot(ps.filter(isB))).slice(0, 3);
  const nb = roles.filter(isB).length, nh = ps.filter((id) => !isB(id)).length;
  ok(nh >= 2 ? nb <= 1 : nb === 3 - nh, label + ': Rollen Mischen/Verteilen = ' + roles.map((id) => (isB(id) ? 'Bot' : 'Mensch')).join('/') + (nh >= 2 ? ' (Server kann keine Menschen-Karte lesen)' : ''));
  await playHand(humans, label, onPlay, top, noClick);
}
