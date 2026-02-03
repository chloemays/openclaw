/**
 * Entity Memory System Types
 *
 * This module defines the core types for the intelligent long-term memory system
 * that automatically extracts, stores, and retrieves structured information about
 * people, events, preferences, tasks, and more.
 */

/**
 * Memory entity types that can be automatically extracted and stored
 */
export type EntityType =
  | "person" // People the agent interacts with or learns about
  | "event" // Events, meetings, appointments, occurrences
  | "preference" // User preferences, likes, dislikes
  | "task" // Tasks, todos, action items
  | "fact" // General facts and information
  | "relationship" // Relationships between entities
  | "location" // Places, addresses, locations
  | "organization" // Companies, teams, groups
  | "topic" // Topics of interest, subjects discussed
  | "decision" // Decisions made, choices, conclusions
  | "custom"; // Custom entity types

/**
 * Temporal context for a memory - when it's relevant
 */
export type TemporalContext = {
  /** When the memory was created */
  createdAt: number;
  /** When the memory was last accessed */
  lastAccessedAt: number;
  /** When the memory was last updated */
  updatedAt: number;
  /** Optional: when this memory becomes relevant (future events) */
  relevantFrom?: number;
  /** Optional: when this memory expires or becomes less relevant */
  relevantUntil?: number;
  /** Optional: recurring pattern (e.g., "daily", "weekly", "monthly") */
  recurrence?: string;
  /** Optional: specific date/time references extracted from the content */
  dateReferences?: DateReference[];
};

/**
 * A date reference extracted from content
 */
export type DateReference = {
  /** The original text that was parsed */
  originalText: string;
  /** The parsed timestamp (may be approximate) */
  timestamp: number;
  /** Confidence in the parsing (0-1) */
  confidence: number;
  /** Type of reference: absolute, relative, recurring */
  type: "absolute" | "relative" | "recurring";
};

/**
 * Importance level for memory prioritization
 */
export type ImportanceLevel = "critical" | "high" | "medium" | "low" | "background";

/**
 * A single memory entity stored in the system
 */
export type MemoryEntity = {
  /** Unique identifier for the memory */
  id: string;
  /** Type of entity */
  type: EntityType;
  /** Primary content/description of the memory */
  content: string;
  /** Extracted key facts or attributes */
  attributes: Record<string, unknown>;
  /** Temporal context */
  temporal: TemporalContext;
  /** Importance level */
  importance: ImportanceLevel;
  /** Confidence score (0-1) - how certain we are about this memory */
  confidence: number;
  /** Source of the memory (session ID, file path, etc.) */
  source: MemorySource;
  /** Related entity IDs */
  relations: MemoryRelation[];
  /** Tags for categorization */
  tags: string[];
  /** Embedding vector for semantic search (optional, computed lazily) */
  embedding?: number[];
  /** Hash of content for deduplication */
  contentHash: string;
  /** Version for optimistic concurrency */
  version: number;
  /** Agent ID that owns this memory */
  agentId: string;
  /** Whether this memory is shared across agents */
  shared: boolean;
};

/**
 * Source of a memory
 */
export type MemorySource = {
  /** Type of source */
  type: "conversation" | "file" | "extraction" | "user_input" | "system" | "consolidation";
  /** Session key if from a conversation */
  sessionKey?: string;
  /** File path if from a file */
  filePath?: string;
  /** Message ID if from a specific message */
  messageId?: string;
  /** Agent ID that created this memory */
  creatorAgentId: string;
  /** Timestamp of the source */
  sourceTimestamp: number;
};

/**
 * Relationship between memory entities
 */
export type MemoryRelation = {
  /** ID of the related entity */
  targetId: string;
  /** Type of relationship */
  relationType:
    | "mentions"
    | "about"
    | "relates_to"
    | "contradicts"
    | "supersedes"
    | "part_of"
    | "caused_by"
    | "results_in"
    | "same_as"
    | "similar_to";
  /** Strength of the relationship (0-1) */
  strength: number;
  /** When the relationship was established */
  establishedAt: number;
};

/**
 * Query for searching memories
 */
export type MemoryQuery = {
  /** Free-text search query */
  query?: string;
  /** Filter by entity types */
  types?: EntityType[];
  /** Filter by tags */
  tags?: string[];
  /** Filter by importance levels */
  importance?: ImportanceLevel[];
  /** Filter by time range */
  timeRange?: {
    from?: number;
    to?: number;
  };
  /** Filter by temporal relevance (memories relevant at this time) */
  relevantAt?: number;
  /** Filter by agent ID */
  agentId?: string;
  /** Include shared memories */
  includeShared?: boolean;
  /** Filter by source type */
  sourceType?: MemorySource["type"];
  /** Filter by session key */
  sessionKey?: string;
  /** Minimum confidence score */
  minConfidence?: number;
  /** Maximum results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Sort order */
  sortBy?: "relevance" | "recency" | "importance" | "access_count";
  /** Sort direction */
  sortDirection?: "asc" | "desc";
};

