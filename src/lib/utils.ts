import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, resolving Tailwind conflicts so the last one wins.
 *
 * `clsx` flattens conditionals; `twMerge` then de-duplicates competing utilities
 * (`px-2 px-4` → `px-4`). Without the second step a variant prop cannot override
 * a base class, which is the whole mechanism shadcn components rely on.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
