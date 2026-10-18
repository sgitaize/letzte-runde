/* Spiellogik nachladen (App-Host): Server bietet ein signiertes Bundle an, die App lädt es auf Wunsch, prüft es,
   spielt danach damit – auch nach einem Neustart ohne Netz und im WLAN-Host. Abgelehnt werden fremde Signaturen,
   Bundles für einen neueren App-Host und gleicher Inhalt; eine Seite, die nicht startet, fällt zurück.
   Ohne Browser: der Test spricht /__bundle/* direkt an.
   Nutzung: node tests/bundle.js <app-verzeichnis> */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

const APP = path.resolve(process.argv[2] || path.join(__dirname, '..', 'app'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-bundle-'));
const SRV = path.join(TMP, 'srv'), APPD = path.join(TMP, 'app'), VAR = path.join(TMP, 'var');
const SPORT = 3983, APORT = 3960, LPORT = 3962;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) throw new Error('FEHLER: ' + m); console.log('  ok  ' + m); };
for (const d of [SRV, APPD]) {
  execSync('cp -r "' + APP + '/." "' + d + '/"');
  for (const x of ['data', 'logs', 'tmp', 'bundle.json']) fs.rmSync(path.join(d, x), { recursive: true, force: true });
}
const KEY = path.join(TMP, 'key.pem');
const run = (dir, args) => execSync(process.execPath + ' scripts/bundle.js ' + args, { cwd: dir, env: Object.assign({}, process.env, { KR_BUNDLE_KEY: KEY }) }).toString();
const mf = require(path.join(APP, 'bundle-manifest.js'));

/* Die App: eingebautes Spiel mit Stempel „Build 1000“ und dem öffentlichen Schlüssel */
run(SRV, 'keygen');
fs.copyFileSync(path.join(SRV, 'bundle-key.pub'), path.join(APPD, 'bundle-key.pub'));
fs.writeFileSync(path.join(APPD, 'bundle.json'), JSON.stringify({ build: 1000 }));
/* Der Server: neuere Spiellogik (Version 77) und eine Markierung in index.html */
const setLogic = (dir, v, mark) => {
  const hf = path.join(dir, 'public', 'hand.js');
  fs.writeFileSync(hf, fs.readFileSync(hf, 'utf8').replace(/var LOGIC_VERSION=\d+;/, 'var LOGIC_VERSION=' + v + ';'));
  const ix = path.join(dir, 'public', 'index.html');
  fs.writeFileSync(ix, fs.readFileSync(ix, 'utf8').replace(/<!--kr-mark[^>]*-->/g, '').replace('<head>', '<head><!--kr-mark ' + mark + '-->'));
};
setLogic(SRV, 77, 'neu');

let srv, host, out = '';
function startSrv() {
  srv = spawn(process.execPath, ['server.js'], { cwd: SRV, env: Object.assign({}, process.env, { PORT: String(SPORT), ADMIN_SECRET: 'x-secret-bundle' }), stdio: 'ignore' });
  return (async () => { for (let i = 0; i < 60; i++) { await sleep(200); try { if ((await fetch('http://127.0.0.1:' + SPORT + '/api?a=config')).ok) return; } catch (e) { /* startet noch */ } } })();
}
async function startHost(upstream) {
  out = '';
  host = spawn(process.execPath, [path.join(APPD, 'app-host.js')], { cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, {
    KR_APP_PORT: String(APORT), KR_LAN_PORT: String(LPORT), KR_APP_TOKEN: 'tok', KR_VAR_DIR: VAR, KR_PUBLIC: path.join(APPD, 'public'),
    KR_UPSTREAM: upstream || 'http://127.0.0.1:' + SPORT, KR_LEADER_SOCK: path.join(TMP, 'l.sock') }) });
  host.stdout.on('data', (d) => { out += d; }); host.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 50 && !/KR_APP_READY/.test(out); i++) await sleep(150);
  ok(/KR_APP_READY/.test(out), 'App-Host gestartet');
}
async function stopHost() { host.kill(); await new Promise((r) => host.once('exit', r)); }
const A = 'http://127.0.0.1:' + APORT;
const bget = async (p) => (await fetch(A + '/__bundle/' + p)).json();
const bpost = async (p) => { const r = await fetch(A + '/__bundle/' + p, { method: 'POST', body: '{}' }); return Object.assign({ status: r.status }, await r.json()); };
const page = async () => (await fetch(A + '/')).text();
const krApp = (html) => JSON.parse(/window\.KR_APP=(\{.*?\});<\/script>/.exec(html)[1]);
const WATCH = /if\(!window\.KR_BOOTED\)location\.reload\(\)/;
const checked = async () => { const s = await bpost('check'); return s; };

