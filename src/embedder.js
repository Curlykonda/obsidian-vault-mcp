import { execSync, spawn } from 'child_process';
import { OLLAMA_URL, EMBED_MODEL } from './config.js';

// nomic-embed-text context window is 8192 tokens.
// Dense text (e.g. German journal entries) tokenizes at ~1.5 chars/token,
// so 8192 tokens ≈ ~12K chars for English but only ~6K for dense text.
// We cap at 6000 chars to stay safe across all content types.
const MAX_CHARS = 6_000;

// Track whether we've already tried to start Ollama this session
let _startAttempted = false;
let _ollamaReady = false;

/**
 * Try to reach Ollama. If unreachable, attempt to start it in the background
 * and wait for it to become ready (up to ~15 seconds).
 */
export async function ensureOllama() {
  if (_ollamaReady) return { ok: true };

  // Quick check — maybe it's already running
  const check = await checkOllama();
  if (check.ok) {
    _ollamaReady = true;
    return { ok: true };
  }

  // If we already tried starting and it still isn't up, don't retry
  if (_startAttempted) {
    return { ok: false, error: check.error };
  }

  _startAttempted = true;

  // Try to find the ollama binary
  const ollamaPath = findOllamaBinary();
  if (!ollamaPath) {
    return {
      ok: false,
      error: 'Ollama not found. Install it with: brew install ollama',
    };
  }

  // Start ollama serve in the background (detached, no stdio)
  console.error('[obsidian-vault-mcp] Ollama not running — starting it...');
  const child = spawn(ollamaPath, ['serve'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      OLLAMA_FLASH_ATTENTION: '1',
      OLLAMA_KV_CACHE_TYPE: 'q8_0',
    },
  });
  child.unref(); // let it outlive this process

  // Poll until ready or timeout
  const maxWait = 15_000;
  const interval = 500;
  const deadline = Date.now() + maxWait;

  while (Date.now() < deadline) {
    await sleep(interval);
    const poll = await checkOllama();
    if (poll.ok) {
      _ollamaReady = true;
      console.error('[obsidian-vault-mcp] Ollama is ready.');
      return { ok: true };
    }
  }

  return {
    ok: false,
    error: `Started Ollama but it did not become ready within ${maxWait / 1000}s. Check logs.`,
  };
}

/**
 * Locate the ollama binary on disk.
 */
function findOllamaBinary() {
  // Common locations
  const candidates = [
    '/opt/homebrew/bin/ollama',
    '/usr/local/bin/ollama',
    '/usr/bin/ollama',
  ];

  for (const p of candidates) {
    try {
      execSync(`test -x "${p}"`, { stdio: 'ignore' });
      return p;
    } catch { /* not found */ }
  }

  // Try `which` as a fallback
  try {
    return execSync('which ollama', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Embed a single text string using Ollama.
 * Automatically starts Ollama if it isn't running.
 * Truncates to stay within the model's context window.
 */
export async function embedText(text) {
  // Ensure Ollama is up before the first embedding call
  if (!_ollamaReady) {
    const status = await ensureOllama();
    if (!status.ok) {
      throw new Error(`Ollama unavailable: ${status.error}`);
    }
  }

  const truncated = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;

  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBED_MODEL,
      prompt: truncated,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embedding failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.embedding;
}

/**
 * Embed multiple texts in sequence with a progress callback.
 */
export async function embedBatch(texts, { onProgress } = {}) {
  const embeddings = [];
  for (let i = 0; i < texts.length; i++) {
    const emb = await embedText(texts[i]);
    embeddings.push(emb);
    if (onProgress) onProgress(i + 1, texts.length);
  }
  return embeddings;
}

/**
 * Check if Ollama is reachable and the model is available.
 */
export async function checkOllama() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return { ok: false, error: `Ollama responded ${res.status}` };
    const data = await res.json();
    const hasModel = data.models?.some(m => m.name.startsWith(EMBED_MODEL));
    if (!hasModel) {
      return { ok: false, error: `Model '${EMBED_MODEL}' not found. Run: ollama pull ${EMBED_MODEL}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Cannot reach Ollama at ${OLLAMA_URL}. Is it running?` };
  }
}
