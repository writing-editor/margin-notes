import { App, Component, MarkdownRenderer, TFile } from 'obsidian';
import { LinkMarker } from './linkMarkers';

/**
 * A cache entry's lifecycle state. "pending" while the disk read is in
 * flight, "ready" once the target's raw markdown has been fetched (NOTE:
 * "ready" carries the raw markdown STRING, not a rendered DOM element — see
 * the cache comment below for why), "missing" if the link target doesn't
 * resolve to a real file, "error" if the disk read itself threw.
 */
type PreviewState =
  | { status: 'pending' }
  | { status: 'ready'; markdown: string; renderSourcePath: string }
  | { status: 'missing'; linkpath: string }
  | { status: 'error' };

interface CacheEntry {
  state: PreviewState;
  mtime: number | null; // dest.stat.mtime at fetch time, for cache invalidation
  listeners: Set<() => void>; // chips waiting on this entry to update in place
}

// Keyed by resolved file path (not linkpath text) so two different [[link
// text]] spellings that resolve to the same file share one fetch. Re-keyed
// to path + mtime effectively via the entry's own `mtime` field (checked on
// every request rather than folded into the key string) so a modify event
// can invalidate in place without churning the map's keys.
//
// IMPORTANT — what this cache stores and why: it originally cached a single
// rendered HTMLElement per target file, built once via MarkdownRenderer and
// then handed out to every chip that referenced that target. That was
// broken: a DOM node can only ever have ONE parent, so when multiple
// [[links]] point at the same note (a common case — the same note is often
// linked more than once in a document), only the LAST chip to receive the
// shared element via replaceChildren() actually kept it — every earlier
// chip that had already inserted it got it silently ripped back out from
// under it the moment a later chip claimed it. This produced exactly the
// reported symptom: intermittent, order-dependent chips showing just
// "link"/"embed" with no preview, "fixed" by removing a neighboring link
// (removing the competing claimant), and different behavior across
// scroll/reload (re-render order changed who claimed the node last).
//
// Fix: the cache now stores only the fetched, immutable MARKDOWN STRING
// (cheap — a JS string can be "shared" by any number of readers with no
// conflict). Each individual chip renders its OWN fresh DOM element from
// that shared string via renderForConsumer() below, using its OWN
// Component for lifecycle (see COMPONENT NOTE below) — so N chips
// referencing the same target now correctly get N independent, correctly
// populated preview elements, at the cost of re-running
// MarkdownRenderer.render() N times instead of once. That's the right
// trade: re-rendering markdown is cheap; silently losing a chip's content
// to a sibling is not acceptable.
const cache = new Map<string, CacheEntry>();

// COMPONENT NOTE: previously one shared, plugin-lifetime Component owned
// every rendered element. Now that each chip renders its own element (see
// above), each render also gets its own Component, created fresh per
// render call and owned by the caller (marginPanel.ts) — NOT tracked in
// this module at all, since this module no longer holds long-lived
// references to rendered DOM. marginPanel.ts is responsible for calling
// `.unload()` on the Component it received when its chip is torn down; see
// buildLinkChip()'s handling of the `component` returned alongside each
// rendered element.

/**
 * Returns the current preview state for a link marker synchronously (never
 * blocks), kicking off an async fetch if there's no entry yet or the cached
 * one is stale. `onUpdate` is called (possibly more than once — e.g. once
 * when the fetch resolves, again later if the target file is modified)
 * when this specific marker's preview state changes, so the caller
 * (marginPanel.ts) can swap just that one chip's inner content in place
 * without re-running the whole margin layout pass.
 *
 * Caller is responsible for calling the returned `unsubscribe()` when the
 * chip is torn down (e.g. next render() pass rebuilds the track), so stale
 * chips don't keep receiving updates for a DOM node that no longer exists.
 *
 * Unlike the earlier version, `dest` resolution is NOT treated as a stable
 * answer once 'missing' — every call re-resolves fresh via
 * getFirstLinkpathDest (cheap, in-memory), so a link that briefly failed
 * to resolve (e.g. right after the target file was created, before
 * metadataCache finished indexing it) self-corrects on the very next call
 * to getLinkPreview() rather than being stuck showing "missing" forever
 * with no path back to "ready".
 */
