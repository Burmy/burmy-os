'use client';

import { Tabs as TabsPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>): React.ReactElement {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col', className)} {...props} />;
}

/**
 * Styled to match `SubNav`'s existing route-based top-level tabs
 * (Library/Upcoming/Stats) exactly — same `border-b`/`-mb-px border-b-2`
 * underline idiom, same active/inactive weight and color — so a tab bar
 * reads the same whether it's backed by routing or, as here, local client
 * state inside a dialog.
 */
function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>): React.ReactElement {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn('flex gap-1 border-b', className)} {...props} />;
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>): React.ReactElement {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors outline-none',
        'hover:text-foreground',
        'focus-visible:ring-ring/50 focus-visible:ring-2',
        'data-[state=active]:border-foreground data-[state=active]:text-foreground data-[state=active]:font-medium',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>): React.ReactElement {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn('outline-none', className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
