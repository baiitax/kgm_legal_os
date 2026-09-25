/**
 * Synthetic demo dataset (§44).
 *
 * EVERY value here is fictional. No real national IDs, passport numbers,
 * phone numbers, documents or financial accounts appear anywhere in this file.
 *
 * The dataset is deliberately adversarial: it contains a second tenant and a
 * second client inside the primary tenant, plus internal-only rows that must
 * never surface in the portal. That is what makes the isolation tests in
 * tests/security meaningful rather than decorative.
 *
 *   T1 KGM Law Firm          ← primary tenant
 *     C1 Ahmed Al-Saud       ← the demo login
 *     C2 Gulf Horizon Trading← same tenant, different client (isolation test)
 *   T2 Najd Legal Partners   ← different tenant (tenancy test)
 *     C3 Layla Mansour
 */
import crypto from 'node:crypto';
import { hashPassword, keyedHash } from '../lib/crypto.js';
import { PERMISSIONS, ROLE_TEMPLATES, TEMPLATE_GRANTS } from '../domain/firm-catalogue.js';
// The seed normalises party names with the SAME function the conflict engine uses.
// A seed that reimplemented it would produce a register that does not match its own
// contents — the failure mode the whole two-dialect discipline exists to prevent.
import { normalizeArabicName } from '../domain/arabic-names.js';
import {
  buildQrPayload, buildInvoiceXml, invoiceHash, GENESIS_PIH,
} from '../domain/zatca.js';

/**
 * Deterministic UUID derived from a stable label.
 *
 * Every seeded row must survive a restart without duplicating: the demo
 * dataset has natural unique keys (tenant_id + code, matter_id + staff_id, ...)
 * that would silently swallow a re-insert while leaving a random surrogate id
 * dangling. Deriving ids from labels makes the whole seed idempotent.
 */
/*
  THE ISSUANCE PASS.

  `buildDemoSeed` returns INSERTS, and inserts are applied table by table in dependency
  order — which means every invoice is written before any of its lines. Issuing an
  invoice is a different act from creating one, and it must happen after the lines
  exist, so it is a second phase: the builder fills this list while it emits the
  invoices, and the seeder applies it once the inserts are done.

  It is not a workaround. It is the same two-step the product performs — draft, then
  issue — and the demo data now demonstrates the lifecycle instead of asserting its
  result.
*/
export interface DemoIssuance { id: string; set: Record<string, unknown>; }
let issuances: DemoIssuance[] = [];

/** The issuance phase produced by the most recent `buildDemoSeed()` call. */
export function demoIssuances(): readonly DemoIssuance[] {
  return issuances;
}

