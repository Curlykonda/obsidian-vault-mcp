import chokidar from 'chokidar';
import { VAULT_PATH, SKIP_PATTERNS } from './config.js';
import { reindexNote } from './indexer.js';
import { deleteChunksForPath } from './db.js';
import { relative } from 'path';

let watcher = null;

/**
 * Start watching the vault for changes.
 * On file add/change → reindex that note.
 * On file delete → remove chunks for that path.
 */
export function startWatcher({ onEvent } = {}) {
  if (watcher) return watcher;

  const ignored = [
    /(^|[/\\])\./,  // hidden files/dirs
    ...SKIP_PATTERNS.map(p => new RegExp(`(^|[/\\\\])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[/\\\\])`)),
    /node_modules/,
  ];

  watcher = chokidar.watch(VAULT_PATH, {
    ignored,
    persistent: true,
    ignoreInitial: true,    // don't fire for existing files
    awaitWriteFinish: {
      stabilityThreshold: 500,   // wait 500ms after last write
      pollInterval: 100,
    },
  });

  // Debounce: track pending files to avoid double-indexing rapid saves
  const pending = new Map();

  function scheduleReindex(filePath) {
    if (!filePath.endsWith('.md')) return;

    if (pending.has(filePath)) {
      clearTimeout(pending.get(filePath));
    }

    pending.set(filePath, setTimeout(async () => {
      pending.delete(filePath);
      const relPath = relative(VAULT_PATH, filePath);
      try {
        const result = await reindexNote(filePath);
        if (onEvent) onEvent('reindexed', relPath, result);
      } catch (err) {
        if (onEvent) onEvent('error', relPath, err.message);
      }
    }, 300));
  }

  watcher
    .on('add', filePath => scheduleReindex(filePath))
    .on('change', filePath => scheduleReindex(filePath))
    .on('unlink', filePath => {
      if (!filePath.endsWith('.md')) return;
      const relPath = relative(VAULT_PATH, filePath);
      try {
        const deleted = deleteChunksForPath(relPath);
        if (onEvent) onEvent('deleted', relPath, { deleted });
      } catch (err) {
        if (onEvent) onEvent('error', relPath, err.message);
      }
    });

  return watcher;
}

export function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}
