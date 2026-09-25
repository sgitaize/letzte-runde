/**
 * Einrichtung/Prüfung für Plesk: Node.js → „Run script" → setup
 * Prüft Node-Version, legt data/ und logs/ an, testet Schreibrechte
 * und startet die App neu (tmp/restart.txt).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let ok = true;
const say = (good, msg) => { console.log((good ? '[OK]     ' : '[FEHLER] ') + msg); if (!good) ok = false; };

const major = Number(process.versions.node.split('.')[0]);
say(major >= 18, 'Node ' + process.version + (major >= 18 ? '' : ' – bitte in Plesk Node 18 oder neuer wählen'));

for (const f of ['server.js', 'public/index.html', 'public/admin.html']) {
  say(fs.existsSync(path.join(ROOT, f)), 'Datei vorhanden: ' + f);
}

for (const d of ['data', 'logs', 'tmp']) {
  const dir = path.join(ROOT, d);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    say(true, 'Ordner beschreibbar: ' + d + '/');
  } catch (e) {
    say(false, 'Ordner ' + d + '/ nicht beschreibbar: ' + e.message);
  }
}

say(true, 'ADMIN_SECRET ' + (process.env.ADMIN_SECRET ? 'gesetzt' : 'nicht gesetzt – wird beim ersten Start erzeugt (data/admin-secret.txt)'));

try {
  const now = new Date();
  const f = path.join(ROOT, 'tmp', 'restart.txt');
  fs.closeSync(fs.openSync(f, 'a'));
  fs.utimesSync(f, now, now);
  say(true, 'Neustart angestoßen (tmp/restart.txt)');
} catch (e) {
  say(false, 'Neustart nicht möglich: ' + e.message);
}

console.log(ok ? '\nAlles bereit.' : '\nBitte die Fehler oben beheben.');
process.exitCode = ok ? 0 : 1;
