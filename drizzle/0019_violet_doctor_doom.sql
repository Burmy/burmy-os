ALTER TABLE "game_sync_changes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "game_sync_runs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "game_trophies" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "game_sync_changes" CASCADE;--> statement-breakpoint
DROP TABLE "game_sync_runs" CASCADE;--> statement-breakpoint
DROP TABLE "game_trophies" CASCADE;--> statement-breakpoint
DROP INDEX "games_owner_steam_appid_idx";--> statement-breakpoint
DROP INDEX "games_owner_psn_title_id_idx";--> statement-breakpoint
ALTER TABLE "games" DROP COLUMN "steam_appid";--> statement-breakpoint
ALTER TABLE "games" DROP COLUMN "psn_title_id";--> statement-breakpoint
ALTER TABLE "games" DROP COLUMN "psn_np_communication_id";--> statement-breakpoint
ALTER TABLE "games" DROP COLUMN "last_played_at";--> statement-breakpoint
DROP TYPE "public"."game_sync_run_status";--> statement-breakpoint
DROP TYPE "public"."game_sync_source";--> statement-breakpoint
DROP TYPE "public"."game_trophy_source";--> statement-breakpoint
DROP TYPE "public"."game_trophy_tier";