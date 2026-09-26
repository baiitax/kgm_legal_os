/*
  0057 · COUNTING WHAT THE RING WITHHELD, WITHOUT HANDING IT OVER
  ─────────────────────────────────────────────────────────────────────────────────────────

  WHY THIS MIGRATION EXISTS, IN ONE PARAGRAPH
  0054 made the privilege ring a DATABASE rule: a restrictive policy on `documents`
  means a member outside the ring is not merely shown fewer rows — the rows are not
  in the result set at all. That is the right place for the rule. It also created a
  reporting problem the moment a screen tried to be honest about it: a list that is
  short because the database refused three rows is indistinguishable, from inside
  the application, from a matter that holds nothing. The member concludes the firm
  lost a file. The panel cannot say "three documents are withheld from you" because
  it cannot count what it cannot read.

  THE SHAPE OF THE ANSWER is the one P0.5 already uses for `matters.internal_notes`:
  a `security definer` function that is the ONLY door to a fact the application role
  cannot reach for itself. It returns a NUMBER and nothing else — no titles, no
  identifiers, no sizes. The member learns that material exists on their own matter
  and that the ring is why they cannot read it, which is the disclosure §57's
  withheld mechanism makes on purpose and which القاعدة الحادية والعشرون does not
  prohibit: the existence of the firm's own advice on the firm's own file, told to
  the firm's own staff, is not the advice.

  WHAT IT REFUSES, AND WHY EACH REFUSAL IS SEPARATE
    · not in a firm phase            → `firm_only`   (the portal must never reach it)
    · matter in another tenant       → `matter_out_of_scope`
    · matter outside the member's    → `matter_out_of_scope`  (same token: an
      practice area or team scope        outsider must not be able to tell a
                                         forbidden matter from a missing one)
  The caller is a ROUTE that has already resolved the ring, and it asks this
  function only when the answer it wants is "how many are hidden from you". A member
  in the ring is shown the documents themselves and never calls it.

  THE DIALECT ASYMMETRY, STATED SO IT IS NOT DISCOVERED LATER
  SQLite has no RLS and no definer functions, so the demo engine filters privileged
  documents in the repository — the same predicate, in the same place, written down
  once more. Both roads must produce the same number on the wire, and the suite
  asserts the number on SQLite while the live harness asserts it on Postgres.

  HOW TO APPLY
    node supabase/ops/dry-run.mjs 0057       # parse + roll back
    node supabase/ops/migrate.mjs            # apply
*/

-- ── 1 · THE FUNCTION ─────────────────────────────────────────────────────────────
create or replace function public.firm_count_matter_privileged_documents(p_matter uuid)
returns integer
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.kgm_tenant();
  v_count  integer;
begin
  /*
    THE FIRM PHASE IS ASSERTED, NOT ASSUMED.

    Every other policy in this schema is phase-gated and this function is the one
    place a `security definer` body reads a table without RLS narrowing it, so the
    phase check cannot be left to the caller: a portal session that somehow reached
    this route would be counted the firm's privileged material.
  */
  if not public.kgm_is_firm() then
    raise exception 'privilege_ring_refused: firm_only'
      using errcode = 'check_violation';
  end if;

  /* `matter_visible` is tenant AND access level, so this one predicate covers both
     refusals above and gives them the same name — which is the point. */
  if not public.matter_visible(p_matter) then
    raise exception 'privilege_ring_refused: matter_out_of_scope'
      using errcode = 'check_violation';
  end if;

  select count(*) into v_count
    from public.documents d
   where d.matter_id = p_matter
     and d.tenant_id = v_tenant
     and d.privilege_class <> 'none';

  return coalesce(v_count, 0);
end $$;

comment on function public.firm_count_matter_privileged_documents(uuid) is
  'P0.5/task-24 · How many privileged documents a matter holds. Returns a COUNT and '
  'nothing else, so a member outside the ring can be told that material is withheld '
  'instead of being shown a short list they cannot interpret. The only door to that '
  'fact, because 0054''s restrictive policy withholds the rows themselves.';

-- ── 2 · THE GRANT ────────────────────────────────────────────────────────────────
/*
  EXECUTE to the application role and to nobody else. `public` is revoked first: in
  PostgreSQL a function is EXECUTE-able by PUBLIC unless that is taken away, and a
  definer function that reads every document in the firm is not something to leave
  on the default.
*/
revoke all on function public.firm_count_matter_privileged_documents(uuid) from public;
grant execute on function public.firm_count_matter_privileged_documents(uuid) to firm_api;

-- ── 3 · VERIFICATION · THE MIGRATION REFUSES TO APPLY IF IT IS WRONG ─────────────
do $$
declare
  v_security_definer boolean;
  v_owner            text;
  v_public_execute   boolean;
  v_firm_execute     boolean;
begin
  /* (a) It must be SECURITY DEFINER. A plain function would be filtered by the very
     policy it exists to see past, and would return 0 for every outside-ring member —
     a silent wrong answer, which is worse than an error. */
  select p.prosecdef, r.rolname
    into v_security_definer, v_owner
    from pg_proc p join pg_roles r on r.oid = p.proowner
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'firm_count_matter_privileged_documents';

  if v_security_definer is null then
    raise exception '0057: firm_count_matter_privileged_documents was not created';
  end if;
  if not v_security_definer then
    raise exception '0057: the count function is NOT security definer — it would count nothing';
  end if;

  /* (b) PUBLIC must not hold EXECUTE. Checked through the ACL rather than by
     re-reading the statement, because `revoke all … from public` is exactly the line
     that is easy to omit and impossible to notice. */
  select exists (
    select 1 from aclexplode(coalesce(
      (select proacl from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname = 'firm_count_matter_privileged_documents'), '{}'::aclitem[])
    ) a
    where a.grantee = 0 and a.privilege_type = 'EXECUTE'
  ) into v_public_execute;
  if v_public_execute then
    raise exception '0057: PUBLIC can execute the privileged-document counter';
  end if;

  /* (c) …and the application role must. */
  select has_function_privilege('firm_api',
    'public.firm_count_matter_privileged_documents(uuid)', 'EXECUTE')
    into v_firm_execute;
  if not v_firm_execute then
    raise exception '0057: firm_api cannot execute the counter it is supposed to call';
  end if;

  /* (d) The function must NOT be reachable by the client-facing role. A portal
     session that could count the firm's privileged documents on its own matter would
     be told the firm withholds advice from it — which is a disclosure about the
     firm's practices, and one this product does not make. */
  if has_function_privilege('portal_api',
       'public.firm_count_matter_privileged_documents(uuid)', 'EXECUTE') then
    raise exception '0057: portal_api can execute the privileged-document counter';
  end if;

  raise notice '0057 ok: counter created (definer=%, owner=%), firm_api may execute, PUBLIC may not',
    v_security_definer, v_owner;
end $$;
