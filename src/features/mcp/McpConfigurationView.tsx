import type { ReactNode } from 'react';
import type { McpClientState, McpConfigStatus, McpConfiguration, McpDetail, McpFinding } from '../../../shared/mcp';
import type { Project } from '../../../shared/types';
import { InlineNotice } from '../../components/ui';
import { CLIENT_NAMES, McpClientNames } from './McpClients';
import { useMcpI18n } from './i18n';
import { CONFIG_LABELS, endpointOrigin, SCOPE_LABELS, TRANSPORT_LABELS } from './model';

export function McpConfigBadge({ status, reason }: { status: McpConfigStatus; reason?: string }) {
  const { t, notice } = useMcpI18n();
  return <span className={`status-badge mcp-config-${status}`} title={reason ? notice(reason) : undefined}>
    <span className="status-dot" aria-hidden />{t(CONFIG_LABELS[status])}
  </span>;
}

function Value({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function Names({ items, empty }: { items: string[]; empty: string }) {
  return items.length ? <ul className="mcp-name-list">{items.map((name, index) =>
    <li key={index}><code>{name}</code></li>)}</ul> : <span className="text-muted">{empty}</span>;
}

export function McpFindings({ findings }: { findings: McpFinding[] }) {
  const { t, notice } = useMcpI18n();
  return <div className="mcp-findings">
    {findings.length ? findings.map((finding, index) =>
      <InlineNotice key={`${finding.code}-${index}`} tone={finding.level === 'error' ? 'error' : finding.level}>
        <code className="mcp-finding-code">{finding.code}</code>
        <p>{notice(finding.message)}</p>
      </InlineNotice>) : <p className="text-muted">{t('정적 진단 항목이 없습니다. 연결 점검은 별도로 진행해야 합니다.')}</p>}
  </div>;
}

export function McpConfigurationView({ configuration }: { configuration: McpConfiguration }) {
  const { t } = useMcpI18n();
  const empty = t('선언 없음');
  const url = endpointOrigin(configuration.url);
  return <section className="mcp-configuration">
    <h3>{t('마스킹된 설정')}</h3>
    <p className="mcp-hint">{t('인수 값은 모두 숨깁니다. 환경 변수와 헤더는 이름만, URL은 출처만 표시합니다.')}</p>
    <dl className="mcp-properties">
      <Value label={t('실행 명령')}>{configuration.command ? <code>{configuration.command}</code> : empty}</Value>
      <Value label={t('인수')}>
        <Names items={configuration.args.map(() => '[redacted]')} empty={empty} />
      </Value>
      <Value label={t('작업 디렉터리')}>{configuration.cwd ? <code>{configuration.cwd}</code> : empty}</Value>
      <Value label={t('서버 URL 출처')}>{url ? <code>{url}</code> : empty}</Value>
      <Value label={t('설정된 환경 변수 이름')}><Names items={configuration.environmentNames} empty={empty} /></Value>
      <Value label={t('상속·참조 환경 변수 이름')}><Names items={configuration.inheritedEnvironmentNames} empty={empty} /></Value>
      <Value label={t('헤더 이름')}><Names items={configuration.headerNames} empty={empty} /></Value>
      <Value label={t('누락된 환경 변수 이름')}><Names items={configuration.missingEnvironmentNames} empty={empty} /></Value>
      <Value label={t('OAuth 선언')}>{t(configuration.hasOAuth ? '선언 있음' : '선언 없음')}</Value>
      <Value label={t('동적 헤더 도우미')}>{t(configuration.hasHeadersHelper ? '선언 있음' : '선언 없음')}</Value>
      <Value label={t('허용 도구 선언')}>{configuration.enabledTools === null ? t('제한 선언 없음')
        : <Names items={configuration.enabledTools} empty={t('빈 목록으로 선언됨')} />}</Value>
      <Value label={t('비활성 도구 선언')}><Names items={configuration.disabledTools} empty={empty} /></Value>
    </dl>
    <p className="mcp-hint">{t('점검은 어시스턴트의 도구 권한이나 적용 중인 정책을 재현하지 않습니다.')}</p>
  </section>;
}

export function McpClientStates({ states }: { states?: McpClientState[] }) {
  const { t, notice } = useMcpI18n();
  if (!states?.length) return null;
  return <section className="mcp-consumer-states">
    <h3>{t('클라이언트별 적용 상태')}</h3>
    <p className="mcp-hint">{t('같은 선언도 CLI와 Desktop에서 우선순위가 다를 수 있습니다. 아래 값은 설정 근거이며 현재 연결 상태가 아닙니다.')}</p>
    <div className="table-scroll"><table className="data-table">
      <thead><tr><th>{t('클라이언트')}</th><th>{t('설정 상태')}</th><th>{t('설정 근거')}</th></tr></thead>
      <tbody>{states.map(state => <tr key={state.client}>
        <td>{CLIENT_NAMES[state.client] ?? state.client}</td>
        <td><McpConfigBadge status={state.status} reason={state.statusReason} /></td>
        <td>{notice(state.statusReason)}</td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}

export function McpConfigurationAnalysis({ detail, projects }: { detail: McpDetail; projects: Project[] }) {
  const { t, notice } = useMcpI18n();
  const sourceKind = {
    config: '설정 파일', plugin: '플러그인 선언', agent: '에이전트 선언', power: '파워 선언',
  }[detail.source.kind];
  return <div className="mcp-analysis">
    <section>
      <h3>{t('설정 분석')}</h3>
      <p className="mcp-hint">{t('설정 파일은 읽기 전용입니다. 목록 갱신으로 프로세스나 연결 점검을 시작하지 않습니다.')}</p>
      <dl className="mcp-properties">
        <Value label={t('설정 상태')}><McpConfigBadge status={detail.status} /></Value>
        <Value label={t('설정 근거')}>{notice(detail.statusReason)}</Value>
        <Value label={t('설정 클라이언트')}><McpClientNames source={detail.source} />
          <p className="mcp-hint">{t('설정 파일을 공유하거나 읽는 클라이언트 구분입니다. 설치 여부, 현재 선택된 클라이언트와 연결 상태는 확인하지 않습니다.')}</p>
        </Value>
        <Value label={t('어시스턴트 연결')}>{t('연결 상태 불명')}
          <p className="mcp-hint">{t('어시스턴트의 현재 연결 상태는 관측하지 않습니다.')}</p>
        </Value>
        <Value label={t('선택된 프로젝트')}>{detail.projectId
          ? projects.find(project => project.id === detail.projectId)?.name ?? t('등록되지 않은 프로젝트') : t('전역')}</Value>
        <Value label={t('범위')}>{t(SCOPE_LABELS[detail.scope])}</Value>
        <Value label={t('전송 방식')}>{t(TRANSPORT_LABELS[detail.transport])}</Value>
        <Value label={t('설정 출처')}><span>{t(sourceKind)} · {detail.source.format.toUpperCase()}</span>
          <code className="mcp-source-path">{detail.source.path}</code></Value>
        {detail.source.pluginName && <Value label={t('소속 플러그인')}>{detail.source.pluginName}</Value>}
        {detail.source.agentName && <Value label={t('소속 에이전트')}>{detail.source.agentName}</Value>}
        <Value label={t('점검 가능 여부')}>{t(detail.checkSupport === 'supported' ? '명시적 점검 가능'
          : detail.checkSupport === 'blocked' ? '설정 근거로 점검 차단' : '워크벤치 점검 미지원')}</Value>
      </dl>
    </section>
    <McpClientStates states={detail.clientStates} />
    <section><h3>{t('정적 진단')}</h3><McpFindings findings={detail.findings} /></section>
    <McpConfigurationView configuration={detail.configuration} />
  </div>;
}
