import { MarkdownPostProcessorContext, MarkdownView, TFile } from 'obsidian';
import { runtime, isMarginNotesEnabled } from './runtime';
import { findNoteMarkers } from './noteMarkers';
import { findTopLevelLinkMarkers } from './linkMarkers';
import { noteTypeColor, LINK_CHIP_COLOR } from './noteTypes';

// ---------------------------------------------------------------------------
// SCOPE, DELIBERATELY CUT DOWN — READ THIS BEFORE EXTENDING THIS FILE
// ---------------------------------------------------------------------------
// This file used to also build a Reading-mode margin column: chips in the
// right-hand margin next to each marker, mirroring the editor's margin
// panel (marginPanel.ts). That was removed on explicit instruction, after
// three consecutive attempts to fix it did not resolve the reported
// symptoms (chips not repositioning on scroll, overlapping the main text
// instead of the text making room for them, and the whole column vanishing
// on switching back to edit mode). Since there is no way to run a live
// Obsidian instance from the environment these fixes were written in, each
// attempt was reasoned through by re-reading Obsidian's own type
// definitions and forum threads rather than observed directly — and it
// kept being wrong in ways that weren't caught until real-world testing.
//
// WHAT WENT WRONG, for whoever picks this back up:
//
// 1. Chips never moved on scroll. First diagnosed as "no scroll listener
//    exists at all" (true, and fixed) — but that fix alone didn't resolve
//    it, which means the deeper problem was likely that .mn-reading-track
//    (position: absolute) was never confirmed to have a genuinely
//    positioned containing block in Reading mode. The editor-mode column
//    gets this for free because CM6's .cm-scroller has position: relative
//    by convention; that assumption was carried over to Reading mode
//    without verifying Obsidian's own Reading-mode container structure
//    actually provides an equivalent, and it may simply not.
//
// 2. Text never made room for the margin, so chips rendered ON TOP of the
//    main text instead of beside it. Tried via a CSS selector guessing at
//    Obsidian's private DOM class names (.markdown-preview-sizer nested
//    under wherever mn-has-margin ended up) — never confirmed to actually
//    match. Switched to a direct JS query + inline style, which is more
//    robust to guessing wrong about nesting depth, but still assumes the
//    .markdown-preview-sizer class name itself is correct and present,
//    which was likewise never confirmed against a real instance.
//
// 3. Whether view.previewMode.containerEl is even the element that
//    actually scrolls (vs. some inner/outer wrapper) was also never
//    confirmed — a later attempt added runtime detection for this via
//    computed-overflow walking, but by that point there wasn't a chance
//    to verify whether it helped, since the whole margin-column approach
//    was cut before further testing.
//
// The common thread: every one of these needed ground truth from a live
// Obsidian DOM tree (actual computed styles, actual element nesting) that
// couldn't be obtained in the environment where the code was written.
// Reintroducing a Reading-mode margin column should start with that —
// inspect the real DOM (Obsidian's own devtools, Ctrl/Cmd+Shift+I) for
// view.previewMode.containerEl's actual position/overflow, and for
// .markdown-preview-sizer's actual parent — BEFORE writing positioning
// code again, rather than reasoning about it from documentation and
// forum posts as this file's history did.
//
// WHAT THIS FILE DOES INSTEAD, NOW: only the inline decoration — marking
// each [mn: ...]/[[link]] marker directly in the rendered text with a
// small colored superscript (notes) or a colored/underlined highlight
// (links), clickable to jump straight to Source mode at that exact
// position. No margin column, no separate chip, no content preview
// rendered in Reading mode at all. This has none of the positioning
// problems above — it decorates elements markdown-it already rendered, in
// place, rather than computing a second, independent layout next to them.

/** Cache of a file's raw markdown text for one post-processor pass, so
 * multiple blocks in the same render don't each re-read the file from disk.
 * Keyed by ctx.docId (unique per render pass, per Obsidian's own docs on
 * MarkdownPostProcessorContext) — NOT by file path, since the same file's
 * markdown can legitimately change between one Reading-mode render and the
 * next (the whole point of re-running the post-processor at all). */
