# obsidian-vault-mcp

MCP server that gives Claude Code read/write access to an Obsidian vault with semantic search. Uses local embeddings via [Ollama](https://ollama.com) + [nomic-embed-text](https://ollama.com/library/nomic-embed-text) and stores vectors in SQLite via [sqlite-vec](https://github.com/asg017/sqlite-vec).

## Tools

| Tool | Description |
|---|---|
| `obs_vault_search` | Recency-weighted semantic search (120-day half-life). Default top_k=8. |
| `obs_vault_deep_search` | Same search without time-decay — all notes weighted equally. Default top_k=20. |
| `obs_vault_list` | List files/subdirectories in a vault folder. Use when you know the folder; faster and more reliable than searching for filename-like queries (dates, note names). |
| `obs_vault_fetch` | Retrieve full note content by vault-relative path. |
| `obs_vault_write` | Create or overwrite a note. |
| `obs_vault_patch` | Insert/replace content in an existing note — supports `append`, `prepend`, `heading_replace`, `heading_append`. |
| `obs_vault_delete` | Delete a note. Fails if path doesn't exist. |
| `obs_vault_move` | Move or rename a note within the vault. Creates destination parent dirs automatically. Fails if source missing or destination exists. |
| `obs_vault_batch_fetch` | Read up to 10 notes in a single call. Per-path success or error. |
| `obs_vault_frontmatter` | YAML-safe get/set of frontmatter fields via gray-matter. Prefer over `obs_vault_patch` for any frontmatter edits. |
| `obs_vault_stats` | Index statistics (note/chunk counts). |

Both search tools use **reciprocal rank fusion** (RRF) combining vector similarity (768-dim nomic-embed-text) with BM25 keyword matching (SQLite FTS5). `obs_vault_search` additionally multiplies scores by `e^(-λ × age_days)` with a 120-day half-life.

## Prerequisites

- **Node.js** ≥ 20
- **Ollama** — `brew install ollama`
- **nomic-embed-text** — `ollama pull nomic-embed-text`

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Start Ollama
ollama serve &

# 3. Build the index
OBSIDIAN_VAULT_PATH="/path/to/your/vault" npm run index      # incremental
OBSIDIAN_VAULT_PATH="/path/to/your/vault" npm run reindex    # full rebuild

# 4. Register the MCP server in Claude Code (~/.claude.json)
#
#    "obsidian-vault": {
#      "type": "stdio",
#      "command": "node",
#      "args": ["/path/to/obsidian-vault-mcp/src/server.js"],
#      "env": { "OBSIDIAN_VAULT_PATH": "/path/to/your/vault" }
#    }

# 5. Auto-allow the tools (no approval prompts)
#    Add to ~/.claude/settings.json under permissions.allow:
#
#    "mcp__obsidian-vault__obs_vault_search",
#    "mcp__obsidian-vault__obs_vault_deep_search",
#    "mcp__obsidian-vault__obs_vault_list",
#    "mcp__obsidian-vault__obs_vault_fetch",
#    "mcp__obsidian-vault__obs_vault_write",
#    "mcp__obsidian-vault__obs_vault_patch",
#    "mcp__obsidian-vault__obs_vault_delete",
#    "mcp__obsidian-vault__obs_vault_move",
#    "mcp__obsidian-vault__obs_vault_batch_fetch",
#    "mcp__obsidian-vault__obs_vault_frontmatter",
#    "mcp__obsidian-vault__obs_vault_stats"
```

## Configuration

All config is via environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `OBSIDIAN_VAULT_PATH` | **yes** | — | Absolute path to your Obsidian vault |
| `DB_PATH` | no | `$OBSIDIAN_VAULT_PATH/.obsidian/obsidian-vault-index.db` | SQLite index location |
| `OLLAMA_URL` | no | `http://127.0.0.1:11434` | Ollama API endpoint |
| `EMBED_MODEL` | no | `nomic-embed-text` | Ollama embedding model |

## Auto-start Ollama on login (optional)

The server auto-starts Ollama on first search (3–5s cold-start delay). To keep it warm, install a launchd agent that starts Ollama 5 minutes after login:

```bash
bash setup/install-launchd.sh
```

To uninstall:
```bash
launchctl bootout "gui/$(id -u)/com.obsidian-vault-mcp.ollama"
rm ~/Library/LaunchAgents/com.obsidian-vault-mcp.ollama.plist
```

## Design

| Decision | Choice | Rationale |
|---|---|---|
| **Vector DB** | SQLite-vec | Single `.db` file, zero ops, SQL gives hybrid structured+vector queries. |
| **Embedding model** | nomic-embed-text (768d, local) | Free, private, ~20ms warm latency, no API key. |
| **Search strategy** | Hybrid RRF (vector + BM25) | 10–20% better retrieval than pure semantic. |
| **Chunking** | Heading boundaries | Preserves semantic units rather than arbitrary token windows. |
| **MCP transport** | stdio | No persistent daemon — Claude Code starts/stops the server per session. |
| **Index location** | Inside vault `.obsidian/` | Co-located with Obsidian config; syncs naturally with vault. |
| **Recency bias** | 120-day half-life | Recent notes are usually more relevant; `obs_vault_deep_search` disables it. |

### Chunking details

Notes split at H1/H2/H3 boundaries. Each chunk carries heading, YAML frontmatter fields (cohort, status, tags), folder path, and a context prefix prepended before embedding. Short chunks (<50 chars) are merged up; long chunks (>5K chars) split at paragraph boundaries. nomic-embed-text has an 8192-token window; the chunker caps at 5K chars as a safety net.

### Index storage

A single SQLite file containing:
- `chunks` — text + metadata (path, heading, folder, cohort, status, tags, modified)
- `chunks_fts` — FTS5 full-text index, auto-synced via triggers
- `vec_chunks` — sqlite-vec float[768] embeddings

## Project structure

```
src/
  server.js     MCP server, tool handlers, RRF fusion
  config.js     Vault/DB path, Ollama URL, model config
  db.js         SQLite schema, CRUD, vector/BM25 search
  embedder.js   Ollama client with auto-start and health check
  chunker.js    Frontmatter parser, heading-boundary splitter
  indexer.js    Vault walker, index orchestration
  watcher.js    Chokidar file watcher (built, not yet daemonized)
  run-index.js  CLI for manual index/reindex
setup/
  com.obsidian-vault-mcp.ollama.plist   launchd agent for delayed Ollama start
  install-launchd.sh                     Installer for the launchd agent
```

## Future work

- Wire `watcher.js` as a launchd daemon for live incremental reindexing
- Cross-encoder re-ranking (e.g. `mxbai-rerank-xsmall-v1`) for top-N refinement
- Migrate to LanceDB if index grows past ~500K chunks
