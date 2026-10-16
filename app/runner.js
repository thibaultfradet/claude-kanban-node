import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { resolveClaudeCommand } from "./claude_bin.js";
import { LOGS_DIR, transaction, utcnow } from "./db.js";
import { boardEvents, ticketLogBroadcaster } from "./events.js";
import {
  EntryAuthor,
  EntryKind,
  TicketStatus,
  entriesFor,
  getProject,
  getTicket,
  insertEntry,
  updateTicket,
} from "./models.js";
import { buildMessage, notify } from "./notify.js";
import { isoformat } from "./timefmt.js";

// Opus is the CLI default and noticeably more expensive for routine tickets; sonnet
// is a saner default for unattended runs. Override with KANBAN_MODEL if needed.
const MODEL = process.env.KANBAN_MODEL ?? "sonnet";
export const DEFAULT_TIMEOUT_SECONDS = Number.parseInt(process.env.KANBAN_TICKET_TIMEOUT ?? "1800", 10);

// These tools assume a human is present to answer; none is, in a headless run.
export const DISALLOWED_TOOLS = "AskUserQuestion,EnterPlanMode,ExitPlanMode";

export const KANBAN_SYSTEM_PROMPT = `\
Tu exécutes un ticket de façon totalement autonome, en mode headless (--print). \
Personne ne répondra pendant ce run : n'utilise jamais AskUserQuestion, \
EnterPlanMode ou ExitPlanMode (ces outils sont désactivés pour cette session). \
Si tu as besoin d'une clarification pour continuer, arrête-toi simplement en \
terminant ta réponse par le bloc structuré décrit plus bas avec status="question".

Ce run est strictement single-shot : il n'y a AUCUN tour suivant. N'utilise jamais \
une commande en arrière-plan (run_in_background, \`&\`, nohup, un outil Monitor...) en \
comptant "attendre la notification" avant de continuer — cette notification \
n'arrivera jamais, ta réponse finale serait alors illisible et le ticket resterait \
bloqué. Si tu dois attendre qu'un process se termine (ex: tester un serveur), fais-le \
de façon synchrone (commande au premier plan avec timeout, ou boucle de polling qui \
se termine avant ta réponse finale), jamais en arrière-plan.

Règles de travail :
- Travaille sur la branche git courante du dépôt. Ne crée jamais de nouvelle branche.
- Commit fréquemment, par petites étapes logiques, au fur et à mesure de ton \
avancement. N'attends jamais la fin pour tout committer d'un coup. Ne pas hésiter \
à committer même par lots.
- Format des messages de commit, strictement : "<type>: <message concis en \
anglais>" avec type parmi feat, fix, chore, style. Une ligne, minuscules après le \
type, pas de point final. Jamais de mention de Claude/AI/outil, jamais de \
Co-authored-by.
- Ne fais jamais de \`git push\`.

Termine TOUJOURS ta dernière réponse par exactement ce bloc (rien après) :

<<<KANBAN_STATUS>>>
{"status": "done", "message": "résumé de ce qui a été fait"}
<<<END_KANBAN_STATUS>>>

ou, si tu es bloqué et as besoin d'une clarification humaine avant de continuer :

<<<KANBAN_STATUS>>>
{"status": "question", "message": "ta question précise"}
<<<END_KANBAN_STATUS>>>
`;

const STATUS_RE = /<<<KANBAN_STATUS>>>\s*(\{[\s\S]*?\})\s*<<<END_KANBAN_STATUS>>>/;

const ENTRY_HEADERS = {
  [EntryKind.plan_initial]: "Plan initial",
  [EntryKind.execution_summary]: "Résumé d'exécution précédent",
  [EntryKind.question]: "Question posée par l'agent",
  [EntryKind.answer]: "Réponse de l'utilisateur",
  [EntryKind.rejection]: "Retour humain après test (rejet)",
  [EntryKind.commit_info]: "Info de commit",
  [EntryKind.error]: "Erreur",
};

export function buildTicketPrompt(entries) {
  return entries
    .map((entry) => {
      const header = ENTRY_HEADERS[entry.kind] ?? entry.kind;
      return `## ${header} (${isoformat(entry.created_at)})\n\n${entry.content}`;
    })
    .join("\n\n---\n\n");
}

export function parseKanbanStatus(finalText) {
  if (!finalText) return null;
  const match = STATUS_RE.exec(finalText);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function gitHeadSha(projectPath) {
  try {
    const out = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: projectPath,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (out.status === 0) return out.stdout.trim();
  } catch {
    // fall through
  }
  return null;
}

function killTree(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === "win32" && proc.pid) {
    // proc.kill() only ends the direct child on Windows; take its tools down too.
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    proc.kill("SIGKILL");
  }
}

