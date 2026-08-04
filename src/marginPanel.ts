import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { editorInfoField, Platform, Modal, Notice } from 'obsidian';
import type { App, Component, TFile, WorkspaceLeaf } from 'obsidian';
import { runtime, isMarginNotesEnabled } from './runtime';
import { findNoteMarkers, forceMarginRefresh, NoteMarker } from './noteMarkers';
import { findTopLevelLinkMarkers, linkDisplayText, LinkMarker } from './linkMarkers';
import { getLinkPreview, renderForConsumer } from './linkPreview';
import { noteTypeColor, LINK_CHIP_COLOR } from './noteTypes';
import { MarginItem, layoutMarginItems, invalidateTrack } from './marginLayout';
import type { Placement } from './agents';
import { renderPlacementText } from './agents';

/**
 * Small trash-can icon (not an "×") for the per-chip delete button — an "×"
 * reads as "dismiss/close the hover-zoom", which is exactly the wrong
 * signal for a destructive, irreversible-feeling action. A bin icon makes
 * "this deletes the note" unambiguous at a glance, without needing a text
 * label the tiny badge has no room for anyway.
 *
 * Built via Obsidian's own `createSvg`/`createEl` element-creation methods
 * (available on every HTMLElement/SVGElement, per Obsidian's `Node`
 * interface extension in obsidian.d.ts) rather than an innerHTML string.
 * The string was a fixed constant with no user input, so it was never an
 * actual injection risk, but Obsidian's own reviewer/linter flags
 * innerHTML categorically since it can't tell "safe hardcoded constant"
 * apart from "unsafe interpolated string" — and separately prefers its
 * own createEl-family helpers over raw `document.createElement`/
 * `document.createElementNS` so every plugin's DOM construction goes
 * through one consistent, typed API.
 */
function appendTrashIcon(button: HTMLButtonElement): void {
  const svg = button.createSvg('svg', { attr: { viewBox: '0 0 24 24' } });
  const paths = ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13', 'M10 11v6', 'M14 11v6'];
  for (const d of paths) {
    svg.createSvg('path', { attr: { d } });
  }
}

/**
 * One shared builder for both chip kinds' delete buttons, so the pinned-
 * badge positioning/hover-reveal behaviour (all in styles.css's
 * .mn-chip-delete rules) and the "don't let this click fall through to the
 * chip's own mousedown handler" guard live in exactly one place rather than
 * being duplicated (and risking drifting apart) between buildChip() and
 * buildLinkChip().
 */
function buildDeleteButton(onDelete: () => void): HTMLButtonElement {
  const btn = createEl('button', { cls: 'mn-chip-delete', attr: { type: 'button', 'aria-label': 'Delete note' } });
  appendTrashIcon(btn);
  btn.addEventListener('mousedown', (evt) => {
    // Must stop this before it bubbles to the chip's own mousedown listener
    // (buildChip's focusNoteText / buildLinkChip's openLinkText) — otherwise
    // deleting would also fire the chip's normal "navigate/focus" action on
    // the same click.
    evt.preventDefault();
    evt.stopPropagation();
    onDelete();
  });
  return btn;
}

/**
 * Tiny confirm dialog for the one truly irreversible-feeling action here:
 * deleting a linked note's actual file. Obsidian has no built-in confirm
 * modal, so this is the minimal Modal subclass needed for a yes/no prompt.
 * Deliberately NOT used for mn (inline) notes — deleting inline text the
 * user can immediately Ctrl+Z is a much lower-stakes action than deleting
 * a file, so that path (see buildChip below) deletes instantly instead.
 */
class ConfirmDeleteFileModal extends Modal {
  constructor(app: App, private readonly fileName: string, private readonly onConfirm: () => void) {
    super(app);
  }
  onOpen() {
    this.titleEl.setText('Delete note?');
    this.contentEl.createEl('p', {
      text: `"${this.fileName}" will be deleted. This also removes the link from this document.`,
    });
    const buttons = this.contentEl.createDiv({ cls: 'mn-confirm-delete-buttons' });
    const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());
    const deleteBtn = buttons.createEl('button', { text: 'Delete', cls: 'mod-warning' });
    deleteBtn.addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
  }
}

// Exported so main.ts's insert-note command can splice a new marker into a
// specific view without duplicating the [mn.type: content] formatting rule.
export function insertNoteAt(view: EditorView, pos: number, type: string | null, content: string) {
  const tag = type ? `mn.${type}` : 'mn';
  const marker = `[${tag}: ${content}]`;
  view.dispatch({ changes: { from: pos, to: pos, insert: marker }, selection: { anchor: pos } });
}

/**
 * Inserting from the highest charPos down means each insertion never shifts
 * the position of one already placed above it — the shift only propagates
 * to positions greater than the insertion point, and we've already handled
 * those. Used by the agent runner to land several notes in one file.
 *
 * Plan §2 — a `kind: 'report'` placement inserts a plain `[[link]]`
 * (already-built text, via `reportLinkTexts`, keyed by charPos) instead of
 * an `[mn.ai: ...]` marker — see renderPlacementText's and
 * buildReportLinkText's doc comments in agents.ts for why. Dispatched as
 * one plain string insert exactly like insertNoteAt's own marker string;
 * CodeMirror doesn't need to know it happens to contain `[[...]]`
 * syntax — Obsidian's own link-parsing extension (already registered
 * elsewhere) picks it up the same way it would a hand-typed link.
 */
export function insertAiNotes(view: EditorView, placements: Placement[], reportLinkTexts: Map<number, string> = new Map()) {
  const sorted = [...placements].sort((a, b) => b.charPos - a.charPos);
  for (const p of sorted) {
    const insertText = renderPlacementText(p, reportLinkTexts.get(p.charPos));
    view.dispatch({ changes: { from: p.charPos, to: p.charPos, insert: insertText }, selection: { anchor: p.charPos } });
  }
}

