ALTER TABLE `link_codes` ADD `id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `link_codes_id_unique` ON `link_codes` (`id`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `trial_started_at` integer;