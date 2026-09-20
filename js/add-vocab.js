// Add/edit a custom vocab word: dictionary lookup, AI-generated example
// sentences, and furigana annotation on save.
//
// The lookup talks to GET /api/jisho, which is source-agnostic — it answers
// from Jotoba (jisho.org is blocked from Cloudflare Workers; see
// functions/api/jisho.js). Nothing on this page should name a specific
// dictionary provider in user-visible text.
//
// Classic script. Depends on window.supabaseClient (bridged in
// supabase-client.js) and on js/furigana.js (renderFurigana, getTagger,
// annotateWithFurigana, furiganaToPlain), which must load before this file.
//
// Examples are edited as PLAIN Japanese text — no brackets — right up until
// save, when each one is run through the tagger to produce the bracket syntax
// that's actually stored. That keeps the textarea a normal text field (no
// bracket-syntax literacy required) whether the sentence came from the AI or
// was typed by hand.

let session = null;
let editingId = null; // custom_vocab.id when ?id= is present, else null
let jishoResults = []; // raw entries from GET /api/jisho
let selectedEntryIndex = 0; // which word
let selectedSenseIndex = 0; // which meaning of that word
let jishoSlug = null;
let partOfSpeech = null;
// Examples are [{ plain, english, furigana }]. `furigana` is normally null and
// gets produced by the tagger on save — but dictionary-pulled sentences arrive
// with authoritative furigana already computed, so it's kept and used verbatim
// (better than re-deriving it, and it works before kuromoji has even loaded).
// Editing the Japanese text clears it, since it no longer describes the text.
let examples = [];
let more = []; // [{ plain, english }] — short "More" usage phrases, capped at 2
let pitch = []; // [{ part, high }] from the dictionary; [] when unknown
// Bumped on every sentence pull so a slow response for a meaning the user has
// already navigated away from can be discarded instead of overwriting.
let sentenceRequestId = 0;
// What the corpus offered for the CURRENT word, kept separately from
// `examples` (the editor's contents) because the two answer different
// questions. `examples` is destroyed and rebuilt as the user moves around —
// notably chooseReview() clears the pulled sentences to make room for AI ones
// — whereas step 2's first card needs to know what the dictionary had for this
// word regardless of what's since happened in the editor. Deriving the card's
// state from `examples` made going to the review step and back permanently
// disable it.
let dictionarySentences = [];
// Rotates only once every pooled sentence is already in the list, so repeated
// presses of a card's 📖 cycle through the corpus in its own order instead of
// returning the same sentence forever. Reset whenever the pool is refetched.
let dictionaryCursor = 0;
let cachedTagger = null; // set once js/furigana.js's tagger has loaded

// Which of the three wizard screens is showing. Purely presentational — no
// piece of state above is owned by a step, which is what lets edit mode open
// directly on step 3 with everything already populated.
let currentStep = 1;
// Whether a /api/sentences round trip is outstanding. Step 2's first choice
// can't describe itself honestly while one is — "Use the dictionary's
// sentences" has to say how many there are.
//
// Starts TRUE (nothing is in flight yet), which is what a word typed by hand
// needs: no lookup ever runs for it, so a false start would leave the card
// stuck on "Looking for sentences…" permanently instead of saying plainly that
// the dictionary has none.
let sentencePullSettled = true;

// ---------------------------------------------------------------------------
// Server communication — same shape as js/account-settings.js's api()
// ---------------------------------------------------------------------------

async function getAccessToken() {
  const { data: { session: s } } = await window.supabaseClient.auth.getSession();
  return s?.access_token || null;
}

async function api(path, { method = "GET", body } = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error("Your session expired. Log in again.");

  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  if (res.status === 404 && !data.code) {
    throw new Error("The API isn't available on this server. Run the site with `dev.cmd` / `./dev.sh`.");
  }
  if (!res.ok) {
    throw new Error(data.message || `Request failed (${res.status}).`);
  }
  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// Wizard navigation
// ---------------------------------------------------------------------------
//
// The three <section class="wizard-step"> blocks in add-vocab.html are shown
// one at a time. This only toggles `hidden` — it never builds or destroys
// markup, so an in-flight generation, a half-typed sentence and the tagger's
// loading state all survive moving between steps.

/** Everything step 2 and 3 need before they mean anything. */
function wordIsUsable() {
  return (
    document.getElementById("customHiragana").value.trim() !== "" &&
    document.getElementById("customEnglish").value.trim() !== ""
  );
}

// True once ?id= has loaded a word. Editing is ONE PAGE, not a wizard: a
// wizard exists to ask a sequence of questions you haven't answered yet, and
// when editing they're all already answered. Stepping through three screens to
// fix one translation was the complaint.
let isEditing = false;

/**
 * Switches the form from wizard to single-page editor.
 *
 * Deliberately a layout MODE over the same markup rather than a second set of
 * fields: one save path, one example renderer, no chance of the two drifting
 * apart the way hand-copied auth markup once did (see CLAUDE.md).
 *
 * Step 2 is dropped entirely. Everything on it answers "how should these first
 * be written?", which is a creation-time question — and its one reusable
 * control, the JLPT level, is already mirrored into step 3's extras by
 * syncJlptControls().
 */
function applyEditLayout() {
  isEditing = true;
  document.getElementById("customVocabForm").classList.add("is-editing");

  document.querySelectorAll(".wizard-step").forEach((section) => {
    section.hidden = section.dataset.step === "2";
  });

  // Nothing is hidden behind a disclosure when editing — "where's the kanji?"
  // shouldn't be a click. They stay toggleable, just not closed to begin with.
  document.querySelectorAll(".wizard-details").forEach((d) => {
    d.open = true;
  });
  document.getElementById("pageTitle").textContent = "Edit word";
  document.querySelector('.wizard-step[data-step="1"] h2').textContent = "Word";
  document.getElementById("reviewHeading").textContent = "Example sentences";
}

/**
 * Shows one step. Steps past 1 refuse to open without a usable word, so the
 * progress bar can't be used to skip the only genuinely required fields.
 */
function goToStep(step, { force = false } = {}) {
  // The editor shows everything at once; there is no step to go to. Guarding
  // here rather than at every call site means the existing navigation wiring
  // (progress bar, Back buttons) simply goes inert.
  if (isEditing) return true;

  if (step > 1 && !force && !wordIsUsable()) {
    document.getElementById("step1Error").textContent =
      "Fill in the hiragana and English for this word first.";
    document.getElementById("wordDetails").open = true;
    return false;
  }

  currentStep = step;
  document.querySelectorAll(".wizard-step").forEach((section) => {
    section.hidden = Number(section.dataset.step) !== step;
  });
  updateProgress();
  updateWordDetailsSummary();

  // Each step is a fresh screen, not a scroll position within the old one.
  window.scrollTo({ top: 0, behavior: "auto" });
  return true;
}

function updateProgress() {
  document.querySelectorAll("#wizardProgress li").forEach((li) => {
    const step = Number(li.dataset.step);
    li.classList.toggle("is-current", step === currentStep);
    li.classList.toggle("is-done", step < currentStep);
  });
}

/**
 * The collapsed "Word details" summary has to show what's inside it, or
 * collapsing it just hides whether the search actually filled anything in.
 */
function updateWordDetailsSummary() {
  const hiragana = document.getElementById("customHiragana").value.trim();
  const english = document.getElementById("customEnglish").value.trim();
  const kanji = wordKanji();
  const el = document.getElementById("wordDetailsSummary");
  if (!hiragana && !english) {
    el.textContent = "— not filled in yet";
    return;
  }
  const headword = kanji ? `${kanji}（${hiragana}）` : hiragana;
  // Long "all meanings" glosses would push the summary onto three lines.
  const gloss = english.length > 40 ? `${english.slice(0, 40)}…` : english;
  el.textContent = `— ${headword} · ${gloss}`;
}

/**
 * #jlptLevel (step 2) and #jlptLevelReview (step 3's extras) are one setting
 * shown in two places — edit mode never displays step 2, and the fast paths
 * never display step 3, so neither control alone can serve every flow. Ids
 * must be unique, so they're mirrored instead.
 */
// Generation settings that appear in more than one section. Each section needs
// its own control to be self-contained, but these are NOT several settings —
// ids must be unique, so the copies are mirrored instead.
//
//   jlpt  — step 2 (create), the Examples section, the More section
//   kanji — step 2 and the Examples section (the More section inherits it;
//           one line of prose there beats a fourth dropdown)
const MIRRORED_CONTROLS = {
  jlpt: ["jlptLevel", "jlptLevelExamples", "jlptLevelReview"],
  kanji: ["kanjiPolicy", "kanjiPolicyExamples"],
};

/** Copies the value of whichever control changed to its mirrors. */
function syncMirroredControl(group, fromId) {
  const ids = MIRRORED_CONTROLS[group];
  const source = document.getElementById(fromId) || document.getElementById(ids[0]);
  if (!source) return;

  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el && el !== source) el.value = source.value;
  });

  // Cards that haven't been individually overridden follow the section value,
  // so they have to move with it — otherwise changing the setting visibly does
  // nothing to the cards already on screen.
  if (group === "kanji") refreshExampleKanji();
}