const rawTextByDocId = new Map<string, string>();

async function getRawText(ctx: MarkdownPostProcessorContext): Promise<string | null> {
  const cached = rawTextByDocId.get(ctx.docId);
  if (cached !== undefined) return cached;
  const app = runtime.app;
  if (!app) return null;
  const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!(file instanceof TFile)) return null;
  const text = await app.vault.cachedRead(file);
  rawTextByDocId.set(ctx.docId, text);
  return text;
}

/**
 * Finds every [mn: ...]/[[link]] marker that falls within this block's own
 * line range and decorates it in place — no separate chip, no layout pass,
 * just marking up the text markdown-it already rendered.
 */
function decorateBlock(el: HTMLElement, text: string, lineStart: number, lineEnd: number, sourcePath: string): void {
  // Byte offsets of this block's own line range within the FULL document
  // text, so marker.from/to (whole-document offsets) can be filtered down
  // to "markers inside this block" before searching this block's DOM.
  //
  // BOTH bounds matter, not just the start: findNoteMarkers/
  // findTopLevelLinkMarkers always search the WHOLE document text (see
  // byLineSlice below), since this plugin's post-processor runs once PER
  // BLOCK across a document with many blocks. Checking only a lower bound
  // would mean every block after the first re-matches every EARLIER
  // marker too (its `from` is still >= 0) — wasted work on every block
  // downstream of every marker, on every render.
  const lines = text.split('\n');
  let blockStartOffset = 0;
  for (let i = 0; i < lineStart; i++) blockStartOffset += lines[i].length + 1; // +1 for the '\n'
  let blockEndOffset = blockStartOffset;
  for (let i = lineStart; i <= lineEnd && i < lines.length; i++) blockEndOffset += lines[i].length + 1;

  const withinBlock = (from: number) => from >= blockStartOffset && from < blockEndOffset;

  const notes = findNoteMarkers(byLineSlice(text)).filter((m) => withinBlock(m.from));
  const links = findTopLevelLinkMarkers(byLineSlice(text)).filter((m) => withinBlock(m.from));

  for (const note of notes) {
    const raw = text.slice(note.from, note.to);
    const supEl = replaceRawTextWithSup(el, raw, String(note.id), noteTypeColor(note.type));
    if (supEl) {
      supEl.addEventListener('mousedown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        void jumpToSource(sourcePath, note.from + raw.indexOf(':') + 1);
      });
    }
  }

  // Links are NOT found by searching rendered text — by the time this
  // post-processor runs, Obsidian's own markdown-it pipeline has ALREADY
  // turned every [[wikilink]] into a real `<a class="internal-link">`
  // anchor; the literal "[[...]]" text this plugin's regex matched
  // against the RAW markdown no longer exists anywhere in the rendered
  // DOM to search for.
  //
  // Fix: match rendered <a class="internal-link"> elements to LinkMarkers
  // by POSITION IN ORDER within this one block, rather than by searching
  // for text. Both lists are already in document order (links: sorted by
  // `.from` from the regex scan; anchors: DOM order, which markdown-it
  // preserves faithfully relative to the source) and confined to the same
  // one block, so the Nth internal-link anchor in el corresponds to the
  // Nth link marker found in this block's raw text.
  const anchors = Array.from(el.querySelectorAll<HTMLAnchorElement>('a.internal-link'));
  links.forEach((link, i) => {
    const anchor = anchors[i];
    if (!anchor) return; // fewer rendered anchors than markers found in source — skip rather than guess
    markLinkAnchor(anchor, LINK_CHIP_COLOR);
    anchor.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      void jumpToSource(sourcePath, link.from);
    });
  });

  // --- small local helper, kept inline since it only makes sense paired
  // with this function's specific text closure ---
  function byLineSlice(fullText: string) {
    // findNoteMarkers/findTopLevelLinkMarkers want an EditorState['doc']-
    // shaped object (only .toString() is actually used by either — see
    // noteMarkers.ts/linkMarkers.ts). A whole-document search each time is
    // simplest and correct (ids stay globally sequential, matching what
    // the editor shows); filtering to "which of those fall in THIS block"
    // happens afterward via withinBlock(), not by pre-slicing the input.
    return { toString: () => fullText } as unknown as Parameters<typeof findNoteMarkers>[0];
  }
}

