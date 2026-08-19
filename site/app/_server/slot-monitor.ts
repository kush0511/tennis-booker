import { loadAvailabilityWindow } from "@/app/_server/availability-window";
import { dooremiClient } from "@/app/_server/api";
import {
  getSettings,
  listEnabledSlotMonitors,
  reconcileSlotMonitorMatches,
  recordSlotMonitorScanFailure,
  type SlotMonitor,
} from "@/db/repository";
import { safeErrorMessage } from "@/lib/dooremi";
import {
  rankedSlotGroups,
  type RankedSlotGroup,
} from "@/lib/slot-discovery";

export type SlotMonitorRun = {
  checkedAt: string;
  monitorCount: number;
  newMatchCount: number;
  failedMonitorCount: number;
};

export async function scanSlotMonitors(baseUrl: string): Promise<SlotMonitorRun> {
  const checkedAt = new Date().toISOString();
  const monitors = await listEnabledSlotMonitors();
  if (!monitors.length) {
    return {
      checkedAt,
      monitorCount: 0,
      newMatchCount: 0,
      failedMonitorCount: 0,
    };
  }

  let client: Awaited<ReturnType<typeof dooremiClient>>;
  try {
    client = await dooremiClient();
  } catch (error) {
    const message = safeErrorMessage(error) || "Dooremi is unavailable.";
    await Promise.all(
      monitors.map((monitor) =>
        recordSlotMonitorScanFailure(monitor.userEmail, checkedAt, message),
      ),
    );
    return {
      checkedAt,
      monitorCount: monitors.length,
      newMatchCount: 0,
      failedMonitorCount: monitors.length,
    };
  }

  const results = await Promise.all(
    monitors.map(async (monitor) => {
      try {
        const settings = await getSettings(monitor.userEmail);
        if (!settings.facilityId || !settings.facilityCategoryId) {
          throw new Error("Court facility settings are incomplete.");
        }
        const window = await loadAvailabilityWindow(client.fork(), settings);
        const successfulDays = window.days.filter((day) => !day.error);
        if (!successfulDays.length) {
          throw new Error("No day in the two-week window could be checked.");
        }
        const matches = rankedSlotGroups(successfulDays, {
          startMinute: monitor.startMinute,
          endMinute: monitor.endMinute,
          minimumContiguousSlots: monitor.minimumContiguousSlots,
        });
        const failedDays = window.days.filter((day) => day.error);
        const error = failedDays.length
          ? `${failedDays.length} of ${window.days.length} days could not be checked; successful days remain monitored.`
          : null;
        const notification = notificationContent(monitor, matches, baseUrl);
        const newMatchCount = await reconcileSlotMonitorMatches({
          userEmail: monitor.userEmail,
          recipientEmail: monitor.recipientEmail,
          matches: matches.map((match) => ({
            fingerprint: match.fingerprint,
            eventDay: match.eventDay,
            eventTimes: match.eventTimes,
            score: match.score,
          })),
          scannedDays: successfulDays.map((day) => day.eventDay),
          scannedAt: checkedAt,
          error,
          notification,
        });
        return { newMatchCount, failed: false };
      } catch (error) {
        await recordSlotMonitorScanFailure(
          monitor.userEmail,
          checkedAt,
          safeErrorMessage(error) || "The slot monitor could not run.",
        );
        return { newMatchCount: 0, failed: true };
      }
    }),
  );
  return {
    checkedAt,
    monitorCount: monitors.length,
    newMatchCount: results.reduce(
      (total, result) => total + result.newMatchCount,
      0,
    ),
    failedMonitorCount: results.filter((result) => result.failed).length,
  };
}

function notificationContent(
  monitor: SlotMonitor,
  matches: readonly RankedSlotGroup[],
  baseUrl: string,
) {
  const best = matches.slice(0, 6);
  const subject = best[0]
    ? `Court Signal: ${slotSummary(best[0])} opened`
    : "Court Signal: a preferred tennis slot opened";
  const preference = `${clockLabel(monitor.startMinute)}–${clockLabel(monitor.endMinute)}, ${monitor.minimumContiguousSlots}+ contiguous session${monitor.minimumContiguousSlots === 1 ? "" : "s"}`;
  const lines = best.map((match, index) => {
    const link = slotLink(baseUrl, match);
    return `${index + 1}. ${longDay(match.eventDay)} · ${timeRange(match)} · ${match.reasons.join(" · ")}\n   ${link}`;
  });
  const textBody = [
    "Court Signal found a new opening that matches your alert filter.",
    `Filter: ${preference}`,
    "",
    ...lines,
    ...(matches.length > best.length
      ? ["", `Plus ${matches.length - best.length} more matching opportunities in Court Signal.`]
      : []),
    "",
    "Availability can change quickly. Court Signal will re-check the selected day before booking and the normal safety lock still applies.",
  ].join("\n");
  const cards = best
    .map(
      (match, index) => `<li style="margin:0 0 14px"><strong>#${index + 1} ${escapeHtml(longDay(match.eventDay))}</strong><br>${escapeHtml(timeRange(match))} · ${escapeHtml(match.reasons.join(" · "))}<br><a href="${escapeHtml(slotLink(baseUrl, match))}">Review and book</a></li>`,
    )
    .join("");
  const htmlBody = `<div style="font-family:Arial,sans-serif;color:#17284a;line-height:1.5"><p><strong>Court Signal found a new preferred opening.</strong></p><p>Filter: ${escapeHtml(preference)}</p><ol style="padding-left:22px">${cards}</ol>${matches.length > best.length ? `<p>Plus ${matches.length - best.length} more matching opportunities in Court Signal.</p>` : ""}<p style="color:#5a686a;font-size:13px">Availability can change quickly. Court Signal re-checks the selected day before booking, and its normal safety lock still applies.</p></div>`;
  return { subject, textBody, htmlBody };
}

function slotSummary(match: RankedSlotGroup): string {
  const evening = match.eveningSlotCount === match.slotCount ? "evening " : "";
  return `${match.slotCount} ${evening}hour${match.slotCount === 1 ? "" : "s"} on ${shortDay(match.eventDay)}`;
}

function slotLink(baseUrl: string, match: RankedSlotGroup): string {
  const url = new URL("/", baseUrl);
  url.searchParams.set("day", match.eventDay);
  url.searchParams.set("times", match.eventTimes.join(","));
  return url.toString();
}

function timeRange(match: RankedSlotGroup): string {
  return `${clockLabel(match.startMinute)}–${clockLabel(match.endMinute)}`;
}

function clockLabel(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour >= 12 && hour < 24 ? "pm" : "am";
  const displayHour = hour % 12 || 12;
  return minute ? `${displayHour}:${String(minute).padStart(2, "0")}${suffix}` : `${displayHour}${suffix}`;
}

function shortDay(eventDay: string): string {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${eventDay}T12:00:00+08:00`));
}

function longDay(eventDay: string): string {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${eventDay}T12:00:00+08:00`));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}