/**
 * Runs `claude -p` headless in stream-json mode, mirroring every output line to
 * data/logs/<ticket>/<subdir>-<run>.jsonl and to the ticket's live log stream.
 * Resolves with { session_id, final_text, is_error, total_cost_usd, timed_out,
 * exit_code }; rejects when Claude could not be launched at all.
 */
export async function runClaudeHeadless({
  ticketId,
  cwd,
  prompt,
  sessionFlag,
  appendSystemPrompt = null,
  disallowedTools = null,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  logSubdir = "run",
}) {
  const runId = randomUUID().replaceAll("-", "").slice(0, 8);
  const logDir = path.join(LOGS_DIR, String(ticketId));
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${logSubdir}-${runId}.jsonl`);

  // The prompt goes through stdin rather than as an argument: Windows caps a
  // command line at 32K characters, which a long ticket history can exceed. It
  // also keeps it clear of variadic flags such as --disallowedTools, which would
  // otherwise swallow a trailing positional prompt.
  const args = [
    "-p",
    ...sessionFlag,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
  ];
  if (MODEL) args.push("--model", MODEL);
  if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);
  if (disallowedTools) args.push("--disallowedTools", disallowedTools);

  const broadcaster = ticketLogBroadcaster(ticketId);
  const { command, prefixArgs } = resolveClaudeCommand();

  const proc = spawn(command, [...prefixArgs, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  // Launch failures (missing binary, missing cwd) surface as an 'error' event
  // before 'spawn'; reject so the caller records a launch failure.
  await new Promise((resolve, reject) => {
    proc.once("spawn", resolve);
    proc.once("error", reject);
  });

  // Late errors (e.g. a failed kill) must not crash the server.
  proc.on("error", () => {});
  proc.stdin.on("error", () => {});
  proc.stdin.end(prompt, "utf8");

  const state = { session_id: null, final_text: null, is_error: false, total_cost_usd: null };
  const logFd = fs.openSync(logPath, "a");

  const readStdout = (async () => {
    // readline has no line-length cap, unlike Python's StreamReader: a huge
    // stream-json line (e.g. a long tool result) cannot abort the run.
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    for await (const text of rl) {
      if (!text) continue;
      fs.writeSync(logFd, text + "\n");
      broadcaster.publish({ type: "log", line: text });
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        continue;
      }
      if (event?.type === "system" && event.subtype === "init") {
        state.session_id = event.session_id || state.session_id;
      } else if (event?.type === "result") {
        state.session_id = event.session_id || state.session_id;
        state.final_text = event.result ?? null;
        state.is_error = Boolean(event.is_error);
        state.total_cost_usd = event.total_cost_usd ?? null;
      }
    }
  })();

  const readStderr = (async () => {
    const rl = readline.createInterface({ input: proc.stderr, crlfDelay: Infinity });
    for await (const text of rl) {
      fs.writeSync(logFd, "[stderr] " + text + "\n");
      broadcaster.publish({ type: "stderr", line: text });
    }
  })();

  const exited = new Promise((resolve) => proc.once("exit", (code) => resolve(code)));

  let timedOut = false;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutSeconds * 1000);
  });

  try {
    await Promise.race([Promise.all([readStdout, readStderr, exited]), timeout]);
    if (timedOut) {
      killTree(proc);
      await exited;
      // A grandchild may still hold the pipes open; stop reading them.
      readStdout.catch(() => {});
      readStderr.catch(() => {});
      proc.stdout.destroy();
      proc.stderr.destroy();
    }
  } catch (err) {
    // A failure while reading the streams must not leave the child `claude`
    // process running untracked: nothing would ever reap it otherwise.
    killTree(proc);
    throw err;
  } finally {
    clearTimeout(timer);
    fs.closeSync(logFd);
  }

  return {
    session_id: state.session_id,
    final_text: state.final_text,
    is_error: state.is_error,
    total_cost_usd: state.total_cost_usd,
    timed_out: timedOut,
    exit_code: proc.exitCode,
  };
}

/**
 * Claude never even got to run (e.g. the project directory doesn't exist).
 *
 * Unlike a normal error/timeout from applyResult, no session was created, so
 * resuming with --resume would fail again. Send the ticket back to a_faire so
 * the scheduler retries it from scratch once the underlying issue is fixed.
 */
export function recordLaunchFailure(ticketId, err) {
  const result = transaction(() => {
    const current = getTicket(ticketId);
    if (!current) return null;
    const errorMessage = `Échec du lancement de Claude : ${err?.message ?? err}`;
    const ticket = updateTicket(ticketId, {
      status: TicketStatus.a_faire,
      session_id: null,
      error_message: errorMessage,
      updated_at: utcnow(),
    });
    insertEntry({ ticket_id: ticketId, kind: EntryKind.error, author: EntryAuthor.agent, content: errorMessage });
    const notif = buildMessage("error", getProject(ticket.project_id).name, ticketId, ticket.title, "échec du lancement");
    return { ticket, notif };
  });
  if (!result) return;

  notify("error", ...result.notif);
  boardEvents.publish({ ticket_id: ticketId, project_id: result.ticket.project_id, status: result.ticket.status });
}

export function applyResult(ticketId, run) {
  const result = transaction(() => {
    const current = getTicket(ticketId);
    if (!current) return null;

    const fields = { updated_at: null };
    if (run.session_id) fields.session_id = run.session_id;

    const status = run.timed_out || run.is_error ? null : parseKanbanStatus(run.final_text);
    let notifEvent = "error";
    let notifReason = "";

    if (status === null) {
      fields.status = TicketStatus.standby;
      const reason = run.timed_out ? "timeout" : run.is_error ? "erreur" : "réponse illisible";
      notifReason = reason;
      const detail = run.final_text || "(aucune sortie finale)";
      insertEntry({
        ticket_id: ticketId,
        kind: EntryKind.error,
        author: EntryAuthor.agent,
        content: `Le run s'est arrêté sans statut exploitable (${reason}). Dernière sortie :\n\n${detail}`,
      });
    } else if (status?.status === "question") {
      notifEvent = "standby";
      fields.status = TicketStatus.standby;
      insertEntry({
        ticket_id: ticketId,
        kind: EntryKind.question,
        author: EntryAuthor.agent,
        content: String(status.message ?? ""),
      });
    } else if (status?.status === "done") {
      notifEvent = "a_valider";
      fields.status = TicketStatus.a_valider;
      insertEntry({
        ticket_id: ticketId,
        kind: EntryKind.execution_summary,
        author: EntryAuthor.agent,
        content: String(status.message ?? ""),
      });
    } else {
      notifReason = "statut inattendu";
      fields.status = TicketStatus.standby;
      insertEntry({
        ticket_id: ticketId,
        kind: EntryKind.error,
        author: EntryAuthor.agent,
        content: `Statut inattendu renvoyé par l'agent : ${JSON.stringify(status)}`,
      });
    }

    fields.updated_at = utcnow();
    const ticket = updateTicket(ticketId, fields);
    const notif = buildMessage(notifEvent, getProject(ticket.project_id).name, ticketId, ticket.title, notifReason);
    return { ticket, notif, notifEvent };
  });
  if (!result) return;

  notify(result.notifEvent, ...result.notif);
  boardEvents.publish({ ticket_id: ticketId, project_id: result.ticket.project_id, status: result.ticket.status });
}

