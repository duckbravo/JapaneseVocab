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
  _lib/               helpers — http, auth, crypto, kv, providers, keys, ratelimit
  llm-providers.js    GET  /api/llm-providers
  llm-keys/
    index.js          GET | POST | DELETE  /api/llm-keys
    validate.js       POST /api/llm-keys/validate
    active.js         POST /api/llm-keys/active
```

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
