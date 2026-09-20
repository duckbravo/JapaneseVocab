-- How much kanji AI-written example sentences should use.
--
-- 'level'   — kanji only where a learner at the chosen JLPT level would be
--             expected to read it; anything above that written in kana.
-- 'natural' — kanji wherever a native writer would use it, however far above
--             the level that is.
--
-- This lived in localStorage first, which made it per-browser: set it on the
-- laptop and the phone still generated textbook-style sentences. It is a
-- statement about how the learner wants to read, so it belongs with the
-- account, next to jlpt_level.
--
-- NOTE the difference from jlpt_level, which Add Vocab reads but does NOT write
-- back (the level is a genuine per-word override — it is stored on the row as
-- custom_vocab.jlpt_level and per example). Kanji policy has no per-word
-- storage anywhere, so changing it on Add Vocab has nowhere else to live and
-- saves immediately.
--
-- Defaults to 'level': the safer choice for a learner, and what the prompt
-- leaned towards before the setting existed, so no existing user sees a change
-- in behaviour from this migration alone.
--
-- There's no Supabase CLI linked to this repo — paste this into the target
-- project's SQL Editor and run it. Additive only.

alter table public.user_preferences
  add column if not exists kanji_policy text not null default 'level';

-- Added separately so re-running this file on a project that already has the
-- column doesn't fail on a duplicate constraint name — same guard as
-- user_preferences_jlpt_level_check in 20260816000000_ai_vocab.sql.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_preferences_kanji_policy_check'
  ) then
    alter table public.user_preferences
      add constraint user_preferences_kanji_policy_check
      check (kanji_policy in ('level', 'natural'));
  end if;
end $$;
