-- ═══════════════════════════════════════════════════════════════════════════════
--  0046 · JUDGMENT REGISTER AND COURT CALENDAR — THE PERMISSION CATALOGUE (P0.4)
-- ═══════════════════════════════════════════════════════════════════════════════
--
--  WHY THIS IS A SEPARATE MIGRATION FROM 0045
--
--  `server/src/domain/firm-catalogue.ts` is GENERATED from the SQL that declares the
--  catalogue, and `tests/security/firm-rbac.test.ts` re-parses that SQL and fails on drift.
--  The generator's parser reads three blocks: the `permissions` insert, the `roles` insert,
--  and the `grants` CTE. It is deliberately narrow — it understands those three shapes and
--  nothing else, because a tolerant parser here would be a silent authorization bug.
--
--  So the new permissions live in their own migration, in EXACTLY those shapes, and the
--  parser learns to read more than one file. Nothing in 0006 is edited: 0006 is applied, and
--  an applied migration is a historical record of what the database was told, not a document
--  to be revised. The permissions arrive here, and the union of the two files is what the
--  TypeScript catalogue and the demo seed are generated from.
--
--  THE AUTHORITY MATRIX, AND WHY EACH LINE IS WHERE IT IS
--
--  | role             | read | record | serve | manage | calendar |
--  | MANAGING_PARTNER |  ✔   |   ✔    |   ✔   |   ✔    |  ✔ + ✔   |
--  | PARTNER          |  ✔   |   ✔    |   ✔   |   ✔    |  ✔       |
--  | LAWYER           |  ✔   |   ✔    |   ✔   |   ·    |  ✔       |
--  | ASSOCIATE        |  ✔   |   ·    |   ·   |   ·    |  ✔       |
--  | PARALEGAL        |  ✔   |   ·    |   ·   |   ·    |  ✔ + ✔   |
--  | OPERATIONS       |  ✔   |   ·    |   ·   |   ·    |  ✔ + ✔   |
--  | COMPLIANCE       |  ✔   |   ·    |   ·   |   ·    |  ✔       |
--  | FINANCE          |  ·   |   ·    |   ·   |   ·    |  ·       |
--  | ADMIN            |  ·   |   ·    |   ·   |   ·    |  ·       |
--
--  · `serve` IS SEPARATE FROM `record`, AND THE SPLIT IS THE POINT. Recording a صك is reading
--    a court document back into the file. Recording its DELIVERY is the fact that starts a
--    thirty-day period running — it is the one that has to be right, so it is the one that
--    gets its own permission.
--  · `manage` IS WHERE ENFORCEMENT OPENS. A lawyer who could record, serve and enforce could
--    commit the firm to using the state's power to collect while the client was still
--    deciding. The same instinct that separates `billing.create` from `billing.approve`.
--  · PARALEGAL AND OPERATIONS HOLD THE CALENDAR, LAWYERS DO NOT. Entering the Eid recess is
--    clerical work, and a period computed against an incomplete calendar is a period that is
--    wrong in the direction that hurts — the system would think a window had closed.
--  · COMPLIANCE READS THE REGISTER AND NOTHING ELSE. The firm's exposure is the compliance
--    officer's business; whether the firm serves a particular صك is not.
--  · FINANCE AND ADMIN HOLD NOTHING. A ledger is not a case file, and the enforcement
--    lifecycle is a legal posture rather than a financial record. FINANCE still sees
--    enforcement through `matters.read_all` and billing; it does not decide that a period
--    has been computed.
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.permissions (code, module, description, description_ar, sensitivity) values
  -- P0.4 · judgments, service and the court calendar.
  ('judgments.read','operations','View the judgment register','عرض سجل الأحكام','normal'),
  ('judgments.record','operations','Record a judgment (الصك)','تسجيل صك الحكم','elevated'),
  ('judgments.serve','operations','Record service of a judgment and accept the period it starts','تسجيل تبليغ الصك وقبول المدة المترتبة عليه','elevated'),
  ('judgments.manage','operations','Amend a judgment, its finality and stays, and open enforcement','تعديل بيانات الحكم ونهائيته وأوامر إيقاف التنفيذ وبدء التنفيذ','critical'),
  ('court_calendar.read','operations','View the court calendar','عرض تقويم أيام العمل القضائية','normal'),
  ('court_calendar.manage','operations','Manage court holidays and recesses','إدارة العطل والإجازات القضائية','normal')
on conflict (code) do nothing;

