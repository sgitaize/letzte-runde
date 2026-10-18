/* Screenshots der neuen Funktionen (Version 1.1) in echtem Chromium – für den Blick ins Repo ohne Gerät.
   Startet einen Server (Port 3975) mit signiertem Spiel-Bundle (neuere Spiellogik) und einen App-Host (Port 3955), der
   „online“ auf diesen Server zeigt, und fotografiert: Update-Hinweis und -Dialog in der App, „Nächster Schritt“-Leiste,
   Tipp-Vorschläge (auch der Bots, auch am Tisch-Bildschirm), private Räume, „Du bist hier“, Konto-Seite, Unterstützen,
   Admin. Nutzung: node --experimental-websocket tests/shot-features.js <ausgabe-ordner>   (CHROME=<pfad>, Standard chromium) */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const OUT = path.resolve(process.argv[2] || '/tmp/kr-features');
const APP = path.join(__dirname, '..', 'app');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-feat-'));
const SRV = path.join(TMP, 'srv'), APPD = path.join(TMP, 'app');
for (const d of [SRV, APPD]) { execSync('cp -r "' + APP + '/." "' + d + '/"'); for (const x of ['data', 'logs', 'tmp', 'bundle.json']) fs.rmSync(path.join(d, x), { recursive: true, force: true }); }
fs.mkdirSync(OUT, { recursive: true });
const PORT = 3975, APORT = 3955, BASE = 'http://127.0.0.1:' + PORT + '/', ABASE = 'http://127.0.0.1:' + APORT + '/', SECRET = 'shot-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];

/* Server: Spiellogik 3 als Bundle (die App hat 2 eingebaut) */
const KEY = path.join(TMP, 'key.pem'), env = Object.assign({}, process.env, { KR_BUNDLE_KEY: KEY });
execSync(process.execPath + ' scripts/bundle.js keygen', { cwd: SRV, env });
fs.copyFileSync(path.join(SRV, 'bundle-key.pub'), path.join(APPD, 'bundle-key.pub'));
fs.writeFileSync(path.join(APPD, 'bundle.json'), JSON.stringify({ build: 1000 }));
const hf = path.join(SRV, 'public', 'hand.js');
fs.writeFileSync(hf, fs.readFileSync(hf, 'utf8').replace(/var LOGIC_VERSION=\d+;/, 'var LOGIC_VERSION=3;'));
execSync(process.execPath + ' scripts/bundle.js build', { cwd: SRV, env });

