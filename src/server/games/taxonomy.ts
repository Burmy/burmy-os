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

export const GAME_STATUSES = ['backlog', 'playing', 'completed', 'paused_dropped', 'wanted'] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];

export const PLATFORM_LABELS: Record<GamePlatform, string> = {
  ps5: 'PS5',
  ps4: 'PS4',
  psp: 'PSP',
  // "Steam / PC" — the owner's library has zero `pc` rows (Steam covers the
  // whole PC library in practice) and the add/edit dialog no longer offers
  // `pc` as an option (see PLATFORM_PICKER_OPTIONS below), so this label
  // absorbs both concepts into the one platform that is actually used. `pc`
  // stays in the enum/type and keeps its own plain "PC" label below — a
  // hypothetical existing `pc` row still renders a sensible label rather than
  // an undefined `Record` lookup; dropping a Postgres enum value needs a
  // migration and there is no value in it for zero real rows.
  steam: 'Steam / PC',
  pc: 'PC',
  other: 'Other',
};

/**
 * The platform options offered when adding or editing a game — `GAME_PLATFORMS`
 * minus `pc`, so a new game can't be filed under a category that now
 * duplicates "Steam / PC" above. This does NOT remove `pc` from the enum, the
 * type, or `PLATFORM_LABELS`: it only narrows what the picker offers going
 * forward, leaving any existing `pc` row (and the database column itself)
 * untouched.
 */
export const PLATFORM_PICKER_OPTIONS = GAME_PLATFORMS.filter((platform) => platform !== 'pc');

export const STATUS_LABELS: Record<GameStatus, string> = {
  backlog: 'Backlog',
  playing: 'Playing',
  completed: 'Completed',
  paused_dropped: 'Paused / Dropped',
  wanted: 'Wanted',
};

export const OWNERSHIP_LABELS: Record<GameOwnership, string> = {
  physical: 'Physical',
  digital: 'Digital',
};
