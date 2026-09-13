import { Slot } from '@radix-ui/react-slot';
import * as React from 'react';

import { cn } from '@/services/utils';

export type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
export type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const getVariantClasses = (variant: ButtonVariant): string => {
  switch (variant) {
    case 'default':
      return 'bg-primary text-primary-foreground shadow hover:bg-primary/90';
    case 'destructive':
      return 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90';
    case 'outline':
      return 'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground';
    case 'secondary':
      return 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80';
    case 'ghost':
      return 'hover:bg-accent hover:text-accent-foreground';
    case 'link':
      return 'text-primary underline-offset-4 hover:underline';
  }
};

const getSizeClasses = (size: ButtonSize): string => {
  switch (size) {
    case 'default':
      return 'h-9 px-4 py-2';
    case 'sm':
      return 'h-8 rounded-md px-3 text-xs';
    case 'lg':
      return 'h-10 rounded-md px-8';
    case 'icon':
      return 'h-9 w-9';
  }
};

const Button = React.forwardRef<HTMLButtonElement, Props>(
  ({ className, variant = 'default', size = 'default', asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    const baseClasses =
      'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0';

    return (
      <Comp
        className={cn(baseClasses, getVariantClasses(variant), getSizeClasses(size), className)}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button };
