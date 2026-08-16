-- "More" phrases for custom vocab: up to 2 short indicative usage phrases per
-- word, mirroring verb_ready_final.csv's "More" column (e.g. "友達に会います
-- -- meet a friend"). Distinct in STYLE from `examples` (full 15-30 character
-- sentences) — a separately-generated shorter style, not a slice of the same
-- list. Same [{ "furigana": "...", "translation": "..." }, ...] shape as
-- `examples`, capped at 2 by the app rather than a DB constraint (consistent
-- with how `examples` isn't DB-capped at its own limit of 5 either).
--
-- There's no Supabase CLI linked to this repo — paste this into the target
-- project's SQL Editor and run it. Additive only.

alter table public.custom_vocab
  add column if not exists more jsonb not null default '[]'::jsonb;
