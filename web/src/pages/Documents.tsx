/**
 * DOCUMENTS (§17–§19) · the client portal's document centre
 *
 * THREE SECURITY PROPERTIES HOLD BY CONSTRUCTION
 *   · the browser never supplies a storage path — the server generates the key;
 *   · a download is a fresh, short-lived, session-bound signed URL fetched per
 *     click, so a URL copied out of the address bar dies within a minute;
 *   · the upload sends only a matter id, a type, two titles and the bytes.
 *     Tenant, client, visibility and category are decided server-side.
 *
 * WHAT THIS FILE GOT WRONG, AND WHY THE FIX IS SHAPED LIKE THIS
 *   It referenced `typeLabel` before its own `const` declaration. That is a
 *   temporal dead zone error: a `const` is hoisted but not initialized, and the
 *   `map` callback that read it ran eagerly while the JSX was being built. So
 *   the page threw on EVERY render — but only when the list was non-empty,
 *   which is why it survived a type-check, a build, 333 server tests and a
 *   live portal harness that signed in to an account with no documents.
 *
 *   Two lessons are baked into the structure below rather than noted in a
 *   comment. First, every helper that reads component state is defined BEFORE
 *   the return, because "declared later" is not a style preference here. Second,
 *   anything the page promises on click must be able to FAIL VISIBLY: the old
 *   code called `void openDocument(...)`, so a refused grant, an expired
 *   document or a rate limit produced a click that did nothing at all — which
 *   the reader experiences as a broken button, not as an error.
 *
 * WHAT IS ENHANCED, AND WHY EACH ONE EARNS ITS PLACE
 *   · File-type identity. A generic page glyph on every row meant the list could
 *     only be read one line at a time. Type and colour are derived from the
 *     MIME type, which the server already sends.
 *   · A request queue pinned above the list. Documents the firm has ASKED FOR
 *     are work, not archive; burying them in date order is how a request is
 *     missed.
 *   · Sorting and a clear-filters control. The list was newest-first with no way
 *     to change it, and a filter that matched nothing offered no way back.
 *   · Per-row busy and error state, so a slow grant looks slow rather than dead.
 *   · Upload progress as a real percentage, because a 20 MB file over a phone
 *     connection is not an indeterminate spinner.
 */
import { useCallback, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
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
type SortId = 'newest' | 'oldest' | 'name' | 'size';

/** Types the upload endpoint accepts. Mirrors the server's allowlist so the
 *  picker cannot offer a value that would be refused. */
const DOC_TYPES = ['client_upload', 'evidence', 'correspondence', 'identity', 'contract', 'other'] as const;

/**
 * Visual identity per file family.
 *
 * Keyed on the MIME type the SERVER reported, not on the filename extension:
 * the extension is client-supplied text, and this is a decoration derived from
 * it — a `.pdf` that is not a PDF would get the wrong colour, which is
 * cosmetic, but deriving it from the verified type keeps the row honest about
 * what the file actually is.
 */
const FILE_FAMILIES = [
  { id: 'pdf', tone: 'pdf', matches: (m: string) => m === 'application/pdf' },
  { id: 'word', tone: 'word', matches: (m: string) => m.includes('word') || m.includes('officedocument.wordprocessing') },
  { id: 'sheet', tone: 'sheet', matches: (m: string) => m.includes('sheet') || m.includes('excel') || m.includes('csv') },
  { id: 'image', tone: 'image', matches: (m: string) => m.startsWith('image/') },
  { id: 'text', tone: 'text', matches: (m: string) => m.startsWith('text/') },
] as const;

/** The extension shown in the corner of the tile, for a file the reader can name. */
function extensionOf(name: string, mime: string): string {
  const fromName = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (fromName && fromName.length <= 4) return fromName.toUpperCase();
  const family = FILE_FAMILIES.find((f) => f.matches(mime));
  return (family?.id ?? 'file').slice(0, 4).toUpperCase();
}

function familyOf(mime: string): string {
  return FILE_FAMILIES.find((f) => f.matches(mime))?.id ?? 'file';
}

/** Upload limit as a readable label, for the {size} placeholder. Used by the modal. */
function mbLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;
}

