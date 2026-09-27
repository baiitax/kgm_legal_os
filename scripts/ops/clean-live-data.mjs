#!/usr/bin/env node
/**
 * CLEAN THE LIVE DATA — recommendation 3 of the audit, as a tool.
 *
 *     node scripts/ops/clean-live-data.mjs                 report only (default)
 *     node scripts/ops/clean-live-data.mjs --label-tests   annotate the fiscal test documents
 *     node scripts/ops/clean-live-data.mjs --drop-orphan-drafts
 *     node scripts/ops/clean-live-data.mjs --purge-demo --confirm <tenant-uuid>
 *
 * WHY IT IS A SCRIPT AND NOT A MIGRATION. A migration runs once, in order, and cannot be
 * reconsidered. This touches a live database whose contents are somebody's review
 * environment, and every action in it deserves to be read before it is taken. So the
 * default is a report, every action is opt-in by name, and the destructive one needs the
 * tenant spelled out.
 *
 * ── WHAT THE AUDIT FOUND, AND WHAT CAN ACTUALLY BE DONE ABOUT EACH ────────────────
 *
 *   1 · FOUR INVOICES VISIBLE TO A CLIENT WITH NO FISCAL IDENTITY (`sent` 2, `partial`
 *       1, `paid` 1). They are the DEMO tenant's own invoices and they are what the
 *       client portal's billing screen is built from. Writing them off individually —
 *       which IS possible for three of the four — would leave the portal showing nothing
 *       but cancelled documents, and would achieve nothing for compliance, because they
 *       belong to a demonstration client of a demonstration firm that must be removed
 *       wholesale before go-live anyway.
 *
 *       THE DECISION IS THEREFORE ONE OPERATION, NOT FOUR: they go with the tenant
 *       purge below, and until then they stay exactly as they are so the review
 *       environment keeps working. Maiming them in place would have been the worst of
 *       both — a broken demo AND demo data still in the database.
 *
 *   2 · TEN `LIVE-FISCAL-…` TEST DOCUMENTS carry UUIDs, ICVs 1–10 and hash-chain
 *       positions, written by a fiscal self-test rather than by real work. They cannot be
 *       deleted (`issued_invoice_not_deletable`) and cannot be cancelled
 *       (`issued_invoice_immutable`), and that is the schema being right: a document in
 *       the chain the tax authority will see is not deletable. What CAN be done is to
 *       label them, so no reader mistakes them for real invoices — and that is worth
 *       doing precisely because they are permanent. Their ICVs also mean the firm's real
 *       invoice counter started at 11, which a go-live conversation should know.
 *
 *   3 · ONE `LIVE-FISCAL-…-DRAFT` has no UUID and no client visibility: a test artifact
 *       that never became a document. It can be cancelled and removed properly.
 *
 *   4 · THE DEMONSTRATION FIRM AND ITS CREDENTIALS. This is the one that must happen
 *       before the system is used for real work, and the one that cannot be undone. It
 *       deletes a tenant and everything hanging off it in dependency order, in one
 *       transaction, and it refuses to run without the tenant id typed out. See
 *       `purgeTenant` for the order and for what is deliberately left alone.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const PW_PATH = process.env.KGM_PW_FILE ?? '/home/user/.kgm-ops/pw.txt';
const readPw = () => readFileSync(PW_PATH, 'utf8').trim();

/** The two tenants the seeder creates. The purge refuses to touch anything else. */
const DEMO_TENANTS = {
  'aaaaaaaa-0000-4000-8000-000000000001': 'KGM Law Firm (the demonstration firm)',
  'bbbbbbbb-0000-4000-8000-000000000002': 'Najd Legal Partners (the second firm, used by the isolation checks)',
};

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

