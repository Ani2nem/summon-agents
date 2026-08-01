// testkit.ts - helpers for integration tests that use real git in temp dirs.
// Not part of the public build (excluded from tsup entry); imported only by *.test.ts.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { git } from "./worktree.js";

/** Create a throwaway git repo with one baseline commit. Returns its path. */
export async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "summon-test-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@summon.dev"]);
  await git(dir, ["config", "user.name", "Summon Test"]);
  await fs.writeFile(path.join(dir, "README.md"), "# temp repo\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "baseline"]);
  return dir;
}

/** Recursively remove a temp dir, ignoring errors. */
export async function cleanupTempRepo(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Write a file (creating parent dirs) and stage+commit it on the current branch. */
export async function commitFile(
  repoDir: string,
  relPath: string,
  content: string,
  message = `add ${relPath}`,
): Promise<void> {
  const full = path.join(repoDir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-m", message]);
}
