-- Fixes a bug in 20260920040000_schema_hygiene.sql.
--
-- That migration tried to stop PostgREST exposing handle_new_user() as an RPC
-- with:
--
--     revoke execute on function public.handle_new_user() from anon, authenticated;
--
-- It ran without error and changed nothing. PostgreSQL grants EXECUTE on every
-- new function to PUBLIC by default, and anon/authenticated never held a grant
-- of their own — they inherit it, because every role is implicitly a member of
-- PUBLIC. Revoking a privilege a role does not directly hold is a silent no-op.
--
-- The ACL made it obvious once looked at:
--     =X/postgres              <- "=X" is PUBLIC holding EXECUTE
--     postgres=X/postgres
--     service_role=X/postgres
--
-- has_function_privilege() resolves inherited grants, so anon/authenticated
-- still reported as able to execute it. Revoking from PUBLIC is the actual fix.
--
-- STILL SAFE FOR SIGNUP: PostgreSQL checks EXECUTE on a trigger's function when
-- the trigger is CREATED, not each time it fires, and this one fires as the
-- auth system's own role. postgres and service_role keep their explicit grants
-- either way. Verify with one real signup regardless — a broken trigger here
-- means new accounts silently get no profiles row.
--
-- There's no Supabase CLI linked to this repo — paste this into the target
-- project's SQL Editor and run it.

revoke execute on function public.handle_new_user() from public;

-- Belt and braces: these are no-ops today (no direct grants exist) but keep the
-- intent explicit if a future migration ever grants them directly.
revoke execute on function public.handle_new_user() from anon, authenticated;
