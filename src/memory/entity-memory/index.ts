/**
 * Entity Memory System
 *
 * An intelligent long-term memory system that automatically extracts, stores,
 * and retrieves structured information about people, events, preferences,
 * tasks, and more.
 *
 * Features:
 * - Automatic fact extraction from conversations
 * - Time-aware storage and retrieval
 * - Multi-agent support with conflict resolution
 * - Semantic search with hybrid ranking
 * - Memory consolidation and decay
 *
 * Usage:
 * ```typescript
 * import { getEntityMemoryManager } from "./memory/entity-memory";
 *
 * const memory = await getEntityMemoryManager({ agentId: "my-agent" });
 *
 * // Store a memory
 * await memory.remember({
 *   type: "person",
 *   content: "John Smith",
 *   attributes: { email: "john@example.com" },
 *   importance: "high",
 * });
 *
 * // Search memories
 * const results = await memory.recall({
 *   query: "John",
 *   types: ["person"],
 *   relevantNow: true,
 * });
 *
 * // Get context for agent
 * const context = await memory.getRelevantContext({
 *   query: "meeting with John",
 *   maxTokens: 500,
 * });
 * ```
 */

export {
  EntityMemoryManager,
  getEntityMemoryManager,
  closeAllEntityMemoryManagers,
} from "./manager.js";

export { EntityMemoryStore } from "./store.js";

export { extractFacts, processAndStoreFacts } from "./extraction.js";

export {
  ensureEntityMemorySchema,
  ensureEntityVectorTable,
  cleanupExpiredLocks,
  cleanupOldAccessLogs,
  SCHEMA_VERSION,
} from "./schema.js";

export type {
  EntityType,
  TemporalContext,
  DateReference,
  ImportanceLevel,
  MemoryEntity,
  MemorySource,
  MemoryRelation,
  MemoryQuery,
  MemorySearchResult,
  ExtractedFacts,
  EntityMemoryConfig,
  ConsolidationResult,
  MemoryStoreStats,
  MemoryLockState,
} from "./types.js";

export { DEFAULT_ENTITY_MEMORY_CONFIG } from "./types.js";
