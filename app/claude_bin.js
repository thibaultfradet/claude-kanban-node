import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function searchDirs() {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  // Fallbacks for a shell whose PATH predates the Claude Code install: the native
  // installer uses ~/.local/bin, `npm install -g` uses %APPDATA%\npm on Windows.
  dirs.push(path.join(os.homedir(), ".local", "bin"));
  if (IS_WINDOWS && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
  return dirs;
}

/** Finds `claude` on the PATH; on Windows prefers claude.exe over the npm claude.cmd shim. */
function findOnPath(name) {
  const names = IS_WINDOWS ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  for (const candidateName of names) {
    for (const dir of searchDirs()) {
      const candidate = path.join(dir, candidateName);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * npm installs Windows commands as .cmd shims. Node refuses to spawn those
 * without a shell, and going through cmd.exe would mangle multi-line arguments
 * such as the system prompt. Read the shim to find what it actually runs.
 */
function unwrapCmdShim(shimPath) {
  const text = fs.readFileSync(shimPath, "utf8");
  // The last quoted %dp0% path is the program; npm shims first test for a
  // bundled node.exe, which must not be mistaken for it.
  const matches = [...text.matchAll(/"%~?dp0%?\\([^"]+?\.(?:js|cjs|mjs|exe))"/gi)];
  const match = matches.at(-1);
  if (!match) {
    throw new Error(
      `Impossible de lancer ${shimPath} sans shell. ` +
        "Définis KANBAN_CLAUDE_BIN vers claude.exe ou vers le cli.js de Claude Code."
    );
  }
  return targetCommand(path.join(path.dirname(shimPath), match[1]));
}

function targetCommand(target) {
  if (/\.(?:js|cjs|mjs)$/i.test(target)) return { command: process.execPath, prefixArgs: [target] };
  if (IS_WINDOWS && /\.(?:cmd|bat)$/i.test(target)) return unwrapCmdShim(target);
  return { command: target, prefixArgs: [] };
}

/**
 * Resolves how to spawn Claude Code: KANBAN_CLAUDE_BIN if set, else `claude`
 * from the PATH. Returns { command, prefixArgs } for child_process.spawn. When
 * nothing is found, returns plain "claude" so the spawn fails with ENOENT and
 * the ticket records a launch failure.
 */
export function resolveClaudeCommand() {
  const configured = process.env.KANBAN_CLAUDE_BIN;
  if (configured) {
    const looksLikePath = configured.includes("/") || configured.includes("\\");
    const target = looksLikePath ? configured : findOnPath(configured) ?? configured;
    return targetCommand(target);
  }
  const found = findOnPath("claude");
  return found ? targetCommand(found) : { command: "claude", prefixArgs: [] };
}
