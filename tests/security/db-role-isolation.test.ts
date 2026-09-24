/**
 * DATABASE ROLE ISOLATION · §49, §71
 *
 * The database is a security boundary only while the connection is one RLS
 * applies to. PostgreSQL exempts three kinds of identity from row security:
 * superusers, roles with BYPASSRLS, and the owner of the table. Nothing in this
 * repository's SQL constrains any of them.
 *
 * These tests cover two separate things, and the second is the one that matters:
 *
 *   1. The POLICY — `judgeRole` decides correctly for every combination of flags.
 *   2. The WIRING — `assertSafeRole` actually queries, actually calls the policy,
 *      and actually throws. A correct policy that nothing calls is not a defence.
 *
 * Supabase hands out `postgres` (a superuser) as the default connection identity,
 * so case 1 in the policy test is the default experience of anyone who copies the
 * connection string from the dashboard. That is why this check is here at all.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  judgeRole, judgeAssumedRoles, shouldRefuseToStart, EXPECTED_ROLE_HINT, FIRM_ROLE,
  type RoleFacts, type AssumedRoleFacts,
} from '../../server/src/db/role-guard.js';

const facts = (over: Partial<RoleFacts> = {}): RoleFacts => ({
  roleName: 'portal_api',
  isSuperuser: false,
  bypassesRls: false,
  ownedTables: 0,
  ...over,
});

// ==========================================================================
// 1 · THE POLICY
// ==========================================================================

describe('§49 · judgeRole', () => {
  it('passes a plain non-owner role', () => {
    const v = judgeRole(facts());
    expect(v.safe).toBe(true);
    expect(v.code).toBe('ok');
    // The detail is logged on boot, so it should state the finding, not the rule.
    expect(v.detail).toContain('portal_api');
  });

  it('refuses a superuser — the Supabase default connection string', () => {
    const v = judgeRole(facts({ roleName: 'postgres', isSuperuser: true }));
    expect(v.safe).toBe(false);
    expect(v.code).toBe('role_is_superuser');
    // Names the consequence, so an operator reading the crash knows what was lost
    // rather than only which rule they broke.
    expect(v.detail).toMatch(/bypassed/i);
  });

  it('refuses a role with BYPASSRLS', () => {
    const v = judgeRole(facts({ roleName: 'bypasser', bypassesRls: true }));
    expect(v.safe).toBe(false);
    expect(v.code).toBe('role_bypasses_rls');
  });

  it('refuses a role that owns tables, even with every other flag clean', () => {
    /*
      The subtle one. This role is not a superuser and has no BYPASSRLS, so it
      looks safe — but RLS does not apply to a table's owner unless the table is
      marked FORCE ROW LEVEL SECURITY, and no migration here does that (64
      ENABLE, 0 FORCE). The policies would still be present and still look
      correct, and would do nothing.
    */
    const v = judgeRole(facts({ roleName: 'table_owner', ownedTables: 7 }));
    expect(v.safe).toBe(false);
    expect(v.code).toBe('role_owns_tables');
    expect(v.detail).toContain('7');
  });

  it('treats superuser as the most severe, so the message is the clearest one', () => {
    // All three faults at once: the operator should be told the worst.
    const v = judgeRole(facts({ roleName: 'postgres', isSuperuser: true, bypassesRls: true, ownedTables: 64 }));
    expect(v.code).toBe('role_is_superuser');
  });

  it('refuses in every environment — there is no lower-stakes RLS', () => {
    // `shouldRefuseToStart` deliberately takes no environment argument. A guard
    // that is lenient in development is exercised only where nobody is watching,
    // and is first genuinely tested on the day it matters.
    for (const bad of [
      facts({ isSuperuser: true }),
      facts({ bypassesRls: true }),
      facts({ ownedTables: 1 }),
    ]) {
      expect(shouldRefuseToStart(judgeRole(bad))).toBe(true);
    }
    expect(shouldRefuseToStart(judgeRole(facts()))).toBe(false);
  });

  it('points at the fix', () => {
    expect(EXPECTED_ROLE_HINT).toContain('create_api_login.sql');
    // The two strings an operator is most likely to have pasted wrongly.
    expect(EXPECTED_ROLE_HINT).toContain('superuser');
  });
});

// ==========================================================================
// 1b · THE POLICY FOR ROLES THE CONNECTION CAN SWITCH INTO
// ==========================================================================
/*
  Why this section exists at all.

  Until migration 0008, one role served both audiences and the guard only ever had
  to judge `current_user`. That is no longer true: a firm-audience request runs
  under `SET ROLE firm_api`, so the role that acts on the request is not the role
  the connection authenticated as.

  A guard that inspected only `current_user` would clear `portal_api` at boot,
  print `ok`, and then let every firm request run as a role nobody vetted. If
  `firm_api` were a superuser or had BYPASSRLS, the entire firm half of the
  product would run with no row security — and the startup check would have said
  everything was fine. That is the same failure mode this file was written to
  prevent, one indirection further out.
*/

const assumed = (over: Partial<AssumedRoleFacts> = {}): AssumedRoleFacts => ({
  roleName: 'firm_api',
  isSuperuser: false,
  bypassesRls: false,
  ownedTables: 0,
  ...over,
});

