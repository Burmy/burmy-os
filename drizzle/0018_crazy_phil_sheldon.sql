ALTER TYPE "public"."anime_sync_run_status" ADD VALUE 'cancelled';--> statement-breakpoint
DROP INDEX "anime_owner_title_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "anime_series_owner_anilist_parent_idx" ON "anime_series" USING btree ("owner_id","anilist_parent_id") WHERE "anime_series"."anilist_parent_id" is not null;