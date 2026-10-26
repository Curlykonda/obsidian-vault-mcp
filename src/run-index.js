#!/usr/bin/env node

/**
 * Standalone script to build or update the vault index.
 * Usage:
 *   node src/run-index.js           # catch-up: diff vault vs index, fix only differences
 *   node src/run-index.js --reindex # drop and rebuild everything
 */

import { checkOllama } from './embedder.js';
import { indexVault, catchUpIndex } from './indexer.js';
import { getStats, closeDb } from './db.js';
import { VAULT_PATH, DB_PATH } from './config.js';

const reindex = process.argv.includes('--reindex');

console.log(`\n🗃️  Obsidian Vault Indexer`);
console.log(`   Vault: ${VAULT_PATH}`);
console.log(`   DB:    ${DB_PATH}`);
console.log(`   Mode:  ${reindex ? 'FULL REINDEX' : 'catch-up (incremental)'}\n`);

// Check Ollama first
const check = await checkOllama();
if (!check.ok) {
  console.error(`❌ ${check.error}`);
  process.exit(1);
}
console.log(`✅ Ollama ready\n`);

if (reindex) {
  // Full rebuild: drop everything and re-embed the whole vault
  let lastPrint = 0;
  const result = await indexVault({
    reindex: true,
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
} else {
  // Catch-up: only touch what changed since the last index
  const before = getStats();
  if (before.totalChunks > 0) {
    console.log(`   Existing index: ${before.totalNotes} notes, ${before.totalChunks} chunks\n`);
  }

  let lastPrint = 0;
  const result = await catchUpIndex({
    onProgress({ done, total, current }) {
      const now = Date.now();
      if (now - lastPrint > 1000 || done === total) {
        process.stdout.write(`\r   [${done}/${total}] ${current.slice(0, 60)}`.padEnd(80));
        lastPrint = now;
      }
    },
  });

  console.log(`\n\n✅ Catch-up done in ${(result.elapsed / 1000).toFixed(1)}s`);
  console.log(`   scanned ${result.scanned} notes | re-indexed ${result.indexed} (${result.chunks} chunks) | removed ${result.removedNotes} | empty ${result.empty} | errors ${result.errors}`);
}

const after = getStats();
console.log(`   ${after.totalNotes} notes → ${after.totalChunks} chunks → ${after.totalVectors} vectors\n`);

closeDb();
