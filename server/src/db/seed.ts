import type { Db } from './types.js';
import type { StorageDriver } from '../storage/service.js';
import { buildDemoSeed, demoIssuances, demoFileBytes, DEMO_ACCOUNTS, DEMO_PASSWORD,
         DEMO_FIRM_ACCOUNTS, DEMO_FIRM_PASSWORD } from './demo-data.js';

const TABLE_ORDER = [
  'tenants', 'clients', 'users', 'staff', 'client_users', 'client_invitations',
  'matters', 'matter_team', 'matter_timeline', 'hearings', 'deadlines',
  'internal_notes', 'message_threads', 'messages', 'message_reads',
  'appointment_types', 'appointments', 'documents', 'invoices', 'invoice_lines',
  'payments', 'receipts', 'notifications', 'notification_preferences', 'consent_records',
  // Firm OS (§5-§17). Order matters: the catalogue and roles must exist before
  // memberships reference them, and memberships before matter grants.
  'permissions', 'roles', 'role_permissions', 'departments',
  'firm_memberships', 'membership_roles', 'department_members',
  'membership_practice_areas', 'matter_controls', 'matter_permissions',
  'tenant_settings',
  // 0027 · the eligibility layer. After `staff` and after `firm_memberships`,
  // because a licence belongs to a staff member and the Article 16 guard reads
  // memberships when a licence is inserted for a member whose status is active.
  'professional_licences', 'prior_office', 'tenant_relationships', 'eligibility_checks',
  // 0029 · parties and conflicts. `matter_parties` after `parties`; `conflict_checks`
  // after `firm_memberships`, because a check records who performed it.
  'parties', 'party_aliases', 'party_affiliations', 'matter_parties',
  'conflict_checks', 'conflict_hits', 'conflict_waivers',
  /*
    0034-0036 · the fiscal document, client money and the billing basis.

    `fiscal_devices` before `invoices` because every issued invoice names the device
    that issued it, and `invoice_submissions` after `invoices` because a submission
    is about one. `client_ledgers` before `ledger_entries` for the same reason one
    level down, and `engagement_letters` + `matter_billing_terms` before
    `time_entries`, because the gate that admits a billable hour reads both.
  */
  'fiscal_identity', 'fiscal_devices', 'rate_cards',
  'engagement_letters', 'matter_billing_terms',
  'client_ledgers', 'ledger_entries',
  'time_entries', 'expenses',
  'invoice_submissions', 'credit_notes', 'ledger_reconciliations',
];

/**
 * The table whose insertion marks the moment issuing becomes both possible and legal.
 *
 * `payments` is the first table the builder emits once every invoice and every one of
 * its lines has been written, and it is still well before the client ledgers — where an
 * application of client money to a fee is refused unless the invoice has been ISSUED.
 * Both constraints are real, and the pass has to land between them.
 */
const ISSUANCE_BOUNDARY = 'payments';

/** Applies the deferred issuances: the second half of creating a tax invoice. */
async function applyDemoIssuances(db: Db): Promise<void> {
  for (const issuance of demoIssuances()) {
    const cols = Object.keys(issuance.set);
    const assignments = cols.map((c) => `${c} = ?`).join(', ');
    try {
      await db.run(
        `update invoices set ${assignments} where id = ? and invoice_uuid is null`,
        [...cols.map((c) => normalize(issuance.set[c])), issuance.id] as never,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`seed failed issuing invoice ${issuance.id}: ${msg}`);
    }
  }
}

/**
 * Loads the synthetic demo dataset (§44). Idempotent: existing rows for the
 * same primary key are ignored so a restart never duplicates data.
 */
