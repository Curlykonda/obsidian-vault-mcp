import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { VAULT_PATH, SKIP_PATTERNS } from './config.js';
import { parseAndChunkNote } from './chunker.js';
import { embedText } from './embedder.js';
import {
  getDb, insertChunk, insertEmbedding, deleteChunksForPath,
  getIndexedPaths, replaceNoteChunks,
} from './db.js';

/**
 * Recursively walk the vault and return all .md file paths.
 */
export function walkVault(dir = VAULT_PATH) {
  const results = [];

  function walk(currentDir) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      // Skip hidden dirs and configured patterns
      if (entry.isDirectory()) {
        const shouldSkip = SKIP_PATTERNS.some(p => entry.name === p || entry.name.startsWith('.'));
        if (shouldSkip) continue;
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Index a single note: chunk it, embed each chunk, store in DB.
 * Returns the number of chunks created.
 */
export async function indexNote(filePath, { onChunk } = {}) {
  const chunks = parseAndChunkNote(filePath);
  let count = 0;

  for (const chunk of chunks) {
    // Embed the contextualised text
    const embedding = await embedText(chunk.embedText);

    // Store chunk metadata + content (without embedText prefix)
    const rowid = insertChunk({
      path: chunk.path,
      heading: chunk.heading,
      content: chunk.content,
      cohort: chunk.cohort,
      status: chunk.status,
      tags: chunk.tags,
      folder: chunk.folder,
      modified: chunk.modified,
    });

    // Store vector
    insertEmbedding(rowid, embedding);

    count++;
    if (onChunk) onChunk(count, chunks.length, chunk);
  }

  return count;
}

/**
 * Re-index a single file. Embeddings are computed BEFORE the DB is touched,
 * then old chunks are swapped for new ones in a single transaction — so the
 * update is atomic per note and safe under concurrent server instances.
 * Also handles the note-emptied case (0 chunks → old chunks removed).
 */
export async function reindexNote(filePath) {
  const relPath = relative(VAULT_PATH, filePath);
  const chunks = parseAndChunkNote(filePath);

  const items = [];
  for (const chunk of chunks) {
    items.push({ chunk, embedding: await embedText(chunk.embedText) });
  }

  const { deleted, inserted } = replaceNoteChunks(relPath, items);
  return { deleted, indexed: inserted };
}

/**
 * Like walkVault, but also returns each note's mtime (epoch seconds — the
 * same unit the chunker stores in chunks.modified).
 */
export function walkVaultWithMtimes(dir = VAULT_PATH) {
  const results = [];

  function walk(currentDir) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        const shouldSkip = SKIP_PATTERNS.some(p => entry.name === p || entry.name.startsWith('.'));
        if (shouldSkip) continue;
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const stat = statSync(fullPath);
        results.push({
          fullPath,
          relPath: relative(VAULT_PATH, fullPath),
          mtime: stat.mtimeMs / 1000,
        });
      }
    }
  }

  walk(dir);
  return results;
}

// Only one catch-up runs per process; concurrent callers share the result.
let _catchUpInFlight = null;

/**
 * Incremental catch-up: diff the vault on disk against the index and fix
 * only the differences — new and modified notes are re-embedded, notes
 * deleted (or moved) since the last index are removed. This is the cheap,
 * always-safe path: after a normal day it touches a handful of files.
 */
export function catchUpIndex(opts = {}) {
  if (_catchUpInFlight) return _catchUpInFlight;
  _catchUpInFlight = _runCatchUp(opts).finally(() => { _catchUpInFlight = null; });
  return _catchUpInFlight;
}

async function _runCatchUp({ onProgress } = {}) {
  const startTime = Date.now();

  const onDisk = walkVaultWithMtimes();
  const inDb = getIndexedPaths();
  const dbMtimes = new Map(inDb.map(r => [r.path, r.modified]));
  const diskPaths = new Set(onDisk.map(f => f.relPath));

  // Notes in the index but no longer on disk (deleted or moved)
  const stale = inDb.filter(r => !diskPaths.has(r.path));
  let removedChunks = 0;
  for (const r of stale) {
    removedChunks += deleteChunksForPath(r.path);
  }

  // New or modified notes. 1s tolerance absorbs mtime jitter from cloud sync.
  const toIndex = onDisk.filter(f => {
    const indexedMtime = dbMtimes.get(f.relPath);
    return indexedMtime == null || Math.abs(f.mtime - indexedMtime) > 1;
  });

  let indexed = 0;
  let chunks = 0;
  let errors = 0;
  let empty = 0;

  for (const f of toIndex) {
    try {
      const result = await reindexNote(f.fullPath);
      if (result.indexed === 0 && result.deleted === 0) {
        // Empty / chunkless note: nothing to store, so it stays absent from
        // the DB and shows up as a candidate every run. Count separately so
        // reports don't claim real re-index work.
        empty++;
      } else {
        chunks += result.indexed;
        indexed++;
      }
    } catch (err) {
      errors++;
      console.error(`  ✗ Error indexing ${f.relPath}: ${err.message}`);
    }
    if (onProgress) {
      onProgress({ done: indexed + errors + empty, total: toIndex.length, current: f.relPath });
    }
  }

  return {
    scanned: onDisk.length,
    indexed,
    chunks,
    errors,
    empty,
    removedNotes: stale.length,
    removedChunks,
    elapsed: Date.now() - startTime,
  };
}

/**
 * Full vault index. Optionally clear the DB first (reindex mode).
 */
export async function indexVault({ reindex = false, onProgress } = {}) {
  const db = getDb();

  if (reindex) {
    db.exec('DELETE FROM chunks');
    db.exec('DELETE FROM vec_chunks');
    // Rebuild FTS
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
  }

  const files = walkVault();
  let totalChunks = 0;
  const startTime = Date.now();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      // reindexNote (not indexNote): embeds first, then swaps atomically —
      // a mid-note embedding failure leaves no partial chunks behind, which
      // would otherwise make catch-up skip the note (mtime matches).
      const result = await reindexNote(file);
      totalChunks += result.indexed;
    } catch (err) {
      console.error(`  ✗ Error indexing ${file}: ${err.message}`);
    }

    if (onProgress) {
      onProgress({
        fileIndex: i + 1,
        totalFiles: files.length,
        totalChunks,
        elapsed: Date.now() - startTime,
        currentFile: file,
      });
    }
  }

  return { totalFiles: files.length, totalChunks, elapsed: Date.now() - startTime };
}
