CREATE TABLE `admin_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_user_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `email_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`email` text NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	CONSTRAINT "email_tokens_purpose_check" CHECK("email_tokens"."purpose" in ('signup', 'recovery'))
);
--> statement-breakpoint
CREATE INDEX `email_tokens_email_purpose_idx` ON `email_tokens` (`email`,`purpose`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`public_key` blob NOT NULL,
	`counter` integer NOT NULL,
	`transports` text,
	`backed_up` integer NOT NULL,
	`added_via` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`counter_regressed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "passkeys_added_via_check" CHECK("passkeys"."added_via" in ('signup', 'account', 'recovery'))
);
--> statement-breakpoint
CREATE INDEX `passkeys_user_id_idx` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`active_org_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`stepped_up_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`active_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`purpose` text NOT NULL,
	`user_id` text,
	`token_hash` text,
	`webauthn_user_id` blob,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webauthn_challenges_expires_at_idx` ON `webauthn_challenges` (`expires_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `webauthn_user_id` blob;--> statement-breakpoint
CREATE UNIQUE INDEX `users_webauthn_user_id_unique` ON `users` (`webauthn_user_id`);