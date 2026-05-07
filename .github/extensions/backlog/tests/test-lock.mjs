import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { wsAcceptKey, lockIsStale } from "../sidecar.mjs";

// wsAcceptKey: RFC 6455 example — secWsKey "dGhlIHNhbXBsZSBub25jZQ=="
// must produce accept "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=".
assertEqual(
  wsAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="),
  "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  "wsAcceptKey matches RFC 6455 example"
);

// lockIsStale: null lock is stale.
assert(lockIsStale(null), "null lock is stale");

// lockIsStale: dead pid is stale even with a fresh heartbeat.
const ancientPid = 99999;
assert(
  lockIsStale({ ownerPid: ancientPid, heartbeatAt: new Date().toISOString() }),
  "lock with dead pid is stale"
);

// lockIsStale: a fresh heartbeat from this process is *also* treated as
// stale (pidAlive treats process.pid as not-alive so we never refuse to
// promote ourselves on restart).
assert(
  lockIsStale({ ownerPid: process.pid, heartbeatAt: new Date().toISOString() }),
  "lock owned by self pid is stale"
);

done("test-lock");
