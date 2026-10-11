# Function Reference

A per-function summary of every JavaScript file in this repository:
`worker.js`, everything under `js/`, and everything under `functions/`. Each
entry is one sentence describing what the function does. This is a
behavioral index, not a design rationale — for the *why* behind non-obvious
choices, see the comments in the source file itself or `CLAUDE.md`.

For a higher-level tour of the folder structure and what each file's role is
in the system, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## `worker.js`

The Worker entry point — routes `/api/*` requests to the modules under
`functions/api/`, and hands everything else to the static asset server.

- `json(body, status)` — builds a JSON `Response` with no-store headers.
- `handlerName(method)` — maps an HTTP method to its Pages-style handler
  export name (e.g. `GET` → `onRequestGet`).
- `export default.fetch(request, env, ctx)` — the Worker's fetch handler:
  looks up the matching route module in `ROUTES`, builds the Pages-shaped
  request context, and dispatches through `_middleware.js` to the handler.

---

## `js/`

### `js/vocab-page.js`

- `initVocabPage(config)` — stores the page's CSV/audio/column config as
  `vocabConfig` and kicks off loading the vocabulary table; the single entry
  point every curated vocab page calls.

### `js/csv-vocab.js`

- `parseFurigana(text)` — converts bracket furigana text into `<ruby>` HTML.
- `loadVocabulary()` — fetches and parses the page's CSV file (via
  PapaParse) into the in-memory vocab data.
- `setupPagination()` — builds the page-number buttons under the table.
- `displayPage(page)` — renders one page's worth of vocab rows into the
  table.
- `resetTable()` — restores the original (unshuffled) row order and
  re-renders.
- `shuffleTable()` — Fisher–Yates shuffles the current rows and re-renders.

### `js/audio-player.js`

- `playAudio(text, soundDir)` — plays a word's Japanese audio clip followed
  by its English audio clip.
- `playExampleAudio(text, soundDir)` — plays a word's example-sentence audio
  clip.
- `startSequentialPlay()` — builds the "play all" queue and starts stepping
  through it.
- `playNextSequential()` — plays the next item in the sequential-playback
  queue, recursing until the queue is empty.
- `stopSequentialPlay()` — halts sequential playback and resets its state.
- `pauseOrResume()` — toggles pause/resume of whatever is currently playing.

### `js/sidebar-nav.js`

