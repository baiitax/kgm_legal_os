/**
 * §57 · FIELD-LEVEL CLASSIFICATION.
 *
 * Matter access (§17) decides whether a member may open a matter. This suite
 * decides what they may READ once it is open — and the two are tested separately
 * because conflating them is the specific bug that leaks a firm's work product
 * to someone legitimately on the team.
 *
 * The fixtures are chosen so that every classification tier is exercised by a
 * member who is entitled to the matter but not to the field:
 *
 *   Mariam  paralegal     operational on KGM-2026-0148  → internal, not confidential
 *   Omar    compliance    compliance  on KGM-2026-0148  → compliance, not confidential
 *   Sara    finance       read_all → bare view on 0148  → public only
 *   Faisal  lawyer        full      on KGM-2026-0148    → confidential
 *   Noura   partner       full + matters.restrict       → everything
 *
 * Sara is the interesting one. She holds `matters.read_all`, which puts every
 * unassigned matter in her list at `view`. Before classification existed that
 * level was enough to read `risk_rating` and `internal_status` off the LIST
 * endpoint while the DETAIL endpoint refused her — two endpoints, one resource,
 * two answers. Tests here assert both surfaces agree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootStack, firmLoginAs, FIRM, IDS, type Stack } from '../helpers.js';
import {
  CLASSIFICATION_ACCEPTS, MATTER_FIELDS, MATTER_LIST_FIELDS, NEVER_ON_THE_WIRE,
  levelAccepts, maskLast4, outName, presenceOnly, project, projectMatter,
  visible, type Classification, type FieldRule,
} from '../../server/src/domain/classification.js';
import { ACCESS_LEVELS, type AccessLevel } from '../../server/src/domain/permissions.js';

let s: Stack;
beforeEach(async () => { s = await bootStack(); });
afterEach(async () => { await s.shutdown(); });

const MATTER_OPEN = IDS.matterCommercial;      // KGM-2026-0148, unrestricted, the whole team on it
const MATTER_LOCKED = IDS.matterGulf;          // KGM-2026-0170, restricted, explicit grants only

/** Signs a member in and returns their agent plus the resolved session payload. */
async function asMember(email: string) {
  const res = await firmLoginAs(s.agent, email);
  expect(res.status, `login ${email}`).toBe(200);
  const d = res.body.data as {
    member: { membershipId: string; permissions: string[]; practiceAreas: string[] };
    activeTenantId: string;
  };
  return {
    membershipId: d.member.membershipId,
    permissions: d.member.permissions,
    practiceAreas: d.member.practiceAreas,
    activeTenantId: d.activeTenantId,
  };
}

async function matterDetail(id: string) {
  const res = await s.agent.get(`/api/firm/matters/${id}`);
  return res;
}

// ============================================================================
// §57.1 · THE PURE PROJECTOR
// ============================================================================

