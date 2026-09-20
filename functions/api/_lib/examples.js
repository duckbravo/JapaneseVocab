// Example-sentence generation: request normalisation, prompt construction,
// the provider call, and the sanitizer.
//
// This lives in _lib/ rather than inside functions/api/generate-examples.js
// because there are now TWO callers with identical model behaviour and
// different plumbing:
//   - generate-examples.js  — foreground: generates, returns the sentences.
//   - queue-examples.js     — background: 202s, then generates under
//                             ctx.waitUntil() and PATCHes them into Supabase.
// Duplicating the prompts across the two would mean the "review it yourself"
// path and the "trust it" path could silently drift into producing different
// sentences for the same word, which is exactly the bug a user would never
// think to report. One module, one prompt.
//
// Exports no onRequest* function, so it emits no route (and worker.js's ROUTES
// table doesn't reference it either).
//
// Furigana is NOT produced here. The model is asked for plain Japanese; ruby
// comes from kuromoji client-side (js/furigana.js) in both flows — immediately
// for the foreground one, and via custom_vocab.needs_furigana for the
// background one.

import { getActiveProviderKey, NoKeyError } from './keys.js';
import { PROMPTS, render } from './prompts.js';
import { knownModels, resolveChain, shouldTryNextModel } from './models.js';

export const JLPT_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
export const STYLES = ['sentence', 'phrase'];
// How much kanji to use in the rest of the sentence. 'level' keeps every
// sentence readable at the chosen JLPT level; 'natural' writes it the way a
// native would. Defaults to 'level' — the safer choice for a learner, and
// what the old ambiguous wording leaned towards.
export const KANJI_POLICIES = ['level', 'natural'];
const MIN_COUNT = 1;
const MAX_COUNT = 5;
// "More" mirrors verb_ready_final.csv exactly: always 2, not a user-chosen count.
export const PHRASE_COUNT = 2;
// How many sentences to ask for when nobody specified — matches MAX_EXAMPLES
// on the client, which is the number a card can actually keep.
const MAX_COUNT_DEFAULT = 3;
const MAX_FIELD_LENGTH = 100;
// `english` is NOT a word, it's a gloss list. add-vocab.html defaults to
// recording ALL of a dictionary entry's meanings (see its senseSelect comment),
// so a perfectly ordinary entry blows straight past MAX_FIELD_LENGTH: 屋台 has
// five senses and serialises to 255 characters. Capping it at 100 rejected
// those words outright with "That field is too long", which reads as a bug in
// the form rather than a limit.
//
// The 100 cap exists to keep pathological input away from the sanitizer's
// regexes; `english` never reaches them — it is only ever interpolated into
// the prompt — so it gets its own, much larger bound.
const MAX_ENGLISH_LENGTH = 600;

// CJK unified + hiragana + katakana — a generated sentence must contain at
// least one of these or it's clearly not Japanese (an empty string, an
// English apology, etc.).
const JAPANESE_RE = /[぀-ヿ一-鿿]/;

// Kanji only — narrower than JAPANESE_RE, used by containsTargetWord below.
const KANJI_RE = /[々〆ヶ㐀-䶿一-鿿豈-﫿]/;

const ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['japanese', 'english'],
  properties: {
    japanese: { type: 'string' },
    english: { type: 'string' },
  },
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['examples'],
  properties: {
    examples: { type: 'array', items: ITEM },
  },
};

/**
 * Both lists in one reply. Named `sentences`/`phrases` rather than reusing
 * `examples` so the two can never be confused when they arrive together — they
 * have different length rules and land in different columns.
 *
 * Both are `required`, so a provider honouring the schema cannot omit one. A
 * provider that ignores schemas still can't cause damage: sanitizeList() checks
 * each array independently and an absent one simply yields no phrases.
 */
const COMBINED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sentences', 'phrases'],
  properties: {
    sentences: { type: 'array', items: ITEM },
    phrases: { type: 'array', items: ITEM },
  },
};

