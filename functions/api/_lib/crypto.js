// AES-GCM-256 encryption for user-supplied LLM API keys, using WebCrypto
// (available in the Workers runtime — no dependencies).
//
// SECURITY RULES FOR THIS FILE:
//   - Never console.log plaintext, ciphertext, or a derived key.
//   - The key-encryption secret lives ONLY in Cloudflare env vars
//     (KEY_ENCRYPTION_SECRET, stored encrypted) and in a local, gitignored
//     .dev.vars. It is never committed and never sent to the browser.
//
// Design notes:
//   - HKDF-SHA256 derives the AES key, salted with the Supabase user id. That
//     turns a possibly-low-entropy env string into a proper 256-bit key AND
//     gives per-user key separation: a blob copied from one user's KV entry
//     into another's is undecryptable.
//   - The AAD binds the ciphertext to userId:providerId:version, so moving a
//     Gemini record into the OpenAI slot fails closed rather than silently
//     sending the wrong key to the wrong vendor.
//   - Every record carries `v`. decryptSecret() dispatches on it, so key
//     rotation later is additive (see ROTATION below).

const enc = new TextEncoder();
const dec = new TextDecoder();

const CURRENT_VERSION = 1;

function b64encode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ROTATION recipe (don't build it until it's needed):
//   1. Add KEY_ENCRYPTION_SECRET_V2 in the Cloudflare dashboard.
//   2. Add it to this map and bump CURRENT_VERSION to 2.
//   3. encryptSecret() then writes v2 while decryptSecret() still reads v1.
//   4. Re-encrypt lazily on the next successful /validate (which already holds
//      the plaintext), then drop v1 once every record has moved.
function secretForVersion(env, version) {
  const secrets = {
    1: env.KEY_ENCRYPTION_SECRET,
  };
  const secret = secrets[version];
  if (!secret) throw new Error(`no encryption secret configured for version ${version}`);
  return secret;
}

/**
 * @param {string} secretB64  base64 of >= 32 random bytes (`openssl rand -base64 32`)
 * @param {string} userId     Supabase user uuid — HKDF salt
 * @param {string} providerId 'gemini' | 'anthropic' | 'openai' — part of HKDF info
 * @param {number} version    record schema version
 * @returns {Promise<CryptoKey>} non-extractable AES-GCM-256 key
 */
async function deriveKey(secretB64, userId, providerId, version) {
  let ikm;
  try {
    ikm = b64decode(secretB64);
  } catch {
    throw new Error('KEY_ENCRYPTION_SECRET is not valid base64');
  }
  if (ikm.length < 32) {
    throw new Error('KEY_ENCRYPTION_SECRET must decode to at least 32 bytes');
  }

  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode(userId),
      info: enc.encode(`japanesevocab:llm-key:v${version}:${providerId}`),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  );
}

function aad(userId, providerId, version) {
  return enc.encode(`${userId}:${providerId}:${version}`);
}

/**
 * @returns {Promise<{ v: number, iv: string, ct: string }>} the stored cipher record
 */
export async function encryptSecret(env, userId, providerId, plaintext) {
  const v = CURRENT_VERSION;
  const key = await deriveKey(secretForVersion(env, v), userId, providerId, v);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // fresh IV per encryption

  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(userId, providerId, v) },
    key,
    enc.encode(plaintext),
  );

  return { v, iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
}

/**
 * @returns {Promise<string>} the plaintext key
 * @throws on tampering, a wrong secret, or an unsupported record version
 */
export async function decryptSecret(env, userId, providerId, record) {
  const v = record?.v;
  if (typeof v !== 'number' || !record?.iv || !record?.ct) {
    throw new Error('malformed cipher record');
  }

  const key = await deriveKey(secretForVersion(env, v), userId, providerId, v);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(record.iv), additionalData: aad(userId, providerId, v) },
    key,
    b64decode(record.ct),
  );

  return dec.decode(pt);
}
