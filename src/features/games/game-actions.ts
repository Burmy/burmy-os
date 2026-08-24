'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { DuplicateGameError, GameNotFoundError } from '@/server/db/games/errors';
import { type Game, type GameInput, createGame, deleteGame, getGame, updateGame } from '@/server/db/games/games';
import { replacePlayYears } from '@/server/db/games/play-years';
import { fromHoursInput } from '@/server/games/hours';
import { findDuplicateYear, validateSplit } from '@/server/games/play-years';
import { GAME_OWNERSHIPS, GAME_PLATFORMS, GAME_STATUSES } from '@/server/games/taxonomy';
import { type ActionResult, fail, ok } from './action-result';

/**
 * Server Actions for the games library.
 *
 * Every one begins with `await requireOwner()`. Next.js handles Server
 * Functions as POSTs to the route where they are used, so proxy coverage is
 * defense-in-depth and never the boundary — see `src/server/auth/owner.ts`.
 */

const idSchema = z.string().uuid();

const gameSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(300),
  platform: z.enum(GAME_PLATFORMS),
  developer: z.string().trim().max(300).optional(),
  publisher: z.string().trim().max(300).optional(),
  ownership: z.enum(GAME_OWNERSHIPS).optional(),
  status: z.enum(GAME_STATUSES),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  hours: z.string().optional(),
  firstPlayedYear: z.coerce.number().int().min(1970).max(2100).optional(),
  achievementsUnlocked: z.coerce.number().int().min(0).max(10_000).optional(),
  achievementsTotal: z.coerce.number().int().min(0).max(10_000).optional(),
  priceDollars: z.coerce.number().min(0).max(10_000).optional(),
  coverUrl: z.string().url().max(2000).optional(),
  genre: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
  // The owner's own claim, not third-party data — a real HTML checkbox, whose
  // presence in FormData (any non-empty value) means "checked." Its ABSENCE
  // (unchecked) is handled below in `parse()`, not here: `.optional()` alone
  // would let an omitted key mean "leave unchanged" the way it does for every
  // text field, which is wrong for a checkbox — see the comment at the
  // assignment site.
  platinum: z.coerce.boolean().optional(),
  // Read-only third-party facts filled by the metadata picker only — no
  // hand-editable control exists for these in the dialog.
  metacritic: z.coerce.number().int().min(0).max(100).optional(),
  averagePlaytimeHours: z.coerce.number().int().min(0).max(1000).optional(),
  esrbRating: z.string().trim().max(50).optional(),
});

const playYearsSchema = z
  .array(
    z.object({
      // A bare `z.coerce.number()` would accept `''` as `0` (`Number('')`
      // is `0`, not `NaN`) and only get rejected because 0 happens to fall
      // below the 1970 floor — a coercion accident, not a real check. The
      // explicit `.min(1)` on the string form rejects a blank year on its
      // own terms, independent of wherever the numeric range happens to sit.
      year: z
        .string()
        .trim()
        .min(1, 'Year is required')
        .transform((value) => Number(value))
        .pipe(z.number().int().min(1970).max(2100)),
      // Whitespace-only must be a validation failure, NOT a silent 0 — a
      // fabricated zero is exactly the bug class this project has hit
      // before. The human message matches the top-level Hours field's own
      // message for the identical failure a few lines below — without it,
      // Zod's default ("Too small: expected string to have >=1 characters")
      // would reach the owner verbatim.
      hours: z.string().trim().min(1, 'Hours must be a number like 23 or 23.5'),
    }),
  )
  .max(30);

/**
 * A disabled Hours/Achievements field in game-dialog.tsx is a UI affordance,
 * not a security boundary — devtools can re-enable it, and even an honest
 * submission omits a disabled field from FormData entirely (native form
 * behavior), which would otherwise read as "the owner cleared this box" and
 * null it out. Either way, for a Steam-linked game these three columns are
 * dropped from the write outright so the existing (Steam-owned) values are
 * left exactly as they are. `commitSyncRun` (src/server/db/games/sync.ts)
 * writes these same columns directly and never goes through this action, so
 * this stripping can never conflict with a sync in progress.
 */
