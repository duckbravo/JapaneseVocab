-- AI-assisted vocab adding.
--
-- Additive only: every column is nullable or defaulted, so existing rows stay
-- valid and the RLS policies from 20260726000000_init_schema.sql cover the new
-- columns without change (they gate on user_id, not on a column list).
--
-- There is no Supabase CLI linked to this repo — paste this into the target
-- project's SQL Editor and run it. Dev project first, then prod.

-- ============================================================
-- user_preferences.jlpt_level
-- ============================================================
-- Default difficulty for generated example sentences. Read/written straight
-- from the browser under RLS, exactly like rows_per_page (js/saved-words.js);
-- add-vocab.html also has a per-word override that is NOT persisted here.
alter table public.user_preferences
  add column if not exists jlpt_level text not null default 'N5';

-- Added separately so re-running this file on a project that already has the
-- column doesn't fail on a duplicate constraint name.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_preferences_jlpt_level_check'
  ) then
    alter table public.user_preferences
      add constraint user_preferences_jlpt_level_check
      check (jlpt_level in ('N5', 'N4', 'N3', 'N2', 'N1'));
  end if;
end $$;

-- ============================================================
-- custom_vocab: multiple examples + jisho metadata
-- ============================================================
-- examples: [{ "furigana": "食[た]べる", "translation": "..." }, ...]
--
-- example_furigana/translation are NOT replaced — they keep holding examples[0]
-- so my-saved-words.js, the existing table renderer, and every pre-existing row
-- carry on working untouched. examples is the richer superset.
alter table public.custom_vocab
  add column if not exists examples jsonb not null default '[]'::jsonb;

-- Display-only, straight from jisho.org (e.g. "Ichidan verb"). Deliberately not
-- wired to user_word_state.word_type, whose check constraint only accepts
-- verb/i-adjective/na-adjective/custom — custom vocab is always 'custom'.
alter table public.custom_vocab
  add column if not exists part_of_speech text;

-- jisho.org entry id (e.g. "食べる"), kept so a later feature can re-look-up a
-- word or detect duplicates. Null for manually-added words.
alter table public.custom_vocab
  add column if not exists jisho_slug text;