- `toggleSidebar()` — opens or closes the sidebar navigation drawer.
- *(a top-level `DOMContentLoaded` listener also wires up the Adjectives
  dropdown toggle; it isn't a named function.)*

### `js/supabase-client.js`

No functions. Creates the single shared Supabase client instance and
assigns it to `window.supabaseClient` so classic (non-module) scripts can
reach it without an `import`.

### `js/saved-words.js`

- `starId(wordType, wordKey)` — builds the composite key used to track a
  word in the in-memory starred set.
- `isWordStarred(wordType, wordKey)` — checks whether a word is currently
  starred.
- `refreshStarredKeys()` — reloads the signed-in user's starred words from
  `user_word_state`.
- `toggleStar(buttonEl)` — flips a word's starred state and writes the
  change to Supabase.
- `loadPreferences()` — loads the `rows_per_page` preference and re-renders
  the table accordingly.
- `changeRowsPerPage(value)` — updates the rows-per-page setting in memory
  and re-renders, persisting it if the user is logged in.
- `savePreferences()` — writes the `rows_per_page` preference to
  `user_preferences`.

### `js/my-saved-words.js`

- `savedWordRowKey(row)` — derives the dedupe key (kanji, falling back to
  hiragana) for a curated-CSV row.
- `loadStarredCsvRows(starredKeysByType)` — cross-references the user's
  starred keys against both curated CSVs to find the matching rows.
- `renderSavedWords(rows)` — renders the "My Saved Words" table, or an
  empty-state message if there are no rows.
- `loadSavedWordsPage(session)` — loads the signed-in user's starred rows
  and renders them; does nothing if not logged in.

### `js/auth-ui.js`

ES module. Injects the login/signup modal and sidebar account links at
runtime so every page gets identical auth UI without hand-copied markup.

- `injectAccountLinks()` — injects the guest and logged-in sidebar link
  markup into the page's account section.
- `injectAuthModal()` — appends the login/signup modal markup to the page
  body (once).
- `setAccountView(session)` — toggles between the guest and logged-in
  sidebar views and dispatches the `auth-state-changed` event.
- `openAuthModal(mode)` — opens the modal in either login or signup mode.
- `closeAuthModal()` — hides the modal.
- `handleAuthSubmit(e)` — submits the login or signup form via Supabase
  auth.
- `handleLogout()` — signs the current user out.
- `handleGoogleSignIn()` — starts the Google OAuth sign-in flow.
- `initAuthUI()` — wires all of the above to the DOM and subscribes to
  Supabase auth state changes.

### `js/furigana.js`

Classic script. Converts between bracket furigana syntax and rendered
`<ruby>` DOM, and hosts the kuromoji morphological tagger used to generate
that syntax from plain text.

- `isKanji(ch)` — tests whether a single character is a kanji.
- `katakanaToHiragana(text)` — converts katakana characters to hiragana by
  codepoint offset.
- `loadTagger()` — loads the kuromoji script and vendored dictionary on
  first use, caching the resulting promise.
- `getTagger()` — memoized accessor that awaits `loadTagger()` once and
  reuses the result afterward.
- `alignReading(surface, reading)` — splits one tokenized word into
  kanji-only ruby bases (e.g. `食べる`/`たべる` → `食[た]べる`), the core
  okurigana-alignment algorithm.
- `annotateWithFurigana(text, tokenizer)` — tokenizes plain Japanese text
  and emits it with bracket-furigana annotations added.
- `furiganaToPlain(text)` — strips bracket furigana syntax back down to
  plain text.
- `buildRuby(base, reading)` — builds a single `<ruby>` DOM node.
- `furiganaBaseStart(pending)` — finds where a ruby's text base starts when
  parsing bracket syntax left-to-right.
- `renderFurigana(text)` — parses bracket syntax into a safe
  `DocumentFragment`, built with DOM APIs only (the XSS boundary for
  user-submitted custom vocab).
- `setFurigana(el, text)` — replaces an element's contents with rendered
  furigana.
- `renderPitch(pitch)` — renders pitch-accent line notation as a DOM
  fragment.
- `setPitch(el, pitch)` — replaces an element's contents with a rendered
  pitch-accent line.

### `js/custom-vocab.js`

Renders the "My Vocab" page: the user's custom words, their generation
status, starring, and deletion.

- `vocabApi(path, opts)` — authenticated fetch helper against `/api/*`.
- `deleteWord(id)` — deletes a custom vocab row (and its starred state)
  after user confirmation.
- `retryGeneration(row, button)` — re-queues background example generation
  for a row that previously failed.
- `examplesOf(row)` — returns a row's `examples` array, or an empty array.
- `renderGenerationState(row)` — builds the pending/failed status banner for
  a row.
- `renderExampleCell(row)` — builds the Example table cell (status banner
  plus rendered example sentences).
- `renderMoreCell(row)` — builds the "More" usage-phrases table cell.
- `renderCustomVocabTable(rows)` — renders the entire My Vocab table.
- `annotateOnce(text, tagger)` — idempotently annotates plain text with
  furigana, or repairs text with corrupted double-annotation.
- `rowsNeedingFurigana(rows)` — selects which rows are due for a
  client-side furigana upgrade this pass.
- `isCorrupted(row)` — detects the double-annotation furigana damage
  pattern.
- `upgradeFurigana(rows)` — annotates and writes back furigana for rows the
  background Worker left as plain text.
- `schedulePendingPoll(rows)` — schedules a re-check while any row is still
  in `pending` generation status.
- `loadCustomVocab()` — loads the signed-in user's custom vocab rows and
  triggers rendering, polling, and furigana upgrades.
- `setGuestState(isGuest)` — toggles between the guest notice and the vocab
  table.

### `js/account-settings.js`

Drives the bring-your-own LLM API key UI on `account-settings.html`.

- `getAccessToken()` — fetches a fresh Supabase access token.
- `api(path, opts)` — authenticated fetch helper against `/api/*`.
- `sanitizeApiKey(raw)` — cleans up a pasted API key client-side (mirrors
  the server-side copy).
- `withArticle(label)` — grammar helper that prefixes "a" or "an" to a
  label.
- `matchesProvider(p, key)` — checks whether a key's prefix matches a given
  provider.
- `checkFormat(providerId, key)` — classifies a key as well-formed,
  suspect, or clearly the wrong provider.
- `formatDate(iso)` — formats an ISO date string for display.
- `button(label, className, action)` — builds a `<button>` element with a
  click handler.
- `buildRow(p)` — builds one provider's full DOM row (inputs, buttons,
  model picker).
