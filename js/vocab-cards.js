// Collapsible vocab cards, shared by every page that lists words
// (index.html, i-adjectives.html, my-saved-words.html, my-vocab.html).
//
// Each word is one card. Collapsed, it shows only what you need to scan a
// list — hiragana, kanji, English, and the always-useful buttons (▶ play,
// ☆ star). Everything else (examples, translations, More, 🎧, edit/delete)
// sits in a details panel that opens on tap.
//
// Classic script; load it BEFORE any renderer that calls buildVocabCard().
//
// SECURITY: string arguments are always set via textContent. A caller that
// needs markup passes a Node instead — the curated-CSV pages use
// trustedHtml() for their pre-built <ruby>, custom-vocab.js passes the DOM
// fragments renderFurigana() builds. This file never decides on its own that
// a string is safe to parse.

// Open/closed state lives here, keyed by word, NOT on the DOM. Every list on
// the site re-renders wholesale — pagination, shuffle, login, and on My Vocab
// a poll tick every few seconds while sentences are being written — and state
// stored on the elements would snap every card shut each time.
const vocabCardOpenState = new Map(); // key -> bool, overrides the default
let vocabCardsOpenByDefault = false;
let vocabCardIdCounter = 0;

function isVocabCardOpen(key) {
  return vocabCardOpenState.has(key) ? vocabCardOpenState.get(key) : vocabCardsOpenByDefault;
}

/**
 * Wraps site-owner-curated HTML (the CSVs' pre-expanded <ruby>) in a span.
 * Only for curated CSV content — never for anything a user typed.
 */
function trustedHtml(html) {
  const span = document.createElement("span");
  span.innerHTML = html;
  return span;
}

function appendContent(el, content) {
  if (content == null) return;
  if (content instanceof Node) el.appendChild(content);
  else el.textContent = String(content);
}

function setVocabCardOpen(card, open) {
  card.classList.toggle("is-open", open);
  card.querySelector(".vocab-card-details").hidden = !open;
  const toggle = card.querySelector(".vocab-card-toggle");
  toggle.setAttribute("aria-expanded", String(open));
  toggle.title = open ? "Hide details" : "Show examples and more";
}

/**
 * Builds one card.
 *
 *   key       stable id for the word, used to remember open/closed state
 *   hiragana, kanji, english   string (textContent) or Node
 *   kanjiEmpty  true when there's no kanji to show — hidden on phones, where
 *               there's no column header to explain a lone "-"
 *   actions   always-visible buttons (▶, ☆)
 *   badge     optional Node shown beside the English, for state that must not
 *             hide behind a collapsed card (e.g. "generation failed")
 *   details   [{ label, content }] — content null/undefined is skipped
 *   detailActions  buttons at the foot of the details panel (🎧, ✏️, 🗑️)
 *   className  extra classes for the card (row-pending, row-failed)
 */
function buildVocabCard({
  key,
  hiragana,
  kanji,
  english,
  kanjiEmpty = false,
  actions = [],
  badge = null,
  details = [],
  detailActions = [],
  className = "",
}) {
  const card = document.createElement("article");
  card.className = `vocab-card ${className}`.trim();
  card.dataset.cardKey = key;

  const summary = document.createElement("div");
  summary.className = "vocab-card-summary";

  const fields = [
    ["hiragana", hiragana],
    ["kanji", kanji],
    ["english", english],
  ];
  for (const [name, content] of fields) {
    const field = document.createElement("div");
    field.className = `vocab-card-field vocab-card-${name}`;
    appendContent(field, content);
    if (name === "kanji" && kanjiEmpty) field.classList.add("is-empty");
    if (name === "english" && badge) field.appendChild(badge);
    summary.appendChild(field);
  }

  const actionsEl = document.createElement("div");
  actionsEl.className = "vocab-card-actions";
  actions.forEach((a) => actionsEl.appendChild(a));

  const detailsId = `vocab-card-details-${++vocabCardIdCounter}`;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "vocab-card-toggle";
  toggle.setAttribute("aria-controls", detailsId);
  toggle.setAttribute("aria-label", "Toggle details");
  toggle.textContent = "▾";
  actionsEl.appendChild(toggle);
  summary.appendChild(actionsEl);

  card.appendChild(summary);

  const panel = document.createElement("div");
  panel.className = "vocab-card-details";
  panel.id = detailsId;

  const shown = details.filter((d) => d.content != null);
  shown.forEach(({ label, content }) => {
    const row = document.createElement("div");
    row.className = "vocab-detail";

    const labelEl = document.createElement("div");
    labelEl.className = "vocab-detail-label";
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const body = document.createElement("div");
    body.className = "vocab-detail-body";
    appendContent(body, content);
    row.appendChild(body);

    panel.appendChild(row);
  });

  if (shown.length === 0) {
    const none = document.createElement("p");
    none.className = "vocab-detail-none";
    none.textContent = "No examples yet.";
    panel.appendChild(none);
  }

  if (detailActions.length) {
    const foot = document.createElement("div");
    foot.className = "vocab-detail-actions";
    detailActions.forEach((a) => foot.appendChild(a));
    panel.appendChild(foot);
  }

  card.appendChild(panel);

  const flip = () => {
    const open = !card.classList.contains("is-open");
    vocabCardOpenState.set(key, open);
    setVocabCardOpen(card, open);
  };
  toggle.addEventListener("click", flip);
  // The whole summary is the hit target — a 30px chevron is a poor target on
  // a phone. Clicks that land on a real control (▶, ☆, links) are theirs.
  summary.addEventListener("click", (e) => {
    if (e.target.closest("button, a, input, select, textarea")) return;
    // Don't treat selecting text (to copy a word) as a click.
    if (window.getSelection && String(window.getSelection())) return;
    flip();
  });

  setVocabCardOpen(card, isVocabCardOpen(key));
  return card;
}

/** A small button for a card's action row. */
function vocabCardButton(label, title, onClick, className = "play-btn") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  if (title) {
    btn.title = title;
    btn.setAttribute("aria-label", title);
  }
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * The ☆ button, shaped the way toggleStar() (saved-words.js) reads it: it
 * takes the word's identity from data-word-type / data-word-key.
 */
function buildStarButton(wordType, wordKey) {
  const starred = typeof isWordStarred === "function" && isWordStarred(wordType, wordKey);
  const btn = vocabCardButton(starred ? "★" : "☆", "Save word", () => toggleStar(btn),
    `star-btn${starred ? " starred" : ""}`);
  btn.dataset.wordType = wordType;
  btn.dataset.wordKey = encodeURIComponent(wordKey);
  return btn;
}

/** Empty-state message in place of the cards. */
function vocabListMessage(list, text) {
  const p = document.createElement("p");
  p.className = "vocab-list-empty";
  p.textContent = text;
  list.appendChild(p);
}

function updateExpandAllButton() {
  const btn = document.getElementById("expandAllBtn");
  if (btn) btn.textContent = vocabCardsOpenByDefault ? "⊟ Collapse all" : "⊞ Expand all";
}

/**
 * Expand/collapse every card, now and on later renders (next page, shuffle).
 * Per-card choices are forgotten — "collapse all" should mean all.
 */
function toggleAllVocabCards() {
  vocabCardsOpenByDefault = !vocabCardsOpenByDefault;
  vocabCardOpenState.clear();
  document.querySelectorAll(".vocab-card").forEach((card) => setVocabCardOpen(card, vocabCardsOpenByDefault));
  updateExpandAllButton();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("expandAllBtn")?.addEventListener("click", toggleAllVocabCards);
  updateExpandAllButton();
});
