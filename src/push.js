/*
 * UNO Adda — Web Push sending (RFC 8291 + VAPID RFC 8292), implemented
 * with WebCrypto only — no npm dependencies.
 *
 * - buildVapidJwt(privateKeyJwk, audience, subject): an ES256 JWT
 *   (header {typ, alg}, claims {aud, exp, sub}) signed with the VAPID
 *   private key. WebCrypto's ECDSA signature is already the raw
 *   R||S form JWS requires.
 * - encryptPayload({p256dh, auth}, plaintext): the aes128gcm content
 *   encoding — ephemeral ECDH with the subscription's public key,
 *   HKDF keyed by the auth secret, AES-128-GCM over payload + the
 *   0x02 final-record delimiter. Body layout:
 *   salt(16) || rs(4) || keyidLen(1) || serverPublicKey(65) || ciphertext.
 * - sendPush(env, sub, payloadObject): builds the JWT for the push
 *   service's origin, encrypts, and POSTs with a bounded timeout.
 *   Returns the HTTP status (0 on network failure). Callers delete the
 *   subscription on 404/410 (gone for good).
 */

export function b64urlEncode(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8
  );
  return new Uint8Array(bits);
}

export async function buildVapidJwt(privateKeyJwk, audience, subject, lifetimeSec = 43200) {
  const jwk = typeof privateKeyJwk === 'string' ? JSON.parse(privateKeyJwk) : privateKeyJwk;
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const enc = new TextEncoder();
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64urlEncode(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + Math.min(lifetimeSec, 86400),
    sub: subject,
  })));
  const signingInput = header + '.' + payload;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput)
  );
  return signingInput + '.' + b64urlEncode(new Uint8Array(sig));
}

export async function encryptPayload(keys, plaintext) {
  const uaPublic = b64urlDecode(keys.p256dh);   // 65-byte uncompressed point
  const authSecret = b64urlDecode(keys.auth);   // 16 bytes
  const payloadBytes = new TextEncoder().encode(plaintext);

  // Ephemeral server keypair for this message.
  const serverKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));

  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, serverKeys.privateKey, 256
  ));

  // RFC 8291 key derivation.
  const info = concatBytes(
    new TextEncoder().encode('WebPush: info\0'), uaPublic, serverPublic
  );
  const ikm = await hkdf(authSecret, ecdhSecret, info, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const record = concatBytes(payloadBytes, new Uint8Array([2])); // final-record delimiter
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, aesKey, record
  ));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concatBytes(salt, rs, new Uint8Array([serverPublic.length]), serverPublic, ciphertext);
}

// sub: { endpoint, keys: { p256dh, auth } } (PushSubscription JSON).
// Returns the push service's HTTP status, or 0 on network failure.
export async function sendPush(env, sub, payloadObject, timeoutMs = 5000) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0;
  try {
    const audience = new URL(sub.endpoint).origin;
    const jwt = await buildVapidJwt(env.VAPID_PRIVATE_KEY, audience, 'mailto:admin@uno-adda.local');
    const body = await encryptPayload(sub.keys, JSON.stringify(payloadObject));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          Authorization: 'vapid t=' + jwt + ', k=' + env.VAPID_PUBLIC_KEY,
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: '3600',
        },
        body,
      });
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return 0;
  }
}
