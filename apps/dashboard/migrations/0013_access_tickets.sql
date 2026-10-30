CREATE TABLE `access_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`engine_id` text NOT NULL,
	`user_id` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`outcome` text,
	`outcome_at` integer,
	`noticed_at` integer
);
--> statement-breakpoint
CREATE INDEX `access_tickets_engine_id_idx` ON `access_tickets` (`engine_id`);--> statement-breakpoint
ALTER TABLE `team_members` ADD `access` text DEFAULT 'none' NOT NULL;