-- ═══════════════════════════════════════════════════════════════════════════════
-- 0044 · ONE GATE, NOT TWO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 0043 restated the due-diligence gate and installed it as `matters_cdd_gate` — a name
-- that differs from 0040's `matter_cdd_gate` by one letter. Postgres therefore kept BOTH
-- triggers on `public.matters`. Two triggers of the same kind fire in name order, so
-- `matter_cdd_gate` — the 0040 text, before the natural-person rule and before the
-- subject set stopped depending on verification — ran FIRST and answered every question
-- the corrected rule was written to answer. The correction was inert, and the only reason
-- it was noticed is that the tables were asked which triggers they carry rather than the
-- migration being trusted.
--
-- THIS IS THE SAME MISTAKE AS THE CREDIT-NOTE GUARD IN 0039, in a different costume: a
-- correction that is present, applied, verified in the sense that it ran — and not in
-- force. The lesson generalises past triggers: when a rule is restated, the thing being
-- replaced has to be NAMED EXACTLY. A near-miss name is a silent duplicate.
--
-- The single trigger is created under the name the SQLite mirror uses, so the two
-- dialects can be compared by name as well as by rule.
-- ═══════════════════════════════════════════════════════════════════════════════

drop trigger if exists matters_cdd_gate on public.matters;
drop trigger if exists matter_cdd_gate on public.matters;

create trigger matter_cdd_gate
  before update on public.matters
  for each row execute function public.matter_cdd_gate();

comment on trigger matter_cdd_gate on public.matters is
  'The client due-diligence gate (P0.3): refuses the transition into `active` unless the client is identified, the persons behind it are identified as people, and every subject is screened and resolved.';

-- ── VERIFY ──────────────────────────────────────────────────────────────────────
do $$
declare
  n integer;
begin
  -- Exactly one, on the right function, and no near-miss duplicate beside it.
  select count(*) into n
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_proc p on p.oid = t.tgfoid
   where not t.tgisinternal and c.relname = 'matters'
     and p.proname = 'matter_cdd_gate';
  if n <> 1 then
    raise exception '0044: % triggers run the due-diligence gate on matters; there must be exactly one', n;
  end if;

  select count(*) into n
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
   where not t.tgisinternal and c.relname = 'matters' and t.tgname like '%cdd%';
  if n <> 1 then
    raise exception '0044: % triggers on matters mention cdd — a near-miss name is a duplicate gate', n;
  end if;

  raise notice '0044 applied: one gate, and it is the one that was corrected.';
end $$;
