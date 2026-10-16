// Per-ticket model/effort: allowed values and environment defaults. Shared by the
// Python version, so names and values must stay identical.
export const MODELS = ["opus", "sonnet", "haiku", "fable"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export const DEFAULT_MODEL = process.env.KANBAN_MODEL || "opus";
export const DEFAULT_EFFORT = process.env.KANBAN_EFFORT || "high";
export const COMMIT_MODEL = process.env.KANBAN_COMMIT_MODEL || "sonnet";
export const COMMIT_EFFORT = process.env.KANBAN_COMMIT_EFFORT || "low";

/** The model/effort a ticket really runs with: its own setting, else the env default. */
export function effectiveSettings(ticket) {
  return {
    effective_model: ticket.model ?? DEFAULT_MODEL,
    effective_effort: ticket.effort ?? DEFAULT_EFFORT,
  };
}
