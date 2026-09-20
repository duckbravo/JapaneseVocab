-- Performance: one missing index, and 15 RLS policies that re-evaluate
-- auth.uid() per row.
--
-- Both were reported by Supabase's own database linter, not guessed at:
--   0001_unindexed_foreign_keys  — custom_vocab_user_id_fkey has no covering index
--   0003_auth_rls_initplan       — 15 policies, every table
--
-- Neither changes behaviour or requires any application change.
--
-- There's no Supabase CLI linked to this repo — paste this into the target
-- project's SQL Editor and run it, or let the Supabase MCP apply it.

-- ============================================================
-- 1. custom_vocab (user_id, created_at desc)
-- ============================================================
-- Covers two things at once:
--   * the foreign key custom_vocab_user_id_fkey (leading column), which
--     Postgres needs to check on every auth.users delete;
--   * js/custom-vocab.js's loadCustomVocab(), which is literally
--     "select * from custom_vocab order by created_at desc" under an RLS
--     predicate of user_id = auth.uid() — so the index satisfies the filter
--     AND the sort, with no separate sort step.
--
-- A plain (user_id) index would serve the FK but still force a sort. At 28
-- rows neither matters; this is about the shape being right before it does.
create index if not exists custom_vocab_user_id_created_at_idx
  on public.custom_vocab (user_id, created_at desc);

-- ============================================================
-- 2. RLS: auth.uid() -> (select auth.uid())
-- ============================================================
-- Bare auth.uid() is treated as volatile and re-evaluated for EVERY candidate
-- row. Wrapping it in a scalar sub-select makes the planner hoist it into an
-- InitPlan evaluated once per statement. The predicate is identical; only the
-- number of times it runs changes.
--
-- Policies are dropped and recreated rather than ALTERed so the definitions
-- are stated in full here — a future reader can see exactly what the rule is
-- without cross-referencing the original migration.

-- profiles (no delete policy exists by design — rows are removed by the
-- auth.users cascade, never by the client)
drop policy if exists "select own profile" on public.profiles;
create policy "select own profile" on public.profiles
  for select using ((select auth.uid()) = id);

drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile" on public.profiles
  for insert with check ((select auth.uid()) = id);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- user_preferences
drop policy if exists "select own preferences" on public.user_preferences;
create policy "select own preferences" on public.user_preferences
  for select using ((select auth.uid()) = user_id);

drop policy if exists "insert own preferences" on public.user_preferences;
create policy "insert own preferences" on public.user_preferences
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "update own preferences" on public.user_preferences;
create policy "update own preferences" on public.user_preferences
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "delete own preferences" on public.user_preferences;
create policy "delete own preferences" on public.user_preferences
  for delete using ((select auth.uid()) = user_id);

-- custom_vocab
drop policy if exists "select own custom_vocab" on public.custom_vocab;
create policy "select own custom_vocab" on public.custom_vocab
  for select using ((select auth.uid()) = user_id);

drop policy if exists "insert own custom_vocab" on public.custom_vocab;
create policy "insert own custom_vocab" on public.custom_vocab
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "update own custom_vocab" on public.custom_vocab;
create policy "update own custom_vocab" on public.custom_vocab
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "delete own custom_vocab" on public.custom_vocab;
create policy "delete own custom_vocab" on public.custom_vocab
  for delete using ((select auth.uid()) = user_id);

-- user_word_state
drop policy if exists "select own word_state" on public.user_word_state;
create policy "select own word_state" on public.user_word_state
  for select using ((select auth.uid()) = user_id);

drop policy if exists "insert own word_state" on public.user_word_state;
create policy "insert own word_state" on public.user_word_state
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "update own word_state" on public.user_word_state;
create policy "update own word_state" on public.user_word_state
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "delete own word_state" on public.user_word_state;
create policy "delete own word_state" on public.user_word_state
  for delete using ((select auth.uid()) = user_id);