/**
 * Stable merge of two already-individually-sorted (by `.from`) MarginItem
 * lists into one combined, still-sorted list. Used to combine note-marker
 * items and link-marker items before handing them to layoutMarginItems(),
 * which requires its input pre-sorted rather than sorting internally
 * (different marker kinds may need this kind of merge rather than an
 * independent full sort).
 */
function mergeByFrom(a: MarginItem[], b: MarginItem[]): MarginItem[] {
  const out: MarginItem[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].from <= b[j].from) out.push(a[i++]);
    else out.push(b[j++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

// How long to hold off rebuilding the margin column after a doc-changing
// keystroke, in ms — only applies to changes isDocChangeLayoutRelevant()
// (below) flags as actually able to move/add/remove a chip; a plain
// same-line character edit that isn't near a marker never reaches this at
// all (see the ViewPlugin's update()), so this only ever debounces a
// genuine burst of marker/newline edits rather than every keystroke.
const TYPING_DEBOUNCE_MS = 200;

// Safety-net interval, in ms, for a background refresh independent of any
// specific trigger. isDocChangeLayoutRelevant() is a heuristic over each
// transaction's inserted/deleted text — deliberately cheap, which means
// deliberately not exhaustive. If some edit path ever slips past it
// (an edge case in how CodeMirror batches/represents a particular kind of
// change, a future marker syntax this heuristic wasn't updated for, etc.),
// this periodic refresh is what self-corrects the column within a bounded
// worst-case delay instead of leaving it stale until some unrelated trigger
// (scroll, resize, selection move) happens to fire. 4s is long enough to
// cost nothing while idle or mid-typing, short enough that a missed
// condition is never wrong for more than a glance.
const SAFETY_NET_INTERVAL_MS = 4000;

/**
 * Cheap pre-filter for whether a doc-changing transaction could possibly
 * need a margin-column rebuild at all, checked BEFORE any debounce timer
 * is even armed (see the ViewPlugin's update() below) — most individual
 * keystrokes (typing a normal character in the middle of a line, nowhere
 * near any marker) touch neither a line count nor any marker-relevant
 * character, so they can be skipped entirely with zero rebuild, zero
 * debounce timer churn, and zero rescan of the document.
 *
 * Deliberately over-inclusive rather than exact: this only looks at the
 * raw characters/line-count of what changed, not whether a full marker
 * scan would actually find something new. A false positive here just
 * costs one debounced rebuild that turns out to reconfirm the same layout
 * (cheap, correct); a false negative would leave the column stale, which
 * is why every check below errs toward "yes, that counts":
 *
 * - Any inserted or deleted text containing '\n' — a line count change
 *   shifts every marker anchor below it, even ones the edit itself didn't
 *   touch (this is the single most common layout-relevant edit: pressing
 *   Enter).
 * - Any inserted or deleted text containing '[' or ']' — the only
 *   characters MN_RE (note markers) and LINK_RE (link markers) can start
 *   or end on. An edit that can't possibly create, remove, or resize a
 *   bracketed span can't change which markers exist.
 */
function isDocChangeLayoutRelevant(update: ViewUpdate): boolean {
  let relevant = false;
  update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (relevant) return; // already found a reason; skip scanning the rest
    const insertedText = inserted.toString();
    if (/[\n[\]]/.test(insertedText)) {
      relevant = true;
      return;
    }
    // Deleted text isn't available as a string directly from iterChanges
    // (it only gives us the INSERTED Text) — but a deletion that removed a
    // newline or bracket is exactly as layout-relevant as inserting one,
    // so read it from the pre-change doc via the fromA/toA range.
    const deletedText = update.startState.doc.sliceString(_fromA, _toA);
    if (/[\n[\]]/.test(deletedText)) {
      relevant = true;
    }
  });
  return relevant;
}

