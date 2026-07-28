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
  const value = cache?.frontmatter?.[key];
  return value === true || value === 'true';
}
