import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FALSE_VALUES = new Set(["0", "false", "no"]);
const ENABLED = !FALSE_VALUES.has((process.env.KANBAN_NOTIFY ?? "1").trim().toLowerCase());
const EVENTS = new Set(
  (process.env.KANBAN_NOTIFY_EVENTS ?? "standby,a_valider,error")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
);

const TITLES = {
  standby: "Claude Kanban — Question",
  a_valider: "Claude Kanban — À valider",
  error: "Claude Kanban — Erreur",
};
const MAX_BODY_LENGTH = 200;

const WINDOWS_APP_ID = String.raw`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`;
const WINDOWS_SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $xml.GetElementsByTagName('text')
$texts.Item(0).AppendChild($xml.CreateTextNode($env:KANBAN_NOTIFY_TITLE)) | Out-Null
$texts.Item(1).AppendChild($xml.CreateTextNode($env:KANBAN_NOTIFY_BODY)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_APP_ID}').Show($toast)
`;

/** Title and body for an event; the body is `<project> · #<id> <title>` (+ reason). */
export function buildMessage(event, projectName, ticketId, ticketTitle, reason = "") {
  let body = `${projectName} · #${ticketId} ${ticketTitle}`;
  if (reason) body += ` — ${reason}`;
  return [TITLES[event] ?? "Claude Kanban", body];
}

function applescriptEscape(text) {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function which(command) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Returns [cmd, args, env] for the current platform, or null if unsupported. */
function buildCommand(title, body) {
  if (process.platform === "darwin") {
    const script = `display notification "${applescriptEscape(body)}" with title "${applescriptEscape(title)}"`;
    return ["osascript", ["-e", script], undefined];
  }
  if (process.platform === "win32") {
    const args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_SCRIPT];
    const env = { ...process.env, KANBAN_NOTIFY_TITLE: title, KANBAN_NOTIFY_BODY: body };
    return ["powershell", args, env];
  }
  if (process.platform === "linux" && which("notify-send")) {
    return ["notify-send", [title, body], undefined];
  }
  return null;
}

/** Fire-and-forget native notification. Never throws, never blocks. */
export function notify(event, title, body) {
  try {
    if (!ENABLED || !EVENTS.has(event)) return;
    const built = buildCommand(title, body.slice(0, MAX_BODY_LENGTH));
    if (built === null) return;
    const [cmd, args, env] = built;
    const child = spawn(cmd, args, { env, stdio: "ignore", windowsHide: true });
    child.on("error", (err) => console.warn(`notification failed: ${err.message}`));
    child.unref();
  } catch (err) {
    console.warn(`notification failed: ${err.message}`);
  }
}