function connect() {
  const url = process.env.KGM_ADMIN_URL
    ?? `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(readPw())}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
  return new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
}

const line = (s = '') => console.log(s);

// ═══════════════════════════════════════════════════════════════════════════════
// THE REPORT — what is in there, and what each thing is
// ═══════════════════════════════════════════════════════════════════════════════
async function report(db) {
  line('\n  LIVE DATA · what the audit found, and what can be done about it');
  line('  ' + '─'.repeat(74));

  const unissued = await db.query(`
    select invoice_number, internal_status, client_status, total, amount_paid, client_id
      from public.invoices
     where invoice_uuid is null and internal_status in ('sent','partially_paid','paid','overdue')
     order by invoice_number`);
  line(`\n  1 · CLIENT-VISIBLE, NEVER ISSUED — ${unissued.rows.length}`);
  for (const r of unissued.rows) {
    line(`      ${r.invoice_number.padEnd(16)} ${r.internal_status.padEnd(16)} `
      + `client sees "${r.client_status}" · SAR ${r.total} · paid ${r.amount_paid}`);
  }
  line('      → left in place deliberately: these are the demo portal\'s invoices and they');
  line('        belong to the demo tenant, which goes in one operation (#4, --purge-demo).');

  const tests = await db.query(`
    select invoice_number, internal_status, icv, (client_status is null) as hidden
      from public.invoices where invoice_number like 'LIVE-FISCAL-%' order by icv nulls first`);
  line(`\n  2 · FISCAL SELF-TEST DOCUMENTS — ${tests.rows.length}`);
  for (const r of tests.rows) {
    line(`      ${String(r.invoice_number).slice(0, 34).padEnd(36)} ${r.internal_status.padEnd(6)} `
      + `icv=${String(r.icv ?? '—').padStart(3)}  ${r.hidden ? 'never shown to a client' : 'VISIBLE TO A CLIENT'}`);
  }
  line('      → permanent by design (issued documents are not deletable). Label with --label-tests');
  line('        so nobody mistakes them for real invoices.');

  const drafts = await db.query(`
    select i.id, i.invoice_number from public.invoices i
     where i.invoice_uuid is null and i.internal_status in ('draft','pending_internal_approval')
       and i.invoice_number like '%DRAFT%' or (i.invoice_uuid is null and i.notes_internal like '%Verification artifact%')`);
  line(`\n  3 · ORPHAN DRAFTS (never issued, never shown) — ${drafts.rows.length}`);
  for (const r of drafts.rows) line(`      ${r.invoice_number}`);
  line('      → removable with --drop-orphan-drafts');

  line('\n  4 · THE DEMONSTRATION FIRMS');
  for (const [id, name] of Object.entries(DEMO_TENANTS)) {
    const counts = await tenantInventory(db, id);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    line(`      ${id}`);
    line(`        ${name}`);
    line(`        ${total} row(s): ` + Object.entries(counts).filter(([, n]) => n > 0)
      .map(([t, n]) => `${t} ${n}`).join(' · '));
  }
  line('      → --purge-demo --confirm <uuid> removes one of them, in one transaction.');
  line('        It refuses anything that is not one of the two above.');
}

/** Row counts for one tenant, table by table, for the tables that carry tenant_id. */
async function tenantInventory(db, tenantId) {
  const cols = await db.query(`
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
     order by c.table_name`);
  const out = {};
  for (const { table_name: table } of cols.rows) {
    const r = await db.query(`select count(*)::int n from public.${table} where tenant_id = $1`, [tenantId]);
    if (r.rows[0].n > 0) out[table] = r.rows[0].n;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Label the fiscal self-test documents, so a permanent artifact is at least an
 * unmistakable one.
 *
 * The update touches `notes_internal` only — no figure, no fiscal field, no status. The
 * immutability guards permit a note and refuse everything that would change the document,
 * which is exactly the line this action stays behind. Idempotent: a document already
 * labelled is not touched again.
 */
async function labelTests(db) {
  const marker = 'FISCAL SELF-TEST ARTIFACT — not a real invoice';
  const r = await db.query(`
    update public.invoices
       set notes_internal = case
             when notes_internal is null or notes_internal = '' then $1
             when notes_internal like '%' || $1 || '%' then notes_internal
             else $1 || ' · ' || notes_internal
           end,
           updated_at = now()
     where invoice_number like 'LIVE-FISCAL-%'
       and (notes_internal is null or notes_internal not like '%' || $1 || '%')`, [marker]);
  line(`\n  labelled ${r.rowCount} fiscal self-test document(s)`);
  const left = await db.query(`
    select count(*)::int n from public.invoices
     where invoice_number like 'LIVE-FISCAL-%' and notes_internal like '%' || $1 || '%'`, [marker]);
  line(`  ${left.rows[0].n} now carry the label`);
}

/**
 * Remove a demonstration tenant and everything that hangs off it.
 *
 * ORDER IS NOT OPTIONAL. The database is full of references between these tables, and a
 * bulk delete in the wrong order fails on a foreign key at best and at worst leaves rows
 * that no longer belong to anything. The order below is children before parents, starting
 * from the leaves of the reference graph (money, documents, time, messages) and ending at
 * the tenant row itself.
 *
 * WHAT IS DELIBERATELY NOT TOUCHED: `audit_events`. The trail is append-only — the
 * database refuses deletes — and it is the record that a tenant existed and what happened
 * inside it. Deleting a firm is not a reason to destroy the evidence of what it did.
 * `kgm_migrations` is untouched for the same class of reason: it is the database's own
 * history rather than a tenant's data.
 */
async function purgeTenant(db, tenantId, opts = {}) {
  if (!DEMO_TENANTS[tenantId]) {
    throw new Error(
      `refusing to purge tenant ${tenantId}: it is not one of the two demonstration tenants. `
      + `This tool deletes demonstration data; removing a firm that has done real work is a `
      + `different decision and needs a different procedure.`,
    );
  }

  const before = await tenantInventory(db, tenantId);
  line(`\n  about to remove: ${DEMO_TENANTS[tenantId]} (${tenantId})`);
  line(`  ${Object.values(before).reduce((a, b) => a + b, 0)} row(s) across ${Object.keys(before).length} table(s):`);
  for (const [t, n] of Object.entries(before)) line(`      ${String(n).padStart(6)}  ${t}`);

  const ownTransaction = !opts.insideTransaction;
  if (ownTransaction) await db.query('begin');
  try {
    /* Every table that carries tenant_id, children first. `documents` before `matters`
       (their storage keys, their versions); `invoice_lines` before `invoices`; the
       ledgers before the clients they belong to. */
    const order = [
      'message_attachments', 'message_reads', 'messages', 'message_threads',
      'notification_preferences', 'notifications', 'security_alerts',
      'document_access_log', 'documents',
      'invoice_submissions', 'credit_notes', 'payments', 'invoice_lines', 'invoices',
      'ledger_reconciliations', 'ledger_entries', 'client_ledgers',
      'time_entries', 'expenses', 'rate_cards',
      'matter_billing_terms', 'engagement_letters', 'privilege_releases',
      'matter_permissions', 'matter_team', 'matter_timeline', 'matter_parties',
      'matter_controls', 'matters',
      'conflict_hits', 'conflict_waivers', 'conflict_checks',
      'str_reports', 'screening_matches', 'screening_runs',
      'client_due_diligence', 'beneficial_owners', 'privacy_requests', 'consent_records',
      'judgment_appeals', 'judgments', 'hearings', 'appointments', 'court_calendar', 'deadlines',
      'party_aliases', 'party_affiliations', 'internal_notes', 'data_exports',
      'client_devices', 'client_sessions', 'client_users', 'client_invitations',
      'login_attempts', 'auth_tokens', 'mfa_recovery_codes',
      'firm_sessions', 'firm_devices', 'firm_invitations', 'firm_invitation_roles',
      'membership_roles', 'membership_practice_areas', 'department_members',
      'departments',
      /*
        'roles' IS DELIBERATELY ABSENT, and the first draft of this order had it wrong —
        the dry run below refused with `system roles cannot be deleted or unmarked`,
        which is migration 00xx's trigger doing its job. A tenant's nine roles are the
        SYSTEM TEMPLATES copied into it at seed time: `is_system` marks them as the
        catalogue's own definitions rather than the firm's, and the database refuses to
        delete or demote them so that a firm cannot lose the definitions its members'
        permissions are drawn from. Removing a firm is not a reason to remove the
        catalogue, so the rows stay; they carry the dead tenant's id and nothing
        references them once the memberships are gone.
      */
      'permissions',
      'professional_licences', 'prior_office', 'eligibility_checks',
      'aml_risk_countries', 'service_events', 'payment_webhook_events',
      'tenant_relationships', 'tenant_settings',
      'fiscal_devices', 'fiscal_identity',
    ];
    let total = 0;
    for (const table of order) {
      const exists = await db.query(
        `select 1 from information_schema.columns
          where table_schema='public' and table_name=$1 and column_name='tenant_id'`, [table]);
      if (!exists.rows.length) continue;
      const r = await db.query(`delete from public.${table} where tenant_id = $1`, [tenantId]);
      if (r.rowCount) { total += r.rowCount; line(`      deleted ${String(r.rowCount).padStart(5)}  ${table}`); }
    }

    /* Users are shared across tenants by design (one identity, many memberships), so they
       go only if they belong to no other tenant. */
    /*
      THE TAIL IS ORDERED BY WHAT REFERENCES WHAT, and the dry run is what established the
      order rather than a reading of the schema:

        firm_memberships  before staff   — a membership names the staff record
        clients           before parties — a client IS a party (clients.party_id)
        users             LAST          — an identity is shared across tenants by design,
                                          so it is removed only when nothing in either
                                          audience points at it any more
        tenants           very last      — everything above carries its id

      `staff` carries no user_id: a staff record is a person on the firm's books and a
      membership is their login, and the two are joined through firm_memberships.
    */
    const memberships = await db.query(`delete from public.firm_memberships where tenant_id = $1`, [tenantId]);
    line(`      deleted ${String(memberships.rowCount).padStart(5)}  firm_memberships`);
    total += memberships.rowCount;

    const staff = await db.query(`delete from public.staff where tenant_id = $1`, [tenantId]);
    line(`      deleted ${String(staff.rowCount).padStart(5)}  staff`);
    total += staff.rowCount;

    const clients = await db.query(
      `delete from public.clients where tenant_id = $1 and not exists
         (select 1 from public.matters m where m.client_id = clients.id)`, [tenantId]);
    line(`      deleted ${String(clients.rowCount).padStart(5)}  clients`);
    total += clients.rowCount;

    const parties = await db.query(`delete from public.parties where tenant_id = $1`, [tenantId]);
    line(`      deleted ${String(parties.rowCount).padStart(5)}  parties`);
    total += parties.rowCount;

    const users = await db.query(`
      delete from public.users u
       where not exists (select 1 from public.firm_memberships m where m.user_id = u.id)
         and not exists (select 1 from public.client_users c where c.user_id = u.id)
      returning id`);
    line(`      deleted ${String(users.rowCount).padStart(5)}  identities that belonged to no one else`);
    total += users.rowCount;

    /*
      ── THE FIRM ITSELF IS CLOSED, NOT DELETED, AND THAT IS THE SCHEMA'S DECISION ─────

      `delete from tenants` was the first thing this function tried, and two independent
      rules refused it: sixty-odd foreign keys are declared ON DELETE RESTRICT, and the
      tenant's nine role rows are system templates that `roles_system_guard` will not
      delete or demote. Together those say something plainly: this schema does not
      consider a firm a row that can be removed. It considers it one that can be CLOSED —
      `tenants.status` is checked against 'active' | 'suspended' | 'archived'.

      So the purge removes every row that belongs to the firm and then marks the firm
      itself. The slug is freed so the name cannot be reused by accident, and the row is
      renamed so a reader of the database sees what happened without a comment. What
      remains is a label, a status, and the permission catalogue the memberships used.
    */
    const tenant = await db.query(`
      update public.tenants
         set status = 'archived',
             slug = slug || '-archived-' || to_char(now(), 'YYYYMMDD'),
             name = 'ARCHIVED — ' || name,
             updated_at = now()
       where id = $1`, [tenantId]);
    line(`      marked      ${String(tenant.rowCount).padStart(5)}  tenant as archived (the schema refuses deletion; see the comment in the source)`);
    total += tenant.rowCount;

    if (ownTransaction) await db.query('commit');
    line(`\n  removed ${total} row(s) in one transaction.`);
    line('  LEFT DELIBERATELY, and each for its own reason:');
    line('    · audit_events — append-only; the database refuses their deletion, and the record');
    line('      that this firm existed and what was done inside it is not a thing to destroy.');
    line('    · roles — the permission catalogue, held as system templates the schema will not');
    line('      delete or demote. They are the definitions the memberships were built from.');
    line('    · the tenants row — closed and renamed rather than removed (see the source).');
  } catch (err) {
    if (ownTransaction) await db.query('rollback');
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
/**
 * THE ISOLATION FIXTURE · the neighbour row the negative tests reach for
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS AT ALL, GIVEN THAT EVERYTHING ELSE HERE REMOVES DATA
 *
 *   `documents-live.mjs`, `intake-live.mjs` and `eligibility-live.mjs` each end with a
 *   block that asks, as the KGM firm, for ANOTHER FIRM'S client, matter and document, and
 *   asserts a 404 that is byte-identical to the answer for a matter that does not exist.
 *   The second half of that claim — "the door is no oracle" — is provable with a made-up
 *   uuid. The first half is not: to show that a REAL foreign row is refused, a real
 *   foreign row has to exist.
 *
 *   That is what purging the second firm removed, and the failure mode is quiet. The
 *   intake harness looked its neighbour up with `select … limit 1` and fell back to a
 *   fabricated id when the query returned nothing, so after the purge it compared two
 *   fabricated 404s and passed — the exact "negative test against an id that is not real
 *   proves only that the server refuses things that are not there" that its own comment
 *   warns about.
 *
 *   So the fixture is rebuilt here, deliberately, with the ids the harnesses already
 *   name. It is NOT a demonstration firm: no staff, no memberships, no sessions, no
 *   client user, nothing that can be signed into, and no client-visible document. It is
 *   one client, one matter and one document, and their only purpose is to be on the wrong
 *   side of a tenant boundary.
 *
 * The document is filed with `client_visibility = 'internal'` and a synthetic sha256:
 * it is never rendered and never downloaded by anything, only counted.
 */
const NEIGHBOUR = {
  tenantId: 'bbbbbbbb-0000-4000-8000-000000000002',
  clientId: 'cccccccc-0000-4000-8000-000000000003',
  matterId: 'eeeeeeee-0000-4000-8000-000000000005',
  documentId: 'c1000000-0000-4000-8000-000000000006',
};

async function seedNeighbour(db) {
  line('\n  THE ISOLATION FIXTURE — the row the negative tests must find');
  await db.query('begin');
  try {
    /* The tenant stays ARCHIVED. It is not reopened for this: the fixture exists to be
       invisible to every firm-facing surface, and an archived tenant is the state that
       says so. */
    await db.query(
      `insert into public.clients
         (id, tenant_id, client_type, name, country, identity_verified, status, created_at, updated_at)
       values ($1, $2, 'organization', 'Isolation Fixture Client', 'SA', true, 'active', now(), now())
       on conflict (id) do nothing`,
      [NEIGHBOUR.clientId, NEIGHBOUR.tenantId]);

    await db.query(
      `insert into public.matters
         (id, tenant_id, client_id, matter_number, title, title_ar, practice_area, practice_area_ar,
          internal_status, client_status, opened_at, created_at, updated_at)
       values ($1, $2, $3, 'ISO-FIX-0001', 'Isolation fixture matter', 'ملف اختبار العزل',
               'commercial', 'تجاري', 'active', 'opened', now(), now(), now())
       on conflict (id) do nothing`,
      [NEIGHBOUR.matterId, NEIGHBOUR.tenantId, NEIGHBOUR.clientId]);

    await db.query(
      `insert into public.documents
         (id, tenant_id, client_id, matter_id, storage_bucket, storage_key, original_filename,
          stored_filename, title, document_type, category, origin, version, mime_type, size_bytes,
          sha256, scan_status, status, client_visibility, requested, created_at, updated_at, privilege_class)
       values ($1, $2, $3, $4, 'kgm-documents', $5, 'isolation-fixture.pdf', 'isolation-fixture.pdf',
               'Isolation fixture document', 'contract', 'from_firm', 'firm', 1, 'application/pdf', 0,
               repeat('0', 64), 'clean', 'available', 'internal', false, now(), now(), 'none')
       on conflict (id) do nothing`,
      [NEIGHBOUR.documentId, NEIGHBOUR.tenantId, NEIGHBOUR.clientId, NEIGHBOUR.matterId,
        `${NEIGHBOUR.tenantId}/${NEIGHBOUR.matterId}/isolation-fixture.pdf`]);

    const counts = await db.query(
      `select (select count(*) from public.clients   where tenant_id = $1) clients,
              (select count(*) from public.matters   where tenant_id = $1) matters,
              (select count(*) from public.documents where tenant_id = $1) documents,
              (select count(*) from public.firm_memberships where tenant_id = $1) memberships,
              (select count(*) from public.client_users where tenant_id = $1) client_users`,
      [NEIGHBOUR.tenantId]);
    const c = counts.rows[0];
    line(`      clients ${c.clients} · matters ${c.matters} · documents ${c.documents}`);
    line(`      memberships ${c.memberships} · client users ${c.client_users}  (both must be 0)`);
    if (Number(c.memberships) !== 0 || Number(c.client_users) !== 0) {
      throw new Error('the fixture tenant must have NO credentials: it exists to be unreachable, not to be signed into');
    }
    await db.query('commit');
    line('  ✓ the fixture is in place — the IDs the harnesses name now exist, in another firm.');
    line('    Re-check isolation with: node scripts/verify/documents-live.mjs');
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
}

async function main() {
  const db = connect();
  await db.connect();
  try {
    if (has('--purge-demo')) {
      const tenantId = valueOf('--confirm');
      if (!tenantId) {
        line('\n  --purge-demo needs --confirm <tenant-uuid>. Nothing was removed.');
        line('  Run without flags to see the inventory of each demonstration tenant.\n');
        await report(db);
        return;
      }
      /* --dry-run performs every statement and then rolls the whole thing back. It is
         the only honest way to know the deletion order is correct: a foreign key that
         the order has wrong fails here, on a database nobody minds about, rather than
         at 2am on the night the firm goes live. */
      if (has('--dry-run')) {
        line('\n  DRY RUN — every delete is executed and then rolled back. Nothing is removed.');
        await db.query('begin');
        try {
          await purgeTenant(db, tenantId, { insideTransaction: true });
        } finally {
          await db.query('rollback');
          line('\n  rolled back. The database is exactly as it was.');
        }
        return;
      }
      await purgeTenant(db, tenantId);
      return;
    }
    /*
      THE ONE WRITE HERE THAT ADDS RATHER THAN REMOVES, and it is deliberate — see the
      comment on `seedNeighbour`. Purging the second firm removed the foreign row that
      three live harnesses assert against, and one of them degraded from a real check to a
      vacuous one without going red.
    */
    if (has('--seed-neighbour')) await seedNeighbour(db);
    if (has('--label-tests')) await labelTests(db);
    if (has('--drop-orphan-drafts')) {
      const r = await db.query(`
        delete from public.invoices i
         where i.invoice_uuid is null
           and i.internal_status in ('draft','pending_internal_approval')
           and not exists (select 1 from public.time_entries te where te.invoice_id = i.id)
           and not exists (select 1 from public.expenses e where e.invoice_id = i.id)
           and (select count(*) from public.invoice_lines l where l.invoice_id = i.id) = 0
        returning id`);
      line(`\n  removed ${r.rowCount} empty draft(s) — none held recorded work`);
    }
    if (!has('--label-tests') && !has('--drop-orphan-drafts') && !has('--seed-neighbour')) await report(db);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(`\n  ✗ ${err.message}\n`);
  process.exit(1);
});
