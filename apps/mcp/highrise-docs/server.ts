#!/usr/bin/env node
/**
 * Highrise Docs MCP Server
 * OWNERSHIP: apps/mcp/highrise-docs
 *
 * Exposes curated Highrise Bot SDK documentation and examples as MCP tools.
 * The AI orchestrator queries this server when generating bot specs and code,
 * so it always uses current, accurate Highrise API information instead of
 * relying solely on training data.
 *
 * TOOLS EXPOSED:
 *   search_docs(query)        — semantic search over Highrise docs
 *   get_event_docs(event)     — full docs for a specific SDK event handler
 *   get_action_docs(action)   — full docs for a specific SDK action
 *   get_example(template_id)  — retrieve a complete working bot example
 *   get_sdk_changelog()       — latest SDK version info and breaking changes
 *   list_emotes(rarity?)      — Highrise emote catalog (from SQLite cache)
 *
 * HOW TO ADD THIS MCP TO YOUR AI AGENT:
 *   In your Claude Code MCP config (~/.claude/mcp.json):
 *   {
 *     "mcpServers": {
 *       "highrise-docs": {
 *         "command": "node",
 *         "args": ["apps/mcp/highrise-docs/server.js"],
 *         "cwd": "/path/to/KojyAI_v3"
 *       }
 *     }
 *   }
 *
 *   The server communicates via stdio (standard MCP transport).
 *   The AI backend (HighriseOrchestrator.ts) calls it via MCPClient.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  HIGHRISE_SDK_EVENTS,
  HIGHRISE_SDK_ACTIONS,
  HIGHRISE_BOT_TEMPLATES,
} from "../../../packages/engine/src/highrise/HighriseKnowledge.js";

const server = new Server(
  { name: "highrise-docs", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// ─── Tool Definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_docs",
      description: "Search the Highrise Bot SDK documentation for information about events, actions, models, or concepts",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (e.g. 'how to send whisper', 'on_tip event')" },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_event_docs",
      description: "Get full documentation for a specific Highrise SDK event handler",
      inputSchema: {
        type: "object",
        properties: {
          event: { type: "string", description: "Event name (e.g. 'on_user_join', 'on_chat', 'on_tip')" },
        },
        required: ["event"],
      },
    },
    {
      name: "get_action_docs",
      description: "Get full documentation for a specific Highrise SDK action method",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action name (e.g. 'chat', 'emote', 'moderate_room')" },
        },
        required: ["action"],
      },
    },
    {
      name: "get_bot_template",
      description: "Get a complete working Highrise bot template for a specific use case",
      inputSchema: {
        type: "object",
        properties: {
          template_id: {
            type: "string",
            enum: HIGHRISE_BOT_TEMPLATES.map(t => t.id),
            description: "Template identifier",
          },
        },
        required: ["template_id"],
      },
    },
    {
      name: "get_sdk_info",
      description: "Get current Highrise Python Bot SDK version, install command, and launch command",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_bot_templates",
      description: "List all available Highrise bot templates with descriptions and difficulty levels",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

// ─── Tool Handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "search_docs": {
      const query = (args?.query as string ?? "").toLowerCase();
      const limit = (args?.limit as number) ?? 5;
      const results: string[] = [];

      // Search events
      for (const [key, val] of Object.entries(HIGHRISE_SDK_EVENTS)) {
        if (key.includes(query) || val.description.toLowerCase().includes(query) || val.commonUse.toLowerCase().includes(query)) {
          results.push(`EVENT: ${key}\n${val.description}\nSignature: ${val.signature}\nCommon use: ${val.commonUse}`);
        }
      }

      // Search actions
      for (const [key, val] of Object.entries(HIGHRISE_SDK_ACTIONS)) {
        if (key.includes(query) || val.description.toLowerCase().includes(query)) {
          results.push(`ACTION: ${key}\n${val.description}\nCode: ${val.code}\nExample: ${val.example}`);
        }
      }

      // Search templates
      for (const t of HIGHRISE_BOT_TEMPLATES) {
        if (t.name.toLowerCase().includes(query) || t.description.toLowerCase().includes(query)) {
          results.push(`TEMPLATE: ${t.id} (${t.name})\n${t.description}\nDifficulty: ${t.difficulty}`);
        }
      }

      const top = results.slice(0, limit);
      return {
        content: [{
          type: "text",
          text: top.length > 0
            ? `Found ${top.length} results:\n\n${top.join("\n\n---\n\n")}`
            : `No results found for "${query}". Try broader terms like "chat", "join", "emote", "tip", "moderate".`,
        }],
      };
    }

    case "get_event_docs": {
      const eventName = args?.event as string;
      const doc = HIGHRISE_SDK_EVENTS[eventName as keyof typeof HIGHRISE_SDK_EVENTS];
      if (!doc) {
        const available = Object.keys(HIGHRISE_SDK_EVENTS).join(", ");
        return { content: [{ type: "text", text: `Event "${eventName}" not found. Available: ${available}` }] };
      }
      return {
        content: [{
          type: "text",
          text: `# ${eventName}\n\n${doc.description}\n\n**Signature:** \`${doc.signature}\`\n\n**Parameters:**\n${Object.entries(doc.params).map(([k, v]) => `- \`${k}\`: ${v}`).join("\n")}\n\n**Common use:** ${doc.commonUse}`,
        }],
      };
    }

    case "get_action_docs": {
      const actionName = args?.action as string;
      const doc = HIGHRISE_SDK_ACTIONS[actionName as keyof typeof HIGHRISE_SDK_ACTIONS];
      if (!doc) {
        const available = Object.keys(HIGHRISE_SDK_ACTIONS).join(", ");
        return { content: [{ type: "text", text: `Action "${actionName}" not found. Available: ${available}` }] };
      }
      return {
        content: [{
          type: "text",
          text: `# ${actionName}\n\n${doc.description}\n\n**Code:** \`${doc.code}\`\n\n**Example:**\n\`\`\`python\n${doc.example}\n\`\`\`\n\n**Rate limit:** ${"rateLimit" in doc ? doc.rateLimit : "Unknown"}${"note" in doc ? `\n\n**Note:** ${doc.note}` : ""}`,
        }],
      };
    }

    case "get_bot_template": {
      const templateId = args?.template_id as string;
      const template = HIGHRISE_BOT_TEMPLATES.find(t => t.id === templateId);
      if (!template) {
        return { content: [{ type: "text", text: `Template "${templateId}" not found.` }] };
      }
      return {
        content: [{
          type: "text",
          text: `# ${template.name}\n\n${template.description}\n\n**Difficulty:** ${template.difficulty}\n\n**Suggested prompt:**\n"${template.prompt}"`,
        }],
      };
    }

    case "get_sdk_info": {
      return {
        content: [{
          type: "text",
          text: `# Highrise Python Bot SDK

**Current version:** highrise-bot-sdk==25.1.0
**Install:** \`pip install highrise-bot-sdk==25.1.0\`
**Python requirement:** 3.10+

**Launch command:**
\`python -m highrise main:YourBotClass <room_id> <api_token>\`

**Token:** Get from https://create.highrise.game/learn/bots/overview
**Room ID:** Found in the room's URL in the Highrise app
**Designer rights:** Bot user must be added as Designer in the room settings

**Key imports:**
\`\`\`python
from highrise import BaseBot, User, Position, Reaction, CurrencyItem, Item
from highrise.models import SessionMetadata
\`\`\``,
        }],
      };
    }

    case "list_bot_templates": {
      const list = HIGHRISE_BOT_TEMPLATES
        .map(t => `**${t.name}** (${t.id}) — ${t.difficulty}\n  ${t.description}`)
        .join("\n\n");
      return { content: [{ type: "text", text: `# Available Bot Templates\n\n${list}` }] };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[highrise-docs MCP] Server running on stdio");
