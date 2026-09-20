-- Two loose ends: a constraint that exists on one column but not its twin,
-- and a trigger function exposed as a public RPC.
--
-- There's no Supabase CLI linked to this repo — paste this into the target
-- project's SQL Editor and run it, or let the Supabase MCP apply it.

-- ============================================================
-- 1. custom_vocab.jlpt_level gets the same check as its twin
-- ============================================================
-- user_preferences.jlpt_level has had a check constraint since
-- 20260816000000_ai_vocab.sql; custom_vocab.jlpt_level, added later in
-- 20260913000000, never got one. Same values, same meaning, different
-- guarantees — which is exactly the kind of asymmetry that leaves a typo
-- sitting in a row until something downstream trips over it.
--
-- NULL stays valid: the column is only populated when a word was generated
-- via the background route, and rows created any other way legitimately have
-- no level recorded.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'custom_vocab_jlpt_level_check'
  ) then
    alter table public.custom_vocab
      add constraint custom_vocab_jlpt_level_check
      check (jlpt_level is null or jlpt_level in ('N5', 'N4', 'N3', 'N2', 'N1'));
  end if;
end $$;

-- ============================================================
-- 2. handle_new_user() is a trigger, not an API
-- ============================================================
-- Supabase's security linter flags it twice (0028, 0029): because it lives in
-- the `public` schema, PostgREST exposes it at /rest/v1/rpc/handle_new_user,
-- callable by both `anon` and `authenticated`, and it is SECURITY DEFINER.
--
-- The practical risk is low — PostgreSQL refuses to run a plpgsql trigger
-- function outside a trigger, so a direct call errors rather than inserting
-- anything — but an unnecessary SECURITY DEFINER entry point on the public API
-- is not worth keeping just because today's version happens to be inert.
--
-- SAFE FOR THE SIGNUP TRIGGER: PostgreSQL checks EXECUTE on a trigger's
-- function when the trigger is CREATED, not each time it fires, and this one
-- fires as the auth system's own role. Revoking from anon/authenticated does
-- not affect it. Verify anyway by completing one real signup afterwards — a
-- broken trigger here means new accounts get no profiles row.
revoke execute on function public.handle_new_user() from anon, authenticated;

comment on function public.handle_new_user() is
  'AFTER INSERT trigger on auth.users: creates the profiles row. Not an API — EXECUTE is revoked from anon/authenticated so PostgREST will not expose it as an RPC.';
