-- 0013 — LET THE FIRM AUDIENCE APPEND TO THE AUDIT TRAIL
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
-- Firm sign-in reached its final step and failed there:
--
--     FirmAuthService.completeLogin
--       -> AuditLogger.write
--         -> Repo.audit
--           -> permission denied for table audit_events
--
-- 0006 revoked the whole table from `firm_api`:
--
--     revoke all on public.internal_notes from firm_api;
--     revoke all on public.audit_events   from firm_api;
--
-- That was written when firm requests ran as `firm_os` by inheritance, where the
-- revoke was invisible. Migration 0008 removed the inheritance and made firm
-- requests run as `firm_api` for real, at which point the revoke took effect — and
-- the audit writer is on the login path, so nobody could sign in.
--
-- THE DEEPER PROBLEM: IT WOULD HAVE BEEN SILENT EVERYWHERE ELSE.
--   `AuditLogger.tryWrite` swallows its errors by design — an audit failure must
--   not mask the operation's own error. `completeLogin` calls `write` (which
--   throws) and so failed loudly. But every OTHER firm audit call site uses
--   `tryWrite`, so once login was fixed the trail would have stopped recording
--   silently: §38 says a sensitive operation cannot succeed without its audit
--   record, and the failure mode is the opposite of loud.
--
--   Evidence this was already happening on the portal side is in the live table:
--   twelve rows, all `LOGIN`. The portal holds column-level INSERT (0004), so its
--   logins record — but anything the portal writes through `tryWrite` under a
--   narrower path would vanish with no trace.
--
-- ============================================================================
-- WHY APPEND IS THE RIGHT ANSWER
-- ============================================================================
-- The audit trail is only worth having if the actors it describes cannot edit it.
-- The design already says so, and 0004 encodes it for the portal as
-- INSERT-without-SELECT: the writer holds column-level INSERT on the sixteen
-- columns of a row and no read privilege at all. "Writes audit rows that a client
-- cannot read back, update or delete" is a tested property of the portal.
--
-- The firm audience gets exactly the same shape, for exactly the same reason. A
-- firm staff member performing an audited action must be able to append the
-- record of it; nothing in the product requires them to read the trail back, and
-- the `auditor` role exists for that (§51) — it holds SELECT and no write.
--
-- Explicitly NOT granted, and each for a reason:
--
--   SELECT  a firm user could then read the trail and learn what compliance is
--           investigating, and which of their colleagues is under review.
--   UPDATE  an audit record that can be edited after the fact is not evidence.
--   DELETE  same, and worse.
--
-- `internal_notes` stays revoked from `firm_api` (0006). That revoke is correct
-- and is re-asserted below: the table's RLS policy is what scopes it, and widening
-- the role would make every firm read of internal notes tenant-blind.

-- ---------------------------------------------------------------------------
-- 1 · Append to the trail. Mirror 0004's portal grant exactly.
-- ---------------------------------------------------------------------------
grant insert (id, occurred_at, tenant_id, actor_kind, actor_user_id, actor_client_id,
              action, resource_type, resource_id, outcome, reason_code,
              ip_hash, ip_country, user_agent, request_id, metadata)
  on public.audit_events to firm_api;

grant usage, select on sequence public.audit_events_id_seq to firm_api;

/*
  A policy is required as well as the grant. `audit_no_read_for_portal` is declared
  `TO portal_api`, and `audit_firm_read` is `TO auditor, firm_os` — so `firm_api`
  has no policy on this table at all, and RLS fails closed for a role with no
  applicable policy regardless of what it has been granted.

  Insert-only, like the portal's: `with check (true)`, no USING clause. Without a
  USING clause there is no rows-visible predicate, so SELECT returns nothing even
  if a grant is ever added by mistake.
*/
drop policy if exists audit_append_for_firm on public.audit_events;
create policy audit_append_for_firm on public.audit_events to firm_api
  with check (true);

comment on policy audit_append_for_firm on public.audit_events is
  'Firm-audience APPEND only. No USING clause, so the writer cannot read the trail '
  'back even if a SELECT grant is added later. Reading is the auditor role''s job.';

-- ---------------------------------------------------------------------------
-- 2 · Assert the outcome, and assert append-only really is append-only.
-- ---------------------------------------------------------------------------
do $$
declare
  can_read boolean;
  can_edit boolean;
  can_delete boolean;
begin
  -- The write path that failed.
  if not has_column_privilege('firm_api', 'public.audit_events', 'action', 'INSERT') then
    raise exception 'firm_api cannot INSERT audit_events.action — firm audit writes fail, and tryWrite hides it.';
  end if;

  -- ...and the read/write privileges that must NOT be there.
  select bool_or(x) into can_read from (
    select has_column_privilege('firm_api', 'public.audit_events', a.attname, 'SELECT') x
      from pg_attribute a
     where a.attrelid = 'public.audit_events'::regclass and a.attnum > 0 and not a.attisdropped
  ) s;
  if can_read then
    raise exception 'firm_api can READ audit_events — a firm user could read the trail.';
  end if;

  can_edit := has_table_privilege('firm_api', 'public.audit_events', 'UPDATE')
           or exists (select 1 from pg_attribute a
                       where a.attrelid = 'public.audit_events'::regclass and a.attnum > 0
                         and not a.attisdropped
                         and has_column_privilege('firm_api', 'public.audit_events', a.attname, 'UPDATE'));
  can_delete := has_table_privilege('firm_api', 'public.audit_events', 'DELETE');
  if can_edit then
    raise exception 'firm_api can UPDATE audit_events — the trail is no longer evidence.';
  end if;
  if can_delete then
    raise exception 'firm_api can DELETE from audit_events — the trail is no longer evidence.';
  end if;

  -- 0006's internal_notes revoke is deliberate and must survive this file.
  if has_table_privilege('firm_api', 'public.internal_notes', 'SELECT')
     or exists (select 1 from pg_attribute a
                 where a.attrelid = 'public.internal_notes'::regclass and a.attnum > 0
                   and not a.attisdropped
                   and has_column_privilege('firm_api', 'public.internal_notes', a.attname, 'SELECT')) then
    raise exception 'firm_api can read internal_notes — 0006''s revoke was undone.';
  end if;

  raise notice 'firm_api may append to audit_events and still cannot read, edit or erase it.';
end $$;
