/**
 * KGM LEGAL OS — COLUMN GRANT RECONCILIATION
 *
 *   DATABASE_URL="postgresql://portal_api.<ref>:<pw>@<host>:5432/postgres" \
 *     node supabase/ops/reconcile_column_grants.mjs
 *
 * Finds every column the APPLICATION reads or writes but the database does not
 * grant. Run it whenever a column is added to a query or a GRANT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS — three production failures, one cause
 * ─────────────────────────────────────────────────────────────────────────────
 * The driver-swap contract says the SQLite demo and the Supabase schema are the
 * same product. They are not, in one specific way that fails silently:
 *
 *   SQLite has no column grants. Postgres does. A query that names a column the
 *   role was never granted works perfectly under SQLite and fails on Postgres
 *   with `permission denied for table <t>`.
 *
 * That gap has now caused three separate outages, each found only by running
 * against the real database:
 *
 *   1. `invoices.client_status` — declared NOT NULL while the derivation function
 *      returns NULL for drafts. The seed died; worse, the DEFAULT would have shown
 *      clients an "awaiting payment" demand for an unreleased invoice.
 *   2. `portal_api` inherited `firm_api`, whose table-level SELECT subsumed every
 *      column grant — the portal could read `matters.risk_rating` and
 *      `matters.internal_notes`.
 *   3. `users.last_login_ip_hash`, `users.mfa_enabled_at`, `users.created_at` —
 *      read by `getUserByEmail`, granted to nobody. **Login returned HTTP 500.**
 *      This is the one the user saw in the browser.
 *
 * Fixing those one at a time is not a strategy: each was found by a user-visible
 * failure. The 0004 grants are an ENUMERATED list of 14 columns on `users` while
 * the code reads 17 — an enumeration that has to be kept in step with the code by
 * hand, and was not. So this tool derives the answer from the code.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW IT READS THE CODE
 * ─────────────────────────────────────────────────────────────────────────────
 * It scans `server/src/**` for SQL string literals, extracts the table aliases
 * (`from users u`, `join matters m on ...`), and then every identifier that a
 * column can appear as — in a select list, a where clause, an order by, an insert
 * column list, an update set — resolving `alias.column` to its table.
 *
 * A regex is not a SQL parser, so this CANNOT be a hard gate: an alias or a
 * function name it fails to resolve is reported as "unresolved", not as a leak,
 * and unresolved names are printed for review rather than failed on. Two rules
 * keep it honest:
 *
 *   IT ONLY ASSERTS WHAT IT IS SURE OF. A bare identifier with no alias in scope,
 *   or one that matches no column anywhere, is dropped. A false "missing grant"
 *   would train everyone to ignore the tool, which is worse than not having it.
 *
 *   IT CHECKS BOTH DIRECTIONS. An unread granted column is reported as unused, so
 *   a grant that no longer matches the code is visible too — that is how the
 *   inverse mistake (granting more than the code needs) gets noticed.
 *
 * Output is a report. Exit code is 1 if any READ is ungranted (a real outage) and
 * 0 otherwise, so it can be wired into CI without the noise failing the build.
 */
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const cs = process.env.DATABASE_URL;
if (!cs) {
  console.error('DATABASE_URL is required (a role connection string).');
  process.exit(1);
}

const ROLE = process.env.KGM_CHECK_ROLE ?? 'portal_api';
const SRC = path.resolve(import.meta.dirname, '..', '..', 'server', 'src');

/*
  AUDIENCE SPLIT.

  After migration 0008 the portal and the firm OS run as DIFFERENT database roles
  on the same connection, so "is this column granted" has no single answer — it
  depends on which half of the product runs the query. Checking everything against
  `portal_api` would flag every legitimately firm-only column; checking everything
  against `firm_api` would miss the portal's own outages, which is the `users`
  login failure this tool was written for.

  So each file is attributed to the role that runs it, by name:

    firm-*            -> firm_api   (firm routes and the firm repository)
    db/repo.ts        -> both       (SHARED: the portal repository is also used
                                     during firm requests for audit and identity,
                                     so both roles must be able to run it)
    everything else   -> portal_api

  `both` is the conservative default for anything shared, because a query that runs
  under either role has to be satisfiable by the narrower one.
*/
function audienceOf(rel) {
  const f = rel.replace(/\\/g, '/');
  if (/(^|\/)firm[-.]/.test(f) || /firm-repo|firm\.routes/.test(f)) return 'firm';
  if (/(^|\/)db\/repo\.ts$/.test(f)) return 'both';
  if (/(^|\/)db\/audit/.test(f)) return 'both';
  return 'portal';
}

