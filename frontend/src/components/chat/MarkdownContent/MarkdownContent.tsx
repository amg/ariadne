import { cn } from '@/services/utils';
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { markdownComponents } from './components';

/**
 * Renders one markdown document inside an assistant bubble (GFM tables,
 * task lists, strikethrough; fenced code highlighted via rehype-highlight).
 * Memoized so settled rows never re-parse on unrelated re-renders; the one
 * actively streaming row re-renders per chunk by design.
 */

type Props = {
  content: string;
  /** True while the row is still streaming — appends a blinking caret. */
  streaming?: boolean;
  /** Allows parents to inject layout/margin classes. */
  className?: string;
};

function MarkdownContent({ content, streaming = false, className }: Props) {
  return (
    <div className={cn('min-w-0 max-w-full', className, streaming && 'markdown-cursor')}>
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
