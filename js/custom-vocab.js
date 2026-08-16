// Renders the "My Vocab" list: custom_vocab rows, starring, and delete.
// Classic script. Depends on window.supabaseClient (bridged in
// supabase-client.js), toggleStar/isWordStarred (saved-words.js), and
// renderFurigana (js/furigana.js, which must load before this file).
//
// Adding/editing a word lives on add-vocab.html now — this page is list-only.
// The ✏️ button below is a plain link to add-vocab.html?id=<row.id>.
//
// SECURITY NOTE: unlike the curated CSVs (index.html/i-adjectives.html), this
// data is user-submitted, so it must NEVER be rendered via innerHTML.
// renderFurigana() builds real DOM nodes with textContent/createTextNode only,
// so something like "<script>" typed into a field renders as literal text
// instead of being parsed as markup.

let customVocabSession = null;

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

// Every kept example (up to MAX_DISPLAYED_EXAMPLES), each with its own
// translation stacked underneath it — not just the first one. There's a
// separate "More" column (see renderMoreCell) for the short indicative
// phrases that DO mirror the curated pages' single-Example shape; this
// column is deliberately richer, since custom vocab isn't limited to that
// fixed 1-example shape the way the curated CSVs are.
function renderExampleCell(row) {
  const cell = document.createElement("td");
  cell.setAttribute("data-label", "Example");

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

    const hiraganaCell = document.createElement("td");
    hiraganaCell.setAttribute("data-label", "Hiragana");
    hiraganaCell.textContent = row.hiragana;
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
}

function setGuestState(isGuest) {
  document.getElementById("guestNotice").style.display = isGuest ? "" : "none";
  document.getElementById("addVocabLink").style.display = isGuest ? "none" : "";
  document.getElementById("customVocabTable").style.display = isGuest ? "none" : "";
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
