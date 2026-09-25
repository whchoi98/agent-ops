import { useI18n, Trans } from '../../i18n/I18nProvider';
import { useState } from 'react';
import type { ExtensionContent } from '../../../shared/extensions';
import { Markdown } from '../../components/Markdown';
import { CopyButton, InlineNotice } from '../../components/ui';
import { formatBytes } from './model';

export function ExtensionContentView({ content }: { content: ExtensionContent }) {
  const { t } = useI18n();
  const [plain, setPlain] = useState(false);
  const markdown = /^(markdown|md)$/i.test(content.language) || /\.md$/i.test(content.path);
  return <div className="extension-content-view">
    <div className="extension-content-heading">
      <div><code>{content.path}</code><span>{content.language || 'text'} · {formatBytes(content.bytes)}</span></div>
      <CopyButton text={content.content} label={t("내용 복사")} compact />
    </div>
    {content.redacted && <InlineNotice><Trans message={"민감한 값이 마스킹된 내용입니다."} /></InlineNotice>}
    {content.truncated && <InlineNotice tone="warning"><Trans message={"미리보기 크기 제한으로 파일의 앞부분만 표시합니다."} /></InlineNotice>}
    {markdown && <div className="extension-content-modes" role="group" aria-label={t("원문 표시 방식")}>
      <button type="button" aria-pressed={!plain} className={!plain ? 'active' : ''} onClick={() => setPlain(false)}>Markdown</button>
      <button type="button" aria-pressed={plain} className={plain ? 'active' : ''} onClick={() => setPlain(true)}><Trans message={"텍스트"} /></button>
    </div>}
    {!content.content ? <p className="extension-empty-text"><Trans message={"파일이 비어 있습니다."} /></p>
      : markdown && !plain ? <div className="extension-markdown"><Markdown content={content.content} /></div>
        : <pre className="extension-source" tabIndex={0} aria-label={t("{0} 내용", { "0": content.path })}><code>{content.content}</code></pre>}
  </div>;
}
