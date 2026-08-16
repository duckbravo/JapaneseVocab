// Add/edit a custom vocab word: jisho.org lookup, AI-generated example
// sentences, and furigana annotation on save.
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
let jishoSlug = null;
let partOfSpeech = null;
let examples = []; // [{ plain, english }] — full example sentences
let more = []; // [{ plain, english }] — short "More" usage phrases, capped at 2
let cachedTagger = null; // set once js/furigana.js's tagger has loaded

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
// jisho.org lookup
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

// Checked against the FIRST sense only, not "any of up to 5 senses" — that
// matches the sense whose gloss is actually shown/saved below, and avoids a
// real jisho.org case (綺麗/きれい): its 2nd/3rd senses carry this tag but
// its 1st doesn't, and 綺麗 is a normal, commonly kanji-written entry — using
// .some() across all senses used to auto-clear the kanji field for it, which
// is exactly the kind of "technically one sense says so" default that feels
// wrong to a user who just searched a word they see written in kanji daily.
function isKanaOnlySense(entry) {
  return entry.senses[0]?.tags.includes("Usually written using kana alone") ?? false;
}

/** Explains an auto-set kanji checkbox so it doesn't look like it came from nowhere. */
function setKanaOnlyHint(reason) {
  const hint = document.getElementById("kanaOnlyHint");
  hint.textContent = reason || "";
  hint.style.display = reason ? "" : "none";
}

function applyJishoEntry(index) {
  const entry = jishoResults[index];
  if (!entry) return;

  const form0 = entry.forms[0] || {};
  const noKanjiForm = !form0.word;
  const kanaTagged = isKanaOnlySense(entry);
  const kanaOnly = noKanjiForm || kanaTagged;

  document.getElementById("customHiragana").value = form0.reading || "";
  // Fill the kanji box even when defaulting to "usually kana" — the box's
  // content and the checkbox are independent (see setKanaOnly/effectiveKanji
  // below), so the user can just untick to use it instead of retyping it.
  setKanaOnly(kanaOnly, form0.word || "");
  setKanaOnlyHint(
    noKanjiForm
      ? "jisho has no kanji spelling on record for this word."
      : kanaTagged
        ? "jisho notes this word is usually written in kana."
        : null,
  );
  document.getElementById("customEnglish").value = (entry.senses[0]?.english || []).join(", ");

  jishoSlug = entry.slug;
  partOfSpeech = entry.senses[0]?.partsOfSpeech[0] || null;

  const otherForms = entry.forms.slice(1).filter((f) => f.word);
  const otherFormsEl = document.getElementById("otherForms");
  if (otherForms.length) {
    otherFormsEl.textContent =
      "Other forms: " + otherForms.map((f) => `${f.word} (${f.reading})`).join(", ");
    otherFormsEl.style.display = "";
  } else {
    otherFormsEl.style.display = "none";
  }
}

// checked/disabled are about whether kanji is CURRENTLY IN USE; the input's
// text is independent of both, and is only ever set when the caller passes
// kanjiValue explicitly (a fresh jisho selection or loading an edit) — never
// as a side effect of the checkbox changing. That's what lets the user flip
// the checkbox back and forth without losing whatever kanji was there.
function setKanaOnly(checked, kanjiValue) {
  const checkbox = document.getElementById("kanaOnly");
  const kanjiInput = document.getElementById("customKanji");
  checkbox.checked = checked;
  kanjiInput.disabled = checked;
  if (kanjiValue !== undefined) kanjiInput.value = kanjiValue;
}

