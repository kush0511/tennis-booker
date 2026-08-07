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
    { DooremiClient },
  ] = await Promise.all([
    import("@/db"),
    import("@/db/repository"),
    import("@/lib/automation"),
    import("@/lib/dooremi"),
  ]);
  const [settings, schedules] = await Promise.all([
    getSettings(user.email),
    listSchedules(user.email),
  ]);
  const { currentSuggestedSessionDay } = await import("@/lib/domain");
  const token = getRuntimeEnv().DOOREMI_BEARER_TOKEN;
  const tokenConfigured = Boolean(token);
  const initialBookingCredential = token
    ? new DooremiClient({ token }).bookingCredential()
    : {
        status: "missing" as const,
        issuedAt: null,
        minimumIssuedAt: null,
      };
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
      automationReady={automationReady}
    />
  );
}
