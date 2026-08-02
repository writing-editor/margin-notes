import { App } from 'obsidian';
import type { SecretSettings } from './settings';

/**
 * API keys are persisted in their OWN file, `api-keys.json`, sitting next
 * to (not inside) this plugin's normal `data.json` — both live in
 * `<vault>/.obsidian/plugins/margin-notes/`. This is a deliberate split,
 * not an accident of how the code happens to be organised:
 *
 * Obsidian's own plugin API only ever gives a plugin ONE persistence
 * mechanism — `Plugin.loadData()`/`saveData()` — and that always reads
 * and writes exactly `data.json`, with no way to redirect part of it
 * elsewhere. So this is NOT "the same data.json, just organised
 * differently" — it's a second, independently-read-and-written file,
 * accessed through the lower-level `Vault.adapter` (read/write/exists),
 * which is the correct, cross-platform-safe way to touch a file that
 * isn't a normal vault note (confirmed against multiple Obsidian forum
 * threads: `adapter.read/write/exists` keep working on both desktop and
 * mobile, whereas dropping to Node's own `fs` or `adapter.getBasePath()`
 * does not — mobile's adapter doesn't expose a real filesystem path).
 *
 * The entire point: this file's path can be added to a single line in a
 * vault's `.gitignore` —
 *   .obsidian/plugins/margin-notes/api-keys.json
 * — excluding ONLY the keys, while `data.json` (every other setting) and
 * the rest of the plugin folder stay tracked normally. Gitignoring the
 * whole plugin folder (the alternative, without this split) would also
 * silently stop tracking `data.json` itself — every non-secret setting
 * (spelling convention, density, agent profile choice, margin width,
 * etc.) — which most people who want to version-control their vault
 * almost certainly don't want either.
 *
 * The values written here are still run through encryptSecret() before
 * ever reaching this file — this split changes WHERE the (possibly
 * still-plaintext-if-no-keychain) string lands, not the encryption
 * logic itself, which is unchanged in secureStorage.ts.
 */
const SECRETS_FILENAME = 'api-keys.json';

function secretsFilePath(app: App): string {
  return `${app.vault.configDir}/plugins/margin-notes/${SECRETS_FILENAME}`;
}

const EMPTY_SECRETS: SecretSettings = { claudeKey: '', openaiKey: '', geminiKey: '' };

/**
 * Returns EMPTY_SECRETS (never throws) if the file doesn't exist yet —
 * true on a fresh install, before ever saving a key through this file.
 */
export async function loadSecretsFile(app: App): Promise<SecretSettings> {
  const path = secretsFilePath(app);
  try {
    const exists = await app.vault.adapter.exists(path);
    if (!exists) return { ...EMPTY_SECRETS };
    const raw = await app.vault.adapter.read(path);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY_SECRETS };
    const p = parsed as Partial<SecretSettings>;
    return {
      claudeKey: typeof p.claudeKey === 'string' ? p.claudeKey : '',
      openaiKey: typeof p.openaiKey === 'string' ? p.openaiKey : '',
      geminiKey: typeof p.geminiKey === 'string' ? p.geminiKey : '',
    };
  } catch (err) {
    console.error('Margin Notes: failed to read api-keys.json, treating as empty', err);
    return { ...EMPTY_SECRETS };
  }
}

/** Writes the whole SecretSettings object to api-keys.json, overwriting it. Never throws — a failed write is logged and surfaced via the returned boolean instead, since losing an already-typed-in key to a crash is worse than a silent-but-logged failure. */
export async function saveSecretsFile(app: App, secrets: SecretSettings): Promise<boolean> {
  const path = secretsFilePath(app);
  try {
    await app.vault.adapter.write(path, JSON.stringify(secrets, null, 2));
    return true;
  } catch (err) {
    console.error('Margin Notes: failed to write api-keys.json', err);
    return false;
  }
}