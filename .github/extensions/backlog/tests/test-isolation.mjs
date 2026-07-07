import "./harness.mjs";
import { assertEqual, done } from "./harness.mjs";
import { bindReviewCandidate, ISOLATION, preflightInPlace, resolveIsolation, updateReviewBinding } from "../isolation.mjs";

const cases = [
  [{ provider: "soda", globalPreference: "auto", capabilities: { sidequest: true } }, "sidequest", false, "auto_sidequest"],
  [{ provider: "git", globalPreference: "auto", capabilities: { sidequest: false } }, "in-place", true, "auto_requires_in_place_approval"],
  [{ provider: "git", globalPreference: "sidequest", capabilities: { sidequest: false } }, "unavailable", true, "git_sidequest_unavailable"],
  [{ provider: "soda", globalPreference: "sidequest", capabilities: { sidequest: true } }, "sidequest", false, "preferred_sidequest"],
  [{ provider: "soda", globalPreference: "sidequest", repoPreference: "in-place", capabilities: { sidequest: true } }, "in-place", false, "preferred_in_place"],
  [{ provider: "soda", globalPreference: "sidequest", repoPreference: "in-place", queuePreference: "sidequest", capabilities: { sidequest: true } }, "sidequest", false, "preferred_sidequest"],
];

for (const [input, mode, requiresApproval, reason] of cases) {
  const result = resolveIsolation(input);
  assertEqual(result.mode, mode, `${JSON.stringify(input)} mode`);
  assertEqual(result.requiresApproval, requiresApproval, `${JSON.stringify(input)} approval`);
  assertEqual(result.reason, reason, `${JSON.stringify(input)} reason`);
}

assertEqual(preflightInPlace({ clean: false, untracked: false, baseSha: "abc" }).reason, "dirty_tree", "dirty tree refused");
assertEqual(preflightInPlace({ clean: true, untracked: true, baseSha: "abc" }).reason, "untracked_files", "untracked files refused");
assertEqual(preflightInPlace({ clean: true, untracked: false, baseSha: null }).reason, "missing_base_sha", "missing base refused");
assertEqual(preflightInPlace({ clean: true, untracked: false, baseSha: "abc" }).ok, true, "clean tree with base accepted");

const binding = bindReviewCandidate({ treeSha: "tree1", diffHash: "diff1", headSha: "head1" });
const metadataMove = updateReviewBinding(binding, { treeSha: "tree1", diffHash: "diff1", headSha: "head2", metadata: { pushed: true } });
assertEqual(metadataMove.invalidated, false, "metadata-only head move does not invalidate review");
assertEqual(metadataMove.binding.headSha, "head2", "metadata-only move updates head");
const contentMove = updateReviewBinding(binding, { treeSha: "tree2", diffHash: "diff2", headSha: "head3" });
assertEqual(contentMove.invalidated, true, "content change invalidates review");

assertEqual(ISOLATION.AUTO, "auto", "isolation constants exported");

done("test-isolation");
