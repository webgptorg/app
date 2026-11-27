CREATE TABLE `website_handoff_states` (
	`challenge_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `website_handoff_states_expires_at_idx` ON `website_handoff_states` (`expires_at`);--> statement-breakpoint
CREATE TABLE `website_license_snapshots` (
	`org_id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`snapshot` text NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `website_links` (
	`org_id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`linked_by_user_id` text NOT NULL,
	`linked_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `website_links_subject_unique` ON `website_links` (`subject`);--> statement-breakpoint
CREATE TABLE `website_pending_links` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `website_pending_links_expires_at_idx` ON `website_pending_links` (`expires_at`);