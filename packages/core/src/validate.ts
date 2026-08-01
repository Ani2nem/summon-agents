// validate.ts - the merged-state validation gate (loophole A).
//
// A clean git merge does not mean the code works: agent A changes a signature,
// agent B calls the old one, git merges with zero conflict markers, broken code
// lands. So before finalizing the local merge we run the repo's OWN already-
// declared validation command on the merged tree. We are running the repo's
// command, not reinventing CI. If the repo declares nothing (true greenfield),
// we skip honestly and say so rather than pretend it passed.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execa } from "execa";

export type PackageManager = "pnpm" | "yarn" | "npm";

export interface ValidationCommand {
  kind: "typecheck" | "build" | "test";
  command: string;
  args: string[];
  label: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Detect the package manager from lockfiles; default npm. */
export async function detectPackageManager(
  repoDir: string,
): Promise<PackageManager> {
  if (await exists(path.join(repoDir, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(repoDir, "yarn.lock"))) return "yarn";
  return "npm";
}

async function readScripts(repoDir: string): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(repoDir, "package.json"), "utf8"),
    );
    return (pkg.scripts ?? {}) as Record<string, string>;
  } catch {
    return {};
  }
}

function runScript(pm: PackageManager, script: string): ValidationCommand {
  return {
    kind: script === "build" ? "build" : script === "test" ? "test" : "typecheck",
    command: pm,
    args: ["run", script],
    label: `${pm} run ${script}`,
  };
}

/**
 * Choose the repo's validation command, in priority order:
 *   1. a "typecheck" script (cheapest, catches the signature-drift case)
 *   2. `tsc --noEmit` if a tsconfig exists (typecheck without a script)
 *   3. a "build" script
 *   4. a "test" script
 * Returns null when the repo declares nothing to run (greenfield -> skip).
 */
export async function detectValidationCommand(
  repoDir: string,
): Promise<ValidationCommand | null> {
  const scripts = await readScripts(repoDir);
  const pm = await detectPackageManager(repoDir);

  if (scripts.typecheck) return runScript(pm, "typecheck");
  if (await exists(path.join(repoDir, "tsconfig.json"))) {
    return {
      kind: "typecheck",
      command: "npx",
      args: ["--no-install", "tsc", "--noEmit"],
      label: "npx tsc --noEmit",
    };
  }
  if (scripts.build) return runScript(pm, "build");
  if (scripts.test) return runScript(pm, "test");
  return null;
}

export interface ValidationResult {
  ran: boolean;
  ok: boolean;
  label?: string;
  output?: string;
}

/**
 * Install dependencies once, up front, before dispatch (loophole C). Doing this
 * centrally keeps agents from each racing to edit the manifest/lockfile.
 */
export async function installDependencies(
  repoDir: string,
  deps: readonly string[],
): Promise<{ ok: boolean; output: string }> {
  if (deps.length === 0) return { ok: true, output: "" };
  const pm = await detectPackageManager(repoDir);
  const verb = pm === "npm" ? "install" : "add";
  const res = await execa(pm, [verb, ...deps], {
    cwd: repoDir,
    reject: false,
    all: true,
  });
  return { ok: res.exitCode === 0, output: res.all ?? "" };
}

/** Run a validation command in the merged tree, capturing combined output. */
export async function runValidation(
  repoDir: string,
  cmd: ValidationCommand,
): Promise<ValidationResult> {
  const res = await execa(cmd.command, cmd.args, {
    cwd: repoDir,
    reject: false,
    all: true,
  });
  return {
    ran: true,
    ok: res.exitCode === 0,
    label: cmd.label,
    output: res.all ?? res.stdout ?? "",
  };
}
