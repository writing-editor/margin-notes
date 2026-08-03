// CM6 StateFields/ViewPlugins are pure and have no constructor arguments once
// registered via registerEditorExtension, so they have no direct route to
// "this plugin instance". The standard workaround (used by most Obsidian CM6
// plugins) is a small mutable singleton the plugin writes to on load/settings
// change, and the stateless extensions read from. There is only ever one
// instance of this plugin running, so this is safe.
import type { App, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, MarginNotesSettings } from './settings';

export const runtime: { app: App | null; settings: MarginNotesSettings } = {
  app: null,
  settings: DEFAULT_SETTINGS,
};

// Last-known frontmatter-mode enabled/disabled result, keyed by file path.
// Exists specifically to survive the brief window after a doc edit where
// app.metadataCache.getFileCache(file) returns null because Obsidian hasn't
// finished its own debounced re-parse of the file's frontmatter yet — that
// window is real and asynchronous, independent of anything this plugin
// controls, and without this cache a null read during it was
// indistinguishable from "this file genuinely has no margin-notes
// property", causing isMarginNotesEnabled to return false and every note in
// the file to lose its decoration simultaneously for that one call. Falling
// back to the last DEFINITE (non-null cache) reading for this file instead
// of collapsing to false closes that gap.
const lastKnownFrontmatterEnabled = new Map<string, boolean>();

/**
 * The single source of truth for "does this file get margin notes". Called
 * from the note-decoration StateField (every doc/selection change) and from
 * the margin-column ViewPlugin (every render pass), so keep it cheap —
 * metadataCache.getFileCache() is an in-memory lookup, not disk I/O.
 */
export function isMarginNotesEnabled(file: TFile | null): boolean {
  const { settings, app } = runtime;
  if (!file || !app || !settings.enabled) return false;

  if (settings.triggerMode === 'all') return true;

  if (settings.triggerMode === 'folder') {
    const folder = settings.folderPath.trim().replace(/^\/+|\/+$/g, '');
    if (!folder) return false;
    return file.path === folder || file.path.startsWith(folder + '/');
  }

  // frontmatter mode
  const key = settings.frontmatterKey.trim() || DEFAULT_SETTINGS.frontmatterKey;
  const cache = app.metadataCache.getFileCache(file);
  if (cache === null) {
    // No current reading available (mid-reparse) — use whatever this file's
    // last DEFINITE reading was, defaulting to false only the very first
    // time this file is ever seen (nothing to fall back to yet).
    return lastKnownFrontmatterEnabled.get(file.path) ?? false;
  }
  const value: unknown = cache.frontmatter?.[key];
  const enabled = value === true || value === 'true';
  lastKnownFrontmatterEnabled.set(file.path, enabled);
  return enabled;
}