-- The templates are identified by code, exactly as 0006 does it, so that a template's id
-- changing would be a failure of this migration rather than a quietly different grant.
with template(id, code) as (values
  ('00000000-0000-4000-8000-0000000000a1'::uuid,'MANAGING_PARTNER'),
  ('00000000-0000-4000-8000-0000000000a2','PARTNER'),
  ('00000000-0000-4000-8000-0000000000a3','LAWYER'),
  ('00000000-0000-4000-8000-0000000000a4','ASSOCIATE'),
  ('00000000-0000-4000-8000-0000000000a5','PARALEGAL'),
  ('00000000-0000-4000-8000-0000000000a6','FINANCE'),
  ('00000000-0000-4000-8000-0000000000a7','COMPLIANCE'),
  ('00000000-0000-4000-8000-0000000000a8','ADMIN'),
  ('00000000-0000-4000-8000-0000000000a9','OPERATIONS')
), grants(code, perm) as (values
  ('MANAGING_PARTNER','judgments.read'),('MANAGING_PARTNER','judgments.record'),
  ('MANAGING_PARTNER','judgments.serve'),('MANAGING_PARTNER','judgments.manage'),
  ('MANAGING_PARTNER','court_calendar.read'),('MANAGING_PARTNER','court_calendar.manage'),
  ('PARTNER','judgments.read'),('PARTNER','judgments.record'),
  ('PARTNER','judgments.serve'),('PARTNER','judgments.manage'),
  ('PARTNER','court_calendar.read'),
  ('LAWYER','judgments.read'),('LAWYER','judgments.record'),
  ('LAWYER','judgments.serve'),('LAWYER','court_calendar.read'),
  ('ASSOCIATE','judgments.read'),('ASSOCIATE','court_calendar.read'),
  ('PARALEGAL','judgments.read'),('PARALEGAL','court_calendar.read'),
  ('PARALEGAL','court_calendar.manage'),
  ('OPERATIONS','judgments.read'),('OPERATIONS','court_calendar.read'),
  ('OPERATIONS','court_calendar.manage'),
  ('COMPLIANCE','judgments.read'),('COMPLIANCE','court_calendar.read')
)
insert into public.role_permissions (role_id, permission_code)
select t.id, g.perm
from grants g join template t on t.code = g.code
join public.permissions p on p.code = g.perm
on conflict do nothing;

-- ── AND THE TENANT'S OWN COPIES, WHICH ARE WHAT A MEMBERSHIP ACTUALLY HOLDS ─────
/*
  `roles` carries a template row per system role AND a copy per tenant, and a membership
  points at the COPY. 0006 grants the templates; whatever creates a tenant's copies is
  responsible for copying the grants — which is true for every tenant that existed when
  0006 ran and is exactly the thing that quietly stops being true for a permission added
  later. So this statement propagates the templates' grants onto every tenant copy, for
  every permission and not merely the six new ones: it is idempotent, and running the
  general rule rather than a special case is what stops the next migration from having to
  rediscover this.
*/
insert into public.role_permissions (role_id, permission_code)
select tenant_role.id, template_grant.permission_code
from public.roles tenant_role
join public.roles template on template.code = tenant_role.code and template.tenant_id is null
join public.role_permissions template_grant on template_grant.role_id = template.id
where tenant_role.tenant_id is not null
on conflict do nothing;

-- ── VERIFY ─────────────────────────────────────────────────────────────────────
do $$
declare
  n integer;
begin
  select count(*) into n from public.permissions
   where code in ('judgments.read','judgments.record','judgments.serve','judgments.manage',
                  'court_calendar.read','court_calendar.manage');
  if n <> 6 then
    raise exception '0046: % of the six P0.4 permissions were inserted', n;
  end if;

  /* Every system role copy in every tenant must carry the grants its template carries —
     checked as a set difference rather than by counting, because a count would pass with
     the wrong grants in it. */
  select count(*) into n
    from public.roles tenant_role
    join public.roles template on template.code = tenant_role.code and template.tenant_id is null
   where tenant_role.tenant_id is not null
     and exists (
       select 1 from public.role_permissions t
        where t.role_id = template.id
          and not exists (
            select 1 from public.role_permissions c
             where c.role_id = tenant_role.id and c.permission_code = t.permission_code));
  if n <> 0 then
    raise exception '0046: % tenant role copies are missing grants their template holds', n;
  end if;

  /* No role outside the matrix gained anything: FINANCE and ADMIN hold none of the six. */
  select count(*) into n
    from public.role_permissions rp
    join public.roles r on r.id = rp.role_id
   where r.code in ('FINANCE','ADMIN')
     and rp.permission_code in ('judgments.read','judgments.record','judgments.serve',
                                'judgments.manage','court_calendar.read','court_calendar.manage');
  if n <> 0 then
    raise exception '0046: FINANCE or ADMIN holds % judgment permission(s) — neither is case work', n;
  end if;

  raise notice '0046 applied: the register has its own permissions, serving is separate from recording, and enforcement belongs to a partner.';
end $$;
