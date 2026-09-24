/**
 * Parser for the Firm OS permission catalogue as it is written in SQL.
 *
 * WHY THIS EXISTS
 *   The permission catalogue and the nine system role templates are defined
 *   twice by necessity: once as DDL/seed in `supabase/migrations/0006_firm_rbac.sql`
 *   for Postgres, and once as rows the SQLite demo seed inserts. Two copies of
 *   an authorization contract is exactly the kind of thing that drifts — a
 *   permission added to the migration but not to the seed means production and
 *   demo disagree about who can do what, and the tests would keep passing
 *   because they only ever look at one side.
 *
 *   So the SQL file is treated as the single source of truth. This module reads
 *   it, and two things consume the result:
 *     - `scripts/gen-firm-catalogue.ts` emits the TypeScript module the app uses
 *     - `tests/security/firm-rbac.test.ts` re-parses and compares, so editing the
 *       migration without regenerating fails the build
 *
 * PARSING APPROACH
 *   Deliberately narrow. It does not understand SQL; it understands the three
 *   specific `insert ... values` blocks this migration writes, and it fails
 *   loudly rather than returning a partial catalogue if the shape changes. A
 *   tolerant parser here would be a silent authorization bug.
 */
import { readFileSync } from 'node:fs';

export interface CataloguePermission {
  code: string;
  module: string;
  description: string;
  descriptionAr: string;
  sensitivity: 'normal' | 'elevated' | 'critical';
}

export interface CatalogueRoleTemplate {
  /** The fixed template id used by the migration. */
  templateId: string;
  code: string;
  name: string;
  nameAr: string;
  description: string;
}

export interface FirmCatalogue {
  permissions: CataloguePermission[];
  roleTemplates: CatalogueRoleTemplate[];
  /** role code -> permission codes, in migration order. */
  templateGrants: Record<string, string[]>;
}

/**
 * Removes `--` line comments outside of quoted strings.
 *
 * The migration annotates every group of permissions with a comment, and those
 * comments contain parentheses and section marks (`-- clients (§21-§23)`). Left
 * in place they would be parsed as tuples, so they are stripped first. String
 * literals are respected: an em dash or a hyphen pair inside a description is
 * data, not a comment.
 */
