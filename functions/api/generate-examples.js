// POST /api/generate-examples — asks the user's own LLM key to write JLPT-
// level-appropriate example sentences (or short usage phrases) for a custom
// vocab word.
//
// This is the endpoint _lib/keys.js was built for: it obtains the user's key
// via getProviderKey(), and NoKeyError is caught here explicitly — the
// middleware only special-cases AuthError, so an uncaught NoKeyError would
// otherwise surface as a generic 500 instead of the actionable "add a key in
// Account Settings" message.
//
// Furigana is NOT generated here. The model is asked for plain Japanese text;
// js/furigana.js (kuromoji, running client-side) annotates it after the fact,
// same as it does for anything the user types by hand.
//
// Two styles, matching the curated CSVs' two-tier Example/More shape
// (verb_ready_final.csv): 'sentence' (default) is a full 15-30 character
// example with real context; 'phrase' is 2 short indicative fragments like
// "友達に会います -- meet a friend" — genuinely shorter, not just fewer of the
// same output, since the prompt itself asks for a different kind of text.

import { json, err, readJsonBody, BadRequest } from './_lib/http.js';
import { assertKvBinding } from './_lib/kv.js';
import { checkRateLimit } from './_lib/ratelimit.js';
import { getActiveProviderKey, NoKeyError } from './_lib/keys.js';

const JLPT_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const STYLES = ['sentence', 'phrase'];
const MIN_COUNT = 1;
const MAX_COUNT = 5;
// "More" mirrors verb_ready_final.csv exactly: always 2, not a user-chosen count.
const PHRASE_COUNT = 2;
const MAX_FIELD_LENGTH = 100;

// CJK unified + hiragana + katakana — a generated sentence must contain at
// least one of these or it's clearly not Japanese (an empty string, an
// English apology, etc.).
const JAPANESE_RE = /[぀-ヿ一-鿿]/;

// Kanji only — narrower than JAPANESE_RE, used by containsTargetWord below.
const KANJI_RE = /[々〆ヶ㐀-䶿一-鿿豈-﫿]/;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['examples'],
  properties: {
    examples: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['japanese', 'english'],
        properties: {
          japanese: { type: 'string' },
          english: { type: 'string' },
        },
      },
    },
  },
};

export async function onRequestPost({ request, env, data }) {
  assertKvBinding(env);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    if (e instanceof BadRequest) return err(400, 'bad_request', e.message);
    throw e;
  }

  const hiragana = typeof body.hiragana === 'string' ? body.hiragana.trim() : '';
  const kanji = typeof body.kanji === 'string' ? body.kanji.trim() : '';
  const english = typeof body.english === 'string' ? body.english.trim() : '';
  const jlptLevel = JLPT_LEVELS.includes(body.jlptLevel) ? body.jlptLevel : 'N5';
  const style = STYLES.includes(body.style) ? body.style : 'sentence';
  // 'phrase' defaults to exactly PHRASE_COUNT (generate/regenerate both), but
  // still honours a smaller explicit count — that's how a single-phrase
  // regenerate asks for just 1 replacement instead of overwriting both.
  const count =
    style === 'phrase'
      ? Number.isInteger(body.count)
        ? Math.min(PHRASE_COUNT, Math.max(MIN_COUNT, body.count))
        : PHRASE_COUNT
      : Number.isInteger(body.count)
        ? Math.min(MAX_COUNT, Math.max(MIN_COUNT, body.count))
        : 3;
  // Sentences the caller already has and wants kept — e.g. regenerating just
  // one card of a batch, or "add more" on top of an existing batch. Without
  // this the model has no idea those exist and happily returns near-repeats.
  const avoid = (Array.isArray(body.avoid) ? body.avoid : [])
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 200)
    .slice(0, MAX_COUNT);

  if (!hiragana || !english) {
    return err(400, 'bad_request', 'Fill in the hiragana and English fields first.');
  }
  if (hiragana.length > MAX_FIELD_LENGTH || kanji.length > MAX_FIELD_LENGTH || english.length > MAX_FIELD_LENGTH) {
    return err(400, 'bad_request', 'That field is too long.');
  }

  let key;
  try {
    key = await getActiveProviderKey(env, data.user.id);
  } catch (e) {
    if (e instanceof NoKeyError) return err(400, 'no_key', e.message);
    throw e;
  }

  const { allowed, retryAfter } = await checkRateLimit(env, data.user.id, 'generate');
  if (!allowed) {
    return err(429, 'rate_limited', `Too many generations — try again in ${retryAfter}s.`);
  }

  const word = kanji || hiragana;
  const systemPrompt =
    `You are a Japanese teacher writing ${style === 'phrase' ? 'short usage phrases' : 'example sentences'} ` +
    'for a language learner. Return plain Japanese text only — no furigana, no ruby markup, no romaji, ' +
    'no bracket annotations.';
  const avoidNoun = style === 'phrase' ? 'phrases' : 'example sentences';
  const avoidClause = avoid.length
    ? ` These ${avoidNoun} already exist for this word — do not repeat or closely rephrase ` +
      `any of them; write something meaningfully different in structure or context: ` +
      avoid.map((s) => `"${s}"`).join('; ') +
      '.'
    : '';
  const userPrompt =
    style === 'phrase'
      ? `Write ${count} very short Japanese phrases (roughly 5-10 characters each, NOT full sentences) ` +
        `each showing a different minimal, typical context where the word ${word}` +
        (kanji ? ` (${hiragana})` : '') +
        ` — meaning "${english}" — is actually used, such as a short verb phrase with an object, or the ` +
        `word paired with a common noun. Use JLPT ${jlptLevel} level vocabulary. Give a short English ` +
        `gloss for each (a few words, not a full sentence).` +
        avoidClause
      : `Write ${count} natural Japanese example sentences using the word ${word}` +
        (kanji ? ` (${hiragana})` : '') +
        ` — meaning "${english}". Use JLPT ${jlptLevel} level grammar and vocabulary, and use kanji ` +
        'where it is natural for that level. Each sentence should be roughly 15-30 characters long, with ' +
        'enough context to show how the word is actually used. Give a natural English translation for each.' +
        avoidClause;

  let result;
  try {
    result = await key.provider.generate({
      apiKey: key.apiKey,
      model: key.provider.defaultModel,
      systemPrompt,
      userPrompt,
      schema: SCHEMA,
      signal: AbortSignal.timeout(45000),
    });
  } catch (e) {
    console.error(`[generate:${key.provider.id}] fetch threw`, e);
    return err(
      502,
      'generation_failed',
      `Couldn't reach ${key.provider.label} (network error or timeout). Try again in a moment.`,
    );
  }

  if (!result.ok) {
    return err(
      502,
      'generation_failed',
      `${key.provider.label} could not generate examples right now. Try again in a moment.`,
    );
  }

  const examples = sanitizeExamples(result.data, word, hiragana, style);
  if (examples.length === 0) {
    console.error(
      `[generate:${key.provider.id}] all examples dropped by sanitizeExamples`,
      JSON.stringify(result.data).slice(0, 500),
    );
    return err(
      502,
      'generation_failed',
      `${key.provider.label} returned no usable examples. Try again, or a different word/level.`,
    );
  }

  return json({ ok: true, provider: key.provider.id, examples });
}

