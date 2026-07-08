import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { createQueue, listQueues } from "../db.mjs";
import { bindQueueScope, resolveQueueForCwd } from "../queue-resolver.mjs";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return dir;
}

const tempDirs = [];
function trackTempDir(dir) {
  tempDirs.push(dir);
  return dir;
}

function makeTrackedTempDir(prefix) {
  return trackTempDir(makeTempDir(prefix));
}

process.on("exit", () => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

const exactScope = makeTrackedTempDir("queue-resolver-exact");
const exactQueue = createQueue({ id: "queue-exact", name: "Exact" });
bindQueueScope(exactQueue, exactScope, { preferred: true });
const exactResult = resolveQueueForCwd(exactScope, { queues: [exactQueue] });
assertEqual(exactResult.state, "resolved", "exact cwd resolves");
assertEqual(exactResult.matchedBy, "exact", "exact cwd uses exact match");
assertEqual(exactResult.queueId, exactQueue.id, "exact cwd resolves the exact queue");

const originScope = makeTrackedTempDir("queue-resolver-origin");
const originQueue = createQueue({ id: "queue-origin", name: "Origin" });
bindQueueScope(originQueue, originScope, { preferred: true });
const worktreeCwd = join(originScope, "sidequest", "tmp", "cwd");
mkdirSync(worktreeCwd, { recursive: true });
const originResult = resolveQueueForCwd(worktreeCwd, { queues: [originQueue], origin: originScope });
assertEqual(originResult.state, "resolved", "worktree-origin cwd resolves");
assertEqual(originResult.matchedBy, "worktree-origin", "worktree-origin cwd uses worktree-origin match");
assertEqual(originResult.queueId, originQueue.id, "worktree-origin cwd resolves the origin queue");

const ancestorScope = makeTrackedTempDir("queue-resolver-ancestor");
const ancestorQueue = createQueue({ id: "queue-ancestor", name: "Ancestor" });
bindQueueScope(ancestorQueue, ancestorScope, { preferred: true });
const childDir = join(ancestorScope, "nested", "child");
mkdirSync(childDir, { recursive: true });
const ancestorResult = resolveQueueForCwd(childDir, { queues: [ancestorQueue] });
assertEqual(ancestorResult.state, "resolved", "ancestor cwd resolves");
assertEqual(ancestorResult.matchedBy, "ancestor", "ancestor cwd uses ancestor match");
assertEqual(ancestorResult.queueId, ancestorQueue.id, "ancestor cwd resolves the ancestor queue");

const ambiguousScope = makeTrackedTempDir("queue-resolver-ambiguous");
const ambiguousQueueA = createQueue({ id: "queue-ambiguous-a", name: "Ambiguous A" });
const ambiguousQueueB = createQueue({ id: "queue-ambiguous-b", name: "Ambiguous B" });
bindQueueScope(ambiguousQueueA, ambiguousScope, { preferred: true });
bindQueueScope(ambiguousQueueB, ambiguousScope, { preferred: true });
const ambiguousResult = resolveQueueForCwd(ambiguousScope, { queues: [ambiguousQueueA, ambiguousQueueB] });
assertEqual(ambiguousResult.state, "ambiguous", "equally preferred matches are ambiguous");
const candidateList = ambiguousResult.candidates || [];
assert(Array.isArray(ambiguousResult.candidates), "ambiguous resolution returns a candidates array");
assertEqual(candidateList.length, 2, "ambiguous resolution returns both candidates");
assert(candidateList.includes(ambiguousQueueA.id), "ambiguous resolution includes the first candidate queue id");
assert(candidateList.includes(ambiguousQueueB.id), "ambiguous resolution includes the second candidate queue id");
assertEqual(ambiguousResult.queueId, undefined, "ambiguous resolution does not select a queue id");

const unboundScope = makeTrackedTempDir("queue-resolver-unbound");
const unboundQueue = createQueue({ id: "queue-unbound", name: "Unbound" });
const beforeUnboundBindingCount = unboundQueue.bindings?.length ?? 0;
const beforeQueueRows = listQueues().length;
const unboundResult = resolveQueueForCwd(unboundScope, { queues: [unboundQueue] });
assertEqual(unboundResult.state, "unbound", "unbound cwd resolves to unbound");
assertEqual((unboundQueue.bindings || []).length, beforeUnboundBindingCount, "unbound resolution does not add bindings");
assertEqual(listQueues().length, beforeQueueRows, "unbound resolution does not create queue rows");

done("test-queue-resolver");
