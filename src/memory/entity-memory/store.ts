/**
 * Entity Memory Store
 *
 * Core storage implementation for the entity memory system.
 * Handles CRUD operations, temporal indexing, and multi-agent access.
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import path from "node:path";
import lockfile from "proper-lockfile";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { resolveUserPath } from "../../utils.js";
import { requireNodeSqlite } from "../sqlite.js";
import {
  ENTITY_TABLE,
  RELATIONS_TABLE,
  LOCKS_TABLE,
  ACCESS_LOG_TABLE,
  ENTITY_FTS_TABLE,
  ENTITY_VEC_TABLE,
  ensureEntityMemorySchema,
  cleanupExpiredLocks,
  ensureEntityVectorTable,
} from "./schema.js";
import type {
  MemoryEntity,
  MemoryQuery,
  MemorySearchResult,
  MemoryRelation,
  MemorySource,
  MemoryLockState,
  MemoryStoreStats,
  EntityType,
  ImportanceLevel,
  TemporalContext,
  EntityMemoryConfig,
  DEFAULT_ENTITY_MEMORY_CONFIG,
} from "./types.js";

const log = createSubsystemLogger("entity-memory");

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 60_000;
const DEFAULT_LOCK_DURATION_MS = 5_000;
const MAX_QUERY_RESULTS = 100;
const IMPORTANCE_WEIGHTS: Record<ImportanceLevel, number> = {
  critical: 1.0,
  high: 0.8,
  medium: 0.6,
  low: 0.4,
  background: 0.2,
};

/**
 * Compute content hash for deduplication
 */
function computeContentHash(content: string, type: EntityType): string {
  return createHash("sha256").update(`${type}:${content}`).digest("hex").slice(0, 32);
}

/**
 * Convert embedding array to blob for storage
 */
