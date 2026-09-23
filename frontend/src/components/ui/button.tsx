import { Slot } from '@radix-ui/react-slot';
import * as React from 'react';

import { cn } from '@/services/utils';

type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const Button = React.forwardRef<HTMLButtonElement, Props>(
  ({ className, variant = 'default', size = 'default', asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    const baseClasses =
      'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0';

    const sizes: Record<ButtonSize, string> = {
      default: 'h-9 px-4 py-2',
      sm: 'h-8 rounded-md px-3 text-xs',
      lg: 'h-10 rounded-md px-8',
      icon: 'h-9 w-9',
    };

    switch (variant) {
      case 'destructive':
        return (
          <Comp
            ref={ref}
            className={cn(
              baseClasses,
              className,
              'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
              sizes[size],
            )}
            {...props}
          />
        );
      case 'outline':
        return (
          <Comp
            ref={ref}
            className={cn(
              baseClasses,
              className,
              'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
              sizes[size],
            )}
            {...props}
          />
        );
      case 'secondary':
        return (
          <Comp
            ref={ref}
            className={cn(
              baseClasses,
              className,
              'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
              sizes[size],
            )}
            {...props}
          />
        );
      case 'ghost':
        return (
          <Comp
            ref={ref}
            className={cn(
              baseClasses,
              className,
              'hover:bg-accent hover:text-accent-foreground',
              sizes[size],
            )}
            {...props}
          />
        );
      case 'link':
        return (
          <Comp
            ref={ref}
            className={cn(
              baseClasses,
              className,
              'text-primary underline-offset-4 hover:underline',
              sizes[size],
            )}
            {...props}
          />
        );
      default:
        return (
          <Comp
            ref={ref}
            className={cn(
              baseClasses,
              className,
              'bg-primary text-primary-foreground shadow hover:bg-primary/90',
              sizes[size],
            )}
            {...props}
          />
        );
    }
  },
);
Button.displayName = 'Button';

export { Button };
