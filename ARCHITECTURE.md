# Architecture

A tour of this repository's folders and files, and the role each one plays
in the running site. This document is meant to stay current — see
"Keeping this document up to date" at the end.

For a detailed, function-by-function reference of what each JavaScript file
does internally, see [FUNCTION_REFERENCE.md](FUNCTION_REFERENCE.md). For the
deeper technical notes, incident history, and reasoning behind
non-obvious decisions in this codebase, see `CLAUDE.md`.

## What this project is

A Japanese vocabulary learning website. Visitors browse curated word lists
(verbs and い-adjectives) with audio pronunciation and example sentences,
and signed-in users can star words to save them, add their own custom
vocabulary with AI-generated example sentences, and manage their account
settings. The site is deliberately simple to build and run: plain HTML,
CSS, and JavaScript with no bundler or framework, backed by Supabase for
accounts and data, and a small Cloudflare Worker for the one thing that
needs a server — keeping each user's AI provider key private.

## Folder-by-folder tour

### Pages (repository root)

Each of these is a self-contained HTML page. They share a common sidebar,
stylesheet, and set of `<script>` includes, and rely on `js/auth-ui.js` to
inject the login modal and account links identically on every page.

| File | Role |
|---|---|
| `index.html` | Home page — the curated verb vocabulary list. |
| `i-adjectives.html` | The curated い-adjective vocabulary list; the template new curated-word-type pages are copied from. |
| `my-saved-words.html` | Shows every word (from either curated list) that the signed-in user has starred. |
| `my-vocab.html` | Manage page for the user's own custom vocabulary entries. |
| `add-vocab.html` | Form for adding a new custom word or editing an existing one, including AI-assisted example sentence generation. |
| `account-settings.html` | Where a signed-in user manages their own LLM API keys (Gemini/Anthropic/OpenAI) and default generation preferences. |
| `api-key-setup.html` | Instructions for obtaining an API key from each supported LLM provider. |
| `favicon.svg` | The site's browser-tab icon. |

### `css/`

- `site.css` — the single stylesheet for the entire site: page layout, the
  vocab tables, the add/edit word wizard, the auth modal, API-key
  provider rows, and pitch-accent rendering.

### `js/`

Classic (non-module) scripts and two ES modules, loaded by `<script>` tags
on the pages that need them. Because classic scripts share one global
scope and execute in the order they're included, later scripts on a page
can safely call functions defined by earlier ones.

| File | Role |
|---|---|
| `vocab-page.js` | Small shared entry point (`initVocabPage`) that each curated vocab page calls to configure and load itself. |
| `csv-vocab.js` | Fetches and parses the curated CSV vocab files, and renders/paginates/shuffles the resulting table. |
| `audio-player.js` | Plays the pre-recorded word, translation, and example-sentence audio clips, including sequential "play all". |
| `sidebar-nav.js` | Opens/closes the sidebar and its dropdowns. |
| `supabase-client.js` (ES module) | Creates the single shared Supabase client used across the site. |
| `auth-ui.js` (ES module) | Injects the login/signup modal and sidebar account links on every page, and broadcasts sign-in/sign-out state to the rest of the site. |
| `saved-words.js` | Handles starring/unstarring words on the curated list pages and the rows-per-page display preference. |
| `my-saved-words.js` | Builds the "My Saved Words" page by combining the user's starred words with the curated CSV data. |
| `furigana.js` | Converts between the site's bracket furigana notation and rendered ruby text, and runs the client-side Japanese tokenizer (kuromoji) used to generate that notation. |
| `custom-vocab.js` | Renders the "My Vocab" page: a user's custom words, their AI-generation status, and controls to retry or delete them. |
| `account-settings.js` | Drives the account settings page: adding, validating, and removing LLM API keys, and choosing default generation preferences. |
| `add-vocab.js` | Drives the add/edit vocabulary form: dictionary lookup, example sentence sourcing (dictionary corpus or AI-generated), and saving. The largest script in the site. |

### `functions/api/`

Server-side request handlers, written in Cloudflare Pages' file-based
routing style (`onRequestGet`, `onRequestPost`, etc.) even though this site
runs as a Cloudflare Worker rather than a Pages project — `worker.js`
reproduces just enough of that contract to load them. Every file here
handles one API route.