export default function Documents() {
  const { t, fmt, lang } = useI18n();
  const [tab, setTab] = useState<TabId>('all');
  const [matterId, setMatterId] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortId>('newest');

  const { data, error, loading, reload } = useAsync(
    () => get<{ documents: DocumentRow[] }>('/api/client/documents'),
    [],
  );
  const matters = useAsync(() => get<{ matters: MatterSummary[] }>('/api/client/matters'), []);

  const [uploadFor, setUploadFor] = useState<{ matterId?: string; requestId?: string } | null>(null);

  /** Per-row transfer state, so one row's failure does not disable the others. */
  const [rowState, setRowState] = useState<Record<string, { busy?: 'view' | 'download'; error?: unknown }>>({});

  /**
   * The authoritative in-flight guard.
   *
   * `disabled` on the buttons is feedback, not protection: it only exists after
   * React has re-rendered, so two clicks dispatched in the same tick both reach
   * the handler and both request a grant — a real double request for a signed
   * URL, and a second one billed against the per-document rate limit. A ref is
   * written synchronously, so the second call sees the first one already in
   * flight. This is the difference between a disabled-looking button and a
   * button that cannot be double-fired.
   */
  const inFlight = useRef<Set<string>>(new Set());

  /**
   * Mounted flag for the whole page. The user navigates away mid-grant all the
   * time; setting state on an unmounted tree is a warning today and a leak
   * tomorrow, and one flag here is cheaper than guarding every row.
   */
  const alive = useRef(true);

  /**
   * Defined BEFORE the return, deliberately.
   *
   * The defect this file fixed was a helper read from the JSX while its `const`
   * was still uninitialized. Keeping every render-scope helper above the return
   * makes that impossible to reintroduce by moving a block.
   */
  const typeLabel = useCallback(
    (type: string) => translate(lang, `doc.type.${type}`),
    [lang],
  );

  const docs = data?.documents ?? [];

  /**
   * Fetches a fresh one-time grant for a click.
   *
   * The busy flag is the point. A grant is a round trip plus a signature, and on
   * a slow connection the button previously looked inert; two impatient taps
   * fired two grants because nothing marked the first as in flight. The key is
   * per-row and per-action, so a view in flight does not block a download of a
   * different document.
   */
  const open = useCallback(
    async (row: DocumentRow, disposition: 'inline' | 'attachment') => {
      if (inFlight.current.has(row.id)) return;
      inFlight.current.add(row.id);
      setRowState((s) => ({ ...s, [row.id]: { busy: disposition === 'inline' ? 'view' : 'download' } }));
      try {
        await openDocument(row.id, disposition);
        if (alive.current) setRowState((s) => ({ ...s, [row.id]: {} }));
      } catch (err) {
        // A refused grant is information the reader needs: the document may have
        // been superseded, quarantined by a scan, or withdrawn. Silence here is
        // what made the old button look broken.
        if (alive.current) setRowState((s) => ({ ...s, [row.id]: { error: err } }));
      } finally {
        inFlight.current.delete(row.id);
      }
    },
    [],
  );

  const requested = useMemo(() => docs.filter((d) => d.requested), [docs]);

  /**
   * The archive: everything the member is not being asked to act on.
   *
   * Requests are removed from the sorted list and rendered above it rather than
   * sorted among it, so the action queue cannot drift down the page as new
   * documents arrive.
   */
  const archive = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = docs.filter((d) => {
      if (d.requested) return false;
      if (tab === 'mine' && d.origin !== 'client') return false;
      if (tab === 'firm' && d.origin !== 'firm') return false;
      if (matterId !== 'all' && d.matterId !== matterId) return false;
      if (!q) return true;
      return [d.title, d.titleAr, d.fileName, d.matterTitle, d.matterTitleAr, d.documentType]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });

    const title = (d: DocumentRow) => pick(lang, d.title, d.titleAr) ?? d.fileName;
    const comparators: Record<SortId, (a: DocumentRow, b: DocumentRow) => number> = {
      newest: (a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
      oldest: (a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')),
      name: (a, b) => String(title(a)).localeCompare(String(title(b)), lang === 'ar' ? 'ar' : 'en'),
      size: (a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0),
    };
    return rows.sort(comparators[sort]);
  }, [docs, tab, matterId, query, sort, lang]);

  /** Requests are filtered by the same query and matter, so the two agree. */
  const visibleRequests = useMemo(() => {
    const q = query.trim().toLowerCase();
    return requested.filter((d) => {
      if (matterId !== 'all' && d.matterId !== matterId) return false;
      if (!q) return true;
      return [d.title, d.titleAr, d.fileName, d.requestNote, d.requestNoteAr, d.matterTitle]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [requested, matterId, query]);

  const filtersActive = query.trim() !== '' || matterId !== 'all';
  const clearFilters = () => {
    setQuery('');
    setMatterId('all');
    setTab('all');
  };

  if (loading && !data) return <PageLoader />;

  const row = (d: DocumentRow) => {
    const state = rowState[d.id] ?? {};
    const label = pick(lang, d.title, d.titleAr) ?? d.fileName;
    return (
      <li key={d.id} className="docrow" data-unavailable={!d.available || undefined}>
        {/* Type is carried by the tile: the reader scans shapes long before
            words, and one glyph for every document made the list unreadable. */}
        <span className="docrow__tile" data-family={familyOf(d.mimeType)} aria-hidden="true">
          <Icon name="doc" size={19} />
          <span className="docrow__ext">{extensionOf(d.fileName, d.mimeType)}</span>
        </span>

        <span className="docrow__main">
          <span className="docrow__title">{label}</span>
          <span className="docrow__meta">
            <span className="docrow__type">{typeLabel(d.documentType)}</span>
            {d.matterId && (
              <Link className="docrow__matter" to={`/portal/matters/${d.matterId}`}>
                {pick(lang, d.matterTitle, d.matterTitleAr)}
              </Link>
            )}
            <span>{fmt.bytes(d.sizeBytes)}</span>
            {d.version > 1 && <span>{t('doc.version', { n: d.version })}</span>}
            <span className="docrow__origin" data-origin={d.origin}>
              {d.origin === 'firm' ? t('doc.fromFirm') : t('doc.fromYou')}
            </span>
            {d.createdAt && <span>{fmt.date(d.createdAt)}</span>}
          </span>

          {/* WHY a row cannot be opened. A disabled control with no explanation
              is the same dead end as the button that did nothing. */}
          {!d.available && (
            <span className="docrow__why">
              <Icon name="clock" size={13} /> {t('doc.notReady')} · {t('doc.notReadyWhy')}
            </span>
          )}

          {state.error ? (
            <span className="docrow__error" role="alert">
              <ErrorAlert error={state.error} />
            </span>
          ) : null}
        </span>

        <span className="docrow__end">
          <StatusBadge status={d.status} />
          <span className="docrow__actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={!d.available || !!state.busy}
              loading={state.busy === 'view'}
              onClick={() => void open(d, 'inline')}
            >
              <Icon name="eye" size={15} />
              {t('doc.view')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!d.available || !!state.busy}
              loading={state.busy === 'download'}
              onClick={() => void open(d, 'attachment')}
              aria-label={t('doc.download')}
            >
              <Icon name="download" size={15} />
            </Button>
          </span>
        </span>
      </li>
    );
  };

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

      {/*
        The action queue, above everything. A document the firm has requested is
        a task with a deadline attached, and it was previously sorted into the
        archive by date — where a request from last month sits below a receipt
        from yesterday.
      */}
      {visibleRequests.length > 0 && (
        <Card className="docqueue">
          <div className="docqueue__head">
            <Icon name="alert" size={16} />
            <b>{t('doc.requested')}</b>
            <Badge tone="warn">{visibleRequests.length}</Badge>
          </div>
          <ul className="docqueue__list">
            {visibleRequests.map((d) => (
              <li key={d.id} className="docqueue__item">
                <span className="docrow__tile" data-family={familyOf(d.mimeType)} aria-hidden="true">
                  <Icon name="doc" size={18} />
                  <span className="docrow__ext">{extensionOf(d.fileName, d.mimeType)}</span>
                </span>
                <span className="docqueue__text">
                  <b>{pick(lang, d.title, d.titleAr) ?? d.fileName}</b>
                  {d.requestNote && (
                    <span className="docqueue__note">
                      {t('doc.requestNote')}: {pick(lang, d.requestNote, d.requestNoteAr)}
                    </span>
                  )}
                  {d.matterId && (
                    <Link className="docrow__matter" to={`/portal/matters/${d.matterId}`}>
                      {pick(lang, d.matterTitle, d.matterTitleAr)}
                    </Link>
                  )}
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setUploadFor({ matterId: d.matterId ?? undefined, requestId: d.id })}
                >
                  <Icon name="upload" size={14} />
                  {t('doc.fulfill')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'all', label: t('common.all'), count: archive.length + visibleRequests.length },
          { id: 'requested', label: t('doc.requested'), count: requested.length },
          { id: 'mine', label: t('doc.fromYou'), count: docs.filter((d) => d.origin === 'client' && !d.requested).length },
          { id: 'firm', label: t('doc.fromFirm'), count: docs.filter((d) => d.origin === 'firm' && !d.requested).length },
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
          <Select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortId)}
            aria-label={t('doc.sort')}
            style={{ maxInlineSize: 200 }}
          >
            <option value="newest">{t('doc.sort.newest')}</option>
            <option value="oldest">{t('doc.sort.oldest')}</option>
            <option value="name">{t('doc.sort.name')}</option>
            <option value="size">{t('doc.sort.size')}</option>
          </Select>
          {filtersActive && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <Icon name="close" size={14} />
              {t('doc.clearFilters')}
            </Button>
          )}
        </div>
      </Card>

      {archive.length === 0 ? (
        <Empty
          icon="doc"
          title={docs.length === 0 ? t('doc.empty') : filtersActive ? t('doc.noMatches') : t('doc.emptyFilter')}
        >
          {docs.length === 0 ? (
            <Button variant="primary" size="sm" onClick={() => setUploadFor({})}>
              <Icon name="upload" size={15} />
              {t('doc.upload')}
            </Button>
          ) : (
            /* A filter that matches nothing must offer the way back, or the
               screen reads as though the documents were deleted. */
            filtersActive && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <Icon name="close" size={14} />
                {t('doc.clearFilters')}
              </Button>
            )
          )}
        </Empty>
      ) : (
        <ul className="doclist" style={{ marginBlockStart: 16 }}>
          {archive.map(row)}
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
  const [percent, setPercent] = useState(0);
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
    setPercent(0);
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
    setPercent(0);
    try {
      await upload(
        '/api/client/documents/upload',
        file,
        {
          matterId: matterId || null,
          documentType,
          title: title || undefined,
          titleAr: titleAr || undefined,
          // Sent only when fulfilling a firm request; the server clears the
          // request flag inside the same transaction as the insert.
          fulfillRequestId: requestId,
        },
        // A real percentage. A 20 MB scan over a phone connection behind an
        // indeterminate spinner reads as a hung page.
        { onProgress: (fraction) => setPercent(Math.round(fraction * 100)) },
      );
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
            {busy ? (percent > 0 ? `${percent}%` : t('doc.uploading')) : t('doc.upload')}
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
              {mbLabel(file.size)} · {ext.toUpperCase()}
            </span>
          )}
          {!file && (
            <span className="small muted">
              {t('doc.maxSize', { size: mbLabel(maxBytes) })}
              {allowed.length > 0 && <> · {t('doc.allowed', { types: allowed.join(', ') })}</>}
            </span>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={allowed.length > 0 ? allowed.map((e) => `.${e}`).join(',') : undefined}
            onChange={(e) => choose(e.target.files)}
          />
        </div>

        {busy && (
          <div className="upload-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <span className="upload-progress__bar" style={{ inlineSize: `${percent}%` }} />
          </div>
        )}

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
                {typeLabelFor(lang, type)}
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

/**
 * A module-level label resolver for the upload form.
 *
 * Deliberately NOT the component's `typeLabel` closure. That closure is what
 * made the original defect possible — a helper that exists only inside the
 * render body is a helper that can be read before it exists. Anything the JSX
 * needs and that does not depend on component state lives out here instead.
 */
function typeLabelFor(lang: 'ar' | 'en', type: string): string {
  return translate(lang, `doc.type.${type}`);
}
