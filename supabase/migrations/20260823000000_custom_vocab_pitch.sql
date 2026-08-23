-- Pitch accent (高低アクセント) for custom vocab.
--
-- Jotoba returns this on every word it knows, as an ordered list of runs:
--   [{ "part": "た", "high": false }, { "part": "べ", "high": true }, ...]
-- Consecutive morae at the same level are already merged into one part, so
-- this is a ready-made drawing instruction rather than per-mora data. Stored
-- verbatim (allowlisted server-side) so the My Vocab table can render the
-- pitch line without re-querying the dictionary.
--
-- Empty array = "no pitch data" (a manually added word, or one the dictionary
-- doesn't know), which renders as nothing at all.
--
-- There's no Supabase CLI linked to this repo — paste this into the target
-- project's SQL Editor and run it. Additive only.

alter table public.custom_vocab
  add column if not exists pitch jsonb not null default '[]'::jsonb;