/**
 * Drops anything that isn't real Japanese, doesn't mention the target word, or
 * is implausibly long — a model can wander even with a schema. Never trust
 * generated content further than necessary before it's stored.
 *
 * 'phrase' style gets much tighter length caps than 'sentence' — the whole
 * point of that style is genuine shortness (matching verb_ready_final.csv's
 * "More" column, e.g. "友達に会います"), so a model that ignores the "5-10
 * characters" instruction and writes a full sentence anyway should be caught
 * here, not silently accepted just because it's valid Japanese.
 */
function sanitizeExamples(data, word, hiragana, style) {
  if (!data || !Array.isArray(data.examples)) return [];

  const maxJapanese = style === 'phrase' ? 30 : 200;
  const maxEnglish = style === 'phrase' ? 60 : 400;
  const maxCount = style === 'phrase' ? PHRASE_COUNT : MAX_COUNT;

  return data.examples
    .filter((ex) => ex && typeof ex.japanese === 'string' && typeof ex.english === 'string')
    .map((ex) => ({ japanese: ex.japanese.trim(), english: ex.english.trim() }))
    .filter(
      (ex) =>
        ex.japanese.length > 0 &&
        ex.japanese.length <= maxJapanese &&
        ex.english.length > 0 &&
        ex.english.length <= maxEnglish &&
        JAPANESE_RE.test(ex.japanese) &&
        containsTargetWord(ex.japanese, word, hiragana),
    )
    .slice(0, maxCount);
}

/**
 * A natural example sentence conjugates the word (食べる -> 食べます/食べた/...),
 * so requiring the exact dictionary-form string as a literal substring — the
 * original check — rejected almost every correctly-generated example for
 * verbs and i-adjectives, which is this site's whole subject matter. Kanji
 * don't change shape under conjugation, so for any word with kanji, checking
 * that every kanji character is present is a robust check without a
 * server-side tagger. Kana-only words fall back to a stem match (drop the
 * last mora), since conjugation only ever changes the tail.
 */
function containsTargetWord(japanese, word, hiragana) {
  const kanjiChars = [...word].filter((ch) => KANJI_RE.test(ch));
  if (kanjiChars.length > 0) {
    return kanjiChars.every((ch) => japanese.includes(ch));
  }
  const stem = hiragana.length > 2 ? hiragana.slice(0, -1) : hiragana;
  return japanese.includes(stem);
}
