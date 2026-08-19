import {
  normalizeEventDay,
  validateEventTime,
  type AvailabilitySlot,
} from "./domain.js";

export const SLOT_WINDOW_DAYS = 14;
export const EVENING_START_MINUTE = 18 * 60;

export type AvailabilityWindowDay = {
  eventDay: string;
  facilityId: number;
  facilityName: string;
  slots: AvailabilitySlot[];
  error: string | null;
};

export type AvailabilityWindow = {
  generatedAt: string;
  rangeStart: string;
  rangeEnd: string;
  days: AvailabilityWindowDay[];
};

export type SlotPreferences = {
  startMinute: number;
  endMinute: number;
  minimumContiguousSlots: number;
};

export type RankedSlotGroup = {
  fingerprint: string;
  eventDay: string;
  eventTimes: string[];
  startMinute: number;
  endMinute: number;
  slotCount: number;
  eveningSlotCount: number;
  score: number;
  reasons: string[];
};

export type TimeSlotOccurrence = {
  eventDay: string;
  eventTime: string;
  runLength: number;
  isEvening: boolean;
};

export type TimeSlotGroup = {
  eventTime: string;
  startMinute: number;
  isEvening: boolean;
  occurrences: TimeSlotOccurrence[];
};

export type BookingLike = {
  id: number;
  eventDay: string;
  eventTime: string;
  eventTimes: string[];
};

export type BookingHistorySections<T extends BookingLike> = {
  upcoming: T[];
  previous: T[];
};

export function singaporeDay(instant = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("Singapore calendar date could not be resolved.");
  }
  return `${year}-${month}-${day}`;
}

