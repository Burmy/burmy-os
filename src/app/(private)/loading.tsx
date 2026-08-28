import { PageHeaderSkeleton, PageSkeleton, SectionSkeleton } from '@/components/ui/page-skeleton';

/**
 * The private area's outermost fallback — the one that shows when a navigation
 * crosses between sections (Finance → Games) and the destination's own segment
 * boundary has not taken over yet.
 *
 * Deliberately the vaguest of the fallbacks, because it is the only one that
 * cannot know where it is going. Every segment below now has its own,
 * route-shaped, so this is a genuine last resort rather than the thing most
 * navigations hit — which is what it used to be.
 */
export default function PrivateLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <PageHeaderSkeleton withAction={false} />
      <SectionSkeleton />
    </PageSkeleton>
  );
}