class MarginColumn {
  private readonly track: HTMLDivElement;
  private rafHandle: number | null = null;
  private debounceHandle: number | null = null;
  // Belt-and-suspenders background refresh — see SAFETY_NET_INTERVAL_MS's
  // doc comment. Scheduled with `immediate: false` so it competes for the
  // same debounce slot as a real edit rather than forcing its own
  // rebuild mid-keystroke; if nothing's actually changed, render() just
  // reconfirms the current layout at negligible cost.
  private safetyNetHandle: number | null = null;
  private readonly resizeObserver: ResizeObserver;
  // Tracks the current preview-update subscription per link marker id, so
  // rebuilding the same marker's chip on a later render() pass can
  // unsubscribe the previous chip's listener before registering the new
  // one — otherwise every render pass (docChanged/selection/scroll can all
  // trigger one) would leak one more listener into linkPreview.ts's cache
  // entry forever. See buildLinkChip() for where this is read/written.
  private readonly linkPreviewUnsubs = new Map<string, () => void>();
  // Each chip's rendered preview now owns its own Component (see
  // linkPreview.ts's renderForConsumer — this replaced one shared,
  // plugin-lifetime Component after that design was found to let one
  // chip's rendered DOM node get silently stolen by another chip
  // referencing the same target file). Tracked per marker id, same
  // rebuild-replaces-previous pattern as linkPreviewUnsubs, so the
  // previous render's Component is always unloaded before a new one
  // is created for the same marker.
  private readonly linkPreviewComponents = new Map<string, Component>();
  // Records, per link marker id, the markdown content string that marker's
  // chip was MOST RECENTLY LAID OUT against (i.e. what layoutMarginItems()
  // measured this chip's offsetHeight while showing). This exists to solve
  // a real bug: layoutMarginItems() runs synchronously, before any link's
  // async preview has necessarily resolved — so a chip can get positioned/
  // clamped based on its tiny one-line "pending" placeholder, and when the
  // real (often much taller) preview content swaps in afterward, nothing
  // re-ran the layout pass against the new, correct height. With several
  // links laid out close together, every one of them could get sized
  // against a placeholder and none of them clamped, then all grow to full
  // height in place once their previews load — overlapping or touching
  // with zero gap.
  // The fix (see buildLinkChip()): every time a chip's content is (re)set,
  // compare it against what's recorded here for that marker id. If it
  // differs — including the transition from "no entry yet" to "real
  // markdown text" — schedule a full re-render (which reruns
  // layoutMarginItems with this chip's now-correct height) exactly once,
  // then update the record. If a later render rebuilds the SAME marker's
  // chip and finds the SAME content already recorded, no re-layout is
  // triggered — this is what breaks what would otherwise be an infinite
  // reschedule loop (each reschedule would otherwise rebuild the chip,
  // synchronously find the same warm cache, and reschedule again forever).
  private readonly linkChipLayoutContent = new Map<string, string>();
  // The right-side split leaf this column has already opened a chip's
  // target into, if any — reused on subsequent chip clicks (from THIS
  // originating pane) instead of piling up a fresh split every time. Not
  // guaranteed to still be open: the user can close that pane manually at
  // any point after we stash the reference, so every read of this field
  // must re-validate it against the workspace's current leaves first (see
  // openInCompanionSplit()) rather than trusting the reference alone.
  private companionLeaf: WorkspaceLeaf | null = null;
  // Cached result of the mobile/narrow-pane gate (see updateChipsAllowed()).
  // Deliberately NOT recomputed inside every render() pass — render() also
  // runs on every debounced keystroke, and re-measuring clientWidth there
  // ties this gate's outcome to whatever the pane's width happens to be at
  // that exact moment, which can visibly flicker independently of any real
  // width change (e.g. while text is still reflowing mid-edit). This value
  // only changes in response to an actual width-changing event — window
  // resize/maximize, a sidebar opening/closing, a new pane splitting in
  // beside this one — via the ResizeObserver in the constructor (the sole
  // trigger; see its own comment for why CM6's geometryChanged flag is
  // deliberately NOT used here despite looking like a fit), never as a
  // side effect of typing.
  private chipsAllowed = true;

  constructor(private readonly view: EditorView) {
    // Appending inside .cm-scroller (not .cm-content) means the track scrolls
    // in lockstep with the text automatically — no manual scroll listener
    // needed, because both are laid out in the same scrolling coordinate
    // space. This is the trick that made the original app's manual
    // scroll-driven positionChips() unnecessary here.
    this.track = view.scrollDOM.createDiv({ cls: 'mn-margin-track' });
    // ResizeObserver on scrollDOM is the ONLY place chipsAllowed gets
    // recomputed from a live width measurement (see updateChipsAllowed()) —
    // it fires precisely on a real box-size change of the pane itself
    // (window resize/maximize, sidebar toggle, a sibling pane splitting in)
    // and nothing else. CM6's own ViewUpdate.geometryChanged flag looks
    // like it should cover the same cases, but per CM6's docs it ALSO
    // fires on ordinary typing that changes content height (e.g. a line
    // wrapping) — using it here previously caused chips to vanish while
    // typing (a live re-measurement + immediate rebuild racing against
    // the doc's own fast-changing state on every such keystroke). This
    // ResizeObserver is deliberately the only live-resize trigger now.
    this.resizeObserver = new ResizeObserver(() => {
      this.updateChipsAllowed();
      this.schedule();
    });
    this.resizeObserver.observe(view.scrollDOM);
    this.updateChipsAllowed();
    this.schedule(); // initial paint — immediate, nothing to debounce yet

    // Safety-net background refresh — see SAFETY_NET_INTERVAL_MS's doc
    // comment for why this exists alongside the targeted triggers above.
    // Uses `immediate: false` (the debounced path) so it never interrupts
    // active typing with its own forced rebuild — it just joins whatever
    // debounce window may already be pending, or starts one that fires
    // after the normal TYPING_DEBOUNCE_MS if nothing else is happening.
    const win = view.dom.ownerDocument.defaultView ?? window;
    this.safetyNetHandle = win.setInterval(() => this.schedule(false), SAFETY_NET_INTERVAL_MS);
  }

