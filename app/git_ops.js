import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BASE_DIR, transaction, utcnow } from "./db.js";
import { boardEvents } from "./events.js";
import { EntryAuthor, EntryKind, TicketStatus, getProject, getTicket, insertEntry, updateTicket } from "./models.js";
import { buildMessage, notify } from "./notify.js";
import { COMMIT_EFFORT, COMMIT_MODEL } from "./config.js";
import { gitHeadSha, runClaudeHeadless } from "./runner.js";

const COMMIT_SKILL_PATH = path.join(os.homedir(), ".claude", "commands", "commit.md");
const BUNDLED_COMMIT_SKILL_PATH = path.join(BASE_DIR, "claude-commands", "commit.md");

function resolveCommitSkillPath() {
  return fs.existsSync(COMMIT_SKILL_PATH) ? COMMIT_SKILL_PATH : BUNDLED_COMMIT_SKILL_PATH;
}

const HEADLESS_OVERRIDE_NOTE = `

---

Note pour ce run headless (pas de terminal interactif) : aucune validation humaine
n'est possible ici. Choisis toi-même le découpage en lots le plus cohérent (Étape 2)
et exécute directement les étapes 3 et 4 sans attendre de confirmation. Toutes les
autres règles ci-dessus restent inchangées (pas de push, pas de co-authored, format
des messages, etc.).
`;

/** Runs git and resolves with { returncode, stdout, stderr }; never rejects. */
function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      let returncode = 0;
      if (err) returncode = typeof err.code === "number" ? err.code : 1;
      resolve({ returncode, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err && typeof err.code !== "number" ? err.message : "") });
    });
  });
}

export async function runCommit(projectId, ticketId) {
  const project = getProject(projectId);
  const startTicket = getTicket(ticketId);
  const projectPath = project.path;
  const projectName = project.name;
  const headBefore = startTicket.head_sha_at_start || gitHeadSha(projectPath);

  let run;
  try {
    const commitSkillText = fs.readFileSync(resolveCommitSkillPath(), "utf8");
    const prompt = commitSkillText + HEADLESS_OVERRIDE_NOTE;

    run = await runClaudeHeadless({
      ticketId,
      cwd: projectPath,
      prompt,
      sessionFlag: ["--session-id", randomUUID()],
      model: COMMIT_MODEL,
      effort: COMMIT_EFFORT,
      disallowedTools: "AskUserQuestion,EnterPlanMode,ExitPlanMode",
      logSubdir: "commit",
    });
  } catch (err) {
    const { ticket, notif } = transaction(() => {
      const errorMessage = `Échec du lancement du commit automatique : ${err?.message ?? err}`;
      const ticket = updateTicket(ticketId, { error_message: errorMessage, updated_at: utcnow() });
      insertEntry({ ticket_id: ticketId, kind: EntryKind.error, author: EntryAuthor.agent, content: errorMessage });
      return { ticket, notif: buildMessage("error", projectName, ticketId, ticket.title, "échec du commit") };
    });
    notify("error", ...notif);
    boardEvents.publish({ ticket_id: ticketId, project_id: ticket.project_id, status: ticket.status });
    return;
  }

  const headAfter = gitHeadSha(projectPath);
  let commitLog = null;
  if (!(run.timed_out || run.is_error) && headBefore && headAfter && headBefore !== headAfter) {
    commitLog = await runGit(["log", "--oneline", `${headBefore}..${headAfter}`], projectPath);
  }

  let notif = null;
  const ticket = transaction(() => {
    const current = getTicket(ticketId);

    if (run.timed_out || run.is_error) {
      const reason = run.timed_out ? "timeout" : "erreur";
      notif = buildMessage("error", projectName, ticketId, current.title, `commit : ${reason}`);
      const errorMessage =
        "Le run de commit automatique a échoué ou dépassé le délai. " +
        "Vérifie l'état du dépôt manuellement puis réessaie.";
      insertEntry({
        ticket_id: ticketId,
        kind: EntryKind.error,
        author: EntryAuthor.agent,
        content: errorMessage + `\n\nDernière sortie :\n\n${run.final_text || "(aucune)"}`,
      });
      return updateTicket(ticketId, { error_message: errorMessage, updated_at: utcnow() });
    }

    let commitMessage;
    if (commitLog) {
      commitMessage = commitLog.stdout.trim() || "(historique indisponible)";
    } else {
      commitMessage =
        "Aucun nouveau commit à ce stade (déjà tout committé pendant " + "l'exécution du ticket).";
    }
    insertEntry({ ticket_id: ticketId, kind: EntryKind.commit_info, author: EntryAuthor.agent, content: commitMessage });
    return updateTicket(ticketId, {
      error_message: null,
      commit_sha: headAfter,
      commit_message: commitMessage,
      updated_at: utcnow(),
    });
  });

  if (notif) notify("error", ...notif);
  boardEvents.publish({ ticket_id: ticketId, project_id: ticket.project_id, status: ticket.status });
}

