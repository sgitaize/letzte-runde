/* App-Store-Bilder: echte Spielszenen in Chrome (wie in der App: window.KR_APP, helles Design)
   und daraus die Store-Motive (Überschrift im Stil des Spiels über dem Screenshot).
   Startet einen lokalen Server (Port 3984) aus einer Wegwerf-Kopie von app/.
   Nutzung: CHROME=<pfad> node --experimental-websocket docs/store/storeshots.js
   Ergebnis: docs/store/screenshots/{iphone,ipad}/0N-<szene>.png (iPhone 6.9″ 1320×2868, iPad 13″ 2064×2752) */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'screenshots');
const RAW = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-store-raw-'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-store-'));
execSync('cp -r "' + path.join(ROOT, 'app') + '/." "' + TMP + '/"');
fs.rmSync(path.join(TMP, 'data'), { recursive: true, force: true });
/* Test-Hook wie in tests/singleplayer.js: Zugriff auf den Singleplayer, um eine feste Hand zu geben (nur in dieser Wegwerf-Kopie) */
{
  const f = path.join(TMP, 'public', 'index.html'); let h = fs.readFileSync(f, 'utf8');
  const s0 = h.indexOf('<script>\n') + 9, e0 = h.indexOf('</script>', s0), i = h.lastIndexOf('})();', e0);
  if (i < s0) throw new Error('Hook-Stelle nicht gefunden');
  h = h.slice(0, i) + 'window.__kr={sp:function(){return sp;},spNewHand:spNewHand,spStage:spStage,spTake:spTake,spReady:spReady,bestHand:bestHand,cmpHand:cmpHand,render:render,cfg:function(k,v){CFG[k]=v;}};\n' + h.slice(i);
  fs.writeFileSync(f, h);
}
const PORT = 3984, URL0 = 'http://127.0.0.1:' + PORT + '/', DBG = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEVICES = [
  { name: 'iphone', w: 440, h: 956, dsf: 3 },     // 1320 × 2868
  { name: 'ipad', w: 1032, h: 1376, dsf: 2 }       // 2064 × 2752
];
/* Reihenfolge = Reihenfolge im Store */
const SCENES = [
  { id: 'play', title: 'Pokern im Team', sub: 'Ordnet eure Hände von schwach bis stark – ohne darüber zu reden.' },
  { id: 'win', title: 'Gemeinsam gewinnen', sub: 'Stimmt die Reihenfolge, gewinnt ihr alle. Sonst verliert ihr alle.' },
  { id: 'room', title: 'Raum auf, Link raus', sub: 'Mit Freunden in der App oder im Browser – Bots füllen freie Plätze.' },
  { id: 'start', title: 'Einfach loslegen', sub: 'Ohne Konto, ohne Werbung. Allein üben oder im WLAN ohne Internet.' },
  { id: 'stats', title: 'Werdet besser', sub: 'Statistik und Bestenliste mit Freunden – auf allen Geräten.' }
];

let srv, chrome;
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const wait = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } });
  return (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
}

