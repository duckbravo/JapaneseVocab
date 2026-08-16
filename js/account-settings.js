// Account Settings: bring-your-own LLM API keys.
//
// Classic (non-module) script, so it uses window.supabaseClient and the
// "auth-state-changed" event rather than importing anything — same pattern as
// custom-vocab.js and saved-words.js.
//
// SECURITY INVARIANTS:
//   1. A plaintext API key travels browser -> server exactly once (POST
//      /api/llm-keys) and NEVER comes back. No endpoint returns one, so this
//      script has no code path that could display one.
//   2. Everything the server sends is rendered with textContent, never
//      innerHTML — same discipline as custom-vocab.js's renderFurigana().
//   3. Key inputs are cleared immediately after every save attempt.

let settingsSession = null;
let providerRegistry = []; // from GET /api/llm-providers
let keyState = { activeProvider: null, providers: {} };
let loadedForUserId = null;

// providerId -> { root, input, msg, pill, hint, saveBtn, recheckBtn, removeBtn, toggleBtn }
const rows = new Map();
// providerId -> true once the user has been warned about a suspect-looking key
// and chosen to proceed anyway.
const overrideFormatWarning = new Set();

// ---------------------------------------------------------------------------
// Server communication
// ---------------------------------------------------------------------------

// Always ask for a fresh token rather than reusing the cached session's
// access_token: getSession() transparently refreshes an expired one. A tab left
// open for over an hour would otherwise start 401ing.
async function getAccessToken() {
  const { data: { session } } = await window.supabaseClient.auth.getSession();
  return session?.access_token || null;
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

  // A 404 with no JSON body means the Pages Functions backend isn't running —
  // most likely the site is being served by Live Server / python -m http.server
  // instead of `npx wrangler pages dev .`.
  if (res.status === 404 && !data.code) {
    throw new Error("The settings API isn't available on this server. Run the site with `npx wrangler pages dev .`.");
  }

  // 422 is a real answer ("the provider rejected your key"), not a transport
  // failure — the caller handles it.
  if (!res.ok && res.status !== 422) {
    throw new Error(data.message || `Request failed (${res.status}).`);
  }
  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// Key sanitising + format checks (client-side, advisory only)
// ---------------------------------------------------------------------------

// KEEP IN SYNC with sanitizeApiKey() in functions/api/_lib/providers.js. This
// copy exists purely so the user SEES the cleaned value in the field before
// saving; the server re-runs its own copy on whatever arrives and that one is
// authoritative.
const ALL_PREFIXES = ["sk-ant-", "sk-", "AIza", "AQ."];

/** Escape regex metacharacters — "AQ." contains a literal dot. */
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

function sanitizeApiKey(raw) {
  if (typeof raw !== "string") return "";

  let s = raw
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();

  s = s.replace(/^(?:Bearer|bearer)\s+/, "");
  s = s.replace(/^(?:x-api-key|x-goog-api-key|authorization|api[_-]?key|key)\s*[:=]\s*/i, "");
  // Trailing "." is stripped (key pasted at the end of a sentence); Google's
  // AQ. keys contain dots internally, which are preserved.
  s = s.replace(/^['"`]+/, "").replace(/['"`,;.\\]+$/, "").trim();

  if (/\s/.test(s)) {
    // Charset allows "." for Google's AQ.… keys.
    const re = new RegExp(`(?:${ALL_PREFIXES.map(escRe).join("|")})[A-Za-z0-9._-]{16,}`, "g");
    const matches = s.match(re);
    if (matches && matches.length) {
      s = matches.reduce((a, b) => (b.length > a.length ? b : a)).replace(/[.,;]+$/, "");
    }
  }

  return s.replace(/^['"`]+|['"`]+$/g, "").trim();
}

// "a Google Gemini" / "an Anthropic Claude" / "an OpenAI" — mirrors
// withArticle() in functions/api/_lib/providers.js.
function withArticle(label) {
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
}

function matchesProvider(p, key) {
  return (
    p.prefixes.some((pre) => key.startsWith(pre)) &&
    !p.excludePrefixes.some((pre) => key.startsWith(pre))
  );
}

// Three outcomes, driven entirely by the registry so there are no duplicated
// provider rules here:
//   wrong-provider — matches a DIFFERENT provider's prefix. Blocked, because
//                    sending a live Anthropic key to Google's endpoint would be
//                    a genuine disclosure to the wrong vendor.
//   suspect        — wrong prefix or length. Warn, but allow: prefix formats
//                    change over time and the server's live check is the real
//                    gate. Blocking on a stale heuristic is worse.
//   ok             — save straight away.
function checkFormat(providerId, key) {
  const p = providerRegistry.find((x) => x.id === providerId);
  if (!p) return { level: "ok" };

  const other = providerRegistry.find((x) => x.id !== providerId && matchesProvider(x, key));
  if (other) {
    return {
      level: "wrong-provider",
      other,
      message: `That looks like ${withArticle(other.label)} key, not ${withArticle(p.label)} one.`,
    };
  }

  if (!matchesProvider(p, key)) {
    return {
      level: "suspect",
      message: `That doesn't look like ${withArticle(p.label)} key. ${p.formatHint}`,
    };
  }
  if (key.length < p.minLength || key.length > p.maxLength) {
    return { level: "suspect", message: `That key looks the wrong length. ${p.formatHint}` };
  }
  return { level: "ok" };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_LABELS = {
  valid: "Working",
  invalid: "Rejected",
  unknown: "Unverified",
  none: "Not set up",
};

function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

function button(label, className, action) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
  b.dataset.action = action;
  return b;
}

function buildRow(p) {
  const root = document.createElement("div");
  root.className = "provider-row";

  const head = document.createElement("div");
  head.className = "provider-row-head";

  const name = document.createElement("strong");
  name.textContent = p.label;

  // Whether a provider costs money is the single most useful thing to know
  // before starting, so it sits next to the name rather than in the docs.
  const pricing = document.createElement("span");
  pricing.className =
    "pricing-pill " + (p.pricingLabel === "Free tier" ? "pricing-free" : "pricing-paid");
  pricing.textContent = p.pricingLabel || "";

  const pill = document.createElement("span");
  pill.className = "status-pill status-none";
  pill.textContent = STATUS_LABELS.none;

  const doc = document.createElement("a");
  doc.className = "provider-row-doc";
  doc.href = `api-key-setup.html#${p.docsAnchor}`;
  doc.textContent = "How to get one";

  head.append(name, pricing, pill, doc);

  const pricingNote = document.createElement("div");
  pricingNote.className = "settings-note";
  pricingNote.textContent = p.pricingNote || "";

  const hint = document.createElement("div");
  hint.className = "key-hint";

  const controls = document.createElement("div");
  controls.className = "provider-row-controls";

  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = `Paste your ${p.label} key`;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", `${p.label} API key`);

  const toggleBtn = button("👁", "btn-secondary", "toggle");
  toggleBtn.setAttribute("aria-label", "Show or hide the key you typed");
  const saveBtn = button("Save", "btn-primary", "save");
  const recheckBtn = button("Re-check", "btn-secondary", "recheck");
  const removeBtn = button("Remove", "btn-danger", "remove");

  controls.append(input, toggleBtn, saveBtn, recheckBtn, removeBtn);

  const msg = document.createElement("div");
  msg.className = "auth-error";

  root.append(head, pricingNote, hint, controls, msg);

  const row = { root, input, msg, pill, hint, saveBtn, recheckBtn, removeBtn, toggleBtn };

  toggleBtn.addEventListener("click", () => {
    input.type = input.type === "password" ? "text" : "password";
  });
  saveBtn.addEventListener("click", () => handleSave(p.id));
  recheckBtn.addEventListener("click", () => handleRecheck(p.id));
  removeBtn.addEventListener("click", () => handleRemove(p.id));

  // Collapse a pasted curl command / quoted key so the user sees exactly what
  // will be sent.
  const clean = () => {
    const cleaned = sanitizeApiKey(input.value);
    if (cleaned !== input.value) input.value = cleaned;
  };
  input.addEventListener("blur", clean);
  input.addEventListener("paste", () => setTimeout(clean, 0));
  input.addEventListener("input", () => {
    overrideFormatWarning.delete(p.id);
    saveBtn.textContent = "Save";
  });

  return row;
}

function renderRow(providerId) {
  const row = rows.get(providerId);
  if (!row) return;

  const record = keyState.providers[providerId];
  const status = record ? (record.status || "unknown") : "none";

  row.pill.className = `status-pill status-${status}`;
  row.pill.textContent = STATUS_LABELS[status] || STATUS_LABELS.unknown;

  if (record) {
    const checked = formatDate(record.lastValidatedAt);
    const detail = record.statusDetail ? ` · ${record.statusDetail}` : "";
    row.hint.textContent =
      `Saved key: ${record.hint || "(hidden)"}` +
      (checked ? ` · last confirmed working ${checked}` : " · not yet confirmed working") +
      detail;
    row.hint.style.display = "";
    row.input.placeholder = "Paste a new key to replace it";
  } else {
    row.hint.textContent = "";
    row.hint.style.display = "none";
  }

  row.recheckBtn.style.display = record ? "" : "none";
  row.removeBtn.style.display = record ? "" : "none";
}

function renderActiveProviderSelect() {
  const select = document.getElementById("activeProviderSelect");
  select.textContent = "";

  const configured = providerRegistry.filter((p) => keyState.providers[p.id]);

  if (!configured.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No provider set up yet";
    select.append(opt);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  for (const p of configured) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    select.append(opt);
  }
  select.value = keyState.activeProvider || configured[0].id;
}

function renderAll() {
  for (const p of providerRegistry) renderRow(p.id);
  renderActiveProviderSelect();
}

function setRowBusy(providerId, busy, message) {
  const row = rows.get(providerId);
  if (!row) return;
  for (const b of [row.saveBtn, row.recheckBtn, row.removeBtn, row.toggleBtn]) {
    b.disabled = busy;
  }
  if (message !== undefined) setRowMessage(providerId, message, "info");
}

function setRowMessage(providerId, text, kind = "error") {
  const row = rows.get(providerId);
  if (!row) return;
  row.msg.textContent = text || "";
  row.msg.classList.toggle("auth-success", kind === "success");
  row.msg.classList.toggle("settings-note", kind === "info");
}

function setPageError(text) {
  const el = document.getElementById("llmKeysError");
  if (el) el.textContent = text || "";
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// Every mutating endpoint returns the full new state, and we render from that
// rather than re-fetching. KV is eventually consistent (a read can lag a write
// by up to a minute), so an immediate re-GET could show the stale blob.
function applyState(data) {
  keyState = { activeProvider: data.activeProvider ?? null, providers: data.providers || {} };
  renderAll();
}

async function handleSave(providerId) {
  const row = rows.get(providerId);
  const p = providerRegistry.find((x) => x.id === providerId);
  if (!row || !p) return;

  const key = sanitizeApiKey(row.input.value);
  row.input.value = key;

  if (!key) {
    setRowMessage(providerId, "Paste a key first.");
    return;
  }

  const verdict = checkFormat(providerId, key);

  if (verdict.level === "wrong-provider") {
    setRowMessage(providerId, verdict.message);
    offerMoveToProvider(providerId, verdict.other, key);
    return; // deliberately never sent — see checkFormat()
  }

  if (verdict.level === "suspect" && !overrideFormatWarning.has(providerId)) {
    overrideFormatWarning.add(providerId);
    setRowMessage(providerId, `${verdict.message} Press "Save anyway" to try it.`);
    row.saveBtn.textContent = "Save anyway";
    return;
  }

  setRowBusy(providerId, true, `Checking this key with ${p.label}…`);
  try {
    const { status, data } = await api("/api/llm-keys", {
      method: "POST",
      body: { provider: providerId, apiKey: key },
    });

    row.input.value = ""; // clear regardless of outcome
    overrideFormatWarning.delete(providerId);
    row.saveBtn.textContent = "Save";

    if (status === 422) {
      setRowMessage(providerId, data.message || "That key was rejected.");
      return;
    }

    applyState(data);
    setRowMessage(
      providerId,
      data.status === "valid"
        ? `Key saved and confirmed working with ${p.label}.`
        : data.message || "Key saved, but it couldn't be verified right now.",
      data.status === "valid" ? "success" : "info",
    );
  } catch (e) {
    row.input.value = "";
    setRowMessage(providerId, e.message);
  } finally {
    setRowBusy(providerId, false);
  }
}

// The pasted key belongs to a different provider. Rather than just refusing,
// hand it over to the right row — the key never leaves the browser here.
function offerMoveToProvider(fromId, otherProvider, key) {
  const fromRow = rows.get(fromId);
  const toRow = rows.get(otherProvider.id);
  if (!fromRow || !toRow) return;

  const move = button(`Save it under ${otherProvider.label} instead`, "btn-secondary", "move");
  move.addEventListener("click", () => {
    toRow.input.value = key;
    fromRow.input.value = "";
    setRowMessage(fromId, "");
    toRow.input.focus();
    toRow.input.scrollIntoView({ block: "nearest" });
  });

  fromRow.msg.append(document.createTextNode(" "), move);
}

async function handleRecheck(providerId) {
  const p = providerRegistry.find((x) => x.id === providerId);
  setRowBusy(providerId, true, `Re-checking with ${p ? p.label : "the provider"}…`);
  try {
    const { data } = await api("/api/llm-keys/validate", {
      method: "POST",
      body: { provider: providerId },
    });
    applyState(data);
    setRowMessage(
      providerId,
      data.status === "valid" ? "Still working." : data.message || "Couldn't verify this key.",
      data.status === "valid" ? "success" : "error",
    );
  } catch (e) {
    setRowMessage(providerId, e.message);
  } finally {
    setRowBusy(providerId, false);
  }
}

async function handleRemove(providerId) {
  const p = providerRegistry.find((x) => x.id === providerId);
  const label = p ? p.label : providerId;
  if (!confirm(`Remove your ${label} key from this site?\n\nThis does not revoke the key at ${label} — do that in their console if it may have been compromised.`)) {
    return;
  }

  setRowBusy(providerId, true, "Removing…");
  try {
    const { data } = await api(`/api/llm-keys?provider=${encodeURIComponent(providerId)}`, {
      method: "DELETE",
    });
    applyState(data);
    setRowMessage(providerId, "Key removed.", "info");
  } catch (e) {
    setRowMessage(providerId, e.message);
  } finally {
    setRowBusy(providerId, false);
  }
}

async function handleActiveProviderChange(value) {
  const select = document.getElementById("activeProviderSelect");
  select.disabled = true;
  try {
    const { data } = await api("/api/llm-keys/active", {
      method: "POST",
      body: { provider: value || null },
    });
    applyState(data);
    setPageError("");
  } catch (e) {
    setPageError(e.message);
  }
  // Re-render rather than just clearing `disabled` — the select is legitimately
  // disabled when no provider is configured, and this puts it back on the value
  // the server actually has if the change failed.
  renderActiveProviderSelect();
}

// ---------------------------------------------------------------------------
// Load + auth wiring
// ---------------------------------------------------------------------------

async function loadSettings() {
  setPageError("");
  try {
    const [providersRes, keysRes] = await Promise.all([
      api("/api/llm-providers"),
      api("/api/llm-keys"),
    ]);

    providerRegistry = providersRes.data.providers || [];

    const list = document.getElementById("providerList");
    list.textContent = "";
    rows.clear();
    for (const p of providerRegistry) {
      const row = buildRow(p);
      rows.set(p.id, row);
      list.append(row.root);
    }

    applyState(keysRes.data);
  } catch (e) {
    setPageError(e.message);
  }
}

function setGuestState(isGuest) {
  document.getElementById("guestNotice").style.display = isGuest ? "" : "none";
  // .settings-section is display:flex, so restore it explicitly.
  document.getElementById("llmKeysSection").style.display = isGuest ? "none" : "flex";
  document.getElementById("vocabPrefsSection").style.display = isGuest ? "none" : "flex";
}

// ---------------------------------------------------------------------------
// Vocab preferences (default JLPT level) — persisted straight to Supabase
// under RLS, same pattern as rows_per_page in js/saved-words.js. No /api/*
// round trip: there's no secret material here, unlike the LLM keys above.
// ---------------------------------------------------------------------------

async function loadVocabPrefs() {
  const { data, error } = await supabaseClient
    .from("user_preferences")
    .select("jlpt_level")
    .eq("user_id", settingsSession.user.id)
    .maybeSingle();

  if (error) {
    console.error("Failed to load vocab preferences:", error);
    return;
  }

  const select = document.getElementById("jlptLevelPref");
  if (data?.jlpt_level) select.value = data.jlpt_level;
}

async function saveJlptLevelPref(value) {
  const msg = document.getElementById("vocabPrefsMsg");
  const { error } = await supabaseClient
    .from("user_preferences")
    .upsert(
      { user_id: settingsSession.user.id, jlpt_level: value, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );

  msg.textContent = error ? "Couldn't save that — try again." : "";
  msg.classList.toggle("auth-success", !error);
  if (error) console.error("Failed to save jlpt_level:", error);
}

document.addEventListener("auth-state-changed", async (e) => {
  settingsSession = e.detail.session;
  setGuestState(!settingsSession);

  const uid = settingsSession?.user?.id || null;
  if (!uid) {
    loadedForUserId = null;
    return;
  }
  // auth-ui.js re-dispatches this on TOKEN_REFRESHED too (roughly hourly).
  // Without this guard the page would silently refetch and flicker.
  if (uid === loadedForUserId) return;

  loadedForUserId = uid;
  await Promise.all([loadSettings(), loadVocabPrefs()]);
});

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("guestLoginLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("loginLink")?.click();
  });
  document.getElementById("activeProviderSelect")?.addEventListener("change", (e) => {
    handleActiveProviderChange(e.target.value);
  });
  document.getElementById("jlptLevelPref")?.addEventListener("change", (e) => {
    saveJlptLevelPref(e.target.value);
  });
});
