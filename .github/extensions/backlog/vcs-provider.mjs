import { existsSync } from "node:fs";
import { join } from "node:path";

export const PROVIDERS = {
  SODA: "soda",
  GIT: "git",
};

export function detectProviderFromCommonGitDir(commonGitDir) {
  return existsSync(join(commonGitDir, ".sd", "repo-id")) ? PROVIDERS.SODA : PROVIDERS.GIT;
}

export function makeProviderCommands(provider) {
  if (provider === PROVIDERS.SODA) {
    return {
      provider,
      status: ["sd", "status"],
      commit: ["sd", "submit", "-d"],
      push: ["sd", "push"],
      pull: ["sd", "pull"],
      sidequestStart: ["sd", "sidequest", "start"],
      sidequestReview: ["sd", "sidequest", "review"],
      sidequestFinish: ["sd", "sidequest", "finish"],
    };
  }
  return {
    provider: PROVIDERS.GIT,
    status: ["git", "status", "--short"],
    commit: ["git", "commit", "-m"],
    push: ["git", "push"],
    pull: ["git", "pull"],
    branch: ["git", "switch", "-c"],
  };
}

export class SodaRepoLock {
  constructor() {
    this.held = new Set();
  }

  acquire(repoRoot) {
    if (this.held.has(repoRoot)) {
      return { ok: false, state: "blocking", reason: "soda_lock_held", repoRoot };
    }
    this.held.add(repoRoot);
    return { ok: true, state: "acquired", repoRoot };
  }

  release(repoRoot) {
    this.held.delete(repoRoot);
  }

  run(repoRoot, fn) {
    const lock = this.acquire(repoRoot);
    if (!lock.ok) return lock;
    try {
      return { ok: true, state: "completed", result: fn() };
    } finally {
      this.release(repoRoot);
    }
  }
}
