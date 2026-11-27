CREATE TABLE `usage_daily_engines` (
	`day` text NOT NULL,
	`engine_id` text NOT NULL,
	`org_id` text NOT NULL,
	`beats` integer NOT NULL,
	`first_beat_at` integer NOT NULL,
	`last_beat_at` integer NOT NULL,
	`engine_version` text NOT NULL,
	`agents` integer NOT NULL,
	`members` integer NOT NULL,
	`setup` text,
	`update_state` text NOT NULL,
	`cpu_load` text NOT NULL,
	PRIMARY KEY(`day`, `engine_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `usage_daily_engines_org_id_idx` ON `usage_daily_engines` (`org_id`);--> statement-breakpoint
CREATE TABLE `usage_daily_people` (
	`day` text NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`day`, `org_id`, `user_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `usage_daily_people_org_id_idx` ON `usage_daily_people` (`org_id`);--> statement-breakpoint
CREATE INDEX `usage_daily_people_user_id_idx` ON `usage_daily_people` (`user_id`);--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` integer NOT NULL,
	`event` text NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text,
	`engine_id` text,
	`props` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `usage_events_occurred_at_idx` ON `usage_events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `usage_events_event_occurred_at_idx` ON `usage_events` (`event`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `usage_events_org_id_idx` ON `usage_events` (`org_id`);--> statement-breakpoint
CREATE INDEX `usage_events_user_id_idx` ON `usage_events` (`user_id`);