- `renderRow(providerId)` — updates one provider row's display from the
  current `keyState`.
- `handleModelChange(providerId, model)` — persists the chosen model via
  `/api/llm-keys/model`.
- `renderActiveProviderSelect()` — rebuilds the "active provider" dropdown
  options.
- `renderAll()` — re-renders every provider row plus the active-provider
  select.
- `setRowBusy(providerId, busy, message)` — disables a row's controls while
  a request against it is in flight.
- `setRowMessage(providerId, text, kind)` — sets a row's inline status
  message.
- `setPageError(text)` — sets the page-level error banner.
- `applyState(data)` — applies a fresh key-state response from the server
  and re-renders.
- `handleSave(providerId)` — validates a key's format, then submits it to
  `/api/llm-keys`.
- `offerMoveToProvider(fromId, otherProvider, key)` — offers to move a
  misplaced key to the provider row it actually belongs to.
- `handleRecheck(providerId)` — re-validates a stored key via
  `/api/llm-keys/validate`.
- `handleRemove(providerId)` — deletes a stored key via `/api/llm-keys`.
- `handleActiveProviderChange(value)` — sets the active provider via
  `/api/llm-keys/active`.
- `loadSettings()` — loads the provider registry and the user's key state,
  then builds all rows.
- `setGuestState(isGuest)` — toggles between the guest notice and the
  settings form.
- `loadVocabPrefs()` — loads the `jlpt_level`/`kanji_policy` preferences
  into the form.
- `saveVocabPref(column, value)` — upserts one vocab-generation preference
  column.

### `js/add-vocab.js`

The add/edit form on `add-vocab.html`: a three-step wizard for adding a
word (dictionary lookup, example-sentence source, review) that also serves
as a single-page edit layout when opened with `?id=`. The largest client
file in the repo.

- `getAccessToken()` — fetches a fresh Supabase access token.
- `api(path, opts)` — authenticated fetch helper against `/api/*`.
- `wordIsUsable()` — checks whether both the hiragana and English fields are
  filled in.
- `applyEditLayout()` — switches the page into single-page edit mode
  instead of the step wizard.
- `goToStep(step, opts)` — shows one wizard step at a time, gated on
  `wordIsUsable()`.
- `updateProgress()` — updates the wizard's progress-bar highlighting.
- `updateWordDetailsSummary()` — updates the collapsed "Word details"
  summary line.
- `syncMirroredControl(group, fromId)` — copies a setting's value across
  all of its mirrored controls (used for JLPT level and kanji policy).
- `syncJlptControls(fromId)` — mirrors the JLPT level setting and refreshes
  example card levels that follow it.
- `kanjiPolicy()` — reads the current page-wide kanji-density setting
  (`'level'` or `'natural'`).
- `saveKanjiPolicy()` — persists the kanji policy to `user_preferences`.
- `refreshExampleLevels()` — re-points example cards that don't have their
  own override to the new page-wide JLPT level.
- `refreshExampleKanji()` — re-points example cards that don't have their
  own override to the new page-wide kanji policy.
- `refreshExampleOverrides(field, selector, current)` — shared
  implementation behind the two functions above.
- `jlptLevelForExamples()` — reads the Examples section's JLPT level
  control.
- `jlptLevel()` — reads the page-wide JLPT level control.
- `warmUpTagger()` — starts loading the kuromoji dictionary early, on first
  sign of user interest.
