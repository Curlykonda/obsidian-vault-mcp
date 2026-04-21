import { resolve, dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Parse --vault-path=<path> or --vault-path <path> from CLI args.
// Useful for Claude Desktop, which persists `args` in its config but strips `env`.
function parseVaultPathArg() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--vault-path=')) return args[i].slice('--vault-path='.length);
    if (args[i] === '--vault-path' && args[i + 1]) return args[i + 1];
  }
  return null;
}

// Optional gitignored local overrides (machine-specific paths etc.)
// See config.local.example.json for shape.
const __dirname = dirname(fileURLToPath(import.meta.url));
const localConfigPath = join(__dirname, '..', 'config.local.json');
const localConfig = existsSync(localConfigPath)
  ? JSON.parse(readFileSync(localConfigPath, 'utf8'))
  : {};

// Precedence: CLI arg > env var > config.local.json
const vaultEnv =
  parseVaultPathArg() ||
  process.env.OBSIDIAN_VAULT_PATH ||
  process.env.VAULT_PATH ||
  localConfig.OBSIDIAN_VAULT_PATH;

if (!vaultEnv) {
  process.stderr.write('Error: OBSIDIAN_VAULT_PATH is not set.\nOptions (in precedence order):\n  1. pass --vault-path=/path/to/vault as a CLI arg\n  2. export OBSIDIAN_VAULT_PATH="/path/to/vault"\n  3. create config.local.json in the project root: {"OBSIDIAN_VAULT_PATH": "/path/to/vault"}\n');
  process.exit(1);
}

export const VAULT_PATH = resolve(vaultEnv);

export const DB_PATH = resolve(
  process.env.DB_PATH ||
  `${VAULT_PATH}/.obsidian/obsidian-vault-index.db`
);

export const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
export const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
export const EMBED_DIMS = 768;

// Folders to skip during indexing
export const SKIP_PATTERNS = [
  '.obsidian',
  '.trash',
  '.smart-env',
  'node_modules',
];
