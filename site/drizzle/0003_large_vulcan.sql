CREATE TABLE `automation_heartbeat` (
	`id` text PRIMARY KEY NOT NULL,
	`last_seen_at` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`cron` text NOT NULL
);
