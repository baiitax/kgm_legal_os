/**
 * Parser for the Firm OS permission catalogue as it is written in SQL.
 *
 * WHY THIS EXISTS
 *   The permission catalogue and the nine system role templates are defined twice by
 *   necessity: once as DDL/seed in `supabase/migrations/0006_firm_rbac.sql` for Postgres, and
 *   once as rows the SQLite demo seed inserts. Two copies of an authorization contract is
 *   exactly the kind of thing that drifts — a permission added to the migration but not to
 *   the seed means production and demo disagree about who can do what, and the tests would
 *   keep passing because they only ever look at one side.
 *
 *   So the SQL files are treated as the single source of truth. This module reads them, and
 *   two things consume the result:
 *     - `scripts/gen-firm-catalogue.ts` emits the TypeScript module the app uses
 *     - `tests/security/firm-rbac.test.ts` re-parses and compares, so editing the SQL without
 *       regenerating fails the build
 *
 * MORE THAN ONE FILE, SINCE P0.4
 *   The catalogue grows with the product, and an applied migration is a historical record of
 *   what the database was told rather than a document to be revised. `0046` therefore declares
 *   the P0.4 permissions in exactly the shapes this parser understands, and the catalogue is
 *   the union of every source, in file order. The merge is strict, because every way of
 *   merging an authorization contract badly is an authorization bug:
 *
 *     · a permission code declared twice is an ERROR, not a silent last-one-wins;
 *     · a role that lists the same permission twice is an ERROR, because the duplicate would
 *       be carried into the demo seed and the two engines would disagree about row counts;
 *     · the `roles` block is OPTIONAL in a later file — a phase that only grants to existing
 *       templates declares no new ones — but at least one source must declare them, since
 *       every grant is validated against the templates that exist.
 *
 * PARSING APPROACH
 *   Deliberately narrow. It does not understand SQL; it understands the three specific
 *   `insert ... values` blocks these migrations write, and it fails loudly rather than
 *   returning a partial catalogue if the shape changes. A tolerant parser here would be a
 *   silent authorization bug.
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
 * The migration annotates every group of permissions with a comment, and those comments
 * contain parentheses and section marks (`-- clients (§21-§23)`). Left in place they would be
 * parsed as tuples, so they are stripped first. String literals are respected: an em dash or a
 * hyphen pair inside a description is data, not a comment.
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
 * Handles `''` escapes and ignores parentheses/commas inside quoted strings, which matters
 * because several Arabic descriptions contain commas.
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
 * Returns the text between an `insert into <table> (...) values` marker and the statement's
 * terminating clause, so tuple parsing never wanders into the next statement.
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

const PERMISSIONS_HEAD =
  'insert into public.permissions (code, module, description, description_ar, sensitivity) values';
const ROLES_HEAD =
  'insert into public.roles (id, tenant_id, code, name, name_ar, description, is_system) values';

/** Reads one migration's contribution into the accumulated catalogue. */
function parseOne(sql: string, index: number, into: FirmCatalogue): void {
  if (!sql.includes(PERMISSIONS_HEAD)) {
    if (index === 0) {
      throw new Error('parse-firm-catalogue: the first source declares no permissions');
    }
    return;
  }

  // ---- permissions -------------------------------------------------------
  const permRows = parseTuples(
    valuesBlock(sql, PERMISSIONS_HEAD, /on conflict \(code\) do nothing/i),
  );

  for (const [i, r] of permRows.entries()) {
    if (r.length !== 5) {
      throw new Error(
        `parse-firm-catalogue: source ${index} permissions row ${i} has ${r.length} fields, expected 5`,
      );
    }
    const sensitivity = scalar(r[4]);
    if (sensitivity !== 'normal' && sensitivity !== 'elevated' && sensitivity !== 'critical') {
      throw new Error(
        `parse-firm-catalogue: source ${index} row ${i} has unknown sensitivity "${sensitivity}"`,
      );
    }
    into.permissions.push({
      code: scalar(r[0]),
      module: scalar(r[1]),
      description: scalar(r[2]),
      descriptionAr: scalar(r[3]),
      sensitivity,
    });
  }

  // ---- role templates (optional in a later source) ------------------------
  if (sql.includes(ROLES_HEAD)) {
    const roleRows = parseTuples(
      valuesBlock(sql, ROLES_HEAD, /on conflict \(tenant_id, code\) do nothing/i),
    );
    for (const [i, r] of roleRows.entries()) {
      if (r.length !== 7) {
        throw new Error(
          `parse-firm-catalogue: source ${index} roles row ${i} has ${r.length} fields, expected 7`,
        );
      }
      if (scalar(r[1]) !== 'null') {
        throw new Error(
          `parse-firm-catalogue: system role template "${scalar(r[2])}" must have tenant_id NULL`,
        );
      }
      if (scalar(r[6]) !== 'true') {
        throw new Error(`parse-firm-catalogue: role "${scalar(r[2])}" must be is_system = true`);
      }
      into.roleTemplates.push({
        templateId: scalar(r[0]),
        code: scalar(r[2]),
        name: scalar(r[3]),
        nameAr: scalar(r[4]),
        description: scalar(r[5]),
      });
    }
  }

  // ---- template -> permission grants -------------------------------------
  const grantsAt = sql.indexOf('grants(code, perm) as (values');
  if (grantsAt < 0) {
    throw new Error(`parse-firm-catalogue: source ${index} declares no grants CTE`);
  }
  const grantsEnd = sql.indexOf(')\ninsert into public.role_permissions', grantsAt);
  if (grantsEnd < 0) {
    throw new Error(`parse-firm-catalogue: source ${index} has an unterminated grants CTE`);
  }

  for (const r of parseTuples(
    sql.slice(grantsAt + 'grants(code, perm) as (values'.length, grantsEnd),
  )) {
    if (r.length !== 2) {
      throw new Error(`parse-firm-catalogue: grant tuple has ${r.length} fields, expected 2`);
    }
    (into.templateGrants[scalar(r[0])] ??= []).push(scalar(r[1]));
  }
}

