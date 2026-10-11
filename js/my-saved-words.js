// Populates the "My Saved Words" page: cross-references user_word_state
// (is_starred = true) against the curated CSVs already used by the other
// pages. Custom vocab (word_type = "custom") isn't wired in yet — that
// lands in M5 alongside the custom_vocab CRUD feature.

const SAVED_WORDS_SOURCES = [
  { wordType: "verb", csv: "verb_ready_final.csv", soundDir: "verb_sound" },
  { wordType: "i-adjective", csv: "iadjective_ready_final.csv", soundDir: "iadjective_sound" },
];

function savedWordRowKey(row) {
  const kanji = row["Kanji"]?.trim().replace(/^"|"$/g, "") || "";
  const hiragana = row["Hiragana"]?.trim().replace(/^"|"$/g, "") || "";
  return kanji || hiragana;
}

async function loadStarredCsvRows(starredKeysByType) {
  const results = [];

  for (const source of SAVED_WORDS_SOURCES) {
    const keys = starredKeysByType[source.wordType];
    if (!keys || keys.size === 0) continue;

    const response = await fetch(source.csv);
    const csvText = await response.text();
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });

    parsed.data.forEach(row => {
      const key = savedWordRowKey(row);
      if (keys.has(key)) {
        results.push({ ...row, __wordType: source.wordType, __soundDir: source.soundDir, __wordKey: key });
      }
    });
  }

  return results;
}

function renderSavedWords(rows) {
  const list = document.querySelector("#savedWordsTable .vocab-list");
  list.innerHTML = "";

  if (rows.length === 0) {
    vocabListMessage(list, "No saved words yet — click the ☆ next to any word to save it here.");
    return;
  }

  rows.forEach(row => {
    const hiragana = row["Hiragana"]?.trim().replace(/^"|"$/g, "") || "";
    const kanji = row["Kanji"]?.trim().replace(/^"|"$/g, "") || "";
    const english = row["English"]?.trim().replace(/^"|"$/g, "") || "";
    const example = row["Example"]?.trim().replace(/^"|"$/g, "") || "";
    const translation = row["Translation"]?.trim().replace(/^"|"$/g, "") || "";
    const more = row["More"]?.trim().replace(/^"|"$/g, "") || "";
    const wordKeyEncoded = encodeURIComponent(row.__wordKey);

    // Curated CSV content (trusted, pre-built <ruby>) — see csv-vocab.js.
    list.appendChild(buildVocabCard({
      key: `${row.__wordType}::${row.__wordKey}`,
      hiragana: trustedHtml(hiragana),
      kanji: kanji ? trustedHtml(kanji) : "-",
      kanjiEmpty: !kanji,
      english: trustedHtml(english),
      actions: [
        vocabCardButton("▶", "Play word", () => playAudio(wordKeyEncoded, row.__soundDir)),
      ],
      details: [
        { label: "Example", content: example ? trustedHtml(example) : null },
        { label: "Translation", content: translation ? trustedHtml(translation) : null },
        { label: "More", content: more ? trustedHtml(more) : null },
        { label: "Type", content: row.__wordType },
      ],
      detailActions: example
        ? [vocabCardButton("🎧 Play example", "Play example sentence",
            () => playExampleAudio(wordKeyEncoded, row.__soundDir))]
        : [],
    }));
  });
}

async function loadSavedWordsPage(session) {
  const guestNotice = document.getElementById("guestNotice");
  const table = document.getElementById("savedWordsTable");

  if (!session) {
    guestNotice.style.display = "";
    table.style.display = "none";
    return;
  }

  guestNotice.style.display = "none";
  table.style.display = "";

  const { data, error } = await supabaseClient
    .from("user_word_state")
    .select("word_type, word_key")
    .eq("is_starred", true);

  if (error) {
    console.error("Failed to load saved words:", error);
    return;
  }

  const starredKeysByType = {};
  data.forEach(row => {
    if (!starredKeysByType[row.word_type]) starredKeysByType[row.word_type] = new Set();
    starredKeysByType[row.word_type].add(row.word_key);
  });

  const rows = await loadStarredCsvRows(starredKeysByType);
  renderSavedWords(rows);
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("guestLoginLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("loginLink")?.click();
  });
});

document.addEventListener("auth-state-changed", (e) => {
  loadSavedWordsPage(e.detail.session);
});
