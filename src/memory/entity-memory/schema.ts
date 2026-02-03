/**
 * Entity Memory Database Schema
 *
 * Defines the SQLite schema for the entity memory system with support for:
 * - Structured entity storage
 * - Temporal indexing
 * - Multi-agent access with locking
 * - Relationship graphs
 * - Embedding vectors for semantic search
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("entity-memory");

export const ENTITY_TABLE = "entities";
export const RELATIONS_TABLE = "entity_relations";
export const LOCKS_TABLE = "entity_locks";
export const ENTITY_FTS_TABLE = "entities_fts";
export const ENTITY_VEC_TABLE = "entities_vec";
export const META_TABLE = "entity_meta";
export const ACCESS_LOG_TABLE = "entity_access_log";
export const CONSOLIDATION_LOG_TABLE = "consolidation_log";

/**
 * Schema version for migrations
 */
export const SCHEMA_VERSION = 1;

/**
 * Create all tables for the entity memory system
 */
export function ensureEntityMemorySchema(params: { db: DatabaseSync; enableFts?: boolean }): {
  ftsAvailable: boolean;
  ftsError?: string;
} {
  const { db, enableFts = true } = params;

  // Meta table for schema version and configuration
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${META_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Check and perform migrations if needed
  const currentVersion = getSchemaVersion(db);
  if (currentVersion < SCHEMA_VERSION) {
    migrateSchema(db, currentVersion, SCHEMA_VERSION);
  }

  // Main entities table
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ENTITY_TABLE} (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      attributes TEXT NOT NULL DEFAULT '{}',
      importance TEXT NOT NULL DEFAULT 'medium',
      confidence REAL NOT NULL DEFAULT 1.0,
      content_hash TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      agent_id TEXT NOT NULL,
      shared INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]',
      embedding TEXT,

      -- Temporal fields
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      relevant_from INTEGER,
      relevant_until INTEGER,
      recurrence TEXT,
      date_references TEXT DEFAULT '[]',

      -- Source fields
      source_type TEXT NOT NULL,
      source_session_key TEXT,
      source_file_path TEXT,
      source_message_id TEXT,
      source_creator_agent_id TEXT NOT NULL,
      source_timestamp INTEGER NOT NULL,

      -- Access tracking
      access_count INTEGER NOT NULL DEFAULT 0,
      decay_factor REAL NOT NULL DEFAULT 1.0
    )
  `);

  // Indices for common queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_type ON ${ENTITY_TABLE}(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_agent_id ON ${ENTITY_TABLE}(agent_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_shared ON ${ENTITY_TABLE}(shared)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_importance ON ${ENTITY_TABLE}(importance)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_created_at ON ${ENTITY_TABLE}(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_updated_at ON ${ENTITY_TABLE}(updated_at)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entities_last_accessed ON ${ENTITY_TABLE}(last_accessed_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entities_relevant_from ON ${ENTITY_TABLE}(relevant_from)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entities_relevant_until ON ${ENTITY_TABLE}(relevant_until)`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_content_hash ON ${ENTITY_TABLE}(content_hash)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entities_session_key ON ${ENTITY_TABLE}(source_session_key)`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_confidence ON ${ENTITY_TABLE}(confidence)`);

  // Relations table for entity relationships
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${RELATIONS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      strength REAL NOT NULL DEFAULT 1.0,
      established_at INTEGER NOT NULL,
      FOREIGN KEY (source_id) REFERENCES ${ENTITY_TABLE}(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES ${ENTITY_TABLE}(id) ON DELETE CASCADE,
      UNIQUE(source_id, target_id, relation_type)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_source ON ${RELATIONS_TABLE}(source_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_target ON ${RELATIONS_TABLE}(target_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_type ON ${RELATIONS_TABLE}(relation_type)`);

  // Locks table for multi-agent coordination
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${LOCKS_TABLE} (
      lock_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      lock_type TEXT NOT NULL,
      resource TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_locks_resource ON ${LOCKS_TABLE}(resource)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_locks_expires ON ${LOCKS_TABLE}(expires_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_locks_agent ON ${LOCKS_TABLE}(agent_id)`);

  // Access log for tracking memory usage patterns
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ACCESS_LOG_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      access_type TEXT NOT NULL,
      accessed_at INTEGER NOT NULL,
      query_context TEXT,
      FOREIGN KEY (entity_id) REFERENCES ${ENTITY_TABLE}(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_access_entity ON ${ACCESS_LOG_TABLE}(entity_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_access_agent ON ${ACCESS_LOG_TABLE}(agent_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_access_time ON ${ACCESS_LOG_TABLE}(accessed_at)`);

  // Consolidation log for tracking memory consolidation
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CONSOLIDATION_LOG_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      processed INTEGER DEFAULT 0,
      merged INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      updated INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT
    )
  `);

  // FTS5 for full-text search
  let ftsAvailable = false;
  let ftsError: string | undefined;

  if (enableFts) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${ENTITY_FTS_TABLE} USING fts5(
          content,
          tags,
          id UNINDEXED,
          type UNINDEXED,
          agent_id UNINDEXED,
          content='${ENTITY_TABLE}',
          content_rowid='rowid'
        )
      `);

      // Create triggers to keep FTS in sync
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON ${ENTITY_TABLE} BEGIN
          INSERT INTO ${ENTITY_FTS_TABLE}(rowid, content, tags, id, type, agent_id)
          VALUES (NEW.rowid, NEW.content, NEW.tags, NEW.id, NEW.type, NEW.agent_id);
        END
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON ${ENTITY_TABLE} BEGIN
          INSERT INTO ${ENTITY_FTS_TABLE}(${ENTITY_FTS_TABLE}, rowid, content, tags, id, type, agent_id)
          VALUES ('delete', OLD.rowid, OLD.content, OLD.tags, OLD.id, OLD.type, OLD.agent_id);
        END
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON ${ENTITY_TABLE} BEGIN
          INSERT INTO ${ENTITY_FTS_TABLE}(${ENTITY_FTS_TABLE}, rowid, content, tags, id, type, agent_id)
          VALUES ('delete', OLD.rowid, OLD.content, OLD.tags, OLD.id, OLD.type, OLD.agent_id);
          INSERT INTO ${ENTITY_FTS_TABLE}(rowid, content, tags, id, type, agent_id)
          VALUES (NEW.rowid, NEW.content, NEW.tags, NEW.id, NEW.type, NEW.agent_id);
        END
      `);

      ftsAvailable = true;
      log.debug("Entity memory FTS5 enabled");
    } catch (err) {
      ftsError = err instanceof Error ? err.message : String(err);
      log.warn(`Entity memory FTS5 unavailable: ${ftsError}`);
    }
  }

  setSchemaVersion(db, SCHEMA_VERSION);

  return { ftsAvailable, ftsError };
}

/**
 * Get current schema version
 */
function getSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`).get("schema_version") as
      | { value: string }
      | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * Set schema version
 */
function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare(
    `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run("schema_version", String(version));
}

