import { spawnSync } from "node:child_process";

// node:sqlite still prints an ExperimentalWarning on some Node versions; it is
// noise for an end user, so drop that one warning and keep every other.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const text = typeof warning === "string" ? warning : warning?.message;
  if (text && text.includes("SQLite")) return;
  return emitWarning.call(process, warning, ...args);
};

let sqlite;
try {
  sqlite = await import("node:sqlite");
} catch (err) {
  // Node 22.5 to 22.12 only expose node:sqlite behind --experimental-sqlite:
  // relaunch the same script with the flag instead of asking the user for it.
  if (process.execArgv.includes("--experimental-sqlite")) throw err;
  const res = spawnSync(
    process.execPath,
    ["--experimental-sqlite", ...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit" }
  );
  process.exit(res.status ?? 1);
}

export const { DatabaseSync } = sqlite;
