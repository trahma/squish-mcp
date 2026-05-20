import type { DB } from "./db.js";
import type { BusEvents } from "./events.js";

/** Everything a tool needs: the database and the event bus. */
export interface BusContext {
  db: DB;
  events: BusEvents;
}
