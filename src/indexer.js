import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { VAULT_PATH, SKIP_PATTERNS } from './config.js';
import { parseAndChunkNote } from './chunker.js';
import { embedText } from './embedder.js';
import { getDb, insertChunk, insertEmbedding, deleteChunksForPath } from './db.js';

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
 * Re-index a single file: delete old chunks, then re-index.
 */
export async function reindexNote(filePath) {
  const chunks = parseAndChunkNote(filePath);
  if (chunks.length === 0) return 0;

  const relPath = chunks[0].path;
  const deleted = deleteChunksForPath(relPath);

  const count = await indexNote(filePath);
  return { deleted, indexed: count };
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
      const count = await indexNote(file);
      totalChunks += count;
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