// The box may hold kanji text while "usually kana" is ticked (see above), so
// its raw .value no longer means "the kanji to use" by itself — the checkbox
// is the actual source of truth for that. Every place that needs "this
// word's kanji, or none" (saving, example generation) should read this
// instead of the input directly.
function effectiveKanji() {
  if (document.getElementById("kanaOnly").checked) return "";
  return document.getElementById("customKanji").value.trim();
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
  status.textContent = "Searching jisho.org…";

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
 * dictionary form — jisho searches work far better on that. Best-effort only:
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

function refreshExampleFurigana(card, plain) {
  const preview = card.querySelector(".example-furigana-preview");
  const annotated = annotateIfReady(plain);
  preview.innerHTML = "";
  if (annotated !== null) {
    preview.appendChild(renderFurigana(annotated));
  } else if (plain) {
    // Loaded-but-failed-on-this-text and never-going-to-load both just show
    // the plain sentence; only "still loading" gets the placeholder message.
    preview.textContent = cachedTagger || taggerFailed ? plain : "Loading furigana…";
  }
}

/** Updates every card's preview in place, without rebuilding the inputs. */
function refreshAllExamplePreviews() {
  document.querySelectorAll("#examplesList .example-card").forEach((card, i) => {
    refreshExampleFurigana(card, examples[i]?.plain || "");
  });
}

/** Updates one card's inputs + preview in place, without touching the others. */
function updateExampleCard(index) {
  const card = document.querySelectorAll("#examplesList .example-card")[index];
  const ex = examples[index];
  if (!card || !ex) return;
  card.querySelector(".example-japanese").value = ex.plain;
  card.querySelector(".example-english").value = ex.english;
  refreshExampleFurigana(card, ex.plain);
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
  document.getElementById("addMoreBtn").disabled = busy;
  document.getElementById("addManualBtn").disabled = busy;
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

    const regenerateBtn = document.createElement("button");
    regenerateBtn.type = "button";
    regenerateBtn.className = "btn-secondary";
    regenerateBtn.textContent = "🔄 Regenerate";
    regenerateBtn.title = "Replace just this example";
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
    actions.append(regenerateBtn, removeBtn);

    japaneseInput.addEventListener("input", () => {
      examples[i].plain = japaneseInput.value;
      refreshExampleFurigana(card, japaneseInput.value);
    });
    englishInput.addEventListener("input", () => {
      examples[i].english = englishInput.value;
    });

    card.append(japaneseInput, preview, englishInput, actions);
    list.appendChild(card);
    refreshExampleFurigana(card, ex.plain);
  });

  document.getElementById("addMoreBtn").style.display =
    examples.length > 0 && examples.length < MAX_EXAMPLES ? "" : "none";
  document.getElementById("generateBtn").textContent =
    examples.length > 0 ? "🔄 Regenerate all" : "✨ Generate examples";
}

async function generateExamples(mode) {
  const hiragana = document.getElementById("customHiragana").value.trim();
  const kanji = effectiveKanji();
  const english = document.getElementById("customEnglish").value.trim();
  const jlptLevel = document.getElementById("jlptLevel").value;
  const status = document.getElementById("generateStatus");

  if (!hiragana || !english) {
    status.textContent = "Fill in the hiragana and English fields first.";
    return;
  }

  const count = mode === "more" ? Math.min(2, MAX_EXAMPLES - examples.length) : 3;
  if (count <= 0) return;

  warmUpTagger(); // examples need furigana on save; make sure it's loading

  // "More" keeps the existing batch, so tell the model what's already there —
  // otherwise it has no way to know and happily returns near-repeats.
  const avoid = mode === "more" ? examples.map((ex) => ex.plain).filter(Boolean) : [];

  setExamplesBusy(true);
  status.textContent = "Generating example sentences…";

  try {
    const { data } = await api("/api/generate-examples", {
      method: "POST",
      body: { hiragana, kanji, english, jlptLevel, count, avoid },
    });

    const generated = (data.examples || []).map((ex) => ({ plain: ex.japanese, english: ex.english }));
    if (mode === "more") examples = examples.concat(generated);
    else examples = generated;

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

/** Replaces a single example in place, keeping the rest of the batch untouched. */
async function regenerateSingleExample(index) {
  const hiragana = document.getElementById("customHiragana").value.trim();
  const kanji = effectiveKanji();
  const english = document.getElementById("customEnglish").value.trim();
  const jlptLevel = document.getElementById("jlptLevel").value;
  const status = document.getElementById("generateStatus");

  if (!hiragana || !english) {
    status.textContent = "Fill in the hiragana and English fields first.";
    return;
  }

  warmUpTagger();

  // Avoid every OTHER current example, so the replacement doesn't just repeat
  // one of the sentences still sitting in the batch.
  const avoid = examples
    .filter((_, i) => i !== index)
    .map((ex) => ex.plain)
    .filter(Boolean);

  setExamplesBusy(true);
  status.textContent = "Regenerating this example…";

  try {
    const { data } = await api("/api/generate-examples", {
      method: "POST",
      body: { hiragana, kanji, english, jlptLevel, count: 1, avoid },
    });

    const [replacement] = data.examples || [];
    if (!replacement) {
      status.textContent = "No usable example came back — try again.";
      return;
    }

    examples[index] = { plain: replacement.japanese, english: replacement.english };
    updateExampleCard(index);
    status.textContent = "";
  } catch (e) {
    status.textContent = e.message;
  } finally {
    setExamplesBusy(false);
  }
}

function addManualExample() {
  examples.push({ plain: "", english: "" });
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
    refreshExampleFurigana(card, more[i]?.plain || "");
  });
}

