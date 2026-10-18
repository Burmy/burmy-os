'use client';

import { createContext, useContext } from 'react';

import type { Game } from '@/server/db/games/games';

/**
 * What a caller hands the panel to open it: either the full row it already
 * has in hand (a library card, a wishlist row — so the header renders the
 * instant it opens) or just an id (a member or collection swap from inside
 * the panel, which shows a skeleton until the fetch lands).
 */
export type GamePanelSeed = Game | { readonly id: string };

export interface GamePanelApi {
  /** The game the panel is showing, or `null` while it is closed. */
  readonly activeId: string | null;
  readonly openGame: (seed: GamePanelSeed) => void;
  readonly close: () => void;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PANEL IS CLIENT STATE, NOT A ROUTE.
 *
 * It lives in the Games `(tabs)` layout (`GamePanelProvider`), so the Library
 * grid and the Upcoming wishlist open the same panel in place — no
 * navigation, no `?game=` param, nothing to refresh back into. The owner
 * chose this deliberately over a deep link: closing is Esc or the X, and a
 * route change (switching tabs) closes it too.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const GamePanelContext = createContext<GamePanelApi | null>(null);

export function useGamePanel(): GamePanelApi {
  const api = useContext(GamePanelContext);
  if (api === null) throw new Error('useGamePanel must be used inside <GamePanelProvider>');
  return api;
}

export function isFullGame(seed: GamePanelSeed): seed is Game {
  return 'title' in seed;
}
