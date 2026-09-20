# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A Japanese vocabulary learning site: static HTML/CSS/vanilla JS pages backed
by CSV vocab data and pre-recorded audio, plus Supabase for user accounts
(starred words, custom vocab, preferences). There is deliberately **no build
step** — no bundler, no package.json, no framework. Keep it that way unless
there's a strong reason to change it; the whole architecture (module loading,
script ordering) is built around plain `<script>` tags working correctly
with zero tooling.

## Commands

- **Run locally**: run **`dev.cmd`** on Windows / **`./dev.sh`** on macOS or
  Linux (double-click it, or Ctrl+Shift+B in VS Code, which picks the right
  one per platform). Both wrap
  `npx wrangler dev --port 8788 --live-reload --persist-to <temp dir>`
  (Node 18+, npx only — still no package.json) and open
  `http://localhost:8788`. `--live-reload` restores the auto-refresh-on-save
  behaviour Live Server used to provide. Everything else — Worker name, entry
  point, assets directory, KV binding, compatibility date — comes from
  `wrangler.jsonc`, so no other flags are needed.
  If a page loads forever and never errors, a previous run left an orphaned
  `workerd` bound to the port — it accepts connections but never answers. Run
  **`stop-dev.cmd`** / **`./stop-dev.sh`** to clear it; both dev scripts also
  refuse to start when the port is already taken, rather than failing silently.
  **`--persist-to` is required, not an optimisation.** The assets directory is
  the repo root, so wrangler watches the whole repo — including `.wrangler/`,
  where miniflare continuously writes its own SQLite state. Wrangler reads that
  write as an asset change, reloads, writes more state, and loops forever: 609
  reloads in two minutes, with every request timing out. Moving the state
  outside the watched tree is what breaks the cycle.
  **But not into the temp directory either.** That state holds the simulated
  `LLM_KEYS` namespace, i.e. the user's encrypted API key. It used to live in
  `%TEMP%` / `$TMPDIR`, which Windows Storage Sense, Disk Cleanup, and most
  Unix `/tmp` reboot policies all delete on a schedule — so the key vanished
  and had to be re-entered, a symptom that never appears on the deployed site
  because real Cloudflare KV is never cleaned. It is now
  `%LOCALAPPDATA%\japanesevocab\wrangler-state` /
  `${XDG_STATE_HOME:-~/.local/state}/japanesevocab/wrangler-state`: outside the
  watched tree, and not auto-cleaned. Both dev scripts migrate the old
  directory across on first run.
  If a key still disappears, the store is not the only suspect — the KV entry
  is `llm-keys:<supabase-user-id>`, so signing in locally with a *different*
  account looks identical to a wiped store. Check which account the sidebar
  shows before assuming persistence broke.
  This is the canonical local server because it runs `worker.js` (and the
  `functions/` modules it imports) as well as serving the static files; a plain
  static server (Live Server, `python -m http.server`) still works for the
  CSV pages but every `/api/*` route 404s, so `account-settings.html` can't
  be exercised. Don't run both side by side either — the two ports would
  make the same-origin API cross-origin. Do **not** open the HTML files via
  `file://`: the CSV loading (`fetch()` in `js/csv-vocab.js`) and ES module
  imports (`js/auth-ui.js`, `js/supabase-client.js`) both require
  `http://`/`https://`.
  Local secrets go in `.dev.vars` at the repo root (gitignored; wrangler
  reads it automatically) — see "Server-side" below for the variables.
  `wrangler dev` *does* honour `.assetsignore` (verified: `/.dev.vars`,
  `/worker.js`, `/wrangler.jsonc` and `/functions/...` all 404 locally), which
  the older `wrangler pages dev` did not.
  Local dev binds KV to the namespace in `preview_id`, never the production
  one, so experimenting here cannot touch real users' encrypted keys.
- **Apply a Supabase migration**: there's no Supabase CLI linked in this
  repo. Paste the contents of the relevant file in `supabase/migrations/`
  into the target project's Supabase SQL Editor and run it. New schema
  changes should be added as new timestamped files in that directory rather
  than editing existing ones, even though nothing currently automates
  applying them.
- No lint/test tooling exists in this repo.
- **Line endings**: this repo is developed on Windows with
  `core.autocrlf=true`, so `.gitattributes` pins `*.sh` to `eol=lf` (a CRLF
  shebang makes bash fail with `bad interpreter: /usr/bin/env bash^M` on
  macOS/Linux) and `*.cmd`/`*.bat` to `eol=crlf`. `dev.sh` and `stop-dev.sh`
  are also stored mode `100755` so they stay executable after a clone. Keep
  both if you add more scripts.

## Architecture

### Multi-page, shared-module pattern
`index.html`, `i-adjectives.html`, `my-saved-words.html`, and `my-vocab.html`
are thin HTML shells: the same sidebar markup, `css/site.css`, the same
`<script>` include list (subset varies per page depending on which features
it needs — e.g. `my-vocab.html` skips `csv-vocab.js`/`audio-player.js` since
it only does custom-vocab CRUD), and — for pages with a CSV table —  a small
inline script at the bottom calling
`initVocabPage({ csv, soundDir, hasMore, wordType })` (from
`js/vocab-page.js`) to parameterize the shared logic. When adding a new page
(e.g. a future `na-adjectives.html`), copy **`i-adjectives.html`** as the
template — the actual behavior lives in `js/`.

