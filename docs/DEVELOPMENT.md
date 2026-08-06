# Margin Notes — development notes

This is the implementation-detail companion to the main
[`README.md`](../README.md). If you're using the plugin, you almost
certainly want that file instead — this one is for anyone modifying,
reviewing, or debugging the code itself.

## What's here

```
manifest.json          — plugin manifest
main.js                — pre-built bundle (already compiled, see below)
styles.css              — margin layout, chip styling, note-sheet modal
src/
  main.ts                — plugin entry: settings, commands, refresh hooks
  runtime.ts              — settings singleton + isMarginNotesEnabled()
  settings.ts             — settings shape + settings tab UI (notes/links/agent)
  secretStorage.ts        — wraps Obsidian's native app.secretStorage (1.11.4+); plaintext fallback below that, honestly labeled
  paragraphs.ts           — the one shared "what is a paragraph" definition (ported from lib/paragraphs.js)
  noteMarkers.ts          — ported from noteWidgets.js: [mn: ...] → superscript widget
  linkMarkers.ts          — [[link]] → plain, underlined clickable inline text, opens in a new tab
  marginLayout.ts         — shared two-pass anchor+clamp layout for note chips
  marginPanel.ts          — the literal margin column: builds note chips, narrow-pane/mobile gate, bulk agent insert
  noteTypes.ts            — note-type registry (color/label) + link accent color
  typeAutocomplete.ts     — "[mn." trigger: note-type picker with color swatches
  agents.ts               — provider dispatch, paragraph-ID contract (ported from lib/ai-proxy.js)
  agentRunner.ts          — orchestrates one run across selection/file/vault scope
```

## Building from source

```
npm install
npm run build     # tsc typecheck + esbuild production bundle -> main.js
```

## Secret storage version gating

`manifest.json`'s `minAppVersion` is deliberately kept below 1.11.4 (the
Obsidian release that added `app.secretStorage`), rather than raised to
require it. This plugin is `isDesktopOnly: false`, so raising the floor
would lock out anyone on an older Obsidian entirely — including mobile
users, since 1.11.4 is also when the native API became available there.
Instead, `secretStorage.ts` checks `requireApiVersion('1.11.4')` at
read/write time and falls back to a plaintext field in `data.json`
(`MarginNotesSettings.secretsFallback`) when it's false, with the
settings tab saying so plainly next to the key field rather than the two
paths behaving identically but silently. Revisit this if a future
minAppVersion bump ever crosses 1.11.4 anyway for an unrelated reason —
at that point the fallback path is permanently dead code and can be
removed.

## Git Lite

Git sync used to live in this plugin too. It's been split out into its own
plugin, **Git Lite**, since it has nothing to do with margin notes — see
that plugin's repo/folder. Nothing here depends on it; this is purely
historical context for anyone who remembers the earlier combined version.

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
  by table lookup, not a guess. A paragraph can get more than one note if it
  genuinely has more than one distinct issue; an optional exact-substring
  `quote` lets a note anchor at a specific sentence/phrase within its
  paragraph instead of just the paragraph's start. A density cap (roughly
  one note per 12 words, meant as a runaway backstop behind the prompt's
  own "don't flag every paragraph" instruction, not a target) keeps a
  misbehaving run from flooding a file, and a resolved position landing
  inside an existing `[mn.*: ...]` marker is rejected outright. After
  writing, `verifyInsertOnly()` strips all `[mn.ai: ...]` markers (and any
  `[[link]]` text the run itself just inserted, for the report-note path
  below) from both before/after snapshots and confirms they're otherwise
  byte-identical.

  A note can also be a **linked report** rather than an inline remark: for
  something that's genuinely its own document (a continuity report
  spanning many paragraphs, a whole-text style summary), the agent writes
  the long-form body to a separate file in the configured reports folder
  and anchors a plain `[[link]]` to it in the source file, instead of
  cramming the whole thing into an inline `[mn.ai: ...]` marker.

  All calls go through Obsidian's `requestUrl`, which bypasses CORS entirely
  — no proxy needed, unlike the original app's mobile setup. See "Network
  use" in the main README for exactly what's sent, where, and when.
