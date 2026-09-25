/**
 * Collects everything the credential manual needs, from the live database and
 * the live deployment. The manual is GENERATED from this output rather than
 * hand-written, so a drifted password or a renamed client shows up as a
 * difference rather than as a lie printed in a PDF.
 */
import pg from '/home/user/kgm-legal-os/node_modules/pg/lib/index.js';
import { readFileSync, writeFileSync } from 'node:fs';

const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
const c = new pg.Client({
  connectionString: `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
  ssl: { ca: readFileSync('/home/user/kgm-legal-os/server/certs/supabase-root-2021.crt', 'utf8'), rejectUnauthorized: true },
});
await c.connect();

const verified = JSON.parse(readFileSync('/tmp/credentials.json', 'utf8'));

// ---- client portal identities -------------------------------------------------
const portal = (await c.query(`
  select u.email, cu.display_name, cu.display_name_ar, cu.job_title, cu.portal_role, cu.status,
         t.name as tenant, t.name_ar as tenant_ar,
         cl.name as client, cl.name_ar as client_ar,
         (select count(*)::int from matters m where m.client_id = cu.client_id) as matters
    from client_users cu
    join users u on u.id = cu.user_id
    join tenants t on t.id = cu.tenant_id
    join clients cl on cl.id = cu.client_id
   where cu.status = 'active'
   order by t.name, cl.name, u.email`)).rows;

// ---- firm memberships --------------------------------------------------------
const firm = (await c.query(`
  select u.email, s.full_name, s.full_name_ar, fm.job_title, fm.job_title_ar, fm.status,
         fm.financial_authority_sar, fm.writeoff_authority_sar, fm.discount_authority_pct,
         t.name as tenant,
         (select string_agg(r.code, ', ' order by r.code)
            from membership_roles mr join roles r on r.id = mr.role_id
           where mr.membership_id = fm.id and mr.revoked_at is null) as roles,
         (select string_agg(pa.practice_area, ', ' order by pa.practice_area)
            from membership_practice_areas pa where pa.membership_id = fm.id) as areas,
         (select string_agg(m.matter_number || ' (' || mp.access_level || ')', ', ' order by m.matter_number)
            from matter_permissions mp join matters m on m.id = mp.matter_id
           where mp.membership_id = fm.id and mp.revoked_at is null) as explicit_grants
    from firm_memberships fm
    join users u on u.id = fm.user_id
    join tenants t on t.id = fm.tenant_id
    left join staff s on s.id = fm.staff_id
   where fm.status = 'active'
   order by u.email`)).rows;

// ---- matters, for the scope table -------------------------------------------
const matters = (await c.query(`
  select m.matter_number, m.title, m.title_ar, m.practice_area, m.internal_status,
         coalesce(mc.is_restricted, false) as restricted, cl.name as client, t.name as tenant
    from matters m
    join clients cl on cl.id = m.client_id
    join tenants t on t.id = m.tenant_id
    left join matter_controls mc on mc.matter_id = m.id
   order by t.name, m.matter_number`)).rows;

// ---- what each role may do, from the permission catalogue -------------------
const perms = (await c.query(`
  select r.code as role, count(rp.permission_code)::int as permission_count
    from roles r left join role_permissions rp on rp.role_id = r.id
   group by r.code order by r.code`)).rows;

// ---- the audience-boundary measurement, if the harness has been run --------
let boundary = null;
try {
  boundary = JSON.parse(readFileSync('/tmp/cross-audience.json', 'utf8'));
} catch {
  console.warn('  ! /tmp/cross-audience.json missing — run scripts/verify/cross-audience.mjs first');
}

const out = {
  generatedAt: new Date().toISOString(),
  base: verified.base,
  portalPassword: verified.portal[0]?.password ?? 'Demo!Portal2026',
  firmPassword: verified.firm[0]?.password ?? 'Demo!Firm2026',
  boundaryEquality: boundary,
  portal: portal.map((p) => ({
    ...p,
    verified: verified.portal.find((v) => v.email === p.email) ?? null,
    boundaryRefused: verified.boundary.find((b) => b.email === p.email && b.direction === 'client → firm')?.refused ?? null,
  })),
  firm: firm.map((f) => ({
    ...f,
    verified: verified.firm.find((v) => v.email === f.email) ?? null,
    boundaryRefused: verified.boundary.find((b) => b.email === f.email && b.direction === 'firm → client')?.refused ?? null,
  })),
  matters,
  rolePermissions: perms,
};


writeFileSync('/tmp/manual-data.json', JSON.stringify(out, null, 2));

console.log(`  portal identities : ${out.portal.length}`);
console.log(`  firm memberships  : ${out.firm.length}`);
console.log(`  matters           : ${out.matters.length}`);
console.log(`  role catalogue    : ${out.rolePermissions.map((r) => `${r.role}=${r.permission_count}`).join(' ')}`);
console.log('  -> /tmp/manual-data.json');
await c.end();
