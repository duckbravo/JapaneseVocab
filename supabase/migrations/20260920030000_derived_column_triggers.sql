-- Let the DATABASE maintain the derived columns, instead of every writer.
--
-- THE PROBLEM. custom_vocab.example_furigana and .translation are a copy of
-- examples[0] kept for readers that predate the `examples` array
-- (js/my-saved-words.js, and any row saved before it existed). Today THREE
-- separate writers each have to remember to set them:
--   js/add-vocab.js         saveWord()
--   js/custom-vocab.js      upgradeFurigana()
--   functions/api/queue-examples.js  successPatch()
-- Nothing enforces that. The first writer to forget produces a row whose
-- My Vocab view and My Saved Words view disagree — a bug that looks like a
-- rendering fault and would be hunted for in the wrong place entirely.
--
-- Same story for updated_at: set by hand in several places, silently wrong
-- wherever it is missed.
--
-- THE FIX, AND WHY A TRIGGER. Moving the rule into the database means any
-- future writer gets it right without knowing it exists — a different page, a
-- Worker route, a psql session, a migration, a client in another language.
-- That is the property asked for: the fewest possible assumptions about how
-- future code is structured.
--
-- GENERATED columns were the alternative and would be stronger still (drift
-- becomes impossible rather than merely handled). They were rejected because
-- Postgres REJECTS writes to a generated column, so all three writers above
-- would start erroring the moment this was applied. A trigger is backward
-- compatible: writers that still set these columns are simply overruled with
-- the identical value.
--
-- There's no Supabase CLI linked to this repo — paste this into the target
-- project's SQL Editor and run it, or let the Supabase MCP apply it.

-- ============================================================
-- Generic: updated_at
-- ============================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
-- Pinned so the function cannot be influenced by a caller's search_path.
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE INSERT/UPDATE trigger: stamps updated_at. Overrules any value the client sent, which is the point — a client clock is not authoritative.';

drop trigger if exists custom_vocab_set_updated_at on public.custom_vocab;
create trigger custom_vocab_set_updated_at
  before insert or update on public.custom_vocab
  for each row execute function public.set_updated_at();

drop trigger if exists user_preferences_set_updated_at on public.user_preferences;
create trigger user_preferences_set_updated_at
  before insert or update on public.user_preferences
  for each row execute function public.set_updated_at();

-- ============================================================
-- custom_vocab: example_furigana / translation mirror examples[0]
-- ============================================================
create or replace function public.custom_vocab_sync_example_mirror()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  -- ONLY when there is an array to mirror.
  --
  -- This guard is load-bearing, not defensive padding. One existing row holds
  -- its example ONLY in example_furigana, with examples = '[]' — it predates
  -- the array. Deriving unconditionally would set that row's sole copy of its
  -- example sentence to NULL the next time anything touched it.
  --
  -- Leaving such rows alone also means this migration changes no data at all:
  -- rows that already agree are rewritten with identical values, and the one
  -- that would lose data is skipped.
  if jsonb_array_length(coalesce(new.examples, '[]'::jsonb)) > 0 then
    new.example_furigana := new.examples -> 0 ->> 'furigana';
    new.translation      := new.examples -> 0 ->> 'translation';
  end if;

  return new;
end;
$$;

comment on function public.custom_vocab_sync_example_mirror() is
  'BEFORE INSERT/UPDATE trigger: keeps example_furigana/translation equal to examples[0]. Skips rows with an empty examples array, which hold their only copy in the legacy columns.';

drop trigger if exists custom_vocab_sync_example_mirror on public.custom_vocab;
create trigger custom_vocab_sync_example_mirror
  before insert or update on public.custom_vocab
  for each row execute function public.custom_vocab_sync_example_mirror();

-- ============================================================
-- Document the contract in the database itself
-- ============================================================
-- Comments live with the schema rather than only in CLAUDE.md, so they survive
-- any future client that never reads this repo.
comment on column public.custom_vocab.example_furigana is
  'DERIVED from examples[0].furigana by trigger — do not set directly. Kept for readers predating the examples array.';
comment on column public.custom_vocab.translation is
  'DERIVED from examples[0].translation by trigger — do not set directly.';
comment on column public.custom_vocab.examples is
  'Authoritative list: [{furigana, translation, level?, kanjiPolicy?}]. furigana uses bracket syntax 食[た]べる, except while needs_furigana is true when it is plain text awaiting the browser tagger.';
comment on column public.custom_vocab.more is
  'Short usage phrases, same shape as examples. Mirrors the "More" column of the curated CSVs.';
comment on column public.custom_vocab.needs_furigana is
  'True when examples/more hold PLAIN Japanese written by the Worker, which cannot run kuromoji. js/custom-vocab.js annotates and clears this.';
comment on column public.custom_vocab.kanji_usually_kana is
  'Display preference only: hides the Kanji column on My Vocab. The kanji is still stored and still used for generation and matching.';
