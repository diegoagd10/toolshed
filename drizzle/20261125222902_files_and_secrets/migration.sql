CREATE TABLE `files` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`name` text PRIMARY KEY,
	`value` blob NOT NULL
);
