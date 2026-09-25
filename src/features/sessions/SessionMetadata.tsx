import { useState, type FormEvent } from 'react';
import { Save } from 'lucide-react';
import type { SessionDetail } from '../../../shared/types';
import { Button, CopyButton, Field, InlineNotice, TokenValue } from '../../components/ui';
import { api } from '../../lib/api';
import { dateTime, duration, errorMessage, money, number, parseTags, recordedDuration } from '../../lib/format';
import { useApp } from '../../state/AppProvider';

export function SessionMetadata({ session, onSaved }: { session: SessionDetail; onSaved: (session: SessionDetail) => void }) {
  const { notify, refresh } = useApp();
  const [title, setTitle] = useState(session.title);
  const [note, setNote] = useState(session.note);
  const [tags, setTags] = useState(session.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = title !== session.title || note !== session.note || JSON.stringify(parseTags(tags)) !== JSON.stringify(session.tags);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) { setError('세션 제목을 입력하세요.'); return; }
    setSaving(true); setError('');
    try {
      const updated = await api.updateSession(session.id, { title: title.trim(), note, tags: parseTags(tags) });
      setTitle(updated.title); setNote(updated.note); setTags(updated.tags.join(', '));
      onSaved(updated);
      await refresh(true);
      notify('세션 메모와 태그를 저장했습니다.');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  return <form onSubmit={save} className="metadata-form">
    <div className="form-section-intro"><h3>나중을 위한 메모</h3><p>다음 작업자가 알아야 할 맥락과 결정 사항을 남겨두세요.</p></div>
    <Field label="세션 제목" htmlFor="metadata-title"><input id="metadata-title" required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></Field>
    <Field label="태그" htmlFor="metadata-tags" hint="쉼표로 구분하세요. 태그는 세션 탐색에서 검색할 수 있습니다.">
      <input id="metadata-tags" value={tags} placeholder="리뷰, 버그 수정, 다음 작업" onChange={event => setTags(event.target.value)} />
      {parseTags(tags).length > 0 && <div className="tag-preview">{parseTags(tags).map(tag => <span className="tag" key={tag}>#{tag}</span>)}</div>}
    </Field>
    <Field label="메모" htmlFor="metadata-note" hint="저장할 때 공통 자격증명 패턴을 마스킹합니다.">
      <textarea id="metadata-note" rows={9} maxLength={16_000} value={note} placeholder="진행한 작업, 다음 단계, 기억할 내용을 적어주세요."
        onChange={event => setNote(event.target.value)} />
    </Field>
    {error && <InlineNotice tone="error">{error}</InlineNotice>}
    <div className="form-actions"><span className="text-muted">{dirty ? '저장하지 않은 변경사항이 있습니다.' : '변경사항이 저장되어 있습니다.'}</span>
      <Button type="submit" variant="primary" icon={Save} busy={saving} disabled={!dirty}>메모·태그 저장</Button></div>
  </form>;
}

export function SessionInfo({ session }: { session: SessionDetail }) {
  const { openSession } = useApp();
  const metric = (value: number | null) => value === null ? '미기록' : number(value);
  return <div className="session-info">
    <div className="form-section-intro"><h3>기록된 사용량</h3><p>CLI 기록에 포함된 값입니다. 미기록은 0을 의미하지 않습니다.</p></div>
    <dl className="info-metrics">
      <div><dt>입력 토큰</dt><dd>{metric(session.usage.inputTokens)}</dd></div>
      <div><dt>출력 토큰</dt><dd>{metric(session.usage.outputTokens)}</dd></div>
      <div><dt>총 토큰</dt><dd><TokenValue usage={session.usage} compact={false} /></dd></div>
      <div><dt>캐시 읽기</dt><dd>{metric(session.usage.cacheReadTokens)}</dd></div>
      <div><dt>캐시 쓰기</dt><dd>{metric(session.usage.cacheWriteTokens)}</dd></div>
      <div><dt>기록된 비용</dt><dd>{money(session.usage.costUsd)}</dd></div>
    </dl>
    <dl className="detail-properties">
      <div><dt>모델</dt><dd className="mono">{session.model || '미기록'}</dd></div>
      <div><dt>프로젝트</dt><dd>{session.projectName || '미지정'}<code>{session.projectPath || '경로 미기록'}</code></dd></div>
      <div><dt>첫 기록</dt><dd>{dateTime(session.startedAt)}</dd></div>
      <div><dt>마지막 기록</dt><dd>{dateTime(session.updatedAt)}</dd></div>
      <div><dt>기록 시간 범위</dt><dd>{duration(recordedDuration(session.startedAt, session.updatedAt))}<small>첫 기록과 마지막 기록 사이의 시간이며 실제 실행 시간과 다를 수 있습니다.</small></dd></div>
      <div><dt>메시지 / 도구 호출</dt><dd>{number(session.messageCount)} / {number(session.toolCallCount)}</dd></div>
    </dl>
    <details className="source-details"><summary>원본 기록 정보</summary><dl className="detail-properties">
      <div><dt>CLI 세션 ID</dt><dd className="with-copy"><code>{session.nativeId || '미기록'}</code>{session.nativeId && <CopyButton text={session.nativeId} compact label="CLI 세션 ID 복사" />}</dd></div>
      <div><dt>원본 파일</dt><dd><code>{session.sourcePath || '미기록'}</code></dd></div>
      {session.parentId && <div><dt>상위 세션</dt><dd><button type="button" className="text-button" onClick={() => openSession(session.parentId!)}>상위 세션 열기</button><code>{session.parentId}</code></dd></div>}
    </dl></details>
  </div>;
}
