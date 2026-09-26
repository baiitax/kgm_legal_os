-- 0061 — THE FIRM WRITES ITS OWN DOCUMENTS
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
--
-- The client portal could upload a document; the firm could not. `firm_api` held
-- SELECT on `documents` and nothing else, and both firm policies on the table are
-- shaped for READING:
--
--   firm_matter_scope           PERMISSIVE ALL   using (matter_visible) with check (false)
--   documents_firm_privileged_ring  RESTRICTIVE ALL  using/check (privilege_class='none' or ring)
--
-- `with check (false)` is the honest way to say "the firm reads this table and
-- never writes it", and it was correct while it was true. The cost is what the gap
-- analysis called the largest unblocker in the product:
--
--   · the documents tab is a list with no way to put anything in it;
--   · a conflict waiver cannot be attached to the check that relied on it, so
--     Rule 8's waiver is a value in a column rather than a document on a file;
--   · the engagement letter (Rule 12) has nowhere to live — the gate reads
--     `engagement_letters`, and the paper it rests on ("the whole point of the
--     engagement gate is that it rests on a writing") cannot be uploaded;
--   · "the current signed contract" is unanswerable, because a new version of a
--     document cannot be written either.
--
-- ============================================================================
-- THE TWO POLICIES, AND WHAT EACH ONE IS ALLOWED TO SEE
-- ============================================================================
--
-- INSERT — a firm document is a MATTER document.
--
--   `matter_id is not null` is a deliberate restriction, not an omission. A
--   document with no matter would have to be scoped through its CLIENT, and 0060
--   has just widened the client read path to include clients the firm added and
--   has no file for. Allowing matter-less firm documents would mean the document
--   table inherits that window: an upload could be attached to a client the
--   member can see but has no file with, and the file where it belongs would not
--   exist yet. Every writing this phase exists to support — a waiver, an
--   engagement letter, a signed contract, a court filing — belongs to a matter.
--   The client-level document is the PORTAL's concept (a client uploads their CR
--   before any matter exists) and it stays reachable through the portal pipeline.
--
--   `origin = 'firm'` is asserted here as well as in the service. `assert_document_readable`
--   already refuses a client-originated document marked internal, and this policy
--   refuses a firm document that claims to be client-originated — the two directions
--   of the same confusion.
--
-- UPDATE — release, restrict, re-file, archive.
--
--   The USING clause is the read rule (`matter_visible`), so a member can only
--   change a document on a matter they can already see. The WITH CHECK repeats the
--   tenant, because USING and WITH CHECK answer different questions and a policy
--   that states only the first lets a row MOVE out of the tenant on update.
--
--   THE RING IS NOT TOUCHED BY THIS FILE. `documents_firm_privileged_ring` is
--   RESTRICTIVE, and restrictive policies are ANDed with the permissive ones — so
--   a member outside the ring still cannot insert or update anything with a
--   privilege_class other than 'none', whatever these policies say. That is the
--   whole point of writing it restrictively, and §(b) below asserts it is still
--   restrictive, because flipping it to permissive would silently OR it away and
--   nothing else in the system would notice.
--
-- ============================================================================
-- NOT GRANTED, ON PURPOSE
-- ============================================================================
--
--   · DELETE. A document is evidence of a relationship; the way to remove one is
--     to archive it, and the way to destroy one is the retention schedule (P1.5)
--     showing its authority. Nothing in the firm API deletes a document.
--   · `storage_key`, after insert. The object's path is server-generated at upload
--     and immutable thereafter: an UPDATE on it would be a way to point a row at
--     another tenant's object.
--   · `sha256`, `size_bytes`, `mime_type`, `origin`, `version` after insert. These
--     describe bytes that have already been written. A row whose hash can be
--     edited is a row whose integrity means nothing.
--
-- ============================================================================

begin;

/* ── 1 · THE VERSION CHAIN (P2.6, and it belongs to this table) ──────────────── */

alter table public.documents
  add column if not exists supersedes_document_id uuid
    references public.documents(id) on delete set null;

comment on column public.documents.supersedes_document_id is
  'The version this row replaces. A new version is a NEW ROW pointing at the old one, '
  'never an edit: the old bytes stay readable, so "what was the client given in March" '
  'remains answerable. Chains are linear and a row may be superseded at most once.';

create index if not exists documents_supersedes_idx
  on public.documents(supersedes_document_id)
  where supersedes_document_id is not null;

/* ── 2 · THE WRITES ──────────────────────────────────────────────────────────── */

grant insert (id, tenant_id, client_id, matter_id, storage_bucket, storage_key,
              original_filename, stored_filename, title, title_ar, document_type,
              category, origin, version, mime_type, size_bytes, sha256, scan_status,
              scan_result, scanned_at, status, client_visibility, privilege_class,
              requested, request_note, request_note_ar, uploaded_by_staff_id,
              supersedes_document_id, created_at, updated_at)
  on public.documents to firm_api;

