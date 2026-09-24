/**
 * ACTIVE SESSIONS · §48, §13
 *
 * Every device currently signed in as the member, and the control to end them all.
 *
 * MOUNTING IS THE FETCH
 *   The drawer that hosts this returns null while closed, so this component's
 *   effects do not run until the member opens their profile. That is deliberate:
 *   a session list is not worth a request on every shell render, and it should be
 *   current at the moment it is looked at rather than cached from page load.
 *
 * "REVOKE ALL" SIGNS YOU OUT HERE TOO
 *   `POST /session/revoke-all` calls `revokeAll(membershipId)` and then
 *   `clearCookies(res)` — it does not mean "sign out my other devices". It ends
 *   EVERY session for this membership, including the one making the request, and
 *   clears the cookie so the browser is left anonymous.
 *
 *   An administrator would not predict that from the label. So the consequence is
 *   stated on screen before the confirm appears, and the local session is cleared
 *   on success so the app routes to sign-in instead of rendering a shell whose
 *   every request now 401s. A control this destructive must not be a single click
 *   away from a label that reads like housekeeping.
 *
 * NO IP ADDRESS IS SHOWN, BECAUSE NONE IS SENT
 *   The route sets `ipHash: undefined` and returns only a coarse `ipCountry`. That
 *   is a projection choice on the server, and this component honours it by showing
 *   the country when present and nothing when not — rather than reconstructing a
 *   plausible-looking address, which would be fabricating an authorization fact.
 *
 * REVOKED SESSIONS STAY IN THE LIST
 *   A row with `revokedAt` remains visible and marked. Removing it would erase the
 *   evidence that a revocation happened, which is exactly what a member checking
 *   this panel is looking for after a suspected compromise.
 *
 * EXPIRY IS COMPUTED HERE, BECAUSE THE SERVER DOES NOT
 *   `listFirmSessions` selects every row for the membership with no filter on
 *   `revoked_at` or `expires_at` — it returns history, not the live set. Measured
 *   against the demo tenant, 12 of 17 rows were ALREADY EXPIRED while all 17 read
 *   as active.
 *
 *   Left uncorrected that is the worst kind of security screen: it overstates the
 *   exposure, so a member either panics at a number that is wrong or learns to
 *   ignore the count entirely. Sessions are therefore classified into three
 *   states, only genuinely live ones are counted, and the destructive button's
 *   count reflects what is actually signed in rather than how many rows exist.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Button, IconLogout, IconRefresh, IconShieldCheck, useFmt, useI18n,
} from '@kgm/ui';
import { firmApi, FirmApiError, type FirmDevice } from '../api/firm.js';
import { useFirmSession } from '../auth/FirmSession.js';

/**
 * A session's real state, derived from timestamps alone.
 *
 * Revoked beats expired: a session that was terminated AND later passed its expiry
 * was still actioned by someone, and reporting it as merely expired would hide the
 * fact that a revocation happened.
 */
function stateOf(s: FirmDevice, now: number): 'revoked' | 'expired' | 'active' {
  if (s.revokedAt) return 'revoked';
  // An absent expiry is treated as NOT expired rather than expired. Guessing that
  // an unknown deadline has passed would report live sessions as dead, which is the
  // more dangerous of the two errors on a security panel.
  if (s.expiresAt && Date.parse(s.expiresAt) < now) return 'expired';
  return 'active';
}

