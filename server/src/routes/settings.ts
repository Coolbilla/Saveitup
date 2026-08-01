import { Router } from "express";
import {
  getRoleConfig,
  setRoleConfig,
  listAIErrors,
  clearAIErrors,
  type AIRole
} from "../lib/ai-config.js";
import { getUserId } from "../lib/request-context.js";

export const settingsRouter = Router();

const AI_ROLES: AIRole[] = ["cleanup", "categorize", "summarize", "chat", "embeddings"];
const KNOWN_PROVIDERS = ["ollama", "ollama_cloud", "anthropic", "openai", "gemini", "openrouter", "nvidia"];

const ENV_DEFAULTS: Record<AIRole, string> = {
  cleanup: process.env.CLEANUP_PROVIDER || process.env.SUMMARY_PROVIDER || "none",
  categorize: process.env.CATEGORIZE_PROVIDER || process.env.SUMMARY_PROVIDER || "none",
  summarize: process.env.SUMMARY_PROVIDER || "none",
  chat: process.env.CHAT_PROVIDER || process.env.SUMMARY_PROVIDER || "none",
  embeddings: process.env.EMBEDDING_PROVIDER || "none"
};

settingsRouter.get("/settings/ai", async (req, res) => {
  try {
    const userId = getUserId(req);
    const roles: Record<string, { chain: { provider: string; model: string }[] } | null> = {};
    for (const role of AI_ROLES) {
      roles[role] = await getRoleConfig(userId, role);
    }
    res.json({ roles, knownProviders: KNOWN_PROVIDERS, envDefaults: ENV_DEFAULTS });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

settingsRouter.put("/settings/ai", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { role, chain } = req.body;
    if (!AI_ROLES.includes(role)) {
      res.status(400).json({ error: "invalid role" });
      return;
    }
    if (!Array.isArray(chain)) {
      res.status(400).json({ error: "chain must be an array" });
      return;
    }
    await setRoleConfig(userId, role, { chain });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

settingsRouter.get("/settings/errors", async (req, res) => {
  try {
    const userId = getUserId(req);
    res.json(await listAIErrors(userId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

settingsRouter.post("/settings/errors/clear", async (req, res) => {
  try {
    const userId = getUserId(req);
    await clearAIErrors(userId);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