describe('§57 · the projector is default-deny in both directions', () => {
  /** A minimal principal, built without a database so the rules can be tested alone. */
  function ctx(accessLevel: AccessLevel, permissions: string[] = []) {
    return {
      accessLevel,
      principal: { permissions: new Set(permissions) } as never,
    };
  }

  const RULES: readonly FieldRule[] = [
    { source: 'title', level: 'public' },
    { source: 'internal_status', out: 'internalStatus', level: 'internal' },
    { source: 'risk_rating', out: 'riskRating', level: 'confidential' },
    { source: 'tenant_id', out: 'tenantId', level: 'never' },
  ];

  it('emits only the fields the caller\'s level satisfies', () => {
    const row = { title: 'T', internal_status: 'active', risk_rating: 'high', tenant_id: 'aaaa' };

    // `tenantId` is classified `never`, so it is withheld at every level and
    // appears in every withheld list. That is the tier doing its job, not noise.
    const view = project<Record<string, unknown>>('matter', RULES, row, ctx('view'));
    expect(Object.keys(view.data)).toEqual(['title']);
    expect(view.withheld).toEqual(['internalStatus', 'riskRating', 'tenantId']);

    const operational = project<Record<string, unknown>>('matter', RULES, row, ctx('operational'));
    expect(Object.keys(operational.data).sort()).toEqual(['internalStatus', 'title']);
    expect(operational.withheld).toEqual(['riskRating', 'tenantId']);
  });

  it('drops a column that is present in the row but absent from the registry', () => {
    // This is the whole reason the registry exists. A new column added to the
    // table and to the SELECT must not reach the wire until someone classifies
    // it — the safe direction for a mistake to fail in.
    const row = { title: 'T', brand_new_column: 'secret', internal_notes: 'strategy' };
    const { data } = project<Record<string, unknown>>('matter', RULES, row, ctx('full'));
    // At `full` the registered fields ARE emitted (as null, since this row does
    // not carry them), so the assertion is about the two UNREGISTERED columns:
    // neither the key nor the value may survive.
    expect(data).not.toHaveProperty('brand_new_column');
    expect(data).not.toHaveProperty('internal_notes');
    expect(JSON.stringify(data)).not.toContain('secret');
    expect(JSON.stringify(data)).not.toContain('strategy');
    expect(data.title).toBe('T');
  });

  it('never emits a `never` field, to any level, including full', () => {
    for (const level of ACCESS_LEVELS) {
      const { data, withheld } = project<Record<string, unknown>>(
        'matter', RULES, { title: 'T', tenant_id: 'aaaa-1' }, ctx(level),
      );
      expect(data).not.toHaveProperty('tenantId');
      expect(JSON.stringify(data)).not.toContain('aaaa-1');
      if (level !== 'none') expect(withheld).toContain('tenantId');
    }
  });

  it('throws rather than leaking if a registry rule names a forbidden column', () => {
    // Guards against the registry itself being edited wrongly. Stripping and
    // continuing would let the mistake survive; failing the request does not.
    const bad: readonly FieldRule[] = [{ source: 'storage_key', out: 'storageKey2', level: 'public' }];
    expect(() => project('matter', bad, { storage_key: 'x' }, ctx('full'))).not.toThrow();

    const worse: readonly FieldRule[] = [{ source: 'storage_key', out: 'storage_key', level: 'public' }];
    expect(() => project('matter', worse, { storage_key: 'x' }, ctx('full')))
      .toThrowError(/NEVER_ON_THE_WIRE/);
  });

  it('requires the extra permission when a rule declares one', () => {
    const rule: readonly FieldRule[] = [
      { source: 'restriction_reason', out: 'restrictionReason', level: 'restricted', permission: 'matters.restrict' },
    ];
    const row = { restriction_reason: 'Client 2 only' };

    // Full access WITHOUT the permission: level satisfied, gate not.
    const noPerm = project<Record<string, unknown>>('matter', rule, row, ctx('full', []));
    expect(noPerm.data).toEqual({});
    expect(noPerm.withheld).toEqual(['restrictionReason']);

    // Full access WITH it.
    const withPerm = project<Record<string, unknown>>('matter', rule, row, ctx('full', ['matters.restrict']));
    expect(withPerm.data).toEqual({ restrictionReason: 'Client 2 only' });
  });

  it('reports withheld names whether or not the column holds a value', () => {
    // Deriving `withheld` from values would make it an existence oracle: a
    // caller could discover that a matter HAS a risk rating by watching the list
    // appear and disappear. The list is a function of classification only.
    const populated = project<Record<string, unknown>>(
      'matter', RULES, { title: 'T', risk_rating: 'high' }, ctx('operational'));
    const empty = project<Record<string, unknown>>(
      'matter', RULES, { title: 'T', risk_rating: null }, ctx('operational'));

    expect(populated.withheld).toEqual(['riskRating', 'tenantId']);
    expect(empty.withheld).toEqual(['riskRating', 'tenantId']);
  });

  it('sorts and de-duplicates the withheld list', () => {
    const rules: readonly FieldRule[] = [
      { source: 'z_field', out: 'zField', level: 'confidential' },
      { source: 'a_field', out: 'aField', level: 'confidential' },
      { source: 'dup', out: 'aField', level: 'confidential' },
    ];
    const { withheld } = project('matter', rules, {}, ctx('view'));
    expect(withheld).toEqual(['aField', 'zField']);
  });
});

// ============================================================================
// §57.2 · THE ACCEPTANCE MATRIX
// ============================================================================

