import {
  Children, cloneElement, isValidElement, memo, useEffect, useId, useRef, useState, type ReactNode,
} from 'react';
import { ChevronDown, ChevronUp, FileImage, Maximize2, RefreshCw, Wrench } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from '../../../shared/types';
import { Markdown, highlightText } from '../../components/Markdown';
import { Button, CopyButton, InlineNotice } from '../../components/ui';
import { api } from '../../lib/api';
import { errorMessage, number, safeMarkdownUrl } from '../../lib/format';

const PREVIEW_LENGTH = 16_000;

export function messagePreview(message: Message) {
  const content = message.content.slice(0, PREVIEW_LENGTH);
  return {
    content,
    truncated: Boolean(message.truncated || message.content.length > PREVIEW_LENGTH
      || (message.contentLength !== undefined && message.contentLength > content.length)),
    contentLength: message.contentLength ?? (message.content.length > PREVIEW_LENGTH ? message.content.length : undefined),
  };
}

function highlighted(children: ReactNode, find: string): ReactNode {
  if (!find) return children;
  return Children.map(children, child => {
    if (typeof child === 'string') return highlightText(child, find);
    if (!isValidElement<{ children?: ReactNode }>(child) || child.type === 'mark') return child;
    return child.props.children ? cloneElement(child, {}, highlighted(child.props.children, find)) : child;
  });
}

function plainText(children: ReactNode): string {
  return Children.toArray(children).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    return isValidElement<{ children?: ReactNode }>(child) ? plainText(child.props.children) : '';
  }).join('');
}

// Reached only after an explicit full-message request. The shared Markdown
// component intentionally retains its own 32,000-character preview.
export const FullMessageMarkdown = memo(function FullMessageMarkdown({ content, find = '' }: { content: string; find?: string }) {
  return <div className="markdown message-full-markdown">
    <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={safeMarkdownUrl} components={{
      a: ({ children, href }) => href
        ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
        : <span>{children}</span>,
      img: ({ alt }) => <span className="markdown-image"><FileImage size={15} aria-hidden />{alt || '이미지'}<span>자동 로드하지 않음</span></span>,
      pre: ({ children }) => <div className="code-block">
        <div className="code-heading"><span>CODE</span><CopyButton text={plainText(children)} compact label="코드 복사" /></div>
        <pre>{children}</pre>
      </div>,
      code: ({ children, className }) => <code className={className}>{highlighted(children, find)}</code>,
      p: ({ children }) => <p>{highlighted(children, find)}</p>,
      li: ({ children }) => <li>{highlighted(children, find)}</li>,
      h1: ({ children }) => <h3>{highlighted(children, find)}</h3>,
      h2: ({ children }) => <h3>{highlighted(children, find)}</h3>,
      h3: ({ children }) => <h4>{highlighted(children, find)}</h4>,
      h4: ({ children }) => <h5>{highlighted(children, find)}</h5>,
      table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>,
      td: ({ children }) => <td>{highlighted(children, find)}</td>,
      th: ({ children }) => <th>{highlighted(children, find)}</th>,
    }}>{content}</ReactMarkdown>
  </div>;
});

export const MessageBody = memo(function MessageBody({ sessionId, message, find }: {
  sessionId: string; message: Message; find: string;
}) {
  const preview = messagePreview(message);
  const [full, setFull] = useState<Message | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const contentId = useId();
  const expanded = full !== null;
  const content = full?.content ?? preview.content;
  useEffect(() => () => controller.current?.abort(), [sessionId, message.id]);

  async function expand() {
    if (loading) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError('');
    try {
      const result = await api.message(sessionId, message.id, request.signal);
      if (!request.signal.aborted) setFull(result);
    } catch (cause) {
      if (!request.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }

  function collapse() {
    controller.current?.abort();
    setFull(null);
    setLoading(false);
    setError('');
  }

  return <div className="message-body">
    {preview.truncated && <div className="message-expansion-controls">
      <span>{expanded ? `전체 내용 · ${number(content.length)}자`
        : preview.contentLength !== undefined ? `미리보기 · 전체 ${number(preview.contentLength)}자 중 일부`
          : '긴 메시지의 일부를 표시합니다.'}</span>
      <Button size="small" icon={expanded ? ChevronUp : error ? RefreshCw : Maximize2} busy={loading}
        aria-expanded={expanded} aria-controls={contentId} onClick={() => expanded ? collapse() : void expand()}>
        {expanded ? '미리보기로 접기' : error ? '다시 시도' : '전체 메시지 보기'}
      </Button>
    </div>}
    {loading && <p className="message-full-loading" role="status">전체 메시지를 불러오는 중입니다.</p>}
    {error && <InlineNotice tone="error"><strong>전체 메시지를 불러오지 못했습니다.</strong><p>{error}</p></InlineNotice>}
    <div id={contentId} className="message-content" aria-busy={loading || undefined}>
      {message.role === 'tool' ? <details className={`tool-block ${message.isError ? 'tool-error' : ''}`}
        open={message.isError || !!find || expanded}>
        <summary><Wrench size={15} aria-hidden /><strong>{message.toolName || '도구 출력'}</strong>
          <span className="tool-result-label">{message.isError ? '오류' : '도구 결과'}</span><ChevronDown size={15} className="tool-chevron" aria-hidden /></summary>
        <pre><code>{highlightText(content, find)}</code></pre>
      </details> : expanded ? <FullMessageMarkdown content={content} find={find} />
        : preview.truncated ? <pre className="message-content-preview">{highlightText(preview.content, find)}</pre>
          : <Markdown content={preview.content} find={find} />}
    </div>
  </div>;
});
