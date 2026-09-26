import { useFormat } from '../../i18n/useFormat';
import { useI18n, Trans } from '../../i18n/I18nProvider';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronUp, Quote, Search, Settings2, Terminal, UserRound, X } from 'lucide-react';
import type { Message, MessageQuery, SessionDetail } from '../../../shared/types';
import { Button, EmptyState, ErrorState, IconButton, ProviderMark, Skeleton } from '../../components/ui';
import { useDebounced, useResource } from '../../hooks/useResource';
import { api } from '../../lib/api';
import { AGENT_META, number } from '../../lib/format';
import { MessageBody } from './MessageBody';
import { useApp, useData } from '../../state/AppProvider';

const CaptureContextDialog = lazy(() => import('../context-packs/CaptureContextDialog').then(module => ({ default: module.CaptureContextDialog })));

const PAGE_SIZE = 50;
const ROLES = [
  { value: 'all', label: '전체' }, { value: 'user', label: '사용자' },
  { value: 'assistant', label: '에이전트' }, { value: 'tool', label: '도구' },
  { value: 'system', label: '시스템' },
] as const;

export function getLastMessageOffset(total: number) {
  return total > 0 ? Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE : 0;
}

export function getFindTarget(active: number, total: number, direction: -1 | 1) {
  if (total <= 0) return null;
  const current = Math.min(Math.max(0, active), total - 1);
  const index = (current + direction + total) % total;
  return { index, offset: Math.floor(index / PAGE_SIZE) * PAGE_SIZE };
}

