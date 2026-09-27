/**
 * THE FIRM'S TAX IDENTITY · recommendation 2 of the audit
 *
 * WHAT WAS MISSING, AND WHAT IT COST. The server has been able to issue a Saudi tax
 * invoice since 0034: it allocates the next counter (ICV), links the hash chain, builds
 * the QR payload and the UBL XML, and refuses to issue at all without a production
 * identity and an active device. What no screen could do was SET THAT UP or READ WHAT IT
 * SAID. So the firm's tax identity, its device, the reporting queue and the submission
 * log were reachable by an engineer and by nothing else — `GET/POST billing/fiscal-identity`,
 * `POST billing/fiscal-devices` and `GET billing/reporting-queue` sat in the audit's list
 * of routes with no screen, which is the largest category of finding in the whole review.
 *
 * THREE THINGS ABOUT THIS SCREEN THAT ARE NOT OBVIOUS
 *
 *   1 · `ready: false` IS NOT AN ERROR AND NOT AN EMPTY STATE. It is the honest answer to
 *       "may this firm legally send a tax invoice?", and the server returns it WITH the
 *       list of missing conditions. The banner below renders each blocker in the firm's
 *       own words rather than a generic failure, because a firm that has not integrated is
 *       not broken — it is a firm that must not send a tax invoice yet, and the screen's
 *       job is to say which part of the onboarding is undone.
 *
 *   2 · THE ONBOARDING STATUS IS A FORM FIELD AND THAT IS A COMPROMISE. Real ZATCA
 *       onboarding exchanges a CSR for a compliance certificate, then a production one.
 *       Until that integration exists, the status is recorded by hand — and the screen
 *       says so, in a note, rather than presenting the dropdown as if it were the
 *       integration. A screen that implied more than it does would be worse than no
 *       screen: the audit's finding was precisely that invoices LOOKED issued.
 *
 *   3 · THE 24-HOUR CLOCK IS SHOWN, NOT STORED. `reportBy` is computed by the server from
 *       the time of supply (a simplified invoice must be reported within 24 hours), so
 *       this page displays the deadline it is given rather than calculating a second one
 *       that could disagree with the first.
 */
import { useEffect, useState } from 'react';
import {
  Badge, Button, Card, CardBody, EmptyState, IconBilling, IconCheck, IconLicences, IconRefresh,
  Modal, PageSkeleton, SelectField, Table, TextField, useI18n, useToast, type Column,
} from '@kgm/ui';
import {
  FirmApiError, firmApi, type FiscalDevice, type FiscalIdentityResponse, type ReportingQueueRow,
} from '../api/firm.js';
import { useFirmSession } from '../auth/FirmSession.js';
import '../shell/shell.css';

interface FiscalProps {
  readonly onNavigate: (to: string) => void;
}

/** How each missing condition is explained to a reader who is not an engineer. */
const BLOCKER_COPY: Record<string, { title: string; body: string }> = {
  no_fiscal_identity: {
    title: 'fiscal.blocker.identity',
    body: 'fiscal.blocker.identityBody',
  },
  onboarding_incomplete: {
    title: 'fiscal.blocker.onboarding',
    body: 'fiscal.blocker.onboardingBody',
  },
  no_active_device: {
    title: 'fiscal.blocker.device',
    body: 'fiscal.blocker.deviceBody',
  },
};

