import { useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { get, upload, openDocument } from '../api/client';
import type { DocumentRow, MatterSummary } from '../api/types';
import { useAuth } from '../auth';
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
  Input,
  Modal,
  PageLoader,
  Select,
  StatusBadge,
  useAsync,
} from '../components/ui';
import { PageHeader, Tabs } from '../components/page';

type TabId = 'all' | 'requested' | 'mine' | 'firm';

/** Types the upload endpoint accepts. Mirrors the server's allowlist so the
 *  picker cannot offer a value that would be refused. */
const DOC_TYPES = ['client_upload', 'evidence', 'correspondence', 'identity', 'contract', 'other'] as const;

/**
 * Document centre (§17–§19).
 *
 * Three things are true here by construction:
 *  · the browser never supplies a storage path — the server generates the key;
 *  · a download is a fresh, short-lived signed URL fetched per click, so a URL
 *    copied out of the address bar dies within a minute;
 *  · the upload form sends only a matter id, a type, two titles and the bytes.
 *    Tenant, client, visibility and category are all decided server-side.
 */
export default function Documents() {
  const { t, fmt, lang } = useI18n();
  const [tab, setTab] = useState<TabId>('all');
  const [matterId, setMatterId] = useState('all');
  const [query, setQuery] = useState('');

  const { data, error, loading, reload } = useAsync(
    () => get<{ documents: DocumentRow[] }>('/api/client/documents'),
    [],
  );
  const matters = useAsync(() => get<{ matters: MatterSummary[] }>('/api/client/matters'), []);

  const [uploadFor, setUploadFor] = useState<{ matterId?: string; requestId?: string } | null>(null);

  const docs = data?.documents ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return docs
      .filter((d) => {
        if (tab === 'requested' && !d.requested) return false;
        if (tab === 'mine' && d.origin !== 'client') return false;
        if (tab === 'firm' && d.origin !== 'firm') return false;
        if (matterId !== 'all' && d.matterId !== matterId) return false;
        if (!q) return true;
        return [d.title, d.titleAr, d.fileName, d.matterTitle, d.matterTitleAr, d.documentType]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q));
      })
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  }, [docs, tab, matterId, query]);

  const requestedCount = docs.filter((d) => d.requested).length;

  if (loading && !data) return <PageLoader />;

  return (
    <>
      <PageHeader
        title={t('doc.title')}
        subtitle={t('doc.subtitle')}
        actions={
          <Button variant="primary" size="sm" onClick={() => setUploadFor({})}>
            <Icon name="upload" size={15} />
            {t('doc.upload')}
          </Button>
        }
      />

      {error ? <ErrorAlert error={error} onRetry={reload} /> : null}

      {requestedCount > 0 && (
        <Alert tone="warn" title={t('dash.actionRequired')}>
          {t('doc.requestedCount', { n: requestedCount })}
        </Alert>
      )}

      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'all', label: t('common.all'), count: docs.length },
          { id: 'requested', label: t('doc.requested'), count: requestedCount },
          { id: 'mine', label: t('doc.fromYou'), count: docs.filter((d) => d.origin === 'client').length },
          { id: 'firm', label: t('doc.fromFirm'), count: docs.filter((d) => d.origin === 'firm').length },
        ]}
      />

      <Card tight>
        <div className="filterbar">
          <div className="filterbar__search">
            <Icon name="search" size={16} />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('common.search')}
              aria-label={t('common.search')}
            />
          </div>
          <Select
            value={matterId}
            onChange={(e) => setMatterId(e.target.value)}
            aria-label={t('doc.chooseMatter')}
            style={{ maxInlineSize: 280 }}
          >
            <option value="all">{t('doc.chooseMatter')}</option>
            {(matters.data?.matters ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {pick(lang, m.title, m.titleAr)} · {m.matterNumber}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Empty icon="doc" title={docs.length === 0 ? t('doc.empty') : t('common.none')}>
          <Button variant="primary" size="sm" onClick={() => setUploadFor({})}>
            <Icon name="upload" size={15} />
            {t('doc.upload')}
          </Button>
        </Empty>
      ) : (
        <ul className="list" style={{ marginBlockStart: 16 }}>
          {filtered.map((d) => (
            <li key={d.id} className="list__item">
              <span className="list__icon">
                <Icon name="doc" size={18} />
              </span>
              <span className="list__main">
                <span className="list__title">{pick(lang, d.title, d.titleAr)}</span>
                <span className="list__meta">
                  <span>{typeLabel(d.documentType)}</span>
                  {d.matterId && (
                    <Link to={`/portal/matters/${d.matterId}`}>{pick(lang, d.matterTitle, d.matterTitleAr)}</Link>
                  )}
                  <span>{fmt.bytes(d.sizeBytes)}</span>
                  <span>{t('doc.version', { n: d.version })}</span>
                  <span>{d.origin === 'firm' ? t('doc.fromFirm') : t('doc.fromYou')}</span>
                  {d.createdAt && <span>{fmt.date(d.createdAt)}</span>}
                </span>
                {d.requested && d.requestNote && (
                  <span className="list__summary">
                    <Icon name="alert" size={13} /> {pick(lang, d.requestNote, d.requestNoteAr)}
                  </span>
                )}
              </span>
              <span className="list__end">
                {d.requested ? (
                  <Badge tone="warn">{t('doc.requested')}</Badge>
                ) : (
                  <StatusBadge status={d.status} />
                )}
                {d.requested && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setUploadFor({ matterId: d.matterId ?? undefined, requestId: d.id })}
                  >
                    <Icon name="upload" size={14} />
                    {t('doc.fulfill')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!d.available}
                  onClick={() => void openDocument(d.id, 'inline')}
                >
                  <Icon name="eye" size={15} />
                  {t('doc.view')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!d.available}
                  onClick={() => void openDocument(d.id, 'attachment')}
                  aria-label={t('doc.download')}
                >
                  <Icon name="download" size={15} />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="small muted" style={{ marginBlockStart: 14 }}>
        <Icon name="lock" size={13} /> {t('doc.private')} · {t('doc.linkExpiry', { n: 60 })}
      </p>

      {uploadFor && (
        <UploadModal
          onClose={() => setUploadFor(null)}
          onDone={reload}
          presetMatterId={uploadFor.matterId}
          requestId={uploadFor.requestId}
          matters={matters.data?.matters ?? []}
        />
      )}
    </>
  );

  const typeLabel = (type: string) => translate(lang, `doc.type.${type}`);
}

function UploadModal({
  onClose,
  onDone,
  presetMatterId,
  requestId,
  matters,
}: {
  onClose: () => void;
  onDone: () => void;
  presetMatterId?: string;
  requestId?: string;
  matters: MatterSummary[];
}) {
  const { t, lang } = useI18n();
  const { boot } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [matterId, setMatterId] = useState(presetMatterId ?? '');
  const [documentType, setDocumentType] = useState<string>(requestId ? 'client_upload' : DOC_TYPES[0]);
  const [title, setTitle] = useState('');
  const [titleAr, setTitleAr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const maxBytes = boot?.upload.maxBytes ?? 25 * 1024 * 1024;
  const allowed = boot?.upload.allowedExtensions ?? [];
  const ext = file ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() : '';
  const tooBig = !!file && file.size > maxBytes;
  const wrongType = !!file && allowed.length > 0 && !allowed.includes(ext);

  const choose = (list: FileList | null) => {
    const next = list?.[0] ?? null;
    setFile(next);
    setError(null);
    // Suggest a title from the filename; the user can still change it.
    if (next && !title) {
      const base = next.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
      setTitle(base);
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    choose(event.dataTransfer.files);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await upload('/api/client/documents/upload', file, {
        matterId: matterId || null,
        documentType,
        title: title || undefined,
        titleAr: titleAr || undefined,
        // Sent only when fulfilling a firm request; the server clears the
        // request flag inside the same transaction as the insert.
        fulfillRequestId: requestId,
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
      title={requestId ? t('doc.fulfill') : t('doc.uploadTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="upload-form" variant="primary" loading={busy} disabled={!file || tooBig || wrongType}>
            <Icon name="upload" size={16} />
            {busy ? t('doc.uploading') : t('doc.upload')}
          </Button>
        </>
      }
    >
      <form id="upload-form" onSubmit={submit} noValidate>
        <div
          className="upload-drop"
          data-over={over}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          aria-label={t('doc.drop')}
        >
          <span className="upload-drop__icon">
            <Icon name="upload" size={20} />
          </span>
          <b>{file ? file.name : t('doc.drop')}</b>
          {file && (
            <span className="small muted">
              {fmtBytes(file.size)} · {ext.toUpperCase()}
            </span>
          )}
          <span className="small muted">
            {t('doc.maxSize', { size: mbLabel(maxBytes) })}
            {allowed.length > 0 && <> · {t('doc.allowed', { types: allowed.join(', ') })}</>}
          </span>
          <input
            ref={inputRef}
            type="file"
            accept={allowed.length > 0 ? allowed.map((e) => `.${e}`).join(',') : undefined}
            onChange={(e) => choose(e.target.files)}
          />
        </div>

        {(tooBig || wrongType) && (
          <Alert tone="error" title={tooBig ? t('err.upload_too_large') : t('err.upload_type_not_allowed')}>
            {tooBig
              ? t('doc.maxSize', { size: mbLabel(maxBytes) })
              : t('doc.allowed', { types: allowed.join(', ') })}
          </Alert>
        )}

        <Field label={t('doc.chooseMatter')} htmlFor="up-matter">
          <Select id="up-matter" value={matterId} onChange={(e) => setMatterId(e.target.value)}>
            <option value="">{t('doc.noMatter')}</option>
            {matters.map((m) => (
              <option key={m.id} value={m.id}>
                {pick(lang, m.title, m.titleAr)} · {m.matterNumber}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('doc.docType')} htmlFor="up-type">
          <Select id="up-type" value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
            {DOC_TYPES.map((type) => (
              <option key={type} value={type}>
                {translate(lang, `doc.type.${type}`)}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid--2">
          <Field label={t('doc.fileTitle')} htmlFor="up-title">
            <Input id="up-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </Field>
          <Field label={t('doc.fileTitleAr')} htmlFor="up-title-ar">
            <Input id="up-title-ar" dir="rtl" value={titleAr} onChange={(e) => setTitleAr(e.target.value)} maxLength={200} />
          </Field>
        </div>

        {error ? <ErrorAlert error={error} /> : null}

        <p className="small muted" style={{ marginBlockStart: 10 }}>
          <Icon name="shield" size={13} /> {t('doc.uploadNote')}
        </p>
      </form>
    </Modal>
  );
}

/** Upload limit as a readable label, for the {size} placeholder. */
function mbLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Local byte formatting for the drop zone, before the formatter is in scope. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
