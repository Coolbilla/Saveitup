import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const server = new McpServer({ name: "saveitup", version: "0.1.0" });
registerTools(server);

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} catch (err) {
  console.error("[saveitup-mcp] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
}
