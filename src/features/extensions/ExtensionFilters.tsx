import { useI18n, Trans } from '../../i18n/I18nProvider';
import { Search, X } from 'lucide-react';
import type { ExtensionQuery } from '../../../shared/extensions';
import { AGENTS, type Agent, type Project } from '../../../shared/types';
import { Field, IconButton } from '../../components/ui';
import { AGENT_META } from '../../lib/format';
import { KIND_LABELS, SCOPE_LABELS, STATUS_LABELS } from './model';

export function ExtensionFilters({ query, projects, update }: {
  query: ExtensionQuery; projects: Project[]; update: (patch: ExtensionQuery) => void;
}) {
  const { t } = useI18n();
  return <div className="extension-filters">
    <div className="extension-search-row">
      <div className="search-input">
        <Search size={18} aria-hidden />
        <input aria-label={t("스킬·플러그인 검색")} placeholder={t("이름이나 설명으로 검색…")} maxLength={500}
          value={query.q ?? ''} onChange={event => update({ q: event.target.value || undefined })} />
        {query.q && <IconButton label={t("검색어 지우기")} icon={X} onClick={() => update({ q: undefined })} />}
      </div>
      <Field label={t("프로젝트")} htmlFor="extension-project">
        <select id="extension-project" aria-label={t("프로젝트 선택")} value={query.projectId ?? ''}
          onChange={event => update({
            projectId: event.target.value || undefined,
            scope: !event.target.value && query.scope === 'project' ? undefined : query.scope,
          })}>
          <option value=""><Trans message={"전역 · 사용자 및 시스템"} /></option>
          {projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
        </select>
      </Field>
    </div>
    <div className="extension-filter-grid">
      <Field label={t("어시스턴트")} htmlFor="extension-agent">
        <select id="extension-agent" aria-label={t("어시스턴트 필터")} value={query.agent ?? ''}
          onChange={event => update({ agent: event.target.value as Agent || undefined })}>
          <option value=""><Trans message={"모든 어시스턴트"} /></option>
          {AGENTS.map(agent => <option key={agent} value={agent}>{AGENT_META[agent].name}</option>)}
        </select>
      </Field>
      <Field label={t("종류")} htmlFor="extension-kind">
        <select id="extension-kind" aria-label={t("종류 필터")} value={query.kind ?? ''}
          onChange={event => update({ kind: event.target.value as ExtensionQuery['kind'] || undefined })}>
          <option value=""><Trans message={"모든 종류"} /></option>
          {Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </Field>
      <Field label={t("설정 상태")} htmlFor="extension-status">
        <select id="extension-status" aria-label={t("설정 상태 필터")} value={query.status ?? ''}
          onChange={event => update({ status: event.target.value as ExtensionQuery['status'] || undefined })}>
          <option value=""><Trans message={"모든 상태"} /></option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </Field>
      <Field label={t("범위")} htmlFor="extension-scope">
        <select id="extension-scope" aria-label={t("범위 필터")} value={query.scope ?? ''}
          onChange={event => update({ scope: event.target.value as ExtensionQuery['scope'] || undefined })}>
          <option value=""><Trans message={"모든 범위"} /></option>
          {Object.entries(SCOPE_LABELS).map(([value, label]) =>
            <option key={value} value={value} disabled={value === 'project' && !query.projectId}>{t(label)}</option>)}
        </select>
      </Field>
    </div>
    <p className="field-hint"><Trans message={"등록된 프로젝트를 선택하면 해당 프로젝트의 확장과 적용 설정도 함께 확인합니다."} /></p>
  </div>;
}
