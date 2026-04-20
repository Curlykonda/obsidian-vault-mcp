import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { DB_PATH, EMBED_DIMS } from './config.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

let _db = null;

export function getDb() {
  if (_db) return _db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);

  // Load sqlite-vec extension
  sqliteVec.load(_db);

  // WAL mode for better concurrent read/write
  _db.pragma('journal_mode = WAL');

  // Create tables
  _db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      path      TEXT    NOT NULL,
      heading   TEXT,
      content   TEXT    NOT NULL,
      -- frontmatter fields
      cohort    TEXT,
      status    TEXT,
      tags      TEXT,
      folder    TEXT,
      modified  REAL,
      indexed_at REAL DEFAULT (unixepoch('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
    CREATE INDEX IF NOT EXISTS idx_chunks_folder ON chunks(folder);
    CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks(status);
    CREATE INDEX IF NOT EXISTS idx_chunks_cohort ON chunks(cohort);
  `);

  // Create FTS5 virtual table for hybrid BM25 + vector search
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      path, heading, content,
      content='chunks',
      content_rowid='id'
    );
  `);

  // Create FTS triggers to keep it in sync
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, path, heading, content)
      VALUES (new.id, new.path, new.heading, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, path, heading, content)
      VALUES ('delete', old.id, old.path, old.heading, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, path, heading, content)
      VALUES ('delete', old.id, old.path, old.heading, old.content);
      INSERT INTO chunks_fts(rowid, path, heading, content)
      VALUES (new.id, new.path, new.heading, new.content);
    END;
  `);

  // Create vector table
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      embedding float[${EMBED_DIMS}]
    );
  `);

  return _db;
}

// --- DB operations ---

const _stmts = {};

function stmt(db, name, sql) {
  if (!_stmts[name]) _stmts[name] = db.prepare(sql);
  return _stmts[name];
}

export function insertChunk(chunk) {
  const db = getDb();
  const s = stmt(db, 'insertChunk', `
    INSERT INTO chunks (path, heading, content, cohort, status, tags, folder, modified)
    VALUES (@path, @heading, @content, @cohort, @status, @tags, @folder, @modified)
  `);
  const info = s.run(chunk);
  return info.lastInsertRowid; // BigInt from better-sqlite3
}

export function insertEmbedding(rowid, embedding) {
  const db = getDb();
  const s = stmt(db, 'insertEmbedding', `
    INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)
  `);
  // sqlite-vec requires BigInt for explicit rowid
  s.run(BigInt(rowid), new Float32Array(embedding));
}

export function deleteChunksForPath(path) {
  const db = getDb();
  // Get rowids first so we can delete from vec_chunks too
  const rows = stmt(db, 'getIdsByPath', `SELECT id FROM chunks WHERE path = ?`).all(path);
  if (rows.length === 0) return 0;

  const ids = rows.map(r => r.id);
  for (const id of ids) {
    stmt(db, 'deleteVec', `DELETE FROM vec_chunks WHERE rowid = ?`).run(BigInt(id));
  }
  stmt(db, 'deleteChunks', `DELETE FROM chunks WHERE path = ?`).run(path);
  return ids.length;
}

export function vectorSearch(queryEmbedding, topK = 10, filters = {}) {
  const db = getDb();

  // Build WHERE clause from filters
  const conditions = [];
  const params = {};

  if (filters.folder) {
    conditions.push(`c.folder LIKE @folder`);
    params.folder = `%${filters.folder}%`;
  }
  if (filters.status) {
    conditions.push(`c.status = @status`);
    params.status = filters.status;
  }
  if (filters.cohort) {
    conditions.push(`c.cohort = @cohort`);
    params.cohort = filters.cohort;
  }
  if (filters.since_days) {
    conditions.push(`c.modified >= @since`);
    params.since = Date.now() / 1000 - filters.since_days * 86400;
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  // If we have filters, we need a two-step approach:
  // 1. Get broader vec results
  // 2. Filter and re-rank
  if (conditions.length > 0) {
    // Get more candidates than needed, then filter
    const broadK = Math.min(topK * 10, 200);
    const vecSql = `
      SELECT rowid, distance
      FROM vec_chunks
      WHERE embedding MATCH ?
        AND k = ${broadK}
      ORDER BY distance
    `;
    const vecResults = db.prepare(vecSql).all(new Float32Array(queryEmbedding));
    const vecRowIds = vecResults.map(r => r.rowid);

    if (vecRowIds.length === 0) return [];

    // Now filter by metadata
    const placeholders = vecRowIds.map(() => '?').join(',');
    const filterSql = `
      SELECT c.id, c.path, c.heading, c.content, c.folder, c.cohort, c.status, c.tags, c.modified
      FROM chunks c
      ${whereClause.replace('WHERE', `WHERE c.id IN (${placeholders}) AND`)}
    `;
    const filterParams = [...vecRowIds, ...Object.values(params)];
    const filtered = db.prepare(filterSql).all(...filterParams);

    // Re-attach distances and sort
    const distMap = new Map(vecResults.map(r => [r.rowid, r.distance]));
    return filtered
      .map(row => ({ ...row, distance: distMap.get(row.id) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, topK);
  }

  // No filters — simple vec search
  const sql = `
    SELECT v.rowid, v.distance,
           c.path, c.heading, c.content, c.folder, c.cohort, c.status, c.tags, c.modified
    FROM vec_chunks v
    JOIN chunks c ON c.id = v.rowid
    WHERE v.embedding MATCH ?
      AND k = ${topK}
    ORDER BY v.distance
  `;
  return db.prepare(sql).all(new Float32Array(queryEmbedding));
}

export function bm25Search(queryText, topK = 20) {
  const db = getDb();
  // Escape FTS5 special chars and create a simple query
  const escaped = queryText.replace(/['"]/g, '').split(/\s+/).filter(Boolean).join(' OR ');
  const sql = `
    SELECT rowid, rank, highlight(chunks_fts, 2, '>>>', '<<<') AS snippet
    FROM chunks_fts
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `;
  try {
    return db.prepare(sql).all(escaped, topK);
  } catch {
    return [];
  }
}

export function getStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM chunks').get();
  const paths = db.prepare('SELECT COUNT(DISTINCT path) as count FROM chunks').get();
  const vecs = db.prepare('SELECT COUNT(*) as count FROM vec_chunks').get();
  return {
    totalChunks: total.count,
    totalNotes: paths.count,
    totalVectors: vecs.count,
  };
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
