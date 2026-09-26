/*
  0056 · WHAT THE RELEASE LEDGER'S DOCUMENT REFERENCES MEAN
  ─────────────────────────────────────────────────────────────────────────────────────────

  0054 gave `privilege_releases` two document references, and the foreign keys it wrote
  prove only that each one EXISTS. They do not prove that the document is the one the
  release claims to rest on:

    · `document_id` is the material being released. It must be a document OF THIS MATTER.
      Without that rule a release could record the disclosure of a document belonging to a
      different file — or to a different firm on the same SaaS — and the ledger would say a
      disclosure happened that did not.

    · `consent_document_id` is the writing that carries the CLIENT's consent, which is what
      القاعدة الحادية والعشرون permits disclosure on. It must belong to the same CLIENT as
      the matter (a client may sign on any of their files) and to the same firm.

  This is the same defect class the project keeps meeting: a constraint that exists, is
  spelled correctly, and does not mean what its name says. An FK answers "does this row
  exist"; the question a regulator asks of this ledger is "is this the document".

  THE RULE IS STATED THREE TIMES, ON PURPOSE, AND ALL THREE SAY THE SAME THING:
  the route (a named 400 before the insert), this function (the ledger's own opinion, for
  anybody who arrives with a psql prompt rather than a browser), and the SQLite mirror's
  triggers (the dialect that has no definer functions). Defect (o) — one rule, three
  copies, drifted — is why the token is identical in all three: `privilege_document_mismatch`.

  HOW TO APPLY
    node supabase/ops/dry-run.mjs 0056       # parse + roll back
    node supabase/ops/migrate.mjs            # apply
*/

-- ── 1 · THE GUARD, RESTATED WITH THE TWO SCOPE CHECKS ───────────────────────────
create or replace function public.privilege_release_guard() returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text;
  v_client uuid;
begin
  if new.tenant_id <> public.kgm_tenant() then
    raise exception 'privilege_ring_refused: tenant_mismatch' using errcode = 'check_violation';
  end if;
  if not public.matter_visible(new.matter_id) then
    raise exception 'privilege_ring_refused: matter_out_of_scope' using errcode = 'check_violation';
  end if;

  v_reason := public.kgm_lawyer_ring_reason(public.kgm_membership());
  if v_reason <> 'in_ring' then
    raise exception 'privilege_ring_refused: %', v_reason using errcode = 'check_violation';
  end if;
  if new.released_by_membership_id <> public.kgm_membership() then
    raise exception 'privilege_ring_refused: release_must_name_the_member_who_made_it'
      using errcode = 'check_violation';
  end if;

  /* The matter is real, is in this tenant, and is visible — so its client is the client
     whose consent this ledger may rest on. A matter that resolves to no client is a matter
     this release cannot be about. */
  select m.client_id into v_client
    from public.matters m
   where m.id = new.matter_id and m.tenant_id = new.tenant_id;
  if v_client is null then
    raise exception 'privilege_ring_refused: matter_out_of_scope' using errcode = 'check_violation';
  end if;

  if new.document_id is not null
     and not exists (
       select 1 from public.documents d
        where d.id = new.document_id
          and d.tenant_id = new.tenant_id
          and d.matter_id = new.matter_id
     ) then
    raise exception 'privilege_document_mismatch: documentId — the document being released is not a document of this matter'
      using errcode = 'check_violation';
  end if;

  if new.consent_document_id is not null
     and not exists (
       select 1 from public.documents d
        where d.id = new.consent_document_id
          and d.tenant_id = new.tenant_id
          and d.client_id = v_client
     ) then
    raise exception 'privilege_document_mismatch: consentDocumentId — the document named as the client''s written consent is not a document of this client'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

comment on function public.privilege_release_guard() is
  'P0.5 · a release names a ground, is made by the member in the ring who signed it, and rests on documents that belong where it says they do.';

-- The trigger already points at this function (`pg_trigger.tgfoid` is unchanged by
-- `create or replace`), but it is re-created so that a database where the wiring was lost
-- is repaired by applying the migration rather than by reading it.
drop trigger if exists privilege_releases_guard on public.privilege_releases;
create trigger privilege_releases_guard
  before insert on public.privilege_releases
  for each row execute function public.privilege_release_guard();

-- ── 2 · VERIFY, AND TRY TO BREAK IT ─────────────────────────────────────────────
do $$
declare
  src      text;
  n_trig   integer;
  n_tokens integer;
  refused  boolean;
begin
  /* (a) The function carries BOTH refusals. Asserted on the deployed source, because a
     `create or replace` on a near-miss name silently makes a second function (P0.4's
     lesson) and because the migration's whole content is these two sentences. */
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'privilege_release_guard';
  if src is null then
    raise exception '0056: privilege_release_guard is missing';
  end if;
  n_tokens := (length(src) - length(replace(src, 'privilege_document_mismatch', '')))
              / length('privilege_document_mismatch');
  if n_tokens <> 2 then
    raise exception '0056: the guard carries % document-scope refusal(s), expected 2', n_tokens;
  end if;

  /* (b) And the ledger has exactly one guard, wired to that function. */
  select count(*) into n_trig
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.privilege_releases'::regclass
     and not t.tgisinternal
     and p.proname = 'privilege_release_guard';
  if n_trig <> 1 then
    raise exception '0056: privilege_releases has % guard trigger(s), expected 1', n_trig;
  end if;

  /* (c) THE FUNCTION'S OWN OPINION, PROVED BY ASKING FOR IT. A release naming a document
     that does not exist must be REFUSED, not accepted: the FK would eventually say so, but
     the point of the guard is that the refusal is the ledger's own answer, raised before any
     constraint is consulted. The UUIDs are random on purpose — this block must not depend on
     any demo row surviving. Both accepted refusals are the guard's (`check_violation`) and
     the FK's (`foreign_key_violation`): with no `kgm.*` GUCs set in a migration session the
     guard refuses the matter before it reaches the document, and the assertion that matters
     is that nothing was written. */
  refused := false;
  begin
    insert into public.privilege_releases
      (tenant_id, matter_id, document_id, subject_kind, ground, recipient_kind,
       recipient_name, released_by_membership_id)
    values
      (public.kgm_tenant(), gen_random_uuid(), gen_random_uuid(),
       'document', 'self_defence', 'court', '0056 probe', gen_random_uuid());
    raise exception '0056: a release naming a document that does not exist was accepted';
  exception
    when check_violation then refused := true;
    when foreign_key_violation then refused := true;
  end;
  if not refused then
    raise exception '0056: the ledger accepted a release it should have refused';
  end if;

  raise notice '0056 applied: a release rests on documents that belong where it says — the '
               'matter for the subject, the client for the consent.';
end $$;
