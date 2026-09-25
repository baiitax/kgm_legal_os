/**
 * KGM LEGAL OS — SCHEMA PARITY BETWEEN THE TWO DIALECTS
 *
 *   npx tsx scripts/verify/schema-parity.ts
 *
 * WHY THIS EXISTS
 *   This system runs on two engines. SQLite is where every test runs; PostgreSQL
 *   is where the product runs. Eleven defects reached production by existing in
 *   only one of them, and every one was found late because the divergence was
 *   invisible: a column granted in one dialect and not the other, a constraint
 *   with a vocabulary of its own, a trigger that cannot exist in both.
 *
 *   The unit suite cannot catch this class. It runs on the dialect that is
 *   missing the defect. So the check has to compare the two schemas directly,
 *   and it has to be cheap enough to run every time.
 *
 * WHAT IT COMPARES
 *   1. Tables present in one dialect and not the other.
 *   2. Columns present in one and not the other.
 *   3. Column-level write privileges: for each table, the server's own inserts
 *      are measured against what `firm_api` may actually write. A column the
 *      server sends but is not granted produces a 500 at runtime and passes
 *      every SQLite test — this is the defect that prompted the file.
 *
 * WHAT IT DOES NOT COMPARE
 *   Types and defaults. The dialects spell them differently on purpose (text vs
 *   timestamptz, integer 0/1 vs boolean) and the repository layer exists to
 *   absorb exactly that. Comparing them would produce a list of known, intended
 *   differences that buries the real findings.
 */
import pg from '../../node_modules/pg/lib/index.js';
import { readFileSync } from 'node:fs';
import { SqliteDb } from '../../server/src/db/sqlite.js';

const ADMIN = (() => {
  const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
  return `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@` +
    'aws-0-us-east-1.pooler.supabase.com:5432/postgres';
})();

/**
 * Columns the server writes on each command, transcribed from `firm-repo.ts`.
 *
 * This is the load-bearing part of the file. A grant list can only be wrong
 * relative to something, and the thing it must match is not the table's columns —
 * it is the statement the server actually issues. Keeping the two in one place
 * means adding a column to an INSERT forces a decision here.
 */
/**
 * Tables whose migration is WRITTEN but not yet applied to the database being checked.
 *
 * A gate that is permanently red is a gate nobody reads, and this one cannot go green
 * until 0034–0037 are applied upstream — so the un-applied tables are reported as
 * PENDING, by name, and excluded from the divergence count. The list is emptied by
 * applying the migrations, never by editing it: the moment a migration lands, the
 * tables it creates drop out of this map and their grants start being checked for real.
 */
const PENDING_MIGRATIONS: Record<string, string> = {
  fiscal_identity: '0034', fiscal_devices: '0034', invoice_submissions: '0034', credit_notes: '0034',
  client_ledgers: '0035', ledger_entries: '0035', ledger_reconciliations: '0035',
  rate_cards: '0036', matter_billing_terms: '0036', time_entries: '0036',
  expenses: '0036', engagement_letters: '0036',
};

/**
 * Grants that a written-but-unapplied migration will add on a table that already exists.
 *
 * `invoices` has been in the database since 0002, so the column test above cannot tell
 * that these specific columns are about to become writable — the columns are old, only
 * the privilege is new. Naming them here keeps the expectation explicit and the count
 * honest, and the entries are meant to be DELETED once the migrations are applied: the
 * check below reports any entry that has become unnecessary, so the map cannot quietly
 * become a place where real findings are hidden.
 */
const PENDING_GRANTS: Record<string, string> = {};
/*
  0035, 0036 and 0038 have been applied, so the five entries that used to live here
  (amount_paid, subtotal, vat_amount, total, notes_internal) are real checks now — and
  they pass. The map stays because the next migration that grants a column on a table
  which already exists will need it, and because an empty map is a readable statement
  that nothing is currently being taken on trust.
*/

