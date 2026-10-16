/** Simple in-memory pub/sub used to feed Server-Sent Events streams. */
export class Broadcaster {
  constructor() {
    this._subscribers = new Set();
  }

  subscribe(listener) {
    this._subscribers.add(listener);
    return () => this.unsubscribe(listener);
  }

  unsubscribe(listener) {
    this._subscribers.delete(listener);
  }

  publish(data) {
    for (const listener of [...this._subscribers]) {
      try {
        listener(data);
      } catch {
        // A broken client must not prevent the others from getting the event.
      }
    }
  }
}

// Board-level events: ticket created / status changed. Used to auto-refresh the board.
export const boardEvents = new Broadcaster();

// Per-ticket live log events, keyed by ticket_id. Used for the "logs live" viewer.
const ticketLogBroadcasters = new Map();

export function ticketLogBroadcaster(ticketId) {
  if (!ticketLogBroadcasters.has(ticketId)) {
    ticketLogBroadcasters.set(ticketId, new Broadcaster());
  }
  return ticketLogBroadcasters.get(ticketId);
}

export function sseFormat(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}
