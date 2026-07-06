import {
  appendEvent,
  db,
  rebuildProjectionsFromEvents,
  setFeatureGate,
  setItemGate,
  setItemWaiver,
  setLease,
  setLoopState,
  writeWithEvent,
} from "./db.mjs";

export class Store {
  constructor(database = db) {
    this.database = database;
  }

  appendEvent(event) {
    return appendEvent(event);
  }

  writeWithEvent(mutator, event) {
    return writeWithEvent(mutator, event);
  }

  setItemGate(input) {
    return setItemGate(input);
  }

  setFeatureGate(input) {
    return setFeatureGate(input);
  }

  setLoopState(input) {
    return setLoopState(input);
  }

  setLease(input) {
    return setLease(input);
  }

  setItemWaiver(input) {
    return setItemWaiver(input);
  }

  rebuildProjectionsFromEvents() {
    return rebuildProjectionsFromEvents();
  }

  getEventCount() {
    return this.database.prepare("SELECT COUNT(*) AS count FROM events").get().count;
  }
}

export function createStore(database = db) {
  return new Store(database);
}
