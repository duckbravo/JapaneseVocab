-- STEP 2 of 2: remove the duplicated example columns.
--
-- ============================================================
--  RUN ORDER MATTERS. THIS ONE IS BREAKING.
-- ============================================================
--   1. Apply 20260920060000_backfill_examples_array.sql  (safe, additive)
--   2. DEPLOY the code that no longer writes these columns
--   3. Then apply this file
--
-- Step 2 is not optional. Dev and prod are the same database (see CLAUDE.md),
-- so the LIVE site is whatever is deployed on `main`. PostgREST rejects an
-- insert naming a column that no longer exists, so dropping these while the
-- deployed code still sets them breaks every save on the live site until the
-- deploy catches up. The reverse order is harmless: deployed code that has
-- stopped writing them works perfectly well against a schema that still has
-- them.
--
-- WHAT GOES, AND WHY THE TRIGGER GOES FIRST.
-- 20260920030000 added custom_vocab_sync_example_mirror() to keep these two
-- columns equal to examples[0]. With the columns gone that function is not
-- merely useless — it is BROKEN: `new.example_furigana := …` against a dropped
-- column raises on every insert and update. It must be dropped in the same
-- transaction, before the columns, or the table becomes unwritable.
--
-- The updated_at triggers from that migration are unaffected and stay.
--
-- AFTERWARDS the schema says what it means: one array, `examples`, holding
-- [{furigana, translation, level?, kanjiPolicy?}], with no second copy for any
-- writer to forget and no trigger needed to paper over it. A future client in
-- any language needs to know about exactly one column.

begin;

-- Trigger first — see above.
drop trigger if exists custom_vocab_sync_example_mirror on public.custom_vocab;
drop function if exists public.custom_vocab_sync_example_mirror();

-- Comments on columns that are about to not exist.
comment on column public.custom_vocab.example_furigana is null;
comment on column public.custom_vocab.translation is null;

alter table public.custom_vocab
  drop column if exists example_furigana,
  drop column if exists translation;

commit;

-- `examples` is now the only place an example sentence lives.
comment on column public.custom_vocab.examples is
  'THE example sentences for this word: [{furigana, translation, level?, kanjiPolicy?}]. Single source of truth — the example_furigana/translation mirror was removed in 20260920070000. furigana uses bracket syntax 食[た]べる, except while needs_furigana is true, when it is plain text awaiting the browser-side kuromoji tagger.';
