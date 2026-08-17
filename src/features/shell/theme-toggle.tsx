'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTransition } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Theme } from '@/server/security/theme';
import { setTheme } from './theme-actions';

// `satisfies` rather than `:` so the tuple keeps a non-empty type — otherwise
// indexing it needs a possibly-undefined check that has no real failure mode.
const OPTIONS = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
] as const satisfies ReadonlyArray<{ value: Theme; label: string; Icon: typeof Sun }>;

/**
 * Theme picker.
 *
 * Calls a Server Action rather than flipping a class client-side, because the
 * theme lives in a cookie that the server reads during SSR (no inline script, no
 * flash — see src/server/security/theme.ts). The trade is a round trip, which
 * `useTransition` makes visible instead of janky.
 */
export function ThemeToggle({ current }: { readonly current: Theme }): React.ReactElement {
  const [pending, startTransition] = useTransition();
  const Active = (OPTIONS.find((option) => option.value === current) ?? OPTIONS[0]).Icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Theme: ${current}`}
          disabled={pending}
          className="size-8"
        >
          <Active className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {OPTIONS.map(({ value, label, Icon }) => (
          <DropdownMenuItem
            key={value}
            onSelect={() => {
              startTransition(async () => {
                await setTheme(value);
              });
            }}
            className={value === current ? 'font-medium' : undefined}
          >
            <Icon className="size-4" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
