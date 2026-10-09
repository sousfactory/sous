import type { Event } from "../session/events.js";

/**
 * The run's append-only history. The executor appends as things happen;
 * `sous status` and steps that need earlier envelopes read it back whole.
 */
export type EventLog = {
  append(event: Event): Promise<void>;
  readAll(): Promise<Event[]>;
};
