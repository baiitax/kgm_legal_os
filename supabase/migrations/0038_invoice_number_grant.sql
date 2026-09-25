-- ═══════════════════════════════════════════════════════════════════════════════
--  0038 · THE OFFICIAL NUMBER, AND THE COLUMN THAT WAS NOT GRANTED
--
--  WHAT THIS FIXES
--
--  Migration 0034 gave `firm_api` UPDATE on every fiscal column it added to
--  `invoices` — and not on `invoice_number`. The issue write is a single statement:
--
--      update public.invoices
--         set invoice_uuid = ?, invoice_type = ?, icv = ?, previous_invoice_hash = ?,
--             invoice_hash = ?, qr_payload = ?, xml_storage_key = ?, supply_at = ?,
--             buyer_name = ?, buyer_vat_number = ?, fiscal_device_id = ?,
--             invoice_number = ?, fiscal_status = ?, fiscal_status_at = ?, updated_at = ?
--       where id = ? and tenant_id = ? and invoice_uuid is null
--
--  PostgreSQL requires a privilege for EVERY column NAMED in a statement, and it
--  refused this one with `permission denied for table invoices`. The route would have
--  turned 42501 into an opaque 500 and the document would simply not have been issued:
--  the number is the one field that has to be written in the same breath as the UUID
--  and the hash, because the guard on the table freezes all three together the moment
--  the invoice exists.
--
--  WHY A NEW FILE AND NOT AN EDIT TO 0034
--
--  0034 has been applied and `kgm_migrations` records its checksum. Editing an applied
--  migration leaves two environments with the same file name and different contents,
--  which is the one thing a migration ledger exists to prevent. Same repair pattern as
--  0028 after 0027 and 0030 after 0029.
--
--  HOW IT WAS FOUND
--
--  By `scripts/verify/schema-parity.ts`, on its FIRST run after 0034 was applied. The
--  checker carries the P0.2/P1 statements as a specification of what the grants must
--  permit, and it reads both the live column privileges and the live schema. Before the
--  migration was applied it could tell the columns did not exist yet and reported them
--  as PENDING; the moment they existed, the missing privilege became a finding.
--
--  That is the fourth time this class of defect has been caught before production, and
--  the second time this checker has caught it in a migration written in the same phase.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1 · THE COLUMN ──────────────────────────────────────────────────────────
/*
  One column, granted by name. Not a table-wide UPDATE, and not "the fiscal columns":
  the privilege a role holds should be readable as the list of things it can actually
  do, and this role does not write `invoice_number` anywhere except at issue time —
  which is also the only moment the guard permits it.
*/
grant update (invoice_number) on public.invoices to firm_api;

-- ── 2 · VERIFY ──────────────────────────────────────────────────────────────
do $$
declare
  missing text;
  n integer;
begin
  /*
    The whole union of what the issue path writes, checked as one list. Asserting only
    the column this migration adds would let the next omission through in exactly the
    way this one arrived — so the check is written against the STATEMENT, not against
    the repair.
  */
  select string_agg(c.column_name, ', ' order by c.column_name) into missing
    from unnest(array['invoice_number','invoice_uuid','invoice_type','icv',
                      'previous_invoice_hash','invoice_hash','qr_payload','xml_storage_key',
                      'supply_at','buyer_name','buyer_vat_number','fiscal_device_id',
                      'fiscal_status','fiscal_status_at','updated_at']) c(column_name)
   where not exists (
           select 1 from information_schema.column_privileges p
            where p.table_schema = 'public' and p.table_name = 'invoices'
              and p.grantee = 'firm_api' and p.privilege_type = 'UPDATE'
              and p.column_name = c.column_name);
  if missing is not null then
    raise exception '0038: firm_api still cannot write invoices column(s): %', missing;
  end if;

  /*
    AND THE CLIENT PORTAL MUST NOT BE ABLE TO WRITE THE DOCUMENT'S IDENTITY. The portal
    reads a projection of the invoice; the fiscal identity — the UUID, the counter, the
    hash, the chain link, the QR, the buyer's VAT number — is what makes the document a
    tax document, and a customer-facing role that could rewrite any of it could rewrite
    the tax record through the front door.
  */
  select count(*) into n
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'invoices'
     and grantee = 'portal_api' and privilege_type = 'UPDATE'
     and column_name in ('invoice_number','invoice_uuid','invoice_type','icv',
                         'previous_invoice_hash','invoice_hash','qr_payload','xml_storage_key',
                         'supply_at','buyer_name','buyer_vat_number','fiscal_device_id',
                         'fiscal_status','fiscal_status_at');
  if n > 0 then
    raise exception '0038: portal_api has UPDATE on % fiscal column(s) of invoices — it must have none', n;
  end if;

  raise notice '0038 applied: firm_api can write the official number, and the portal cannot write the document''s identity.';
end $$;
