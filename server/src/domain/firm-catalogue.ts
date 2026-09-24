/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source of truth: supabase/migrations/0006_firm_rbac.sql
 * Regenerate:      npx tsx server/scripts/gen-firm-catalogue.ts
 *
 * The permission catalogue and the nine system role templates are defined once,
 * in SQL, and lifted into TypeScript here so that the demo seed, the resolver and
 * the Postgres migration can never disagree about what a role is allowed to do.
 * tests/security/firm-rbac.test.ts re-parses the migration and fails on drift.
 */

export type PermissionSensitivity = 'normal' | 'elevated' | 'critical';

export interface PermissionDef {
  readonly code: string;
  readonly module: string;
  readonly description: string;
  readonly descriptionAr: string;
  readonly sensitivity: PermissionSensitivity;
}

export interface RoleTemplateDef {
  /** Stable id shared by every tenant copy of this template. */
  readonly templateId: string;
  readonly code: string;
  readonly name: string;
  readonly nameAr: string;
  readonly description: string;
}

/** 69 permission codes across 7 modules. */
export const PERMISSIONS: readonly PermissionDef[] = [
  { code: "clients.read", module: "clients", description: "View client records",
    descriptionAr: "عرض سجلات العملاء", sensitivity: "normal" },
  { code: "clients.create", module: "clients", description: "Create a client",
    descriptionAr: "إنشاء عميل", sensitivity: "normal" },
  { code: "clients.update", module: "clients", description: "Edit client records",
    descriptionAr: "تعديل سجلات العملاء", sensitivity: "normal" },
  { code: "clients.archive", module: "clients", description: "Archive a client",
    descriptionAr: "أرشفة عميل", sensitivity: "elevated" },
  { code: "clients.read_sensitive", module: "clients", description: "View unmasked national identifiers",
    descriptionAr: "عرض معرفات الهوية غير المقنّعة", sensitivity: "critical" },
  { code: "clients.kyc", module: "clients", description: "Perform KYC/AML review",
    descriptionAr: "إجراء مراجعة اعرف عميلك", sensitivity: "elevated" },
  { code: "matters.read", module: "matters", description: "View assigned matters",
    descriptionAr: "عرض القضايا المسندة", sensitivity: "normal" },
  { code: "matters.read_all", module: "matters", description: "View matters outside practice-area scope",
    descriptionAr: "عرض القضايا خارج نطاق الممارسة", sensitivity: "elevated" },
  { code: "matters.create", module: "matters", description: "Create a matter",
    descriptionAr: "إنشاء قضية", sensitivity: "normal" },
  { code: "matters.update", module: "matters", description: "Edit matter details",
    descriptionAr: "تعديل بيانات القضية", sensitivity: "normal" },
  { code: "matters.assign", module: "matters", description: "Assign and remove matter team members",
    descriptionAr: "إسناد أعضاء فريق القضية", sensitivity: "elevated" },
  { code: "matters.restrict", module: "matters", description: "Restrict or unrestrict a matter",
    descriptionAr: "تقييد قضية أو رفع القيد", sensitivity: "critical" },
  { code: "matters.close", module: "matters", description: "Close a matter",
    descriptionAr: "إغلاق القضية", sensitivity: "elevated" },
  { code: "matters.reopen", module: "matters", description: "Reopen a closed matter",
    descriptionAr: "إعادة فتح قضية مغلقة", sensitivity: "elevated" },
  { code: "matters.status", module: "matters", description: "Advance the matter state machine",
    descriptionAr: "تحريك حالة القضية", sensitivity: "normal" },
  { code: "documents.read", module: "documents", description: "View documents on assigned matters",
    descriptionAr: "عرض مستندات القضايا المسندة", sensitivity: "normal" },
  { code: "documents.create", module: "documents", description: "Upload and draft documents",
    descriptionAr: "رفع المستندات وإنشاء المسودات", sensitivity: "normal" },
  { code: "documents.edit", module: "documents", description: "Edit document content",
    descriptionAr: "تعديل محتوى المستند", sensitivity: "normal" },
  { code: "documents.delete", module: "documents", description: "Delete an unapproved document version",
    descriptionAr: "حذف إصدار مستند غير معتمد", sensitivity: "elevated" },
  { code: "documents.approve", module: "documents", description: "Approve a document version",
    descriptionAr: "اعتماد إصدار المستند", sensitivity: "elevated" },
  { code: "documents.release", module: "documents", description: "Release a document to the client portal",
    descriptionAr: "نشر المستند إلى بوابة العميل", sensitivity: "elevated" },
  { code: "documents.templates", module: "documents", description: "Manage document templates",
    descriptionAr: "إدارة قوالب المستندات", sensitivity: "elevated" },
  { code: "tasks.read", module: "operations", description: "View tasks",
    descriptionAr: "عرض المهام", sensitivity: "normal" },
  { code: "tasks.manage", module: "operations", description: "Create, assign and close tasks",
    descriptionAr: "إنشاء المهام وإسنادها وإغلاقها", sensitivity: "normal" },
  { code: "hearings.read", module: "operations", description: "View hearings",
    descriptionAr: "عرض الجلسات", sensitivity: "normal" },
  { code: "hearings.manage", module: "operations", description: "Create and update hearings",
    descriptionAr: "إنشاء الجلسات وتحديثها", sensitivity: "normal" },
  { code: "deadlines.read", module: "operations", description: "View deadlines",
    descriptionAr: "عرض المواعيد النهائية", sensitivity: "normal" },
  { code: "deadlines.manage", module: "operations", description: "Create and update deadlines",
    descriptionAr: "إنشاء المواعيد النهائية وتحديثها", sensitivity: "normal" },
  { code: "contracts.read", module: "operations", description: "View engagement contracts",
    descriptionAr: "عرض عقود الأتعاب", sensitivity: "normal" },
  { code: "contracts.manage", module: "operations", description: "Create and amend engagement contracts",
    descriptionAr: "إنشاء عقود الأتعاب وتعديلها", sensitivity: "elevated" },
  { code: "poa.read", module: "operations", description: "View powers of attorney",
    descriptionAr: "عرض الوكالات", sensitivity: "normal" },
  { code: "poa.manage", module: "operations", description: "Record and amend powers of attorney",
    descriptionAr: "تسجيل الوكالات وتعديلها", sensitivity: "elevated" },
  { code: "billing.read", module: "finance", description: "View invoices and billing data",
    descriptionAr: "عرض الفواتير وبيانات الفوترة", sensitivity: "normal" },
  { code: "billing.read_all", module: "finance", description: "View billing outside practice-area scope",
    descriptionAr: "عرض الفوترة خارج نطاق الممارسة", sensitivity: "elevated" },
  { code: "billing.create", module: "finance", description: "Draft invoices",
    descriptionAr: "إنشاء مسودات الفواتير", sensitivity: "normal" },
  { code: "billing.edit", module: "finance", description: "Edit draft invoices",
    descriptionAr: "تعديل مسودات الفواتير", sensitivity: "normal" },
  { code: "billing.approve", module: "finance", description: "Approve an invoice for sending",
    descriptionAr: "اعتماد الفاتورة للإرسال", sensitivity: "elevated" },
  { code: "billing.send", module: "finance", description: "Send an approved invoice to a client",
    descriptionAr: "إرسال فاتورة معتمدة إلى العميل", sensitivity: "elevated" },
  { code: "billing.record_payment", module: "finance", description: "Record a payment from a verified source",
    descriptionAr: "تسجيل دفعة من مصدر موثّق", sensitivity: "elevated" },
  { code: "billing.writeoff", module: "finance", description: "Write off a balance",
    descriptionAr: "إعدام رصيد", sensitivity: "critical" },
  { code: "billing.discount", module: "finance", description: "Apply a discount",
    descriptionAr: "تطبيق خصم", sensitivity: "elevated" },
  { code: "time.read", module: "finance", description: "View time entries",
    descriptionAr: "عرض قيود الوقت", sensitivity: "normal" },
  { code: "time.create", module: "finance", description: "Record own time",
    descriptionAr: "تسجيل الوقت الشخصي", sensitivity: "normal" },
  { code: "time.adjust", module: "finance", description: "Adjust or void time entries",
    descriptionAr: "تعديل أو إبطال قيود الوقت", sensitivity: "elevated" },
  { code: "expenses.read", module: "finance", description: "View expenses",
    descriptionAr: "عرض المصروفات", sensitivity: "normal" },
  { code: "expenses.create", module: "finance", description: "Submit own expenses",
    descriptionAr: "تقديم المصروفات الشخصية", sensitivity: "normal" },
  { code: "expenses.approve", module: "finance", description: "Approve expenses",
    descriptionAr: "اعتماد المصروفات", sensitivity: "elevated" },
  { code: "compliance.read", module: "compliance", description: "View compliance records",
    descriptionAr: "عرض سجلات الامتثال", sensitivity: "elevated" },
  { code: "compliance.create", module: "compliance", description: "Open conflict checks and reviews",
    descriptionAr: "فتح فحوص التعارض والمراجعات", sensitivity: "elevated" },
  { code: "compliance.review", module: "compliance", description: "Review KYC, AML and conflicts",
    descriptionAr: "مراجعة اعرف عميلك وغسل الأموال والتعارضات", sensitivity: "elevated" },
  { code: "compliance.approve", module: "compliance", description: "Clear or escalate a compliance item",
    descriptionAr: "اعتماد أو تصعيد بند امتثال", sensitivity: "critical" },
  { code: "compliance.licences", module: "compliance", description: "Manage lawyer licences",
    descriptionAr: "إدارة تراخيص المحاماة", sensitivity: "elevated" },
  { code: "compliance.training", module: "compliance", description: "Manage CLE and training records",
    descriptionAr: "إدارة سجلات التدريب", sensitivity: "normal" },
  { code: "compliance.complaints", module: "compliance", description: "Manage complaints",
    descriptionAr: "إدارة الشكاوى", sensitivity: "critical" },
  { code: "users.read", module: "admin", description: "View firm members",
    descriptionAr: "عرض أعضاء المكتب", sensitivity: "elevated" },
  { code: "users.invite", module: "admin", description: "Invite a firm member",
    descriptionAr: "دعوة عضو إلى المكتب", sensitivity: "critical" },
  { code: "users.update", module: "admin", description: "Edit a member record",
    descriptionAr: "تعديل سجل عضو", sensitivity: "elevated" },
  { code: "users.deactivate", module: "admin", description: "Suspend or deactivate a member",
    descriptionAr: "تعليق أو إلغاء تفعيل عضو", sensitivity: "critical" },
  { code: "users.assign_role", module: "admin", description: "Grant or revoke a role",
    descriptionAr: "منح دور أو سحبه", sensitivity: "critical" },
  { code: "users.assign_matter", module: "admin", description: "Grant or revoke matter access",
    descriptionAr: "منح صلاحية قضية أو سحبها", sensitivity: "critical" },
  { code: "users.revoke_session", module: "admin", description: "Revoke another member session",
    descriptionAr: "إنهاء جلسة عضو آخر", sensitivity: "critical" },
  { code: "roles.read", module: "admin", description: "View roles and permissions",
    descriptionAr: "عرض الأدوار والصلاحيات", sensitivity: "elevated" },
  { code: "roles.manage", module: "admin", description: "Create and edit roles",
    descriptionAr: "إنشاء الأدوار وتعديلها", sensitivity: "critical" },
  { code: "departments.manage", module: "admin", description: "Manage departments and membership",
    descriptionAr: "إدارة الأقسام والعضوية", sensitivity: "elevated" },
  { code: "settings.read", module: "admin", description: "View firm settings",
    descriptionAr: "عرض إعدادات المكتب", sensitivity: "elevated" },
  { code: "settings.manage", module: "admin", description: "Change firm settings",
    descriptionAr: "تغيير إعدادات المكتب", sensitivity: "critical" },
  { code: "audit.read", module: "admin", description: "Search the audit log",
    descriptionAr: "البحث في سجل التدقيق", sensitivity: "critical" },
  { code: "audit.export", module: "admin", description: "Export the audit log",
    descriptionAr: "تصدير سجل التدقيق", sensitivity: "critical" },
  { code: "analytics.read", module: "admin", description: "View firm analytics and risk centre",
    descriptionAr: "عرض التحليلات ومركز المخاطر", sensitivity: "elevated" },
] as const;

