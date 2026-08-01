// summon-agents-mcp - stdio MCP server entry.
// Registered in a host's MCP config (e.g. .mcp.json) and launched by the host.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
