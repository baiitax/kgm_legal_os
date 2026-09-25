/**
 * SIGN IN · the firm OS defers to the central screen
 *
 * The product has ONE sign-in screen, at `/login`. This component is what the
 * firm application renders when it has no session, and it does not draw a form:
 * it forwards to that screen with `?as=firm`, which preselects the firm audience
 * and skips a choice the reader should not have to make twice.
 *
 * WHY THERE IS NO SECOND FORM HERE
 *   There used to be one. It was a good screen — MFA, lockout copy keyed off the
 *   server's error code, its own demo list — and every part of it was a second
 *   place the product could drift from its own security model. Two sign-in
 *   screens means two places to remember that a refusal at the wrong door must
 *   be worded exactly like a wrong password, two places to add an error code,
 *   and, in practice, one place that gets the fix and one that does not. That is
 *   not hypothetical: the portal door shipped a 403 where a 401 belonged while
 *   the firm door was already correct.
 *
 * WHAT DID NOT MOVE
 *   The authorization model. This is a redirect, not a relaxation. The firm API
 *   still refuses a client's credential and still refuses an unknown one with
 *   the same answer, and the audience is DECLARED on the central screen rather
 *   than inferred from a response — so the screen cannot be used to work out
 *   whether an address is real.
 *
 * THE DEEP LINK
 *   The firm OS routes on the hash, so a member who follows a shared link to a
 *   matter while signed out would otherwise lose it. The current hash is carried
 *   through `?next=` and restored after sign-in.
 */
import { useEffect } from 'react';
import { useI18n } from '@kgm/ui';

export function SignIn() {
  const { t } = useI18n();

  useEffect(() => {
    const hash = window.location.hash && window.location.hash !== '#/' ? window.location.hash : '';
    const target = `/login?as=firm${hash ? `&next=${encodeURIComponent(hash)}` : ''}`;
    // `replace`, so Back does not bounce between the two screens.
    window.location.replace(target);
  }, []);

  /*
    While the navigation is in flight — and if it is ever blocked — this renders
    a plain, translated line rather than a blank page or a flash of a form that
    does not work. It mirrors the shell's own loading treatment.
  */
  return (
    <div className="firm-auth" role="status" aria-live="polite">
      <main className="firm-auth__form">
        <div className="firm-auth__card">
          <p className="firm-auth__cardsub">{t('auth.redirecting')}</p>
        </div>
      </main>
    </div>
  );
}