The login/signup modal **and the sidebar account links** are not part of
that copied markup — they used to be, and hand-copying them into every HTML
file is exactly what let pages drift out of sync (a bad merge once left one
page's modal missing the Google sign-in button that every other page had).
`js/auth-ui.js` injects both at runtime: `injectAuthModal()` appends the
modal to `document.body`, and `injectAccountLinks()` fills the page's
`<li id="accountSection">`. So an HTML page carries only an **empty**
`<li id="accountSection"></li>`, and any page including
`<script type="module" src="js/auth-ui.js">` gets identical auth UI
automatically — including future pages, with zero extra markup. To add or
change an account link (e.g. the ⚙️ Account Settings entry), edit
`injectAccountLinks()` once; never paste modal or account-link markup into
an HTML file again.

Shared modules and their responsibilities:
- `js/vocab-page.js` — holds `vocabConfig` and `initVocabPage()`, the
  per-page config entry point.
- `js/csv-vocab.js` — CSV fetch/parse (PapaParse), pagination, table
  rendering, shuffle/reset. Rendering uses `innerHTML` for the `Example`/
  `More` columns because the CSVs are site-owner-curated and already contain
  trusted `<ruby>` HTML.
- `js/audio-player.js` — single-word and "play all" sequential audio
  playback. `playAudio(text, soundDir)` / `playExampleAudio(text, soundDir)`
  take an optional explicit `soundDir` (used by the cross-source saved-words
  page); otherwise they fall back to `vocabConfig.soundDir`.
- `js/sidebar-nav.js` — sidebar open/close + dropdown toggling.
- `js/supabase-client.js` — **ES module** (`type="module"`). Creates the
  singleton Supabase client and also assigns it to `window.supabaseClient`,
  because classic (non-module) scripts can't `import` it directly.
- `js/auth-ui.js` — **ES module**. Injects the login/signup modal
  (email+password and Google OAuth) via `injectAuthModal()` and the sidebar
  account links via `injectAccountLinks()` — see "Multi-page, shared-module
  pattern" above — plus session restore. On every auth change it dispatches
  an `auth-state-changed` CustomEvent on `document` (`detail: { session }`)
  — this is the bridge classic scripts use to react to login state without
  importing a module. Both `initAuthUI()` and `setAccountView()` guard every
  element lookup, since not every page has every optional sidebar piece;
  don't remove that guarding — a hard crash in `setAccountView()` happens
  *before* the dispatch and would silently break session restore for every
  classic script on the page.
- `js/saved-words.js` — star/bookmark toggling against `user_word_state`,
  plus `rows_per_page` preference persistence. Classic script; listens for
  `auth-state-changed`.
- `js/custom-vocab.js` — CRUD for `custom_vocab`. **Security-critical**:
  user-submitted text is rendered via `renderFurigana()`, which builds real
  DOM nodes (`createElement`/`textContent`) — never `innerHTML` — because
  unlike the curated CSVs, this content isn't trusted. If you touch rendering
  of custom vocab, preserve this distinction.
- `js/my-saved-words.js` — populates the cross-source "My Saved Words" page
  by cross-referencing starred `user_word_state` rows against both curated
  CSVs (custom words aren't included there yet).
- `js/add-vocab.js` — the add/edit form on `add-vocab.html`, structured as a
  **three-step wizard**: (1) find the word + pick its meaning, (2) choose how
  the example sentences get written, (3) review and save. The steps are
  `<section class="wizard-step">` blocks inside one `<form>`, shown one at a
  time by `goToStep()`, which only toggles `hidden` — it never rebuilds markup,
  so an in-flight generation, a half-typed sentence and the tagger's loading
  state all survive navigation between steps. Every exit from step 2 and step 3
  goes through the single `saveWord()` writer, which is **idempotent**: after a
  successful insert it adopts the new id as `editingId`, so a step-2 choice
  that fails *after* saving (a missing AI key) leaves the user free to pick a
  different option without creating a duplicate word.
  **`?id=` (edit) is NOT a wizard** — `applyEditLayout()` adds `.is-editing`,
  reveals steps 1 and 3 together, forces both `<details>` open, and hides the
  progress bar and step navigation. A wizard asks a sequence of questions you
  haven't answered yet; when editing they're all answered, and walking three
  screens to fix one translation was the complaint that produced this. It's a
  layout MODE over the same markup, not a second set of fields — one save path,
  one example renderer, nothing to drift. `goToStep()` returns early while
  editing, so the existing navigation wiring goes inert rather than needing
  removal. Apply it from the URL in `DOMContentLoaded`, not after `loadForEdit()`
  resolves, or the wizard flashes first.
  Step 2 is dropped entirely when editing (it only asks how sentences should
  *first* be written). **Replacing a sentence is a per-card action**, not a bulk
  one — each card carries 📖 Dictionary and 🔄 AI rewrite, because wanting a
  different second example is no reason to discard the first and third. The
  shared toolbar only ever ADDS (`📖 Add from dictionary`, `✨ Top up`,
  `✏️ Add one`).
  `fetchDictionarySentences()` stashes the WHOLE corpus pool in
  `dictionarySentences`; `pullDictionarySentences()` is the separate
  fill-empty-slots-only auto-pull. Keep them apart — the old combined version
  truncated the stash to the free slots, so with the list already full the pool
  came back empty and per-card replacement had nothing to offer.
  `nextDictionarySentence()` prefers a sentence **not already in the list**,
  then falls back to dictionary order via a rotating cursor. Every current
  example counts as used, *including the card being replaced*: excluding it
  makes that card's own sentence the first "unused" candidate, so 📖 silently
  replaces D2 with D2 while an unused D4 sits in the pool.
  `#jlptLevel` (step 2) and `#jlptLevelReview` (step 3) are one setting mirrored
  into two controls — edit mode never shows step 2 and the fast paths never show
  step 3, so neither alone serves every flow.
- `js/account-settings.js` — the bring-your-own-LLM-key UI on
  `account-settings.html`. Classic script; talks to the Worker's `/api/*`
  routes (handlers under `functions/api/`) rather than to Supabase directly.
  See "Server-side" below.

### Script loading order matters
Classic `<script>` tags execute synchronously in document order as the
parser reaches them; `type="module"` scripts (`auth-ui.js`,
`supabase-client.js`) are always deferred until after the document has
parsed, regardless of where their `<script>` tag sits relative to classic
scripts. This is why `saved-words.js`/`custom-vocab.js` can safely reference
`isWordStarred`, `toggleStar`, etc. defined earlier in other classic
scripts, and why `window.supabaseClient` bridging exists at all.

### Vocab data conventions
- CSV columns: `Hiragana, Kanji, English, Example, Translation, [More]` (the
  `More` column only exists in `verb_ready_final.csv`, not
  `iadjective_ready_final.csv` — controlled by the `hasMore` flag passed to
  `initVocabPage`).
- `Example`/`More`/`custom_vocab.example_furigana` fields use bracket syntax
  `食べる[たべる]` for furigana authoring; the curated CSVs have this already
  pre-expanded to raw `<ruby>` HTML, while `custom_vocab` stores the bracket
  syntax and it's expanded client-side by `renderFurigana()`.
- Audio files are pre-recorded and looked up by URL-encoded `Kanji || Hiragana`
  text: `<soundDir>/<key>.wav` (word), `<soundDir>/<key>_eng.mp3` (English),
  `<soundDir>/<key>_ex.wav` (example sentence). This only works for
  site-owner-curated words — custom vocab has no audio and its Play buttons
  are intentionally omitted.

### Supabase
- Schema lives in `supabase/migrations/20260726000000_init_schema.sql`:
  `profiles`, `user_preferences`, `custom_vocab`, `user_word_state` — every
  table is RLS-protected on `auth.uid()`, and `profiles` auto-populates via
  a trigger on `auth.users` insert.
- `user_word_state` unifies starring + lightweight progress for curated
  words (keyed by the same `Kanji || Hiragana` string used for audio
  filenames) and custom words (keyed by `custom_vocab.id`), distinguished
  by `word_type`.
- **`custom_vocab.examples` is the single source of truth for example
  sentences.** It used to be mirrored into `example_furigana` + `translation`,
  which three separate writers each had to remember to keep in sync. Those
  columns were dropped in `20260920070000` after the one row predating the
  array was backfilled. The comment in `20260816000000_ai_vocab.sql` justifying
  the mirror named three readers; two of them were **already wrong** by the
  time it was checked — `my-saved-words.js` never read `custom_vocab` at all
  (its `translation` comes from the curated CSV), and `examplesOf()` had long
  preferred the array. Don't reintroduce a denormalised copy: if a reader wants
  "the first example", read `examples->0`.
- **Schema-level invariants live in triggers, not in callers.**
  `20260920030000` added `set_updated_at()` on `custom_vocab` and
  `user_preferences`, so `updated_at` is right regardless of which client
  wrote the row. Prefer this shape for anything every writer would otherwise
  have to remember.
- **RLS policies must wrap auth calls: `(select auth.uid())`, never bare
  `auth.uid()`.** Bare calls are re-evaluated per candidate row; the
  sub-select is hoisted into a once-per-statement InitPlan. All 15 policies
  were converted in `20260920020000` after Supabase's linter flagged them
  (`0003_auth_rls_initplan`). Write new policies the same way.
- **Currently a single shared Supabase project** (`osckijyshkdlribqmtrk`)
  backs both local dev and the live site — `.dev.vars` and the committed
  `js/supabase-client.js` point at the identical URL/anon key. Separate
  dev/prod projects is the intended eventual state, not the current one, and
  earlier revisions of this file asserted the split as fact without checking
  — don't repeat that; verify against `.dev.vars` and `js/supabase-client.js`
  before assuming either way, since credentials have changed hands
  mid-project before. Practical consequence of the merge: local testing
  (throwaway accounts, deleted rows, hammered `custom_vocab` inserts) writes
  to the exact same data the live site serves — there is currently no
  isolation. This is a deliberate, known tradeoff (confirmed with the user
  2026-08-16), not an oversight to fix unprompted — revisit splitting into a
  real second project once there's real user data worth protecting from
  local experiments. Until then, a schema migration only needs to be pasted
  into the SQL Editor once, since dev and prod are the same database. The
  anon/publishable key is intentionally public and safe to commit; RLS is
  the actual access boundary. Never commit a `service_role` key.
  (This bullet used to say LLM API keys "belong in Supabase Edge Function
  secrets only". That predated the per-user BYO-key feature and is no longer
  how it works — user LLM keys live encrypted in Cloudflare KV and the
  encryption secret lives in Cloudflare env vars. See "Server-side" below.)
- This project currently has email confirmation disabled (Authentication →
  Providers → Email) as a deliberate, temporary workaround — free email
  providers (Gmail/Yahoo/Outlook) can't pass DMARC alignment through
  third-party SMTP without a verified custom domain, which blocked realistic
  signup testing. Because dev and prod are the same project right now, this
  also means **the live site currently accepts unconfirmed signups** —
  relevant before pointing real users at it. Revisit once a domain is
  available for proper SMTP + domain auth, and/or once the project is split.
- Google OAuth requires provider setup in the Supabase dashboard plus a
  Google Cloud OAuth client — not something a code change alone can enable.

### Server-side (Cloudflare Worker)
`worker.js` + `functions/` hold the repo's only server-side code. It exists
because users bring their **own** LLM API key (Gemini / Anthropic / OpenAI) and
a key must never be readable by the browser. Still no build step — these are
plain ESM files that Cloudflare bundles at deploy time.

```
worker.js             THE ENTRY POINT — routes /api/*, hands everything else to env.ASSETS
wrangler.jsonc        name/main/assets/KV binding/compatibility_date
functions/api/
  _middleware.js      auth + no-store for every /api/* request
  _lib/               helpers — http, auth, crypto, kv, providers, keys, ratelimit,
                      examples, prompts, models, supabase-rest
  llm-providers.js    GET  /api/llm-providers
  jisho.js            GET  /api/jisho          — dictionary lookup (Add Vocab)
  generate-examples.js POST /api/generate-examples — AI example sentences (foreground)
  queue-examples.js   POST /api/queue-examples — same, in the background (202 + waitUntil)
  llm-keys/
    index.js          GET | POST | DELETE  /api/llm-keys
    validate.js       POST /api/llm-keys/validate
    active.js         POST /api/llm-keys/active
    model.js          POST /api/llm-keys/model   — pick which model a key uses
```

**jisho.org is unreachable from Cloudflare Workers — do not "fix" the
dictionary lookup by pointing it back there.** Measured 2026-08-16 from a real
colo via `wrangler dev --remote`: every request to jisho.org returns HTTP
**525 "SSL handshake failed"** generated by Cloudflare itself, in ~165ms,
never reaching jisho. Confirmed identical for `https://jisho.org`,
`https://www.jisho.org`, plain `http://`, and with browser User-Agent/Accept
headers. The same URL answers 200 in ~0.4s from an ordinary IP, and
`https://example.com` answers 200 from the same Worker — so it is neither our
egress nor jisho being down. jisho.org (ZoneEdit nameservers, so *not* the
"fetching a Cloudflare zone from a Worker" trap) is blocking Cloudflare's
shared Worker egress IPs at the TLS layer. No `fetch()` option gets around it.
`functions/api/jisho.js` therefore uses **Jotoba** (`jotoba.de`, open-source
and JMdict-backed — the same dictionary data jisho.org serves) as its primary
source, with jisho.org retained only as a fallback in case the block lifts.
The route path and response shape are unchanged, so `js/add-vocab.js` is
source-agnostic; both mappers are allowlist projections, and Jotoba's
`misc: "UsuallyWrittenInKana"` is translated to jisho's exact wording
`"Usually written using kana alone"` because the client keys the kana-only
checkbox off that string.

**Don't filter corpus example sentences by dictionary sense.** It has been
tried and reverted. Jotoba's sentence objects carry no sense link, so the only
lever is matching the sense's English glosses against each sentence's
translation — which filters on English *surface form* and therefore silently
drops every irregular inflection ("I already ate." fails the gloss "to eat")
and every paraphrase. Systematically hiding past-tense examples from a learner
is worse than occasionally showing another sense of the word. `/api/sentences`
returns them unfiltered, and `add-vocab.html` defaults to recording **all** of
a word's meanings so the card matches the sentences attached to it. Real
sense-linked data does exist if this is ever worth doing properly: the Tanaka
Corpus (`examples.utf.gz`, ~9.7MB) annotates each indexed word with its JMdict
sense and conjugated form — `会う[01]{会えない}` — but that means vendoring and
indexing a corpus, not adding a filter.

**Background example generation writes to Supabase from the Worker — as the
user, never with a `service_role` key.** `POST /api/queue-examples` answers
`202` and finishes generating inside `ctx.waitUntil()`, because the whole point
is that the browser navigates away (a `fetch()` dies with its page;
`keepalive: true` preserves the request but discards the response, so the only
place a result can land is the database). `_lib/supabase-rest.js` PATCHes the
row by forwarding the same bearer token the browser sent, so RLS is still the
access boundary — a bug there cannot reach another user's rows because Postgres
refuses, not because the code remembered a filter. Three rules hold this
together:
- **Save the row before requesting generation.** `custom_vocab.example_status`
  goes `pending` at insert time. Worst case is then a saved word with no
  sentences (visible and retryable on My Vocab), not a word that vanished
  because a provider was down.
- **Every exit path writes a terminal status.** A row stuck on `pending`
  forever is the one failure the user can neither see nor act on. Client-side
  failures to even start the job (`no_key`, `rate_limited`) flip the row to
  `failed` from the browser; server-side ones do it from `waitUntil`.
- **The Worker cannot produce furigana.** kuromoji is a ~12MB browser-only
  dictionary, so generated sentences are stored as plain Japanese with
  `needs_furigana = true`. `js/custom-vocab.js` annotates those rows with the
  tagger it already loads and writes the bracket syntax back, then clears the
  flag. Anything editing such a row must **drop** the stored `furigana` first
  (`loadForEdit` does) — `annotateForSave()` skips entries that already carry
  furigana, so keeping it would save un-annotated text as authoritative and
  lose the ruby permanently.

**One provider call per word when CREATING — `runCombinedGeneration()`.** Every
call spends one request of the user's daily quota, and on a free tier that is
the binding constraint, so example sentences and the short "More" phrases come
back from a single structured reply (`COMBINED_SCHEMA`: two top-level lists,
`sentences` and `phrases`). This used to be two calls, which halved how many
words a day were possible for no benefit. Both creation paths use it — the
background route always, and the foreground one via `withPhrases: true` on
`POST /api/generate-examples`.

**Rewriting is deliberately NOT combined.** When the user targets one section,
a combined call would throw away the half they were happy with. So: per-card
📖/🔄 replace one sentence, `#rewriteAllBtn` rewrites all the sentences in one
call (one request instead of three), and the More section regenerates on its
own. Phrase outcomes stay independent of sentence outcomes — `more` is optional,
so no usable phrases must never red-flag a word whose sentences are fine.

**Kanji density in generated text is the user's choice, not a guess.**
`kanjiPolicy` is `'level'` (kanji only where a learner at the chosen JLPT level
would read it, everything above that in kana) or `'natural'` (kanji wherever a
native writer would, however far above the level). It defaults to `'level'` and
applies to sentences, phrases and the combined create call alike. The old
wording — "use kanji where it is natural for that level" — tried to mean both
at once and so meant neither; don't reintroduce a blended phrasing.
`PROMPTS.kanjiPolicy` is deliberately scoped to **"the other words in the
sentence"**, because how the TARGET word is spelled is settled separately by
`spellingNote`/`kanaOnlyNote` and the two would otherwise contradict each other
for a word like 苺 that sits outside the JLPT lists. Each example card also carries its **own** kanji dropdown, overriding the
section for that sentence's 🔄 rewrite — same "undefined means follow the
section" rule as its per-card JLPT level, refreshed by
`refreshExampleOverrides()` and persisted alongside `level` inside `examples[]`
(jsonb, no migration). The control is mirrored
across step 2 and the Examples section by `syncMirroredControl('kanji', …)`,
and stored in `user_preferences.kanji_policy` — set it on
`account-settings.html` next to the default JLPT level, or on Add Vocab, which
**writes it back**.

That write-back is the asymmetry with `jlpt_level`, which Add Vocab reads but
never saves: the level is a genuine per-word override (stored on the row as
`custom_vocab.jlpt_level`, and per example inside `examples[]`), whereas kanji
policy has no per-word storage anywhere, so a change made on Add Vocab would
simply be lost. It started in `localStorage`, which made it per-browser — set
it on the laptop and the phone still generated textbook sentences.

**Regenerating must put the REJECTED text in `avoid`, with `replacing: true`.**
Three separate bugs made rewriting return the same sentences: the per-card
rewrite excluded the very sentence being replaced from `avoid` (so the only one
the model wasn't told to avoid was the one the user rejected); "rewrite all"
cleared `examples` *before* building `avoid`, sending an empty list; and the
wording — "these example sentences already exist for this word" — reads as
background information rather than as a request. `replacing: true` switches the
prompt to `PROMPTS.avoidReplaced`, which states the rejection outright and names
the axes that must vary (situation, surrounding vocabulary, structure);
"write something different" alone gets the same sentence with one particle
changed. Top-ups keep the original wording, because there the listed items
genuinely are being kept.

`sanitizeList(items, word, hiragana, style)` takes a bare array so the combined
reply's two lists can be checked under their own rules — the phrase cap is 30
characters against the sentence cap of 200, which is what stops a model
returning five items of identical shape from passing as both.

**Every LLM prompt lives in `functions/api/_lib/prompts.js` — put new ones
there, not inline.** It's plain data (template strings with `{placeholders}`,
filled by its own `render()`), so wording can be tuned without reading
assembly code. `_lib/examples.js` decides only which pieces apply; the schema
and sanitizer stay there. Both the foreground and background routes assemble
from the same templates, so the "review it yourself" and "trust it" paths can
never drift into producing different sentences for the same word.

Two conventions in that file are load-bearing:
- **Optional clauses are passed in pre-rendered** (`{avoidClause}`,
  `{amendmentSection}`, `{reading}`), which is why there are no conditionals
  in the templates.
- **Constraints are restated AFTER the user's own text** in
  `amendmentSection`, and numbered. That section carries the per-sentence
  "how should this change?" note from the review step — **the only untrusted
  text in any prompt**. Don't move the rules above it: later instructions
  carry more weight. `normalizeInstruction()` flattens control characters and
  newlines, neutralises quotes that could close the quotation it sits in, and
  caps it at 200 characters.

None of that is the security boundary. `sanitizeExamples()` re-checks every
returned sentence independently, so a model that obeys an injection wholesale
still can't store anything — verified: a reply of `"PWNED"` is rejected as
`not_japanese`. Keep the sanitizer as the thing that actually holds.

**`english` is a gloss LIST, not a word — don't size its limits like one.** The
Add Vocab form defaults to recording every sense of an entry, so an ordinary
word serialises long: 屋台 has five senses and 255 characters. It was sharing
the 100-character cap meant for hiragana/kanji, which rejected such words with
*"That field is too long"* — an error about a field the user never typed into.
`MAX_ENGLISH_LENGTH` (600) is now separate, because that cap exists to keep
pathological input out of the sanitizer's regexes and `english` never reaches
them. Conversely the PROMPT gets only the primary sense (`promptGloss()`, first
`"; "` segment): the card should be honest about covering every meaning, but a
model told 屋台 means "cart; festival float; stage prop; framework; house"
scatters its sentences across all five.

**Never discard the kanji for a "usually written in kana" word.** JMdict tags
いちご as usually-kana, and the form used to respond by clearing the kanji field
and storing `kanji = null`. That broke generation outright: the model was told
the word was いちご with no kanji, wrote the perfectly correct 苺が食べたい。,
and `containsTargetWord()` rejected every sentence because the only thing it
had to match on was kana. The tag is a frequency observation, not a claim the
kanji is wrong. `kanji` is now always stored; `custom_vocab.kanji_usually_kana`
records the tag as a **display preference** (hides the Kanji column on My Vocab,
tooltip still names it, untick on the edit form to reveal).

**Ask the model for the spelling you can verify.** `containsTargetWord()` can
only match on what the row holds, so `buildPrompts()` picks between two mutually
exclusive notes:
- kanji on record → `PROMPTS.spellingNote`: either spelling is fine, and the
  checker accepts either.
- no kanji on record → `PROMPTS.kanaOnlyNote`: write the word in kana, don't
  substitute a kanji spelling. Leaving the choice open here is what killed three
  perfect sentences for いちご — the model wrote 苺 and the checker had only the
  kana stem いち to match.

Rows saved before the kanji was kept store `kanji = null` and cannot recover it
from the row alone, so they're stuck on the weaker kana-only path. `loadForEdit`
prefills the dictionary search with `jisho_slug` and shows a hint, making
"Back → Search" the one-click repair that restores the kanji.

**Furigana annotation must be idempotent — `annotateOnce()` in
`js/custom-vocab.js`.** `needs_furigana` is one row-level flag describing two
independently-written arrays (`examples` and `more`), and `queue-examples.js`
sets it whenever *either* is written. When the sentences call fails but the
phrases call succeeds, `examples` still holds the correctly-annotated
dictionary sentences — annotating them again produced
`苺[いちご][いちご]が食[しょく][た]べたい。` on screen (kuromoji re-read the
orphaned 食 as しょく). So: plain text gets annotated; text already carrying
brackets is left alone (dictionary readings are authoritative and must not be
re-derived); text matching `/\]\[/` — a signature correct syntax never produces
— is stripped back with `furiganaToPlain()` and re-annotated, which also
repairs rows already damaged. `rowsNeedingFurigana()` picks up corrupted rows
by that signature, since the write that corrupted them also cleared their flag.

**`containsTargetWord()` is a "did the model ignore us entirely" guard, not a
grammar check — keep it loose.** It has been too strict twice, and both times
the symptom was the same unhelpful error, *"…returned no usable examples"*,
on output that was actually fine. Requiring the dictionary form as a literal
substring rejected every conjugation; requiring *every* kanji of the word then
rejected every sentence where the model spelled the word in kana (たべます for
食べる, きれい for 綺麗, できます for 出来る) or only partly in kanji
(もって行きます for 持って行く) — four of six realistic cases in testing. It now
accepts the kana reading's stem **or** any one kanji from the word. A
too-permissive filter costs one odd example the user can regenerate in a tap;
a too-strict one takes down the whole request. When this error is reported,
read the `rejections=` tally in the Worker log before changing anything — it
names which of the filters fired and how often.

**Never pair `cf: { cacheTtl }` with `cacheEverything` on a third-party
fetch.** That combination caches *error* responses for the full TTL too, so a
single transient 502 becomes a day of failures for that query at that colo.
Use `cacheTtlByStatus: { '200-299': N, '300-599': 0 }`, which replaces both.

**This site is a Worker with static assets, NOT a Pages project.** That
distinction is load-bearing and easy to get wrong, because the `functions/`
layout and the `onRequest<Method>` export names are *Pages* conventions. A
Worker has a single entry point and would never compile that directory on its
own. `worker.js` reproduces the small part of the Pages contract the handlers
rely on: a path→module table, `onRequest<Method>` dispatch, the
`{ request, env, data, next, waitUntil }` context, and `_middleware` wrapping
every `/api/*` request. The handlers stay in Pages shape deliberately — they
remain portable, and helper modules under `_lib/` are still inert because
nothing imports them as routes.

- **Adding an endpoint = new file under `functions/api/` + one line in `ROUTES`
  in `worker.js`.** Unlike Pages, that table is hand-maintained; forget the line
  and the route 404s immediately.
- Symptom to recognise: if the dashboard says *"Variables cannot be added to a
  Worker that only has static assets"*, the deployed version has no `main` —
  i.e. `wrangler.jsonc`/`worker.js` didn't reach the deploy.
- **Auth**: the browser sends its Supabase access token as
  `Authorization: Bearer …`; `_lib/auth.js` verifies it by calling
  `GET {SUPABASE_URL}/auth/v1/user`, not by checking the JWT signature
  locally. Remote verification sees sign-out/ban/deletion immediately, which
  matters for endpoints gating the user's paid API keys. Never fail open.
- Client-side, always get the token via
  `supabaseClient.auth.getSession()` (which refreshes it), never from the
  cached `auth-state-changed` session — a tab open for over an hour would
  otherwise 401. Conversely, `auth-ui.js` re-dispatches on `TOKEN_REFRESHED`,
  so page loaders must guard on `user.id` to avoid refetching hourly.

**Model choice here is a QUOTA decision, not a capability one.** Writing three
short Japanese sentences against a fixed JSON schema does not distinguish
frontier models from small ones, so the registry defaults to the cheapest
model with the largest allowance on each provider — `gemini-3.5-flash-lite`,
`claude-haiku-4-5-20251001`, `gpt-4.1-mini`. This matters most on Google's free
tier: as of 2026-09 free-tier Flash is reported at ~20 requests/day (cut from
250) while Flash-Lite is ~500, and a backgrounded word costs TWO calls, so the
previous `gemini-3.5-flash` default ran out after about ten words a day.

**Google no longer publishes per-model free-tier limits.**
`https://ai.google.dev/gemini-api/docs/rate-limits` now says limits "can be
viewed in Google AI Studio" and links `https://aistudio.google.com/rate-limit`.
The numbers above come from the developer forum, not documentation — treat them
as indicative, check your own AI Studio dashboard for the real figures, and
don't "correct" the code from memory of an older docs table.

`functions/api/_lib/models.js` keeps that decision from going stale:
- Each registry entry carries `models: [{id, label, note}]` — a **preference
  order**, cheapest/highest-quota first — plus an optional `listModels()`.
- On a **429 (quota) or 404 (model retired)** the generation walks to the next
  model in the chain. Any other status fails immediately, since a bad key or a
  provider outage will fail identically on every model.
- The provider's live catalogue is cached in KV under `models:<providerId>` and
  refreshed opportunistically when older than 24h — traffic-driven, not a Cron
  Trigger, because discovery needs an API key and keys are per-user and
  encrypted, so a scheduled job has no credentials to check with. A stale cache
  is served immediately and refreshed under `waitUntil`.
- `knownModels()` returns **null**, never `[]`, when discovery fails — null
  means "no opinion" and leaves the chain unfiltered. An empty array would be
  indistinguishable from "the provider offers nothing" and would take
  generation down on a transient listing error.
- Users can override the model per provider (`POST /api/llm-keys/model`, stored
  as `model` on the KV record). The server re-checks the id against the registry
  because it gets interpolated into a provider URL.

**Two hard conventions:**
1. **The registry rule.** Adding an LLM provider = one object literal in
   `functions/api/_lib/providers.js` plus one `<h2 id="…">` section in
   `api-key-setup.html` matching its `docsAnchor`. Format hints, live
   validation calls, model chains, and error messages all derive from that
   entry. If you're writing `if (provider === 'gemini')` anywhere else, that's
   a bug.
2. **The plaintext invariant.** No endpoint returns a decrypted key.
   `_lib/kv.js` `toPublic()` builds every response body from an **allowlist**
   (never by deleting `cipher` from a spread), and `decryptSecret()` has
   exactly two call sites: `llm-keys/validate.js` and `_lib/keys.js` (the seam
   for the future generation endpoint). Preserve both when extending this.

**Bindings live in `wrangler.jsonc`, not the dashboard.** The `LLM_KEYS` KV
binding is declared as code, so it is version-controlled, applied on every
deploy, and impossible to forget after a redeploy. Editing bindings in the
dashboard on a config-managed Worker is the wrong move — the next deploy
overwrites it.

**Order matters: deploy the Worker BEFORE trying to configure secrets.** On a
Worker whose latest deployment contains only static files, the dashboard
refuses variables outright — *"Variables cannot be added to a Worker that only
has static assets"* — because there is no server-side code to attach them to.
So: deploy `worker.js` + `wrangler.jsonc` first, then add the three secrets,
then redeploy so they reach a running version.

Only the **secrets** are set by hand (they must never be committed). Either
`npx wrangler secret put <NAME>` from the repo root, or the dashboard at
**Settings → Variables and Secrets → Add**, with the **Encrypt** checkbox to
make a value a secret. (Dashboard paths verified Aug 2026 — Cloudflare renames
these periodically, so trust deployed behaviour over these labels.)

What to set:
- `KEY_ENCRYPTION_SECRET` — 32 random bytes, base64
  (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`),
  stored **encrypted**. Use a value distinct from the local `.dev.vars` one.
  It lives only in Cloudflare and in that gitignored file; never in `js/`,
  never committed. Losing it makes every stored user key permanently
  undecryptable — there is no recovery path by design.
- `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` — must match whichever Supabase
  project the browser authenticates against, or every request 401s in a way
  that looks like a session bug rather than a config one.

Diagnosing a deployment, in order:
- `GET /api/llm-keys` with **no** Authorization header → `404` means the Worker
  didn't deploy (no `main`, so it's static-assets-only again); `401` means the
  Worker is live and running this code. Note `requireUser()` checks for a
  missing token *before* it checks env vars, so this request can never return
  `503` — it says nothing about whether the secrets are set.
- To test config, send a junk token (`Authorization: Bearer x`). Then
  `503 server_misconfigured` = a Supabase var is missing, while
  `401` *"Your session expired"* = the vars are good and Supabase actually
  rejected the token. The two 401 messages are the tell: *"Please log in
  again"* is the no-token path, *"Your session expired"* is the verified path.
- A `500` once genuinely authenticated means the `LLM_KEYS` binding didn't
  reach the running version.

**Known debt**: deleting a Supabase account leaves an orphaned encrypted KV
entry — nothing cleans it up. `DELETE /api/llm-keys?all=1` exists as the hook
a future account-deletion flow should call, and every blob stores `updatedAt`
so a Cron Trigger could sweep. Rate limiting (`_lib/ratelimit.js`) is
deliberately best-effort dampening, not a security control — KV is eventually
consistent and drops increments under burst.

### Hosting
Live on Cloudflare as a **Worker with static assets** named `japanesevocab`
(dash → Workers → `japanesevocab`), git-connected to the `main` branch.
GitHub Pages has been disabled; Cloudflare is the only deployment target.

It is **not** a Pages project — `wrangler pages project list` returns empty for
this account. Earlier notes in this file said "Cloudflare Pages"; that was
wrong, and it cost real debugging time (the `functions/` directory would never
have been compiled). Cloudflare's own guidance is to use Workers for anything
mixing static content with dynamic logic, and that all new investment goes to
Workers, so there is no reason to migrate back.

- **`.assetsignore`** (repo root, gitignore syntax) excludes non-site paths
  from being uploaded as deployable assets: `.git`, `.github`, `.claude`,
  `supabase`, `README.md`, `CLAUDE.md`, `.mcp.json`, `.dev.vars`, the dev
  scripts, and — importantly — `worker.js`, `wrangler.jsonc` and `functions`,
  which are **server source, not assets**. Excluding them does not stop them
  being compiled: only the asset manifest is filtered, while the bundler
  follows `main` and its imports. Verified locally — all of those paths 404
  while `/api/*` works.
  This file is required, not optional: without it the build fails outright
  (`.git`'s pack files exceed the Workers 25 MiB per-asset limit). Any new
  top-level dir/file that isn't part of the served site belongs here too.
- Per-asset size is capped at **25 MiB** — relevant if large audio/CSV
  files are ever added under a served directory.
- Non-`main` branches produce **preview versions of the same Worker**, which
  share its bindings and secrets — so a branch deploy writes to the
  *production* KV namespace. There is no free preview/production isolation the
  way Pages had. Use local dev (which binds `preview_id`) for anything
  experimental.
- Workers Builds runs a different command per branch: `wrangler deploy` on
  `main` (releases to production) and `wrangler versions upload` on other
  branches (uploads a version without releasing it). So a **failed branch build
  cannot affect the live site** — worth remembering before panicking at a red
  build. Note also that `wrangler deploy` from your machine uploads local files
  directly, bypassing git entirely; the deployed code then matches no commit
  until you push. Prefer pushing to `main` for routine changes.
- `npx wrangler versions upload --dry-run` locally runs the same validation the
  branch build does, which is the fastest way to tell a real config error from
  a stale build.