  /**
   * Recomputes and caches whether the chip column is allowed to show at
   * all right now (see the `chipsAllowed` field's own doc comment for why
   * this is split out from render() rather than inlined there). Also
   * applies the `mn-has-margin` class immediately here — that CSS class is
   * what actually reserves/releases the editor's margin-right space, so it
   * needs to flip in lockstep with this check, not lag behind it until the
   * next debounced render() happens to run.
   */
  updateChipsAllowed() {
    const info = this.view.state.field(editorInfoField, false);
    const file = info?.file ?? null;
    const enabled = isMarginNotesEnabled(file);

    // Mobile check first (cheap, no DOM measurement needed) — Platform.
    // isMobile covers phones specifically (Obsidian gives tablets the
    // desktop-style layout, so this deliberately does NOT also gate on
    // Platform.isTablet).
    const mobileBlocked = runtime.settings.disableChipsOnMobile && Platform.isMobile;

    // Pane-width check: view.scrollDOM's own clientWidth is the actual
    // rendered width of THIS editor pane specifically — reading it here
    // (rather than window.innerWidth) is what makes a split-pane layout
    // correctly narrow just the half that's actually narrow, without
    // affecting a sibling pane that still has room. This compares against
    // marginWidth * narrowPaneRatio rather than a fixed pixel number, so
    // the threshold scales correctly with whatever marginWidth the user
    // has actually configured (see settings.ts's doc comment on
    // narrowPaneRatio for why a fixed number doesn't work well here).
    // ratio <= 0 means "never hide for width".
    const ratio = runtime.settings.narrowPaneRatio;
    const paneWidth = this.view.scrollDOM.clientWidth;
    const paneTooNarrow = ratio > 0 && paneWidth < runtime.settings.marginWidth * ratio;

    this.chipsAllowed = enabled && !mobileBlocked && !paneTooNarrow;

    // mn-has-margin toggles on chipsAllowed, not on `enabled` alone — this
    // class is what reserves the CSS padding/margin space for the chip
    // column via --mn-margin-width. If chips are suppressed for width/
    // mobile reasons but this class stayed on anyway, the pane would
    // reserve empty space for nothing; basing it on chipsAllowed instead
    // means that reservation correctly disappears too, giving the narrow
    // pane's prose its full width back — which is the whole point of this
    // gate.
    this.view.scrollDOM.classList.toggle('mn-has-margin', this.chipsAllowed);
    this.view.scrollDOM.style.setProperty('--mn-margin-width', `${runtime.settings.marginWidth}px`);
    this.view.scrollDOM.style.setProperty(
      '--mn-chip-font-size',
      `calc(var(--font-text-size, 16px) * ${runtime.settings.chipFontRatio})`
    );
  }

  /**
   * @param immediate When false (the default caller for doc changes — see
   * marginPanel's update() below), a pending rebuild is debounced by
   * TYPING_DEBOUNCE_MS and re-armed on every call, so a fast run of
   * keystrokes collapses into a single rebuild once typing actually
   * pauses instead of one full rebuild per character. When true (scroll,
   * resize, non-typing selection moves), the rebuild is scheduled on the
   * very next animation frame as before — those triggers don't come in
   * keystroke-speed bursts, and users expect the column to track them
   * without a visible lag.
   */
  schedule(immediate = true) {
    if (!immediate) {
      const win = this.view.dom.ownerDocument.defaultView ?? window;
      if (this.debounceHandle !== null) win.clearTimeout(this.debounceHandle);
      this.debounceHandle = win.setTimeout(() => {
        this.debounceHandle = null;
        this.scheduleFrame();
      }, TYPING_DEBOUNCE_MS);
      return;
    }
    this.scheduleFrame();
  }

  private scheduleFrame() {
    if (this.rafHandle !== null) return;
    // window.requestAnimationFrame (not the bare global) matters specifically
    // for Obsidian's popout windows: a popout is a separate browser window
    // with its own `window` object, and the bare identifier can resolve to
    // the WRONG window's animation-frame timer in that context. this.view's
    // own DOM lives in whichever window the pane was popped out into, and
    // that's the window whose paint cycle this frame actually needs to be
    // scheduled against.
    const win = this.view.dom.ownerDocument.defaultView ?? window;
    this.rafHandle = win.requestAnimationFrame(() => {
      this.rafHandle = null;
      // render() is async (see its own doc comment for why: it needs to
      // pre-resolve every link's preview content BEFORE laying anything
      // out, so layoutMarginItems() measures real heights instead of
      // placeholders) — schedule() itself stays fire-and-forget here since
      // nothing needs to wait on it; render() manages its own generation
      // guard internally against overlapping calls.
      void this.render();
    });
  }

  /**
   * Guards against overlapping render() calls: schedule() can fire again
   * (e.g. a fast series of scroll/selection events) while a previous
   * render() is still mid-flight in its async pre-fetch step below. Each
   * call captures its own generation number; if a newer call started
   * before this one reached the point of actually mutating the DOM, this
   * (now-stale) call abandons itself rather than laying out against
   * possibly-outdated marker positions.
   */
  private renderGeneration = 0;

