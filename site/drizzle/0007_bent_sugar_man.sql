CREATE TABLE `slot_monitor_matches` (
	`user_email` text NOT NULL,
	`fingerprint` text NOT NULL,
	`event_day` text NOT NULL,
	`event_times_json` text NOT NULL,
	`score` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_alerted_at` text,
	PRIMARY KEY(`user_email`, `fingerprint`)
);
--> statement-breakpoint
CREATE INDEX `slot_monitor_matches_active_idx` ON `slot_monitor_matches` (`user_email`,`active`,`event_day`);--> statement-breakpoint
CREATE TABLE `slot_monitors` (
	`user_email` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`recipient_email` text NOT NULL,
	`start_minute` integer DEFAULT 1080 NOT NULL,
	`end_minute` integer DEFAULT 1440 NOT NULL,
	`minimum_contiguous_slots` integer DEFAULT 2 NOT NULL,
	`last_scan_at` text,
	`last_error` text,
	`last_notification_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `slot_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_email` text NOT NULL,
	`recipient_email` text NOT NULL,
	`subject` text NOT NULL,
	`text_body` text NOT NULL,
	`html_body` text NOT NULL,
	`event_day` text NOT NULL,
	`event_times_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`lease_until` text,
	`created_at` text NOT NULL,
	`delivered_at` text
);
--> statement-breakpoint
CREATE INDEX `slot_notifications_delivery_idx` ON `slot_notifications` (`status`,`lease_until`,`created_at`);