/*
  Files whose SQL is not run by an application role at all.

  - `*.sqlite.ts` is DDL for the OTHER driver. It is a schema definition, and
    reading it as a query produces findings like `matters.id` "missing INSERT",
    which is meaningless — SQLite has no grants.
  - `dev.routes.ts` is mounted only when NODE_ENV is not production, and it exists
    to inspect the demo database. Granting a production role anything for it would
    be granting access for a route that is switched off.
*/
function isExcluded(rel) {
  const f = rel.replace(/\\/g, '/');
  if (f.endsWith('.sqlite.ts')) return true;
  if (/(^|\/)db\/schema/.test(f)) return true;
  if (/dev\.routes\.ts$/.test(f)) return true;
  if (/(^|\/)db\/reset\.ts$/.test(f)) return true;
  return false;
}

const CA = path.resolve(import.meta.dirname, '..', '..', 'server', 'certs', 'supabase-root-2021.crt');
const bare = cs.replace(/([?&])(sslmode|sslrootcert|sslcert|sslkey|sslnegotiation)=[^&]*/g, '$1').replace(/[?&]$/, '');
const pool = new pg.Pool({
  connectionString: bare, max: 2,
  ssl: fs.existsSync(CA) ? { ca: fs.readFileSync(CA, 'utf8') } : undefined,
});

/** Every .ts file under server/src. */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Extracts SQL from a source file.
 *
 * Only template literals and quoted strings that contain `select`/`insert`/
 * `update`/`delete` followed by `from`/`into`/`set`. Without the leading keyword
 * every log message and comment would be scanned as SQL.
 */
