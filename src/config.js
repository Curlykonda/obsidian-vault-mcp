import { resolve } from 'path';

const vaultEnv = process.env.OBSIDIAN_VAULT_PATH || process.env.VAULT_PATH;
if (!vaultEnv) {
  process.stderr.write('Error: OBSIDIAN_VAULT_PATH environment variable is required.\nSet it to the absolute path of your Obsidian vault, e.g.:\n  export OBSIDIAN_VAULT_PATH="/Users/you/Documents/MyVault"\n');
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