export function detId(label: string): string {
  const h = crypto.createHash('sha256').update(`kgm-demo:${label}`).digest('hex');
  const bytes = [...h.slice(0, 32).matchAll(/../g)].map((m) => parseInt(m[0], 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;   // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80;   // RFC 4122 variant
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable ids so cross-references resolve and re-seeding is idempotent. */
export const IDS = {
  tenantKgm: 'aaaaaaaa-0000-4000-8000-000000000001',
  tenantNajd: 'bbbbbbbb-0000-4000-8000-000000000002',
  clientAhmed: 'cccccccc-0000-4000-8000-000000000001',
  clientGulf: 'cccccccc-0000-4000-8000-000000000002',
  clientLayla: 'cccccccc-0000-4000-8000-000000000003',
  userAhmed: 'dddddddd-0000-4000-8000-000000000001',
  userGulf: 'dddddddd-0000-4000-8000-000000000002',
  userLayla: 'dddddddd-0000-4000-8000-000000000003',
  matterCommercial: 'eeeeeeee-0000-4000-8000-000000000001',
  matterRealEstate: 'eeeeeeee-0000-4000-8000-000000000002',
  matterEmployment: 'eeeeeeee-0000-4000-8000-000000000003',
  matterGulf: 'eeeeeeee-0000-4000-8000-000000000004',
  matterLayla: 'eeeeeeee-0000-4000-8000-000000000005',
  // P0.1 · closed matters, for the Rule 8/4 windows. A conflict check that cannot
  // see a closed file cannot see a former client, and Rule 8 is mostly about
  // former clients.
  matterNukhba: 'eeeeeeee-0000-4000-8000-000000000006',
  matterQadim: 'eeeeeeee-0000-4000-8000-000000000007',
  clientNukhba: 'cccccccc-0000-4000-8000-000000000004',
  clientQadim: 'cccccccc-0000-4000-8000-000000000005',
  partyAhmed: '11111111-0000-4000-8000-000000000001',
  partyGulf: '11111111-0000-4000-8000-000000000002',
  partyLayla: '11111111-0000-4000-8000-000000000003',
  partyNukhba: '11111111-0000-4000-8000-000000000004',
  partyQadim: '11111111-0000-4000-8000-000000000005',
  partyFajr: '11111111-0000-4000-8000-000000000006',
  partyFajrVariant: '11111111-0000-4000-8000-000000000007',
  partyRiyadh: '11111111-0000-4000-8000-000000000008',
  // Firm OS identities. A firm member is a `users` row plus a `firm_memberships`
  // row; the two audiences never share an authorization surface (§6).
  userNoura: 'dddddddd-0000-4000-8000-000000000011',
  userFaisal: 'dddddddd-0000-4000-8000-000000000012',
  userMariam: 'dddddddd-0000-4000-8000-000000000013',
  userOmar: 'dddddddd-0000-4000-8000-000000000014',
  userSara: 'dddddddd-0000-4000-8000-000000000015',
  // P0.3 · a client the firm was asked to act for and could not identify. It has a
  // record and no matter, because the matter is exactly what the obligation forbids.
  clientFajr: 'cccccccc-0000-4000-8000-000000000006',
} as const;

export const DEMO_PASSWORD = 'Demo!Portal2026';

export const DEMO_ACCOUNTS = [
  { email: 'ahmed.alsaud@example.test', password: DEMO_PASSWORD, who: 'Ahmed Al-Saud (KGM · Client 1)' },
  { email: 'finance@gulfhorizon.example.test', password: DEMO_PASSWORD, who: 'Gulf Horizon Trading (KGM · Client 2)' },
  { email: 'layla.mansour@example.test', password: DEMO_PASSWORD, who: 'Layla Mansour (Najd · other tenant)' },
] as const;

/**
 * Firm OS demo logins. Deliberately a DIFFERENT password from the client
 * accounts: the two products must not share a credential, and a tester who
 * types the client password into the firm login gets a clean 401 rather than an
 * accidental cross-audience sign-in.
 */
export const DEMO_FIRM_PASSWORD = 'Demo!Firm2026';

export const DEMO_FIRM_ACCOUNTS = [
  { email: 'noura@kgm.example.test',  password: DEMO_FIRM_PASSWORD, who: 'Noura Al-Qahtani — Managing Partner (all practice areas)' },
  { email: 'faisal@kgm.example.test', password: DEMO_FIRM_PASSWORD, who: 'Faisal Al-Harbi — Lawyer (Commercial Litigation, Real Estate)' },
  { email: 'mariam@kgm.example.test', password: DEMO_FIRM_PASSWORD, who: 'Mariam Al-Zahrani — Paralegal (Commercial Litigation)' },
  { email: 'omar@kgm.example.test',   password: DEMO_FIRM_PASSWORD, who: 'Omar Al-Dossary — Compliance (assigned matters only)' },
  { email: 'partner@najd.example.test', password: DEMO_FIRM_PASSWORD, who: 'Sultan Al-Otaibi — Najd Legal Partners (a second firm: no fiscal identity)' },
  { email: 'sara@kgm.example.test',   password: DEMO_FIRM_PASSWORD, who: 'Sara Al-Otaibi — Finance (billing.read_all, 25,000 SAR ceiling)' },
] as const;

const DAY = 86_400_000;
const iso = (offsetDays: number, hour = 9, minute = 0) => {
  const d = new Date(Date.now() + offsetDays * DAY);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
};
const date = (offsetDays: number) => iso(offsetDays).slice(0, 10);

/**
 * Placeholder bytes for a seeded document (§44).
 *
 * A document row with nothing behind it is worse than no row at all: it renders
 * as a downloadable file in the portal and then fails at click time. So the demo
 * dataset materializes a structurally valid, clearly-labelled PDF for every
 * document it inserts. The content is synthetic and self-describing.
 */
export function demoFileBytes(label: string, docId: string): Buffer {
  const safe = String(label).replace(/[()\\]/g, ' ').slice(0, 80);
  const body = [
    `KGM LEGAL OS - DEMO DOCUMENT`,
    `${safe}`,
    `Synthetic content. Not a real legal instrument.`,
    `id: ${docId}`,
  ];
  const lines = body
    .map((t, i) => `BT /F1 ${i === 0 ? 16 : 11} Tf 56 ${740 - i * 26} Td (${t}) Tj ET`)
    .join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${lines.length} >>\nstream\n${lines}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export interface SeedRow {
  table: string;
  row: Record<string, unknown>;
}

export function buildDemoSeed(): SeedRow[] {
  issuances = [];
  const now = new Date().toISOString();
  const rows: SeedRow[] = [];
  const add = (table: string, row: Record<string, unknown>) => rows.push({ table, row });

  // ---------------------------------------------------------------- tenants
  add('tenants', {
    id: IDS.tenantKgm, slug: 'kgm', name: 'KGM Law Firm', name_ar: 'شركة كيه جي إم للمحاماة',
    country: 'SA', default_language: 'ar', default_calendar: 'islamic-umalqura',
    status: 'active', created_at: now, updated_at: now,
  });
  add('tenants', {
    id: IDS.tenantNajd, slug: 'najd', name: 'Najd Legal Partners', name_ar: 'شركاء نجد القانونيون',
    country: 'SA', default_language: 'ar', default_calendar: 'islamic-umalqura',
    status: 'active', created_at: now, updated_at: now,
  });

  // ---------------------------------------------------------------- clients
  const parties = [
    { id: IDS.partyAhmed, tenant: IDS.tenantKgm, kind: 'individual',
      name: 'Ahmed Al-Saud', nameAr: 'أحمد آل سعود', cr: null, vat: null },
    { id: IDS.partyGulf, tenant: IDS.tenantKgm, kind: 'company',
      name: 'Gulf Horizon Trading Co.', nameAr: 'شركة الأفق للتجارة', cr: '1010556677', vat: '300055667700003' },
    { id: IDS.partyNukhba, tenant: IDS.tenantKgm, kind: 'company',
      name: 'Al-Nukhba Trading Est.', nameAr: 'مؤسسة النخبة التجارية', cr: '1010334455', vat: null },
    { id: IDS.partyQadim, tenant: IDS.tenantKgm, kind: 'company',
      name: 'Qadim Logistics Co.', nameAr: 'شركة قديم للخدمات اللوجستية', cr: '4030998877', vat: null },
    { id: IDS.partyFajr, tenant: IDS.tenantKgm, kind: 'company',
      name: 'Al-Fajr Contracting Co.', nameAr: 'شركة الفجر للمقاولات', cr: '1010887766', vat: null },
    // The same name as recorded by a different clerk at intake. Its own row, because
    // the firm does not yet KNOW it is the same company — that is the question the
    // matcher asks and a person answers.
    { id: IDS.partyFajrVariant, tenant: IDS.tenantKgm, kind: 'company',
      name: 'Al-Fajr Contracting & Trading Co.', nameAr: 'شركة الفجر للمقاولات والتجارة',
      cr: null, vat: null },
    { id: IDS.partyRiyadh, tenant: IDS.tenantKgm, kind: 'company',
      name: 'Riyadh Holding Group', nameAr: 'مجموعة الرياض القابضة', cr: '1010123456', vat: null },
    { id: IDS.partyLayla, tenant: IDS.tenantNajd, kind: 'individual',
      name: 'Layla Mansour', nameAr: 'ليلى منصور', cr: null, vat: null },
  ];
  for (const p of parties) {
    add('parties', {
      id: p.id, tenant_id: p.tenant, kind: p.kind, name: p.name, name_ar: p.nameAr,
      // DERIVED, and derived by the SAME function the engine uses — imported rather
      // than reimplemented, because a seed whose normalisation differs from the
      // search's would produce a register that does not match its own contents.
      name_normalized: normalizeArabicName([p.nameAr, p.name].filter(Boolean).join(' ')),
      commercial_registration: p.cr, vat_number: p.vat,
      national_id_masked: null, national_id_hash: null,
      status: 'active', merged_into_party_id: null, notes: null,
      created_by_membership_id: null, created_at: now, updated_at: now,
    });
  }

  /*
    ── `identity_verified` IS NOT ASSERTED HERE ────────────────────────────────

    Every client row in this file states ZERO, including the two whose identity has
    genuinely been verified. The flag is derived — from whether a current
    due-diligence record exists and is complete — and the derivation runs as a
    deferred pass at the end of the seed, the same way invoice issuance does, for
    the same reason: the records it reads do not exist yet when these rows are
    written.

    A fixture that typed `1` here would be the defect this phase exists to remove,
    one layer up.
  */
  add('clients', {
    id: IDS.clientAhmed, tenant_id: IDS.tenantKgm, client_type: 'individual',
    name: 'Ahmed Al-Saud', name_ar: 'أحمد السعود',
    national_id_masked: '********1234', national_id_hash: keyedHash('demo-nid-1234'),
    email: 'ahmed.alsaud@example.test', phone: '+966 5X XXX 1234',
    address_line: 'King Fahd Road, Al Olaya', city: 'Riyadh', country: 'SA',
    identity_verified: 0, verification_note: 'Verified via Absher integration (demo)',
    status: 'active', created_at: now, updated_at: now,
      party_id: IDS.partyAhmed,
    relationship_ended_on: null,
});
  add('clients', {
    id: IDS.clientGulf, tenant_id: IDS.tenantKgm, client_type: 'organization',
    name: 'Gulf Horizon Trading Co.', name_ar: 'شركة الأفق التجاري',
    commercial_reg_masked: '******789', national_id_masked: null, national_id_hash: null,
    email: 'finance@gulfhorizon.example.test', phone: '+966 1X XXX 5678',
    address_line: 'Corniche Road, Al Shatea', city: 'Jeddah', country: 'SA',
    identity_verified: 0, verification_note: 'CR verified (demo)',
    status: 'active', created_at: now, updated_at: now,
      party_id: IDS.partyGulf,
    relationship_ended_on: null,
});
  add('clients', {
    id: IDS.clientLayla, tenant_id: IDS.tenantNajd, client_type: 'individual',
    name: 'Layla Mansour', name_ar: 'ليلى منصور',
    national_id_masked: '********5678', national_id_hash: keyedHash('demo-nid-5678'),
    email: 'layla.mansour@example.test', phone: '+966 5X XXX 9012',
    address_line: 'Prince Sultan Road', city: 'Khobar', country: 'SA',
    identity_verified: 0, verification_note: null,
    status: 'active', created_at: now, updated_at: now,
      party_id: IDS.partyLayla,
    relationship_ended_on: null,
});

  // ------------------------------------------------------------------ users
  const pw = hashPassword(DEMO_PASSWORD);
  add('users', {
    id: IDS.userAhmed, email: 'ahmed.alsaud@example.test', password_hash: pw,
    password_updated_at: now, email_verified_at: now, status: 'active',
    failed_login_count: 0, locked_until: null, last_login_at: null, last_login_ip_hash: null,
    mfa_enabled: 0, mfa_method: null, mfa_secret_enc: null, mfa_enabled_at: null,
    preferred_language: 'ar', preferred_calendar: 'islamic-umalqura',
    created_at: now, updated_at: now,
  });
  add('users', {
    id: IDS.userGulf, email: 'finance@gulfhorizon.example.test', password_hash: pw,
    password_updated_at: now, email_verified_at: now, status: 'active',
    failed_login_count: 0, locked_until: null, last_login_at: null, last_login_ip_hash: null,
    mfa_enabled: 0, mfa_method: null, mfa_secret_enc: null, mfa_enabled_at: null,
    preferred_language: 'en', preferred_calendar: 'gregory',
    created_at: now, updated_at: now,
  });
  add('users', {
    id: IDS.userLayla, email: 'layla.mansour@example.test', password_hash: pw,
    password_updated_at: now, email_verified_at: now, status: 'active',
    failed_login_count: 0, locked_until: null, last_login_at: null, last_login_ip_hash: null,
    mfa_enabled: 0, mfa_method: null, mfa_secret_enc: null, mfa_enabled_at: null,
    preferred_language: 'ar', preferred_calendar: 'islamic-umalqura',
    created_at: now, updated_at: now,
  });

  // ----------------------------------------------------------- client_users
  add('client_users', {
    id: detId(`client_user:${IDS.userAhmed}:${IDS.clientAhmed}`), user_id: IDS.userAhmed, client_id: IDS.clientAhmed, tenant_id: IDS.tenantKgm,
    display_name: 'Ahmed Al-Saud', display_name_ar: 'أحمد السعود', job_title: null,
    phone: '+966 5X XXX 1234', portal_role: 'client_primary', status: 'active',
    created_by_staff: null, created_at: now, updated_at: now,
  });
  add('client_users', {
    id: detId(`client_user:${IDS.userGulf}:${IDS.clientGulf}`), user_id: IDS.userGulf, client_id: IDS.clientGulf, tenant_id: IDS.tenantKgm,
    display_name: 'Finance Department', display_name_ar: 'الإدارة المالية', job_title: 'Finance Manager',
    phone: '+966 1X XXX 5678', portal_role: 'client_primary', status: 'active',
    created_by_staff: null, created_at: now, updated_at: now,
  });
  add('client_users', {
    id: detId(`client_user:${IDS.userLayla}:${IDS.clientLayla}`), user_id: IDS.userLayla, client_id: IDS.clientLayla, tenant_id: IDS.tenantNajd,
    display_name: 'Layla Mansour', display_name_ar: 'ليلى منصور', job_title: null,
    phone: '+966 5X XXX 9012', portal_role: 'client_primary', status: 'active',
    created_by_staff: null, created_at: now, updated_at: now,
  });

  // ------------------------------------------------------------------ staff
  const staff = [
    { id: 'f1000000-0000-4000-8000-000000000001', name: 'Noura Al-Qahtani', ar: 'نورة القحطاني',
      role: 'managing_partner', visible: 1, title: 'Managing Partner', titleAr: 'الشريكة الإدارية' },
    { id: 'f1000000-0000-4000-8000-000000000002', name: 'Faisal Al-Harbi', ar: 'فيصل الحربي',
      role: 'lawyer', visible: 1, title: 'Senior Associate', titleAr: 'محامٍ أول' },
    { id: 'f1000000-0000-4000-8000-000000000003', name: 'Mariam Al-Zahrani', ar: 'مريم الزهراني',
      role: 'paralegal', visible: 1, title: 'Paralegal', titleAr: 'مساعدة قانونية' },
    // INTERNAL ONLY — must never appear in the portal (§11).
    { id: 'f1000000-0000-4000-8000-000000000004', name: 'Omar Al-Dossary', ar: 'عمر الدوسري',
      role: 'compliance', visible: 0, title: null, titleAr: null },
    { id: 'f1000000-0000-4000-8000-000000000005', name: 'Sara Al-Otaibi', ar: 'سارة العتيبي',
      role: 'finance', visible: 0, title: null, titleAr: null },
  ];
  for (const s of staff) {
    add('staff', {
      id: s.id, tenant_id: IDS.tenantKgm, full_name: s.name, full_name_ar: s.ar,
      email: `${s.name.split(' ')[0].toLowerCase()}@kgm.example.test`, internal_role: s.role,
      bar_number: s.role === 'lawyer' || s.role === 'managing_partner' ? 'LSA-DEMO-0000' : null,
      client_visible: s.visible, client_title: s.title, client_title_ar: s.titleAr,
      is_active: 1, created_at: now,
    });
  }

  // ---------------------------------------------------------------- matters
  /*
    Two FORMER CLIENTS, and their closed matters.

    They exist for Rule 8, which is a prohibition on acting against former clients —
    so a demo dataset that contains only a current client cannot exercise the rule
    at all. The two are dated to land on opposite sides of القاعدة ٨/٤'s three years,
    so the demo shows the rule AND its exception:

      · النخبة  — relationship ended 15 August 2024. Three years run to 15 August
                  2027, so acting against them today is a POTENTIAL conflict that
                  needs their written consent.
      · قديم    — relationship ended 30 June 2019. The window closed in 2022, so
                  the rule says in terms that this is NOT a conflict. The finding is
                  still recorded, because "why is this not a problem" is the question
                  asked about a clearance later.
  */
  add('clients', {
    id: IDS.clientNukhba, tenant_id: IDS.tenantKgm, client_type: 'organization',
    name: 'Al-Nukhba Trading Est.', name_ar: 'مؤسسة النخبة التجارية',
    national_id_masked: null, national_id_hash: null, commercial_reg_masked: '******441',
    email: null, phone: null, address_line: null, city: 'Riyadh', country: 'SA',
    identity_verified: 0, verification_note: 'CR sighted at engagement (synthetic)',
    status: 'inactive', created_at: now, updated_at: now,
    party_id: IDS.partyNukhba, relationship_ended_on: '2024-08-15',
  });
  add('clients', {
    id: IDS.clientQadim, tenant_id: IDS.tenantKgm, client_type: 'organization',
    name: 'Qadim Logistics Co.', name_ar: 'شركة قديم للخدمات اللوجستية',
    national_id_masked: null, national_id_hash: null, commercial_reg_masked: '******902',
    email: null, phone: null, address_line: null, city: 'Jeddah', country: 'SA',
    identity_verified: 0, verification_note: 'Archived engagement (synthetic)',
    status: 'inactive', created_at: now, updated_at: now,
    party_id: IDS.partyQadim, relationship_ended_on: '2019-06-30',
  });

  const matters = [
    {
      id: IDS.matterCommercial, tenant: IDS.tenantKgm, client: IDS.clientAhmed,
      number: 'KGM-2026-0148', caseNo: '1447/12345',
      title: 'Commercial Dispute', titleAr: 'قضية تجارية',
      area: 'Commercial Litigation', areaAr: 'التقاضي التجاري',
      court: 'Commercial Court — Riyadh', courtAr: 'المحكمة التجارية بالرياض',
      internal: 'partner_review', clientStatus: 'hearings', opened: -14, lastUpdate: -1,
      summary: 'Dispute over unpaid invoices under a supply agreement.',
      summaryAr: 'نزاع حول فواتير غير مدفوعة بموجب اتفاقية توريد.',
      risk: 'high', conflict: null, notes: 'INTERNAL: partner to approve settlement posture before next session.',
    },
    {
      id: IDS.matterRealEstate, tenant: IDS.tenantKgm, client: IDS.clientAhmed,
      number: 'KGM-2026-0151', caseNo: null,
      title: 'Real Estate Contract Matter', titleAr: 'قضية عقد عقاري',
      area: 'Real Estate', areaAr: 'العقارات',
      court: null, courtAr: null,
      internal: 'internal_review', clientStatus: 'under_review', opened: -7, lastUpdate: -2,
      summary: 'Review and negotiation of a commercial lease agreement.',
      summaryAr: 'مراجعة والتفاوض على اتفاقية إيجار تجاري.',
      risk: 'medium', conflict: null, notes: 'INTERNAL: awaiting conflict clearance on counterparty.',
    },
    {
      id: IDS.matterEmployment, tenant: IDS.tenantKgm, client: IDS.clientAhmed,
      number: 'KGM-2026-0163', caseNo: null,
      title: 'Employment Dispute', titleAr: 'نزاع عمالي',
      area: 'Labour & Employment', areaAr: 'العمل والتوظيف',
      court: 'Labour Court — Riyadh', courtAr: 'محكمة الرياض العمالية',
      internal: 'conflict_check', clientStatus: 'opened', opened: -2, lastUpdate: 0,
      summary: 'Claim relating to end-of-service benefits.',
      summaryAr: 'مطالبة تتعلق بمكافأة نهاية الخدمة.',
      risk: 'low', conflict: null, notes: 'INTERNAL: conflict check in progress — do not contact client yet.',
    },
    {
      id: IDS.matterGulf, tenant: IDS.tenantKgm, client: IDS.clientGulf,
      number: 'KGM-2026-0170', caseNo: '1447/99887',
      title: 'Corporate Acquisition', titleAr: 'استحواذ شركات',
      area: 'Corporate / M&A', areaAr: 'الشركات والاندماج',
      court: null, courtAr: null,
      internal: 'active', clientStatus: 'under_review', opened: -30, lastUpdate: -5,
      summary: 'Acquisition of a logistics subsidiary.',
      summaryAr: 'الاستحواذ على شركة تابعة في قطاع الخدمات اللوجستية.',
      // DERIVED, and backed by the concluded check seeded at the end of this
      // function: one hit, dispositioned. It is the only matter in the dataset whose
      // clearance is EARNED rather than absent.
      risk: 'critical', conflict: 1, notes: 'INTERNAL: highly confidential — Client 2 only.',
    },
    {
      id: IDS.matterLayla, tenant: IDS.tenantNajd, client: IDS.clientLayla,
      number: 'NLP-2026-0021', caseNo: null,
      title: 'Cross-border Contract Review', titleAr: 'مراجعة عقد دولي',
      area: 'Contracts', areaAr: 'العقود',
      court: null, courtAr: null,
      internal: 'active', clientStatus: 'under_review', opened: -10, lastUpdate: -3,
      summary: 'Review of a cross-border distribution agreement.',
      summaryAr: 'مراجعة اتفاقية توزيع عابرة للحدود.',
      risk: 'medium', conflict: null, notes: 'INTERNAL: other firm, other tenant.',
    },
    {
      id: IDS.matterNukhba, tenant: IDS.tenantKgm, client: IDS.clientNukhba,
      number: 'KGM-2024-0112', caseNo: '1446/7777',
      title: 'Supply Agreement Drafting', titleAr: 'صياغة اتفاقية توريد',
      area: 'Commercial Litigation', areaAr: 'التقاضي التجاري',
      court: null, courtAr: null,
      internal: 'closed', clientStatus: 'closed', opened: -800, lastUpdate: -404,
      closed: '2024-08-15T09:00:00.000Z',
      summary: 'Drafting and negotiation of a supply agreement.',
      summaryAr: 'صياغة والتفاوض على اتفاقية توريد.',
      risk: 'low', conflict: null, notes: 'INTERNAL: closed on completion of the engagement.',
    },
    {
      id: IDS.matterQadim, tenant: IDS.tenantKgm, client: IDS.clientQadim,
      number: 'KGM-2019-0044', caseNo: null,
      title: 'Warehousing Dispute', titleAr: 'نزاع تخزين',
      area: 'Commercial Litigation', areaAr: 'التقاضي التجاري',
      court: 'Commercial Court — Jeddah', courtAr: 'المحكمة التجارية بجدة',
      internal: 'closed', clientStatus: 'closed', opened: -2600, lastUpdate: -2600,
      closed: '2019-06-30T09:00:00.000Z',
      summary: 'Warehousing liability claim, concluded by settlement.',
      summaryAr: 'مطالبة مسؤولية تخزين، انتهت بتسوية.',
      risk: 'medium', conflict: null, notes: 'INTERNAL: settled; retention applies.',
    },
  ];
  for (const m of matters) {
    add('matters', {
      id: m.id, tenant_id: m.tenant, client_id: m.client, matter_number: m.number,
      case_number: m.caseNo, title: m.title, title_ar: m.titleAr,
      practice_area: m.area, practice_area_ar: m.areaAr, court: m.court, court_ar: m.courtAr,
      internal_status: m.internal, client_status: m.clientStatus,
      summary: m.summary, summary_ar: m.summaryAr,
      opened_at: iso(m.opened),
      // A closed matter carries its closing date, because that date is where Rule
      // 8/4's three years start. It is not decoration.
      closed_at: (m as { closed?: string }).closed ?? null,
      last_client_update_at: iso(m.lastUpdate, 11),
      risk_rating: m.risk, conflict_cleared: m.conflict, internal_notes: m.notes,
      created_at: now, updated_at: now,
    });
  }

  // ------------------------------------------------------------ matter_team
  const team: [string, string, string, number, string, string][] = [
    [IDS.matterCommercial, staff[0].id, 'lead_partner', 1, 'Lead Partner', 'الشريكة المسؤولة'],
    [IDS.matterCommercial, staff[1].id, 'lead_lawyer', 1, 'Senior Associate', 'محامٍ أول'],
    [IDS.matterCommercial, staff[2].id, 'paralegal', 1, 'Paralegal', 'مساعدة قانونية'],
    // Compliance is on the matter but must NOT be shown to the client.
    [IDS.matterCommercial, staff[3].id, 'compliance_contact', 0, 'Compliance', 'الامتثال'],
    [IDS.matterRealEstate, staff[1].id, 'lead_lawyer', 1, 'Senior Associate', 'محامٍ أول'],
    [IDS.matterEmployment, staff[0].id, 'lead_partner', 1, 'Lead Partner', 'الشريكة المسؤولة'],
    [IDS.matterGulf, staff[0].id, 'lead_partner', 1, 'Lead Partner', 'الشريكة المسؤولة'],
    [IDS.matterLayla, staff[1].id, 'lead_lawyer', 1, 'Senior Associate', 'محامٍ أول'],
  ];
  for (const [matterId, staffId, role, visible, label, labelAr] of team) {
    add('matter_team', {
      id: detId(`matter_team:${matterId}:${staffId}`), matter_id: matterId,
      tenant_id: matters.find((m) => m.id === matterId)!.tenant,
      staff_id: staffId, matter_role: role, client_visible: visible,
      client_role_label: label, client_role_label_ar: labelAr, is_active: 1, created_at: now,
    });
  }

  // --------------------------------------------------------- matter_timeline
  const timeline = [
    [IDS.matterCommercial, -14, 'matter_opened', 'Matter opened', 'تم فتح القضية',
      'Your matter was opened and assigned to the legal team.', 'تم فتح قضيتك وإسنادها إلى الفريق القانوني.', 'complete'],
    [IDS.matterCommercial, -9, 'documents_received', 'Documents received', 'تم استلام المستندات',
      'Supply agreement and invoice schedule received.', 'تم استلام اتفاقية التوريد وكشوف الفواتير.', 'complete'],
    [IDS.matterCommercial, -5, 'submission_filed', 'Statement of claim filed', 'تم تقديم صحيفة الدعوى',
      'Filed with the Commercial Court in Riyadh.', 'تم التقديم لدى المحكمة التجارية بالرياض.', 'complete'],
    [IDS.matterCommercial, 0, 'hearing_scheduled', 'Hearing scheduled', 'تم تحديد جلسة',
      'A hearing has been scheduled. See the Hearings section for details.',
      'تم تحديد جلسة. راجع قسم الجلسات للتفاصيل.', 'complete'],
    [IDS.matterCommercial, 22, 'hearing_scheduled', 'Upcoming hearing', 'جلسة قادمة',
      'Attend or confirm your availability with the firm.', 'يُرجى الحضور أو تأكيد توفرك لدى الشركة.', 'upcoming'],
    [IDS.matterRealEstate, -7, 'matter_opened', 'Matter opened', 'تم فتح القضية',
      'Lease review engagement opened.', 'تم فتح مهمة مراجعة عقد الإيجار.', 'complete'],
    [IDS.matterRealEstate, -2, 'status_update', 'Draft under review', 'المسودة قيد المراجعة',
      'The legal team is reviewing the counterparty draft.', 'يقوم الفريق القانوني بمراجعة مسودة الطرف الآخر.', 'in_progress'],
    [IDS.matterEmployment, -2, 'matter_opened', 'Matter opened', 'تم فتح القضية',
      'Employment matter registered.', 'تم تسجيل القضية العمالية.', 'complete'],
    [IDS.matterGulf, -30, 'matter_opened', 'Matter opened', 'تم فتح القضية', 'Acquisition engagement opened.', 'تم فتح مهمة الاستحواذ.', 'complete'],
    [IDS.matterLayla, -10, 'matter_opened', 'Matter opened', 'تم فتح القضية', 'Contract review opened.', 'تم فتح مراجعة العقد.', 'complete'],
    // NOT client visible — an internal status change that must never surface.
    [IDS.matterEmployment, -1, 'note', 'Internal review checkpoint', 'نقطة مراجعة داخلية',
      'Internal only.', 'داخلي فقط.', 'complete'],
  ] as const;
  for (const [matterId, off, type, title, titleAr, desc, descAr, status] of timeline) {
    const isInternal = type === 'note';
    add('matter_timeline', {
      id: detId(`timeline:${matterId}:${off}:${type}:${title}`), matter_id: matterId,
      tenant_id: matters.find((m) => m.id === matterId)!.tenant,
      occurred_at: iso(off, 10), event_type: type, title, title_ar: titleAr,
      description: desc, description_ar: descAr, status,
      client_visible: isInternal ? 0 : 1, created_by_staff: staff[1].id, created_at: now,
    });
  }

  // ---------------------------------------------------------------- hearings
  const hearings = [
    { id: 'a1000000-0000-4000-8000-000000000001', matter: IDS.matterCommercial, tenant: IDS.tenantKgm, client: IDS.clientAhmed,
      off: 22, hour: 7, min: 30, court: 'Commercial Court — Riyadh', courtAr: 'المحكمة التجارية بالرياض',
      type: 'session', loc: 'Courtroom 4, Riyadh', locAr: 'قاعة 4، الرياض', remote: 0, status: 'upcoming',
      instr: 'Please bring the original supply agreement and a valid ID.',
      instrAr: 'يُرجى إحضار أصل اتفاقية التوريد وهوية سارية.' },
    { id: 'a1000000-0000-4000-8000-000000000002', matter: IDS.matterRealEstate, tenant: IDS.tenantKgm, client: IDS.clientAhmed,
      off: 9, hour: 10, min: 0, court: 'Virtual — Najiz', courtAr: 'افتراضية — ناجز',
      type: 'mediation', loc: null, locAr: null, remote: 1, status: 'upcoming',
      instr: 'A joining link will be shared 24 hours before the session.',
      instrAr: 'سيتم مشاركة رابط الدخول قبل الجلسة بـ 24 ساعة.' },
    { id: 'a1000000-0000-4000-8000-000000000003', matter: IDS.matterCommercial, tenant: IDS.tenantKgm, client: IDS.clientAhmed,
      off: -5, hour: 8, min: 0, court: 'Commercial Court — Riyadh', courtAr: 'المحكمة التجارية بالرياض',
      type: 'session', loc: 'Courtroom 4, Riyadh', locAr: 'قاعة 4، الرياض', remote: 0, status: 'held',
      instr: null, instrAr: null },
    { id: 'a1000000-0000-4000-8000-000000000004', matter: IDS.matterGulf, tenant: IDS.tenantKgm, client: IDS.clientGulf,
      off: 14, hour: 9, min: 0, court: 'Commercial Court — Jeddah', courtAr: 'المحكمة التجارية بجدة',
      type: 'session', loc: 'Courtroom 2, Jeddah', locAr: 'قاعة 2، جدة', remote: 0, status: 'upcoming',
      instr: null, instrAr: null },
  ];
  for (const h of hearings) {
    add('hearings', {
      id: h.id, matter_id: h.matter, tenant_id: h.tenant, client_id: h.client,
      scheduled_at: iso(h.off, h.hour, h.min), ends_at: iso(h.off, h.hour + 1, h.min),
      court: h.court, court_ar: h.courtAr, hearing_type: h.type,
      location: h.loc, location_ar: h.locAr, is_remote: h.remote,
      remote_platform: h.remote ? 'Najiz Virtual Courtroom' : null,
      remote_link: h.remote ? 'https://najiz.example.test/join/DEMO-LINK' : null,
      internal_status: h.status === 'upcoming' ? 'scheduled' : 'held',
      client_status: h.status, instructions: h.instr, instructions_ar: h.instrAr,
      client_visible: 1, created_at: now, updated_at: now,
    });
  }

  // --------------------------------------------------------------- deadlines
  const deadlines = [
    { id: 'b1000000-0000-4000-8000-000000000001', matter: IDS.matterCommercial, tenant: IDS.tenantKgm, client: IDS.clientAhmed,
      kind: 'client_action', title: 'Document submission', titleAr: 'تقديم مستندات',
      desc: 'Provide the signed commercial agreement and the payment correspondence.',
      descAr: 'يُرجى توفير الاتفاقية التجارية الموقعة والمراسلات الخاصة بالسداد.',
      off: 3, priority: 'high', clientStatus: 'open', visible: 1 },
    { id: 'b1000000-0000-4000-8000-000000000002', matter: IDS.matterRealEstate, tenant: IDS.tenantKgm, client: IDS.clientAhmed,
      kind: 'client_action', title: 'Confirm lease terms', titleAr: 'تأكيد شروط الإيجار',
      desc: 'Review the marked-up lease and confirm the agreed rental escalation.',
      descAr: 'مراجعة عقد الإيجار المعدّل وتأكيد نسبة التصعيد المتفق عليها.',
      off: 12, priority: 'normal', clientStatus: 'open', visible: 1 },
    { id: 'b1000000-0000-4000-8000-000000000003', matter: IDS.matterEmployment, tenant: IDS.tenantKgm, client: IDS.clientAhmed,
      kind: 'client_action', title: 'Provide employment contract', titleAr: 'توفير عقد العمل',
      desc: 'Upload the signed employment contract and the last three payslips.',
      descAr: 'رفع عقد العمل الموقع وكشوف الرواتب لآخر ثلاثة أشهر.',
      off: 8, priority: 'normal', clientStatus: 'open', visible: 1 },
    // INTERNAL — a lawyer task. Must never appear in the portal (§16).
    { id: 'b1000000-0000-4000-8000-000000000004', matter: IDS.matterCommercial, tenant: IDS.tenantKgm, client: IDS.clientAhmed,
      kind: 'internal_task', title: 'File memorandum of authority', titleAr: 'تقديم مذكرة التفويض',
      desc: 'Internal filing task.', descAr: 'مهمة أرشفة داخلية.',
      off: 4, priority: 'critical', clientStatus: 'open', visible: 0 },
    { id: 'b1000000-0000-4000-8000-000000000005', matter: IDS.matterGulf, tenant: IDS.tenantKgm, client: IDS.clientGulf,
      kind: 'client_action', title: 'Deliver board resolution', titleAr: 'تقديم قرار مجلس الإدارة',
      desc: 'Signed board resolution authorising the acquisition.',
      descAr: 'قرار مجلس الإدارة الموقّع بتفويض عملية الاستحواذ.',
      off: 6, priority: 'high', clientStatus: 'open', visible: 1 },
  ];
  for (const d of deadlines) {
    add('deadlines', {
      id: d.id, matter_id: d.matter, tenant_id: d.tenant, client_id: d.client, kind: d.kind,
      title: d.title, title_ar: d.titleAr, description: d.desc, description_ar: d.descAr,
      due_at: iso(d.off, 15), priority: d.priority,
      internal_status: d.kind === 'internal_task' ? 'in_progress' : 'open',
      client_status: d.clientStatus,
      assigned_staff_id: d.kind === 'internal_task' ? staff[2].id : null,
      internal_comment: d.kind === 'internal_task' ? 'INTERNAL: paralegal to file before Friday.' : null,
      client_visible: d.visible, created_at: now, updated_at: now,
    });
  }

  // ---------------------------------------------------------- internal_notes
  // Law firm work product. The portal has no code path that reads this table.
  for (const m of matters) {
    add('internal_notes', {
      id: detId(`internal_note:${m.id}`), tenant_id: m.tenant, matter_id: m.id, author_staff_id: staff[0].id,
      note_type: m.risk === 'critical' || m.risk === 'high' ? 'strategy' : 'general',
      body: m.notes, is_privileged: 1, created_at: now,
    });
  }

  // -------------------------------------------------------------- documents
  const docs = [
    { id: 'c1000000-0000-4000-8000-000000000001', matter: IDS.matterCommercial, client: IDS.clientAhmed, tenant: IDS.tenantKgm,
      title: 'Statement of Claim', titleAr: 'صحيفة الدعوى', type: 'court_document', cat: 'court',
      origin: 'firm', mime: 'application/pdf', size: 284_112, vis: 'visible', requested: 0, file: 'statement-of-claim.pdf' },
    { id: 'c1000000-0000-4000-8000-000000000002', matter: IDS.matterCommercial, client: IDS.clientAhmed, tenant: IDS.tenantKgm,
      title: 'Engagement Letter', titleAr: 'خطاب الارتباط', type: 'signed_document', cat: 'signed',
      origin: 'firm', mime: 'application/pdf', size: 156_908, vis: 'visible', requested: 0, file: 'engagement-letter.pdf' },
    { id: 'c1000000-0000-4000-8000-000000000003', matter: IDS.matterCommercial, client: IDS.clientAhmed, tenant: IDS.tenantKgm,
      title: 'Supply Agreement (requested)', titleAr: 'اتفاقية التوريد (مطلوبة)', type: 'contract', cat: 'requested',
      origin: 'firm', mime: 'application/pdf', size: 402_331, vis: 'visible', requested: 1, file: 'supply-agreement-request.pdf' },
    // INTERNAL visibility — a document on the client's matter that must not surface.
    { id: 'c1000000-0000-4000-8000-000000000004', matter: IDS.matterCommercial, client: IDS.clientAhmed, tenant: IDS.tenantKgm,
      title: 'Internal Risk Assessment', titleAr: 'تقييم المخاطر الداخلي', type: 'other', cat: 'from_firm',
      origin: 'firm', mime: 'application/pdf', size: 88_120, vis: 'internal', requested: 0, file: 'internal-risk.pdf' },
    { id: 'c1000000-0000-4000-8000-000000000005', matter: IDS.matterGulf, client: IDS.clientGulf, tenant: IDS.tenantKgm,
      title: 'Share Purchase Agreement', titleAr: 'اتفاقية شراء الأسهم', type: 'contract', cat: 'from_firm',
      origin: 'firm', mime: 'application/pdf', size: 512_004, vis: 'visible', requested: 0, file: 'spa.pdf' },
    // The receipt behind a disbursement (0036). A reimbursable expense must carry the
    // document being passed on, so the demo needs one that is actually a receipt.
    { id: 'c1000000-0000-4000-8000-000000000007', matter: IDS.matterGulf, client: IDS.clientGulf, tenant: IDS.tenantKgm,
      title: 'Court fee receipt', titleAr: 'إيصال رسوم المحكمة', type: 'receipt', cat: 'from_firm',
      origin: 'firm', mime: 'application/pdf', size: 64_220, vis: 'visible', requested: 0, file: 'court-fee-receipt.pdf' },
    { id: 'c1000000-0000-4000-8000-000000000006', matter: IDS.matterLayla, client: IDS.clientLayla, tenant: IDS.tenantNajd,
      title: 'Distribution Agreement', titleAr: 'اتفاقية التوزيع', type: 'contract', cat: 'from_firm',
      origin: 'firm', mime: 'application/pdf', size: 233_871, vis: 'visible', requested: 0, file: 'distribution.pdf' },
  ];
  for (const d of docs) {
    add('documents', {
      id: d.id, tenant_id: d.tenant, client_id: d.client, matter_id: d.matter,
      storage_bucket: 'client-documents',
      storage_key: `${d.tenant}/${d.client}/${d.matter}/${d.id}/v1/demo-${d.file}`,
      original_filename: d.file, stored_filename: `demo-${d.file}`,
      title: d.title, title_ar: d.titleAr, document_type: d.type, category: d.cat,
      origin: d.origin, version: 1, mime_type: d.mime, size_bytes: d.size,
      sha256: keyedHash(`demo-doc:${d.id}`), scan_status: 'clean', scan_result: 'demo-seed',
      scanned_at: now, status: 'available', client_visibility: d.vis,
      requested: d.requested, request_note: d.requested ? 'Required before the next hearing.' : null,
      request_note_ar: d.requested ? 'مطلوب قبل الجلسة القادمة.' : null,
      uploaded_by_user_id: null, uploaded_by_staff_id: staff[2].id,
      created_at: now, updated_at: now,
    });
  }

  // ---------------------------------------------------------------- invoices
  const invoices = [
    { id: 'd1000000-0000-4000-8000-000000000001', tenant: IDS.tenantKgm, client: IDS.clientAhmed, matter: IDS.matterCommercial,
      number: 'INV-2026-0148', issue: -20, due: 10, sub: 18_000, paid: 0, internal: 'sent',
      lines: [['Professional fees — statement of claim preparation', 'أتعاب مهنية — إعداد صحيفة الدعوى', 1, 12_000],
              ['Court filing and disbursements', 'رسوم التقديم والمصروفات', 1, 6_000]] },
    { id: 'd1000000-0000-4000-8000-000000000002', tenant: IDS.tenantKgm, client: IDS.clientAhmed, matter: IDS.matterRealEstate,
      number: 'INV-2026-0151', issue: -5, due: 25, sub: 9_500, paid: 4_000, internal: 'partially_paid',
      lines: [['Lease review — phase one', 'مراجعة عقد الإيجار — المرحلة الأولى', 1, 9_500]] },
    { id: 'd1000000-0000-4000-8000-000000000003', tenant: IDS.tenantKgm, client: IDS.clientAhmed, matter: IDS.matterEmployment,
      number: 'INV-2026-0163', issue: -40, due: -10, sub: 5_200, paid: 5_200, internal: 'paid',
      lines: [['Consultation and initial assessment', 'الاستشارة والتقييم الأولي', 1, 5_200]] },
    // NOT projected: still in internal approval. Invisible to the client (§20).
    { id: 'd1000000-0000-4000-8000-000000000004', tenant: IDS.tenantKgm, client: IDS.clientAhmed, matter: IDS.matterCommercial,
      number: 'INV-2026-0149-DRAFT', issue: 0, due: 30, sub: 22_000, paid: 0, internal: 'pending_internal_approval',
      lines: [['Draft line — not yet approved', 'بند مسودة — غير معتمد', 1, 22_000]] },
    { id: 'd1000000-0000-4000-8000-000000000005', tenant: IDS.tenantKgm, client: IDS.clientGulf, matter: IDS.matterGulf,
      number: 'INV-2026-0170', issue: -12, due: 18, sub: 64_000, paid: 0, internal: 'sent',
      lines: [['Acquisition advisory — phase one', 'استشارات الاستحواذ — المرحلة الأولى', 1, 64_000]] },
  ];
  const derive = (internal: string, paid: number, total: number, due: string) => {
    if (internal === 'draft' || internal === 'pending_internal_approval') return null;
    if (internal === 'cancelled' || internal === 'written_off') return 'cancelled';
    if (paid >= total && total > 0) return 'paid';
    if (paid > 0) return 'partially_paid';
    return due < date(0) ? 'overdue' : 'awaiting_payment';
  };
  /*
    THE FISCAL CHAIN, COMPUTED BEFORE ANYTHING IS EMITTED.

    `invoices.fiscal_device_id` references the device, and the device carries the
    chain head — the last ICV and the last hash — which is only known once every
    invoice has been hashed. So the chain is derived first into `fiscalFor`, then the
    device row is emitted with its final values, then the invoices are emitted with
    theirs. The alternative (emit the device at counter 0 and update it afterwards)
    is what the server does at run time; a fixture that shipped a device claiming
    counter 0 while five documents cite ICVs 1–5 would be a demo that contradicts
    itself the moment anybody read the device row.
  */
  const fiscalFor = new Map<string, {
    icv: number; previousHash: string; hash: string; qr: string;
    subtype: 'standard' | 'simplified'; supplyAt: string;
  }>();
  /*
    The buyer's VAT registration, indexed by client, taken from the PARTY record the
    clients link to. Built here rather than hardcoded below so the fiscal chain and the
    client register cannot drift apart.
  */
  const buyerVatByClient = new Map<string, string>();
  for (const [clientId, partyId] of [
    [IDS.clientAhmed, IDS.partyAhmed],
    [IDS.clientGulf, IDS.partyGulf],
  ] as const) {
    const partyRow = parties.find((p) => p.id === partyId);
    if (partyRow?.vat) buyerVatByClient.set(clientId, partyRow.vat);
  }

  let chainHead = GENESIS_PIH;
  let icvCounter = 0;
  for (const inv of invoices) {
    if (inv.internal === 'pending_internal_approval') continue;   // never issued at all
    const lineAmounts = inv.lines.map((l) => (l as [string, string, number, number])[2] * (l as [string, string, number, number])[3]);
    const sub = Math.round(lineAmounts.reduce((a, b) => a + b, 0) * 100) / 100;
    const vat = Math.round(sub * 0.15 * 100) / 100;
    const total = Math.round((sub + vat) * 100) / 100;
    const supplyAt = iso(inv.issue, 9);
    /*
      STANDARD OR SIMPLIFIED IS DECIDED BY THE BUYER, NOT BY PREFERENCE — and it is
      decided from the BUYER'S OWN RECORD, which is the only way the fixture can be
      consistent with the gate the issue route applies.

      A client whose party carries a VAT registration is a business and gets a standard
      invoice, which must be CLEARED before it is shared with them. A private individual
      with no registration gets a simplified one, REPORTED within 24 hours. Gulf Horizon
      has a registration on its party record; Ahmed Al-Saud, an individual, does not.

      An earlier version of this fixture issued Ahmed a STANDARD invoice carrying a VAT
      number that appears nowhere on his client or party record, which meant the seeded
      document disagreed with the buyer the product would have looked up — and the
      issue route then refused to produce the same document the fixture had already
      produced. The buyer's VAT number is read from the register here for the same
      reason it is read from the register at run time.
    */
    const buyerVat = buyerVatByClient.get(inv.client) ?? null;
    const subtype = buyerVat ? 'standard' as const : 'simplified' as const;
    const buyerName = inv.client === IDS.clientGulf ? 'Gulf Horizon Trading Co.' : 'Ahmed Al-Saud';

    icvCounter += 1;
    const icv = icvCounter;
    const previousHash = chainHead;

    /*
      The QR is built from the invoice's own figures, then the XML is built carrying
      that same QR, then the XML is hashed — which is the order the regulation
      implies, because the hash is over the document and the document contains the
      QR. A generator that hashed first and embedded the QR afterwards would produce
      a document whose own hash does not match it.
    */
    const qr = buildQrPayload({
      sellerName: 'شركة كيه جي إم للمحاماة',
      vatRegistrationNumber: '300000000000003',
      timestamp: supplyAt,
      totalWithVat: total.toFixed(2),
      vatTotal: vat.toFixed(2),
    });

    const xml = buildInvoiceXml({
      documentTypeCode: '388',
      subtype,
      invoiceNumber: inv.number,
      uuid: detId(`invoice:${inv.id}`),
      issueDate: date(inv.issue),
      issueTime: '09:00:00',
      supplyDate: subtype === 'standard' ? date(inv.issue) : null,
      currency: 'SAR',
      icv,
      previousInvoiceHash: previousHash,
      seller: {
        name: 'KGM Law Firm', nameAr: 'شركة كيه جي إم للمحاماة',
        vatRegistrationNumber: '300000000000003', commercialRegistration: '1010345678',
        address: '1234 King Fahd Road', city: 'Riyadh', postalCode: '12211', country: 'SA',
      },
      buyer: { name: buyerName, vatNumber: buyerVat, address: null },
      lines: inv.lines.map((l, i) => {
        const [desc, descAr, qty, unit] = l as [string, string, number, number];
        const amount = Math.round(qty * unit * 100) / 100;
        return {
          position: i + 1, description: desc, descriptionAr: descAr,
          quantity: String(qty), unitPrice: unit.toFixed(2),
          lineExtensionAmount: amount.toFixed(2), vatCategory: 'standard' as const,
          vatRate: '0.15', vatAmount: (Math.round(amount * 0.15 * 100) / 100).toFixed(2),
        };
      }),
      subtotal: sub.toFixed(2), vatTotal: vat.toFixed(2), total: total.toFixed(2),
      qrPayload: qr,
    });

    const hash = invoiceHash(xml);
    chainHead = hash;
    fiscalFor.set(inv.id, { icv, previousHash, hash, qr, subtype, supplyAt });
  }

  add('fiscal_identity', {
    id: detId('fiscal:kgm'), tenant_id: IDS.tenantKgm,
    registered_name: 'KGM Law Firm', registered_name_ar: 'شركة كيه جي إم للمحاماة',
    vat_registration_number: '300000000000003', commercial_registration: '1010345678',
    registered_address: '1234 King Fahd Road, Al Olaya', registered_address_ar: '١٢٣٤ طريق الملك فهد، العليا',
    city: 'Riyadh', postal_code: '12211', country: 'SA',
    /*
      A PRODUCTION CSID THAT DOES NOT EXIST, in a database that is entirely synthetic
      and says so. The alternative — leaving the demo firm un-onboarded — would mean
      none of the demo's invoices could be sent, and the product's central financial
      gate would never be exercised on the demo at all. What is NOT faked is the
      environment field: it says 'production' because that is what the fixture claims
      to be, and the SECOND tenant in the same fixture has no fiscal identity at all,
      which is what the live harness uses to prove the refusal.
    */
    environment: 'production', onboarding_status: 'production_csid',
    certificate_expires_at: iso(400),
    superseded_by: null, created_at: iso(-200), updated_at: iso(-200),
  });

  add('fiscal_devices', {
    id: detId('fiscal_device:kgm-1'), tenant_id: IDS.tenantKgm,
    fiscal_identity_id: detId('fiscal:kgm'),
    device_label: 'Head office — Riyadh', device_serial: '1-KGM-RUH-0001',
    invoice_counter_value: icvCounter, last_invoice_hash: icvCounter ? chainHead : null,
    is_active: 1, created_at: iso(-200), updated_at: now,
  });

  for (const inv of invoices) {
    const f = fiscalFor.get(inv.id);
    const lineAmounts = inv.lines.map((l) => (l as [string, string, number, number])[2] * (l as [string, string, number, number])[3]);
    const vat = Math.round(Math.round(lineAmounts.reduce((a, b) => a + b, 0) * 100) / 100 * 0.15 * 100) / 100;
    const sub = Math.round(lineAmounts.reduce((a, b) => a + b, 0) * 100) / 100;
    const total = Math.round((sub + vat) * 100) / 100;
    // A settled invoice is settled for the VAT-INCLUSIVE total; `inv.paid`
    // holds the part-payment figure for the partially paid one.
    const paid = inv.internal === 'paid' ? total : inv.paid;
    add('invoices', {
      /*
        CREATED FIRST, ISSUED LATER — and the order is the product's order, not a
        convenience. A document exists as a draft, its lines are added, and only then is
        it issued: the fiscal fields below are empty HERE and filled by the issuance pass
        in `demoIssuances()`, which runs after the lines have been written.

        The alternative — emitting a finished, issued invoice in one insert — can no
        longer be done at all, because 0034 refuses an invoice at sent/paid/overdue with
        no fiscal identity AND refuses a line being added to an invoice that already has
        one. A fixture that could only work around those two guards would be a fixture
        demonstrating that the guards do not hold.
      */
      id: inv.id, tenant_id: inv.tenant, client_id: inv.client, matter_id: inv.matter,
      invoice_number: inv.number, issue_date: date(inv.issue), due_date: date(inv.due),
      currency: 'SAR', subtotal: sub, vat_rate: 0.15, vat_amount: vat, total,
      /*
        The state before issue. An invoice that WILL be issued waits here as a draft
        nobody can see; its internal and client statuses arrive with the issuance, and
        the client status is the one the derivation produces rather than a second
        opinion about it. An invoice with no fiscal identity to come — the one waiting
        for partner sign-off — keeps the status it is waiting in, because "draft" and
        "awaiting approval" are different answers to the question the approver asks.
      */
      amount_paid: paid,
      internal_status: f ? 'draft' : inv.internal,
      client_status: f ? null : derive(inv.internal, paid, total, date(inv.due)),
      storage_key: `${inv.tenant}/${inv.client}/financial/${inv.id}/invoice.pdf`,
      approved_by_staff: inv.internal === 'pending_internal_approval' ? null : staff[4].id,
      approved_at: inv.internal === 'pending_internal_approval' ? null : now,
      notes_internal: inv.internal === 'pending_internal_approval'
        ? 'INTERNAL: awaiting partner sign-off. Do NOT release.' : null,
      fiscal_device_id: null, invoice_uuid: null, invoice_type: null, icv: null,
      previous_invoice_hash: null, invoice_hash: null, qr_payload: null,
      xml_storage_key: null, supply_at: null,
      buyer_vat_number: null, buyer_name: null, buyer_address: null, buyer_address_ar: null,
      fiscal_status: null, fiscal_status_at: null,
      created_at: now, updated_at: now,
    });
    if (f) {
      /*
        THE ISSUANCE, deferred. Every field the document's identity consists of, plus the
        status it reaches once issued — so the draft that stays a draft keeps NO fiscal
        identity at all, and the issue route can be demonstrated on it.
      */
      issuances.push({
        id: inv.id,
        set: {
          internal_status: inv.internal,
          client_status: derive(inv.internal, paid, total, date(inv.due)),
          fiscal_device_id: detId('fiscal_device:kgm-1'),
          invoice_uuid: detId(`invoice:${inv.id}`),
          invoice_type: f.subtype,
          icv: f.icv,
          previous_invoice_hash: f.previousHash,
          invoice_hash: f.hash,
          qr_payload: f.qr,
          xml_storage_key: `${inv.tenant}/${inv.client}/financial/${inv.id}/invoice.xml`,
          supply_at: f.supplyAt,
          // The buyer's VAT number is what MAKES an invoice standard rather than
          // simplified, so it is present exactly when the type says so — and it is the
          // same figure stamped into the document above, because a row that disagreed
          // with its own XML would be a tax record nobody could reconcile.
          buyer_vat_number: buyerVatByClient.get(inv.client) ?? null,
          buyer_name: inv.client === IDS.clientGulf ? 'Gulf Horizon Trading Co.' : 'Ahmed Al-Saud',
          fiscal_status: f.subtype === 'standard' ? 'cleared' : 'reported',
          fiscal_status_at: iso(inv.issue, 9, 5),
          updated_at: now,
        },
      });
    }
    inv.lines.forEach((l, i) => {
      const [desc, descAr, qty, unit] = l as [string, string, number, number];
      const amount = Math.round(qty * unit * 100) / 100;
      add('invoice_lines', {
        id: detId(`invoice_line:${inv.id}:${i + 1}`), invoice_id: inv.id, position: i + 1, description: desc,
        description_ar: descAr, quantity: qty, unit_price: unit, amount: qty * unit,
        vat_category: 'standard', vat_rate: 0.15,
        vat_amount: Math.round(amount * 0.15 * 100) / 100,
        discount_amount: 0,
      });
    });
    /*
      A standard invoice may only be SENT once it is CLEARED, so the demo's sent and
      settled standard invoices need the clearance that admits them. Without this row
      the fixture would violate the very gate the migration installs — which is how
      this was discovered, since the seed began failing the moment 0034 landed.
    */
    if (f && f.subtype === 'standard') {
      add('invoice_submissions', {
        id: detId(`submission:${inv.id}:clearance`), tenant_id: inv.tenant, invoice_id: inv.id,
        submission_type: 'clearance', attempt: 1, status: 'cleared', http_status: 200,
        response_code: 'BR-KSA-200', request_body_hash: keyedHash(`submission:${inv.id}`),
        response_body: null, warnings: null, errors: null,
        next_retry_at: null, submitted_at: iso(inv.issue, 9, 3), resolved_at: iso(inv.issue, 9, 5),
        created_at: iso(inv.issue, 9, 3),
      });
    } else if (f) {
      add('invoice_submissions', {
        id: detId(`submission:${inv.id}:reporting`), tenant_id: inv.tenant, invoice_id: inv.id,
        submission_type: 'reporting', attempt: 1, status: 'reported', http_status: 200,
        response_code: 'BR-KSA-200', request_body_hash: keyedHash(`submission:${inv.id}`),
        response_body: null, warnings: null, errors: null,
        next_retry_at: null, submitted_at: iso(inv.issue, 9, 3), resolved_at: iso(inv.issue, 9, 4),
        created_at: iso(inv.issue, 9, 3),
      });
    }
  }

  // ---------------------------------------------------------------- payments
  add('payments', {
    id: detId('payment:demo-1'), tenant_id: IDS.tenantKgm,
    invoice_id: invoices[2].id, client_id: IDS.clientAhmed, initiated_by_user_id: IDS.userAhmed,
    provider: 'mada', provider_intent_id: 'demo_pi_0001', idempotency_key: 'demo-idem-0001',
    amount: 5_980, currency: 'SAR', status: 'succeeded', receipt_number: 'RCP-2026-00091',
    failure_reason: null, webhook_received_at: iso(-38), completed_at: iso(-38), created_at: iso(-38),
  });

  // The receipt for that settled payment. Without this row the demo would show
  // a paid invoice with no receipt behind it — which is exactly the kind of
  // half-finished state a client notices immediately.
  add('receipts', {
    id: detId('receipt:demo-1'), tenant_id: IDS.tenantKgm,
    payment_id: detId('payment:demo-1'), invoice_id: invoices[2].id, client_id: IDS.clientAhmed,
    receipt_number: 'RCP-2026-00091', issued_at: iso(-38),
    amount: 5_980, currency: 'SAR',
    storage_key: `${IDS.tenantKgm}/${IDS.clientAhmed}/financial/${invoices[2].id}/${detId('receipt:demo-1')}.pdf`,
    created_at: iso(-38),
  });

  // --------------------------------------------------------- message_threads
  const threads = [
    { id: 'e1000000-0000-4000-8000-000000000001', matter: IDS.matterCommercial, tenant: IDS.tenantKgm, client: IDS.clientAhmed,
      subject: 'Commercial Dispute — hearing preparation', subjectAr: 'القضية التجارية — التحضير للجلسة', status: 'awaiting_client' },
    { id: 'e1000000-0000-4000-8000-000000000002', matter: IDS.matterRealEstate, tenant: IDS.tenantKgm, client: IDS.clientAhmed,
      subject: 'Lease markup comments', subjectAr: 'ملاحظات على تعديل عقد الإيجار', status: 'awaiting_firm' },
  ];
  for (const t of threads) {
    add('message_threads', {
      id: t.id, tenant_id: t.tenant, matter_id: t.matter, client_id: t.client,
      subject: t.subject, subject_ar: t.subjectAr, thread_status: t.status,
      last_message_at: iso(-1, 12), created_at: iso(-6),
    });
  }
  const msgs: [string, string, string | null, string | null, string, string, number, string | null, number][] = [
    [threads[0].id, 'staff', null, staff[1].id, 'Faisal Al-Harbi',
      'Good morning Ahmed. Ahead of the hearing on the 15th we need the signed supply agreement and any payment correspondence. Could you upload them to the Documents section?', 0, null, -3],
    [threads[0].id, 'client', IDS.userAhmed, null, 'Ahmed Al-Saud',
      'Thank you Faisal. I will upload the agreement today. Do you also need the bank transfer receipts?', 0, null, -2],
    [threads[0].id, 'staff', null, staff[1].id, 'Faisal Al-Harbi',
      'Yes please — the last six months would be ideal. We will prepare the evidence bundle once received.', 0, null, -1],
    // An internal-only message that must never be delivered to the client.
    [threads[0].id, 'staff', null, staff[0].id, 'Noura Al-Qahtani',
      'Internal: do not disclose the settlement floor to the client before the partner meeting.', 1, 'INTERNAL FLAG — privileged.', -1],
    [threads[1].id, 'staff', null, staff[1].id, 'Faisal Al-Harbi',
      'We have marked up the lease. Clauses 7.2 and 11.4 need your commercial input.', 0, null, -4],
  ];
  for (const [threadId, kind, userId, staffId, name, body, internalFlag, internalNote, off] of msgs) {
    add('messages', {
      id: detId(`message:${threadId}:${off}:${body.slice(0, 24)}`), thread_id: threadId, tenant_id: IDS.tenantKgm, sender_kind: kind,
      sender_user_id: userId, sender_staff_id: staffId, sender_display_name: name,
      body, internal_flag: internalFlag, internal_note: internalNote, created_at: iso(off, 12, 30),
    });
  }

  // ------------------------------------------------------------- appointments
  const apptTypes = [
    { id: detId('appt_type:consultation'), code: 'consultation', label: 'Legal Consultation', labelAr: 'استشارة قانونية', dur: 45 },
    { id: detId('appt_type:case_review'), code: 'case_review', label: 'Case Review Meeting', labelAr: 'اجتماع مراجعة القضية', dur: 60 },
    { id: detId('appt_type:document_signing'), code: 'document_signing', label: 'Document Signing', labelAr: 'توقيع مستندات', dur: 30 },
    { id: detId('appt_type:billing'), code: 'billing', label: 'Billing Discussion', labelAr: 'مناقشة الفواتير', dur: 30 },
  ];
  for (const t of apptTypes) {
    add('appointment_types', {
      id: t.id, tenant_id: IDS.tenantKgm, code: t.code, label: t.label, label_ar: t.labelAr,
      duration_min: t.dur, is_active: 1,
    });
  }
  add('appointments', {
    id: detId('appointment:confirmed-1'), tenant_id: IDS.tenantKgm, client_id: IDS.clientAhmed, matter_id: IDS.matterCommercial,
    requested_by_user_id: IDS.userAhmed, type_id: apptTypes[1].id,
    type_label: apptTypes[1].label, type_label_ar: apptTypes[1].labelAr,
    preferred_date: date(5), preferred_time: '13:00', preferred_mode: 'video',
    client_note: 'Would like to review the evidence bundle before the hearing.',
    confirmed_at: iso(2, 9), confirmed_staff_id: staff[1].id, rescheduled_from: null,
    status: 'confirmed', cancellation_reason: null, cancelled_by: null,
    created_at: iso(-1), updated_at: now,
  });
  add('appointments', {
    id: detId('appointment:requested-1'), tenant_id: IDS.tenantKgm, client_id: IDS.clientAhmed, matter_id: IDS.matterRealEstate,
    requested_by_user_id: IDS.userAhmed, type_id: apptTypes[0].id,
    type_label: apptTypes[0].label, type_label_ar: apptTypes[0].labelAr,
    preferred_date: date(11), preferred_time: '10:30', preferred_mode: 'in_person',
    client_note: null, confirmed_at: null, confirmed_staff_id: null, rescheduled_from: null,
    status: 'requested', cancellation_reason: null, cancelled_by: null,
    created_at: iso(0, 8), updated_at: now,
  });

  // ------------------------------------------------------------ notifications
  const notifs: [string, string, string, string, string, string, string, number, number][] = [
    ['hearing', 'action_required', 'Hearing scheduled', 'تم تحديد جلسة',
      'Commercial Dispute — 15 October, Commercial Court Riyadh.',
      'القضية التجارية — 15 أكتوبر، المحكمة التجارية بالرياض.', '/portal/hearings', 0, 0],
    ['deadline', 'urgent', 'Deadline in 3 days', 'موعد نهائي خلال 3 أيام',
      'Document submission is due for Commercial Dispute.',
      'تقديم المستندات مستحق للقضية التجارية.', '/portal/deadlines', 0, 0],
    ['message', 'info', 'New message from your legal team', 'رسالة جديدة من فريقك القانوني',
      'Faisal Al-Harbi replied in "Commercial Dispute — hearing preparation".',
      'رد فيصل الحربي في "القضية التجارية — التحضير للجلسة".', '/portal/messages', 0, 0],
    ['invoice', 'info', 'Invoice awaiting payment', 'فاتورة بانتظار السداد',
      'INV-2026-0148 for 20,700.00 SAR is due soon.',
      'الفاتورة INV-2026-0148 بمبلغ 20,700.00 ر.س تستحق قريباً.', '/portal/invoices', 0, 0],
    ['matter_update', 'info', 'Matter status updated', 'تم تحديث حالة القضية',
      'Real Estate Contract Matter moved to Under Review.',
      'انتقلت قضية العقد العقاري إلى قيد المتابعة.', '/portal/matters', 1, 0],
    ['security', 'info', 'New sign-in detected', 'تم رصد تسجيل دخول جديد',
      'A sign-in occurred from a new device.',
      'تم تسجيل الدخول من جهاز جديد.', '/portal/security', 1, 0],
  ];
  for (const [cat, sev, title, titleAr, body, bodyAr, link, read, off] of notifs) {
    add('notifications', {
      id: detId(`notification:${cat}:${title}`), tenant_id: IDS.tenantKgm, user_id: IDS.userAhmed, client_id: IDS.clientAhmed,
      category: cat, severity: sev, title, title_ar: titleAr, body, body_ar: bodyAr, link,
      matter_id: null, read_at: read ? iso(off, 10) : null, emailed_at: null, created_at: iso(off, 9),
    });
  }

  // ------------------------------------------------- notification_preferences
  const cats = ['matter_update', 'hearing', 'deadline', 'document', 'invoice',
                'payment', 'appointment', 'message', 'security', 'system'];
  for (const u of [IDS.userAhmed, IDS.userGulf, IDS.userLayla]) {
    for (const c of cats) {
      add('notification_preferences', {
        user_id: u, category: c, in_app: 1, email: c !== 'system' ? 1 : 0,
        locked: c === 'security' ? 1 : 0, updated_at: now,
      });
    }
  }

  // ------------------------------------------------------------- consents
  add('consent_records', {
    id: detId('consent:ahmed:portal_access'), tenant_id: IDS.tenantKgm, user_id: IDS.userAhmed, purpose: 'portal_access',
    consented: 1, policy_version: '2026-01', ip_hash: keyedHash('ip:demo'), recorded_at: now,
  });

  // ==========================================================================
  // FIRM OS — RBAC GRAPH (§5-§17, §27, §50)
  // ==========================================================================
  // The five `staff` rows above are display records for the client portal. What
  // follows is what makes them OPERATORS: a `users` identity, a membership with
  // numeric authority ceilings, roles drawn from the catalogue, a department,
  // and a practice-area scope. None of it touches the portal projection, so the
  // 185 client-facing tests are unaffected.

  // ------------------------------------------------------- firm identities
  const firmPw = hashPassword(DEMO_FIRM_PASSWORD);
  /*
    Which role templates practise law, and therefore require a valid licence.

    Declared here as data that the seed WRITES rather than as a rule the seed
    ASSUMES, so that a fresh database has the same answer as migration 0027's
    `update roles set requires_practising_licence = true where code in (...)`.
    Two lists that must agree is a risk; it is taken deliberately, because the
    alternative — computing it in one place — would mean either the SQL migration
    reading from application code, or the application hardcoding a list the
    database does not share.
  */
  const PRACTISING_ROLE_CODES = new Set(['MANAGING_PARTNER', 'PARTNER', 'ASSOCIATE', 'LAWYER']);

  const firmPeople = [
    { userId: IDS.userNoura,  staffId: staff[0].id, email: 'noura@kgm.example.test',
      template: 'MANAGING_PARTNER', department: 'LEGAL', isDeptLead: 1,
      title: 'Managing Partner', titleAr: 'الشريكة الإدارية',
      practiceAreas: ['*'],
      // A practising role carries a licence. See the seeding loop below: a member
      // whose role practises and who has NO licence row is refused assignment,
      // so this is not decoration.
      licence: { number: 'SA-BAR-11482', issued: '2011-04-12', expires: '2027-04-11' },
      financial: 500000, writeoff: 100000, discount: 25, language: 'ar' },
    { userId: IDS.userFaisal, staffId: staff[1].id, email: 'faisal@kgm.example.test',
      template: 'LAWYER', department: 'LEGAL', isDeptLead: 0,
      title: 'Senior Associate', titleAr: 'محامٍ أول',
      practiceAreas: ['Commercial Litigation', 'Real Estate'],
      licence: { number: 'SA-BAR-20917', issued: '2019-09-01', expires: '2026-11-30' },
      // NULL, not 0: a lawyer holds no financial authority at all, and the
      // resolver must read that as "refuse", never as "unlimited" (§10).
      financial: null, writeoff: null, discount: null, language: 'ar' },
    // NO `licence` KEY — deliberate. A paralegal does not hold a licence to
    // practise, so requiring one would block a legitimate hire; `memberRequires-
    // Licence()` reads that from the role catalogue and gating never applies.
    { userId: IDS.userMariam, staffId: staff[2].id, email: 'mariam@kgm.example.test',
      template: 'PARALEGAL', department: 'LEGAL', isDeptLead: 0,
      title: 'Paralegal', titleAr: 'مساعدة قانونية',
      practiceAreas: ['Commercial Litigation'],
      financial: null, writeoff: null, discount: null, language: 'ar' },
    { userId: IDS.userOmar, staffId: staff[3].id, email: 'omar@kgm.example.test',
      template: 'COMPLIANCE', department: 'COMPLIANCE', isDeptLead: 1,
      title: 'Compliance Officer', titleAr: 'مسؤول الامتثال',
      // Empty scope: compliance reaches matters by assignment or explicit grant,
      // not by wandering the whole practice (§15).
      practiceAreas: [],
      financial: null, writeoff: null, discount: null, language: 'ar' },
    { userId: IDS.userSara, staffId: staff[4].id, email: 'sara@kgm.example.test',
      template: 'FINANCE', department: 'FINANCE', isDeptLead: 1,
      title: 'Finance Manager', titleAr: 'مديرة الشؤون المالية',
      practiceAreas: [],
      financial: 25000, writeoff: 5000, discount: 10, language: 'ar' },
  ];

  /*
    ── A SECOND FIRM, ON THE SAME SAAS ────────────────────────────────────────────

    Najd Legal Partners is a separate tenant with its own client, its own matter and
    its own partner, and — the part that matters here — NO FISCAL IDENTITY AT ALL.
    It has never onboarded an EGS unit with ZATCA and cannot issue a tax invoice.

    That is not a gap in the fixture. It is the fixture's load-bearing negative case:
    the only way to demonstrate on a live deployment that the fiscal gate REFUSES is
    to have a firm for which it must, and a demo where every firm is compliant can
    only ever show the happy path. `scripts/verify/invoice-fiscal-live.mjs` signs in
    as this partner and attempts a send the firm is not entitled to make.
  */
  const najdPeople = [
    { userId: 'dddddddd-0000-4000-8000-000000000020', staffId: 'f2000000-0000-4000-8000-000000000001',
      email: 'partner@najd.example.test', template: 'MANAGING_PARTNER', department: 'LEGAL', isDeptLead: 1,
      title: 'Managing Partner', titleAr: 'الشريك الإداري',
      name: 'Sultan Al-Otaibi', nameAr: 'سلطان العتيبي',
      practiceAreas: ['*'],
      financial: 300000, writeoff: 50000, discount: 20, language: 'ar' },
  ];

  /*
    The eligibility layer (migration 0027).

    Two lawyers hold a valid licence; the paralegal, the compliance officer and
    the finance manager hold none, and the ABSENCE of a row is the intended state
    for them rather than a gap in the seed — their roles do not practise, so the
    gate does not apply.

    The expiry dates are real dates rather than nulls so the demo exercises the
    expiry branch of `eligibilityFor()`: Faisal's licence expires 30 November
    2026, which is in the future today and becomes a refusal on its own with no
    code change, which is what a licence register is for.
  */
  for (const f of firmPeople) {
    if (!('licence' in f) || !f.licence) continue;
    add('professional_licences', {
      id: detId(`licence:${f.staffId}:${f.licence.number}`),
      tenant_id: IDS.tenantKgm, staff_id: f.staffId,
      licence_number: f.licence.number,
      issued_at: f.licence.issued, expires_at: f.licence.expires, status: 'valid',
      status_effective_from: f.licence.issued, status_reference: null,
      verified_by_membership_id: null, verified_at: iso(-30, 6),
      created_at: now, updated_at: now,
    });
  }

  for (const f of firmPeople) {
    add('users', {
      id: f.userId, email: f.email, password_hash: firmPw,
      password_updated_at: now, email_verified_at: now, status: 'active',
      failed_login_count: 0, locked_until: null, last_login_at: null, last_login_ip_hash: null,
      mfa_enabled: 0, mfa_method: null, mfa_secret_enc: null, mfa_enabled_at: null,
      preferred_language: f.language, preferred_calendar: 'islamic-umalqura',
      created_at: now, updated_at: now,
    });
  }

  // ------------------------------------------------- permission catalogue (§8)
  // Global rows: the catalogue has no tenant_id, and no API can write to it.
  for (const perm of PERMISSIONS) {
    add('permissions', {
      code: perm.code, module: perm.module, description: perm.description,
      description_ar: perm.descriptionAr, sensitivity: perm.sensitivity, created_at: now,
    });
  }

  // ---------------------------------------------- per-tenant role copies (§7)
  // A tenant gets its own copy of every system template so one firm can tune a
  // role without changing another's. `is_system` keeps the copy protected from
  // deletion while still allowing its grants to be adjusted.
  const tenantRoleId = (tenantId: string, code: string) => detId(`firm_role:${tenantId}:${code}`);
  const TENANT_ROLES: [string, string][] = [
    [IDS.tenantKgm, 'KGM Law Firm'],
    [IDS.tenantNajd, 'Najd Legal Partners'],
  ];
  for (const [tenantId] of TENANT_ROLES) {
    for (const t of ROLE_TEMPLATES) {
      add('roles', {
        id: tenantRoleId(tenantId, t.code), tenant_id: tenantId, code: t.code,
        name: t.name, name_ar: t.nameAr, description: t.description, description_ar: null,
        is_system: 1, is_active: 1,
        // 0027. Declared per role, not hardcoded in a function, so a tenant that
        // invents a "Legal Consultant" role can say it practises — and a new role
        // is inert until someone decides. PARALEGAL is deliberately FALSE: legal
        // work under supervision is not practice, and requiring a licence would
        // block a legitimate hire.
        requires_practising_licence: PRACTISING_ROLE_CODES.has(t.code) ? 1 : 0,
        created_at: now, updated_at: now,
      });
      for (const code of TEMPLATE_GRANTS[t.code] ?? []) {
        add('role_permissions', {
          role_id: tenantRoleId(tenantId, t.code), permission_code: code, granted_at: now,
        });
      }
    }
  }

  // -------------------------------------------------------- departments (§5)
  const DEPARTMENTS: [string, string, string][] = [
    ['LEGAL', 'Legal', 'الشؤون القانونية'],
    ['FINANCE', 'Finance', 'الشؤون المالية'],
    ['COMPLIANCE', 'Compliance', 'الامتثال'],
    ['ADMIN', 'Administration', 'الإدارة'],
    ['OPERATIONS', 'Operations', 'العمليات'],
  ];
  const deptId = (tenantId: string, code: string) => detId(`dept:${tenantId}:${code}`);
  for (const [tenantId] of TENANT_ROLES) {
    for (const [code, name, nameAr] of DEPARTMENTS) {
      add('departments', {
        id: deptId(tenantId, code), tenant_id: tenantId, code, name, name_ar: nameAr,
        parent_id: null, is_active: 1, created_at: now, updated_at: now,
      });
    }
  }

  // ------------------------------------------------- memberships + ceilings (§6, §10)
  const membershipId = (userId: string) => detId(`firm_membership:${IDS.tenantKgm}:${userId}`);
  for (const f of firmPeople) {
    const mId = membershipId(f.userId);
    add('firm_memberships', {
      id: mId, tenant_id: IDS.tenantKgm, user_id: f.userId, staff_id: f.staffId,
      job_title: f.title, job_title_ar: f.titleAr, status: 'active',
      financial_authority_sar: f.financial, writeoff_authority_sar: f.writeoff,
      discount_authority_pct: f.discount,
      joined_at: iso(-120, 8), left_at: null, invited_by_membership_id: null,
      created_at: now, updated_at: now,
    });
    add('membership_roles', {
      membership_id: mId, role_id: tenantRoleId(IDS.tenantKgm, f.template),
      // 'bootstrap': the demo firm's first grants have no granter. The database
      // trigger accepts that only for an explained origin — a NULL granter on an
      // ordinary admin grant is rejected.
      granted_by_membership_id: null, grant_origin: 'bootstrap',
      granted_at: iso(-120, 8), revoked_at: null,
    });
    add('department_members', {
      department_id: deptId(IDS.tenantKgm, f.department), membership_id: mId,
      is_lead: f.isDeptLead, joined_at: iso(-120, 8),
    });
    for (const area of f.practiceAreas) {
      add('membership_practice_areas', {
        membership_id: mId, practice_area: area, granted_at: iso(-120, 8),
      });
    }
  }

  /*
    ── THE SECOND FIRM'S PARTNER ──────────────────────────────────────────────────

    Seeded explicitly rather than by adding Najd to `firmPeople`, because everything
    in that array is a KGM member: its membership id, its roles, its departments and
    its practice areas are all keyed to the KGM tenant. Threading a tenant through
    eight loops to serve one row would touch every line of a fixture whose ordering
    already cost one production incident; four explicit inserts touch nothing.

    He is a managing partner with full practice-area scope and real financial
    authority, so nothing about his own authority refuses him. The ONLY thing that
    stands between him and sending an invoice is that his firm has no fiscal identity
    — which is exactly the single variable the fiscal gate is supposed to isolate.
  */
  {
    const najd = najdPeople[0];
    const najdMembershipId = detId(`firm_membership:${IDS.tenantNajd}:${najd.userId}`);
    add('staff', {
      id: najd.staffId, tenant_id: IDS.tenantNajd,
      full_name: najd.name, full_name_ar: najd.nameAr,
      internal_role: 'managing_partner', client_visible: 1,
      email: najd.email, created_at: now,
    });
    add('users', {
      id: najd.userId, email: najd.email, password_hash: firmPw,
      password_updated_at: now, email_verified_at: now, status: 'active',
      failed_login_count: 0, locked_until: null, last_login_at: null, last_login_ip_hash: null,
      mfa_enabled: 0, mfa_method: null, mfa_secret_enc: null, mfa_enabled_at: null,
      preferred_language: 'ar', preferred_calendar: 'islamic-umalqura',
      created_at: now, updated_at: now,
    });
    add('firm_memberships', {
      id: najdMembershipId, tenant_id: IDS.tenantNajd, user_id: najd.userId, staff_id: najd.staffId,
      job_title: najd.title, job_title_ar: najd.titleAr, status: 'active',
      financial_authority_sar: najd.financial, writeoff_authority_sar: najd.writeoff,
      discount_authority_pct: najd.discount,
      joined_at: iso(-90, 8), left_at: null, invited_by_membership_id: null,
      created_at: now, updated_at: now,
    });
    add('membership_roles', {
      membership_id: najdMembershipId, role_id: tenantRoleId(IDS.tenantNajd, najd.template),
      granted_by_membership_id: null, grant_origin: 'bootstrap',
      granted_at: iso(-90, 8), revoked_at: null,
    });
    add('department_members', {
      department_id: deptId(IDS.tenantNajd, najd.department), membership_id: najdMembershipId,
      is_lead: najd.isDeptLead, joined_at: iso(-90, 8),
    });
    for (const area of najd.practiceAreas) {
      add('membership_practice_areas', {
        membership_id: najdMembershipId, practice_area: area, granted_at: iso(-90, 8),
      });
    }
  }

  // ------------------------------------------------ matter scoping (§17, §27)
  // One control row per matter, in BOTH tenants. matterGulf is restricted: it is
  // the row that proves §27, because a restricted matter stops being reachable
  // through practice-area scope and demands an explicit grant.
  for (const m of matters) {
    const restricted = m.id === IDS.matterGulf;
    add('matter_controls', {
      matter_id: m.id, tenant_id: m.tenant,
      department_id: deptId(m.tenant, 'LEGAL'),
      owner_membership_id: membershipId(IDS.userNoura),
      lead_staff_id: staff[0].id,
      supervising_partner_staff_id: m.tenant === IDS.tenantKgm ? staff[0].id : null,
      is_restricted: restricted ? 1 : 0,
      restriction_reason: restricted ? 'Highly confidential acquisition — Client 2 only' : null,
      restriction_reason_ar: restricted ? 'استحواذ شديد السرية — العميل الثاني فقط' : null,
      restricted_at: restricted ? iso(-30, 10) : null,
      restricted_by_membership_id: restricted ? membershipId(IDS.userNoura) : null,
      created_at: now, updated_at: now,
    });
  }

  // Explicit grants on the restricted matter. Noura and Faisal are on the team
  // already, so these rows exist to show that §27 is satisfied by an explicit
  // record rather than by team membership; Sara gets a lateral `financial` level
  // so Finance can bill the matter without reading its legal strategy (§14).
  const EXPLICIT_GRANTS: [string, string, string, string][] = [
    [IDS.matterGulf, IDS.userNoura, 'full', 'Restricted matter owner'],
    [IDS.matterGulf, IDS.userFaisal, 'edit', 'Assigned by Managing Partner'],
    [IDS.matterGulf, IDS.userSara, 'financial', 'Billing only'],
  ];
  for (const [matterId, userId, level, reason] of EXPLICIT_GRANTS) {
    add('matter_permissions', {
      id: detId(`matter_perm:${matterId}:${userId}`), matter_id: matterId,
      tenant_id: IDS.tenantKgm, membership_id: membershipId(userId),
      access_level: level, reason, granted_by_membership_id: membershipId(IDS.userNoura),
      granted_at: iso(-29, 9), revoked_at: null,
    });
  }
  // A denial record: Mariam is explicitly kept off the restricted matter. A row
  // with access_level 'none' is stronger than an absent row, because it survives
  // a later practice-area widening and documents the decision (§27).
  add('matter_permissions', {
    id: detId(`matter_perm:${IDS.matterGulf}:${IDS.userMariam}`), matter_id: IDS.matterGulf,
    tenant_id: IDS.tenantKgm, membership_id: membershipId(IDS.userMariam),
    access_level: 'none', reason: 'Excluded from confidential acquisition',
    granted_by_membership_id: membershipId(IDS.userNoura),
    granted_at: iso(-29, 9), revoked_at: null,
  });

  // ------------------------------------------------- tenant configuration (§50)
  // Multi-firm SaaS: per-tenant branding, locale, VAT and session policy. These
  // are the values the tenant-switching UI and the firm login page read, and
  // they are the reason two firms can share one deployment without sharing a
  // look, a tax rate or a password policy.
  add('tenant_settings', {
    tenant_id: IDS.tenantKgm,
    display_name: 'KGM Law Firm', display_name_ar: 'شركة كيه جي إم للمحاماة',
    brand_key: 'kgm', support_email: 'support@kgm.example.test',
    support_phone: '+966 1X XXX 0000',
    timezone: 'Asia/Riyadh', currency: 'SAR', vat_rate: 0.15,
    fiscal_year_start_month: 1,
    notification_channels: JSON.stringify(['in_app', 'email']),
    // §52: the SWITCH that makes MFA compulsory for the roles that can change
    // the authorization graph. Seeded OFF so the demo is usable without an
    // authenticator; tests/security/firm-rbac.test.ts flips it on and asserts
    // that a Managing Partner who has not enrolled cannot sign in, and that a
    // critical action is refused mid-session without a verified factor.
    mfa_required: 0, password_min_length: 12,
    session_absolute_minutes: 720, session_idle_minutes: 30,
    updated_at: now,
  });
  add('tenant_settings', {
    tenant_id: IDS.tenantNajd,
    display_name: 'Najd Legal Partners', display_name_ar: 'شركاء نجد القانونيون',
    brand_key: 'najd', support_email: 'support@najd.example.test',
    support_phone: '+966 1X XXX 1111',
    timezone: 'Asia/Riyadh', currency: 'SAR', vat_rate: 0.15,
    fiscal_year_start_month: 1,
    notification_channels: JSON.stringify(['in_app']),
    mfa_required: 0, password_min_length: 12,
    session_absolute_minutes: 480, session_idle_minutes: 20,
    updated_at: now,
  });

  /*
    ── P0.1 · THE PARTY REGISTER, AND A CONFLICT WORTH FINDING ────────────────

    Placed last because `conflict_checks.started_by_membership_id` and the
    affiliations reference `firm_memberships`, which is seeded above.

    What this builds is a firm that has a real conflict on its books, of the kind
    القاعدة الثامنة exists to catch:

      · «مؤسسة النخبة التجارية» was a client of the firm until 15 August 2024, and
        is now the COUNTERPARTY on KGM-2026-0148. Three years have not passed, so
        acting for the new client is a potential conflict requiring the former
        client's written consent.
      · Faisal Al-Harbi previously worked for «مجموعة الرياض القابضة», which is the
        counterparty on KGM-2026-0151. القاعدة ٨/٢ and ٨/٣ give that five years.
      · Noura Al-Qahtani sits on the board of «شركة الفجر للمقاولات», also adverse on
        KGM-2026-0148 — a potential conflict with no window, because an interest does
        not expire with time.
      · «شركة قديم للخدمات اللوجستية» ended its relationship in June 2019, and its
        counterparty appearance on KGM-2026-0170 is therefore NOT a conflict — the
        exception in القاعدة ٨/٤, recorded rather than silently skipped.
      · A counterparty entered at intake as «شركة الفجر للمقاولات والتجارة», which
        the matcher can only CALL A CANDIDATE — one company written two ways, or two
        companies with a common name. That one is for a human.

    The register also holds the aliases, because a company appears differently in a
    court filing, in Najiz and on its commercial registration, and a conflict search
    that only knows one of those spellings finds the conflict some of the time.
  */

  const aliases: Array<[string, string, string, string, string]> = [
    [IDS.partyGulf, 'Gulf Horizon Trading', 'en', 'manual', 'Short form used in correspondence.'],
    [IDS.partyGulf, 'الأفق للتجارة', 'ar', 'najiz', 'As it appears on the Najiz case record.'],
    [IDS.partyFajr, 'مؤسسة الفجر للمقاولات', 'ar', 'court_filing', 'The legal form differs on the filing.'],
    [IDS.partyFajr, 'Al-Fajr Contracting Co. Ltd.', 'en', 'commercial_registration', 'English form on the CR.'],
    [IDS.partyNukhba, 'النخبة التجارية', 'ar', 'court_filing', 'Without the legal form word.'],
    [IDS.partyRiyadh, 'Riyadh Holding', 'en', 'manual', 'Short form.'],
  ];
  for (const [partyId, alias, script, source, note] of aliases) {
    add('party_aliases', {
      id: detId(`alias:${partyId}:${alias}`),
      tenant_id: matters.find((m) => m.id === IDS.matterCommercial)!.tenant,
      party_id: partyId, alias, alias_normalized: normalizeArabicName(alias),
      script, source, created_at: now, updated_at: now, note,
    });
  }

  // Who is on which side. Note the absence of a client role: the client of a matter
  // is matters.client_id, and a second way to say it would be a second answer.
  const matterParties: Array<[string, string, string, string]> = [
    [IDS.matterCommercial, IDS.partyNukhba, 'counterparty', 'الطرف الآخر في نزاع الفواتير'],
    [IDS.matterCommercial, IDS.partyFajr, 'counterparty', 'مقاول متعاقد من الباطن'],
    [IDS.matterRealEstate, IDS.partyRiyadh, 'counterparty', 'مالك العقار'],
    [IDS.matterEmployment, IDS.partyFajrVariant, 'counterparty', 'اسم مُدخل عند الاستلام'],
    [IDS.matterGulf, IDS.partyQadim, 'counterparty', 'طرف مقابل في ملف قديم الصلة'],
    [IDS.matterNukhba, IDS.partyFajr, 'related_entity', 'طرف ذو علاقة — ليس خصماً'],
    [IDS.matterQadim, IDS.partyRiyadh, 'counterparty', 'طرف مقابل في الملف المنتهي'],
  ];
  for (const [matterId, partyId, role, note] of matterParties) {
    add('matter_parties', {
      id: detId(`matter_party:${matterId}:${partyId}:${role}`),
      tenant_id: matters.find((m) => m.id === matterId)!.tenant,
      matter_id: matterId, party_id: partyId, role, note,
      added_by_membership_id: null,
      // 29 days ago, and the DATE IS LOAD-BEARING. `matter_conflict_gate` accepts a
      // check as covering a matter only when every party on the matter was added no
      // later than the moment the check started — because a conflict check that ran
      // before the counterparty was known has not checked the counterparty.
      //
      // The first version of this seed used `now` for these rows and backdated the
      // check to 30 days ago, which is a sequence that cannot happen: the check
      // would have run before the parties existed. Every clearance it produced
      // failed the trigger's coverage test, so the demo's one "cleared" matter was
      // cleared by a record the database itself refused to honour. The seed now
      // tells a story that can happen: opened 30 days ago, parties registered the
      // day after, check run two days ago.
      created_at: iso(-29, 9), updated_at: iso(-29, 9),
    });
  }

  /*
    Declared interests of the firm's own people.

    These are the records no one remembers unaided: that a partner sits on a
    board, that a lawyer used to work somewhere. القاعدة ٨/٢ and ٨/٣ make the second
    an obligation with a five-year life, and القاعدة ٨/١ makes the first a
    «محتمل» conflict for as long as the interest lasts.
  */
  const affiliations: Array<[string, string, string, string | null, string | null, string]> = [
    // [partyId, staffId, relation, startedOn, endedOn, note]
    [IDS.partyRiyadh, staff[1].id, 'former_employer', '2015-03-01', '2023-01-31',
      'Employment before joining the firm.'],
    [IDS.partyFajr, staff[0].id, 'board_member', '2021-06-01', null,
      'Non-executive board seat declared on joining.'],
    [IDS.partyQadim, staff[0].id, 'former_employer', '2008-01-01', '2014-12-31',
      'Historical employment; the five years of القاعدة ٨/٣ expired in 2019.'],
  ];
  for (const [partyId, staffId, relation, startedOn, endedOn, note] of affiliations) {
    add('party_affiliations', {
      id: detId(`affiliation:${partyId}:${staffId}:${relation}`),
      tenant_id: IDS.tenantKgm, party_id: partyId, staff_id: staffId, relation,
      started_on: startedOn, ended_on: endedOn, note,
      recorded_by_membership_id: null, created_at: now, updated_at: now,
    });
  }

  /*
    ONE CONCLUDED CHECK: the acquisition file, which is genuinely clear.

    It is clear because its only finding is the former client whose three years had
    already run — القاعدة ٨/٤'s exception in action. That finding is recorded with a
    severity of 'none' rather than dropped, so the register shows WHY the matter
    cleared, which is the question asked about a clearance six months later.
  */
  // The membership id shape used by the memberships block above:
  // detId(`firm_membership:${tenant}:${userId}`). Reusing the helper would mean the
  // two expressions of "who is this membership" living in one file; this one is
  // derived from the same label, and the FK below proves they agree.
  const nouraMembershipId = detId(`firm_membership:${IDS.tenantKgm}:${IDS.userNoura}`);
  const gulfCheckId = detId('conflict_check:gulf');
  add('conflict_checks', {
    id: gulfCheckId, tenant_id: IDS.tenantKgm, matter_id: IDS.matterGulf,
    kind: 'intake', status: 'clear', parties_checked: 2, matters_searched: 7, hits_found: 1,
    started_by_membership_id: nouraMembershipId,
    started_at: iso(-28, 9),
    concluded_by_membership_id: nouraMembershipId,
    concluded_at: iso(-28, 10),
    conclusion: 'لا يوجد تعارض: العلاقة مع «شركة قديم» انتهت في ٢٠١٩ ومضى أكثر من ثلاث سنوات.',
    created_at: iso(-28, 9), updated_at: iso(-28, 10),
  });
  add('conflict_hits', {
    id: detId(`conflict_hit:${gulfCheckId}:${IDS.partyQadim}`),
    tenant_id: IDS.tenantKgm, check_id: gulfCheckId, matter_id: IDS.matterGulf,
    party_id: IDS.partyQadim, matched_party_id: IDS.partyQadim, matched_matter_id: IDS.matterQadim,
    matched_client_id: IDS.clientQadim, relation: 'former_client',
    match_strength: 'exact', match_basis: 'name',
    affected_party_id: IDS.partyQadim,
    // What the engine assessed (0031), and what a person decided. They agree here
    // because the window really had closed.
    proposed_severity: 'none', severity: 'none',
    rule_cited: 'القاعدة الثامنة/٤ من قواعد السلوك المهني — انقضاء ثلاث سنوات على العلاقة',
    relationship_ended_on: '2019-06-30', window_years: 3, window_lifts_on: '2022-06-30',
    within_window: 0, disposition: 'same_party',
    disposition_reason: 'نفس الطرف؛ والقاعدة ٨/٤ تقضي بأن انقضاء ثلاث سنوات يرفع التعارض.',
    disposition_by_membership_id: nouraMembershipId,
    disposition_at: iso(-28, 10), created_at: iso(-28, 9), updated_at: iso(-28, 10),
  });
  /*
    NOTE ON THE DERIVED COLUMN.

    `matters.conflict_cleared` for KGM-2026-0170 is set to 1 in the MAIN matters
    loop above, not here, and the first draft of this seed got that wrong: it emitted
    a second `matters` row at the end of the function with the derived value on it.
    The seed inserts with `on conflict do nothing`, so the second row was silently
    discarded and the column stayed null — a seed that reported one state and wrote
    another, with nothing failing.

    The value is legitimately 1: the check seeded below is CONCLUDED, and its single
    hit was dispositioned, which is the definition this system uses for clearance.
    The seed and the schema agree, so the row is consistent with its own ledger —
    which is what a demo dataset is supposed to be.

    The engine derives this value in production. Nothing in the running system reads
    a seeded `conflict_cleared` to decide anything.
  */

  // ─────────────────────────────────────────────── what a fee rests on (0036)
  /*
    THE ENGAGEMENT CONTRACT, AND THE GATE IT OPERATES.

    Only two of the five matters have a signed engagement letter, and that is the
    point of the fixture rather than an oversight: the other matters are the ones on
    which billable time is REFUSED, and the demo can show the refusal instead of
    asserting that it would happen. A fixture where every gate passes demonstrates
    nothing about the gates.
  */
  const engagementDocs: Record<string, string> = {
    [IDS.matterCommercial]: 'c1000000-0000-4000-8000-000000000002',   // the signed letter, already a document
    [IDS.matterGulf]: 'c1000000-0000-4000-8000-000000000005',
  };
  const engagementLetters = [
    {
      matter: IDS.matterCommercial, client: IDS.clientAhmed, fee: null as number | null,
      scope: 'Representation in the commercial claim against Al-Fajr Contracting, through first instance.',
      scopeAr: 'التمثيل في الدعوى التجارية ضد شركة الفجر للمقاولات أمام محكمة أول درجة.',
      method: 'Hourly, at the rates in the firm rate card current at the date each hour is worked.',
      methodAr: 'بالساعة، وفق جدول الأسعار الساري في تاريخ تسجيل كل ساعة.',
    },
    {
      matter: IDS.matterGulf, client: IDS.clientGulf, fee: null as number | null,
      scope: 'Advisory and transactional support on the acquisition of the Riyadh distribution business.',
      scopeAr: 'الدعم الاستشاري والتعاقدي في الاستحواذ على نشاط التوزيع في الرياض.',
      method: 'Hourly against an agreed cap of SAR 75,000, at which point the work is re-scoped in writing.',
      methodAr: 'بالساعة بحد أقصى متفق عليه قدره ٧٥٬٠٠٠ ريال، يُعاد عنده تحديد النطاق كتابةً.',
    },
  ];
  for (const el of engagementLetters) {
    add('engagement_letters', {
      id: detId(`engagement:${el.matter}`), tenant_id: IDS.tenantKgm, matter_id: el.matter,
      client_id: el.client, scope: el.scope, scope_ar: el.scopeAr,
      fee_amount_sar: el.fee, calculation_method: el.method,
      signed_by_client_at: iso(-45), signed_by_client_name: el.client === IDS.clientGulf ? 'Khalid Al-Mutairi' : 'Ahmed Al-Saud',
      document_id: engagementDocs[el.matter],
      // Rule 11's three preconditions, recorded on the gate itself.
      identity_verified_at: iso(-46), capacity_verified: 1,
      status: 'signed', superseded_by: null, created_by_user_id: IDS.userSara,
      created_at: iso(-46), 
    });
  }

  const rateCard = [
    { level: 'managing_partner', rate: 2_400 },
    { level: 'partner', rate: 1_800 },
    { level: 'senior_associate', rate: 1_200 },
    { level: 'associate', rate: 900 },
    { level: 'paralegal', rate: 350 },
  ];
  for (const rc of rateCard) {
    add('rate_cards', {
      id: detId(`rate_card:${rc.level}`), tenant_id: IDS.tenantKgm, level: rc.level,
      staff_id: null, practice_area: null, hourly_rate_sar: rc.rate,
      effective_from: date(-365), effective_to: null,
      created_by_user_id: IDS.userSara, created_at: iso(-365),
    });
  }

  /*
    TERMS PER BASIS, so all four the rule's "method of calculation" resolves to are
    visible in the demo, and so the capped one has something to be capped at.
  */
  const billingTerms = [
    { matter: IDS.matterCommercial, basis: 'hourly', fee: null, cap: null, retainer: null, disc: 0,
      notes: 'Standard hourly engagement. Rates per the firm card at the date worked.' },
    { matter: IDS.matterGulf, basis: 'capped', fee: null, cap: 75_000, retainer: null, disc: 5,
      notes: 'Capped at SAR 75,000 by written agreement of 12 August. Re-scope above the cap.' },
    { matter: IDS.matterRealEstate, basis: 'fixed', fee: 9_500, cap: null, retainer: null, disc: 0,
      notes: 'Fixed fee for the lease review, agreed in the engagement letter.' },
    { matter: IDS.matterNukhba, basis: 'staged', fee: null, cap: null, retainer: null, disc: 0,
      notes: 'Staged: pleadings, hearing, judgment.',
      stages: JSON.stringify([{ label: 'Pleadings', amount: 20_000 }, { label: 'Hearing', amount: 15_000 }, { label: 'Judgment', amount: 10_000 }]) },
  ];
  for (const bt of billingTerms) {
    add('matter_billing_terms', {
      id: detId(`billing_terms:${bt.matter}`), tenant_id: IDS.tenantKgm, matter_id: bt.matter,
      basis: bt.basis, fee_amount_sar: bt.fee, cap_amount_sar: bt.cap,
      retainer_amount_sar: bt.retainer, stages: (bt as { stages?: string }).stages ?? null,
      agreed_discount_pct: bt.disc, vat_applicable: 1,
      effective_from: date(-45), effective_to: null, superseded_by: null, notes: bt.notes,
      created_by_user_id: IDS.userSara, created_at: iso(-45),
    });
  }

  /*
    TIME, RECORDED AT THE RATE THAT APPLIED WHEN IT WAS WORKED — copied onto the row,
    not joined at billing. Prices on the card change; hours already worked do not.
  */
  const timeWork = [
    { matter: IDS.matterCommercial, staff: 1, days: -18, mins: 185, rate: 1_200,
      narrative: 'Drafting statement of claim and reviewing the supply agreement.',
      narrativeAr: 'صياغة صحيفة الدعوى ومراجعة اتفاقية التوريد.' },
    { matter: IDS.matterCommercial, staff: 1, days: -14, mins: 95, rate: 1_200,
      narrative: 'Attendance at the first case management session.',
      narrativeAr: 'حضور جلسة إدارة الدعوى الأولى.' },
    { matter: IDS.matterCommercial, staff: 2, days: -11, mins: 150, rate: 350,
      narrative: 'Chronology and bundle preparation for the hearing file.',
      narrativeAr: 'إعداد التسلسل الزمني وحزمة ملف الجلسة.' },
    { matter: IDS.matterCommercial, staff: 0, days: -9, mins: 60, rate: 2_400,
      narrative: 'Partner review of the claim before filing.',
      narrativeAr: 'مراجعة الشريك لصحيفة الدعوى قبل التقديم.' },
    { matter: IDS.matterGulf, staff: 1, days: -7, mins: 240, rate: 1_200,
      narrative: 'Due diligence on the target and drafting the disclosure schedule.',
      narrativeAr: 'العناية الواجبة على الشركة المستهدفة وصياغة جدول الإفصاح.' },
    { matter: IDS.matterGulf, staff: 0, days: -4, mins: 90, rate: 2_400,
      narrative: 'Negotiation session with opposing counsel on the price adjustment.',
      narrativeAr: 'جلسة تفاوض مع محامي الطرف الآخر بشأن تعديل السعر.' },
  ];
  for (const t of timeWork) {
    const amount = Math.round((t.mins / 60) * t.rate * 100) / 100;
    add('time_entries', {
      id: detId(`time:${t.matter}:${t.days}:${t.staff}`), tenant_id: IDS.tenantKgm,
      matter_id: t.matter, staff_id: staff[t.staff].id, entry_date: date(t.days),
      minutes: t.mins, narrative: t.narrative, narrative_ar: t.narrativeAr,
      billable: 1, hourly_rate_sar: t.rate, amount_sar: amount,
      invoice_id: null, status: 'approved',
      approved_by_user_id: IDS.userSara, approved_at: iso(t.days + 1),
      written_off_reason: null, created_at: iso(t.days), updated_at: iso(t.days + 1),
    });
  }
  // A NON-BILLABLE HOUR on a matter with no engagement letter. Recorded, and
  // deliberately not billable — which is the only kind of time this matter may hold.
  add('time_entries', {
    id: detId(`time:${IDS.matterEmployment}:pro-bono`), tenant_id: IDS.tenantKgm,
    matter_id: IDS.matterEmployment, staff_id: staff[1].id, entry_date: date(-6),
    minutes: 45, narrative: 'Initial assessment of the employment claim (no engagement in place).',
    narrative_ar: 'التقييم الأولي لمطالبة العمل (لا يوجد خطاب ارتباط).',
    billable: 0, hourly_rate_sar: 0, amount_sar: 0,
    invoice_id: null, status: 'non_billable', approved_by_user_id: null, approved_at: null,
    written_off_reason: null, created_at: iso(-6), updated_at: iso(-6),
  });

  // Disbursements. The reimbursable one carries its receipt; the internal one does not
  // need to, because it is not being passed on.
  add('expenses', {
    id: detId('expense:gulf:court-fee'), tenant_id: IDS.tenantKgm, matter_id: IDS.matterGulf,
    client_id: IDS.clientGulf, submitted_by_staff: staff[1].id, incurred_on: date(-7),
    category: 'court_fee', description: 'Commercial court filing fee — acquisition dispute.',
    description_ar: 'رسوم تقديم لدى المحكمة التجارية — نزاع الاستحواذ.',
    net_amount_sar: 1_000, vat_amount_sar: 150, total_amount_sar: 1_150,
    vat_category: 'standard', receipt_document_id: 'c1000000-0000-4000-8000-000000000007',
    reimbursable: 1, invoice_id: null, status: 'approved',
    approved_by_user_id: IDS.userSara, approved_at: iso(-6),
    rejection_reason: null, created_at: iso(-7), updated_at: iso(-6),
  });
  add('expenses', {
    id: detId('expense:commercial:translation'), tenant_id: IDS.tenantKgm, matter_id: IDS.matterCommercial,
    client_id: IDS.clientAhmed, submitted_by_staff: staff[2].id, incurred_on: date(-12),
    category: 'translation', description: 'Certified translation of the supply agreement.',
    description_ar: 'ترجمة معتمدة لاتفاقية التوريد.',
    net_amount_sar: 2_400, vat_amount_sar: 360, total_amount_sar: 2_760,
    vat_category: 'standard', receipt_document_id: null,
    // Not reimbursable: the firm absorbed it, so there is nothing to evidence to the
    // client and nothing to recharge.
    reimbursable: 0, invoice_id: null, status: 'approved',
    approved_by_user_id: IDS.userSara, approved_at: iso(-11),
    rejection_reason: null, created_at: iso(-12), updated_at: iso(-11),
  });

  // ────────────────────────────────────────────────────────────── client money (0035)
  /*
    A RETAINER HELD, AND PART OF IT APPLIED.

    Ahmed paid SAR 25,000 on account before any invoice was raised. SAR 4,000 of it
    has been applied to the lease-review invoice, which is why that invoice shows a
    part payment — the invoice and the ledger tell the SAME story rather than two
    stories that happen to be adjacent. The remaining SAR 21,000 is held, and it is
    the firm's liability, not its cash.
  */
  add('client_ledgers', {
    id: detId(`ledger:${IDS.clientAhmed}`), tenant_id: IDS.tenantKgm, client_id: IDS.clientAhmed,
    currency: 'SAR', status: 'open', frozen_reason: null,
    opened_at: iso(-30), closed_at: null, created_at: iso(-30), updated_at: iso(-30),
  });
  add('client_ledgers', {
    id: detId(`ledger:${IDS.clientGulf}`), tenant_id: IDS.tenantKgm, client_id: IDS.clientGulf,
    currency: 'SAR', status: 'open', frozen_reason: null,
    opened_at: iso(-25), closed_at: null, created_at: iso(-25), updated_at: iso(-25),
  });

  add('ledger_entries', {
    id: detId('ledger_entry:ahmed-receipt'), tenant_id: IDS.tenantKgm,
    ledger_id: detId(`ledger:${IDS.clientAhmed}`), client_id: IDS.clientAhmed,
    entry_type: 'receipt', direction: 'credit', amount: 25_000, currency: 'SAR',
    invoice_id: null, matter_id: null,
    description: 'Retainer received on account, before any invoice was raised.',
    reference: 'IBAN transfer ref 88213', evidence_document_id: null,
    reverses_entry_id: null, reversal_reason: null,
    entry_at: iso(-30, 11), recorded_by_user_id: IDS.userSara, recorded_at: iso(-30, 11),
  });
  add('ledger_entries', {
    id: detId('ledger_entry:ahmed-application'), tenant_id: IDS.tenantKgm,
    ledger_id: detId(`ledger:${IDS.clientAhmed}`), client_id: IDS.clientAhmed,
    entry_type: 'application_to_fee', direction: 'debit', amount: 4_000, currency: 'SAR',
    invoice_id: 'd1000000-0000-4000-8000-000000000002', matter_id: IDS.matterRealEstate,
    description: 'Applied against INV-2026-0151 (lease review, phase one).',
    reference: 'INV-2026-0151', evidence_document_id: null,
    reverses_entry_id: null, reversal_reason: null,
    entry_at: iso(-4, 10), recorded_by_user_id: IDS.userSara, recorded_at: iso(-4, 10),
  });
  add('ledger_entries', {
    id: detId('ledger_entry:gulf-receipt'), tenant_id: IDS.tenantKgm,
    ledger_id: detId(`ledger:${IDS.clientGulf}`), client_id: IDS.clientGulf,
    entry_type: 'receipt', direction: 'credit', amount: 40_000, currency: 'SAR',
    invoice_id: null, matter_id: null,
    description: 'Advance against disbursements on the acquisition matter.',
    reference: 'IBAN transfer ref 90114', evidence_document_id: null,
    reverses_entry_id: null, reversal_reason: null,
    entry_at: iso(-25, 14), recorded_by_user_id: IDS.userSara, recorded_at: iso(-25, 14),
  });

  /*
    TWO RECONCILIATIONS, AND THE SECOND ONE DOES NOT BALANCE.

    A demo where every reconciliation agrees is a demo that has never been near a
    client account. The discrepancy of SAR 1,250 is recorded with its explanation and
    left open as 'investigated', which is what the schema makes you do — the row
    cannot claim 'balanced' with a difference on it, and it cannot be amended
    afterwards to make the difference go away.
  */
  add('ledger_reconciliations', {
    id: detId('reconciliation:kgm:balanced'), tenant_id: IDS.tenantKgm, currency: 'SAR',
    as_of: iso(-20, 23), ledger_total: 65_000, bank_balance: 65_000, difference: 0,
    bank_statement_reference: 'SA03 8000 0000 6080 1016 7519 · 30 Jun',
    bank_statement_document_id: null, clients_with_balance: 2, status: 'balanced',
    notes: null, performed_by_user_id: IDS.userSara, performed_at: iso(-19), created_at: iso(-19),
  });
  add('ledger_reconciliations', {
    id: detId('reconciliation:kgm:difference'), tenant_id: IDS.tenantKgm, currency: 'SAR',
    as_of: iso(-2, 23), ledger_total: 61_000, bank_balance: 61_000 - 1_250, difference: 1_250,
    bank_statement_reference: 'SA03 8000 0000 6080 1016 7519 · 31 Jul',
    bank_statement_document_id: null, clients_with_balance: 2, status: 'investigated',
    notes: 'SAR 1,250 bank charge posted by the bank on 30 July that has not yet been recorded against a client ledger. Charged to the firm, not to either client; to be posted as an operating expense.',
    performed_by_user_id: IDS.userSara, performed_at: iso(-1), created_at: iso(-1),
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     P0.3 · CLIENT DUE DILIGENCE, THE OWNERS, THE SCREENING AND ONE REPORT

     WHAT THIS DATASET HAS TO BE ABLE TO SHOW, in the order the obligation runs:

       · a client whose due diligence is COMPLETE, whose owners are accounted for
         and whose screening is resolved — the matter gate admits them, and the
         only way to prove a gate admits anybody is to have somebody it admits;
       · a client whose due diligence is COMPLETE but whose screening has an OPEN
         HIT — the case an inspector looks for, because the file looks finished;
       · a client whose screening RUN FAILED — which is not a clearance, and reads
         as one in any schema that has no status for it;
       · a legal person whose owners are genuinely opaque — a chain that ends in a
         nominee nobody will name;
       · a company that owns 100% of itself, recorded as a legal person, because the
         obvious implementation of "add up the percentages" accepts that chain and
         a clean one refuses it;
       · one client the firm was asked to act for and COULD NOT IDENTIFY — the case
         the manual is clearest about, where the answer is a prohibition;
       · one report, filed, against a client whose screening went wrong.

     AND ONE THING THIS DATASET DELIBERATELY DOES NOT DO. It never opens a matter
     for a client whose record is incomplete. `matter_cdd_gate` would refuse the
     seed on a fresh database, which is the gate working — but a fixture that
     cannot load is not a fixture. The incomplete clients are clients, not matters.
  */

  /*
    ── THE REGISTER OF HIGH-RISK JURISDICTIONS ─────────────────────────────────

    A SHORT, REAL LIST, DATED. The Kingdom's own designations come by circular and
    the FATF lists move; what this records is which list was in force and when, so
    that "why was this client rated high in March" has an answer that is not the
    opinion of whoever is being asked.
  */
  const riskCountries: Array<[string, string, string, string, string, string]> = [
    ['IR', 'Iran', 'إيران', 'fatf_call_for_action', 'prohibited', '2020-02-21'],
    ['KP', 'Korea, Democratic People\'s Republic of', 'كوريا الشمالية', 'fatf_call_for_action', 'prohibited', '2020-02-21'],
    ['MM', 'Myanmar', 'ميانمار', 'fatf_call_for_action', 'prohibited', '2023-10-01'],
    ['SY', 'Syrian Arab Republic', 'الجمهورية العربية السورية', 'sama_circular', 'high', '2011-05-01'],
    ['YE', 'Yemen', 'اليمن', 'fatf_grey', 'high', '2024-06-28'],
    ['NG', 'Nigeria', 'نيجيريا', 'fatf_grey', 'high', '2023-02-24'],
    ['LB', 'Lebanon', 'لبنان', 'internal', 'high', '2024-11-01'],
  ];
  for (const [code, name, nameAr, source, level, from] of riskCountries) {
    add('aml_risk_countries', {
      id: detId(`risk_country:${code}:${source}`), tenant_id: IDS.tenantKgm,
      country_code: code, country_name: name, country_name_ar: nameAr,
      list_source: source, risk_level: level, effective_from: from, effective_to: null,
      note: null, created_by_membership_id: detId(`firm_membership:${IDS.tenantKgm}:${IDS.userOmar}`),
      created_at: now, updated_at: now,
    });
  }

  const ddNoura = detId(`firm_membership:${IDS.tenantKgm}:${IDS.userNoura}`);
  const ddOmar = detId(`firm_membership:${IDS.tenantKgm}:${IDS.userOmar}`);
  const ddGulf = detId(`due_diligence:${IDS.clientGulf}`);
  const ddNukhba = detId(`due_diligence:${IDS.clientNukhba}`);
  const ddQadim = detId(`due_diligence:${IDS.clientQadim}`);

  /*
    ── AHMED: AN INDIVIDUAL, COMPLETE, AND ADMITTED ────────────────────────────

    Every field a natural person is identified by, plus the two that exist because
    the risk assessment needs them rather than because a form asked: where the
    funds come from, and why he is here at all.

    `risk_rating` is 'low' and the reasons are EMPTY, which is a statement rather
    than an omission: nothing in the record elevated it. The pair travels together
    in the schema, so a rating without reasons cannot be written by accident.
  */
  add('client_due_diligence', {
    id: detId(`due_diligence:${IDS.clientAhmed}`), tenant_id: IDS.tenantKgm,
    client_id: IDS.clientAhmed, party_id: IDS.partyAhmed, version: 1,
    cdd_level: 'standard', status: 'complete',
    legal_name: 'Ahmed bin Saud Al-Saud', legal_name_ar: 'أحمد بن سعود السعود',
    date_of_birth: '1981-06-14', nationality: 'SA', residence_country: 'SA',
    address: 'King Fahd Road, Al Olaya, Riyadh 12212',
    id_type: 'national_id', id_number_hash: keyedHash('demo-nid-1234'),
    id_number_masked: '********1234', id_issued_at: '2019-03-02', id_expires_at: '2029-03-01',
    cr_number: null, cr_issued_at: null, incorporation_country: null, business_activity: null,
    ownership_structure: null,
    source_of_funds: 'Salary and accumulated savings from his employment in the Kingdom.',
    source_of_wealth: null,
    purpose: 'A commercial dispute with a former supplier, and a review of an existing lease.',
    expected_annual_volume_sar: 120_000,
    verification_method: 'electronic', verification_source: 'National single sign-on (demo)',
    verified_by_membership_id: ddOmar, verified_at: iso(-88, 10),
    /*
      NULL IS NOT 'not_pep'. It means NOBODY HAS MADE THE DETERMINATION, and it is
      the state that keeps the record incomplete. This one is determined because a
      determination was actually made — on the date recorded beside it.
    */
    pep_status: 'not_pep', pep_details: null,
    risk_rating: 'low', risk_reasons: '[]', risk_assessed_at: iso(-88, 10),
    senior_approved_by_membership_id: null, senior_approved_at: null, senior_approval_note: null,
    review_due_at: '2028-06-01', last_reviewed_at: iso(-88, 10),
    completed_at: iso(-88, 11), completed_by_membership_id: ddOmar,
    unable_reason: null, notes: null,
    superseded_by: null, superseded_at: null,
    created_by_membership_id: ddOmar, created_at: iso(-88, 9), updated_at: iso(-88, 11),
  });

  /*
    ── GULF HORIZON: A COMPANY, COMPLETE, TWO OWNERS AND A SCREENING THAT WENT WRONG

    Four things are happening in this client's file, and all four are the point.

    1. THE OWNERS. One natural person at 60% and one at 25% — the second is there so
       that the 25% threshold is TESTED rather than described. The third row owns 15%
       and is BELOW the threshold; it is recorded anyway, because the firm knows about
       it, and the gate must count it neither towards the threshold nor as a subject to
       screen. An implementation that screens every row passes this fixture; one that
       screens only the ones that count also passes. The one that fails is the one that
       sums unverified rows, which is why two of the three are verified and the
       interest of the third is recorded without verification.

    2. THE SCREENING. The company cleared; the 60% owner cleared; the 25% owner's run
       FAILED — the provider timed out. Nothing about that file looks unfinished, and
       in any schema without a `failed` status it reads as "no matches found". It is
       the most expensive false negative this obligation has, so the fixture contains
       it and the gate refuses on it.

    3. THE PEP. The 25% owner is a `pep_family` — a close relative of a serving
       official — which is a recorded determination, not an opinion, and it is the
       reason the assessment is high risk rather than medium.

    4. AND IT IS STILL `complete` WITH THE RIGHT LEVEL. The level is `standard`,
       deliberately. This client is NOT eligible for a matter to be opened, and the
       fixture says why in the record rather than in a comment: the determination was
       made, the level was not raised to meet it, and the firm's own record shows the
       gap. A fixture where every complete record is also admissible could not tell
       the two rules apart.

    `identity_verified` on the client row follows from this record — the trigger
    derives it, and the seed asserts nothing.
  */
  add('client_due_diligence', {
    id: ddGulf, tenant_id: IDS.tenantKgm,
    client_id: IDS.clientGulf, party_id: IDS.partyGulf, version: 1,
    cdd_level: 'standard', status: 'complete',
    legal_name: 'Gulf Horizon Trading Company (a Saudi closed joint stock company)',
    legal_name_ar: 'شركة الأفق التجاري (شركة مساهمة مقفلة سعودية)',
    date_of_birth: null, nationality: null, residence_country: 'SA',
    address: 'Corniche Road, Al Shatea, Jeddah 23613',
    id_type: 'commercial_registration', id_number_hash: keyedHash('demo-cr-1010556677'),
    id_number_masked: '******789', id_issued_at: '2016-02-08', id_expires_at: null,
    cr_number: '1010556677', cr_issued_at: '2016-02-08',
    incorporation_country: 'SA',
    business_activity: 'Wholesale of building materials and related trading activity.',
    ownership_structure: 'Three shareholders; the majority holder is also the general manager.',
    source_of_funds: 'Trading revenue and bank facilities with a licensed Saudi bank.',
    purpose: 'The acquisition of a competitor, and the disputes arising from it.',
    expected_annual_volume_sar: 480_000,
    verification_method: 'certified_copy',
    verification_source: 'CR extract and articles of association, certified and sighted.',
    verified_by_membership_id: ddOmar, verified_at: iso(-70, 10),
    pep_status: 'pep_family',
    pep_details: 'A majority shareholder is a close relative of a serving senior official.',
    risk_rating: 'high',
    risk_reasons: JSON.stringify([
      { code: 'pep', weight: 'high',
        label: 'a politically exposed person is connected to this relationship',
        labelAr: 'يرتبط بالعلاقة شخص ذو نفوذ سياسي' },
    ]),
    risk_assessed_at: iso(-70, 10),
    senior_approved_by_membership_id: null, senior_approved_at: null, senior_approval_note: null,
    review_due_at: '2027-03-01', last_reviewed_at: iso(-70, 10),
    completed_at: iso(-70, 11), completed_by_membership_id: ddOmar,
    unable_reason: null,
    notes: 'PEP determination recorded. Enhanced due diligence and senior approval have NOT yet been undertaken.',
    superseded_by: null, superseded_at: null,
    created_by_membership_id: ddOmar, created_at: iso(-72, 9), updated_at: iso(-70, 11),
  });

  /*
    ── QADIM: COMPLETE, OWNED, SCREENED AND ADMISSIBLE ────────────────────────
    The rule 8/4 exception client — the relationship that ended in 2019 — and the
    one legal person in this dataset for which a matter may be opened. Without it,
    every company in the demo would be a refusal and the gate would look like a
    wall rather than a gate.
  */
  add('client_due_diligence', {
    id: ddQadim, tenant_id: IDS.tenantKgm,
    client_id: IDS.clientQadim, party_id: IDS.partyQadim, version: 1,
    cdd_level: 'standard', status: 'complete',
    legal_name: 'Qadim Logistics Company', legal_name_ar: 'شركة قديم للخدمات اللوجستية',
    date_of_birth: null, nationality: null, residence_country: 'SA',
    address: 'Industrial City, Phase 4, Riyadh 14331',
    id_type: 'commercial_registration', id_number_hash: keyedHash('demo-cr-4030998877'),
    id_number_masked: '******877', id_issued_at: '2014-05-19', id_expires_at: null,
    cr_number: '4030998877', cr_issued_at: '2014-05-19', incorporation_country: 'SA',
    business_activity: 'Freight forwarding and warehousing within the Kingdom.',
    ownership_structure: 'Controlled by the founder through a voting right rather than a shareholding.',
    source_of_funds: 'Operating revenue from freight contracts.',
    purpose: 'Recovery of unpaid invoices, if the firm is instructed again.',
    expected_annual_volume_sar: 80_000,
    verification_method: 'original_seen',
    verification_source: 'Originals sighted at the firm\'s offices.',
    verified_by_membership_id: ddOmar, verified_at: iso(-40, 10),
    pep_status: 'not_pep', pep_details: null,
    risk_rating: 'medium',
    risk_reasons: JSON.stringify([
      { code: 'cash_intensive', weight: 'medium',
        label: 'the business is cash-intensive by nature',
        labelAr: 'النشاط كثيف النقد بطبيعته' },
    ]),
    risk_assessed_at: iso(-40, 10),
    senior_approved_by_membership_id: null, senior_approved_at: null, senior_approval_note: null,
    review_due_at: '2027-09-01', last_reviewed_at: iso(-40, 10),
    completed_at: iso(-40, 11), completed_by_membership_id: ddOmar,
    unable_reason: null, notes: null,
    superseded_by: null, superseded_at: null,
    created_by_membership_id: ddOmar, created_at: iso(-41, 9), updated_at: iso(-40, 11),
  });

  /*
    ── AL-NUKHBA: A COMPANY WHOSE OWNER IS ANOTHER COMPANY ────────────────────

    Complete on paper, and not identified in fact. The register holds one owner,
    a legal person, at 100%, verified against a shareholders register — and that
    chain ends in a holding company in Jersey, itself held through a trust whose
    beneficiaries have never been provided.

    WHY THIS CLIENT IS IN THE FIXTURE. The obvious implementation of a 25% rule
    adds up `ownership_pct`, reaches 100, and concludes the client is identified —
    and then tries to screen a company against a designation list, which finds
    nothing, and the matter opens. That implementation is wrong in law (the
    obligation is about the PERSONS behind the client) and this is the row that
    catches it: the identified percentage counts verified natural persons only, so
    it is zero here, and no control right has been recorded to take its place.

    Its screening is deliberately absent. The gate's ownership check runs before
    the screening check in both dialects, so the refusal this client produces is
    `cdd_beneficial_owner_missing` — which is the honest answer about the file.
  */
  add('client_due_diligence', {
    id: ddNukhba, tenant_id: IDS.tenantKgm,
    client_id: IDS.clientNukhba, party_id: IDS.partyNukhba, version: 1,
    cdd_level: 'standard', status: 'complete',
    legal_name: 'Al-Nukhba Trading Establishment', legal_name_ar: 'مؤسسة النخبة التجارية',
    date_of_birth: null, nationality: null, residence_country: 'SA',
    address: 'King Abdulaziz Road, Al Malaz, Riyadh 12836',
    id_type: 'commercial_registration', id_number_hash: keyedHash('demo-cr-1010334455'),
    id_number_masked: '******455', id_issued_at: '2012-08-14', id_expires_at: null,
    cr_number: '1010334455', cr_issued_at: '2012-08-14', incorporation_country: 'SA',
    business_activity: 'General trading.',
    ownership_structure: 'Held in full by a company registered outside the Kingdom.',
    source_of_funds: 'Trading revenue.',
    purpose: 'A supply dispute, concluded in 2024.',
    expected_annual_volume_sar: 200_000,
    verification_method: 'certified_copy',
    verification_source: 'Shareholders register supplied by the client and certified.',
    verified_by_membership_id: ddOmar, verified_at: iso(-45, 10),
    pep_status: 'not_pep', pep_details: null,
    risk_rating: 'high',
    risk_reasons: JSON.stringify([
      { code: 'opaque_ownership', weight: 'high',
        label: 'the ownership is opaque — the identified owners hold 0.00% below the 25% threshold, and no control right is recorded',
        labelAr: 'هيكل الملكية غير واضح' },
    ]),
    risk_assessed_at: iso(-45, 10),
    senior_approved_by_membership_id: null, senior_approved_at: null, senior_approval_note: null,
    review_due_at: '2027-04-01', last_reviewed_at: iso(-45, 10),
    completed_at: iso(-45, 11), completed_by_membership_id: ddOmar,
    unable_reason: null,
    notes: 'The ultimate beneficial owners sit behind a trust and have not been provided.',
    superseded_by: null, superseded_at: null,
    created_by_membership_id: ddOmar, created_at: iso(-46, 9), updated_at: iso(-45, 11),
  });

  /*
    ── AL-FAJR CONTRACTING: ASKED TO ACT, AND THE FIRM COULD NOT IDENTIFY IT ──

    A client record exists — it is a counterparty on two of the firm's matters, and
    a firm that refused to record a counterparty because it could not identify it
    would have an evidence problem, not a compliance one. What does NOT exist is a
    matter of its own, and what DOES exist is a due-diligence record marked
    `unable_to_complete` with the ground written out.

    THE GROUND IS THE POINT. "Unable to complete" with no reason is an unexplained
    exit from an obligation, and the schema refuses it under ten characters. This
    one is the case the manual describes: the persons behind the company would not
    be named, so the lawyer may not act.
  */
  add('clients', {
    id: IDS.clientFajr, tenant_id: IDS.tenantKgm, client_type: 'organization',
    name: 'Al-Fajr Contracting Co.', name_ar: 'شركة الفجر للمقاولات',
    commercial_reg_masked: '******766', national_id_masked: null, national_id_hash: null,
    email: null, phone: null, address_line: null, city: 'Riyadh', country: 'SA',
    /*
      FALSE, AND A TRIGGER WOULD MAKE IT FALSE ANYWAY. `clients_identity_derived`
      derives this column from whether a complete due-diligence record exists, and
      for this client none does — so the row states the derived answer rather than
      asserting one. That is the whole point of the phase.
    */
    identity_verified: 0,
    verification_note: 'Instruction declined: customer due diligence could not be completed.',
    status: 'active', created_at: iso(-20, 9), updated_at: iso(-19, 11),
    party_id: IDS.partyFajr,
    relationship_ended_on: null,
  });
  add('client_due_diligence', {
    id: detId(`due_diligence:${IDS.clientFajr}`), tenant_id: IDS.tenantKgm,
    client_id: IDS.clientFajr, party_id: IDS.partyFajr, version: 1,
    cdd_level: 'standard', status: 'unable_to_complete',
    legal_name: 'Al-Fajr Contracting Company', legal_name_ar: 'شركة الفجر للمقاولات',
    date_of_birth: null, nationality: null, residence_country: 'SA',
    address: 'As recorded on the commercial registration.',
    id_type: 'commercial_registration', id_number_hash: keyedHash('demo-cr-1010887766'),
    id_number_masked: '******766', id_issued_at: null, id_expires_at: null,
    cr_number: '1010887766', cr_issued_at: null, incorporation_country: 'SA',
    business_activity: null, ownership_structure: 'Not provided.',
    source_of_funds: null, source_of_wealth: null, purpose: null,
    expected_annual_volume_sar: null,
    verification_method: null, verification_source: null,
    verified_by_membership_id: null, verified_at: null,
    pep_status: null, pep_details: null,
    risk_rating: null, risk_reasons: '[]', risk_assessed_at: null,
    senior_approved_by_membership_id: null, senior_approved_at: null, senior_approval_note: null,
    review_due_at: null, last_reviewed_at: null,
    completed_at: null, completed_by_membership_id: null,
    unable_reason: 'The client would not identify the persons who control it, and no ownership document was provided. Customer due diligence cannot be completed on these facts.',
    notes: 'Escalated to the compliance officer; the instruction was declined on that basis.',
    superseded_by: null, superseded_at: null,
    created_by_membership_id: ddOmar, created_at: iso(-20, 9), updated_at: iso(-19, 11),
  });

  const owners: Array<Record<string, unknown>> = [
    {
      id: detId('beneficial_owner:gulf:mohammed'),
      dd_id: ddGulf, client_id: IDS.clientGulf, party_id: null,
      owner_kind: 'natural_person', full_name: 'Mohammed Al-Harbi', full_name_ar: 'محمد الحربي',
      date_of_birth: '1974-11-03', nationality: 'SA', residence_country: 'SA',
      address: 'Al Rawdah District, Jeddah',
      id_type: 'national_id', id_number_hash: keyedHash('demo-owner-nid-4471'),
      id_number_masked: '********4471',
      cr_number: null, ownership_pct: 60, control_basis: 'ownership', control_description: null,
      pep_status: 'not_pep', is_designated: 0,
      source: 'Commercial registration extract and the shareholders register.',
      verification_method: 'certified_copy', verified_by_membership_id: ddOmar,
      verified_at: iso(-70, 10), notes: null,
    },
    {
      /*
        THE 25% HOLDER, AND THE PEP. Recorded at the threshold exactly: a rule that
        is strict (`> 25`) excludes her and one that is inclusive (`>= 25`) includes
        her. The manual is inclusive, so this row is the one that pins the operator.
      */
      id: detId('beneficial_owner:gulf:sara'),
      dd_id: ddGulf, client_id: IDS.clientGulf, party_id: null,
      owner_kind: 'natural_person', full_name: 'Sara bint Nasser Al-Dosari',
      full_name_ar: 'سارة بنت ناصر الدوسري',
      date_of_birth: '1986-04-19', nationality: 'SA', residence_country: 'SA',
      address: 'Al Malqa District, Riyadh',
      id_type: 'national_id', id_number_hash: keyedHash('demo-owner-nid-8863'),
      id_number_masked: '********8863',
      cr_number: null, ownership_pct: 25, control_basis: 'ownership', control_description: null,
      pep_status: 'pep_family', is_designated: 0,
      source: 'Commercial registration extract and the shareholders register.',
      verification_method: 'certified_copy', verified_by_membership_id: ddOmar,
      verified_at: iso(-70, 10),
      notes: 'PEP family determination — a close relative of a serving official.',
    },
    {
      /*
        BELOW THE THRESHOLD, AND NOT VERIFIED. Two deliberate negatives in one row:
        this holder is not a subject the gate screens, and the firm's failure to
        verify the holding must not be counted as an identified 15%. An
        implementation that sums `ownership_pct` without the `verified_at` filter
        reaches 100% here and passes a fixture it should fail.
      */
      id: detId('beneficial_owner:gulf:minority'),
      dd_id: ddGulf, client_id: IDS.clientGulf, party_id: null,
      owner_kind: 'natural_person', full_name: 'Khalid bin Omar Al-Zahrani',
      full_name_ar: 'خالد بن عمر الزهراني',
      date_of_birth: '1990-09-30', nationality: 'SA', residence_country: 'SA',
      address: 'Al Khobar North, Al Khobar',
      id_type: 'national_id', id_number_hash: keyedHash('demo-owner-nid-2210'),
      id_number_masked: '********2210',
      cr_number: null, ownership_pct: 15, control_basis: 'ownership', control_description: null,
      pep_status: null, is_designated: null,
      source: 'Commercial registration extract; not yet verified against the register.',
      verification_method: null, verified_by_membership_id: null, verified_at: null,
      notes: 'Below the 25% threshold. Recorded for completeness of the ownership picture.',
    },

    /*
      ── AL-NUKHBA: A COMPANY THAT OWNS ITSELF ────────────────────────────────

      One owner, a legal person, 100%. The chain does not terminate in a human
      being, and no control right is recorded either — a previous counsel is named
      in the file and nobody will say who instructs. This is the shape an
      "add up the percentages" rule accepts: 100 ≥ 25, so the client reads as
      identified and every subject in the relationship reads as screenable. There is
      no subject to screen, because a company is not searchable against a
      designation list in the same way a person is, and the firm may not act.
    */
    {
      id: detId('beneficial_owner:nukhba:nested'),
      dd_id: ddNukhba, client_id: IDS.clientNukhba, party_id: null,
      owner_kind: 'legal_person', full_name: 'Al-Nukhba Holdings (Jersey) Limited',
      full_name_ar: 'النخبة القابضة (جيرسي) المحدودة',
      date_of_birth: null, nationality: null, residence_country: null,
      address: 'St Helier, Jersey',
      id_type: null, id_number_hash: null, id_number_masked: null,
      cr_number: 'JE-118472', ownership_pct: 100, control_basis: 'ownership',
      control_description: null,
      pep_status: null, is_designated: null,
      source: 'Shareholders register supplied by the client.',
      verification_method: 'relying_on_third_party', verified_by_membership_id: ddOmar,
      verified_at: iso(-45, 10),
      notes: 'The parent is itself held through a trust. The ultimate owners have not been provided.',
    },

    /*
      ── QADIM: A COMPANY CONTROLLED BY SOMEONE WHO OWNS NOTHING ──────────────

      Zero shareholding and a control right: the founder holds a golden share and is
      the only person who signs. Under a pure percentage rule this client is
      unidentified and the firm may not act — wrongly, because the manual's own
      reason for the threshold is that control is what matters and shares are only
      the usual way of measuring it. The gate must admit this client, and this row is
      the only way to prove that it does.

      AND A CONTROL RIGHT HAS A DESCRIPTION, which the schema requires: "control",
      recorded as a word, is not a fact anybody can review.
    */
    {
      id: detId('beneficial_owner:qadim:founder'),
      dd_id: ddQadim, client_id: IDS.clientQadim, party_id: null,
      owner_kind: 'natural_person', full_name: 'Faisal bin Abdulrahman Al-Otaibi',
      full_name_ar: 'فيصل بن عبدالرحمن العتيبي',
      date_of_birth: '1963-01-22', nationality: 'SA', residence_country: 'SA',
      address: 'Al Yasmin District, Riyadh',
      id_type: 'national_id', id_number_hash: keyedHash('demo-owner-nid-5507'),
      id_number_masked: '********5507',
      cr_number: null, ownership_pct: null, control_basis: 'voting_rights',
      control_description: 'A golden share and the sole signature authority on the bank mandate.',
      pep_status: 'not_pep', is_designated: 0,
      source: 'Articles of association and the bank mandate.',
      verification_method: 'certified_copy', verified_by_membership_id: ddOmar,
      verified_at: iso(-40, 10), notes: null,
    },
  ];
  for (const owner of owners) {
    add('beneficial_owners', {
      tenant_id: IDS.tenantKgm, created_at: now, updated_at: now, ...owner,
    });
  }

  /*
    ── AHMED'S SCREENING ──────────────────────────────────────────────────────
    One run, cleared, against the internal register. `list_as_of` is the date of the
    list that was searched, not the date of the search: screening against a list
    eighteen months old is not screening, and the two dates are only the same date
    by coincidence.
  */
  const ahmedRunId = detId('screening_run:ahmed:client');
  add('screening_runs', {
    id: ahmedRunId, tenant_id: IDS.tenantKgm,
    dd_id: detId(`due_diligence:${IDS.clientAhmed}`), client_id: IDS.clientAhmed,
    subject_kind: 'client', subject_id: IDS.clientAhmed, subject_name: 'Ahmed bin Saud Al-Saud',
    list_sets: JSON.stringify(['un_consolidated', 'sama_designations', 'internal_register']),
    list_as_of: '2026-08-31', provider: 'internal_register',
    /*
      NOT 'clear' — A MATCH WAS FOUND AND RULED OUT.

      `matches_found` is 1 and the status is `potential_match`, because a run that
      found somebody with the same name and had it dispositioned by a person is not
      a run that found nothing, and recording it as clear would erase the decision.
      What makes this client admissible is not the absence of a hit but the presence
      of a disposition — which is the difference between screening and searching.

      The score is recorded because a fuzzy match without its score is a claim about
      similarity that nobody can check afterwards.
    */
    provider_reference: 'AML-2026-0417', status: 'potential_match', matches_found: 1,
    failure_reason: null, run_at: iso(-88, 10), run_by_membership_id: ddOmar,
    note: 'One candidate; ruled out against the date of birth and the national identification.',
    created_at: iso(-88, 10),
  });
  add('screening_matches', {
    id: detId('screening_match:ahmed:ruled-out'), tenant_id: IDS.tenantKgm,
    run_id: ahmedRunId, list_source: 'internal_register',
    matched_name: 'Ahmed Saud Al-Saud (listed 2016 — settled 2018)',
    matched_reference: 'INTERNAL-2016-0114',
    match_kind: 'fuzzy_name', score: 62.0,
    disposition: 'false_positive',
    disposition_reason: 'Different date of birth and a different national identification; the entry was closed in 2018.',
    disposition_by_membership_id: ddOmar, disposition_at: iso(-88, 11),
    created_at: iso(-88, 10),
  });

  /*
    ── GULF HORIZON'S SCREENING, AND THE RUN THAT FAILED ──────────────────────

    Three runs for this client, and the third is the one this fixture exists for.
    The company cleared and Mohammed cleared; the run against Sara — the 25% holder,
    the PEP — returned a provider failure and wrote `failed` with its reason on it.

    The temptation this refuses is a fixture where the failed run is simply ABSENT,
    because a missing run and a failed run look identical on any screen that reads
    "no matches". Keeping the row is what makes the difference legible.
  */
  const gulfClientRun = detId('screening_run:gulf:client');
  const gulfOwnerRun = detId('screening_run:gulf:owner-mohammed');
  const gulfOwnerFailedRun = detId('screening_run:gulf:owner-sara-failed');
  add('screening_runs', {
    id: gulfClientRun, tenant_id: IDS.tenantKgm, dd_id: ddGulf, client_id: IDS.clientGulf,
    subject_kind: 'client', subject_id: IDS.clientGulf,
    subject_name: 'Gulf Horizon Trading Company',
    list_sets: JSON.stringify(['un_consolidated', 'sama_designations', 'internal_register']),
    list_as_of: '2026-08-31', provider: 'internal_register',
    provider_reference: 'AML-2026-0418', status: 'clear', matches_found: 0,
    failure_reason: null, run_at: iso(-70, 10), run_by_membership_id: ddOmar, note: null,
    created_at: iso(-70, 10),
  });
  add('screening_runs', {
    id: gulfOwnerRun, tenant_id: IDS.tenantKgm, dd_id: ddGulf, client_id: IDS.clientGulf,
    subject_kind: 'beneficial_owner',
    subject_id: detId('beneficial_owner:gulf:mohammed'),
    subject_name: 'Mohammed Al-Harbi',
    list_sets: JSON.stringify(['un_consolidated', 'sama_designations', 'internal_register']),
    list_as_of: '2026-08-31', provider: 'internal_register',
    provider_reference: 'AML-2026-0419', status: 'clear', matches_found: 0,
    failure_reason: null, run_at: iso(-70, 10), run_by_membership_id: ddOmar, note: null,
    created_at: iso(-70, 10),
  });
  add('screening_runs', {
    id: gulfOwnerFailedRun, tenant_id: IDS.tenantKgm, dd_id: ddGulf, client_id: IDS.clientGulf,
    subject_kind: 'beneficial_owner',
    subject_id: detId('beneficial_owner:gulf:sara'),
    subject_name: 'Sara bint Nasser Al-Dosari',
    list_sets: JSON.stringify(['un_consolidated', 'sama_designations']),
    list_as_of: '2026-08-31', provider: 'external_provider',
    provider_reference: 'REF-8842-TIMEOUT', status: 'failed', matches_found: 0,
    failure_reason: 'The screening provider did not respond within the configured timeout.',
    run_at: iso(-70, 10), run_by_membership_id: ddOmar,
    note: 'Re-run required. Recorded as a failure rather than left absent.',
    created_at: iso(-70, 10),
  });

  /*
    ── QADIM'S SCREENING, CLEARED ─────────────────────────────────────────────
    A control-right holder is a subject too — the reason the owner exists in the
    register is that the firm has to know who instructs, and knowing who instructs
    and not screening them is the gap this run closes.
  */
  /*
    BOTH SUBJECTS, AND THE FIRST DRAFT OF THIS FIXTURE HAD ONLY ONE.

    It screened the control-right holder and not the company, and the gate refused:
    `screening_incomplete`. The client is a subject in its own right — the company
    that owns nothing is still the company the firm is acting for — so a fixture that
    screens the interesting person and forgets the obvious one produces a client that
    cannot be admitted for a reason the file does not show. The gate was right.
  */
  add('screening_runs', {
    id: detId('screening_run:qadim:client'), tenant_id: IDS.tenantKgm, dd_id: ddQadim,
    client_id: IDS.clientQadim, subject_kind: 'client', subject_id: IDS.clientQadim,
    subject_name: 'Qadim Logistics Company',
    list_sets: JSON.stringify(['un_consolidated', 'sama_designations', 'internal_register']),
    list_as_of: '2026-08-31', provider: 'internal_register',
    provider_reference: 'AML-2026-0420', status: 'clear', matches_found: 0,
    failure_reason: null, run_at: iso(-40, 10), run_by_membership_id: ddOmar, note: null,
    created_at: iso(-40, 10),
  });
  add('screening_runs', {
    id: detId('screening_run:qadim:owner'), tenant_id: IDS.tenantKgm, dd_id: ddQadim,
    client_id: IDS.clientQadim, subject_kind: 'beneficial_owner',
    subject_id: detId('beneficial_owner:qadim:founder'),
    subject_name: 'Faisal bin Abdulrahman Al-Otaibi',
    list_sets: JSON.stringify(['un_consolidated', 'sama_designations', 'internal_register']),
    list_as_of: '2026-08-31', provider: 'internal_register',
    provider_reference: 'AML-2026-0421', status: 'clear', matches_found: 0,
    failure_reason: null, run_at: iso(-40, 10), run_by_membership_id: ddOmar, note: null,
    created_at: iso(-40, 10),
  });

  /*
    ── AND A HIT SOMEBODY HAS TO DECIDE ABOUT ─────────────────────────────────

    A fuzzy match between Qadim's client name and an entry on the internal register,
    left OPEN. This is what an unresolved screening looks like in the register, and
    it is the second refusal the gate has to make: a client whose file is otherwise
    finished but against whom a name hit nobody has ruled out. The hit is on the
    CLIENT subject, so the client's own clearance is the one that is withheld.

    `score` is recorded because a fuzzy match without its score is a claim about
    similarity that cannot be checked.
  */
  const nukhbaRunId = detId('screening_run:nukhba:client');
  add('screening_runs', {
    id: nukhbaRunId, tenant_id: IDS.tenantKgm, dd_id: ddNukhba,
    client_id: IDS.clientNukhba, subject_kind: 'client', subject_id: IDS.clientNukhba,
    subject_name: 'Al-Nukhba Trading Establishment',
    list_sets: JSON.stringify(['un_consolidated', 'sama_designations', 'internal_register']),
    list_as_of: '2026-08-31', provider: 'internal_register',
    provider_reference: 'AML-2026-0422', status: 'potential_match', matches_found: 1,
    failure_reason: null, run_at: iso(-45, 10), run_by_membership_id: ddOmar, note: null,
    created_at: iso(-45, 10),
  });
  add('screening_matches', {
    id: detId('screening_match:nukhba:open'), tenant_id: IDS.tenantKgm,
    run_id: nukhbaRunId,
    list_source: 'internal_register',
    matched_name: 'Faisal Abdulrahman Al-Otaibi (listed 2019 — settled)',
    matched_reference: 'INTERNAL-2019-0033',
    match_kind: 'fuzzy_name', score: 87.5,
    disposition: 'open', disposition_reason: null,
    disposition_by_membership_id: null, disposition_at: null,
    created_at: iso(-40, 10),
  });

  /*
    ── ONE REPORT, FILED ──────────────────────────────────────────────────────
    Against Gulf Horizon's failed screening, because that is how the two records
    connect in real life: a screening that cannot be completed is a question, and
    the answer to a question about a client's funds is sometimes a report.

    The narrative is Arabic — the schema, the trigger and the domain check all
    insist on it — and the report is FILED, which means it carries the moment, the
    member, the authority's reference and the acknowledgement that the client was
    not told. `tipping_off_acknowledged_at` is not ceremony: tipping off is its own
    offence under the same law.
  */
  add('str_reports', {
    id: detId('str_report:gulf:2026-0007'), tenant_id: IDS.tenantKgm,
    report_number: 'STR-2026-0007',
    subject_kind: 'client', subject_id: IDS.clientGulf, subject_name: 'Gulf Horizon Trading Company',
    client_id: IDS.clientGulf, matter_id: IDS.matterGulf,
    grounds: JSON.stringify(['third_party_funding', 'reluctant_identification']),
    narrative_ar: 'وردت أتعاب ملف الاستحواذ من حساب بنكي باسم طرف ثالث لا تربطه بالعميل علاقة ظاهرة، '
      + 'وقد طُلب أكثر من مرة مستند يوضح مصدر الأموال فلم يُقدَّم. كما لم يُقدَّم بيان بالمالك الحقيقي '
      + 'الأخير للشركة الأم. وقد أُرسل التقرير إلى وحدة التحريات المالية في المملكة.',
    narrative_en: null,
    amount_sar: 40_000, currency: 'SAR',
    transaction_reference: 'IBAN transfer ref 90114',
    transaction_at: iso(-24, 14),
    status: 'filed',
    prepared_by_membership_id: ddOmar, prepared_at: iso(-24, 10),
    reviewed_by_membership_id: ddNoura, reviewed_at: iso(-24, 12),
    filed_by_membership_id: ddOmar, filed_at: iso(-23, 9),
    /* Three working days from preparation: Friday and Saturday do not count. */
    filed_due_at: iso(-21, 10),
    fiu_reference: 'SAFIU-2026-118420',
    fiu_response: null, fiu_responded_at: null,
    tipping_off_acknowledged_at: iso(-23, 9), tipping_off_acknowledged_by_membership_id: ddOmar,
    closure_reason: null, closed_at: null,
    created_by_membership_id: ddOmar, created_at: iso(-24, 10), updated_at: iso(-23, 9),
  });

  return rows;
}