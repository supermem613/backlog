import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

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

function pathExists(path) {
  return existsSync(path);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function parseSodaStatusMainRepoRoot(output) {
  const text = typeof output === "string" ? output : "";
  if (!text.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    const root = parsed?.data?.summary?.mainRepo?.root;
    return typeof root === "string" && root.trim() ? resolve(root) : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function runDefaultSodaStatus(cwd) {
  const result = spawnSync("sd", ["status"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  return parseSodaStatusMainRepoRoot(result.stdout);
}

function resolveSodaStatusMainRepoRoot(cwd, evidence = {}) {
  const explicit = evidence.mainRepoRoot || evidence.mainRepo?.root;
  if (explicit) return resolve(explicit);
  if (evidence.sdStatus !== undefined) return parseSodaStatusMainRepoRoot(evidence.sdStatus);
  const runner = evidence.runSodaStatus;
  if (runner === false) return null;
  if (typeof runner === "function") {
    const result = runner(cwd);
    if (typeof result === "string") return parseSodaStatusMainRepoRoot(result);
    return parseSodaStatusMainRepoRoot(result?.stdout || "");
  }
  return runDefaultSodaStatus(cwd);
}

function resolveGitWorktreeMainRepoRoot(gitMarker, cwd) {
  const text = readFileSync(gitMarker, "utf8");
  const match = /^gitdir:\s*(.+)$/im.exec(text);
  if (!match) return null;
  const gitDir = resolve(cwd, match[1].trim());
  const normalized = gitDir.replace(/\\/g, "/");
  const marker = "/.git/worktrees/";
  const index = normalized.toLowerCase().lastIndexOf(marker);
  return index > 0 ? resolve(gitDir.slice(0, index)) : null;
}

export function resolveWorktreeOrigin(cwd, evidence = {}) {
  const start = resolve(cwd || ".");
  const explicit = [evidence.origin, evidence.worktreeOrigin, evidence.mainRepoRoot, evidence.mainRepo?.root, evidence.repoRoot, evidence.commonGitDir].filter(Boolean);
  for (const candidate of explicit) {
    if (!candidate) continue;
    return resolve(candidate);
  }
  let current = start;
  while (true) {
    const gitMarker = join(current, ".git");
    if (pathExists(gitMarker)) {
      if (isFile(gitMarker)) {
        return resolveSodaStatusMainRepoRoot(current, evidence)
          || resolveGitWorktreeMainRepoRoot(gitMarker, current)
          || current;
      }
      return current;
    }
    if (pathExists(join(current, ".sd", "repo-id"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
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
