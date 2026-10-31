import { type DependencyList, useEffect, useRef, useState } from 'react';

const FOLLOW_BOTTOM_PX = 80;

/**
 * Follows the tail of a scrolling pane while the user is near it, and never
 * fights a user who has scrolled up. Attach `viewportRef` to the pane, whose
 * first child holds the content. The tail is followed again whenever
 * `triggers` change, and whenever the content or the pane resizes.
 * `scrollToBottom` jumps to the tail and follows it from then on.
 */
export function useStickToBottom({ triggers }: { triggers: DependencyList }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const followBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleScroll = () => {
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const near = distance <= FOLLOW_BOTTOM_PX;
      followBottom.current = near;
      setAtBottom(near);
    };
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, []);

  // Keep the tail visible when the triggers change (new message, stream deltas).
  // The triggers are the intentional dependencies — the effect itself only reads refs.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && followBottom.current) {
      // Use RAF to ensure DOM has updated before scrolling
      requestAnimationFrame(() => {
        viewport.scrollTop = viewport.scrollHeight;
      });
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: the triggers are the dependencies, see above
  }, triggers);

  // Chase growth that happens without a trigger changing (code blocks, images),
  // and keep the tail visible when the pane shrinks (on-screen keyboard).
  useEffect(() => {
    const viewport = viewportRef.current;
    const content = viewport?.firstElementChild;
    if (!viewport || !(content instanceof HTMLElement)) return;
    const observer = new ResizeObserver(() => {
      if (followBottom.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const scrollToBottom = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followBottom.current = true;
    viewport.scrollTop = viewport.scrollHeight;
  };

  return { viewportRef, atBottom, scrollToBottom };
}
