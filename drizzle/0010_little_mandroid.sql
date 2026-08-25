ALTER TABLE "games" ADD COLUMN "psn_title_id" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "psn_np_communication_id" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "last_played_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "games_owner_psn_title_id_idx" ON "games" USING btree ("owner_id","psn_title_id") WHERE "games"."psn_title_id" is not null;