/**
 * Perform schema migrations
 */
function migrateSchema(db: DatabaseSync, from: number, to: number): void {
  log.info(`Migrating entity memory schema from v${from} to v${to}`);

  // Future migrations would go here
  // if (from < 2 && to >= 2) { ... }
}

/**
 * Create vector table for semantic search (requires sqlite-vec extension)
 */
export function ensureEntityVectorTable(params: { db: DatabaseSync; dimensions: number }): void {
  const { db, dimensions } = params;

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${ENTITY_VEC_TABLE} USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[${dimensions}]
      )
    `);
    log.debug(`Entity memory vector table created with ${dimensions} dimensions`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to create entity vector table: ${message}`);
  }
}

/**
 * Drop and recreate vector table (for dimension changes)
 */
export function recreateEntityVectorTable(params: { db: DatabaseSync; dimensions: number }): void {
  const { db, dimensions } = params;

  try {
    db.exec(`DROP TABLE IF EXISTS ${ENTITY_VEC_TABLE}`);
    ensureEntityVectorTable(params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to recreate entity vector table: ${message}`);
  }
}

/**
 * Clean up expired locks
 */
export function cleanupExpiredLocks(db: DatabaseSync): number {
  const now = Date.now();
  const result = db.prepare(`DELETE FROM ${LOCKS_TABLE} WHERE expires_at < ?`).run(now);
  return result.changes;
}

/**
 * Clean up old access logs (keep last N days)
 */
export function cleanupOldAccessLogs(db: DatabaseSync, retentionDays: number = 30): number {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const result = db.prepare(`DELETE FROM ${ACCESS_LOG_TABLE} WHERE accessed_at < ?`).run(cutoff);
  return result.changes;
}
