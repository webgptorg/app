CREATE TABLE `vps_oauth_clients` (
	`callback` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `link_codes` ADD `vps_provider` text;--> statement-breakpoint
ALTER TABLE `link_codes` ADD `vps_resource_id` text;