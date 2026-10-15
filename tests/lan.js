/* WLAN-Host der App (app-host.js) in echtem Chromium: Gast über http:// an einer Nicht-localhost-Adresse
   (kein Secure Context → Web-Crypto-Ersatz kr-subtle.js), Raum mit 3 Bots, Hand geben, eigene Karten entschlüsselt.
   Außerdem: HTTPS-Listener mit eigenem Zertifikat, Konten im WLAN gesperrt, App-Steuerung nur mit Token.
   Nutzung: node --experimental-websocket tests/lan.js <app-verzeichnis> <eigene-IP (nicht 127.0.0.1)> */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), https = require('https');
const APP = path.resolve(process.argv[2] || path.join(__dirname, '..', 'app'));
const IP = process.argv[3] || [].concat(...Object.values(os.networkInterfaces())).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address)[0];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-lan-'));
const APP_PORT = 3970, LAN_PORT = 3980, TOKEN = 'testtoken';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let host, chrome;
const ok = (c, m) => { if (!c) throw new Error('FEHLER: ' + m); console.log('  ok  ' + m); };

async function tab(url) {
  const t = await (await fetch('http://127.0.0.1:9337/json/new?' + encodeURIComponent(url), { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const wait = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } });
  return (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
}
async function cdp() {
  chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9337', '--ignore-certificate-errors', '--user-data-dir=' + path.join(TMP, 'chr'), 'about:blank'], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 50; i++) { try { list = await (await fetch('http://127.0.0.1:9337/json')).json(); break; } catch (e) { await sleep(200); } }
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const wait = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } });
  return (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
}
const ctl = (p, body) => fetch('http://127.0.0.1:' + APP_PORT + '/__app/' + p, { method: body ? 'POST' : 'GET',
  headers: { 'x-kr-app': TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

(async () => {
  ok(IP && IP !== '127.0.0.1', 'eigene Adresse ' + IP);
  host = spawn(process.execPath, [path.join(APP, 'app-host.js')], { cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, {
    KR_APP_PORT: String(APP_PORT), KR_LAN_PORT: String(LAN_PORT), KR_APP_TOKEN: TOKEN, KR_VAR_DIR: path.join(TMP, 'var'),
    KR_PUBLIC: path.join(APP, 'public'), KR_UPSTREAM: 'http://127.0.0.1:9', KR_BOT_SPEED: '0.3', KR_LEADER_SOCK: path.join(TMP, 'l.sock') }) });
  let out = ''; host.stdout.on('data', (d) => { out += d; }); host.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 50 && !/KR_APP_READY/.test(out); i++) await sleep(200);
  ok(/KR_APP_READY/.test(out), 'App-Host gestartet');
  ok((await ctl('state')).status === 200 && (await fetch('http://127.0.0.1:' + APP_PORT + '/__app/state')).status === 403, 'Steuerung nur mit Token');
  const st = await (await ctl('mode', { mode: 'lan' })).json();
  ok(st.mode === 'lan' && st.lan.on && /^[0-9A-F:]{95}$/.test(st.lan.fingerprint), 'WLAN-Host an, Zertifikat erzeugt');
  ok((await fetch('http://' + IP + ':' + LAN_PORT + '/__app/state', { headers: { 'x-kr-app': TOKEN } })).status === 404, 'Steuerung aus dem WLAN nicht erreichbar');
  ok((await fetch('http://' + IP + ':' + LAN_PORT + '/api?a=acct.me')).status === 503, 'Konten im WLAN gesperrt');
  const tlsOk = await new Promise((r) => https.get({ host: IP, port: LAN_PORT + 1, path: '/', rejectUnauthorized: false }, (res) => {
    const fp = res.socket.getPeerCertificate().fingerprint256; res.resume(); r(res.statusCode === 200 && fp === st.lan.fingerprint);
  }).on('error', () => r(false)));
  ok(tlsOk, 'HTTPS im WLAN mit dem angezeigten Fingerabdruck');

  const send = await cdp();
  const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };
  const click = (sel) => js('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');if(e){e.click();return true;}return false;})()');
  const until = async (expr, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 45000)) { if (await js(expr)) return true; await sleep(300); } return false; };
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://' + IP + ':' + LAN_PORT + '/' });
  ok(await until('!!document.querySelector(\'[data-a="create"]\')'), 'Gast lädt das Spiel vom WLAN-Host');
  ok(await js('!window.isSecureContext&&!!(window.crypto&&crypto.subtle)&&document.documentElement.classList.contains("kr-lan")'), 'kein Secure Context, Web-Crypto-Ersatz aktiv');
  await js('window.confirm=function(){return true};document.getElementById("name").value="Gast";1');
  await click('[data-a="create"]');
  ok(await until('!!document.querySelector(\'[data-a="addbot"]\')'), 'Raum im WLAN erstellt');
  // Host spielt in der App (WebView auf 127.0.0.1 → eingebetteter Server), Gast im Browser über das WLAN
  const code = await js('localStorage.getItem("kr.room")');
  const app = await tab('http://127.0.0.1:' + APP_PORT + '/');
  const ajs = async (expr) => { const r = await app('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };
  const auntil = async (expr, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 45000)) { if (await ajs(expr)) return true; await sleep(300); } return false; };
  ok(await auntil('!!document.querySelector(\'[data-a="join"]\')&&window.isSecureContext&&!!(window.KR_APP&&KR_APP.app)'), 'App-Seite auf 127.0.0.1 (Secure Context, KR_APP)');
  ok(await ajs('document.body.innerText.indexOf("Du hostest im WLAN")>=0'), 'App zeigt „Du hostest im WLAN“');
  await ajs('window.confirm=function(){return true};document.getElementById("name").value="Host";document.getElementById("code").value=' + JSON.stringify(code) + ';document.querySelector(\'[data-a="join"]\').click();1');
  ok(await auntil('localStorage.getItem("kr.room")===' + JSON.stringify(code), 20000), 'App tritt dem Raum des Gasts bei');
  ok(await until('/Host/.test(document.body.innerText)', 20000), 'Gast sieht den Host im Raum');
  for (let i = 0; i < 2; i++) { await click('[data-a="addbot"]'); await sleep(900); }
  await click('[data-a="start"]');
  ok(await until('/Runde 1 von 4/.test(document.body.innerText)', 60000), 'Hand gegeben (Mischen/Verteilen über drei Rollen)');
  ok(await until('/Du hast:/.test(document.body.innerText)', 30000), 'eigene Karten mit dem Ersatz entschlüsselt');
  ok(await auntil('/Du hast:/.test(document.body.innerText)', 30000), 'App entschlüsselt ihre Karten (echte Web-Crypto) im selben Raum');
  const inv = await js('location.href');
  ok(String(inv).indexOf(IP) >= 0, 'Gast bleibt auf der WLAN-Adresse');
  ok(!(await js('document.querySelector(".err")&&document.querySelector(".err").textContent')), 'keine Fehlermeldung');
  chrome.kill(); host.kill(); await sleep(500); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* egal */ }
  console.log('WLAN-TEST BESTANDEN'); process.exit(0);
})().catch((e) => { console.error(e.message || e); try { chrome.kill(); host.kill(); } catch (x) { /* egal */ } process.exit(1); });
