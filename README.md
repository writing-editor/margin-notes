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
  marginPanel.ts          — the literal margin column, chip positioning/editing, bulk agent insert
  noteEditModal.ts        — insert/edit/delete note modal
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

Notes are stored literally, inline in the document body, as
`[mn.type: content]` / `[mn: content]` markers that CodeMirror decorates
into a superscript widget + margin chip. There's no separate file, link, or
footnote involved yet — see the open discussion in this repo about a
possible second, link-backed note mode for longer notes (particularly AI
output), which is a bigger design change and deliberately not part of this
split.
