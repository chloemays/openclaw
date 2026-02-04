/**
 * Entity Memory Tool
 *
 * Provides agents with access to the intelligent long-term memory system.
 * Allows storing and retrieving structured information about people, events,
 * preferences, tasks, and more.
 */

import { Type } from "@sinclair/typebox";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  EntityMemoryManager,
  getEntityMemoryManager,
  type EntityType,
  type ImportanceLevel,
  type MemorySearchResult,
} from "../../memory/entity-memory/index.js";
import {
  jsonResult,
  readStringParam,
  readStringArrayParam,
  readNumberParam,
  type AnyAgentTool,
} from "./common.js";

const log = createSubsystemLogger("entity-memory-tool");

// Tool input schemas using TypeBox
const RememberInputSchema = Type.Object({
  type: Type.String({
    description:
      "Type of memory: person, event, preference, task, fact, relationship, location, organization, topic, decision, or custom",
  }),
  content: Type.String({
    description: "The main content or description of the memory",
  }),
  attributes: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Additional attributes as key-value pairs",
    }),
  ),
  importance: Type.Optional(
    Type.String({
      description: "Importance level: critical, high, medium, low, or background",
    }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tags for categorization",
    }),
  ),
  relevantFrom: Type.Optional(
    Type.Number({
      description: "Unix timestamp when this memory becomes relevant (for future events)",
    }),
  ),
  relevantUntil: Type.Optional(
    Type.Number({
      description: "Unix timestamp when this memory becomes less relevant",
    }),
  ),
  shared: Type.Optional(
    Type.Boolean({
      description: "Whether to share this memory with other agents",
    }),
  ),
});

const RecallInputSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description: "Search query to find relevant memories",
    }),
  ),
  types: Type.Optional(
    Type.Array(Type.String(), {
      description: "Filter by memory types",
    }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "Filter by tags",
    }),
  ),
  importance: Type.Optional(
    Type.Array(Type.String(), {
      description: "Filter by importance levels",
    }),
  ),
  relevantNow: Type.Optional(
    Type.Boolean({
      description: "Only return memories relevant at the current time",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of results to return (default: 10)",
    }),
  ),
});

const ForgetInputSchema = Type.Object({
  id: Type.String({
    description: "ID of the memory to delete",
  }),
});

const UpdateInputSchema = Type.Object({
  id: Type.String({
    description: "ID of the memory to update",
  }),
  content: Type.Optional(
    Type.String({
      description: "New content for the memory",
    }),
  ),
  importance: Type.Optional(
    Type.String({
      description: "New importance level",
    }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "New tags",
    }),
  ),
  shared: Type.Optional(
    Type.Boolean({
      description: "Whether to share this memory",
    }),
  ),
});

/**
 * Create the entity memory tools for an agent
 */
