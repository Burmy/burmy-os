'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { Button } from '@/components/ui/button';

/** Purely presentational — `Sidebar` owns the collapsed state and the toggle handler. */
export function SidebarToggle({
  collapsed,
  onToggle,
}: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}): React.ReactElement {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      className="size-8"
      onClick={onToggle}
    >
      <Icon className="size-4" />
    </Button>
  );
}