/**
 * Finds `raw` as a literal substring inside el's own text content, wraps
 * the FIRST occurrence in a `<sup class="mn-marker">`, and returns that
 * sup element — or null if `raw` isn't found in el at all.
 *
 * Notes-only — links need a different approach (markLinkAnchor below):
 * unlike a note's `[mn: ...]` markup, which markdown-it leaves as plain
 * text since it isn't Markdown syntax at all, a note's raw text really is
 * still sitting in the rendered DOM verbatim, so a literal text search is
 * the right tool for notes specifically.
 *
 * Walks TEXT NODES ONLY (TreeWalker with SHOW_TEXT) — never touches
 * el.innerHTML directly, since a naive string replace on innerHTML would
 * also match `raw` if it happened to appear inside an attribute value or
 * inside another element's already-rendered tag soup, corrupting markup
 * that has nothing to do with this marker.
 */
function replaceRawTextWithSup(el: HTMLElement, raw: string, label: string, color: string): HTMLElement | null {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const idx = node.textContent?.indexOf(raw) ?? -1;
    if (idx === -1) continue;
    const textNode = node as Text;
    const after = textNode.splitText(idx);
    after.splitText(raw.length); // leaves `after` holding exactly `raw`

    const sup = el.ownerDocument.createElement('sup');
    sup.className = 'mn-marker mn-marker-reading';
    sup.textContent = label;
    sup.style.color = color;
    sup.style.cursor = 'pointer';

    after.replaceWith(sup);
    return sup;
  }
  return null;
}

/**
 * Links don't get a new element inserted next to them the way notes do —
 * the rendered <a class="internal-link"> IS already the clickable inline
 * widget this plugin would otherwise have built (Obsidian's own link,
 * complete with hover preview and every other native link behavior this
 * plugin has no reason to reimplement or shadow). This just tags it with
 * this plugin's own color/cursor and a mousedown listener IN ADDITION to
 * whatever Obsidian's own link-click handling already does —
 * evt.stopPropagation() in the caller's listener stops it from also
 * following the link to the target note, since clicking this marker
 * should jump to SOURCE mode at this position, not navigate away to the
 * linked file the way a normal, unmodified click on this same link
 * still does.
 */
function markLinkAnchor(anchor: HTMLAnchorElement, color: string): void {
  anchor.classList.add('mn-marker-reading', 'mn-linktext');
  anchor.style.color = color;
}

async function jumpToSource(sourcePath: string, charOffset: number): Promise<void> {
  const app = runtime.app;
  if (!app) return;
  const file = app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) return;
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(file);
  const view = leaf.view;
  if (view instanceof MarkdownView) {
    const current = leaf.getViewState();
    await leaf.setViewState({ ...current, state: { ...current.state, mode: 'source' } });
    const editor = view.editor;
    const pos = editor.offsetToPos(charOffset);
    editor.setCursor(pos);
    editor.scrollIntoView({ from: pos, to: pos }, true);
    editor.focus();
  }
}

/**
 * The post-processor itself. Registered unconditionally in main.ts (per
 * Obsidian's own model — post-processors aren't leaf-scoped, they just run
 * whenever Reading mode renders ANY block, anywhere), but this is exactly
 * the "only when Reading mode is actually rendering something" gate the
 * user asked for: it does nothing until Obsidian itself decides to render
 * a Reading-mode block, which never happens while every open leaf is in
 * Source/Live Preview. There is no separate always-on listener or timer
 * here that would run during normal editing.
 */
export async function readingModePostProcessor(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
  const app = runtime.app;
  if (!app) return;
  const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!(file instanceof TFile) || !isMarginNotesEnabled(file)) return;

  const info = ctx.getSectionInfo(el);
  if (!info) return; // no line-range info available for this element — nothing to anchor to

  const text = await getRawText(ctx);
  if (text === null) return;

  decorateBlock(el, text, info.lineStart, info.lineEnd, ctx.sourcePath);
}