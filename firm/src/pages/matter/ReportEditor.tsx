/*
  THE CASE REPORT · what the client is told, and the write that tells them.
  ────────────────────────────────────────────────────────────────────────────

  WHY THIS IS NOT A FIELD ON THE OVERVIEW. A case report is a recurring act, not a
  property: a lawyer opens the file, writes what changed, and the client reads it in
  the portal. The screen that does it therefore has to do three things at once — edit
  the file's own description, leave a client-facing note, and move the date that says
  the client was last told anything — and it has to do them in ONE save. The route
  accepts all three in one call and writes them in one transaction; this is the form.

  THE LAST-NOTIFIED DATE IS SHOWN, NOT DECORATIVE. It is the number a client
  relationship is judged by and the one nobody can recall from memory: "the matter was
  opened eleven weeks ago and the client has been told nothing since." A report form
  that did not surface it would be a form that lets a firm forget.

  WHAT IT REFUSES. `internal_status` is not editable here and the status machine keeps
  its own gate — the CDD gate has to see a matter becoming active, and a report form
  that could set the status would be a way around it. The screen shows no control for
  it, and the route rejects the key outright (`.strict()`).
*/
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, IconEdit, Skeleton,
  TextArea, TextField, useFmt, useI18n, useToast,
} from '@kgm/ui';
import { FirmApiError, firmApi, type MatterReportPayload } from '../../api/firm.js';

interface ReportEditorProps {
  readonly matterId: string;
  /** Re-reads the workspace so the header and overview reflect the new report. */
  readonly onSaved: () => void;
  readonly onClose: () => void;
}

export function ReportEditor({ matterId, onSaved, onClose }: ReportEditorProps) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const toast = useToast();
  const [data, setData] = useState<MatterReportPayload | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    title: '', titleAr: '', caseNumber: '', court: '', practiceArea: '',
    summary: '', summaryAr: '', note: '', notifyClient: true,
  });

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const payload = await firmApi.matterReport(matterId);
      setData(payload);
      setForm({
        title: payload.report.title,
        titleAr: payload.report.titleAr ?? '',
        caseNumber: payload.report.caseNumber ?? '',
        court: payload.report.court ?? '',
        practiceArea: payload.report.practiceArea,
        summary: payload.report.summary ?? '',
        summaryAr: payload.report.summaryAr ?? '',
        note: '',
        notifyClient: true,
      });
      setStatus('ready');
    } catch (err) {
      setError((err as FirmApiError).message);
      setStatus('error');
    }
  }, [matterId]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true);
    try {
      /*
        ONLY WHAT CHANGED. Sending every field on every save would rewrite the report
        with whatever the form happened to be holding, and the audit row would then
        name columns nobody edited — which is exactly the noise an audit trail cannot
        afford.
      */
      const out = await firmApi.updateMatterReport(matterId, {
        title: form.title,
        titleAr: form.titleAr || null,
        caseNumber: form.caseNumber || null,
        court: form.court || null,
        practiceArea: form.practiceArea,
        summary: form.summary || null,
        summaryAr: form.summaryAr || null,
        note: form.note || null,
        noteAr: null,
        notifyClient: form.notifyClient,
      });
      toast.success(
        out.notifiedClient ? t('report.saved.notified') : t('report.saved'),
        out.fields.length ? out.fields.join(', ') : undefined,
      );
      onSaved();
      onClose();
    } catch (err) {
      toast.error(t('report.failed'), (err as FirmApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (status === 'loading') {
    return (
      <Card variant="default">
        <CardHeader title={t('report.title')} icon={<IconEdit size={15} />} />
        <CardBody><Skeleton height={180} variant="rect" /></CardBody>
      </Card>
    );
  }

  if (status === 'error' || !data) {
    return (
      <Card variant="default">
        <CardHeader title={t('report.title')} icon={<IconEdit size={15} />} />
        <CardBody>
          <Alert tone="critical" title={t('panel.error.title')}>{error}</Alert>
        </CardBody>
      </Card>
    );
  }

  if (!data.mayUpdate) {
    return (
      <Card variant="default">
        <CardHeader title={t('report.title')} icon={<IconEdit size={15} />} />
        <CardBody>
          <Alert tone="notice">{t('report.noPermission')}</Alert>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card variant="default" className="firm-report">
      <CardHeader
        title={t('report.title')}
        icon={<IconEdit size={15} />}
        action={(
          <span className="firm-report__last">
            {data.report.lastClientUpdateAt
              ? <>{t('report.lastUpdate')} <Badge tone="neutral" size="xs">
                {fmt.date(data.report.lastClientUpdateAt)}
              </Badge></>
              : <span className="c-muted">{t('report.neverUpdated')}</span>}
          </span>
        )}
      />
      <CardBody>
        <div className="firm-formgrid">
          <TextField
            label={t('intake.case.title')}
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <TextField
            label={t('intake.case.titleAr')}
            value={form.titleAr}
            onChange={(e) => setForm({ ...form, titleAr: e.target.value })}
          />
          <TextField
            label={t('intake.case.caseNumber')}
            value={form.caseNumber}
            onChange={(e) => setForm({ ...form, caseNumber: e.target.value })}
          />
          <TextField
            label={t('intake.case.court')}
            value={form.court}
            onChange={(e) => setForm({ ...form, court: e.target.value })}
          />
          <TextField
            label={t('matter.practiceArea')}
            value={form.practiceArea}
            onChange={(e) => setForm({ ...form, practiceArea: e.target.value })}
          />
        </div>

        <TextArea
          label={t('intake.case.summary')}
          hint={pick(null, t('intake.case.summary.hint'))}
          value={form.summary}
          onChange={(e) => setForm({ ...form, summary: e.target.value })}
          maxLength={4000} maxLengthCounter
        />
        <TextArea
          label={t('intake.case.summaryAr')}
          value={form.summaryAr}
          onChange={(e) => setForm({ ...form, summaryAr: e.target.value })}
          maxLength={4000}
        />
        <TextArea
          label={t('report.note')}
          hint={t('report.note.hint')}
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
          maxLength={2000} maxLengthCounter
        />
        <Checkbox
          label={t('report.notify')}
          hint={t('report.notify.hint')}
          checked={form.notifyClient}
          onChange={(e) => setForm({ ...form, notifyClient: e.target.checked })}
        />

        <div className="firm-report__actions">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
            {busy ? t('common.saving') : t('report.submit')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
        </div>
      </CardBody>
    </Card>
  );
}
