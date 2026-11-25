CREATE TABLE `keys` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`hash` text NOT NULL UNIQUE,
	`prefix` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE TABLE `calls` (
	`id` integer PRIMARY KEY,
	`at` text NOT NULL,
	`key_id` text NOT NULL,
	`tool` text NOT NULL,
	`via` text NOT NULL,
	`ms` integer NOT NULL,
	`error` text,
	CONSTRAINT `fk_calls_key_id_keys_id_fk` FOREIGN KEY (`key_id`) REFERENCES `keys`(`id`)
);
