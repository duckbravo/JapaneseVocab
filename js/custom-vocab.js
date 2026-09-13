// Renders the "My Vocab" list: custom_vocab rows, starring, and delete.
// Classic script. Depends on window.supabaseClient (bridged in
// supabase-client.js), toggleStar/isWordStarred (saved-words.js), and
// renderFurigana (js/furigana.js, which must load before this file).
//
// Adding/editing a word lives on add-vocab.html now — this page is list-only.
// The ✏️ button below is a plain link to add-vocab.html?id=<row.id>.
//
// This page is also where BACKGROUND GENERATION becomes visible. A word added
// via add-vocab.html's "write them in the background" choice is saved with
// example_status='pending' and finished by the Worker
// (functions/api/queue-examples.js) after the browser has moved on. So a row
// here can be in one of three states, and two of them need showing:
//   pending — spinner, and a poll so it fills itself in without a refresh
//   failed  — a red flag with the provider's reason and a Retry button
// A background job that can fail silently is worse than no background job;
// the red flag is what keeps the feature honest.
//
// SECURITY NOTE: unlike the curated CSVs (index.html/i-adjectives.html), this
// data is user-submitted, so it must NEVER be rendered via innerHTML.
// renderFurigana() builds real DOM nodes with textContent/createTextNode only,
// so something like "<script>" typed into a field renders as literal text
// instead of being parsed as markup. The same applies to example_error: it is
// a server-written string, but it goes in via textContent like everything else.

let customVocabSession = null;
let pendingPollTimer = null;

// ---------------------------------------------------------------------------
// Server communication — same shape as js/add-vocab.js's api()
// ---------------------------------------------------------------------------

