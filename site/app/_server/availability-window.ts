import type { UserSettings } from "@/db/repository";
import type { DooremiClient } from "@/lib/dooremi";
import { safeErrorMessage } from "@/lib/dooremi";
import {
  sessionDays,
  singaporeDay,
  SLOT_WINDOW_DAYS,
  type AvailabilityWindow,
  type AvailabilityWindowDay,
} from "@/lib/slot-discovery";

const AVAILABILITY_CONCURRENCY = 3;

export async function loadAvailabilityWindow(
  client: DooremiClient,
  settings: Pick<UserSettings, "facilityId" | "facilityCategoryId">,
  options: { startDay?: string; dayCount?: number } = {},
): Promise<AvailabilityWindow> {
  const days = sessionDays(
    options.startDay ?? singaporeDay(),
    options.dayCount ?? SLOT_WINDOW_DAYS,
  );
  const results = await mapWithConcurrency(
    days,
    AVAILABILITY_CONCURRENCY,
    async (eventDay): Promise<AvailabilityWindowDay> => {
      try {
        const availability = await client.availability(
          eventDay,
          settings.facilityId,
          settings.facilityCategoryId,
        );
        return {
          eventDay,
          facilityId: availability.facilityId,
          facilityName: availability.facilityName,
          slots: availability.slots,
          error: null,
        };
      } catch (error) {
        return {
          eventDay,
          facilityId: settings.facilityId,
          facilityName: "Tennis court",
          slots: [],
          error:
            safeErrorMessage(error) ||
            "Availability could not be checked for this day.",
        };
      }
    },
  );
  return {
    generatedAt: new Date().toISOString(),
    rangeStart: days[0],
    rangeEnd: days.at(-1) ?? days[0],
    days: results,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      async () => {
        while (nextIndex < values.length) {
          const index = nextIndex++;
          results[index] = await mapper(values[index], index);
        }
      },
    ),
  );
  return results;
}
