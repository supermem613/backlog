import "./harness.mjs";
import { assertEqual, done } from "./harness.mjs";
import { createStore } from "../store.mjs";

const store = createStore();
const before = store.getEventCount();
store.appendEvent({
  actor: "test",
  scopeKind: "store",
  scopeId: "store-test",
  kind: "store_smoke",
  payload: { ok: true },
});
assertEqual(store.getEventCount(), before + 1, "Store appends and reads events through one interface");

done("test-store");