async function vocabApi(path, { method = "GET", body } = {}) {
  // Always from getSession(), never a cached session object — a tab left open
  // for over an hour would otherwise send an expired token and 401.
  const { data: { session: s } } = await window.supabaseClient.auth.getSession();
  const token = s?.access_token;
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
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status}).`);
  return data;
}

async function deleteWord(id) {
  if (!confirm("Delete this word? This can't be undone.")) return;

  const { error } = await supabaseClient.from("custom_vocab").delete().eq("id", id);
  if (error) {
    console.error("Failed to delete custom vocab:", error);
    return;
  }

  // Best-effort cleanup of any star/progress state pointing at the deleted word.
  await supabaseClient
    .from("user_word_state")
    .delete()
    .eq("word_type", "custom")
    .eq("word_key", String(id));

  await loadCustomVocab();
}

/**
 * Puts a failed row back into the queue. Re-uses the level the word was
 * originally generated at (custom_vocab.jlpt_level) rather than the user's
 * current default, so retrying a word doesn't quietly change its difficulty.
 */
async function retryGeneration(row, button) {
  button.disabled = true;
  button.textContent = "Retrying…";

  const { error } = await supabaseClient
    .from("custom_vocab")
    .update({ example_status: "pending", example_error: null })
    .eq("id", row.id);

  if (error) {
    button.disabled = false;
    button.textContent = "↻ Retry";
    console.error("Failed to mark row pending:", error);
    return;
  }

  try {
    await vocabApi("/api/queue-examples", {
      method: "POST",
      body: {
        vocabId: row.id,
        hiragana: row.hiragana,
        kanji: row.kanji || "",
        english: row.english,
        jlptLevel: row.jlpt_level || "N5",
        count: MAX_DISPLAYED_EXAMPLES,
      },
    });
  } catch (e) {
    // Same rule as add-vocab.js: nothing else will ever clear 'pending', so
    // the row has to be put back into a state the user can see and act on.
    await supabaseClient
      .from("custom_vocab")
      .update({ example_status: "failed", example_error: e.message })
      .eq("id", row.id);
  }

  await loadCustomVocab();
}

// Matches add-vocab.js's MAX_EXAMPLES — kept the same on purpose (a saved
// word shouldn't be able to show more examples than the form lets you keep),
// but also enforced here defensively for rows saved before that cap existed.
const MAX_DISPLAYED_EXAMPLES = 3;

/** Every stored example plus a legacy fallback for rows saved before `examples` existed. */
function examplesOf(row) {
  if (Array.isArray(row.examples) && row.examples.length) return row.examples;
  if (row.example_furigana) {
    return [{ furigana: row.example_furigana, translation: row.translation }];
  }
  return [];
}

/**
 * The pending/failed banner that sits above a row's examples, or null when
 * there's nothing outstanding. Rows written before this column existed have
 * no example_status at all, which reads as 'ready' — no backfill needed.
 */
function renderGenerationState(row) {
  if (row.example_status === "pending") {
    const el = document.createElement("div");
    el.className = "gen-state gen-state-pending";
    el.textContent = "⏳ Writing example sentences…";
    return el;
  }

  if (row.example_status === "failed") {
    const el = document.createElement("div");
    el.className = "gen-state gen-state-failed";

    const label = document.createElement("span");
    label.className = "gen-state-label";
    label.textContent = "⚠️ Couldn't write example sentences";
    el.appendChild(label);

    if (row.example_error) {
      const reason = document.createElement("span");
      reason.className = "gen-state-reason";
      reason.textContent = row.example_error;
      el.appendChild(reason);
    }

    const retry = document.createElement("button");
    retry.className = "btn-secondary gen-state-retry";
    retry.textContent = "↻ Retry";
    retry.addEventListener("click", () => retryGeneration(row, retry));
    el.appendChild(retry);

    return el;
  }

  return null;
}

// Every kept example (up to MAX_DISPLAYED_EXAMPLES), each with its own
// translation stacked underneath it — not just the first one. There's a
// separate "More" column (see renderMoreCell) for the short indicative
// phrases that DO mirror the curated pages' single-Example shape; this
// column is deliberately richer, since custom vocab isn't limited to that
// fixed 1-example shape the way the curated CSVs are.
function renderExampleCell(row) {
  const cell = document.createElement("td");
  cell.setAttribute("data-label", "Example");

  const state = renderGenerationState(row);
  if (state) cell.appendChild(state);

  examplesOf(row)
    .slice(0, MAX_DISPLAYED_EXAMPLES)
    .forEach((ex) => {
      const entry = document.createElement("div");
      entry.className = "example-entry";
      entry.appendChild(renderFurigana(ex.furigana || ""));

      if (ex.translation) {
        const translation = document.createElement("span");
        translation.className = "example-translation";
        translation.textContent = ex.translation;
        entry.appendChild(translation);
      }

      cell.appendChild(entry);
    });

  return cell;
}

function renderMoreCell(row) {
  const cell = document.createElement("td");
  cell.setAttribute("data-label", "More");

  const items = Array.isArray(row.more) ? row.more.slice(0, 2) : [];

  items.forEach((ex, i) => {
    if (i > 0) cell.appendChild(document.createElement("br"));

    const entry = document.createElement("span");
    entry.className = "more-entry";
    entry.appendChild(renderFurigana(ex.furigana || ""));

    if (ex.translation) {
      const gloss = document.createElement("span");
      gloss.className = "more-gloss";
      gloss.textContent = ` — ${ex.translation}`;
      entry.appendChild(gloss);
    }

    cell.appendChild(entry);
  });

  return cell;
}

function renderCustomVocabTable(rows) {
  const tableBody = document.querySelector("#customVocabTable tbody");
  tableBody.innerHTML = "";

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.textContent = "You haven't added any custom words yet.";
    tr.appendChild(td);
    tableBody.appendChild(tr);
    return;
  }

  rows.forEach(row => {
    const tr = document.createElement("tr");
    if (row.example_status === "pending") tr.className = "row-pending";
    if (row.example_status === "failed") tr.className = "row-failed";

    const hiraganaCell = document.createElement("td");
    hiraganaCell.setAttribute("data-label", "Hiragana");
    hiraganaCell.textContent = row.hiragana;
    // Pitch accent under the reading, where it belongs — it describes how the
    // reading is said. Renders nothing at all when the word has no pitch data
    // (manually added words, or ones the dictionary didn't know).
    if (Array.isArray(row.pitch) && row.pitch.length) {
      const pitchLine = document.createElement("div");
      pitchLine.className = "pitch-line";
      pitchLine.appendChild(renderPitch(row.pitch));
      hiraganaCell.appendChild(pitchLine);
    }
    tr.appendChild(hiraganaCell);

    const kanjiCell = document.createElement("td");
    kanjiCell.setAttribute("data-label", "Kanji");
    kanjiCell.textContent = row.kanji || "-";
    tr.appendChild(kanjiCell);

    const englishCell = document.createElement("td");
    englishCell.setAttribute("data-label", "English");
    englishCell.textContent = row.english;
    tr.appendChild(englishCell);

    tr.appendChild(renderExampleCell(row));
    tr.appendChild(renderMoreCell(row));

    const actionsCell = document.createElement("td");
    actionsCell.setAttribute("data-label", "Actions");

    const starred = typeof isWordStarred === "function" && isWordStarred("custom", String(row.id));
    const starBtn = document.createElement("button");
    starBtn.className = `star-btn${starred ? " starred" : ""}`;
    starBtn.textContent = starred ? "★" : "☆";
    starBtn.dataset.wordType = "custom";
    starBtn.dataset.wordKey = encodeURIComponent(String(row.id));
    starBtn.addEventListener("click", () => toggleStar(starBtn));
    actionsCell.appendChild(starBtn);

    const editLink = document.createElement("a");
    editLink.className = "play-btn";
    editLink.href = `add-vocab.html?id=${encodeURIComponent(row.id)}`;
    editLink.textContent = "✏️";
    editLink.title = "Edit";
    actionsCell.appendChild(editLink);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "play-btn";
    deleteBtn.textContent = "🗑️";
    deleteBtn.title = "Delete";
    deleteBtn.addEventListener("click", () => deleteWord(row.id));
    actionsCell.appendChild(deleteBtn);

    tr.appendChild(actionsCell);

    tableBody.appendChild(tr);
  });
}

// ---------------------------------------------------------------------------
// Furigana debt
// ---------------------------------------------------------------------------
//
// kuromoji runs in the browser and nowhere else, so the Worker that generates
// sentences in the background can only store PLAIN Japanese — it sets
// needs_furigana and leaves the ruby to whoever loads the row next. That's
// this page: it already loads js/furigana.js, so it can annotate the text and
// write the real bracket syntax back, after which the row is indistinguishable
// from one saved through the form.
//
// Reading a flagged row meanwhile still works — renderFurigana() on plain text
// renders plain text, just without ruby.

// Row ids attempted during this page load, so a row whose write-back fails
// isn't retried on every poll tick for as long as the tab stays open.
const annotationAttempted = new Set();

// One Supabase write per row, so a user who adds twenty words in a sitting
// shouldn't get twenty simultaneous round trips the first time they open this
// page. The rest are picked up on the next load or the next poll tick, which
// costs nothing extra — the tagger is already in memory by then.
const MAX_ANNOTATIONS_PER_PASS = 5;

/**
 * Decides which of the loaded rows to annotate and write back on this pass.
 *
 * Three exclusions, each for a different reason:
 *   - not flagged: the row's furigana is already authoritative bracket syntax.
 *   - still pending: the Worker is about to overwrite `examples` wholesale
 *     (see queue-examples.js successPatch), so annotating now is a lost race —
 *     wasted writes whose result is discarded seconds later.
 *   - already attempted this page load: `upgradeFurigana()` runs again on
 *     every 4-second poll tick, so without this a row whose write keeps
 *     failing (offline, RLS, a bad sentence the tagger throws on) would be
 *     retried indefinitely for as long as the tab stays open.
 */
function rowsNeedingFurigana(rows) {
  return rows
    .filter(
      (row) =>
        row.needs_furigana &&
        row.example_status !== "pending" &&
        !annotationAttempted.has(String(row.id)) &&
        examplesOf(row).length > 0,
    )
    .slice(0, MAX_ANNOTATIONS_PER_PASS);
}

/**
 * Annotates the chosen rows and persists the result. Runs after the table is
 * already on screen: the ruby appearing a beat later is a far better trade
 * than blocking the whole list on a ~12MB dictionary download.
 */
async function upgradeFurigana(rows) {
  const targets = rowsNeedingFurigana(rows);
  if (targets.length === 0) return;

  let tagger;
  try {
    tagger = await getTagger();
  } catch {
    // No dictionary, no annotation. The rows stay flagged and readable, and
    // the next page load on a better connection will pick them up.
    return;
  }

  let changed = false;

  for (const row of targets) {
    annotationAttempted.add(String(row.id));

    // BOTH arrays. The background generator writes example sentences and the
    // short "More" phrases in the same pass, so a row flagged needs_furigana
    // owes ruby on both — annotating only `examples` would leave the More
    // column permanently un-annotated while the flag it depends on gets
    // cleared.
    let annotated;
    let annotatedMore;
    try {
      const annotate = (list) =>
        list.map((ex) => ({
          furigana: annotateWithFurigana(ex.furigana || "", tagger),
          translation: ex.translation || null,
        }));
      annotated = annotate(examplesOf(row));
      annotatedMore = annotate(Array.isArray(row.more) ? row.more : []);
    } catch (e) {
      console.error(`Couldn't annotate custom vocab ${row.id}:`, e);
      continue;
    }

    const { error } = await supabaseClient
      .from("custom_vocab")
      .update({
        examples: annotated,
        more: annotatedMore,
        // Keeps mirroring examples[0], exactly as every other writer does.
        example_furigana: annotated[0]?.furigana || null,
        needs_furigana: false,
      })
      .eq("id", row.id);

    if (error) {
      console.error(`Couldn't save furigana for custom vocab ${row.id}:`, error);
      continue;
    }

    // Update in place so the re-render below shows the ruby without a refetch.
    row.examples = annotated;
    row.more = annotatedMore;
    row.needs_furigana = false;
    changed = true;
  }

  if (changed) renderCustomVocabTable(rows);

  // Drain the rest in further passes of MAX_ANNOTATIONS_PER_PASS. This
  // terminates because every row above joins `annotationAttempted` whether it
  // succeeded or not, so each pass strictly shrinks the candidate set — and
  // the tagger is cached by now, so subsequent passes cost only the writes.
  if (rowsNeedingFurigana(rows).length > 0) await upgradeFurigana(rows);
}

