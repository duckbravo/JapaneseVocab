// POST /api/queue-examples — generate example sentences for an ALREADY-SAVED
// custom_vocab row, in the background, and write them into that row.
//
// WHY A SECOND ENDPOINT INSTEAD OF A FLAG ON /api/generate-examples: the two
// differ in where the result goes, not in what gets generated. The foreground
// route hands sentences back to a page that is still open and waiting. This
// one answers 202 immediately and finishes the work under ctx.waitUntil(),
// because the whole point is that the user navigates away — starts another
// word, goes back to the vocab tables, closes the tab. A fetch() started by a
// page dies with that page (keepalive:true preserves the request but throws
// the response away), so the only place the result can land is the database.
//
// CONTRACT WITH THE CLIENT: the row must already exist, saved with
// example_status='pending'. That ordering is deliberate — the word is durable
// before any generation is attempted, so the worst case is a saved word with
// no sentences (visible and fixable on My Vocab) rather than a word that
// vanished because generation failed.
//
// Every exit path writes a terminal status. A row stuck on 'pending' forever
// would be the one failure mode the user can neither see nor act on, so
// failures are recorded in example_error rather than only logged.

import { err, json, readJsonBody, BadRequest } from './_lib/http.js';
import { assertKvBinding } from './_lib/kv.js';
import { checkRateLimit } from './_lib/ratelimit.js';
import { normalizeRequest, runCombinedGeneration } from './_lib/examples.js';
import { bearerToken, patchRow } from './_lib/supabase-rest.js';

export async function onRequestPost({ request, env, data, waitUntil }) {
  assertKvBinding(env);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    if (e instanceof BadRequest) return err(400, 'bad_request', e.message);
    throw e;
  }

  // custom_vocab.id is a bigint identity column, so anything non-numeric is a
  // malformed client, not a missing row.
  const vocabId = typeof body.vocabId === 'number' || typeof body.vocabId === 'string'
    ? String(body.vocabId).trim()
    : '';
  if (!/^\d+$/.test(vocabId)) {
    return err(400, 'bad_request', 'A saved word id is required.');
  }

  const normalized = normalizeRequest(body);
  if (!normalized.ok) return err(400, 'bad_request', normalized.message);

  const token = bearerToken(request);

  // Rate limiting happens BEFORE the 202. Returning 202 and then silently
  // dropping the job would leave the row pending forever; a 429 lets the page
  // tell the user now, while it can still offer to retry.
  const { allowed, retryAfter } = await checkRateLimit(env, data.user.id, 'generate');
  if (!allowed) {
    return err(429, 'rate_limited', `Too many generations — try again in ${retryAfter}s.`);
  }

  waitUntil(generateInBackground(env, token, data.user.id, vocabId, normalized.request, waitUntil));

  return json({ ok: true, queued: true, vocabId }, 202);
}

/** The generator shouldn't throw, but waitUntil() is no place to find out. */
async function safely(env, userId, request, vocabId, waitUntil) {
  return runCombinedGeneration(env, userId, request, waitUntil).catch((e) => {
    console.error(`[queue-examples:${vocabId}] generation threw`, e?.stack || String(e));
    return { ok: false, message: 'Generation failed unexpectedly.' };
  });
}

/**
 * Runs after the 202 has already been sent. Nothing here can surface an error
 * to the caller, so every outcome — success, provider failure, database
 * failure — ends in either a written row or a console.error.
 *
 * ONE generation, not two. The example sentences and the short "More" phrases
 * are genuinely different styles, but a single structured reply can carry both
 * lists — see runCombinedGeneration(). This used to be two concurrent calls,
 * which doubled the quota cost of every backgrounded word for no benefit; on
 * Google's free tier that halved how many words a day were possible.
 *
 * The two OUTCOMES are still independent. `more` is optional on the form and
 * optional here: no usable phrases must not red-flag a word whose sentences
 * came back fine.
 */
async function generateInBackground(env, token, userId, vocabId, request, waitUntil) {
  const result = await safely(env, userId, request, vocabId, waitUntil);

  const patch = {
    jlpt_level: request.jlptLevel,
    updated_at: new Date().toISOString(),
  };

  if (result.ok) {
    patch.examples = toStored(result.examples);
    patch.example_status = 'ready';
    patch.example_error = null;
    // Everything written here is PLAIN Japanese; kuromoji runs in the browser.
    // js/custom-vocab.js annotates both arrays and clears this. Its
    // annotateOnce() must stay idempotent — one flag describes two arrays.
    patch.needs_furigana = true;

    if (result.phrases.length) patch.more = toStored(result.phrases);
  } else {
    patch.example_status = 'failed';
    patch.example_error = result.message;
  }

  const write = await patchRow(env, token, 'custom_vocab', vocabId, patch);
  if (!write.ok) {
    // The row stays 'pending'. My Vocab treats a long-stale pending row as
    // recoverable (it offers a retry), so this is degraded rather than lost —
    // but it's still the case worth having in the logs.
    console.error(`[queue-examples:${vocabId}] patch failed ${write.status}: ${write.message}`);
  }
}

/**
 * Shapes generated text into the stored {furigana, translation} shape used by
 * both `examples` and `more`.
 *
 * The `furigana` field holds PLAIN Japanese here, not bracket syntax — kuromoji
 * runs in the browser and this code doesn't. needs_furigana is what tells
 * js/custom-vocab.js to annotate BOTH arrays with the tagger it already loads
 * and write the real thing back. Until that happens the text still renders
 * correctly, just without ruby, because renderFurigana() on un-bracketed text
 * is a no-op.
 */
function toStored(items) {
  return items.map((ex) => ({ furigana: ex.japanese, translation: ex.english }));
}