  private async render() {
    const myGeneration = ++this.renderGeneration;
    const info = this.view.state.field(editorInfoField, false);
    const file = info?.file ?? null;

    // The mobile/narrow-pane gate itself is NOT recomputed here — see
    // updateChipsAllowed() and the `chipsAllowed` field's doc comment for
    // why. This render pass just acts on whatever the most recent real
    // width-change event last determined.
    if (!this.chipsAllowed) {
      // Chips just got suppressed (disabled entirely, or the pane shrank
      // below threshold, or mobile) — clean up anything left over from a
      // previous render pass where they WERE showing, same teardown as
      // destroy() below, just without actually destroying the column
      // itself (the pane could grow back past threshold on the very next
      // resize, at which point a normal render() call resumes as usual).
      this.track.replaceChildren();
      // MUST accompany the direct replaceChildren() above — see
      // invalidateTrack()'s own doc comment. Without this, layoutMarginItems()'s
      // next call (once chips are allowed again) would see the same
      // item ids/keys as its last successful pass, conclude every chip is
      // still reusable, and skip its own re-attach step as a no-op — leaving
      // correctly-positioned chips sitting detached in memory while `track`
      // stays empty in the live DOM. This is exactly the "margin notes gone
      // until the file is closed and reopened" bug for a note-only file:
      // a file with at least one [[link]] doesn't show it, purely because a
      // link chip's key changes every render (see buildLinkChip's own
      // comment) and so its presence forces a real re-attach anyway,
      // masking the same underlying staleness.
      invalidateTrack(this.track);
      for (const unsub of this.linkPreviewUnsubs.values()) unsub();
      this.linkPreviewUnsubs.clear();
      for (const component of this.linkPreviewComponents.values()) component.unload();
      this.linkPreviewComponents.clear();
      return;
    }

    const markers = findNoteMarkers(this.view.state.doc);
    const linkMarkers = findTopLevelLinkMarkers(this.view.state.doc);

    // THE ACTUAL FIX for chips visually touching/overlapping with no gap
    // when several links are laid out close together (e.g. two links each
    // on their own line with one blank line between): pre-resolve and
    // pre-render EVERY top-level link's preview content now, before
    // layoutMarginItems() ever runs, rather than letting each chip kick off
    // its own async render independently and hoping a later reschedule
    // catches up. getLinkPreview() itself is synchronous and safe to call
    // here (it only ever kicks off a fetch if the cache is cold — see
    // linkPreview.ts); this loop's actual awaiting is only for
    // renderForConsumer() calls on links whose cache is ALREADY warm
    // ('ready' state) at this exact moment, which is the common case for
    // any link that isn't brand new. A link whose fetch is still genuinely
    // in flight (a fresh 'pending' state) is deliberately NOT awaited here
    // — waiting on disk I/O before ever painting anything would delay the
    // whole margin column's first paint for one slow link; that case still
    // falls back to the old placeholder-then-live-update path inside
    // buildLinkChip(), same as before this fix.
    const prefetched = new Map<string, { el: HTMLElement; component: Component }>();
    await Promise.all(
      linkMarkers.map(async (marker) => {
        const sourcePath = file?.path ?? '';
        const app = runtime.app;
        if (!app) return;
        // onUpdate is a no-op here — this call's only purpose is to read
        // whatever state is CURRENTLY cached (and kick off a fetch if
        // needed for buildLinkChip's own subscription to pick up later);
        // the actual live-updating subscription is still registered by
        // buildLinkChip() itself below, same as before.
        const { state } = getLinkPreview(app, marker, sourcePath, () => {});
        if (state.status !== 'ready') return; // still pending/missing — buildLinkChip handles it
        const rendered = await renderForConsumer(app, state);
        prefetched.set(marker.id, rendered);
      })
    );

    // If a NEWER render() call started while the awaits above were in
    // flight, abandon this one — the newer call will redo this same
    // pre-fetch pass against current marker positions and win the race to
    // actually mutate the DOM. Without this check, an old, slow render()
    // call finishing late could stomp on a newer one's already-correct
    // layout.
    if (myGeneration !== this.renderGeneration) {
      for (const { component } of prefetched.values()) component.unload();
      return;
    }

    // Map both marker kinds into the generic MarginItem shape the shared
    // layout pass operates over (marginLayout.ts), then merge-sort by
    // document position — layoutMarginItems() requires its input already
    // sorted by `.from` ascending, and note/link markers are each already
    // individually sorted (both scanners walk the doc left to right), so a
    // stable merge is all that's needed rather than a full re-sort.
    // Note chips are simple/synchronous (buildChip has no async state or
    // subscriptions — see its own comment), so they're safe to key on
    // actual content: layoutMarginItems() will reuse the previous render's
    // DOM node whenever both id and key match, skipping a rebuild for any
    // note whose text/type didn't change. `key` deliberately includes
    // marker.type and marker.content (not just `.id`, which is an ordinal
    // position that stays the same even when a note's text is edited).
    const noteItems: MarginItem[] = markers.map((marker) => ({
      from: marker.from,
      id: `mn:${marker.id}`,
      key: `${marker.type ?? ''}\u0000${marker.content}`,
      buildChip: () => this.buildChip(marker),
    }));
    // Link chips are NOT given a content-based key here: buildLinkChip()
    // registers a fresh async-preview subscription every time it's called
    // and unsubscribes the previous one for that marker id (see its own
    // comment) — that subscribe/unsubscribe pairing, and the render()
    // prefetch step above that feeds it, assume buildChip runs on every
    // pass. Reusing a link chip node without also re-running that logic
    // risks subtly stale preview content in a case this pass didn't
    // stress-test for. Giving it a fresh, render-unique key every time
    // opts link items OUT of layoutMarginItems' reuse path entirely
    // (always "different key" -> always rebuilt), preserving their exact
    // previous behavior while note items still get the DOM-churn
    // reduction. Revisit if link chips' subscription lifecycle is ever
    // reworked to be reuse-safe too.
    const linkItems: MarginItem[] = linkMarkers.map((marker) => ({
      from: marker.from,
      id: marker.id,
      key: `${myGeneration}`,
      buildChip: () => this.buildLinkChip(marker, prefetched.get(marker.id)),
    }));
    const items = mergeByFrom(noteItems, linkItems);

    layoutMarginItems(this.view, this.track, items);
  }