export function Fiscal({ onNavigate }: FiscalProps) {
  const { t, lang } = useI18n();
  const { can } = useFirmSession();

  /*
    THE READER'S LANGUAGE DECIDES WHICH REGISTERED NAME AND ADDRESS TO SHOW, and this is a
    correction rather than a preference. The house `pick(primary, secondary)` returns the
    first non-empty value — it is a FALLBACK helper, not a language switch — so
    `pick(arabic, english)` prints Arabic to an English reader. On this page that matters
    twice over: the registered name and address are what the firm's own tax documents carry,
    and a member checking them against a certificate must see the same script they are
    looking at. Both are shown in full in the form; the page shows the one for this reader.
  */
  const byLang = (ar: string | null | undefined, en: string | null | undefined): string => {
    const first = lang === 'ar' ? ar : en;
    const second = lang === 'ar' ? en : ar;
    if (first && first.trim()) return first;
    if (second && second.trim()) return second;
    return '—';
  };

  const [data, setData] = useState<FiscalIdentityResponse | null>(null);
  const [queue, setQueue] = useState<ReportingQueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FirmApiError | null>(null);
  const [editing, setEditing] = useState(false);
  const [addingDevice, setAddingDevice] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([firmApi.fiscalIdentity(), firmApi.reportingQueue().catch(() => ({ count: 0, overdue: 0, invoices: [] }))])
      .then(([identity, q]) => { setData(identity); setQueue(q.invoices); setError(null); })
      .catch((err) => {
        setData(null);
        setError(err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'unreachable'));
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const deviceColumns: ReadonlyArray<Column<FiscalDevice>> = [
    {
      key: 'label', header: t('fiscal.device.label'), responsive: 'card', cardLabel: t('fiscal.device.label'),
      cell: (d) => (
        <span className="firm-fiscal__device">
          <span>{d.label}</span>
          <span className="c-muted num firm-fiscal__serial">{d.serial}</span>
        </span>
      ),
    },
    {
      key: 'counter', header: t('fiscal.device.counter'), responsive: 'card',
      cardLabel: t('fiscal.device.counter'), width: '10rem',
      cell: (d) => (
        <span className="num">
          {d.counterValue}
          {/* The counter IS the ICV the next invoice carries. Saying so here saves a
              support question every time a ZATCA report arrives with a number in it. */}
          <span className="c-muted firm-fiscal__hint">{t('fiscal.device.nextIcv')}</span>
        </span>
      ),
    },
    {
      key: 'chain', header: t('fiscal.device.chain'), responsive: 'card',
      cardLabel: t('fiscal.device.chain'), width: '9rem',
      cell: (d) => (
        <Badge tone={d.hasChainHead ? 'lime' : 'neutral'}>
          {d.hasChainHead ? t('fiscal.device.chained') : t('fiscal.device.genesis')}
        </Badge>
      ),
    },
    {
      key: 'active', header: t('fiscal.device.state'), responsive: 'card',
      cardLabel: t('fiscal.device.state'), width: '8rem',
      cell: (d) => (
        <Badge tone={d.isActive ? 'lime' : 'warning'}>
          {d.isActive ? t('fiscal.device.active') : t('fiscal.device.inactive')}
        </Badge>
      ),
    },
  ];

  const queueColumns: ReadonlyArray<Column<ReportingQueueRow>> = [
    {
      key: 'number', header: t('money.col.number'), responsive: 'card', cardLabel: t('money.col.number'),
      width: '11rem',
      cell: (r) => <span className="num firm-money__num">{r.number}</span>,
    },
    {
      key: 'supply', header: t('fiscal.queue.supply'), responsive: 'card',
      cardLabel: t('fiscal.queue.supply'),
      cell: (r) => <span className="num">{r.supplyAt ? String(r.supplyAt).slice(0, 16).replace('T', ' ') : '—'}</span>,
    },
    {
      key: 'total', header: t('money.col.total'), responsive: 'card', cardLabel: t('money.col.total'),
      width: '9rem', align: 'end',
      cell: (r) => <span className="num">{r.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>,
    },
    {
      key: 'due', header: t('fiscal.queue.reportBy'), responsive: 'card',
      cardLabel: t('fiscal.queue.reportBy'),
      cell: (r) => (
        <Badge tone={r.overdue ? 'high' : 'warning'}>
          {r.overdue
            ? t('fiscal.queue.overdue')
            : r.reportBy ? String(r.reportBy).slice(0, 16).replace('T', ' ') : t('fiscal.queue.unscheduled')}
        </Badge>
      ),
    },
  ];

  if (loading && !data) return <PageSkeleton title={t('fiscal.title')} />;

  if (error) {
    return (
      <div className="firm-page">
        <EmptyState
          kind="error"
          icon={<IconBilling />}
          title={t('fiscal.unavailable')}
          description={error.code === 'forbidden' ? t('fiscal.forbidden') : error.message}
          action={{ label: t('common.retry'), onClick: load }}
        />
      </div>
    );
  }

  const identity = data?.identity ?? null;
  const ready = data?.ready ?? false;

  return (
    <div className="firm-page firm-fiscal">
      <header className="firm-page__head">
        <div>
          <h1 className="firm-page__title">{t('fiscal.title')}</h1>
          <p className="firm-page__sub">{t('fiscal.subtitle')}</p>
        </div>
        <div className="firm-page__actions">
          <Button variant="ghost" icon={<IconRefresh size={16} />} onClick={load}>{t('common.refresh')}</Button>
        </div>
      </header>

      {/*
        THE READINESS BANNER. Green means the firm may legally issue; anything else names
        the missing conditions one by one. It is deliberately the first thing on the page:
        every other control here is trivia until this question is answered.
      */}
      <Card>
        <CardBody>
          <div className={`firm-fiscal__ready firm-fiscal__ready--${ready ? 'ok' : 'blocked'}`}>
            <div className="firm-fiscal__readyHead">
              <IconCheck size={18} />
              <strong>{ready ? t('fiscal.ready') : t('fiscal.notReady')}</strong>
              <Badge tone={identity?.environment === 'production' ? 'lime' : 'warning'}>
                {t(`fiscal.env.${identity?.environment ?? 'sandbox'}`)}
              </Badge>
            </div>
            <p className="firm-fiscal__readyBody">{ready ? t('fiscal.readyBody') : t('fiscal.notReadyBody')}</p>
            {(data?.blockers ?? []).length > 0 ? (
              <ul className="firm-fiscal__blockers">
                {data!.blockers.map((b) => (
                  <li key={b}>
                    <strong>{t(BLOCKER_COPY[b]?.title ?? b)}</strong>
                    <span>{t(BLOCKER_COPY[b]?.body ?? 'fiscal.blocker.unknown')}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </CardBody>
      </Card>

      {/* ── the registration itself ─────────────────────────────────────────── */}
      <Card>
        <CardBody>
          <div className="firm-fiscal__sectionHead">
            <h2 className="firm-fiscal__h2">{t('fiscal.identity')}</h2>
            {can('settings.manage') ? (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                {identity ? t('common.edit') : t('fiscal.identity.add')}
              </Button>
            ) : (
              /* §50: a screen may hide a control from a member who lacks the code, and can
                 never grant one. The server checks `settings.manage` on the write too. */
              <span className="c-muted firm-fiscal__hint">{t('fiscal.identity.readOnly')}</span>
            )}
          </div>

          {identity ? (
            <dl className="firm-fiscal__facts">
              <div><dt>{t('fiscal.field.registeredName')}</dt><dd>{byLang(identity.registered_name_ar, identity.registered_name)}</dd></div>
              <div><dt>{t('fiscal.field.vat')}</dt><dd className="num">{identity.vat_registration_number}</dd></div>
              <div><dt>{t('fiscal.field.cr')}</dt><dd className="num">{identity.commercial_registration}</dd></div>
              <div><dt>{t('fiscal.field.address')}</dt><dd>{byLang(identity.registered_address_ar, identity.registered_address)}</dd></div>
              {/* The city and the postal code are part of the National Address and they
                  print on the invoice, so they belong in the registration and not only in
                  the edit form — an omission the screen test caught, not a reviewer. */}
              <div>
                <dt>{t('fiscal.field.cityPostal')}</dt>
                <dd>{[identity.city, identity.postal_code].filter(Boolean).join(' · ') || '—'}</dd>
              </div>
              <div><dt>{t('fiscal.field.onboarding')}</dt><dd><Badge tone={identity.onboarding_status === 'production_csid' ? 'lime' : 'warning'}>{t(`fiscal.onboarding.${identity.onboarding_status}`)}</Badge></dd></div>
              <div>
                <dt>{t('fiscal.field.certificate')}</dt>
                <dd>{identity.certificate_expires_at
                  ? String(identity.certificate_expires_at).slice(0, 10)
                  : <span className="c-muted">{t('fiscal.field.noCertificate')}</span>}</dd>
              </div>
            </dl>
          ) : (
            <EmptyState
              kind="empty"
              icon={<IconLicences />}
              title={t('fiscal.identity.none')}
              description={t('fiscal.identity.noneBody')}
              action={can('settings.manage')
                ? { label: t('fiscal.identity.add'), onClick: () => setEditing(true) }
                : undefined}
            />
          )}
        </CardBody>
      </Card>

      {/* ── the devices that may issue in the firm's name ───────────────────── */}
      <Card>
        <CardBody>
          <div className="firm-fiscal__sectionHead">
            <h2 className="firm-fiscal__h2">{t('fiscal.devices')}</h2>
            <Button variant="secondary" onClick={() => setAddingDevice(true)} disabled={!identity}>
              {t('fiscal.devices.add')}
            </Button>
          </div>
          <p className="firm-fiscal__note">{t('fiscal.devices.note')}</p>
          <Table
            columns={deviceColumns}
            rows={data?.devices ?? []}
            rowKey={(d) => d.id}
            label={t('fiscal.devices')}
            density="compact"
            empty={(
              <EmptyState
                kind="empty"
                icon={<IconBilling />}
                title={t('fiscal.devices.none')}
                description={t('fiscal.devices.noneBody')}
              />
            )}
          />
        </CardBody>
      </Card>

      {/* ── the 24-hour clock ───────────────────────────────────────────────── */}
      <Card>
        <CardBody>
          <div className="firm-fiscal__sectionHead">
            <h2 className="firm-fiscal__h2">{t('fiscal.queue')}</h2>
            {queue.length > 0 ? (
              <Badge tone={queue.some((r) => r.overdue) ? 'high' : 'warning'}>{queue.length}</Badge>
            ) : null}
          </div>
          <p className="firm-fiscal__note">{t('fiscal.queue.note')}</p>
          <Table
            columns={queueColumns}
            rows={queue}
            rowKey={(r) => r.id}
            label={t('fiscal.queue')}
            density="compact"
            onRowClick={(r) => onNavigate(`/billing?invoice=${r.id}`)}
            empty={(
              <EmptyState
                kind="empty"
                icon={<IconCheck />}
                title={t('fiscal.queue.empty')}
                description={t('fiscal.queue.emptyBody')}
              />
            )}
          />
        </CardBody>
      </Card>

      {editing ? (
        <IdentityDialog
          current={identity}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); }}
        />
      ) : null}

      {addingDevice ? (
        <DeviceDialog
          onClose={() => setAddingDevice(false)}
          onSaved={() => { setAddingDevice(false); load(); }}
        />
      ) : null}
    </div>
  );
}

/**
 * THE REGISTRATION FORM.
 *
 * Every field the server validates is validated here too, in the same shape — the VAT
 * number is fifteen digits beginning and ending in 3, which is the Saudi format — because
 * a refusal that arrives as a 400 after a form has been filled in is a worse experience
 * than a field that says so first. The server is still the authority; this is courtesy.
 */
function IdentityDialog({
  current, onClose, onSaved,
}: {
  current: FiscalIdentityResponse['identity'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    registeredName: current?.registered_name ?? '',
    registeredNameAr: current?.registered_name_ar ?? '',
    vatRegistrationNumber: current?.vat_registration_number ?? '',
    commercialRegistration: current?.commercial_registration ?? '',
    registeredAddress: current?.registered_address ?? '',
    registeredAddressAr: current?.registered_address_ar ?? '',
    city: current?.city ?? '',
    postalCode: current?.postal_code ?? '',
    environment: current?.environment ?? ('sandbox' as const),
    onboardingStatus: current?.onboarding_status ?? 'not_started',
  });

  const vatOk = /^3[0-9]{13}3$/.test(form.vatRegistrationNumber.trim());
  const canSave = form.registeredName.trim().length >= 2
    && vatOk
    && form.commercialRegistration.trim().length >= 6
    && form.registeredAddress.trim().length >= 5;

  async function submit() {
    setBusy(true);
    try {
      await firmApi.saveFiscalIdentity({
        registeredName: form.registeredName.trim(),
        registeredNameAr: form.registeredNameAr.trim() || null,
        vatRegistrationNumber: form.vatRegistrationNumber.trim(),
        commercialRegistration: form.commercialRegistration.trim(),
        registeredAddress: form.registeredAddress.trim(),
        registeredAddressAr: form.registeredAddressAr.trim() || null,
        city: form.city.trim() || null,
        postalCode: form.postalCode.trim() || null,
        country: 'SA',
        environment: form.environment,
        onboardingStatus: form.onboardingStatus,
      });
      toast.success(t('fiscal.identity.saved'), t('fiscal.identity.savedBody'));
      onSaved();
    } catch (err) {
      toast.error(t('fiscal.identity.saveFailed'), err instanceof FirmApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('fiscal.identity.dialogTitle')}
      description={t('fiscal.identity.dialogBody')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!canSave} onClick={() => { void submit(); }}>
            {t('common.save')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <TextField
          label={t('fiscal.field.registeredName')}
          value={form.registeredName}
          onChange={(e) => setForm({ ...form, registeredName: e.target.value })}
          required
        />
        <TextField
          label={t('fiscal.field.registeredNameAr')}
          value={form.registeredNameAr}
          onChange={(e) => setForm({ ...form, registeredNameAr: e.target.value })}
        />
        <TextField
          label={t('fiscal.field.vat')}
          value={form.vatRegistrationNumber}
          onChange={(e) => setForm({ ...form, vatRegistrationNumber: e.target.value })}
          hint={t('fiscal.field.vatHint')}
          required
          {...(form.vatRegistrationNumber.length > 0 && !vatOk ? { error: t('fiscal.field.vatError') } : {})}
        />
        <TextField
          label={t('fiscal.field.cr')}
          value={form.commercialRegistration}
          onChange={(e) => setForm({ ...form, commercialRegistration: e.target.value })}
          required
        />
        <TextField
          label={t('fiscal.field.address')}
          value={form.registeredAddress}
          onChange={(e) => setForm({ ...form, registeredAddress: e.target.value })}
          required
        />
        <TextField
          label={t('fiscal.field.addressAr')}
          value={form.registeredAddressAr}
          onChange={(e) => setForm({ ...form, registeredAddressAr: e.target.value })}
        />
        <TextField
          label={t('fiscal.field.city')}
          value={form.city}
          onChange={(e) => setForm({ ...form, city: e.target.value })}
        />
        <TextField
          label={t('fiscal.field.postalCode')}
          value={form.postalCode}
          onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
        />
        <SelectField
          label={t('fiscal.field.environment')}
          value={form.environment}
          onChange={(e) => setForm({ ...form, environment: e.target.value as typeof form.environment })}
          hint={t('fiscal.field.environmentHint')}
          options={[
            { value: 'sandbox', label: t('fiscal.env.sandbox') },
            { value: 'simulation', label: t('fiscal.env.simulation') },
            { value: 'production', label: t('fiscal.env.production') },
          ]}
        />
        <SelectField
          label={t('fiscal.field.onboarding')}
          value={form.onboardingStatus}
          onChange={(e) => setForm({ ...form, onboardingStatus: e.target.value })}
          hint={t('fiscal.field.onboardingHint')}
          options={['not_started', 'csr_generated', 'compliance_csid', 'production_csid', 'revoked']
            .map((v) => ({ value: v, label: t(`fiscal.onboarding.${v}`) }))}
        />
        {/*
          SAID PLAINLY, IN THE FORM. Until the authority's own onboarding is integrated,
          this status is recorded by hand — and a screen that let a reader believe
          otherwise would be repeating the very finding this page exists to close.
        */}
        <p className="firm-fiscal__note firm-fiscal__note--warn">{t('fiscal.field.manualNote')}</p>
      </div>
    </Modal>
  );
}

function DeviceDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [serial, setSerial] = useState('');

  async function submit() {
    setBusy(true);
    try {
      await firmApi.addFiscalDevice({ deviceLabel: label.trim(), deviceSerial: serial.trim() });
      toast.success(t('fiscal.devices.saved'), t('fiscal.devices.savedBody'));
      onSaved();
    } catch (err) {
      toast.error(t('fiscal.devices.saveFailed'), err instanceof FirmApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('fiscal.devices.add')}
      description={t('fiscal.devices.dialogBody')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={label.trim().length < 2 || serial.trim().length < 2}
            onClick={() => { void submit(); }}
          >
            {t('common.save')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <TextField label={t('fiscal.device.label')} value={label} onChange={(e) => setLabel(e.target.value)} required />
        <TextField label={t('fiscal.device.serial')} value={serial} onChange={(e) => setSerial(e.target.value)} required />
        <p className="firm-fiscal__note">{t('fiscal.devices.inactiveNote')}</p>
      </div>
    </Modal>
  );
}
