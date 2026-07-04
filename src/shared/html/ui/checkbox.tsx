// Adapted from basecn (shadcn/ui on Base UI) — checkbox.
// Source: https://basecn.dev/r/checkbox.json
// Local changes: rebuilt on native <input type="checkbox"> instead of
// CheckboxPrimitive. Base UI's checkbox toggles checked state with
// JavaScript; these pages render to static HTML opened from file://, so
// only a native checkbox still toggles. The lucide CheckIcon indicator
// becomes a CSS glyph drawn by theme.css on [data-slot=checkbox]:checked.
// The data-slot contract is preserved; data-[checked] selectors from the
// upstream class shell become native checked: variants.

import type * as React from 'react';

import { cn } from './utils.js';

function Checkbox({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        'peer border-input dark:bg-input/30 checked:bg-primary dark:checked:bg-primary checked:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 appearance-none rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Checkbox };
