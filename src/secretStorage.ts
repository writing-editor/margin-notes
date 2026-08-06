import { App, requireApiVersion } from 'obsidian';

// Obsidian shipped a native SecretStorage API on `App.secretStorage`
// starting in v1.11.4 (types confirmed against the currently installed
// 'obsidian' package's obsidian.d.ts — see the SecretStorage class there):
//
//   setSecret(id: string, secret: string): void
//   getSecret(id: string): string | null
//   listSecrets(): string[]
//
// It's synchronous (no Promises), backed by the OS's own secret store
// (Electron safeStorage under the hood on desktop — macOS Keychain /
// Windows Credential Manager / Linux secret service — and available on
// mobile too, from 1.11.4 onward there as well). Obsidian owns all of the
// platform-detection, shape-checking, and unprotected-Linux-backend
// fallback logic internally now — none of that has to live in this
// plugin anymore.
//
// One important difference from a plugin-private store: per Obsidian's
// own changelog, this is "a new opt-in way for plugins to save keys that
// might be shared across multiple plugins" — i.e. secret IDs are a
// single namespace, not implicitly scoped to the plugin that wrote them.
// A bare "claudeKey" could collide with some other installed plugin using
// the same id for an unrelated purpose. Every id this plugin uses is
// therefore prefixed, so it can never collide with another plugin's.
const ID_PREFIX = 'margin-notes-';

/**
 * Minimum Obsidian version that exposes App.secretStorage. Kept as a
 * named constant for every non-guard reference (the human-readable
 * messages below, nativeSecretStorageAvailable()'s own check) so there's
 * one place to update if this ever changes \u2014 EXCEPT inside
 * setNativeSecret/getNativeSecret's own requireApiVersion guards below,
 * which intentionally repeat this same value as an inline string
 * literal instead (see the comment on those guards for why). If this
 * constant ever changes, update those two literals to match.
 */
const MIN_SECRET_STORAGE_VERSION = '1.11.4';

/**
 * This plugin's own minAppVersion (manifest.json) is intentionally kept
 * BELOW 1.11.4 rather than raised to require it — see manifest.json and
 * the "Network use" section of README.md for the reasoning. That means
 * this module has to run correctly on older Obsidian too, where
 * `app.secretStorage` simply doesn't exist. `requireApiVersion` is the
 * documented way to check that without touching the (possibly-absent)
 * property directly.
 */
export function nativeSecretStorageAvailable(): boolean {
  return requireApiVersion(MIN_SECRET_STORAGE_VERSION);
}

/** Human-readable line for the settings tab — same job secureStorage.ts's secretStorageDescription() used to do, updated for the new reality. */
export function secretStorageDescription(): string {
  if (nativeSecretStorageAvailable()) {
    return 'Stored via Obsidian\u2019s built-in secret storage, encrypted at rest through your OS keychain.';
  }
  return (
    `Your Obsidian version predates ${MIN_SECRET_STORAGE_VERSION}, which is when Obsidian added built-in ` +
    'encrypted secret storage \u2014 stored in plain text in this plugin\u2019s data.json until you upgrade Obsidian.'
  );
}

/**
 * Obsidian's secret storage requires ids to be lowercase letters, numbers,
 * and dashes only (64 chars max) — see the error this guards against:
 * "Secret ID is invalid. Use only lowercase letters, numbers and dashes."
 * The plugin's own field names (e.g. SecretSettings's `geminiKey`,
 * `claudeKey`, `openaiKey`) are camelCase and would violate that rule as-is,
 * so every id is run through this before being namespaced: camelCase
 * boundaries become dashes and the whole thing is lowercased, turning
 * "geminiKey" into "gemini-key". This has to happen for every id (not just
 * the ones known to be camelCase today) so any future field name is safe
 * automatically instead of relying on every call site remembering to name
 * fields dash-safe up front.
 */
function sanitizeIdSegment(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
}

function namespacedId(id: string): string {
  return `${ID_PREFIX}${sanitizeIdSegment(id)}`;
}

