'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { DuplicateGameError, GameNotFoundError } from '@/server/db/games/errors';
import {
  type GameInput,
  createGame,
  deleteGame,
  getGame,
  updateGame,
} from '@/server/db/games/games';
import { fromHoursInput } from '@/server/games/hours';
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
});

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
 */
function parse(formData: FormData): GameInput {
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
  });

  const input: {
    -readonly [K in keyof GameInput]: GameInput[K];
  } = { title: raw.title, platform: raw.platform, status: raw.status };

  if (raw.developer !== undefined) input.developer = raw.developer;
  if (raw.publisher !== undefined) input.publisher = raw.publisher;
  if (raw.ownership !== undefined) input.ownership = raw.ownership;
  if (raw.rating !== undefined) input.rating = raw.rating;
  if (raw.firstPlayedYear !== undefined) input.firstPlayedYear = raw.firstPlayedYear;
  if (raw.achievementsUnlocked !== undefined) input.achievementsUnlocked = raw.achievementsUnlocked;
  if (raw.achievementsTotal !== undefined) input.achievementsTotal = raw.achievementsTotal;
  if (raw.coverUrl !== undefined) input.coverUrl = raw.coverUrl;
  if (raw.genre !== undefined) input.genre = raw.genre;
  if (raw.notes !== undefined) input.notes = raw.notes;

  if (raw.hours !== undefined) {
    const tenths = fromHoursInput(raw.hours);
    if (tenths === null)
      throw new z.ZodError([
        { code: 'custom', path: ['hours'], message: 'Hours must be a number like 23 or 23.5' },
      ]);
    input.hoursTenths = tenths;
  }

  // Dollars in the form, cents in the database — never a float in storage.
  if (raw.priceDollars !== undefined) input.priceCents = Math.round(raw.priceDollars * 100);

  return input;
}

export async function createGameAction(formData: FormData): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await createGame(owner.userId, parse(formData));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/games');
  revalidatePath('/games/stats');
  return ok();
}

export async function updateGameAction(id: string, formData: FormData): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await updateGame(owner.userId, idSchema.parse(id), parse(formData));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/games');
  revalidatePath('/games/stats');
  return ok();
}

export async function deleteGameAction(id: string): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await deleteGame(owner.userId, idSchema.parse(id));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/games');
  revalidatePath('/games/stats');
  return ok();
}

/**
 * Status-only change, for the one-click control on a library card. Kept
 * separate from `updateGameAction` so moving a game to "Playing" does not
 * require round-tripping every other field back through the form.
 */
export async function setGameStatusAction(
  id: string,
  status: (typeof GAME_STATUSES)[number],
): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    const parsedStatus = z.enum(GAME_STATUSES).parse(status);
    const existing = await getGame(owner.userId, idSchema.parse(id));
    await updateGame(owner.userId, existing.id, {
      title: existing.title,
      platform: existing.platform,
      status: parsedStatus,
    });
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/games');
  revalidatePath('/games/stats');
  return ok();
}
