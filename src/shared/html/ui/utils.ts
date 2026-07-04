// cn() — the shadcn/ui class combiner.
//
// clsx resolves conditional class fragments; tailwind-merge resolves
// conflicting Tailwind utilities (last one wins) so callers can override
// vendored component classes via className.

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