/**
 * Returns every secret id THIS plugin has stored (unprefixed — e.g.
 * "gemini-key", not "margin-notes-gemini-key"), for use as suggestions in
 * the settings tab. `app.secretStorage.listSecrets()` returns the WHOLE
 * shared namespace (see the module comment above on why ids are prefixed
 * in the first place) — filtering to this plugin's own prefix here is
 * what keeps some other plugin's unrelated entries out of the suggestion
 * list. Never throws; returns [] on any failure or pre-1.11.4.
 */
export function listNativeSecretIds(app: App): string[] {
  if (requireApiVersion('1.11.4')) {
    try {
      return app.secretStorage
        .listSecrets()
        .filter((id) => id.startsWith(ID_PREFIX))
        .map((id) => id.slice(ID_PREFIX.length));
    } catch (err) {
      console.error('Margin Notes: failed to list secrets from Obsidian\u2019s secret storage', err);
      return [];
    }
  }
  return [];
}

/**
 * Reads a secret by its already-sanitized, unprefixed id (e.g.
 * "gemini-key") rather than by a SecretSettings field name — used when
 * pulling in a value from a suggestion the person picked, which may not
 * correspond to any of this plugin's own field names (e.g. they picked
 * some other id this plugin previously stored under a different
 * provider). Skips namespacedId()'s camelCase-to-dash-case rewrite since
 * the id here is already in that form; only re-prefixes it.
 */
export function getNativeSecretById(app: App, sanitizedId: string): string {
  if (requireApiVersion('1.11.4')) {
    try {
      return app.secretStorage.getSecret(`${ID_PREFIX}${sanitizedId}`) ?? '';
    } catch (err) {
      console.error(`Margin Notes: failed to read secret "${sanitizedId}" from Obsidian's secret storage`, err);
      return '';
    }
  }
  return '';
}

/**
 * Writes a secret through Obsidian's native store when available. Never
 * throws \u2014 a failed write is logged and reported via the boolean instead,
 * since losing an already-typed-in key to a crash is worse than a
 * silent-but-logged failure (same posture the old saveSecretsFile() had).
 * Guarded by requireApiVersion directly in this function (not just at
 * call sites) so it's never possible to reach app.secretStorage on an
 * Obsidian version that doesn't have it, however this gets called from.
 * The guard is written as an enclosing `if`, not an early return, so
 * eslint-plugin-obsidianmd's no-unsupported-api rule can statically
 * verify the call is actually reachable-only-when-supported \u2014 that
 * rule only recognizes the call sitting inside the guard's own `if`
 * branch, not a preceding early-return with the same effect.
 */
export function setNativeSecret(app: App, id: string, value: string): boolean {
  // Literal version string (not MIN_SECRET_STORAGE_VERSION) is required
  // right here \u2014 eslint-plugin-obsidianmd's no-unsupported-api rule only
  // recognizes requireApiVersion('x.y.z') with an inline string literal
  // as a valid guard, not a call through a named constant. Every other
  // reference to this version elsewhere in the file still goes through
  // the constant.
  if (requireApiVersion('1.11.4')) {
    try {
      app.secretStorage.setSecret(namespacedId(id), value);
      return true;
    } catch (err) {
      console.error(`Margin Notes: failed to write secret "${id}" to Obsidian's secret storage`, err);
      return false;
    }
  }
  return false;
}

/** Returns '' (never throws) if the secret isn't set, can't be read, or this Obsidian version predates native secret storage \u2014 see setNativeSecret's comment on the requireApiVersion guard. */
export function getNativeSecret(app: App, id: string): string {
  if (requireApiVersion('1.11.4')) {
    try {
      return app.secretStorage.getSecret(namespacedId(id)) ?? '';
    } catch (err) {
      console.error(`Margin Notes: failed to read secret "${id}" from Obsidian's secret storage`, err);
      return '';
    }
  }
  return '';
}

/**
 * Minimal plaintext fallback for Obsidian versions before 1.11.4, where
 * `app.secretStorage` doesn't exist at all. Values here are stored
 * as-is, in the plain settings object that ends up in data.json \u2014
 * matching secretStorageDescription()'s honest "plain text until you
 * upgrade" message above rather than claiming protection that isn't
 * happening. This exists ONLY as a stopgap for old installs; once a
 * person's Obsidian is 1.11.4+, values are read/written through the
 * native store instead and this path isn't touched.
 */
export type PlaintextFallbackSecrets = Record<string, string>;