  private buildLinkChip(marker: LinkMarker, prefetched?: { el: HTMLElement; component: Component }): HTMLDivElement {
    const chip = createDiv({ cls: 'mn-chip mn-chip-link' });
    chip.setCssStyles({ borderLeftColor: LINK_CHIP_COLOR });
    chip.dataset.linkId = marker.id;

    chip.createSpan({ cls: 'mn-chip-label', text: 'link' });

    // Placeholder content shown synchronously while the async preview
    // fetch (linkPreview.ts) is in flight — just the bare title. Kept in
    // its own wrapper span (not reusing the plain .mn-chip-text the note
    // chips use) so the preview-swap logic below has one clearly-scoped
    // element to replace the *contents* of, without touching the label
    // span next to it.
    const body = chip.createSpan({ cls: 'mn-chip-link-body', text: linkDisplayText(marker) });

    const info = this.view.state.field(editorInfoField, false);
    const sourcePath = info?.file?.path ?? '';
    const app = runtime.app;

    if (prefetched) {
      // Content was ALREADY resolved and rendered before layoutMarginItems()
      // ran this pass (see render()'s pre-fetch step above) — apply it
      // synchronously right now, so this chip's real, final content is
      // what gets measured for offsetHeight during layout, not a
      // placeholder. This is the actual fix for chips visually touching
      // when several links sit close together: their true heights are
      // known BEFORE layout runs, not corrected after the fact.
      const prevComponent = this.linkPreviewComponents.get(marker.id);
      prevComponent?.unload();
      this.linkPreviewComponents.set(marker.id, prefetched.component);
      body.replaceChildren(prefetched.el);
      chip.classList.add('mn-chip-link-loaded');
    }

    if (app) {
      // Bumped each time applyState() kicks off a fresh renderForConsumer()
      // call, so that if TWO renders end up in flight for this same chip
      // (e.g. the target file changes again before the first re-render
      // finished — see registerLinkPreviewInvalidation) the OLDER one's
      // result is discarded on arrival instead of clobbering the newer
      // one. Purely a per-chip local guard.
      let renderToken = 0;

      const applyState = () => {
        const { state } = getLinkPreview(app, marker, sourcePath, applyState);
        if (state.status === 'ready') {
          const myToken = ++renderToken;
          // Each chip renders its OWN fresh DOM element from the cached
          // markdown string (renderForConsumer), rather than reusing a
          // single shared element across every chip that references the
          // same target — a shared element could only ever have one
          // parent, so whichever chip last called replaceChildren() on it
          // silently stole it from every other chip pointing at the same
          // note. See linkPreview.ts's cache comment for the full story.
          renderForConsumer(app, state)
            .then(({ el, component }) => {
              if (myToken !== renderToken) {
                // Superseded by a newer render before this one finished —
                // discard it (and its Component) rather than applying stale
                // content or leaking the Component.
                component.unload();
                return;
              }
              const prevComponent = this.linkPreviewComponents.get(marker.id);
              prevComponent?.unload();
              this.linkPreviewComponents.set(marker.id, component);
              body.replaceChildren(el);
              chip.classList.add('mn-chip-link-loaded');
              chip.classList.remove('mn-chip-link-missing');
              // This chip's real content just arrived asynchronously
              // (the common case here is: this link's fetch was genuinely
              // still in flight when render()'s pre-fetch step ran, since
              // that step deliberately doesn't wait on cold fetches — see
              // render()'s comment). Schedule a re-layout so
              // layoutMarginItems() re-measures this chip's now-correct
              // height instead of leaving it sized against the placeholder
              // it had during the last layout pass. This can still fire more
              // than once across a chip's lifetime (e.g. once here, then
              // again after a vault.on('modify') invalidation) — that's
              // fine; it only ever fires when content actually changes, not
              // on every rebuild, since a rebuild against an already-warm
              // cache goes through the `prefetched` branch above instead of
              // this subscription path reaching 'ready' from scratch.
              this.schedule();
            })
            .catch((err: unknown) => {
              // MarkdownRenderer.render can throw on genuinely malformed
              // content — degrade the same way the 'error' state above
              // does (bare link text, missing-state styling) rather than
              // leaving an unhandled rejection and a permanently-stuck
              // placeholder chip.
              if (myToken !== renderToken) return;
              console.error('Margin Notes: failed to render link preview', marker.linkpath, err);
              body.textContent = linkDisplayText(marker);
              chip.classList.add('mn-chip-link-missing');
            });
        } else if (state.status === 'missing') {
          body.textContent = `No note titled "${state.linkpath}" yet`;
          chip.classList.add('mn-chip-link-missing');
        } else if (state.status === 'error') {
          body.textContent = linkDisplayText(marker);
          chip.classList.add('mn-chip-link-missing');
        }
        // 'pending' keeps showing the bare-title placeholder already set
        // above — nothing further to do for that state.
      };
      // First call both reads the current (possibly cached, possibly
      // freshly-kicked-off) state AND subscribes this chip's applyState as
      // the listener that fires again when the async fetch resolves later
      // — a single call handles both the synchronous initial paint and the
      // async swap-in-place, since getLinkPreview() always registers
      // onUpdate regardless of whether it returns 'pending' or a settled
      // state immediately. When `prefetched` was already applied above,
      // this call will immediately see the same 'ready' state and just
      // re-confirm it (harmless — renderForConsumer() runs once more
      // redundantly in that case, but does not loop, since nothing here
      // schedules another render when reached via this synchronous initial
      // call; only the LATER, genuinely-async arm above does that).
      const { unsubscribe } = getLinkPreview(app, marker, sourcePath, applyState);
      if (!prefetched) applyState();
      // This chip's own DOM node is discarded and rebuilt from scratch on
      // every render() pass (this.track.replaceChildren() at the top of
      // render()) — docChanged/viewportChanged/selectionSet can all
      // trigger one. Unsubscribing the PREVIOUS listener for this same
      // marker id before registering the new one keeps this bounded to at
      // most one live listener (and, via linkPreviewComponents above, at
      // most one live rendered Component) per marker at any time, instead
      // of accumulating one more of each on every re-render pass.
      const prevUnsub = this.linkPreviewUnsubs.get(marker.id);
      if (prevUnsub) prevUnsub();
      this.linkPreviewUnsubs.set(marker.id, unsubscribe);
    }

    // Clicking a link chip navigates to that note — but unlike clicking the
    // inline text (linkMarkers.ts's LinkInlineWidget, which still opens on
    // the active leaf exactly as Obsidian's own link clicks do), the chip
    // opens the target in a split to the right instead of replacing the
    // current note. That's the whole point of a margin chip: it's meant to
    // be glanced at without losing your place in the document you're
    // annotating, so navigating away from it in-place would defeat that.
    // See openInCompanionSplit() for why this reuses one split per
    // originating pane rather than creating a fresh one on every click.
    //
    // No extra call is needed to re-trigger the narrow-pane margin-collapse
    // check: MarginColumn's own ResizeObserver (see its constructor) is
    // already watching this pane's scrollDOM, so the moment the split
    // actually shrinks this pane below the threshold, render() reruns and
    // hides the chip column on its own.
    chip.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      void this.openInCompanionSplit(marker.linkpath, sourcePath);
    });

    // Deleting a link chip is a bigger deal than deleting an mn note: it
    // deletes the actual target FILE from the vault, not just some inline
    // text — so, unlike deleteNote() above, this is gated behind a confirm
    // modal rather than firing instantly. Confirmed deletion also strips
    // the `[[link]]` markup itself from THIS document (see
    // deleteLinkedFile()) — leaving it in place would turn the chip into a
    // permanently broken/"missing" link pointing at a file that no longer
    // exists, which is exactly the dangling state cleanup is meant to avoid.
    chip.appendChild(buildDeleteButton(() => this.confirmDeleteLinkedFile(marker, sourcePath)));

    return chip;
  }

  /**
   * Opens `linkpath` in a split to the right of this margin column's own
   * pane, reusing the SAME split across repeated chip clicks (from this
   * pane) rather than piling up a new one every time — clicking three
   * different chips in a row should swap the one companion pane's content
   * three times, not leave three new panes open.
   *
   * The obvious-looking alternative — call
   * `app.workspace.openLinkText(linkpath, sourcePath, 'split')` every time
   * — was rejected specifically because 'split' always creates a brand new
   * leaf; it has no "but reuse the one I already made" mode.
   *
   * Approach: keep a reference to the leaf we created last time
   * (this.companionLeaf). A stored leaf reference can go stale at any
   * point — the user is always free to close that pane by hand — so it's
   * revalidated against the workspace's CURRENT leaves on every call
   * rather than trusted blindly; WorkspaceLeaf has no public
   * "amIStillOpen" flag, so membership in iterateAllLeaves()'s output is
   * the standard, documented-behavior-only way to tell. If it's gone, a
   * fresh split is created and stashed as the new companion.
   *
   * Once we have a live leaf to reuse, setActiveLeaf() makes it Obsidian's
   * notion of "the currently active/navigable leaf", then
   * openLinkText(..., false) targets exactly that leaf — 'false' being the
   * "use the active leaf" mode. Routing back through openLinkText (rather
   * than resolving the file ourselves and calling leaf.openFile()) is
   * deliberate: it's what keeps alias/heading targets and the "create this
   * note?" prompt for unresolved links working exactly as they already do
   * elsewhere in this plugin — only which leaf receives the result
   * changes, not how the link itself gets resolved.
   */
  private async openInCompanionSplit(linkpath: string, sourcePath: string) {
    const app = runtime.app;
    if (!app) return;

    // Checked across ALL leaves, not just getLeavesOfType('markdown') —
    // the companion pane could currently be showing a non-markdown file
    // (an image, PDF, canvas, etc., if a previous chip's target wasn't a
    // note) and would still count as "still open" for reuse purposes.
    const liveLeaves: WorkspaceLeaf[] = [];
    app.workspace.iterateAllLeaves((l) => liveLeaves.push(l));
    const stillOpen = this.companionLeaf && liveLeaves.includes(this.companionLeaf);
    const leaf = stillOpen ? this.companionLeaf! : app.workspace.getLeaf('split', 'vertical');
    this.companionLeaf = leaf;

    app.workspace.setActiveLeaf(leaf, { focus: true });
    await app.workspace.openLinkText(linkpath, sourcePath, false);
  }

  private confirmDeleteLinkedFile(marker: LinkMarker, sourcePath: string) {
    const app = runtime.app;
    if (!app) return;
    const dest = app.metadataCache.getFirstLinkpathDest(marker.linkpath, sourcePath);
    if (!dest) {
      // Nothing to delete on disk (already missing) — still let the user
      // clear the dead [[link]] text out of the document.
      this.removeLinkMarkup(marker);
      return;
    }
    new ConfirmDeleteFileModal(app, dest.basename, () => {
      void this.deleteLinkedFile(marker, dest);
    }).open();
  }

  private async deleteLinkedFile(marker: LinkMarker, dest: TFile) {
    const app = runtime.app;
    if (!app) return;
    try {
      // fileManager.trashFile (not vault.trash) is Obsidian's own
      // recommended API for this — per Obsidian's plugin guidelines,
      // vault.trash bypasses some of the same "respect the user's actual
      // Settings → Files and links → Deleted files preference" handling
      // fileManager.trashFile guarantees.
      await app.fileManager.trashFile(dest);
    } catch (err) {
      console.error('Margin Notes: failed to delete linked file', dest.path, err);
      new Notice(`Margin Notes: could not delete "${dest.basename}".`);
      return;
    }
    this.removeLinkMarkup(marker);
  }

  /** Strips the `[[...]]` markup itself out of the host document. */
  private removeLinkMarkup(marker: LinkMarker) {
    // Re-locate by position rather than trusting the marker's original
    // from/to, since the doc may have shifted (e.g. an async gap while a
    // confirm modal was open) between render() and this call.
    const current = findTopLevelLinkMarkers(this.view.state.doc).find((m) => m.id === marker.id);
    const from = current?.from ?? marker.from;
    const to = current?.to ?? marker.to;
    this.view.dispatch({ changes: { from, to, insert: '' } });
  }

  private buildChip(marker: NoteMarker): HTMLDivElement {
    const chip = createDiv({ cls: 'mn-chip' });
    chip.dataset.noteId = String(marker.id);

    // Plain sidenotes have no left border anymore to carry the
    // per-note-type color, so the color now lives on the superscript
    // label itself instead — same noteTypeColor(marker.type) value as
    // before, just moved to where it's still visible.
    const label = chip.createSpan({ cls: 'mn-chip-label', text: `${marker.id}` });
    label.setCssStyles({ color: noteTypeColor(marker.type) });
    chip.createSpan({ cls: 'mn-chip-text', text: marker.content });

    // Clicking a chip (outside the delete button) just moves the caret into
    // the note's own text in the document (the raw `[mn.type: content]`
    // markdown, which noteMarkers.ts already reveals whenever the selection
    // overlaps it). Editing IS editing that text.
    chip.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.focusNoteText(marker);
    });

    // Deleting an mn note removes its entire `[mn.type: content]` span from
    // the document in one shot — there is no separate file backing it, so
    // "delete" here just means "delete that inline text". Instant, no
    // confirmation: unlike a linked file's deletion below, this is a single
    // normal doc edit the user can undo with Ctrl+Z like any other typing,
    // so a modal would be more friction than the action warrants.
    chip.appendChild(buildDeleteButton(() => this.deleteNote(marker)));

    return chip;
  }

  private deleteNote(marker: NoteMarker) {
    // Re-locate by id in case the doc shifted since render() (same reason
    // focusNoteText() does this) — deleting against a stale from/to could
    // remove the wrong span or a now-incorrect range.
    const current = findNoteMarkers(this.view.state.doc).find((m) => m.id === marker.id);
    if (!current) return;
    this.view.dispatch({ changes: { from: current.from, to: current.to, insert: '' } });
    this.view.focus();
  }

  private focusNoteText(marker: NoteMarker) {
    // Re-locate the marker by id in case the doc shifted since render().
    const current = findNoteMarkers(this.view.state.doc).find((m) => m.id === marker.id);
    if (!current) return;
    // Select just the content between "...: " and the closing "]" so a
    // click both places the caret there for appending AND lets someone
    // immediately start typing to replace the whole note in one motion —
    // the same one-click affordance a popup textarea gave, minus the popup.
    const innerEnd = current.to - 1; // just before ']'
    const innerStart = innerEnd - current.content.length;
    this.view.dispatch({ selection: { anchor: innerStart, head: innerEnd }, scrollIntoView: true });
    this.view.focus();
  }

  destroy() {
    this.resizeObserver.disconnect();
    // Cancel a still-pending scheduled frame (see schedule()) — without
    // this, a frame requested just before the editor closes would still
    // fire afterward and call this.render() against an instance whose
    // track/scrollDOM have already been torn down below.
    if (this.rafHandle !== null) {
      const win = this.view.dom.ownerDocument.defaultView ?? window;
      win.cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.debounceHandle !== null) {
      const win = this.view.dom.ownerDocument.defaultView ?? window;
      win.clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.safetyNetHandle !== null) {
      const win = this.view.dom.ownerDocument.defaultView ?? window;
      win.clearInterval(this.safetyNetHandle);
      this.safetyNetHandle = null;
    }
    for (const unsub of this.linkPreviewUnsubs.values()) unsub();
    this.linkPreviewUnsubs.clear();
    for (const component of this.linkPreviewComponents.values()) component.unload();
    this.linkPreviewComponents.clear();
    invalidateTrack(this.track);
    this.track.remove();
    this.view.scrollDOM.classList.remove('mn-has-margin');
  }
}

