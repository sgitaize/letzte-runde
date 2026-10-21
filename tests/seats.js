/* „Deine Plätze“ in echtem Chromium: Raum betreten, verlassen, über die Startseite weiterspielen; volle Räume beschriftet.
   Startet einen eigenen Server (Port 3986) aus einer Wegwerf-Kopie von app/.
   Nutzung: node --experimental-websocket tests/seats.js <app-verzeichnis> */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const APP = path.resolve(process.argv[2] || path.join(__dirname, '..', 'app'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-seats-'));
execSync('cp -r "' + APP + '/." "' + TMP + '/"');
const PORT = 3986, URL0 = 'http://127.0.0.1:' + PORT + '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let srv, chrome;

async function cdp() {
  chrome = spawn('chromium', ['--headless=new', '--lang=de-DE', '--accept-lang=de-DE', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9336', '--user-data-dir=' + path.join(TMP, 'chr'), 'about:blank'], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 50; i++) { try { list = await (await fetch('http://127.0.0.1:9336/json')).json(); break; } catch (e) { await sleep(200); } }
  return connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
}
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const wait = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } });
  const send = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  return send;
}
(async () => {
  srv = spawn(process.execPath, ['server.js'], { cwd: TMP, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
  await sleep(800);
  const send = await cdp();
  const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };
  const click = (sel) => js('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');if(e){e.click();return true;}return false;})()');
  const until = async (expr, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 45000)) { if (await js(expr)) return true; await sleep(250); } return false; };
  const ok = (c, m) => { if (!c) throw new Error('FEHLER: ' + m); console.log('  ok  ' + m); };
  await send('Page.enable');
  await send('Page.navigate', { url: URL0 });
  await until('!!document.querySelector(\'[data-a="create"]\')');
  await js('window.confirm=function(){return true};document.getElementById("name").value="Simon";1');
  await click('[data-a="create"]');
  ok(await until('!!localStorage.getItem("kr.room")&&!!document.querySelector(\'[data-a="leave"]\')'), 'Raum erstellt und beigetreten');
  const room = await js('localStorage.getItem("kr.room")');
  await click('[data-a="leave"]');
  ok(await until('!!document.querySelector(\'[data-a="seatgo"][data-code="' + room + '"]\')'), 'Startseite: „Deine Plätze“ mit Weiterspielen');
  await click('[data-a="seatgo"]');
  ok(await until('localStorage.getItem("kr.room")==="' + room + '"&&!!document.querySelector(\'[data-a="leave"]\')&&!document.querySelector(\'[data-a="play"]\')'), 'Weiterspielen: zurück auf dem eigenen Platz');
  ok(!(await js('document.querySelector(".err")')), 'keine Fehlermeldung');
  chrome.kill(); srv.kill(); await sleep(500); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* Chromium schreibt noch */ }
  console.log('PLÄTZE-TEST BESTANDEN'); process.exit(0);
})().catch((e) => { console.error(e.message || e); try { chrome.kill(); srv.kill(); } catch (x) { /* egal */ } process.exit(1); });
