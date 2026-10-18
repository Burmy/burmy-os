'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import { GamePanel } from './game-panel';
import { type GamePanelApi, GamePanelContext, type GamePanelSeed } from './game-panel-context';

/**
 * Holds which game the side panel is showing, for every Games tab at once.
 *
 * Mounted by `src/app/(private)/games/(tabs)/layout.tsx` (a Server Component)
 * around its children, which is what lets a Library card and an Upcoming
 * wishlist row open the same panel without changing route.
 *
 * SIDE BY SIDE, NOT ON TOP. While the panel is open the page content gets
 * right padding equal to the panel's width, so the library reflows into the
 * space beside it instead of sitting underneath a 520px overlay — the grid
 * stays readable and clickable, which is the whole point of a non-modal
 * panel (see `GamePanel`).
 *
 * Closing on navigation uses the compare-during-render pattern CLAUDE.md
 * documents, not a `useEffect` — `react-hooks/set-state-in-effect` exists to
 * catch exactly the effect version of this.
 */
export function GamePanelProvider({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  const pathname = usePathname();
  const [seenPath, setSeenPath] = useState(pathname);
  const [seed, setSeed] = useState<GamePanelSeed | null>(null);

  if (pathname !== seenPath) {
    setSeenPath(pathname);
    setSeed(null);
  }

  const close = useCallback(() => setSeed(null), []);
  const activeId = seed?.id ?? null;
  const api = useMemo<GamePanelApi>(
    () => ({ activeId, openGame: setSeed, close }),
    [activeId, close],
  );

  return (
    <GamePanelContext.Provider value={api}>
      <div className={cn('transition-[padding] duration-200', seed !== null && 'sm:pr-[536px]')}>
        {children}
      </div>
      <GamePanel seed={seed} onClose={close} onOpen={setSeed} />
    </GamePanelContext.Provider>
  );
}