async function cdp(port) {
  procs.push(spawn(process.env.CHROME || 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(TMP, 'chr' + port), 'about:blank'], { stdio: 'ignore' }));
  for (let i = 0; i < 60; i++) { try { await (await fetch('http://127.0.0.1:' + port + '/json')).json(); return; } catch (e) { await sleep(200); } }
}
async function tab(port, url) {
  const t = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const wait = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } });
  /* jede Anfrage mit Zeitgrenze – eine verlorene Antwort hält sonst das ganze Skript an */
  const send = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    setTimeout(() => { if (wait.has(i)) { wait.delete(i); r({ error: 'timeout' }); } }, method === 'Page.captureScreenshot' ? 20000 : 8000); });
  const js = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };
  const T = {
    send, js,
    click: (sel) => { if (process.env.TRACE) console.log('    klick ' + sel); return js('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');if(e){e.click();return true;}return false;})()'); },
    until: async (e, ms) => { if (process.env.TRACE) console.log('    warte ' + e.slice(0, 70)); const t0 = Date.now(); while (Date.now() - t0 < (ms || 30000)) { if (await js(e)) return true; await sleep(250); } throw new Error('Timeout: ' + e); },
    size: (w, h, dsf) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dsf || 2, mobile: w < 700 }),
    shot: async (name, opt) => {
      opt = opt || {};
      await send('Page.bringToFront');   // Hintergrund-Tabs liefern sonst manchmal kein Bild
      if (opt.scroll) await js('(function(){var e=document.querySelector(' + JSON.stringify(opt.scroll) + ');if(e)e.scrollIntoView({block:"' + (opt.block || 'start') + '"});return 1;})()');
      await sleep(opt.wait || 500);
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
      console.log('  ' + name + '.png');
    }
  };
  await send('Page.enable');
  return T;
}
const api = async (a, q, body, key) => (await fetch(BASE + 'api?a=' + a + (q || ''), { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-kr-key': key || 'shot-key-0123456789abcdef', 'x-kr-logic': '3' }, body: body ? JSON.stringify(body) : undefined })).json();
const admin = (body) => fetch(BASE + 'admin-api?a=config', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-secret': SECRET }, body: JSON.stringify(body) });

(async () => {
  procs.push(spawn(process.execPath, ['server.js'], { cwd: SRV, env: Object.assign({}, process.env, { PORT: String(PORT), ADMIN_SECRET: SECRET, KR_BOT_SPEED: '0.35' }), stdio: 'ignore' }));
  await sleep(1200);
  await admin({ donateUrl: 'https://paypal.me/beispiel/{betrag}EUR' });
  procs.push(spawn(process.execPath, [path.join(APPD, 'app-host.js')], { cwd: TMP, stdio: 'ignore', env: Object.assign({}, process.env, {
    KR_APP_PORT: String(APORT), KR_LAN_PORT: '3958', KR_APP_TOKEN: 'tok', KR_VAR_DIR: path.join(TMP, 'var'), KR_PUBLIC: path.join(APPD, 'public'),
    KR_UPSTREAM: BASE.slice(0, -1), KR_LEADER_SOCK: path.join(TMP, 'l.sock'), KR_PLATFORM: 'android', KR_APP_VERSION: '1.0.0' }) }));
  await cdp(9351);

  /* ---- App: Update der Spiellogik beim Start ---- */
  console.log('App (Update der Spiellogik):');
  const A = await tab(9351, 'about:blank');
  await A.size(390, 844);
  await A.send('Page.navigate', { url: ABASE });
  await A.until('!!document.querySelector(\'[data-a="bapply"]\')', 30000);
  await A.shot('01-app-update-dialog');
  await A.click('[data-a="blater"]');
  await A.shot('02-app-update-banner', { wait: 800 });
  await A.click('[data-a="bshow"]'); await sleep(300);
  await A.click('[data-a="bapply"]');
  await A.until('window.KR_APP&&KR_APP.logic===3&&!!document.querySelector(".sitefoot")', 30000);
  await A.shot('03-app-nach-update-fusszeile', { scroll: '.sitefoot', block: 'end' });
  await admin({ minLogic: 4 });   // Server verlangt eine Logik, die es (noch) nicht gibt → Hinweis „Update nötig“ (hier ohne Bundle)
  await A.js('location.reload();1'); await sleep(3500);
  await A.shot('04-app-online-raum-mit-alter-logik', { wait: 300 });
  await admin({ minLogic: 0 });

  /* ---- Browser: Startseite, Raum mit Bots, „Nächster Schritt“, Tipp-Vorschläge ---- */
  console.log('Browser:');
  const W = await tab(9351, 'about:blank');
  await W.size(390, 844);
  await W.send('Page.navigate', { url: BASE });
  await W.until('!!document.querySelector(\'[data-a="create"]\')');
  await W.js('document.getElementById("name").value="Simon";document.getElementById("rname").value="Freitagsrunde";1');
  await W.shot('05-start-privat-und-unterstuetzen', { scroll: '#rpriv', block: 'center' });
  await W.click('[data-a="create"]');
  await W.until('!!document.querySelector(\'[data-a="addbot"]\')');
  for (let i = 0; i < 3; i++) { await W.click('[data-a="addbot"]'); await sleep(900); }
  await W.until('document.querySelectorAll(".p-players .pl").length>=4');
  await W.shot('06-raum-lobby-naechster-schritt');
  await W.click('[data-a="invite"]'); await sleep(400);
  await W.click('[data-a="rpriv"]'); await sleep(900);
  await W.shot('07-raum-privat-einladen', { scroll: '.invite' });
  await W.click('[data-a="invite"]');
  const code = await W.js('localStorage.getItem("kr.room")');
  /* Tisch-Bildschirm (Tablet quer) im selben Raum */
  const TV = await tab(9351, 'about:blank');
  await TV.size(1180, 820, 1);
  await TV.send('Page.navigate', { url: BASE + '?tisch=' + code });

  /* Hände spielen, bis ein Bot den höchsten Chip hat und wir tippen; Chips aus der Mitte nehmen, dann klopfen */
  let shotPlay = false, shotReady = false, gotGuess = false;
  for (let hand = 0; hand < 6 && !gotGuess; hand++) {
    await W.click('[data-a="start"]');
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      const st = await W.js('(function(){var t=document.body.innerText;return /Tippt gemeinsam|Tipp auf .* bestätigen/.test(t)?"guess":/deine Karten/.test(t)&&/tippen/.test(t)?"target":/Neue Hand ▶/.test(t)?"done":/Nimm einen Chip/.test(t)?"take":/passt\\? Dann klopfen/.test(t)?"ready":"wait";})()');
      if (st === 'guess') { gotGuess = true; break; }
      if (st === 'done') break;
      if (st === 'take') {
        if (!shotPlay) { shotPlay = true; await W.shot('08-raum-naechster-schritt-chip'); await W.click('[data-a="jumpto"]'); await sleep(450); await W.shot('09-raum-sprung-zu-den-chips', { wait: 100 }); }
        await W.js('(function(){var c=document.querySelector(".p-chips [data-chip]");if(c)c.click();return 1;})()');
      }
      if (st === 'ready') {
        if (!shotReady) { shotReady = true; await W.shot('10-raum-naechster-schritt-bereit'); }
        await W.click('.endbar.next [data-a="ready"]');
      }
      await sleep(400);
    }
    if (!gotGuess) { await W.until('/Neue Hand ▶/.test(document.body.innerText)||/Tippt gemeinsam/.test(document.body.innerText)', 90000).catch(() => {}); }
  }
  if (gotGuess) {
    await W.until('document.querySelectorAll(".sugs .sug").length>=2', 30000).catch(() => {});
    await W.js('(function(){var b=document.querySelectorAll("[data-grank]");if(b[12])b[12].click();return 1;})()'); await sleep(600);
    await W.js('(function(){var b=document.querySelectorAll("[data-grank]");if(b[11])b[11].click();return 1;})()'); await sleep(900);
    await W.shot('11-raum-tipp-vorschlaege-bots', { scroll: '.p-guess' });
    await W.shot('12-raum-tipp-naechster-schritt', { scroll: '.endbar.next', block: 'end' });
    await TV.shot('13-tisch-tipp-vorschlaege');
    await W.click('.endbar.next [data-a="confirm"]');
  } else console.log('  (kein Tipp-Bild: Tipp kam in 6 Händen nicht zustande)');
  await TV.send('Page.navigate', { url: 'about:blank' });
  await W.until('/Neue Hand ▶/.test(document.body.innerText)', 120000).catch(() => {});
  await W.shot('14-raum-ergebnis-server', { scroll: '.p-reveal' });
  await W.click('[data-a="notable"]'); await sleep(400);
  await W.shot('15-raum-tisch-knopf');
  await W.click('[data-a="notable"]');

  /* Startseite: „Du bist hier“ (wir sitzen im Raum), zweiter öffentlicher Raum, Unterstützen */
  await api('create', '&room=ZZPUB', { hostId: 'u-ole', name: 'Spieleabend' }, 'ole-key-0123456789abcdef');
  await api('set', '&room=ZZPUB&path=players/u-ole', { name: 'Ole' }, 'ole-key-0123456789abcdef');
  await api('roomopt', '&room=' + code, { uid: await W.js('localStorage.getItem("kr.uid")'), private: false }, await W.js('localStorage.getItem("kr.sk")'));
  await W.click('[data-a="leave"]');
  await W.until('!!document.querySelector(".pl.here")', 30000);
  await W.shot('16-start-du-bist-hier', { scroll: '#roomlist' });
  await W.click('.donatebar [data-a="donate"]'); await sleep(400);
  await W.shot('17-unterstuetzen-web');
  await W.click('[data-a="donateclose"]');

  /* Singleplayer: Leiste und Tipp-Vorschläge der Bots */
  await W.click('[data-a="sp"]');
  await W.until('/Nimm einen Chip/.test(document.body.innerText)');
  await W.shot('18-singleplayer-naechster-schritt');
  let spGuess = false;
  for (let k = 0; k < 400 && !spGuess; k++) {
    const t = await W.js('document.body.innerText');
    if (/Mein Tipp:/.test(t) && /Vorschläge/.test(t)) { spGuess = true; break; }
    if (/Neue Hand ▶/.test(t)) { await W.click('.endbar [data-a="spnext"]'); await sleep(500); continue; }
    if (/Tippe die Karten/.test(t)) { await sleep(500); continue; }
    if (/Bots tippen deine/.test(t)) { await sleep(500); continue; }
    if (/Nimm einen Chip/.test(t)) await W.js('(function(){var c=document.querySelectorAll(".p-chips [data-chip]");if(c.length)c[0].click();return 1;})()');
    else if (/passt\? Dann klopfen/.test(t)) await W.click('.endbar.next [data-a="ready"]');
    await sleep(350);
  }
  if (spGuess) { await sleep(1500); await W.shot('19-singleplayer-bot-vorschlaege', { scroll: '.p-guess' }); }
  await W.click('[data-a="leave"]'); await sleep(500);

  /* Konto-Seite */
  await api('acct.register', '', { name: 'Simon', pw: 'kartenrunde-2026' });
  await W.js('fetch("api?a=acct.login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"Simon",pw:"kartenrunde-2026"})}).then(function(r){return r.json()}).then(function(r){localStorage.setItem("kr.acct",JSON.stringify({id:r.account.id,name:r.account.name}));location.reload();})');
  await sleep(3000);
  await W.click('[data-a="acct"]'); await sleep(1500);
  await W.shot('20-konto-statistik');
  await W.click('[data-a="accttab"][data-t="pl"]'); await sleep(1200);
  await W.shot('21-konto-plaetze');
  await W.click('[data-a="accttab"][data-t="set"]'); await sleep(500);
  await W.shot('22-konto-einstellungen');

  /* Admin */
  const AD = await tab(9351, 'about:blank');
  await AD.size(1180, 1100, 1);
  await AD.send('Page.navigate', { url: BASE + 'admin.html' });
  await sleep(800);
  await AD.js('document.getElementById("s").value=' + JSON.stringify(SECRET) + ';document.getElementById("go").click();1');
  await AD.until('!!document.getElementById("f_minLogic")');
  await AD.shot('23-admin-spiellogik-spendenlink', { scroll: '#f_donateUrl', block: 'center' });

  console.log('fertig: ' + OUT);
  procs.forEach((p) => { try { p.kill(); } catch (e) { /* egal */ } });
  process.exit(0);
})().catch((e) => { console.error(e); procs.forEach((p) => { try { p.kill(); } catch (x) { /* egal */ } }); process.exit(1); });
