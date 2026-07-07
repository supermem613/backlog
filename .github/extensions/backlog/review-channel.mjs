import { createStore } from "./store.mjs";

const START_BLOCKED_STATUSES = new Set(["running", "needs_review", "reviewed", "finishing", "done"]);

function requireItem(store, itemId) {
  if (!itemId) throw new Error("item id required");
  const item = store.getItem(itemId);
  if (!item) throw new Error(`item '${itemId}' not found`);
  return item;
}

function parseBinding(raw) {
  try { return JSON.parse(raw || "{}"); }
  catch { return {}; }
}

function decisionFromRow(row) {
  return {
    kind: row.kind,
    itemId: row.itemId,
    description: row.description,
    status: row.status,
    queueId: row.queueId || null,
    gateState: row.gateState || "pending",
    binding: parseBinding(row.bindingJson),
  };
}

export function approveItemStart({ store = createStore(), itemId, actor = "human", binding = {}, correlationId = null }) {
  const item = requireItem(store, itemId);
  if (START_BLOCKED_STATUSES.has(item.status)) {
    throw new Error(`cannot approve start for item '${itemId}' while status is '${item.status}'`);
  }
  const approvedAt = new Date().toISOString();
  const gateBinding = { ...binding, approvedAt };
  store.setItemGate({ itemId, gateKind: "start", state: "approved", binding: gateBinding, actor, correlationId });
  if (item.status !== "approved") {
    store.transitionItem({ itemId, status: "approved", actor, correlationId });
  }
  return { ...item, status: "approved", gateKind: "start", gateState: "approved", binding: gateBinding };
}

export function requestItemReview({ store = createStore(), itemId, summary = "", actor = "loop", binding = {}, correlationId = null }) {
  const item = requireItem(store, itemId);
  const requestedAt = new Date().toISOString();
  const gateBinding = { ...binding, summary, requestedAt };
  store.setItemGate({ itemId, gateKind: "review", state: "pending", binding: gateBinding, actor, correlationId });
  return {
    kind: "review",
    itemId,
    description: item.description,
    status: "needs_review",
    queueId: item.queue_id || null,
    gateState: "pending",
    binding: gateBinding,
  };
}

export function approveItemReview({ store = createStore(), itemId, actor = "human", binding = {}, correlationId = null }) {
  const item = requireItem(store, itemId);
  if (item.status !== "needs_review") {
    throw new Error(`cannot approve review for item '${itemId}' while status is '${item.status}'`);
  }
  const approvedAt = new Date().toISOString();
  const gateBinding = { ...binding, approvedAt };
  store.setItemGate({ itemId, gateKind: "review", state: "approved", binding: gateBinding, actor, correlationId });
  store.transitionItem({ itemId, status: "reviewed", actor, correlationId });
  return { ...item, status: "reviewed", gateKind: "review", gateState: "approved", binding: gateBinding };
}

export function rejectItemReview({ store = createStore(), itemId, reason = "", actor = "human", binding = {}, correlationId = null }) {
  const item = requireItem(store, itemId);
  if (item.status !== "needs_review") {
    throw new Error(`cannot reject review for item '${itemId}' while status is '${item.status}'`);
  }
  const rejectedAt = new Date().toISOString();
  const gateBinding = { ...binding, reason, rejectedAt };
  store.setItemGate({ itemId, gateKind: "review", state: "rejected", binding: gateBinding, actor, correlationId });
  store.transitionItem({ itemId, status: "blocked", actor, correlationId });
  return { ...item, status: "blocked", gateKind: "review", gateState: "rejected", binding: gateBinding };
}

export function listHumanDecisions({ store = createStore() } = {}) {
  return store.database.prepare(`
    SELECT
      'start' AS kind,
      i.id AS itemId,
      i.description,
      i.status,
      i.queue_id AS queueId,
      COALESCE(g.state, 'pending') AS gateState,
      COALESCE(g.binding_json, '{}') AS bindingJson
    FROM items i
    LEFT JOIN item_gates g ON g.item_id = i.id AND g.gate_kind = 'start'
    WHERE i.status IN ('proposed', 'needs_recovery')
      AND COALESCE(g.state, 'pending') = 'pending'
    UNION ALL
    SELECT
      'review' AS kind,
      i.id AS itemId,
      i.description,
      i.status,
      i.queue_id AS queueId,
      COALESCE(g.state, 'pending') AS gateState,
      COALESCE(g.binding_json, '{}') AS bindingJson
    FROM items i
    LEFT JOIN item_gates g ON g.item_id = i.id AND g.gate_kind = 'review'
    WHERE i.status = 'needs_review'
      AND COALESCE(g.state, 'pending') = 'pending'
    ORDER BY itemId
  `).all().map(decisionFromRow);
}

export function formatHumanDecisionNotice(decisions) {
  if (!decisions.length) return "No human backlog decisions are pending.";
  const lines = ["Human backlog decision required:"];
  for (const decision of decisions) {
    const command = decision.kind === "review"
      ? `/backlog review ${decision.itemId} approve`
      : `/backlog approve ${decision.itemId}`;
    lines.push(`- ${decision.kind}: [${decision.itemId}] ${decision.description} (${command})`);
  }
  return lines.join("\n");
}
