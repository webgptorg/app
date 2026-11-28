CREATE TABLE `notification_preferences` (
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`channel` text NOT NULL,
	PRIMARY KEY(`user_id`, `org_id`, `kind`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notification_preferences_channel_check" CHECK("notification_preferences"."channel" in ('off', 'in-app', 'email'))
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`engine_id` text,
	`kind` text NOT NULL,
	`variant` text,
	`count` integer NOT NULL,
	`opened_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`seen_at` integer,
	`emailed_at` integer,
	`due_at` integer,
	`closed_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_open_project_idx` ON `notifications` (`user_id`,`org_id`,`engine_id`,`kind`) WHERE "notifications"."closed_at" is null and "notifications"."engine_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_open_org_idx` ON `notifications` (`user_id`,`org_id`,`kind`) WHERE "notifications"."closed_at" is null and "notifications"."engine_id" is null;--> statement-breakpoint
CREATE INDEX `notifications_target_idx` ON `notifications` (`org_id`,`engine_id`,`kind`);--> statement-breakpoint
CREATE INDEX `notifications_due_idx` ON `notifications` (`due_at`) WHERE "notifications"."closed_at" is null and "notifications"."due_at" is not null;--> statement-breakpoint
CREATE INDEX `notifications_closed_idx` ON `notifications` (`closed_at`);