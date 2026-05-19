import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { db, getSetting } from "../db.mjs";
import { addFrictionItem, addItem, getLatestItemContext } from "../items.mjs";
import { handleBacklogCommand } from "../commands.mjs";

const sid = "test-friction-session";

addItem(sid, "manual top");
const first = addFrictionItem(sid, {
  key: "k-permission",
  category: "permission_denied",
  tool: "powershell",
  description: "Fix recurring permission denied in powershell",
  context: { primary_event: { error_message_redacted: "access is denied" } },
});

assert(first.created, "first friction occurrence creates an item");
assertEqual(first.item.source, "friction", "friction item has provenance source");
assertEqual(first.item.occurrence_count, 1, "first occurrence count is 1");

const repeated = addFrictionItem(sid, {
  key: "k-permission",
  category: "permission_denied",
  tool: "powershell",
  description: "Fix recurring permission denied in powershell",
  context: { primary_event: { error_message_redacted: "access is denied again" } },
});

assert(!repeated.created, "repeat occurrence dedupes into existing item");
assertEqual(repeated.item.id, first.item.id, "repeat keeps same backlog item");
assertEqual(repeated.item.occurrence_count, 2, "repeat increments occurrence count");

const latest = getLatestItemContext(first.item.id);
assertEqual(latest.primary_event.error_message_redacted, "access is denied again", "latest context is retained");

const rows = db.prepare(
  "SELECT description, source, position FROM items WHERE session_id = ? AND status = ? ORDER BY position"
).all(sid, "pending");
assertEqual(rows[0].description, "manual top", "manual item stays ahead of friction lane");
assertEqual(rows[1].source, "friction", "friction item stays in friction lane");

assertEqual(getSetting("friction_capture_enabled"), "1", "friction capture defaults on");
assertEqual(handleBacklogCommand(sid, "friction status"), "Friction capture is on.", "friction status reports on");
assertEqual(handleBacklogCommand(sid, "friction off"), "Friction capture is off. Existing friction items remain in the backlog.", "friction off works");
assertEqual(handleBacklogCommand(sid, "friction status"), "Friction capture is off.", "friction status reports off");
assertEqual(handleBacklogCommand(sid, "friction on"), "Friction capture is on. Tier-1 hard failures can auto-add backlog items.", "friction on works");

done("test-friction-items");
