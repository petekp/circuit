// Vendored from basecn (shadcn/ui on Base UI) — label.
// Source: https://basecn.dev/r/label.json
// Local changes: import paths; a11y suppression below (callers associate
// the label via htmlFor or by nesting the control as children).

import type * as React from 'react';

import { cn } from './utils.js';

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: generic primitive; call sites pass htmlFor or nest the control
    <label
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 peer-[[data-disabled]]:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