function stripSteamOwnedFields(input: GameInput): GameInput {
  const { hoursTenths: _hoursTenths, achievementsUnlocked: _achievementsUnlocked, achievementsTotal: _achievementsTotal, ...rest } = input;
  return rest;
}

function toResult(error: unknown): ActionResult {
  if (error instanceof DuplicateGameError) {
    return fail(
      `"${error.duplicateTitle}" is already in your library on that platform. The same game on a different platform is fine.`,
      'title',
    );
  }
  if (error instanceof GameNotFoundError) return fail(error.message);
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const path = issue?.path[0];
    const field = path === 'title' || path === 'hours' || path === 'rating' ? path : undefined;
    return fail(issue?.message ?? 'That input is not valid', field);
  }
  // Anything unrecognized is a real fault, not user input. Let it throw.
  throw error;
}

/** Empty-string form fields become `undefined`, not `''`, before validation. */
function text(formData: FormData, key: string): string | undefined {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Build the DAL input. More than three optional fields are assembled here, so
 * this uses a mutable local object rather than merged conditional spreads —
 * merging many spreads makes `tsc` infer `T | undefined` under
 * `exactOptionalPropertyTypes` even though each spread is individually correct
 * (documented inference gap in CLAUDE.md).
 *
 * `mode` is why this function exists in this shape at all. `text()` maps a
 * blank input to `undefined`, and CREATE and UPDATE must treat that
 * `undefined` differently:
 *
 * - `'create'`: an absent optional field OMITS the key, so the column's own
 *   default applies. This is the pre-existing behaviour, unchanged.
 * - `'update'`: an absent optional field means the owner explicitly cleared a
 *   box that used to have a value in it — omitting the key here would be
 *   silently indistinguishable from "the owner didn't touch this field," so
 *   every optional key is always written, to its parsed value or to `null`.
 *   Without this, a field once set could never be blanked again from the
 *   editor (rate a game 5, clear the box, save — it silently stays 5).
 *
 * A single `parse()` that could not tell "absent" from "cleared" was the root
 * cause; `mode` makes the two paths explicit instead of leaving it to be
 * inferred from which caller happens to pass a fresher object.
 */
interface ParsedGame {
  readonly input: GameInput;
  readonly playYears: readonly { readonly year: number; readonly hoursTenths: number }[];
}

function parse(formData: FormData, mode: 'create' | 'update'): ParsedGame {
  const raw = gameSchema.parse({
    title: text(formData, 'title') ?? '',
    platform: text(formData, 'platform') ?? 'other',
    developer: text(formData, 'developer'),
    publisher: text(formData, 'publisher'),
    ownership: text(formData, 'ownership'),
    status: text(formData, 'status') ?? 'backlog',
    rating: text(formData, 'rating'),
    hours: text(formData, 'hours'),
    firstPlayedYear: text(formData, 'firstPlayedYear'),
    achievementsUnlocked: text(formData, 'achievementsUnlocked'),
    achievementsTotal: text(formData, 'achievementsTotal'),
    priceDollars: text(formData, 'priceDollars'),
    coverUrl: text(formData, 'coverUrl'),
    genre: text(formData, 'genre'),
    notes: text(formData, 'notes'),
    platinum: text(formData, 'platinum'),
    metacritic: text(formData, 'metacritic'),
    averagePlaytimeHours: text(formData, 'averagePlaytimeHours'),
    esrbRating: text(formData, 'esrbRating'),
  });

  const input: {
    -readonly [K in keyof GameInput]: GameInput[K];
  } = { title: raw.title, platform: raw.platform, status: raw.status };
  const clearing = mode === 'update';

  // Unconditional, in BOTH modes — unlike every field below. An unchecked
  // checkbox submits no "platinum" key in FormData at all (see game-dialog.tsx),
  // so there is no "the owner didn't touch this" state to preserve the way
  // `clearing` distinguishes for text/select fields: every submit reasserts
  // the owner's current claim, checked or not. Gating this behind `clearing`
  // the way the fields below are gated would mean a platinum, once set, could
  // never be turned back off — a later submit with the box unchecked would
  // omit the key and this function would never assign `false` on create mode,
  // and CREATE has no `clearing` at all in the pattern below.
  input.platinum = raw.platinum ?? false;

  if (raw.developer !== undefined) input.developer = raw.developer;
  else if (clearing) input.developer = null;

  if (raw.publisher !== undefined) input.publisher = raw.publisher;
  else if (clearing) input.publisher = null;

  if (raw.ownership !== undefined) input.ownership = raw.ownership;
  else if (clearing) input.ownership = null;

  if (raw.rating !== undefined) input.rating = raw.rating;
  else if (clearing) input.rating = null;

  if (raw.firstPlayedYear !== undefined) input.firstPlayedYear = raw.firstPlayedYear;
  else if (clearing) input.firstPlayedYear = null;

  if (raw.achievementsUnlocked !== undefined) input.achievementsUnlocked = raw.achievementsUnlocked;
  else if (clearing) input.achievementsUnlocked = null;

  if (raw.achievementsTotal !== undefined) input.achievementsTotal = raw.achievementsTotal;
  else if (clearing) input.achievementsTotal = null;

  if (raw.coverUrl !== undefined) input.coverUrl = raw.coverUrl;
  else if (clearing) input.coverUrl = null;

  if (raw.genre !== undefined) input.genre = raw.genre;
  else if (clearing) input.genre = null;

  if (raw.metacritic !== undefined) input.metacritic = raw.metacritic;
  else if (clearing) input.metacritic = null;

  if (raw.averagePlaytimeHours !== undefined) input.averagePlaytimeHours = raw.averagePlaytimeHours;
  else if (clearing) input.averagePlaytimeHours = null;

  if (raw.esrbRating !== undefined) input.esrbRating = raw.esrbRating;
  else if (clearing) input.esrbRating = null;

  if (raw.notes !== undefined) input.notes = raw.notes;
  else if (clearing) input.notes = null;

  if (raw.hours !== undefined) {
    const tenths = fromHoursInput(raw.hours);
    if (tenths === null)
      throw new z.ZodError([
        { code: 'custom', path: ['hours'], message: 'Hours must be a number like 23 or 23.5' },
      ]);
    input.hoursTenths = tenths;
  } else if (clearing) {
    input.hoursTenths = null;
  }

  // Dollars in the form, cents in the database — never a float in storage.
  if (raw.priceDollars !== undefined) input.priceCents = Math.round(raw.priceDollars * 100);
  else if (clearing) input.priceCents = null;

  const rawPlayYears = text(formData, 'playYears');
  let playYears: { year: number; hoursTenths: number }[] = [];
  if (rawPlayYears !== undefined) {
    const drafts = playYearsSchema.parse(JSON.parse(rawPlayYears));
    playYears = drafts.map((draft, index) => {
      const tenths = fromHoursInput(draft.hours);
      if (tenths === null)
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['playYears', index, 'hours'],
            message: `"${draft.hours}" is not a valid number of hours`,
          },
        ]);
      return { year: draft.year, hoursTenths: tenths };
    });
  }

  return { input, playYears };
}