/** Pushes the project's current branch; resolves with [ok, message]. */
export async function pushTicket(projectId, ticketId) {
  const project = getProject(projectId);
  const startTicket = getTicket(ticketId);
  const projectPath = project.path;
  const notif = buildMessage("error", project.name, ticketId, startTicket.title, "échec du push");

  const branchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], projectPath);
  const branchName = branchRes.stdout.trim();
  if (branchRes.returncode !== 0 || !branchName) {
    notify("error", ...notif);
    return [false, "Impossible de déterminer la branche git courante."];
  }

  const hasUpstream = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], projectPath);
  const pushRes =
    hasUpstream.returncode === 0
      ? await runGit(["push"], projectPath)
      : await runGit(["push", "-u", "origin", branchName], projectPath);

  if (pushRes.returncode !== 0) {
    notify("error", ...notif);
    return [false, pushRes.stderr.trim() || "Échec du push (raison inconnue)."];
  }

  const ticket = transaction(() => {
    insertEntry({
      ticket_id: ticketId,
      kind: EntryKind.commit_info,
      author: EntryAuthor.user,
      content: `Poussé sur \`${branchName}\`.`,
    });
    return updateTicket(ticketId, { status: TicketStatus.termine, updated_at: utcnow() });
  });

  boardEvents.publish({ ticket_id: ticketId, project_id: ticket.project_id, status: TicketStatus.termine });
  return [true, `Poussé sur ${branchName}.`];
}

// ---------------------------------------------------------------------------
// Changes view — read-only: never touches the index, the stash or the worktree.
// ---------------------------------------------------------------------------

const CHANGES_GIT_TIMEOUT_MS = 15_000;
const MAX_FILE_BYTES = 1024 * 1024;
export const WORKTREE = "WORKTREE";

export class GitError extends Error {}

/**
 * Runs a read-only git command and resolves with its stdout as a Buffer.
 * Rejects with a GitError on failure or timeout. With `limit`, stops reading
 * once stdout exceeds that many bytes and resolves with null instead.
 */
