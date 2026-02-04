/**
 * Entity Memory Manager
 *
 * The main interface for the intelligent long-term memory system.
 * Provides automatic extraction, temporal-aware retrieval, and multi-agent support.
 */

import type { OpenClawConfig } from "../../config/config.js";
import type {
  MemoryEntity,
  MemoryQuery,
  MemorySearchResult,
  MemorySource,
  EntityMemoryConfig,
  ConsolidationResult,
  MemoryStoreStats,
  EntityType,
  ImportanceLevel,
} from "./types.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { extractFacts, processAndStoreFacts } from "./extraction.js";
import { EntityMemoryStore } from "./store.js";

const log = createSubsystemLogger("entity-memory");

// Global cache of managers per agent
const MANAGER_CACHE = new Map<string, EntityMemoryManager>();

// Consolidation interval timer
const CONSOLIDATION_TIMERS = new Map<string, NodeJS.Timeout>();

/**
 * EntityMemoryManager - Main interface for the intelligent memory system
 */
export class EntityMemoryManager {
  private readonly store: EntityMemoryStore;
  private readonly config: EntityMemoryConfig;
  private readonly agentId: string;
  private sessionUnsubscribe?: () => void;
  private consolidationTimer?: NodeJS.Timeout;
  private closed = false;

  private constructor(params: {
    store: EntityMemoryStore;
    config: EntityMemoryConfig;
    agentId: string;
  }) {
    this.store = params.store;
    this.config = params.config;
    this.agentId = params.agentId;
  }

  /**
   * Get or create an EntityMemoryManager for an agent
   */
  static async get(params: {
    cfg?: OpenClawConfig;
    agentId: string;
    config?: Partial<EntityMemoryConfig>;
  }): Promise<EntityMemoryManager> {
    const { agentId, cfg } = params;

    // Check cache
    const cached = MANAGER_CACHE.get(agentId);
    if (cached && !cached.closed) {
      return cached;
    }

    // Create store
    const store = EntityMemoryStore.create({
      agentId,
      agentDir: cfg ? resolveAgentDir(cfg, agentId) : undefined,
      dbPath: params.config?.dbPath,
    });

    // Merge config with defaults
    const config: EntityMemoryConfig = {
      autoExtract: params.config?.autoExtract ?? true,
      extractionModel: params.config?.extractionModel,
      enableConsolidation: params.config?.enableConsolidation ?? true,
      consolidationIntervalMinutes: params.config?.consolidationIntervalMinutes ?? 60,
      consolidationThreshold: params.config?.consolidationThreshold ?? 1000,
      enableTemporalDecay: params.config?.enableTemporalDecay ?? true,
      decayRatePerDay: params.config?.decayRatePerDay ?? 0.02,
      decayFloor: params.config?.decayFloor ?? 0.1,
      enableSharing: params.config?.enableSharing ?? true,
      defaultShared: params.config?.defaultShared ?? false,
      embeddingProvider: params.config?.embeddingProvider ?? "auto",
      embeddingModel: params.config?.embeddingModel,
      maxContextTokens: params.config?.maxContextTokens ?? 2000,
      backgroundIndexing: params.config?.backgroundIndexing ?? true,
    };

    const manager = new EntityMemoryManager({ store, config, agentId });

    // Setup auto-extraction from sessions if enabled
    if (config.autoExtract) {
      manager.setupSessionListener();
    }

    // Setup consolidation timer if enabled
    if (config.enableConsolidation) {
      manager.setupConsolidationTimer();
    }

    // Cache the manager
    MANAGER_CACHE.set(agentId, manager);

    log.debug("Entity memory manager created", { agentId });
    return manager;
  }

  /**
   * Store a new memory
   */
  async remember(params: {
    type: EntityType;
    content: string;
    attributes?: Record<string, unknown>;
    importance?: ImportanceLevel;
    confidence?: number;
    source?: Partial<MemorySource>;
    tags?: string[];
    relevantFrom?: number;
    relevantUntil?: number;
    shared?: boolean;
  }): Promise<MemoryEntity> {
    const now = Date.now();
    const source: MemorySource = {
      type: params.source?.type ?? "user_input",
      sessionKey: params.source?.sessionKey,
      filePath: params.source?.filePath,
      messageId: params.source?.messageId,
      creatorAgentId: params.source?.creatorAgentId ?? this.agentId,
      sourceTimestamp: params.source?.sourceTimestamp ?? now,
    };

    return this.store.store({
      type: params.type,
      content: params.content,
      attributes: params.attributes,
      importance: params.importance,
      confidence: params.confidence,
      source,
      tags: params.tags,
      temporal: {
        relevantFrom: params.relevantFrom,
        relevantUntil: params.relevantUntil,
      },
      shared: params.shared ?? this.config.defaultShared,
    });
  }

