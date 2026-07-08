import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { createQueue, db } from "../db.mjs";
import { addItem } from "../items.mjs";
import { buildSnapshot, handleHttp, sidecarState } from "../sidecar.mjs";

const sid = "test-sidecar-offline";
const queueId = "sidecar-mutate-queue";
createQueue({ id: queueId, name: "Sidecar Mutate" });
const { id } = addItem(sid, "delete me from offline session", false, queueId);
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

assertEqual(buildSnapshot().sessions.find((s) => s.id === sid)?.live, false, "session starts as offline in snapshot");

const res = await postMutate({ op: "delete", sessionId: sid, id, queueId });
assertEqual(res.statusCode, 200, "offline delete mutation succeeds");
assertEqual(JSON.parse(res.body).ok, true, "offline delete returns ok");
assertEqual(db.prepare("SELECT COUNT(*) AS count FROM items WHERE id = ?").get(id).count, 0, "offline item is removed from db");
assert(!buildSnapshot().sessions.find((s) => s.id === sid), "empty offline session disappears from snapshot");
assertEqual(events.includes("viewer-close-message"), false, "viewer close is deferred until after response");

await new Promise((resolve) => setImmediate(resolve));
assertEqual(events.indexOf("response") < events.indexOf("viewer-close-message"), true, "viewer closes after mutation response");
sidecarState.wsClients.delete(ws);

done("test-sidecar-mutate");
