// Audio playback (single word + example + sequential play-all) shared by every vocab page.
// Depends on vocabConfig from vocab-page.js and currentVocabData from csv-vocab.js.

let sequentialAudioList = [];
let sequentialIndex = 0;
let isPaused = false;
let isStopped = false;

function playAudio(text, soundDir) {
  const audioPlayer = document.getElementById("audioPlayer");
  const basePath = `${soundDir || vocabConfig.soundDir}/${text}`;

  // Stop and reset any current audio
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
  audioPlayer.src = "";

  // Remove any lingering event listeners
  audioPlayer.onended = null;

  // Step 1: Play Japanese
  audioPlayer.src = `${basePath}.wav`;
  audioPlayer.play()
    .then(() => {
      // Step 2: After Japanese ends, play English
      audioPlayer.onended = () => {
        audioPlayer.onended = null; // Prevent recursion
        setTimeout(() => {
          audioPlayer.src = `${basePath}_eng.mp3`;
          audioPlayer.play()
            .then(() => {
              // Step 3: Clear onended after English
              audioPlayer.onended = () => {
                audioPlayer.onended = null;
              };
            })
            .catch(err => console.error("Error playing English audio:", err));
        }, 300); // 0.3s delay
      };
    })
    .catch(err => {
      console.error("Error playing Japanese audio:", err);
    });
}

function playExampleAudio(text, soundDir) {
  const audioPlayer = document.getElementById("audioPlayer");
  const basePath = `${soundDir || vocabConfig.soundDir}/${text}_ex`;

  audioPlayer.pause();
  audioPlayer.currentTime = 0;
  audioPlayer.src = "";

  audioPlayer.src = `${basePath}.wav`;
  audioPlayer.play().catch(err => {
    console.error("Error playing example audio:", err);
  });
}

function startSequentialPlay() {
  sequentialAudioList = currentVocabData.map(row => (row.Kanji || row.Hiragana)?.trim().replace(/^"|"$/g, '') || "").filter(Boolean);
  isPaused = false;
  isStopped = false;
  sequentialIndex = 0;

  playNextSequential();
}

function playNextSequential() {
  if (isStopped || sequentialIndex >= sequentialAudioList.length) return;
  if (isPaused) return;

  const audioPlayer = document.getElementById("audioPlayer");
  const current = sequentialAudioList[sequentialIndex];
  const basePath = `${vocabConfig.soundDir}/${current}`;

  // Play Japanese audio first
  audioPlayer.src = `${basePath}.wav`;
  audioPlayer.play().then(() => {
    audioPlayer.onended = () => {
      if (isPaused || isStopped) return;

      // Wait 0.3s → play English translation
      setTimeout(() => {
        audioPlayer.src = `${basePath}_eng.mp3`;
        audioPlayer.play().then(() => {
          audioPlayer.onended = () => {
            if (isPaused || isStopped) return;
            sequentialIndex++;
            setTimeout(() => {
              playNextSequential();
            }, 500); // 0.5s after English ends
          };
        }).catch(err => {
          console.error("English audio error:", err);
          // Skip to next
          sequentialIndex++;
          setTimeout(playNextSequential, 500);
        });
      }, 300);
    };
  }).catch(err => {
    console.error("Japanese audio error:", err);
    sequentialIndex++;
    setTimeout(playNextSequential, 500);
  });
}

function stopSequentialPlay() {
  isStopped = true;
  isPaused = false;
  sequentialIndex = 0;
  const audioPlayer = document.getElementById("audioPlayer");
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
  document.getElementById("pauseResumeBtn").textContent = "⏸ Pause";
}

function pauseOrResume() {
  const audioPlayer = document.getElementById("audioPlayer");

  if (!isPaused) {
    isPaused = true;
    audioPlayer.pause();
    document.getElementById("pauseResumeBtn").textContent = "▶ Resume";
  } else {
    isPaused = false;
    audioPlayer.play().then(() => {
      document.getElementById("pauseResumeBtn").textContent = "⏸ Pause";
    }).catch(err => {
      console.error("Resume play error:", err);
    });
  }
}