/** Back-compat wrapper: the JLPT group additionally refreshes the card levels. */
function syncJlptControls(fromId) {
  syncMirroredControl("jlpt", fromId);
  refreshExampleLevels();
}

/** How much kanji AI-written sentences should use: "level" or "natural". */
function kanjiPolicy() {
  return document.getElementById("kanjiPolicyExamples")?.value
    || document.getElementById("kanjiPolicy")?.value
    || "level";
}

/**
 * Persists the choice to user_preferences.kanji_policy.
 *
 * NOTE the asymmetry with the JLPT level, which this page reads but never
 * writes back: the level is a genuine per-word override, stored on the row as
 * custom_vocab.jlpt_level and per example. Kanji policy has no per-word
 * storage anywhere, so a change made here would simply be lost — saving is the
 * only way it survives the page.
 *
 * Fire-and-forget. A failed write must not block generation; the worst case is
 * the setting not sticking, which the next change can fix.
 */
async function saveKanjiPolicy() {
  if (!session) return;

  const { error } = await supabaseClient
    .from("user_preferences")
    .upsert(
      {
        user_id: session.user.id,
        kanji_policy: kanjiPolicy(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

  if (error) console.error("Failed to save kanji_policy:", error);
}

/**
 * Re-points every example card that hasn't been individually overridden at the
 * new page-wide level.
 *
 * Cards store `level` only once the user touches their own dropdown, so
 * "undefined" genuinely means "follow the default" rather than "was created
 * under N5". Without this, changing the review step's level would visibly do
 * nothing to the cards already on screen, which reads as the control being
 * broken.
 */
function refreshExampleLevels() {
  refreshExampleOverrides("level", ".example-level-select", jlptLevel);
}

/** The same rule for the per-card kanji-use control. */
function refreshExampleKanji() {
  refreshExampleOverrides("kanjiPolicy", ".example-kanji-select", kanjiPolicy);
}

/**
 * Re-points every card that hasn't been individually overridden at the new
 * section-wide value.
 *
 * @param {string} field the property on the example that records an override
 * @param {string} selector the control inside the card
 * @param {Function} current reads the section-wide value
 */
function refreshExampleOverrides(field, selector, current) {
  const value = current();
  document.querySelectorAll("#examplesList .example-card").forEach((card, i) => {
    if (examples[i]?.[field]) return; // explicitly overridden — leave it alone
    const select = card.querySelector(selector);
    if (select) select.value = value;
  });
}

/**
 * The level for example sentences. Reads the Examples section's own control,
 * which the sync keeps equal to the others — so this is the same value as
 * jlptLevel(), just read from the place the user set it.
 */
function jlptLevelForExamples() {
  return document.getElementById("jlptLevelExamples")?.value || jlptLevel();
}

function jlptLevel() {
  return document.getElementById("jlptLevel").value;
}

// ---------------------------------------------------------------------------
// Furigana tagger warm-up
// ---------------------------------------------------------------------------

// True once loading has failed — distinct from cachedTagger being null just
// because loading hasn't started or is still in flight. Used to stop showing
// "Loading furigana…" forever once it's clear it isn't coming.
let taggerFailed = false;

// Starts loading the ~12MB dictionary the first time the user shows any
// interest in typing Japanese, not on page load. Safe to call repeatedly —
// getTagger() (js/furigana.js) caches the in-flight promise.
function warmUpTagger() {
  if (cachedTagger || taggerFailed) return;
  getTagger()
    .then((tagger) => {
      cachedTagger = tagger;
      // Refresh previews only — NOT a full renderExamples(), which would tear
      // down and rebuild every textarea and steal focus from whatever the
      // user happens to be typing when the dictionary finishes loading.
      refreshAllExamplePreviews();
      refreshAllMorePreviews();
    })
    .catch(() => {
      // Furigana becomes best-effort for the rest of this page load; save()
      // still works, it just stores plain text instead of bracket syntax.
      taggerFailed = true;
      refreshAllExamplePreviews();
      refreshAllMorePreviews();
    });
}

/** Bracket-annotate plain text if the tagger happens to be ready; else null. */
function annotateIfReady(plain) {
  if (!cachedTagger || !plain) return null;
  try {
    return annotateWithFurigana(plain, cachedTagger);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dictionary lookup
// ---------------------------------------------------------------------------

function jishoOptionLabel(entry) {
  const form = entry.forms[0] || {};
  const headword = form.word || form.reading || "?";
  const badges = [
    ...entry.jlpt.map((j) => j.replace("jlpt-", "").toUpperCase()),
    entry.isCommon ? "common" : null,
  ].filter(Boolean);
  const gloss = entry.senses[0]?.english.join(", ") || "";
  const badgeText = badges.length ? ` · ${badges.join(", ")}` : "";
  return `${headword} (${form.reading || ""})${badgeText} — ${gloss}`;
}

function renderJishoResults() {
  const select = document.getElementById("jishoResults");
  const label = document.getElementById("jishoResultsLabel");
  select.textContent = "";

  jishoResults.forEach((entry, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = jishoOptionLabel(entry);
    select.appendChild(opt);
  });

  const manual = document.createElement("option");
  manual.value = "manual";
  manual.textContent = jishoResults.length ? "✏️ None of these — add manually" : "✏️ Add manually";
  select.appendChild(manual);

  label.style.display = "";

  if (jishoResults.length) {
    select.value = "0";
    applyJishoEntry(0);
  } else {
    select.value = "manual";
  }
}

// Checked against the SELECTED sense only, never "any sense of this word".
// A real case that makes the difference concrete (綺麗/きれい): its 2nd and
// 3rd senses carry this tag but its 1st doesn't, and 綺麗 is a normal,
// commonly kanji-written word — so a .some() across all senses used to clear
// the kanji field for it, which is exactly the kind of "well, technically one
// sense says so" default that feels wrong to someone who just looked up a
// word they see written in kanji every day.
function isKanaOnlySense(entry, senseIndex) {
  return entry.senses[senseIndex]?.tags.includes("Usually written using kana alone") ?? false;
}

/** "1. to eat" / "2. to live on (e.g. a salary), to live off" */
function senseOptionLabel(sense, i) {
  const gloss = sense.english.join(", ");
  const pos = sense.partsOfSpeech[0];
  return `${i + 1}. ${gloss}${pos ? ` — ${pos}` : ""}`;
}

/** Every meaning's glosses, in dictionary order: "to eat; to live on, to live off". */
function allGlosses(entry) {
  return entry.senses.map((s) => s.english.join(", ")).filter(Boolean).join("; ");
}

// Defaults to ALL meanings. The example sentences can't be tied to a single
// sense (see functions/api/sentences.js), so recording every meaning is what
// keeps the entry consistent with the sentences attached to it. Narrowing to
// one meaning stays available for anyone who wants a single-sense card.
const ALL_SENSES = "all";

function renderSenseOptions(entry) {
  const select = document.getElementById("senseSelect");
  const label = document.getElementById("senseSelectLabel");
  select.textContent = "";

  const all = document.createElement("option");
  all.value = ALL_SENSES;
  all.textContent = `All meanings — ${allGlosses(entry)}`;
  select.appendChild(all);

  entry.senses.forEach((sense, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = senseOptionLabel(sense, i);
    select.appendChild(opt);
  });

  select.value = ALL_SENSES;
  // With one meaning, "all" and "that one" are the same thing — no choice to make.
  label.style.display = entry.senses.length > 1 ? "" : "none";
}

/** Explains an auto-set kanji checkbox so it doesn't look like it came from nowhere. */
function setKanaOnlyHint(reason) {
  const hint = document.getElementById("kanaOnlyHint");
  hint.textContent = reason || "";
  hint.style.display = reason ? "" : "none";
}

/** Picking an entry = choosing the WORD. Everything meaning-specific is in applySense(). */
function applyJishoEntry(index) {
  const entry = jishoResults[index];
  if (!entry) return;

  selectedEntryIndex = index;

  const form0 = entry.forms[0] || {};
  document.getElementById("customHiragana").value = form0.reading || "";
  jishoSlug = entry.slug;

  pitch = Array.isArray(entry.pitch) ? entry.pitch : [];
  setPitch(document.getElementById("pitchDisplay"), pitch);
  document.getElementById("pitchRow").style.display = pitch.length ? "" : "none";

  const otherForms = entry.forms.slice(1).filter((f) => f.word);
  const otherFormsEl = document.getElementById("otherForms");
  if (otherForms.length) {
    otherFormsEl.textContent =
      "Other forms: " + otherForms.map((f) => `${f.word} (${f.reading})`).join(", ");
    otherFormsEl.style.display = "";
  } else {
    otherFormsEl.style.display = "none";
  }

  renderSenseOptions(entry);
  applySense(ALL_SENSES);

  // Sentences belong to the WORD, not to a meaning — they can't be filtered by
  // sense (see functions/api/sentences.js), so they're fetched once per entry
  // and left alone when the meaning selection changes. Sweep out the previous
  // word's pulls first so there's room; anything generated, typed or edited by
  // hand is the user's and stays.
  examples = examples.filter((ex) => ex.source !== "dictionary");
  dictionarySentences = []; // belongs to the previous word
  renderExamples();

  // Fire-and-forget: the rest of the form is already filled in and usable, and
  // a slow corpus shouldn't hold up the selection.
  pullDictionarySentences(form0.word || form0.reading || "");
}

/**
 * Picking which meaning(s) to record. Drives the English stored, the part of
 * speech, and the kana-only default. It deliberately does NOT touch the
 * example sentences: those aren't sense-linked, so re-pulling them per meaning
 * would only churn the list without making it any more relevant.
 *
 * @param {number|"all"} senseIndex
 */
function applySense(senseIndex) {
  const entry = jishoResults[selectedEntryIndex];
  if (!entry) return;

  const isAll = senseIndex === ALL_SENSES;
  const sense = isAll ? entry.senses[0] : entry.senses[senseIndex];
  if (!sense) return;

  selectedSenseIndex = senseIndex;

  const form0 = entry.forms[0] || {};
  const noKanjiForm = !form0.word;
  // For "all meanings" this follows the PRIMARY sense: a word whose first and
  // most common meaning is normally written in kanji shouldn't have the kanji
  // cleared just because some later sense is usually kana (綺麗 is the case
  // that makes this concrete — see isKanaOnlySense).
  const kanaTagged = isKanaOnlySense(entry, isAll ? 0 : senseIndex);
  const kanaOnly = noKanjiForm || kanaTagged;

  // Fill the kanji box even when defaulting to "usually kana" — the box's
  // content and the checkbox are independent (see setKanaOnly/wordKanji
  // below), so the user can just untick to use it instead of retyping it.
  setKanaOnly(kanaOnly, form0.word || "");
  setKanaOnlyHint(
    noKanjiForm
      ? "The dictionary has no kanji spelling on record for this word."
      : kanaTagged
        ? `The dictionary notes ${isAll ? "this word is" : "this meaning is"} usually written in kana.`
        : null,
  );

  document.getElementById("customEnglish").value = isAll
    ? allGlosses(entry)
    : sense.english.join(", ");
  partOfSpeech = sense.partsOfSpeech[0] || null;

  // The fields this just wrote are behind a collapsed <details>, so the
  // summary line is the only evidence the user has that anything happened.
  updateWordDetailsSummary();
  document.getElementById("step1Error").textContent = "";
}

// checked/disabled are about whether kanji is CURRENTLY IN USE; the input's
// text is independent of both, and is only ever set when the caller passes
// kanjiValue explicitly (a fresh jisho selection or loading an edit) — never
// as a side effect of the checkbox changing. That's what lets the user flip
// the checkbox back and forth without losing whatever kanji was there.
// The checkbox is a DISPLAY preference, not a data filter. It used to disable
// the kanji input and cause the kanji to be dropped on save; that cost real
// functionality — see kanjiUsuallyKana() below — so the input now stays
// editable and the kanji is always kept.
function setKanaOnly(checked, kanjiValue) {
  const checkbox = document.getElementById("kanaOnly");
  const kanjiInput = document.getElementById("customKanji");
  checkbox.checked = checked;
  if (kanjiValue !== undefined) kanjiInput.value = kanjiValue;
}

/**
 * The kanji to store and to generate from — ALWAYS whatever is in the box,
 * regardless of the "usually written in kana" checkbox.
 *
 * This function used to return "" when that box was ticked, and that was the
 * cause of two separate user-visible failures:
 *
 *   - Generation became impossible for such words. The model was told the word
 *     was いちご with no kanji, wrote the perfectly correct 苺が食べたい。, and
 *     containsTargetWord() rejected it — it had only the kana stem いち to
 *     match on and the sentence contains no kana form at all. Every sentence
 *     got thrown away and the user saw "Gemini wrote sentences that don't
 *     actually contain いちご".
 *   - The learner never saw the kanji. JMdict's "usually written using kana
 *     alone" is a frequency observation, not a claim that the kanji is wrong;
 *     苺 is common enough on menus that recognising it is worth something.
 *
 * Whether to SHOW it is a separate question, answered by kanjiUsuallyKana().
 */
function wordKanji() {
  return document.getElementById("customKanji").value.trim();
}

/**
 * Whether the dictionary considers this word usually-kana. Stored as
 * custom_vocab.kanji_usually_kana and used only to hide the Kanji column on My
 * Vocab; unticking it on the edit form reveals the kanji that was there all
 * along.
 */
function kanjiUsuallyKana() {
  return document.getElementById("kanaOnly").checked;
}

async function performJishoSearch() {
  const query = document.getElementById("jishoSearchInput").value.trim();
  const status = document.getElementById("jishoStatus");
  const btn = document.getElementById("jishoSearchBtn");

  if (!query) {
    status.textContent = "Type a word to search for.";
    return;
  }

  btn.disabled = true;
  status.textContent = "Searching the dictionary…";

  try {
    const { data } = await api(`/api/jisho?q=${encodeURIComponent(query)}`);
    jishoResults = data.results || [];
    renderJishoResults();
    status.textContent = jishoResults.length
      ? ""
      : "No results — you can still add this word manually below.";
  } catch (e) {
    jishoResults = [];
    renderJishoResults();
    status.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

/**
 * If the query is a single conjugated token the tagger knows, offer its
 * dictionary form — lookups work far better on that. Best-effort only:
 * silently does nothing if the tagger isn't loaded yet.
 */
function maybeSuggestDictionaryForm() {
  const el = document.getElementById("dictFormSuggestion");
  const input = document.getElementById("jishoSearchInput");
  const query = input.value.trim();

  if (!cachedTagger || !query) {
    el.style.display = "none";
    return;
  }

  let tokens;
  try {
    tokens = cachedTagger.tokenize(query);
  } catch {
    el.style.display = "none";
    return;
  }

  const base = tokens[0]?.basic_form;
  if (tokens.length !== 1 || !base || base === "*" || base === tokens[0].surface_form) {
    el.style.display = "none";
    return;
  }

  el.textContent = "";
  el.append("Did you mean the dictionary form? ");
  const link = document.createElement("a");
  link.href = "#";
  link.textContent = base;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    input.value = base;
    el.style.display = "none";
    performJishoSearch();
  });
  el.appendChild(link);
  el.style.display = "";
}

// ---------------------------------------------------------------------------
// Example sentences
// ---------------------------------------------------------------------------

// Matches MAX_DISPLAYED_EXAMPLES in js/custom-vocab.js — every example kept
// here is shown on the My Vocab table, so the keep limit and the display
// limit are the same number by design, not two caps that happen to agree.
const MAX_EXAMPLES = 3;

// Mirrors JLPT_LEVELS in functions/api/_lib/examples.js, which is the actual
// allowlist — anything else is clamped to N5 server-side. Duplicated rather
// than fetched because there's no build step to share a constant across the
// browser/Worker boundary, and a five-item list that hasn't changed since the
// JLPT was reorganised in 2010 isn't worth a round trip.
const JLPT_LEVELS = ["N5", "N4", "N3", "N2", "N1"];

/**
 * @param {HTMLElement} card
 * @param {string} plain the sentence as typed/pulled
 * @param {string|null} ready pre-computed bracket furigana, when the source
 *   supplied it (dictionary sentences do). Skips the tagger entirely, so these
 *   render correctly even before kuromoji's dictionary has finished loading.
 */
function refreshExampleFurigana(card, plain, ready) {
  const preview = card.querySelector(".example-furigana-preview");
  const annotated = ready || annotateIfReady(plain);
  preview.innerHTML = "";
  if (annotated) {
    preview.appendChild(renderFurigana(annotated));
  } else if (plain) {
    // Loaded-but-failed-on-this-text and never-going-to-load both just show
    // the plain sentence; only "still loading" gets the placeholder message.
    preview.textContent = cachedTagger || taggerFailed ? plain : "Loading furigana…";
  }
}

/**
 * Pulls real sentences for `word` into the example boxes. Only fills EMPTY
 * slots up to MAX_EXAMPLES, so anything the user already typed, generated, or
 * edited is never clobbered by a late-arriving response.
 *
 * Sentences are NOT restricted to one meaning — the corpus doesn't record
 * which sense a sentence demonstrates, and guessing from the English
 * translation biased the results badly (it silently dropped every past-tense
 * sentence, since "ate" doesn't look like "eat"). See
 * functions/api/sentences.js.
 */
/**
 * Fetches the corpus pool for `word` into `dictionarySentences`.
 *
 * Stashes the WHOLE pool, not just what happens to fit. The previous version
 * truncated to the free slots, which meant that with the example list already
 * full the stash came back empty — and per-card replacement, which needs
 * alternatives to offer, had nothing to work with.
 */
async function fetchDictionarySentences(word) {
  if (!word) return [];

  // A late response for a word the user has already navigated away from must
  // not land in the boxes.
  const requestId = ++sentenceRequestId;

  sentencePullSettled = false;
  updateDictionaryChoice();

  const status = document.getElementById("generateStatus");
  status.textContent = "Looking for example sentences…";

  let pulled = [];
  try {
    const { data } = await api(`/api/sentences?q=${encodeURIComponent(word)}`);
    pulled = Array.isArray(data.sentences) ? data.sentences : [];
  } catch {
    // Sentences are a bonus, not a requirement — stay silent and let the user
    // generate or type their own.
    if (requestId === sentenceRequestId) {
      status.textContent = "";
      sentencePullSettled = true;
      updateDictionaryChoice();
    }
    return [];
  }

  if (requestId !== sentenceRequestId) return []; // superseded

  sentencePullSettled = true;
  dictionarySentences = pulled.map((s) => ({
    plain: s.japanese,
    english: s.english || "",
    furigana: s.furigana || null,
    source: "dictionary",
  }));
  dictionaryCursor = 0;

  updateDictionaryChoice();
  status.textContent = dictionarySentences.length
    ? ""
    : "No ready-made sentences for this word — try Generate.";
  return dictionarySentences;
}

/** Fetches the pool once per word, then reuses it. */
async function ensureDictionaryPool() {
  if (dictionarySentences.length) return dictionarySentences;
  const word = wordKanji() || document.getElementById("customHiragana").value.trim();
  return fetchDictionarySentences(word);
}

/**
 * The next corpus sentence to offer.
 *
 * Prefers one NOT already in the list, so pressing 📖 across cards walks
 * through distinct sentences instead of pasting the same one everywhere. Once
 * every pooled sentence is in use, it falls back to dictionary order via a
 * rotating cursor, so pressing again cycles rather than sticking.
 *
 * EVERY current example counts as used — including the card being replaced.
 * Excluding it (the first attempt at this) made that card's own sentence the
 * first "unused" candidate, so pressing 📖 on a card already showing D2 quietly
 * replaced D2 with D2 while a genuinely unused D4 sat in the pool.
 */
function nextDictionarySentence() {
  if (dictionarySentences.length === 0) return null;

  const used = new Set(examples.map((ex) => ex.plain));
  const unused = dictionarySentences.find((s) => !used.has(s.plain));
  if (unused) return { ...unused };

  const s = dictionarySentences[dictionaryCursor % dictionarySentences.length];
  dictionaryCursor++;
  return { ...s };
}

/** Initial auto-pull: fills EMPTY slots only, never clobbering existing text. */
async function pullDictionarySentences(word) {
  if (!word || examples.length >= MAX_EXAMPLES) return;

  const pool = await fetchDictionarySentences(word);
  const room = MAX_EXAMPLES - examples.length;
  if (room <= 0 || pool.length === 0) return;

  // Copies, so editing one in the form doesn't mutate the stash.
  examples = examples.concat(pool.slice(0, room).map((s) => ({ ...s })));
  renderExamples();
}

/**
 * How many dictionary sentences would actually be SAVED — the pool can now be
 * larger than the list holds, and step 2's card promises what you'd get, not
 * what exists.
 */
function dictionaryExampleCount() {
  return Math.min(dictionarySentences.length, MAX_EXAMPLES);
}

/** Replaces one card with a corpus sentence, fetching the pool if needed. */
async function replaceWithDictionary(index) {
  const status = document.getElementById("generateStatus");
  status.textContent = "";

  setExamplesBusy(true);
  try {
    await ensureDictionaryPool();
    const replacement = nextDictionarySentence();
    if (!replacement) {
      status.textContent = "The dictionary has no sentences for this word.";
      return;
    }
    // Keeps its corpus furigana, which is authoritative and needs no tagger.
    // `level`/`instruction` are dropped with the old sentence — they described
    // text that is no longer here.
    examples[index] = replacement;
    updateExampleCard(index);
  } finally {
    setExamplesBusy(false);
  }
}

/** Appends a corpus sentence the list doesn't already have. */
async function addFromDictionary() {
  const status = document.getElementById("generateStatus");
  status.textContent = "";

  // renderExamples() hides this button when the list is full, so this should be
  // unreachable — but say so rather than returning silently if it ever isn't.
  // A no-op with no explanation is exactly how this read as broken before.
  if (examples.length >= MAX_EXAMPLES) {
    status.textContent = `Already at ${MAX_EXAMPLES} sentences — use a card's 📖 to swap one out.`;
    return;
  }

  setExamplesBusy(true);
  try {
    await ensureDictionaryPool();
    const next = nextDictionarySentence();
    if (!next) {
      status.textContent = "The dictionary has no sentences for this word.";
      return;
    }
    examples.push(next);
    renderExamples();
  } finally {
    setExamplesBusy(false);
  }
}

/**
 * Keeps step 2's first choice honest about what taking it would actually
 * save. A card reading "Use the dictionary's sentences" that quietly saves
 * zero of them is worse than no card at all, so with nothing pulled it
 * disables itself and says so.
 */
function updateDictionaryChoice() {
  const card = document.getElementById("choiceDictionary");
  const desc = document.getElementById("choiceDictionaryDesc");
  if (!card || !desc) return;

  const count = dictionaryExampleCount();

  if (!sentencePullSettled) {
    desc.textContent = "Looking for real sentences from the dictionary…";
    card.disabled = true;
    return;
  }

  if (count === 0) {
    desc.textContent = "The dictionary has no ready-made sentences for this word.";
    card.disabled = true;
    return;
  }

  desc.textContent =
    count === 1
      ? "1 real sentence, written by a human and already checked."
      : `${count} real sentences, written by humans and already checked.`;
  card.disabled = false;
}

/** Updates every card's preview in place, without rebuilding the inputs. */
function refreshAllExamplePreviews() {
  document.querySelectorAll("#examplesList .example-card").forEach((card, i) => {
    refreshExampleFurigana(card, examples[i]?.plain || "", examples[i]?.furigana);
  });
}

/** Updates one card's inputs + preview in place, without touching the others. */
function updateExampleCard(index) {
  const card = document.querySelectorAll("#examplesList .example-card")[index];
  const ex = examples[index];
  if (!card || !ex) return;
  card.querySelector(".example-japanese").value = ex.plain;
  card.querySelector(".example-english").value = ex.english;
  refreshExampleFurigana(card, ex.plain, ex.furigana);
}

/**
 * Disables everything that can mutate `examples` — batch generate/add
 * more/add manual, and every per-card regenerate/remove — while a generate
 * request is in flight. Without this, removing card 0 while card 2 is
 * mid-regenerate would shift indices out from under the in-flight request
 * and it would overwrite the wrong card when it resolves.
 */
function setExamplesBusy(busy) {
  document.getElementById("generateBtn").disabled = busy;
  document.getElementById("addManualBtn").disabled = busy;
  // Also the dictionary add — a corpus fetch can take a second, and without
  // this a second click during it would queue a duplicate.
  document.getElementById("addFromDictionaryBtn").disabled = busy;
  document.querySelectorAll("#examplesList button").forEach((btn) => {
    btn.disabled = busy;
  });
}

function renderExamples() {
  const list = document.getElementById("examplesList");
  list.textContent = "";

  examples.forEach((ex, i) => {
    const card = document.createElement("div");
    card.className = "example-card";

    const japaneseInput = document.createElement("textarea");
    japaneseInput.rows = 2;
    japaneseInput.className = "example-japanese";
    japaneseInput.placeholder = "日本語の例文";
    japaneseInput.value = ex.plain;

    const preview = document.createElement("div");
    preview.className = "example-furigana-preview furigana-preview";

    const englishInput = document.createElement("input");
    englishInput.type = "text";
    englishInput.className = "example-english";
    englishInput.placeholder = "English translation";
    englishInput.value = ex.english;

    // --- per-example tuning -------------------------------------------
    // These controls belong to THIS card: how hard it is, how much kanji it
    // uses, and what it's about. None is worth rerolling the whole batch for,
    // and one sentence often wants different treatment from its neighbours —
    // seeing 苺 written in kanji in one example while the rest stay readable
    // is a reasonable thing to want.
    const tune = document.createElement("div");
    tune.className = "example-tune";

    const levelLabel = document.createElement("label");
    levelLabel.className = "example-level";
    levelLabel.append("Level");
    const levelSelect = document.createElement("select");
    levelSelect.className = "example-level-select";
    JLPT_LEVELS.forEach((lv) => {
      const opt = document.createElement("option");
      opt.value = lv;
      opt.textContent = lv;
      levelSelect.appendChild(opt);
    });
    // ex.level is undefined until the user overrides it, so a card that's been
    // left alone follows the review step's level rather than freezing whatever
    // it was created under.
    levelSelect.value = ex.level || jlptLevel();
    levelSelect.addEventListener("change", () => {
      examples[i].level = levelSelect.value;
    });
    levelLabel.appendChild(levelSelect);

    // Same "undefined means follow the section" rule as ex.level above.
    // Option labels are terse because three controls share this row; the
    // title carries the full wording used on the section-wide control.
    const kanjiLabel = document.createElement("label");
    kanjiLabel.className = "example-level";
    kanjiLabel.append("Kanji");
    const kanjiSelect = document.createElement("select");
    kanjiSelect.className = "example-kanji-select";
    [
      ["level", "My level", "Only kanji for my JLPT level"],
      ["natural", "Native", "However a native would write it"],
    ].forEach(([value, short, full]) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = short;
      opt.title = full;
      kanjiSelect.appendChild(opt);
    });
    kanjiSelect.value = ex.kanjiPolicy || kanjiPolicy();
    kanjiSelect.title = "How much kanji this sentence should use when rewritten";
    kanjiSelect.addEventListener("change", () => {
      examples[i].kanjiPolicy = kanjiSelect.value;
    });
    kanjiLabel.appendChild(kanjiSelect);

    const instructionInput = document.createElement("input");
    instructionInput.type = "text";
    instructionInput.className = "example-instruction";
    instructionInput.placeholder = "How should this change? e.g. about food, more polite, shorter";
    instructionInput.value = ex.instruction || "";
    instructionInput.addEventListener("input", () => {
      examples[i].instruction = instructionInput.value;
    });
    // Enter in a single-line input inside a <form> would submit the form and
    // save the word; here it should do the obvious thing instead.
    instructionInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        regenerateSingleExample(i);
      }
    });

    tune.append(levelLabel, kanjiLabel, instructionInput);

    // Two ways to replace THIS sentence, mirroring the two sources a sentence
    // can come from in the first place. Per-card rather than whole-list,
    // because wanting a different second example is not a reason to throw away
    // the first and third.
    const dictionaryBtn = document.createElement("button");
    dictionaryBtn.type = "button";
    dictionaryBtn.className = "btn-secondary";
    dictionaryBtn.textContent = "📖 Dictionary";
    dictionaryBtn.title = "Replace this one with a real sentence from the dictionary";
    dictionaryBtn.addEventListener("click", () => replaceWithDictionary(i));

    const regenerateBtn = document.createElement("button");
    regenerateBtn.type = "button";
    regenerateBtn.className = "btn-secondary";
    regenerateBtn.textContent = "🔄 AI rewrite";
    regenerateBtn.title = "Replace this one with AI, using the level and note above";
    regenerateBtn.addEventListener("click", () => regenerateSingleExample(i));

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-danger";
    removeBtn.textContent = "✕ Remove";
    removeBtn.addEventListener("click", () => {
      examples.splice(i, 1);
      renderExamples();
    });

    const actions = document.createElement("div");
    actions.className = "example-card-actions";
    actions.append(dictionaryBtn, regenerateBtn, removeBtn);

    japaneseInput.addEventListener("input", () => {
      examples[i].plain = japaneseInput.value;
      // Any pre-computed furigana described the ORIGINAL text, so it's wrong
      // the moment the text changes — drop it and fall back to the tagger.
      examples[i].furigana = null;
      // Once you've edited it, it's yours: it stops being a swept-away
      // dictionary pull if you later switch to a different meaning.
      examples[i].source = "manual";
      refreshExampleFurigana(card, japaneseInput.value, null);
    });
    englishInput.addEventListener("input", () => {
      examples[i].english = englishInput.value;
    });

    card.append(japaneseInput, preview, englishInput, tune, actions);
    list.appendChild(card);
    refreshExampleFurigana(card, ex.plain, ex.furigana);
  });

  // EVERY button in this row only ADDS, so all three are useless once the list
  // is full — and a visible button that does nothing is worse than no button.
  // "Add from dictionary" was missing from this and stayed on screen doing
  // nothing, which in edit mode (which normally opens with a full list) meant
  // it appeared broken every time. To bring in a dictionary sentence when the
  // list is full, use a card's own 📖 to replace one.
  const room = MAX_EXAMPLES - examples.length;
  const generateBtn = document.getElementById("generateBtn");
  generateBtn.style.display = room > 0 ? "" : "none";
  generateBtn.textContent =
    examples.length > 0 ? `✨ Generate ${room} more with AI` : "✨ Generate examples";
  document.getElementById("addManualBtn").style.display = room > 0 ? "" : "none";
  document.getElementById("addFromDictionaryBtn").style.display = room > 0 ? "" : "none";
}

/**
 * Tops the example list up to MAX_EXAMPLES with AI-written sentences. Always
 * ADDITIVE — never replaces what's already there, because by the time this
 * runs the list usually holds real dictionary sentences that were pulled in
 * automatically, and wiping those would defeat the point. Replacing one
 * specific example is what each card's 🔄 button does.
 */
/** AI text carries no furigana of its own; the tagger supplies it on save. */
function asAiExample(ex, level) {
  return {
    plain: ex.japanese,
    english: ex.english,
    furigana: null,
    source: "ai", // survives a change of meaning; only "dictionary" is swept
    level,
  };
}

/**
 * Tops the example list up to MAX_EXAMPLES with AI-written sentences.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.withPhrases] ask for the short "More" phrases in the
 *   SAME provider call and fill `more` with them. One call instead of two,
 *   which matters because each call spends one request of the user's daily
 *   quota — see runCombinedGeneration() server-side. Only used when creating a
 *   word; rewriting regenerates one section at a time.
 * @param {boolean} [opts.replaceAll] throw the current list away first, so the
 *   whole set is rewritten together rather than topped up.
 * @param {string} [opts.level] JLPT level to use instead of the page default.
 */
async function generateExamples({ withPhrases = false, replaceAll = false, level } = {}) {
  const hiragana = document.getElementById("customHiragana").value.trim();
  const kanji = wordKanji();
  const english = document.getElementById("customEnglish").value.trim();
  const jlptLevel = level || jlptLevelForExamples();
  const status = document.getElementById("generateStatus");

  if (!hiragana || !english) {
    status.textContent = "Fill in the hiragana and English fields first.";
    return;
  }

  // Captured BEFORE the list is cleared. Wiping first and then building the
  // avoid list from `examples` produced an EMPTY one, so "rewrite all" asked
  // the model to avoid nothing and it returned the same sentences — the whole
  // reason rewriting felt like it did nothing.
  const outgoing = replaceAll ? examples.map((ex) => ex.plain).filter(Boolean) : [];

  if (replaceAll) {
    examples = [];
    renderExamples();
  }

  const count = MAX_EXAMPLES - examples.length;
  if (count <= 0) return;

  warmUpTagger();

  // Either what's being kept (top-up) or what's being discarded (rewrite).
  // `replacing` tells the server which, so the prompt can say "the learner
  // rejected these" rather than the much weaker "these already exist".
  const avoid = replaceAll ? outgoing : examples.map((ex) => ex.plain).filter(Boolean);

  setExamplesBusy(true);
  status.textContent = withPhrases
    ? "Writing example sentences and short phrases…"
    : "Generating example sentences…";

  try {
    const { data } = await api("/api/generate-examples", {
      method: "POST",
      body: { hiragana, kanji, english, jlptLevel, count, avoid, withPhrases, replacing: replaceAll, kanjiPolicy: kanjiPolicy() },
    });

    const generated = (data.examples || []).map((ex) => asAiExample(ex, jlptLevel));
    examples = examples.concat(generated).slice(0, MAX_EXAMPLES);

    // Only ever ADDS phrases, never clobbers: on the create path `more` is
    // empty anyway, and anything the user typed is theirs.
    if (withPhrases && Array.isArray(data.phrases)) {
      const room = MAX_MORE - more.length;
      if (room > 0) {
        more = more.concat(
          data.phrases.slice(0, room).map((ex) => ({
            plain: ex.japanese,
            english: ex.english,
            furigana: null,
          })),
        );
        renderMore();
      }
    }

    renderExamples();
    status.textContent = generated.length
      ? ""
      : "No usable examples came back — try again or a different word.";
  } catch (e) {
    status.textContent = e.message;
  } finally {
    setExamplesBusy(false);
  }
}

/**
 * Rewrites EVERY example sentence in one call at the chosen level.
 *
 * One request instead of up to three individual 🔄 rewrites, which is the
 * point: each call costs a slice of the user's daily quota. Confirms first,
 * because unlike "Top up" this discards what's there — including anything
 * hand-edited.
 */
async function rewriteAllExamples() {
  if (
    examples.length > 0 &&
    !confirm(`Rewrite all ${examples.length} example sentences with AI? This can't be undone.`)
  ) {
    return;
  }
  await generateExamples({ replaceAll: true });
}

/**
 * Replaces a single example in place, keeping the rest of the batch untouched.
 *
 * Uses THIS card's level and amendment note rather than the page-wide ones —
 * that's the whole point of the per-card controls. The note is passed as
 * `instruction`; the server treats it as untrusted text and restates its hard
 * rules after it (see functions/api/_lib/prompts.js), and sanitizeExamples()
 * re-checks whatever comes back regardless, so a nonsense or hostile note
 * can't produce a stored sentence that's missing the target word or isn't
 * Japanese — worst case the request fails and the card is left as it was.
 */
async function regenerateSingleExample(index) {
  const hiragana = document.getElementById("customHiragana").value.trim();
  const kanji = wordKanji();
  const english = document.getElementById("customEnglish").value.trim();
  const level = examples[index]?.level || jlptLevel();
  const instruction = (examples[index]?.instruction || "").trim();
  const policy = examples[index]?.kanjiPolicy || kanjiPolicy();
  const status = document.getElementById("generateStatus");

  if (!hiragana || !english) {
    status.textContent = "Fill in the hiragana and English fields first.";
    return;
  }

  warmUpTagger();

  // Avoid every OTHER current example, so the replacement doesn't just repeat
  // one of the sentences still sitting in the batch.
  // INCLUDES the sentence being replaced. Excluding it — the original version
  // — meant the one sentence the user had just rejected was the only one the
  // model wasn't told to avoid, so "rewrite" frequently returned it verbatim.
  const avoid = examples.map((ex) => ex.plain).filter(Boolean);

  setExamplesBusy(true);
  status.textContent = instruction ? "Rewriting this example…" : "Regenerating this example…";

  try {
    const { data } = await api("/api/generate-examples", {
      method: "POST",
      body: { hiragana, kanji, english, jlptLevel: level, count: 1, avoid, instruction, replacing: true, kanjiPolicy: policy },
    });

    const [replacement] = data.examples || [];
    if (!replacement) {
      status.textContent = "No usable example came back — try again.";
      return;
    }

    // furigana: null — this is fresh AI text, so any furigana the replaced
    // (possibly dictionary-pulled) example carried no longer applies. It stops
    // being a "dictionary" example too, so a later change of meaning leaves it
    // alone. The level and the note are carried over deliberately: the note
    // stays in the box so an unsatisfying result can be nudged again without
    // retyping it.
    examples[index] = {
      plain: replacement.japanese,
      english: replacement.english,
      furigana: null,
      source: "ai",
      level,
      instruction,
      kanjiPolicy: policy,
    };
    updateExampleCard(index);
    status.textContent = "";
  } catch (e) {
    status.textContent = e.message;
  } finally {
    setExamplesBusy(false);
  }
}

function addManualExample() {
  if (examples.length >= MAX_EXAMPLES) return;
  examples.push({ plain: "", english: "", furigana: null, source: "manual" });
  renderExamples();
  const cards = document.querySelectorAll("#examplesList .example-card textarea");
  cards[cards.length - 1]?.focus();
}

// ---------------------------------------------------------------------------
// "More" phrases — short indicative usage phrases, mirroring the curated
// pages' More column (e.g. "友達に会います -- meet a friend"). A separate,
// genuinely shorter style from the sentences above (style: "phrase" on the
// same endpoint), not just fewer of the same kind of output. Capped at
// MAX_MORE, matching verb_ready_final.csv's fixed shape. Reuses the same
// .example-card/.example-japanese/etc. classes and refreshExampleFurigana()
// as the examples section above — same card shape, so no reason to duplicate
// that plumbing.
// ---------------------------------------------------------------------------

const MAX_MORE = 2;

/** Updates every "More" card's preview in place, without rebuilding the inputs. */
function refreshAllMorePreviews() {
  document.querySelectorAll("#moreList .example-card").forEach((card, i) => {
    refreshExampleFurigana(card, more[i]?.plain || "", more[i]?.furigana);
  });
}

/** Updates one "More" card's inputs + preview in place, without touching the others. */
function updateMoreCard(index) {
  const card = document.querySelectorAll("#moreList .example-card")[index];
  const ex = more[index];
  if (!card || !ex) return;
  card.querySelector(".example-japanese").value = ex.plain;
  card.querySelector(".example-english").value = ex.english;
  refreshExampleFurigana(card, ex.plain, ex.furigana);
}

/** Same reasoning as setExamplesBusy — locks out concurrent mutation of `more`. */
function setMoreBusy(busy) {
  document.getElementById("generateMoreBtn").disabled = busy;
  document.getElementById("addManualMoreBtn").disabled = busy;
  document.querySelectorAll("#moreList button").forEach((btn) => {
    btn.disabled = busy;
  });
}

function renderMore() {
  const list = document.getElementById("moreList");
  list.textContent = "";

  more.forEach((ex, i) => {
    const card = document.createElement("div");
    card.className = "example-card";

    const japaneseInput = document.createElement("textarea");
    japaneseInput.rows = 1;
    japaneseInput.className = "example-japanese";
    japaneseInput.placeholder = "短いフレーズ";
    japaneseInput.value = ex.plain;

    const preview = document.createElement("div");
    preview.className = "example-furigana-preview furigana-preview";

    const englishInput = document.createElement("input");
    englishInput.type = "text";
    englishInput.className = "example-english";
    englishInput.placeholder = "Short gloss";
    englishInput.value = ex.english;

    const regenerateBtn = document.createElement("button");
    regenerateBtn.type = "button";
    regenerateBtn.className = "btn-secondary";
    regenerateBtn.textContent = "🔄 Regenerate";
    regenerateBtn.title = "Replace just this phrase";
    regenerateBtn.addEventListener("click", () => regenerateSingleMorePhrase(i));

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-danger";
    removeBtn.textContent = "✕ Remove";
    removeBtn.addEventListener("click", () => {
      more.splice(i, 1);
      renderMore();
    });

    const actions = document.createElement("div");
    actions.className = "example-card-actions";
    actions.append(regenerateBtn, removeBtn);

    japaneseInput.addEventListener("input", () => {
      more[i].plain = japaneseInput.value;
      more[i].furigana = null; // stored furigana no longer matches the text
      refreshExampleFurigana(card, japaneseInput.value, null);
    });
    englishInput.addEventListener("input", () => {
      more[i].english = englishInput.value;
    });

    card.append(japaneseInput, preview, englishInput, actions);
    list.appendChild(card);
    refreshExampleFurigana(card, ex.plain, ex.furigana);
  });

  document.getElementById("addManualMoreBtn").style.display = more.length < MAX_MORE ? "" : "none";
  document.getElementById("generateMoreBtn").textContent =
    more.length > 0 ? "🔄 Regenerate both" : "✨ Generate short phrases";
}

/** Always replaces both phrases at once — there's no "add more" here, the shape is fixed at 2. */
async function generateMorePhrases() {
  const hiragana = document.getElementById("customHiragana").value.trim();
  const kanji = wordKanji();
  const english = document.getElementById("customEnglish").value.trim();
  const jlptLevel = document.getElementById("jlptLevel").value;
  const status = document.getElementById("generateMoreStatus");

  if (!hiragana || !english) {
    status.textContent = "Fill in the hiragana and English fields first.";
    return;
  }

  warmUpTagger(); // "more" phrases need furigana on save too

  setMoreBusy(true);
  status.textContent = "Generating short phrases…";

  try {
    const { data } = await api("/api/generate-examples", {
      method: "POST",
      body: { hiragana, kanji, english, jlptLevel, style: "phrase", kanjiPolicy: kanjiPolicy() },
    });

    more = (data.examples || []).map((ex) => ({
      plain: ex.japanese,
      english: ex.english,
      furigana: null, // AI text; the tagger annotates it on save
    }));
    renderMore();
    status.textContent = more.length
      ? ""
      : "No usable phrases came back — try again or a different word.";
  } catch (e) {
    status.textContent = e.message;
  } finally {
    setMoreBusy(false);
  }
}

/** Replaces a single "More" phrase in place, keeping the other one untouched. */
async function regenerateSingleMorePhrase(index) {
  const hiragana = document.getElementById("customHiragana").value.trim();
  const kanji = wordKanji();
  const english = document.getElementById("customEnglish").value.trim();
  const jlptLevel = document.getElementById("jlptLevel").value;
  const status = document.getElementById("generateMoreStatus");

  if (!hiragana || !english) {
    status.textContent = "Fill in the hiragana and English fields first.";
    return;
  }

  warmUpTagger();

  // Avoid the OTHER phrase, so the replacement isn't just a rephrasing of it.
  // INCLUDES the phrase being replaced — see regenerateSingleExample().
  const avoid = more.map((ex) => ex.plain).filter(Boolean);

  setMoreBusy(true);
  status.textContent = "Regenerating this phrase…";

  try {
    const { data } = await api("/api/generate-examples", {
      method: "POST",
      body: { hiragana, kanji, english, jlptLevel, style: "phrase", count: 1, avoid, replacing: true, kanjiPolicy: kanjiPolicy() },
    });

    const [replacement] = data.examples || [];
    if (!replacement) {
      status.textContent = "No usable phrase came back — try again.";
      return;
    }

    more[index] = { plain: replacement.japanese, english: replacement.english, furigana: null };
    updateMoreCard(index);
    status.textContent = "";
  } catch (e) {
    status.textContent = e.message;
  } finally {
    setMoreBusy(false);
  }
}

function addManualMorePhrase() {
  if (more.length >= MAX_MORE) return;
  more.push({ plain: "", english: "", furigana: null });
  renderMore();
  const cards = document.querySelectorAll("#moreList .example-card textarea");
  cards[cards.length - 1]?.focus();
}

// ---------------------------------------------------------------------------
// Notes preview (unchanged bracket-syntax field from the old single-page form)
// ---------------------------------------------------------------------------

function updateNotesPreview() {
  const notesPreview = document.getElementById("notesPreview");
  notesPreview.innerHTML = "";
  notesPreview.appendChild(renderFurigana(document.getElementById("customNotes").value));
}

// ---------------------------------------------------------------------------
// JLPT level preference
// ---------------------------------------------------------------------------

/** Both generation defaults, in one round trip. Set on account-settings.html. */
async function loadGenerationPreferences() {
  if (!session) return;
  const { data } = await supabaseClient
    .from("user_preferences")
    .select("jlpt_level, kanji_policy")
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (data?.jlpt_level) {
    document.getElementById("jlptLevel").value = data.jlpt_level;
    syncJlptControls("jlptLevel");
  }

  if (data?.kanji_policy) {
    document.getElementById("kanjiPolicy").value = data.kanji_policy;
    syncMirroredControl("kanji", "kanjiPolicy");
  }
}

// ---------------------------------------------------------------------------
// Edit mode
// ---------------------------------------------------------------------------

// Stored rows already hold correct bracket furigana, so keep it rather than
// re-deriving it — that way opening a word for editing needs no tagger, and
// re-saving without touching a sentence can't quietly change its readings.
function examplesFromRow(row) {
  if (Array.isArray(row.examples) && row.examples.length) {
    return row.examples.map((e) => ({
      plain: furiganaToPlain(e.furigana || ""),
      english: e.translation || "",
      furigana: e.furigana || null,
      // Absent on every row saved before per-example overrides existed, which
      // is correct: those cards fall back to the section-wide value.
      level: e.level || undefined,
      kanjiPolicy: e.kanjiPolicy || undefined,
    }));
  }
  // No legacy fallback: `examples` is the single source of truth. The
  // example_furigana/translation columns it used to read were dropped once the
  // one row that still depended on them had been backfilled.
  return [];
}

function moreFromRow(row) {
  if (!Array.isArray(row.more)) return [];
  return row.more.map((e) => ({
    plain: furiganaToPlain(e.furigana || ""),
    english: e.translation || "",
    furigana: e.furigana || null,
  }));
}

async function loadForEdit(id) {
  const { data: row, error } = await supabaseClient
    .from("custom_vocab")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error || !row) {
    document.getElementById("formError").textContent = "That word couldn't be found.";
    return;
  }

  document.getElementById("customHiragana").value = row.hiragana || "";
  // `?? !row.kanji` covers rows saved before kanji_usually_kana existed, where
  // a missing kanji was the only trace left of the box having been ticked.
  setKanaOnly(row.kanji_usually_kana ?? !row.kanji, row.kanji || "");
  document.getElementById("customEnglish").value = row.english || "";
  document.getElementById("customNotes").value = row.notes_furigana || "";
  jishoSlug = row.jisho_slug || null;
  partOfSpeech = row.part_of_speech || null;

  examples = examplesFromRow(row);
  more = moreFromRow(row);

  // needs_furigana means the `furigana` field holds PLAIN text the Worker
  // couldn't annotate, not bracket syntax. Dropping it here is essential:
  // annotateForSave() skips anything that already carries furigana, so
  // keeping it would save the un-annotated text as if it were authoritative
  // and clear the flag — permanently losing the ruby for that word. Applies
  // to `more` too, which the background generator now fills in as well.
  if (row.needs_furigana) {
    examples = examples.map((ex) => ({ ...ex, furigana: null }));
    more = more.map((ex) => ({ ...ex, furigana: null }));
  }
  pitch = Array.isArray(row.pitch) ? row.pitch : [];
  setPitch(document.getElementById("pitchDisplay"), pitch);
  document.getElementById("pitchRow").style.display = pitch.length ? "" : "none";
  renderExamples();
  renderMore();
  updateNotesPreview();

  document.getElementById("formSubmitBtn").textContent = "Save changes";
  document.getElementById("cancelEditBtn").style.display = "";

  // Prefill the lookup so re-fetching this word from the dictionary is one
  // click from step 1. That is the repair path for rows saved before the kanji
  // was kept: they store kanji = null, which can't be recovered from the row
  // itself, and without the kanji the generator can only be asked for the kana
  // spelling (see PROMPTS.kanaOnlyNote).
  document.getElementById("jishoSearchInput").value =
    row.jisho_slug || row.kanji || row.hiragana || "";
  if (!row.kanji) {
    setKanaOnlyHint(
      "No kanji is stored for this word. Go Back and press Search to fetch it " +
        "from the dictionary — example sentences can then use either spelling.",
    );
  }

  if (row.jlpt_level) {
    document.getElementById("jlptLevel").value = row.jlpt_level;
    syncJlptControls("jlptLevel");
  }
  // A row the Worker generated in the background shows plain text until the
  // tagger has run; opening it for editing is a good moment to pay that off,
  // and saving will clear needs_furigana (see saveWord).
  if (row.needs_furigana) warmUpTagger();
  applyEditLayout();
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/** Shared by both `examples` and `more` — same {plain, english} shape either way. */
async function annotateForSave(list) {
  // Anything that already carries authoritative furigana (dictionary-pulled
  // sentences) needs no tagger at all, so don't pay for loading one unless
  // something in the list actually requires it.
  // `level` rides along in the stored JSON (no migration — `examples` is
  // jsonb) so reopening a word for editing restores each sentence's own
  // difficulty instead of silently resetting every card to the page default.
  // Undefined stays undefined, preserving "follow the default" as distinct
  // from "was pinned to N5".
  const shape = (ex) => {
    const out = { furigana: ex.furigana, translation: ex.english.trim() };
    if (ex.level) out.level = ex.level;
    if (ex.kanjiPolicy) out.kanjiPolicy = ex.kanjiPolicy;
    return out;
  };

  const needsTagger = list.some((ex) => ex.plain.trim() && !ex.furigana);
  if (!needsTagger) {
    return list.filter((ex) => ex.plain.trim()).map(shape);
  }

  // Save waits for the tagger rather than accepting "best effort" here — the
  // whole point of this page is that the user shouldn't have to hand-type
  // brackets, so silently storing plain text on a slow network would be a
  // worse outcome than a short wait. Only blocks on the FIRST call — once
  // cachedTagger is set (or taggerFailed is), later calls resolve instantly.
  if (!cachedTagger) {
    try {
      cachedTagger = await getTagger();
      taggerFailed = false;
    } catch {
      taggerFailed = true; // dictionary truly unreachable — fall back to plain text
    }
  }
  const tagger = cachedTagger;

  return list
    .filter((ex) => ex.plain.trim())
    .map((ex) => {
      const plain = ex.plain.trim();
      let furigana = plain;
      if (tagger) {
        try {
          furigana = annotateWithFurigana(plain, tagger);
        } catch {
          furigana = plain;
        }
      }
      return { ...shape(ex), furigana };
    });
}

/**
 * Writes the current form state to custom_vocab and returns the row id.
 *
 * Shared by all four exits from the wizard (each step-2 choice plus step 3's
 * Save), which is what keeps them consistent — there is exactly one place that
 * knows the payload shape.
 *
 * IDEMPOTENT BY DESIGN: on a successful insert it adopts the new id as
 * `editingId`, so a second call updates that row instead of inserting a
 * duplicate. That matters because step 2's choices can fail *after* the word
 * is already saved (an AI key that turns out to be missing), leaving the user
 * on step 2 free to pick a different option — which must not create a second
 * copy of the word.
 *
 * @param {object} overrides extra columns, e.g. the generation status
 * @returns {Promise<{ ok: boolean, id?: string, message?: string }>}
 */
async function saveWord(overrides = {}) {
  if (!session) return { ok: false, message: "Your session expired. Log in again." };

  const storedExamples = await annotateForSave(examples);
  const storedMore = await annotateForSave(more);

  const payload = {
    user_id: session.user.id,
    hiragana: document.getElementById("customHiragana").value.trim(),
    kanji: wordKanji() || null,
    // Kept even when the dictionary says the word is usually kana — this flag
    // only controls whether My Vocab shows it.
    kanji_usually_kana: kanjiUsuallyKana(),
    english: document.getElementById("customEnglish").value.trim(),
    examples: storedExamples,
    more: storedMore,
    pitch,
    notes_furigana: document.getElementById("customNotes").value.trim() || null,
    part_of_speech: partOfSpeech,
    jisho_slug: jishoSlug,
    // annotateForSave() has just run the tagger over everything here, so
    // whatever this row owed is paid. Explicit rather than relying on the
    // column default: editing a word the Worker generated in the background
    // has to CLEAR the flag, not leave it set on hand-annotated text.
    needs_furigana: false,
    updated_at: new Date().toISOString(),
    ...overrides,
  };

  const query = editingId
    ? supabaseClient.from("custom_vocab").update(payload).eq("id", editingId).select("id").single()
    : supabaseClient.from("custom_vocab").insert(payload).select("id").single();

  const { data, error } = await query;
  if (error) return { ok: false, message: error.message };

  editingId = String(data.id); // see IDEMPOTENT above
  return { ok: true, id: editingId };
}

// ---------------------------------------------------------------------------
// Step 2 — the three ways out
// ---------------------------------------------------------------------------

function setStep2Busy(busy, message = "") {
  document.querySelectorAll("#choiceDictionary, #choiceBackground, #choiceReview").forEach((btn) => {
    btn.disabled = busy;
  });
  document.getElementById("step2Status").textContent = message;
  // Re-deriving this is what stops a disabled-because-busy dictionary card
  // from coming back enabled when there were never any sentences to use.
  if (!busy) updateDictionaryChoice();
}

/** CHOICE 1 — save the corpus sentences and leave. */
async function chooseDictionary() {
  const error = document.getElementById("step2Error");
  error.textContent = "";
  setStep2Busy(true, "Saving…");

  // The card says "use the dictionary's sentences", so that is what gets
  // saved — literally, even if the user has been through the AI review step
  // and its generated sentences are still sitting in `examples`. Restoring
  // from the stash is what makes coming back here a real second chance rather
  // than a save of whatever the last path happened to leave behind.
  // Capped: the stash now holds the WHOLE corpus pool, which can be longer
  // than the list is allowed to keep.
  examples = dictionarySentences.slice(0, MAX_EXAMPLES).map((s) => ({ ...s }));
  renderExamples();

  const result = await saveWord({ example_status: "ready", example_error: null });
  if (!result.ok) {
    error.textContent = result.message;
    setStep2Busy(false);
    return;
  }
  window.location.href = "my-vocab.html";
}

/**
 * CHOICE 2 — save now, generate later.
 *
 * ORDER IS LOAD-BEARING: the row is inserted BEFORE the generation is
 * requested, so the worst outcome is a saved word whose sentences didn't
 * arrive (visible and retryable on My Vocab) rather than a word that vanished
 * because a provider was down.
 *
 * The dictionary sentences are saved along with it as a safety net. On success
 * the Worker replaces them with the AI ones — this choice is "AI writes them",
 * and merging two sources server-side would mean teaching the Worker about
 * furigana it can't produce. On failure they're what the row keeps.
 */
async function chooseBackground() {
  const error = document.getElementById("step2Error");
  error.textContent = "";
  setStep2Busy(true, "Saving…");

  const level = jlptLevel();
  const result = await saveWord({
    example_status: "pending",
    example_error: null,
    jlpt_level: level,
  });
  if (!result.ok) {
    error.textContent = result.message;
    setStep2Busy(false);
    return;
  }

  try {
    await api("/api/queue-examples", {
      method: "POST",
      body: {
        vocabId: result.id,
        hiragana: document.getElementById("customHiragana").value.trim(),
        kanji: wordKanji(),
        english: document.getElementById("customEnglish").value.trim(),
        jlptLevel: level,
        kanjiPolicy: kanjiPolicy(),
        count: MAX_EXAMPLES,
      },
    });
  } catch (e) {
    // The request never started, so nothing will ever clear 'pending'. Flag it
    // here rather than leaving a row spinning forever — and show the reason
    // now, since "no AI key" is something the user can act on immediately.
    await supabaseClient
      .from("custom_vocab")
      .update({ example_status: "failed", example_error: e.message })
      .eq("id", result.id);
    error.textContent = `Saved "${payloadHeadword()}", but the sentences couldn't be started: ${e.message}`;
    setStep2Busy(false);
    return;
  }

  window.location.href = "my-vocab.html?generating=1";
}

/** CHOICE 3 — generate now, then hand over to the review step. */
async function chooseReview() {
  const error = document.getElementById("step2Error");
  error.textContent = "";
  setStep2Busy(true, "Writing example sentences…");

  // Make room first. generateExamples() only TOPS UP to MAX_EXAMPLES, so with
  // three corpus sentences already pulled it would generate nothing at all and
  // drop the user on a review screen containing no AI sentences whatsoever —
  // the exact opposite of the choice they just made. Only the automatic pulls
  // are cleared; anything typed or edited by hand is already marked "manual".
  examples = examples.filter((ex) => ex.source !== "dictionary");
  renderExamples();

  // withPhrases: the short "More" phrases come back in the SAME provider call
  // rather than costing a second one. Creating a word wants both, and every
  // call spends a slice of the user's daily quota — see runCombinedGeneration()
  // server-side. Rewriting later regenerates one section at a time, where the
  // user is targeting something specific.
  await generateExamples({ withPhrases: true });

  setStep2Busy(false);

  const failure = document.getElementById("generateStatus").textContent;
  if (failure) {
    // generateExamples() reports into #generateStatus, which lives on step 3.
    // Surface it here instead of silently moving the user to a screen whose
    // error message they'd have to scroll to find.
    error.textContent = failure;
    return;
  }
  goToStep(3);
}

/** The escape hatch: no AI, no corpus, just write them by hand on step 3. */
function chooseManual() {
  if (examples.length === 0) addManualExample();
  goToStep(3);
}

function payloadHeadword() {
  return wordKanji() || document.getElementById("customHiragana").value.trim();
}

// ---------------------------------------------------------------------------
// Step 3 — final save
// ---------------------------------------------------------------------------

async function handleFormSubmit(e) {
  e.preventDefault();
  if (!session) return;

  const formError = document.getElementById("formError");
  const submitBtn = document.getElementById("formSubmitBtn");
  formError.textContent = "";
  submitBtn.disabled = true;

  try {
    // Reaching this screen means the sentences were reviewed by a human, so
    // there is nothing outstanding on the row whatever it was before.
    const result = await saveWord({ example_status: "ready", example_error: null });
    if (!result.ok) {
      formError.textContent = result.message;
      return;
    }
    window.location.href = "my-vocab.html";
  } finally {
    submitBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Guest gating + wiring
// ---------------------------------------------------------------------------

function setGuestState(isGuest) {
  document.getElementById("guestNotice").style.display = isGuest ? "" : "none";
  document.getElementById("customVocabForm").style.display = isGuest ? "none" : "flex";
}

document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const idParam = params.get("id");
  editingId = idParam && /^\d+$/.test(idParam) ? idParam : null;

  document.getElementById("customVocabForm").addEventListener("submit", handleFormSubmit);
  document.getElementById("customNotes").addEventListener("input", updateNotesPreview);
  document.getElementById("guestLoginLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("loginLink")?.click();
  });

  document.getElementById("jishoSearchInput").addEventListener("focus", warmUpTagger, { once: true });
  document.getElementById("jishoSearchInput").addEventListener("input", () => {
    maybeSuggestDictionaryForm();
  });
  document.getElementById("jishoSearchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      performJishoSearch();
    }
  });
  document.getElementById("jishoSearchBtn").addEventListener("click", performJishoSearch);
  document.getElementById("jishoResults").addEventListener("change", (e) => {
    if (e.target.value !== "manual") {
      applyJishoEntry(Number(e.target.value));
    } else {
      // No dictionary entry backing the form anymore.
      setKanaOnlyHint(null);
      document.getElementById("senseSelectLabel").style.display = "none";
    }
  });

  document.getElementById("senseSelect").addEventListener("change", (e) => {
    applySense(e.target.value === ALL_SENSES ? ALL_SENSES : Number(e.target.value));
  });

  document.getElementById("kanaOnly").addEventListener("change", (e) => {
    setKanaOnly(e.target.checked);
    setKanaOnlyHint(null); // the user just overrode whatever jisho suggested
  });

  document.getElementById("generateBtn").addEventListener("click", () => generateExamples());
  document.getElementById("addManualBtn").addEventListener("click", addManualExample);
  document.getElementById("addFromDictionaryBtn").addEventListener("click", addFromDictionary);
  document.getElementById("rewriteAllBtn").addEventListener("click", rewriteAllExamples);
  document.getElementById("jlptLevelExamples").addEventListener("change", () => syncJlptControls("jlptLevelExamples"));
  ["kanjiPolicy", "kanjiPolicyExamples"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      syncMirroredControl("kanji", id);
      saveKanjiPolicy();
    });
  });

  document.getElementById("generateMoreBtn").addEventListener("click", generateMorePhrases);
  document.getElementById("addManualMoreBtn").addEventListener("click", addManualMorePhrase);

  // --- wizard navigation -------------------------------------------------
  document.getElementById("toStep2Btn").addEventListener("click", () => goToStep(2));
  document.querySelectorAll(".wizard-back").forEach((btn) => {
    btn.addEventListener("click", () => goToStep(Number(btn.dataset.goto), { force: true }));
  });
  document.querySelectorAll("#wizardProgress li").forEach((li) => {
    const step = Number(li.dataset.step);
    li.querySelector("button").addEventListener("click", () => {
      // Going BACK is always allowed; going forward still has to pass the
      // word check in goToStep(), so this can't be used to skip step 1.
      goToStep(step, { force: step < currentStep });
    });
  });

  // Typing in the required fields both re-validates and keeps the collapsed
  // summary truthful, so manual entry (no dictionary hit) behaves the same.
  ["customHiragana", "customEnglish", "customKanji"].forEach((id) => {
    document.getElementById(id).addEventListener("input", () => {
      updateWordDetailsSummary();
      if (wordIsUsable()) document.getElementById("step1Error").textContent = "";
    });
  });

  // --- step 2 choices ----------------------------------------------------
  document.getElementById("choiceDictionary").addEventListener("click", chooseDictionary);
  document.getElementById("choiceBackground").addEventListener("click", chooseBackground);
  document.getElementById("choiceReview").addEventListener("click", chooseReview);
  document.getElementById("choiceManual").addEventListener("click", (e) => {
    e.preventDefault();
    chooseManual();
  });

  document.getElementById("jlptLevel").addEventListener("change", () => syncJlptControls("jlptLevel"));
  document.getElementById("jlptLevelReview").addEventListener("change", () => syncJlptControls("jlptLevelReview"));

  updateNotesPreview();
  renderExamples();
  renderMore();
  updateDictionaryChoice();

  // Decide the layout from the URL, not from the loaded row. loadForEdit()
  // waits on a Supabase round trip, and switching only after it returns shows
  // a step-1 wizard for a moment first — which looks like the page changing
  // its mind. Nothing in applyEditLayout() needs the row's data.
  if (editingId) applyEditLayout();
  else goToStep(1, { force: true });
});

document.addEventListener("auth-state-changed", async (e) => {
  const wasGuest = !session;
  session = e.detail.session;
  setGuestState(!session);
  if (!session) return;

  // TOKEN_REFRESHED re-dispatches this roughly hourly; only load once per session.
  if (!wasGuest) return;

  await loadGenerationPreferences();
  if (editingId) await loadForEdit(editingId);
});
