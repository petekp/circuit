// Adapted from basecn (shadcn/ui on Base UI) — radio-group.
// Source: https://basecn.dev/r/radio-group.json
// Local changes: rebuilt on native <input type="radio"> instead of
// RadioGroupPrimitive. Base UI's radio group toggles checked state with
// JavaScript; these pages render to static HTML opened from file://, so
// native radios (grouped by the name attribute) are the only ones that
// still toggle. The lucide CircleIcon indicator becomes a CSS dot drawn
// by theme.css on [data-slot=radio-group-item]:checked. The data-slot
// contract and the upstream class shell are preserved.

import type * as React from 'react';

import { cn } from './utils.js';

function RadioGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      role="radiogroup"
      data-slot="radio-group"
      className={cn('grid gap-3', className)}
      {...props}
    />
  );
}

function RadioGroupItem({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type="radio"
      data-slot="radio-group-item"
      className={cn(
        'border-input text-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 aspect-square size-4 shrink-0 appearance-none rounded-full border shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 checked:border-primary',
        className,
      )}
      {...props}
    />
  );
}

export { RadioGroup, RadioGroupItem };
