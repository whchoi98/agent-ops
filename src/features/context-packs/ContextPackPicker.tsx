import { useEffect, useId, useState } from 'react';
import { RefreshCw, Search, X } from 'lucide-react';
import type { ContextPackPage } from '../../../shared/context-packs';
import { Button, EmptyState, InlineNotice, Skeleton } from '../../components/ui';
import { useDebounced } from '../../hooks/useResource';
import { useContextPacks } from './useContextPacks';
import { selectionLimit, toggleContextPack } from './model';
import { useContextPackI18n } from './i18n';
import './context-packs.css';

export interface ContextPackPickerProps {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  /** Optional list filter; selections from other projects are never discarded. */
  projectId?: string;
  /** Defaults to five; bounded to 1–5. Use one for a capture target. */
  maxSelected?: number;
  disabled?: boolean;
  /** Increment after creating a pack locally, without refreshing bootstrap. */
  refreshKey?: number;
}

export function ContextPackSelection({
  page, selectedIds, maxSelected, disabled = false, loading, error, onToggle, onReload, onPage,
}: {
  page: ContextPackPage | null; selectedIds: string[]; maxSelected: number; disabled?: boolean;
  loading: boolean; error: string | null; onToggle: (id: string) => void; onReload: () => void;
  onPage: (offset: number) => void;
}) {
  const { t, notice } = useContextPackI18n();
  const maximum = selectionLimit(maxSelected);
  const pending = disabled || loading;
  return <fieldset className="context-pack-selection">
    <legend>{t('컨텍스트 묶음 선택')}</legend>
    <div className="context-pack-actions">
      <span role="status">{t('{count} / {max}개 선택', { count: selectedIds.length, max: maximum })}</span>
      <Button size="small" icon={RefreshCw} disabled={pending} onClick={onReload}>{t('묶음 다시 불러오기')}</Button>
    </div>
    {!!selectedIds.length && <div className="context-pack-selected" aria-label={t('선택한 묶음')}>
      {selectedIds.map(id => {
        const name = page?.items.find(pack => pack.id === id)?.name ?? id;
        return <Button key={id} size="small" icon={X} disabled={disabled}
          aria-label={`${t('선택한 묶음 제거')}: ${name}`} onClick={() => onToggle(id)}>{name}</Button>;
      })}
      {selectedIds.some(id => !page?.items.some(pack => pack.id === id)) && <p className="field-hint">{t('이 페이지에 없는 선택은 ID로 표시됩니다.')}</p>}
    </div>}
    {loading && <Skeleton rows={2} />}
    {error && <InlineNotice tone="error">{notice(error)}</InlineNotice>}
    {page && <div className="context-pack-options">
      {page.items.map(pack => {
        const selected = selectedIds.includes(pack.id);
        return <label className="context-pack-option" key={pack.id}>
          <input type="checkbox" checked={selected}
            disabled={pending || Boolean(error) || (!selected && selectedIds.length >= maximum)}
            onChange={() => onToggle(pack.id)} />
          <span><strong>{pack.name}</strong>{pack.description && <span>{pack.description}</span>}
            <small>{t('{count}개 항목, {chars}자', { count: pack.itemCount, chars: pack.totalChars.toLocaleString() })}</small>
          </span>
        </label>;
      })}
    </div>}
    {!loading && !error && !page?.items.length && <EmptyState compact title={t('컨텍스트 묶음이 없습니다')}
      description={t('메시지 인용이나 메모를 담을 묶음을 만들어 보세요.')} />}
    {page && page.total > 0 && <div className="context-pack-pagination">
      <Button size="small" disabled={pending || Boolean(error) || page.offset === 0}
        onClick={() => onPage(Math.max(0, page.offset - page.limit))}>{t('이전')}</Button>
      <span>{t('묶음 {from}–{to} / {total}개', {
        from: page.items.length ? page.offset + 1 : 0, to: Math.min(page.offset + page.items.length, page.total), total: page.total,
      })}</span>
      <Button size="small" disabled={pending || Boolean(error) || page.offset + page.limit >= page.total}
        onClick={() => onPage(page.offset + page.limit)}>{t('다음')}</Button>
    </div>}
  </fieldset>;
}

export function ContextPackPicker({
  selectedIds, onChange, projectId, maxSelected = 5, disabled = false, refreshKey = 0,
}: ContextPackPickerProps) {
  const { t } = useContextPackI18n();
  const searchId = useId();
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [onlyProject, setOnlyProject] = useState(false);
  const debounced = useDebounced(q);
  const selectedProject = onlyProject ? projectId : undefined;
  const resource = useContextPacks({ q: debounced, projectId: selectedProject, offset, limit: 25 }, refreshKey);
  useEffect(() => { setOffset(0); }, [selectedProject, debounced]);
  return <div className="context-pack-picker form-stack">
    <div className="search-input">
      <Search size={16} aria-hidden />
      <input id={searchId} aria-label={t('묶음 검색')} maxLength={500} disabled={disabled}
        value={q} onChange={event => setQ(event.target.value)} placeholder={t('묶음 검색')} />
    </div>
    {projectId && <label className="context-pack-project-filter">
      <input type="checkbox" checked={onlyProject} disabled={disabled}
        onChange={event => setOnlyProject(event.target.checked)} />
      {t('현재 프로젝트만 표시')}
    </label>}
    <ContextPackSelection page={resource.page} selectedIds={selectedIds} maxSelected={maxSelected}
      disabled={disabled} loading={resource.loading || q !== debounced} error={resource.error}
      onToggle={id => onChange(toggleContextPack(selectedIds, id, maxSelected))}
      onPage={setOffset} onReload={resource.reload} />
  </div>;
}
