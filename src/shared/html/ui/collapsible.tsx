// Adapted from basecn (shadcn/ui on Base UI) — collapsible.
// Source: https://basecn.dev/r/collapsible.json
// Local changes: rebuilt on native <details>/<summary> instead of
// CollapsiblePrimitive. Base UI's collapsible drives its panel with
// JavaScript state; these pages render to static HTML opened from
// file://, so the disclosure must work with zero script. The data-slot
// contract (collapsible / collapsible-trigger / collapsible-content)
// is preserved so styling and tests match the upstream shape.

import type * as React from 'react';

import { cn } from './utils.js';

function Collapsible({ className, ...props }: React.ComponentProps<'details'>) {
  return (
    <details data-slot="collapsible" className={cn('group/collapsible', className)} {...props} />
  );
}

function CollapsibleTrigger({ className, ...props }: React.ComponentProps<'summary'>) {
  return (
    <summary
      data-slot="collapsible-trigger"
      className={cn(
        'cursor-pointer select-none rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className,
      )}
      {...props}
    />
  );
}

function CollapsibleContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="collapsible-content" className={className} {...props} />;
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
