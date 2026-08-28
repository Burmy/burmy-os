import { PageHeaderSkeleton, PageSkeleton, SectionSkeleton } from '@/components/ui/page-skeleton';

/**
 * Covers Settings and everything nested under it (Finance → Categories), which
 * is deliberate: the categories screen is a titled section with a list, the
 * same shape this already draws, so a second more specific fallback would add
 * a file without adding fidelity.
 */
export default function SettingsLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <PageHeaderSkeleton withAction={false} />
      <SectionSkeleton />
      <SectionSkeleton height="h-24" />
    </PageSkeleton>
  );
}
