/**
 * DEMO CREDENTIALS · the synthetic accounts behind both doors.
 *
 * This is the same list the manual in `/home/user/KGM-LEGAL-OS-Test-Credentials.pdf`
 * documents and the same accounts the security harnesses sign in with. It lives
 * here so the sign-in screen can offer them, and it is deliberately a plain
 * constant rather than a fetch: a sign-in screen that has to call an API before
 * it can tell you how to sign in is a sign-in screen that is unavailable exactly
 * when you need it.
 *
 * THE ACCOUNTS ARE NOT EQUIVALENT, AND THE LIST SAYS SO
 *   Each row carries what the account is FOR — a client with three matters, a
 *   member with a financial ceiling — because the fastest way to see the
 *   authorization model work is to sign in as two different members and watch
 *   the navigation change. A bare email list invites the reader to assume every
 *   account sees the same thing, which is the one thing this product is built to
 *   prevent.
 *
 * GATED, LIKE THE FIRM'S LIST
 *   Rendered only when `VITE_SHOW_DEMO_ACCOUNTS=1`. The build that deploys the
 *   demo sets it; a real deployment does not, and the screen then shows a normal
 *   sign-in form with no credentials on it.
 */
import type { MessageKey } from '../i18n';

export type Audience = 'client' | 'firm';

export interface DemoAccount {
  readonly email: string;
  /** Label for what the account is, translated at render time. */
  readonly roleKey: MessageKey;
  /** What the account can actually reach. Plain text: these are facts, not copy. */
  readonly scope: string;
  readonly audience: Audience;
}

/** The portal password, shared by every client account on the demo. */
export const DEMO_PORTAL_PASSWORD = 'Demo!Portal2026';

/** The firm password, shared by every member account on the demo. */
export const DEMO_FIRM_PASSWORD = 'Demo!Firm2026';

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  // ---- client portal -------------------------------------------------------
  {
    email: 'ahmed.alsaud@example.test',
    roleKey: 'auth.demoPortalPrimary',
    scope: '3 matters · KGM-2026-0148, 0151, 0163',
    audience: 'client',
  },
  {
    email: 'finance@gulfhorizon.example.test',
    roleKey: 'auth.demoPortalFinance',
    scope: 'restricted matter · KGM-2026-0170 only',
    audience: 'client',
  },
  {
    email: 'layla.mansour@example.test',
    roleKey: 'auth.demoPortalOther',
    scope: '1 matter · NLP-2026-0021, a different firm',
    audience: 'client',
  },

  // ---- internal firm OS ---------------------------------------------------
  {
    email: 'noura@kgm.example.test',
    roleKey: 'auth.demoPartner',
    scope: 'all practice areas · 500k SAR ceiling · 4 matters',
    audience: 'firm',
  },
  {
    email: 'faisal@kgm.example.test',
    roleKey: 'auth.demoLawyer',
    scope: 'litigation, real estate · no financial authority · 3 matters',
    audience: 'firm',
  },
  {
    email: 'mariam@kgm.example.test',
    roleKey: 'auth.demoParalegal',
    scope: 'commercial litigation only · 1 matter',
    audience: 'firm',
  },
  {
    email: 'omar@kgm.example.test',
    roleKey: 'auth.demoCompliance',
    scope: 'compliance · assigned matters only · 1 matter',
    audience: 'firm',
  },
  {
    email: 'sara@kgm.example.test',
    roleKey: 'auth.demoFinance',
    scope: 'billing.read_all · 25k SAR ceiling · 4 matters',
    audience: 'firm',
  },
];

/** Whether the build offers the synthetic accounts on the sign-in screen. */
export const SHOW_DEMO_ACCOUNTS = import.meta.env.VITE_SHOW_DEMO_ACCOUNTS === '1';

export const passwordFor = (audience: Audience): string =>
  audience === 'firm' ? DEMO_FIRM_PASSWORD : DEMO_PORTAL_PASSWORD;

export const accountsFor = (audience: Audience): readonly DemoAccount[] =>
  DEMO_ACCOUNTS.filter((a) => a.audience === audience);
