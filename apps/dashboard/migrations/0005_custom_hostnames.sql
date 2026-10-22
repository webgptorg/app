CREATE TABLE `engine_hostnames` (
	`hostname` text PRIMARY KEY NOT NULL,
	`engine_id` text NOT NULL,
	`org_id` text NOT NULL,
	`claim_sig` text NOT NULL,
	`status` text NOT NULL,
	`dns_checked_at` integer,
	`created_at` integer NOT NULL,
	`created_by_user_id` text NOT NULL,
	FOREIGN KEY (`engine_id`) REFERENCES `engines`(`engine_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "engine_hostnames_status_check" CHECK("engine_hostnames"."status" in ('pending-dns', 'active'))
);
--> statement-breakpoint
CREATE INDEX `engine_hostnames_engine_id_idx` ON `engine_hostnames` (`engine_id`);