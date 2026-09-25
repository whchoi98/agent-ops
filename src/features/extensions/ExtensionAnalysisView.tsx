import { ArrowRight } from 'lucide-react';
import type { ExtensionDetail, ExtensionSummary } from '../../../shared/extensions';
import { InlineNotice } from '../../components/ui';
import { number, safeMarkdownUrl } from '../../lib/format';
import { ExtensionStatusBadge } from './ExtensionCatalog';
import { KIND_LABELS, SCOPE_LABELS } from './model';

function Declarations({ title, values }: { title: string; values: string[] }) {
  return <section className="extension-declaration">
    <h3>{title}</h3>
    {values.length ? <ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul>
      : <p className="text-muted">발견한 선언이 없습니다.</p>}
  </section>;
}

export function ExtensionAnalysisView({ detail, onSelect }: {
  detail: ExtensionDetail; onSelect: (item: ExtensionSummary) => void;
}) {
  const { analysis } = detail;
  return <div className="extension-analysis">
    <section className="extension-purpose">
      <div><h3>역할과 목적</h3><span>지시문 {number(analysis.lineCount)}줄</span></div>
      <p>{analysis.purpose || detail.description || '목적에 대한 설명 선언이 없습니다. 원문을 확인하세요.'}</p>
    </section>
    <p className="extension-analysis-note">파일과 설정에서 발견한 선언을 정리했습니다. 도구 실행 권한이나 실제 사용 기록을 의미하지 않습니다.</p>
    <div className="extension-declarations">
      <Declarations title="트리거" values={analysis.triggers} />
      <Declarations title="도구" values={analysis.tools} />
      <Declarations title="MCP 서버" values={analysis.mcpServers} />
      <Declarations title="훅" values={analysis.hooks} />
      <Declarations title="참고 자료" values={analysis.resources} />
      <Declarations title="참조하는 에이전트" values={analysis.usedBy} />
    </div>
    {analysis.sections.length > 0 && <Declarations title="문서 구성" values={analysis.sections} />}
    {analysis.links.length > 0 && <section className="extension-declaration">
      <h3>관련 링크</h3><ul>{analysis.links.map((link, index) => {
        const href = safeMarkdownUrl(link);
        return <li key={index}>{href ? <a href={href} target="_blank" rel="noreferrer noopener">{link}</a> : <span>{link}</span>}</li>;
      })}</ul>
    </section>}
    <section className="extension-evidence">
      <h3>상태와 설정 근거</h3>
      <p>{detail.statusReason || '활성 상태를 판단할 구체적인 근거가 제공되지 않았습니다.'}</p>
      {detail.agent === 'kiro' && detail.kind === 'power' && <InlineNotice>
        Kiro IDE의 파워 등록만으로 Kiro CLI에서 활성화되었다고 판단할 수 없습니다.
      </InlineNotice>}
      {detail.evidence.length ? <dl>{detail.evidence.map((evidence, index) => <div key={index}>
        <dt><code>{evidence.source}</code></dt><dd>{evidence.detail}</dd>
      </div>)}</dl> : <p className="text-muted">추가 설정 근거가 없습니다.</p>}
    </section>
    {(analysis.findings.length > 0 || detail.warnings.length > 0) && <section className="extension-findings">
      <h3>확인할 내용</h3>
      {analysis.findings.map((finding, index) => <InlineNotice key={index} tone={finding.level === 'warning' ? 'warning' : 'info'}>
        <strong>{finding.title}</strong><p>{finding.detail}</p>
      </InlineNotice>)}
      {detail.warnings.length > 0 && <ul className="extension-warnings">{detail.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    </section>}
    {detail.children.length > 0 && <section className="extension-children">
      <h3>포함된 확장 <span className="count-badge">{number(detail.children.length)}</span></h3>
      <div>{detail.children.map(child => <button type="button" key={child.id} className="extension-child"
        aria-label={`${child.name} 내용 보기`} onClick={() => onSelect(child)}>
        <span><strong>{child.name}</strong><small>{KIND_LABELS[child.kind]} · {SCOPE_LABELS[child.scope]}</small></span>
        <ExtensionStatusBadge status={child.status} reason={child.statusReason} /><ArrowRight size={15} aria-hidden />
      </button>)}</div>
    </section>}
    <section className="extension-metadata-section">
      <h3>메타데이터</h3>
      <dl className="extension-metadata">
        <div><dt>발견 경로</dt><dd><code>{detail.path}</code></dd></div>
        <div><dt>범위</dt><dd>{SCOPE_LABELS[detail.scope]}</dd></div>
        <div><dt>버전</dt><dd>{detail.version || '버전 선언 없음'}</dd></div>
        {detail.pluginName && <div><dt>소속 플러그인</dt><dd>{detail.pluginName}</dd></div>}
        {Object.entries(detail.metadata).map(([key, value]) => <div key={key}>
          <dt>{key}</dt><dd>{typeof value === 'string' ? value : <pre>{JSON.stringify(value, null, 2)}</pre>}</dd>
        </div>)}
      </dl>
    </section>
  </div>;
}
