import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import nunjucks from "nunjucks";

import { transaction, initDb, utcnow } from "./db.js";
import { boardEvents, sseFormat, ticketLogBroadcaster } from "./events.js";
import { pushTicket, runCommit } from "./git_ops.js";
import {
  EntryAuthor,
  EntryKind,
  TicketStatus,
  entriesFor,
  findProjectByPath,
  getProject,
  getTicket,
  insertEntry,
  insertProject,
  insertTicket,
  listProjects,
  listTickets,
  updateTicket,
} from "./models.js";
import { executeTicketResume } from "./runner.js";
import { recoverStaleTickets, startSchedulerLoop } from "./scheduler.js";
import { PyDateTime } from "./timefmt.js";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.KANBAN_PORT ?? "8787", 10);

// The templates are the Jinja ones from the Python version, nearly verbatim:
// Jinja compat gives them dict.get(), and the view objects below give them
// enum `.value` and datetime `.isoformat()` / `.strftime()`.
nunjucks.installJinjaCompat();
const templates = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(APP_DIR, "templates")), {
  autoescape: true,
});

const STATUS_LABELS = {
  [TicketStatus.a_faire]: "À faire",
  [TicketStatus.en_cours]: "En cours",
  [TicketStatus.standby]: "Stand by (question)",
  [TicketStatus.a_valider]: "À valider",
  [TicketStatus.a_committer]: "À committer",
  [TicketStatus.termine]: "Terminé",
};

const STATUS_ORDER = [
  TicketStatus.a_faire,
  TicketStatus.en_cours,
  TicketStatus.standby,
  TicketStatus.a_valider,
  TicketStatus.a_committer,
  TicketStatus.termine,
];

const ALLOWED_MANUAL_TRANSITIONS = new Set([
  `${TicketStatus.a_valider}>${TicketStatus.a_committer}`,
  `${TicketStatus.a_committer}>${TicketStatus.a_valider}`,
]);

