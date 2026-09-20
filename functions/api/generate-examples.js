// POST /api/generate-examples — asks the user's own LLM key to write JLPT-
// level-appropriate example sentences (or short usage phrases) for a custom
// vocab word, and returns them for the user to review before saving.
//
// The model behaviour (prompts, schema, sanitizer) lives in _lib/examples.js
// so that this route and the background one (queue-examples.js) can never
// drift into producing different sentences for the same word. What stays here
// is only the HTTP plumbing: parse, rate-limit, map a structured failure onto
// a status code.
//
// NoKeyError is handled inside runGeneration() and surfaces as a 400 'no_key'
// rather than a generic 500 — the middleware only special-cases AuthError, so
// letting it escape would lose the actionable "add a key in Account Settings"
// message.
//
// Furigana is NOT generated here. The model is asked for plain Japanese text;
// js/furigana.js (kuromoji, running client-side) annotates it after the fact,
// same as it does for anything the user types by hand.

import { json, err, readJsonBody, BadRequest } from './_lib/http.js';
import { assertKvBinding } from './_lib/kv.js';
import { checkRateLimit } from './_lib/ratelimit.js';
import { normalizeRequest, runGeneration, runCombinedGeneration } from './_lib/examples.js';

export async function onRequestPost({ request, env, data, waitUntil }) {
  assertKvBinding(env);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    if (e instanceof BadRequest) return err(400, 'bad_request', e.message);
    throw e;
  }

  const normalized = normalizeRequest(body);
  if (!normalized.ok) return err(400, 'bad_request', normalized.message);

  const { allowed, retryAfter } = await checkRateLimit(env, data.user.id, 'generate');
  if (!allowed) {
    return err(429, 'rate_limited', `Too many generations — try again in ${retryAfter}s.`);
  }

  // `withPhrases` asks for the short "More" phrases in the SAME provider call.
  // Used when creating a word, where both are wanted and a second call would
  // double the quota cost. Rewriting an existing word leaves it off, so one
  // section can be regenerated without disturbing the other.
  if (body.withPhrases === true) {
    const combined = await runCombinedGeneration(env, data.user.id, normalized.request, waitUntil);
    if (!combined.ok) return err(combined.status, combined.code, combined.message);

    return json({
      ok: true,
      provider: combined.provider,
      model: combined.model,
      examples: combined.examples,
      phrases: combined.phrases,
    });
  }

  const result = await runGeneration(env, data.user.id, normalized.request, waitUntil);
  if (!result.ok) return err(result.status, result.code, result.message);

  return json({ ok: true, provider: result.provider, model: result.model, examples: result.examples });
}
