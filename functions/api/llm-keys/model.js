// POST /api/llm-keys/model — choose which model a stored provider key uses.
//
// Sits next to active.js, which picks WHICH PROVIDER to use; this picks which
// model within one. Kept separate from index.js (add/remove a key) because
// changing a model must never touch the ciphertext.
//
// Why this is worth exposing at all: on Google's free tier the choice of model
// is mostly a choice of daily quota, and the two lines differ by more than an
// order of magnitude (Flash-Lite ~500 requests/day vs Flash ~20 as of
// 2026-09). The registry's default is the high-quota one, but someone who
// wants better prose on a paid key, or who finds a model deprecated out from
// under them, needs a way to say so.
//
// `model: null` clears the choice and returns the provider to its default —
// that's the "reset" the UI's first option sends.

import { json, err, readJsonBody, BadRequest } from '../_lib/http.js';
import { assertKvBinding, readBlob, writeBlob, toPublic } from '../_lib/kv.js';
import { getProvider } from '../_lib/providers.js';

export async function onRequestPost({ request, env, data }) {
  assertKvBinding(env);

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

  // An allowlist against the registry, not a format check. The model id is
  // interpolated into a provider URL by generate(), so "any string the client
  // sent" is not something to pass along — and an id outside the curated chain
  // would also escape the cost/quota ordering the chain exists to express.
  const requested = body.model === null || body.model === undefined ? null : String(body.model);
  if (requested !== null) {
    const allowed = (provider.models || []).map((m) => m.id).concat(provider.defaultModel);
    if (!allowed.includes(requested)) {
      return err(400, 'bad_request', 'That model is not one of the options for this provider.');
    }
  }

  const blob = await readBlob(env, data.user.id);
  const record = blob.providers[provider.id];
  if (!record?.cipher) {
    return err(400, 'bad_request', `No API key is stored for ${provider.label}.`);
  }

  // Storing null rather than deleting the field keeps "explicitly default"
  // and "never chosen" the same state, which is what the UI shows.
  record.model = requested;
  record.updatedAt = new Date().toISOString();

  await writeBlob(env, data.user.id, blob);

  // KV is eventually consistent, so the new state is returned here rather than
  // leaving the client to re-fetch and possibly read its own write stale.
  return json({ ok: true, ...toPublic(blob) });
}