function stripLineComments(body: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (body[i + 1] === "'") {
          out += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '-' && body[i + 1] === '-') {
      while (i < body.length && body[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Splits a parenthesised tuple list into rows of fields.
 *
 * Handles `''` escapes and ignores parentheses/commas inside quoted strings,
 * which matters because several Arabic descriptions contain commas.
 */
function parseTuples(rawBody: string): string[][] {
  const body = stripLineComments(rawBody);
  const rows: string[][] = [];
  let depth = 0;
  let row: string[] = [];
  let field = '';
  let inString = false;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];

    if (inString) {
      if (ch === "'") {
        if (body[i + 1] === "'") {
          field += "'";
          i += 1;
        } else {
          inString = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    switch (ch) {
      case "'":
        inString = true;
        break;
      case '(':
        depth += 1;
        if (depth === 1) {
          row = [];
          field = '';
        } else {
          field += ch;
        }
        break;
      case ')':
        depth -= 1;
        if (depth === 0) {
          row.push(field.trim());
          rows.push(row);
        } else {
          field += ch;
        }
        break;
      case ',':
        if (depth === 1) {
          row.push(field.trim());
          field = '';
        } else {
          field += ch;
        }
        break;
      default:
        if (depth >= 1) field += ch;
    }
  }

  if (depth !== 0 || inString) {
    throw new Error('parse-firm-catalogue: unbalanced tuple list in migration');
  }
  return rows;
}

/** Strips `::type` casts and SQL literals down to a comparable scalar. */
function scalar(raw: string): string {
  const v = raw.trim().replace(/::[a-z_ ]+$/i, '');
  if (/^(null|true|false)$/i.test(v)) return v.toLowerCase();
  return v;
}

/**
 * Returns the text between an `insert into <table> (...) values` marker and the
 * statement's terminating clause, so tuple parsing never wanders into the next
 * statement.
 */
function valuesBlock(sql: string, insertHead: string, terminator: RegExp): string {
  const start = sql.indexOf(insertHead);
  if (start < 0) throw new Error(`parse-firm-catalogue: missing "${insertHead}"`);
  const valuesAt = sql.indexOf('values', start);
  if (valuesAt < 0) throw new Error(`parse-firm-catalogue: no VALUES after "${insertHead}"`);
  const endMatch = terminator.exec(sql.slice(valuesAt));
  if (!endMatch) throw new Error(`parse-firm-catalogue: unterminated block after "${insertHead}"`);
  return sql.slice(valuesAt + 'values'.length, valuesAt + endMatch.index);
}

export function parseFirmCatalogue(sql: string): FirmCatalogue {
  // ---- permissions -------------------------------------------------------
  const permRows = parseTuples(
    valuesBlock(
      sql,
      'insert into public.permissions (code, module, description, description_ar, sensitivity) values',
      /on conflict \(code\) do nothing/i,
    ),
  );

  const permissions: CataloguePermission[] = permRows.map((r, i) => {
    if (r.length !== 5) {
      throw new Error(`parse-firm-catalogue: permissions row ${i} has ${r.length} fields, expected 5`);
    }
    const sensitivity = scalar(r[4]);
    if (sensitivity !== 'normal' && sensitivity !== 'elevated' && sensitivity !== 'critical') {
      throw new Error(`parse-firm-catalogue: permissions row ${i} has unknown sensitivity "${sensitivity}"`);
    }
    return {
      code: scalar(r[0]),
      module: scalar(r[1]),
      description: scalar(r[2]),
      descriptionAr: scalar(r[3]),
      sensitivity,
    };
  });

  // ---- role templates ----------------------------------------------------
  const roleRows = parseTuples(
    valuesBlock(
      sql,
      'insert into public.roles (id, tenant_id, code, name, name_ar, description, is_system) values',
      /on conflict \(tenant_id, code\) do nothing/i,
    ),
  );

  const roleTemplates: CatalogueRoleTemplate[] = roleRows.map((r, i) => {
    if (r.length !== 7) {
      throw new Error(`parse-firm-catalogue: roles row ${i} has ${r.length} fields, expected 7`);
    }
    if (scalar(r[1]) !== 'null') {
      throw new Error(`parse-firm-catalogue: system role template "${scalar(r[2])}" must have tenant_id NULL`);
    }
    if (scalar(r[6]) !== 'true') {
      throw new Error(`parse-firm-catalogue: role "${scalar(r[2])}" must be is_system = true`);
    }
    return {
      templateId: scalar(r[0]),
      code: scalar(r[2]),
      name: scalar(r[3]),
      nameAr: scalar(r[4]),
      description: scalar(r[5]),
    };
  });

  // ---- template -> permission grants -------------------------------------
  const grantsAt = sql.indexOf('grants(code, perm) as (values');
  if (grantsAt < 0) throw new Error('parse-firm-catalogue: missing grants CTE');
  const grantsEnd = sql.indexOf(')\ninsert into public.role_permissions', grantsAt);
  if (grantsEnd < 0) throw new Error('parse-firm-catalogue: unterminated grants CTE');

  const templateGrants: Record<string, string[]> = {};
  for (const r of parseTuples(sql.slice(grantsAt + 'grants(code, perm) as (values'.length, grantsEnd))) {
    if (r.length !== 2) throw new Error(`parse-firm-catalogue: grant tuple has ${r.length} fields, expected 2`);
    const role = scalar(r[0]);
    const perm = scalar(r[1]);
    (templateGrants[role] ??= []).push(perm);
  }

  // ---- cross-checks: fail loudly rather than emit a broken contract -------
  const codes = new Set(permissions.map((p) => p.code));
  if (codes.size !== permissions.length) {
    throw new Error('parse-firm-catalogue: duplicate permission code in migration');
  }
  for (const [role, perms] of Object.entries(templateGrants)) {
    if (!roleTemplates.some((t) => t.code === role)) {
      throw new Error(`parse-firm-catalogue: grants reference unknown role "${role}"`);
    }
    for (const p of perms) {
      if (!codes.has(p)) {
        throw new Error(`parse-firm-catalogue: role "${role}" grants unknown permission "${p}"`);
      }
    }
  }

  return { permissions, roleTemplates, templateGrants };
}

export function parseFirmCatalogueFile(path: string): FirmCatalogue {
  return parseFirmCatalogue(readFileSync(path, 'utf8'));
}
