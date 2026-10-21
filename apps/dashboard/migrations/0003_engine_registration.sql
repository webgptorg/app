CREATE TABLE `engines` (
	`engine_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`public_key` text NOT NULL,
	`hostname` text NOT NULL,
	`mode` text NOT NULL,
	`engine_version` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`status_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "engines_status_check" CHECK("engines"."status" in ('active', 'suspended')),
	CONSTRAINT "engines_mode_check" CHECK("engines"."mode" in ('tunnel', 'direct'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `engines_public_key_unique` ON `engines` (`public_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `engines_hostname_unique` ON `engines` (`hostname`);--> statement-breakpoint
CREATE INDEX `engines_org_id_idx` ON `engines` (`org_id`);--> statement-breakpoint
CREATE TABLE `link_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`engine_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `link_codes_org_id_created_at_idx` ON `link_codes` (`org_id`,`created_at`);