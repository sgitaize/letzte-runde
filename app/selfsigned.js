/**
 * Selbst signiertes Zertifikat für den WLAN-Host (HTTPS ohne Internet). Node ≥ 18, ohne Abhängigkeiten.
 * Schlüssel: ECDSA P-256, einmal je Gerät erzeugt und in <dir>/lan-cert.json abgelegt (App-Container).
 * Der SHA-256-Fingerabdruck wird neben dem QR-Code angezeigt, damit Gäste die Browserwarnung prüfen können.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* --- minimales DER --- */
function len(n) {
  if (n < 128) return Buffer.from([n]);
  const b = []; while (n > 0) { b.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | b.length].concat(b));
}
function tlv(tag, body) { return Buffer.concat([Buffer.from([tag]), len(body.length), body]); }
const seq = (...a) => tlv(0x30, Buffer.concat(a));
const set = (...a) => tlv(0x31, Buffer.concat(a));
function oid(s) {
  const p = s.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const b = [v & 0x7f]; let x = v >> 7;
    while (x > 0) { b.unshift(0x80 | (x & 0x7f)); x >>= 7; }
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
function int(buf) { if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]); return tlv(0x02, buf); }
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
function time(d) {   // UTCTime bis 2049, danach GeneralizedTime
  const z = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const body = z(d.getUTCMonth() + 1) + z(d.getUTCDate()) + z(d.getUTCHours()) + z(d.getUTCMinutes()) + z(d.getUTCSeconds()) + 'Z';
  return y < 2050 ? tlv(0x17, Buffer.from(String(y).slice(2) + body)) : tlv(0x18, Buffer.from(y + body));
}
const ctx = (n, body, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, body);

function create(cn) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const algo = seq(oid('1.2.840.10045.4.3.2'));                       // ecdsa-with-SHA256
  const name = seq(set(seq(oid('2.5.4.3'), utf8(cn))));
  const now = new Date(Date.now() - 86400000);
  const end = new Date(Date.now() + 397 * 86400000);                    // ≤ 398 Tage (Apple-Vorgabe)
  const san = seq(tlv(0x82, Buffer.from('localhost')));                 // dNSName; IP-Adressen wechseln im WLAN
  const exts = ctx(3, seq(
    seq(oid('2.5.29.17'), tlv(0x04, san)),                             // subjectAltName
    seq(oid('2.5.29.37'), tlv(0x04, seq(oid('1.3.6.1.5.5.7.3.1')))),  // extKeyUsage serverAuth
  ));
  const tbs = seq(ctx(0, int(Buffer.from([2]))), int(crypto.randomBytes(16)), algo, name, seq(time(now), time(end)), name, spki, exts);
  const sig = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, algo, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const pem = '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
  const fp = crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g).join(':');
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem, fingerprint: fp, expires: end.getTime() };
}

/* Lädt das Zertifikat aus <dir>/lan-cert.json oder erzeugt ein neues (auch 30 Tage vor Ablauf). */
function load(dir) {
  const f = path.join(dir, 'lan-cert.json');
  try {
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (c.key && c.cert && c.expires > Date.now() + 30 * 86400000) return c;
  } catch (e) { /* neu erzeugen */ }
  const c = create('Letzte Runde (WLAN)');
  fs.writeFileSync(f, JSON.stringify(c), { mode: 0o600 });
  return c;
}
module.exports = { create, load };
