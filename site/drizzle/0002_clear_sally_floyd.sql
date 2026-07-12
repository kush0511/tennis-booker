CREATE TABLE `schedule_windows` (
	`user_email` text NOT NULL,
	`release_at` text NOT NULL,
	`schedule_id` text NOT NULL,
	PRIMARY KEY(`user_email`, `release_at`)
);