export async function createGameAction(formData: FormData): Promise<ActionResult> {
  const owner = await requireOwner();

  let parsed: ParsedGame;
  try {
    parsed = parse(formData, 'create');
  } catch (error) {
    return toResult(error);
  }

  const duplicateYear = findDuplicateYear(parsed.playYears);
  if (duplicateYear !== null) {
    return fail(`Year ${duplicateYear} appears more than once in the split.`);
  }

  const validation = validateSplit(parsed.input.hoursTenths ?? 0, parsed.playYears);
  if (!validation.ok) {
    return fail('The year-by-year split must add up to the total hours.');
  }

  let saved: Game;
  try {
    saved = await createGame(owner.userId, parsed.input);
  } catch (error) {
    return toResult(error);
  }

  // Deliberately two separate writes, not one transaction. The checks above
  // (duplicate year, sum mismatch) remove the only reachable way
  // `replacePlayYears` could fail in normal operation — real atomicity would
  // mean widening `createGame`/`updateGame` to accept play years directly and
  // updating every caller, just to close a window that now requires an actual
  // mid-request database fault (a race, a dropped connection) to hit at all.
  // If it DOES throw, the game row has already been committed; the catch
  // below turns that into a field error instead of an unhandled crash — it is
  // defense-in-depth, not a rollback.
  try {
    await replacePlayYears(owner.userId, saved.id, parsed.playYears);
  } catch {
    // Revalidate even on this failure path: `createGame`/`updateGame` above
    // already committed the game row, so without this the library cache
    // still hides it — "try editing it again" would point at a row the
    // owner can't see, and re-adding it would collide as a duplicate.
    revalidatePath('/games', 'layout');
    return fail('The game was saved, but its year-by-year split could not be — try editing it again.');
  }

  // `'layout'` covers both tab routes (`/games/library`, `/games/stats`) in
  // one call. `/games` itself is a pure `redirect('/games/library')` with no
  // data of its own — revalidating the exact leaf paths individually would
  // miss nothing today, but 'layout' is the one call that keeps covering both
  // if a third tab is ever added under the same route group.
  revalidatePath('/games', 'layout');
  return ok();
}

