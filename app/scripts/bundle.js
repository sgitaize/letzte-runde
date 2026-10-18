#!/usr/bin/env node
/**
 * Spiel-Bundle für die Apps (Spiellogik nachladen ohne Store-Release).
 *
 *   node app/scripts/bundle.js keygen          Schlüsselpaar (Ed25519) erzeugen: privat nach $KR_BUNDLE_KEY
 *                                               (Standard ~/.letzte-runde/bundle-key.pem, nie ins Repo),
 *                                               öffentlich nach app/bundle-key.pub (ins Repo, die Apps prüfen damit)
 *   node app/scripts/bundle.js build           app/bundle.json erzeugen und signieren (deploy.sh, vor dem Hochladen)
 *   node app/scripts/bundle.js verify [datei]  Manifest gegen app/bundle-key.pub und die Dateien prüfen
 *
 * build-Nummer = Unix-Sekunden; die Apps nehmen nur Bundles, die neuer sind als ihr eingebautes (game/bundle.json,
 * beim App-Build mit derselben Uhr gestempelt) und sich in mindestens einer Datei unterscheiden.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const B = require('../bundle-manifest.js');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'bundle-key.pub');
const KEY = process.env.KR_BUNDLE_KEY || path.join(os.homedir(), '.letzte-runde', 'bundle-key.pem');
const OUT = path.join(ROOT, 'bundle.json');
const die = (msg) => { console.error(msg); process.exit(1); };

function hostApi() {
  const m = /const HOST_API = (\d+);/.exec(fs.readFileSync(path.join(ROOT, 'app-host.js'), 'utf8'));
  return m ? Number(m[1]) : 1;
}
const cmd = process.argv[2];
if (cmd === 'keygen') {
  if (fs.existsSync(KEY) && process.argv[3] !== '--force') die('Privater Schlüssel existiert schon: ' + KEY + ' (neu erzeugen mit --force – dann brauchen alle Apps einen neuen öffentlichen Schlüssel)');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(KEY), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(PUB, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log('Privater Schlüssel: ' + KEY + '  (sichern, nie ins Repo; auf dem Deploy-Rechner als KR_BUNDLE_KEY)');
  console.log('Öffentlicher Schlüssel: ' + PUB + '  (committen, dann Apps bauen)');
} else if (cmd === 'build') {
  if (!fs.existsSync(KEY)) die('Kein privater Schlüssel unter ' + KEY + ' – erst „node app/scripts/bundle.js keygen“ bzw. KR_BUNDLE_KEY setzen');
  const priv = fs.readFileSync(KEY, 'utf8');
  if (fs.existsSync(PUB) && crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' }) !== fs.readFileSync(PUB, 'utf8'))
    die('Privater Schlüssel passt nicht zu app/bundle-key.pub – die Apps würden das Bundle ablehnen');
  const m = { v: 1, build: Math.floor(Date.now() / 1000), logic: require('../public/hand.js').LOGIC_VERSION, minHost: hostApi(), files: B.hashes(ROOT) };
  m.sig = B.sign(m, priv);
  fs.writeFileSync(OUT, JSON.stringify(m));
  const n = Object.keys(m.files).length, kb = Math.round(Object.values(m.files).reduce((a, f) => a + f.n, 0) / 1024);
  console.log('bundle.json: Build ' + m.build + ', Spiellogik ' + m.logic + ', App-Host ab ' + m.minHost + ', ' + n + ' Dateien, ' + kb + ' KB');
} else if (cmd === 'verify') {
  const f = process.argv[3] || OUT;
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!B.verify(m, fs.readFileSync(PUB, 'utf8'))) die('Signatur ungültig');
  const bad = Object.keys(m.files).filter((rel) => !fs.existsSync(path.join(ROOT, rel)) || B.hashFile(path.join(ROOT, rel)) !== m.files[rel].h);
  if (bad.length) die('Signatur ok, aber Dateien weichen ab: ' + bad.join(', '));
  console.log('ok: Build ' + m.build + ', ' + Object.keys(m.files).length + ' Dateien');
} else {
  die('Nutzung: node app/scripts/bundle.js keygen|build|verify');
}
