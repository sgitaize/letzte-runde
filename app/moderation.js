/* Moderation: Wortfilter für Chat, Spieler- und Raumnamen sowie Meldungen an den Admin.
 * (App-Store-Richtlinie 1.2: Filter, Melden, Stummschalten – Stummschalten läuft nur im Client.)
 *
 *   filter(s)            -> s mit ***** statt anstößiger Wörter (gleiche Länge, Rest unverändert)
 *   report(r, code, …)   -> Meldung speichern (data/moderation/reports.json, max. REP_KEEP), false bei Dublette
 *   POST /admin-api?a=reports | repdone {id} | repdone {all:true}
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REP_KEEP = 300;
/* Wortstämme (klein, ohne Umlaute → ae/oe/ue/ss). Treffer am Wortanfang, damit auch Beugungen greifen
   („fotzen“, „wichser“); Wörter, die harmlos in anderen stecken (z. B. „analyse“), stehen nicht in der Liste. */
const STEMS = ['arschloch', 'arschgeige', 'wichser', 'wixxer', 'wixer', 'fotze', 'hurensohn', 'hure', 'nutte', 'schlampe', 'missgeburt',
  'spast', 'spasti', 'behindi', 'schwuchtel', 'kanake', 'kanacke', 'neger', 'nigger', 'nigga', 'zigeuner', 'judensau',
  'kinderficker', 'pisser', 'ficken', 'fick', 'fuck', 'motherfucker', 'cunt', 'whore', 'slut', 'bitch', 'faggot', 'retard',
  'dickhead', 'asshole', 'bastard', 'hitler', 'sieg heil', 'heil hitler', 'nazi', 'kill yourself', 'bring dich um'];
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
function norm(ch) {
  const c = ch.toLowerCase();
  return LEET[c] || ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' })[c] || c;
}
/* Normalisierte Fassung + Zuordnung jeder normalisierten Stelle zur Originalstelle */
function normalize(s) {
  let out = '', map = [];
  for (let i = 0; i < s.length; i++) { const n = norm(s[i]); for (const c of n) { out += c; map.push(i); } }
  return { out, map };
}
const RE = new RegExp('(^|[^a-z])(' + STEMS.map((w) => w.replace(/ /g, '[^a-z]*')).join('|') + ')', 'g');

function filter(s) {
  s = String(s == null ? '' : s);
  if (!s) return s;
  const { out, map } = normalize(s);
  const hit = new Array(s.length).fill(false);
  let m; RE.lastIndex = 0;
  while ((m = RE.exec(out))) {
    const a = m.index + m[1].length;
    let b = a + m[2].length;
    while (b < out.length && /[a-z]/.test(out[b])) b++;   // ganzes Wort bis zum Ende ausblenden
    for (let i = a; i < b; i++) hit[map[i]] = true;
    if (RE.lastIndex === m.index) RE.lastIndex++;
  }
  if (!hit.some(Boolean)) return s;
  return s.split('').map((c, i) => (hit[i] && /\S/.test(c) ? '*' : c)).join('');
}

module.exports = function (o) {
  /* eigener Unterordner: *.json direkt in data/ gelten als Räume (Aufräumen, Zähler) */
  const DIR = path.join(o.dataDir, 'moderation'), FILE = path.join(DIR, 'reports.json');
  try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); } catch (e) { /* egal */ }
  let reports = [];
  try { reports = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (!Array.isArray(reports)) reports = []; } catch (e) { reports = []; }
  let saveTimer = null;
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(reports), { mode: 0o600 }); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.error('Meldungen speichern: ' + e.message); }
    }, 500);
  }
  const REASONS = ['beleidigung', 'spam', 'name', 'sonstiges'];

  /* Meldung aus einem Raum: Namen und letzte Chatzeilen nimmt der Server selbst (nicht vom Client) */
  function report(r, code, who, target, reason, note) {
    if (!REASONS.includes(reason)) reason = 'sonstiges';
    const key = code + '|' + who + '|' + target;
    if (reports.some((x) => x.key === key && Date.now() - x.ts < 3600000)) return false;
    const nm = (id) => o.cleanName((r.docs['players/' + id] || {}).name).slice(0, 24);
    const chat = ((r.docs.chat && r.docs.chat.msgs) || []).slice(-20).map((c) => ({ id: c.id === target ? 'T' : c.id === who ? 'R' : '', name: String(c.name || '').slice(0, 24), text: String(c.text || '').slice(0, 300), ts: c.ts }));
    reports.push({ id: crypto.randomBytes(6).toString('hex'), key: key, ts: Date.now(), room: code, roomName: String((r.docs.room && r.docs.room.name) || '').slice(0, 30),
      target: nm(target), by: nm(who), reason: reason, note: String(note || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 300), chat: chat });
    reports = reports.slice(-REP_KEEP);
    save();
    console.log('Meldung in Raum ' + code + ' (' + reason + ')');
    return true;
  }

  async function admin(a, req, res) {
    if (a === 'reports') return o.json(res, 200, { ok: true, reports: reports.slice().reverse().map((x) => { const y = Object.assign({}, x); delete y.key; return y; }) }), true;
    if (a === 'repdone') {
      let b; try { b = await o.readBody(req); } catch (e) { return o.json(res, 400, { error: 'Body' }), true; }
      const n = reports.length;
      reports = b.all ? [] : reports.filter((x) => x.id !== String(b.id || ''));
      save();
      return o.json(res, 200, { ok: true, removed: n - reports.length }), true;
    }
    return false;
  }
  return { report, admin, flush: () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; try { fs.writeFileSync(FILE, JSON.stringify(reports), { mode: 0o600 }); } catch (e) { /* egal */ } } } };
};
module.exports.filter = filter;
