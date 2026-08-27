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

/**
 * Three VISIBLE states — `backlog`, `playing`, `wanted` — plus `played`, an
 * invisible default for "this game has simply been played." Real usage
 * showed `completed` (now `played`) describing 171 of 180 games: a status
 * that describes 95% of the library carries no information, so `played`
 * renders no badge at all (`StatusBadge` returns `null` for it) rather than
 * standing out as a fourth thing to scan past on every card.
 *
 * `played` is a deliberate non-null SENTINEL, not a nullable column — making
 * "no status" a `NULL` would turn every `WHERE status = …`, every count, and
 * the `wanted` exclusion in `listGameStatRows` into null-aware SQL, real bug
 * surface for what is otherwise a plain non-null comparison everywhere else.
 *
 * `paused_dropped` is deliberately NOT in this list even though the
 * Postgres `game_status` type still contains it (see `schema.ts`) — it had
 * zero rows when this was decided and dropping a Postgres enum VALUE isn't
 * supported, only adding/renaming one. Removing it here makes it
 * unreachable from the app; the dead label stays in the database type
 * because there is no cheap way to remove it and nothing needs to.
 */
export const GAME_STATUSES = ['backlog', 'playing', 'played', 'wanted'] as const;
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

/**
 * `played`'s label is still real text (used by `StatusBadge`'s `onImage`
 * variant's `aria-label`-adjacent uses and anywhere a status needs to be
 * NAMED rather than badged, e.g. the library filter chip) even though the
 * badge itself never renders for it — see `GAME_STATUSES` above.
 */
export const STATUS_LABELS: Record<GameStatus, string> = {
  backlog: 'Backlog',
  playing: 'Playing',
  played: 'Played',
  wanted: 'Wanted',
};

export const OWNERSHIP_LABELS: Record<GameOwnership, string> = {
  physical: 'Physical',
  digital: 'Digital',
};
