/* Erzeugt die Vorab-Tabelle für hand.js: Anteil der Einzelduelle, die eine Starthand (2 Karten, leerer Tisch)
   nach der Hausregel gewinnt (Unentschieden halb). Erwarteter Rang bei n Spielern ≈ 1 + (n-1)·p.
   Nutzung: node tests/gen-preflop.js [sims je Hand]  → druckt die Tabelle (169 Werte, Reihenfolge siehe preKey in hand.js) */
'use strict';
const { fork } = require('child_process'), path = require('path');
const H = require(path.join(__dirname, '../app/public/hand.js'));
const SIMS = +process.argv[2] || 10000;
const classes = []; for (let a = 12; a >= 0; a--) for (let b = a; b >= 0; b--) { classes.push([a, b, 0]); if (a !== b) classes.push([a, b, 1]); }
if (process.env.KR_PART) {
  const [k, of] = process.env.KR_PART.split('/').map(Number), out = {};
  classes.forEach(([a, b, s], i) => {
    if (i % of !== k) return;
    const hole = [a, s ? b : b + 13], known = new Set(hole), deck = []; for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);
    let w = 0;
    for (let n = 0; n < SIMS; n++) {
      const d = deck.slice(); for (let j = 0; j < 7; j++) { const r = j + Math.floor(Math.random() * (d.length - j)); [d[j], d[r]] = [d[r], d[j]]; }
      const board = d.slice(2, 7), x = H.cmpHand(H.bestHand(hole.concat(board), hole), H.bestHand(d.slice(0, 2).concat(board), d.slice(0, 2)));
      w += x > 0 ? 1 : x === 0 ? 0.5 : 0;
    }
    out[H.preKey(hole)] = w / SIMS;
  });
  process.send(out); process.exit(0);
} else {
  const P = 4, res = {}; let done = 0;
  for (let k = 0; k < P; k++) fork(__filename, [String(SIMS)], { env: Object.assign({}, process.env, { KR_PART: k + '/' + P }) })
    .on('message', (m) => { Object.assign(res, m); if (++done === P) { const a = []; for (let i = 0; i < 169; i++) a.push(Math.round(res[i] * 1000)); console.log(a.join(',')); } });
}
