-- ============================================================================
-- KGM LEGAL OS · STORAGE OBJECT POLICIES
-- ============================================================================
-- Run as the STORAGE ADMINISTRATOR, after migrations 0001-0006.
--
-- HOW TO RUN (pick one)
--   Dashboard  →  Storage  →  Policies  →  New policy  →  paste each statement
--   SQL editor →  may fail with "must be owner of table objects" if the editor
--                 session runs as `postgres`; the Dashboard storage UI uses the
--                 storage admin and is the reliable path.
--
-- WHY THIS IS SEPARATE FROM MIGRATION 0005
--   `storage.objects` is owned by `supabase_storage_admin`, and the `postgres`
--   role on this project is NOT a member of it. `create policy` requires table
--   ownership, so 0005 cannot apply these; it detects the situation and reports
--   the outstanding action instead of failing the whole migration.
--
-- WHY `as restrictive` AND `using (false)`
--   The original statements in 0005 were permissive and shaped as:
--
--     for all to anon using (bucket_id in (...)) with check (false)
--
--   In PostgreSQL `USING` governs SELECT/UPDATE/DELETE visibility, and permissive
--   policies are combined with OR. That form therefore GRANTED anon SELECT and
--   DELETE on every object in the four buckets. Verified against a live instance:
--
--     SELECT  ALLOWED  (2 rows)      INSERT  denied
--     UPDATE  denied                 DELETE  ALLOWED  (1 row)
--
--   RLS was already enabled with no other policy, so anon was denied by default.
--   The migration as written would have opened client documents to unauthenticated
--   read AND delete — a hole created by the file meant to prevent one.
--
--   `as restrictive` ANDs instead of OR-ing, and `using (false)` admits no row, so
--   the denial holds even if a permissive policy is added later.
-- ============================================================================

-- Idempotent: safe to re-run.
drop policy if exists "portal_objects_denied_anon"     on storage.objects;
drop policy if exists "portal_objects_denied_auth"     on storage.objects;
drop policy if exists "portal_objects_service_only"    on storage.objects;

-- No browser-side Supabase client may read, list, write or delete an object,
-- even if an anon or authenticated key were leaked.
create policy "portal_objects_denied_anon" on storage.objects
  as restrictive for all to anon
  using (false) with check (false);

create policy "portal_objects_denied_auth" on storage.objects
  as restrictive for all to authenticated
  using (false) with check (false);

-- service_role carries BYPASSRLS, so this is inert in practice and exists to
-- document intent. Deliberately permissive and bucket-scoped: a restrictive
-- policy here would AND against every other policy for that role, which is not
-- what a scoping statement should do.
create policy "portal_objects_service_only" on storage.objects
  for all to service_role
  using (bucket_id in ('client-documents','client-uploads','financial-documents','data-exports'))
  with check (bucket_id in ('client-documents','client-uploads','financial-documents','data-exports'));

-- ============================================================================
-- VERIFY
-- ----------------------------------------------------------------------------
--   select policyname, permissive, roles, cmd, qual
--     from pg_policies where schemaname='storage' and tablename='objects';
--
--   Expect permissive = 'RESTRICTIVE' for the two denied_* policies.
-- ============================================================================
