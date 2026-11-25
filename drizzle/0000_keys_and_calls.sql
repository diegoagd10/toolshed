CREATE TABLE `keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `keys_hash_unique` ON `keys` (`hash`);--> statement-breakpoint
CREATE TABLE `calls` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`key_id` text NOT NULL,
	`tool` text NOT NULL,
	`via` text NOT NULL,
	`ms` integer NOT NULL,
	`error` text,
	FOREIGN KEY (`key_id`) REFERENCES `keys`(`id`) ON UPDATE no action ON DELETE no action
);