/** The 9 system role templates (§7, §9-§16). tenant_id is NULL in SQL; a tenant gets its own copy on first boot. */
export const ROLE_TEMPLATES: readonly RoleTemplateDef[] = [
  { templateId: "00000000-0000-4000-8000-0000000000a1", code: "MANAGING_PARTNER", name: "Managing Partner",
    nameAr: "الشريك الإداري", description: "Highest normal business authority (§9). Cannot bypass technical controls or edit audit history." },
  { templateId: "00000000-0000-4000-8000-0000000000a2", code: "PARTNER", name: "Partner",
    nameAr: "شريك", description: "Partner authority, scoped by department, practice group and financial ceiling (§10)." },
  { templateId: "00000000-0000-4000-8000-0000000000a3", code: "LAWYER", name: "Lawyer",
    nameAr: "محامٍ", description: "Operational access through assigned matters (§11)." },
  { templateId: "00000000-0000-4000-8000-0000000000a4", code: "ASSOCIATE", name: "Associate",
    nameAr: "محامٍ مشارك", description: "Prepares work; controlled actions need approval (§12)." },
  { templateId: "00000000-0000-4000-8000-0000000000a5", code: "PARALEGAL", name: "Paralegal",
    nameAr: "مساعد قانوني", description: "Matter preparation and operations; no administration or financial state (§13)." },
  { templateId: "00000000-0000-4000-8000-0000000000a6", code: "FINANCE", name: "Finance",
    nameAr: "المالية", description: "Financial operating layer; no legal strategy or conflict material (§14)." },
  { templateId: "00000000-0000-4000-8000-0000000000a7", code: "COMPLIANCE", name: "Compliance",
    nameAr: "الامتثال", description: "Compliance workspace with restricted-by-design access (§15)." },
  { templateId: "00000000-0000-4000-8000-0000000000a8", code: "ADMIN", name: "Administration",
    nameAr: "الإدارة", description: "Operating environment; no financial approval or compliance decisions (§16)." },
  { templateId: "00000000-0000-4000-8000-0000000000a9", code: "OPERATIONS", name: "Operations",
    nameAr: "العمليات", description: "Cross-cutting operational support." },
] as const;

