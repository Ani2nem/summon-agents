// summon-agents-mcp - stdio MCP server entry.
// Registered in a host's MCP config (e.g. .mcp.json) and launched by the host.

import * as os from "node:os";
import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// Some hosts (notably VS Code) launch MCP servers with a minimal PATH that omits
// user/homebrew bin dirs, so bare `claude`/`gh` cannot be found. Augment PATH
// with the common locations so agent CLIs resolve without manual env config.
function augmentPath(): void {
  const home = os.homedir();
  const extra = [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const current = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const merged = [...current, ...extra.filter((p) => !current.includes(p))];
  process.env.PATH = merged.join(path.delimiter);
}

augmentPath();

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
