import type { Metadata } from "next";
import { getChatGPTUser, chatGPTSignInPath } from "./chatgpt-auth";
import { TennisDashboard } from "./tennis-dashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Court Signal" },
  description: "A precise, mobile-first tennis court scheduler for Dooremi.",
};

export default async function Home() {
  const authenticated = await getChatGPTUser();
  const localEmail =
    process.env.NODE_ENV === "development"
      ? process.env.LOCAL_DEV_USER_EMAIL || "local@court-signal.test"
      : null;
  const user =
    authenticated ||
    (localEmail
      ? { email: localEmail, displayName: "Local player", fullName: null }
      : null);

  if (!user) {
    return (
      <main className="signin-shell">
        <div className="signin-card">
          <div className="brand-mark" aria-hidden="true">
            CS
          </div>
          <p className="eyebrow">Private court operations</p>
          <h1>Your booking window, under control.</h1>
          <p>
            Sign in with ChatGPT to view live Dooremi availability, arm a
            release, and review every result.
          </p>
          <a className="primary-button" href={chatGPTSignInPath("/")}>
            Sign in with ChatGPT
          </a>
          <small>
            Court Signal receives your account email to keep schedules private
            to you. It never sends the Dooremi token to your browser.
          </small>
        </div>
      </main>
    );
  }

  const [
    { getRuntimeEnv },
    { getSettings, listSchedules },
    { externalWakeCoversRelease },
    { maintainDooremiSession, bookingMutationStatus },
  ] = await Promise.all([
    import("@/db"),
    import("@/db/repository"),
    import("@/lib/automation"),
    import("@/app/_server/api"),
  ]);
  const [settings, schedules, bookingGuard] = await Promise.all([
    getSettings(user.email),
    listSchedules(user.email),
    bookingMutationStatus(),
  ]);
  const { currentSuggestedSessionDay } = await import("@/lib/domain");
  const session = await maintainDooremiSession();
  const tokenConfigured =
    session.autoRenewConfigured ||
    session.source === "managed" ||
    session.source === "bootstrap";
  const initialBookingCredential = session.bookingCredential;
  const automationReady = Boolean(
    getRuntimeEnv().AUTOMATION_SECRET &&
      getRuntimeEnv().AUTOMATION_TRIGGER_ENABLED === "true" &&
      externalWakeCoversRelease(settings.releaseHour, settings.releaseMinute),
  );

  return (
    <TennisDashboard
      user={{ email: user.email, displayName: user.displayName }}
      initialSettings={settings}
      initialSchedules={schedules}
      initialDay={currentSuggestedSessionDay(settings.bookingLeadDays)}
      tokenConfigured={tokenConfigured}
      initialBookingCredential={initialBookingCredential}
      initialBookingApiGuard={{
        status: bookingGuard.guard.status,
        bookingsEnabled: bookingGuard.decision.enabled,
        expectedAppVersion: bookingGuard.guard.expectedAppVersion,
        observedAppVersion: bookingGuard.guard.observedAppVersion,
        checkedAt: bookingGuard.guard.checkedAt,
        lastHealthyAt: bookingGuard.guard.lastHealthyAt,
        disabledAt: bookingGuard.guard.disabledAt,
        failureCode: bookingGuard.guard.failureCode,
        failureMessage: bookingGuard.guard.failureMessage,
        message: bookingGuard.decision.message,
      }}
      automationReady={automationReady}
    />
  );
}
