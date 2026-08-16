// Furigana: bracket syntax <-> DOM, plus the morphological tagger that produces
// the brackets. Classic script — everything here is a global.
//
// This is a JavaScript port of generate_furigana() from
// manual_generation_readonly.ipynb, which used fugashi (MeCab) in Python. The
// site has no build step and Workers can't run Python, so the tagger is
// kuromoji.js loaded from a CDN at the moment it's first needed.
//
// TWO DELIBERATE DIFFERENCES FROM THE NOTEBOOK:
//
// 1. It reads token.reading, not feature.pron. `pron` is the *phonetic*
//    reading, which is why the curated CSVs are full of
//    <ruby>映画<rt>えーが</rt></ruby>, きょー, せんせー, たいよー. kuromoji's
//    `reading` is orthographic (エイガ), so new data comes out correct. The
//    existing CSVs are untouched — this is not a regeneration.
//
// 2. It splits okurigana out of the ruby base (食[た]べる) instead of wrapping
//    the whole token (<ruby>食べる<rt>たべる</rt></ruby>). See alignReading()
//    for why that matters: it's what makes the stored bracket syntax
//    unambiguous to parse.

// 々 〆 ヶ, CJK ext. A, CJK unified, CJK compatibility ideographs.
const KANJI_CLASS = "々〆ヶ㐀-䶿一-鿿豈-﫿";
const KANJI_RE = new RegExp(`[${KANJI_CLASS}]`);
const KANA_RE = /[ぁ-ゟ゠-ヿ]/;

// Explicit base-start marker, for the rare token whose okurigana can't be
// aligned. Everything after the last one of these, up to the "[", is the base.
const BASE_MARKER = "｜"; // ｜

function isKanji(ch) {
  return KANJI_RE.test(ch);
}

/**
 * ァ-ン -> ぁ-ん by codepoint offset, the same trick the notebook used.
 *
 * Note the notebook's version silently passed ー (U+30FC) through because it
 * sits outside the ァ-ン range — half of the えーが bug. Reading orthographic
 * `reading` instead of `pron` means ー now only shows up in genuine katakana
 * loanwords, which contain no kanji and so are never annotated at all.
 */
