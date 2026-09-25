import { Children, cloneElement, isValidElement, memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileImage, Maximize2 } from 'lucide-react';
import { safeMarkdownUrl } from '../lib/format';
import { Button, CopyButton } from './ui';

export function highlightText(text: string, needle: string): ReactNode {
  if (!needle.trim()) return text;
  const lower = text.toLocaleLowerCase();
  const query = needle.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let found = lower.indexOf(query);
  let count = 0;
  while (found !== -1 && count < 1500) {
    parts.push(text.slice(cursor, found), <mark key={`${found}-${count}`}>{text.slice(found, found + query.length)}</mark>);
    cursor = found + query.length;
    found = lower.indexOf(query, cursor);
    count += 1;
  }
  parts.push(text.slice(cursor));
  return parts;
}

function highlightChildren(children: ReactNode, needle: string): ReactNode {
  if (!needle) return children;
  return Children.map(children, child => {
    if (typeof child === 'string') return highlightText(child, needle);
    if (isValidElement(child) && child.type === 'mark') return child;
    if (isValidElement<{ children?: ReactNode }>(child) && child.props.children) {
      return cloneElement(child, {}, highlightChildren(child.props.children, needle));
    }
    return child;
  });
}

function textContent(children: ReactNode): string {
  return Children.toArray(children).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    return isValidElement<{ children?: ReactNode }>(child) ? textContent(child.props.children) : '';
  }).join('');
}

export const Markdown = memo(function Markdown({ content, find = '' }: { content: string; find?: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > 32_000;
  const visible = isLong && !expanded && !find ? content.slice(0, 32_000) : content;
  return <div className="markdown">
    <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={safeMarkdownUrl} components={{
      a: ({ children, href }) => href
        ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
        : <span>{children}</span>,
      img: ({ alt }) => <span className="markdown-image"><FileImage size={15} aria-hidden />{alt || '이미지'}<span>자동 로드하지 않음</span></span>,
      pre: ({ children }) => <div className="code-block">
        <div className="code-heading"><span>CODE</span><CopyButton text={textContent(children)} compact label="코드 복사" /></div>
        <pre>{children}</pre>
      </div>,
      code: ({ children, className }) => <code className={className}>{highlightChildren(children, find)}</code>,
      p: ({ children }) => <p>{highlightChildren(children, find)}</p>,
      li: ({ children }) => <li>{highlightChildren(children, find)}</li>,
      h1: ({ children }) => <h3>{highlightChildren(children, find)}</h3>,
      h2: ({ children }) => <h3>{highlightChildren(children, find)}</h3>,
      h3: ({ children }) => <h4>{highlightChildren(children, find)}</h4>,
      h4: ({ children }) => <h5>{highlightChildren(children, find)}</h5>,
      table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>,
      td: ({ children }) => <td>{highlightChildren(children, find)}</td>,
      th: ({ children }) => <th>{highlightChildren(children, find)}</th>,
    }}>{visible}</ReactMarkdown>
    {isLong && !expanded && !find && <div className="long-content-notice">
      <span>긴 메시지의 앞부분을 표시하고 있습니다.</span>
      <Button size="small" icon={Maximize2} onClick={() => setExpanded(true)}>전체 메시지 보기</Button>
    </div>}
  </div>;
});