export function parseFirmCatalogue(...sources: string[]): FirmCatalogue {
  if (!sources.length) throw new Error('parse-firm-catalogue: no sources given');

  const into: FirmCatalogue = { permissions: [], roleTemplates: [], templateGrants: {} };
  for (const [index, sql] of sources.entries()) parseOne(sql, index, into);

  // ---- cross-checks: fail loudly rather than emit a broken contract -------
  const codes = new Set(into.permissions.map((p) => p.code));
  if (codes.size !== into.permissions.length) {
    throw new Error('parse-firm-catalogue: a permission code is declared twice across sources');
  }
  if (!into.roleTemplates.length) {
    throw new Error('parse-firm-catalogue: no source declares the role templates');
  }
  for (const [role, perms] of Object.entries(into.templateGrants)) {
    if (!into.roleTemplates.some((t) => t.code === role)) {
      throw new Error(`parse-firm-catalogue: grants reference unknown role "${role}"`);
    }
    const seen = new Set<string>();
    for (const p of perms) {
      if (!codes.has(p)) {
        throw new Error(`parse-firm-catalogue: role "${role}" grants unknown permission "${p}"`);
      }
      if (seen.has(p)) {
        throw new Error(`parse-firm-catalogue: role "${role}" lists "${p}" twice`);
      }
      seen.add(p);
    }
  }

  return into;
}

/** Every catalogue-bearing migration, in order. */
export const CATALOGUE_MIGRATIONS = [
  'supabase/migrations/0006_firm_rbac.sql',
  'supabase/migrations/0046_judgment_permissions.sql',
] as const;

export function parseFirmCatalogueFiles(paths: readonly string[]): FirmCatalogue {
  return parseFirmCatalogue(...paths.map((p) => readFileSync(p, 'utf8')));
}

/** @deprecated prefer `parseFirmCatalogueFiles` with `CATALOGUE_MIGRATIONS`. */
export function parseFirmCatalogueFile(path: string): FirmCatalogue {
  return parseFirmCatalogue(readFileSync(path, 'utf8'));
}
