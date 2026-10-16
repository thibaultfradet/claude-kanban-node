import { db, transaction, utcnow } from "./db.js";
import { boardEvents } from "./events.js";
import {
  EntryAuthor,
  EntryKind,
  OCCUPIED_STATUSES,
  TicketStatus,
  insertEntry,
  listProjects,
  ticketsWithStatus,
  updateTicket,
} from "./models.js";
import { executeTicketStart } from "./runner.js";

const POLL_INTERVAL_SECONDS = Number.parseInt(process.env.KANBAN_POLL_INTERVAL ?? "20", 10);

/**
 * Requeue tickets left in en_cours from a previous process.
 *
 * en_cours means "a claude subprocess is running for this ticket right now" —
 * but that subprocess was a child of the previous server process, so it died
 * with it. Left as-is these tickets block their project's queue forever since
 * the scheduler treats en_cours as occupied and never retries it on its own.
 */
export function recoverStaleTickets() {
  transaction(() => {
    for (const ticket of ticketsWithStatus(TicketStatus.en_cours)) {
      updateTicket(ticket.id, { status: TicketStatus.a_faire, session_id: null, updated_at: utcnow() });
      insertEntry({
        ticket_id: ticket.id,
        kind: EntryKind.error,
        author: EntryAuthor.agent,
        content:
          "Ticket remis en file d'attente après redémarrage du serveur " +
          "(l'exécution précédente a été interrompue).",
      });
    }
  });
}

export function startSchedulerLoop() {
  let timer = null;
  let stopped = false;
  const loop = () => {
    try {
      tick();
    } catch (err) {
      // Keep the loop alive no matter what.
      console.error("scheduler tick failed", err);
    }
    if (!stopped) timer = setTimeout(loop, POLL_INTERVAL_SECONDS * 1000);
  };
  loop();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

const occupiedPlaceholders = OCCUPIED_STATUSES.map(() => "?").join(", ");

export function tick() {
  const toLaunch = transaction(() => {
    const launches = [];
    for (const project of listProjects()) {
      const occupied = db
        .prepare(`SELECT id FROM ticket WHERE project_id = ? AND status IN (${occupiedPlaceholders}) LIMIT 1`)
        .get(project.id, ...OCCUPIED_STATUSES);
      if (occupied) continue;

      const next = db
        .prepare("SELECT id FROM ticket WHERE project_id = ? AND status = ? ORDER BY created_at LIMIT 1")
        .get(project.id, TicketStatus.a_faire);
      if (!next) continue;

      updateTicket(next.id, { status: TicketStatus.en_cours, updated_at: utcnow() });
      launches.push([project.id, next.id]);
    }
    return launches;
  });

  for (const [projectId, ticketId] of toLaunch) {
    executeTicketStart(projectId, ticketId).catch((err) => console.error(`ticket ${ticketId} failed`, err));
    boardEvents.publish({ ticket_id: ticketId, project_id: projectId, status: TicketStatus.en_cours });
  }
}
