"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  EVENING_START_MINUTE,
  rankedSlotGroups,
  timeSlotGroups,
  type AvailabilityWindow,
  type RankedSlotGroup,
} from "../lib/slot-discovery.js";

type ApiResponse<T> = { data?: T; error?: string };

type SlotMonitor = {
  userEmail: string;
  enabled: boolean;
  recipientEmail: string;
  startMinute: number;
  endMinute: number;
  minimumContiguousSlots: number;
  lastScanAt: string | null;
  lastError: string | null;
  lastNotificationAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type SlotMonitorResponse = {
  monitor: SlotMonitor;
  deliveryConfigured: boolean;
  recipientEmail: string | null;
};

type AvailabilityExplorerProps = {
  tokenConfigured: boolean;
  maximumSessions: number;
  onChoose: (eventDay: string, eventTimes: string[]) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
};

export function AvailabilityExplorer({
  tokenConfigured,
  maximumSessions,
  onChoose,
  onError,
  onNotice,
}: AvailabilityExplorerProps) {
  const [availabilityWindow, setAvailabilityWindow] =
    useState<AvailabilityWindow | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"best" | "time">("best");
  const [eveningOnly, setEveningOnly] = useState(false);
  const [monitorState, setMonitorState] = useState<SlotMonitorResponse | null>(null);
  const [loadingMonitor, setLoadingMonitor] = useState(true);
  const [savingMonitor, setSavingMonitor] = useState(false);

  const loadWindow = useCallback(async () => {
    if (!tokenConfigured) return;
    setLoading(true);
    try {
      setAvailabilityWindow(
        await request<AvailabilityWindow>("/api/availability/overview"),
      );
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [onError, tokenConfigured]);

  const loadMonitor = useCallback(async () => {
    setLoadingMonitor(true);
    try {
      setMonitorState(await request<SlotMonitorResponse>("/api/slot-monitor"));
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setLoadingMonitor(false);
    }
  }, [onError]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadWindow(), 0);
    return () => window.clearTimeout(timer);
  }, [loadWindow]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadMonitor(), 0);
    return () => window.clearTimeout(timer);
  }, [loadMonitor]);

  const ranked = useMemo(
    () =>
      availabilityWindow ? rankedSlotGroups(availabilityWindow.days) : [],
    [availabilityWindow],
  );
  const byTime = useMemo(
    () =>
      availabilityWindow
        ? timeSlotGroups(availabilityWindow.days).filter(
            (group) => !eveningOnly || group.startMinute >= EVENING_START_MINUTE,
          )
        : [],
    [availabilityWindow, eveningOnly],
  );
  const dayMetrics = useMemo(() => {
    if (!availabilityWindow) return [];
    const bestByDay = new Map<string, RankedSlotGroup>();
    for (const group of ranked) {
      if (!bestByDay.has(group.eventDay)) bestByDay.set(group.eventDay, group);
    }
    return availabilityWindow.days.map((day) => {
      const open = day.slots.filter((slot) => slot.available);
      const evening = open.filter((slot) => {
        const hour = Number(slot.eventTime.slice(0, 2));
        return hour >= 18;
      });
      return {
        eventDay: day.eventDay,
        openCount: open.length,
        eveningCount: evening.length,
        failed: Boolean(day.error),
        best: bestByDay.get(day.eventDay) ?? null,
      };
    });
  }, [availabilityWindow, ranked]);
  const totalOpen = dayMetrics.reduce((total, day) => total + day.openCount, 0);
  const failedDays = dayMetrics.filter((day) => day.failed).length;

  function choose(group: RankedSlotGroup) {
    onChoose(group.eventDay, group.eventTimes.slice(0, maximumSessions));
  }

  function updateMonitor(patch: Partial<SlotMonitor>) {
    setMonitorState((current) =>
      current
        ? { ...current, monitor: { ...current.monitor, ...patch } }
        : current,
    );
  }

  async function saveMonitor() {
    if (!monitorState) return;
    setSavingMonitor(true);
    try {
      const saved = await request<SlotMonitorResponse>("/api/slot-monitor", {
        method: "PUT",
        body: JSON.stringify({
          enabled: monitorState.monitor.enabled,
          startMinute: monitorState.monitor.startMinute,
          endMinute: monitorState.monitor.endMinute,
          minimumContiguousSlots:
            monitorState.monitor.minimumContiguousSlots,
        }),
      });
      setMonitorState(saved);
      onNotice(
        saved.monitor.enabled
          ? "Google email monitoring saved."
          : "Slot email monitoring paused.",
      );
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSavingMonitor(false);
    }
  }

  return (
    <section className="availability-explorer" aria-labelledby="radar-heading">
      <div className="radar-heading-row">
        <div>
          <p className="section-kicker">Two-week court radar</p>
          <h2 id="radar-heading">Find the openings worth playing</h2>
          <p>
            Evenings and connected sessions rise to the top. Every opening is
            still available by clock time below.
          </p>
        </div>
        <button
          className="radar-refresh"
          type="button"
          onClick={() => void loadWindow()}
          disabled={loading || !tokenConfigured}
        >
          {loading ? "Scanning 14 days…" : "Refresh radar"}
        </button>
      </div>

      <div className="radar-statline" aria-live="polite">
        <strong>{loading && !availabilityWindow ? "—" : totalOpen}</strong>
        <span>open sessions across the next 14 days</span>
        {failedDays ? <small>{failedDays} days need a retry</small> : null}
      </div>

      <div className="fortnight-ribbon" aria-label="Open sessions by day">
        {loading && !availabilityWindow
          ? Array.from({ length: 14 }, (_, index) => (
              <span className="ribbon-day is-loading" key={index} />
            ))
          : dayMetrics.map((day) => {
              const parts = compactDay(day.eventDay);
              return (
                <button
                  className={`ribbon-day ${day.eveningCount ? "has-evening" : ""} ${day.best?.slotCount && day.best.slotCount > 1 ? "has-run" : ""}`}
                  type="button"
                  key={day.eventDay}
                  disabled={!day.best}
                  onClick={() => day.best && choose(day.best)}
                  aria-label={
                    day.failed
                      ? `${parts.long}: availability check failed`
                      : `${parts.long}: ${day.openCount} openings, ${day.eveningCount} in the evening`
                  }
                >
                  <span>{parts.weekday}</span>
                  <strong>{parts.day}</strong>
                  <i
                    style={{
                      height: `${Math.min(30, 4 + day.openCount * 4)}px`,
                    }}
                  />
                  <small>{day.failed ? "!" : day.openCount || "—"}</small>
                </button>
              );
            })}
      </div>
      <div className="ribbon-legend" aria-hidden="true">
        <span><i /> Daytime</span>
        <span><i className="evening-key" /> After 6 pm</span>
        <span><b /> Connected hours</span>
      </div>

      <div className="radar-controls">
        <div className="segmented-control" aria-label="Availability view">
          <button
            type="button"
            className={mode === "best" ? "is-active" : ""}
            onClick={() => setMode("best")}
            aria-pressed={mode === "best"}
          >
            Best slots
          </button>
          <button
            type="button"
            className={mode === "time" ? "is-active" : ""}
            onClick={() => setMode("time")}
            aria-pressed={mode === "time"}
          >
            By timeslot
          </button>
        </div>
        {mode === "time" ? (
          <label className="evening-filter">
            <input
              type="checkbox"
              checked={eveningOnly}
              onChange={(event) => setEveningOnly(event.target.checked)}
            />
            After 6 pm only
          </label>
        ) : null}
      </div>

      <div className="radar-content">
        <div className="radar-results">
          {mode === "best" ? (
            <BestSlots
              ranked={ranked}
              loading={loading}
              onChoose={choose}
            />
          ) : (
            <TimeSlotBrowser
              groups={byTime}
              loading={loading}
              onChoose={(eventDay, eventTime) =>
                onChoose(eventDay, [eventTime])
              }
            />
          )}
        </div>

        <details className="monitor-card">
          <summary className="monitor-title-row">
            <div>
              <span className="monitor-signal" aria-hidden="true" />
              <p className="section-kicker">Slot alerts</p>
              <h3>Watch for a better opening</h3>
            </div>
            <span className="monitor-summary-status">
              {loadingMonitor || !monitorState
                ? "Loading"
                : monitorState.monitor.enabled
                  ? "On"
                  : "Off"}
            </span>
          </summary>
          <div className="monitor-body">
            {loadingMonitor || !monitorState ? (
              <div className="monitor-loading">Loading your alert filter…</div>
            ) : (
              <>
                <label className="monitor-toggle">
                  <span>Email me when matches appear</span>
                  <input
                    type="checkbox"
                    checked={monitorState.monitor.enabled}
                    onChange={(event) =>
                      updateMonitor({ enabled: event.target.checked })
                    }
                  />
                </label>
              <div className="monitor-filter-grid">
                <label>
                  <span>From</span>
                  <select
                    value={monitorState.monitor.startMinute}
                    onChange={(event) =>
                      updateMonitor({ startMinute: Number(event.target.value) })
                    }
                  >
                    {hourOptions(5, 23).map((option) => (
                      <option value={option.value} key={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Until</span>
                  <select
                    value={monitorState.monitor.endMinute}
                    onChange={(event) =>
                      updateMonitor({ endMinute: Number(event.target.value) })
                    }
                  >
                    {hourOptions(6, 24).map((option) => (
                      <option value={option.value} key={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="contiguous-filter">
                  <span>Minimum connected sessions</span>
                  <select
                    value={monitorState.monitor.minimumContiguousSlots}
                    onChange={(event) =>
                      updateMonitor({
                        minimumContiguousSlots: Number(event.target.value),
                      })
                    }
                  >
                    {[1, 2, 3, 4].map((value) => (
                      <option value={value} key={value}>
                        {value} {value === 1 ? "hour" : "hours"}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="monitor-destination">
                <span>Email destination</span>
                <strong>{monitorState.monitor.recipientEmail}</strong>
              </div>
              <button
                className="monitor-save"
                type="button"
                onClick={() => void saveMonitor()}
                disabled={savingMonitor}
              >
                {savingMonitor ? "Saving…" : "Save alert filter"}
              </button>
              <div className="monitor-status">
                <span
                  className={monitorState.deliveryConfigured ? "is-connected" : ""}
                />
                <p>
                  {monitorState.deliveryConfigured
                    ? monitorState.monitor.enabled
                      ? "Google checks every 15 minutes and emails only newly opened matches."
                      : "Google delivery is connected; monitoring is paused."
                    : "Google delivery will activate with the hosted monitor."}
                  {monitorState.monitor.lastScanAt
                    ? ` Last checked ${relativeTime(monitorState.monitor.lastScanAt)}.`
                    : ""}
                </p>
              </div>
              {monitorState.monitor.lastError ? (
                <p className="monitor-error">{monitorState.monitor.lastError}</p>
              ) : null}
              </>
            )}
          </div>
        </details>
      </div>
    </section>
  );
}

function BestSlots({
  ranked,
  loading,
  onChoose,
}: {
  ranked: RankedSlotGroup[];
  loading: boolean;
  onChoose: (group: RankedSlotGroup) => void;
}) {
  if (loading && !ranked.length) {
    return (
      <div className="best-slot-list" aria-label="Loading ranked slots">
        {Array.from({ length: 4 }, (_, index) => (
          <span className="best-slot-skeleton" key={index} />
        ))}
      </div>
    );
  }
  if (!ranked.length) {
    return (
      <div className="radar-empty">
        <strong>No open sessions in the current scan</strong>
        <p>The monitor will keep watching the full two-week window.</p>
      </div>
    );
  }
  return (
    <div className="best-slot-list">
      {ranked.slice(0, 8).map((group, index) => (
        <article
          className={`best-slot-card ${group.eveningSlotCount === group.slotCount ? "is-evening" : ""}`}
          key={group.fingerprint}
        >
          <span className="rank-number">#{index + 1}</span>
          <div className="best-slot-date">
            <strong>{compactDay(group.eventDay).weekday}</strong>
            <span>{compactDay(group.eventDay).date}</span>
          </div>
          <div className="best-slot-copy">
            <strong>{groupTime(group)}</strong>
            <span>{group.reasons.join(" · ")}</span>
          </div>
          <button type="button" onClick={() => onChoose(group)}>
            Book {group.slotCount > 1 ? "block" : "slot"} →
          </button>
        </article>
      ))}
    </div>
  );
}

function TimeSlotBrowser({
  groups,
  loading,
  onChoose,
}: {
  groups: ReturnType<typeof timeSlotGroups>;
  loading: boolean;
  onChoose: (eventDay: string, eventTime: string) => void;
}) {
  if (loading && !groups.length) {
    return <div className="timeslot-loading">Building the timeslot index…</div>;
  }
  if (!groups.length) {
    return (
      <div className="radar-empty">
        <strong>No matching timeslots</strong>
        <p>Try showing the full day or refresh the radar.</p>
      </div>
    );
  }
  return (
    <div className="timeslot-browser">
      {groups.map((group) => (
        <section
          className={`timeslot-row ${group.isEvening ? "is-evening" : ""}`}
          key={group.eventTime}
        >
          <div className="timeslot-label">
            <strong>{shortTimeRange(group.eventTime)}</strong>
            <span>
              {group.occurrences.length} opening
              {group.occurrences.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="timeslot-dates">
            {group.occurrences.map((occurrence) => (
              <button
                type="button"
                className={occurrence.runLength > 1 ? "is-connected" : ""}
                key={`${occurrence.eventDay}-${occurrence.eventTime}`}
                onClick={() => onChoose(occurrence.eventDay, occurrence.eventTime)}
                title={
                  occurrence.runLength > 1
                    ? `Part of ${occurrence.runLength} connected hours`
                    : "Single opening"
                }
              >
                <strong>{compactDay(occurrence.eventDay).weekday}</strong>
                <span>{compactDay(occurrence.eventDay).day}</span>
                {occurrence.runLength > 1 ? <small>{occurrence.runLength}×</small> : null}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const payload = (await response.json()) as ApiResponse<T>;
  if (!response.ok || !payload.data) {
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }
  return payload.data;
}

function compactDay(eventDay: string) {
  const date = new Date(`${eventDay}T12:00:00+08:00`);
  const weekday = new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "short",
  }).format(date);
  const day = new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    day: "numeric",
  }).format(date);
  const dateLabel = new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "short",
  }).format(date);
  return {
    weekday,
    day,
    date: dateLabel,
    long: `${weekday} ${dateLabel}`,
  };
}

function groupTime(group: RankedSlotGroup): string {
  return `${clock(group.startMinute)}–${clock(group.endMinute)}`;
}

function shortTimeRange(eventTime: string): string {
  const [start, end] = eventTime.split("-");
  return `${clockString(start)}–${clockString(end)}`;
}

function clock(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return clockString(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
}

function clockString(value: string): string {
  const [hourValue, minute] = value.split(":").map(Number);
  const suffix = hourValue >= 12 && hourValue < 24 ? "pm" : "am";
  const hour = hourValue % 12 || 12;
  return minute ? `${hour}:${String(minute).padStart(2, "0")}${suffix}` : `${hour}${suffix}`;
}

function hourOptions(startHour: number, endHour: number) {
  return Array.from({ length: endHour - startHour + 1 }, (_, index) => {
    const hour = startHour + index;
    return { value: hour * 60, label: clock(hour * 60) };
  });
}

function relativeTime(value: string): string {
  const milliseconds = Date.now() - new Date(value).valueOf();
  if (milliseconds < 60_000) return "just now";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}