grant update (title, title_ar, document_type, category, client_visibility, status,
              privilege_class, request_note, request_note_ar, supersedes_document_id,
              updated_at)
  on public.documents to firm_api;

/*
  INSERT. A firm document belongs to a matter the member can see, in the firm's own
  tenant, and says it came from the firm.
*/
drop policy if exists documents_firm_insert on public.documents;
create policy documents_firm_insert on public.documents
  for insert
  to firm_api
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and origin = 'firm'
    and matter_id is not null
    and public.matter_visible(matter_id)
  );

/*
  UPDATE. Released to the client, restricted from them, re-filed, archived — the
  four things the firm does to a document that already exists.
*/
drop policy if exists documents_firm_update on public.documents;
create policy documents_firm_update on public.documents
  for update
  to firm_api
  using (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and matter_id is not null
    and public.matter_visible(matter_id)
  )
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

comment on policy documents_firm_insert on public.documents is
  'The firm may file a document on a matter it can see. Matter-scoped by design: a '
  'matter-less firm document would inherit the intake read window opened by 0060.';
comment on policy documents_firm_update on public.documents is
  'Release, restrict, re-file, archive. DELETE is deliberately not granted anywhere; '
  'the ring still narrows this (it is RESTRICTIVE) so a non-lawyer cannot touch a '
  'privileged document whatever this policy says.';

-- ── THE ASSERTIONS ───────────────────────────────────────────────────────────────

do $$
declare
  v_n   integer;
  v_ok  boolean;
begin
  /* (a) The writes are GRANTED, asked of the catalogue. `grant insert (...)` fails
     whole if a column name is misspelled, and this is what turns that into a
     visible error rather than a 500 the first time somebody files a document. */
  for v_n in
    select count(*) from (values ('INSERT'), ('UPDATE')) as t(priv)
     where not exists (
       select 1 from information_schema.column_privileges cp
        where cp.grantee = 'firm_api' and cp.table_name = 'documents'
          and cp.privilege_type = t.priv)
  loop
    if v_n > 0 then
      raise exception '0061: firm_api is missing a document write privilege';
    end if;
  end loop;

  /* (b) THE RING IS STILL RESTRICTIVE — the assertion this file exists for half of.
     A permissive ring policy would OR with the two above and grant every member of
     the firm access to privileged documents. Nothing else in the system would fail;
     the ring would simply stop being a ring. */
  select exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'documents'
       and policyname = 'documents_firm_privileged_ring'
       and permissive = 'RESTRICTIVE'
  ) into v_ok;
  if not v_ok then
    raise exception '0061: documents_firm_privileged_ring is no longer RESTRICTIVE — the ring is open';
  end if;

  /* (c) The two new policies exist, for the right command, to the right role. Asked
     of the catalogue rather than of the statements above, because a policy created
     for the wrong command still exists and still looks right in a diff. */
  select count(*) into v_n
    from pg_policies
   where schemaname = 'public' and tablename = 'documents'
     and roles::text like '%firm_api%'
     and ((policyname = 'documents_firm_insert' and cmd = 'INSERT')
       or (policyname = 'documents_firm_update' and cmd = 'UPDATE'));
  if v_n <> 2 then
    raise exception '0061: expected the two document write policies, found %', v_n;
  end if;

  /* (d) DELETE is not granted anywhere, and the firm still cannot rewrite the bytes'
     own description. */
  select exists (
    select 1 from information_schema.column_privileges
     where grantee = 'firm_api' and table_name = 'documents'
       and privilege_type = 'DELETE'
  ) into v_ok;
  if v_ok then
    raise exception '0061: firm_api holds DELETE on documents — removal must be a retention action';
  end if;

  select exists (
    select 1 from information_schema.column_privileges
     where grantee = 'firm_api' and table_name = 'documents'
       and column_name in ('storage_key', 'sha256', 'origin', 'version')
       and privilege_type = 'UPDATE'
  ) into v_ok;
  if v_ok then
    raise exception '0061: a byte-describing column became editable after insert';
  end if;

  /* (e) The version chain exists and is a real reference. */
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'documents'
       and column_name = 'supersedes_document_id'
  ) into v_ok;
  if not v_ok then
    raise exception '0061: supersedes_document_id is missing';
  end if;

  /* (f) The scan gate is still a trigger on this table. A file that can be made
     available without a clean scan is worse than no file at all. */
  select exists (
    select 1 from pg_trigger
     where tgrelid = 'public.documents'::regclass and tgname = 'document_readable_guard'
  ) into v_ok;
  if not v_ok then
    raise exception '0061: the malware-scan gate is no longer on documents';
  end if;
end $$;

commit;