function gitOutput(args, cwd, { limit } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn("git", args, { cwd, windowsHide: true });
    } catch (err) {
      reject(new GitError(`git ${args[0]} : ${err.message}`));
      return;
    }
    const chunks = [];
    const errChunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      proc.kill();
      finish(reject, new GitError(`git ${args[0]} : délai de ${CHANGES_GIT_TIMEOUT_MS / 1000} s dépassé`));
    }, CHANGES_GIT_TIMEOUT_MS);

    proc.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (limit != null && size > limit) {
        proc.kill();
        finish(resolve, null);
        return;
      }
      chunks.push(chunk);
    });
    proc.stderr.on("data", (chunk) => errChunks.push(chunk));
    proc.on("error", (err) => finish(reject, new GitError(`git ${args[0]} : ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        finish(resolve, Buffer.concat(chunks));
      } else {
        const stderr = Buffer.concat(errChunks).toString("utf8").trim();
        finish(reject, new GitError(stderr || `git ${args[0]} a échoué (code ${code})`));
      }
    });
  });
}

async function gitText(args, cwd) {
  return (await gitOutput(args, cwd)).toString("utf8");
}

/** Splits `-z` output into its NUL-separated fields, dropping the trailing empty one. */
function splitNul(text) {
  const parts = text.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

function normalizeStatus(letter) {
  return ["A", "M", "D", "R"].includes(letter) ? letter : "M";
}

function looksBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function countLines(buf) {
  if (buf.length === 0) return 0;
  let lines = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) lines++;
  return buf[buf.length - 1] === 10 ? lines : lines + 1;
}

/** Parses `git diff --name-status -z -M` output into { path, old_path, status }. */
function parseNameStatus(text) {
  const parts = splitNul(text);
  const files = [];
  for (let i = 0; i < parts.length; ) {
    const status = normalizeStatus(parts[i][0]);
    if (parts[i][0] === "R" || parts[i][0] === "C") {
      files.push({ path: parts[i + 2], old_path: parts[i + 1], status });
      i += 3;
    } else {
      files.push({ path: parts[i + 1], old_path: null, status });
      i += 2;
    }
  }
  return files;
}

/** Parses `git diff --numstat -z -M` output into a map path -> { additions, deletions, binary }. */
function parseNumstat(text) {
  const parts = splitNul(text);
  const stats = new Map();
  for (let i = 0; i < parts.length; ) {
    const [added, deleted, inlinePath] = parts[i].split("\t");
    let filePath = inlinePath;
    i += 1;
    if (inlinePath === "") {
      // Rename: the old and new paths follow as separate fields.
      filePath = parts[i + 1];
      i += 2;
    }
    const binary = added === "-" || deleted === "-";
    stats.set(filePath, {
      additions: binary ? 0 : Number.parseInt(added, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
      binary,
    });
  }
  return stats;
}

/**
 * What a ticket changed since it started: { base, target, live, root, files }.
 * Each file carries an internal `binary` flag on top of the public fields.
 */
export async function ticketChanges(ticket, projectPath) {
  const base = ticket.head_sha_at_start || null;
  const isDone = ticket.status === TicketStatus.termine;
  const live = ticket.status === TicketStatus.en_cours;
  if (!base) {
    return { base: null, target: isDone ? ticket.commit_sha || null : WORKTREE, live, root: null, files: [] };
  }

  // Run from the repository root so every path is root-relative, even when the
  // project lives in a sub-directory of the repository.
  const root = (await gitText(["rev-parse", "--show-toplevel"], projectPath)).trim();
  const target = isDone ? ticket.commit_sha || (await gitText(["rev-parse", "HEAD"], root)).trim() : WORKTREE;
  const range = isDone ? [base, target] : [base];

  const [nameStatus, numstat, untracked] = await Promise.all([
    gitText(["diff", "--name-status", "-z", "-M", ...range, "--"], root),
    gitText(["diff", "--numstat", "-z", "-M", ...range, "--"], root),
    isDone ? Promise.resolve("") : gitText(["ls-files", "--others", "--exclude-standard", "-z"], root),
  ]);

  const stats = parseNumstat(numstat);
  const files = parseNameStatus(nameStatus).map((f) => ({
    ...f,
    ...(stats.get(f.path) ?? { additions: 0, deletions: 0, binary: false }),
  }));

  const known = new Set(files.map((f) => f.path));
  for (const filePath of splitNul(untracked)) {
    if (known.has(filePath)) continue;
    let additions = 0;
    let binary = false;
    try {
      const buf = fs.readFileSync(path.join(root, filePath));
      binary = looksBinary(buf);
      if (!binary) additions = countLines(buf);
    } catch {
      // Vanished between the listing and the read: still list it, with no count.
    }
    files.push({ path: filePath, old_path: null, status: "A", additions, deletions: 0, binary });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { base, target, live, root, files };
}

/** Reads a file from the working tree, or null if it is larger than the limit. */
function readWorktreeFile(filePath) {
  try {
    if (fs.statSync(filePath).size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(filePath);
  } catch {
    return Buffer.alloc(0);
  }
}

/** Both sides of one changed file: { original, modified, binary, too_large }. */
export async function fileContents(changes, file) {
  const result = { original: "", modified: "", binary: false, too_large: false };
  if (file.binary) return { ...result, binary: true };

  const { base, target, root } = changes;
  const original =
    file.status === "A" ? Buffer.alloc(0) : await gitOutput(["show", `${base}:${file.old_path ?? file.path}`], root, { limit: MAX_FILE_BYTES });
  let modified = Buffer.alloc(0);
  if (file.status !== "D") {
    modified =
      target === WORKTREE
        ? readWorktreeFile(path.join(root, file.path))
        : await gitOutput(["show", `${target}:${file.path}`], root, { limit: MAX_FILE_BYTES });
  }

  if (original === null || modified === null) return { ...result, too_large: true };
  if (looksBinary(original) || looksBinary(modified)) return { ...result, binary: true };
  return { ...result, original: original.toString("utf8"), modified: modified.toString("utf8") };
}
