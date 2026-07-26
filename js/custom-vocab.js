// CRUD against custom_vocab, plus safe furigana rendering. Classic script.
// Depends on `supabaseClient` (bridged in supabase-client.js) and
// toggleStar/isWordStarred (from saved-words.js) for consistent starring.
//
// SECURITY NOTE: unlike the curated CSVs (index.html/i-adjectives.html),
// this data is user-submitted, so it must NEVER be rendered via innerHTML.
// renderFurigana() below builds real DOM nodes with textContent/createTextNode
// only, so something like "<script>" typed into a field renders as literal
// text instead of being parsed as markup.

let customVocabSession = null;
let editingId = null;

function buildRuby(base, reading) {
  const ruby = document.createElement("ruby");
  ruby.appendChild(document.createTextNode(base));
  const rt = document.createElement("rt");
  rt.textContent = reading;
  ruby.appendChild(rt);
  return ruby;
}

function renderFurigana(text) {
  const fragment = document.createDocumentFragment();
  const regex = /([^\[\]]+)\[([^\[\]]+)\]/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    const [, kanji, furigana] = match;
    if (kanji.length === furigana.length) {
      for (let i = 0; i < kanji.length; i++) {
        fragment.appendChild(buildRuby(kanji[i], furigana[i]));
      }
    } else {
      fragment.appendChild(buildRuby(kanji, furigana));
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  return fragment;
}

function updateLivePreview() {
  const examplePreview = document.getElementById("examplePreview");
  examplePreview.innerHTML = "";
  examplePreview.appendChild(renderFurigana(document.getElementById("customExample").value));

  const notesPreview = document.getElementById("notesPreview");
  notesPreview.innerHTML = "";
  notesPreview.appendChild(renderFurigana(document.getElementById("customNotes").value));
}

function resetForm() {
  editingId = null;
  document.getElementById("customVocabForm").reset();
  document.getElementById("formTitle").textContent = "Add a word";
  document.getElementById("formSubmitBtn").textContent = "Add";
  document.getElementById("cancelEditBtn").style.display = "none";
  document.getElementById("formError").textContent = "";
  updateLivePreview();
}

function startEdit(row) {
  editingId = row.id;
  document.getElementById("customHiragana").value = row.hiragana || "";
  document.getElementById("customKanji").value = row.kanji || "";
  document.getElementById("customEnglish").value = row.english || "";
  document.getElementById("customExample").value = row.example_furigana || "";
  document.getElementById("customTranslation").value = row.translation || "";
  document.getElementById("customNotes").value = row.notes_furigana || "";
  document.getElementById("formTitle").textContent = "Edit word";
  document.getElementById("formSubmitBtn").textContent = "Save";
  document.getElementById("cancelEditBtn").style.display = "";
  updateLivePreview();
  document.getElementById("customVocabForm").scrollIntoView({ behavior: "smooth" });
}

async function handleFormSubmit(e) {
  e.preventDefault();
  if (!customVocabSession) return;

  const formError = document.getElementById("formError");
  formError.textContent = "";

  const payload = {
    user_id: customVocabSession.user.id,
    hiragana: document.getElementById("customHiragana").value.trim(),
    kanji: document.getElementById("customKanji").value.trim() || null,
    english: document.getElementById("customEnglish").value.trim(),
    example_furigana: document.getElementById("customExample").value.trim() || null,
    translation: document.getElementById("customTranslation").value.trim() || null,
    notes_furigana: document.getElementById("customNotes").value.trim() || null,
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

  resetForm();
  await loadCustomVocab();
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

    const exampleCell = document.createElement("td");
    exampleCell.setAttribute("data-label", "Example");
    exampleCell.appendChild(renderFurigana(row.example_furigana || ""));
    tr.appendChild(exampleCell);

    const translationCell = document.createElement("td");
    translationCell.setAttribute("data-label", "Translation");
    translationCell.textContent = row.translation || "";
    tr.appendChild(translationCell);

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

    const editBtn = document.createElement("button");
    editBtn.className = "play-btn";
    editBtn.textContent = "✏️";
    editBtn.title = "Edit";
    editBtn.addEventListener("click", () => startEdit(row));
    actionsCell.appendChild(editBtn);

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
  document.getElementById("customVocabForm").style.display = isGuest ? "none" : "flex";
  document.getElementById("customVocabTable").style.display = isGuest ? "none" : "";
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("customVocabForm").addEventListener("submit", handleFormSubmit);
  document.getElementById("cancelEditBtn").addEventListener("click", resetForm);
  document.getElementById("customExample").addEventListener("input", updateLivePreview);
  document.getElementById("customNotes").addEventListener("input", updateLivePreview);
  document.getElementById("guestLoginLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("loginLink")?.click();
  });
  updateLivePreview();
});

document.addEventListener("auth-state-changed", (e) => {
  customVocabSession = e.detail.session;
  setGuestState(!customVocabSession);
  if (customVocabSession) loadCustomVocab();
});