- `annotateIfReady(plain)` — annotates text with furigana only if the
  tagger is already loaded (never blocks on loading it).
- `jishoOptionLabel(entry)` — builds a dictionary-result `<option>` label.
- `renderJishoResults()` — populates the dictionary search results
  dropdown.
- `isKanaOnlySense(entry, senseIndex)` — checks whether one dictionary sense
  is tagged "usually written in kana".
- `senseOptionLabel(sense, i)` — builds a meaning/sense `<option>` label.
- `allGlosses(entry)` — joins every sense's glosses into one combined
  string.
- `renderSenseOptions(entry)` — populates the meaning/sense selection
  dropdown.
- `setKanaOnlyHint(reason)` — shows or hides the explanation text for an
  auto-set kana-only checkbox.
- `applyJishoEntry(index)` — applies a chosen dictionary entry's word-level
  fields to the form.
- `applySense(senseIndex)` — applies a chosen meaning (English text, part of
  speech, kana-only default) to the form.
- `setKanaOnly(checked, kanjiValue)` — sets the "usually written in kana"
  checkbox and optionally the kanji field.
- `wordKanji()` — reads the current kanji field value.
- `kanjiUsuallyKana()` — reads the "usually written in kana" checkbox
  state.
- `performJishoSearch()` — runs a dictionary lookup via `/api/jisho`.
- `maybeSuggestDictionaryForm()` — suggests a word's dictionary (base) form
  when the query looks conjugated.
- `refreshExampleFurigana(card, plain, ready)` — updates one example card's
  furigana preview.
- `fetchDictionarySentences(word)` — fetches the corpus sentence pool for a
  word via `/api/sentences`.
- `ensureDictionaryPool()` — fetches the sentence pool once per word and
  reuses it afterward.
- `nextDictionarySentence()` — picks the next unused corpus sentence to
  offer the user.
- `pullDictionarySentences(word)` — auto-fills any empty example slots from
  the corpus pool.
- `dictionaryExampleCount()` — computes how many corpus sentences would
  actually be saved, capped at the maximum example count.
- `replaceWithDictionary(index)` — replaces one example card with the next
  corpus sentence.
- `addFromDictionary()` — appends a new corpus sentence as an additional
  example card.
- `updateDictionaryChoice()` — keeps step 2's "use dictionary sentences"
  option accurate and enabled/disabled correctly.
- `refreshAllExamplePreviews()` — refreshes every example card's furigana
  preview in place.
- `updateExampleCard(index)` — refreshes one example card's inputs and
  preview.
- `setExamplesBusy(busy)` — disables all example-editing controls while a
  request is in flight.
- `renderExamples()` — renders the full list of example cards (inputs,
  per-card controls, actions).
- `asAiExample(ex, level)` — shapes a raw AI-generated result into the
  editor's internal example object format.
- `generateExamples(opts)` — tops up or rewrites the example list via
  `/api/generate-examples`.
- `rewriteAllExamples()` — confirms with the user, then regenerates every
  example sentence in one request.
- `regenerateSingleExample(index)` — replaces one example sentence via a
  per-card AI request.
- `addManualExample()` — adds a blank example card for hand-typed text.
- `refreshAllMorePreviews()` — refreshes every "More" phrase card's
  preview.
- `updateMoreCard(index)` — refreshes one "More" phrase card's inputs and
  preview.
- `setMoreBusy(busy)` — disables all "More"-phrase-editing controls while a
  request is in flight.
- `renderMore()` — renders the "More" phrases card list.
- `generateMorePhrases()` — generates both "More" phrases at once (always
  replaces both).
- `regenerateSingleMorePhrase(index)` — replaces one "More" phrase, keeping
  the other unchanged.
- `addManualMorePhrase()` — adds a blank "More" phrase card for hand-typed
  text.
- `updateNotesPreview()` — re-renders the notes field's furigana preview.
- `loadGenerationPreferences()` — loads the JLPT level and kanji policy
  defaults from `user_preferences`.
- `examplesFromRow(row)` — converts a saved row's `examples` column into
  editor state.
- `moreFromRow(row)` — converts a saved row's `more` column into editor
  state.