(async () => {
  /* Ohne Manifest auf dem Server: nichts anzubieten */
  await startSrv();
  ok((await fetch('http://127.0.0.1:' + SPORT + '/app/bundle.json')).status === 404, 'Server ohne bundle.json: 404');
  srv.kill(); await sleep(300);
  console.log(run(SRV, 'build').trim());
  const M = JSON.parse(fs.readFileSync(path.join(SRV, 'bundle.json'), 'utf8'));
  ok(mf.verify(M, fs.readFileSync(path.join(SRV, 'bundle-key.pub'), 'utf8')) && M.logic === 77 && !M.files['app-host.js'] && !M.files['public/sw.js'], 'Manifest signiert, ohne App-Host und Service Worker');
  const forged = JSON.parse(JSON.stringify(M)); forged.files['public/hand.js'].h = 'ab'.repeat(32);
  ok(!mf.verify(forged, fs.readFileSync(path.join(SRV, 'bundle-key.pub'), 'utf8')), 'geänderte Prüfsumme → Signatur ungültig');
  ok(!mf.verify(Object.assign({}, M, { files: Object.assign({ '../x.js': { h: 'a', n: 1 } }, M.files) }), fs.readFileSync(path.join(SRV, 'bundle-key.pub'), 'utf8')), 'Pfad mit „..“ abgelehnt');
  await startSrv();
  ok((await (await fetch('http://127.0.0.1:' + SPORT + '/api?a=config')).json()).bundle.build === M.build, '/api?a=config nennt das Bundle');
  ok((await fetch('http://127.0.0.1:' + SPORT + '/app/bundle/public/hand.js')).ok && (await fetch('http://127.0.0.1:' + SPORT + '/app/bundle/data/config.json')).status === 404, 'Server liefert nur Dateien aus dem Manifest');
  ok(/const VERSION = 'lr-[0-9a-f]{10}';/.test(await (await fetch('http://127.0.0.1:' + SPORT + '/sw.js')).text()), 'sw.js bekommt VERSION aus dem Dateistand');

  /* Erster Start: Update wird angeboten, aber nicht von selbst geladen */
  await startHost();
  let s = await checked();
  ok(s.available && s.available.build === M.build && s.available.logic === 77 && s.active.src === 'builtin' && !s.required, 'Update angeboten (Spiellogik 77), noch eingebaut aktiv');
  ok(s.available.files >= 2 && s.available.files < Object.keys(M.files).length, 'nur geänderte Dateien (' + s.available.files + ' von ' + Object.keys(M.files).length + ')');
  ok(krApp(await page()).logic !== 77 && !/kr-mark neu/.test(await page()), 'Seite noch aus dem App-Paket');
  s = await bpost('apply');
  ok(s.status === 200 && s.reload && s.active.build === M.build && s.active.src === 'download', 'Update geladen und aktiv');
  let html = await page();
  ok(/kr-mark neu/.test(html) && krApp(html).logic === 77 && WATCH.test(html), 'Seite aus dem Bundle, mit Start-Wächter (Probezeit)');
  await bpost('ok');
  ok(!WATCH.test(await page()) && !(await bget('state')).active.trial, 'Seite meldet sich → Probezeit vorbei');
  ok((await checked()).available === null, 'danach kein Update mehr angeboten');

  /* Neustart ohne Netz: gespeicherte Logik bleibt */
  await stopHost();
  await startHost('http://127.0.0.1:9');
  ok(/kr-mark neu/.test(await page()) && (await bget('state')).active.logic === 77, 'offline nach Neustart: weiter mit der geladenen Spiellogik');
  /* WLAN-Host nutzt dieselbe Logik (eingebetteter Server aus dem Bundle) */
  const st = await (await fetch(A + '/__app/mode', { method: 'POST', headers: { 'x-kr-app': 'tok', 'content-type': 'application/json' }, body: '{"mode":"lan"}' })).json();
  ok(st.mode === 'lan', 'WLAN-Host an');
  ok((await (await fetch('http://127.0.0.1:' + (APORT + 1) + '/api?a=config')).json()).logic === 77, 'eingebetteter Spielserver rechnet mit Spiellogik 77');
  ok((await fetch('http://127.0.0.1:' + LPORT + '/__bundle/state')).status === 404, '/__bundle nicht aus dem WLAN erreichbar');
  await stopHost();

  /* Neues Bundle, Seite startet nicht → Rückfall auf das vorige */
  setLogic(SRV, 78, 'kaputt'); srv.kill(); await sleep(300); await sleep(1100); run(SRV, 'build'); await startSrv();
  const M2 = JSON.parse(fs.readFileSync(path.join(SRV, 'bundle.json'), 'utf8'));
  await startHost();
  s = await checked();
  ok(s.available && s.available.build === M2.build, 'zweites Update angeboten');
  await bpost('apply');
  for (let i = 0; i < 4; i++) await page();
  s = await bget('state');
  ok(s.active.build === M.build && s.active.logic === 77, 'Seite meldet sich nie → zurück auf das vorige Bundle');
  ok((await checked()).available === null, 'kaputtes Bundle wird nicht wieder angeboten');
  await stopHost();

  /* Fremde Signatur und Bundle für einen neueren App-Host */
  setLogic(SRV, 79, 'fremd'); srv.kill(); await sleep(1100);
  const other = path.join(TMP, 'other.pem');
  fs.writeFileSync(other, crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const pub = fs.readFileSync(path.join(SRV, 'bundle-key.pub'));
  fs.rmSync(path.join(SRV, 'bundle-key.pub'));
  execSync(process.execPath + ' scripts/bundle.js build', { cwd: SRV, env: Object.assign({}, process.env, { KR_BUNDLE_KEY: other }) });
  fs.writeFileSync(path.join(SRV, 'bundle-key.pub'), pub);
  await startSrv(); await startHost();
  s = await checked();
  ok(!s.available && /Signatur/.test(s.error), 'fremd signiertes Bundle abgelehnt');
  await stopHost(); srv.kill(); await sleep(1100);
  const hostSrc = path.join(SRV, 'app-host.js');
  fs.writeFileSync(hostSrc, fs.readFileSync(hostSrc, 'utf8').replace(/const HOST_API = \d+;/, 'const HOST_API = 99;'));
  run(SRV, 'build'); await startSrv(); await startHost();
  s = await checked();
  ok(s.available && s.available.needsApp, 'Bundle für neueren App-Host: „App-Update nötig“');
  ok((await bpost('apply')).status === 409 && (await bget('state')).active.build === M.build, '… und wird nicht geladen');

  /* Mindest-Spiellogik vom Server → Update ist Pflicht für Online-Räume */
  await fetch('http://127.0.0.1:' + SPORT + '/admin-api?a=config', { method: 'POST', headers: { 'x-admin-secret': 'x-secret-bundle', 'content-type': 'application/json' }, body: '{"minLogic":79}' });
  s = await checked();
  ok(s.minLogic === 79 && s.required, 'Server verlangt Spiellogik 79 → required');
  await stopHost();

  /* Abgestürzter WLAN-Server aus dem Bundle → beim nächsten Start verworfen */
  const bsf = path.join(VAR, 'bundle', 'state.json'), bsj = JSON.parse(fs.readFileSync(bsf, 'utf8'));
  fs.writeFileSync(bsf, JSON.stringify(Object.assign(bsj, { innerTrial: bsj.active })));
  await startHost('http://127.0.0.1:9');
  ok((await bget('state')).active.src === 'builtin' && !/kr-mark/.test(await page()), 'Absturz des eingebetteten Servers → eingebautes Spiel');
  await stopHost();

  /* App-Update aus dem Store: eingebautes Spiel neuer als der Download → Download fällt weg */
  fs.writeFileSync(bsf, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(bsf, 'utf8')), { active: M.build, bad: [] })));
  fs.writeFileSync(path.join(APPD, 'bundle.json'), JSON.stringify({ build: M2.build + 100 }));
  await startHost('http://127.0.0.1:9');
  ok((await bget('state')).active.src === 'builtin', 'neue App-Version: älterer Download wird nicht mehr benutzt');
  await stopHost();

  /* Gleicher Inhalt mit neuerer Build-Nummer: kein Update */
  srv.kill(); await sleep(300);
  execSync('cp -r "' + APP + '/." "' + SRV + '/"');
  fs.rmSync(path.join(SRV, 'bundle.json'), { force: true });
  fs.copyFileSync(path.join(APPD, 'bundle-key.pub'), path.join(SRV, 'bundle-key.pub'));
  fs.writeFileSync(path.join(APPD, 'bundle.json'), JSON.stringify({ build: 1000 }));
  run(SRV, 'build'); await startSrv(); await startHost();
  ok((await checked()).available === null, 'Server hat dieselben Dateien wie die App → nichts zu laden');
  await stopHost();

  srv.kill();
  console.log('fertig');
  process.exit(0);
})().catch((e) => { console.error(e); console.error(out.slice(-2000)); try { srv && srv.kill(); host && host.kill(); } catch (x) { /* egal */ } process.exit(1); });
