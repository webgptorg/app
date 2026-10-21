CREATE TABLE `relay_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`relay_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_tokens_token_hash_unique` ON `relay_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `relay_tokens_relay_id_idx` ON `relay_tokens` (`relay_id`);