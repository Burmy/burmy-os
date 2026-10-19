-- Hand-edited (2026-10-18): every statement is idempotent because this migration must run on
-- production only AFTER the new code is deployed (old code reads these tables), while a dev
-- database that applied the earlier drop-only 0019 already has them gone. See docs/DEPLOYMENT.md.
DROP TABLE IF EXISTS "game_sync_changes" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "game_sync_runs" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "game_trophies" CASCADE;--> statement-breakpoint
DROP INDEX IF EXISTS "games_owner_steam_appid_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "games_owner_psn_title_id_idx";--> statement-breakpoint
ALTER TABLE "games" DROP COLUMN IF EXISTS "steam_appid";--> statement-breakpoint
ALTER TABLE "games" DROP COLUMN IF EXISTS "psn_title_id";--> statement-breakpoint
ALTER TABLE "games" DROP COLUMN IF EXISTS "psn_np_communication_id";--> statement-breakpoint
ALTER TABLE "games" DROP COLUMN IF EXISTS "last_played_at";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."game_sync_run_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."game_sync_source";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."game_trophy_source";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."game_trophy_tier";