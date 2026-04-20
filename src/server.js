#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { VAULT_PATH } from './config.js';
import { embedText, ensureOllama } from './embedder.js';
import { vectorSearch, bm25Search, getStats } from './db.js';

// ---------------------------------------------------------------------------
// Time-decay: recent notes score higher
// ---------------------------------------------------------------------------
// Half-life of 120 days: a note from 120 days ago has 50% weight,
// 240 days ago has 25%, a year ago has ~12%. A very strong semantic
// match from 2022 can still surface, but recent notes are preferred.
const HALF_LIFE_DAYS = 120;
const DECAY_LAMBDA = Math.LN2 / HALF_LIFE_DAYS;  // ln(2)/120 ≈ 0.00578

function recencyWeight(modifiedEpochSecs) {
  if (!modifiedEpochSecs) return 0.5; // unknown age → treat as ~120 days old
  const ageDays = (Date.now() / 1000 - modifiedEpochSecs) / 86400;
  return Math.exp(-DECAY_LAMBDA * Math.max(0, ageDays));
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion with time-decay
// ---------------------------------------------------------------------------
// Each chunk's final score = RRF score × recency weight.
// A chunk that's semantically strong AND recent dominates.
// A chunk from years ago needs to be a near-perfect match to surface.
function reciprocalRankFusion(vecResults, bm25Results, chunkMeta, { useDecay = true, k = 60 } = {}) {
  const scores = new Map();

  vecResults.forEach((r, rank) => {
    const id = r.rowid ?? r.id;
    scores.set(id, (scores.get(id) || 0) + 1 / (k + rank));
  });

  bm25Results.forEach((r, rank) => {
    const id = r.rowid;
    scores.set(id, (scores.get(id) || 0) + 1 / (k + rank));
  });

  // Apply time-decay to the fused score (unless disabled)
  return [...scores.entries()]
    .map(([id, rrfScore]) => {
      const meta = chunkMeta.get(id);
      const decay = useDecay
        ? (meta ? recencyWeight(meta.modified) : 0.5)
        : 1;
      return { id, rrfScore, recencyWeight: decay, score: rrfScore * decay };
    })
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Shared search logic
// ---------------------------------------------------------------------------
async function runSearch({ query, top_k = 8, folder, status, cohort, since_days, useDecay = true }) {
  const queryEmbedding = await embedText(query);

  const filters = {};
  if (folder) filters.folder = folder;
  if (status) filters.status = status;
  if (cohort) filters.cohort = cohort;
  if (since_days) filters.since_days = since_days;

  const vecResults = vectorSearch(queryEmbedding, top_k * 2, filters);
  const bm25Results = bm25Search(query, top_k * 2);
  const vecMap = new Map(vecResults.map(r => [r.rowid ?? r.id, r]));
  const fused = reciprocalRankFusion(vecResults, bm25Results, vecMap, { useDecay });

  const results = [];
  for (const { id, rrfScore, recencyWeight: decay, score } of fused) {
    const chunk = vecMap.get(id);
    if (!chunk) continue;
    results.push({
      path: chunk.path,
      heading: chunk.heading,
      folder: chunk.folder,
      cohort: chunk.cohort,
      status: chunk.status,
      tags: chunk.tags,
      distance: chunk.distance,
      score,
      ...(useDecay && { recencyWeight: Math.round(decay * 100) + '%' }),
      content: chunk.content.length > 800
        ? chunk.content.slice(0, 800) + '…'
        : chunk.content,
    });
    if (results.length >= top_k) break;
  }

  return {
    query,
    mode: useDecay ? 'recency-weighted' : 'deep (no time-decay)',
    resultsCount: results.length,
    indexStats: getStats(),
    results,
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: 'obsidian-vault',
  version: '0.1.0',
});

// Shared schema for search filter params
const searchFilterSchema = {
  query: z.string().describe('Natural language search query'),
  top_k: z.number().optional().default(8).describe('Number of results to return (default 8)'),
  folder: z.string().optional().describe('Filter by folder path substring, e.g. "MATS - Area", "00 - Daily Notes"'),
  status: z.string().optional().describe('Filter by frontmatter status field, e.g. "active", "completed → Apollo"'),
  cohort: z.string().optional().describe('Filter by MATS cohort, e.g. "8.1", "8.2"'),
  since_days: z.number().optional().describe('Only include notes modified within the last N days'),
};

// --- Tool: obs_vault_search ---
server.tool(
  'obs_vault_search',
  `Semantic search over note content (not filenames or paths) in the Obsidian vault. Prefers recent notes via 120-day half-life decay. Use for conceptual or topical queries when you don't know where the note lives. Prefer obs_vault_list when you already know (or can guess) the containing folder and the filename follows a predictable pattern — listing is one reliable call versus search's semantic guesswork, because embeddings index content, not filenames. Default top_k=8.`,
  searchFilterSchema,
  async (params) => {
    try {
      const result = await runSearch({ ...params, useDecay: true });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error searching vault: ${err.message}` }], isError: true };
    }
  }
);

// --- Tool: obs_vault_deep_search ---
server.tool(
  'obs_vault_deep_search',
  `Same as obs_vault_search (semantic over note content, not filenames or paths) but without recency decay — older notes weighted equally. Use when looking for historical context, long-term patterns, or when obs_vault_search missed an older entry you know exists. Prefer obs_vault_list if you already know the containing folder and the filename follows a predictable pattern, because embeddings index content not filenames. Default top_k=20.`,
  {
    ...searchFilterSchema,
    top_k: z.number().optional().default(20).describe('Number of results to return (default 20)'),
  },
  async (params) => {
    try {
      const result = await runSearch({ ...params, useDecay: false });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error searching vault: ${err.message}` }], isError: true };
    }
  }
);

