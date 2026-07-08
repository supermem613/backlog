import { relative, resolve } from "node:path";
import { bindQueueScope as bindQueueScopeDb, listQueueScopes as listQueueScopesDb } from "./db.mjs";
import { resolveWorktreeOrigin } from "./vcs-provider.mjs";

function normalizePath(value) {
  return resolve(String(value || "."));
}

function isAncestorPath(ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  const normalizedAncestor = normalizePath(ancestor);
  const normalizedDescendant = normalizePath(descendant);
  if (normalizedAncestor === normalizedDescendant) return false;
  const relativePath = relative(normalizedAncestor, normalizedDescendant);
  return !!relativePath && !relativePath.startsWith("..") && !relativePath.startsWith("/") && !relativePath.startsWith("\\") && !relativePath.includes("..\\") && !relativePath.includes("../");
}

function getQueueBindings(queue) {
  if (!queue) return [];
  if (Array.isArray(queue.bindings)) return queue.bindings;
  const queueId = queue.id;
  return queueId ? listQueueScopesDb(queueId) : [];
}

function buildCandidate(queue, binding, matchedBy) {
  return {
    queueId: queue.id,
    queue,
    binding,
    matchedBy,
    scope: binding?.scope || null,
  };
}

export function bindQueueScope(queue, scope, { preferred = false } = {}) {
  if (!queue) throw new Error("queue is required");
  if (!scope) throw new Error("scope is required");
  const binding = bindQueueScopeDb(queue, scope, { preferred });
  const queueId = queue.id;
  if (queueId) {
    queue.bindings = listQueueScopesDb(queueId);
  }
  return binding;
}

export function resolveQueue({ cwd, worktreeEvidence = {} } = {}) {
  const queues = Array.isArray(worktreeEvidence.queues) ? worktreeEvidence.queues : [];
  const normalizedCwd = normalizePath(cwd);
  const worktreeOrigin = resolveWorktreeOrigin(normalizedCwd, worktreeEvidence);
  const normalizedOrigin = worktreeOrigin ? normalizePath(worktreeOrigin) : null;

  const exactMatches = [];
  const worktreeOriginMatches = [];
  const ancestorMatches = [];

  for (const queue of queues) {
    const bindings = getQueueBindings(queue);
    for (const binding of bindings) {
      const bindingScope = normalizePath(binding.scope);
      if (bindingScope === normalizedCwd) {
        exactMatches.push(buildCandidate(queue, binding, "exact"));
      } else if (normalizedOrigin && bindingScope === normalizedOrigin) {
        worktreeOriginMatches.push(buildCandidate(queue, binding, "worktree-origin"));
      } else if (isAncestorPath(bindingScope, normalizedCwd)) {
        ancestorMatches.push(buildCandidate(queue, binding, "ancestor"));
      }
    }
  }

  const groups = [
    { kind: "exact", matches: exactMatches },
    { kind: "worktree-origin", matches: worktreeOriginMatches },
    { kind: "ancestor", matches: ancestorMatches },
  ];

  for (const group of groups) {
    if (!group.matches.length) continue;
    const preferredMatches = group.matches.filter((candidate) => candidate.binding.preferred);
    const candidates = preferredMatches.length ? preferredMatches : group.matches;
    const uniqueQueueIds = [...new Set(candidates.map((candidate) => candidate.queueId))];
    if (candidates.length === 1 || uniqueQueueIds.length === 1) {
      const selected = candidates[0];
      return {
        state: "resolved",
        matchedBy: group.kind,
        queueId: selected.queueId,
        queue: selected.queue,
        binding: selected.binding,
        candidates: uniqueQueueIds,
      };
    }
    return {
      state: "ambiguous",
      matchedBy: group.kind,
      queueId: undefined,
      queue: undefined,
      binding: undefined,
      candidates: uniqueQueueIds,
    };
  }

  return {
    state: "unbound",
    matchedBy: undefined,
    queueId: undefined,
    queue: undefined,
    binding: undefined,
    candidates: [],
  };
}

export function resolveQueueForCwd(cwd, { queues = [], origin = null } = {}) {
  return resolveQueue({
    cwd,
    worktreeEvidence: {
      queues,
      origin,
      worktreeOrigin: origin,
    },
  });
}