describe('§49 · judgeAssumedRoles', () => {
  it('passes when every reachable role is as safe as the connection', () => {
    const v = judgeAssumedRoles(facts({ assumedRoles: [assumed()] }));
    expect(v).toBeNull();
  });

  it('refuses a reachable role with BYPASSRLS', () => {
    // The exact hole: current_user is clean, so judgeRole alone would pass.
    const f = facts({ assumedRoles: [assumed({ bypassesRls: true })] });
    expect(judgeRole(f).safe).toBe(true);
    const v = judgeAssumedRoles(f);
    expect(v?.safe).toBe(false);
    expect(v?.code).toBe('assumed_role_bypasses_rls');
    // The message must say the role is REACHABLE, or an operator will reasonably
    // ask why a role the server never logs in as stops the server.
    expect(v?.detail).toContain('firm_api');
    expect(v?.detail).toMatch(/SET ROLE/i);
  });

  it('refuses a reachable superuser', () => {
    const v = judgeAssumedRoles(facts({ assumedRoles: [assumed({ isSuperuser: true })] }));
    expect(v?.code).toBe('assumed_role_is_superuser');
  });

  it('refuses a reachable role that owns tables', () => {
    const v = judgeAssumedRoles(facts({ assumedRoles: [assumed({ roleName: 'firm_os', ownedTables: 3 })] }));
    expect(v?.code).toBe('assumed_role_owns_tables');
  });

  it('does not re-judge the connection itself when it appears in the reachable set', () => {
    // `pg_has_role(current_user, oid, 'SET')` includes the connection's own role.
    // Judging it twice would report a role name in the "may SET ROLE into" line
    // that the connection never switches out to.
    const v = judgeAssumedRoles(facts({
      assumedRoles: [assumed({ roleName: 'portal_api' })],
    }));
    expect(v).toBeNull();
  });

  it('is inert when the connection can switch into nothing', () => {
    expect(judgeAssumedRoles(facts())).toBeNull();
    expect(judgeAssumedRoles(facts({ assumedRoles: [] }))).toBeNull();
  });

  it('names FIRM_ROLE as the role the driver switches into', () => {
    // postgres.ts imports this constant rather than hardcoding 'firm_api', so the
    // role the driver assumes and the role this file vets cannot drift apart.
    // A drift would mean vetting one role and running as another.
    expect(FIRM_ROLE).toBe('firm_api');
  });
});

// ==========================================================================
// 2 · THE WIRING
// ==========================================================================

/** Builds a PostgresDb with pg.Pool stubbed to answer the role query. */
async function withStubbedPool(answer: Record<string, unknown> | null) {
  vi.resetModules();
  const query = vi.fn(async () => ({ rows: answer ? [answer] : [] }));
  const on = vi.fn();

  vi.doMock('pg', () => ({
    default: {
      Pool: class {
        query = query;
        on = on;
        end = vi.fn();
        connect = vi.fn();
      },
    },
  }));

  const { PostgresDb } = await import('../../server/src/db/postgres.js');
  const db = new PostgresDb('postgres://u:p@127.0.0.1:5432/postgres', 1);
  return { db, query };
}

describe('§49 · assertSafeRole wiring', () => {
  it('throws when the connected role is a superuser', async () => {
    const { db, query } = await withStubbedPool({
      rolname: 'postgres', rolsuper: true, rolbypassrls: false, owned_tables: '0',
    });
    // The assertion: not merely that the policy is right, but that boot is refused.
    await expect(db.assertSafeRole()).rejects.toThrow(/refusing to start/i);
    await expect(db.assertSafeRole()).rejects.toThrow(/SUPERUSER/);
    expect(query).toHaveBeenCalled();
    vi.doUnmock('pg');
  });

  it('resolves for the restricted role', async () => {
    const { db } = await withStubbedPool({
      rolname: 'portal_api', rolsuper: false, rolbypassrls: false, owned_tables: '0',
    });
    await expect(db.assertSafeRole()).resolves.toBeUndefined();
    vi.doUnmock('pg');
  });

  it('throws when the role cannot be determined at all', async () => {
    /*
      Fail closed. An empty result means the identity of the connection is
      unknown, and an unknown identity cannot be cleared — so it is treated the
      same as a known-bad one rather than assumed benign.
    */
    const { db } = await withStubbedPool(null);
    await expect(db.assertSafeRole()).rejects.toThrow(/could not determine/i);
    vi.doUnmock('pg');
  });

  it('reads ownership, not just the role flags', async () => {
    // OWNERSHIP is a separate column in the query. If the SQL ever stops
    // selecting it, a non-superuser table owner silently becomes "safe".
    const { db, query } = await withStubbedPool({
      rolname: 'sneaky_owner', rolsuper: false, rolbypassrls: false, owned_tables: '12',
    });
    await expect(db.assertSafeRole()).rejects.toThrow(/owns 12 table/i);
    const sql = String(query.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain('relowner');
    expect(sql).toContain('rolbypassrls');
    expect(sql).toContain('rolsuper');
    expect(sql).toContain('current_user');
    vi.doUnmock('pg');
  });
});