async function scenario(send, dev) {
  const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };
  const click = (sel) => js('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');if(e){e.click();return true;}return false;})()');
  const until = async (expr, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { if (await js(expr)) return true; await sleep(250); } return false; };
  const scrollTo = (sel, off) => js('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');window.scrollTo(0,e?Math.max(0,e.getBoundingClientRect().top+window.scrollY-' + (off || 12) + '):0);return 1;})()');
  const shoot = async (id) => {
    await sleep(500);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(RAW, dev.name + '-' + id + '.png'), Buffer.from(r.result.data, 'base64'));
    console.log(dev.name, id);
  };
  const step = '(function(){var r=document.querySelector(\'[data-a="ready"]\');var mine=document.querySelector(".pl.me .chip:not(.ph)");' +
    'if(!mine){var c=document.querySelector(".p-chips [data-chip]");if(c)c.click();}else if(r&&!r.disabled&&/Bereit$/.test(r.textContent))r.click();' +
    'var gk=document.querySelectorAll("[data-grank]");if(gk.length&&document.querySelector(".gslot .card.empty")){gk[12].click();}' +
    'var cf=document.querySelector(\'[data-a="confirm"]\');if(cf&&!cf.disabled&&/bestätigen/.test(cf.textContent))cf.click();var rv=document.querySelector(\'[data-a="reveal"]\');if(rv)rv.click();return 1;})()';
  const stage = () => js('(function(){var m=/Runde (\\d) von 4/.exec(document.body.innerText);return m?+m[1]:0;})()');

  await send('Emulation.setDeviceMetricsOverride', { width: dev.w, height: dev.h, deviceScaleFactor: dev.dsf, mobile: dev.w < 600 });
  await send('Page.navigate', { url: URL0 });
  await until('!!document.querySelector(\'[data-a="sp"]\')');
  await js('localStorage.clear();localStorage.setItem("kr.name","Simon");localStorage.setItem("kr.sp.bots","3");1');
  await send('Page.reload'); await until('!!document.querySelector(\'[data-a="sp"]\')');
  await js('document.getElementById("name").value="Simon";var pc=document.getElementById("playcount");if(pc)pc.style.display="none";1');   // Zähler des Wegwerf-Servers (0) nicht zeigen
  await shoot('start');

  /* Singleplayer mit festgelegter Hand über den Test-Hook window.__kr (wie tests/singleplayer.js „Screenshot-Hand“):
     du D♦ 3♥ (Drilling), Bots K♠ 6♠ / 9♥ 7♥ / 3♠ 8♣, Tisch D♣ D♠ 7♣ K♦ 2♦ → du nimmst die 4, die Bots ordnen sich 3/2/1 ein. */
  await click('[data-a="sp"]');
  await until('/Singleplayer/.test(document.body.innerText)&&!!window.__kr');
  await js('__kr.cfg("guessEnabled",false);1');   // Tipp aus: die richtige Reihenfolge ist der Sieg
  const cd = (c) => '23456789TJQKA'.indexOf(c[0]) + 13 * 'shdc'.indexOf(c[1]);
  const J = (x) => JSON.stringify(x);
  const deal = (me, b, board, st) => js('(function(){__kr.spNewHand();var s=__kr.sp();s.hole.me=' + J(me) + ';var bb=s.players.filter(function(p){return p.bot;});' +
    'bb.forEach(function(p,k){s.hole[p.id]=' + J(b) + '[k];});s.board=' + J(board) + ';__kr.spStage(' + st + ');__kr.render();return 1;})()');
  const settled = '(function(){var s=__kr.sp();return s.players.filter(function(p){return p.bot;}).every(function(p){return s.chips[p.id]&&s.ready[p.id];});})()';
  const insist = async (n) => { for (let k = 0; k < 12; k++) { await js('__kr.spTake(' + n + ');1'); await sleep(400); await until(settled, 15000); if (await js('__kr.sp().chips.me===' + n)) return true; } return false; };
  const rankMe = '(function(){var s=__kr.sp(),st=function(id){return __kr.bestHand(s.hole[id].concat(s.board),s.hole[id]);},ids=s.players.map(function(p){return p.id;});' +
    'return 1+ids.filter(function(o){return o!=="me"&&__kr.cmpHand(st(o),st("me"))<0;}).length;})()';
  const finish = async () => { await js('__kr.spReady();1'); await until('!!document.querySelector(".p-reveal .result,.endbar")', 40000); await sleep(1200); return js('!!document.querySelector(".result.win")'); };
  const SHOT = { me: ['Qd', '3h'].map(cd), b: [['Ks', '6s'], ['9h', '7h'], ['3s', '8c']].map((h) => h.map(cd)), board: ['Qc', 'Qs', '7c', 'Kd', '2d'].map(cd) };
  await deal(SHOT.me, SHOT.b, SHOT.board, 3);
  await insist(4); await sleep(1500);
  await scrollTo('.p-board'); await shoot('play');
  let won = false;
  for (let t = 0; t < 6 && !won; t++) {
    if (t) await deal(SHOT.me, SHOT.b, SHOT.board, 4); else { await js('__kr.spReady();1'); await until('__kr.sp().stage===4', 20000); }
    await insist(4);
    won = await finish(); console.log(dev.name, 'Screenshot-Hand', t + 1, won ? 'gewonnen' : 'daneben');
  }
  if (!won) throw new Error('Screenshot-Hand nicht gewonnen');
  await scrollTo('.p-board'); await shoot('win');
  /* Statistik: ein paar weitere Hände, jeweils mit dem richtigen Platz */
  for (let h = 0; h < 6; h++) {
    await js('__kr.spNewHand();__kr.spStage(4);1'); await sleep(300);
    await insist(await js(rankMe));
    console.log(dev.name, 'Hand', h + 2, (await finish()) ? 'gewonnen' : 'daneben');
  }
  await click('[data-a="stats"]'); await sleep(800);
  await scrollTo('.stats'); await shoot('stats');
  await click('[data-a="stats"]');

  /* Raum mit 3 Bots und Chat, Runde 2 */
  await click('[data-a="leave"]'); await sleep(600);
  await js('document.getElementById("name").value="Simon";var n=document.getElementById("rname")||document.querySelector("input[placeholder*=Freitag]");if(n)n.value="Freitagsrunde";1');
  await click('[data-a="create"]');
  await until('!!document.querySelector(\'[data-a="addbot"]\')');
  for (let i = 0; i < 3; i++) { await click('[data-a="addbot"]'); await sleep(900); }
  for (const t of ['Wer bringt die Chips mit? 😄', 'Los geht’s – letzte Runde!']) {
    await js('(function(){var i=document.getElementById("chatin");if(i){i.value=' + JSON.stringify(t) + ';document.querySelector(\'[data-a="chat"]\').click();}return 1;})()');
    await sleep(700);
  }
  await click('[data-a="start"]');
  await until('/Runde 1 von 4/.test(document.body.innerText)', 40000);
  for (let i = 0; i < 400 && (await stage()) < 2; i++) { await js(step); await sleep(300); }
  for (let i = 0; i < 40 && !(await js('!!document.querySelector(".pl.me .chip:not(.ph)")')); i++) { await js(step); await sleep(300); }
  await sleep(2500);
  await scrollTo(dev.w < 600 ? '.p-board' : 'body'); await shoot('room');
}

