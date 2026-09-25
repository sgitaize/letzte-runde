/* Voice-Chat Ende-zu-Ende: zwei echte Chromium-Fenster (Test-Mikrofon mit Piepton), lokaler Server (Port 3994).
   Prüft: Standard aus, Admin schaltet ein/aus, Verbindung zwischen den Geräten, Ton kommt an (🔊 beim anderen),
   Stummschalten sichtbar, Rechte am Server.
   Nutzung: node --experimental-websocket tests/voice.js [app-verzeichnis] */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const APP = path.resolve(process.argv[2] || path.join(__dirname, '..', 'app'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-voice-'));
execSync('cp -r "' + APP + '/." "' + TMP + '/"');
const PORT = 3994, URL0 = 'http://127.0.0.1:' + PORT + '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) throw new Error('FEHLER: ' + m); console.log('  ok  ' + m); };
let srv, chrome;

async function page(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const wait = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } });
  const send = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };
  const click = (sel) => js('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');if(e){e.click();return true;}return false;})()');
  const until = async (expr, what, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { if (await js(expr)) return; await sleep(250); } throw new Error('Timeout: ' + what); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });   // beide Fenster wie im Vordergrund (keine Timer-Drosselung)
  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  return { send, js, click, until, close: () => ws.close() };
}
const admin = (body) => fetch(URL0 + 'admin-api?a=config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-secret': fs.readFileSync(path.join(TMP, 'data', 'admin-secret.txt'), 'utf8').trim() }, body: JSON.stringify(body) });

