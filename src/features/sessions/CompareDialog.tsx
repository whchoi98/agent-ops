import { useFormat } from '../../i18n/useFormat';
import { useI18n, Trans } from '../../i18n/I18nProvider';
import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { SessionDetail } from '../../../shared/types';
import { Dialog } from '../../components/Dialog';
import { AgentBadge, Button, ErrorState, InlineNotice, Skeleton, StatusBadge, TokenValue } from '../../components/ui';
import { api } from '../../lib/api';
import { number, recordedDuration } from '../../lib/format';
import { useResource } from '../../hooks/useResource';
import { useApp } from '../../state/AppProvider';

export function CompareDialog({ ids }: { ids: [string, string] }) {
  const { money, dateTime, duration } = useFormat();
  const { t } = useI18n();
  const { closeModal, openSession } = useApp();
  const resource = useResource(signal => Promise.all(ids.map(id => api.session(id, signal))), JSON.stringify(ids));
  const metric = (value: number | null) => value === null ? <span className="text-muted"><Trans message={"미기록"} /></span> : number(value);
  const rows: Array<{ label: string; render: (session: SessionDetail) => ReactNode }> = [
    { label: '에이전트', render: session => <AgentBadge agent={session.agent} /> },
    { label: '프로젝트', render: session => session.projectName || t('미지정') },
    { label: '모델', render: session => <div className="compare-models">{[...new Set([session.model, ...session.messages.map(message => message.model)].filter(Boolean))].map(model => <code key={model}>{model}</code>)}</div> },
    { label: '상태', render: session => <StatusBadge status={session.status} /> },
    { label: '메시지', render: session => number(session.messageCount) },
    { label: '도구 호출', render: session => number(session.toolCallCount) },
    { label: '입력 토큰', render: session => metric(session.usage.inputTokens) },
    { label: '출력 토큰', render: session => metric(session.usage.outputTokens) },
    { label: '총 토큰', render: session => <TokenValue usage={session.usage} compact={false} /> },
    { label: '캐시 읽기', render: session => metric(session.usage.cacheReadTokens) },
    { label: '캐시 쓰기', render: session => metric(session.usage.cacheWriteTokens) },
    { label: '기록된 비용', render: session => money(session.usage.costUsd) },
    { label: '첫 기록', render: session => dateTime(session.startedAt) },
    { label: '마지막 기록', render: session => dateTime(session.updatedAt) },
    { label: '기록 시간 범위', render: session => duration(recordedDuration(session.startedAt, session.updatedAt)) },
  ];
  return <Dialog title={t("세션 비교")} description={t("두 세션에 기록된 모델, 사용량과 시간을 나란히 확인하세요.")} onClose={closeModal} size="large" className="compare-dialog">
    {resource.error ? <ErrorState message={resource.error} retry={resource.reload} /> : !resource.data ? <Skeleton rows={8} /> : <>
      <InlineNotice><Trans message={"미기록은 0이 아닙니다. 기록 시간 범위에는 대화 사이의 대기 시간도 포함됩니다."} /></InlineNotice>
      <div className="comparison-scroll"><table className="comparison-table"><thead><tr><th><Trans message={"비교 항목"} /></th>{resource.data.map(session =>
        <th key={session.id}><span>{session.title}</span><Button variant="ghost" size="small" icon={ArrowUpRight} onClick={() => openSession(session.id)}><Trans message={"대화 열기"} /></Button></th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.label}><th>{t(row.label)}</th>{resource.data!.map(session => <td key={session.id}>{row.render(session)}</td>)}</tr>)}</tbody>
      </table></div>
    </>}
  </Dialog>;
}
