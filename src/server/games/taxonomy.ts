/**
 * The Games module's shared vocabulary — platform, ownership, and status
 * values, plus their display labels.
 *
 * Kept pure and framework-free, alongside `hours.ts` and `stats.ts`, precisely
 * so client components can import these const tuples and label maps directly
 * for form options and badges without pulling `getDb()`/drizzle into the
 * browser bundle the way importing them from the data-access layer would.
 */

export const GAME_PLATFORMS = ['ps5', 'ps4', 'psp', 'steam', 'pc', 'other'] as const;
export type GamePlatform = (typeof GAME_PLATFORMS)[number];

export const GAME_OWNERSHIPS = ['physical', 'digital'] as const;
export type GameOwnership = (typeof GAME_OWNERSHIPS)[number];

export const GAME_STATUSES = ['backlog', 'playing', 'completed', 'paused_dropped'] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];

export const PLATFORM_LABELS: Record<GamePlatform, string> = {
  ps5: 'PS5',
  ps4: 'PS4',
  psp: 'PSP',
  steam: 'Steam',
  pc: 'PC',
  other: 'Other',
};

export const STATUS_LABELS: Record<GameStatus, string> = {
  backlog: 'Backlog',
  playing: 'Playing',
  completed: 'Completed',
  paused_dropped: 'Paused / Dropped',
};

export const OWNERSHIP_LABELS: Record<GameOwnership, string> = {
  physical: 'Physical',
  digital: 'Digital',
};
