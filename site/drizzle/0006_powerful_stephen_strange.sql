CREATE TABLE `booking_api_guard` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`bookings_enabled` integer DEFAULT 0 NOT NULL,
	`expected_app_version` text NOT NULL,
	`observed_app_version` text,
	`checked_at` text,
	`last_healthy_at` text,
	`disabled_at` text,
	`failure_code` text,
	`failure_message` text,
	`check_lease_until` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_settings` (
	`user_email` text PRIMARY KEY NOT NULL,
	`facility_id` integer NOT NULL,
	`facility_category_id` integer NOT NULL,
	`booking_lead_days` integer DEFAULT 14 NOT NULL,
	`release_hour` integer DEFAULT 12 NOT NULL,
	`release_minute` integer DEFAULT 0 NOT NULL,
	`cancellation_lead_seconds` integer DEFAULT 15 NOT NULL,
	`fire_delay_milliseconds` integer DEFAULT 10 NOT NULL,
	`maximum_sessions` integer DEFAULT 10 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_user_settings`("user_email", "facility_id", "facility_category_id", "booking_lead_days", "release_hour", "release_minute", "cancellation_lead_seconds", "fire_delay_milliseconds", "maximum_sessions", "created_at", "updated_at") SELECT "user_email", "facility_id", "facility_category_id", "booking_lead_days", "release_hour", "release_minute", "cancellation_lead_seconds", "fire_delay_milliseconds", "maximum_sessions", "created_at", "updated_at" FROM `user_settings`;--> statement-breakpoint
DROP TABLE `user_settings`;--> statement-breakpoint
ALTER TABLE `__new_user_settings` RENAME TO `user_settings`;--> statement-breakpoint
UPDATE `user_settings` SET `maximum_sessions` = 10 WHERE `maximum_sessions` = 6;--> statement-breakpoint
PRAGMA foreign_keys=ON;