/**
 * Validates and clamps a raw JSON body into the shape runGeneration() wants.
 * @returns {{ ok: true, request: object } | { ok: false, message: string }}
 */
export function normalizeRequest(body) {
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

  const instruction = normalizeInstruction(body.instruction);
  // Whether the avoided items are being replaced (a rewrite) rather than kept
  // (a top-up). Drives which avoid wording the prompt uses.
  const replacing = body.replacing === true;
  const kanjiPolicy = KANJI_POLICIES.includes(body.kanjiPolicy) ? body.kanjiPolicy : 'level';

  if (!hiragana || !english) {
    return { ok: false, message: 'Fill in the hiragana and English fields first.' };
  }
  // Named separately so the message says which field — "That field is too
  // long" on a form whose fields were all filled in by the dictionary is an
  // error nobody can act on.
  if (hiragana.length > MAX_FIELD_LENGTH || kanji.length > MAX_FIELD_LENGTH) {
    return { ok: false, message: 'That hiragana or kanji is too long to generate from.' };
  }
  if (english.length > MAX_ENGLISH_LENGTH) {
    return {
      ok: false,
      message: 'That English meaning is too long — try narrowing it to one meaning.',
    };
  }

  return {
    ok: true,
    request: { hiragana, kanji, english, jlptLevel, style, count, avoid, instruction, replacing, kanjiPolicy },
  };
}

// Long enough for a real request ("make it about ordering food at a festival,
// and more polite"), short enough that it can't become the bulk of the prompt
// and drown the rules that follow it.
const MAX_INSTRUCTION_LENGTH = 200;

/**
 * Cleans the learner's free-text "how should this change?" request.
 *
 * This is the only untrusted text that reaches a prompt, so it gets shaped
 * before it goes anywhere near one. None of this is the security boundary —
 * sanitizeExamples() re-checks the OUTPUT regardless — but it removes the
 * cheap ways to distort a prompt's structure:
 *
 *   - Control characters and newlines are collapsed to spaces, so the request
 *     can't fake paragraph breaks, a fake "Rules:" block, or a fake end of the
 *     quoted section.
 *   - Double quotes become single, so it can't close the quotation it's
 *     wrapped in and continue as if it were prompt text.
 *   - Length is capped, so it can't bury the rules under sheer volume.
 *
 * Returns '' for anything absent or empty, which is what switches the whole
 * amendment section off.
 */
