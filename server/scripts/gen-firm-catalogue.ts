/**
 * Generates `server/src/domain/firm-catalogue.ts` from the Postgres migration.
 *
 * Run with:  npx tsx server/scripts/gen-firm-catalogue.ts
 *
 * The migration is the source of truth for the authorization contract. This
 * script exists so the TypeScript side cannot drift from it by accident — and
 * tests/security/firm-rbac.test.ts fails if someone edits the SQL and forgets
 * to regenerate.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFirmCatalogueFile } from '../src/domain/parse-firm-catalogue.js';

const MIGRATION = resolve('supabase/migrations/0006_firm_rbac.sql');
const OUT = resolve('server/src/domain/firm-catalogue.ts');

const c = parseFirmCatalogueFile(MIGRATION);

const q = (s: string) => JSON.stringify(s);

const lines: string[] = [];
lines.push('/**');
lines.push(' * GENERATED FILE — DO NOT EDIT BY HAND.');
lines.push(' *');
lines.push(' * Source of truth: supabase/migrations/0006_firm_rbac.sql');
lines.push(' * Regenerate:      npx tsx server/scripts/gen-firm-catalogue.ts');
lines.push(' *');
lines.push(' * The permission catalogue and the nine system role templates are defined once,');
lines.push(' * in SQL, and lifted into TypeScript here so that the demo seed, the resolver and');
lines.push(' * the Postgres migration can never disagree about what a role is allowed to do.');
lines.push(' * tests/security/firm-rbac.test.ts re-parses the migration and fails on drift.');
lines.push(' */');
lines.push('');
lines.push("export type PermissionSensitivity = 'normal' | 'elevated' | 'critical';");
lines.push('');
lines.push('export interface PermissionDef {');
lines.push('  readonly code: string;');
lines.push('  readonly module: string;');
lines.push('  readonly description: string;');
lines.push('  readonly descriptionAr: string;');
lines.push('  readonly sensitivity: PermissionSensitivity;');
lines.push('}');
lines.push('');
lines.push('export interface RoleTemplateDef {');
lines.push('  /** Stable id shared by every tenant copy of this template. */');
lines.push('  readonly templateId: string;');
lines.push('  readonly code: string;');
lines.push('  readonly name: string;');
lines.push('  readonly nameAr: string;');
lines.push('  readonly description: string;');
lines.push('}');
lines.push('');
lines.push(`/** ${c.permissions.length} permission codes across ${new Set(c.permissions.map((p) => p.module)).size} modules. */`);
lines.push('export const PERMISSIONS: readonly PermissionDef[] = [');
for (const p of c.permissions) {
  lines.push(`  { code: ${q(p.code)}, module: ${q(p.module)}, description: ${q(p.description)},`);
  lines.push(`    descriptionAr: ${q(p.descriptionAr)}, sensitivity: ${q(p.sensitivity)} },`);
}
lines.push('] as const;');
lines.push('');
lines.push(`/** The ${c.roleTemplates.length} system role templates (§7, §9-§16). tenant_id is NULL in SQL; a tenant gets its own copy on first boot. */`);
lines.push('export const ROLE_TEMPLATES: readonly RoleTemplateDef[] = [');
for (const r of c.roleTemplates) {
  lines.push(`  { templateId: ${q(r.templateId)}, code: ${q(r.code)}, name: ${q(r.name)},`);
  lines.push(`    nameAr: ${q(r.nameAr)}, description: ${q(r.description)} },`);
}
lines.push('] as const;');
lines.push('');
lines.push('/**');
lines.push(' * Template code -> permission codes. Written out explicitly rather than');
lines.push(' * derived, so "what can a PARALEGAL do?" is answerable by reading this file.');
lines.push(' * The restrictions in §13-§16 are visible here as absent entries.');
lines.push(' */');
lines.push('export const TEMPLATE_GRANTS: Readonly<Record<string, readonly string[]>> = {');
for (const r of c.roleTemplates) {
  const perms = c.templateGrants[r.code] ?? [];
  lines.push(`  ${q(r.code)}: [`);
  for (let i = 0; i < perms.length; i += 4) {
    lines.push(`    ${perms.slice(i, i + 4).map(q).join(', ')},`);
  }
  lines.push('  ],');
}
lines.push('};');
lines.push('');
lines.push('export type PermissionCode = (typeof PERMISSIONS)[number]["code"];');
lines.push('export type SystemRoleCode = keyof typeof TEMPLATE_GRANTS;');
lines.push('');

writeFileSync(OUT, lines.join('\n'));
console.log(`[gen] ${OUT}: ${c.permissions.length} permissions, ${c.roleTemplates.length} templates`);
