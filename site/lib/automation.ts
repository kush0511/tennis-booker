export const AUTOMATION_CRON = "* * * * *";
export const AUTOMATION_HEARTBEAT_ID = "runner";

// Claim and warm the hosted transaction early without exposing existing court
// slots for this entire interval. Destructive cancellation still follows the
// user's narrower cancellation lead inside the prepared transaction.
export const HOSTED_PREPARATION_LEAD_SECONDS = 60;
export const HOSTED_ARMING_WINDOW_SECONDS = 240;
export const HOSTED_GRACE_PERIOD_SECONDS = 300;
// Calibrate twice: a pre-cancellation health gate protects existing bookings,
// then a denser probe train near release drives the actual transmit time.
export const HOSTED_PRE_CANCELLATION_PROBE_COUNT = 3;
export const HOSTED_PRE_CANCELLATION_MINIMUM_SUCCESSES = 2;
export const HOSTED_LATENCY_PROBE_COUNT = 5;
export const HOSTED_LATENCY_PROBE_INTERVAL_MILLISECONDS = 75;
export const HOSTED_LATENCY_PROBE_TIMEOUT_MILLISECONDS = 500;
export const HOSTED_LATENCY_CALIBRATION_LEAD_MILLISECONDS = 4_000;
export const HOSTED_LATENCY_CALIBRATION_CUTOFF_MILLISECONDS = 1_500;
export const HOSTED_LATENCY_PERCENTILE = 0.75;
export const HOSTED_MINIMUM_LATENCY_SAMPLES = 5;
export const HOSTED_FALLBACK_ROUND_TRIP_MILLISECONDS = 120;
export const HOSTED_MAX_TRANSMISSION_LEAD_MILLISECONDS = 250;

// These delays apply only after Dooremi has returned an explicit rejection,
// which proves that the preceding attempt did not create a booking. Ambiguous
// responses are reconciled against booking history instead of being resent.
export const HOSTED_REJECTED_SUBMISSION_RETRY_DELAYS_MILLISECONDS = [
  40,
  90,
  200,
  450,
] as const;
export const HOSTED_REJECTED_SUBMISSION_RETRIES =
  HOSTED_REJECTED_SUBMISSION_RETRY_DELAYS_MILLISECONDS.length;
export const HOSTED_REJECTED_SUBMISSION_RETRY_STAGGER_MILLISECONDS = 10;
export const HOSTED_AMBIGUOUS_RECONCILIATION_DELAYS_MILLISECONDS = [
  0,
  250,
  750,
  1_500,
] as const;
export const EXTERNAL_WAKE_START_MINUTE_SGT = 11 * 60 + 30;
export const EXTERNAL_WAKE_END_MINUTE_SGT = 12 * 60 + 5;

export function effectiveHostedPreparationLead(configuredSeconds: number): number {
  return Math.max(configuredSeconds, HOSTED_PREPARATION_LEAD_SECONDS);
}

export function externalWakeCoversRelease(hour: number, minute: number): boolean {
  const releaseMinute = hour * 60 + minute;
  return (
    Number.isInteger(releaseMinute) &&
    releaseMinute >= EXTERNAL_WAKE_START_MINUTE_SGT &&
    releaseMinute <= EXTERNAL_WAKE_END_MINUTE_SGT
  );
}
