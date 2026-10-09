import type { EventLog } from "../../src/ports/eventlog.js";
import type { Event, EventType } from "../../src/session/events.js";

export type FakeEventLog = EventLog & {
  /** Every appended event, in order; tests read and may seed it. */
  readonly events: Event[];
  /** Event types in order, the compact view executor tests assert on. */
  types(): EventType[];
  of<T extends EventType>(type: T): Extract<Event, { type: T }>[];
};

export const fakeEventLog = (seed: readonly Event[] = []): FakeEventLog => {
  const events: Event[] = [...seed];
  return {
    events,
    async append(event) {
      events.push(event);
    },
    async readAll() {
      return [...events];
    },
    types: () => events.map((e) => e.type),
    of: <T extends EventType>(type: T) => events.filter((e): e is Extract<Event, { type: T }> => e.type === type),
  };
};