function embeddingToBlob(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

/**
 * Parse embedding from JSON string
 */
function parseEmbedding(embeddingJson: string | null): number[] | undefined {
  if (!embeddingJson) return undefined;
  try {
    return JSON.parse(embeddingJson) as number[];
  } catch {
    return undefined;
  }
}

/**
 * EntityMemoryStore - Core storage for structured memory entities
 */
export class EntityMemoryStore {
  private readonly db: DatabaseSync;
  private readonly agentId: string;
  private readonly dbPath: string;
  private readonly ftsAvailable: boolean;
  private vectorDims?: number;
  private closed = false;

  private constructor(params: {
    db: DatabaseSync;
    agentId: string;
    dbPath: string;
    ftsAvailable: boolean;
  }) {
    this.db = params.db;
    this.agentId = params.agentId;
    this.dbPath = params.dbPath;
    this.ftsAvailable = params.ftsAvailable;
  }

  /**
   * Create or get an EntityMemoryStore instance
   */
  static create(params: {
    agentId: string;
    dbPath?: string;
    agentDir?: string;
  }): EntityMemoryStore {
    const { agentId } = params;

    // Determine database path
    const dbPath = params.dbPath
      ? resolveUserPath(params.dbPath)
      : path.join(
          params.agentDir ?? resolveAgentDir(undefined, agentId),
          "memory",
          "entity-memory.sqlite",
        );

    // Ensure directory exists
    const dir = path.dirname(dbPath);
    const fs = require("node:fs");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open database
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath, { allowExtension: true });

    // Initialize schema
    const { ftsAvailable } = ensureEntityMemorySchema({ db, enableFts: true });

    log.debug("Entity memory store opened", { agentId, dbPath, ftsAvailable });

    return new EntityMemoryStore({ db, agentId, dbPath, ftsAvailable });
  }

  /**
   * Store a new memory entity
   */
  async store(params: {
    type: EntityType;
    content: string;
    attributes?: Record<string, unknown>;
    importance?: ImportanceLevel;
    confidence?: number;
    source: MemorySource;
    tags?: string[];
    temporal?: Partial<TemporalContext>;
    shared?: boolean;
    embedding?: number[];
    relations?: Array<{ targetId: string; relationType: MemoryRelation["relationType"]; strength?: number }>;
  }): Promise<MemoryEntity> {
    const now = Date.now();
    const id = randomUUID();
    const contentHash = computeContentHash(params.content, params.type);

    // Check for duplicates
    const existing = this.findByContentHash(contentHash, params.type);
    if (existing) {
      // Update existing instead of creating duplicate
      return this.update(existing.id, {
        attributes: { ...existing.attributes, ...params.attributes },
        confidence: Math.max(existing.confidence, params.confidence ?? 1.0),
        tags: [...new Set([...existing.tags, ...(params.tags ?? [])])],
      });
    }

    const entity: MemoryEntity = {
      id,
      type: params.type,
      content: params.content,
      attributes: params.attributes ?? {},
      temporal: {
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        ...params.temporal,
      },
      importance: params.importance ?? "medium",
      confidence: params.confidence ?? 1.0,
      source: params.source,
      relations: [],
      tags: params.tags ?? [],
      embedding: params.embedding,
      contentHash,
      version: 1,
      agentId: this.agentId,
      shared: params.shared ?? false,
    };

    // Insert entity
    this.db
      .prepare(
        `INSERT INTO ${ENTITY_TABLE} (
          id, type, content, attributes, importance, confidence, content_hash,
          version, agent_id, shared, tags, embedding,
          created_at, updated_at, last_accessed_at, relevant_from, relevant_until,
          recurrence, date_references,
          source_type, source_session_key, source_file_path, source_message_id,
          source_creator_agent_id, source_timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entity.id,
        entity.type,
        entity.content,
        JSON.stringify(entity.attributes),
        entity.importance,
        entity.confidence,
        entity.contentHash,
        entity.version,
        entity.agentId,
        entity.shared ? 1 : 0,
        JSON.stringify(entity.tags),
        entity.embedding ? JSON.stringify(entity.embedding) : null,
        entity.temporal.createdAt,
        entity.temporal.updatedAt,
        entity.temporal.lastAccessedAt,
        entity.temporal.relevantFrom ?? null,
        entity.temporal.relevantUntil ?? null,
        entity.temporal.recurrence ?? null,
        JSON.stringify(entity.temporal.dateReferences ?? []),
        entity.source.type,
        entity.source.sessionKey ?? null,
        entity.source.filePath ?? null,
        entity.source.messageId ?? null,
        entity.source.creatorAgentId,
        entity.source.sourceTimestamp,
      );

    // Insert into vector table if embedding provided
    if (entity.embedding && entity.embedding.length > 0) {
      await this.ensureVectorTable(entity.embedding.length);
      try {
        this.db
          .prepare(`INSERT INTO ${ENTITY_VEC_TABLE} (id, embedding) VALUES (?, ?)`)
          .run(entity.id, embeddingToBlob(entity.embedding));
      } catch (err) {
        log.debug(`Failed to insert vector: ${err}`);
      }
    }

    // Insert relations
    if (params.relations && params.relations.length > 0) {
      for (const rel of params.relations) {
        this.addRelation(entity.id, rel.targetId, rel.relationType, rel.strength);
      }
    }

    log.debug("Stored memory entity", { id: entity.id, type: entity.type });
    return entity;
  }

  /**
   * Get a memory entity by ID
   */
  get(id: string): MemoryEntity | null {
    const row = this.db.prepare(`SELECT * FROM ${ENTITY_TABLE} WHERE id = ?`).get(id) as
      | EntityRow
      | undefined;
    if (!row) return null;

    // Update access tracking
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE ${ENTITY_TABLE} SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?`,
      )
      .run(now, id);

    // Log access
    this.db
      .prepare(`INSERT INTO ${ACCESS_LOG_TABLE} (entity_id, agent_id, access_type, accessed_at) VALUES (?, ?, ?, ?)`)
      .run(id, this.agentId, "get", now);

    return this.rowToEntity(row);
  }

  /**
   * Update a memory entity
   */
  update(
    id: string,
    updates: Partial<{
      content: string;
      attributes: Record<string, unknown>;
      importance: ImportanceLevel;
      confidence: number;
      tags: string[];
      temporal: Partial<TemporalContext>;
      shared: boolean;
      embedding: number[];
    }>,
  ): MemoryEntity {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Memory entity not found: ${id}`);
    }

    const now = Date.now();
    const contentHash = updates.content
      ? computeContentHash(updates.content, existing.type)
      : existing.contentHash;

    const sets: string[] = ["updated_at = ?", "version = version + 1"];
    const values: unknown[] = [now];

    if (updates.content !== undefined) {
      sets.push("content = ?", "content_hash = ?");
      values.push(updates.content, contentHash);
    }
    if (updates.attributes !== undefined) {
      sets.push("attributes = ?");
      values.push(JSON.stringify({ ...existing.attributes, ...updates.attributes }));
    }
    if (updates.importance !== undefined) {
      sets.push("importance = ?");
      values.push(updates.importance);
    }
    if (updates.confidence !== undefined) {
      sets.push("confidence = ?");
      values.push(updates.confidence);
    }
    if (updates.tags !== undefined) {
      sets.push("tags = ?");
      values.push(JSON.stringify(updates.tags));
    }
    if (updates.shared !== undefined) {
      sets.push("shared = ?");
      values.push(updates.shared ? 1 : 0);
    }
    if (updates.embedding !== undefined) {
      sets.push("embedding = ?");
      values.push(JSON.stringify(updates.embedding));
    }
    if (updates.temporal !== undefined) {
      if (updates.temporal.relevantFrom !== undefined) {
        sets.push("relevant_from = ?");
        values.push(updates.temporal.relevantFrom);
      }
      if (updates.temporal.relevantUntil !== undefined) {
        sets.push("relevant_until = ?");
        values.push(updates.temporal.relevantUntil);
      }
      if (updates.temporal.recurrence !== undefined) {
        sets.push("recurrence = ?");
        values.push(updates.temporal.recurrence);
      }
      if (updates.temporal.dateReferences !== undefined) {
        sets.push("date_references = ?");
        values.push(JSON.stringify(updates.temporal.dateReferences));
      }
    }

    values.push(id);
    this.db.prepare(`UPDATE ${ENTITY_TABLE} SET ${sets.join(", ")} WHERE id = ?`).run(...values);

    // Update vector if embedding changed
    if (updates.embedding && updates.embedding.length > 0) {
      await this.ensureVectorTable(updates.embedding.length);
      try {
        this.db.prepare(`DELETE FROM ${ENTITY_VEC_TABLE} WHERE id = ?`).run(id);
        this.db
          .prepare(`INSERT INTO ${ENTITY_VEC_TABLE} (id, embedding) VALUES (?, ?)`)
          .run(id, embeddingToBlob(updates.embedding));
      } catch (err) {
        log.debug(`Failed to update vector: ${err}`);
      }
    }

    return this.get(id)!;
  }

  /**
   * Delete a memory entity
   */
  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM ${ENTITY_TABLE} WHERE id = ?`).run(id);

    // Also delete from vector table
    try {
      this.db.prepare(`DELETE FROM ${ENTITY_VEC_TABLE} WHERE id = ?`).run(id);
    } catch {}

    return result.changes > 0;
  }

  /**
   * Search memories with intelligent ranking
   */
  async search(query: MemoryQuery): Promise<MemorySearchResult[]> {
    const limit = Math.min(query.limit ?? 10, MAX_QUERY_RESULTS);
    const offset = query.offset ?? 0;
    const now = Date.now();

    // Build WHERE clause
    const conditions: string[] = [];
    const params: unknown[] = [];

    // Agent ID filter (own + shared)
    if (query.includeShared !== false) {
      conditions.push("(agent_id = ? OR shared = 1)");
      params.push(query.agentId ?? this.agentId);
    } else {
      conditions.push("agent_id = ?");
      params.push(query.agentId ?? this.agentId);
    }

    // Type filter
    if (query.types && query.types.length > 0) {
      conditions.push(`type IN (${query.types.map(() => "?").join(", ")})`);
      params.push(...query.types);
    }

    // Importance filter
    if (query.importance && query.importance.length > 0) {
      conditions.push(`importance IN (${query.importance.map(() => "?").join(", ")})`);
      params.push(...query.importance);
    }

    // Time range filter
    if (query.timeRange?.from) {
      conditions.push("created_at >= ?");
      params.push(query.timeRange.from);
    }
    if (query.timeRange?.to) {
      conditions.push("created_at <= ?");
      params.push(query.timeRange.to);
    }

    // Temporal relevance filter
    if (query.relevantAt) {
      conditions.push(
        "(relevant_from IS NULL OR relevant_from <= ?) AND (relevant_until IS NULL OR relevant_until >= ?)",
      );
      params.push(query.relevantAt, query.relevantAt);
    }

    // Source filter
    if (query.sourceType) {
      conditions.push("source_type = ?");
      params.push(query.sourceType);
    }
    if (query.sessionKey) {
      conditions.push("source_session_key = ?");
      params.push(query.sessionKey);
    }

    // Confidence filter
    if (query.minConfidence) {
      conditions.push("confidence >= ?");
      params.push(query.minConfidence);
    }

    // Tags filter (using JSON contains)
    if (query.tags && query.tags.length > 0) {
      for (const tag of query.tags) {
        conditions.push("tags LIKE ?");
        params.push(`%"${tag}"%`);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Determine sort order
    let orderBy: string;
    switch (query.sortBy) {
      case "recency":
        orderBy = "updated_at";
        break;
      case "importance":
        orderBy = `CASE importance
          WHEN 'critical' THEN 5
          WHEN 'high' THEN 4
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 2
          ELSE 1
        END`;
        break;
      case "access_count":
        orderBy = "access_count";
        break;
      default:
        orderBy = "updated_at"; // Default to recency
    }
    const direction = query.sortDirection === "asc" ? "ASC" : "DESC";

    // Execute query
    let rows: EntityRow[];
    let textScores: Map<string, number> | undefined;

    if (query.query && this.ftsAvailable) {
      // Use FTS for text search
      const ftsQuery = this.buildFtsQuery(query.query);
      if (ftsQuery) {
        rows = this.db
          .prepare(
            `SELECT e.*, bm25(${ENTITY_FTS_TABLE}) as text_score
             FROM ${ENTITY_TABLE} e
             JOIN ${ENTITY_FTS_TABLE} fts ON fts.id = e.id
             ${whereClause}
             AND ${ENTITY_FTS_TABLE} MATCH ?
             ORDER BY text_score
             LIMIT ? OFFSET ?`,
          )
          .all(...params, ftsQuery, limit, offset) as Array<EntityRow & { text_score: number }>;

        textScores = new Map(
          rows.map((r) => [r.id, Math.abs((r as { text_score?: number }).text_score ?? 0)]),
        );
      } else {
        rows = this.db
          .prepare(
            `SELECT * FROM ${ENTITY_TABLE} ${whereClause} ORDER BY ${orderBy} ${direction} LIMIT ? OFFSET ?`,
          )
          .all(...params, limit, offset) as EntityRow[];
      }
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM ${ENTITY_TABLE} ${whereClause} ORDER BY ${orderBy} ${direction} LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as EntityRow[];
    }

    // Convert to results with scoring
    const results: MemorySearchResult[] = rows.map((row) => {
      const entity = this.rowToEntity(row);

      // Calculate relevance score
      const textScore = textScores?.get(entity.id) ?? 0;
      const relevanceScore = this.calculateRelevanceScore(entity, textScore);

      // Calculate temporal score
      const temporalScore = this.calculateTemporalScore(entity, now);

      // Combined score
      const combinedScore = relevanceScore * 0.6 + temporalScore * 0.4;

      return {
        entity,
        relevanceScore,
        temporalScore,
        combinedScore,
        matchedSnippet: query.query ? this.extractMatchedSnippet(entity.content, query.query) : undefined,
      };
    });

    // Sort by combined score
    results.sort((a, b) => b.combinedScore - a.combinedScore);

    // Update access logs
    for (const result of results) {
      this.db
        .prepare(
          `INSERT INTO ${ACCESS_LOG_TABLE} (entity_id, agent_id, access_type, accessed_at, query_context) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(result.entity.id, this.agentId, "search", now, query.query ?? null);
    }

    return results;
  }

  /**
   * Find related memories
   */
  findRelated(entityId: string, maxDepth: number = 2): MemoryEntity[] {
    const visited = new Set<string>([entityId]);
    const results: MemoryEntity[] = [];

    const explore = (id: string, depth: number) => {
      if (depth > maxDepth) return;

      const relations = this.db
        .prepare(`SELECT target_id FROM ${RELATIONS_TABLE} WHERE source_id = ?`)
        .all(id) as Array<{ target_id: string }>;

      for (const rel of relations) {
        if (visited.has(rel.target_id)) continue;
        visited.add(rel.target_id);

        const entity = this.get(rel.target_id);
        if (entity) {
          results.push(entity);
          explore(rel.target_id, depth + 1);
        }
      }
    };

    explore(entityId, 1);
    return results;
  }

  /**
   * Add a relation between entities
   */
  addRelation(
    sourceId: string,
    targetId: string,
    relationType: MemoryRelation["relationType"],
    strength: number = 1.0,
  ): void {
    this.db
      .prepare(
        `INSERT INTO ${RELATIONS_TABLE} (source_id, target_id, relation_type, strength, established_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_id, target_id, relation_type) DO UPDATE SET strength = excluded.strength`,
      )
      .run(sourceId, targetId, relationType, strength, Date.now());
  }

  /**
   * Acquire a lock for multi-agent access
   */
  acquireLock(params: {
    resource: string;
    lockType: "read" | "write" | "exclusive";
    durationMs?: number;
  }): MemoryLockState | null {
    // Clean expired locks first
    cleanupExpiredLocks(this.db);

    const now = Date.now();
    const durationMs = params.durationMs ?? DEFAULT_LOCK_DURATION_MS;
    const expiresAt = now + durationMs;
    const lockId = randomUUID();

    // Check for conflicting locks
    const existingLocks = this.db
      .prepare(
        `SELECT * FROM ${LOCKS_TABLE} WHERE resource = ? AND expires_at > ?`,
      )
      .all(params.resource, now) as LockRow[];

    if (params.lockType === "exclusive" && existingLocks.length > 0) {
      return null; // Can't get exclusive if any locks exist
    }
    if (params.lockType === "write") {
      const hasExclusiveOrWrite = existingLocks.some(
        (l) => l.lock_type === "exclusive" || l.lock_type === "write",
      );
      if (hasExclusiveOrWrite) return null;
    }
    if (params.lockType === "read") {
      const hasExclusive = existingLocks.some((l) => l.lock_type === "exclusive");
      if (hasExclusive) return null;
    }

    // Acquire lock
    this.db
      .prepare(
        `INSERT INTO ${LOCKS_TABLE} (lock_id, agent_id, lock_type, resource, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(lockId, this.agentId, params.lockType, params.resource, now, expiresAt);

    return {
      lockId,
      agentId: this.agentId,
      lockType: params.lockType,
      resource: params.resource,
      acquiredAt: now,
      expiresAt,
    };
  }

  /**
   * Release a lock
   */
  releaseLock(lockId: string): boolean {
    const result = this.db.prepare(`DELETE FROM ${LOCKS_TABLE} WHERE lock_id = ?`).run(lockId);
    return result.changes > 0;
  }

  /**
   * Get store statistics
   */
  getStats(): MemoryStoreStats {
    const total = this.db.prepare(`SELECT COUNT(*) as count FROM ${ENTITY_TABLE}`).get() as { count: number };

    const byTypeRows = this.db
      .prepare(`SELECT type, COUNT(*) as count FROM ${ENTITY_TABLE} GROUP BY type`)
      .all() as Array<{ type: EntityType; count: number }>;
    const byType = Object.fromEntries(byTypeRows.map((r) => [r.type, r.count])) as Record<EntityType, number>;

    const byImportanceRows = this.db
      .prepare(`SELECT importance, COUNT(*) as count FROM ${ENTITY_TABLE} GROUP BY importance`)
      .all() as Array<{ importance: ImportanceLevel; count: number }>;
    const byImportance = Object.fromEntries(
      byImportanceRows.map((r) => [r.importance, r.count]),
    ) as Record<ImportanceLevel, number>;

    const avgConfidence = this.db
      .prepare(`SELECT AVG(confidence) as avg FROM ${ENTITY_TABLE}`)
      .get() as { avg: number | null };

    const sharedCount = this.db
      .prepare(`SELECT COUNT(*) as count FROM ${ENTITY_TABLE} WHERE shared = 1`)
      .get() as { count: number };

    const fs = require("node:fs");
    let dbSizeBytes = 0;
    try {
      const stat = fs.statSync(this.dbPath);
      dbSizeBytes = stat.size;
    } catch {}

    return {
      totalMemories: total.count,
      byType,
      byImportance,
      avgConfidence: avgConfidence.avg ?? 0,
      sharedMemories: sharedCount.count,
      dbSizeBytes,
    };
  }

  /**
   * Close the store
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    log.debug("Entity memory store closed", { agentId: this.agentId });
  }

  // Private helper methods

  private findByContentHash(hash: string, type: EntityType): MemoryEntity | null {
    const row = this.db
      .prepare(`SELECT * FROM ${ENTITY_TABLE} WHERE content_hash = ? AND type = ? LIMIT 1`)
      .get(hash, type) as EntityRow | undefined;
    return row ? this.rowToEntity(row) : null;
  }

  private async ensureVectorTable(dimensions: number): Promise<void> {
    if (this.vectorDims === dimensions) return;
    ensureEntityVectorTable({ db: this.db, dimensions });
    this.vectorDims = dimensions;
  }

  private buildFtsQuery(query: string): string | null {
    const cleaned = query
      .trim()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return null;
    return cleaned
      .split(" ")
      .map((term) => `"${term}"`)
      .join(" OR ");
  }

  private calculateRelevanceScore(entity: MemoryEntity, textScore: number): number {
    const importanceWeight = IMPORTANCE_WEIGHTS[entity.importance] ?? 0.5;
    const confidenceWeight = entity.confidence;
    const decayFactor = (entity as { decayFactor?: number }).decayFactor ?? 1.0;

    // Normalize text score (BM25 returns negative values where more negative = better match)
    const normalizedTextScore = textScore > 0 ? 1 / (1 + textScore) : 0.5;

    return (importanceWeight * 0.3 + confidenceWeight * 0.3 + normalizedTextScore * 0.4) * decayFactor;
  }

  private calculateTemporalScore(entity: MemoryEntity, now: number): number {
    const ageMs = now - entity.temporal.createdAt;
    const ageDays = ageMs / (24 * 60 * 60 * 1000);

    // Recency score (exponential decay)
    const recencyScore = Math.exp(-ageDays / 30); // Half-life of ~30 days

    // Relevance window score
    let windowScore = 1.0;
    if (entity.temporal.relevantFrom && now < entity.temporal.relevantFrom) {
      const daysUntilRelevant = (entity.temporal.relevantFrom - now) / (24 * 60 * 60 * 1000);
      windowScore = Math.max(0, 1 - daysUntilRelevant / 7); // Ramp up over 7 days
    }
    if (entity.temporal.relevantUntil && now > entity.temporal.relevantUntil) {
      const daysPastRelevant = (now - entity.temporal.relevantUntil) / (24 * 60 * 60 * 1000);
      windowScore = Math.max(0, 1 - daysPastRelevant / 7); // Ramp down over 7 days
    }

    // Access recency score
    const lastAccessMs = now - entity.temporal.lastAccessedAt;
    const accessRecencyScore = Math.exp(-lastAccessMs / (7 * 24 * 60 * 60 * 1000)); // Half-life of ~7 days

    return recencyScore * 0.4 + windowScore * 0.4 + accessRecencyScore * 0.2;
  }

  private extractMatchedSnippet(content: string, query: string): string {
    const queryTerms = query.toLowerCase().split(/\s+/);
    const sentences = content.split(/[.!?]+/);

    // Find sentence with most matches
    let bestSentence = sentences[0] ?? content.slice(0, 200);
    let bestScore = 0;

    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      const score = queryTerms.filter((term) => lower.includes(term)).length;
      if (score > bestScore) {
        bestScore = score;
        bestSentence = sentence;
      }
    }

    return bestSentence.trim().slice(0, 200);
  }

  private rowToEntity(row: EntityRow): MemoryEntity {
    return {
      id: row.id,
      type: row.type as EntityType,
      content: row.content,
      attributes: JSON.parse(row.attributes || "{}"),
      temporal: {
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastAccessedAt: row.last_accessed_at,
        relevantFrom: row.relevant_from ?? undefined,
        relevantUntil: row.relevant_until ?? undefined,
        recurrence: row.recurrence ?? undefined,
        dateReferences: JSON.parse(row.date_references || "[]"),
      },
      importance: row.importance as ImportanceLevel,
      confidence: row.confidence,
      source: {
        type: row.source_type as MemorySource["type"],
        sessionKey: row.source_session_key ?? undefined,
        filePath: row.source_file_path ?? undefined,
        messageId: row.source_message_id ?? undefined,
        creatorAgentId: row.source_creator_agent_id,
        sourceTimestamp: row.source_timestamp,
      },
      relations: this.getRelations(row.id),
      tags: JSON.parse(row.tags || "[]"),
      embedding: parseEmbedding(row.embedding),
      contentHash: row.content_hash,
      version: row.version,
      agentId: row.agent_id,
      shared: row.shared === 1,
    };
  }

  private getRelations(entityId: string): MemoryRelation[] {
    const rows = this.db
      .prepare(`SELECT * FROM ${RELATIONS_TABLE} WHERE source_id = ?`)
      .all(entityId) as RelationRow[];

    return rows.map((row) => ({
      targetId: row.target_id,
      relationType: row.relation_type as MemoryRelation["relationType"],
      strength: row.strength,
      establishedAt: row.established_at,
    }));
  }
}

// Type definitions for database rows
type EntityRow = {
  id: string;
  type: string;
  content: string;
  attributes: string;
  importance: string;
  confidence: number;
  content_hash: string;
  version: number;
  agent_id: string;
  shared: number;
  tags: string;
  embedding: string | null;
  created_at: number;
  updated_at: number;
  last_accessed_at: number;
  relevant_from: number | null;
  relevant_until: number | null;
  recurrence: string | null;
  date_references: string;
  source_type: string;
  source_session_key: string | null;
  source_file_path: string | null;
  source_message_id: string | null;
  source_creator_agent_id: string;
  source_timestamp: number;
  access_count: number;
  decay_factor: number;
};

type RelationRow = {
  id: number;
  source_id: string;
  target_id: string;
  relation_type: string;
  strength: number;
  established_at: number;
};

type LockRow = {
  lock_id: string;
  agent_id: string;
  lock_type: string;
  resource: string;
  acquired_at: number;
  expires_at: number;
};
