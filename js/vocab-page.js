// Shared config + entry point for every vocab table page (index.html, i-adjectives.html, ...).
// Call initVocabPage({ csv, soundDir, hasMore }) once, at the bottom of each page.

let vocabConfig = {};

function initVocabPage(config) {
  vocabConfig = Object.assign({ hasMore: false }, config);
  loadVocabulary();
}