function sqlFragments(src) {
  const found = [];
  const re = /`([^`]*)`|'([^'\n]*)'|"([^"\n]*)"/g;
  let m;
  while ((m = re.exec(src))) {
    const body = m[1] ?? m[2] ?? m[3] ?? '';
    if (/\b(select|insert\s+into|update|delete\s+from)\b/i.test(body) && /\b(from|into|set|join|values)\b/i.test(body)) {
      found.push({ text: body, index: m.index });
    }
  }
  return found;
}

/** Line number of an offset, for a report that points at the code. */
const lineAt = (src, i) => src.slice(0, i).split('\n').length;

/**
 * Words that look like columns but are SQL syntax, functions, or JS.
 * Kept deliberately small: over-filtering hides real findings.
 */
const NOT_A_COLUMN = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'null', 'is', 'in', 'as', 'on',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'lateral',
  'group', 'by', 'order', 'having', 'limit', 'offset', 'asc', 'desc', 'distinct',
  'insert', 'into', 'values', 'update', 'set', 'delete', 'returning', 'with',
  'case', 'when', 'then', 'else', 'end', 'exists', 'union', 'all', 'any', 'some',
  'true', 'false', 'coalesce', 'count', 'sum', 'min', 'max', 'avg', 'now',
  'current_date', 'current_timestamp', 'cast', 'text', 'uuid', 'jsonb', 'int',
  'integer', 'numeric', 'boolean', 'timestamptz', 'date', 'interval', 'array',
  'string_agg', 'json_agg', 'json_build_object', 'row_number', 'over', 'partition',
  'generate_series', 'extract', 'epoch', 'at', 'time', 'zone', 'using', 'with',
  'conflict', 'do', 'nothing', 'default', 'primary', 'key', 'references',
  'constraint', 'check', 'unique', 'index', 'table', 'schema', 'public',
  'if', 'exists', 'function', 'returns', 'language', 'begin', 'commit',
  'rollback', 'savepoint', 'release', 'reset', 'role', 'grant', 'revoke',
  'is_local', 'local', 'config', 'nullif', 'greatest', 'least', 'between',
  'like', 'ilike', 'similar', 'to', 'escape', 'filter', 'within', 'recursive',
]);

/** True for an identifier that could be a bare (unaliased) column name. */
const isIdent = (s) => /^[a-z_][a-z0-9_]*$/i.test(s) && !NOT_A_COLUMN.has(s.toLowerCase());

async function main() {
  console.log('');
  console.log(`  KGM LEGAL OS — column grant reconciliation for "${ROLE}"`);
  console.log('  ────────────────────────────────────────────────────────────────');

  // ── the actual schema and grants, from the catalog ────────────────────────
  /*
    READ `pg_catalog`, NOT `information_schema`.

    This is not a style preference, and getting it wrong made the first version of
    this tool silently under-report — the dangerous direction.

    PostgreSQL's `information_schema` views are filtered to objects the CURRENT
    USER holds a privilege on. `information_schema.columns` is defined with
    `has_column_privilege(...)`, so a column the role was never granted is
    INVISIBLE to it. The tool builds its table of "columns that exist" from that
    view, then checks whether each is granted — so the ungranted columns, the
    entire object of the search, were missing from the list it searched.
    `users.created_at` and `users.last_login_ip_hash` are read by the login query
    and granted to nobody; neither appeared in the report because neither appeared
    in the schema.

    `pg_class`/`pg_attribute` are world-readable and unfiltered, so the set of
    columns is complete regardless of who is asking.
  */
  const cols = await pool.query(`
    select c.relname as table_name, a.attname as column_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where n.nspname = 'public' and c.relkind in ('r','p')
     order by c.relname, a.attnum`);
  const byTable = new Map();
  for (const r of cols.rows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Set());
    byTable.get(r.table_name).add(r.column_name);
  }

  const granted = await pool.query(`
    select c.relname as table_name, a.attname as column_name, x.privilege_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      cross join lateral aclexplode(a.attacl) x
      join pg_roles r on r.oid = x.grantee
     where n.nspname = 'public' and a.attacl is not null and r.rolname = $1`, [ROLE]);
  const can = { SELECT: new Map(), INSERT: new Map(), UPDATE: new Map() };
  for (const r of granted.rows) {
    const m = can[r.privilege_type];
    if (!m) continue;
    if (!m.has(r.table_name)) m.set(r.table_name, new Set());
    m.get(r.table_name).add(r.column_name);
  }
  // A table-level grant covers every column; the role has none of those after
  // 0008, but the check must still be correct if one is ever added back.
  const tableLevel = await pool.query(`
    select c.relname as table_name, x.privilege_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) x
      join pg_roles r on r.oid = x.grantee
     where n.nspname = 'public' and c.relkind in ('r','p') and c.relacl is not null and r.rolname = $1`, [ROLE]);
  const tableWide = { SELECT: new Set(), INSERT: new Set(), UPDATE: new Set() };
  for (const r of tableLevel.rows) tableWide[r.privilege_type]?.add(r.table_name);

  const holds = (priv, table, column) => {
    if (tableWide[priv]?.has(table)) return true;
    return can[priv]?.get(table)?.has(column) ?? false;
  };

  // ── what the code reads ───────────────────────────────────────────────────
  const reads = new Map();   // "table.column" -> Set of "file:line verb"
  const writes = new Map();
  const unresolved = new Map();
  const note = (map, key, where, audience) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(`${audience}|${where}`);
  };

  const files = walk(SRC);
  for (const file of files) {
    const rel = path.relative(path.resolve(SRC, '..', '..'), file);
    if (isExcluded(rel)) continue;
    const audience = audienceOf(rel);
    const src = fs.readFileSync(file, 'utf8');
    for (const frag of sqlFragments(src)) {
      const sql = frag.text;
      const where = `${rel}:${lineAt(src, frag.index)}`;
      const verb = /\binsert\s+into\b/i.test(sql) ? 'INSERT'
        : /\bupdate\b/i.test(sql) ? 'UPDATE'
        : /\bdelete\s+from\b/i.test(sql) ? 'DELETE' : 'SELECT';

      // aliases: `from users u`, `join matters as m`, `from public.users x`
      const aliases = new Map();
      for (const m of sql.matchAll(/\b(?:from|join)\s+(public\.)?([a-z_][a-z0-9_]*)\s*(?:as\s+)?([a-z_][a-z0-9_]*)?/gi)) {
        const table = m[2];
        if (!byTable.has(table)) continue;
        const alias = m[3];
        aliases.set(table, table);
        // Only treat the trailing word as an alias if it is not a keyword that can
        // legally follow a table name.
        if (alias && !NOT_A_COLUMN.has(alias.toLowerCase()) && alias.toLowerCase() !== table) {
          aliases.set(alias.toLowerCase(), table);
        }
      }
      if (aliases.size === 0) continue;

      const tables = new Set([...aliases.values()]);
      if (tables.size > 1) {
        // Ambiguous without a real parser: record it, do not assert on it.
        for (const m of sql.matchAll(/\b([a-z_][a-z0-9_]*)\s*\.\s*([a-z_][a-z0-9_]*)/gi)) {
          const tbl = aliases.get(m[1].toLowerCase());
          if (!tbl) continue;
          const col = m[2];
          const map = verb === 'SELECT' ? reads : writes;
          note(map, `${tbl}.${col}`, `${where} (${verb})`, audience);
        }
        continue;
      }

      const table = [...tables][0];
      const known = byTable.get(table);
      const map = verb === 'SELECT' ? reads : writes;

      // alias-qualified references resolve exactly
      for (const m of sql.matchAll(/\b([a-z_][a-z0-9_]*)\s*\.\s*([a-z_][a-z0-9_]*)/gi)) {
        const tbl = aliases.get(m[1].toLowerCase());
        if (!tbl) continue;
        if (byTable.get(tbl)?.has(m[2])) note(map, `${tbl}.${m[2]}`, `${where} (${verb})`, audience);
      }

      /*
        Bare identifiers, resolved against the single table in scope.
        This is where the `users` failure appeared: `select id, email, ..., created_at
        from users where email = ?` has one table and no aliases on its columns.
        A bare word only counts if it IS a column of that table — anything else is
        an expression, a parameter, or JS interpolation, and asserting on those
        would be the false-positive noise that makes a tool ignorable.
      */
      for (const m of sql.matchAll(/(?<![\w.'])([a-z_][a-z0-9_]*)(?![\w.'])/gi)) {
        const word = m[1];
        if (!isIdent(word)) continue;
        const lower = word.toLowerCase();
        if (aliases.has(lower)) continue;      // it is a table/alias, not a column
        if (known.has(lower)) note(map, `${table}.${lower}`, `${where} (${verb})`, audience);
      }
    }
  }

  // ── report ────────────────────────────────────────────────────────────────
  /*
    Grants are loaded for BOTH roles so a finding can be attributed to the role
    that will actually fail on it. `holdsFor` consults one role's privileges.
  */
  async function grantsFor(role) {
    /*
      Column privileges, expanded from the raw ACL rather than read from
      `information_schema.column_privileges` — same visibility trap as above, and
      `aclexplode` also reports the true privilege set including grants made
      through a role the role is a member of.
    */
    const cs2 = await pool.query(
      `select c.relname as table_name, a.attname as column_name, x.privilege_type
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         cross join lateral aclexplode(a.attacl) x
         join pg_roles r on r.oid = x.grantee
        where n.nspname = 'public' and a.attacl is not null and r.rolname = $1`, [role]);
    // Nested: privilege -> table -> columns. Keying tables directly on `m` (the
    // mistake this replaces) puts every column under a table-name property and
    // leaves the privilege maps empty, so every lookup returns "not granted" —
    // the tool then reports the whole schema as missing. It failed loudly and
    // obviously; the same slip in the other direction would have reported a clean
    // bill of health, which is why the counts are asserted below.
    const m = { SELECT: new Map(), INSERT: new Map(), UPDATE: new Map() };
    for (const r of cs2.rows) {
      const byTable = m[r.privilege_type];
      if (!byTable) continue;
      if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Set());
      byTable.get(r.table_name).add(r.column_name);
    }
    const tl = await pool.query(
      `select c.relname as table_name, x.privilege_type
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join lateral aclexplode(c.relacl) x
         join pg_roles r on r.oid = x.grantee
        where n.nspname = 'public' and c.relkind in ('r','p') and c.relacl is not null and r.rolname = $1`, [role]);
    const wide = { SELECT: new Set(), INSERT: new Set(), UPDATE: new Set() };
    for (const r of tl.rows) wide[r.privilege_type]?.add(r.table_name);
    return (priv, t, c) => wide[priv]?.has(t) || (m[priv]?.get(t)?.has(c) ?? false);
  }

  const ROLES = { portal: 'portal_api', firm: 'firm_api' };
  const holdsCache = new Map();
  const holdsFor = async (role, priv, t, c) => {
    if (!holdsCache.has(role)) holdsCache.set(role, await grantsFor(role));
    return holdsCache.get(role)(priv, t, c);
  };

  /*
    A GRANT LOADER THAT LOADS NOTHING WOULD REPORT THE ENTIRE SCHEMA AS MISSING.
    That failure mode looks exactly like a catastrophic finding, so it has to be
    ruled out before the findings are believed. Every role here holds known grants
    on known columns, so if a probe of one returns false, the loader is broken and
    the run is meaningless.
  */
  const SELF_TEST = [['portal_api', 'matters', 'title'], ['portal_api', 'users', 'email']];
  for (const [role, t, c] of SELF_TEST) {
    if (!(await holdsFor(role, 'SELECT', t, c))) {
      console.error(`\n  SELF-TEST FAILED: ${role} is known to hold SELECT on ${t}.${c} but the`);
      console.error('  grant loader did not see it. Findings below would be meaningless.');
      process.exit(2);
    }
  }

  const bad = [];
  for (const [key, entries] of reads) {
    const [t, c] = key.split('.');
    if (!byTable.has(t) || !byTable.get(t).has(c)) continue;   // stale/derived name
    const audiences = new Set([...entries].map((e) => e.split('|')[0]));
    // 'both' means either role may run it, so it must hold for at least one of
    // them — a shared query is executed by whichever audience is active.
    const roles = audiences.has('both') ? ['portal_api', 'firm_api']
      : [...audiences].map((a) => ROLES[a]).filter(Boolean);
    /*
      Report if ANY attributed role lacks it, not only if all do.

      Requiring every role to lack it suppresses exactly the failure this tool was
      written for: `users.created_at` is missing from `portal_api` (which breaks
      the portal login with a 500) but present for `firm_api`, so an "all roles"
      rule stayed silent. A query is run by ONE audience at a time, so each
      audience must be able to run it on its own; "the other role can" is no help
      to the request that fails.
    */
    const missing = [];
    for (const r of roles) if (!(await holdsFor(r, 'SELECT', t, c))) missing.push(r);
    if (missing.length) {
      bad.push({ key, priv: 'SELECT', roles: missing, wheres: [...entries].map((e) => e.split('|')[1]) });
    }
  }
  const badWrites = [];
  for (const [key, entries] of writes) {
    const [t, c] = key.split('.');
    if (!byTable.has(t) || !byTable.get(t).has(c)) continue;
    const audiences = new Set([...entries].map((e) => e.split('|')[0]));
    const roles = audiences.has('both') ? ['portal_api', 'firm_api']
      : [...audiences].map((a) => ROLES[a]).filter(Boolean);
    // An INSERT column list or an UPDATE SET list — either privilege is enough.
    const missing = [];
    for (const r of roles) {
      const ok = (await holdsFor(r, 'INSERT', t, c)) || (await holdsFor(r, 'UPDATE', t, c));
      if (!ok) missing.push(r);
    }
    if (missing.length) {
      badWrites.push({ key, priv: 'INSERT/UPDATE', roles: missing, wheres: [...entries].map((e) => e.split('|')[1]) });
    }
  }

  console.log('');
  console.log(`  scanned ${files.length} source file(s); ${reads.size} read reference(s), ${writes.size} write reference(s)`);
  console.log('');

  if (bad.length === 0) {
    console.log('  OK  every column the code READS is granted to every role that runs the query');
  } else {
    console.log(`  ${bad.length} column(s) the code reads are granted to NO role that runs the query:`);
    console.log('');
    for (const b of bad) {
      console.log(`    MISSING SELECT  ${b.key}   (needed by ${b.roles.join(' and ')})`);
      for (const w of b.wheres.slice(0, 4)) console.log(`                    ${w}`);
      if (b.wheres.length > 4) console.log(`                    ...and ${b.wheres.length - 4} more`);
    }
    console.log('');
    console.log('  Each of these is a query that WORKS on SQLite and returns');
    console.log('  "permission denied for table <t>" on Postgres. Grant them, or stop');
    console.log('  selecting them.');
  }

  if (badWrites.length) {
    console.log('');
    console.log(`  ${badWrites.length} column(s) the code WRITES are NOT granted:`);
    for (const b of badWrites) {
      console.log(`    MISSING ${b.priv}  ${b.key}`);
      for (const w of b.wheres.slice(0, 3)) console.log(`                    ${w}`);
    }
  }

  /* Grants the code no longer uses — the inverse drift, reported not failed. */
  const unused = [];
  for (const [t, set] of can.SELECT) {
    if (!byTable.has(t)) continue;
    for (const c of set) if (!reads.has(`${t}.${c}`)) unused.push(`${t}.${c}`);
  }
  if (unused.length) {
    console.log('');
    console.log(`  note: ${unused.length} SELECT grant(s) not referenced by any query. Usually`);
    console.log('        fine (a projection may name columns at runtime), but a grant that');
    console.log('        outlives its query is how access creeps. Review:');
    console.log('        ' + unused.slice(0, 24).join(', ') + (unused.length > 24 ? ` …+${unused.length - 24}` : ''));
  }

  console.log('');
  console.log('  ────────────────────────────────────────────────────────────────');
  console.log('');
  process.exitCode = bad.length ? 1 : 0;
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error('\n  RECONCILE ERROR:', String(e?.message ?? e).split('\n')[0]);
    await pool.end().catch(() => {});
    process.exit(1);
  });
