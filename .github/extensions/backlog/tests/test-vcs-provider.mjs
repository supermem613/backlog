import "./harness.mjs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEqual, done } from "./harness.mjs";
import { detectProviderFromCommonGitDir, makeProviderCommands, PROVIDERS, resolveWorktreeOrigin, SodaRepoLock } from "../vcs-provider.mjs";

const plain = join(tmpdir(), `backlog-provider-plain-${process.pid}`);
const soda = join(tmpdir(), `backlog-provider-soda-${process.pid}`);
const gitOrigin = join(tmpdir(), `backlog-provider-git-origin-${process.pid}`);
const sodaOrigin = join(tmpdir(), `backlog-provider-soda-origin-${process.pid}`);
try {
  mkdirSync(plain, { recursive: true });
  mkdirSync(join(soda, ".sd"), { recursive: true });
  writeFileSync(join(soda, ".sd", "repo-id"), "repo\n", "utf8");

  assertEqual(detectProviderFromCommonGitDir(plain), PROVIDERS.GIT, "plain common git dir resolves to git");
  assertEqual(detectProviderFromCommonGitDir(soda), PROVIDERS.SODA, "common git dir with .sd/repo-id resolves to soda");
  assertEqual(makeProviderCommands(PROVIDERS.SODA).commit[0], "sd", "soda provider commits through sd");
  assertEqual(makeProviderCommands(PROVIDERS.GIT).commit[0], "git", "git provider commits through git");

  mkdirSync(gitOrigin, { recursive: true });
  mkdirSync(join(gitOrigin, ".git"), { recursive: true });
  assertEqual(resolveWorktreeOrigin(gitOrigin), gitOrigin, "git worktree origin resolves from .git marker");
 
  mkdirSync(join(sodaOrigin, ".sd"), { recursive: true });
  writeFileSync(join(sodaOrigin, ".sd", "repo-id"), "repo\n", "utf8");
  assertEqual(resolveWorktreeOrigin(join(sodaOrigin, "nested", "child")), sodaOrigin, "soda worktree origin resolves from .sd/repo-id marker");

  const lock = new SodaRepoLock();
  assertEqual(lock.acquire("C:\\repo").state, "acquired", "first soda lock acquire succeeds");
  assertEqual(lock.acquire("C:\\repo").state, "blocking", "second soda lock acquire is visible blocking");
  lock.release("C:\\repo");
  assertEqual(lock.run("C:\\repo", () => 42).result, 42, "lock run executes and releases");
  assertEqual(lock.acquire("C:\\repo").state, "acquired", "lock is available after run releases");
  lock.release("C:\\repo");
 
  done("test-vcs-provider");
} finally {
  rmSync(plain, { recursive: true, force: true });
  rmSync(soda, { recursive: true, force: true });
  rmSync(gitOrigin, { recursive: true, force: true });
  rmSync(sodaOrigin, { recursive: true, force: true });
}
