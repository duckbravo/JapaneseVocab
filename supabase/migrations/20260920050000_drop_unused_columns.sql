-- Drop two columns nothing has ever read or written.
--
-- THIS IS THE ONLY IRREVERSIBLE MIGRATION in this cleanup. Everything else
-- adds, fixes or documents. Verified before writing it: a grep across js/,
-- functions/ and every .html found ZERO references to either column, and both
-- hold only their defaults.
--
--   profiles.username                 — never written by anything. Carried a
--                                       UNIQUE index, so this also removes an
--                                       index nothing could ever use.
--   user_preferences.autoplay_example — a planned audio setting that was never
--                                       wired to a control.
--
-- DELIBERATELY KEPT, despite also being unreferenced today:
--   profiles.display_name                — written by the handle_new_user
--                                          trigger on every signup, so it does
--                                          hold real data.
--   user_word_state.status               — the scaffolding for spaced
--   user_word_state.review_count           repetition, which the schema was
--   user_word_state.last_reviewed_at       plainly designed around. Costs
--                                          nothing to keep; re-adding them
--                                          later is easy, but any progress
--                                          data recorded in the meantime would
--                                          not be.
--
-- If a future feature wants a username, add it back as a fresh column — do not
-- resurrect this one expecting data in it.
--
-- There's no Supabase CLI linked to this repo — paste this into the target
-- project's SQL Editor and run it, or let the Supabase MCP apply it.

alter table public.profiles
  drop column if exists username;

alter table public.user_preferences
  drop column if exists autoplay_example;

comment on column public.profiles.display_name is
  'Populated from raw_user_meta_data by the handle_new_user trigger at signup. Not yet surfaced in the UI.';
