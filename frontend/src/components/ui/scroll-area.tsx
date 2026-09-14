import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import * as React from 'react';

import { cn } from '@/services/utils';

type Props = React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
  /** Ref to the element that actually scrolls (the Radix Viewport). */
  viewportRef?: React.Ref<HTMLDivElement>;
};

const ScrollArea = React.forwardRef<React.ElementRef<typeof ScrollAreaPrimitive.Root>, Props>(
  ({ className, children, viewportRef, ...props }, ref) => (
    <ScrollAreaPrimitive.Root
      ref={ref}
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport ref={viewportRef} className="h-full w-full rounded-[inherit]">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  ),
);
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

type ScrollBarProps = React.ComponentPropsWithoutRef<
  typeof ScrollAreaPrimitive.ScrollAreaScrollbar
>;

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  ScrollBarProps
>(({ className, orientation = 'vertical', ...props }, ref) => {
  const baseClasses = 'flex touch-none select-none transition-colors';

  switch (orientation) {
    case 'horizontal':
      return (
        <ScrollAreaPrimitive.ScrollAreaScrollbar
          ref={ref}
          orientation={orientation}
          className={cn(
            baseClasses,
            className,
            'h-2.5 flex-col border-t border-t-transparent p-[1px]',
          )}
          {...props}
        >
          <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
        </ScrollAreaPrimitive.ScrollAreaScrollbar>
      );
    default:
      return (
        <ScrollAreaPrimitive.ScrollAreaScrollbar
          ref={ref}
          orientation={orientation}
          className={cn(
            baseClasses,
            className,
            'h-full w-2.5 border-l border-l-transparent p-[1px]',
          )}
          {...props}
        >
          <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
        </ScrollAreaPrimitive.ScrollAreaScrollbar>
      );
  }
});
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
