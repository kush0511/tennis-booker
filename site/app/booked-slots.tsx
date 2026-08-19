"use client";

import { useMemo } from "react";
import {
  bookingDay,
  bookingHistorySections,
  sessionDays,
  singaporeDay,
} from "../lib/slot-discovery.js";

export type BookingDisplayRecord = {
  id: number;
  facilityName: string;
  eventDay: string;
  eventTime: string;
  eventTimes: string[];
  statusName: string;
  canCancel: boolean;
};

export function BookedSlots({
  bookings,
  loading,
  canMutate,
  submitting,
  onCancel,
}: {
  bookings: BookingDisplayRecord[];
  loading: boolean;
  canMutate: boolean;
  submitting: boolean;
  onCancel: (booking: BookingDisplayRecord) => void;
}) {
  const today = singaporeDay();
  const sections = useMemo(
    () => bookingHistorySections(bookings, today),
    [bookings, today],
  );
  const activeUpcoming = sections.upcoming.filter(
    (booking) => booking.statusName.toLowerCase() === "confirmed",
  );
  const days = sessionDays(today);
  const bookingsByDay = useMemo(() => {
    const grouped = new Map<string, BookingDisplayRecord[]>();
    for (const booking of activeUpcoming) {
      const day = bookingDay(booking.eventDay);
      grouped.set(day, [...(grouped.get(day) || []), booking]);
    }
    return grouped;
  }, [activeUpcoming]);

  return (
    <>
      <section className="booked-calendar" aria-labelledby="booked-calendar-heading">
        <div className="booked-summary">
          <div>
            <p className="section-kicker">Next 14 days</p>
            <h3 id="booked-calendar-heading">Your court rhythm</h3>
          </div>
          <strong>
            {activeUpcoming.reduce(
              (total, booking) => total + bookingTimes(booking).length,
              0,
            )}
            <span> booked sessions</span>
          </strong>
        </div>
        <div className="booked-fortnight" aria-label="Upcoming booked sessions by day">
          {days.map((day) => {
            const dayBookings = bookingsByDay.get(day) || [];
            const parts = calendarDay(day);
            return (
              <article
                className={`booked-day ${dayBookings.length ? "has-booking" : ""}`}
                key={day}
              >
                <header>
                  <span>{parts.weekday}</span>
                  <strong>{parts.day}</strong>
                </header>
                <div>
                  {dayBookings.length ? (
                    dayBookings.flatMap((booking) =>
                      bookingTimes(booking).map((time) => (
                        <span
                          className={isEvening(time) ? "is-evening" : ""}
                          key={`${booking.id}-${time}`}
                        >
                          {compactTime(time)}
                        </span>
                      )),
                    )
                  ) : (
                    <i aria-hidden="true" />
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="booking-itinerary" aria-labelledby="upcoming-bookings-heading">
        <div className="itinerary-heading">
          <div>
            <p className="section-kicker">Chronological itinerary</p>
            <h3 id="upcoming-bookings-heading">Upcoming</h3>
          </div>
          <span>Earliest first</span>
        </div>
        {loading && !bookings.length ? (
          <div className="itinerary-loading">Checking your Dooremi bookings…</div>
        ) : sections.upcoming.length ? (
          <div className="itinerary-list">
            {sections.upcoming.map((booking) => (
              <BookingItineraryRow
                booking={booking}
                key={booking.id}
                canMutate={canMutate}
                submitting={submitting}
                onCancel={onCancel}
              />
            ))}
          </div>
        ) : (
          <div className="itinerary-empty">
            <strong>No upcoming bookings</strong>
            <p>Your next confirmed court will appear here in date order.</p>
          </div>
        )}
      </section>

      {sections.previous.length ? (
        <details className="previous-bookings">
          <summary>
            <span>Previous bookings</span>
            <strong>{sections.previous.length}</strong>
          </summary>
          <div className="itinerary-list">
            {sections.previous.slice(0, 24).map((booking) => (
              <BookingItineraryRow
                booking={booking}
                key={booking.id}
                canMutate={false}
                submitting={submitting}
                onCancel={onCancel}
              />
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
}

function BookingItineraryRow({
  booking,
  canMutate,
  submitting,
  onCancel,
}: {
  booking: BookingDisplayRecord;
  canMutate: boolean;
  submitting: boolean;
  onCancel: (booking: BookingDisplayRecord) => void;
}) {
  const day = calendarDay(bookingDay(booking.eventDay));
  const times = bookingTimes(booking);
  return (
    <article className="itinerary-row">
      <time dateTime={bookingDay(booking.eventDay)}>
        <span>{day.weekday}</span>
        <strong>{day.day}</strong>
        <small>{day.month}</small>
      </time>
      <div className="itinerary-track" aria-label={times.join(", ")}>
        {times.map((time, index) => (
          <span
            className={`${isEvening(time) ? "is-evening" : ""} ${isJoined(times, index) ? "is-joined" : ""}`}
            key={time}
          >
            {compactTime(time)}
          </span>
        ))}
      </div>
      <div className="itinerary-copy">
        <strong>{booking.facilityName}</strong>
        <span>
          {times.length} session{times.length === 1 ? "" : "s"} · {booking.statusName}
        </span>
      </div>
      {booking.canCancel ? (
        <button
          type="button"
          className="danger-link"
          onClick={() => onCancel(booking)}
          disabled={submitting || !canMutate}
        >
          Cancel
        </button>
      ) : null}
    </article>
  );
}

function bookingTimes(booking: BookingDisplayRecord): string[] {
  return booking.eventTimes.length ? booking.eventTimes : [booking.eventTime];
}

function calendarDay(day: string) {
  const date = new Date(`${day}T12:00:00+08:00`);
  return {
    weekday: new Intl.DateTimeFormat("en-SG", {
      timeZone: "Asia/Singapore",
      weekday: "short",
    }).format(date),
    day: new Intl.DateTimeFormat("en-SG", {
      timeZone: "Asia/Singapore",
      day: "numeric",
    }).format(date),
    month: new Intl.DateTimeFormat("en-SG", {
      timeZone: "Asia/Singapore",
      month: "short",
    }).format(date),
  };
}

function compactTime(time: string): string {
  const [start, end] = time.split("-");
  return `${clock(start)}–${clock(end)}`;
}

function clock(value: string): string {
  const [hourValue, minuteValue] = value.split(":").map(Number);
  const suffix = hourValue >= 12 ? "p" : "a";
  const hour = hourValue % 12 || 12;
  return minuteValue ? `${hour}:${String(minuteValue).padStart(2, "0")}${suffix}` : `${hour}${suffix}`;
}

function isEvening(time: string): boolean {
  return Number(time.slice(0, 2)) >= 18;
}

function isJoined(times: string[], index: number): boolean {
  if (index === 0) return false;
  return times[index - 1].split("-")[1] === times[index].split("-")[0];
}
