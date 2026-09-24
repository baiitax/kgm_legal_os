import { useState, type FormEvent } from 'react';
import { get, post } from '../api/client';
import type { PrivacyOverview } from '../api/types';
import { translate, useI18n } from '../i18n';
import { pick } from '../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  ErrorAlert,
  Field,
  Icon,
  KeyValue,
  Modal,
  PageLoader,
  Select,
  StatusBadge,
  Textarea,
  useAsync,
} from '../components/ui';
import { PageHeader } from '../components/page';

/** The request types the endpoint accepts; the UI offers exactly these. */
const REQUEST_TYPES = ['access', 'rectification', 'erasure', 'portability', 'restriction', 'objection'] as const;

/**
 * Privacy centre (§27, PDPL-ready).
 *
 * Two design points are visible here on purpose:
 *
 *  · Deletion is a REQUEST, never an action. There is no DELETE route for the
 *    account, because retention obligations under Saudi professional rules have
 *    to be assessed by a person. The screen says so instead of offering a button
 *    that would either lie or bypass compliance.
 *  · Consent changes are recorded with the policy version and a timestamp, and
 *    the previous record stays in the audit log. Withdrawing consent is not the
 *    same as erasing data, and the copy does not pretend otherwise.
 */
export default function Privacy() {
  const { t, fmt, lang } = useI18n();
  const { data, error, loading, reload } = useAsync(() => get<PrivacyOverview>('/api/client/privacy'), []);

  const [requesting, setRequesting] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [busyPurpose, setBusyPurpose] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (loading && !data) return <PageLoader />;
  if (!data) return <ErrorAlert error={error} onRetry={reload} />;

  const priv = data;

  const toggleConsent = async (purpose: string, consented: boolean) => {
    setBusyPurpose(purpose);
    setActionError(null);
    setNotice(null);
    try {
      await post('/api/client/privacy/consent', { purpose, consented });
      reload();
      setNotice(t('priv.consentUpdated'));
    } catch (err) {
      setActionError(err);
    } finally {
      setBusyPurpose(null);
    }
  };

  const withdraw = async (id: string) => {
    setActionError(null);
    setNotice(null);
    try {
      await post(`/api/client/privacy/requests/${encodeURIComponent(id)}/withdraw`, {});
      setWithdrawing(null);
      reload();
      setNotice(t('priv.requestWithdrawn'));
    } catch (err) {
      setActionError(err);
    }
  };

  return (
    <>
      <PageHeader
        title={t('priv.title')}
        subtitle={t('priv.subtitle')}
        actions={
          <Button variant="primary" size="sm" onClick={() => setRequesting(true)}>
            <Icon name="plus" size={15} />
            {t('priv.newRequest')}
          </Button>
        }
      />

      {actionError ? <ErrorAlert error={actionError} /> : null}
      {notice && <Alert tone="ok">{notice}</Alert>}

      <div className="grid grid--2">
        <Card title={t('priv.requests')} hint={t('priv.requestsHint')}>
          {priv.requests.length === 0 ? (
            <Empty icon="doc" title={t('priv.noRequests')}>
              <Button variant="ghost" size="sm" onClick={() => setRequesting(true)}>
                <Icon name="plus" size={15} />
                {t('priv.newRequest')}
              </Button>
            </Empty>
          ) : (
            <ul className="list">
              {priv.requests.map((r) => (
                <li key={r.id} className="list__item">
                  <span className="list__icon">
                    <Icon name="doc" size={16} />
                  </span>
                  <span className="list__main">
                    <span className="list__title">{typeLabel(r.requestType)}</span>
                    {r.details && <span className="list__summary">{r.details}</span>}
                    <span className="list__meta">
                      <span>{fmt.dateTime(r.createdAt)}</span>
                      {r.resolvedAt && <span>{t('priv.resolved')}: {fmt.date(r.resolvedAt)}</span>}
                    </span>
                  </span>
                  <span className="list__end">
                    <StatusBadge status={r.status} prefix="priv.status" />
                    {canWithdraw(r.status) && (
                      <Button variant="ghost" size="sm" onClick={() => setWithdrawing(r.id)}>
                        <Icon name="close" size={14} />
                        {t('priv.withdraw')}
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div>
          <Card title={t('priv.consent')} hint={t('priv.consentHint')}>
            {priv.consents.length === 0 ? (
              <Empty icon="lock" title={t('common.none')} />
            ) : (
              <ul className="list">
                {priv.consents.map((c) => (
                  <li key={c.purpose} className="list__item">
                    <span className="list__main">
                      <span className="list__title">{purposeLabel(c.purpose)}</span>
                      <span className="list__meta">
                        <span>
                          {t('priv.retentionVersion')}: <span className="ltr mono">{c.policyVersion}</span>
                        </span>
                        <span>{fmt.date(c.recordedAt)}</span>
                      </span>
                    </span>
                    <span className="list__end">
                      <Badge tone={c.consented ? 'ok' : 'muted'}>
                        {c.consented ? t('priv.granted') : t('priv.withdrawn')}
                      </Badge>
                      {/* portal_access cannot be withdrawn from inside the portal:
                          leaving it off would make the account unusable, and the
                          server treats it as required for the session. */}
                      {c.purpose !== 'portal_access' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={busyPurpose === c.purpose}
                          onClick={() => void toggleConsent(c.purpose, !c.consented)}
                        >
                          {c.consented ? t('priv.withdraw') : t('priv.grant')}
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={t('priv.retention')}>
            <KeyValue
              items={[
                [
                  t('priv.retentionVersion'),
                  <span className="ltr mono" key="v">{priv.retention.policyVersion}</span>,
                ],
                [t('priv.retentionRule'), pick(lang, priv.retention.matterFileRetention, priv.retention.matterFileRetentionAr)],
              ]}
            />
            {priv.retention.deletionIsRequestOnly && (
              <Alert tone="warn" title={t('priv.deletionNote')}>
                {t('priv.deletionNoteBody')}
              </Alert>
            )}
          </Card>
        </div>
      </div>

      {requesting && (
        <RequestModal
          onClose={() => setRequesting(false)}
          onDone={() => {
            setRequesting(false);
            reload();
            setNotice(t('priv.requestCreated'));
          }}
        />
      )}

      {withdrawing && (
        <Modal
          open
          onClose={() => setWithdrawing(null)}
          title={t('priv.withdraw')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setWithdrawing(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" onClick={() => void withdraw(withdrawing)}>
                <Icon name="close" size={16} />
                {t('common.confirm')}
              </Button>
            </>
          }
        >
          <p>{t('priv.withdrawBody')}</p>
        </Modal>
      )}
    </>
  );

  const typeLabel = (type: string) => translate(lang, `priv.type.${type}`);
  const purposeLabel = (purpose: string) => translate(lang, `priv.purpose.${purpose}`);
}

/** Only a request still in flight can be withdrawn. */
function canWithdraw(status: string): boolean {
  return ['submitted', 'under_review', 'retention_assessment'].includes(status);
}

function RequestModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t, lang } = useI18n();
  const [requestType, setRequestType] = useState<(typeof REQUEST_TYPES)[number]>('access');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/client/privacy/requests', {
        requestType,
        details: details.trim() || undefined,
      });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('priv.newRequest')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="priv-form" variant="primary" loading={busy}>
            <Icon name="send" size={16} />
            {t('priv.submit')}
          </Button>
        </>
      }
    >
      <form id="priv-form" onSubmit={submit} noValidate>
        <Field label={t('priv.requestType')} htmlFor="pr-type">
          <Select
            id="pr-type"
            value={requestType}
            onChange={(e) => setRequestType(e.target.value as (typeof REQUEST_TYPES)[number])}
          >
            {REQUEST_TYPES.map((type) => (
              <option key={type} value={type}>
                {translate(lang, `priv.type.${type}`)}
              </option>
            ))}
          </Select>
        </Field>

        {requestType === 'erasure' && (
          <Alert tone="warn" title={t('priv.deletionNote')}>
            {t('priv.deletionNoteBody')}
          </Alert>
        )}

        <Field label={t('priv.details')} htmlFor="pr-details" hint={t('common.optional')}>
          <Textarea
            id="pr-details"
            rows={4}
            maxLength={2000}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
          />
        </Field>

        {error ? <ErrorAlert error={error} /> : null}
      </form>
    </Modal>
  );
}
