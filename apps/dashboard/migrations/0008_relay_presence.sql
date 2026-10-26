CREATE TABLE `relay_presence` (
	`relay_id` text NOT NULL,
	`engine_id` text NOT NULL,
	PRIMARY KEY(`relay_id`, `engine_id`),
	FOREIGN KEY (`relay_id`) REFERENCES `relay_presence_reports`(`relay_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `relay_presence_engine_id_idx` ON `relay_presence` (`engine_id`);--> statement-breakpoint
CREATE TABLE `relay_presence_reports` (
	`relay_id` text PRIMARY KEY NOT NULL,
	`reported_at` integer NOT NULL
);