export function ActiveSessions() {
  const { t } = useI18n();
  const fmt = useFmt();
  const { signOut } = useFirmSession();

  const [sessions, setSessions] = useState<FirmDevice[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FirmApiError | null>(null);

  /** Whether the destructive confirm is showing. Two steps, never one. */
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    firmApi.devices()
      .then((res) => { setSessions(res.sessions); setError(null); })
      .catch((err) => {
        setSessions(null);
        setError(err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'unreachable'));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const revokeAll = async () => {
    setRevoking(true);
    try {
      await firmApi.revokeAllSessions();
      /*
        The session this request was made with no longer exists. Clearing local
        state is not bookkeeping — it is the only correct state afterwards, and it
        sends the member to sign-in rather than leaving a shell that 401s on every
        subsequent call.

        `signOut()` attempts a logout first, which will fail against an already
        revoked session; it swallows that, which is the behaviour this path wants.
      */
      await signOut();
    } catch {
      /*
        A failure here is genuinely ambiguous — the revoke may have succeeded and
        the response been lost — so the list is re-read rather than assumed. If the
        sessions are still live the member can try again; if they are gone, the
        reload shows that instead of a stale list asserting the opposite.
      */
      setConfirming(false);
      load();
    } finally {
      setRevoking(false);
    }
  };

  // ---- states ------------------------------------------------------------

  if (loading) {
    return (
      <div className="kgm-profile__section">
        <h3 className="kgm-profile__sectiontitle">{t('profile.sessions')}</h3>
        <p className="kgm-sessions__hint">{t('common.loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="kgm-profile__section">
        <h3 className="kgm-profile__sectiontitle">{t('profile.sessions')}</h3>
        <div className="kgm-sessions__error">
          <span>{t('profile.sessions.error')}</span>
          <Button variant="ghost" size="xs" icon={<IconRefresh size={13} />} onClick={load}>
            {t('common.retry')}
          </Button>
        </div>
      </div>
    );
  }

  const all = sessions ?? [];
  /*
    `Date.now()` is read once per render rather than per row so every row is
    classified against the same instant — otherwise a slow render could mark one
    session expired and an identical one live.
  */
  const now = Date.now();
  const live = all.filter((s) => stateOf(s, now) === 'active');
  /*
    The current session is listed first: it is the one the member means when they
    ask "am I signed in anywhere I shouldn't be". Live sessions then outrank ended
    ones, so a dozen expired rows cannot push a real one out of the first screen.
  */
  const rank = (s: FirmDevice) => (s.current ? 0 : stateOf(s, now) === 'active' ? 1 : 2);
  const ordered = [...all].sort((a, b) => rank(a) - rank(b));

  return (
    <div className="kgm-profile__section">
      <h3 className="kgm-profile__sectiontitle">{t('profile.sessions')}</h3>
      <p className="kgm-sessions__hint">{t('profile.sessions.sub')}</p>

      <ul className="kgm-sessions">
        {ordered.map((s) => {
          const state = stateOf(s, now);
          return (
          <li key={s.id} className="kgm-sessions__item" data-current={s.current || undefined}
              data-state={state}>
            <div className="kgm-sessions__head">
              <span className="kgm-sessions__device">
                {s.deviceLabel || t('profile.sessions.unknown')}
              </span>
              {s.current && <Badge tone="brand" size="xs">{t('profile.sessions.current')}</Badge>}
              {state === 'revoked' && <Badge tone="critical" size="xs">{t('profile.sessions.revoked')}</Badge>}
              {/* Expired is NOT the same as revoked: nothing was terminated, the
                  session simply ran out. Labelling one as the other would misreport
                  whether anyone acted on the account. */}
              {state === 'expired' && <Badge tone="neutral" size="xs">{t('profile.sessions.expired')}</Badge>}
            </div>

            {/* Parsed browser and OS, not the raw agent string: the raw string is
                unreadable at this size and the parse is already done server-side. */}
            <p className="kgm-sessions__spec" dir="ltr">
              {[s.browser, s.os].filter(Boolean).join(' · ') || '—'}
              {s.ipCountry ? ` · ${s.ipCountry}` : ''}
            </p>

            <dl className="kgm-sessions__meta">
              <div>
                <dt>{t('profile.sessions.lastActive')}</dt>
                <dd>
                  {s.lastActivity ? fmt.relative(s.lastActivity) : '—'}
                  {s.lastActivity && (
                    <span className="kgm-sessions__abs"> · {fmt.dateTime(s.lastActivity)}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>{t('profile.sessions.signedIn')}</dt>
                <dd>{fmt.dateTime(s.createdAt)}</dd>
              </div>
              <div>
                <dt>{t('profile.sessions.expires')}</dt>
                <dd>{s.expiresAt ? fmt.dateTime(s.expiresAt) : '—'}</dd>
              </div>
            </dl>

            {/*
              Per-session, not per-account. A member can have one session that
              cleared a second factor and another that did not, and the difference
              is the whole reason to look at this list.
            */}
            <p className="kgm-sessions__mfa" data-verified={s.mfaVerifiedAt ? true : undefined}>
              {s.mfaVerifiedAt
                ? (
                  <Badge tone="lime" size="xs" icon={<IconShieldCheck size={11} />}>
                    {t('profile.sessions.mfaVerified')}
                  </Badge>
                )
                : (
                  <Badge tone="neutral" size="xs">
                    {t('profile.sessions.mfaNotVerified')}
                  </Badge>
                )}
            </p>
          </li>
          );
        })}
      </ul>

      {/*
        The consequence, stated BEFORE the confirm control appears — not in a
        dialog after the fact, and not as a toast that arrives once it is too late.
      */}
      {confirming ? (
        <>
          <Alert tone="warning">{t('profile.revokeAll.notice')}</Alert>
          <div className="kgm-sessions__actions">
            <Button
              variant="secondary" size="sm" block
              loading={revoking}
              onClick={() => void revokeAll()}
            >
              {t('profile.revokeAll.confirm')}
            </Button>
            <Button
              variant="ghost" size="sm" block
              disabled={revoking}
              onClick={() => setConfirming(false)}
            >
              {t('profile.revokeAll.cancel')}
            </Button>
          </div>
        </>
      ) : (
        /*
          The count is LIVE SESSIONS, not rows. The server's `revoked` return value
          counts every non-revoked row it touched — including long-expired ones —
          so showing that number would claim more exposure than exists.

          Disabled when the current session is the only live one: ending it is just
          signing out, which the button below already does, and offering it here
          would imply a security action that changes nothing.
        */
        <Button
          variant="ghost" size="sm" block
          icon={<IconLogout size={15} />}
          disabled={live.length <= 1}
          onClick={() => setConfirming(true)}
        >
          {t('profile.revokeAll')}
          {live.length > 1 && ` (${fmt.numberLatin(live.length)})`}
        </Button>
      )}
    </div>
  );
}