- **Scope: selection, file, or vault.** Selection scope sends only the
  selected substring to the model; the returned paragraph-relative offsets
  are shifted by the selection's start position before insertion, so a note
  from a two-paragraph selection lands correctly in the full document, not
  at the top of the file. File scope runs on the whole active file. Vault
  scope runs across every file currently matching the enablement rule.
- **Remembering config.** Provider, per-provider model, agent profile,
  scope, spelling convention, and note density all persist in the plugin's
  normal settings (`data.json`). See "Network use" in the main README for
  how API keys specifically are stored.

## Links

`[[Note Title]]`, `[[Note|Alias]]`, `[[Note#Heading]]`, and
`[[Note#Heading|Alias]]` render inline as plain, underlined clickable text
(no brackets, muted accent color instead of Obsidian's default blue) — same
visual weight as surrounding prose, just distinguishable enough to notice.
Clicking one opens the target in a new tab rather than replacing the
current one, so navigating to a linked note never costs you your place in
the document you were reading.

Links are otherwise left alone — no margin chip, no preview, nothing
rendered beyond that inline text. The margin column is reserved
exclusively for `[mn: ...]` notes.

- **`linkMarkers.ts`** parses `[[...]]` (`target[#heading][|alias]`
  grammar) and decorates matches with a plain `<span class="mn-linktext">`
  widget. Clicking it calls Obsidian's own `app.workspace.openLinkText()`
  with the "open in a new leaf" flag set — the same target-resolution
  behavior Obsidian's built-in renderer uses, just landing in a new tab
  instead of the current one. The regex intentionally does NOT use a
  lookbehind to exclude `![[...]]` — iOS's JS engine doesn't support
  lookbehind assertions, and using one here would have silently broken
  every link on iPhone rather than throwing an obvious error. Instead,
  `findLinkMarkers()` does a manual "was the character right before this
  preceded by `!`" check against the raw text, which is lookbehind-free
  and behaves identically.
- **Nested links inside `[mn: ...]` notes.** A `[[link]]` written inside a
  note's own content (e.g. `[mn: see [[Character Bible]] for context]`) is
  swallowed into the note as plain text — it does NOT also get its own
  underline. `findTopLevelLinkMarkers()` (in `linkMarkers.ts`) excludes
  any link whose range falls inside a note marker's range before the
  inline decoration layer ever sees it. This matters for two reasons:
  (1) two different CM6 extensions each trying to `Decoration.replace`
  overlapping, nested ranges is not something CM6 resolves predictably —
  avoiding the overlap entirely sidesteps that rather than relying on
  undefined behavior; (2) `noteMarkers.ts`'s own regex (`MN_RE`) is
  non-greedy and, on its own, stops at the FIRST `]` it finds after the
  note's colon — which used to be the nested link's own closing bracket,
  truncating the note's content and leaving stray bracket characters as
  broken visible text. `findNoteMarkers()` now includes a
  bracket-depth-aware rescan (`findTrueNoteEnd()`) that finds the note's
  real closing bracket whenever its captured content contains an
  unbalanced `[[` — a plain note with no nested double-brackets is
  completely unaffected and takes the same fast path as before.
- **`marginLayout.ts`** is the shared positioning/clamping engine for note
  chips — a generic `MarginItem` interface (`{ from, id, buildChip() }`)
  plus a two-pass "compute every anchor's true position first, then place
  chips top-down clamping only when the *next* item's real anchor demands
  it" layout. `marginPanel.ts` maps `[mn: ...]` note markers into this
  shape before handing them to the pass; links never enter this pipeline
  at all, since they don't get a chip.
- **Hover-zoom.** Every margin note chip, clamped or not, scales up and
  lifts on `:hover` (pure CSS `transform` + `box-shadow`, no JS involved
  in the motion itself), showing its full unclamped content. It's pinned
  to the margin's own horizontal position (`transform-origin: right
  center`, matching the track's right-aligned layout) so a zoomed chip
  never grows toward or over the main text — only leftward/vertically,
  within the reserved margin space. This has zero effect on the editor's
  own cursor, selection, or focus. Links have no chip, so hover-zoom
  doesn't apply to them — the inline text itself just gets a lighter/
  darker opacity change on hover, no scaling.
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

## Implementation caveats (for maintainers)

These are risk notes about the current implementation, not user-facing
limitations — see the main README's "Known caveats" for the one caveat
that actually affects how you use the plugin.

- **`editor.cm` is not officially typed.** If a future Obsidian release
  changes this, the insert-note command, the agent's live-editor path, and
  the refresh-on-rename/frontmatter-change hooks fail with a `Notice` instead
  of a crash. The note *rendering* itself doesn't depend on it.
- **Readable line length / split panes** — see the CSS comments; the margin
  reservation is a CSS override and may need tuning against unusual themes.

## Notes storage today

`[mn.type: content]` / `[mn: content]` notes are stored literally, inline in
the document body, decorated by CodeMirror into a superscript widget +
margin chip — there's no separate file or footnote involved for these.

`[[links]]` are the second kind of marker this plugin understands, but
they don't store or preview any content themselves — they're just
Obsidian's own wikilink syntax, rendered as clean inline text and opened
in a new tab on click. There's no margin presence for them at all.

## A possible future direction: richer link-opening

Clicking a `[[link]]` currently opens the target in a new tab
(`linkMarkers.ts`'s `LinkInlineWidget`, via `openLinkText(..., true)`).
This is deliberately kept simple for now rather than adding more click
modes, but Obsidian's public API does support a couple of things worth
considering later if there's a real need:

- `app.workspace.openPopoutLeaf()` — opens the target in a genuinely
  separate OS-level window (desktop only), closer to a detached
  browser-tab feel than a same-window tab.
- Wiring the link into Obsidian's own native hover-preview popover (the
  same transient floating preview a normal `[[link]]` already gets on
  hover in Obsidian core), as a no-click "peek" option.

Not implemented — noted here in case it's worth revisiting, but the
current new-tab behavior covers the common case without adding another
setting or click-mode for people to learn.

## A possible future direction: more/different agent types

The agent system today ships two bundled profiles (continuity checker,
line editor) and lets anyone drop a markdown file into a configured
folder to define more, using the same paragraph-anchored placement
pipeline (`agents.ts`) regardless of what the profile actually asks the
model to look for. That same pipeline could support quite different
kinds of agents without new core mechanics, e.g.:

- **A style/voice-consistency agent** — flags places where narration
  voice, tense, or POV shifts unintentionally partway through a
  document.
- **A worldbuilding/continuity cross-reference agent** built on top of
  the linked-note capability — reads a project's linked "bible" notes
  ([[links]]) alongside the main text and flags where the prose
  contradicts something already established in one of those notes,
  rather than only checking the document against itself.
- **A vault-context agent** that reads related linked notes as extra
  context before annotating, rather than seeing only the one file/
  selection currently being run against.
- **A read-aloud/pacing agent** that flags paragraphs likely to read
  awkwardly out loud (sentence length/rhythm heuristics plus a model
  pass), useful for material meant to be performed or narrated.

None of these need new placement/anchoring mechanics beyond what's
already planned — they're new prompt profiles plus, in the
vault-context case, feeding the model more than just the current file's
own text. Not implemented; listed here as directions worth exploring
once the core agent-output work (multi-note-per-paragraph, precise
anchoring, linked report notes) is in place.

## A possible future direction: one-click apply for AI suggestions

Right now every `[mn.ai: ...]` note is pure commentary — the plugin's
insert-only guarantee means an agent run never touches your actual prose,
only adds a note alongside it. A natural next step some people will want
is a small affordance on an AI note — e.g. two circular arrows/a sync
icon — that, on click, applies the AI's suggested rewrite directly into
the document and removes the note, rather than leaving you to read the
suggestion and edit it in by hand.

This is intentionally **not** planned or scheduled — it changes a real
safety property (agent runs are currently guaranteed non-destructive to
your prose) into something that can rewrite your document on a click, and
that needs to be earned with real precision, not bolted onto the existing
note type. If this is ever built, it likely needs, roughly in order:

- **A genuinely new note kind**, not an extra button on `mn.ai` — so the
  "this note can rewrite your text" property is visible and distinct
  from an ordinary annotation, both in the markup and to the person
  reading it.
- **Exact-span anchoring**, not paragraph-level anchoring — the model
  needs to identify a precise, verbatim substring to replace, not just
  "this paragraph has an issue." Paragraph-level placement (today's
  approach, and the improved-but-still-paragraph-scoped anchoring
  planned for regular AI notes) isn't precise enough to safely apply an
  edit automatically — a wrong or ambiguous match risks silently
  rewriting the wrong text.
- **A confirm-before-write UX**, most likely a diff-style preview (show
  exactly what will change) rather than a single click committing an
  edit with no preview at all.
- **Acceptance that smaller/local models will struggle here** — proposing
  a reliable verbatim replacement span is a harder task than proposing a
  paragraph-scoped comment, and the failure modes are worse (a missed
  match fails safely and does nothing; a wrong match silently edits the
  wrong spot) — so this feature's quality will likely track model choice
  much more closely than today's note-placement agents do.

A safer intermediate step, if this direction is pursued at all: let an AI
note *propose* a specific rewrite as part of its (still just) commentary,
so a person can read and manually apply it — automating the "click to
apply" step only once that proposal mechanism has proven reliable in
practice.

## A possible future direction: linking one `mn:` note to another

`[[links]]` connect a note to a whole other *file*; there's currently no
way to link one `[mn: ...]` note to another `[mn: ...]` note living
elsewhere in the **same** file — useful when one underlying issue is
mentioned in several places in the same document ("this contradicts what
was said near the note on this same topic three pages up") and you'd
rather cross-reference the earlier note than repeat it.

This is a genuinely different problem from file-based links: an `mn:`
note has no stable identity today beyond its live character offset,
which shifts constantly as the document is edited elsewhere — so it
can't be resolved the way `getFirstLinkpathDest` resolves a file. Two
possible approaches, in order of how safe they'd be to build:

- **Explicit, user-assigned anchor ids** — something like
  `[mn#continuity1: ...]` to name a note, and a way to reference that id
  from elsewhere (a new small syntax, or a variant of the existing link
  syntax) to jump to it. Safer: the reference stays valid regardless of
  what else changes in the document, the same way `[[Note#Heading]]`
  already asks a person to name the heading explicitly rather than
  guessing its position.
- **Implicit positional ids** ("the 3rd note in this file") — cheaper to
  write, but fragile: deleting or reordering an earlier note would
  silently break every later reference to it, which is exactly the kind
  of silent-corruption risk called out above for one-click-apply.

The click behavior itself would likely scroll the same editor pane to
the target note (not open a split — this is same-file navigation) and
give the target note's chip a small "back" affordance to return to where
you clicked from, ideally as a short stack rather than a single fixed
origin, so following a chain of two or three references can retrace its
steps.

Automatically detecting that two notes are *about the same thing*
(rather than requiring an explicit reference) would need either
unreliable text-matching heuristics or a model-assisted pass — the
latter is really an agent capability, and would want to build on
whatever anchoring work the agent roadmap already produces, rather than
being invented separately. Not implemented; scoped to same-file
cross-references only — a cross-file version of this idea is really
"you want a linked note," which `[[links]]` already provide.