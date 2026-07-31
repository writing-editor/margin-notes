# Margin Notes (Obsidian plugin)

Literal book-margin notes, ported from the ManuScript app's CM6 editor, plus
an AI notes agent. A file opts into margin notes via a frontmatter property
(default `margin-notes: true`), a folder rule, or "every file" — everything
else is a completely unmodified Obsidian editor.

> Git sync used to live in this plugin too. It's been split out into its
> own plugin, **Git Lite**, since it has nothing to do with margin notes —
> see that plugin's repo/folder. Nothing here depends on it.

## What's here

```
manifest.json          — plugin manifest
main.js                — pre-built bundle (already compiled, see below)
styles.css              — margin layout, chip styling, note-sheet modal
src/
  main.ts                — plugin entry: settings, commands, refresh hooks
  runtime.ts              — settings singleton + isMarginNotesEnabled()
  settings.ts             — settings shape + settings tab UI (notes/links/agent)
  secureStorage.ts        — OS-keychain-backed secret storage (falls back to plaintext, honestly)
  paragraphs.ts           — the one shared "what is a paragraph" definition (ported from lib/paragraphs.js)
  noteMarkers.ts          — ported from noteWidgets.js: [mn: ...] → superscript widget
  linkMarkers.ts          — [[link]] → plain, underlined clickable inline text (![[embeds]] untouched, left to Obsidian)
  linkPreview.ts          — async resolve/read/render/cache for link margin chips
  marginLayout.ts         — shared two-pass anchor+clamp layout, generic across chip kinds
  marginPanel.ts          — the literal margin column: builds note chips and link chips, narrow-pane/mobile gate, bulk agent insert
  noteTypes.ts            — note-type registry (color/label) + link chip accent color
  agents.ts               — provider dispatch, paragraph-ID contract (ported from lib/ai-proxy.js)
  agentRunner.ts          — orchestrates one run across selection/file/vault scope
```

## Installing it in your vault (no build needed)

1. Create `<your-vault>/.obsidian/plugins/margin-notes/`.
2. Copy `manifest.json`, `main.js`, and `styles.css` into that folder.
3. In Obsidian: Settings → Community plugins → reload, then enable "Margin Notes".
4. Settings → Margin Notes: pick a trigger, margin width, and
   agent provider/model/key/profile/scope.
5. Open a file that matches the trigger and run **Insert margin note** (Cmd/Ctrl+P).

## Building from source

```
npm install
npm run build     # tsc typecheck + esbuild production bundle -> main.js
```

## How the pieces fit together

- **Selective activation.** Both `noteMarkers.ts` and `marginPanel.ts` read
  Obsidian's `editorInfoField` (a CM6 `StateField` Obsidian injects into every
  markdown editor's state) to find the associated file, then check
  `isMarginNotesEnabled()`. Each open editor decides independently.
- **Paragraph alignment.** Chips align to the top of the paragraph the note
  belongs to via `paragraphs.ts`'s `splitIntoParagraphs()` — the identical
  function the agent uses for paragraph IDs (see below), so "paragraph 4" on
  screen and "paragraph 4" a note is anchored to are guaranteed to be the
  same block of text, not two independent guesses that could disagree.
- **The note-sheet modal** is one toolbar row — a type dropdown on the left,
  icon buttons (delete/save/cancel) on the right — over a borderless
  textarea with only a placeholder. Obsidian's own default modal close
  button is hidden via CSS so there's exactly one close control, not two. It
  opens anchored near the triggering click/cursor position rather than
  screen-centered.
- **Agents — the model never sees or invents a character offset.** This was
  a real bug in an earlier version of this plugin (and, per `lib/ai-proxy.js`'s
  own history, in an earlier version of the original app too): asking a
  model to return `charPos` doesn't work, because models don't reliably
  count characters over any real document length — the numbers come back
  off, landing mid-word or in the wrong paragraph entirely.

  Instead: `paragraphs.ts` splits the text first and tags each block `[P1]`,
  `[P2]`, ... in what's shown to the model. The model is only ever asked to
  *name* a paragraph id it recognizes — not estimate a position — and
  `resolveParagraphPlacements()` looks up that id's real, exact start offset
  by table lookup, not a guess. On top of that: at most one note per
  paragraph (first wins on a duplicate), a density cap at roughly one note
  per 50 words as a hard backstop behind the prompt's own "don't flag every
  paragraph" instruction, and a resolved position landing inside an existing
  `[mn.*: ...]` marker is rejected outright. After writing,
  `verifyInsertOnly()` strips all `[mn.ai: ...]` markers from both
  before/after snapshots and confirms they're otherwise byte-identical.

  All calls go through Obsidian's `requestUrl`, which bypasses CORS entirely
  — no proxy needed, unlike the original app's mobile setup.
