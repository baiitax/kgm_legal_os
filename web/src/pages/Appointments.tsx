import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../api/client';
import type { Appointment, AppointmentType, MatterSummary } from '../api/types';
import { translate, useI18n } from '../i18n';
import { pick } from '../lib/format';
import {
  Alert,
  Badge,
  Button,
  Empty,
  ErrorAlert,
  Field,
  Icon,
  Input,
  Modal,
  PageLoader,
  Select,
  StatusBadge,
  Textarea,
  useAsync,
} from '../components/ui';
import { PageHeader, Tabs } from '../components/page';

type TabId = 'upcoming' | 'past' | 'cancelled';

/**
 * Appointments (§23).
 *
 * A request creates an appointment in `requested` state. Confirmation is a firm
 * action, and the portal says so rather than implying a booking was made. The
 * `canCancel` flag comes from the server: it is false once the firm has
 * confirmed and the window has closed, and the button is hidden accordingly —
 * though the real gate is the API, which refuses the cancellation regardless.
 */
export default function Appointments() {
  const { t, fmt, lang } = useI18n();
  const { data, error, loading, reload } = useAsync(
    async () => {
      const [appts, matters] = await Promise.all([
        get<{ appointments: Appointment[]; types: AppointmentType[] }>('/api/client/appointments'),
        get<{ matters: MatterSummary[] }>('/api/client/matters'),
      ]);
      return { ...appts, matters: matters.matters };
    },
    [],
  );

  const [tab, setTab] = useState<TabId>('upcoming');
  const [requesting, setRequesting] = useState(false);
  const [cancelling, setCancelling] = useState<Appointment | null>(null);

  const all = data?.appointments ?? [];
  const now = Date.now();
  const groups = {
    upcoming: all
      .filter((a) => a.status !== 'cancelled' && a.status !== 'completed' && new Date(a.preferredDate).getTime() >= now - 86_400_000)
      .sort((a, b) => a.preferredDate.localeCompare(b.preferredDate)),
    past: all
      .filter((a) => a.status === 'completed' || (a.status !== 'cancelled' && new Date(a.preferredDate).getTime() < now - 86_400_000))
      .sort((a, b) => b.preferredDate.localeCompare(a.preferredDate)),
    cancelled: all.filter((a) => a.status === 'cancelled'),
  };

  if (loading && !data) return <PageLoader />;

  /** Mode labels come from the dictionary when present, else the raw code. */
  const modeLabel = (mode: string) => translate(lang, `appt.mode.${mode}`);

  return (
    <>
      <PageHeader
        title={t('appt.title')}
        subtitle={t('appt.subtitle')}
        actions={
          <Button variant="primary" size="sm" onClick={() => setRequesting(true)}>
            <Icon name="plus" size={15} />
            {t('appt.request')}
          </Button>
        }
      />

      {error ? <ErrorAlert error={error} onRetry={reload} /> : null}

      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'upcoming', label: t('hearing.upcoming'), count: groups.upcoming.length },
          { id: 'past', label: t('hearing.past'), count: groups.past.length },
          { id: 'cancelled', label: t('appt.status.cancelled'), count: groups.cancelled.length },
        ]}
      />

      {groups[tab].length === 0 ? (
        <Empty icon="calendar" title={t('appt.empty')}>
          <Button variant="primary" size="sm" onClick={() => setRequesting(true)}>
            <Icon name="plus" size={15} />
            {t('appt.request')}
          </Button>
        </Empty>
      ) : (
        <ul className="list">
          {groups[tab].map((a) => (
            <li key={a.id} className="list__item">
              <span className="list__icon">
                <Icon name={a.preferredMode === 'video' ? 'video' : a.preferredMode === 'phone' ? 'phone' : 'pin'} size={18} />
              </span>
              <span className="list__main">
                <span className="list__title">
                  {pick(lang, a.typeLabel, a.typeLabelAr)}
                  {a.matterId && (
                    <>
                      {' · '}
                      <Link to={`/portal/matters/${a.matterId}`}>{pick(lang, a.matterTitle, a.matterTitleAr)}</Link>
                    </>
                  )}
                </span>
                <span className="list__meta">
                  <span className="ltr">{fmt.day(a.preferredDate)}</span>
                  <span className="ltr">{a.preferredTime}</span>
                  <span>{modeLabel(a.preferredMode)}</span>
                  {a.confirmedAt && <span>{t('appt.confirmedAt')}: {fmt.dateTime(a.confirmedAt)}</span>}
                </span>
                {a.clientNote && <span className="list__summary">{a.clientNote}</span>}
                {a.cancellationReason && (
                  <span className="list__summary">
                    <Icon name="alert" size={13} /> {a.cancellationReason}
                  </span>
                )}
              </span>
              <span className="list__end">
                <StatusBadge status={a.status} prefix="appt.status" />
                {a.canCancel && a.status !== 'cancelled' && (
                  <Button variant="ghost" size="sm" onClick={() => setCancelling(a)}>
                    <Icon name="close" size={14} />
                    {t('appt.cancel')}
                  </Button>
                )}
                {a.cancelledBy && <Badge tone="default">{a.cancelledBy}</Badge>}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="small muted" style={{ marginBlockStart: 14 }}>
        <Icon name="info" size={13} /> {t('appt.noteAboutTimes')}
      </p>

      {requesting && data && (
        <RequestModal
          types={data.types}
          matters={data.matters}
          onClose={() => setRequesting(false)}
          onDone={reload}
        />
      )}

      {cancelling && (
        <CancelModal appointment={cancelling} onClose={() => setCancelling(null)} onDone={reload} />
      )}
    </>
  );
}

function RequestModal({
  types,
  matters,
  onClose,
  onDone,
}: {
  types: AppointmentType[];
  matters: MatterSummary[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, lang } = useI18n();
  const today = new Date().toISOString().slice(0, 10);
  const [matterId, setMatterId] = useState('');
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [date, setDate] = useState(today);
  const [time, setTime] = useState('10:00');
  const [mode, setMode] = useState<'in_person' | 'video' | 'phone'>('video');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/client/appointments', {
        matterId: matterId || null,
        typeId: typeId || undefined,
        preferredDate: date,
        preferredTime: time,
        preferredMode: mode,
        note: note.trim() || undefined,
      });
      setDone(true);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('appt.requestTitle')}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="appt-form" variant="primary" loading={busy}>
              <Icon name="send" size={16} />
              {t('common.submit')}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <Alert tone="ok" title={t('appt.created')}>
          {t('appt.createdBody')}
        </Alert>
      ) : (
        <form id="appt-form" onSubmit={submit} noValidate>
          <Field label={t('appt.type')} htmlFor="ap-type">
            <Select id="ap-type" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              {types.map((ty) => (
                <option key={ty.id} value={ty.id}>
                  {pick(lang, ty.label, ty.labelAr)} · {ty.durationMinutes}′
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('doc.chooseMatter')} htmlFor="ap-matter">
            <Select id="ap-matter" value={matterId} onChange={(e) => setMatterId(e.target.value)}>
              <option value="">{t('common.none')}</option>
              {matters.map((m) => (
                <option key={m.id} value={m.id}>
                  {pick(lang, m.title, m.titleAr)} · {m.matterNumber}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid--2">
            <Field label={t('appt.date')} htmlFor="ap-date">
              <Input
                id="ap-date"
                type="date"
                dir="ltr"
                min={today}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </Field>
            <Field label={t('appt.time')} htmlFor="ap-time">
              <Input
                id="ap-time"
                type="time"
                dir="ltr"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
              />
            </Field>
          </div>

          <Field label={t('appt.mode')} htmlFor="ap-mode">
            <Select id="ap-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="video">{t('appt.mode.video')}</option>
              <option value="in_person">{t('appt.mode.in_person')}</option>
              <option value="phone">{t('appt.mode.phone')}</option>
            </Select>
          </Field>

          <Field label={t('appt.note')} htmlFor="ap-note" hint={t('common.optional')}>
            <Textarea
              id="ap-note"
              rows={3}
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>

          {error ? <ErrorAlert error={error} /> : null}

          <p className="small muted" style={{ marginBlockStart: 10 }}>
            <Icon name="info" size={13} /> {t('appt.noteAboutTimes')}
          </p>
        </form>
      )}
    </Modal>
  );
}

function CancelModal({
  appointment,
  onClose,
  onDone,
}: {
  appointment: Appointment;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, lang } = useI18n();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/client/appointments/${encodeURIComponent(appointment.id)}/cancel`, {
        reason: reason.trim() || undefined,
      });
      onDone();
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('appt.cancelTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.back')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void submit()}>
            <Icon name="close" size={16} />
            {t('appt.cancel')}
          </Button>
        </>
      }
    >
      <p>
        {pick(lang, appointment.typeLabel, appointment.typeLabelAr)} ·{' '}
        <span className="ltr">{appointment.preferredDate} {appointment.preferredTime}</span>
      </p>
      <Field label={t('appt.cancelReason')} htmlFor="cn-reason" hint={t('common.optional')}>
        <Textarea id="cn-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error ? <ErrorAlert error={error} /> : null}
      <p className="small muted">
        <Icon name="info" size={13} /> {t('appt.cancelNote')}
      </p>
    </Modal>
  );
}
