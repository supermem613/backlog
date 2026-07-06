import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import {
  assertDeprivilegedJoinConfig,
  createBacklogJoinConfig,
  describeJoinPrivilege,
} from "../join-config.mjs";

const dependencies = {
  getActiveSessionId: () => "test-session",
  log: () => {},
  syncSidecarVisibility: () => {},
  ensureSession: () => {},
  getDb: () => ({
    prepare: () => ({
      all: () => [],
    }),
  }),
  getTopItem: () => null,
  getPendingCount: () => 0,
  addItem: () => ({ id: "item-1", position: 1 }),
  markDone: () => ({ description: "done item" }),
  removeItem: () => ({ description: "removed item" }),
  handleBacklogCommand: () => "ok",
};

const config = createBacklogJoinConfig(dependencies);
assertEqual(
  JSON.stringify(describeJoinPrivilege(config)),
  JSON.stringify({
    elevated: false,
    elevatedHandlers: [],
    hasHooks: false,
    skippedPermissionTools: [],
  }),
  "join config matches de-privileged baseline",
);
assertEqual(config.commands[0].name, "backlog", "backlog command is registered");
assertEqual(config.tools.length, 5, "agent tool count matches baseline");
assertEqual(config.tools.map((tool) => tool.name).join(","),
  "backlog_next,backlog_list,backlog_add,backlog_done,backlog_remove",
  "agent tool names match baseline");
assertDeprivilegedJoinConfig(config);

let threw = false;
try {
  assertDeprivilegedJoinConfig({
    ...config,
    onPermissionRequest: () => {},
  });
} catch (err) {
  threw = /de-privileged/.test(err.message) && /onPermissionRequest/.test(err.message);
}
assert(threw, "startup assertion rejects an elevated handler with a clear message");

threw = false;
try {
  assertDeprivilegedJoinConfig({
    ...config,
    tools: [{ name: "unsafe_tool", skipPermission: true }],
  });
} catch (err) {
  threw = /skipPermission tools: unsafe_tool/.test(err.message);
}
assert(threw, "startup assertion rejects per-tool skipPermission with a clear message");

done("test-join-config");
