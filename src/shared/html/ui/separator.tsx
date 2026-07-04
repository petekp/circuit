// Vendored from basecn (shadcn/ui on Base UI) — separator.
// Source: https://basecn.dev/r/separator.json
// Local changes: import paths only.

import { Separator as SeparatorPrimitive } from '@base-ui/react/separator';

import { cn } from './utils.js';

function Separator({ className, ...props }: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      className={cn(
        'bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
