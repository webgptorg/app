CREATE TABLE `usage_daily_meters` (
	`day` text NOT NULL,
	`org_id` text NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`meter` text NOT NULL,
	`value` integer NOT NULL,
	`unreported` integer NOT NULL,
	`peak` integer NOT NULL,
	PRIMARY KEY(`day`, `org_id`, `scope`, `scope_id`, `meter`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "usage_daily_meters_scope_check" CHECK("usage_daily_meters"."scope" in ('org', 'team', 'project'))
);
--> statement-breakpoint
CREATE INDEX `usage_daily_meters_org_id_day_idx` ON `usage_daily_meters` (`org_id`,`day`);--> statement-breakpoint
CREATE INDEX `usage_daily_engines_engine_id_day_idx` ON `usage_daily_engines` (`engine_id`,`day`);