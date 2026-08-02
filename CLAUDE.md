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

- **Run locally**: serve the repo root with any static file server (e.g. VS
  Code "Live Server", or `python -m http.server`). Do **not** open the HTML
  files via `file://` — the CSV loading (`fetch()` in `js/csv-vocab.js`) and
  ES module imports (`js/auth-ui.js`, `js/supabase-client.js`) both require
  `http://`/`https://`.
- **Apply a Supabase migration**: there's no Supabase CLI linked in this
  repo. Paste the contents of the relevant file in `supabase/migrations/`
  into the target project's Supabase SQL Editor and run it. New schema
  changes should be added as new timestamped files in that directory rather
  than editing existing ones, even though nothing currently automates
  applying them.
- No lint/test tooling exists in this repo.

## Architecture

### Multi-page, shared-module pattern
`i-adjectives.html`, `my-saved-words.html`, and `my-vocab.html` are thin HTML
shells: the same sidebar/login-modal markup, `css/site.css`, the same
`<script>` include list (subset varies per page depending on which features
it needs — e.g. `my-vocab.html` skips `csv-vocab.js`/`audio-player.js` since
it only does custom-vocab CRUD), and — for pages with a CSV table —  a small
inline script at the bottom calling
`initVocabPage({ csv, soundDir, hasMore, wordType })` (from
`js/vocab-page.js`) to parameterize the shared logic. When adding a new page
(e.g. a future `na-adjectives.html`), copy **`i-adjectives.html`**, not
`index.html` (see below) — the actual behavior lives in `js/`.

**`index.html` (the Verbs page) is the one exception and is *not* migrated
to this pattern.** It predates the shared-module refactor: inline `<style>`
instead of `css/site.css`, no sidebar/login modal, no `js/*.js` includes,
and a single inline `<script>` block that reimplements CSV loading,
pagination-free table rendering, audio playback, and shuffle/reset from
scratch (duplicating what `js/csv-vocab.js`/`js/audio-player.js` do for
every other page). Treat it as legacy: don't copy it for new pages, and if
you're asked to add a feature (auth, starring, sidebar) to the Verbs page,
that means migrating `index.html` onto `initVocabPage()` first, not
patching its inline script further.

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
- `js/auth-ui.js` — **ES module**. Login/signup modal (email+password and
  Google OAuth), sidebar account section, session restore. On every auth
  change it dispatches a `auth-state-changed` CustomEvent on `document`
  (`detail: { session }`) — this is the bridge classic scripts use to react
  to login state without importing a module. `initAuthUI()` guards every
  element lookup with `?.` since not every page has every optional piece
  (e.g. only pages with the Google button need it present); don't remove
  that guarding — a hard crash here previously broke session restore on any
  page missing one element.
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
- There are **separate dev and prod Supabase projects**. The URL/anon key
  committed in `js/supabase-client.js` point at one of them — check which
  before assuming, since credentials have changed hands mid-project. The
  anon/publishable key is intentionally public and safe to commit; RLS is
  the actual access boundary. Never commit a `service_role` key or any
  future LLM API key — those belong in Supabase Edge Function secrets only.
- The **dev** project currently has email confirmation disabled
  (Authentication → Providers → Email) as a deliberate, temporary
  workaround — free email providers (Gmail/Yahoo/Outlook) can't pass DMARC
  alignment through third-party SMTP without a verified custom domain, which
  blocked realistic signup testing. Prod still requires confirmation. Revisit
  once a domain is available for proper SMTP + domain auth on both.
- Google OAuth requires provider setup in the Supabase dashboard plus a
  Google Cloud OAuth client — not something a code change alone can enable.

### Hosting
Currently GitHub Pages. The intended next host is **Cloudflare Pages** (not
Netlify/Vercel), chosen specifically for its secret/env-var storage for
future server-side features (e.g. an AI chatbot proxy) — keep this in mind
if hosting migration comes up.