- `loadForEdit(id)` — loads an existing custom vocab row into the editor
  (edit mode).
- `annotateForSave(list)` — runs the kuromoji tagger over an example/more
  list to produce storable bracket-furigana text.
- `saveWord(overrides)` — upserts the current form state to `custom_vocab`;
  the single, idempotent save path used by every exit from the wizard.
- `setStep2Busy(busy, message)` — disables step 2's three choice cards
  while a request is in flight.
- `chooseDictionary()` — step 2, choice 1: save the word with corpus
  sentences.
- `chooseBackground()` — step 2, choice 2: save the word now and queue
  background AI generation.
- `chooseReview()` — step 2, choice 3: generate examples now, then proceed
  to the review step.
- `chooseManual()` — step 2 escape hatch: skip generation and write
  examples by hand on step 3.
- `payloadHeadword()` — returns the word text (kanji, or hiragana as
  fallback) used in status messages.
- `handleFormSubmit(e)` — step 3's final save handler.
- `setGuestState(isGuest)` — toggles between the guest notice and the form.

---

## `functions/api/`

### `functions/api/_middleware.js`

- `onRequest(context)` — wraps every `/api/*` request: authenticates it,
  sets no-store/nosniff response headers, and converts `AuthError` or
  unexpected errors into clean JSON error responses.

### `functions/api/_lib/auth.js`

- `class AuthError` — typed error carrying an HTTP status and error code.
- `requireUser(request, env)` — verifies the caller's bearer token by
  calling Supabase's `/auth/v1/user` endpoint (remote verification, not a
  local JWT check) and returns the authenticated user's id and email.

### `functions/api/_lib/http.js`

- `json(body, status)` — JSON response helper with no-store headers.
- `err(status, code, message)` — builds an error-shaped JSON response.
- `class BadRequest` — typed 400 (bad request) error.
- `readJsonBody(request)` — parses a request body as JSON, enforcing a size
  cap.

### `functions/api/_lib/kv.js`

Manages each user's LLM-key blob in Cloudflare KV.

- `emptyBlob()` — returns the default empty blob shape for a user with no
  stored keys.
- `assertKvBinding(env)` — throws a clear error if the `LLM_KEYS` KV
  binding is missing.
- `kvKey(userId)` — builds the KV storage key for a given user.
- `readBlob(env, userId)` — reads a user's key blob, or returns the default
  empty one.
- `writeBlob(env, userId, blob)` — writes a user's key blob, stamping it
  with `updatedAt`.
- `deleteBlob(env, userId)` — deletes a user's entire key blob.
- `toPublic(blob)` — projects a blob to only the fields safe to return to
  the browser (allowlist, never a decrypted key).
- `maskKey(apiKey)` — computes a masked display hint for a key (e.g.
  `AIzaSy…9xQ2`).
- `removeProvider(blob, providerId)` — removes one provider's record from a
  blob and repairs `activeProvider` if it pointed at the removed one.

### `functions/api/_lib/crypto.js`

AES-GCM-256 encryption of stored API keys using the WebCrypto API.

- `b64encode(bytes)` / `b64decode(s)` — base64 encoding/decoding helpers.
- `secretForVersion(env, version)` — resolves the encryption secret for a
  given schema version, supporting future secret rotation.
- `deriveKey(secretB64, userId, providerId, version)` — HKDF-derives a
  per-user, per-provider AES key from the master secret.
- `aad(userId, providerId, version)` — builds the AES-GCM
  additional-authenticated-data string.
- `encryptSecret(env, userId, providerId, plaintext)` — encrypts a
  plaintext API key into a storable cipher record.
- `decryptSecret(env, userId, providerId, record)` — decrypts a stored
  cipher record back to the plaintext key.

### `functions/api/_lib/keys.js`

- `class NoKeyError` — typed "no key configured" error.
- `getProviderKey(env, userId, providerId)` — resolves and decrypts a
  user's stored key for a specific (or their active) provider.
- `getActiveProviderKey(env, userId)` — convenience wrapper for "give me
  whatever provider the user has chosen as active".

### `functions/api/_lib/ratelimit.js`