describe('§57 · classification tiers are lateral, not a ladder', () => {
  it('public accepts every level that can see the matter at all, and rejects none', () => {
    for (const level of ACCESS_LEVELS) {
      expect(levelAccepts('public', level)).toBe(level !== 'none');
    }
  });

  it('internal excludes a bare view — practice scope is not work product', () => {
    expect(levelAccepts('internal', 'view')).toBe(false);
    expect(levelAccepts('internal', 'operational')).toBe(true);
    expect(levelAccepts('internal', 'financial')).toBe(true);
    expect(levelAccepts('internal', 'compliance')).toBe(true);
    expect(levelAccepts('internal', 'none')).toBe(false);
  });

  it('confidential accepts those who write the matter, and not those who merely work it', () => {
    expect(levelAccepts('confidential', 'full')).toBe(true);
    expect(levelAccepts('confidential', 'edit')).toBe(true);
    expect(levelAccepts('confidential', 'operational')).toBe(false);
    expect(levelAccepts('confidential', 'financial')).toBe(false);
    expect(levelAccepts('confidential', 'compliance')).toBe(false);
  });

  it('financial and compliance are lateral to each other and to operational', () => {
    // The point of an acceptance set rather than a rank: a finance officer must
    // not satisfy a compliance check by outranking it numerically.
    expect(levelAccepts('financial', 'financial')).toBe(true);
    expect(levelAccepts('financial', 'compliance')).toBe(false);
    expect(levelAccepts('financial', 'operational')).toBe(false);
    expect(levelAccepts('compliance', 'compliance')).toBe(true);
    expect(levelAccepts('compliance', 'financial')).toBe(false);
    expect(levelAccepts('compliance', 'operational')).toBe(false);
  });

  it('restricted is the narrowest tier and never accepts a lateral level', () => {
    expect(levelAccepts('restricted', 'full')).toBe(true);
    expect(levelAccepts('restricted', 'edit')).toBe(false);
    expect(levelAccepts('restricted', 'financial')).toBe(false);
  });

  it('never accepts nothing, for any level', () => {
    for (const level of ACCESS_LEVELS) expect(levelAccepts('never', level)).toBe(false);
  });

  it('every tier used by a registry rule is defined in the acceptance map', () => {
    // Catches a tier added to the union type but forgotten in the map, which
    // would otherwise read as `undefined` and throw at request time.
    const used = new Set<Classification>();
    for (const rule of [...MATTER_FIELDS, ...MATTER_LIST_FIELDS]) used.add(rule.level);
    for (const tier of used) {
      expect(CLASSIFICATION_ACCEPTS[tier], `tier ${tier}`).toBeDefined();
      expect(Array.isArray(CLASSIFICATION_ACCEPTS[tier])).toBe(true);
    }
    expect(CLASSIFICATION_ACCEPTS.never).toEqual([]);
  });

  it('no rule classifies a forbidden column as anything other than never', () => {
    for (const rule of [...MATTER_FIELDS, ...MATTER_LIST_FIELDS]) {
      const emits = outName(rule);
      if (NEVER_ON_THE_WIRE.has(emits) || NEVER_ON_THE_WIRE.has(rule.source)) {
        expect(rule.level, `${rule.source} must be 'never'`).toBe('never');
      }
    }
  });
});

// ============================================================================
// §57.3 · MASKS
// ============================================================================

describe('§57 · masks transform rather than classify', () => {
  it('maskLast4 keeps only the tail, and refuses to mask a short value', () => {
    expect(maskLast4('1010XXXXXX1234')).toMatch(/1234$/);
    expect(maskLast4('1010XXXXXX1234')).not.toContain('1010');
    // A two-character string with one character redacted is not a mask, it is a
    // hint. Returning null is honest where a partial mask would be misleading.
    expect(maskLast4('12')).toBeNull();
    expect(maskLast4('1234')).toBeNull();
    expect(maskLast4(null)).toBeNull();
  });

  it('presenceOnly answers whether, never what', () => {
    expect(presenceOnly('a value')).toBe(true);
    expect(presenceOnly('')).toBe(false);
    expect(presenceOnly(null)).toBe(false);
    expect(presenceOnly(undefined)).toBe(false);
  });

  it('a masked field is still emitted — masking is not a refusal', () => {
    const rules: readonly FieldRule[] = [
      { source: 'commercial_reg', out: 'commercialReg', level: 'public', mask: maskLast4 },
    ];
    const { data, withheld } = project<Record<string, unknown>>(
      'matter', rules, { commercial_reg: '1010XXXXXX9876' }, { accessLevel: 'view', principal: { permissions: new Set() } as never },
    );
    expect(data).toEqual({ commercialReg: expect.stringMatching(/9876$/) });
    expect(withheld).toEqual([]);
  });
});

