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

/**
 * Deterministic UUID derived from a stable label.
 *
 * Every seeded row must survive a restart without duplicating: the demo
 * dataset has natural unique keys (tenant_id + code, matter_id + staff_id, ...)
 * that would silently swallow a re-insert while leaving a random surrogate id
 * dangling. Deriving ids from labels makes the whole seed idempotent.
 */
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
  // Firm OS identities. A firm member is a `users` row plus a `firm_memberships`
  // row; the two audiences never share an authorization surface (§6).
  userNoura: 'dddddddd-0000-4000-8000-000000000011',
  userFaisal: 'dddddddd-0000-4000-8000-000000000012',
  userMariam: 'dddddddd-0000-4000-8000-000000000013',
  userOmar: 'dddddddd-0000-4000-8000-000000000014',
  userSara: 'dddddddd-0000-4000-8000-000000000015',
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
  add('clients', {
    id: IDS.clientAhmed, tenant_id: IDS.tenantKgm, client_type: 'individual',
    name: 'Ahmed Al-Saud', name_ar: 'أحمد السعود',
    national_id_masked: '********1234', national_id_hash: keyedHash('demo-nid-1234'),
    email: 'ahmed.alsaud@example.test', phone: '+966 5X XXX 1234',
    address_line: 'King Fahd Road, Al Olaya', city: 'Riyadh', country: 'SA',
    identity_verified: 1, verification_note: 'Verified via Absher integration (demo)',
    status: 'active', created_at: now, updated_at: now,
  });
  add('clients', {
    id: IDS.clientGulf, tenant_id: IDS.tenantKgm, client_type: 'organization',
    name: 'Gulf Horizon Trading Co.', name_ar: 'شركة الأفق التجاري',
    commercial_reg_masked: '******789', national_id_masked: null, national_id_hash: null,
    email: 'finance@gulfhorizon.example.test', phone: '+966 1X XXX 5678',
    address_line: 'Corniche Road, Al Shatea', city: 'Jeddah', country: 'SA',
    identity_verified: 1, verification_note: 'CR verified (demo)',
    status: 'active', created_at: now, updated_at: now,
  });
  add('clients', {
    id: IDS.clientLayla, tenant_id: IDS.tenantNajd, client_type: 'individual',
    name: 'Layla Mansour', name_ar: 'ليلى منصور',
    national_id_masked: '********5678', national_id_hash: keyedHash('demo-nid-5678'),
    email: 'layla.mansour@example.test', phone: '+966 5X XXX 9012',
    address_line: 'Prince Sultan Road', city: 'Khobar', country: 'SA',
    identity_verified: 0, verification_note: null,
    status: 'active', created_at: now, updated_at: now,
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
      risk: 'high', conflict: 1, notes: 'INTERNAL: partner to approve settlement posture before next session.',
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
      risk: 'medium', conflict: 1, notes: 'INTERNAL: awaiting conflict clearance on counterparty.',
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
      risk: 'low', conflict: 0, notes: 'INTERNAL: conflict check in progress — do not contact client yet.',
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
      risk: 'medium', conflict: 1, notes: 'INTERNAL: other firm, other tenant.',
    },
  ];
  for (const m of matters) {
    add('matters', {
      id: m.id, tenant_id: m.tenant, client_id: m.client, matter_number: m.number,
      case_number: m.caseNo, title: m.title, title_ar: m.titleAr,
      practice_area: m.area, practice_area_ar: m.areaAr, court: m.court, court_ar: m.courtAr,
      internal_status: m.internal, client_status: m.clientStatus,
      summary: m.summary, summary_ar: m.summaryAr,
      opened_at: iso(m.opened), closed_at: null, last_client_update_at: iso(m.lastUpdate, 11),
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
  for (const inv of invoices) {
    const vat = Math.round(inv.sub * 0.15 * 100) / 100;
    const total = Math.round((inv.sub + vat) * 100) / 100;
    // A settled invoice is settled for the VAT-INCLUSIVE total; `inv.paid`
    // holds the part-payment figure for the partially paid one.
    const paid = inv.internal === 'paid' ? total : inv.paid;
    add('invoices', {
      id: inv.id, tenant_id: inv.tenant, client_id: inv.client, matter_id: inv.matter,
      invoice_number: inv.number, issue_date: date(inv.issue), due_date: date(inv.due),
      currency: 'SAR', subtotal: inv.sub, vat_rate: 0.15, vat_amount: vat, total,
      amount_paid: paid, internal_status: inv.internal,
      client_status: derive(inv.internal, paid, total, date(inv.due)),
      storage_key: `${inv.tenant}/${inv.client}/financial/${inv.id}/invoice.pdf`,
      approved_by_staff: inv.internal === 'pending_internal_approval' ? null : staff[4].id,
      approved_at: inv.internal === 'pending_internal_approval' ? null : now,
      notes_internal: inv.internal === 'pending_internal_approval'
        ? 'INTERNAL: awaiting partner sign-off. Do NOT release.' : null,
      created_at: now, updated_at: now,
    });
    inv.lines.forEach((l, i) => {
      const [desc, descAr, qty, unit] = l as [string, string, number, number];
      add('invoice_lines', {
        id: detId(`invoice_line:${inv.id}:${i + 1}`), invoice_id: inv.id, position: i + 1, description: desc,
        description_ar: descAr, quantity: qty, unit_price: unit, amount: qty * unit,
      });
    });
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
  const firmPeople = [
    { userId: IDS.userNoura,  staffId: staff[0].id, email: 'noura@kgm.example.test',
      template: 'MANAGING_PARTNER', department: 'LEGAL', isDeptLead: 1,
      title: 'Managing Partner', titleAr: 'الشريكة الإدارية',
      practiceAreas: ['*'],
      financial: 500000, writeoff: 100000, discount: 25, language: 'ar' },
    { userId: IDS.userFaisal, staffId: staff[1].id, email: 'faisal@kgm.example.test',
      template: 'LAWYER', department: 'LEGAL', isDeptLead: 0,
      title: 'Senior Associate', titleAr: 'محامٍ أول',
      practiceAreas: ['Commercial Litigation', 'Real Estate'],
      // NULL, not 0: a lawyer holds no financial authority at all, and the
      // resolver must read that as "refuse", never as "unlimited" (§10).
      financial: null, writeoff: null, discount: null, language: 'ar' },
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
        is_system: 1, is_active: 1, created_at: now, updated_at: now,
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

  return rows;
}
