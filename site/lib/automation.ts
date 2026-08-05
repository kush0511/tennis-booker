export const AUTOMATION_CRON = "* * * * *";
export const AUTOMATION_HEARTBEAT_ID = "runner";

// Claim and warm the hosted transaction early without exposing existing court
// slots for this entire interval. Destructive cancellation still follows the
// user's narrower cancellation lead inside the prepared transaction.
export const HOSTED_PREPARATION_LEAD_SECONDS = 60;
export const HOSTED_ARMING_WINDOW_SECONDS = 240;
export const HOSTED_GRACE_PERIOD_SECONDS = 300;
export const HOSTED_MAX_TRANSMISSION_LEAD_MILLISECONDS = 40;
export const HOSTED_REJECTED_SUBMISSION_RETRIES = 1;
export const HOSTED_REJECTED_SUBMISSION_RETRY_DELAY_MILLISECONDS = 60;
export const HOSTED_REJECTED_SUBMISSION_RETRY_STAGGER_MILLISECONDS = 10;
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
