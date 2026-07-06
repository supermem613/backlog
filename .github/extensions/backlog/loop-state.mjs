export const ITEM_STATES = [
  "proposed",
  "approved",
  "running",
  "needs_review",
  "reviewed",
  "finishing",
  "done",
  "blocked",
  "needs_recovery",
];

const TRANSITIONS = new Map([
  ["proposed", ["approved", "blocked"]],
  ["approved", ["running", "blocked"]],
  ["running", ["needs_review", "blocked", "needs_recovery"]],
  ["needs_review", ["reviewed", "running", "blocked"]],
  ["reviewed", ["finishing", "blocked"]],
  ["finishing", ["done", "blocked"]],
  ["blocked", ["approved", "running"]],
  ["needs_recovery", ["approved", "blocked"]],
]);

export function canTransition(from, to) {
  return !!TRANSITIONS.get(from)?.includes(to);
}

export function assertTransition(from, to) {
  if (canTransition(from, to)) return;
  throw new Error(`illegal item transition ${from} -> ${to}`);
}

export function completeItemState() {
  return "needs_review";
}

export function blockedItemState() {
  return "blocked";
}

export function isGateSatisfied(gate) {
  return gate?.state === "approved" || gate?.state === "waived";
}

export function canRunItem({ item, startGate, featureActiveItem }) {
  if (!item || item.status !== "approved") return { ok: false, reason: "item_not_approved" };
  if (!isGateSatisfied(startGate)) return { ok: false, reason: "start_gate_required" };
  if (featureActiveItem && featureActiveItem.id !== item.id) return { ok: false, reason: "feature_has_active_item" };
  return { ok: true, reason: "ready" };
}

export function canFinishFeature({ reviewGate }) {
  if (!isGateSatisfied(reviewGate)) return { ok: false, reason: "review_gate_required" };
  return { ok: true, reason: "ready" };
}

export function waiverApplies(waiver, now = new Date()) {
  if (!waiver) return false;
  if (waiver.mode === "sticky") return true;
  if (waiver.mode === "time") return !!waiver.expires_at && Date.parse(waiver.expires_at) > now.getTime();
  if (waiver.mode === "count") return Number(waiver.remaining_uses || 0) > 0;
  return false;
}

export function reconcileItemState({ dbState, gitState, sodaState, prState, porState }) {
  if (dbState === "running" && sodaState === "missing") return "needs_recovery";
  if (sodaState === "finished" || prState === "merged") return "done";
  if (prState === "open" && dbState === "finishing") return "finishing";
  if (porState === "blocked") return "blocked";
  return dbState || "proposed";
}
