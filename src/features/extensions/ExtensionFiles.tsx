import { useI18n, Trans } from '../../i18n/I18nProvider';
import { useState } from 'react';
import { FileText } from 'lucide-react';
import type { ExtensionContent, ExtensionFile } from '../../../shared/extensions';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui';
import { useResource } from '../../hooks/useResource';
import { api } from '../../lib/api';
import { ExtensionContentView } from './ExtensionContentView';
import { FILE_KIND_LABELS, formatBytes } from './model';

function FilePreview({ extensionId, file, projectId }: { extensionId: string; file: ExtensionFile; projectId?: string }) {
  const { t } = useI18n();
  const resource = useResource<ExtensionContent>(signal => api.extensionFile(extensionId, file.id, projectId, signal),
    JSON.stringify([extensionId, file.id, projectId]));
  return <section className="extension-file-preview" aria-label={t("{0} 미리보기", { "0": file.path })} aria-busy={resource.loading}>
    {resource.error ? <ErrorState message={resource.error} retry={resource.reload} compact />
      : !resource.data ? <Skeleton rows={5} />
        : <ExtensionContentView content={resource.data} />}
  </section>;
}

export function ExtensionFiles({ extensionId, files, projectId }: {
  extensionId: string; files: ExtensionFile[]; projectId?: string;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = files.find(file => file.id === selectedId && file.readable);
  if (!files.length) return <EmptyState compact icon={FileText} title={t("표시할 파일이 없습니다")}
    description={t("이 항목에서 발견한 파일이 없습니다. 내용 분석에서 검색 진단을 확인하세요.")} />;
  return <>
    <p className="extension-file-hint"><Trans message={"파일을 선택하면 읽기 전용으로 내용을 확인합니다. 미리보기가 제한된 파일은 열 수 없습니다."} /></p>
    <div className="extension-files">
      <div className="extension-file-list" role="group" aria-label={t("미리보기 파일 선택")}>
        {files.map(file => <button type="button" key={file.id}
          className={`extension-file-button ${selectedId === file.id ? 'active' : ''}`}
          disabled={!file.readable} aria-pressed={selectedId === file.id}
          aria-label={t("{0} 파일 보기", { "0": file.path })} title={file.readable ? file.path : t("이 파일은 텍스트 미리보기가 제한됩니다.")}
          onClick={() => setSelectedId(file.id)}>
          <FileText size={16} aria-hidden /><span><code>{file.path}</code>
            <small>{t(FILE_KIND_LABELS[file.kind])} · {formatBytes(file.bytes)}{!file.readable && t(" · 미리보기 제한")}</small>
          </span>
        </button>)}
      </div>
      {selected ? <FilePreview key={JSON.stringify([extensionId, selected.id, projectId])}
        extensionId={extensionId} file={selected} projectId={projectId} />
        : <EmptyState compact icon={FileText} title={t("파일을 선택하세요")}
          description={t("지시문, 참고 자료와 설정 파일의 내용을 확인할 수 있습니다.")} />}
    </div>
  </>;
}
