CREATE TABLE `ct_certs` (
	`issuance_sha256` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`not_before` integer NOT NULL,
	`hostnames` text NOT NULL,
	`issuer` text NOT NULL,
	`alert` text,
	CONSTRAINT "ct_certs_source_check" CHECK("ct_certs"."source" in ('crt.sh', 'certspotter'))
);
--> statement-breakpoint
CREATE INDEX `ct_certs_first_seen_at_idx` ON `ct_certs` (`first_seen_at`);--> statement-breakpoint
CREATE INDEX `ct_certs_not_before_idx` ON `ct_certs` (`not_before`);--> statement-breakpoint
CREATE TABLE `ct_cursors` (
	`source` text PRIMARY KEY NOT NULL,
	`cursor` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `public_face_checks` (
	`engine_id` text NOT NULL,
	`checked_at` integer NOT NULL,
	`result` text NOT NULL,
	`fingerprint` text,
	PRIMARY KEY(`engine_id`, `checked_at`),
	FOREIGN KEY (`engine_id`) REFERENCES `engines`(`engine_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "public_face_checks_result_check" CHECK("public_face_checks"."result" in ('match', 'mismatch', 'unreachable'))
);
--> statement-breakpoint
CREATE INDEX `public_face_checks_checked_at_idx` ON `public_face_checks` (`checked_at`);