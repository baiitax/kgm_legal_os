-- ============================================================================
-- KGM LEGAL OS · 0020 — GRANTS FOR UPSERTS
-- ============================================================================
-- 0016 reconciled the column grants for every INSERT and UPDATE in the code. It
-- still missed three statements, because they are neither: they are upserts.
--
--   insert into matter_permissions (...)
--     on conflict (matter_id, membership_id) do update set access_level = ...,
--       reason = ..., granted_by_membership_id = ..., granted_at = ..., revoked_at = null
--
--   insert into membership_roles (...)
--     on conflict ... do update set grant_origin = ..., granted_by_membership_id = ...,
--       granted_at = ..., revoked_at = null
--
-- WHY THE AUDIT MISSED THEM, AND WHY THAT MATTERS
--   `insert into t (cols)` privileges and `update t set cols` privileges are
--   checked as two separate things, but the statement is written as one, so a
--   scanner looking for `insert into` sees only the INSERT list — and one looking
--   for `update ... set` never sees the second half at all. Postgres requires BOTH
--   at plan time, whether or not a conflict actually occurs.
--
--   The failure therefore appears on the FIRST grant of matter access, and it
--   reports the table, not the column:
--
--       POST /api/firm/matters/:id/access -> 500 internal_error
--       cause: permission denied for table matter_permissions
--
--   Which is the same shape as 0016's header: "permission denied for TABLE",
--   with the missing column nowhere in the message. `firm_api` held INSERT on all
--   nine columns and UPDATE on exactly one (`revoked_at`), and the upsert needs
--   UPDATE on the five columns it writes in its DO UPDATE branch.
--
--   Recorded because the reconciler in supabase/ops only understands plain
--   INSERT and UPDATE forms; adding upserts to it is the follow-up, and until
--   then this file is the list.
--
-- SCOPE
--   Two tables, both firm-only authority surfaces, granted to `firm_api` only:
--   who may act on a matter, and which role a member holds. Nothing is granted to
--   the portal, and `revoked_at` was already granted — a revocation could always
--   be written, it was the re-grant that could not.
-- ============================================================================

grant update (
        access_level,
        reason,
        granted_by_membership_id,
        granted_at
) on public.matter_permissions to firm_api;

grant update (
        grant_origin,
        granted_by_membership_id,
        granted_at
) on public.membership_roles to firm_api;

-- ============================================================================
-- VERIFY — every column the three upserts write must be writable by the role
-- that runs them, on BOTH sides of the statement.
-- ============================================================================
do $$
declare
  r record;
  missing text[] := '{}';
begin
  for r in
    select * from (values
      ('firm_api',   'matter_permissions', 'INSERT', 'id'),
      ('firm_api',   'matter_permissions', 'INSERT', 'matter_id'),
      ('firm_api',   'matter_permissions', 'INSERT', 'tenant_id'),
      ('firm_api',   'matter_permissions', 'INSERT', 'membership_id'),
      ('firm_api',   'matter_permissions', 'INSERT', 'access_level'),
      ('firm_api',   'matter_permissions', 'INSERT', 'reason'),
      ('firm_api',   'matter_permissions', 'INSERT', 'granted_by_membership_id'),
      ('firm_api',   'matter_permissions', 'INSERT', 'granted_at'),
      ('firm_api',   'matter_permissions', 'INSERT', 'revoked_at'),
      ('firm_api',   'matter_permissions', 'UPDATE', 'access_level'),
      ('firm_api',   'matter_permissions', 'UPDATE', 'reason'),
      ('firm_api',   'matter_permissions', 'UPDATE', 'granted_by_membership_id'),
      ('firm_api',   'matter_permissions', 'UPDATE', 'granted_at'),
      ('firm_api',   'matter_permissions', 'UPDATE', 'revoked_at'),
      ('firm_api',   'membership_roles',   'INSERT', 'membership_id'),
      ('firm_api',   'membership_roles',   'INSERT', 'role_id'),
      ('firm_api',   'membership_roles',   'INSERT', 'granted_by_membership_id'),
      ('firm_api',   'membership_roles',   'INSERT', 'grant_origin'),
      ('firm_api',   'membership_roles',   'INSERT', 'granted_at'),
      ('firm_api',   'membership_roles',   'UPDATE', 'grant_origin'),
      ('firm_api',   'membership_roles',   'UPDATE', 'granted_by_membership_id'),
      ('firm_api',   'membership_roles',   'UPDATE', 'granted_at'),
      ('firm_api',   'membership_roles',   'UPDATE', 'revoked_at'),
      ('portal_api', 'client_devices',     'INSERT', 'fingerprint_hash'),
      ('portal_api', 'client_devices',     'UPDATE', 'label'),
      ('portal_api', 'client_devices',     'UPDATE', 'last_seen_at'),
      ('portal_api', 'client_devices',     'UPDATE', 'mfa_trusted'),
      ('portal_api', 'client_devices',     'UPDATE', 'trusted_until')
    ) as t(role_name, table_name, op, column_name)
  loop
    if not has_column_privilege(r.role_name, 'public.' || r.table_name, r.column_name, r.op) then
      missing := missing || (r.role_name || ' ' || r.op || ' ' || r.table_name || '.' || r.column_name);
    end if;
  end loop;

  if array_length(missing, 1) > 0 then
    raise exception 'upsert grants still missing (%): %', array_length(missing, 1), array_to_string(missing, ', ');
  end if;

  raise notice 'both halves of all three upserts are granted to the role that runs them.';
end $$;
