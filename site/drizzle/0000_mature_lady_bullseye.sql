CREATE TABLE `schedule_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`schedule_id` text NOT NULL,
	`user_email` text NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedule_slots` (
	`user_email` text NOT NULL,
	`event_day` text NOT NULL,
	`event_time` text NOT NULL,
	`facility_id` integer NOT NULL,
	`schedule_id` text NOT NULL,
	PRIMARY KEY(`user_email`, `event_day`, `event_time`, `facility_id`)
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_email` text NOT NULL,
	`event_day` text NOT NULL,
	`event_times_json` text NOT NULL,
	`facility_id` integer NOT NULL,
	`facility_category_id` integer NOT NULL,
	`release_at` text NOT NULL,
	`status` text NOT NULL,
	`claimed_at` text,
	`lease_until` text,
	`attempted_at` text,
	`result_message` text,
	`booking_order_ids_json` text DEFAULT '[]' NOT NULL,
	`prepared_targets_json` text,
	`submitted_targets_json` text,
	`cancelled_booking_ids_json` text DEFAULT '[]' NOT NULL,
	`submit_skew_ms` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_email` text PRIMARY KEY NOT NULL,
	`facility_id` integer NOT NULL,
	`facility_category_id` integer NOT NULL,
	`booking_lead_days` integer DEFAULT 14 NOT NULL,
	`release_hour` integer DEFAULT 12 NOT NULL,
	`release_minute` integer DEFAULT 0 NOT NULL,
	`cancellation_lead_seconds` integer DEFAULT 15 NOT NULL,
	`fire_delay_milliseconds` integer DEFAULT 10 NOT NULL,
	`maximum_sessions` integer DEFAULT 6 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
