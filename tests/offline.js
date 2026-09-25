/* Offline (Übungsraum ohne Netz, z. B. im Flugzeug) in echtem Chromium: App einmal online laden, dann den Server
   abschalten und neu laden → Seite kommt aus dem Service Worker, Offline-Hinweis, komplette Übungsraum-Hand,
   Kurzbefehl ?sp=1; Server wieder an → offline gespielte Hände werden nachgezählt.
   Nutzung: node --experimental-websocket tests/offline.js [app-verzeichnis] */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const APP = path.resolve(process.argv[2] || path.join(__dirname, '..', 'app'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-off-'));
execSync('cp -r "' + APP + '/." "' + TMP + '/app"');
const PORT = 3992, URL0 = 'http://127.0.0.1:' + PORT + '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) throw new Error('FEHLER: ' + m); console.log('  ok  ' + m); };
let srv, chrome;
const startSrv = () => { srv = spawn(process.execPath, ['server.js'], { cwd: path.join(TMP, 'app'), env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' }); return sleep(800); };
const stopSrv = () => new Promise((r) => { srv.on('exit', r); srv.kill('SIGTERM'); });

(async () => {
  await startSrv();
  chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9335', '--user-data-dir=' + path.join(TMP, 'chr'), 'about:blank'], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 50; i++) { try { list = await (await fetch('http://127.0.0.1:9335/json')).json(); break; } catch (e) { await sleep(200); } }
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const wait = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } });
  const send = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };
  const click = (sel) => js('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');if(e){e.click();return true;}return false;})()');
  const until = async (expr, what, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { try { if (await js(expr)) return; } catch (e) { /* lädt */ } await sleep(250); } throw new Error('Timeout: ' + what); };
  const nav = async (u) => { await send('Page.navigate', { url: u }); await sleep(800); };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  // 1) online laden, Service Worker aktiv
  await nav(URL0);
  await until('!!document.querySelector(\'[data-a="sp"]\')', 'Startseite online');
  await until('navigator.serviceWorker.ready.then(function(){return true;})', 'Service Worker bereit');
  await nav(URL0); await until('!!navigator.serviceWorker.controller', 'Seite vom Service Worker kontrolliert');
  ok(true, 'Online geladen, Service Worker hält die App vor');
  await js('document.getElementById("name").value="Simon";localStorage.setItem("kr.name","Simon");1');
  const before = (await (await fetch(URL0 + 'api?a=rooms')).json()).counts.sp;

  // 2) Server aus = kein Netz – Hinweis muss ohne Neuladen erscheinen
  await stopSrv();
  { const t = Date.now(); await until('/Offline/.test(document.body.innerText)', 'Offline-Hinweis ohne Neuladen', 15000);
    ok(true, 'Netz weg: Offline-Hinweis erscheint von selbst, ohne Neuladen (' + ((Date.now() - t) / 1000).toFixed(1) + ' s)'); }
  await nav(URL0);
  await until('/Letzte Runde/.test(document.body.innerText)&&!!document.querySelector(\'[data-a="sp"]\')', 'Seite offline');
  ok(true, 'Ohne Server: Seite kommt trotzdem (aus dem Speicher des Geräts)');
  await until('/Offline/.test(document.body.innerText)', 'Offline-Hinweis', 10000);
  ok(true, 'Offline-Hinweis „Räume gehen gerade nicht, der Übungsraum schon“');

  // 3) Übungsraum offline: komplette Hand, dann gleich die nächste
  await click('.panel.offline [data-a="sp"]');
  await until('/Übungsraum/.test(document.body.innerText)&&!!document.querySelector(".p-board")', 'Übungsraum offline');
  if (!(await js('!!document.querySelector(".coach")'))) await click('[data-a="splearn"]');
  await until('/passender Chip/.test((document.querySelector(".coach")||{}).textContent||"")', 'Lernmodus offline', 5000);
  ok(true, 'Lernmodus funktioniert offline (Einschätzung + passender Chip)');
  for (let hand = 1; hand <= 2; hand++) {
    for (let i = 0; i < 600 && !(await js('!!document.querySelector(".p-reveal")')); i++) {
      await js('(function(){var r=document.querySelector(\'[data-a="ready"]\');var mine=document.querySelector(".pl.me .chip:not(.ph)");' +
        'if(!mine){var c=document.querySelector(".p-chips [data-chip]");if(c)c.click();}else if(r&&!r.disabled&&/Bereit$/.test(r.textContent))r.click();' +
        'var s=document.querySelectorAll("select[data-g]");s.forEach(function(x,k){if(!x.value){x.value=String(12-k);x.dispatchEvent(new Event("change",{bubbles:true}));}});' +
        'var cf=document.querySelector(\'[data-a="confirm"]\');if(cf&&!cf.disabled)cf.click();return 1;})()');
      await sleep(300);
    }
    if (!(await js('!!document.querySelector(".p-reveal")'))) console.log('    Bildschirm: ' + (await js('document.body.innerText.replace(/\\s+/g," ").slice(0,500)')));
    ok(await js('!!document.querySelector(".p-reveal")'), 'Offline: Übungsraum-Hand ' + hand + ' komplett gespielt');
    if (hand === 1) { await click('[data-a="spnext"]'); await until('!!!document.querySelector(".p-reveal")', 'nächste Hand'); }
  }
  ok(await js('JSON.parse(localStorage.getItem("kr.sp.stats")||"[]").length>=2'), 'Offline: Statistik auf dem Gerät gespeichert');
  ok(await js('Number(localStorage.getItem("kr.sp.pending"))>=2'), 'Offline gespielte Hände warten aufs Nachzählen');

  // 4) Kurzbefehl ?sp=1 offline
  await nav(URL0 + '?sp=1');
  await until('/Übungsraum/.test(document.body.innerText)&&!!document.querySelector(".p-board")', 'Kurzbefehl offline', 15000);
  ok(true, 'Kurzbefehl …/?sp=1 startet den Übungsraum direkt (offline)');

  // 4b) Netz „hängt“ (Flugzeug-WLAN ohne Internet): Server nimmt Verbindungen an, antwortet aber nie
  const hang = require('net').createServer(() => { /* nie antworten */ });
  await new Promise((r) => hang.listen(PORT, '127.0.0.1', r));
  let t = Date.now();
  await send('Page.navigate', { url: URL0 });
  await until('!!document.querySelector(\'[data-a="sp"]\')&&typeof spStart!=="number"', 'Seite bei hängendem Netz', 15000);
  await click('[data-a="sp"]');
  await until('!!document.querySelector(".p-board")', 'Übungsraum bei hängendem Netz', 15000);
  const tt = Date.now() - t;
  ok(tt < 6000, 'Hängendes Netz: App in ' + (tt / 1000).toFixed(1) + ' s bedienbar, Übungsraum startet');
  await click('[data-a="leave"]'); t = Date.now();
  await until('/Offline/.test(document.body.innerText)', 'Offline-Hinweis bei hängendem Netz', 15000);
  ok(true, 'Hängendes Netz: Offline-Hinweis nach ' + ((Date.now() - t) / 1000).toFixed(1) + ' s, ohne Neuladen');
  await new Promise((r) => { for (const c of [...(hang._conns || [])]) c.destroy(); hang.close(r); setTimeout(r, 500); });

  // 5) Netz wieder da → nachzählen
  await startSrv();
  await nav(URL0);
  await until('Number(localStorage.getItem("kr.sp.pending"))===0', 'nachgezählt', 20000);
  const after = (await (await fetch(URL0 + 'api?a=rooms')).json()).counts.sp;
  ok(after - before >= 3, 'Netz wieder da: offline gespielte Hände nachgezählt (' + (after - before) + ')');
  ok(await js('!/Offline/.test(document.body.innerText)'), 'Offline-Hinweis verschwindet wieder');
  console.log('OFFLINE-TEST BESTANDEN');
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; })
  .finally(() => {
    try { chrome.kill('SIGKILL'); } catch (e) {} try { srv.kill('SIGKILL'); } catch (e) {}
    setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }); } catch (e) {} process.exit(process.exitCode || 0); }, 600);
  });