// --- Tool: obs_vault_fetch ---
server.tool(
  'obs_vault_fetch',
  `Retrieve the full content of a specific note by its vault-relative path (as returned by obs_vault_search, obs_vault_deep_search, or obs_vault_list).`,
  {
    path: z.string().describe('Relative path within the vault, e.g. "04-Life_Areas/MATS - Area/Fellows/Victor Gillioz.md"'),
  },
  async ({ path }) => {
    try {
      const fullPath = resolve(VAULT_PATH, path);

      // Basic path traversal guard
      if (!fullPath.startsWith(VAULT_PATH)) {
        return {
          content: [{ type: 'text', text: 'Error: path outside vault' }],
          isError: true,
        };
      }

      const content = readFileSync(fullPath, 'utf-8');
      return {
        content: [{
          type: 'text',
          text: content,
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `Error reading note: ${err.message}`,
        }],
        isError: true,
      };
    }
  }
);

// --- Tool: obs_vault_stats ---
server.tool(
  'obs_vault_stats',
  `Show index statistics: how many notes and chunks are indexed in the vault.`,
  {},
  async () => {
    const stats = getStats();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(stats, null, 2),
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Shared path-safety helper
// ---------------------------------------------------------------------------
function safePath(relPath) {
  const full = resolve(VAULT_PATH, relPath);
  if (!full.startsWith(VAULT_PATH)) {
    throw new Error('Path outside vault');
  }
  return full;
}

// ---------------------------------------------------------------------------
// Tool: obs_vault_write — create or overwrite a note
// ---------------------------------------------------------------------------
server.tool(
  'obs_vault_write',
  `Create a new note or overwrite an existing one in the Obsidian vault. Path is relative to vault root (e.g. "00 - Daily Notes/2026-03-25.md"). Parent directories are created automatically. Use overwrite=true to replace an existing file; defaults to false (fails if file exists).`,
  {
    path: z.string().describe('Relative path within the vault, e.g. "00 - Daily Notes/2026-03-25.md"'),
    content: z.string().describe('Full markdown content for the note'),
    overwrite: z.boolean().optional().default(false).describe('If true, overwrite existing file. If false (default), fail if file already exists.'),
  },
  async ({ path: relPath, content, overwrite }) => {
    try {
      const fullPath = safePath(relPath);

      if (!overwrite && existsSync(fullPath)) {
        return {
          content: [{ type: 'text', text: `Error: file already exists at "${relPath}". Set overwrite=true to replace it.` }],
          isError: true,
        };
      }

      // Ensure parent directories exist
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');

      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, path: relPath, action: overwrite && existsSync(fullPath) ? 'overwritten' : 'created' }) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error writing note: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: obs_vault_patch — insert/replace content relative to a heading
// ---------------------------------------------------------------------------
server.tool(
  'obs_vault_patch',
  `Insert, replace, or append content in an existing note. Supports heading-aware operations:
- "append": add content at the end of the file
- "prepend": add content at the beginning (after frontmatter)
- "heading_replace": replace the content under a specific heading (up to the next heading of equal or higher level)
- "heading_append": append content at the end of a heading's section
Use this for targeted edits to daily notes, weekly goals, etc.`,
  {
    path: z.string().describe('Relative path within the vault'),
    operation: z.enum(['append', 'prepend', 'heading_replace', 'heading_append']).describe('Type of patch operation'),
    content: z.string().describe('The markdown content to insert'),
    heading: z.string().optional().describe('Target heading text (without # prefix) — required for heading_replace and heading_append'),
  },
  async ({ path: relPath, operation, content, heading }) => {
    try {
      const fullPath = safePath(relPath);

      if (!existsSync(fullPath)) {
        return {
          content: [{ type: 'text', text: `Error: file not found at "${relPath}"` }],
          isError: true,
        };
      }

      const existing = readFileSync(fullPath, 'utf-8');
      let updated;

      if (operation === 'append') {
        updated = existing.trimEnd() + '\n\n' + content + '\n';

      } else if (operation === 'prepend') {
        // Insert after frontmatter if present
        const fmMatch = existing.match(/^---\n[\s\S]*?\n---\n/);
        if (fmMatch) {
          const afterFm = fmMatch.index + fmMatch[0].length;
          updated = existing.slice(0, afterFm) + '\n' + content + '\n' + existing.slice(afterFm);
        } else {
          updated = content + '\n\n' + existing;
        }

      } else if (operation === 'heading_replace' || operation === 'heading_append') {
        if (!heading) {
          return {
            content: [{ type: 'text', text: `Error: "heading" parameter is required for ${operation}` }],
            isError: true,
          };
        }

        // Find the heading line and determine its level
        const lines = existing.split('\n');
        let headingLineIdx = -1;
        let headingLevel = 0;

        for (let i = 0; i < lines.length; i++) {
          const match = lines[i].match(/^(#{1,6})\s+(.*)/);
          if (match && match[2].trim() === heading.trim()) {
            headingLineIdx = i;
            headingLevel = match[1].length;
            break;
          }
        }

        if (headingLineIdx === -1) {
          return {
            content: [{ type: 'text', text: `Error: heading "${heading}" not found in "${relPath}"` }],
            isError: true,
          };
        }

        // Find the end of this section (next heading of same or higher level, or EOF)
        let sectionEnd = lines.length;
        for (let i = headingLineIdx + 1; i < lines.length; i++) {
          const match = lines[i].match(/^(#{1,6})\s/);
          if (match && match[1].length <= headingLevel) {
            sectionEnd = i;
            break;
          }
        }

        if (operation === 'heading_replace') {
          // Keep the heading line, replace everything under it
          const before = lines.slice(0, headingLineIdx + 1);
          const after = lines.slice(sectionEnd);
          updated = [...before, content, ...after].join('\n');
        } else {
          // heading_append: insert before sectionEnd
          const before = lines.slice(0, sectionEnd);
          const after = lines.slice(sectionEnd);
          // Trim trailing blank lines in the section, then add content
          while (before.length > 0 && before[before.length - 1].trim() === '') {
            before.pop();
          }
          updated = [...before, content, '', ...after].join('\n');
        }

      } else {
        return {
          content: [{ type: 'text', text: `Error: unknown operation "${operation}"` }],
          isError: true,
        };
      }

      writeFileSync(fullPath, updated, 'utf-8');

      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, path: relPath, operation, heading: heading || null }) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error patching note: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: obs_vault_list — list files/folders in a directory
// ---------------------------------------------------------------------------
server.tool(
  'obs_vault_list',
  `List files and subdirectories in a vault folder, returning names, types (file/dir), and modification times. Use when you know (or can guess) the containing folder — weekly reviews live in "03-Systems/Weekly Review - Sys/2026/", daily notes in "00 - Daily Notes/", fellow notes in "04-Life_Areas/MATS - Area/Fellows/". Listing the folder and scanning filenames is one step; semantic search over filename-like queries ("CW16", "2026-04-19") will miss because embeddings index content, not filenames. Path is relative to vault root; omit or use "" for root. Set recursive=true for full subtree (max 200 entries).`,
  {
    path: z.string().optional().default('').describe('Relative folder path within the vault (e.g. "00 - Daily Notes"). Empty string for vault root.'),
    recursive: z.boolean().optional().default(false).describe('If true, list all files recursively (max 200 entries). Default false.'),
  },
  async ({ path: relPath, recursive }) => {
    try {
      const fullPath = safePath(relPath || '');
      if (!existsSync(fullPath)) {
        return {
          content: [{ type: 'text', text: `Error: folder not found at "${relPath}"` }],
          isError: true,
        };
      }

      const MAX_ENTRIES = 200;
      const entries = [];

      function walk(dir) {
        if (entries.length >= MAX_ENTRIES) return;
        const items = readdirSync(dir);
        for (const name of items) {
          if (entries.length >= MAX_ENTRIES) break;
          if (name.startsWith('.')) continue; // skip hidden files/dirs
          const itemPath = resolve(dir, name);
          const stat = statSync(itemPath);
          const rel = relative(VAULT_PATH, itemPath);
          entries.push({
            name,
            path: rel,
            type: stat.isDirectory() ? 'dir' : 'file',
            modified: stat.mtime.toISOString(),
          });
          if (recursive && stat.isDirectory()) {
            walk(itemPath);
          }
        }
      }

      walk(fullPath);

      // Sort: dirs first, then by name
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            folder: relPath || '(vault root)',
            count: entries.length,
            truncated: entries.length >= MAX_ENTRIES,
            entries,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error listing folder: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
