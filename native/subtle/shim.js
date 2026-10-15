/**
 * Ersatz für crypto.subtle, nur für WLAN-Gäste über http:// (dort gibt es im Browser keine Web-Crypto).
 * Deckt genau ab, was index.html nutzt: ECDH P-256 (JWK, deriveBits 256) und AES-GCM (raw, 12-Byte-IV,
 * 128-Bit-Tag am Ende wie Web-Crypto). Rechnet mit @noble/curves + @noble/ciphers (geprüft, MIT).
 * Wird nur aktiv, wenn crypto.subtle fehlt.
 */
import { p256 } from '@noble/curves/p256';
import { gcm } from '@noble/ciphers/aes';

(function () {
  var c = window.crypto;
  if (!c || c.subtle) return;
  function u8(x) { return x instanceof Uint8Array ? x : ArrayBuffer.isView(x) ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : new Uint8Array(x); }
  function ab(u) { return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); }
  function b64u(u) { var s = ''; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function ub64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; var b = atob(s), o = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; }
  function Key(type, alg, extractable, usages, data) { this.type = type; this.algorithm = alg; this.extractable = extractable; this.usages = usages; this._d = data; }
  var EC = { name: 'ECDH', namedCurve: 'P-256' };
  function pubKey(point) { return new Key('public', EC, true, [], { pub: point }); }
  function privKey(priv, ext, us) { return new Key('private', EC, ext, us, { priv: priv, pub: p256.getPublicKey(priv, false) }); }
  function name(a) { return (typeof a === 'string' ? a : a && a.name || '').toUpperCase(); }
  function fail(m) { return Promise.reject(new DOMException(m, 'NotSupportedError')); }
  var subtle = {
    generateKey: function (alg, ext, us) {
      if (name(alg) !== 'ECDH') return fail('generateKey');
      var priv = p256.utils.randomPrivateKey();
      var k = privKey(priv, ext, us);
      return Promise.resolve({ privateKey: k, publicKey: pubKey(k._d.pub) });
    },
    importKey: function (fmt, data, alg, ext, us) {
      try {
        if (name(alg) === 'ECDH' && fmt === 'jwk') {
          var x = ub64u(data.x), y = ub64u(data.y), pt = new Uint8Array(65);
          pt[0] = 4; pt.set(x, 1); pt.set(y, 33);
          p256.ProjectivePoint.fromHex(pt).assertValidity();
          if (data.d) return Promise.resolve(privKey(ub64u(data.d), ext, us));
          return Promise.resolve(pubKey(pt));
        }
        if (name(alg) === 'AES-GCM' && fmt === 'raw') {
          var raw = u8(data).slice();
          if ([16, 24, 32].indexOf(raw.length) < 0) throw new Error('AES-Schlüssellänge');
          return Promise.resolve(new Key('secret', { name: 'AES-GCM', length: raw.length * 8 }, ext, us, { raw: raw }));
        }
      } catch (e) { return Promise.reject(e); }
      return fail('importKey ' + fmt);
    },
    exportKey: function (fmt, key) {
      if (fmt !== 'jwk' || name(key.algorithm) !== 'ECDH') return fail('exportKey ' + fmt);
      var pt = key._d.pub, j = { kty: 'EC', crv: 'P-256', x: b64u(pt.slice(1, 33)), y: b64u(pt.slice(33, 65)), ext: true };
      if (key.type === 'private') { j.d = b64u(key._d.priv); j.key_ops = ['deriveBits']; } else j.key_ops = [];
      return Promise.resolve(j);
    },
    deriveBits: function (alg, priv, bits) {
      if (name(alg) !== 'ECDH' || bits !== 256) return fail('deriveBits');
      try { return Promise.resolve(ab(p256.getSharedSecret(priv._d.priv, alg.public._d.pub, true).slice(1))); }
      catch (e) { return Promise.reject(e); }
    },
    encrypt: function (alg, key, data) {
      try { return Promise.resolve(ab(gcm(key._d.raw, u8(alg.iv)).encrypt(u8(data)))); } catch (e) { return Promise.reject(e); }
    },
    decrypt: function (alg, key, data) {
      try { return Promise.resolve(ab(gcm(key._d.raw, u8(alg.iv)).decrypt(u8(data)))); }
      catch (e) { return Promise.reject(new DOMException('Entschlüsselung fehlgeschlagen', 'OperationError')); }
    }
  };
  try { Object.defineProperty(c, 'subtle', { value: subtle, configurable: true }); } catch (e) { /* älterer Browser */ }
})();