function katakanaToHiragana(text) {
  let out = "";
  for (const ch of text) {
    out += ch >= "ァ" && ch <= "ヶ" ? String.fromCharCode(ch.charCodeAt(0) - 0x60) : ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tagger
// ---------------------------------------------------------------------------

// ~17 MB of dictionary, so this is started on demand (first focus of the search
// box) rather than on page load, and the browser caches it after the first
// visit. The kuromoji.js SCRIPT itself is still loaded from the CDN (that part
// is fine) — but the dictionary files are vendored into this repo under
// /kuromoji-dict/ rather than pointed at the CDN, because kuromoji 0.1.2's own
// DictionaryLoader builds each file's URL with Node's `path.join(dicPath,
// filename)` (see its bundled loader/DictionaryLoader.js), and path.join
// collapses the "//" in "https://cdn.jsdelivr.net/..." down to a single
// slash. Some browsers silently repair that malformed URL when resolving it;
// Microsoft Edge does not, and instead requests it as a path on THIS site's
// own origin (verified live: 404s on
// https://<this-site>/cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/base.dat.gz).
// There is no dicPath string containing "//" that survives path.join, so a
// cross-origin dicPath can never be made reliable — a same-origin absolute
// path (no "//" in it at all) is the only fix that isn't browser-dependent.
const KUROMOJI_VERSION = "0.1.2";
const KUROMOJI_SCRIPT = `https://cdn.jsdelivr.net/npm/kuromoji@${KUROMOJI_VERSION}/build/kuromoji.js`;
const KUROMOJI_DICT = "/kuromoji-dict/";

let taggerPromise = null;

/**
 * @returns {Promise<object>} the kuromoji tokenizer. Rejects if the CDN is
 *   unreachable — callers must degrade rather than block saving.
 */
function loadTagger() {
  if (taggerPromise) return taggerPromise;

  taggerPromise = new Promise((resolve, reject) => {
    const fail = () => reject(new Error("Could not load the furigana dictionary."));

    const build = () => {
      if (typeof kuromoji === "undefined") return fail();
      kuromoji
        .builder({ dicPath: KUROMOJI_DICT })
        .build((err, tokenizer) => (err ? fail() : resolve(tokenizer)));
    };

    const existing = document.querySelector(`script[src="${KUROMOJI_SCRIPT}"]`);
    if (existing) {
      existing.addEventListener("load", build);
      existing.addEventListener("error", fail);
      return;
    }

    const script = document.createElement("script");
    script.src = KUROMOJI_SCRIPT;
    script.onload = build;
    script.onerror = fail;
    document.head.appendChild(script);
  });

  // A failed load must not be cached forever — let the next call retry.
  taggerPromise.catch(() => {
    taggerPromise = null;
  });

  return taggerPromise;
}

/** True once the dictionary is in memory, so callers can skip the spinner. */
let taggerReady = null;

async function getTagger() {
  if (taggerReady) return taggerReady;
  taggerReady = await loadTagger();
  return taggerReady;
}

// ---------------------------------------------------------------------------
// Okurigana alignment
// ---------------------------------------------------------------------------

/**
 * Splits one token into kanji-only ruby bases.
 *
 *   食べる  たべる      -> 食[た]べる
 *   晩ご飯  ばんごはん  -> 晩[ばん]ご飯[はん]
 *   明日    あした      -> 明日[あした]        (one kanji run, nothing to split)
 *   消しゴム けしごむ    -> 消[け]しゴム
 *
 * WHY BOTHER, when the notebook just wrapped the whole token? Because the
 * curated CSVs store pre-expanded <ruby> HTML, but custom_vocab stores bracket
 * syntax that has to be parsed back. With kana allowed inside a base,
 * "私は食べる[たべる]" and "晩ご飯[ばんごはん]" are structurally identical
 * strings — there is no rule that reads the first as 食べる and the second as
 * 晩ご飯. Kanji-only bases remove the ambiguity entirely.
 *
 * @returns {string|null} bracket syntax, or null when the kana in the surface
 *   can't be matched against the reading (jukujikun, digits, odd tokens).
 */
function alignReading(surface, reading) {
  // Split into alternating kanji / non-kanji runs.
  const runs = [];
  for (const ch of surface) {
    const kanji = isKanji(ch);
    const last = runs[runs.length - 1];
    if (last && last.kanji === kanji) last.text += ch;
    else runs.push({ kanji, text: ch });
  }

  let out = "";
  let at = 0; // how much of `reading` has been consumed

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];

    if (!run.kanji) {
      // A kana run must appear in the reading verbatim. Compare normalised
      // (the surface may be katakana where the reading is hiragana) but emit
      // the original characters.
      const want = katakanaToHiragana(run.text);
      if (reading.slice(at, at + want.length) !== want) return null;
      out += run.text;
      at += want.length;
      continue;
    }

    // A kanji run's reading runs up to wherever the following kana run starts.
    const next = runs[i + 1];
    let end;
    if (!next) {
      end = reading.length;
    } else {
      // +1 because a kanji run must consume at least one kana.
      end = reading.indexOf(katakanaToHiragana(next.text), at + 1);
      if (end === -1) return null;
    }
    if (end <= at) return null;

    out += `${run.text}[${reading.slice(at, end)}]`;
    at = end;
  }

  return at === reading.length ? out : null;
}

/**
 * Annotates Japanese text with bracket furigana.
 *
 * @param {string} text plain Japanese, no existing brackets
 * @param {object} tokenizer from getTagger()
 */
function annotateWithFurigana(text, tokenizer) {
  let out = "";

  for (const token of tokenizer.tokenize(text)) {
    const surface = token.surface_form;

    // Nothing to read, or characters that would corrupt the bracket syntax.
    if (
      !KANJI_RE.test(surface) ||
      surface.includes("[") ||
      surface.includes("]") ||
      surface.includes(BASE_MARKER)
    ) {
      out += surface;
      continue;
    }

    // Unknown words have no reading — emit them bare so the user can fill it in.
    const reading = token.reading ? katakanaToHiragana(token.reading) : "";
    if (!reading || reading === surface) {
      out += surface;
      continue;
    }

    const aligned = alignReading(surface, reading);
    // Alignment failed: fall back to the notebook's whole-token behaviour, but
    // mark the base explicitly so the parser can still find where it starts.
    out += aligned !== null ? aligned : `${BASE_MARKER}${surface}[${reading}]`;
  }

  return out;
}

