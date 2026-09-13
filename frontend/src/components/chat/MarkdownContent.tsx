import { cn } from '@/services/utils';
import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

/**
 * Renders one markdown document inside an assistant bubble (GFM tables,
 * task lists, strikethrough; fenced code highlighted via rehype-highlight).
 * Memoized so settled rows never re-parse on unrelated re-renders; the one
 * actively streaming row re-renders per chunk by design.
 */

const markdownComponents: Components = {
  p: ({ children }) => <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="mb-1.5 mt-3 text-lg font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-3 text-base font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-3 text-[15px] font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => <h4 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h5>,
  h6: ({ children }) => <h6 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h6>,
  ul: ({ children }) => (
    <ul className="my-1.5 list-disc space-y-1 pl-5 marker:text-muted-foreground">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 list-decimal space-y-1 pl-5 marker:text-muted-foreground">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed [&>ol]:my-1 [&>ul]:my-1">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-muted-foreground">{children}</del>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-neutral-600 pl-3 text-neutral-300 first:mt-0 last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-neutral-700" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-md border border-neutral-800">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-neutral-700 bg-neutral-800/70 px-2.5 py-1.5 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-neutral-800 px-2.5 py-1.5 align-top">{children}</td>
  ),
  img: ({ src, alt }) => (
    <img src={src} alt={alt ?? ''} className="my-2 max-w-full rounded-md" loading="lazy" />
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md border border-neutral-800 bg-neutral-900/80 p-3 text-[13px] leading-relaxed first:mt-0 last:mb-0">
      {children}
    </pre>
  ),
  // `code` arrives for both inline spans and the inner element of <pre>
  // blocks — blocks carry a language-* class (or newlines), inline never.
  code: ({ className, children }) => {
    const isInline = !className && !String(children).includes('\n');

    if (isInline) {
      return (
        <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[0.85em]">
          {children}
        </code>
      );
    }

    return <code className="font-mono">{children}</code>;
  },
};

type Props = {
  content: string;
  /** True while the row is still streaming — appends a blinking caret. */
  streaming?: boolean;
};

function MarkdownContent({ content, streaming = false }: Props) {
  return (
    <div className={cn('min-w-0 max-w-full', streaming && 'markdown-cursor')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default memo(MarkdownContent);
