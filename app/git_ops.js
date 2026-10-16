import { execFile } from "node:child_process";
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