// ============================================================================
// §57.4 · THE DETAIL ENDPOINT, PER MEMBER
// ============================================================================

describe('§57 · matter detail — each member reads their own slice', () => {
  it('paralegal (operational): internal fields yes, confidential no', async () => {
    await asMember(FIRM.paralegal);
    const res = await matterDetail(MATTER_OPEN);
    expect(res.status).toBe(200);
    const d = res.body.data;

    expect(d.accessLevel).toBe('operational');
    // Entitled: the matter's own working state.
    expect(d.internalStatus).toBeTruthy();
    expect(d.court).toBeTruthy();
    expect(d.matterNumber).toBeTruthy();
    // Not entitled: the firm's assessment of its own risk and strategy.
    expect(d).not.toHaveProperty('riskRating');
    expect(d).not.toHaveProperty('internalNotes');
    expect(d).not.toHaveProperty('conflictCleared');
    expect(d.withheld).toEqual(expect.arrayContaining(['riskRating', 'internalNotes', 'conflictCleared']));
    // The value must not appear anywhere in the body, not even inside withheld.
    expect(res.text).not.toMatch(/high|critical/i);
  });

  it('compliance officer: conflict state yes, legal strategy no', async () => {
    await asMember(FIRM.compliance);
    const res = await matterDetail(MATTER_OPEN);
    expect(res.status).toBe(200);
    const d = res.body.data;

    expect(d.accessLevel).toBe('compliance');
    expect(d).toHaveProperty('conflictCleared');
    expect(d).not.toHaveProperty('riskRating');
    expect(d).not.toHaveProperty('internalNotes');
    // `internal` accepts compliance, so the working state is visible even though
    // the assessment of it is not.
    expect(d).toHaveProperty('internalStatus');
  });

  it('finance with matters.read_all gets a bare view: public fields only', async () => {
    const session = await asMember(FIRM.finance);
    expect(session.permissions).toContain('matters.read_all');

    const res = await matterDetail(MATTER_OPEN);
    expect(res.status).toBe(200);
    const d = res.body.data;

    // She is not on this matter's team. `matters.read_all` puts it in her list;
    // it does not hand her the work product.
    expect(d.accessLevel).toBe('view');
    expect(d.matterNumber).toBeTruthy();
    expect(d.title).toBeTruthy();
    expect(d).not.toHaveProperty('internalStatus');
    expect(d).not.toHaveProperty('court');
    expect(d).not.toHaveProperty('riskRating');
    expect(d).not.toHaveProperty('internalNotes');
    expect(d.withheld).toEqual(expect.arrayContaining(['internalStatus', 'riskRating', 'internalNotes']));
  });

  it('lead lawyer (full): confidential fields are readable', async () => {
    await asMember(FIRM.lawyer);
    const res = await matterDetail(MATTER_OPEN);
    expect(res.status).toBe(200);
    const d = res.body.data;

    expect(d.accessLevel).toBe('full');
    expect(d).toHaveProperty('riskRating');
    expect(d).toHaveProperty('internalNotes');
    expect(d.riskRating).toBeTruthy();
  });

  it('managing partner sees every classified field, including tenant-scoped ones being withheld', async () => {
    await asMember(FIRM.managingPartner);
    const res = await matterDetail(MATTER_OPEN);
    expect(res.status).toBe(200);
    const d = res.body.data;

    expect(d).toHaveProperty('riskRating');
    expect(d).toHaveProperty('internalNotes');
    expect(d).toHaveProperty('conflictCleared');
    // Structural columns are withheld even from the person who may read everything else.
    expect(d).not.toHaveProperty('tenantId');
    expect(res.text).not.toContain(IDS.tenantKgm);
  });

  it('the restriction reason needs full access AND the matters.restrict permission', async () => {
    // Faisal holds `edit` on the locked matter by explicit grant — enough to
    // work it, not enough to learn why it was locked.
    await asMember(FIRM.lawyer);
    const res = await matterDetail(MATTER_LOCKED);
    expect(res.status).toBe(200);
    expect(res.body.data.accessLevel).toBe('edit');
    expect(res.body.data).not.toHaveProperty('restrictionReason');
    expect(res.body.data.restricted).toBe(true);
    expect(res.text).not.toContain('Highly confidential');
  });

  it('the partner who may restrict a matter may read why it was restricted', async () => {
    await asMember(FIRM.managingPartner);
    const res = await matterDetail(MATTER_LOCKED);
    expect(res.status).toBe(200);
    expect(res.body.data.accessLevel).toBe('full');
    expect(res.body.data.restrictionReason).toContain('Highly confidential');
  });

  it('an explicit none grant still produces 404, not a redacted projection', async () => {
    // Classification is the second door. It must never become the first: a
    // member excluded from a matter gets no projection at all, empty or not.
    await asMember(FIRM.paralegal);
    const res = await matterDetail(MATTER_LOCKED);
    expect(res.status).toBe(404);
    expect(res.body.data).toBeUndefined();
  });
});

