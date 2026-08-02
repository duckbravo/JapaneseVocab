// CSV loading, pagination, and table rendering shared by every vocab page.
// Depends on vocabConfig from vocab-page.js.

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
  const tableBody = document.querySelector("#vocabTable tbody");
  tableBody.innerHTML = "";

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
    const starred = typeof isWordStarred === "function" && isWordStarred(vocabConfig.wordType, displayKanji);
    const tr = document.createElement("tr");

    tr.innerHTML = `
    <td data-label="Hiragana">${hiragana}</td>
    <td data-label="Kanji">${kanji || "-"}</td>
    <td data-label="English">${english}</td>
    <td data-label="Translation">${translation}</td>
    <td data-label="Play">
      <button class="play-btn" onclick="playAudio('${wordKeyEncoded}')">▶</button>
      <button class="star-btn${starred ? " starred" : ""}" data-word-type="${vocabConfig.wordType}" data-word-key="${wordKeyEncoded}" onclick="toggleStar(this)">${starred ? "★" : "☆"}</button>
    </td>
    <td data-label="Play Example">
        <button class="play-btn" onclick="playExampleAudio('${wordKeyEncoded}')">🎧</button>
    </td>
   `;

    const exampleCell = document.createElement("td");
    exampleCell.setAttribute("data-label", "Example");
    exampleCell.innerHTML = example; // Example already contains ruby tags
    tr.insertBefore(exampleCell, tr.children[3]);

    if (vocabConfig.hasMore) {
      const moreCell = document.createElement("td");
      moreCell.setAttribute("data-label", "More");
      moreCell.innerHTML = more;
      tr.insertBefore(moreCell, tr.children[5]); // Insert after Translation
    }

    tableBody.appendChild(tr);
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
