/**
 * Spiel-Bundle für die Apps: welche Dateien gehören dazu, Prüfsummen, Signatur (Ed25519).
 *
 * Gemeinsam für scripts/bundle.js (erzeugt app/bundle.json beim Deploy), server.js (liefert Manifest + Dateien aus)
 * und app-host.js (lädt in der App nach, prüft, schaltet um). Nur Node-Standardmodule.
 *
 * Manifest: { v: 1, build: <Unix-Sekunden>, logic: <hand.js LOGIC_VERSION>, minHost: <app-host.js HOST_API>,
 *             files: { "public/index.html": { h: <sha256 hex>, n: <Bytes> }, … }, sig: <base64> }
 * Signiert wird canon(manifest) – die Felder in fester Reihenfolge, Dateien sortiert.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* Nicht im Bundle: der App-Host selbst (ändert sich nur mit einem Store-Release), Service Worker und Admin (nur Web),
   Passwort-Verknüpfungen (.well-known), Laufzeitdaten */
const SERVER_FILES = ['server.js', 'bots.js', 'accounts.js', 'moderation.js', 'resolve.js', 'bundle-manifest.js', 'package.json'];
const SKIP_PUBLIC = /^(sw\.js|admin\.html)$|^\./;

function fileList(root) {
  const out = SERVER_FILES.filter((f) => fs.existsSync(path.join(root, f)));
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (rel === 'public/' && SKIP_PUBLIC.test(name)) continue;
      if (name[0] === '.') continue;
      const full = path.join(dir, name), st = fs.statSync(full);
      if (st.isDirectory()) walk(full, rel + name + '/');
      else if (st.isFile()) out.push(rel + name);
    }
  };
  walk(path.join(root, 'public'), 'public/');
  return out;
}
function hashFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function hashes(root, list) {
  const files = {};
  for (const rel of list || fileList(root)) {
    const full = path.join(root, rel);
    files[rel] = { h: hashFile(full), n: fs.statSync(full).size };
  }
  return files;
}
function canon(m) {
  const files = {};
  for (const k of Object.keys(m.files || {}).sort()) files[k] = { h: String(m.files[k].h), n: Number(m.files[k].n) };
  return JSON.stringify({ v: Number(m.v), build: Number(m.build), logic: Number(m.logic), minHost: Number(m.minHost), files });
}
/* Pfad aus dem Manifest: nur relative Pfade ohne „..“, Backslash oder Steuerzeichen */
function safeRel(rel) { return typeof rel === 'string' && rel.length < 200 && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(rel) && rel.split('/').indexOf('..') < 0; }
function verify(m, pubPem) {
  try {
    if (!m || m.v !== 1 || !Number.isInteger(m.build) || !m.files || typeof m.sig !== 'string') return false;
    if (!Object.keys(m.files).every(safeRel) || !m.files['public/index.html'] || !m.files['server.js']) return false;
    return crypto.verify(null, Buffer.from(canon(m)), crypto.createPublicKey(pubPem), Buffer.from(m.sig, 'base64'));
  } catch (e) { return false; }
}
function sign(m, privPem) { return crypto.sign(null, Buffer.from(canon(m)), crypto.createPrivateKey(privPem)).toString('base64'); }

module.exports = { fileList, hashFile, hashes, canon, verify, sign, safeRel, SERVER_FILES };