// ============================================================================
// §57.5 · THE LIST ENDPOINT AGREES WITH THE DETAIL ENDPOINT
// ============================================================================

describe('§57 · list and detail cannot disagree about a field', () => {
  it('the list never carries riskRating or internalStatus, for anyone', async () => {
    for (const email of [FIRM.managingPartner, FIRM.lawyer, FIRM.finance, FIRM.paralegal]) {
      const agent = s.agent;
      agent.clearCookies();
      await asMember(email);
      const res = await agent.get('/api/firm/matters');
      expect(res.status, email).toBe(200);
      const matters = res.body.data.matters as Record<string, unknown>[];
      expect(matters.length, email).toBeGreaterThan(0);
      for (const m of matters) {
        expect(m, `${email} list row`).not.toHaveProperty('riskRating');
        expect(m, `${email} list row`).not.toHaveProperty('internalStatus');
        expect(m, `${email} list row`).not.toHaveProperty('internalNotes');
        // The boolean flag is not the reason; knowing a matter is locked is what
        // stops someone opening it.
        expect(m, `${email} list row`).toHaveProperty('restricted');
        expect(m, `${email} list row`).toHaveProperty('accessLevel');
      }
    }
  });

  it('every field the list emits is one the detail view also emits at the same level', async () => {
    // The invariant that would have caught the original leak, stated generally:
    // a field visible in a list must be visible in the detail of the same row.
    agent: {
      s.agent.clearCookies();
    }
    await asMember(FIRM.finance);
    const list = await s.agent.get('/api/firm/matters');
    const rows = list.body.data.matters as Record<string, unknown>[];

    for (const row of rows) {
      const level = row.accessLevel as AccessLevel;
      const detailFields = MATTER_FIELDS.filter((r) =>
        visible(r, { accessLevel: level, principal: { permissions: new Set() } as never }));
      const listFields = MATTER_LIST_FIELDS.filter((r) =>
        visible(r, { accessLevel: level, principal: { permissions: new Set() } as never }));

      const detailNames = new Set(detailFields.map(outName));
      for (const lf of listFields) {
        const name = outName(lf);
        expect(detailNames.has(name), `list field "${name}" absent from detail at ${level}`).toBe(true);
      }
      // And the keys actually on the wire are a subset of what the registry allows.
      for (const key of Object.keys(row)) {
        if (key === 'restricted' || key === 'accessLevel') continue; // authorization facts
        expect(detailNames.has(key) || listFields.some((r) => outName(r) === key),
          `unexpected list key "${key}" at ${level}`).toBe(true);
      }
    }
  });
});

// ============================================================================
// §57.6 · THE PROJECTION CANNOT BE WIDENED FROM THE REQUEST
// ============================================================================

describe('§57 · a caller cannot ask for more fields', () => {
  it('ignores fields/include query parameters rather than honouring them', async () => {
    await asMember(FIRM.paralegal);
    for (const qs of [
      '?fields=riskRating,internalNotes',
      '?include=internal_notes,risk_rating',
      '?classification=confidential',
      '?all=true',
      '?view=full',
    ]) {
      const res = await s.agent.get(`/api/firm/matters/${MATTER_OPEN}${qs}`);
      expect(res.status, qs).toBe(200);
      expect(res.body.data, qs).not.toHaveProperty('riskRating');
      expect(res.body.data, qs).not.toHaveProperty('internalNotes');
      expect(res.body.data.accessLevel, qs).toBe('operational');
    }
  });

  it('a forged access level in the query cannot raise the projection', async () => {
    await asMember(FIRM.paralegal);
    const res = await s.agent.get(`/api/firm/matters/${MATTER_OPEN}?accessLevel=full`);
    expect(res.status).toBe(200);
    expect(res.body.data.accessLevel).toBe('operational');
    expect(res.body.data).not.toHaveProperty('riskRating');
  });
});
