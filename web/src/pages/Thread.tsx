import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post } from '../api/client';
import type { ThreadDetail as ThreadDto } from '../api/types';
import { useI18n } from '../i18n';
import { pick } from '../lib/format';
import { Button, Card, Empty, ErrorAlert, Icon, PageLoader, StatusBadge, Textarea, useAsync } from '../components/ui';
import { Crumbs, PageHeader } from '../components/page';

/**
 * Conversation view (§22).
 *
 * Rendering rule worth stating: `from` is the server's own classification of who
 * wrote the message, not something inferred from the session. A message the firm
 * wrote always renders on the firm's side even if a client tampers with local
 * state, because the next fetch restores it — and the client cannot post as the
 * firm, since the API only ever records `from: 'client'` for this role.
 */
export default function Thread() {
  const { id = '' } = useParams();
  const { t, fmt, lang } = useI18n();
  const { data, error, loading, reload } = useAsync(
    () => get<ThreadDto>(`/api/client/messages/${encodeURIComponent(id)}`),
    [id],
  );

  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  const messages = data?.messages ?? [];
  const closed = data?.thread.status === 'closed';

  // Keep the newest message in view as the thread grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    if (data && !closed) boxRef.current?.focus();
  }, [data, closed]);

  const grouped = useMemo(() => {
    // A day separator between messages makes long threads readable in both
    // calendars without asking the server for anything.
    const out: Array<{ kind: 'day'; key: string; label: string } | { kind: 'msg'; key: string; index: number }> = [];
    let lastDay = '';
    messages.forEach((m, index) => {
      const day = fmt.date(m.createdAt);
      if (day !== lastDay) {
        out.push({ kind: 'day', key: `d-${day}-${index}`, label: day });
        lastDay = day;
      }
      out.push({ kind: 'msg', key: m.id, index });
    });
    return out;
  }, [messages, fmt]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    setSendError(null);
    try {
      await post(`/api/client/messages/${encodeURIComponent(id)}`, { body: text });
      setBody('');
      reload();
    } catch (err) {
      setSendError(err);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <PageLoader />;

  if (error || !data) {
    return (
      <>
        <Crumbs items={[{ to: '/portal/messages', label: t('msg.title') }, { label: t('common.none') }]} />
        <ErrorAlert error={error} onRetry={reload} />
      </>
    );
  }

  const th = data.thread;

  return (
    <>
      <Crumbs
        items={[
          { to: '/portal', label: t('nav.dashboard') },
          { to: '/portal/messages', label: t('msg.title') },
          { label: pick(lang, th.subject, th.subjectAr) },
        ]}
      />

      <PageHeader
        title={pick(lang, th.subject, th.subjectAr)}
        subtitle={
          <Link to={`/portal/matters/${th.matterId}`}>{pick(lang, th.matterTitle, th.matterTitleAr)}</Link>
        }
        actions={
          <>
            <StatusBadge status={th.status} prefix="msg.status" />
            <Link to={`/portal/matters/${th.matterId}`}>
              <Button variant="ghost" size="sm">
                <Icon name="folder" size={15} />
                {t('matter.detail')}
              </Button>
            </Link>
          </>
        }
      />

      {sendError ? <ErrorAlert error={sendError} /> : null}

      <Card tight>
        {messages.length === 0 ? (
          <Empty icon="chat" title={t('msg.noMessages')} />
        ) : (
          <div className="chat">
            {grouped.map((item) =>
              item.kind === 'day' ? (
                <div key={item.key} className="chat__day">
                  <span>{item.label}</span>
                </div>
              ) : (
                (() => {
                  const m = messages[item.index];
                  const mine = m.from === 'client';
                  return (
                    <div key={item.key} className={mine ? 'bubble bubble--mine' : 'bubble'}>
                      <div className="bubble__who">{mine ? t('msg.you') : m.authorName}</div>
                      <div className="bubble__body">{m.body}</div>
                      <div className="bubble__when">
                        {fmt.time(m.createdAt)}
                        {!mine && !m.read && <span className="bubble__new">{t('notif.unread')}</span>}
                      </div>
                    </div>
                  );
                })()
              ),
            )}
            <div ref={endRef} />
          </div>
        )}
      </Card>

      {closed ? (
        <Card>
          <Empty icon="lock" title={t('msg.threadClosed')}>
            <span className="small muted">{t('msg.closedHint')}</span>
          </Empty>
        </Card>
      ) : (
        <Card title={t('msg.reply')}>
          <form onSubmit={send}>
            <Textarea
              ref={boxRef}
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, 4000))}
              rows={4}
              placeholder={t('msg.reply')}
              aria-label={t('msg.reply')}
              required
            />
            <div className="row row--between" style={{ marginBlockStart: 10 }}>
              <span className="small muted">
                {fmt.number(body.length)} / {fmt.number(4000)}
              </span>
              <Button type="submit" variant="primary" loading={busy} disabled={!body.trim()}>
                <Icon name="send" size={16} />
                {busy ? t('msg.sending') : t('msg.send')}
              </Button>
            </div>
          </form>
          <p className="small muted" style={{ marginBlockStart: 10 }}>
            <Icon name="lock" size={13} /> {t('msg.secureNote')}
          </p>
        </Card>
      )}
    </>
  );
}