(async () => {
  srv = spawn(process.execPath, ['server.js'], { cwd: TMP, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
  await sleep(800);
  chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9334', '--user-data-dir=' + path.join(TMP, 'chr'),
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 50; i++) { try { list = await (await fetch('http://127.0.0.1:9334/json')).json(); break; } catch (e) { await sleep(200); } }
  // Ben in eigenem Browser-Kontext (eigener Speicher = eigenes Gerät)
  const ver = await (await fetch('http://127.0.0.1:9334/json/version')).json();
  const bws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => bws.addEventListener('open', r));
  const bsend = (() => { let i = 0; const w = new Map(); bws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (w.has(d.id)) { w.get(d.id)(d); w.delete(d.id); } });
    return (method, params) => new Promise((r) => { const k = ++i; w.set(k, r); bws.send(JSON.stringify({ id: k, method, params: params || {} })); }); })();
  const ctxId = (await bsend('Target.createBrowserContext')).result.browserContextId;
  const tid = (await bsend('Target.createTarget', { url: 'about:blank', browserContextId: ctxId })).result.targetId;
  await sleep(300);
  const tB = (await (await fetch('http://127.0.0.1:9334/json')).json()).find((t) => t.id === tid);
  const A = await page(list.find((t) => t.type === 'page')), B = await page(tB);

  // Anna erstellt, Ben tritt bei
  await A.send('Page.navigate', { url: URL0 }); await A.until('!!document.querySelector(\'[data-a="create"]\')', 'Startseite A');
  await A.js('document.getElementById("name").value="Anna";1'); await A.click('[data-a="create"]');
  await A.until('/Raum [A-Z0-9]{4}/.test(document.body.innerText)', 'Raum A');
  const code = await A.js('document.querySelector("h1 .code").textContent');
  await B.send('Page.navigate', { url: URL0 + '#' + code }); await B.until('!!document.querySelector(\'[data-a="join"]\')', 'Startseite B');
  await B.js('document.getElementById("name").value="Ben";1'); await B.click('[data-a="join"]');
  await A.until('document.querySelectorAll(".p-players .pl").length===2', 'Ben im Raum');
  await sleep(1500);
  ok(!(await A.js('!!document.querySelector(\'[data-a="vjoin"]\')')), 'Standard: Voice-Chat aus, kein Knopf');
  let r = await fetch(URL0 + 'api?a=signals&room=' + code, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"uid":"x"}' });
  ok(r.status === 403, 'Standard: Server lehnt Voice-Anfragen ab (403)');

  // Admin schaltet ein
  ok((await admin({ voiceEnabled: true })).status === 200, 'Admin schaltet Voice-Chat ein');
  await A.until('!!document.querySelector(\'[data-a="vjoin"]\')', 'Knopf bei Anna', 10000);
  await B.until('!!document.querySelector(\'[data-a="vjoin"]\')', 'Knopf bei Ben', 10000);
  ok(true, 'Knopf „🎙 Voice“ erscheint bei beiden ohne Neuladen');
  r = await fetch(URL0 + 'api?a=signal&room=' + code, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kr-key': 'fremder-schluessel-1234567890' }, body: '{"uid":"x","to":"y","type":"offer","data":"{}"}' });
  ok(r.status === 403, 'Fremde können keine Voice-Nachrichten schicken (403)');

  // Einwilligung beim ersten Mal
  await A.click('[data-a="vjoin"]');
  await A.until('!!document.querySelector(".vdlg")&&/Google und Cloudflare/.test(document.querySelector(".vdlg").textContent)', 'Zustimmungsfenster', 5000);
  ok(await A.js('!document.querySelector(".vstat")&&!localStorage.getItem("kr.voice.consent")'), 'Erstes Mal: Zustimmungsfenster erklärt Voice-Chat, noch kein Mikrofon');
  await A.click('[data-a="vcancel"]');
  ok(await A.js('!document.querySelector(".vdlg")&&!document.querySelector(".vstat")'), 'Abbrechen: kein Voice-Chat');
  await A.click('[data-a="vjoin"]'); await A.until('!!document.querySelector(".vdlg")', 'Fenster erneut', 5000); await A.click('[data-a="vconsent"]');
  await B.click('[data-a="vjoin"]'); await B.until('!!document.querySelector(".vdlg")', 'Fenster bei Ben', 5000); await B.click('[data-a="vconsent"]');
  ok(await A.js('!!localStorage.getItem("kr.voice.consent")'), 'Zustimmung wird auf dem Gerät gespeichert');
  await A.until('(document.querySelector(".vstat")||{dataset:{}}).dataset.n==="1"', 'Anna verbunden', 30000);
  await B.until('(document.querySelector(".vstat")||{dataset:{}}).dataset.n==="1"', 'Ben verbunden', 30000);
  ok(true, 'Beide Geräte direkt verbunden (1/1)');
  await A.until('[...document.querySelectorAll(".p-players .pl")].some(function(p){return /Ben/.test(p.textContent)&&p.querySelector(".tag.vc.talk");})', 'Ton von Ben bei Anna', 20000);
  await B.until('[...document.querySelectorAll(".p-players .pl")].some(function(p){return /Anna/.test(p.textContent)&&p.querySelector(".tag.vc.talk");})', 'Ton von Anna bei Ben', 20000);
  ok(true, 'Ton kommt an: 🔊 beim jeweils anderen (Test-Mikrofon)');
  ok(await A.js('document.querySelectorAll("#voiceaudio audio").length===1'), 'Ein Audio-Ausgang je Gegenüber');

  await B.click('[data-a="vmute"]');
  await A.until('[...document.querySelectorAll(".p-players .pl")].some(function(p){return /Ben/.test(p.textContent)&&/🔇/.test(p.querySelector(".tag.vc")?p.querySelector(".tag.vc").textContent:"");})', 'Ben stumm bei Anna', 10000);
  ok(true, 'Stummschalten ist beim anderen sichtbar (🔇)');

  await B.click('[data-a="vleave"]');
  await A.until('(document.querySelector(".vstat")||{dataset:{}}).dataset.n==="0"', 'Verbindung beendet', 30000);
  ok(true, 'Voice verlassen trennt die Verbindung');

  await B.click('[data-a="vjoin"]');
  ok(await B.js('!document.querySelector(".vdlg")'), 'Beim zweiten Mal wird nicht erneut gefragt');
  await A.until('(document.querySelector(".vstat")||{dataset:{}}).dataset.n==="1"', 'wieder verbunden', 30000);
  ok(true, 'Wieder beitreten verbindet erneut');
  await B.click('[data-a="vinfo"]'); await B.until('!!document.querySelector(\'[data-a="vrevoke"]\')', 'Info', 5000);
  await B.click('[data-a="vrevoke"]');
  await A.until('(document.querySelector(".vstat")||{dataset:{}}).dataset.n==="0"', 'Widerruf beendet Verbindung', 30000);
  ok(await B.js('!localStorage.getItem("kr.voice.consent")&&!document.querySelector(".vstat")'), 'ⓘ → Zustimmung zurücknehmen beendet Voice und löscht die Zustimmung');
  await B.click('[data-a="vjoin"]'); await B.until('!!document.querySelector(".vdlg")', 'nach Widerruf wieder gefragt', 5000);
  ok(true, 'Nach dem Widerruf wird wieder gefragt'); await B.click('[data-a="vconsent"]');
  await A.until('(document.querySelector(".vstat")||{dataset:{}}).dataset.n==="1"', 'wieder verbunden 2', 30000);

  ok((await admin({ voiceEnabled: false })).status === 200, 'Admin schaltet Voice-Chat aus');
  await A.until('!document.querySelector(".vstat")&&!document.querySelector(\'[data-a="vjoin"]\')', 'Voice bei Anna beendet', 10000);
  await B.until('!document.querySelector(".vstat")', 'Voice bei Ben beendet', 10000);
  ok(await A.js('document.querySelectorAll("#voiceaudio audio").length===0'), 'Ausschalten im Admin beendet laufende Gespräche');
  console.log('VOICE-TEST BESTANDEN');
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; })
  .finally(() => {
    try { chrome.kill('SIGKILL'); } catch (e) {} try { srv.kill('SIGKILL'); } catch (e) {}
    setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }); } catch (e) {} process.exit(process.exitCode || 0); }, 600);
  });
