-- 0064 — THE DEFAULT THAT THE CHECK REFUSES
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
--
-- `documents.category` was declared like this:
--
--   category text not null default 'other'
--   constraint documents_category_check check (category in
--     ('from_firm','requested','uploaded','signed','court','financial'))
--
-- The DEFAULT IS NOT IN THE CHECK. Any INSERT that omits the column fails — and it fails
-- with "new row for relation documents violates check constraint
-- documents_category_check", which tells the caller that a value is wrong without saying
-- which column or what the six right answers are. The column meanwhile reads as though
-- the database will fill it in.
--
-- Nothing has hit it yet, and that is exactly why it survived: the portal always writes
-- 'uploaded' or 'requested', and the firm's filing writes 'from_firm'. It surfaced the
-- first time the firm's new document route was driven by a harness that passed a category
-- the CHECK does not admit — a 500 where a 400 belongs.
--
-- ============================================================================
-- WHY THE DEFAULT IS REMOVED RATHER THAN THE CHECK WIDENED
-- ============================================================================
--
-- The other repair was to add 'other' to the vocabulary. It is rejected here on purpose:
-- these six words are PROVENANCE — where the paper came from — and 'other' says nothing
-- about that. A reviewer asking "did this come from the firm, from the client, from the
-- court, or was it signed" is answered by every legal value and by none of 'other'.
--
-- Widening a vocabulary to accommodate a default is also the wrong direction of change:
-- the default exists for the writer who did not think about provenance, and the honest
-- answer to that writer is to be told so — by a NOT NULL violation that names the column,
-- not by being handed a category that means nothing.
--
-- WHAT REPLACES IT IS IN THE SERVICE, NOT IN A DEFAULT. `DOCUMENT_CATEGORIES` in
-- `domain/firm-documents.ts` is the same six words, and both write paths validate against
-- it before the INSERT, so the API answers 400 with `allowed: [...]`. The constraint
-- remains as the last line — a vocabulary with two enforcement points, which is the
-- pattern the rest of the document layer already follows.
--
-- ============================================================================

begin;

alter table public.documents alter column category drop default;

comment on column public.documents.category is
  'Provenance: where the paper came from (firm, client, court, signed, financial). NOT '
  'defaulted — a document whose provenance nobody chose should be refused, not guessed at. '
  'The six values mirror documents_category_check and DOCUMENT_CATEGORIES in the service.';

-- ── THE ASSERTIONS ───────────────────────────────────────────────────────────────

do $$
declare
  v_def text;
  v_ok  boolean;
  v_n   integer;
begin
  /* (a) There is no default any more — asked of the catalogue, because `drop default`
     on a column that never had one succeeds silently. */
  select column_default into v_def
    from information_schema.columns
   where table_schema = 'public' and table_name = 'documents' and column_name = 'category';
  if v_def is not null then
    raise exception '0064: documents.category still has a default: %', v_def;
  end if;

  /* (b) AND THE CHECK STILL EXISTS. Removing a default is a change to a column that the
     vocabulary guards; if an earlier migration had dropped the constraint, the two
     statements above would leave a free-text column that looks exactly like this one. */
  select exists (
    select 1 from pg_constraint
     where conrelid = 'public.documents'::regclass
       and conname = 'documents_category_check'
  ) into v_ok;
  if not v_ok then
    raise exception '0064: documents_category_check is missing — category is unconstrained';
  end if;

  /* (c) THE VOCABULARY IN THE CHECK IS THE VOCABULARY THE SERVICE VALIDATES AGAINST.
     Six words, and 'other' is not among them: this file's whole premise is that a
     default outside the CHECK was the defect, and widening the list would recreate it. */
  select count(*) into v_n
    from pg_constraint
   where conrelid = 'public.documents'::regclass
     and conname = 'documents_category_check'
     and pg_get_constraintdef(oid) not like '%other%'
     and pg_get_constraintdef(oid) like '%from_firm%'
     and pg_get_constraintdef(oid) like '%financial%';
  if v_n <> 1 then
    raise exception '0064: documents_category_check is no longer the six-value provenance vocabulary';
  end if;

  /* (d) NOT NULL is still declared. A dropped default on a nullable column would accept
     a document with no provenance at all, which is the failure this file removes one
     door short of. */
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'documents'
       and column_name = 'category' and is_nullable = 'NO'
  ) into v_ok;
  if not v_ok then
    raise exception '0064: documents.category became nullable';
  end if;

  /* (e) Every row that exists is already inside the vocabulary — so this migration can
     never be the reason a later read fails. */
  select exists (
    select 1 from public.documents
     where category not in ('from_firm','requested','uploaded','signed','court','financial')
  ) into v_ok;
  if v_ok then
    raise exception '0064: a row outside the provenance vocabulary exists already';
  end if;
end $$;

commit;
