import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listSavedPages, getSavedPage, searchSavedPages } from "./backend-client.js";

export function registerTools(server: McpServer) {
  server.tool(
    "list_saved_pages",
    "List saved pages, newest first, optionally filtered by domain. Returns lightweight summaries (id, title, url, domain, date, and flags for whether description/transcript/highlight/note exist) — call get_saved_page(id) to fetch full content for a specific page.",
    { limit: z.number().optional(), domain: z.string().optional() },
    async ({ limit, domain }) => {
      const pages = await listSavedPages({ limit, domain });
      return { content: [{ type: "text", text: JSON.stringify(pages, null, 2) }] };
    }
  );

  server.tool(
    "get_saved_page",
    "Get a single saved page by id, including full page content/transcript/description/highlight text/note text",
    { id: z.number() },
    async ({ id }) => {
      const page = await getSavedPage(id);
      return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
    }
  );

  server.tool(
    "search_saved_pages",
    "Search saved pages by substring match against title/content/description/note/highlight text. Returns lightweight summaries — call get_saved_page(id) to fetch full content for a match.",
    { query: z.string() },
    async ({ query }) => {
      const pages = await searchSavedPages(query);
      return { content: [{ type: "text", text: JSON.stringify(pages, null, 2) }] };
    }
  );
}
