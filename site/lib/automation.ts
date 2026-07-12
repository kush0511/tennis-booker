export const AUTOMATION_CRON = "* * * * *";
export const AUTOMATION_HEARTBEAT_ID = "runner";

// The hosted runner has a 12 second upstream timeout. Three cancellation /
// verification passes can therefore consume roughly 75 seconds even when
// cancellations within a pass are sent concurrently. Keep a safety margin for
// Worker scheduling and D1 writes instead of inheriting the local Mac's 15s
// lead, where connection behavior and latency are materially different.
export const HOSTED_CANCELLATION_LEAD_SECONDS = 90;
export const HOSTED_ARMING_WINDOW_SECONDS = 240;
export const HOSTED_GRACE_PERIOD_SECONDS = 300;
export const EXTERNAL_WAKE_START_MINUTE_SGT = 11 * 60 + 30;
export const EXTERNAL_WAKE_END_MINUTE_SGT = 12 * 60 + 5;

export function effectiveHostedCancellationLead(configuredSeconds: number): number {
  return Math.max(configuredSeconds, HOSTED_CANCELLATION_LEAD_SECONDS);
}

export function externalWakeCoversRelease(hour: number, minute: number): boolean {
  const releaseMinute = hour * 60 + minute;
  return (
    Number.isInteger(releaseMinute) &&
    releaseMinute >= EXTERNAL_WAKE_START_MINUTE_SGT &&
    releaseMinute <= EXTERNAL_WAKE_END_MINUTE_SGT
  );
}