  /**
   * Search memories with intelligent ranking
   */
  async recall(params: {
    query?: string;
    types?: EntityType[];
    tags?: string[];
    importance?: ImportanceLevel[];
    timeRange?: { from?: number; to?: number };
    relevantNow?: boolean;
    sessionKey?: string;
    limit?: number;
    includeShared?: boolean;
  }): Promise<MemorySearchResult[]> {
    const query: MemoryQuery = {
      query: params.query,
      types: params.types,
      tags: params.tags,
      importance: params.importance,
      timeRange: params.timeRange,
      relevantAt: params.relevantNow ? Date.now() : undefined,
      agentId: this.agentId,
      includeShared: params.includeShared ?? this.config.enableSharing,
      sessionKey: params.sessionKey,
      limit: params.limit ?? 10,
      sortBy: params.query ? "relevance" : "recency",
    };

    return this.store.search(query);
  }

  /**
   * Get memory by ID
   */
  get(id: string): MemoryEntity | null {
    return this.store.get(id);
  }

  /**
   * Update a memory
   */
  async update(
    id: string,
    updates: Partial<{
      content: string;
      attributes: Record<string, unknown>;
      importance: ImportanceLevel;
      confidence: number;
      tags: string[];
      relevantFrom: number;
      relevantUntil: number;
      shared: boolean;
    }>,
  ): Promise<MemoryEntity> {
    return this.store.update(id, {
      content: updates.content,
      attributes: updates.attributes,
      importance: updates.importance,
      confidence: updates.confidence,
      tags: updates.tags,
      temporal: {
        relevantFrom: updates.relevantFrom,
        relevantUntil: updates.relevantUntil,
      },
      shared: updates.shared,
    });
  }

  /**
   * Delete a memory
   */
  forget(id: string): boolean {
    return this.store.delete(id);
  }

  /**
   * Find memories related to a given memory
   */
  findRelated(entityId: string, maxDepth?: number): MemoryEntity[] {
    return this.store.findRelated(entityId, maxDepth);
  }

  /**
   * Process a conversation message and extract memories
   */
  async processMessage(params: {
    content: string;
    role: "user" | "assistant";
    sessionKey: string;
    messageId?: string;
  }): Promise<void> {
    if (!this.config.autoExtract) {
      return;
    }

    const now = Date.now();
    const source: MemorySource = {
      type: "conversation",
      sessionKey: params.sessionKey,
      messageId: params.messageId,
      creatorAgentId: this.agentId,
      sourceTimestamp: now,
    };

    // Extract facts from the message
    const facts = extractFacts({
      content: params.content,
      role: params.role,
      timestamp: now,
      sessionKey: params.sessionKey,
    });

    // Store extracted facts
    await processAndStoreFacts({
      store: this.store,
      facts,
      source,
      agentId: this.agentId,
    });
  }

  /**
   * Get relevant context for a conversation
   * Returns formatted context suitable for including in agent prompts
   */
  async getRelevantContext(params: {
    query?: string;
    sessionKey?: string;
    maxTokens?: number;
  }): Promise<string> {
    const maxTokens = params.maxTokens ?? this.config.maxContextTokens;

    // Search for relevant memories
    const results = await this.recall({
      query: params.query,
      sessionKey: params.sessionKey,
      relevantNow: true,
      limit: 20,
      includeShared: true,
    });

    if (results.length === 0) {
      return "";
    }

    // Build context string with token budget
    const lines: string[] = ["## Relevant Memories"];
    let estimatedTokens = 10; // Header tokens

    for (const result of results) {
      const entity = result.entity;
      const line = this.formatMemoryForContext(entity);
      const lineTokens = Math.ceil(line.length / 4); // Rough estimate

      if (estimatedTokens + lineTokens > maxTokens) {
        break;
      }

      lines.push(line);
      estimatedTokens += lineTokens;
    }

    if (lines.length === 1) {
      return "";
    }

    return lines.join("\n");
  }