/** Bracket syntax -> the plain sentence, for re-annotating after an edit. */
function furiganaToPlain(text) {
  return String(text || "")
    .replace(/\[[^\[\]]*\]/g, "")
    .split(BASE_MARKER)
    .join("");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function buildRuby(base, reading) {
  const ruby = document.createElement("ruby");
  ruby.appendChild(document.createTextNode(base));
  const rt = document.createElement("rt");
  rt.textContent = reading;
  ruby.appendChild(rt);
  return ruby;
}

/**
 * Works out where the ruby base starts, given everything since the last
 * annotation and knowing it is immediately followed by "[".
 *
 *   1. An explicit ｜ marker — base is everything after the last one.
 *   2. Otherwise: walk left over trailing okurigana (kana immediately before
 *      the bracket), then over the contiguous kanji run immediately before
 *      THAT. The base is the union of the two — kanji run plus its okurigana.
 *
 * This is what annotateWithFurigana() emits (食[た], 明日[あした]), and it's
 * also the convention CLAUDE.md documents for hand-typed entries
 * ("食べる[たべる]をたべます"). The key property: the walk stops the moment
 * it runs out of kanji, so it never reaches PAST an intervening word. That's
 * what fixes the old greedy, unanchored regex — "私は食べる[たべる]" now
 * resolves to a base of "食べる" (the verb its okurigana), not
 * "私は食べる" (verb plus the subject marker in front of it).
 *
 * @returns {number} index into `pending`, or -1 for "no base here"
 */
function furiganaBaseStart(pending) {
  const marker = pending.lastIndexOf(BASE_MARKER);
  if (marker !== -1) return marker + 1;
  if (!pending) return -1;

  let i = pending.length;
  while (i > 0 && !isKanji(pending[i - 1]) && KANA_RE.test(pending[i - 1])) i--;

  let kanjiStart = i;
  while (kanjiStart > 0 && isKanji(pending[kanjiStart - 1])) kanjiStart--;

  return kanjiStart < i ? kanjiStart : -1;
}

/**
 * Bracket syntax -> DocumentFragment.
 *
 * SECURITY: this is the XSS boundary for custom vocab. Unlike the curated CSVs,
 * this text is user-submitted, so every node is built with createElement /
 * createTextNode and never innerHTML. "<script>" typed into the field renders
 * as literal text. Do not "simplify" this into a string of HTML.
 */
function renderFurigana(text) {
  const fragment = document.createDocumentFragment();
  const source = String(text || "");

  let pending = ""; // unannotated text seen since the last ruby, marker included
  let i = 0;

  // ｜ is punctuation for the parser (see furiganaBaseStart), never content —
  // strip it before anything in `pending` reaches the DOM.
  const flush = (upTo) => {
    const chunk = pending.slice(0, upTo).split(BASE_MARKER).join("");
    if (chunk) fragment.appendChild(document.createTextNode(chunk));
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch !== "[") {
      pending += ch; // markers stay in `pending` until flush() strips them
      i++;
      continue;
    }

    const close = source.indexOf("]", i + 1);
    const reading = close === -1 ? "" : source.slice(i + 1, close);
    const start = close === -1 ? -1 : furiganaBaseStart(pending);

    if (start === -1 || !reading) {
      // Unbalanced or baseless — emit verbatim rather than swallowing it.
      pending += close === -1 ? ch : source.slice(i, close + 1);
      i = close === -1 ? i + 1 : close + 1;
      continue;
    }

    flush(start);
    fragment.appendChild(buildRuby(pending.slice(start), reading));
    pending = "";
    i = close + 1;
  }

  // Markers are layout hints, not text — strip them from the visible output.
  const tail = pending.split(BASE_MARKER).join("");
  if (tail) fragment.appendChild(document.createTextNode(tail));

  return fragment;
}

/** Convenience: replace an element's contents with rendered furigana. */
function setFurigana(el, text) {
  if (!el) return;
  el.innerHTML = "";
  el.appendChild(renderFurigana(text));
}
