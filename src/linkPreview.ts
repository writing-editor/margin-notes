import { App, Component, MarkdownRenderer, TFile } from 'obsidian';
import { LinkMarker } from './linkMarkers';

/**
 * A cache entry's lifecycle state. "pending" while the disk read + render is
 * in flight, "ready" once content is available, "missing" if the link
 * target doesn't resolve to a real file (Gotcha #5's "note not found" case
 * — never silently show nothing, never throw), "error" if resolution
 * succeeded but rendering itself threw (belt-and-suspenders; render() isn't
 * expected to throw for normal markdown, but a chip must never break the
 * whole margin column if it somehow does).
 */
type PreviewState =
  | { status: 'pending' }
  | { status: 'ready'; el: HTMLElement }
  | { status: 'missing'; linkpath: string }
  | { status: 'error' };

interface CacheEntry {
  state: PreviewState;
  mtime: number | null; // dest.stat.mtime at render time, for cache invalidation
  component: Component; // owns the rendered DOM's child renderers — see Gotcha #7
  listeners: Set<() => void>; // chips waiting on this entry to update in place
}

// Keyed by resolved file path (not linkpath text) so two different [[link
// text]] spellings that resolve to the same file share one cache entry and
// one render. Re-keyed to path + mtime effectively via the entry's own
// `mtime` field (checked on every request rather than folded into the key
// string) so a modify event can invalidate in place without churning the
// map's keys.
const cache = new Map<string, CacheEntry>();

// One Component per plugin lifetime owns all preview renders' cleanup
// hooks. This is simpler than "one Component per cache entry, individually
// unloaded" (Gotcha #7 mentions either is acceptable) and matches how the
// margin column itself is a single long-lived object per editor — we unload
// the whole thing once, in disposeAllLinkPreviews(), called from
// MarginColumn.destroy() so nothing leaks when an editor view closes.
// Individual cache entries are NOT unloaded piecemeal on eviction; eviction
// here only ever means "re-render," and re-rendering into the SAME
// Component is fine (Obsidian's Component.load()/unload() are about this
// component's own children, and re-rendering into the same el via
// MarkdownRenderer.render() again is a supported, idiomatic re-render, not
// a leak) — so entries are simply overwritten in place rather than each
// carrying its own Component to unload individually.
let sharedComponent: Component | null = null;

function getSharedComponent(): Component {
  if (!sharedComponent) {
    sharedComponent = new Component();
    sharedComponent.load();
  }
  return sharedComponent;
}

/** Call once when the whole plugin unloads (not per-editor) — see main.ts onunload(). */
export function disposeAllLinkPreviews() {
  sharedComponent?.unload();
  sharedComponent = null;
  cache.clear();
}

/**
 * Returns the current preview state for a link marker synchronously (never
 * blocks), kicking off an async fetch-resolve-render if there's no entry yet
 * or the cached one is stale. `onUpdate` is called (possibly more than
 * once — e.g. once when the fetch resolves, again later if the target file
 * is modified) when this specific marker's preview state changes, so the
 * caller (marginPanel.ts) can swap just that one chip's inner content in
 * place without re-running the whole margin layout pass.
 *
 * Caller is responsible for calling the returned `unsubscribe()` when the
 * chip is torn down (e.g. next render() pass rebuilds the track), so stale
 * chips don't keep receiving updates for a DOM node that no longer exists.
 */
