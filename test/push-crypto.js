'use strict';
/*
 * Web Push crypto unit tests (src/push.js): the VAPID JWT has the
 * right structure and a verifiable ES256 signature, and the RFC 8291
 * aes128gcm payload encryption round-trips — decrypting here with the
 * subscription's private key exactly like a push service / browser
 * would. No server needed: node test/push-crypto.js
 */
import { buildVapidJwt, encryptPayload, b64urlEncode, b64urlDecode } from '../src/push.js';

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}
const subtle = crypto.subtle;
const enc = new TextEncoder();

function cat(...ps) {
  const t = ps.reduce((n, p) => n + p.length, 0);
  const o = new Uint8Array(t);
  let f = 0;
  for (const p of ps) { o.set(p, f); f += p.length; }
  return o;
}
async function hkdf(salt, ikm, info, len) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

async function main() {
  // ------------------------------------------------------------ VAPID JWT
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privJwk = await subtle.exportKey('jwk', kp.privateKey);
  const jwt = await buildVapidJwt(privJwk, 'https://fcm.googleapis.com', 'mailto:admin@uno-adda.local');
  const parts = jwt.split('.');
  check('jwt: three parts', parts.length === 3);
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  check('jwt: header is ES256', header.alg === 'ES256' && header.typ === 'JWT');
  check('jwt: aud is the push origin', payload.aud === 'https://fcm.googleapis.com');
  check('jwt: sub is the admin mailto', payload.sub === 'mailto:admin@uno-adda.local');
  check('jwt: exp within 24h', payload.exp > Date.now() / 1000 && payload.exp <= Date.now() / 1000 + 86400);
  const sigOk = await subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey,
    b64urlDecode(parts[2]), enc.encode(parts[0] + '.' + parts[1])
  );
  check('jwt: ES256 signature verifies with the public key', sigOk);

  // ------------------------------------------------------------ RFC 8291 round-trip
  const uaKeys = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPublic = new Uint8Array(await subtle.exportKey('raw', uaKeys.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const keys = { p256dh: b64urlEncode(uaPublic), auth: b64urlEncode(auth) };
  const plaintext = JSON.stringify({ title: 'অফার!', body: 'আজ রাত ৯টায় টুর্নামেন্ট 🎉', url: '/' });
  const body = await encryptPayload(keys, plaintext);
  check('push: body has the aes128gcm header layout', body.length > 21 + 65 + plaintext.length);

  const salt = body.slice(0, 16);
  const idLen = body[20];
  check('push: key id length is 65 (uncompressed point)', idLen === 65);
  const serverPublic = body.slice(21, 21 + idLen);
  const ciphertext = body.slice(21 + idLen);
  const serverKey = await subtle.importKey('raw', serverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: serverKey }, uaKeys.privateKey, 256));
  const ikm = await hkdf(auth, secret, cat(enc.encode('WebPush: info\0'), uaPublic, serverPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, ciphertext));
  check('push: final-record delimiter is 0x02', plain[plain.length - 1] === 2);
  check('push: payload round-trips byte-for-byte', new TextDecoder().decode(plain.slice(0, -1)) === plaintext);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
