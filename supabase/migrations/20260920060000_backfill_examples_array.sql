-- STEP 1 of 2: make `examples` the single source of truth.
--
-- Safe and additive. Run this FIRST, before deploying the code change, and
-- before 20260920070000 drops the legacy columns.
--
-- WHY THIS IS NEEDED. custom_vocab.example_furigana + .translation are a copy
-- of examples[0], left behind when 20260816000000_ai_vocab.sql introduced the
-- array. That migration listed three reasons to keep them; checking them
-- against the code as it stands, two are no longer true:
--
--   * "my-saved-words.js" — that page never reads custom_vocab at all. Its
--     `translation` comes from the curated CSV. Custom words aren't on it yet.
--   * "the existing table renderer" — examplesOf() has preferred `examples`
--     for a long time and only fell back to the legacy columns.
--   * "every pre-existing row" — TRUE, and the whole reason this file exists:
--     exactly ONE of 28 rows predates the array and holds its example only in
--     example_furigana. Dropping the columns without this backfill would
--     destroy that row's only copy.
--
-- After this runs, every row carries its examples in `examples`, the fallback
-- branches in js/ are dead code, and the columns are pure duplication.

update public.custom_vocab
set examples = jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'furigana',    example_furigana,
          'translation', translation
        )
      )
    )
where example_furigana is not null
  and jsonb_array_length(coalesce(examples, '[]'::jsonb)) = 0;

-- Prove it: this must return zero rows before running 20260920070000.
-- Anything listed here would LOSE its example when the columns are dropped.
do $$
declare
  stranded int;
begin
  select count(*) into stranded
  from public.custom_vocab
  where example_furigana is not null
    and jsonb_array_length(coalesce(examples, '[]'::jsonb)) = 0;

  if stranded > 0 then
    raise exception
      'Backfill incomplete: % row(s) still hold an example only in example_furigana. Do NOT run the drop migration.',
      stranded;
  end if;
end $$;
