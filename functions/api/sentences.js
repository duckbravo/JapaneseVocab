// GET /api/sentences?q=<word> — real example sentences for a vocab word.
//
// Source is Jotoba's sentence corpus (Tatoeba-derived), the same service
// functions/api/jisho.js uses for definitions — see that file's header for why
// jisho.org itself is unreachable from Cloudflare Workers.
//
// Why this is a SEPARATE route rather than part of /api/jisho: sentences are
// only wanted once the user has actually picked an entry from the dropdown,
// whereas /api/jisho runs on every search. Folding them together would pay for
// a second upstream request on every keystroke-driven lookup for data that is
// usually thrown away.
//
// Two things these sentences give us that AI-generated ones don't:
//   1. They come with furigana already computed, so they render correctly
//      before (or entirely without) kuromoji's ~17MB dictionary loading.
//   2. They need no LLM key, so the Add Vocab page is useful to a user who
//      never set one up.
// What they don't give us is controlled difficulty — this is a raw corpus with
// no JLPT filter — which is exactly why the AI path stays available alongside.

import { json, err } from './_lib/http.js';
import { checkRateLimit } from './_lib/ratelimit.js';

const MAX_QUERY_LENGTH = 64;
const MAX_SENTENCES = 3;
const MAX_SENTENCE_LENGTH = 120;
const LOOKUP_TIMEOUT_MS = 8000;

// NO SENSE FILTERING — deliberate, and a reversal of an earlier attempt.
//
// A word's senses can't be told apart from anything in this response: a
// sentence object carries only { content, furigana, translation, language,
// eng }, with no link back to a dictionary sense. The previous version tried
// to infer it by matching the chosen sense's English glosses against each
// sentence's translation, and it worked in the narrow sense (for 食べる it
// kept 6/10 for "to eat" and 0/10 for "to live on") — but it introduced a
// far worse problem than the one it solved: it filtered on ENGLISH SURFACE
// FORM, so "I already ate." was rejected for the gloss "to eat" because
// "ate" shares no prefix with "eat". A learner would then systematically
// never be shown past-tense examples, and equally never see any sentence
// that paraphrases ("Let's catch a bite"). Biasing the corpus toward one
// grammatical form is a worse failure for a language-learning tool than
// occasionally showing a sentence from a different sense of the word.
//
// Sense-linked example sentences DO exist, just not here: the Tanaka Corpus
// that ultimately feeds this data annotates every indexed word with its
// JMdict sense and the conjugated surface form, e.g.
//   B: ... 君(きみ)[01] に 会う[01]{会えない}
// (`[01]` = sense 1, `{会えない}` = the form actually used). Using that would
// mean vendoring and indexing the ~9.7MB examples.utf.gz corpus rather than
// calling an API — a real piece of work, not a filter. Until then, sentences
// are returned unfiltered and the vocab entry records ALL of the word's
// meanings, so the entry and its sentences stay consistent with each other.

export async function onRequestGet({ request, env, data }) {
  const q = new URL(request.url).searchParams.get('q')?.trim();
  if (!q) return err(400, 'bad_request', 'Enter a word to look up.');
  if (q.length > MAX_QUERY_LENGTH) return err(400, 'bad_request', 'That search is too long.');

  const { allowed, retryAfter } = await checkRateLimit(env, data.user.id, 'jisho');
  if (!allowed) {
    return err(429, 'rate_limited', `Too many lookups — try again in ${retryAfter}s.`);
  }

  let res;
  try {
    res = await fetch('https://jotoba.de/api/search/sentences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: q, language: 'English' }),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch (e) {
    console.error('[sentences] fetch threw', e);
    // Sentences are a bonus, never a blocker: the caller treats an empty list
    // and a failure identically, so a dead corpus just means "none found".
    return json({ sentences: [] });
  }

  if (!res.ok) {
    console.error(`[sentences] jotoba returned HTTP ${res.status}`);
    return json({ sentences: [] });
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    console.error('[sentences] response was not valid JSON', e);
    return json({ sentences: [] });
  }

  const all = Array.isArray(body?.sentences) ? body.sentences : [];
  return json({ sentences: all.map(toSentence).filter(Boolean).slice(0, MAX_SENTENCES) });
}

/** Allowlist projection — same discipline as _lib/kv.js#toPublic(). */
function toSentence(s) {
  const japanese = typeof s?.content === 'string' ? s.content.trim() : '';
  const english = typeof s?.translation === 'string' ? s.translation.trim()
    : typeof s?.eng === 'string' ? s.eng.trim()
    : '';

  if (!japanese || japanese.length > MAX_SENTENCE_LENGTH) return null;

  return {
    japanese,
    english,
    // Pre-computed and converted to this repo's bracket convention, so the
    // client can store it directly without running the tagger.
    furigana: toRepoFurigana(typeof s?.furigana === 'string' ? s.furigana : '') || japanese,
  };
}

/**
 * Jotoba writes furigana as `[base|reading]`, and for a multi-kanji base it may
 * split the reading per kanji: `[全部食|ぜん|ぶ|た]`. This repo stores
 * kanji-only bases instead (`全[ぜん]部[ぶ]食[た]`) — see js/furigana.js's
 * alignReading() for why that convention exists: it's what makes the stored
 * bracket syntax unambiguous to parse back.
 *
 * When the split count matches the base's character count, expand it per
 * kanji; otherwise keep the base whole (`大人[おとな]`), which is still a
 * kanji-only base and so still parses correctly.
 */
function toRepoFurigana(text) {
  return String(text).replace(/\[([^|\]]+)\|([^\]]+)\]/g, (_match, base, reading) => {
    const parts = reading.split('|');
    const chars = [...base];
    if (parts.length > 1 && parts.length === chars.length) {
      return chars.map((ch, i) => `${ch}[${parts[i]}]`).join('');
    }
    return `${base}[${parts.join('')}]`;
  });
}
