import type { Db } from './types.js';
import type { StorageDriver } from '../storage/service.js';
import { buildDemoSeed, demoFileBytes, DEMO_ACCOUNTS, DEMO_PASSWORD,
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
];

/**
 * Loads the synthetic demo dataset (§44). Idempotent: existing rows for the
 * same primary key are ignored so a restart never duplicates data.
 */
export async function seedDemoData(
  db: Db,
  opts: { verbose?: boolean; force?: boolean; storage?: StorageDriver } = {},
): Promise<void> {
  const rows = buildDemoSeed();
  let inserted = 0;
  let skipped = false;

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
      const cols = Object.keys(row);
      const placeholders = cols.map(() => '?').join(', ');
      try {
        await q.run(
          `insert into ${table} (${cols.join(', ')}) values (${placeholders})
           on conflict do nothing`,
          cols.map((c) => normalize(row[c])) as never,
        );
        inserted++;
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
    console.log(`[seed] demo dataset ready (${inserted} rows)`);
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
