CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`team_ids` text NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_hash_unique` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invites_org_id_idx` ON `invites` (`org_id`);--> statement-breakpoint
CREATE TABLE `member_revocations` (
	`id` text PRIMARY KEY NOT NULL,
	`engine_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`acked_at` integer,
	`outcome` text
);
--> statement-breakpoint
CREATE INDEX `member_revocations_engine_id_idx` ON `member_revocations` (`engine_id`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `team_members_user_id_idx` ON `team_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `teams_org_id_idx` ON `teams` (`org_id`);--> statement-breakpoint
ALTER TABLE `engines` ADD `team_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `engines_team_id_unique` ON `engines` (`team_id`);--> statement-breakpoint
ALTER TABLE `link_codes` ADD `team_id` text;--> statement-breakpoint
-- Every existing engine gets a team of its own, named after its label or hostname, with the organization's owners in
-- it. The team takes the engine's ID, which has the same shape; new teams get random IDs.
INSERT INTO `teams` (`id`, `org_id`, `name`, `created_at`, `deleted_at`)
	SELECT `engine_id`, `org_id`, coalesce(`label`, `hostname`), `created_at`, NULL FROM `engines`;--> statement-breakpoint
UPDATE `engines` SET `team_id` = `engine_id`;--> statement-breakpoint
INSERT INTO `team_members` (`team_id`, `user_id`, `created_at`)
	SELECT `engines`.`engine_id`, `memberships`.`user_id`, `engines`.`created_at` FROM `engines`
	INNER JOIN `memberships` ON `memberships`.`org_id` = `engines`.`org_id` AND `memberships`.`role` = 'owner';
