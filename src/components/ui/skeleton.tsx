import { cn } from '@/lib/utils';

/**
 * A content-shaped loading placeholder — replaces the bare spinner+text
 * pattern that used to stand in for the trophy list, the metadata-search
 * suggestions, and sync-run progress. A pulsing block roughly the shape of
 * what's about to load reads as "this is coming" rather than "something is
 * broken," and it's the concrete fix for real feedback that slow API calls
 * (PSN, IGDB) had no real waiting state.
 */
export function Skeleton({ className }: { readonly className?: string }): React.ReactElement {
  return <div className={cn('bg-muted animate-pulse rounded-md', className)} aria-hidden />;
}
