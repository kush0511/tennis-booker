export const MAX_BOOKING_TARGETS = 6;
export const SINGAPORE_UTC_OFFSET_HOURS = 8;

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export interface Config {
  facilityId: number;
  facilityCategoryId: number;
  bookingLeadDays: number;
  releaseHour: number;
  releaseMinute: number;
  cancellationLeadSeconds: number;
  fireDelayMilliseconds: number;
  maxSessionsPerBooking: number;
}

export const defaultConfig: Readonly<Config> = Object.freeze({
  facilityId: 0,
  facilityCategoryId: 0,
  bookingLeadDays: 14,
  releaseHour: 12,
  releaseMinute: 0,
  cancellationLeadSeconds: 15,
  fireDelayMilliseconds: 10,
  maxSessionsPerBooking: MAX_BOOKING_TARGETS,
});

export const SCHEDULE_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "partial",
  "failed",
  "missed",
  "cancelled",
] as const;

export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export interface BookingTarget {
  eventDay: string;
  eventTime: string;
  facilityId: number;
}

export interface Schedule {
  id?: string;
  eventDay: string;
  eventTime?: string;
  eventTimes?: readonly string[];
  facilityId: number;
  facilityCategoryId?: number;
  releaseAt?: string;
  status?: ScheduleStatus;
  bookingTargets?: readonly BookingTarget[];
}

export interface AvailabilitySlot {
  id: number | null;
  facilityId: number;
  eventTime: string;
  available: boolean;
}

export interface Availability {
  facilityId: number;
  facilityName: string;
  maximumSelectableSlots: number;
  slots: AvailabilitySlot[];
}

export interface BookingRecord {
  id: number;
  facilityName: string;
  eventDay: string;
  eventTime: string;
  eventTimes: string[];
  status: number | null;
  statusName: string;
  canCancel: boolean;
  categoryType: string | number | null;
}

export interface BookingPayload {
  eventDay: string;
  bookingOrderFacilityList: Array<{
    facilityId: number;
    eventTime: string;
  }>;
}

const isoDayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const dooremiDayPattern = /^(?:[A-Za-z]{3},\s*)?(\d{2})\/(\d{2})\/(\d{4})$/;
const eventTimePattern =
  /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function realIsoDay(year: number, month: number, day: number): string {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new DomainError("Use a real session date in YYYY-MM-DD format.");
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function normalizeEventDay(value: string): string {
  const input = value.trim();
  const iso = isoDayPattern.exec(input);
  if (iso) {
    return realIsoDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const dooremi = dooremiDayPattern.exec(input);
  if (dooremi) {
    return realIsoDay(
      Number(dooremi[3]),
      Number(dooremi[2]),
      Number(dooremi[1]),
    );
  }

  throw new DomainError("Use a real session date in YYYY-MM-DD format.");
}

export function validateEventTime(value: string): string {
  const input = value.trim();
  const match = eventTimePattern.exec(input);
  if (!match) {
    throw new DomainError("Use an hourly range such as 16:00-17:00.");
  }

  const startMinutes = Number(match[1]) * 60 + Number(match[2]);
  const endMinutes = Number(match[3]) * 60 + Number(match[4]);
  if (startMinutes >= endMinutes) {
    throw new DomainError("The session end time must be after its start time.");
  }
  return input;
}

export function normalizeFacilityId(value: unknown): number {
  const facilityId =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(facilityId) || facilityId <= 0) {
    throw new DomainError("A valid facility ID is required.");
  }
  return facilityId;
}

function validateReleaseConfig(
  config: Pick<Config, "bookingLeadDays" | "releaseHour" | "releaseMinute">,
): void {
  if (!Number.isInteger(config.bookingLeadDays) || config.bookingLeadDays < 0) {
    throw new DomainError("Booking lead days must be a non-negative integer.");
  }
  if (
    !Number.isInteger(config.releaseHour) ||
    config.releaseHour < 0 ||
    config.releaseHour > 23 ||
    !Number.isInteger(config.releaseMinute) ||
    config.releaseMinute < 0 ||
    config.releaseMinute > 59
  ) {
    throw new DomainError("Release time must be a valid Singapore time.");
  }
}

export function releaseAt(
  eventDay: string,
  config: Pick<Config, "bookingLeadDays" | "releaseHour" | "releaseMinute">,
): Date {
  validateReleaseConfig(config);
  const [year, month, day] = normalizeEventDay(eventDay).split("-").map(Number);
  return new Date(
    Date.UTC(
      year,
      month - 1,
      day - config.bookingLeadDays,
      config.releaseHour - SINGAPORE_UTC_OFFSET_HOURS,
      config.releaseMinute,
    ),
  );
}

export function scheduleEventTimes(schedule: Schedule): string[] {
  const values =
    schedule.eventTimes && schedule.eventTimes.length > 0
      ? [...schedule.eventTimes]
      : schedule.eventTime
        ? [schedule.eventTime]
        : [];
  return [...new Set(values.map(validateEventTime))];
}

export function normalizeBookingTargets(schedule: Schedule): BookingTarget[] {
  const fallbackFacilityId = normalizeFacilityId(schedule.facilityId);
  const source =
    schedule.bookingTargets && schedule.bookingTargets.length > 0
      ? [...schedule.bookingTargets]
      : scheduleEventTimes(schedule).map((eventTime) => ({
          eventDay: schedule.eventDay,
          eventTime,
          facilityId: fallbackFacilityId,
        }));

  if (source.length === 0) {
    throw new DomainError("Choose at least one session.");
  }

  const seen = new Set<string>();
  const targets: BookingTarget[] = [];
  for (const target of source) {
    const normalized: BookingTarget = {
      eventDay: normalizeEventDay(target.eventDay),
      eventTime: validateEventTime(target.eventTime),
      facilityId: normalizeFacilityId(target.facilityId ?? fallbackFacilityId),
    };
    const key = `${normalized.eventDay}\u0000${normalized.eventTime}\u0000${normalized.facilityId}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(normalized);
    }
  }
  return targets;
}

export function singleTargetSchedule(
  schedule: Schedule,
  target: BookingTarget,
): Schedule {
  const normalized = normalizeBookingTargets({
    ...schedule,
    bookingTargets: [target],
  })[0];
  return {
    ...schedule,
    eventDay: normalized.eventDay,
    eventTime: normalized.eventTime,
    eventTimes: [normalized.eventTime],
    facilityId: normalized.facilityId,
    bookingTargets: undefined,
  };
}

export function bookingPayload(schedule: Schedule): BookingPayload {
  const targets = normalizeBookingTargets(schedule);
  const eventDays = new Set(targets.map((target) => target.eventDay));
  if (eventDays.size !== 1) {
    throw new DomainError(
      "A single Dooremi request cannot contain sessions from different dates.",
    );
  }
  return {
    eventDay: targets[0].eventDay,
    bookingOrderFacilityList: targets.map((target) => ({
      facilityId: target.facilityId,
      eventTime: target.eventTime,
    })),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numericId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const candidate = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(candidate) ? candidate : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError(`Dooremi returned an unreadable ${label}.`);
  }
  return value.trim();
}

export function parseAvailabilityPayload(
  payload: unknown,
  preferredFacilityId: number,
): Availability {
  const root = asRecord(payload);
  if (!root || root.status !== 0) {
    throw new DomainError("Dooremi rejected the availability request.");
  }

  const content = Array.isArray(root.content) ? root.content : [];
  const facilities = content
    .map((item) => asRecord(asRecord(item)?.facility))
    .filter((item): item is Record<string, unknown> => item !== null);
  const facility =
    facilities.find((item) => numericId(item.id) === preferredFacilityId) ??
    facilities[0];
  if (!facility) {
    throw new DomainError(
      "No facility availability was returned for that date.",
    );
  }

  const facilityId = numericId(facility.id) ?? preferredFacilityId;
  const rawSlots = Array.isArray(facility.condoBookingFacilityDateBeanList)
    ? facility.condoBookingFacilityDateBeanList
    : [];
  const slots = rawSlots.map((rawSlot): AvailabilitySlot => {
    const slot = asRecord(rawSlot);
    if (!slot) {
      throw new DomainError("Dooremi returned an unreadable availability slot.");
    }
    const start = requiredString(slot.startFrom, "slot start time");
    const end = requiredString(slot.endTo, "slot end time");
    const eventTime = validateEventTime(`${start}-${end}`);
    return {
      id: numericId(slot.id),
      facilityId: numericId(slot.facilityId) ?? facilityId,
      eventTime,
      available: slot.state === 0 && slot.bookingOrderId == null,
    };
  });

  const multiSelectTime = numericId(facility.multiSelectTime) ?? 1;
  return {
    facilityId,
    facilityName:
      typeof facility.facilityName === "string" && facility.facilityName.trim()
        ? facility.facilityName.trim()
        : "Tennis court",
    maximumSelectableSlots: Math.max(1, multiSelectTime),
    slots,
  };
}

export function activeTennisBookings(
  bookings: readonly BookingRecord[],
): BookingRecord[] {
  return bookings.filter(
    (booking) =>
      booking.statusName === "Confirmed" &&
      booking.facilityName.toLocaleLowerCase("en").includes("tennis"),
  );
}
