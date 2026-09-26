/* Screenshots der echten Seite in Chromium (headless, über das DevTools-Protokoll, ohne Zusatzpakete).
   Startet einen lokalen Server (Port 3995) aus einer Wegwerf-Kopie von app/ und fotografiert
   Übungsraum und Mehrspieler-Raum (1 Mensch + 3 Bots) in mehreren Bildschirmgrößen.
   Nutzung: node --experimental-websocket tests/shot.js <ausgabe-ordner> [breite x höhe ...]
   Beispiel: node --experimental-websocket tests/shot.js /tmp/shots 1024x768 1366x768 390x844 */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const OUT = path.resolve(process.argv[2] || '/tmp/shots');
const SIZES = (process.argv.slice(3).length ? process.argv.slice(3) : ['1024x768', '1366x768', '390x844']).map((s) => s.split('x').map(Number));
const APP = process.env.APPDIR ? path.resolve(process.env.APPDIR) : path.join(__dirname, '..', 'app');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-shot-'));
execSync('cp -r "' + APP + '/." "' + TMP + '/"');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 3995, URL0 = 'http://127.0.0.1:' + PORT + '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let srv, chrome;

async function cdp() {
  chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9333', '--user-data-dir=' + path.join(TMP, 'chr'), 'about:blank'], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 50; i++) { try { list = await (await fetch('http://127.0.0.1:9333/json')).json(); break; } catch (e) { await sleep(200); } }
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const wait = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } });
  const send = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  return send;
}
(async () => {
  srv = spawn(process.execPath, ['server.js'], { cwd: TMP, env: Object.assign({}, process.env, { PORT: String(PORT), KR_BOT_SPEED: '0.3' }), stdio: 'ignore' });
  await sleep(800);
  const send = await cdp();
  const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };
  const click = (sel) => js('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');if(e){e.click();return true;}return false;})()');
  const until = async (expr, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { if (await js(expr)) return true; await sleep(250); } return false; };
  async function shoot(name) {
    for (const [w, h] of SIZES) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: Number(process.env.DSF) || 1, mobile: w < 600 });
      await sleep(400);
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const f = path.join(OUT, name + '-' + w + 'x' + h + '.png');
      fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
      const scroll = await js('document.documentElement.scrollHeight-window.innerHeight');
      console.log(f, '· überstehend: ' + scroll + ' px');
    }
  }
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: SIZES[0][0], height: SIZES[0][1], deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL0 });
  await until('!!document.querySelector(\'[data-a="sp"]\')');
  await js('document.getElementById("name").value="Simon";1');
  // Übungsraum mit 5 Bots, Runde 2 und Handende
  await js('localStorage.setItem("kr.sp.bots","5");1');
  await click('[data-a="sp"]');
  await until('/Übungsraum/.test(document.body.innerText)');
  if (process.env.LEARN && !(await js('!!document.querySelector(".coach")'))) await click('[data-a="splearn"]');
  await sleep(2500);
  await shoot('sp-runde1');
  // Hand bis zum Ende spielen: freien Chip nehmen, klopfen; Tipp mit Ass/König bestätigen
  for (let i = 0; i < 400 && !(await js('!!document.querySelector(".p-reveal")')); i++) {
    await js('(function(){var r=document.querySelector(\'[data-a="ready"]\');var mine=document.querySelector(".pl.me .chip:not(.ph)");' +
      'if(!mine){var c=document.querySelector(".p-chips [data-chip]");if(c)c.click();}else if(r&&!r.disabled&&/Bereit$/.test(r.textContent))r.click();' +
      'var gk=document.querySelectorAll("[data-grank]");if(gk.length&&document.querySelector(".gslot .card.empty")){gk[12].click();}' +
      'var cf=document.querySelector(\'[data-a="confirm"]\');if(cf&&!cf.disabled)cf.click();return 1;})()');
    await sleep(300);
  }
  await sleep(800);
  await shoot('sp-ende');
  // Mehrspieler: Raum erstellen, 3 Bots, Hand geben
  await click('[data-a="leave"]'); await sleep(500);
  await js('document.getElementById("name").value="Simon";1');
  await click('[data-a="create"]');
  await until('!!document.querySelector(\'[data-a="addbot"]\')');
  for (let i = 0; i < 3; i++) { await click('[data-a="addbot"]'); await sleep(900); }
  await js('document.querySelector(\'[data-a="chat"]\')&&(document.getElementById("chatin").value="Na, wer hat die 4?",document.querySelector(\'[data-a="chat"]\').click());1');
  await sleep(600);
  await shoot('mp-lobby');
  await click('[data-a="start"]');
  await until('/Runde 1 von 4/.test(document.body.innerText)', 40000);
  await sleep(4000);
  await shoot('mp-runde1');
  console.log('fertig');
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    try { chrome.kill('SIGKILL'); } catch (e) {} try { srv.kill('SIGKILL'); } catch (e) {}
    setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }); } catch (e) { /* Chromium schreibt noch – egal */ } process.exit(process.exitCode || 0); }, 600);
  });
