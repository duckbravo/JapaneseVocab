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
  `npx wrangler pages dev . --kv LLM_KEYS --compatibility-date=2026-08-08 --live-reload`
  (Node 18+, npx only — still no package.json) and open
  `http://localhost:8788`. `--live-reload` restores the auto-refresh-on-save
  behaviour Live Server used to provide.
  If a page loads forever and never errors, a previous run left an orphaned
  `workerd` bound to the port — it accepts connections but never answers. Run
  **`stop-dev.cmd`** / **`./stop-dev.sh`** to clear it; both dev scripts also
  refuse to start when the port is already taken, rather than failing silently.
  The explicit `--compatibility-date` is **required**:
  with no wrangler config file, wrangler defaults it to *today*, and if that's
  newer than the bundled `workerd` binary supports the runtime refuses to
  start ("This Worker requires compatibility date X, but the newest date
  supported by this server binary is Y"). Bump the date when you upgrade
  wrangler. This is
  now the canonical local server because it runs the Cloudflare Pages
  Functions in `functions/` as well as serving the static files; a plain
  static server (Live Server, `python -m http.server`) still works for the
  CSV pages but every `/api/*` route 404s, so `account-settings.html` can't
  be exercised. Don't run both side by side either — the two ports would
  make the same-origin API cross-origin. Do **not** open the HTML files via
  `file://`: the CSV loading (`fetch()` in `js/csv-vocab.js`) and ES module
  imports (`js/auth-ui.js`, `js/supabase-client.js`) both require
  `http://`/`https://`.
  Local secrets go in `.dev.vars` at the repo root (gitignored; wrangler
  reads it automatically) — see "Server-side" below for the variables. Note
  `wrangler pages dev` serves the directory as-is and does **not** honour
  `.assetsignore`, so `.dev.vars` really is fetchable at
  `localhost:8788/.dev.vars` while the dev server runs. That's local-only
  (it's gitignored, so it never reaches a deploy), but don't expose the dev
  server beyond localhost.
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
- `js/account-settings.js` — the bring-your-own-LLM-key UI on
  `account-settings.html`. Classic script; talks to the Pages Functions in
  `functions/api/` rather than to Supabase directly. See "Server-side" below.

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
  the actual access boundary. Never commit a `service_role` key.
  (This bullet used to say LLM API keys "belong in Supabase Edge Function
  secrets only". That predated the per-user BYO-key feature and is no longer
  how it works — user LLM keys live encrypted in Cloudflare KV and the
  encryption secret lives in Cloudflare env vars. See "Server-side" below.)
- The **dev** project currently has email confirmation disabled
  (Authentication → Providers → Email) as a deliberate, temporary
  workaround — free email providers (Gmail/Yahoo/Outlook) can't pass DMARC
  alignment through third-party SMTP without a verified custom domain, which
  blocked realistic signup testing. Prod still requires confirmation. Revisit
  once a domain is available for proper SMTP + domain auth on both.
- Google OAuth requires provider setup in the Supabase dashboard plus a
  Google Cloud OAuth client — not something a code change alone can enable.

### Server-side (Cloudflare Pages Functions)
`functions/` holds the repo's only server-side code. It exists because users
bring their **own** LLM API key (Gemini / Anthropic / OpenAI) and a key must
never be readable by the browser. Still no build step — Pages Functions are
plain ESM files that Cloudflare bundles at deploy time.

```
functions/api/
  _middleware.js      auth + no-store for every /api/* request
  _lib/               helpers — http, auth, crypto, kv, providers, keys, ratelimit
  llm-providers.js    GET  /api/llm-providers
  llm-keys/
    index.js          GET | POST | DELETE  /api/llm-keys
    validate.js       POST /api/llm-keys/validate
    active.js         POST /api/llm-keys/active
```

- **Only files exporting `onRequest[Method]` become routes.** That's why
  `_lib/*.js` helper modules are safe to put under `functions/` — they export
  plain functions, so the file-path router emits nothing for them.
  `_middleware` is the one specially-cased filename.
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

**Two hard conventions:**
1. **The registry rule.** Adding an LLM provider = one object literal in
   `functions/api/_lib/providers.js` plus one `<h2 id="…">` section in
   `api-key-setup.html` matching its `docsAnchor`. Format hints, live
   validation calls, and error messages all derive from that entry. If you're
   writing `if (provider === 'gemini')` anywhere else, that's a bug.
2. **The plaintext invariant.** No endpoint returns a decrypted key.
   `_lib/kv.js` `toPublic()` builds every response body from an **allowlist**
   (never by deleting `cipher` from a spread), and `decryptSecret()` has
   exactly two call sites: `llm-keys/validate.js` and `_lib/keys.js` (the seam
   for the future generation endpoint). Preserve both when extending this.

**Secrets and bindings** — set by hand in the Cloudflare dashboard, per
environment (Production *and* Preview), then **redeploy**: binding and
env-var changes do not apply to existing deployments, and that is by far the
most common cause of `LLM_KEYS is undefined`.

**Order matters: deploy the Functions BEFORE trying to configure them.** On a
project whose latest deployment contains only static files, the dashboard
refuses variables outright — *"Variables cannot be added to a Worker that only
has static assets"* — and bindings silently do nothing, because there is no
server-side code to attach them to. So: push `functions/` first, confirm the
build compiled it, then add the binding and variables, then redeploy.

Dashboard paths (verified Aug 2026 — Cloudflare renames these periodically,
so trust the deployed behaviour over these labels):
- Namespaces: **Storage & Databases → KV → Create namespace**
- Bindings: project → **Settings → Bindings → Add → KV namespace**
- Variables/secrets: project → **Settings → Variables and Secrets → Add**,
  with an **Encrypt** checkbox in the dialog to make a value a secret.
- `wrangler pages secret put` exists but takes only `--project-name` — no
  environment flag — so it can't set Preview, and it can't create bindings
  at all. The dashboard is the only route for both.

What to set:
- KV binding `LLM_KEYS` → a KV namespace (use a separate one for Preview so
  branch experiments can't corrupt real users' keys).
- `KEY_ENCRYPTION_SECRET` — `openssl rand -base64 32`, stored **encrypted**.
  Use a *different* value for Preview than Production: a preview leak must
  not decrypt production data. It lives only in the CF dashboard and in a
  local gitignored `.dev.vars`; never in `js/`, never committed.
- `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` — plain text, pointed at the
  prod project for Production and the dev project for Preview. These must
  match whichever project the browser authenticates against, or every request
  401s.

Diagnosing a misconfigured environment from the response to an unauthenticated
`GET /api/llm-keys`: `401 unauthenticated` = Supabase vars are good;
`503 server_misconfigured` = a Supabase var is missing; `404` = Functions
didn't deploy. A `500` once authenticated means the `LLM_KEYS` binding is
missing or the deploy predates it.

**Known debt**: deleting a Supabase account leaves an orphaned encrypted KV
entry — nothing cleans it up. `DELETE /api/llm-keys?all=1` exists as the hook
a future account-deletion flow should call, and every blob stores `updatedAt`
so a Cron Trigger could sweep. Rate limiting (`_lib/ratelimit.js`) is
deliberately best-effort dampening, not a security control — KV is eventually
consistent and drops increments under burst.

### Hosting
Live on **Cloudflare Pages**, git-connected to the `main` branch (chosen
over Netlify/Vercel specifically for its secret/env-var storage for future
server-side features, e.g. an AI chatbot proxy — keep this in mind if that
gets built). GitHub Pages has been disabled; Cloudflare is the only
deployment target.

Cloudflare's Pages git-integration deploys run through the same
`wrangler deploy` / Workers-static-assets pipeline as native Workers
projects (confirmed from build logs — this is Cloudflare's current
direction, not just an implementation detail likely to change back). Two
consequences that matter for this repo:
- **`.assetsignore`** (repo root, gitignore syntax) excludes non-site
  paths — `.git`, `.github`, `.claude`, `supabase`, `README.md`,
  `CLAUDE.md`, `.mcp.json`, `.dev.vars` — from being uploaded as deployable
  assets. This is required, not optional: without it, the build fails
  outright (`.git`'s pack files exceed the Workers 25 MiB per-asset limit).
  Any new top-level dir/file that isn't part of the served site should be
  added here too.
  `functions/` is deliberately **not** listed. Cloudflare treats it as a
  reserved directory and compiles it rather than uploading it, but that
  isn't guaranteed under the newer static-assets pipeline — so verify after
  a deploy that `https://<site>/functions/api/_lib/crypto.js` 404s. If it
  ever returns 200, add `functions` here and then re-check that
  `/api/llm-keys` still answers 401 rather than 404. (No secrets live in the
  function source either way — the exposure would be source visibility, not
  a credential leak.)
- Per-asset size is capped at **25 MiB** — relevant if large audio/CSV
  files are ever added under a served directory.
