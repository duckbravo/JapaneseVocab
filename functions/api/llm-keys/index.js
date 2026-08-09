// GET | POST | DELETE  /api/llm-keys
//
// The user is already authenticated by functions/api/_middleware.js and
// available as context.data.user.
//
// INVARIANT: a plaintext API key travels browser -> server exactly once, in the
// POST body. Nothing here ever puts one in a response — every body is built by
// toPublic(), which is an allowlist.

import { json, err, readJsonBody, BadRequest } from '../_lib/http.js';
import { encryptSecret } from '../_lib/crypto.js';
import {
  assertKvBinding,
  readBlob,
  writeBlob,
  deleteBlob,
  toPublic,
  maskKey,
  removeProvider,
} from '../_lib/kv.js';
import { getProvider, sanitizeApiKey, runValidation, checkKeyShape } from '../_lib/providers.js';
import { checkRateLimit } from '../_lib/ratelimit.js';

const MAX_KEY_LENGTH = 512;

export async function onRequestGet({ env, data }) {
  assertKvBinding(env);
  const blob = await readBlob(env, data.user.id);
  return json(toPublic(blob));
}

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
  if (!provider) {
    return err(400, 'bad_request', 'Unknown provider.');
  }

  if (typeof body.apiKey !== 'string' || body.apiKey.length > MAX_KEY_LENGTH) {
    return err(400, 'bad_request', 'Missing or oversized API key.');
  }

  // Re-sanitize independently of the client: its copy is advisory UX only.
  const apiKey = sanitizeApiKey(body.apiKey);

  // Structural sanity + the cross-vendor guard only. Anything that merely
  // *looks* unusual is sent to the provider anyway and judged by them — key
  // formats change (Google's AIza -> AQ. switch), and refusing a valid key on a
  // stale prefix rule is worse than one wasted round trip.
  const shapeError = checkKeyShape(provider, apiKey);
  if (shapeError) {
    return err(400, 'bad_format', shapeError);
  }

  // Rate limit before the outbound call, so hammering this can't be used to
  // test keys against the provider.
  const limit = await checkRateLimit(env, userId, 'validate');
  if (!limit.allowed) {
    return err(
      429,
      'rate_limited',
      `Too many key checks. Try again in ${limit.retryAfter} seconds.`,
    );
  }

  const verdict = await runValidation(provider, apiKey);

  // The provider actively rejected it — store nothing, and leave any
  // previously stored key for this provider untouched.
  if (verdict.outcome === 'invalid') {
    return json(
      {
        ok: false,
        code: 'key_rejected',
        provider: provider.id,
        status: 'invalid',
        statusDetail: verdict.detail,
        message: verdict.message,
      },
      422,
    );
  }

  // 'valid' or 'unknown'. We deliberately store on 'unknown' (rate limit,
  // outage, network) — a provider having a bad day shouldn't stop someone
  // saving their key.
  const now = new Date().toISOString();
  const cipher = await encryptSecret(env, userId, provider.id, apiKey);

  const blob = await readBlob(env, userId);
  const previous = blob.providers[provider.id];

  blob.providers[provider.id] = {
    cipher,
    hint: maskKey(apiKey),
    keyLength: apiKey.length,
    status: verdict.outcome,
    statusDetail: verdict.detail,
    lastValidatedAt: verdict.outcome === 'valid' ? now : (previous?.lastValidatedAt ?? null),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };

  if (!blob.activeProvider) {
    blob.activeProvider = provider.id;
  }

  await writeBlob(env, userId, blob);

  const publicState = toPublic(blob);
  return json({
    ok: true,
    provider: provider.id,
    status: verdict.outcome,
    message: verdict.outcome === 'valid' ? null : verdict.message,
    record: publicState.providers[provider.id],
    ...publicState,
  });
}

export async function onRequestDelete({ request, env, data }) {
  assertKvBinding(env);
  const userId = data.user.id;
  const url = new URL(request.url);

  // Query params rather than a DELETE body — bodies on DELETE are
  // inconsistently supported across clients and proxies.
  if (url.searchParams.get('all') === '1') {
    await deleteBlob(env, userId);
    return json({ ok: true, activeProvider: null, providers: {} });
  }

  const providerId = url.searchParams.get('provider');
  if (!getProvider(providerId)) {
    return err(400, 'bad_request', 'Unknown provider.');
  }

  const blob = await readBlob(env, userId);
  if (!removeProvider(blob, providerId)) {
    return err(404, 'not_found', 'No key is stored for that provider.');
  }

  await writeBlob(env, userId, blob);
  return json({ ok: true, ...toPublic(blob) });
}
