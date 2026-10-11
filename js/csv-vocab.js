// CSV loading, pagination, and card rendering shared by every vocab page.
// Depends on vocabConfig from vocab-page.js and buildVocabCard/trustedHtml
// from vocab-cards.js.

let originalVocabData = [];
let currentVocabData = [];
let currentPage = 1;
let rowsPerPage = 20;

function parseFurigana(text) {
  return text.replace(/([^\[\]]+)\[([^\[\]]+)\]/g, (_, kanji, furigana) => {
    // If length matches, split into separate ruby per character
    if (kanji.length === furigana.length) {
      return kanji.split('').map((k, i) => `<ruby>${k}<rt>${furigana[i]}</rt></ruby>`).join('');
    } else {
      // fallback to full word ruby
      return `<ruby>${kanji}<rt>${furigana}</rt></ruby>`;
    }
  });
}

async function loadVocabulary() {
  const response = await fetch(vocabConfig.csv);
  const csvText = await response.text();

  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true
  });

  originalVocabData = parsed.data;
  currentVocabData = [...originalVocabData];

  displayPage(1);
  setupPagination();
}

function setupPagination() {
  const paginationControls = document.getElementById("paginationControls");
  paginationControls.innerHTML = "";
  const pageCount = Math.ceil(currentVocabData.length / rowsPerPage);

  for (let i = 1; i <= pageCount; i++) {
    const btn = document.createElement("button");
    btn.innerText = i;
    btn.onclick = () => displayPage(i);
    if (i === currentPage) {
      btn.style.fontWeight = "bold";
      btn.style.textDecoration = "underline";
    }
    paginationControls.appendChild(btn);
  }
}

function displayPage(page) {
  currentPage = page;
  const list = document.querySelector("#vocabTable .vocab-list");
  list.innerHTML = "";

  const startIndex = (page - 1) * rowsPerPage;
  const endIndex = startIndex + rowsPerPage;
  const paginatedItems = currentVocabData.slice(startIndex, endIndex);

  paginatedItems.forEach(row => {
    const hiragana = row["Hiragana"]?.trim().replace(/^"|"$/g, '') || "";
    const kanji = row["Kanji"]?.trim().replace(/^"|"$/g, '') || "";
    const english = row["English"]?.trim().replace(/^"|"$/g, '') || "";
    const example = row["Example"]?.trim().replace(/^"|"$/g, '') || "";
    const translation = row["Translation"]?.trim().replace(/^"|"$/g, '') || "";
    const more = row["More"]?.trim().replace(/^"|"$/g, '') || "";

    const displayKanji = kanji || hiragana;
    const wordKeyEncoded = encodeURIComponent(displayKanji);

    // Curated CSV content is site-owner-written and already carries <ruby>
    // markup, so it goes through trustedHtml() — exactly as the table cells'
    // innerHTML did before. Never copy this pattern for custom vocab.
    list.appendChild(buildVocabCard({
      key: `${vocabConfig.wordType}::${displayKanji}`,
      hiragana: trustedHtml(hiragana),
      kanji: kanji ? trustedHtml(kanji) : "-",
      kanjiEmpty: !kanji,
      english: trustedHtml(english),
      actions: [
        vocabCardButton("▶", "Play word", () => playAudio(wordKeyEncoded)),
        buildStarButton(vocabConfig.wordType, displayKanji),
      ],
      details: [
        { label: "Example", content: example ? trustedHtml(example) : null },
        { label: "Translation", content: translation ? trustedHtml(translation) : null },
        { label: "More", content: vocabConfig.hasMore && more ? trustedHtml(more) : null },
      ],
      detailActions: example
        ? [vocabCardButton("🎧 Play example", "Play example sentence", () => playExampleAudio(wordKeyEncoded))]
        : [],
    }));
  });
}

function resetTable() {
  currentVocabData = [...originalVocabData];
  displayPage(1);
  setupPagination();
}

function shuffleTable() {
  // Fisher–Yates shuffle
  for (let i = currentVocabData.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [currentVocabData[i], currentVocabData[j]] = [currentVocabData[j], currentVocabData[i]];
  }
  displayPage(1);
  setupPagination();
}
