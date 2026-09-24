-- 0010 — GRANT THE UPDATE COLUMNS THE DYNAMIC WRITE PATHS ACTUALLY SET
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
-- 0009 fixed the portal's READS. Sign-in then failed on its second statement:
--
--     Repo.updateUser  ->  permission denied for table users
--
-- Four repository methods build their SET clause at runtime from a JavaScript
-- allow-list:
--
--     repo.ts:113  updateUser              -> users        (15 columns + updated_at)
--     repo.ts:162  updateClientProfile     -> clients      (4 columns  + updated_at)
--     repo.ts:178  updateClientUserDisplay -> client_users (4 columns  + updated_at)
--     firm-repo.ts:191 updateUserAuthState -> users        (+ updated_at)
--
-- Because the column names never appear in a SQL string, no amount of reading the
-- queries finds them — `reconcile_column_grants.mjs` scans SQL text and correctly
-- reported only the two write findings it could see. The names live in a `Set`,
-- which is precisely where a hand-maintained grant list stops matching the code.
--
-- MEASURED, as `portal_api`, before this migration:
--
--     users         UPDATE missing: last_login_ip_hash, updated_at
--     clients       UPDATE missing: phone, address_line, city, country, updated_at
--     client_users  UPDATE missing: updated_at
--
-- `clients` held no UPDATE privilege at all, so saving a phone number from the
-- portal profile page failed the same way sign-in did.
--
-- ============================================================================
-- WHY EACH GRANT IS CORRECT
-- ============================================================================
-- users.last_login_ip_hash
--     Written on every successful sign-in to record where it came from — a salted
--     hash, never an address. 0004 granted UPDATE on eleven other auth-state
--     columns and omitted this one, which read as deliberate but was not: the
--     same method writes it, and without the grant nobody can sign in.
--
-- users.updated_at
--     Every one of the four builders appends `updated_at = ?` unconditionally,
--     including the two that write a hardcoded prefix. It is a modification
--     timestamp the role already reads and writes elsewhere.
--
-- clients.phone, address_line, city, country, updated_at
--     Exactly the set `updateClientProfile` permits, and exactly what its own
--     comment intends: "Phone/address only. name, client_type, national_id*,
--     tenant_id, status and identity_verified are firm-controlled (§25, §35 R11)."
--     This grant deliberately does NOT touch name, name_ar, client_type,
--     national_id_masked, national_id_hash, commercial_reg_masked, email,
--     identity_verified, verification_note, status or tenant_id. A client editing
--     their contact details remains unable to edit their legal identity, and the
--     database — not the allow-list — is what enforces that.
--
-- client_users.updated_at
--     Same as users.updated_at. 0004 already grants UPDATE on display_name,
--     display_name_ar, job_title and phone.
--
-- ============================================================================
-- WHAT IS DELIBERATELY NOT GRANTED
-- ============================================================================
-- `clients.updated_at` is granted, but `clients.status` is not — so a client
-- cannot reactivate themselves, and `client_scope`'s WITH CHECK would refuse it
-- even if the grant existed. No grant here widens any §57 column: internal_notes,
-- risk_rating, notes_internal, assigned_staff_id, internal_comment and
-- hearings.internal_status remain unreadable and unwritable, and section 2 below
-- asserts that.

-- ---------------------------------------------------------------------------
-- 1 · The dynamic write paths
-- ---------------------------------------------------------------------------
grant update (last_login_ip_hash, updated_at) on public.users to portal_api;

grant update (phone, address_line, city, country, updated_at)
  on public.clients to portal_api;

grant update (updated_at) on public.client_users to portal_api;

-- ---------------------------------------------------------------------------
-- 2 · Assert the outcome, and assert the boundary held.
-- ---------------------------------------------------------------------------
do $$
declare
  missing text;
begin
  -- The columns whose absence broke sign-in and the profile save.
  select string_agg(t || '.' || c, ', ') into missing
    from (values
      ('users', 'last_login_ip_hash'), ('users', 'updated_at'),
      ('clients', 'phone'), ('clients', 'address_line'),
      ('clients', 'city'), ('clients', 'country'),
      ('client_users', 'updated_at')
    ) as x(t, c)
   where not has_column_privilege('portal_api', 'public.' || t, c, 'UPDATE');

  if missing is not null then
    raise exception 'portal_api still cannot UPDATE % — login/profile saves will fail.', missing;
  end if;

  /*
    The §25 / §35 R11 boundary: a client may change how to reach them, never who
    they are. These are the columns the firm controls, and a grant here would be a
    privilege escalation the application layer is not supposed to be the only
    guard against.
  */
  select string_agg(c, ', ') into missing
    from unnest(array['name', 'name_ar', 'client_type', 'national_id_masked',
                      'national_id_hash', 'commercial_reg_masked', 'email',
                      'identity_verified', 'verification_note', 'status', 'tenant_id']) c
   where has_column_privilege('portal_api', 'public.clients', c, 'UPDATE');

  if missing is not null then
    raise exception 'portal_api can UPDATE firm-controlled clients column(s): %', missing;
  end if;

  -- §57 must remain untouched by an UPDATE-granting migration.
  select string_agg(t || '.' || c, ', ') into missing
    from (values
      ('matters', 'risk_rating'), ('matters', 'internal_notes'),
      ('invoices', 'notes_internal'), ('deadlines', 'assigned_staff_id'),
      ('deadlines', 'internal_comment'), ('hearings', 'internal_status'),
      ('messages', 'internal_note')
    ) as x(t, c)
   where has_column_privilege('portal_api', 'public.' || t, c, 'SELECT')
      or has_column_privilege('portal_api', 'public.' || t, c, 'UPDATE');

  if missing is not null then
    raise exception 'portal_api can reach internal column(s): %', missing;
  end if;

  raise notice 'portal_api update grants reconciled; §25/§57 boundaries intact.';
end $$;