- **Scope: selection, file, or vault.** Selection scope sends only the
  selected substring to the model; the returned paragraph-relative offsets
  are shifted by the selection's start position before insertion, so a note
  from a two-paragraph selection lands correctly in the full document, not
  at the top of the file. File scope runs on the whole active file. Vault
  scope runs across every file currently matching the enablement rule.
- **Remembering config.** Provider, per-provider model, agent profile, and
  scope persist in the plugin's normal settings (`data.json`). API keys go
  through `secureStorage.ts`: encrypted via Electron's `safeStorage` (your
  OS keychain) when available, plaintext with an explicit on-screen note
  when it isn't (mobile, or a desktop with no keyring backend).

## Links in the margin

> **For usage instructions, see
> [`docs/links-and-hover-zoom-user-guide.md`](docs/links-and-hover-zoom-user-guide.md).**
> The rest of this section is implementation notes for developers.

`[[Note Title]]`, `[[Note|Alias]]`, `[[Note#Heading]]`, and
`[[Note#Heading|Alias]]` render inline as plain, underlined clickable text
(no brackets, muted accent color instead of Obsidian's default blue) — same
visual weight as surrounding prose, just distinguishable enough to notice.
A margin chip appears next to that line with a live-rendered preview of the
target note's content.

`![[embeds]]` are deliberately **not** part of this feature — they were
tried (parsed, given a margin chip, left to render inline via Obsidian's
own native embed handling too) and reverted. Obsidian's own Live Preview
already renders `![[...]]` as a live embedded block right where it's
written; adding a second, independent margin-chip preview on top of that
just duplicated the same content for no benefit, and the two decorators
(this plugin's `Decoration.replace` and Obsidian's own embed rendering)
fighting over the same character range produced genuinely inconsistent
bugs — sometimes the chip won, sometimes Obsidian's own embed won, with no
reliable way to predict which. `[[links]]` don't have that overlap —
Obsidian leaves them as plain clickable text with nothing rendered inline,
which is exactly the gap this feature fills — so links get full treatment
and embeds are left 100% to Obsidian.

- **`linkMarkers.ts`** parses `[[...]]` (`target[#heading][|alias]`
  grammar) and decorates matches with a plain `<span class="mn-linktext">`
  widget. Clicking it calls Obsidian's own `app.workspace.openLinkText()` —
  the same link-click behavior Obsidian's built-in renderer uses. The
  regex intentionally does NOT use a lookbehind to exclude `![[...]]` —
  iOS's JS engine doesn't support lookbehind assertions, and using one here
  would have silently broken every link on iPhone rather than throwing an
  obvious error. Instead, `findLinkMarkers()` does a manual "was the
  character right before this preceded by `!`" check against the raw text,
  which is lookbehind-free and behaves identically.
- **Nested links inside `[mn: ...]` notes.** A `[[link]]` written inside a
  note's own content (e.g. `[mn: see [[Character Bible]] for context]`) is
  swallowed into the note as plain text — it does NOT also get its own
  underline/margin chip. `findTopLevelLinkMarkers()` (in `linkMarkers.ts`)
  excludes any link whose range falls inside a note marker's range before
  either the inline decoration or the margin chip layer ever sees it. This
  matters for two reasons: (1) two different CM6 extensions each trying to
  `Decoration.replace` overlapping, nested ranges is not something CM6
  resolves predictably — avoiding the overlap entirely sidesteps that
  rather than relying on undefined behavior; (2) `noteMarkers.ts`'s own
  regex (`MN_RE`) is non-greedy and, on its own, stops at the FIRST `]` it
  finds after the note's colon — which used to be the nested link's own
  closing bracket, truncating the note's content and leaving stray bracket
  characters as broken visible text. `findNoteMarkers()` now includes a
  bracket-depth-aware rescan (`findTrueNoteEnd()`) that finds the note's
  real closing bracket whenever its captured content contains an
  unbalanced `[[` — a plain note with no nested double-brackets is
  completely unaffected and takes the same fast path as before.
- **`linkPreview.ts`** owns the async side: resolving the link target via
  `app.metadataCache.getFirstLinkpathDest()` (re-checked fresh on every
  call — a link that briefly fails to resolve is never treated as a
  permanently stable "missing" answer), reading its content with
  `app.vault.cachedRead()`, and caching the fetched **markdown string**
  (not a rendered DOM element) keyed by the resolved file's path, so
  multiple links to the same note share one fetch. Each individual chip
  then renders its **own independent DOM element** from that shared string
  via `renderForConsumer()`, with its own `Component` for lifecycle. This
  replaced an earlier design that cached one shared, already-rendered
  `HTMLElement` per target and handed it to every chip referencing that
  file — which was broken, since a DOM node can only ever have one parent:
  whichever chip called `replaceChildren()` on the shared node last would
  silently steal it away from every earlier chip pointing at the same
  note, producing exactly the symptom "the same note linked twice on a
  page — only one of the two chips ever shows a preview, and which one is
  order/timing-dependent." A broken link shows a distinct "note not found"
  chip state instead of a blank or throwing chip, and self-corrects the
  next time it's checked once the target file exists. The cache
  invalidates and live-updates every subscribed chip when the target file
  is modified (`vault.on('modify')`).
- **`marginLayout.ts`** is the shared positioning/clamping engine both note
  chips and link chips run through — a generic `MarginItem` interface
  (`{ from, id, buildChip() }`) plus a two-pass "compute every anchor's true
  position first, then place chips top-down clamping only when the *next*
  item's real anchor demands it" layout. `marginPanel.ts` merges note
  markers and (top-level only — see above) link markers into one
  document-order list before handing it to this pass, so a note and a link
  near each other on the page get clamping decisions that correctly
  account for both as neighbors — not two independently-computed layouts
  fighting over the same vertical space.
- **Hover-zoom.** Every margin chip — note or link, clamped or not —
  scales up and lifts on `:hover` (pure CSS `transform` + `box-shadow`, no
  JS involved in the motion itself), showing its full unclamped content.
  It's pinned to the margin's own horizontal position
  (`transform-origin: right center`, matching the track's right-aligned
  layout) so a zoomed chip never grows toward or over the main text — only
  leftward/vertically, within the reserved margin space. This has zero
  effect on the editor's own cursor, selection, or focus.
- **Narrow-pane / split-view / mobile.** The chip column (built by
  `marginPanel.ts`'s `MarginColumn`) hides itself — while
  `noteMarkerField`'s superscripts and `linkMarkerField`'s underlined link
  text, both independent CM6 `StateField`s, keep rendering completely
  unaffected — whenever: (a) `Platform.isMobile` is true and the "Hide
  chips on mobile" setting is on (default: on; phones specifically, not
  tablets — Obsidian gives tablets the same desktop-style layout), or (b)
  the editor pane's own rendered width (`view.scrollDOM.clientWidth`, not
  the window's width — this is what makes a split-pane layout correctly
  narrow just the pane that's actually narrow) falls below
  `marginWidth * narrowPaneRatio` (the "Hide chips in narrow panes" setting,
  default ratio 3.0; 0 disables this check entirely). This is a RATIO
  against the user's own configured margin width rather than a fixed pixel
  number, specifically so it scales correctly if the user changes
  `marginWidth` — a fixed pixel threshold would either feel too aggressive
  at a narrow `marginWidth` or not aggressive enough at a wide one. A
  dedicated `ResizeObserver` on the pane's `scrollDOM` guarantees this
  reacts to a split-pane resize even in edge cases where CM6's own
  `geometryChanged` update flag might not fire for a given resize path.

## Nested markers, generally

Both marker kinds are designed to resolve overlaps in one direction only,
to keep the resolution predictable: a `[[link]]`'s range can be nested
inside an `[mn: ...]` note's range (link-in-note is a normal, supported
thing to write, and the note simply wins — see above), but an `[mn: ...]`
note is never expected to be written nested inside a `[[link]]`'s own
`target`/`heading`/`alias` text (Obsidian's own wikilink syntax doesn't
have a construct for that, so it isn't a case that comes up in practice).
If you find a way to construct a genuinely ambiguous nesting beyond
link-in-note, please file it as a bug — the resolution rule above is
deliberately the only one implemented, not a general arbitrary-depth
nesting resolver.

## Known caveats (read before relying on this)

- **`editor.cm` is not officially typed.** If a future Obsidian release
  changes this, the insert-note command, the agent's live-editor path, and
  the refresh-on-rename/frontmatter-change hooks fail with a `Notice` instead
  of a crash. The note *rendering* itself doesn't depend on it.
- **Selection scope needs a live editor** — it reads the CM6 selection
  directly, so it only works on the currently open file, not vault scope.
- **Readable line length / split panes** — see the CSS comments; the margin
  reservation is a CSS override and may need tuning against unusual themes.

## Notes storage today

`[mn.type: content]` / `[mn: content]` notes are stored literally, inline in
the document body, decorated by CodeMirror into a superscript widget +
margin chip — there's no separate file or footnote involved for these.

`[[links]]` are the second, link-backed kind mentioned as a future
direction in earlier drafts of this README — that direction has now
shipped (see "Links in the margin" above). Unlike `mn` notes, links don't
store any content themselves; the margin chip is a live preview of
whatever the target note currently contains, fetched and cached by
`linkPreview.ts`. `![[embeds]]` are intentionally not part of this — see
above for why.