function normalizeInstruction(value) {
  if (typeof value !== 'string') return '';
  return value
    // Escaped ranges, never literal bytes: C0 controls, DEL and C1. Newlines
    // and tabs are in here too, so the request cannot fake a paragraph break,
    // a second 'Rules:' block, or an early end of the quoted section it sits
    // inside.
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    // Straight and curly double quotes both close the quotation this text is
    // wrapped in, so neither survives.
    .replace(/["\u201C\u201D\u301D\u301E]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_INSTRUCTION_LENGTH);
}

// How much of the gloss list to put in front of the model. Enough for a full
// first sense ("cart (esp. a food cart), stall, stand"), short enough that the
// instruction doesn't get buried.
const PROMPT_GLOSS_LIMIT = 120;

/**
 * The meaning to actually generate against.
 *
 * The stored `english` may list every sense of the word, because the CARD is
 * deliberately honest about covering all of them (add-vocab.html). A PROMPT
 * wants the opposite: telling the model 屋台 means "cart; festival float;
 * stage prop; framework; house" gives it five unrelated targets and scatters
 * the output across meanings the learner didn't ask about.
 *
 * allGlosses() in js/add-vocab.js joins senses with "; " and the glosses
 * within a sense with ", ", so the first "; " segment is exactly the primary
 * sense — and a single-sense selection contains no "; " at all, so it passes
 * through whole.
 */
function promptGloss(english) {
  const primary = english.split(';')[0].trim() || english.trim();
  return primary.length > PROMPT_GLOSS_LIMIT
    ? `${primary.slice(0, PROMPT_GLOSS_LIMIT).trim()}…`
    : primary;
}

// Target length quoted TO the model. Deliberately narrower than the sanitizer's
// hard caps below — asking for 15-30 and rejecting at 200 leaves room for a
// model that runs slightly long, without accepting a paragraph.
const SENTENCE_TARGET = { min: 15, max: 30 };
// Widened only for an amended sentence: "make it longer" or "add more context"
// is a reasonable request, and the rules quoted alongside the user's own words
// need a bound they can actually state.
const AMENDED_TARGET = { min: 10, max: 40 };

/**
 * Assembles the prompt from PROMPTS. All wording lives in _lib/prompts.js;
 * this decides only which pieces apply and what fills their placeholders.
 */
function buildPrompts({ hiragana, kanji, english, jlptLevel, style, count, avoid, instruction, replacing, kanjiPolicy }) {
  const word = kanji || hiragana;
  const gloss = promptGloss(english);

  // Pre-rendered so the templates stay flat prose — see prompts.js.
  const reading = kanji ? ` (${hiragana})` : '';
  // Ask for the spelling we can actually verify.
  //
  // With a kanji on record, containsTargetWord() accepts either spelling, so
  // the model is told both are fine. WITHOUT one — a word stored before the
  // kanji was kept, or a genuinely kana-only word — the kana is the only thing
  // we can match, so it has to be requested explicitly. Leaving it open there
  // is what produced "Gemini wrote sentences that don't actually use いちご"
  // on three perfectly good sentences that all spelled it 苺.
  const hasKanji = Boolean(kanji) && kanji !== hiragana;
  const spellingNote = hasKanji
    ? render(PROMPTS.spellingNote, { word: kanji, hiragana })
    : render(PROMPTS.kanaOnlyNote, { hiragana });
  // `replacing` says the avoided items are being THROWN AWAY, not merely kept
  // alongside — a rewrite rather than a top-up. The wording differs sharply,
  // because "these already exist" reads as background information while the
  // user has actually just said "not this one", and models happily return the
  // same sentence in reply to the former.
  const avoidTemplate = replacing ? PROMPTS.avoidReplaced[style] : PROMPTS.avoid[style];
  const avoidClause = avoid.length
    ? render(avoidTemplate, { list: avoid.map((s) => `"${s}"`).join('; ') })
    : '';

  // An amended sentence gets the wider bound, since the request itself may
  // legitimately be about length.
  const target = instruction ? AMENDED_TARGET : SENTENCE_TARGET;

  const amendmentSection = instruction
    ? render(PROMPTS.amendmentSection, {
        instruction,
        word,
        hiragana,
        minChars: AMENDED_TARGET.min,
        maxChars: AMENDED_TARGET.max,
      })
    : '';

  const systemPrompt = PROMPTS.system[style];
  const userPrompt =
    render(PROMPTS.task[style], {
      count,
      word,
      reading,
      gloss,
      level: jlptLevel,
      minChars: target.min,
      maxChars: target.max,
      spellingNote,
      kanjiPolicy: render(PROMPTS.kanjiPolicy[kanjiPolicy], { level: jlptLevel }),
    }) +
    avoidClause +
    amendmentSection;

  return { word, systemPrompt, userPrompt };
}

/**
 * Prompt for the one-call-both-lists path. Shares promptGloss/spellingNote with
 * buildPrompts() so a word reads identically whichever route generated it.
 *
 * No `avoid` clause and no amendment section: this only ever runs on a word
 * being created, where by definition there is nothing yet to avoid and no
 * per-sentence note to honour.
 */
function buildCombinedPrompts({ hiragana, kanji, english, jlptLevel, kanjiPolicy }) {
  const word = kanji || hiragana;
  const hasKanji = Boolean(kanji) && kanji !== hiragana;

  return {
    word,
    systemPrompt: PROMPTS.combined.system,
    userPrompt: render(PROMPTS.combined.task, {
      word,
      reading: hasKanji ? ` (${hiragana})` : '',
      gloss: promptGloss(english),
      level: jlptLevel,
      sentenceCount: MAX_COUNT_DEFAULT,
      phraseCount: PHRASE_COUNT,
      minChars: SENTENCE_TARGET.min,
      maxChars: SENTENCE_TARGET.max,
      spellingNote: hasKanji
        ? render(PROMPTS.spellingNote, { word: kanji, hiragana })
        : render(PROMPTS.kanaOnlyNote, { hiragana }),
      kanjiPolicy: render(PROMPTS.kanjiPolicy[kanjiPolicy], { level: jlptLevel }),
    }),
  };
}

/**
 * Resolves the user's key, calls their provider, and sanitizes the result.
 *
 * Returns a structured failure rather than throwing, because the two callers
 * do completely different things with one: the foreground route turns it into
 * an HTTP error the user reads right now, while the background one writes it
 * into custom_vocab.example_error for the user to find on My Vocab later.
 *
 * @returns {Promise<{ ok: true, provider: string, examples: Array }
 *                 | { ok: false, status: number, code: string, message: string }>}
 */
async function callProvider(env, userId, { systemPrompt, userPrompt, schema }, waitUntil) {
  let key;
  try {
    key = await getActiveProviderKey(env, userId);
  } catch (e) {
    if (e instanceof NoKeyError) {
      return { ok: false, status: 400, code: 'no_key', message: e.message };
    }
    throw e;
  }

  // The chain is the user's chosen model (if any), then the registry's
  // cost/quota ordering, intersected with what the provider currently offers.
  const available = await knownModels(env, key.provider, key.apiKey, waitUntil);
  const chain = resolveChain(key.provider, key.record?.model || null, available);

  let result = null;
  let usedModel = null;
  let lastStatus = null;

  for (const model of chain) {
    try {
      result = await key.provider.generate({
        apiKey: key.apiKey,
        model,
        systemPrompt,
        userPrompt,
        schema,
        signal: AbortSignal.timeout(45000),
      });
    } catch (e) {
      // A network failure or timeout says nothing about the model, so there's
      // nothing to fall back TO — the next one would fail the same way.
      console.error(`[generate:${key.provider.id}:${model}] fetch threw`, e);
      return {
        ok: false,
        status: 502,
        code: 'generation_failed',
        message: `Couldn't reach ${key.provider.label} (network error or timeout). Try again in a moment.`,
      };
    }

    if (result.ok) {
      usedModel = model;
      break;
    }

    lastStatus = result.status;
    if (!shouldTryNextModel(result.status)) break;

    // Quota exhausted (429) or model gone (404) — both are worth trying the
    // next model for, and both are worth logging: a 404 here is how a
    // deprecation shows up, and is the signal to update providers.js.
    console.error(
      `[generate:${key.provider.id}:${model}] HTTP ${result.status} — falling back to next model`,
    );
  }

  if (!result?.ok) {
    return {
      ok: false,
      status: 502,
      code: lastStatus === 429 ? 'quota_exhausted' : 'generation_failed',
      message:
        lastStatus === 429
          ? `Your ${key.provider.label} key has hit its usage limit on every available model. ` +
            `Free-tier allowances reset daily — try again tomorrow, or pick a different model in Account Settings.`
          : `${key.provider.label} could not generate examples right now. Try again in a moment.`,
    };
  }

  // `model` travels back so the client can say which one actually answered —
  // after a fallback that differs from what the user selected, and silently
  // switching models on someone is exactly the kind of thing that makes output
  // quality look randomly variable.
  return {
    ok: true,
    data: result.data,
    provider: key.provider.id,
    label: key.provider.label,
    model: usedModel,
  };
}

/** One style (sentences OR phrases) in one call. */
export async function runGeneration(env, userId, request, waitUntil) {
  const { word, systemPrompt, userPrompt } = buildPrompts(request);

  const call = await callProvider(env, userId, { systemPrompt, userPrompt, schema: SCHEMA }, waitUntil);
  if (!call.ok) return call;

  const list = Array.isArray(call.data?.examples) ? call.data.examples : null;
  const { examples, rejections } = sanitizeList(list, word, request.hiragana, request.style);

  if (examples.length === 0) {
    logDropped(call, word, request, request.style, rejections);
    return {
      ok: false,
      status: 502,
      code: 'generation_failed',
      message: describeRejections(rejections, call.label, word),
    };
  }

  return { ok: true, provider: call.provider, model: call.model, examples };
}

/**
 * BOTH styles in ONE call.
 *
 * Every provider call costs a request against the user's quota, and on Google's
 * free tier that is the binding constraint — a word generated as two calls
 * (sentences, then phrases) burned twice the daily allowance for one word. The
 * model is perfectly capable of returning both lists in a single structured
 * reply, so creating a word now does exactly that.
 *
 * Only used when CREATING. Rewriting an existing word regenerates one section
 * at a time, because then the user is targeting a specific thing and a combined
 * call would throw away the half they were happy with.
 *
 * The phrases are OPTIONAL: `more` is an optional field on the form, so phrases
 * failing their own sanitising must not fail the word. Sentences failing does.
 */
export async function runCombinedGeneration(env, userId, request, waitUntil) {
  const { word, systemPrompt, userPrompt } = buildCombinedPrompts(request);

  const call = await callProvider(
    env,
    userId,
    { systemPrompt, userPrompt, schema: COMBINED_SCHEMA },
    waitUntil,
  );
  if (!call.ok) return call;

  const sentences = sanitizeList(
    Array.isArray(call.data?.sentences) ? call.data.sentences : null,
    word,
    request.hiragana,
    'sentence',
  );
  const phrases = sanitizeList(
    Array.isArray(call.data?.phrases) ? call.data.phrases : null,
    word,
    request.hiragana,
    'phrase',
  );

  if (sentences.examples.length === 0) {
    logDropped(call, word, request, 'combined:sentences', sentences.rejections);
    return {
      ok: false,
      status: 502,
      code: 'generation_failed',
      message: describeRejections(sentences.rejections, call.label, word),
    };
  }

  if (phrases.examples.length === 0) {
    // Logged, never surfaced — the word is complete without them.
    console.error(
      `[generate:${call.provider}] combined reply had no usable phrases`,
      `word=${word} rejections=${JSON.stringify(phrases.rejections)}`,
    );
  }

  return {
    ok: true,
    provider: call.provider,
    model: call.model,
    examples: sentences.examples,
    phrases: phrases.examples,
  };
}

/**
 * The rejection tally is the whole point of this log line. "No usable examples"
 * collapses six genuinely different failures into one sentence, and without
 * knowing WHICH filter fired the only way to debug a report of it is to guess.
 */
function logDropped(call, word, request, styleLabel, rejections) {
  console.error(
    `[generate:${call.provider}] all examples dropped by sanitizeExamples`,
    `word=${word} hiragana=${request.hiragana} style=${styleLabel}`,
    `rejections=${JSON.stringify(rejections)}`,
    JSON.stringify(call.data).slice(0, 500),
  );
}

/**
 * Turns the rejection tally into something the user can act on.
 *
 * Only facts we already hold are named — the target word, the style, counts.
 * The model's actual output never reaches the browser: some providers echo
 * request fragments back, and this response is not a place to leak them.
 */
function describeRejections(rejections, label, word) {
  const entries = Object.entries(rejections).sort((a, b) => b[1] - a[1]);
  const [reason] = entries[0] || [];

  switch (reason) {
    case 'malformed_response':
      return `${label} replied in an unexpected format. Try again in a moment.`;
    case 'missing_target_word':
      // No longer suggests ticking "usually written in kana" — that box is now
      // a display preference and has no effect on generation. Both spellings
      // are accepted, so reaching this genuinely means the model wandered off
      // the word rather than merely spelling it the other way.
      return (
        `${label} wrote sentences that don't actually use ${word}. ` +
        `Try again, or check the Kanji and Hiragana fields are both correct for this word.`
      );
    case 'too_long':
      return `${label} wrote sentences that were too long to use. Try again, or a lower JLPT level.`;
    case 'not_japanese':
      return `${label} didn't return Japanese text. Try again, or check your API key's model access.`;
    case 'empty':
      return `${label} returned blank sentences. Try again in a moment.`;
    default:
      return `${label} returned no usable examples. Try again, or a different word/level.`;
  }
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
function sanitizeList(items, word, hiragana, style) {
  if (!Array.isArray(items)) {
    return { examples: [], rejections: { malformed_response: 1 } };
  }
  const data = { examples: items };

  const maxJapanese = style === 'phrase' ? 30 : 200;
  const maxEnglish = style === 'phrase' ? 60 : 400;
  const maxCount = style === 'phrase' ? PHRASE_COUNT : MAX_COUNT;

  const rejections = {};
  const kept = [];

  for (const raw of data.examples) {
    if (!raw || typeof raw.japanese !== 'string' || typeof raw.english !== 'string') {
      rejections.malformed_response = (rejections.malformed_response || 0) + 1;
      continue;
    }

    const ex = { japanese: raw.japanese.trim(), english: raw.english.trim() };

    // Ordered cheapest-first, and each example is attributed to the FIRST rule
    // it breaks — a sentence can fail several at once, and counting it under
    // all of them would make the tally unreadable.
    let reason = null;
    if (!ex.japanese || !ex.english) reason = 'empty';
    else if (ex.japanese.length > maxJapanese || ex.english.length > maxEnglish) reason = 'too_long';
    else if (!JAPANESE_RE.test(ex.japanese)) reason = 'not_japanese';
    else if (!containsTargetWord(ex.japanese, word, hiragana)) reason = 'missing_target_word';

    if (reason) {
      rejections[reason] = (rejections[reason] || 0) + 1;
      continue;
    }
    kept.push(ex);
  }

  return { examples: kept.slice(0, maxCount), rejections };
}

/**
 * Does this sentence plausibly use the target word?
 *
 * This is a guard against a model ignoring the instruction entirely, NOT a
 * grammatical check — there is no tagger server-side. It has been wrong in
 * both directions, so the reasoning matters:
 *
 *   v1 required the dictionary form as a literal substring. That rejected
 *   almost everything, because natural sentences conjugate (食べる ->
 *   食べます/食べた), and conjugation is this site's whole subject matter.
 *
 *   v2 required EVERY kanji of the word to appear. Better, but still rejected
 *   four of six realistic cases in testing, because it silently assumed the
 *   model would spell the word the same way the dictionary does:
 *     - 食べる written as たべます        (kana spelling of a kanji word)
 *     - 綺麗 written as きれい            (a word usually written in kana)
 *     - 出来る written as できます        (ditto)
 *     - 持って行く written as もって行きます (compound, partly kana)
 *   That is the failure behind "returned no usable examples": every sentence
 *   was fine and the filter threw them all away.
 *
 * v3 accepts either spelling:
 *   - the kana reading's stem (conjugation only ever changes the tail), or
 *   - ANY kanji from the word, not all of them.
 *
 * Loosening to "any" does let through the odd sentence that uses a different
 * word sharing a kanji (食事 for 食べる). That trade is deliberate: a slightly
 * off example is visible, editable and regenerable in one tap, whereas a false
 * rejection takes down the entire request and returns an error the user can do
 * nothing about.
 */
function containsTargetWord(japanese, word, hiragana) {
  // Conjugation changes only the tail, so drop the last mora — but not for
  // very short readings, where doing so would leave a stem that matches almost
  // any sentence.
  const stem = hiragana.length > 2 ? hiragana.slice(0, -1) : hiragana;
  if (stem && japanese.includes(stem)) return true;

  const kanjiChars = [...word].filter((ch) => KANJI_RE.test(ch));
  return kanjiChars.some((ch) => japanese.includes(ch));
}