export function SessionReader({ session }: { session: SessionDetail }) {
  const { dateTime } = useFormat();
  const { t } = useI18n();
  const { notify } = useApp();
  const { projects } = useData();
  const [capture, setCapture] = useState<{ messageId: string; offset: number; length: number; previewText: string } | null>(null);
  const [role, setRole] = useState<Message['role'] | 'all'>('all');
  const [find, setFind] = useState('');
  const [offset, setOffset] = useState(0);
  const [activeMatch, setActiveMatch] = useState(0);
  const debouncedFind = useDebounced(find, 280);
  const refs = useRef(new Map<number, HTMLElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingMatch = useRef<number | null>(null);
  const query = useMemo<MessageQuery>(() => ({
    role: role === 'all' ? undefined : role, q: debouncedFind || undefined, offset, limit: PAGE_SIZE,
  }), [role, debouncedFind, offset]);
  const requestKey = JSON.stringify([session.id, session.updatedAt, session.messageCount, query]);
  const resource = useResource(async signal => ({
    key: requestKey, sessionId: session.id, page: await api.messages(session.id, query, signal),
  }), requestKey, true);
  const page = resource.data?.key === requestKey ? resource.data.page : null;
  const roleCounts = resource.data?.sessionId === session.id ? resource.data.page.roleCounts : undefined;
  const messages = useMemo(() => page?.items.slice(0, PAGE_SIZE) ?? [], [page]);
  const debouncing = find !== debouncedFind;
  const loading = debouncing || resource.loading || (!page && !resource.error);
  const searching = debouncedFind.length > 0;
  const total = page?.total ?? 0;
  const hasNext = !!page && page.offset + messages.length < page.total;
  const canNavigate = !!page && !loading && !resource.error;

  function reveal(index: number) {
    const element = refs.current.get(index);
    (element?.querySelector('mark') ?? element)?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }

  useEffect(() => {
    setRole('all'); setFind(''); setOffset(0); setActiveMatch(0);
    setCapture(null);
    pendingMatch.current = null;
  }, [session.id]);

  useEffect(() => {
    if (!page || loading || resource.error) return;
    if (page.total > 0 && page.offset >= page.total) {
      const lastOffset = getLastMessageOffset(page.total);
      setOffset(lastOffset); setActiveMatch(lastOffset);
      pendingMatch.current = searching ? lastOffset : null;
      return;
    }
    const target = pendingMatch.current;
    if (target !== null && target >= page.offset && target < page.offset + messages.length) {
      reveal(target);
    } else {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    }
    pendingMatch.current = null;
  }, [page, loading, resource.error, messages.length, searching]);

  function changeFind(value: string) {
    setFind(value); setOffset(0); setActiveMatch(0);
    pendingMatch.current = value ? 0 : null;
  }

  function changeRole(value: typeof role) {
    setRole(value); setOffset(0); setActiveMatch(0);
    pendingMatch.current = find ? 0 : null;
  }

  function move(direction: -1 | 1) {
    if (!canNavigate || !searching || !page) return;
    const target = getFindTarget(activeMatch, page.total, direction);
    if (!target) return;
    setActiveMatch(target.index);
    if (target.offset !== page.offset) {
      pendingMatch.current = target.index;
      setOffset(target.offset);
    } else {
      reveal(target.index);
    }
  }

  function goToPage(next: number) {
    if (!canNavigate) return;
    const nextOffset = Math.max(0, next);
    setOffset(nextOffset); setActiveMatch(nextOffset);
    pendingMatch.current = searching ? nextOffset : null;
  }

  function captureMessage(message: Message) {
    let length = Math.min(8000, message.content.length);
    const last = message.content.charCodeAt(length - 1);
    if (last >= 0xd800 && last <= 0xdbff) length--;
    if (!length) return;
    setCapture({
      messageId: message.id, offset: message.contentOffset ?? 0, length,
      previewText: message.content.slice(0, length),
    });
  }

  return <div className="session-reader">
    <div className="reader-toolbar">
      <div className="role-filters" aria-label={t("메시지 역할 필터")} title={t("전체 세션의 역할별 메시지 수")}>{ROLES.map(item => {
        const count = roleCounts?.[item.value] ?? (item.value === 'all' ? session.messageCount : null);
        return <button type="button" key={item.value} aria-pressed={role === item.value} className={role === item.value ? 'active' : ''}
          onClick={() => changeRole(item.value)}>{t(item.label)}<span>{count === null ? '—' : number(count)}</span></button>;
      })}</div>
      <div className="reader-find">
        <Search size={15} aria-hidden /><input aria-label={t("대화에서 찾기")} placeholder={t("전체 대화에서 찾기")} maxLength={500}
          value={find} onChange={event => changeFind(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault(); move(event.shiftKey ? -1 : 1);
            }
          }} />
        {find && <><span className="find-count" aria-live="polite">{loading ? t("검색 중…") : total
          ? `${number(Math.min(activeMatch + 1, total))} / ${number(total)}` : t("0개")}</span>
          <IconButton label={t("이전 검색 결과")} icon={ChevronUp} disabled={!canNavigate || !total} onClick={() => move(-1)} />
          <IconButton label={t("다음 검색 결과")} icon={ChevronDown} disabled={!canNavigate || !total} onClick={() => move(1)} />
          <IconButton label={t("대화 찾기 초기화")} icon={X} onClick={() => changeFind('')} /></>}
      </div>
    </div>
    <div className={`reader-result-summary ${searching || debouncing ? 'reader-search-active' : ''}`}>
      {searching || debouncing
        ? t("전체 기록 검색 · 일치하는 메시지만 표시합니다.")
        : t("기록순 50개씩 · 역할별 개수는 전체 세션 기준")}
    </div>
    <div className="reader-scroll" ref={scrollRef} aria-busy={loading || undefined}>
      {resource.error && !debouncing ? <ErrorState compact message={resource.error} retry={resource.reload} />
        : loading ? <Skeleton rows={5} />
          : messages.length && page ? <div className="conversation-messages" key={requestKey}>
            <div className="conversation-start"><span />{dateTime(messages[0].timestamp || session.startedAt, { year: 'numeric', month: 'long', day: 'numeric' })}<span /></div>
            {messages.map((message, index) => <article key={message.id}
              ref={element => {
                if (element) refs.current.set(page.offset + index, element);
                else refs.current.delete(page.offset + index);
              }}
              className={`conversation-message message-${message.role} ${searching && activeMatch === page.offset + index ? 'message-current-match' : ''}`}
              aria-label={t("{0} 메시지", { "0": message.role === 'user' ? t("사용자") : message.role === 'assistant' ? AGENT_META[session.agent].name : message.role === 'tool' ? t("도구") : t("시스템") })}>
              <div className="message-avatar">{message.role === 'assistant' ? <ProviderMark agent={session.agent} /> :
                message.role === 'user' ? <UserRound size={17} aria-hidden /> :
                  message.role === 'tool' ? <Terminal size={17} aria-hidden /> : <Settings2 size={17} aria-hidden />}</div>
              <div className="message-main"><div className="message-meta">
                <strong>{message.role === 'user' ? t("사용자") : message.role === 'assistant' ? AGENT_META[session.agent].name : message.role === 'tool' ? message.toolName || t("도구") : t("시스템")}</strong>
                {message.model && <span className="message-model">{message.model}</span>}
                <time dateTime={message.timestamp} title={dateTime(message.timestamp)}>{dateTime(message.timestamp, { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
                <IconButton icon={Quote} label={t('컨텍스트 묶음에 추가')} className="message-context-action"
                  disabled={!message.content.length} onClick={() => captureMessage(message)} />
              </div><MessageBody sessionId={session.id} message={message} find={debouncedFind} /></div>
            </article>)}
            <div className="conversation-end"><span />{hasNext ? t("다음 페이지에서 계속됩니다") : searching
              ? t("검색 결과의 끝") : role === 'all' ? t("기록의 끝") : t("선택한 역할의 기록 끝")}<span /></div>
          </div> : <EmptyState compact title={searching ? t("검색어가 포함된 메시지가 없습니다") : t("표시할 메시지가 없습니다")}
            description={searching ? t("전체 세션을 검색했습니다. 다른 검색어나 역할을 선택해 보세요.")
              : role === 'all' ? t("이 세션에는 대화 내용이 기록되지 않았습니다.") : t("다른 역할을 선택해 대화를 확인하세요.")}
            action={searching ? <Button size="small" onClick={() => changeFind('')}><Trans message={"검색 초기화"} /></Button>
              : role !== 'all' ? <Button size="small" onClick={() => changeRole('all')}><Trans message={"모든 역할 보기"} /></Button> : undefined} />}
    </div>
    <nav className="reader-pagination" aria-label={t("메시지 페이지")}>
      <span className="reader-page-range" role="status" aria-live="polite">{loading ? t("메시지 불러오는 중…") : resource.error
        ? t("메시지를 다시 불러와 주세요.") : page && messages.length
          ? t("{0}–{1} / {2}개 {3}", { "0": number(page.offset + 1), "1": number(page.offset + messages.length), "2": number(page.total), "3": searching ? t("검색 결과") : t("메시지") })
          : t("0개 {0}", { "0": searching ? t("검색 결과") : t("메시지") })}</span>
      <div className="reader-page-actions">
        <IconButton label={t("처음 메시지")} icon={ChevronsLeft} disabled={!canNavigate || !page || page.offset === 0}
          onClick={() => goToPage(0)} />
        <Button size="small" icon={ChevronLeft} disabled={!canNavigate || !page || page.offset === 0}
          onClick={() => goToPage((page?.offset ?? 0) - PAGE_SIZE)}><Trans message={"이전 메시지"} /></Button>
        <Button size="small" disabled={!canNavigate || !hasNext}
          onClick={() => goToPage((page?.offset ?? 0) + PAGE_SIZE)}><Trans message={"다음 메시지"} /><ChevronRight size={14} aria-hidden /></Button>
        <IconButton label={t("마지막 메시지")} icon={ChevronsRight} disabled={!canNavigate || !hasNext}
          onClick={() => goToPage(getLastMessageOffset(total))} />
      </div>
    </nav>
    {capture && <Suspense fallback={<p role="status">{t('인용 준비 중…')}</p>}>
      <CaptureContextDialog sessionId={session.id} {...capture}
        projectId={projects.find(project => project.path === session.projectPath)?.id}
        onClose={() => setCapture(null)} onCaptured={() => notify('컨텍스트에 인용을 저장했습니다.')} />
    </Suspense>}
  </div>;
}