/* Store-Motiv: Filz-Grün mit Überschrift (Logo-Schrift), darunter der Screenshot als „Gerät“ */
function composeHtml(dev, sc, img) {
  const phone = dev.w < 600;
  return '<!doctype html><meta charset="utf-8"><style>' +
    'html,body{margin:0;width:' + dev.w + 'px;height:' + dev.h + 'px;overflow:hidden}' +
    'body{background:radial-gradient(ellipse at 50% 0%,#2a7553 0%,#1f5a41 40%,#16452f 100%);font-family:-apple-system,"SF Pro Text",system-ui,sans-serif;color:#eef5f0;position:relative}' +
    'body:after{content:"";position:absolute;inset:0;background:radial-gradient(circle at 20% 10%,rgba(255,255,255,.06),transparent 40%);pointer-events:none}' +
    '.head{position:absolute;left:0;right:0;top:' + (phone ? 54 : 70) + 'px;text-align:center;padding:0 ' + (phone ? 28 : 90) + 'px}' +
    '.logo{width:' + (phone ? 46 : 62) + 'px;height:auto;display:block;margin:0 auto ' + (phone ? 10 : 14) + 'px;filter:drop-shadow(0 4px 8px rgba(0,0,0,.3))}' +
    'h1{font-family:Georgia,"Iowan Old Style",serif;font-style:italic;font-weight:700;font-size:' + (phone ? 40 : 58) + 'px;line-height:1.08;margin:0 0 ' + (phone ? 12 : 16) + 'px;letter-spacing:-.01em;text-shadow:0 2px 10px rgba(0,0,0,.25)}' +
    'p{font-size:' + (phone ? 19 : 25) + 'px;line-height:1.35;margin:0 auto;max-width:' + (phone ? 360 : 700) + 'px;color:rgba(238,245,240,.88)}' +
    '.dev{position:absolute;left:50%;transform:translateX(-50%);top:' + (phone ? 262 : 300) + 'px;width:' + (phone ? 82 : 78) + '%;' +
      'border-radius:' + (phone ? 44 : 34) + 'px;overflow:hidden;border:' + (phone ? 9 : 12) + 'px solid #0d0f0e;background:#0d0f0e;' +
      'box-shadow:0 30px 60px rgba(0,0,0,.45),0 0 0 2px rgba(255,255,255,.08)}' +
    '.dev img{display:block;width:100%;border-radius:' + (phone ? 35 : 22) + 'px}' +
    '</style><body><div class="head"><img class="logo" src="' + URL0 + 'logo.svg"><h1>' + sc.title + '</h1><p>' + sc.sub + '</p></div>' +
    '<div class="dev"><img src="data:image/png;base64,' + img.toString('base64') + '"></div></body>';
}

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { chrome.kill('SIGKILL'); } catch (e) {} try { srv.kill('SIGKILL'); } catch (e) {} process.exit(1); });
(async () => {
  srv = spawn(process.execPath, ['server.js'], { cwd: TMP, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { await sleep(250); try { if ((await fetch(URL0 + 'api?a=config')).ok) break; } catch (e) { /* startet noch */ } }
  chrome = spawn(process.env.CHROME || 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=' + DBG, '--user-data-dir=' + path.join(TMP, 'chr'), 'about:blank'], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 50; i++) { try { list = await (await fetch('http://127.0.0.1:' + DBG + '/json')).json(); break; } catch (e) { await sleep(200); } }
  const send = await connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await send('Page.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });   // ohne Gewinn-Animation
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.KR_APP={app:true,mode:"online",origin:"https://gang.aize.eu"};' });
  for (const dev of DEVICES) await scenario(send, dev);

  /* Motive setzen */
  for (const dev of DEVICES) {
    const dir = path.join(OUT, dev.name); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    await send('Emulation.setDeviceMetricsOverride', { width: dev.w, height: dev.h, deviceScaleFactor: dev.dsf, mobile: false });
    for (let i = 0; i < SCENES.length; i++) {
      const sc = SCENES[i], f = path.join(RAW, dev.name + '-' + sc.id + '.png'), html = path.join(RAW, 'c.html');
      fs.writeFileSync(html, composeHtml(dev, sc, fs.readFileSync(f)));
      await send('Page.navigate', { url: 'file://' + html }); await sleep(900);
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const outf = path.join(dir, '0' + (i + 1) + '-' + sc.id + '.png');
      fs.writeFileSync(outf, Buffer.from(r.result.data, 'base64')); console.log(outf);
    }
  }
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    try { chrome.kill('SIGKILL'); } catch (e) {} try { srv.kill('SIGKILL'); } catch (e) {}
    setTimeout(() => { for (const d of [TMP, RAW]) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch (e) { /* egal */ } process.exit(process.exitCode || 0); }, 600);
  });
