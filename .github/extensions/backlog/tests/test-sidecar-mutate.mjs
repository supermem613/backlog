import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { createQueue, db } from "../db.mjs";
import { addItem } from "../items.mjs";
import { buildSnapshot, handleHttp, sidecarState } from "../sidecar.mjs";

const queueId = "sidecar-mutate-queue";
createQueue({ id: queueId, name: "Sidecar Mutate" });
const { id } = addItem("delete me from sidecar", false, queueId);
const moveQueueId = "sidecar-move-queue";
createQueue({ id: moveQueueId, name: "Sidecar Move" });
const movable = addItem("move me from sidecar", false, moveQueueId);
const displaced = addItem("displace me from sidecar", false, moveQueueId);
sidecarState.role = "owner";
sidecarState.token = "test-token";
const events = [];
const ws = {
  write(chunk) {
    if (Buffer.isBuffer(chunk) && chunk[0] === 0x88) {
      events.push("viewer-close-frame");
      return;
    }
    if (Buffer.isBuffer(chunk) && chunk[0] === 0x81) {
      const len = chunk[1] & 0x7f;
      const off = len === 126 ? 4 : 2;
      const text = chunk.subarray(off).toString("utf8");
      events.push(text.includes('"type":"close"') ? "viewer-close-message" : "viewer-message");
      return;
    }
    events.push("viewer-message");
  },
  end() {},
};
sidecarState.wsClients.add(ws);

function makeReq(body) {
  const listeners = new Map();
  return {
    method: "POST",
    url: "/api/mutate",
    on(event, handler) {
      listeners.set(event, handler);
      if (event === "data") queueMicrotask(() => handler(Buffer.from(JSON.stringify(body))));
      if (event === "end") queueMicrotask(handler);
      return this;
    },
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: "",
    headers: null,
    done: null,
    listeners: new Map(),
    once(event, handler) {
      this.listeners.set(event, handler);
      return this;
    },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers || null;
    },
    end(chunk = "") {
      this.body += chunk;
      events.push("response");
      this.listeners.get("finish")?.();
      this.done?.();
    },
  };
}

async function postMutate(body) {
  const req = makeReq({ ...body, token: sidecarState.token });
  const res = makeRes();
  const completed = new Promise((resolve) => { res.done = resolve; });
  await handleHttp(req, res);
  await completed;
  return res;
}

assertEqual(buildSnapshot().sessions.length, 0, "snapshot starts without live peers");

const moveRes = await postMutate({ op: "move", id: displaced.id, target: 1, queueId: moveQueueId });
assertEqual(moveRes.statusCode, 200, "move mutation succeeds");
assertEqual(JSON.parse(moveRes.body).ok, true, "move returns ok");
assertEqual(db.prepare("SELECT position FROM items WHERE id = ?").get(displaced.id).position, 1, "move mutation updates position");
assertEqual(db.prepare("SELECT position FROM items WHERE id = ?").get(movable.id).position, 2, "move mutation shifts the displaced item");
db.prepare("DELETE FROM items WHERE queue_id = ?").run(moveQueueId);

const res = await postMutate({ op: "delete", id, queueId });
assertEqual(res.statusCode, 200, "delete mutation succeeds");
assertEqual(JSON.parse(res.body).ok, true, "delete returns ok");
assertEqual(db.prepare("SELECT COUNT(*) AS count FROM items WHERE id = ?").get(id).count, 0, "item is removed from db");
assertEqual(events.includes("viewer-close-message"), false, "viewer close is deferred until after response");

await new Promise((resolve) => setImmediate(resolve));
assertEqual(events.indexOf("response") < events.indexOf("viewer-close-message"), true, "viewer closes after mutation response");
sidecarState.wsClients.delete(ws);

done("test-sidecar-mutate");