/** A str-enum member as templates see it: `.value`, and usable as a dict key. */
class EnumValue {
  constructor(value) {
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

function ticketView(row) {
  return {
    ...row,
    status: new EnumValue(row.status),
    created_at: new PyDateTime(row.created_at),
    updated_at: new PyDateTime(row.updated_at),
  };
}

function entryView(row) {
  return {
    ...row,
    kind: new EnumValue(row.kind),
    author: new EnumValue(row.author),
    created_at: new PyDateTime(row.created_at),
  };
}

function render(reply, template, context) {
  reply.type("text/html; charset=utf-8");
  return templates.render(template, context);
}

class HttpError extends Error {
  constructor(statusCode, detail) {
    super(detail);
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

function requireTicket(ticketId) {
  const ticket = getTicket(ticketId);
  if (!ticket) throw new HttpError(404, "Ticket introuvable");
  return ticket;
}

/** Python's Path(p).expanduser().resolve(): expands ~, absolutizes, follows symlinks. */
function resolveProjectPath(projectPath) {
  let expanded = projectPath;
  if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  const absolute = path.resolve(expanded);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

const app = Fastify({ logger: false });

app.setErrorHandler((err, request, reply) => {
  if (err instanceof HttpError) {
    return reply.code(err.statusCode).send({ detail: err.detail });
  }
  if (err.validation) {
    // Same status as FastAPI for an invalid request body or path parameter.
    return reply.code(422).send({ detail: err.validation });
  }
  if (err.statusCode && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ detail: err.message });
  }
  console.error(err);
  return reply.code(500).send({ detail: "Internal Server Error" });
});

app.register(fastifyStatic, { root: path.join(APP_DIR, "static"), prefix: "/static/" });

const ticketIdParams = {
  type: "object",
  properties: { ticketId: { type: "integer" } },
  required: ["ticketId"],
};

function bodySchema(fields) {
  return {
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f, { type: "string" }])),
    required: fields,
  };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

app.get("/", async (request, reply) => render(reply, "board.html", {}));

app.get("/fragments/board", async (request, reply) => {
  const tickets = listTickets();
  const projectNames = Object.fromEntries(listProjects().map((p) => [p.id, p.name]));

  const ticketsByStatus = Object.fromEntries(STATUS_ORDER.map((status) => [status, []]));
  for (const ticket of tickets) ticketsByStatus[ticket.status]?.push(ticket);
  for (const status of STATUS_ORDER) {
    ticketsByStatus[status] = ticketsByStatus[status]
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
      .map(ticketView);
  }

  return render(reply, "board_fragment.html", {
    statuses: STATUS_ORDER.map((status) => new EnumValue(status)),
    status_labels: STATUS_LABELS,
    tickets_by_status: ticketsByStatus,
    project_names: projectNames,
  });
});

function ticketContext(ticketId) {
  const ticket = requireTicket(ticketId);
  return {
    ticket: ticketView(ticket),
    project: getProject(ticket.project_id),
    entries: entriesFor(ticketId).map(entryView),
    status_labels: STATUS_LABELS,
  };
}

app.get("/tickets/:ticketId", { schema: { params: ticketIdParams } }, async (request, reply) =>
  render(reply, "ticket_detail.html", ticketContext(request.params.ticketId))
);

app.get("/fragments/tickets/:ticketId", { schema: { params: ticketIdParams } }, async (request, reply) =>
  render(reply, "_ticket_fragment.html", ticketContext(request.params.ticketId))
);

// ---------------------------------------------------------------------------
// API — used by the kanban-ticket skill and the web UI
// ---------------------------------------------------------------------------

app.post(
  "/api/tickets",
  { schema: { body: bodySchema(["project_name", "project_path", "title", "plan"]) } },
  async (request) => {
    const body = request.body;
    const projectPath = resolveProjectPath(body.project_path);

    const { ticketId, projectId } = transaction(() => {
      const project = findProjectByPath(projectPath) ?? insertProject({ name: body.project_name, path: projectPath });
      const ticket = insertTicket({ project_id: project.id, title: body.title, status: TicketStatus.a_faire });
      insertEntry({ ticket_id: ticket.id, kind: EntryKind.plan_initial, author: EntryAuthor.user, content: body.plan });
      return { ticketId: ticket.id, projectId: project.id };
    });

    boardEvents.publish({ ticket_id: ticketId, project_id: projectId, status: TicketStatus.a_faire });
    return { ticket_id: ticketId, project_id: projectId };
  }
);

app.post(
  "/api/tickets/:ticketId/feedback",
  { schema: { params: ticketIdParams, body: bodySchema(["message"]) } },
  async (request) => {
    const { ticketId } = request.params;
    const ticket = transaction(() => {
      requireTicket(ticketId);
      insertEntry({ ticket_id: ticketId, kind: EntryKind.rejection, author: EntryAuthor.user, content: request.body.message });
      return updateTicket(ticketId, { status: TicketStatus.a_faire, updated_at: utcnow() });
    });

    boardEvents.publish({ ticket_id: ticketId, project_id: ticket.project_id, status: TicketStatus.a_faire });
    return { ok: true };
  }
);

app.post(
  "/api/tickets/:ticketId/answer",
  { schema: { params: ticketIdParams, body: bodySchema(["message"]) } },
  async (request) => {
    const { ticketId } = request.params;
    const ticket = transaction(() => {
      const current = requireTicket(ticketId);
      if (current.status !== TicketStatus.standby) throw new HttpError(409, "Ce ticket n'est pas en stand by");
      insertEntry({ ticket_id: ticketId, kind: EntryKind.answer, author: EntryAuthor.user, content: request.body.message });
      return updateTicket(ticketId, { status: TicketStatus.en_cours, updated_at: utcnow() });
    });

    executeTicketResume(ticketId, request.body.message).catch((err) => console.error(`ticket ${ticketId} failed`, err));
    boardEvents.publish({ ticket_id: ticketId, project_id: ticket.project_id, status: TicketStatus.en_cours });
    return { ok: true };
  }
);

app.patch(
  "/api/tickets/:ticketId/status",
  { schema: { params: ticketIdParams, body: bodySchema(["status"]) } },
  async (request) => {
    const { ticketId } = request.params;
    const newStatus = request.body.status;
    if (!Object.values(TicketStatus).includes(newStatus)) throw new HttpError(400, "Statut inconnu");

    const ticket = transaction(() => {
      const current = requireTicket(ticketId);
      if (!ALLOWED_MANUAL_TRANSITIONS.has(`${current.status}>${newStatus}`)) {
        throw new HttpError(409, "Transition non autorisée");
      }
      const fields = { status: newStatus, updated_at: utcnow() };
      if (newStatus === TicketStatus.a_committer) {
        fields.error_message = null;
        fields.commit_message = null;
      }
      return updateTicket(ticketId, fields);
    });

    if (newStatus === TicketStatus.a_committer) {
      runCommit(ticket.project_id, ticketId).catch((err) => console.error(`commit for ticket ${ticketId} failed`, err));
    }

    boardEvents.publish({ ticket_id: ticketId, project_id: ticket.project_id, status: newStatus });
    return { ok: true };
  }
);

app.post("/api/tickets/:ticketId/push", { schema: { params: ticketIdParams } }, async (request) => {
  const { ticketId } = request.params;
  const ticket = requireTicket(ticketId);
  if (ticket.status !== TicketStatus.a_committer) throw new HttpError(409, "Ce ticket n'est pas prêt à être poussé");

  const [ok, message] = await pushTicket(ticket.project_id, ticketId);
  return { ok, message };
});

/** Streams a broadcaster's events to the client as Server-Sent Events. */
function streamEvents(request, reply, broadcaster) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const unsubscribe = broadcaster.subscribe((data) => res.write(sseFormat(data)));
  // An SSE comment now and then lets a dead connection be noticed and dropped.
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  request.raw.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}

app.get("/api/tickets/:ticketId/stream", { schema: { params: ticketIdParams } }, (request, reply) =>
  streamEvents(request, reply, ticketLogBroadcaster(request.params.ticketId))
);

app.get("/api/events", (request, reply) => streamEvents(request, reply, boardEvents));

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

initDb();

try {
  // Bind the port before touching any ticket: a second instance must fail here,
  // not requeue the first one's running tickets and start duplicate agents.
  await app.listen({ host: HOST, port: PORT });
} catch (err) {
  if (err.code === "EADDRINUSE") {
    console.error(`Le port ${PORT} est déjà utilisé : le board tourne-t-il déjà ? (KANBAN_PORT pour en changer)`);
  } else {
    console.error(err);
  }
  process.exit(1);
}

recoverStaleTickets();
const stopScheduler = startSchedulerLoop();
console.log(`Claude Kanban : http://${HOST}:${PORT}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopScheduler();
    process.exit(0);
  });
}
