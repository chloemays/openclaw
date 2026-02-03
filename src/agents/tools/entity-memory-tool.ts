/**
 * Entity Memory Tool
 *
 * Provides agents with access to the intelligent long-term memory system.
 * Allows storing and retrieving structured information about people, events,
 * preferences, tasks, and more.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  EntityMemoryManager,
  getEntityMemoryManager,
  type EntityType,
  type ImportanceLevel,
  type MemorySearchResult,
} from "../../memory/entity-memory/index.js";

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

type RememberInput = Static<typeof RememberInputSchema>;
type RecallInput = Static<typeof RecallInputSchema>;
type ForgetInput = Static<typeof ForgetInputSchema>;
type UpdateInput = Static<typeof UpdateInputSchema>;

/**
 * Create the entity memory tools for an agent
 */
export function createEntityMemoryTools(params: {
  agentId: string;
  sessionKey?: string;
}): AgentTool[] {
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
      name: "memory_remember",
      description:
        "Store a new memory. Use this to remember important information about people, events, preferences, tasks, decisions, and other facts for future reference.",
      parameters: RememberInputSchema,
      execute: async (input: RememberInput): Promise<string> => {
        try {
          const manager = await getManager();

          const entity = await manager.remember({
            type: input.type as EntityType,
            content: input.content,
            attributes: input.attributes as Record<string, unknown> | undefined,
            importance: input.importance as ImportanceLevel | undefined,
            tags: input.tags,
            relevantFrom: input.relevantFrom,
            relevantUntil: input.relevantUntil,
            shared: input.shared,
            source: {
              type: "user_input",
              sessionKey,
              creatorAgentId: agentId,
            },
          });

          log.debug("Memory stored via tool", { id: entity.id, type: entity.type });

          return JSON.stringify({
            success: true,
            id: entity.id,
            message: `Remembered ${input.type}: "${input.content.slice(0, 50)}${input.content.length > 50 ? "..." : ""}"`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("Memory remember failed", { error: message });
          return JSON.stringify({ success: false, error: message });
        }
      },
    },

    // Recall tool
    {
      name: "memory_recall",
      description:
        "Search and retrieve stored memories. Use this to find previously stored information about people, events, preferences, tasks, and other facts.",
      parameters: RecallInputSchema,
      execute: async (input: RecallInput): Promise<string> => {
        try {
          const manager = await getManager();

          const results = await manager.recall({
            query: input.query,
            types: input.types as EntityType[] | undefined,
            tags: input.tags,
            importance: input.importance as ImportanceLevel[] | undefined,
            relevantNow: input.relevantNow,
            limit: input.limit,
            sessionKey,
          });

          if (results.length === 0) {
            return JSON.stringify({
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

          return JSON.stringify({
            success: true,
            memories: formattedResults,
            message: `Found ${results.length} memories.`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("Memory recall failed", { error: message });
          return JSON.stringify({ success: false, error: message });
        }
      },
    },

    // Forget tool
    {
      name: "memory_forget",
      description:
        "Delete a stored memory by its ID. Use this when a memory is no longer needed or was stored incorrectly.",
      parameters: ForgetInputSchema,
      execute: async (input: ForgetInput): Promise<string> => {
        try {
          const manager = await getManager();
          const deleted = manager.forget(input.id);

          if (deleted) {
            log.debug("Memory deleted via tool", { id: input.id });
            return JSON.stringify({
              success: true,
              message: `Memory ${input.id} has been deleted.`,
            });
          } else {
            return JSON.stringify({
              success: false,
              error: `Memory ${input.id} not found.`,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("Memory forget failed", { error: message });
          return JSON.stringify({ success: false, error: message });
        }
      },
    },

    // Update tool
    {
      name: "memory_update",
      description:
        "Update an existing memory by its ID. Use this to correct or add information to a previously stored memory.",
      parameters: UpdateInputSchema,
      execute: async (input: UpdateInput): Promise<string> => {
        try {
          const manager = await getManager();

          const updated = await manager.update(input.id, {
            content: input.content,
            importance: input.importance as ImportanceLevel | undefined,
            tags: input.tags,
            shared: input.shared,
          });

          log.debug("Memory updated via tool", { id: input.id });

          return JSON.stringify({
            success: true,
            id: updated.id,
            message: `Memory ${input.id} has been updated.`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("Memory update failed", { error: message });
          return JSON.stringify({ success: false, error: message });
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

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