export function getLinkPreview(
  app: App,
  marker: LinkMarker,
  sourcePath: string,
  onUpdate: () => void
): { state: PreviewState; unsubscribe: () => void } {
  const dest = app.metadataCache.getFirstLinkpathDest(marker.linkpath, sourcePath);

  if (!dest) {
    return { state: { status: 'missing', linkpath: marker.linkpath }, unsubscribe: () => {} };
  }

  const key = dest.path;
  const existing = cache.get(key);
  const currentMtime = dest.stat.mtime;

  if (existing && existing.mtime === currentMtime) {
    existing.listeners.add(onUpdate);
    return { state: existing.state, unsubscribe: () => existing.listeners.delete(onUpdate) };
  }

  // No entry, or the file's mtime moved since we last fetched it (either a
  // fresh request or an invalidation from vault.on('modify') — see
  // registerLinkPreviewInvalidation below) — (re)kick off the fetch.
  const entry: CacheEntry = {
    state: { status: 'pending' },
    mtime: currentMtime,
    listeners: new Set([onUpdate]),
  };
  cache.set(key, entry);
  // fetchInto is deliberately not awaited here — this function returns the
  // CURRENT (pending) state synchronously so the caller can render a
  // placeholder immediately, while the fetch resolves in the background and
  // notifies listeners via entry.listeners. It never rejects (see its own
  // try/catch, which always resolves by setting entry.state to 'ready' or
  // 'error'), so `void` is a correct, deliberate fire-and-forget here, not
  // a missed error path.
  void fetchInto(app, dest, entry);

  return { state: entry.state, unsubscribe: () => entry.listeners.delete(onUpdate) };
}

async function fetchInto(app: App, dest: TFile, entry: CacheEntry): Promise<void> {
  try {
    // cachedRead, not read: this is a read-only preview, so serving from
    // Obsidian's own cache (when available) avoids hitting disk on every
    // margin render.
    const fullMarkdown = await app.vault.cachedRead(dest);
    entry.state = { status: 'ready', markdown: excerptFor(fullMarkdown), renderSourcePath: dest.path };
  } catch (err) {
    console.error('Margin Notes: failed to read link preview target', dest.path, err);
    entry.state = { status: 'error' };
  }
  for (const listener of entry.listeners) listener();
}

// How much of a target note's content a link chip actually needs to show,
// before this got fixed: NONE of it was limited — the cache stored, and
// renderForConsumer() rendered, the ENTIRE target file's markdown on
// every chip, every render. mn: notes never had this problem (they're
// short by construction — a person types them by hand directly into the
// margin) so it went unnoticed until a document linked to a genuinely
// long note, or linked to the same note several times: each chip ran a
// full MarkdownRenderer.render() pass over the whole file, repeatedly,
// which is real, measurable lag on a large vault, not a display nicety.
//
// Truncating the SOURCE markdown here (before it ever reaches
// MarkdownRenderer.render() in renderForConsumer) fixes the actual cost —
// CSS max-height/overflow alone would still pay for rendering the entire
// document, just hide most of it visually afterward, which does nothing
// for the lag this was actually about.
const EXCERPT_MAX_LINES = 6;
const EXCERPT_MAX_CHARS = 400;

function excerptFor(fullMarkdown: string): string {
  const lines = fullMarkdown.split('\n');
  // Skip a leading frontmatter block entirely — showing "---\ntags: ..."
  // as a linked note's "preview" is never useful, and it would otherwise
  // eat most or all of a short excerpt budget on metadata instead of
  // actual content.
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const closing = lines.indexOf('---', 1);
    if (closing !== -1) start = closing + 1;
  }
  const body = lines.slice(start).join('\n').trimStart();
  const lineLimited = body.split('\n').slice(0, EXCERPT_MAX_LINES).join('\n');
  const excerpt =
    lineLimited.length > EXCERPT_MAX_CHARS ? lineLimited.slice(0, EXCERPT_MAX_CHARS) : lineLimited;
  const wasTruncated = excerpt.length < body.length;
  return wasTruncated ? `${excerpt.trimEnd()}…` : excerpt;
}

/**
 * Renders a FRESH, independent DOM element from an already-fetched
 * 'ready' state's markdown — call this once per chip, every time that
 * chip needs to (re)render its preview. Returns both the element and a
 * Component the caller must `.unload()` when the chip is torn down (each
 * render gets its own Component rather than sharing one, since the
 * element itself is no longer shared either — see the cache's top comment
 * for the full reasoning).
 */
export async function renderForConsumer(
  app: App,
  state: Extract<PreviewState, { status: 'ready' }>
): Promise<{ el: HTMLElement; component: Component }> {
  const el = createDiv({ cls: 'mn-link-preview-content' });
  const component = new Component();
  component.load();
  await MarkdownRenderer.render(app, state.markdown, el, state.renderSourcePath, component);
  return { el, component };
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
    entry.state = { status: 'pending' };
    for (const listener of entry.listeners) listener();
    void fetchInto(app, file, entry); // see the other call site's comment — never rejects, deliberately fire-and-forget
  };
  const ref = app.vault.on('modify', handler as unknown as (...data: unknown[]) => unknown);
  return { unregister: () => app.vault.offref(ref) };
}

/** Call once when the whole plugin unloads (not per-editor) — see main.ts onunload(). */
export function disposeAllLinkPreviews() {
  cache.clear();
}