/**
 * Template code -> permission codes. Written out explicitly rather than
 * derived, so "what can a PARALEGAL do?" is answerable by reading this file.
 * The restrictions in §13-§16 are visible here as absent entries.
 */
export const TEMPLATE_GRANTS: Readonly<Record<string, readonly string[]>> = {
  "MANAGING_PARTNER": [
    "clients.read", "clients.create", "clients.update", "clients.archive",
    "clients.read_sensitive", "clients.kyc", "matters.read", "matters.read_all",
    "matters.create", "matters.update", "matters.assign", "matters.restrict",
    "matters.close", "matters.reopen", "matters.status", "documents.read",
    "documents.create", "documents.edit", "documents.delete", "documents.approve",
    "documents.release", "documents.templates", "tasks.read", "tasks.manage",
    "hearings.read", "hearings.manage", "deadlines.read", "deadlines.manage",
    "contracts.read", "contracts.manage", "poa.read", "poa.manage",
    "billing.read", "billing.read_all", "billing.create", "billing.edit",
    "billing.approve", "billing.send", "billing.record_payment", "billing.writeoff",
    "billing.discount", "time.read", "time.create", "time.adjust",
    "expenses.read", "expenses.create", "expenses.approve", "compliance.read",
    "compliance.create", "compliance.review", "compliance.approve", "compliance.licences",
    "compliance.training", "compliance.complaints", "users.read", "users.invite",
    "users.update", "users.deactivate", "users.assign_role", "users.assign_matter",
    "users.revoke_session", "roles.read", "roles.manage", "departments.manage",
    "settings.read", "settings.manage", "audit.read", "audit.export",
    "analytics.read",
  ],
  "PARTNER": [
    "clients.read", "clients.create", "clients.update", "clients.read_sensitive",
    "clients.kyc", "matters.read", "matters.create", "matters.update",
    "matters.assign", "matters.restrict", "matters.close", "matters.reopen",
    "matters.status", "documents.read", "documents.create", "documents.edit",
    "documents.approve", "documents.release", "documents.templates", "tasks.read",
    "tasks.manage", "hearings.read", "hearings.manage", "deadlines.read",
    "deadlines.manage", "contracts.read", "contracts.manage", "poa.read",
    "poa.manage", "billing.read", "billing.create", "billing.edit",
    "billing.approve", "billing.send", "billing.record_payment", "billing.discount",
    "time.read", "time.create", "time.adjust", "expenses.read",
    "expenses.create", "expenses.approve", "compliance.read", "compliance.review",
    "users.read", "users.assign_matter", "roles.read", "settings.read",
    "analytics.read",
  ],
  "LAWYER": [
    "clients.read", "matters.read", "matters.update", "matters.status",
    "documents.read", "documents.create", "documents.edit", "tasks.read",
    "tasks.manage", "hearings.read", "hearings.manage", "deadlines.read",
    "deadlines.manage", "contracts.read", "poa.read", "time.read",
    "time.create", "expenses.read", "expenses.create",
  ],
  "ASSOCIATE": [
    "clients.read", "matters.read", "matters.update", "documents.read",
    "documents.create", "documents.edit", "tasks.read", "tasks.manage",
    "hearings.read", "deadlines.read", "deadlines.manage", "contracts.read",
    "time.read", "time.create", "expenses.read", "expenses.create",
  ],
  "PARALEGAL": [
    "clients.read", "clients.create", "matters.read", "matters.update",
    "documents.read", "documents.create", "documents.edit", "tasks.read",
    "tasks.manage", "hearings.read", "hearings.manage", "deadlines.read",
    "deadlines.manage", "poa.read", "time.read", "time.create",
    "expenses.read", "expenses.create",
  ],
  "FINANCE": [
    "billing.read", "billing.read_all", "billing.create", "billing.edit",
    "billing.send", "billing.record_payment", "billing.discount", "time.read",
    "time.adjust", "expenses.read", "expenses.approve", "clients.read",
    "matters.read", "matters.read_all", "analytics.read",
  ],
  "COMPLIANCE": [
    "clients.read", "clients.read_sensitive", "clients.kyc", "matters.read",
    "compliance.read", "compliance.create", "compliance.review", "compliance.approve",
    "compliance.licences", "compliance.training", "compliance.complaints", "documents.read",
    "poa.read", "audit.read",
  ],
  "ADMIN": [
    "users.read", "users.invite", "users.update", "users.deactivate",
    "users.assign_role", "users.assign_matter", "users.revoke_session", "roles.read",
    "departments.manage", "settings.read", "settings.manage", "clients.read",
    "matters.read", "tasks.read", "hearings.read", "deadlines.read",
  ],
  "OPERATIONS": [
    "tasks.read", "tasks.manage", "hearings.read", "hearings.manage",
    "deadlines.read", "deadlines.manage", "clients.read", "matters.read",
    "documents.read", "analytics.read",
  ],
};

export type PermissionCode = (typeof PERMISSIONS)[number]["code"];
export type SystemRoleCode = keyof typeof TEMPLATE_GRANTS;