- `checkRateLimit(env, userId, action)` — a per-user, per-minute/hour KV
  counter used as a best-effort abuse dampener (not a hard security
  control).

### `functions/api/_lib/models.js`

Model-catalogue discovery and fallback ordering for LLM generation calls.

- `preferenceChain(provider, preferred)` — builds the ordered list of
  models to try: the user's preferred model first, then the registry's
  cost/quota-ordered fallback list.
- `knownModels(env, provider, apiKey, waitUntil)` — reads the cached live
  model catalogue from KV, refreshing it in the background if stale.
- `refresh(env, provider, apiKey, cacheKey)` — calls a provider's
  `listModels()` and writes the result into the KV cache.
- `resolveChain(provider, preferred, available)` — intersects the
  preference chain with the models actually available right now.
- `shouldTryNextModel(status)` — decides whether an HTTP failure status
  (e.g. 429 quota, 404 retired model) warrants trying the next model in the
  chain.

### `functions/api/_lib/prompts.js`

- `PROMPTS` (exported object, not a function) — every prompt template used
  for sentence and phrase generation (system prompts, task instructions,
  spelling notes, avoid clauses, amendment sections, etc.).
- `render(template, vars)` — fills `{placeholder}` tokens in a prompt
  template with the given values.

### `functions/api/_lib/examples.js`

The example-sentence generation pipeline: request validation, prompt
construction, the provider call, and result sanitization. Shared by both
the foreground and background generation routes so they can never produce
different sentences for the same word.

- `normalizeRequest(body)` — validates and clamps a raw JSON request body
  into the shape generation needs.
- `normalizeInstruction(value)` — sanitizes the user's free-text "how
  should this change?" note before it reaches a prompt.
- `promptGloss(english)` — extracts the primary sense from a stored gloss
  list, so the model is prompted with one clear meaning rather than all of
  them.
- `buildPrompts(args)` — assembles the system and user prompt for one style
  (sentences or phrases) from the shared templates.
- `buildCombinedPrompts(args)` — assembles the prompt for the single-call
  "generate both sentences and phrases" path.
- `callProvider(env, userId, req, waitUntil)` — resolves the user's active
  key and model chain, calls the provider, and falls back through models on
  quota/retirement errors.
- `runGeneration(env, userId, request, waitUntil)` — generates one style
  (sentences or phrases) end-to-end, including sanitization.
- `runCombinedGeneration(env, userId, request, waitUntil)` — generates both
  sentences and phrases from a single provider call, used when creating a
  new word.
- `logDropped(call, word, request, styleLabel, rejections)` — logs the
  rejection tally when every generated item was discarded.
- `describeRejections(rejections, label, word)` — turns the rejection tally
  into a user-facing error message.
- `sanitizeList(items, word, hiragana, style)` — drops generated items that
  aren't Japanese, don't mention the target word, are too long, or are
  empty.
- `containsTargetWord(japanese, word, hiragana)` — a loose heuristic check
  that a generated sentence plausibly uses the target word, tolerant of
  conjugation and alternate kana/kanji spelling.

### `functions/api/_lib/providers.js`

The LLM provider registry (Gemini, Anthropic, OpenAI) and the shared logic
for validating and calling them.

- `toGeminiSchema(schema)` — strips unsupported fields (e.g.
  `additionalProperties`) for Gemini's JSON schema dialect.
- `logGenerateFailure(providerId, label, res, extra)` — logs full detail
  about a failed generation call server-side.
- `PROVIDERS` (exported object) — per-provider configuration, including
  `validate()`, `generate()`, `listModels()` (Gemini only), and outcome/
  status-mapping logic for each provider's API.
- `publicProviderList()` — projects the registry to the browser-safe fields
  used by `GET /api/llm-providers`.
- `withArticle(label)` — grammar helper that prefixes "a" or "an" to a
  label (server-side copy).
- `getProvider(id)` — looks up one registry entry by its provider id.
- `matchesPrefixes(provider, key)` — checks whether a key's prefix matches
  a given provider.
- `checkKeyShape(provider, key)` — a structural sanity check on a pasted
  key, including a cross-vendor mismatch guard.
