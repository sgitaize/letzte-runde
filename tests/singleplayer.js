/* Übungsraum (Einzelspieler gegen Bots): läuft ohne Server. Prüft Bot-Verhalten, Ablauf über 4 Runden,
   Auswertung, Statistik und dass keine Anfrage an den Server geht.
   Nutzung: node tests/singleplayer.js app/public/index.html */
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path');
let src = fs.readFileSync(process.argv[2], 'utf8');
const st0 = src.indexOf('<script>\n') + 9; src = src.slice(st0, src.indexOf('</script>', st0));
const HANDLIB = fs.readFileSync(path.join(path.dirname(process.argv[2]), 'hand.js'), 'utf8');
const QRLIB = fs.readFileSync(path.join(path.dirname(process.argv[2]), 'qrcode.js'), 'utf8');
const hook = `globalThis.__kr={sp:function(){return sp;},spStart:spStart,spTake:spTake,spReady:spReady,spNewHand:spNewHand,
 spEstimate:spEstimate,spSetBots:spSetBots,spGuessSet:spGuessSet,spGuessConfirm:spGuessConfirm,spTick:spTick,spTakeFor:spTakeFor,spToggleLearn:spToggleLearn,sendReact:sendReact,statsPanel:statsPanel,spStage:spStage,
 setSpeed:function(v){spSpeed=v;},bestHand:bestHand,cmpHand:cmpHand,leave:leave,roomsHtml:roomsHtml,uid:function(){return uid;}};\n`;
const i = src.lastIndexOf('})();'); src = src.slice(0, i) + hook + src.slice(i);

let fetches = 0, errors = 0, reloads = 0; const fetchUrls = [];
const ls = {};
const els = { name: { value: 'Sina' }, code: { value: '' }, app: { innerHTML: '', className: '' }, roomlist: { innerHTML: '' },
  chat: { innerHTML: '', style: {} }, toast: { textContent: '', className: '', log: [] } };
Object.defineProperty(els.toast, 'textContent', { get() { return this._t || ''; }, set(v) { this._t = v; this.log.push(v); } });
const con = Object.assign({}, console, { error: (...a) => { errors++; console.log('console.error:', ...a); } });
const ctx = { console: con, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, btoa, atob, crypto: globalThis.crypto,
  fetch: (u) => { fetches++; fetchUrls.push(String(u)); return Promise.reject(new Error('kein Server')); },
  location: { pathname: '/', search: '', hash: '', origin: 'http://x', protocol: 'http:', host: 'x', reload() { reloads++; } }, navigator: {}, history: { replaceState() {} },
  localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } },
  document: { getElementById: (id) => els[id] || null, addEventListener() {}, hidden: false, documentElement: { setAttribute() {}, getAttribute() { return null; } } } };
ctx.window = ctx; vm.createContext(ctx); vm.runInContext(HANDLIB, ctx); vm.runInContext(QRLIB + ';this.qrcode=qrcode;', ctx); vm.runInContext(src, ctx);
const X = ctx.__kr;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) throw new Error('FEHLER: ' + m); console.log('  ok  ' + m); };
async function until(f, what, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (f()) return; } catch (e) { /* weiter */ } await sleep(20); } throw new Error('Timeout: ' + what); }
const cd = (s) => '23456789TJQKA'.indexOf(s[0]) + 13 * 'shdc'.indexOf(s[1]);
const bots = () => X.sp().players.filter((p) => p.bot);
const settled = () => X.sp().players.filter((p) => p.bot).every((p) => X.sp().chips[p.id] && X.sp().ready[p.id]);
const holder = (n) => Object.keys(X.sp().chips).find((k) => X.sp().chips[k] === n) || null;

