'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { setSidebarCollapsed } from './sidebar-actions';

/** Same round-trip pattern as `ThemeToggle` — see `sidebar-actions.ts`. */
export function SidebarToggle({ collapsed }: { readonly collapsed: boolean }): React.ReactElement {
  const [pending, startTransition] = useTransition();
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      disabled={pending}
      className="size-8"
      onClick={() => startTransition(async () => {
        await setSidebarCollapsed(!collapsed);
      })}
    >
      <Icon className="size-4" />
    </Button>
  );
}
