-- 0063 — THE FIRM READS A DOCUMENT, AND THE READ IS LOGGED
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
--
-- 0061 gave the firm the four writes it was missing. The fifth thing it needed was
-- the least dramatic and the first one a lawyer reaches for: OPENING THE DOCUMENT.
--
-- The route is new; the log row it must write is not. `document_access_log` has been
-- in the schema since the portal needed to answer "has the client opened what we sent
-- them", and it carries three rules in its own DDL:
--
--   accessor_kind  in ('client', 'staff', 'system')
--   action         in ('signed_url_issued', 'viewed', 'downloaded', 'upload_completed', 'access_denied')
--   id             generated always as identity
--
-- The firm's read failed on the FIRST of those, and it failed in the way this
-- codebase keeps meeting: not at review time. `firm_api` holds no privilege at all on
-- this table — the grants and the one non-portal policy are attached to `firm_os`, a
-- role from before the firm API existed — so the 500 did not even come from the
-- vocabulary. It came from `permission denied for table document_access_log`, and the
-- member saw "internal error" instead of the contract they were trying to read.
--
-- That is the failure mode worth naming precisely: THE FIRM COULD FILE A DOCUMENT AND
-- NOT OPEN IT. An audit trail that is only written when a write succeeds, and not when
-- a read succeeds, is not a record of who saw the client's papers.
--
-- ============================================================================
-- WHY THIS TABLE IS ALLOWED A FIRM WRITE, WHEN `audit_events` IS NOT
-- ============================================================================
--
-- `audit_events` is append-only and written through one logger; nothing else writes
-- it, and no route gets a grant so that "who saw this" cannot be edited after the
-- fact. This table is a different kind of record and is granted differently on
-- purpose:
--
--   · It is a per-document ACCESS history, read in place by the firm's document
--     panel and by the portal's "shared with you" view.
--   · The firm INSERTs to it and never UPDATEs or DELETEs — so the history can be
--     appended to and never rewritten, which is the same guarantee by a narrower
--     route than a grant on the audit log would give.
--   · The append is part of the READ path. If the read succeeds and the log cannot
--     be written, the request fails (documented in the service): a read the firm
--     cannot prove it made is not a read the firm should be allowed to make.
--
-- ============================================================================
-- WHAT EACH POLICY IS ALLOWED, AND WHY THE RING PROPAGATES FOR FREE
-- ============================================================================
--
-- INSERT — the member may record an access to a document they can already reach:
--
--     tenant matches, the document row exists IN THEIR TENANT, and its matter is
--     visible to them.
--
-- SELECT — the same expression, so the history they read back is the history of the
-- documents they are entitled to see, and no more.
--
-- THE SUBQUERY RUNS AS `firm_api`, WHICH IS THE PART WORTH PAUSING ON. It reads
-- `documents`, and `documents` carries `documents_firm_privileged_ring` as a
-- RESTRICTIVE policy — restrictive policies are ANDed, and they apply to a policy's
-- own subqueries too. So a member outside the ring cannot read the access log of a
-- privileged document, not because this file says so, but because the ring is real
-- and the subquery is subject to it. §(d) below asserts the ring is still restrictive,
-- because this policy's correctness rests on it the way 0061's did.
--
-- ============================================================================
-- NOT GRANTED, ON PURPOSE
-- ============================================================================
--
--   · UPDATE. An access history that can be edited answers no question.
--   · DELETE. Same, and more so.
--   · `id`, on INSERT. It is `generated always as identity`; naming it in the grant
--     would be the difference between the sequence deciding the row's identity and
--     the caller deciding it.
--
-- ============================================================================

begin;

/* ── 1 · THE APPEND, AND THE READ-BACK ───────────────────────────────────────── */

grant insert (document_id, tenant_id, accessor_kind, accessor_id, action, ip_hash, created_at)
  on public.document_access_log to firm_api;

grant select (id, document_id, tenant_id, accessor_kind, accessor_id, action, ip_hash, created_at)
  on public.document_access_log to firm_api;

/* ── 2 · THE TWO POLICIES ────────────────────────────────────────────────────── */

/*
  INSERT. The member records what they did to a document on a matter they can see.
  The document must already exist in their tenant — the FK would refuse a dangling row,
  but the FK says nothing about WHICH TENANT it dangles in, and this does.
*/
drop policy if exists doc_access_log_firm_insert on public.document_access_log;
create policy doc_access_log_firm_insert on public.document_access_log
  for insert
  to firm_api
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and exists (
      select 1
        from public.documents d
       where d.id = document_access_log.document_id
         and d.tenant_id = public.kgm_tenant()
         and d.matter_id is not null
         and public.matter_visible(d.matter_id)
    )
  );