(async () => {
  await sleep(300);
  ok(/data-a="sp"/.test(X.roomsHtml()) && /Übungsraum/.test(X.roomsHtml()), 'Startseite: Übungsraum immer in der Raumliste');
  ok(/class="brand" data-a="reload"/.test(els.app.innerHTML), 'Startseite: Logo lädt die Seite neu');
  const f0 = fetches;
  X.setSpeed(0.03);
  X.spStart();
  const S = X.sp;
  ok(S() && S().players.length === 4 && S().phase === 'play' && S().stage === 1, 'Übungsraum startet: du + 3 Bots, Runde 1');
  ok(/Übungsraum/.test(els.app.innerHTML) && /data-chip="4"/.test(els.app.innerHTML), 'Ansicht mit Tisch, Chips und Spielern');
  ok(/class="brand sm" data-a="reload"/.test(els.app.innerHTML), 'Übungsraum: Logo lädt die Seite neu');
  ok(/Mitspieler:/.test(els.app.innerHTML) && /data-a="spbots" data-n="5"/.test(els.app.innerHTML), 'Auswahl der Mitspieler im Kopf sichtbar');
  X.spSetBots(4); ok(S().players.length === 5 && S().stage === 1, 'Runde 1 ohne eigenen Chip: 4 Bots gelten sofort');
  S().stage = 2; X.spSetBots(2);
  ok(S().players.length === 5 && /ab der nächsten Hand 3 Spieler/.test(els.app.innerHTML), 'Mitten in der Hand: Hinweis „ab der nächsten Hand“');
  X.spNewHand(); ok(S().players.length === 3, 'Nächste Hand mit 2 Bots');
  X.spSetBots(3);

  // Einschätzung: Monte-Carlo trennt starke und schwache Hände
  S().stage = 1; S().hole.me = [cd('As'), cd('Ah')];
  let t0 = Date.now(); const strong = X.spEstimate('me', 300); const ms = Date.now() - t0;
  S().hole.me = [cd('7c'), cd('2d')];
  const weak = X.spEstimate('me', 300);
  ok(strong > 3.2 && weak < 2.2, 'Einschätzung: A-A → Rang ' + strong.toFixed(2) + ', 7-2 → Rang ' + weak.toFixed(2) + ' (von 4)');
  ok(ms < 1500, 'Einschätzung schnell genug (' + ms + ' ms für 300 Durchläufe)');
  X.spNewHand();

  // Bots nehmen allein Chips, alle verschieden, und klopfen
  await until(settled, 'Bots bereit');
  const bc = bots().map((p) => S().chips[p.id]);
  ok(new Set(bc).size === 3 && !S().chips.me, 'Bots nehmen 3 verschiedene Chips und klopfen (' + bc.join(',') + '), ohne dich startet nichts');
  await sleep(200); ok(S().stage === 1 && !S().cd, 'Ohne deinen Chip kein Countdown');

  // Fest gelegte Hand (Screenshot 2026-09-23): du D♦ 3♥ (Drilling), Ole K♠ 6♠ (Könige+Damen), Ida 9♥ 7♥ (Damen+Siebenen),
  // Lea 3♠ 8♣ (nur Damen vom Tisch). Tisch D♣ D♠ 7♣ K♦ 2♦. Du nimmst die 4 → Bots müssen 3/2/1 richtig verteilen.
  function setup(hands, board) {
    X.spNewHand();
    const s = S(); s.hole.me = hands.me; bots().forEach((p, k) => { s.hole[p.id] = hands.b[k]; });
    s.board = board; X.spStage(4); return s;
  }
  const SHOT = { me: [cd('Qd'), cd('3h')], b: [[cd('Ks'), cd('6s')], [cd('9h'), cd('7h')], [cd('3s'), cd('8c')]] };
  const SHOT_BOARD = [cd('Qc'), cd('Qs'), cd('7c'), cd('Kd'), cd('2d')];
  /* Wie ein Mensch: Chip n nehmen und darauf bestehen, bis die Bots ihn lassen; zählt, wie oft er weggenommen wurde */
  async function insist(n, what) {
    let lost = 0;
    X.spTake(n);
    for (;;) {
      await until(() => settled(), what);
      if (S().chips.me === n) return lost;
      lost++; X.spTake(n);
    }
  }
  let right = 0;
  for (let trial = 0; trial < 10; trial++) {
    setup(SHOT, SHOT_BOARD);
    const lost = await insist(4, 'Bots eingeordnet');
    const got = bots().map((p) => S().chips[p.id]).join('/');
    if (got === '3/2/1') right++;
    console.log('       Screenshot-Hand, Durchlauf ' + (trial + 1) + ': Ole/Ida/Lea → ' + got + (got === '3/2/1' ? ' ✓' : '') + (lost ? ' (4 wurde dir ' + lost + '× weggenommen)' : ''));
  }
  ok(right >= 8, 'Screenshot-Hand: Bots ordnen sich hinter dir richtig ein (' + right + ' von 10)');

  // Absprache hält über die Runden: Runde 2 um die 4 gekämpft, Runde 3 ändert nichts → kein neuer Kampf
  // Du 7♣ 7♦ (Drilling), Bot 1 K♥ K♦ (Drilling Könige – will eigentlich die 4), Bot 2 D♣ B♣, Bot 3 4♠ 5♥; Tisch 7♥ K♠ 2♦ | 9♣ (ändert nichts)
  let kept = 0, noFight = 0;
  for (let trial = 0; trial < 6; trial++) {
    X.spNewHand();
    const s = S(); s.hole.me = [cd('7c'), cd('7d')];
    const bb = bots(); s.hole[bb[0].id] = [cd('Kh'), cd('Kd')]; s.hole[bb[1].id] = [cd('Qc'), cd('Jc')]; s.hole[bb[2].id] = [cd('4s'), cd('5h')];
    s.board = [cd('7h'), cd('Ks'), cd('2d'), cd('9c'), cd('3h')];
    X.spStage(2);
    await insist(4, 'Runde 2 ausgehandelt');
    const r2 = bb.map((p) => S().chips[p.id]).join('/');
    X.spReady(); await until(() => S().stage === 3, 'Runde 3');
    const t0 = els.toast.log.length;
    X.spTake(4);
    await until(() => settled(), 'Runde 3 eingeordnet');
    await sleep(40);
    const fights = els.toast.log.slice(t0).filter((m) => /hat dir Chip/.test(m)).length;
    const r3 = bb.map((p) => S().chips[p.id]).join('/');
    if (!fights) noFight++;
    if (r3 === r2 && S().chips.me === 4) kept++;
    console.log('       Absprache, Durchlauf ' + (trial + 1) + ': Runde 2 ' + r2 + ' → Runde 3 ' + r3 + (fights ? ' (' + fights + '× um die 4 gekämpft)' : ' (kein Kampf)'));
  }
  ok(noFight >= 5, 'Runde 3: kein neuer Kampf um deinen Chip, wenn sich nichts geändert hat (' + noFight + ' von 6)');
  ok(kept >= 5, 'Runde 3: alle bleiben bei den Chips aus Runde 2 (' + kept + ' von 6)');

  // Klar stärkste Hand: Bot mit Vierling holt sich die 4 zurück, gibt aber irgendwann nach
  let backs = 0, maxBacks = 0;
  for (let trial = 0; trial < 8; trial++) {
    const s = setup({ me: [cd('2c'), cd('7d')], b: [[cd('9s'), cd('9h')], [cd('4c'), cd('5d')], [cd('3s'), cd('6c')]] },
      [cd('9c'), cd('9d'), cd('Jh'), cd('Ks'), cd('2h')]);
    const strong = bots()[0];
    await until(() => settled(), 'Bots bereit');
    const n = S().chips[strong.id];
    let took = 0;
    for (let k = 0; k < 6; k++) {
      X.spTake(n);
      await until(() => S().chips[strong.id] && settled(), 'Bot reagiert');
      if (S().chips[strong.id] === n) took++; else break;
    }
    if (took) backs++; maxBacks = Math.max(maxBacks, took);
    console.log('       Vierling, Durchlauf ' + (trial + 1) + ': ' + strong.name + ' (Sturheit ' + strong.stub + ') holt Chip ' + n + ' ' + took + '× zurück' + (S().chips.me === n ? ', gibt dann nach' : ''));
  }
  ok(backs >= 3, 'Mit klar bester Hand holt sich der Bot den Chip zurück (' + backs + ' von 8)');
  ok(maxBacks <= 4, 'Aber nicht endlos (höchstens ' + maxBacks + '× hintereinander)');

  // Trefferquote in Runde 4 bei Zufallshänden, wenn du deinen richtigen Platz nimmst
  let good = 0; const RUNS = 20;
  for (let trial = 0; trial < RUNS; trial++) {
    X.spNewHand(); X.spStage(4);
    const s = S(), strength = (id) => X.bestHand(s.hole[id].concat(s.board), s.hole[id]);
    const ids = s.players.map((p) => p.id), rank = (id) => 1 + ids.filter((o) => o !== id && X.cmpHand(strength(o), strength(id)) < 0).length;
    await insist(rank('me'), 'eingeordnet');
    const ok4 = ids.every((a) => ids.every((b) => !(S().chips[a] < S().chips[b] && X.cmpHand(strength(a), strength(b)) > 0)));
    if (ok4) good++;
  }
  ok(good >= RUNS * 0.8, 'Runde 4, Zufallshände: Bots ordnen sich in ' + good + ' von ' + RUNS + ' Fällen komplett richtig ein');

  // Komplette Hände spielen: du nimmst den Chip, der zu deiner Hand passt
  async function playHand(expectBots) {
    X.spNewHand();
    ok(S().players.length === expectBots + 1, 'Hand ' + S().hand + ': du + ' + expectBots + ' Bots');
    for (let stg = 1; stg <= 4; stg++) {
      await until(() => S().stage === stg && S().phase === 'play', 'Runde ' + stg);
      const n = S().players.length, e = X.spEstimate('me', 120);
      let want = Math.max(1, Math.min(n, Math.round(e)));
      await until(() => Object.keys(S().chips).length >= n - 1 || !holder(want), 'Chips verteilt');
      if (!holder(want) || holder(want) !== 'me') X.spTake(want);
      await until(() => settled() || S().stage !== stg, 'Bots haben Chips');
      if (!S().chips.me) { const free = [...Array(n).keys()].map((x) => x + 1).find((c) => !holder(c)); X.spTake(free); await until(settled, 'nachgezogen'); }
      if (S().stage === stg && !S().ready.me) X.spReady();
      await until(() => S().stage > stg || S().phase !== 'play', 'Runde ' + stg + ' fertig');
    }
    if (S().phase === 'guess') {
      if (S().target === 'me') { ok(/tippen jetzt deine/.test(els.app.innerHTML), 'Du hast den höchsten Chip → Bots tippen'); }
      else { for (let k = 0; k < S().K; k++) X.spGuessSet(k, 12 - k); X.spGuessConfirm(); }
    }
    await until(() => S().phase === 'done', 'Auflösung');
    // unabhängige Prüfung
    const h4 = S().hist[4], ps = S().players.map((p) => ({ id: p.id, chip: h4[p.id], h: X.bestHand(S().hole[p.id].concat(S().board), S().hole[p.id]) }));
    let win = true;
    for (const a of ps) for (const b of ps) if (a.chip < b.chip && X.cmpHand(a.h, b.h) > 0) win = false;
    ok(S().res.orderOk === win && S().res.win === (win && (!S().gr || S().gr.hits === S().gr.of)) && new Set(Object.values(h4)).size === ps.length, 'Hand ' + S().hand + ': Auswertung stimmt (' + (win ? 'Alles richtig' : S().res.bad + ' falsch') + ')');
    ok(/Auflösung/.test(els.app.innerHTML) && /Neue Hand/.test(els.app.innerHTML) && /Händen richtig/.test(els.app.innerHTML), 'Auflösung mit allen Karten, Neue Hand, Statistik-Zeile');
    ok(/<div class="endbar">.*(Alles richtig|Tipp daneben|Nicht ganz).*data-a="spnext"/.test(els.app.innerHTML) && els.app.innerHTML.lastIndexOf('class="endbar"') > els.app.innerHTML.lastIndexOf('Auflösung'),
      'Leiste „Neue Hand ▶“ mit Ergebnis am Seitenende (klebt unten)');
    { const h = els.app.innerHTML, a = h.indexOf('p-board'), b = h.indexOf('p-reveal'), c = h.indexOf('p-mine');
      ok(a >= 0 && a < b && b < c, 'Auflösung unter dem Tisch und über deiner Hand'); }
  }
  await playHand(3);
  X.spSetBots(5); await playHand(5);
  X.spSetBots(2); await playHand(2);
  // Chip weggenommen → großes Popup, verschwindet von selbst
  X.spNewHand(); X.spTake(2); X.spTakeFor(bots()[0].id, 2);
  ok(/class="steal-pop"[^]*hat dir Chip 2 genommen/.test(els.app.innerHTML), 'Großes Popup, wenn dir ein Bot den Chip wegnimmt');
  await sleep(1800); ok(!/class="steal-pop"/.test(els.app.innerHTML), 'Popup verschwindet nach 1,6 s von selbst');
  X.sendReact(0); ok(/class="react-pop"[^>]*>👍/.test(els.app.innerHTML), 'Reaktion 👍 im Übungsraum');
  // Lernmodus
  ok(/data-a="splearn"/.test(els.app.innerHTML) && !/class="panel coach/.test(els.app.innerHTML), 'Knopf „🎓 Lernmodus“, standardmäßig aus');
  X.spToggleLearn(); X.spNewHand(); await sleep(50);
  { const h = els.app.innerHTML;
    ok(/class="panel coach p-coach /.test(h) && /passender Chip: <b class="coachchip">\d<\/b>/.test(h) && /Nimm die <b>\d<\/b>/.test(h), 'Lernmodus: Einschätzung + passender Chip, bevor du einen nimmst');
    ok(h.indexOf('coach-l') > h.indexOf('p-board') && h.indexOf('coach-l') < h.indexOf('p-mine') && h.indexOf('coach-r') < h.indexOf('p-players'), 'Lernmodus-Kasten direkt unter dem Tisch'); }
  { const n = S().players.length, sug = +/coachchip">(\d)/.exec(els.app.innerHTML)[1], bad = sug <= n / 2 ? n : 1;
    X.spTake(bad); await sleep(30);
    ok(Math.abs(bad - sug) < 2 || /class="coachwarn"/.test(els.app.innerHTML), 'Lernmodus warnt bei unpassendem Chip (Chip ' + bad + ', passend ' + sug + ')'); }
  await playHand(S().players.length - 1);
  ok(/class="panel coach p-coach /.test(els.app.innerHTML) && /(Du lagst richtig|passte nicht)/.test(els.app.innerHTML) && /Deine Chips je Runde/.test(els.app.innerHTML), 'Lernmodus erklärt nach der Hand (richtig/warum falsch, Chips je Runde)');
  X.spToggleLearn(); ok(!/class="panel coach/.test(els.app.innerHTML), 'Lernmodus lässt sich ausschalten');
  const stats = JSON.parse(ls['kr.sp.stats'] || '[]');
  ok(stats.every((e) => e.players.every((p) => Array.isArray(p.rounds) && p.rounds.length === 4)), 'Übungsraum: Treffer je Runde gespeichert');
  ok(/Deine Treffsicherheit/.test(X.statsPanel(stats)), 'Übungsraum: Treffsicherheit je Runde in der Statistik');
  ok(stats.length === 4 && stats.every((e) => e.players.some((p) => p.id === X.uid())), 'Statistik lokal gespeichert (4 Hände, du mit deiner ID)');
  ok(ls['kr.sp.bots'] === '2', 'Bot-Anzahl gemerkt');
  const spCalls = fetchUrls.slice(f0);
  ok(spCalls.length > 0 && spCalls.every((u) => /\?a=sphand$/.test(u)), 'Übungsraum fragt den Server nur für den Zähler an (' + spCalls.length + '× sphand, sonst nichts)');
  X.leave(); ok(!S() && /Übungsraum/.test(els.app.innerHTML), 'Verlassen → Startseite');
  ok(errors === 0, 'Keine Fehler in der Konsole');
  console.log('EINZELSPIELER-TEST BESTANDEN'); process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