| File | Route it handles |
|---|---|
| `_middleware.js` | Runs before every `/api/*` request: authentication and response headers. |
| `llm-providers.js` | `GET /api/llm-providers` — the list of supported AI providers. |
| `jisho.js` | `GET /api/jisho` — Japanese dictionary lookup (used by Add Vocab). |
| `sentences.js` | `GET /api/sentences` — real-world example sentences for a word, from a dictionary corpus. |
| `generate-examples.js` | `POST /api/generate-examples` — AI-generated example sentences, returned immediately for review. |
| `queue-examples.js` | `POST /api/queue-examples` — the same generation, run in the background after a word is saved. |
| `llm-keys/index.js` | `GET`/`POST`/`DELETE /api/llm-keys` — view, add, or remove a stored provider key. |
| `llm-keys/active.js` | `POST /api/llm-keys/active` — choose which provider is currently active. |
| `llm-keys/model.js` | `POST /api/llm-keys/model` — choose which model a provider should use. |
| `llm-keys/validate.js` | `POST /api/llm-keys/validate` — re-check a stored key still works. |

### `functions/api/_lib/`

Shared server-side helper modules, imported by the route handlers above
(these are plain helper files, not routes themselves).

| File | Role |
|---|---|
| `auth.js` | Verifies a request's Supabase session token. |
| `http.js` | Small JSON response and error-handling helpers. |
| `kv.js` | Reads and writes each user's encrypted-key record in Cloudflare KV storage. |
| `crypto.js` | Encrypts and decrypts stored API keys. |
| `keys.js` | Resolves a signed-in user's usable, decrypted provider key. |
| `ratelimit.js` | A best-effort per-user request rate limiter. |
| `models.js` | Keeps track of which AI models are available per provider and in what preference order. |
| `prompts.js` | Every prompt template sent to the AI providers. |
| `examples.js` | The example-sentence generation pipeline: builds prompts, calls the provider, and filters the results. |
| `providers.js` | The registry of supported AI providers (Gemini, Anthropic, OpenAI) and how to call each one's API. |
| `supabase-rest.js` | A minimal client for writing to Supabase directly from the Worker, used only by the background generation path. |

### `supabase/migrations/`

SQL migration files defining the database schema, applied in order by
pasting each one into the Supabase SQL Editor (there is no CLI/automation
for this in the current setup). New schema changes are added as new,
timestamped files rather than editing old ones. Fourteen migrations exist
as of this writing, covering the initial schema and a series of additive
features and fixes (AI vocab support, pitch-accent storage, background
generation status, performance and security hardening, and cleanup of
unused columns).

### Data and asset directories

| Path | Role |
|---|---|
| `iadjective_ready_final.csv`, `verb_ready_final.csv` | The curated vocabulary data — one row per word, with readings, meanings, and example sentences. |
| `iadjective_sound/`, `verb_sound/` | Pre-recorded audio clips for the curated words, looked up by filename. |
| `kuromoji-dict/` | The vendored dictionary data for the client-side Japanese tokenizer (kuromoji), used to auto-generate furigana. |
| `manual_generation_readonly.ipynb` | The original Python notebook used to prepare the curated CSV data; kept for reference, not run as part of the site. |

### Server entry point and configuration

| File | Role |
|---|---|
| `worker.js` | The Cloudflare Worker's entry point — routes `/api/*` requests to the handlers in `functions/api/` and serves everything else as a static file. |
| `wrangler.jsonc` | Cloudflare Worker configuration: name, entry point, static assets directory, and the `LLM_KEYS` storage binding. |
| `.assetsignore` | Lists paths (like `worker.js` and `functions/`) that should be treated as server code rather than uploaded as public static files. |
| `.dev.vars` | Local-only secrets used by the dev server (not committed to version control). |
| `.gitattributes` | Line-ending rules, ensuring shell scripts stay usable when checked out on macOS/Linux. |
| `.gitignore` | Files and folders excluded from version control. |

### Developer tooling

| File | Role |
|---|---|
| `dev.cmd` / `dev.sh` | Start the local development server (Windows / macOS-Linux). |
| `stop-dev.cmd` / `stop-dev.sh` | Stop a local development server that didn't shut down cleanly. |
| `README.md` | Project introduction and setup notes. |
| `todo.txt` | Informal running list of planned work. |
| `.claude/`, `.mcp.json`, `.vscode/`, `.playwright-mcp/` | Editor and AI-assistant tooling configuration; not part of the deployed site. |

## How the pieces fit together

A visitor's browser loads one of the HTML pages, which pulls in a small,
page-specific subset of the scripts in `js/`. Those scripts read vocabulary
data directly from the CSV files and audio directories for the curated
lists, or talk to Supabase directly (using a public, RLS-protected key) for
anything involving a user's account — starred words, custom vocabulary,
and preferences.

The one thing the browser is never trusted with is a user's own AI provider
API key. Adding or using a key goes through the Cloudflare Worker
(`worker.js` and `functions/api/`), which stores it encrypted and only ever
uses it server-side to generate example sentences on the user's behalf.

## Keeping this document up to date

This file describes the *current* state of the project, not its history —
that context belongs in `CLAUDE.md` and the git log instead. Whenever a
file or folder is added, removed, renamed, or has its responsibility
change in a way that would make the tables above inaccurate, update this
document as part of that change.
