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
  settings.ts             — settings shape + settings tab UI (notes/agent)
  secureStorage.ts        — OS-keychain-backed secret storage (falls back to plaintext, honestly)
  paragraphs.ts           — the one shared "what is a paragraph" definition (ported from lib/paragraphs.js)
  noteMarkers.ts          — ported from noteWidgets.js: [mn: ...] → superscript widget
  linkMarkers.ts          — [[link]]/![[embed]] → plain clickable inline text
  linkPreview.ts          — async resolve/read/render/cache for link & embed margin chips
  marginLayout.ts         — shared two-pass anchor+clamp layout, generic across chip kinds
  marginPanel.ts          — the literal margin column: builds note chips and link/embed chips, bulk agent insert
  noteTypes.ts            — note-type registry (color/label) + link/embed chip accent colors
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

## Links and embeds in the margin

`[[Note Title]]`, `[[Note|Alias]]`, `[[Note#Heading]]`, `[[Note#Heading|Alias]]`,
and their `![[...]]` embed equivalents render inline as plain, unstyled
clickable text (no brackets, no default blue link color) — same visual
weight as surrounding prose. A margin chip appears next to that line with a
live-rendered preview of the target note's content, using a distinct accent
color for links vs. embeds so you can tell the two apart at a glance.

- **`linkMarkers.ts`** parses the `[[...]]`/`![[...]]` syntax
  (`target[#heading][|alias]` grammar) and decorates matches with a plain
  `<span class="mn-linktext">` widget. Clicking it calls Obsidian's own
  `app.workspace.openLinkText()` — the same link-click behavior Obsidian's
  built-in renderer uses (handles aliases/headings/creating a missing note
  the same way).
- **`linkPreview.ts`** owns the async side: resolving the link target via
  `app.metadataCache.getFirstLinkpathDest()`, reading its content with
  `app.vault.cachedRead()`, and rendering it via `MarkdownRenderer.render()`
  into a cache keyed by the resolved file's path (so multiple links to the
  same note share one render). A broken link shows a distinct "note not
  found" chip state instead of a blank or throwing chip. The cache
  invalidates and live-updates open chips when the target file is modified
  (`vault.on('modify')`), and everything is rendered through one shared,
  plugin-lifetime `Component` so `MarkdownRenderer`'s own child renderers
  are cleaned up correctly on unload rather than leaking per re-render.
- **`marginLayout.ts`** is the shared positioning/clamping engine both note
  chips and link/embed chips run through — a generic `MarginItem` interface
  (`{ from, id, buildChip() }`) plus a two-pass "compute every anchor's true
  position first, then place chips top-down clamping only when the *next*
  item's real anchor demands it" layout. `marginPanel.ts` merges note
  markers and link markers into one document-order list before handing it
  to this pass, so a note and a link near each other on the page get
  clamping decisions that correctly account for both as neighbors — not two
  independently-computed layouts fighting over the same vertical space.
- **Hover-zoom.** Every margin chip — note or link/embed, clamped or not —
  scales up and lifts on `:hover` (pure CSS `transform` + `box-shadow`, no
  JS involved in the motion itself), showing its full unclamped content.
  It's pinned to the margin's own horizontal position
  (`transform-origin: right center`, matching the track's right-aligned
  layout) so a zoomed chip never grows toward or over the main text — only
  leftward/vertically, within the reserved margin space. This has zero
  effect on the editor's own cursor, selection, or focus.

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

`[[links]]` and `![[embeds]]` are the second, link-backed kind mentioned as
a future direction in earlier drafts of this README — that direction has
now shipped (see "Links and embeds in the margin" above). Unlike `mn` notes,
these don't store any content themselves; the margin chip is a live preview
of whatever the target note currently contains, fetched and cached by
`linkPreview.ts`.