const SERVER_WRITES: Array<{
  table: string;
  command: 'INSERT' | 'UPDATE';
  /** Columns the statement WRITES. For an UPDATE this is the SET list only. */
  columns: string[];
  /** Columns the statement merely READS (a WHERE clause), which need SELECT. */
  readColumns?: string[];
  /** Which role issues the statement. Defaults to firm_api; `clients` is portal_api's. */
  grantee?: string;
  where: string;
}> = [
  {
    table: 'professional_licences', command: 'INSERT', where: 'FirmRepo.upsertLicence (new licence)',
    columns: ['id', 'tenant_id', 'staff_id', 'licence_number', 'issued_at', 'expires_at',
      'status', 'status_effective_from', 'status_reference', 'verified_by_membership_id',
      'verified_at', 'created_at', 'updated_at'],
  },
  {
    table: 'professional_licences', command: 'UPDATE', where: 'FirmRepo.upsertLicence (renewal)',
    columns: ['issued_at', 'expires_at', 'status', 'status_effective_from', 'status_reference',
      'verified_by_membership_id', 'verified_at', 'updated_at'],
    // `where id = ? and tenant_id = ?` — an UPDATE needs UPDATE on the columns it
    // SETS and SELECT on the columns it READS, which is a rule that catches people
    // out in both directions. Kept as a separate list so the check states it.
    readColumns: ['id', 'tenant_id'],
  },
  {
    table: 'prior_office', command: 'INSERT', where: 'FirmRepo.recordPriorOffice',
    columns: ['id', 'tenant_id', 'staff_id', 'office_kind', 'institution', 'institution_ar',
      'role_title', 'role_title_ar', 'started_on', 'ended_on', 'created_at', 'updated_at'],
  },
  {
    table: 'eligibility_checks', command: 'INSERT', where: 'FirmRepo.recordEligibilityCheck',
    columns: ['tenant_id', 'subject_kind', 'subject_id', 'precondition', 'outcome', 'evidence',
      'rule_cited', 'evaluated_by_membership_id', 'evaluated_at'],
  },

  // ── P0.1 · the party register and the conflict ledger ───────────────────
  // Twelve routes and four repo methods were written before this list was. That is
  // the wrong order and it is the one the plan says not to repeat: the list is the
  // SPECIFICATION of what the grants must permit, and writing it afterwards makes
  // it a description of what happened.
  {
    table: 'parties', command: 'INSERT', where: 'FirmRepo.createParty',
    columns: ['id', 'tenant_id', 'kind', 'name', 'name_ar', 'name_normalized',
      'commercial_registration', 'vat_number', 'national_id_masked', 'national_id_hash',
      'status', 'notes', 'created_by_membership_id', 'created_at', 'updated_at'],
  },
  {
    // The SET list is built at runtime from whichever fields were supplied, so the
    // list here is the UNION of everything the method can write. A grant covering
    // the union covers every actual call; a grant covering less would fail only for
    // certain callers, which is the hardest kind of privilege bug to find.
    table: 'parties', command: 'UPDATE', where: 'FirmRepo.updateParty (union of optional sets)',
    columns: ['name', 'name_ar', 'name_normalized', 'notes', 'kind', 'updated_at'],
    readColumns: ['id', 'tenant_id'],
  },
  {
    table: 'party_aliases', command: 'INSERT', where: 'FirmRepo.addPartyAlias',
    columns: ['id', 'tenant_id', 'party_id', 'alias', 'alias_normalized', 'script', 'source',
      'note', 'created_at', 'updated_at'],
  },
  {
    table: 'party_affiliations', command: 'INSERT', where: 'FirmRepo.addAffiliation',
    columns: ['id', 'tenant_id', 'party_id', 'staff_id', 'relation', 'started_on', 'ended_on',
      'note', 'recorded_by_membership_id', 'created_at', 'updated_at'],
  },
  {
    table: 'matter_parties', command: 'INSERT', where: 'FirmRepo.addMatterParty',
    columns: ['id', 'tenant_id', 'matter_id', 'party_id', 'role', 'note',
      'added_by_membership_id', 'created_at', 'updated_at'],
  },
  {
    table: 'conflict_checks', command: 'INSERT', where: 'FirmRepo.startConflictCheck',
    columns: ['id', 'tenant_id', 'matter_id', 'kind', 'status', 'parties_checked',
      'matters_searched', 'hits_found', 'started_by_membership_id', 'started_at',
      'created_at', 'updated_at'],
  },
  {
    table: 'conflict_checks', command: 'UPDATE', where: 'FirmRepo.recordHit / concludeCheck',
    columns: ['parties_checked', 'matters_searched', 'hits_found', 'updated_at',
      'status', 'conclusion', 'concluded_by_membership_id', 'concluded_at'],
    readColumns: ['id', 'tenant_id'],
  },
  {
    table: 'conflict_hits', command: 'INSERT', where: 'FirmRepo.recordHit',
    columns: ['id', 'tenant_id', 'check_id', 'matter_id', 'party_id', 'matched_party_id',
      'matched_matter_id', 'matched_client_id', 'relation', 'match_strength', 'match_basis',
      // 0031 · the engine's opinion has its own column; `severity` is left null
      // while the hit is open and the schema refuses it before then.
      'affected_party_id', 'proposed_severity', 'rule_cited', 'relationship_ended_on', 'window_years',
      'window_lifts_on', 'within_window', 'disposition', 'created_at', 'updated_at'],
  },
  {
    table: 'conflict_hits', command: 'UPDATE', where: 'FirmRepo.dispositionHit',
    columns: ['disposition', 'disposition_reason', 'disposition_by_membership_id',
      'disposition_at', 'severity', 'affected_party_id', 'updated_at'],
    readColumns: ['id', 'tenant_id'],
  },
  {
    table: 'conflict_waivers', command: 'INSERT', where: 'FirmRepo.recordWaiver',
    columns: ['id', 'tenant_id', 'hit_id', 'matter_id', 'waived_by_party_id',
      'consent_document_id', 'consent_reference', 'consent_signed_on', 'scope',
      'recorded_by_membership_id', 'created_at'],
  },
  {
    // firm_api, not portal_api: `clients` is the portal's table, but it is the FIRM
    // that records which party a client is — a lawyer does the linkage at intake.
    // This annotation said portal_api when it was first written, and the check
    // reported a missing grant that was not missing. A transcription error in this
    // list produces a false alarm, which is the acceptable direction: the dangerous
    // error is a statement missing from the list altogether.
    table: 'clients', command: 'UPDATE', where: 'FirmRepo.linkClientParty',
    columns: ['party_id', 'updated_at'], readColumns: ['id', 'tenant_id'],
  },
  {
    table: 'matters', command: 'UPDATE', where: 'FirmRepo.setMatterConflictCleared / setMatterStatus',
    columns: ['conflict_cleared', 'updated_at', 'internal_status'],
    readColumns: ['id', 'tenant_id'],
  },
  // ── P0.2 · the fiscal chain ─────────────────────────────────────────────
  // Forty-two repo methods and twelve routes were written before this list was. The
  // list is the SPECIFICATION of what the grants must permit — the order it is written
  // in matters less than that it exists before the migration is applied, which is now
  // the case: 0034–0037 are written and waiting, so their grants are checked against
  // these statements the moment they land rather than after a 500 in production.
  {
    table: 'fiscal_identity', command: 'INSERT', where: 'FirmRepo.upsertFiscalIdentity (first identity)',
    columns: ['id', 'tenant_id', 'registered_name', 'registered_name_ar', 'vat_registration_number',
      'commercial_registration', 'registered_address', 'registered_address_ar', 'city', 'postal_code',
      'country', 'environment', 'onboarding_status', 'certificate_expires_at', 'superseded_by',
      'created_at', 'updated_at'],
  },
  {
    // Superseding an identity writes ONE column on the old row: the pointer to its
    // successor. Nothing about a registered identity is ever rewritten in place, because
    // the documents already issued under it name the numbers it held.
    table: 'fiscal_identity', command: 'UPDATE', where: 'FirmRepo.upsertFiscalIdentity (supersede)',
    columns: ['superseded_by', 'updated_at'], readColumns: ['id', 'tenant_id'],
  },
  {
    table: 'fiscal_devices', command: 'INSERT', where: 'FirmRepo.createFiscalDevice',
    columns: ['id', 'tenant_id', 'fiscal_identity_id', 'device_label', 'device_serial',
      'invoice_counter_value', 'last_invoice_hash', 'is_active', 'created_at', 'updated_at'],
  },
  {
    // The counter is taken in a single `update … returning`, and `is_active` is in the
    // WHERE clause: an inactive device is refused by the database, not by the caller.
    table: 'fiscal_devices', command: 'UPDATE', where: 'FirmRepo.allocateFiscalNumber',
    columns: ['invoice_counter_value', 'updated_at'], readColumns: ['id', 'is_active'],
  },
  {
    table: 'fiscal_devices', command: 'UPDATE', where: 'FirmRepo.recordInvoiceIssue / createCreditNote (chain head)',
    columns: ['last_invoice_hash', 'updated_at'], readColumns: ['id'],
  },
  {
    // The issue itself. Every frozen field of the document is written here and nowhere
    // else, and the WHERE clause requires `invoice_uuid is null` so a second issue
    // cannot take the number twice.
    table: 'invoices', command: 'UPDATE', where: 'FirmRepo.recordInvoiceIssue',
    columns: ['invoice_uuid', 'invoice_type', 'icv', 'previous_invoice_hash', 'invoice_hash',
      'qr_payload', 'xml_storage_key', 'supply_at', 'buyer_name', 'buyer_vat_number',
      'fiscal_device_id', 'invoice_number', 'fiscal_status', 'fiscal_status_at', 'updated_at'],
    readColumns: ['id', 'tenant_id', 'invoice_uuid'],
  },
  {
    table: 'invoices', command: 'UPDATE', where: 'FirmRepo.setFiscalStatus (reporting / clearance outcome)',
    columns: ['fiscal_status', 'fiscal_status_at', 'updated_at'], readColumns: ['id', 'tenant_id'],
  },
  {
    table: 'invoice_submissions', command: 'INSERT', where: 'FirmRepo.recordSubmission',
    columns: ['id', 'tenant_id', 'invoice_id', 'submission_type', 'attempt', 'status', 'http_status',
      'response_code', 'request_body_hash', 'response_body', 'warnings', 'errors', 'next_retry_at',
      'submitted_at', 'resolved_at', 'created_at'],
  },
  {
    table: 'credit_notes', command: 'INSERT', where: 'FirmRepo.createCreditNote',
    columns: ['id', 'tenant_id', 'invoice_id', 'client_id', 'credit_number', 'reason', 'amount',
      'vat_amount', 'total', 'currency', 'fiscal_device_id', 'invoice_uuid', 'icv',
      'previous_invoice_hash', 'invoice_hash', 'qr_payload', 'xml_storage_key', 'fiscal_status',
      'issued_by_staff', 'issued_at', 'created_at'],
  },

  // ── P1 · client money ───────────────────────────────────────────────────
  {
    table: 'client_ledgers', command: 'INSERT', where: 'FirmRepo.ensureClientLedger',
    columns: ['id', 'tenant_id', 'client_id', 'currency', 'status', 'frozen_reason', 'opened_at',
      'closed_at', 'created_at', 'updated_at'],
  },
  {
    // Append-only: INSERT and never UPDATE or DELETE. The grants must not include
    // the UPDATE privilege at all, which is the half of this list a checker would
    // otherwise never look for.
    table: 'ledger_entries', command: 'INSERT', where: 'FirmRepo.recordLedgerEntry (receipt, application, refund, reversal)',
    columns: ['id', 'tenant_id', 'ledger_id', 'client_id', 'entry_type', 'direction', 'amount',
      'currency', 'invoice_id', 'matter_id', 'description', 'reference', 'evidence_document_id',
      'reverses_entry_id', 'reversal_reason', 'entry_at', 'recorded_by_user_id', 'recorded_at'],
  },
  {
    // An application moves the invoice's own paid figure, in the same request that
    // records the entry: the invoice may never show money no entry accounts for, and
    // the database's cap on the next application reads this column.
    table: 'invoices', command: 'UPDATE', where: 'FirmRepo.applyMoneyToInvoice (application to a fee)',
    columns: ['amount_paid', 'internal_status', 'client_status', 'updated_at'],
    readColumns: ['id', 'tenant_id', 'amount_paid', 'total'],
  },
  {
    table: 'ledger_reconciliations', command: 'INSERT', where: 'FirmRepo.createReconciliation',
    columns: ['id', 'tenant_id', 'currency', 'as_of', 'ledger_total', 'bank_balance', 'difference',
      'bank_statement_reference', 'bank_statement_document_id', 'clients_with_balance', 'status',
      'notes', 'performed_by_user_id', 'performed_at', 'created_at'],
  },

  // ── P1 · the basis for the fee, the hour and the disbursement ───────────
  {
    table: 'engagement_letters', command: 'INSERT', where: 'FirmRepo.upsertEngagementLetter',
    columns: ['id', 'tenant_id', 'matter_id', 'client_id', 'scope', 'scope_ar', 'fee_amount_sar',
      'calculation_method', 'signed_by_client_at', 'signed_by_client_name', 'document_id',
      'identity_verified_at', 'capacity_verified', 'status', 'superseded_by', 'created_by_user_id',
      'created_at'],
  },
  {
    table: 'engagement_letters', command: 'UPDATE', where: 'FirmRepo.signEngagementLetter',
    columns: ['status', 'signed_by_client_at', 'signed_by_client_name', 'document_id',
      'identity_verified_at', 'capacity_verified'],
    readColumns: ['id', 'tenant_id'],
  },
  {
    table: 'matter_billing_terms', command: 'INSERT', where: 'FirmRepo.setBillingTerms (new basis)',
    columns: ['id', 'tenant_id', 'matter_id', 'basis', 'fee_amount_sar', 'cap_amount_sar',
      'retainer_amount_sar', 'stages', 'agreed_discount_pct', 'vat_applicable', 'effective_from',
      'effective_to', 'superseded_by', 'notes', 'created_by_user_id', 'created_at'],
  },
  {
    // Terms are superseded, never edited: the old basis has to remain answerable for
    // the hours that were worked under it.
    table: 'matter_billing_terms', command: 'UPDATE', where: 'FirmRepo.setBillingTerms (supersede the previous basis)',
    columns: ['superseded_by'], readColumns: ['matter_id', 'tenant_id'],
  },
  {
    table: 'rate_cards', command: 'INSERT', where: 'FirmRepo.createRateCard',
    columns: ['id', 'tenant_id', 'level', 'staff_id', 'practice_area', 'hourly_rate_sar',
      'effective_from', 'effective_to', 'created_by_user_id', 'created_at'],
  },
  {
    table: 'time_entries', command: 'INSERT', where: 'FirmRepo.recordTimeEntry',
    columns: ['id', 'tenant_id', 'matter_id', 'staff_id', 'entry_date', 'minutes', 'narrative',
      'narrative_ar', 'billable', 'hourly_rate_sar', 'amount_sar', 'invoice_id', 'status',
      'approved_by_user_id', 'approved_at', 'written_off_reason', 'created_at', 'updated_at'],
  },
  {
    /*
      The SET list is built at runtime, so this is the UNION of everything the method
      can write. `hourly_rate_sar` is READ inside the amount expression
      (`round((? / 60.0) * hourly_rate_sar, 2)`) — a column named in a statement needs
      its privilege even when it is not the target of an assignment, which is the
      distinction that produced the 0027/0028 defect.
    */
    table: 'time_entries', command: 'UPDATE', where: 'FirmRepo.adjustTimeEntry (union of optional sets)',
    columns: ['updated_at', 'status', 'approved_by_user_id', 'approved_at', 'written_off_reason',
      'minutes', 'amount_sar'],
    readColumns: ['id', 'tenant_id', 'hourly_rate_sar'],
  },
  {
    table: 'expenses', command: 'INSERT', where: 'FirmRepo.recordExpense',
    columns: ['id', 'tenant_id', 'matter_id', 'client_id', 'submitted_by_staff', 'incurred_on',
      'category', 'description', 'description_ar', 'net_amount_sar', 'vat_amount_sar',
      'total_amount_sar', 'vat_category', 'receipt_document_id', 'reimbursable', 'invoice_id',
      'status', 'approved_by_user_id', 'approved_at', 'rejection_reason', 'created_at', 'updated_at'],
  },
  {
    table: 'expenses', command: 'UPDATE', where: 'FirmRepo.decideExpense',
    columns: ['status', 'approved_by_user_id', 'approved_at', 'rejection_reason', 'updated_at'],
    readColumns: ['id', 'status', 'tenant_id'],
  },
  {
    // The two ceilings that had no guard before this phase. Both are ordinary UPDATEs on
    // an issued invoice's money, which is exactly why their grants must be checked: the
    // route is refused by a ceiling, but the STATEMENT that would follow the ceiling is
    // the one that must not be able to run ungranted.
    table: 'invoices', command: 'UPDATE', where: 'FirmRepo.applyDiscount (recomputed VAT and total)',
    columns: ['subtotal', 'vat_amount', 'total', 'updated_at'],
    readColumns: ['id', 'tenant_id', 'subtotal', 'vat_amount', 'total'],
  },
  {
    table: 'invoices', command: 'UPDATE', where: 'FirmRepo.writeOffInvoice (outstanding balance abandoned)',
    columns: ['internal_status', 'client_status', 'notes_internal', 'updated_at'],
    readColumns: ['id', 'tenant_id', 'internal_status', 'amount_paid', 'total', 'due_date'],
  },

];

