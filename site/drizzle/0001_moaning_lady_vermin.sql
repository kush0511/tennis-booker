CREATE INDEX `schedule_events_schedule_idx` ON `schedule_events` (`schedule_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `schedules_user_release_idx` ON `schedules` (`user_email`,`release_at`);--> statement-breakpoint
CREATE INDEX `schedules_due_idx` ON `schedules` (`status`,`release_at`);