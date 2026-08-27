-- Hand-written. `drizzle-kit generate` produced a destructive type swap
-- (ALTER COLUMN ... SET DATA TYPE text; DROP TYPE; CREATE TYPE; ALTER COLUMN
-- ... SET DATA TYPE ... USING status::game_status) — the final USING cast
-- would fail outright, because the newly created type no longer contains the
-- label 'completed' that all 171 existing rows still carry at the moment the
-- cast runs. Postgres supports renaming an enum label in place with zero data
-- movement, so that is what this migration does instead.
ALTER TYPE "public"."game_status" RENAME VALUE 'completed' TO 'played';