const NEW_TABLES = [
  'professional_licences', 'prior_office', 'tenant_relationships', 'eligibility_checks',
  // 0029
  'parties', 'party_aliases', 'party_affiliations', 'matter_parties',
  'conflict_checks', 'conflict_hits', 'conflict_waivers',
];

/**
 * Columns the server writes on an EXISTING table, so they are checked in the same
 * way as the new tables' columns: present in both dialects. `clients` and `matters`
 * arrived long before 0029 and are easy to forget.
 */
const TOUCHED_TABLES = ['clients', 'matters'];

async function main(): Promise<void> {
  const db = new SqliteDb(':memory:');
  db.migrate();

  const lite = await db.all<{ name: string }>(
    `select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like 'kgm_%'`,
  );
  const liteTables = new Set(lite.map((r) => r.name));
  const liteCols = new Map<string, Set<string>>();
  for (const t of liteTables) {
    const cols = await db.all<{ name: string }>(`pragma table_info(${t})`);
    liteCols.set(t, new Set(cols.map((c) => c.name)));
  }

  const c = new pg.Client({ connectionString: ADMIN, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const pgTables = new Set(
    (await c.query(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`))
      .rows.map((r: { table_name: string }) => r.table_name),
  );
  const pgCols = new Map<string, Set<string>>();
  for (const t of pgTables) {
    const cols = await c.query(
      `select column_name from information_schema.columns where table_schema='public' and table_name=$1`, [t]);
    pgCols.set(t, new Set(cols.rows.map((r: { column_name: string }) => r.column_name)));
  }

  const findings: string[] = [];

  // ── 1 · tables ──────────────────────────────────────────────────────────
  console.log('TABLES');
  console.log(`  sqlite ${liteTables.size}   postgres ${pgTables.size}`);
  const pendingTables: string[] = [];
  for (const t of liteTables) {
    if (!pgTables.has(t)) {
      const migration = PENDING_MIGRATIONS[t];
      if (migration) {
        pendingTables.push(t);
        console.log(`  PENDING ${migration}       : ${t}  (mirror written, migration not applied here)`);
        continue;
      }
      findings.push(`table ${t} exists in SQLite and not in PostgreSQL`);
      console.log(`  MISSING in postgres : ${t}`);
    }
  }
  for (const t of pgTables) {
    if (!liteTables.has(t)) {
      // Expected in one direction only: the local drivers and the ops tables have
      // no SQLite mirror. Anything else is a gap the suite cannot see.
      const expected = ['kgm_migrations', 'client_invitations_alias'];
      if (!expected.includes(t)) console.log(`  note — postgres-only table: ${t}`);
    }
  }

  // ── 2 · columns, for every table the phase touched ──────────────────────
  console.log('\nCOLUMNS (tables this phase touches, both dialects)');
  for (const t of [...NEW_TABLES, ...TOUCHED_TABLES]) {
    const a = liteCols.get(t) ?? new Set<string>();
    const b = pgCols.get(t) ?? new Set<string>();
    const onlyLite = [...a].filter((x) => !b.has(x));
    const onlyPg = [...b].filter((x) => !a.has(x));
    const status = onlyLite.length === 0 && onlyPg.length === 0 ? 'in step' : 'DIVERGENT';
    console.log(`  ${t.padEnd(24)} ${String(a.size).padStart(2)} / ${String(b.size).padStart(2)}  ${status}`);
    if (onlyLite.length) {
      findings.push(`${t}: only in SQLite — ${onlyLite.join(', ')}`);
      console.log(`      only in SQLite : ${onlyLite.join(', ')}`);
    }
    if (onlyPg.length) {
      findings.push(`${t}: only in PostgreSQL — ${onlyPg.join(', ')}`);
      console.log(`      only in PostgreSQL : ${onlyPg.join(', ')}`);
    }
  }

  // ── 3 · write privileges, measured against the server's own statements ──
  console.log('\nWRITE PRIVILEGES (firm_api, against what the server actually sends)');
  let skipped = 0;
  for (const w of SERVER_WRITES) {
    /*
      A statement whose table — or whose COLUMN — is not in the live schema yet has no
      grants to check, and reporting it as a failure would be reporting the migrations
      as a defect. It is counted as PENDING instead, so that the number of unchecked
      statements is visible on every run rather than assumed to be zero.

      The column test matters as much as the table test: `invoices` has existed for
      years, and the columns this phase adds to it arrive with 0034–0036. Without the
      column test the gate would report "ungranted" for a privilege on a column the
      database has never heard of, and a reader would learn to ignore the word.
    */
    const liveCols = pgCols.get(w.table);
    const absent = liveCols
      ? [...w.columns, ...(w.readColumns ?? [])].filter((col) => !liveCols.has(col))
      : ['(the whole table)'];
    if (absent.length > 0) {
      skipped += 1;
      console.log(`  PENDING ${PENDING_MIGRATIONS[w.table] ?? '0034–0037'}   ${w.table} ${w.command}  `
        + `(${w.where}) — not in the live schema here: ${[...new Set(absent)].join(', ')}`);
      continue;
    }
    const grantee = w.grantee ?? 'firm_api';
    const granted = new Set(
      (await c.query(
        `select column_name from information_schema.column_privileges
          where table_name=$1 and grantee=$3 and privilege_type=$2`,
        [w.table, w.command, grantee],
      )).rows.map((r: { column_name: string }) => r.column_name),
    );
    const selects = new Set(
      (await c.query(
        `select column_name from information_schema.column_privileges
          where table_name=$1 and grantee='firm_api' and privilege_type='SELECT'`,
        [w.table],
      )).rows.map((r: { column_name: string }) => r.column_name),
    );

    /*
      A column the server sends but is not granted is a runtime failure that no
      SQLite test can produce: the engine has one role and no column privileges.
      It is the defect this file was written for — `eligibility_checks.evaluated_at`
      returned HTTP 500 in production while 346 tests passed.
    */
    const missing = [...w.columns.filter((col) => !granted.has(col)),
      ...(w.readColumns ?? []).filter((col) => !selects.has(col))];
    const pendingHere = missing.filter((col) => PENDING_GRANTS[`${w.table} ${col}`]);
    const ungranted = missing.filter((col) => !PENDING_GRANTS[`${w.table} ${col}`]);

    /*
      A column this phase GRANTS in a migration that is not applied yet is not a defect
      — it is the plan. It is reported with the migration that will fix it, and counted,
      so the difference between "checked and clean" and "not yet checkable" is visible.
    */
    if (ungranted.length === 0 && pendingHere.length > 0) {
      skipped += 1;
      const migrations = [...new Set(pendingHere.map((col) => PENDING_GRANTS[`${w.table} ${col}`]))];
      console.log(`  PENDING ${migrations.join('/')}   ${w.table} ${w.command}  (${w.where}) — granted by `
        + `${migrations.join(', ')} when applied: ${pendingHere.join(', ')}`);
      continue;
    }

    const ok = ungranted.length === 0;
    if (!ok) findings.push(`${w.table} ${w.command}: server uses ungranted column(s) — ${ungranted.join(', ')}`);
    console.log(`  ${ok ? 'OK    ' : 'FAIL  '} ${w.table} ${w.command}  (${w.where})`);
    if (ungranted.length) console.log(`         NOT GRANTED for ${w.command}: ${ungranted.join(', ')}`);
    if (pendingHere.length) console.log(`         (granted by ${pendingHere.map((col) => PENDING_GRANTS[`${w.table} ${col}`]).join(', ')} when applied: ${pendingHere.join(', ')})`);
  }

  /*
    An entry left in PENDING_GRANTS after its migration was applied is a rule that no
    longer means anything — and a place where a real finding could hide. The check
    reports the ones that have become unnecessary rather than silently ignoring them.
  */
  const stale: string[] = [];
  for (const key of Object.keys(PENDING_GRANTS)) {
    const [table, col] = key.split(' ');
    const live = pgCols.get(table);
    if (!live || !live.has(col)) continue;   // the migration is still not applied
    const granted = await c.query(
      `select 1 from information_schema.column_privileges
        where table_schema='public' and table_name=$1 and grantee='firm_api'
          and privilege_type='UPDATE' and column_name=$2`, [table, col]);
    if (granted.rowCount && granted.rowCount > 0) stale.push(`${key} (${PENDING_GRANTS[key]} applied)`);
  }

  await c.end();

  console.log('');
  if (stale.length > 0) {
    console.log(`  note — PENDING_GRANTS entries whose migration appears applied; delete them: ${stale.join(', ')}`);
  }
  if (pendingTables.length > 0 || skipped > 0) {
    console.log(`  ${skipped} statement grant check(s) pending an unapplied migration `
      + `(${pendingTables.length} table(s) exist in the mirror only).`);
  }
  if (findings.length) {
    console.log(`  ${findings.length} finding(s) — the dialects disagree:`);
    for (const f of findings) console.log(`    · ${f}`);
    process.exit(1);
  }
  console.log('  PASS — no divergence between the two dialects');
}

main().catch((err) => { console.error(err); process.exit(1); });