/*
  SELECT. The history of a document the member can see, and only that. The ring narrows
  this by virtue of the subquery, not by a clause added here.
*/
drop policy if exists doc_access_log_firm_read on public.document_access_log;
create policy doc_access_log_firm_read on public.document_access_log
  for select
  to firm_api
  using (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and exists (
      select 1
        from public.documents d
       where d.id = document_access_log.document_id
         and d.tenant_id = public.kgm_tenant()
         and d.matter_id is not null
         and public.matter_visible(d.matter_id)
    )
  );

comment on policy doc_access_log_firm_insert on public.document_access_log is
  'The firm appends to a document''s access history for documents on matters it can '
  'see. No UPDATE and no DELETE anywhere: history is appended to, never rewritten.';
comment on policy doc_access_log_firm_read on public.document_access_log is
  'The firm reads back the access history of its own documents. The subquery runs as '
  'firm_api, so the RESTRICTIVE privilege ring on `documents` narrows this to the ring.';

-- ── THE ASSERTIONS ───────────────────────────────────────────────────────────────

do $$
declare
  v_ok boolean;
  v_n  integer;
begin
  /* (a) Both privileges are actually held — asked of the catalogue. `grant insert (...)`
     fails whole on a misspelled column, and this is what turns that into a named error
     here rather than a 500 the first time a member opens a contract. */
  for v_n in
    select count(*) from (values ('INSERT'), ('SELECT')) as t(priv)
     where not exists (
       select 1 from information_schema.column_privileges cp
        where cp.grantee = 'firm_api' and cp.table_name = 'document_access_log'
          and cp.privilege_type = t.priv)
  loop
    if v_n > 0 then
      raise exception '0063: firm_api is missing an access-log privilege';
    end if;
  end loop;

  /* (b) The two policies exist, for the right command, to the right role. */
  select count(*) into v_n
    from pg_policies
   where schemaname = 'public' and tablename = 'document_access_log'
     and roles::text like '%firm_api%'
     and ((policyname = 'doc_access_log_firm_insert' and cmd = 'INSERT')
       or (policyname = 'doc_access_log_firm_read' and cmd = 'SELECT'));
  if v_n <> 2 then
    raise exception '0063: expected the two access-log policies, found %', v_n;
  end if;

  /* (c) THE PORTAL DID NOT GAIN ANYTHING. Its policy is scoped to `portal_api` alone,
     and this file must not have widened it — a firm grant that also lands on the
     portal's role would be a client reading the firm's internal access history. */
  select exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'document_access_log'
       and policyname = 'doc_access_scope'
       and roles::text <> '{portal_api}'
  ) into v_ok;
  if v_ok then
    raise exception '0063: the portal access-log policy is no longer portal-only';
  end if;

  /* (d) THE RING IS STILL RESTRICTIVE. Both policies above lean on it through their
     subquery; a permissive ring would OR it away and the narrowing would silently
     become decorative. */
  select exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'documents'
       and policyname = 'documents_firm_privileged_ring'
       and permissive = 'RESTRICTIVE'
  ) into v_ok;
  if not v_ok then
    raise exception '0063: documents_firm_privileged_ring is no longer RESTRICTIVE — the ring is open';
  end if;

  /* (e) History is append-only for the firm: no UPDATE, no DELETE, and the identity
     column is not the caller's to set. */
  select exists (
    select 1 from information_schema.column_privileges
     where grantee = 'firm_api' and table_name = 'document_access_log'
       and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
  ) into v_ok;
  if v_ok then
    raise exception '0063: firm_api gained a privilege over access history beyond appending to it';
  end if;

  select exists (
    select 1 from information_schema.column_privileges
     where grantee = 'firm_api' and table_name = 'document_access_log'
       and column_name = 'id' and privilege_type = 'INSERT'
  ) into v_ok;
  if v_ok then
    raise exception '0063: firm_api may name the identity column — the sequence owns it';
  end if;

  /* (f) The vocabulary the service writes against is the vocabulary the table enforces.
     The 500 that produced this file was an accessor_kind outside the CHECK, and a
     constraint that drifts from the code that writes it is how that happens twice. */
  select exists (
    select 1 from pg_constraint
     where conrelid = 'public.document_access_log'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%accessor_kind%'
       and pg_get_constraintdef(oid) like '%staff%'
  ) into v_ok;
  if not v_ok then
    raise exception '0063: document_access_log no longer admits staff accessors';
  end if;
end $$;

commit;