export async function seedDemoData(
  db: Db,
  opts: {
    verbose?: boolean;
    force?: boolean;
    storage?: StorageDriver;
    /**
     * Tables to leave alone, by name.
     *
     * An operator tool needs this for one legitimate case: a row that was created
     * through the PRODUCT's own path rather than by the fixture — the fiscal identity
     * and the device are onboarded by the firm, not seeded into it — and re-inserting
     * the fixture's own version of it would leave the tenant with two active
     * identities, which is a state the product is right to be confused by.
     */
    skipTables?: string[];
  } = {},
): Promise<void> {
  const rows = buildDemoSeed();
  const skip = new Set(opts.skipTables ?? []);
  const issuanceSkipped = skip.has('fiscal_devices');
  let inserted = 0;
  let skippedRows = 0;
  let skipped = false;

  if (skip.size > 0 && opts.verbose) {
    console.log(`[seed] leaving ${[...skip].join(', ')} exactly as they are`);
  }

  // Seeding is idempotent (every id is derived from a stable label), but if the
  // dataset is already present we skip the inserts so a restart is cheap and
  // cannot partially apply.
  if (!opts.force) {
    const existing = await db.get<{ n: number }>(`select count(*) as n from tenants`);
    if (Number(existing?.n ?? 0) > 0) {
      skipped = true;
      if (opts.verbose) console.log('[seed] demo dataset already present — skipping inserts');
    }
  }

  if (!skipped) {
    const q = db;
    for (const { table, row } of rows) {
      if (!TABLE_ORDER.includes(table)) {
        throw new Error(`seed: unknown table "${table}"`);
      }
      if (skip.has(table)) {
        skippedRows++;
        continue;
      }
      /*
        AND WHEN THE ISSUE PASS IS SKIPPED, SO IS EVERY MOVEMENT THAT DEPENDS ON IT.

        A ledger entry that applies client money to a fee, a credit note that corrects an
        invoice, and a submission that reports or clears one, are all about a document
        that must be a valid tax invoice first. A run that deliberately leaves the invoices un-issued cannot seed them —
        and the database says so in as many words (`invoice_not_fiscally_valid`), which
        is how this rule was found rather than assumed.
      */
      if (issuanceSkipped && row.invoice_id
          && (table === 'ledger_entries' || table === 'credit_notes' || table === 'invoice_submissions')) {
        skippedRows++;
        continue;
      }
      const cols = Object.keys(row);
      const placeholders = cols.map(() => '?').join(', ');
      try {
        await q.run(
          `insert into ${table} (${cols.join(', ')}) values (${placeholders})
           on conflict do nothing`,
          cols.map((c) => normalize(row[c])) as never,
        );
        inserted++;
        /*
          THE ISSUANCE BOUNDARY.

          Invoices are inserted as drafts, their lines are added, and their fiscal
          identity is written by a second pass — the same two steps the product takes,
          because 0034 refuses a line added to an invoice that already has a UUID and
          refuses a sent invoice with no identity.

          The pass runs HERE, at the fiscal device, rather than at the end of the seed,
          and both halves of that are load-bearing:

            · it must be after the lines, so the reconcile guard can compare the
              document's totals with them;
            · it must be before the client ledgers below, because an application of
              client money to a fee is refused unless the invoice it is applied to has
              been ISSUED — which is the guard doing its job on the fixture, and it
              caught exactly this ordering the first time the pass was written.
        */
        /*
          The issuance pass is skipped with the devices it needs. A stamp naming a
          device that was never seeded would fail its foreign key, and the failure
          would read as a seed bug rather than as the deliberate omission it is.
        */
        if (table === ISSUANCE_BOUNDARY && !issuanceSkipped) {
          await applyDemoIssuances(q);
        } else if (table === ISSUANCE_BOUNDARY && opts.verbose) {
          console.log('[seed] invoices were not issued: the fiscal devices are not seeded here');
        }
      } catch (err) {
        // `on conflict do nothing` covers re-runs; anything else is a real bug.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/unique constraint|UNIQUE|duplicate key/i.test(msg)) {
          throw new Error(`seed failed on ${table}: ${msg}`);
        }
      }
    }
  }

  // Storage is reconciled on EVERY run, including a skipped one: the database
  // can outlive the volume holding the bytes (a restart with a fresh /tmp), and
  // a document row with no file behind it is a broken download rather than a
  // missing document.
  if (opts.storage) {
    let written = 0;
    for (const { table, row } of rows) {
      if (table !== 'documents' && table !== 'receipts') continue;
      const key = String(row.storage_key ?? '');
      if (!key) continue;
      const mime = table === 'documents' ? String(row.mime_type ?? 'application/pdf') : 'application/pdf';
      if (mime !== 'application/pdf') continue;
      const label = table === 'documents'
        ? String(row.title ?? 'Document')
        : `Receipt ${String(row.receipt_number ?? '')}`;
      await opts.storage.put(key, demoFileBytes(label, String(row.id)), mime);
      written++;
    }
    if (opts.verbose) console.log(`[seed] materialized ${written} demo file(s) (documents + receipts)`);
  }

  if (skipped) return;

  if (opts.verbose) {
    console.log(`[seed] demo dataset ready (${inserted} rows${skippedRows ? `, ${skippedRows} left alone` : ''})`);
    console.log('[seed] ─────────────────────────────────────────────────────────');
    console.log('[seed]  CLIENT PORTAL CREDENTIALS — synthetic data only (§44)');
    for (const a of DEMO_ACCOUNTS) {
      console.log(`[seed]   ${a.email.padEnd(38)} ${a.password}   ${a.who}`);
    }
    console.log('[seed] ─────────────────────────────────────────────────────────');
    console.log('[seed]  FIRM OS CREDENTIALS — separate audience, separate cookie (§6)');
    for (const a of DEMO_FIRM_ACCOUNTS) {
      console.log(`[seed]   ${a.email.padEnd(38)} ${a.password}   ${a.who}`);
    }
    console.log('[seed] ─────────────────────────────────────────────────────────');
  }
}

function normalize(v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v as never;
}

export { DEMO_ACCOUNTS, DEMO_PASSWORD, DEMO_FIRM_ACCOUNTS, DEMO_FIRM_PASSWORD };
