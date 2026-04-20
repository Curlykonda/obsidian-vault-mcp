#!/usr/bin/env node

/**
 * Standalone script to build or rebuild the vault index.
 * Usage:
 *   node src/run-index.js           # index only new/unindexed notes
 *   node src/run-index.js --reindex # drop and rebuild everything
 */

import { checkOllama } from './embedder.js';
import { indexVault } from './indexer.js';
import { getStats, closeDb } from './db.js';
import { VAULT_PATH, DB_PATH } from './config.js';

const reindex = process.argv.includes('--reindex');

console.log(`\n🗃️  Obsidian Vault Indexer`);
console.log(`   Vault: ${VAULT_PATH}`);
console.log(`   DB:    ${DB_PATH}`);
console.log(`   Mode:  ${reindex ? 'FULL REINDEX' : 'index'}\n`);

// Check Ollama first
const check = await checkOllama();
if (!check.ok) {
  console.error(`❌ ${check.error}`);
  process.exit(1);
}
console.log(`✅ Ollama ready\n`);

// Show existing stats
const before = getStats();
if (before.totalChunks > 0 && !reindex) {
  console.log(`   Existing index: ${before.totalNotes} notes, ${before.totalChunks} chunks`);
  console.log(`   Use --reindex to rebuild from scratch.\n`);
}

// Run indexing
let lastPrint = 0;
const result = await indexVault({
  reindex,
  onProgress({ fileIndex, totalFiles, totalChunks, elapsed }) {
    // Print progress every 2 seconds
    const now = Date.now();
    if (now - lastPrint > 2000 || fileIndex === totalFiles) {
      const pct = ((fileIndex / totalFiles) * 100).toFixed(1);
      const rate = (fileIndex / (elapsed / 1000)).toFixed(1);
      process.stdout.write(
        `\r   [${pct}%] ${fileIndex}/${totalFiles} notes | ${totalChunks} chunks | ${rate} notes/sec`
      );
      lastPrint = now;
    }
  },
});

console.log(`\n\n✅ Done in ${(result.elapsed / 1000).toFixed(1)}s`);

const after = getStats();
console.log(`   ${after.totalNotes} notes → ${after.totalChunks} chunks → ${after.totalVectors} vectors\n`);

closeDb();
