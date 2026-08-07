CREATE TABLE `provider_credentials` (
	`provider` text PRIMARY KEY NOT NULL,
	`token_ciphertext` text,
	`token_iv` text,
	`encryption_version` integer,
	`issued_at` text,
	`refreshed_at` text,
	`last_validated_at` text,
	`last_refresh_attempt_at` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`last_error_message` text,
	`refresh_lease_until` text,
	`login_identifier_kind` text,
	`updated_at` text NOT NULL
);