export function sessionDays(
  startDay: string,
  count = SLOT_WINDOW_DAYS,
): string[] {
  const normalized = normalizeEventDay(startDay);
  const date = new Date(`${normalized}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const value = new Date(date);
    value.setUTCDate(value.getUTCDate() + index);
    return value.toISOString().slice(0, 10);
  });
}

export function eventTimeMinutes(eventTime: string): {
  startMinute: number;
  endMinute: number;
} {
  const normalized = validateEventTime(eventTime);
  const [start, end] = normalized.split("-");
  return {
    startMinute: clockMinutes(start),
    endMinute: clockMinutes(end),
  };
}

export function rankedSlotGroups(
  days: readonly AvailabilityWindowDay[],
  preferences: SlotPreferences = {
    startMinute: 0,
    endMinute: 24 * 60,
    minimumContiguousSlots: 1,
  },
): RankedSlotGroup[] {
  validatePreferences(preferences);
  const groups = days.flatMap((day) => {
    if (day.error) return [];
    const open = day.slots
      .filter((slot) => slot.available)
      .map((slot) => ({
        eventTime: validateEventTime(slot.eventTime),
        ...eventTimeMinutes(slot.eventTime),
      }))
      .filter(
        (slot) =>
          slot.startMinute >= preferences.startMinute &&
          slot.endMinute <= preferences.endMinute,
      )
      .sort((left, right) => left.startMinute - right.startMinute);

    const contiguous: typeof open[] = [];
    for (const slot of open) {
      const current = contiguous.at(-1);
      if (current && current.at(-1)?.endMinute === slot.startMinute) {
        current.push(slot);
      } else {
        contiguous.push([slot]);
      }
    }

    return contiguous
      .filter((group) => group.length >= preferences.minimumContiguousSlots)
      .map((group) => {
        const eventTimes = group.map((slot) => slot.eventTime);
        const eveningSlotCount = group.filter(
          (slot) => slot.startMinute >= EVENING_START_MINUTE,
        ).length;
        const slotCount = group.length;
        const score =
          slotCount * 30 +
          Math.max(0, slotCount - 1) * 70 +
          eveningSlotCount * 45 +
          (eveningSlotCount === slotCount ? 30 : 0);
        const reasons = [
          ...(slotCount > 1 ? [`${slotCount} contiguous hours`] : []),
          ...(eveningSlotCount === slotCount
            ? ["All evening"]
            : eveningSlotCount > 0
              ? [`${eveningSlotCount} evening hour${eveningSlotCount === 1 ? "" : "s"}`]
              : []),
          ...(slotCount === 1 && eveningSlotCount === 0 ? ["Single opening"] : []),
        ];
        return {
          fingerprint: `${day.eventDay}|${eventTimes.join(",")}`,
          eventDay: day.eventDay,
          eventTimes,
          startMinute: group[0].startMinute,
          endMinute: group.at(-1)?.endMinute ?? group[0].endMinute,
          slotCount,
          eveningSlotCount,
          score,
          reasons,
        };
      });
  });

  return groups.sort(
    (left, right) =>
      right.score - left.score ||
      left.eventDay.localeCompare(right.eventDay) ||
      left.startMinute - right.startMinute,
  );
}

export function timeSlotGroups(
  days: readonly AvailabilityWindowDay[],
): TimeSlotGroup[] {
  const runLengths = new Map<string, number>();
  const groupsByTime = new Map<string, TimeSlotGroup>();

  for (const group of rankedSlotGroups(days)) {
    for (const eventTime of group.eventTimes) {
      runLengths.set(`${group.eventDay}|${eventTime}`, group.slotCount);
    }
  }

  for (const day of days) {
    if (day.error) continue;
    for (const slot of day.slots) {
      if (!slot.available) continue;
      const eventTime = validateEventTime(slot.eventTime);
      const { startMinute } = eventTimeMinutes(eventTime);
      const existing = groupsByTime.get(eventTime) ?? {
        eventTime,
        startMinute,
        isEvening: startMinute >= EVENING_START_MINUTE,
        occurrences: [],
      };
      existing.occurrences.push({
        eventDay: day.eventDay,
        eventTime,
        runLength: runLengths.get(`${day.eventDay}|${eventTime}`) ?? 1,
        isEvening: startMinute >= EVENING_START_MINUTE,
      });
      groupsByTime.set(eventTime, existing);
    }
  }

  return [...groupsByTime.values()]
    .map((group) => ({
      ...group,
      occurrences: group.occurrences.sort((left, right) =>
        left.eventDay.localeCompare(right.eventDay),
      ),
    }))
    .sort((left, right) => left.startMinute - right.startMinute);
}

export function bookingHistorySections<T extends BookingLike>(
  bookings: readonly T[],
  today = singaporeDay(),
): BookingHistorySections<T> {
  const normalizedToday = normalizeEventDay(today);
  const upcoming: T[] = [];
  const previous: T[] = [];
  for (const booking of bookings) {
    const day = bookingDay(booking.eventDay);
    (day >= normalizedToday ? upcoming : previous).push(booking);
  }
  upcoming.sort(compareBookingsAscending);
  previous.sort((left, right) => compareBookingsAscending(right, left));
  return { upcoming, previous };
}

export function bookingDay(value: string): string {
  try {
    return normalizeEventDay(value);
  } catch {
    return "0000-01-01";
  }
}

function compareBookingsAscending(left: BookingLike, right: BookingLike): number {
  const leftDay = bookingDay(left.eventDay);
  const rightDay = bookingDay(right.eventDay);
  return (
    leftDay.localeCompare(rightDay) ||
    bookingStartMinute(left) - bookingStartMinute(right) ||
    left.id - right.id
  );
}

function bookingStartMinute(booking: BookingLike): number {
  const first = booking.eventTimes[0] || booking.eventTime;
  try {
    return eventTimeMinutes(first).startMinute;
  } catch {
    return 0;
  }
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function validatePreferences(preferences: SlotPreferences): void {
  if (
    !Number.isInteger(preferences.startMinute) ||
    !Number.isInteger(preferences.endMinute) ||
    preferences.startMinute < 0 ||
    preferences.endMinute > 24 * 60 ||
    preferences.startMinute >= preferences.endMinute
  ) {
    throw new Error("The slot-monitor time window is invalid.");
  }
  if (
    !Number.isInteger(preferences.minimumContiguousSlots) ||
    preferences.minimumContiguousSlots < 1 ||
    preferences.minimumContiguousSlots > 10
  ) {
    throw new Error("The contiguous-slot preference must be between 1 and 10.");
  }
}