- `sanitizeApiKey(raw)` — server-authoritative cleanup of a pasted API key.
- `runValidation(provider, apiKey)` — calls a provider's live liveness
  check and maps the result to a pass/fail verdict.
- `fill(rule, provider, detail)` — fills the `PROVIDER` placeholder into a
  status-map message template.

### `functions/api/_lib/supabase-rest.js`

A minimal PostgREST client used only by the background generation path.

- `bearerToken(request)` — extracts the caller's raw bearer token from the
  request.
- `patchRow(env, token, table, id, patch)` — PATCHes one row as the user,
  forwarding their own bearer token (never a `service_role` key), so RLS
  remains the access boundary.

### `functions/api/llm-providers.js`

- `onRequestGet()` — handles `GET /api/llm-providers`, returning the public
  provider list.

### `functions/api/llm-keys/index.js`

- `onRequestGet({env, data})` — handles `GET /api/llm-keys`, returning the
  caller's current key state.
- `onRequestPost({request, env, data})` — handles `POST /api/llm-keys`,
  validating, encrypting, and storing a new key.
- `onRequestDelete({request, env, data})` — handles `DELETE /api/llm-keys`,
  removing one provider's key or all of the caller's keys.

### `functions/api/llm-keys/active.js`

- `onRequestPost({request, env, data})` — handles
  `POST /api/llm-keys/active`, setting or clearing which provider is
  active.

### `functions/api/llm-keys/model.js`

- `onRequestPost({request, env, data})` — handles
  `POST /api/llm-keys/model`, setting or clearing which model a provider
  should use.

### `functions/api/llm-keys/validate.js`

- `onRequestPost({request, env, data})` — handles
  `POST /api/llm-keys/validate`, re-checking an already-stored key (the
  "Re-check" button).

### `functions/api/jisho.js`

Dictionary lookup, backed primarily by Jotoba with jisho.org retained only
as a fallback.

- `onRequestGet({request, env, data})` — handles `GET /api/jisho?q=`,
  orchestrating the Jotoba-then-jisho lookup.
- `lookupJotoba(q)` — performs a Jotoba word search, with one retry.
- `tryJotoba(q, attempt)` — a single Jotoba search attempt.
- `toJotobaEntry(word)` — maps one Jotoba result to the shared response
  shape.
- `toPitch(pitch)` — projects pitch-accent data to the allowlisted response
  shape.
- `posLabel(pos)` — flattens Jotoba's nested part-of-speech encoding into a
  readable label.
- `miscToTags(misc)` — maps Jotoba's misc-info enum to jisho.org-style tag
  strings, so the client stays source-agnostic.
- `lookupJisho(q)` — the fallback jisho.org search, used only if Jotoba is
  unreachable.
- `toJishoEntry(entry)` — maps one jisho.org result to the shared response
  shape.

### `functions/api/sentences.js`

- `onRequestGet({request, env, data})` — handles `GET /api/sentences?q=`,
  fetching unfiltered real-corpus example sentences for a word from Jotoba.
- `toSentence(s)` — projects one Jotoba sentence result to the allowlisted
  response shape.
- `toRepoFurigana(text)` — converts Jotoba's furigana bracket format into
  this repo's kanji-only-base bracket convention.

### `functions/api/generate-examples.js`

- `onRequestPost({request, env, data, waitUntil})` — handles
  `POST /api/generate-examples`, the foreground AI generation path that
  returns sentences for the user to review before saving.

### `functions/api/queue-examples.js`

Background example generation for an already-saved word: answers `202`
immediately and finishes the work under `ctx.waitUntil()`.

- `onRequestPost({request, env, data, waitUntil})` — handles
  `POST /api/queue-examples`: validates the request, checks the rate limit,
  returns `202`, and starts background generation.
- `safely(env, userId, request, vocabId, waitUntil)` — wraps the background
  generation call so it can never throw unhandled inside `waitUntil()`.
- `generateInBackground(env, token, userId, vocabId, request, waitUntil)` —
  runs generation and writes the result (or failure) into the
  `custom_vocab` row.
- `toStored(items)` — shapes generated items into the row's stored
  `{furigana, translation}` format.