export function createEntityMemoryTools(params: {
  agentId: string;
  sessionKey?: string;
}): AnyAgentTool[] {
  const { agentId, sessionKey } = params;

  let managerPromise: Promise<EntityMemoryManager> | null = null;

  const getManager = async (): Promise<EntityMemoryManager> => {
    if (!managerPromise) {
      managerPromise = getEntityMemoryManager({ agentId });
    }
    return managerPromise;
  };

  return [
    // Remember tool
    {
      label: "Entity Memory - Remember",
      name: "memory_remember",
      description:
        "Store a new memory. Use this to remember important information about people, events, preferences, tasks, decisions, and other facts for future reference.",
      parameters: RememberInputSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Record<string, unknown>;
        try {
          const manager = await getManager();

          const type = readStringParam(params, "type", { required: true });
          const content = readStringParam(params, "content", { required: true });
          const attributes = params.attributes as Record<string, unknown> | undefined;
          const importance = readStringParam(params, "importance") as ImportanceLevel | undefined;
          const tags = readStringArrayParam(params, "tags");
          const relevantFrom = readNumberParam(params, "relevantFrom");
          const relevantUntil = readNumberParam(params, "relevantUntil");
          const shared = typeof params.shared === "boolean" ? params.shared : undefined;

          const entity = await manager.remember({
            type: type as EntityType,
            content,
            attributes,
            importance,
            tags,
            relevantFrom,
            relevantUntil,
            shared,
            source: {
              type: "user_input",
              sessionKey,
              creatorAgentId: agentId,
            },
          });

          log.debug("Memory stored via tool", { id: entity.id, type: entity.type });

          return jsonResult({
            success: true,
            id: entity.id,
            message: `Remembered ${type}: "${content.slice(0, 50)}${content.length > 50 ? "..." : ""}"`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("Memory remember failed", { error: message });
          return jsonResult({ success: false, error: message });
        }
      },
    },

    // Recall tool
    {
      label: "Entity Memory - Recall",
      name: "memory_recall",
      description:
        "Search and retrieve stored memories. Use this to find previously stored information about people, events, preferences, tasks, and other facts.",
      parameters: RecallInputSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Record<string, unknown>;
        try {
          const manager = await getManager();

          const query = readStringParam(params, "query");
          const types = readStringArrayParam(params, "types") as EntityType[] | undefined;
          const tags = readStringArrayParam(params, "tags");
          const importance = readStringArrayParam(params, "importance") as
            | ImportanceLevel[]
            | undefined;
          const relevantNow =
            typeof params.relevantNow === "boolean" ? params.relevantNow : undefined;
          const limit = readNumberParam(params, "limit", { integer: true });

          const results = await manager.recall({
            query,
            types,
            tags,
            importance,
            relevantNow,
            limit,
            sessionKey,
          });

          if (results.length === 0) {
            return jsonResult({
              success: true,
              memories: [],
              message: "No memories found matching the query.",
            });
          }

          const formattedResults = results.map((r) => ({
            id: r.entity.id,
            type: r.entity.type,
            content: r.entity.content,
            importance: r.entity.importance,
            confidence: r.entity.confidence,
            tags: r.entity.tags,
            attributes: r.entity.attributes,
            createdAt: new Date(r.entity.temporal.createdAt).toISOString(),
            score: r.combinedScore,
          }));

          log.debug("Memory recall via tool", { count: results.length });

          return jsonResult({
            success: true,
            memories: formattedResults,
            message: `Found ${results.length} memories.`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("Memory recall failed", { error: message });
          return jsonResult({ success: false, error: message });
        }
      },
    },

    // Forget tool
    {
      label: "Entity Memory - Forget",
      name: "memory_forget",
      description:
        "Delete a stored memory by its ID. Use this when a memory is no longer needed or was stored incorrectly.",
      parameters: ForgetInputSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Record<string, unknown>;
        try {
          const manager = await getManager();
          const id = readStringParam(params, "id", { required: true });
          const deleted = manager.forget(id);

          if (deleted) {
            log.debug("Memory deleted via tool", { id });
            return jsonResult({
              success: true,
              message: `Memory ${id} has been deleted.`,
            });
          } else {
            return jsonResult({
              success: false,
              error: `Memory ${id} not found.`,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("Memory forget failed", { error: message });
          return jsonResult({ success: false, error: message });
        }
      },
    },

    // Update tool
    {
      label: "Entity Memory - Update",
      name: "memory_update",
      description:
        "Update an existing memory by its ID. Use this to correct or add information to a previously stored memory.",
      parameters: UpdateInputSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Record<string, unknown>;
        try {
          const manager = await getManager();

          const id = readStringParam(params, "id", { required: true });
          const content = readStringParam(params, "content");
          const importance = readStringParam(params, "importance") as ImportanceLevel | undefined;
          const tags = readStringArrayParam(params, "tags");
          const shared = typeof params.shared === "boolean" ? params.shared : undefined;

          const updated = await manager.update(id, {
            content,
            importance,
            tags,
            shared,
          });

          log.debug("Memory updated via tool", { id });

          return jsonResult({
            success: true,
            id: updated.id,
            message: `Memory ${id} has been updated.`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("Memory update failed", { error: message });
          return jsonResult({ success: false, error: message });
        }
      },
    },
  ];
}

/**
 * Format memory search results for display
 */
export function formatMemoryResults(results: MemorySearchResult[]): string {
  if (results.length === 0) {
    return "No memories found.";
  }

  const lines = ["## Relevant Memories", ""];

  for (const result of results) {
    const entity = result.entity;
    const typeIcon = getTypeIcon(entity.type);
    const importanceMarker =
      entity.importance === "critical" || entity.importance === "high" ? " ⚠️" : "";
    const age = formatAge(entity.temporal.createdAt);

    let line = `${typeIcon}${importanceMarker} **${entity.content}**`;

    // Add key attributes
    const attrs: string[] = [];
    if (entity.attributes) {
      for (const [key, value] of Object.entries(entity.attributes)) {
        if (value && typeof value === "string") {
          attrs.push(`${key}: ${value}`);
        }
      }
    }
    if (attrs.length > 0) {
      line += ` (${attrs.slice(0, 2).join(", ")})`;
    }

    line += ` — _${age}_`;

    if (entity.tags.length > 0) {
      line += ` [${entity.tags.slice(0, 3).join(", ")}]`;
    }

    lines.push(line);
  }

  return lines.join("\n");
}

function getTypeIcon(type: EntityType): string {
  const icons: Record<EntityType, string> = {
    person: "👤",
    event: "📅",
    preference: "❤️",
    task: "☑️",
    fact: "💡",
    relationship: "🔗",
    location: "📍",
    organization: "🏢",
    topic: "💬",
    decision: "✅",
    custom: "📝",
  };
  return icons[type] ?? "📝";
}

function formatAge(timestamp: number): string {
  const ms = Date.now() - timestamp;
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(ms / 86400000);

  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  if (hours < 24) {
    return `${hours}h ago`;
  }
  if (days < 30) {
    return `${days}d ago`;
  }
  return `${Math.floor(days / 30)}mo ago`;
}
