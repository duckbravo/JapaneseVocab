// POST /api/llm-keys/validate   body: { provider }
//
// Re-checks an already-stored key against the provider ("Re-check" in the UI).
// Useful when a key has been revoked upstream, or was saved during a provider
// outage and never got a real verdict.
//
// This is one of exactly two places that call decryptSecret() (the other is
// _lib/keys.js, the seam for the future generation endpoint). It returns a
// verdict only — the decrypted key never leaves this function.

import { json, err, readJsonBody, BadRequest } from '../_lib/http.js';
import { decryptSecret } from '../_lib/crypto.js';
import { assertKvBinding, readBlob, writeBlob, toPublic } from '../_lib/kv.js';
import { getProvider, runValidation } from '../_lib/providers.js';
import { checkRateLimit } from '../_lib/ratelimit.js';

export async function onRequestPost({ request, env, data }) {
  assertKvBinding(env);
  const userId = data.user.id;

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    if (e instanceof BadRequest) return err(400, 'bad_request', e.message);
    throw e;
  }

  const provider = getProvider(body.provider);
  if (!provider) return err(400, 'bad_request', 'Unknown provider.');

  const blob = await readBlob(env, userId);
  const record = blob.providers[provider.id];
  if (!record?.cipher) {
    return err(404, 'not_found', 'No key is stored for that provider.');
  }

  const limit = await checkRateLimit(env, userId, 'validate');
  if (!limit.allowed) {
    return err(429, 'rate_limited', `Too many key checks. Try again in ${limit.retryAfter} seconds.`);
  }

  let apiKey;
  try {
    apiKey = await decryptSecret(env, userId, provider.id, record.cipher);
  } catch (e) {
    // Wrong/rotated KEY_ENCRYPTION_SECRET, or a tampered record. Say something
    // actionable rather than leaking the crypto failure.
    console.error('decrypt failed for provider', provider.id, e?.message);
    return err(
      500,
      'decrypt_failed',
      'Your stored key could not be read. Remove it and save it again.',
    );
  }

  const verdict = await runValidation(provider, apiKey);
  const now = new Date().toISOString();

  record.status = verdict.outcome;
  record.statusDetail = verdict.detail;
  record.updatedAt = now;
  // A 429/5xx means "we couldn't tell", not "the key went bad" — so don't
  // advance lastValidatedAt and don't discard the earlier successful check.
  if (verdict.outcome === 'valid') {
    record.lastValidatedAt = now;
  }

  await writeBlob(env, userId, blob);

  const publicState = toPublic(blob);
  return json({
    ok: true,
    provider: provider.id,
    status: verdict.outcome,
    message: verdict.message,
    record: publicState.providers[provider.id],
    ...publicState,
  });
}
