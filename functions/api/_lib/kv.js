// Reads/writes the per-user LLM-key blob in Cloudflare KV, and is the ONLY
// place that decides what leaves the server.
//
// KV layout: one entry per user.
//
//   llm-keys:<supabase-user-id>  ->  {
//     activeProvider: 'gemini' | null,
//     providers: {
//       gemini: {
//         cipher:          { v, iv, ct },   // NEVER leaves this file
//         hint:            'AIzaSy…9xQ2',
//         keyLength:       39,
//         status:          'valid' | 'invalid' | 'unknown',
//         statusDetail:    'API_KEY_INVALID' | null,
//         lastValidatedAt: ISO | null,
//         createdAt:       ISO,
//         updatedAt:       ISO,
//       },
//     },
//     updatedAt: ISO,
//   }
//
// KV is eventually consistent (a read can lag a write by up to ~60s), which is
// why every mutating endpoint returns the new state in its own response and the
// client renders from that instead of re-fetching. Concurrent writes from two
// tabs are last-write-wins; KV has no compare-and-swap. Acceptable here (one
// user, a handful of writes), and contained: if it ever stops being acceptable,
// only this file has to change.

const PREFIX = 'llm-keys:';

// The ONLY fields ever serialised to the browser. This is an allowlist on
// purpose — building the response by deleting `cipher` from a spread would
// leak any field added later.
const PUBLIC_RECORD_FIELDS = [
  'hint',
  'keyLength',
  'status',
  'statusDetail',
  'lastValidatedAt',
  'createdAt',
  'updatedAt',
];

function emptyBlob() {
  return { activeProvider: null, providers: {}, updatedAt: null };
}

/**
 * The single most common deployment mistake is adding the KV binding in the
 * Cloudflare dashboard without redeploying — bindings don't apply to existing
 * deployments. Fail with something that says so rather than
 * "Cannot read properties of undefined".
 */
export function assertKvBinding(env) {
  if (!env.LLM_KEYS) {
    throw new Error(
      'KV binding LLM_KEYS is not configured. Bind it under Pages > Settings > Functions, then REDEPLOY (bindings do not apply to existing deployments). Locally, run: npx wrangler pages dev . --kv LLM_KEYS',
    );
  }
}

function kvKey(userId) {
  return PREFIX + userId;
}

/** Reads the user's blob, or a fresh empty one. Never returns null. */
export async function readBlob(env, userId) {
  const raw = await env.LLM_KEYS.get(kvKey(userId), { type: 'json' });
  if (!raw || typeof raw !== 'object') return emptyBlob();

  return {
    activeProvider: typeof raw.activeProvider === 'string' ? raw.activeProvider : null,
    providers: raw.providers && typeof raw.providers === 'object' ? raw.providers : {},
    updatedAt: raw.updatedAt ?? null,
  };
}

export async function writeBlob(env, userId, blob) {
  blob.updatedAt = new Date().toISOString();
  await env.LLM_KEYS.put(kvKey(userId), JSON.stringify(blob));
}

export async function deleteBlob(env, userId) {
  await env.LLM_KEYS.delete(kvKey(userId));
}

/**
 * Projects the stored blob down to what the browser is allowed to see.
 * Every response body goes through this.
 */
export function toPublic(blob) {
  const providers = {};
  for (const [id, record] of Object.entries(blob.providers || {})) {
    providers[id] = Object.fromEntries(
      PUBLIC_RECORD_FIELDS.map((f) => [f, record?.[f] ?? null]),
    );
  }
  return { activeProvider: blob.activeProvider ?? null, providers };
}

/**
 * Masked display hint, computed server-side (the client no longer has the key
 * by the time this matters). First 6 + last 4 is what Google's and OpenAI's own
 * dashboards show: the prefix is public format information and the last 4 leak
 * negligible entropy, while making "which key is this?" answerable.
 */
export function maskKey(apiKey) {
  if (apiKey.length >= 16) return `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;
  return `…${apiKey.slice(-4)}`;
}

/**
 * Drops a provider and repairs `activeProvider` if it pointed at it.
 * @returns {boolean} whether anything was removed
 */
export function removeProvider(blob, providerId) {
  if (!blob.providers[providerId]) return false;

  delete blob.providers[providerId];
  if (blob.activeProvider === providerId) {
    const remaining = Object.keys(blob.providers);
    blob.activeProvider = remaining.length ? remaining[0] : null;
  }
  return true;
}