/**
 * Result of a memory search
 */
export type MemorySearchResult = {
  /** The memory entity */
  entity: MemoryEntity;
  /** Relevance score (0-1) */
  relevanceScore: number;
  /** Temporal relevance score (0-1) */
  temporalScore: number;
  /** Combined score */
  combinedScore: number;
  /** Snippet of the content that matched */
  matchedSnippet?: string;
  /** Related memories that were also returned */
  relatedMemories?: MemoryEntity[];
};

/**
 * Facts extracted from a conversation message
 */
export type ExtractedFacts = {
  /** People mentioned or discussed */
  people: Array<{
    name: string;
    attributes: Record<string, unknown>;
    context: string;
  }>;
  /** Events mentioned */
  events: Array<{
    description: string;
    when?: DateReference;
    where?: string;
    who?: string[];
  }>;
  /** Preferences expressed */
  preferences: Array<{
    subject: string;
    sentiment: "positive" | "negative" | "neutral";
    strength: number;
    context: string;
  }>;
  /** Tasks or action items */
  tasks: Array<{
    description: string;
    assignee?: string;
    dueDate?: DateReference;
    priority?: ImportanceLevel;
    status: "pending" | "in_progress" | "completed" | "cancelled";
  }>;
  /** General facts */
  facts: Array<{
    statement: string;
    subject?: string;
    confidence: number;
    temporal?: DateReference;
  }>;
  /** Decisions made */
  decisions: Array<{
    decision: string;
    reasoning?: string;
    alternatives?: string[];
    madeBy?: string;
    madeAt?: DateReference;
  }>;
};

/**
 * Configuration for the entity memory system
 */
export type EntityMemoryConfig = {
  /** Enable automatic fact extraction */
  autoExtract: boolean;
  /** Model to use for extraction (if using LLM-based extraction) */
  extractionModel?: string;
  /** Enable memory consolidation */
  enableConsolidation: boolean;
  /** Consolidation interval in minutes */
  consolidationIntervalMinutes: number;
  /** Maximum memories before consolidation triggers */
  consolidationThreshold: number;
  /** Enable temporal decay (reduce importance over time) */
  enableTemporalDecay: boolean;
  /** Decay rate per day (0-1) */
  decayRatePerDay: number;
  /** Minimum importance before decay stops */
  decayFloor: number;
  /** Enable cross-agent memory sharing */
  enableSharing: boolean;
  /** Default sharing policy */
  defaultShared: boolean;
  /** Embedding provider for semantic search */
  embeddingProvider: "openai" | "local" | "gemini" | "auto";
  /** Embedding model */
  embeddingModel?: string;
  /** Database path */
  dbPath?: string;
  /** Maximum context tokens to include in agent prompts */
  maxContextTokens: number;
  /** Enable background indexing */
  backgroundIndexing: boolean;
};

/**
 * Default configuration
 */
export const DEFAULT_ENTITY_MEMORY_CONFIG: EntityMemoryConfig = {
  autoExtract: true,
  enableConsolidation: true,
  consolidationIntervalMinutes: 60,
  consolidationThreshold: 1000,
  enableTemporalDecay: true,
  decayRatePerDay: 0.02,
  decayFloor: 0.1,
  enableSharing: true,
  defaultShared: false,
  embeddingProvider: "auto",
  maxContextTokens: 2000,
  backgroundIndexing: true,
};

/**
 * Memory consolidation result
 */
export type ConsolidationResult = {
  /** Number of memories processed */
  processed: number;
  /** Number of memories merged */
  merged: number;
  /** Number of memories archived */
  archived: number;
  /** Number of memories updated */
  updated: number;
  /** Duration in milliseconds */
  durationMs: number;
};

/**
 * Statistics about the memory store
 */
export type MemoryStoreStats = {
  /** Total number of memories */
  totalMemories: number;
  /** Memories by type */
  byType: Record<EntityType, number>;
  /** Memories by importance */
  byImportance: Record<ImportanceLevel, number>;
  /** Average confidence score */
  avgConfidence: number;
  /** Number of shared memories */
  sharedMemories: number;
  /** Database size in bytes */
  dbSizeBytes: number;
  /** Last consolidation timestamp */
  lastConsolidation?: number;
  /** Last sync timestamp */
  lastSync?: number;
};

/**
 * Lock state for multi-agent access
 */
export type MemoryLockState = {
  /** Lock ID */
  lockId: string;
  /** Agent ID holding the lock */
  agentId: string;
  /** Lock type */
  lockType: "read" | "write" | "exclusive";
  /** When the lock was acquired */
  acquiredAt: number;
  /** When the lock expires */
  expiresAt: number;
  /** Resource being locked */
  resource: string;
};
