"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { StoredSchedule, UserSettings } from "@/db/repository";

type AvailabilitySlot = {
  id: number | string | null;
  facilityId: number;
  eventTime: string;
  available: boolean;
};

type Availability = {
  facilityId: number;
  facilityName: string;
  maximumSelectableSlots: number;
  slots: AvailabilitySlot[];
};

type BookingRecord = {
  id: number;
  facilityName: string;
  eventDay: string;
  eventTime: string;
  eventTimes: string[];
  statusName: string;
  canCancel: boolean;
};

type ApiResponse<T> = {
  data?: T;
  error?: string;
};

type DashboardProps = {
  user: { email: string; displayName: string };
  initialSettings: UserSettings;
  initialSchedules: StoredSchedule[];
  tokenConfigured: boolean;
  automationReady: boolean;
};

type Tab = "book" | "plans" | "history";

export function TennisDashboard({
  user,
  initialSettings,
  initialSchedules,
  tokenConfigured,
  automationReady,
}: DashboardProps) {
  const [tab, setTab] = useState<Tab>("book");
  const [settings, setSettings] = useState(initialSettings);
  const [schedules, setSchedules] = useState(initialSchedules);
  const [bookings, setBookings] = useState<BookingRecord[]>([]);
  const [selectedDay, setSelectedDay] = useState("");
  const [dayAnchor, setDayAnchor] = useState<number | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [selectedTimes, setSelectedTimes] = useState<string[]>([]);
  const [loadingAvailability, setLoadingAvailability] = useState(false);
  const [loadingBookings, setLoadingBookings] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);

  const dates = useMemo(
    () =>
      dayAnchor === null
        ? []
        : Array.from({ length: 7 }, (_, index) =>
            suggestedSessionDay(settings.bookingLeadDays, index, dayAnchor),
          ),
    [dayAnchor, settings.bookingLeadDays],
  );
  const release = useMemo(
    () => (selectedDay ? releaseFor(selectedDay, settings) : null),
    [selectedDay, settings],
  );
  const releaseOpen =
    release !== null && now !== null && now >= release.getTime();
  const activePlans = schedules.filter((item) =>
    ["pending", "running"].includes(item.status),
  );
  const recentPlans = schedules
    .filter((item) => !["pending", "running"].includes(item.status))
    .slice(0, 6);

  useEffect(() => {
    let clockTimer: number | null = null;
    const startupTimer = window.setTimeout(() => {
      const current = Date.now();
      setNow(current);
      setDayAnchor(current);
      setSelectedDay((day) =>
        day || suggestedSessionDay(initialSettings.bookingLeadDays, 0, current),
      );
      clockTimer = window.setInterval(() => setNow(Date.now()), 1000);
    }, 0);
    return () => {
      window.clearTimeout(startupTimer);
      if (clockTimer !== null) window.clearInterval(clockTimer);
    };
  }, [initialSettings.bookingLeadDays]);

  const loadAvailability = useCallback(async () => {
    if (
      !selectedDay ||
      !tokenConfigured ||
      !settings.facilityId ||
      !settings.facilityCategoryId
    ) {
      setAvailability(null);
      return;
    }
    setLoadingAvailability(true);
    setError(null);
    try {
      const result = await api<Availability>(
        `/api/availability?date=${encodeURIComponent(selectedDay)}`,
      );
      setAvailability(result);
      setSelectedTimes((current) =>
        current.filter((time) =>
          result.slots.some((slot) => slot.eventTime === time && slot.available),
        ),
      );
    } catch (caught) {
      setAvailability(null);
      setError(messageOf(caught));
    } finally {
      setLoadingAvailability(false);
    }
  }, [selectedDay, settings, tokenConfigured]);

  const loadBookings = useCallback(async () => {
    if (!tokenConfigured) return;
    setLoadingBookings(true);
    try {
      const result = await api<BookingRecord[]>("/api/bookings");
      setBookings(result);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoadingBookings(false);
    }
  }, [tokenConfigured]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAvailability(), 0);
    return () => window.clearTimeout(timer);
  }, [loadAvailability]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadBookings(), 0);
    return () => window.clearTimeout(timer);
  }, [loadBookings]);

  function changeDay(day: string) {
    setSelectedDay(day);
    setSelectedTimes([]);
    setNotice(null);
    setError(null);
  }

  function toggleSlot(slot: AvailabilitySlot) {
    if (!slot.available) return;
    setSelectedTimes((current) => {
      if (current.includes(slot.eventTime)) {
        return current.filter((value) => value !== slot.eventTime);
      }
      if (current.length >= settings.maximumSessions) {
        setError(`Choose at most ${settings.maximumSessions} sessions.`);
        return current;
      }
      setError(null);
      return [...current, slot.eventTime];
    });
  }

  async function submitSelection() {
    if (!selectedTimes.length) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      if (releaseOpen) {
        const result = await api<{
          status: string;
          message: string;
          bookingOrderIds: number[];
        }>("/api/bookings/execute", {
          method: "POST",
          body: JSON.stringify({
            eventDay: selectedDay,
            eventTimes: selectedTimes,
          }),
        });
        setNotice(result.message);
        setSelectedTimes([]);
        await Promise.all([loadAvailability(), loadBookings()]);
      } else {
        const schedule = await api<StoredSchedule>("/api/schedules", {
          method: "POST",
          body: JSON.stringify({
            eventDay: selectedDay,
            eventTimes: selectedTimes,
          }),
        });
        setSchedules((current) => [schedule, ...current]);
        setNotice(
          automationReady
            ? `${selectedTimes.length} session${selectedTimes.length === 1 ? "" : "s"} armed for ${formatRelease(schedule.releaseAt)}.`
            : `Release plan saved for ${formatRelease(schedule.releaseAt)}. Open it inside the four-minute arming window to run it, or use the TUI for unattended execution.`,
        );
        setSelectedTimes([]);
      }
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelPlan(schedule: StoredSchedule) {
    setSubmitting(true);
    setError(null);
    try {
      await api(`/api/schedules/${encodeURIComponent(schedule.id)}/cancel`, {
        method: "POST",
      });
      setSchedules((current) =>
        current.map((item) =>
          item.id === schedule.id ? { ...item, status: "cancelled" } : item,
        ),
      );
      setNotice("The schedule was cancelled before execution.");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSubmitting(false);
    }
  }

  async function runPlan(schedule: StoredSchedule) {
    setSubmitting(true);
    setError(null);
    setNotice("The hosted runner is preparing your synchronized release.");
    try {
      const result = await api<{
        status: StoredSchedule["status"];
        message: string;
        bookingOrderIds: number[];
      }>(`/api/schedules/${encodeURIComponent(schedule.id)}/run`, {
        method: "POST",
      });
      setSchedules((current) =>
        current.map((item) =>
          item.id === schedule.id
            ? { ...item, status: result.status, resultMessage: result.message }
            : item,
        ),
      );
      setNotice(result.message);
      await Promise.all([loadAvailability(), loadBookings()]);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelRemoteBooking(booking: BookingRecord) {
    setSubmitting(true);
    setError(null);
    try {
      const result = await api<{ message: string }>(
        `/api/bookings/${booking.id}/cancel`,
        { method: "POST" },
      );
      setNotice(result.message);
      await Promise.all([loadBookings(), loadAvailability()]);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSubmitting(false);
    }
  }

  async function persistSettings(next: UserSettings) {
    setSubmitting(true);
    setError(null);
    try {
      const saved = await api<UserSettings>("/api/settings", {
        method: "PUT",
        body: JSON.stringify(next),
      });
      setSettings(saved);
      const current = Date.now();
      setDayAnchor(current);
      setSelectedDay(suggestedSessionDay(saved.bookingLeadDays, 0, current));
      setSettingsOpen(false);
      setSelectedTimes([]);
      setNotice("Court settings saved.");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button
          className="wordmark"
          type="button"
          onClick={() => setTab("book")}
          aria-label="Court Signal home"
        >
          <span className="wordmark-dot" />
          COURT<span>/</span>SIGNAL
        </button>
        <div className="topbar-actions">
          <span className={`connection-pill ${tokenConfigured ? "is-live" : ""}`}>
            <span /> {tokenConfigured ? "Dooremi live" : "Setup needed"}
          </span>
          <button
            className="avatar-button"
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open booking settings"
          >
            {initials(user.displayName)}
          </button>
        </div>
      </header>

      <div className="desktop-grid">
        <section
          className={`booking-column ${tab === "book" ? "mobile-active" : ""}`}
          aria-labelledby="booking-heading"
        >
          <div className="release-hero">
            <div className="court-lines" aria-hidden="true">
              <span className="court-net" />
              <span className="court-ball" />
            </div>
            <div className="hero-copy">
              <p className="eyebrow">
                {release === null
                  ? "Court clock"
                  : releaseOpen
                    ? "Booking window open"
                    : "Next release"}
              </p>
              <h1 id="booking-heading">
                {release === null || now === null
                  ? "Syncing release…"
                  : releaseOpen
                    ? "Ready when you are."
                    : countdownLabel(release.getTime() - now)}
              </h1>
              <p className="release-detail">
                {release === null
                  ? "Singapore time"
                  : `${formatDay(selectedDay)} · ${formatClock(release)} SGT`}
              </p>
            </div>
            <div
              className="release-state"
              aria-label={
                release === null
                  ? "Syncing court clock"
                  : releaseOpen
                  ? "Booking is open"
                  : automationReady
                    ? "Booking is armed"
                    : "Manual release mode"
              }
            >
              <span className="pulse-ring" />
              {release === null
                ? "SYNC"
                : releaseOpen
                  ? "OPEN"
                  : automationReady
                    ? "TRACKING"
                    : "MANUAL"}
            </div>
          </div>

          {!tokenConfigured ? (
            <div className="setup-banner" role="status">
              <div>
                <strong>Add your hosted secret</strong>
                <p>
                  Set <code>DOOREMI_BEARER_TOKEN</code> in this Site’s settings,
                  then redeploy. It stays on the server.
                </p>
              </div>
              <button type="button" onClick={() => setSettingsOpen(true)}>
                Court IDs
              </button>
            </div>
          ) : null}

          <section className="date-section" aria-labelledby="date-label">
            <div className="section-heading-row">
              <div>
                <p className="section-kicker">Step 1</p>
                <h2 id="date-label">Choose a court day</h2>
              </div>
              <span>Singapore time</span>
            </div>
            <div className="date-rail" role="list" aria-label="Session dates">
              {dates.map((day) => {
                const parts = dateParts(day);
                return (
                  <button
                    type="button"
                    className={`date-chip ${selectedDay === day ? "is-selected" : ""}`}
                    key={day}
                    onClick={() => changeDay(day)}
                    aria-pressed={selectedDay === day}
                  >
                    <span>{parts.weekday}</span>
                    <strong>{parts.day}</strong>
                    <small>{parts.month}</small>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="slot-section" aria-labelledby="slot-label">
            <div className="section-heading-row">
              <div>
                <p className="section-kicker">Step 2</p>
                <h2 id="slot-label">Pick your sessions</h2>
              </div>
              <button
                className="text-button"
                type="button"
                onClick={() => void loadAvailability()}
                disabled={loadingAvailability || !tokenConfigured}
              >
                {loadingAvailability ? "Checking…" : "Refresh"}
              </button>
            </div>

            <div className="facility-strip">
              <div className="facility-monogram" aria-hidden="true">TC</div>
              <div>
                <strong>{availability?.facilityName || "Tennis court"}</strong>
                <span>
                  {availability
                    ? `${availability.slots.filter((slot) => slot.available).length} sessions available`
                    : "Live availability appears here"}
                </span>
              </div>
              <span className="facility-status">LIVE</span>
            </div>

            <div className="slot-grid" aria-busy={loadingAvailability}>
              {loadingAvailability
                ? Array.from({ length: 6 }, (_, index) => (
                    <div className="slot-skeleton" key={index} aria-hidden="true" />
                  ))
                : availability?.slots.map((slot) => {
                    const selected = selectedTimes.includes(slot.eventTime);
                    return (
                      <button
                        type="button"
                        key={`${slot.id}-${slot.eventTime}`}
                        className={`slot-card ${selected ? "is-selected" : ""} ${!slot.available ? "is-unavailable" : ""}`}
                        disabled={!slot.available}
                        onClick={() => toggleSlot(slot)}
                        aria-pressed={selected}
                      >
                        <span className="slot-time">{slot.eventTime.split("-")[0]}</span>
                        <span className="slot-end">to {slot.eventTime.split("-")[1]}</span>
                        <span className="slot-state">
                          {selected ? "Selected" : slot.available ? "Available" : "Booked"}
                        </span>
                      </button>
                    );
                  })}
              {!loadingAvailability && !availability ? (
                <div className="empty-slots">
                  <span aria-hidden="true">＋</span>
                  <strong>Connect your court</strong>
                  <p>Add the facility and category IDs to load this date.</p>
                  <button type="button" onClick={() => setSettingsOpen(true)}>
                    Open settings
                  </button>
                </div>
              ) : null}
            </div>
          </section>

          <div className={`selection-dock ${selectedTimes.length ? "is-visible" : ""}`}>
            <div>
              <span>{selectedTimes.length} selected</span>
              <strong>{selectedTimes.join(" · ") || "Choose a session"}</strong>
            </div>
            <button
              className="primary-button"
              type="button"
              onClick={() => void submitSelection()}
              disabled={!selectedTimes.length || submitting || !tokenConfigured}
            >
              {submitting
                ? "Working…"
                : releaseOpen
                  ? `Book ${selectedTimes.length || ""} now`
                  : automationReady
                    ? `Arm ${selectedTimes.length || ""} release`
                    : `Save ${selectedTimes.length || ""} plan`}
            </button>
          </div>
        </section>

        <aside
          className={`operations-column ${tab === "plans" ? "mobile-active" : ""}`}
          aria-labelledby="plans-heading"
        >
          <div className="aside-heading">
            <div>
              <p className="section-kicker">Your automation</p>
              <h2 id="plans-heading">Release plans</h2>
            </div>
            <span className="count-badge">{activePlans.length}</span>
          </div>

          <div className="plan-list">
            {activePlans.length ? (
              activePlans.map((schedule) => (
                <article className="plan-card" key={schedule.id}>
                  <div className="plan-marker" aria-hidden="true">
                    <span />
                  </div>
                  <div className="plan-content">
                    <div className="plan-title-row">
                      <strong>{formatDay(schedule.eventDay)}</strong>
                      <StatusPill status={schedule.status} />
                    </div>
                    <p>{schedule.eventTimes.join(" · ")}</p>
                    <div className="plan-meta">
                      <span>Releases {formatRelease(schedule.releaseAt)}</span>
                      <span>Up to {settings.maximumSessions} synchronized</span>
                      {!automationReady ? <span>Manual trigger required</span> : null}
                    </div>
                    {schedule.status === "pending" &&
                    now !== null &&
                    insideArmingWindow(schedule.releaseAt, now) ? (
                      <button
                        className="run-plan-button"
                        type="button"
                        onClick={() => void runPlan(schedule)}
                        disabled={submitting || !tokenConfigured}
                      >
                        Run this release
                      </button>
                    ) : null}
                    {schedule.status === "pending" ? (
                      <button
                        className="danger-link"
                        type="button"
                        onClick={() => void cancelPlan(schedule)}
                        disabled={submitting}
                      >
                        Cancel plan
                      </button>
                    ) : null}
                  </div>
                </article>
              ))
            ) : (
              <div className="empty-plans">
                <div className="empty-court" aria-hidden="true"><span /></div>
                <strong>No release plans yet</strong>
                <p>Select future sessions and Court Signal will keep the plan here.</p>
                <button type="button" onClick={() => setTab("book")}>Choose sessions</button>
              </div>
            )}
          </div>

          {recentPlans.length ? (
            <section className="recent-results" aria-labelledby="recent-results-heading">
              <div className="recent-heading">
                <h3 id="recent-results-heading">Recent results</h3>
                <span>{recentPlans.length}</span>
              </div>
              <div className="result-list">
                {recentPlans.map((schedule) => (
                  <article className="result-row" key={schedule.id}>
                    <div>
                      <strong>{formatDay(schedule.eventDay)}</strong>
                      <span>{schedule.eventTimes.join(" · ")}</span>
                      {schedule.resultMessage ? <small>{schedule.resultMessage}</small> : null}
                    </div>
                    <StatusPill status={schedule.status} />
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          <div className="safety-card">
            <span className="safety-icon" aria-hidden="true">✓</span>
            <div>
              <strong>Safe replacement mode</strong>
              <p>
                Active tennis bookings are verified and preserved in the same
                synchronized batch. Ambiguous requests are never retried.
              </p>
            </div>
          </div>
          {automationReady ? (
            <div className="trigger-card is-active">
              <strong>Google Cloud wake window active</strong>
              <p>
                Court Signal checks for armed releases every minute from 11:30 AM
                through 12:05 PM Singapore time. The D1 lease prevents duplicate
                execution when wake-up calls overlap.
              </p>
            </div>
          ) : (
            <div className="trigger-card">
              <strong>Unattended trigger not connected</strong>
              <p>
                Sites securely stores plans and can execute them, but its current
                manifest cannot provision the exact-time trigger. Run a plan in
                its four-minute window or keep using the macOS TUI for unattended releases.
              </p>
            </div>
          )}
        </aside>

        <section
          className={`history-column ${tab === "history" ? "mobile-active" : ""}`}
          aria-labelledby="history-heading"
        >
          <div className="aside-heading">
            <div>
              <p className="section-kicker">Dooremi account</p>
              <h2 id="history-heading">My bookings</h2>
            </div>
            <button
              className="text-button"
              type="button"
              onClick={() => void loadBookings()}
              disabled={loadingBookings || !tokenConfigured}
            >
              {loadingBookings ? "Checking…" : "Refresh"}
            </button>
          </div>
          <div className="history-list">
            {bookings.map((booking) => (
              <article className="booking-row" key={booking.id}>
                <div className="booking-date">
                  <strong>{historyDayNumber(booking.eventDay)}</strong>
                  <span>{historyMonth(booking.eventDay)}</span>
                </div>
                <div className="booking-copy">
                  <strong>{booking.facilityName}</strong>
                  <span>{booking.eventTime}</span>
                  <small>{booking.statusName}</small>
                </div>
                {booking.canCancel ? (
                  <button
                    type="button"
                    className="danger-link"
                    onClick={() => void cancelRemoteBooking(booking)}
                    disabled={submitting}
                  >
                    Cancel
                  </button>
                ) : null}
              </article>
            ))}
            {!bookings.length && !loadingBookings ? (
              <div className="empty-plans compact">
                <strong>No bookings returned</strong>
                <p>Confirmed Dooremi bookings will appear here.</p>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <div className="toast-stack" aria-live="polite" aria-atomic="true">
        {notice ? <div className="toast success">{notice}</div> : null}
        {error ? <div className="toast error">{error}</div> : null}
      </div>

      <nav className="mobile-nav" aria-label="Primary navigation">
        <NavButton label="Book" active={tab === "book"} onClick={() => setTab("book")} symbol="＋" />
        <NavButton label="Plans" active={tab === "plans"} onClick={() => setTab("plans")} symbol="◷" count={activePlans.length} />
        <NavButton label="Bookings" active={tab === "history"} onClick={() => setTab("history")} symbol="≡" />
      </nav>

      {settingsOpen ? (
        <SettingsSheet
          settings={settings}
          email={user.email}
          saving={submitting}
          onClose={() => setSettingsOpen(false)}
          onSave={persistSettings}
        />
      ) : null}
    </main>
  );
}

function SettingsSheet({
  settings,
  email,
  saving,
  onClose,
  onSave,
}: {
  settings: UserSettings;
  email: string;
  saving: boolean;
  onClose: () => void;
  onSave: (settings: UserSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-heading"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-heading">
          <div>
            <p className="section-kicker">Private configuration</p>
            <h2 id="settings-heading">Court settings</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close settings">×</button>
        </div>
        <p className="account-line">Signed in as {email}</p>
        <div className="settings-grid">
          <NumberField
            label="Facility ID"
            value={draft.facilityId}
            onChange={(facilityId) => setDraft({ ...draft, facilityId })}
          />
          <NumberField
            label="Category ID"
            value={draft.facilityCategoryId}
            onChange={(facilityCategoryId) =>
              setDraft({ ...draft, facilityCategoryId })
            }
          />
          <NumberField
            label="Release hour"
            value={draft.releaseHour}
            min={0}
            max={23}
            onChange={(releaseHour) => setDraft({ ...draft, releaseHour })}
          />
          <NumberField
            label="Release minute"
            value={draft.releaseMinute}
            min={0}
            max={59}
            onChange={(releaseMinute) => setDraft({ ...draft, releaseMinute })}
          />
          <NumberField
            label="Booking lead days"
            value={draft.bookingLeadDays}
            min={1}
            max={60}
            onChange={(bookingLeadDays) => setDraft({ ...draft, bookingLeadDays })}
          />
          <NumberField
            label="Max sessions"
            value={draft.maximumSessions}
            min={1}
            max={6}
            onChange={(maximumSessions) => setDraft({ ...draft, maximumSessions })}
          />
        </div>
        <div className="secret-note">
          <strong>The Dooremi token is not editable here.</strong>
          <p>
            It belongs in the Site’s hosted <code>DOOREMI_BEARER_TOKEN</code>
            secret so browser code and database records can never read it.
          </p>
        </div>
        <button
          className="primary-button wide"
          type="button"
          disabled={saving || !draft.facilityId || !draft.facilityCategoryId}
          onClick={() => void onSave(draft)}
        >
          {saving ? "Saving…" : "Save court settings"}
        </button>
      </section>
    </div>
  );
}

function NumberField({
  label,
  value,
  min = 1,
  max = 999999999,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value || ""}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}

function NavButton({
  label,
  symbol,
  active,
  count,
  onClick,
}: {
  label: string;
  symbol: string;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className={active ? "is-active" : ""}>
      <span className="nav-symbol">{symbol}</span>
      <span>{label}</span>
      {count ? <small>{count}</small> : null}
    </button>
  );
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const payload = (await response.json()) as ApiResponse<T>;
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }
  return payload.data as T;
}

function suggestedSessionDay(
  leadDays: number,
  offset: number,
  instant: number,
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const current = new Date(Date.UTC(year, month - 1, day));
  current.setUTCDate(current.getUTCDate() + leadDays + offset);
  return current.toISOString().slice(0, 10);
}

function releaseFor(day: string, settings: UserSettings): Date {
  const session = new Date(`${day}T00:00:00+08:00`);
  session.setUTCDate(session.getUTCDate() - settings.bookingLeadDays);
  const releaseDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(session);
  return new Date(
    `${releaseDay}T${String(settings.releaseHour).padStart(2, "0")}:${String(settings.releaseMinute).padStart(2, "0")}:00+08:00`,
  );
}

function countdownLabel(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h to go`;
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function dateParts(day: string) {
  const value = new Date(`${day}T12:00:00+08:00`);
  return {
    weekday: new Intl.DateTimeFormat("en-SG", { weekday: "short", timeZone: "Asia/Singapore" }).format(value),
    day: new Intl.DateTimeFormat("en-SG", { day: "2-digit", timeZone: "Asia/Singapore" }).format(value),
    month: new Intl.DateTimeFormat("en-SG", { month: "short", timeZone: "Asia/Singapore" }).format(value),
  };
}

function formatDay(day: string): string {
  return new Intl.DateTimeFormat("en-SG", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Asia/Singapore",
  }).format(new Date(`${day}T12:00:00+08:00`));
}

function formatClock(value: Date): string {
  return new Intl.DateTimeFormat("en-SG", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Singapore",
  }).format(value);
}

function formatRelease(value: string): string {
  return new Intl.DateTimeFormat("en-SG", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Singapore",
  }).format(new Date(value));
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function insideArmingWindow(releaseAt: string, now: number): boolean {
  const milliseconds = new Date(releaseAt).valueOf() - now;
  return milliseconds <= 240_000 && milliseconds >= -300_000;
}

function historyDayNumber(value: string): string {
  const match = value.match(/(?:,\s)?(\d{2})\/(\d{2})\/(\d{4})/);
  if (match) return match[1];
  const iso = value.match(/^\d{4}-\d{2}-(\d{2})$/);
  return iso?.[1] || "—";
}

function historyMonth(value: string): string {
  const match = value.match(/(?:,\s)?(\d{2})\/(\d{2})\/(\d{4})/);
  const month = match?.[2] || value.match(/^\d{4}-(\d{2})-\d{2}$/)?.[1];
  if (!month) return "";
  return new Intl.DateTimeFormat("en-SG", { month: "short" }).format(
    new Date(Date.UTC(2026, Number(month) - 1, 1)),
  );
}
