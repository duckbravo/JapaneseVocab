// Star/bookmark handling against `user_word_state`, plus `user_preferences`
// persistence. Classic (non-module) script, using `window.supabaseClient`
// bridged from supabase-client.js. Depends on displayPage/currentPage/
// vocabConfig from vocab-page.js/csv-vocab.js when re-rendering after login.

let currentSession = null;
let starredKeys = new Set(); // `${wordType}::${wordKey}`

function starId(wordType, wordKey) {
  return `${wordType}::${wordKey}`;
}

function isWordStarred(wordType, wordKey) {
  return starredKeys.has(starId(wordType, wordKey));
}

async function refreshStarredKeys() {
  starredKeys = new Set();
  if (!currentSession) return;

  const { data, error } = await supabaseClient
    .from("user_word_state")
    .select("word_type, word_key")
    .eq("is_starred", true);

  if (error) {
    console.error("Failed to load starred words:", error);
    return;
  }

  data.forEach(row => starredKeys.add(starId(row.word_type, row.word_key)));
}

async function toggleStar(buttonEl) {
  if (!currentSession) {
    document.getElementById("loginLink")?.click();
    return;
  }

  const wordType = buttonEl.dataset.wordType;
  const wordKey = decodeURIComponent(buttonEl.dataset.wordKey);
  const nowStarred = !isWordStarred(wordType, wordKey);

  const { error } = await supabaseClient
    .from("user_word_state")
    .upsert(
      { user_id: currentSession.user.id, word_type: wordType, word_key: wordKey, is_starred: nowStarred },
      { onConflict: "user_id,word_type,word_key" }
    );

  if (error) {
    console.error("Failed to update star:", error);
    return;
  }

  if (nowStarred) {
    starredKeys.add(starId(wordType, wordKey));
  } else {
    starredKeys.delete(starId(wordType, wordKey));
  }

  buttonEl.textContent = nowStarred ? "★" : "☆";
  buttonEl.classList.toggle("starred", nowStarred);
}

async function loadPreferences() {
  if (!currentSession) return;

  const { data, error } = await supabaseClient
    .from("user_preferences")
    .select("rows_per_page")
    .eq("user_id", currentSession.user.id)
    .maybeSingle();

  if (error) {
    console.error("Failed to load preferences:", error);
    return;
  }

  if (data && typeof displayPage === "function") {
    rowsPerPage = data.rows_per_page;
    const select = document.getElementById("rowsPerPageSelect");
    if (select) select.value = String(rowsPerPage);
    displayPage(1);
    setupPagination();
  }
}

function changeRowsPerPage(value) {
  rowsPerPage = parseInt(value, 10);
  displayPage(1);
  setupPagination();
  if (currentSession) savePreferences();
}

async function savePreferences() {
  const { error } = await supabaseClient
    .from("user_preferences")
    .upsert(
      { user_id: currentSession.user.id, rows_per_page: rowsPerPage, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );

  if (error) {
    console.error("Failed to save preferences:", error);
  }
}

document.addEventListener("auth-state-changed", async (e) => {
  currentSession = e.detail.session;
  await refreshStarredKeys();
  await loadPreferences();
  if (typeof displayPage === "function" && typeof currentPage === "number") {
    displayPage(currentPage);
  }
});