// ---------------------------------------------------------------------------
// Loading + polling
// ---------------------------------------------------------------------------

// A generation takes a few seconds; this is slow enough not to hammer
// Supabase and fast enough that the row fills in while the user is still
// looking at the page.
const PENDING_POLL_MS = 4000;
// Roughly two minutes. A job that hasn't landed by then isn't coming back on
// its own (see queue-examples.js: a failed PATCH leaves the row pending), and
// polling a dead row forever would be a battery drain with no payoff.
const PENDING_POLL_MAX = 30;
let pendingPollCount = 0;

function schedulePendingPoll(rows) {
  clearTimeout(pendingPollTimer);

  const stillPending = rows.some((row) => row.example_status === "pending");
  if (!stillPending) {
    pendingPollCount = 0;
    document.getElementById("generatingNotice").style.display = "none";
    return;
  }

  document.getElementById("generatingNotice").style.display = "";

  if (++pendingPollCount > PENDING_POLL_MAX) return;
  pendingPollTimer = setTimeout(loadCustomVocab, PENDING_POLL_MS);
}

async function loadCustomVocab() {
  if (!customVocabSession) return;

  const { data, error } = await supabaseClient
    .from("custom_vocab")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to load custom vocab:", error);
    return;
  }

  renderCustomVocabTable(data);
  schedulePendingPoll(data);
  upgradeFurigana(data);
}

function setGuestState(isGuest) {
  document.getElementById("guestNotice").style.display = isGuest ? "" : "none";
  document.getElementById("addVocabLink").style.display = isGuest ? "none" : "";
  document.getElementById("customVocabTable").style.display = isGuest ? "none" : "";
  if (isGuest) document.getElementById("generatingNotice").style.display = "none";
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("guestLoginLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("loginLink")?.click();
  });
});

document.addEventListener("auth-state-changed", (e) => {
  customVocabSession = e.detail.session;
  setGuestState(!customVocabSession);
  if (customVocabSession) loadCustomVocab();
});