export async function executeTicketStart(projectId, ticketId) {
  const { prompt, newSessionId, projectPath } = transaction(() => {
    const project = getProject(projectId);
    const ticket = getTicket(ticketId);
    const prompt = buildTicketPrompt(entriesFor(ticketId));
    const newSessionId = randomUUID();
    const fields = { session_id: newSessionId };
    if (!ticket.head_sha_at_start) fields.head_sha_at_start = gitHeadSha(project.path);
    updateTicket(ticketId, fields);
    return { prompt, newSessionId, projectPath: project.path };
  });

  let run;
  try {
    run = await runClaudeHeadless({
      ticketId,
      cwd: projectPath,
      prompt,
      sessionFlag: ["--session-id", newSessionId],
      appendSystemPrompt: KANBAN_SYSTEM_PROMPT,
      disallowedTools: DISALLOWED_TOOLS,
      logSubdir: "start",
    });
  } catch (err) {
    recordLaunchFailure(ticketId, err);
    return;
  }
  applyResult(ticketId, run);
}

export async function executeTicketResume(ticketId, answerText) {
  const ticket = getTicket(ticketId);
  const project = getProject(ticket.project_id);

  let run;
  try {
    run = await runClaudeHeadless({
      ticketId,
      cwd: project.path,
      prompt: answerText,
      sessionFlag: ["--resume", ticket.session_id],
      appendSystemPrompt: KANBAN_SYSTEM_PROMPT,
      disallowedTools: DISALLOWED_TOOLS,
      logSubdir: "resume",
    });
  } catch (err) {
    recordLaunchFailure(ticketId, err);
    return;
  }
  applyResult(ticketId, run);
}
