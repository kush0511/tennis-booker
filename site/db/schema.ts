import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const userSettings = sqliteTable("user_settings", {
  userEmail: text("user_email").primaryKey(),
  facilityId: integer("facility_id").notNull(),
  facilityCategoryId: integer("facility_category_id").notNull(),
  bookingLeadDays: integer("booking_lead_days").notNull().default(14),
  releaseHour: integer("release_hour").notNull().default(12),
  releaseMinute: integer("release_minute").notNull().default(0),
  cancellationLeadSeconds: integer("cancellation_lead_seconds")
    .notNull()
    .default(15),
  fireDelayMilliseconds: integer("fire_delay_milliseconds")
    .notNull()
    .default(10),
  maximumSessions: integer("maximum_sessions").notNull().default(6),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    userEmail: text("user_email").notNull(),
    eventDay: text("event_day").notNull(),
    eventTimesJson: text("event_times_json").notNull(),
    facilityId: integer("facility_id").notNull(),
    facilityCategoryId: integer("facility_category_id").notNull(),
    releaseAt: text("release_at").notNull(),
    status: text("status").notNull(),
    claimedAt: text("claimed_at"),
    leaseUntil: text("lease_until"),
    attemptedAt: text("attempted_at"),
    resultMessage: text("result_message"),
    bookingOrderIdsJson: text("booking_order_ids_json").notNull().default("[]"),
    preparedTargetsJson: text("prepared_targets_json"),
    submittedTargetsJson: text("submitted_targets_json"),
    cancelledBookingIdsJson: text("cancelled_booking_ids_json")
      .notNull()
      .default("[]"),
    submitSkewMs: integer("submit_skew_ms"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("schedules_user_release_idx").on(table.userEmail, table.releaseAt),
    index("schedules_due_idx").on(table.status, table.releaseAt),
  ],
);

export const scheduleSlots = sqliteTable(
  "schedule_slots",
  {
    userEmail: text("user_email").notNull(),
    eventDay: text("event_day").notNull(),
    eventTime: text("event_time").notNull(),
    facilityId: integer("facility_id").notNull(),
    scheduleId: text("schedule_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.userEmail,
        table.eventDay,
        table.eventTime,
        table.facilityId,
      ],
    }),
  ],
);

export const scheduleWindows = sqliteTable(
  "schedule_windows",
  {
    userEmail: text("user_email").notNull(),
    releaseAt: text("release_at").notNull(),
    scheduleId: text("schedule_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userEmail, table.releaseAt] })],
);

export const scheduleEvents = sqliteTable(
  "schedule_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scheduleId: text("schedule_id").notNull(),
    userEmail: text("user_email").notNull(),
    level: text("level").notNull(),
    message: text("message").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("schedule_events_schedule_idx").on(
      table.scheduleId,
      table.createdAt,
    ),
  ],
);

export const automationHeartbeat = sqliteTable("automation_heartbeat", {
  id: text("id").primaryKey(),
  lastSeenAt: text("last_seen_at").notNull(),
  scheduledAt: text("scheduled_at").notNull(),
  cron: text("cron").notNull(),
});