export function getLinkPreview(
  app: App,
  marker: LinkMarker,
  sourcePath: string,
  onUpdate: () => void
): { state: PreviewState; unsubscribe: () => void } {
  const dest = app.metadataCache.getFirstLinkpathDest(marker.linkpath, sourcePath);

  if (!dest) {
    // Broken link — resolve target doesn't exist (yet). This is a stable,
    // synchronous answer (no caching needed; re-resolved fresh every call,
    // which is cheap — it's an in-memory metadataCache lookup, not disk
    // I/O), and per Gotcha #5's brief: show a distinct state, don't throw,
    // don't silently show nothing.
    return { state: { status: 'missing', linkpath: marker.linkpath }, unsubscribe: () => {} };
  }

  const key = dest.path;
  const existing = cache.get(key);
  const currentMtime = dest.stat.mtime;

  if (existing && existing.mtime === currentMtime) {
    existing.listeners.add(onUpdate);
    return { state: existing.state, unsubscribe: () => existing.listeners.delete(onUpdate) };
  }

  // No entry, or the file's mtime moved since we last rendered it (either a
  // fresh request or an invalidation from vault.on('modify') — see
  // watchForInvalidation below) — (re)kick off the fetch-render pipeline.
  const entry: CacheEntry = {
    state: { status: 'pending' },
    mtime: currentMtime,
    component: getSharedComponent(),
    listeners: new Set([onUpdate]),
  };
  cache.set(key, entry);
  renderInto(app, dest, entry);

  return { state: entry.state, unsubscribe: () => entry.listeners.delete(onUpdate) };
}

async function renderInto(app: App, dest: TFile, entry: CacheEntry): Promise<void> {
  try {
    // cachedRead, not read: this is a read-only preview, so serving from
    // Obsidian's own cache (when available) avoids hitting disk on every
    // margin render — see §2.2 step 3 of the plan.
    const markdown = await app.vault.cachedRead(dest);
    const scratch = document.createElement('div');
    scratch.className = 'mn-link-preview-content';
    // sourcePath here is dest.path (the file being rendered), not the
    // original linking file — internal links/embeds *within* the preview
    // should resolve relative to the previewed note itself, same as
    // Obsidian's own embed rendering would.
    await MarkdownRenderer.render(app, markdown, scratch, dest.path, entry.component);
    entry.state = { status: 'ready', el: scratch };
  } catch (err) {
    console.error('Margin Notes: failed to render link preview for', dest.path, err);
    entry.state = { status: 'error' };
  }
  // Notify whoever's still listening (a chip's own unsubscribe removes it
  // from this set the moment it's torn down, so a stale listener from a
  // long-since-rebuilt chip is never called here).
  for (const listener of entry.listeners) listener();
}

/**
 * Wire up cache invalidation for file modifications. Call once from
 * main.ts's onload() (parallel to its other registerEvent calls) — NOT
 * per-editor, since the cache itself is module-level/shared across all
 * open editors' margin columns.
 */
export function registerLinkPreviewInvalidation(app: App): { unregister: () => void } {
  const handler = (file: TFile) => {
    const entry = cache.get(file.path);
    if (!entry) return; // nothing cached for this file — nothing to invalidate
    entry.mtime = null; // force the next getLinkPreview() call to treat this as stale
    // Re-render eagerly rather than waiting for the next getLinkPreview()
    // call, so an already-open margin chip showing this note updates live
    // when the note is edited elsewhere, not just next time a chip happens
    // to be rebuilt for an unrelated reason.
    entry.state = { status: 'pending' };
    for (const listener of entry.listeners) listener();
    renderInto(app, file, entry);
  };
  // Obsidian's Vault.on has a specific overload for 'modify' typed as
  // (name: 'modify', callback: (file: TFile) => any) => EventRef, but
  // TypeScript's overload resolution needs 'modify' to reach it as a
  // literal type, not as `string`. In some TS/obsidian.d.ts version
  // combinations that overload isn't picked up here and it falls back to
  // the generic Events.on(name: string, callback: (...data: unknown[]) =>
  // unknown) signature, producing a type error on `handler`'s parameter.
  // Casting through `unknown` sidesteps the overload-resolution issue
  // without changing runtime behavior at all — `app.vault.on` still emits
  // 'modify' with a single TFile argument regardless of how TS typed it.
  const ref = app.vault.on('modify', handler as unknown as (...data: unknown[]) => unknown);
  return { unregister: () => app.vault.offref(ref) };
}