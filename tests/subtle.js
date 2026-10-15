/* Prüft app/public/kr-subtle.js gegen die echte Web-Crypto (Node): ECDH beidseitig, AES-GCM beidseitig, JWK-Rundreise. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const real = require('crypto').webcrypto;
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'kr-subtle.js'), 'utf8');
const fakeCrypto = { getRandomValues: (a) => real.getRandomValues(a) };
const win = { crypto: fakeCrypto };
vm.runInNewContext(src, { window: win, btoa, atob, DOMException, Uint8Array, ArrayBuffer, Promise, Object, Error, Math, String, Array, TextEncoder, TextDecoder, crypto: fakeCrypto });
const shim = win.crypto.subtle;
let ok = 0, bad = 0;
function check(name, cond) { if (cond) ok++; else { bad++; console.log('✗ ' + name); } }
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));
(async () => {
  check('shim aktiv', !!shim && typeof shim.generateKey === 'function');
  for (let round = 0; round < 20; round++) {
    const a = await shim.generateKey(EC, true, ['deriveBits']);
    const b = await real.subtle.generateKey(EC, true, ['deriveBits']);
    const aPub = await shim.exportKey('jwk', a.publicKey), bPub = await real.subtle.exportKey('jwk', b.publicKey);
    const aPriv = await shim.exportKey('jwk', a.privateKey);
    // JWK der Ersatzbibliothek muss die echte Web-Crypto importieren können und umgekehrt
    const aPrivReal = await real.subtle.importKey('jwk', aPriv, EC, true, ['deriveBits']);
    const bPubShim = await shim.importKey('jwk', bPub, EC, true, []);
    const aPubReal = await real.subtle.importKey('jwk', aPub, EC, true, []);
    const s1 = await shim.deriveBits({ name: 'ECDH', public: bPubShim }, a.privateKey, 256);
    const s2 = await real.subtle.deriveBits({ name: 'ECDH', public: aPubReal }, b.privateKey, 256);
    const s3 = await real.subtle.deriveBits({ name: 'ECDH', public: await real.subtle.importKey('jwk', bPub, EC, true, []) }, aPrivReal, 256);
    check('ECDH gleich ' + round, eq(s1, s2) && eq(s1, s3) && s1.byteLength === 32);
    // AES-GCM: shim verschlüsselt, echt entschlüsselt und umgekehrt
    const kS = await shim.importKey('raw', s1, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const kR = await real.subtle.importKey('raw', s2, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const iv = real.getRandomValues(new Uint8Array(12));
    const msg = new TextEncoder().encode(JSON.stringify({ hand: [round, 51 - round], t: 'Karte' }));
    const c1 = await shim.encrypt({ name: 'AES-GCM', iv }, kS, msg);
    const c2 = await real.subtle.encrypt({ name: 'AES-GCM', iv }, kR, msg);
    check('AES-GCM gleiches Chiffrat ' + round, eq(c1, c2));
    check('echt entschlüsselt shim ' + round, eq(await real.subtle.decrypt({ name: 'AES-GCM', iv }, kR, c1), msg));
    check('shim entschlüsselt echt ' + round, eq(await shim.decrypt({ name: 'AES-GCM', iv }, kS, c2), msg));
    const bad1 = new Uint8Array(c1); bad1[0] ^= 1;
    check('Manipulation erkannt ' + round, await shim.decrypt({ name: 'AES-GCM', iv }, kS, bad1).then(() => false, () => true));
  }
  // Fremder Punkt (nicht auf der Kurve) wird abgelehnt
  check('ungültiger Punkt abgelehnt', await shim.importKey('jwk', { kty: 'EC', crv: 'P-256', x: 'AQ', y: 'AQ' }, EC, true, []).then(() => false, () => true));
  console.log((bad ? '✗ ' : '✓ ') + ok + '/' + (ok + bad) + ' kr-subtle');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