export const marginPanel = ViewPlugin.fromClass(
  class {
    private col: MarginColumn;
    constructor(view: EditorView) {
      this.col = new MarginColumn(view);
    }
    update(update: ViewUpdate) {
      // docChanged fires at keystroke speed (every character typed is a
      // doc change), but most individual keystrokes can't possibly move,
      // add, or remove a chip — typing a letter in the middle of a
      // sentence changes neither the line count nor any marker's
      // brackets. isDocChangeLayoutRelevant() filters those out before a
      // debounce timer is even armed, so ordinary typing schedules NO
      // rebuild at all rather than one that just gets debounced away.
      // Edits that DO look layout-relevant (a newline, or a bracket that
      // could start/end/resize a [mn:...] or [[link]]) still go through
      // the same debounce as before, so a burst of THOSE still collapses
      // into one rebuild rather than one per edit.
      if (update.docChanged && isDocChangeLayoutRelevant(update)) {
        this.col.schedule(false);
      }
      // geometryChanged is CM6's OWN signal for "this editor's rendered
      // dimensions changed in this update" — but per CM6's docs that
      // covers BOTH a real box-size change (pane resize, sidebar toggle,
      // split open/close) AND ordinary typing that grows/shrinks content
      // height (e.g. a line wrapping to a new visual row). Treating it as
      // a live-resize signal was the actual cause of chips vanishing while
      // typing: on a geometryChanged-from-typing update, this branch called
      // updateChipsAllowed() (a live clientWidth re-measurement) and an
      // IMMEDIATE, non-debounced schedule() on literally the same keystroke
      // isDocChangeLayoutRelevant() above was correctly trying to skip or
      // debounce — a race between that immediate render() and the doc's
      // own fast-changing state during a typing burst is what left the
      // column empty until a full file close/reopen forced a clean re-init.
      //
      // The constructor's ResizeObserver on view.scrollDOM is the correct,
      // narrower signal for this: it only fires on an actual box-size
      // change of the pane itself, never as a side effect of content
      // reflowing inside a pane whose own box didn't resize. That's the
      // sole live-measurement trigger now; geometryChanged is no longer
      // read here at all.
      const forcedRefresh = update.transactions.some((tr) => tr.effects.some((e) => e.is(forceMarginRefresh)));
      if (forcedRefresh) {
        this.col.updateChipsAllowed();
      }
      if (update.viewportChanged || (update.selectionSet && !update.docChanged) || forcedRefresh) {
        this.col.schedule();
      }
    }
    destroy() {
      this.col.destroy();
    }
  }
);