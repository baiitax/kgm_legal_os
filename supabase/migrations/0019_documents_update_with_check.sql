-- ============================================================================
-- KGM LEGAL OS · 0019 — DOCUMENTS UPDATE: A WITH CHECK MUST HOLD AFTER THE WRITE
-- ============================================================================
-- 0018 split the documents policy per command, and got the UPDATE half wrong in a
-- way that is worth recording, because it is the same mistake as the one it was
-- fixing — one step further along.
--
-- 0018's UPDATE branch reads:
--
--   using      (... and ((origin = 'client' and uploaded_by_user_id = kgm_user())
--                        or requested = true))
--   with check (SAME EXPRESSION)
--
-- The fulfilment path is precisely the one that sets `requested = false`:
--
--   update documents set requested = FALSE, updated_at = ? where id = ? ...
--
-- So the row passes USING (it was requested of this client), and then the NEW row
-- fails WITH CHECK, because the condition that admitted it is the condition the
-- statement just removed. Live result, unchanged from before the fix:
--
--   new row violates row-level security policy for table "documents"
--
-- USING and WITH CHECK are not the same predicate and must not be copy-pasted.
-- USING decides which existing row may be touched. WITH CHECK decides what the row
-- may look like afterwards. A transition that clears the flag it was admitted by
-- can never satisfy a WITH CHECK that restates it.
--
-- THE CORRECTION
--   USING      — the row being targeted must be the caller's own upload, or a
--                document the firm asked them for. Unchanged from 0018: this is
--                what stops a client touching a document that is merely visible.
--   WITH CHECK — the row must still be in the caller's tenant and client scope,
--                and must still be client-visible. `requested` is deliberately
--                NOT re-asserted, because clearing it is the operation.
--
-- WHY dropping `requested` from WITH CHECK is safe
--   The column cannot be moved to a document the client should not have, because
--   USING already restricted the target to the client's own upload or a document
--   requested of them. And the columns an UPDATE can touch at all are bounded by
--   the grant, not by the policy: portal_api holds UPDATE on exactly
--   scan_result, scan_status, scanned_at, status, title, title_ar, requested and
--   updated_at (0016). `origin`, `client_id`, `tenant_id` and `uploaded_by_user_id`
--   are not in that list and cannot be rewritten at all — which is also why the
--   WITH CHECK does not need to pin them.
-- ============================================================================

drop policy if exists document_scope_update on public.documents;

create policy document_scope_update on public.documents
  for update to portal_api
  using (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and client_visibility = 'visible'
    and ((origin = 'client' and uploaded_by_user_id = kgm_user()) or requested = true)
  )
  with check (
    -- Deliberately NOT a copy of USING: the fulfilment path clears `requested`,
    -- so the post-state must be judged on what must still be true, not on what
    -- admitted the row.
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and client_visibility = 'visible'
  );

-- ============================================================================
-- VERIFY
-- ============================================================================
do $$
declare
  u text;
  w text;
begin
  select qual into u from pg_policies where schemaname = 'public' and tablename = 'documents'
    and policyname = 'document_scope_update';
  select with_check into w from pg_policies where schemaname = 'public' and tablename = 'documents'
    and policyname = 'document_scope_update';

  if u is null or w is null then
    raise exception 'document_scope_update is missing a USING or WITH CHECK expression';
  end if;

  -- The target restriction must survive.
  if u not like '%requested = true%' or u not like '%origin = ''client''%' then
    raise exception 'the UPDATE target restriction was lost: %', u;
  end if;

  -- The with-check must NOT restate `requested`, or fulfilment breaks again.
  if w like '%requested = true%' then
    raise exception 'WITH CHECK re-asserts requested — clearing the flag will violate it again';
  end if;

  -- Scope must still be re-asserted on the post-state.
  if w not like '%kgm_tenant()%' or w not like '%kgm_clients()%' then
    raise exception 'WITH CHECK no longer pins tenant and client scope: %', w;
  end if;

  -- And no predicate may have silently disappeared from the rewrite.
  if u not like '%kgm_phase()%' or w not like '%kgm_phase()%' then
    raise exception 'the portal-phase predicate is missing from USING or WITH CHECK';
  end if;

  raise notice 'documents UPDATE: target restricted, post-state scope pinned, requested free to clear.';
end $$;
