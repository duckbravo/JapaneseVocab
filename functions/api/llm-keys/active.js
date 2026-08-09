// POST /api/llm-keys/active   body: { provider: 'gemini' | null }
//
// Picks which stored provider the (future) generation pipeline should use.
// Passing null clears the selection.

import { json, err, readJsonBody, BadRequest } from '../_lib/http.js';
import { assertKvBinding, readBlob, writeBlob, toPublic } from '../_lib/kv.js';
import { getProvider, withArticle } from '../_lib/providers.js';

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

  const blob = await readBlob(env, userId);

  if (body.provider === null || body.provider === '') {
    blob.activeProvider = null;
  } else {
    const provider = getProvider(body.provider);
    if (!provider) return err(400, 'bad_request', 'Unknown provider.');
    if (!blob.providers[provider.id]?.cipher) {
      return err(400, 'bad_request', `Add ${withArticle(provider.label)} key before selecting it.`);
    }
    blob.activeProvider = provider.id;
  }

  await writeBlob(env, userId, blob);
  return json({ ok: true, ...toPublic(blob) });
}