export async function updateGameAction(id: string, formData: FormData): Promise<ActionResult> {
  const owner = await requireOwner();

  let parsed: ParsedGame;
  try {
    parsed = parse(formData, 'update');
  } catch (error) {
    return toResult(error);
  }

  // Fetched before either check below, because a Steam-linked game changes
  // both what gets written (stripSteamOwnedFields) and what the split has to
  // add up to (the game's own current total, not whatever — or nothing — the
  // form submitted for a disabled field).
  let gameId: string;
  let existing: Game;
  try {
    gameId = idSchema.parse(id);
    existing = await getGame(owner.userId, gameId);
  } catch (error) {
    return toResult(error);
  }

  const steamOwned = existing.steamAppid !== null;
  const input = steamOwned ? stripSteamOwnedFields(parsed.input) : parsed.input;

  const duplicateYear = findDuplicateYear(parsed.playYears);
  if (duplicateYear !== null) {
    return fail(`Year ${duplicateYear} appears more than once in the split.`);
  }

  // Steam knows the total; only the owner knows which year it happened in
  // (see game-dialog.tsx) — so the split still has to reconcile against a
  // total, just the EXISTING Steam-owned one rather than whatever this
  // update's own (stripped) input carries.
  const totalTenthsForSplit = steamOwned ? (existing.hoursTenths ?? 0) : (input.hoursTenths ?? 0);
  const validation = validateSplit(totalTenthsForSplit, parsed.playYears);
  if (!validation.ok) {
    return fail('The year-by-year split must add up to the total hours.');
  }

  let saved: Game;
  try {
    saved = await updateGame(owner.userId, gameId, input);
  } catch (error) {
    return toResult(error);
  }

  // See the matching comment in createGameAction — deliberately not atomic
  // with the write above, and for the same reason.
  try {
    await replacePlayYears(owner.userId, saved.id, parsed.playYears);
  } catch {
    // Revalidate even on this failure path: `createGame`/`updateGame` above
    // already committed the game row, so without this the library cache
    // still hides it — "try editing it again" would point at a row the
    // owner can't see, and re-adding it would collide as a duplicate.
    revalidatePath('/games', 'layout');
    return fail('The game was saved, but its year-by-year split could not be — try editing it again.');
  }

  revalidatePath('/games', 'layout');
  return ok();
}

export async function deleteGameAction(id: string): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await deleteGame(owner.userId, idSchema.parse(id));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/games', 'layout');
  return ok();
}
