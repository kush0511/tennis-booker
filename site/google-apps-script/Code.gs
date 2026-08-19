const COURT_SIGNAL_URL_PROPERTY = "COURT_SIGNAL_MONITOR_URL";
const COURT_SIGNAL_SECRET_PROPERTY = "COURT_SIGNAL_MONITOR_SECRET";
const COURT_SIGNAL_HANDLER = "pollCourtSignal";

function setupCourtSignal() {
  const properties = PropertiesService.getScriptProperties();
  requireProperty_(properties, COURT_SIGNAL_URL_PROPERTY);
  requireProperty_(properties, COURT_SIGNAL_SECRET_PROPERTY);
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === COURT_SIGNAL_HANDLER)
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger(COURT_SIGNAL_HANDLER)
    .timeBased()
    .everyMinutes(15)
    .create();
  pollCourtSignal();
}

function pollCourtSignal() {
  const properties = PropertiesService.getScriptProperties();
  const endpoint = requireProperty_(properties, COURT_SIGNAL_URL_PROPERTY);
  const secret = requireProperty_(properties, COURT_SIGNAL_SECRET_PROPERTY);
  const response = callCourtSignal_(endpoint, secret, { action: "poll" });
  const notifications = response.data && response.data.notifications
    ? response.data.notifications
    : [];
  notifications.forEach((notification) => {
    GmailApp.sendEmail(
      notification.recipientEmail,
      notification.subject,
      notification.textBody,
      {
        htmlBody: notification.htmlBody,
        name: "Court Signal",
      },
    );
    callCourtSignal_(endpoint, secret, {
      action: "acknowledge",
      notificationIds: [notification.id],
    });
  });
}

function callCourtSignal_(endpoint, secret, payload) {
  const response = UrlFetchApp.fetch(endpoint, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${secret}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  let parsed;
  try {
    parsed = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error(`Court Signal returned unreadable data (${status}).`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(parsed.error || `Court Signal monitor failed (${status}).`);
  }
  return parsed;
}

function requireProperty_(properties, key) {
  const value = properties.getProperty(key);
  if (!value) throw new Error(`Missing script property: ${key}`);
  return value;
}
