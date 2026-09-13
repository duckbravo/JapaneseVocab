-- Background AI example generation for custom vocab.
--
-- The Add Vocab flow can now save a word IMMEDIATELY and let the Worker finish
-- writing its example sentences afterwards (POST /api/queue-examples, which
-- returns 202 and keeps working under ctx.waitUntil). That means a row can
-- exist in three states rather than just "saved", so the state has to live in
-- the table — the browser that requested the generation may well be closed by
-- the time it finishes.
--
-- There's no Supabase CLI linked to this repo — paste this into the target
-- project's SQL Editor and run it. Additive only: every column is defaulted or
-- nullable, and the RLS policies in 20260726000000_init_schema.sql gate on
-- user_id rather than a column list, so they cover these without change.

-- ============================================================
-- custom_vocab.example_status
-- ============================================================
-- 'ready'   — examples are whatever they are; nothing is owed. The default, so
--             every pre-existing row and every synchronously-saved word is
--             already correct without a backfill.
-- 'pending' — a generation is in flight. My Vocab shows the row greyed with a
--             spinner instead of an empty Example cell.
-- 'failed'  — generation finished and produced nothing usable. My Vocab
--             red-flags the row so the user can retry or edit by hand. This is
--             the state that makes the feature honest: a background job that
--             can fail silently is worse than no background job.
alter table public.custom_vocab
  add column if not exists example_status text not null default 'ready'
    check (example_status in ('ready', 'pending', 'failed'));

-- The provider-facing reason, shown verbatim in the red flag's tooltip (e.g.
-- "Gemini could not generate examples right now"). Null unless status='failed'.
alter table public.custom_vocab
  add column if not exists example_error text;

-- The level the generation was requested at, so "Retry" on My Vocab can
-- re-run it without asking again. Distinct from user_preferences.jlpt_level,
-- which is the default for the NEXT word rather than a record of this one.
alter table public.custom_vocab
  add column if not exists jlpt_level text;

-- ============================================================
-- custom_vocab.needs_furigana
-- ============================================================
-- kuromoji (js/furigana.js, ~12MB) runs in the BROWSER only, so a Worker that
-- generates sentences in the background can store plain Japanese but cannot
-- produce the bracket syntax (食[た]べる) every other example carries.
--
-- Rather than leave those rows permanently un-annotated, the Worker sets this
-- flag and js/custom-vocab.js annotates them with the tagger it already loads,
-- then writes the result back once and clears the flag. Reading a flagged row
-- still works in the meantime: renderFurigana() on plain text renders plain
-- text, just without ruby.
alter table public.custom_vocab
  add column if not exists needs_furigana boolean not null default false;