/** Updates one "More" card's inputs + preview in place, without touching the others. */
function updateMoreCard(index) {
  const card = document.querySelectorAll("#moreList .example-card")[index];
  const ex = more[index];
  if (!card || !ex) return;
  card.querySelector(".example-japanese").value = ex.plain;
  card.querySelector(".example-english").value = ex.english;
  refreshExampleFurigana(card, ex.plain);
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
      refreshExampleFurigana(card, japaneseInput.value);
    });
    englishInput.addEventListener("input", () => {
      more[i].english = englishInput.value;
    });

    card.append(japaneseInput, preview, englishInput, actions);
    list.appendChild(card);
    refreshExampleFurigana(card, ex.plain);
  });

  document.getElementById("addManualMoreBtn").style.display = more.length < MAX_MORE ? "" : "none";
  document.getElementById("generateMoreBtn").textContent =
    more.length > 0 ? "🔄 Regenerate both" : "✨ Generate short phrases";
}

/** Always replaces both phrases at once — there's no "add more" here, the shape is fixed at 2. */
async function generateMorePhrases() {
  const hiragana = document.getElementById("customHiragana").value.trim();
  const kanji = effectiveKanji();
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
      body: { hiragana, kanji, english, jlptLevel, style: "phrase" },
    });

    more = (data.examples || []).map((ex) => ({ plain: ex.japanese, english: ex.english }));
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
  const kanji = effectiveKanji();
  const english = document.getElementById("customEnglish").value.trim();
  const jlptLevel = document.getElementById("jlptLevel").value;
  const status = document.getElementById("generateMoreStatus");

  if (!hiragana || !english) {
    status.textContent = "Fill in the hiragana and English fields first.";
    return;
  }

  warmUpTagger();

  // Avoid the OTHER phrase, so the replacement isn't just a rephrasing of it.
  const avoid = more
    .filter((_, i) => i !== index)
    .map((ex) => ex.plain)
    .filter(Boolean);

  setMoreBusy(true);
  status.textContent = "Regenerating this phrase…";

  try {
    const { data } = await api("/api/generate-examples", {
      method: "POST",
      body: { hiragana, kanji, english, jlptLevel, style: "phrase", count: 1, avoid },
    });

    const [replacement] = data.examples || [];
    if (!replacement) {
      status.textContent = "No usable phrase came back — try again.";
      return;
    }

    more[index] = { plain: replacement.japanese, english: replacement.english };
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
  more.push({ plain: "", english: "" });
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

async function loadJlptPreference() {
  if (!session) return;
  const { data } = await supabaseClient
    .from("user_preferences")
    .select("jlpt_level")
    .eq("user_id", session.user.id)
    .maybeSingle();

  const select = document.getElementById("jlptLevel");
  if (data?.jlpt_level) select.value = data.jlpt_level;
}

// ---------------------------------------------------------------------------
// Edit mode
// ---------------------------------------------------------------------------

function examplesFromRow(row) {
  if (Array.isArray(row.examples) && row.examples.length) {
    return row.examples.map((e) => ({
      plain: furiganaToPlain(e.furigana || ""),
      english: e.translation || "",
    }));
  }
  if (row.example_furigana) {
    return [{ plain: furiganaToPlain(row.example_furigana), english: row.translation || "" }];
  }
  return [];
}

function moreFromRow(row) {
  if (!Array.isArray(row.more)) return [];
  return row.more.map((e) => ({
    plain: furiganaToPlain(e.furigana || ""),
    english: e.translation || "",
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
  setKanaOnly(!row.kanji, row.kanji || "");
  document.getElementById("customEnglish").value = row.english || "";
  document.getElementById("customNotes").value = row.notes_furigana || "";
  jishoSlug = row.jisho_slug || null;
  partOfSpeech = row.part_of_speech || null;

  examples = examplesFromRow(row);
  more = moreFromRow(row);
  renderExamples();
  renderMore();
  updateNotesPreview();

  document.getElementById("pageTitle").textContent = "Edit word";
  document.getElementById("formSubmitBtn").textContent = "Save";
  document.getElementById("cancelEditBtn").style.display = "";
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/** Shared by both `examples` and `more` — same {plain, english} shape either way. */
async function annotateForSave(list) {
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
      return { furigana, translation: ex.english.trim() };
    });
}

async function handleFormSubmit(e) {
  e.preventDefault();
  if (!session) return;

  const formError = document.getElementById("formError");
  const submitBtn = document.getElementById("formSubmitBtn");
  formError.textContent = "";
  submitBtn.disabled = true;

  try {
    const storedExamples = await annotateForSave(examples);
    const storedMore = await annotateForSave(more);
    const first = storedExamples[0] || {};

    const payload = {
      user_id: session.user.id,
      hiragana: document.getElementById("customHiragana").value.trim(),
      kanji: effectiveKanji() || null,
      english: document.getElementById("customEnglish").value.trim(),
      examples: storedExamples,
      more: storedMore,
      example_furigana: first.furigana || null,
      translation: first.translation || null,
      notes_furigana: document.getElementById("customNotes").value.trim() || null,
      part_of_speech: partOfSpeech,
      jisho_slug: jishoSlug,
      updated_at: new Date().toISOString(),
    };

    const query = editingId
      ? supabaseClient.from("custom_vocab").update(payload).eq("id", editingId)
      : supabaseClient.from("custom_vocab").insert(payload);

    const { error } = await query;
    if (error) {
      formError.textContent = error.message;
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
    if (e.target.value !== "manual") applyJishoEntry(Number(e.target.value));
    else setKanaOnlyHint(null); // no jisho entry backing the form anymore
  });

  document.getElementById("kanaOnly").addEventListener("change", (e) => {
    setKanaOnly(e.target.checked);
    setKanaOnlyHint(null); // the user just overrode whatever jisho suggested
  });

  document.getElementById("generateBtn").addEventListener("click", () => generateExamples("replace"));
  document.getElementById("addMoreBtn").addEventListener("click", () => generateExamples("more"));
  document.getElementById("addManualBtn").addEventListener("click", addManualExample);

  document.getElementById("generateMoreBtn").addEventListener("click", generateMorePhrases);
  document.getElementById("addManualMoreBtn").addEventListener("click", addManualMorePhrase);

  updateNotesPreview();
  renderExamples();
  renderMore();
});

document.addEventListener("auth-state-changed", async (e) => {
  const wasGuest = !session;
  session = e.detail.session;
  setGuestState(!session);
  if (!session) return;

  // TOKEN_REFRESHED re-dispatches this roughly hourly; only load once per session.
  if (!wasGuest) return;

  await loadJlptPreference();
  if (editingId) await loadForEdit(editingId);
});
