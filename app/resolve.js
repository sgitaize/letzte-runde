/**
 * Verbindliche Auswertung einer fertigen Hand auf dem Server (ohne Bots, ohne Abhängigkeiten).
 *
 * Nach dem Aufdecken liegt alles Nötige offen im Raum:
 *   Tisch:  deal/boardA.keys[i] = {s: Platz im Deck, k}, deal/boardB.keys[i] = {k}, Chiffrat deal/deck.cts[s]
 *   Hände:  reveal/<id> = {slots, k1[], k2[]}  (die mitgeschickten „cards“ des Clients zählen nicht – nachgerechnet)
 *   Karte = AES-GCM mit Schlüssel k1 XOR k2 (hex), „iv.ct“ in base64, Klartext 1 Byte Kartenindex (wie decCard im Browser).
 * Gewertet wird mit hand.js resolve() – dieselbe Fassung wie im Browser und bei den Bots.
 */
'use strict';
const crypto = require('crypto');
const H = require('./public/hand.js');

function decCard(k1, k2, s) {
  const a = Buffer.from(String(k1), 'hex'), b = Buffer.from(String(k2), 'hex');
  if (a.length !== 32 || b.length !== 32) throw new Error('Schlüssel');
  const key = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) key[i] = a[i] ^ b[i];
  const p = String(s).split('.'), iv = Buffer.from(p[0] || '', 'base64'), ct = Buffer.from(p[1] || '', 'base64');
  if (iv.length !== 12 || ct.length < 17) throw new Error('Chiffrat');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  if (pt.length !== 1 || pt[0] > 51) throw new Error('Karte');
  return pt[0];
}

/* Liefert {hand, logic, res} oder null, wenn die Hand (noch) nicht auswertbar ist (nicht fertig, Tisch unvollständig) */
function resolveRoom(r) {
  const docs = r.docs || {}, m = docs['state/main'] || {}, h = Number(m.hand) || 0;
  if (m.phase !== 'done' || !h) return null;
  const ok = (d) => d && Number(d.hand) === h;
  const deck = docs['deal/deck'], bA = docs['deal/boardA'], bB = docs['deal/boardB'];
  if (!ok(deck) || !ok(bA) || !ok(bB) || !Array.isArray(deck.cts)) return null;
  const board = [], boardSlots = new Set();
  for (let i = 0; i < 5; i++) {
    const a = (bA.keys || {})[String(i)], b = (bB.keys || {})[String(i)];
    if (!a || !b || !Number.isInteger(a.s) || !deck.cts[a.s]) return null;
    board.push(decCard(a.k, b.k, deck.cts[a.s]));
    boardSlots.add(a.s);
  }
  const parts = Array.isArray(m.participants) ? m.participants.map(String) : [];
  const h4 = (m.chipHist || {})['4'] || {}, used = new Set(boardSlots);
  const players = parts.map((id) => {
    let chip = h4[id] != null ? Number(h4[id]) : null;
    if (chip == null) for (const k of Object.keys(docs)) { const c = docs[k]; if (k.indexOf('chips/') === 0 && c && c.hand === h && c.holder === id) chip = Number(k.slice(6)); }
    let cards = null;
    const rv = docs['reveal/' + id];
    try {
      /* Nur eigene Plätze: keine Tischkarten, keine doppelt aufgedeckten Plätze (sonst könnte man fremde Schlüssel „vorzeigen“) */
      if (ok(rv) && Array.isArray(rv.slots) && rv.slots.length && rv.slots.length <= 5 && Array.isArray(rv.k1) && Array.isArray(rv.k2) &&
          rv.slots.every((s) => Number.isInteger(s) && deck.cts[s] && !used.has(s))) {
        cards = rv.slots.map((s, i) => decCard(rv.k1[i], rv.k2[i], deck.cts[s]));
        rv.slots.forEach((s) => used.add(s));
      }
    } catch (e) { cards = null; }            // falsche Schlüssel → zählt als nicht aufgedeckt
    return { id, chip: Number.isFinite(chip) ? chip : null, cards };
  });
  const g = docs['state/guess'];
  const res = H.resolve({ board, players, guess: ok(g) && m.target ? { target: String(m.target), cards: g.cards } : null });
  return res ? { hand: h, logic: H.LOGIC_VERSION, res } : null;
}

/* Kurzform für das Raum-Dokument state/result (ohne Kartenobjekte) */
function resultDoc(x) {
  const by = {};
  for (const id of Object.keys(x.res.by)) {
    const p = x.res.by[id];
    by[id] = p.hand ? { chip: p.chip, lo: p.lo, hi: p.hi, ok: !!p.ok, swaps: p.swaps || [] } : { chip: p.chip, missing: true };
  }
  const gr = x.res.gr;
  return { hand: x.hand, logic: x.logic, ts: Date.now(), by, bad: x.res.bad, missing: x.res.missing, orderOk: x.res.orderOk, guessOk: x.res.guessOk,
    win: x.res.win, part: x.res.part, guess: gr ? { target: gr.target, hits: gr.hits, of: gr.of } : null };
}

module.exports = { resolveRoom, resultDoc, decCard };
