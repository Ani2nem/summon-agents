import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./server.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A stub agent: triage -> single mode; worker -> writes a file and commits. */
const STUB = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("stub 1.0"); process.exit(0); }
const prompt = args[args.indexOf("-p") + 1] ?? "";
if (prompt.includes("--- PLAN ---") || prompt.includes("planning brain")) {
  console.log(JSON.stringify({ mode: "single", reason: "small", subtasks: [
    { slug: "main", title: "Do it", instructions: "the plan", allowedFiles: [] }
  ], hotspotFiles: [], preInstall: [] }));
  process.exit(0);
}
writeFileSync("done.txt", "ok");
execSync("git add -A && git commit -m 'stub work' --quiet");
process.exit(0);
`;

async function makeRepo(): Promise<{ dir: string; stub: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "summon-mcp-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.dev"]);
  git(dir, ["config", "user.name", "T"]);
  await fs.writeFile(path.join(dir, ".gitignore"), ".summon-agents/\n");
  await fs.writeFile(path.join(dir, "README.md"), "# t\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "base"]);
  const stub = path.join(dir, "stub.mjs");
  await fs.writeFile(stub, STUB);
  await fs.chmod(stub, 0o755);
  return { dir, stub };
}

async function connect(repoRoot: string): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createServer(repoRoot);
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientT);
  return client;
}

describe("summon-agents MCP server", () => {
  let dir: string;
  let stub: string;
  beforeEach(async () => {
    ({ dir, stub } = await makeRepo());
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("registers the expected tools", async () => {
    const client = await connect(dir);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "summon_abort",
      "summon_agents",
      "summon_gc",
      "summon_merge",
      "summon_status",
    ]);
    await client.close();
  });

  it("review gate: summon_agents(review) holds, summon_merge finalizes", async () => {
    const prevBin = process.env.SUMMON_AGENT_BIN;
    process.env.SUMMON_AGENT_BIN = stub;
    try {
      const client = await connect(dir);
      const held = (await client.callTool({
        name: "summon_agents",
        arguments: { plan: "Do a small thing", review: true },
      })) as { content: { text: string }[] };
      const heldBody = held.content.map((c) => c.text).join("\n");
      expect(heldBody).toMatch(/status: awaitingReview/);
      expect(heldBody).toMatch(/summon_merge/);
      // Nothing landed on main yet.
      expect(
        await fs
          .access(path.join(dir, "done.txt"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);

      // Grab the runId from status and finalize it.
      const status = (await client.callTool({
        name: "summon_status",
        arguments: {},
      })) as { content: { text: string }[] };
      const runId = status.content[0]!.text.split(":")[0]!.trim();

      const merged = (await client.callTool({
        name: "summon_merge",
        arguments: { runId },
      })) as { content: { text: string }[] };
      expect(merged.content.map((c) => c.text).join("\n")).toMatch(
        /status: completed/,
      );
      expect(
        await fs
          .access(path.join(dir, "done.txt"))
          .then(() => true)
          .catch(() => false),
      ).toBe(true);
      await client.close();
    } finally {
      if (prevBin === undefined) delete process.env.SUMMON_AGENT_BIN;
      else process.env.SUMMON_AGENT_BIN = prevBin;
    }
  });

  it("summon_agents runs the pipeline end-to-end via MCP", async () => {
    const prevBin = process.env.SUMMON_AGENT_BIN;
    process.env.SUMMON_AGENT_BIN = stub;
    try {
      const client = await connect(dir);
      const res = (await client.callTool({
        name: "summon_agents",
        arguments: { plan: "Do a small thing" },
      })) as { content: { type: string; text: string }[]; isError?: boolean };

      const body = res.content.map((c) => c.text).join("\n");
      expect(body).toMatch(/status: completed/);
      expect(res.isError).toBeFalsy();
      // The stub's work landed on main.
      const exists = await fs
        .access(path.join(dir, "done.txt"))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
      await client.close();
    } finally {
      if (prevBin === undefined) delete process.env.SUMMON_AGENT_BIN;
      else process.env.SUMMON_AGENT_BIN = prevBin;
    }
  });

  it("summon_status reports no runs on a fresh repo, then lists after a run", async () => {
    const client = await connect(dir);
    const res = (await client.callTool({
      name: "summon_status",
      arguments: {},
    })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toMatch(/no runs yet/);
    await client.close();
  });

  it("summon_gc returns a reaped count", async () => {
    const client = await connect(dir);
    const res = (await client.callTool({
      name: "summon_gc",
      arguments: {},
    })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toMatch(/reaped/);
    await client.close();
  });
});
