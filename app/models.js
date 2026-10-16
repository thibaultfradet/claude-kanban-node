import { db, utcnow } from "./db.js";

export const TicketStatus = Object.freeze({
  a_faire: "a_faire",
  en_cours: "en_cours",
  standby: "standby",
  a_valider: "a_valider",
  a_committer: "a_committer",
  termine: "termine",
});

// Statuses that mean "this project's working directory is occupied" — no worktree
// isolation, so only one ticket per project may be anywhere in this range at a time.
export const OCCUPIED_STATUSES = [
  TicketStatus.en_cours,
  TicketStatus.standby,
  TicketStatus.a_valider,
  TicketStatus.a_committer,
];

export const EntryKind = Object.freeze({
  plan_initial: "plan_initial",
  execution_summary: "execution_summary",
  question: "question",
  answer: "answer",
  rejection: "rejection",
  commit_info: "commit_info",
  error: "error",
});

export const EntryAuthor = Object.freeze({
  user: "user",
  agent: "agent",
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function getProject(id) {
  return db.prepare("SELECT * FROM project WHERE id = ?").get(id);
}

export function listProjects() {
  return db.prepare("SELECT * FROM project").all();
}

export function findProjectByPath(projectPath) {
  return db.prepare("SELECT * FROM project WHERE path = ?").get(projectPath);
}

export function insertProject({ name, path }) {
  const res = db
    .prepare("INSERT INTO project (name, path, created_at) VALUES (?, ?, ?)")
    .run(name, path, utcnow());
  return getProject(Number(res.lastInsertRowid));
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export function getTicket(id) {
  return db.prepare("SELECT * FROM ticket WHERE id = ?").get(id);
}

export function listTickets() {
  return db.prepare("SELECT * FROM ticket").all();
}

export function ticketsWithStatus(status) {
  return db.prepare("SELECT * FROM ticket WHERE status = ?").all(status);
}

export function insertTicket({ project_id, title, status = TicketStatus.a_faire }) {
  const now = utcnow();
  const res = db
    .prepare(
      "INSERT INTO ticket (project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(project_id, title, status, now, now);
  return getTicket(Number(res.lastInsertRowid));
}

const TICKET_COLUMNS = new Set([
  "title",
  "status",
  "session_id",
  "head_sha_at_start",
  "commit_sha",
  "commit_message",
  "error_message",
  "updated_at",
]);

/** Updates the given columns and returns the fresh row. */
export function updateTicket(id, fields) {
  const keys = Object.keys(fields);
  for (const key of keys) {
    if (!TICKET_COLUMNS.has(key)) throw new Error(`Unknown ticket column: ${key}`);
  }
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    db.prepare(`UPDATE ticket SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
  }
  return getTicket(id);
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export function entriesFor(ticketId) {
  return db
    .prepare("SELECT * FROM ticketentry WHERE ticket_id = ? ORDER BY created_at, id")
    .all(ticketId);
}

export function insertEntry({ ticket_id, kind, author, content }) {
  db.prepare(
    "INSERT INTO ticketentry (ticket_id, kind, author, content, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(ticket_id, kind, author, content, utcnow());
}
