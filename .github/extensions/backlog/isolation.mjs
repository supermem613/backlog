export const ISOLATION = {
  AUTO: "auto",
  SIDEQUEST: "sidequest",
  IN_PLACE: "in-place",
};

export function resolveIsolation({
  provider,
  globalPreference = ISOLATION.AUTO,
  repoPreference = null,
  featurePreference = null,
  capabilities = {},
}) {
  const preference = featurePreference || repoPreference || globalPreference || ISOLATION.AUTO;
  const canSidequest = !!capabilities.sidequest;
  if (preference === ISOLATION.IN_PLACE) {
    return { mode: ISOLATION.IN_PLACE, requiresApproval: false, reason: "preferred_in_place" };
  }
  if (preference === ISOLATION.SIDEQUEST) {
    if (canSidequest) return { mode: ISOLATION.SIDEQUEST, requiresApproval: false, reason: "preferred_sidequest" };
    return { mode: "unavailable", requiresApproval: true, reason: `${provider}_sidequest_unavailable` };
  }
  if (canSidequest) return { mode: ISOLATION.SIDEQUEST, requiresApproval: false, reason: "auto_sidequest" };
  return { mode: ISOLATION.IN_PLACE, requiresApproval: true, reason: "auto_requires_in_place_approval" };
}

export function preflightInPlace({ clean, untracked, baseSha }) {
  if (!clean) return { ok: false, reason: "dirty_tree" };
  if (untracked) return { ok: false, reason: "untracked_files" };
  if (!baseSha) return { ok: false, reason: "missing_base_sha" };
  return { ok: true, baseSha };
}

export function bindReviewCandidate({ treeSha, diffHash, headSha, metadata = {} }) {
  return { treeSha, diffHash, headSha, metadata };
}

export function updateReviewBinding(binding, next) {
  const sameContent = binding.treeSha === next.treeSha && binding.diffHash === next.diffHash;
  return {
    binding: sameContent ? { ...binding, headSha: next.headSha, metadata: next.metadata || binding.metadata || {} } : next,
    invalidated: !sameContent,
  };
}