  /**
   * Run memory consolidation
   */
  async consolidate(): Promise<ConsolidationResult> {
    const startTime = Date.now();
    let processed = 0;
    let merged = 0;
    let archived = 0;
    let updated = 0;

    try {
      // Apply temporal decay if enabled
      if (this.config.enableTemporalDecay) {
        const decayed = await this.applyTemporalDecay();
        updated += decayed;
      }

      // Merge similar memories
      const mergeResult = await this.mergeSimilarMemories();
      merged = mergeResult.merged;
      processed += mergeResult.processed;

      // Archive old, low-importance memories
      const archiveResult = await this.archiveOldMemories();
      archived = archiveResult.archived;
      processed += archiveResult.processed;

      const durationMs = Date.now() - startTime;
      log.info("Memory consolidation complete", {
        agentId: this.agentId,
        processed,
        merged,
        archived,
        updated,
        durationMs,
      });

      return { processed, merged, archived, updated, durationMs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Memory consolidation failed", { agentId: this.agentId, error: message });
      throw err;
    }
  }

  /**
   * Get store statistics
   */
  getStats(): MemoryStoreStats {
    return this.store.getStats();
  }

  /**
   * Close the manager
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;

    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
    }

    if (this.consolidationTimer) {
      clearInterval(this.consolidationTimer);
      CONSOLIDATION_TIMERS.delete(this.agentId);
    }

    this.store.close();
    MANAGER_CACHE.delete(this.agentId);

    log.debug("Entity memory manager closed", { agentId: this.agentId });
  }

  // Private methods

  private setupSessionListener(): void {
    // Session transcript update only provides the file path, not individual messages.
    // Auto-extraction from sessions requires reading and parsing JSONL transcript files,
    // which would add significant complexity and I/O overhead.
    // For now, auto-extraction is triggered via explicit processMessage() calls
    // from the agent runtime or message handlers.
    this.sessionUnsubscribe = onSessionTranscriptUpdate((update) => {
      if (this.closed) {
        return;
      }

      // Check if this session file belongs to this agent
      const sessionFile = update.sessionFile;
      if (!sessionFile?.includes(this.agentId)) {
        return;
      }

      // Log that we received an update but won't auto-extract
      log.debug("Session transcript updated (auto-extraction disabled)", {
        agentId: this.agentId,
        sessionFile,
      });
    });
  }

  private setupConsolidationTimer(): void {
    const intervalMs = this.config.consolidationIntervalMinutes * 60 * 1000;

    this.consolidationTimer = setInterval(() => {
      const stats = this.getStats();
      if (stats.totalMemories >= this.config.consolidationThreshold) {
        void this.consolidate().catch((err) => {
          log.warn(`Scheduled consolidation failed: ${err}`);
        });
      }
    }, intervalMs);

    CONSOLIDATION_TIMERS.set(this.agentId, this.consolidationTimer);
  }

  private formatMemoryForContext(entity: MemoryEntity): string {
    const typeEmoji = this.getTypeEmoji(entity.type);
    const importance = entity.importance === "critical" || entity.importance === "high" ? "!" : "";
    const age = this.formatAge(entity.temporal.createdAt);

    let line = `${typeEmoji}${importance} ${entity.content}`;

    // Add relevant attributes (safely convert unknown values to strings)
    const email = entity.attributes.email;
    if (entity.type === "person" && typeof email === "string") {
      line += ` (${email})`;
    }
    const status = entity.attributes.status;
    if (entity.type === "task" && typeof status === "string") {
      line += ` [${status}]`;
    }
    const sentiment = entity.attributes.sentiment;
    if (entity.type === "preference" && typeof sentiment === "string") {
      line += ` (${sentiment})`;
    }

    line += ` (${age})`;
    return line;
  }

  private getTypeEmoji(type: EntityType): string {
    const emojis: Record<EntityType, string> = {
      person: "👤",
      event: "📅",
      preference: "❤️",
      task: "☐",
      fact: "ℹ️",
      relationship: "🔗",
      location: "📍",
      organization: "🏢",
      topic: "💬",
      decision: "✓",
      custom: "•",
    };
    return emojis[type] ?? "•";
  }

  private formatAge(timestamp: number): string {
    const ageMs = Date.now() - timestamp;
    const minutes = Math.floor(ageMs / 60000);
    const hours = Math.floor(ageMs / 3600000);
    const days = Math.floor(ageMs / 86400000);

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

  /**
   * Apply temporal decay to memories based on age.
   * Updates decay_factor in the database using exponential decay.
   * decay_factor = max(decayFloor, exp(-decayRate * ageDays))
   */
  private async applyTemporalDecay(): Promise<number> {
    const { decayRatePerDay, decayFloor } = this.config;
    const now = Date.now();
    const msPerDay = 24 * 60 * 60 * 1000;

    // Get all memories that need decay updates (those with decay_factor > decayFloor)
    // We access the store's db through a helper method
    const memories = await this.store.findMemoriesForDecay({
      minDecayFactor: decayFloor + 0.001, // Only update those above floor
      limit: 500, // Process in batches
    });

    let updated = 0;
    for (const memory of memories) {
      const ageDays = (now - memory.createdAt) / msPerDay;
      // Exponential decay: decay_factor = exp(-rate * age)
      const newDecayFactor = Math.max(decayFloor, Math.exp(-decayRatePerDay * ageDays));

      // Only update if there's a meaningful change
      if (Math.abs(memory.decayFactor - newDecayFactor) > 0.01) {
        await this.store.updateDecayFactor(memory.id, newDecayFactor);
        updated++;
      }
    }

    log.debug("Applied temporal decay", { agentId: this.agentId, updated, total: memories.length });
    return updated;
  }

  /**
   * Find and merge similar memories to reduce redundancy.
   * Groups memories by type and content similarity, keeping the most important one.
   */
  private async mergeSimilarMemories(): Promise<{ merged: number; processed: number }> {
    let merged = 0;
    let processed = 0;

    // Get memories grouped by type and content hash prefix (first 8 chars)
    const duplicateCandidates = await this.store.findDuplicateCandidates({
      limit: 100,
    });

    for (const group of duplicateCandidates) {
      if (group.memories.length < 2) {
        continue;
      }

      processed += group.memories.length;

      // Sort by importance (highest first), then by confidence, then by most recent
      const sorted = [...group.memories].toSorted((a, b) => {
        const importanceOrder = { critical: 5, high: 4, medium: 3, low: 2, background: 1 };
        const impDiff = (importanceOrder[b.importance] ?? 0) - (importanceOrder[a.importance] ?? 0);
        if (impDiff !== 0) {
          return impDiff;
        }

        const confDiff = b.confidence - a.confidence;
        if (Math.abs(confDiff) > 0.1) {
          return confDiff;
        }

        return b.updatedAt - a.updatedAt;
      });

      // Keep the first (best) one, merge info from others
      const keeper = sorted[0];
      const toMerge = sorted.slice(1);

      // Merge tags and attributes from duplicates into keeper
      const mergedTags = new Set(keeper.tags);
      let mergedAttributes = { ...keeper.attributes };

      for (const dup of toMerge) {
        for (const tag of dup.tags) {
          mergedTags.add(tag);
        }
        mergedAttributes = { ...mergedAttributes, ...dup.attributes };

        // Create a "supersedes" relation before deleting
        this.store.addRelation(keeper.id, dup.id, "supersedes", 1.0);

        // Delete the duplicate
        this.store.delete(dup.id);
        merged++;
      }

      // Update keeper with merged data if we had duplicates
      if (toMerge.length > 0) {
        await this.update(keeper.id, {
          tags: [...mergedTags],
          attributes: mergedAttributes,
        });
      }
    }

    log.debug("Merged similar memories", { agentId: this.agentId, merged, processed });
    return { merged, processed };
  }

  /**
   * Archive (delete) old, low-importance memories that haven't been accessed recently.
   * This helps keep the database clean and performant.
   */
  private async archiveOldMemories(): Promise<{ archived: number; processed: number }> {
    const now = Date.now();
    const msPerDay = 24 * 60 * 60 * 1000;

    // Archive criteria:
    // - Low or background importance
    // - Not accessed in the last 60 days
    // - Created more than 90 days ago
    // - Decay factor at floor
    const ageThresholdDays = 90;
    const accessThresholdDays = 60;

    const candidates = await this.store.findArchiveCandidates({
      maxImportance: ["low", "background"],
      createdBefore: now - ageThresholdDays * msPerDay,
      lastAccessedBefore: now - accessThresholdDays * msPerDay,
      maxDecayFactor: this.config.decayFloor + 0.05,
      limit: 200,
    });

    let archived = 0;
    for (const memory of candidates) {
      // Log the archival to consolidation log for audit purposes
      await this.store.logConsolidationAction({
        entityId: memory.id,
        action: "archive",
        reason: "old_low_importance",
        timestamp: now,
      });

      this.store.delete(memory.id);
      archived++;
    }

    log.debug("Archived old memories", {
      agentId: this.agentId,
      archived,
      processed: candidates.length,
    });
    return { archived, processed: candidates.length };
  }
}

/**
 * Convenience function to get memory manager for an agent
 */
export async function getEntityMemoryManager(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  config?: Partial<EntityMemoryConfig>;
}): Promise<EntityMemoryManager> {
  return EntityMemoryManager.get(params);
}

/**
 * Close all cached managers (for cleanup)
 */
export function closeAllEntityMemoryManagers(): void {
  for (const manager of MANAGER_CACHE.values()) {
    manager.close();
  }
  MANAGER_CACHE.clear();

  for (const timer of CONSOLIDATION_TIMERS.values()) {
    clearInterval(timer);
  }
  CONSOLIDATION_TIMERS.clear();
}
