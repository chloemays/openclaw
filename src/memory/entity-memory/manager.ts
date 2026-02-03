/**
 * Entity Memory Manager
 *
 * The main interface for the intelligent long-term memory system.
 * Provides automatic extraction, temporal-aware retrieval, and multi-agent support.
 */

import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  MemoryEntity,
  MemoryQuery,
  MemorySearchResult,
  MemorySource,
  EntityMemoryConfig,
  DEFAULT_ENTITY_MEMORY_CONFIG,
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
    if (!this.config.autoExtract) return;

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
    if (this.closed) return;
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
    this.sessionUnsubscribe = onSessionTranscriptUpdate(async (update) => {
      if (this.closed) return;

      // Only process updates for this agent's sessions
      const sessionKey = update.sessionKey;
      if (!sessionKey?.includes(this.agentId)) return;

      // Process the message
      const message = update.message;
      if (!message || typeof message !== "object") return;

      const role = (message as { role?: string }).role;
      const content = (message as { content?: unknown }).content;

      if (role !== "user" && role !== "assistant") return;
      if (!content) return;

      // Extract text content
      let textContent: string;
      if (typeof content === "string") {
        textContent = content;
      } else if (Array.isArray(content)) {
        textContent = content
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("\n");
      } else {
        return;
      }

      if (!textContent.trim()) return;

      try {
        await this.processMessage({
          content: textContent,
          role,
          sessionKey,
        });
      } catch (err) {
        log.warn(`Failed to process message for memory extraction: ${err}`);
      }
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

    // Add relevant attributes
    if (entity.type === "person" && entity.attributes.email) {
      line += ` (${entity.attributes.email})`;
    }
    if (entity.type === "task" && entity.attributes.status) {
      line += ` [${entity.attributes.status}]`;
    }
    if (entity.type === "preference" && entity.attributes.sentiment) {
      line += ` (${entity.attributes.sentiment})`;
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

    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  private async applyTemporalDecay(): Promise<number> {
    // This would update decay_factor in the database based on age
    // For now, return 0 as placeholder
    return 0;
  }

  private async mergeSimilarMemories(): Promise<{ merged: number; processed: number }> {
    // This would find and merge duplicate/similar memories
    // For now, return placeholder
    return { merged: 0, processed: 0 };
  }

  private async archiveOldMemories(): Promise<{ archived: number; processed: number }> {
    // This would archive old, low-importance memories
    // For now, return placeholder
    return { archived: 0, processed: 0 };
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
